/**
 * S4 Docx XML block parsing contract (pure, no CLI/account).
 *
 * Pins the editor's two invariants:
 * - the parsed model keeps the exact inner XML (inline styles survive an
 *   untouched edit) and the outer attributes except `id`;
 * - only text blocks with a safe block id are editable; complex containers and
 *   id-less blocks are read-only instead of being rebuilt;
 * - attribute scanning is quote-aware: an `id=` that lives inside another
 *   attribute value (a caption) is not the block id and is never rewritten;
 * - a malformed tail marks the parse incomplete instead of silently hiding it;
 * - serialization emits one `<tag attrs>inner</tag>` for `block_replace`,
 *   never append/overwrite/delete/move.
 */
import { describe, expect, it } from 'vitest'
import {
  buildDocBlockXml,
  buildDocTitleXml,
  isSafeBlockId,
  parseDocEditXml,
  topLevelSpans,
} from '../src/clues/sources/feishu/edit.ts'

const XML = [
  '<title id="blk-title" align="center">Plan</title>',
  '<p id="blk-p1" align="left">Hello <b>world</b> &amp; more</p>',
  '<ul><li id="blk-li1" seq="auto">One</li><li>No id</li></ul>',
  '<pre id="blk-pre" lang="ts" caption="demo"><code>const x = 1 &lt; 2</code></pre>',
  '<table id="blk-table"><tbody><tr><td>Cell</td></tr></tbody></table>',
  '<hr id="blk-hr"/>',
  '<img id="blk-img" token="tok" url="https://cdn.example/a.png"/>',
].join('')

