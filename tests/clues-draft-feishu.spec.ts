/** Native XML draft seam: resources and IDs survive; edits return the existing block model. */
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClueDraftManager } from '../src/clues/drafts.ts'
import { removeTree } from './temp-tree.ts'
import { FakeLarkRuntime, okResult } from './clues-feishu-fixture.ts'
import { createFeishuDraftBridge, planFeishuDraft } from '../src/clues/drafts/feishu.ts'
import { parseDocEditXml } from '../src/clues/sources/feishu/edit.ts'
import type { ClueEditDocument, JsonValue } from '../src/clues/types.ts'
import type { CluesService } from '../src/clues/service.ts'
const XML = '<title id="t1">Title</title>\n<p id="p1" align="center">Before <b>bold</b><img token="image-token"/></p>\n<image id="asset1" token="resource-token"/>\n<ul><li id="li1">Item</li></ul>'
const parsed = parseDocEditXml(XML)
const baseline: ClueEditDocument = { format: 'feishu.docs.xml', baseRevision: '14', data: { kind: 'docx', docToken: 'doc1', title: parsed.title, baselineTitle: parsed.title, titleEditable: true, titleBlockId: parsed.titleBlockId!, titleAttrs: parsed.titleAttrs, blocks: parsed.blocks, readOnlyBlocks: parsed.readOnlyBlocks } as unknown as JsonValue }
describe('Feishu native draft projection', () => {
  it('round-trips untouched resources and changes text through the original block model', () => {
    const plan = planFeishuDraft(baseline, XML, XML.replace('Before ', 'After ').replace('Item</li>', 'Revised item</li>'))
    expect(plan.insertions).toEqual([])
    expect(plan.document.data).toMatchObject({ docToken: 'doc1', blocks: [{ id: 'p1', attrs: 'align="center"', baseline: 'Before <b>bold</b><img token="image-token"/>', text: 'After <b>bold</b><img token="image-token"/>' }, { id: 'li1', baseline: 'Item', text: 'Revised item' }] })
  })
  it('prepares the actual full XML file and submits native edits through the manager', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clue-native-xml-'))
    try {
      const runtime = new FakeLarkRuntime().enqueue(okResult({ document: { content: XML, revision_id: 14 } }))
      const clues = { loadEdit: vi.fn(async () => structuredClone(baseline)), saveEdit: vi.fn<CluesService['saveEdit']>(async () => ({ savedAt: 'now', revision: '15' })) }
      const feishu = createFeishuDraftBridge({ clues, getRuntime: () => runtime.asRuntime(), resolveWorkspacePath: () => '/workspace' })
      const manager = createClueDraftManager({ clues, root, feishu })
      const prepared = await manager.prepare({ workspaceId: 'w', sessionId: 's', clueId: 'doc1' })
      expect(prepared.bodyPath.endsWith('.xml')).toBe(true)
      expect(await readFile(prepared.bodyPath, 'utf8')).toBe(XML)
      await writeFile(prepared.bodyPath, XML.replace('Before ', 'After '))
      expect((await manager.commit(prepared.draftId)).status).toBe('committed')
      expect(clues.saveEdit.mock.calls[0]?.[0]).toMatchObject({ document: { format: 'feishu.docs.xml', baseRevision: '14', data: { docToken: 'doc1' } } })
    } finally { removeTree(root) }
  })

  it('plans new text blocks as scoped insertions while keeping existing IDs', () => {
    const plan = planFeishuDraft(baseline, XML, XML.replace('\n<image', '\n<p>Inserted paragraph</p>\n<image'))
    expect(plan.insertions).toEqual([{ afterId: 'p1', xml: '<p>Inserted paragraph</p>', count: 1 }])
  })
  it('escapes new text XML and never uses a guessed zero anchor', () => {
    const plan = planFeishuDraft(baseline, XML, '<p>Start & more</p>' + XML)
    expect(plan.insertions).toEqual([{ afterId: 't1', xml: '<p>Start &amp; more</p>', count: 1 }])
  })

  it('preserves link resources and all nested IDs during a text change', () => {
    const linked = XML.replace('Before ', '<a id="link-id" href="https://example.com">Before</a> ')
    const linkedParsed = parseDocEditXml(linked)
    const linkedBase = { ...baseline, data: { ...(baseline.data as object), blocks: linkedParsed.blocks } as unknown as JsonValue }
    expect(() => planFeishuDraft(linkedBase, linked, linked.replace('href="https://example.com"', 'href="https://different.example"'))).toThrow()
    expect(() => planFeishuDraft(linkedBase, linked, linked.replace(' id="link-id"', ''))).toThrow()
  })

  it('inserts through fixed native transport then rebinds text edits to the fresh source model', async () => {
    const runtime = new FakeLarkRuntime().enqueue(
      okResult({ document: { content: XML, revision_id: 14 } }),
      okResult({ result: 'success', updated_blocks_count: 2, document: { revision_id: 15 } }),
    )
    const freshXml = XML.replace('\n<image', '\n<p id="new1">Inserted</p>\n<p id="new2">Second</p>\n<image')
    const fresh = parseDocEditXml(freshXml)
    const freshDocument: ClueEditDocument = { ...baseline, baseRevision: '15', data: { ...(baseline.data as object), blocks: fresh.blocks, readOnlyBlocks: fresh.readOnlyBlocks } as unknown as JsonValue }
    const clues = { loadEdit: vi.fn(async () => freshDocument), saveEdit: vi.fn<CluesService['saveEdit']>(async () => ({ savedAt: 'now', revision: '16' })) }
    const bridge = createFeishuDraftBridge({ clues, getRuntime: () => runtime.asRuntime(), resolveWorkspacePath: () => '/workspace' })
    const plan = planFeishuDraft(baseline, XML, XML.replace('Before ', 'After ').replace('\n<image', '\n<p>Inserted</p>\n<p>Second</p>\n<image'))
    const resource = { workspaceId: 'w', sessionId: 's', clueId: 'doc1' }
    expect(await bridge.save(plan, baseline, resource)).toEqual({ savedAt: 'now', revision: '16' })
    expect(runtime.requests[1]!.args).toContain('block_insert_after')
    expect(runtime.requests[1]!.args).toContain('p1')
    expect(runtime.requests[1]!.stdin).toBe('<p>Inserted</p>\n<p>Second</p>')
    expect(runtime.requests[1]!.args).not.toContain('<p>Inserted</p>')
    expect(clues.saveEdit.mock.calls[0]?.[0]).toMatchObject({ document: { baseRevision: '15', data: { blocks: [{ id: 'p1', baseline: 'Before <b>bold</b><img token="image-token"/>', text: 'After <b>bold</b><img token="image-token"/>' }, { id: 'new1', text: 'Inserted' }, { id: 'new2', text: 'Second' }, { id: 'li1', text: 'Item' }] } } })
  })

  it.each([
    XML.replace('<image id="asset1" token="resource-token"/>', ''),
    XML.replace('image-token', 'different-token'),
    XML.replace('align="center"', 'align="right"'),
    XML.replace('id="p1"', 'id="other"'),
    XML.replace('<p id="p1"', '<h2 id="p1"').replace('</p>', '</h2>'),
    XML + '<p>broken',
    XML.replace('<p id="p1" align="center">Before <b>bold</b><img token="image-token"/></p>', ''),
    XML.replace('<ul><li id="li1">Item</li></ul>', '<ul><li id="li1">Item</li><li>New list item</li></ul>'),
  ])('rejects unsupported structural destruction before a write', xml => {
    expect(() => planFeishuDraft(baseline, XML, xml)).toThrow()
  })
})
