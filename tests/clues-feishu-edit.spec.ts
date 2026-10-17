/**
 * S4 Docx XML block parsing contract (pure, no CLI/account).
 *
 * Pins the editor's two invariants:
 * - the parsed model keeps the exact inner XML (inline styles survive an
 *   untouched edit) and the outer attributes except `id`;
 * - only text blocks with a safe block id are editable; complex containers and
 *   id-less blocks are read-only instead of being rebuilt;
 * - serialization emits one `<tag attrs>inner</tag>` for `block_replace`,
 *   never append/overwrite/delete/move.
 */
import { describe, expect, it } from 'vitest'
import {
  buildDocBlockXml,
  buildDocTitleXml,
  parseDocEditXml,
} from '../src/clues/sources/feishu/edit.ts'

const XML = [
  '<title id="blk-title" align="center">Plan</title>',
  '<p id="blk-p1" align="left">Hello <b>world</b> &amp; more</p>',
  '<ul><li id="blk-li1" seq="auto">One</li><li>No id</li></ul>',
  '<pre id="blk-pre" lang="ts" caption="demo"><code>const x = 1 &lt; 2</code></pre>',
  '<table id="blk-table"><tbody><tr><td>Cell</td></tr></tbody></table>',
  '<hr id="blk-hr"/>',
].join('')

describe('Docx edit XML parser', () => {
  it('extracts the title, text blocks and their original attributes', () => {
    const parsed = parseDocEditXml(XML)
    expect(parsed.title).toBe('Plan')
    expect(parsed.titleBlockId).toBe('blk-title')
    expect(parsed.titleAttrs).toBe('align="center"')
    expect(parsed.blocks.map(block => block.id)).toEqual([
      'blk-p1', 'blk-li1', 'blk-pre',
    ])
    expect(parsed.blocks[0]).toMatchObject({
      tag: 'p',
      attrs: 'align="left"',
      text: 'Hello <b>world</b> &amp; more',
      baseline: 'Hello <b>world</b> &amp; more',
      kind: 'xml',
    })
    expect(parsed.blocks[1]).toMatchObject({ tag: 'li', attrs: 'seq="auto"', text: 'One' })
    expect(parsed.blocks[2]).toMatchObject({
      tag: 'pre',
      attrs: 'lang="ts" caption="demo"',
      text: 'const x = 1 < 2',
      kind: 'plain',
    })
    expect(parsed.readOnlyBlocks.map(block => block.tag)).toEqual(['li', 'table', 'hr'])
    expect(parsed.readOnlyBlocks[0]!.text).toBe('No id')
    expect(parsed.readOnlyBlocks[1]!.text).toBe('Cell')
    expect(parsed.readOnlyBlocks[2]!.reason).toMatch(/read-only/)
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

  it('does not invent blocks for malformed XML and refuses id-less text blocks', () => {
    expect(parseDocEditXml('<p id="blk">unterminated')).toEqual({
      title: '',
      titleAttrs: '',
      blocks: [],
      readOnlyBlocks: [],
    })
    const noId = parseDocEditXml('<p>loose text</p><h1>Heading</h1>')
    expect(noId.blocks).toHaveLength(0)
    expect(noId.readOnlyBlocks.map(block => block.tag)).toEqual(['p', 'h1'])
  })
})