describe('Docx edit XML parser', () => {
  it('extracts the title, text blocks and their original attributes', () => {
    const parsed = parseDocEditXml(XML)
    expect(parsed.title).toBe('Plan')
    expect(parsed.titleBlockId).toBe('blk-title')
    expect(parsed.titleAttrs).toBe('align="center"')
    expect(parsed.complete).toBe(true)
    expect(parsed.blocks.map(block => block.id)).toEqual([
      'blk-p1', 'blk-li1', 'blk-pre',
    ])
    expect(parsed.blocks[0]).toMatchObject({
      tag: 'p',
      attrs: 'align="left"',
      text: 'Hello <b>world</b> &amp; more',
      baseline: 'Hello <b>world</b> &amp; more',
      kind: 'xml',
      order: 1,
    })
    expect(parsed.blocks[1]).toMatchObject({ tag: 'li', attrs: 'seq="auto"', text: 'One' })
    expect(parsed.blocks[2]).toMatchObject({
      tag: 'pre',
      attrs: 'lang="ts" caption="demo"',
      text: 'const x = 1 < 2',
      kind: 'plain',
    })
    expect(parsed.readOnlyBlocks.map(block => block.tag)).toEqual(['li', 'table', 'hr', 'img'])
    expect(parsed.readOnlyBlocks[0]!.text).toBe('No id')
    expect(parsed.readOnlyBlocks[1]!.text).toBe('Cell')
    expect(parsed.readOnlyBlocks[2]!.reason).toMatch(/read-only/)
    // Complex blocks keep their resource URL/order so the client can show them
    // in place instead of dropping the original entry.
    expect(parsed.readOnlyBlocks[3]).toMatchObject({
      tag: 'img',
      url: 'https://cdn.example/a.png',
    })
    expect(parsed.readOnlyBlocks.map(block => block.order)).toEqual([4, 6, 7, 8])
  })

  it('serializes only the changed block, preserving attrs and escaping code', () => {
    const parsed = parseDocEditXml(XML)
    const paragraph = parsed.blocks[0]!
    expect(buildDocBlockXml(paragraph, 'Hello <b>there</b>'))
      .toBe('<p align="left">Hello <b>there</b></p>')
    const code = parsed.blocks[2]!
    expect(buildDocBlockXml(code, 'if (a < b) run()'))
      .toBe('<pre lang="ts" caption="demo"><code>if (a &lt; b) run()</code></pre>')
    expect(buildDocTitleXml(parsed.titleAttrs, 'Renamed'))
      .toBe('<title align="center">Renamed</title>')
  })

  it('escapes plain user text but keeps a well-formed inline fragment', () => {
    const parsed = parseDocEditXml(XML)
    const paragraph = parsed.blocks[0]!
    // A normal paragraph is kind=xml so inline styles survive. Plain text the
    // user types must not become malformed XML (`&`, `<`, unclosed tags).
    expect(buildDocBlockXml(paragraph, 'A & B'))
      .toBe('<p align="left">A &amp; B</p>')
    expect(buildDocBlockXml(paragraph, 'a < b'))
      .toBe('<p align="left">a &lt; b</p>')
    expect(buildDocBlockXml(paragraph, '<b>bold</b> &amp; more'))
      .toBe('<p align="left"><b>bold</b> &amp; more</p>')
    // An unknown named entity is not valid DocxXML; escaping it keeps the
    // literal text instead of sending an invalid entity.
    expect(buildDocBlockXml(paragraph, 'a&nbsp;b'))
      .toBe('<p align="left">a&amp;nbsp;b</p>')
  })

  it('serializes a changed list item as one bare <li> block_replace payload', () => {
    const parsed = parseDocEditXml(XML)
    const item = parsed.blocks[1]!
    // block_replace targets one existing block; the group is not targetable.
    // Wrapping the replacement in <ul> would replace the item with a new list.
    expect(buildDocBlockXml(item, 'Changed & safe'))
      .toBe('<li seq="auto">Changed &amp; safe</li>')
  })

  it('never mistakes an id-looking attribute value for the block id', () => {
    const xml = [
      '<pre id="blk-real" lang="ts" caption="note id=\'blk-evil\'  keep  spacing"><code>x</code></pre>',
      '<p id=\'blk-single\' title="a  b">Body</p>',
    ].join('')
    const parsed = parseDocEditXml(xml)
    expect(parsed.blocks.map(block => block.id)).toEqual(['blk-real', 'blk-single'])
    expect(parsed.blocks[0]!.attrs).toBe('lang="ts" caption="note id=\'blk-evil\'  keep  spacing"')
    expect(parsed.blocks[1]!.attrs).toBe('title="a  b"')
    // A subsequent write keeps the caption text (including its quoted id and
    // double spaces) verbatim.
    expect(buildDocBlockXml(parsed.blocks[0]!, 'y')).toBe(
      '<pre lang="ts" caption="note id=\'blk-evil\'  keep  spacing"><code>y</code></pre>',
    )
  })

  it('refuses unsafe block ids (leading dash / -1) instead of targeting another block', () => {
    expect(isSafeBlockId('blk-1')).toBe(true)
    expect(isSafeBlockId('-1')).toBe(false)
    expect(isSafeBlockId('-blk')).toBe(false)
    expect(isSafeBlockId('1,2')).toBe(false)
    const parsed = parseDocEditXml('<p id="-1">x</p><p id="blk-ok">y</p>')
    expect(parsed.blocks.map(block => block.id)).toEqual(['blk-ok'])
    expect(parsed.readOnlyBlocks.map(block => block.tag)).toEqual(['p'])
  })

  it('does not invent blocks for malformed XML and refuses id-less text blocks', () => {
    expect(parseDocEditXml('<p id="blk">unterminated')).toEqual({
      title: '',
      titleAttrs: '',
      blocks: [],
      readOnlyBlocks: [],
      complete: false,
    })
    const noId = parseDocEditXml('<p>loose text</p><h1>Heading</h1>')
    expect(noId.blocks).toHaveLength(0)
    expect(noId.readOnlyBlocks.map(block => block.tag)).toEqual(['p', 'h1'])
    expect(noId.complete).toBe(true)
  })

  it('reports a valid prefix plus a malformed tail as incomplete', () => {
    const parsed = parseDocEditXml('<title>Plan</title><p id="blk-a">ok</p><p id="blk-b>broken')
    expect(parsed.blocks.map(block => block.id)).toEqual(['blk-a'])
    expect(parsed.complete).toBe(false)
    // A valid empty-title document stays complete and editable.
    const emptyTitle = parseDocEditXml('<p id="blk-a">only body</p>')
    expect(emptyTitle).toMatchObject({ title: '', complete: true })
    expect(emptyTitle.blocks).toHaveLength(1)
  })

  it('returns only complete top-level spans (used for block-aligned read windows)', () => {
    expect(topLevelSpans('<title>T</title><p>a</p>')).toEqual([
      { start: 0, end: 16 },
      { start: 16, end: 24 },
    ])
    expect(topLevelSpans('<p>ok</p><p>unterminated')).toBeUndefined()
    expect(topLevelSpans('')).toEqual([])
  })
})
