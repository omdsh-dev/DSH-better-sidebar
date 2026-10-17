/**
 * S4 Feishu DOCS source contract (fake lark-cli; no real account).
 *
 * Pins the approved document semantics:
 * - browsing starts from an EXPLICIT Drive folder / wiki space-or-parent /
 *   explicit Drive root — never an implicit "all documents" or silent root;
 * - exactly one provider page per request (`drive files list`, `wiki
 *   +node-list`, `wiki +space-list`, `drive +search`), continued only by the
 *   returned page token; `--page-all` never appears; a cursor from another
 *   range/query is refused instead of mixing pages;
 * - a Drive folder row is returned as a `drive-folder` scope candidate; one
 *   explicit follow-up list call descends one level (no recursive walk);
 * - no invented `total`; an unpaginatable root or search-index coverage is
 *   reported as `limited`;
 * - a wiki URL resolves through `wiki +node-get` and the wiki NODE token is
 *   never used as a docx token;
 * - reads are latest XML by default (Markdown is a read-only projection),
 *   fetched with the lightweight `simple` detail that still carries content +
 *   revision; lark-cli 1.0.55 has no reference sidecar/flag, so none is faked.
 *   Long content is an explicit block-aligned fragment with `nextOffset`, and
 *   an oversized document reports the plugin runner's 8 MiB capture limit
 *   instead of returning a partial read;
 * - edits are BLOCK-SCOPED text replacements: loadEdit fetches XML with block
 *   ids, saveEdit compares the native revision and the changed blocks'
 *   tag/attrs/kind/inner XML against a fresh read and sends only
 *   `block_replace`; complex containers stay read-only, and
 *   append/overwrite/delete/move never appear;
 * - the update business result is checked: a missing/unknown result, warnings
 *   or an unexpected updated-block count is never reported as full success;
 * - a locator of another source's shape is "not mine" in auto resolution
 *   instead of aborting the later source;
 * - portable locators export only resource identifiers + original URL/host,
 *   never an access token.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClueError } from '../src/clues/types.ts'
import type { ClueCandidate, ClueOperationContext, JsonValue } from '../src/clues/types.ts'
import { createFeishuDocsSource } from '../src/clues/sources/feishu/docs.ts'
import { createFeishuTasksSource } from '../src/clues/sources/feishu/tasks.ts'
import { createCluesService } from '../src/clues/service.ts'
import { CluesStore } from '../src/clues/store.ts'
import { windowsShimCommandLine } from '../src/clues/runtime/cli.ts'
import { removeTree } from './temp-tree.ts'
import {
  DOCS_EDIT_SCOPE_NOTE,
  FEISHU_CONNECTION_ID,
  FEISHU_FORMATS,
  FEISHU_SOURCE_IDS,
  FEISHU_TYPE_IDS,
  type FeishuDocEditData,
} from '../src/clues/sources/feishu/format.ts'
import {
  cliResult,
  failResult,
  FakeLarkRuntime,
  okResult,
  operationContext,
} from './clues-feishu-fixture.ts'

const CWD = '/tmp/dsh-feishu'
const PROBE = 'https://acme.feishu.cn'

function sourceWith(runtime: FakeLarkRuntime) {
  return createFeishuDocsSource(() => runtime.asRuntime())
}

function opsOf(runtime: FakeLarkRuntime) {
  const source = sourceWith(runtime)
  const operations = source.operations
  if (operations === undefined) throw new Error('docs source needs operations')
  return { source, operations }
}

function context(): ClueOperationContext {
  return operationContext() as unknown as ClueOperationContext
}

/**
 * Windows managed installs can resolve a `lark-cli.cmd` shim; S2 wraps it in
 * `cmd.exe /d /s /c`, and `windowsShimCommandLine` refuses a double quote in
 * any argv token. No Feishu command may put JSON/XML into argv.
 */
function expectWindowsSafeArgs(runtime: FakeLarkRuntime): void {
  for (const request of runtime.requests) {
    expect(request.args.every(arg => !arg.includes('"'))).toBe(true)
    expect(() => windowsShimCommandLine('C:\\tools\\lark-cli.cmd', request.args)).not.toThrow()
  }
}

/** One full XML edit fixture (block ids + a complex read-only table). */
const EDIT_XML = [
  '<title id="blk-title">Design notes</title>',
  '<p id="blk-p1">Hello <b>world</b></p>',
  '<h2 id="blk-h2">Section</h2>',
  '<ul><li id="blk-li1">First</li><li id="blk-li2">Second</li></ul>',
  '<table id="blk-table"><tbody><tr><td>Cell</td></tr></tbody></table>',
  '<pre id="blk-pre" lang="ts"><code>const x = 1</code></pre>',
  '<checkbox id="blk-todo" done="false">Todo</checkbox>',
].join('')

/** A full-fetch success answer for {@link EDIT_XML}. */
function editFetch(revisionId = 7, content = EDIT_XML) {
  return okResult({
    document: {
      document_id: 'doccnA',
      revision_id: revisionId,
      content,
    },
  })
}

/** Clone a loaded payload and replace one block's text. */
function withEditBlock(data: FeishuDocEditData, id: string, text: string): FeishuDocEditData {
  return {
    ...data,
    blocks: data.blocks.map(block => (block.id === id ? { ...block, text } : block)),
  }
}

describe('docs browsing ranges', () => {
  it('refuses to list without an explicit range and performs no CLI call', async () => {
    const runtime = new FakeLarkRuntime()
    const { operations } = opsOf(runtime)
    await expect(operations.list!({}, context())).rejects.toMatchObject({
      category: 'invalid-request',
    })
    expect(runtime.requests).toHaveLength(0)
  })

  it('lists one Drive folder page with typed flags (no JSON argv)', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({
      files: [
        {
          type: 'docx',
          token: 'doccnA',
          name: 'Design notes',
          url: 'https://acme.feishu.cn/docx/doccnA',
          modified_time: '1700000000',
        },
        { type: 'folder', token: 'fldChild', name: 'A subfolder' },
        { type: 'sheet', token: 'sht1', name: 'Sheet' },
      ],
      has_more: true,
      next_page_token: 'pt-2',
    }))
    const { operations } = opsOf(runtime)
    const first = await operations.list!(
      { scope: { kind: 'drive', folderToken: 'fldRoot' }, limit: 500 },
      context(),
    )

    expect(runtime.requests[0]!.args).toEqual([
      'drive', 'files', 'list',
      '--folder-token', 'fldRoot',
      '--page-size', '200',
      '--as', 'user', '--format', 'json',
    ])
    expect(runtime.requests[0]!.stdin).toBeUndefined()
    expectWindowsSafeArgs(runtime)
    expect(runtime.requests[0]!.cwd).toBe(CWD)
    expect(first.items).toHaveLength(2)
    expect(first.items[0]).toMatchObject({
      sourceId: 'builtin.feishu.docs',
      typeId: FEISHU_TYPE_IDS.docx,
      title: 'Design notes',
      locator: { kind: 'docx', docToken: 'doccnA' },
    })
    // A subfolder is returned as an explicit scope row (token + role), never
    // silently dropped and never walked recursively.
    expect(first.items[1]).toMatchObject({
      sourceId: 'builtin.feishu.docs',
      typeId: FEISHU_TYPE_IDS.docx,
      title: 'A subfolder',
      subtitle: 'Folder',
      locator: { kind: 'drive-folder', folderToken: 'fldChild' },
      meta: { role: 'scope', scopeKind: 'drive-folder' },
    })
    expect(first.total).toBeUndefined()
    expect(first.nextCursor).toBeTruthy()
    expect(Object.keys(first.items[0]!.locator)).not.toContain('token')

    // The cursor resumes ONLY this folder range with the provider token.
    runtime.enqueue(okResult({ files: [], has_more: false }))
    await operations.list!(
      { scope: { kind: 'drive', folderToken: 'fldRoot' }, cursor: first.nextCursor },
      context(),
    )
    expect(runtime.requests[1]!.args).toEqual([
      'drive', 'files', 'list',
      '--folder-token', 'fldRoot',
      '--page-size', '100',
      '--page-token', 'pt-2',
      '--as', 'user', '--format', 'json',
    ])
  })

  it('descends one folder level only when the caller explicitly picks the folder scope row', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(okResult({
        files: [{ type: 'folder', token: 'fldChild', name: 'Child' }],
        has_more: false,
      }))
      .enqueue(okResult({
        files: [{ type: 'docx', token: 'doccnInner', name: 'Inner doc' }],
        has_more: false,
      }))
    const { operations } = opsOf(runtime)
    const parent = await operations.list!(
      { scope: { kind: 'drive', folderToken: 'fldRoot' } },
      context(),
    )
    const folder = parent.items[0]!
    expect(folder.locator).toMatchObject({ kind: 'drive-folder', folderToken: 'fldChild' })
    const child = await operations.list!(
      { scope: { kind: 'drive', folderToken: (folder.locator as { folderToken: string }).folderToken } },
      context(),
    )
    expect(runtime.requests[1]!.args).toEqual([
      'drive', 'files', 'list',
      '--folder-token', 'fldChild',
      '--page-size', '100',
      '--as', 'user', '--format', 'json',
    ])
    expect(child.items[0]).toMatchObject({
      locator: { kind: 'docx', docToken: 'doccnInner' },
      title: 'Inner doc',
    })
  })

  it('refuses a cursor minted for another range instead of mixing pages', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({
      files: [{ type: 'docx', token: 'doccnA', name: 'A' }],
      has_more: true,
      next_page_token: 'pt-a',
    }))
    const { operations } = opsOf(runtime)
    const page = await operations.list!({ scope: { kind: 'drive', folderToken: 'fldA' } }, context())
    await expect(operations.list!(
      { scope: { kind: 'drive', folderToken: 'fldB' }, cursor: page.nextCursor },
      context(),
    )).rejects.toMatchObject({ category: 'invalid-request' })
    expect(runtime.requests).toHaveLength(1)
  })

  it('treats the Drive root as an explicit start point: no invented pages, marked limited', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({
      files: [{ type: 'docx', token: 'doccnA', name: 'Root doc' }],
      has_more: true,
      next_page_token: 'ignored-root-token',
    }))
    const { operations } = opsOf(runtime)
    const page = await operations.list!({ scope: { kind: 'drive-root' } }, context())
    // The root is requested by OMITTING --folder-token (the CLI documents an
    // absent/empty folder token as the root); no JSON `--params` argv token.
    expect(runtime.requests[0]!.args).toEqual([
      'drive', 'files', 'list',
      '--page-size', '100',
      '--as', 'user', '--format', 'json',
    ])
    expect(page.limited).toBe(true)
    expect(page.nextCursor).toBeUndefined()
    expect(page.total).toBeUndefined()
  })

  it('treats has_more as authoritative: no phantom cursor and no invented empty page', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(okResult({ files: [], has_more: false, next_page_token: 'stale-token' }))
      .enqueue(okResult({ files: [], has_more: true }))
    const { operations } = opsOf(runtime)
    const done = await operations.list!({ scope: { kind: 'drive', folderToken: 'fldRoot' } }, context())
    expect(done.nextCursor).toBeUndefined()
    expect(done.limited).toBeUndefined()
    const truncated = await operations.list!({ scope: { kind: 'drive', folderToken: 'fldRoot' } }, context())
    expect(truncated.nextCursor).toBeUndefined()
    expect(truncated.limited).toBe(true)
  })

  it('treats a success envelope with no rows array as a failure, not an empty page', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(okResult({}))
      .enqueue(okResult({ files: null }))
      .enqueue(okResult({}))
    const { operations } = opsOf(runtime)
    await expect(operations.list!({ scope: { kind: 'drive', folderToken: 'fldRoot' } }, context()))
      .rejects.toMatchObject({ category: 'failed' })
    await expect(operations.list!({ scope: { kind: 'drive', folderToken: 'fldRoot' } }, context()))
      .rejects.toMatchObject({ category: 'failed' })
    await expect(operations.search!({ query: 'plan' }, context()))
      .rejects.toMatchObject({ category: 'failed' })
  })

  it('lists one wiki node page under an explicit space/parent', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({
      nodes: [
        {
          obj_type: 'docx',
          node_token: 'wikcnNode',
          obj_token: 'doccnObj',
          title: 'Wiki design',
          has_child: true,
          node_type: 'origin',
        },
        { obj_type: 'sheet', node_token: 'wikcnSheet', obj_token: 'sht1', title: 'A sheet' },
      ],
      has_more: false,
    }))
    const { operations } = opsOf(runtime)
    const page = await operations.list!(
      { scope: { kind: 'wiki', spaceId: '7123', parentNodeToken: 'wikcnParent' }, limit: 500 },
      context(),
    )
    expect(runtime.requests[0]!.args).toEqual([
      'wiki', '+node-list', '--space-id', '7123',
      '--parent-node-token', 'wikcnParent',
      '--page-size', '50',
      '--as', 'user', '--format', 'json',
    ])
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      typeId: FEISHU_TYPE_IDS.wiki,
      title: 'Wiki design',
      locator: {
        kind: 'wiki',
        wikiToken: 'wikcnNode',
        objToken: 'doccnObj',
        objType: 'docx',
        spaceId: '7123',
      },
    })
    expect(page.items[0]!.meta?.hasChild).toBe(true)
  })

  it('lists wiki spaces as ONE explicit page and surfaces the personal library row', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({
      spaces: [{ space_id: '9001', name: 'Engineering', space_type: 'team', visibility: 'private' }],
      has_more: false,
    }))
    const { operations } = opsOf(runtime)
    const page = await operations.list!({ scope: { kind: 'wiki-spaces' } }, context())
    expect(runtime.requests[0]!.args).toEqual([
      'wiki', '+space-list', '--page-size', '50', '--as', 'user', '--format', 'json',
    ])
    // `wiki +space-list` never returns the personal library; the source adds a
    // synthetic picker row so `my_library` is selectable.
    expect(page.items[0]).toMatchObject({
      typeId: FEISHU_TYPE_IDS.wiki,
      locator: { kind: 'wiki-space', spaceId: 'my_library' },
      title: 'My library',
      meta: { role: 'scope', synthetic: true },
    })
    expect(page.items[1]).toMatchObject({
      typeId: FEISHU_TYPE_IDS.wiki,
      locator: { kind: 'wiki-space', spaceId: '9001' },
      title: 'Engineering',
      meta: { role: 'scope' },
    })
  })
})

describe('docs search', () => {
  it('resolves the personal-library alias to a numeric space id before a wiki-scoped search', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(okResult({ space: { space_id: '7123', name: 'My library' } }))
      .enqueue(okResult({ results: [], has_more: false }))
    const { operations } = opsOf(runtime)
    await operations.search!({ query: 'plan', scope: { kind: 'wiki', spaceId: 'my_library' } }, context())
    expect(runtime.requests[0]!.args).toEqual([
      'wiki', 'spaces', 'get',
      '--space-id', 'my_library',
      '--as', 'user', '--format', 'json',
    ])
    expect(runtime.requests[1]!.args).toEqual(expect.arrayContaining(['--space-ids', '7123']))
    expectWindowsSafeArgs(runtime)
  })

  it('maps the real drive +search results rows (docx/wiki, other types skipped)', async () => {
    // Real lark-cli 1.0.55 `drive +search` output: a `results` wrapper over
    // Search v2 `res_units` rows, each with
    // `title_highlighted`/`entity_type` and the identifiers under
    // `result_meta`. The old flat `results[].doc_type/token` fixture never
    // exercised this, so the mapper returned an empty page while the suite
    // stayed green.
    const runtime = new FakeLarkRuntime().enqueue(okResult({
      results: [
        {
          title_highlighted: 'Quarterly <hb>plan</hb>',
          entity_type: 'DOCX',
          result_meta: {
            doc_types: 'DOCX',
            token: 'doccnA',
            url: 'https://acme.feishu.cn/docx/doccnA',
            update_time: '1700000000',
          },
        },
        {
          title_highlighted: 'Wiki <hb>page</hb>',
          entity_type: 'WIKI',
          result_meta: {
            doc_types: ['WIKI'],
            token: 'wikcnB',
            url: 'https://acme.feishu.cn/wiki/wikcnB',
            update_time: '1700000001',
          },
        },
        {
          title_highlighted: 'A spreadsheet',
          entity_type: 'SHEET',
          result_meta: { doc_types: ['SHEET'], token: 'sht1' },
        },
        {
          title_highlighted: 'A Base',
          entity_type: 'BITABLE',
          result_meta: { doc_types: ['BITABLE'], token: 'bas1' },
        },
      ],
      has_more: true,
      page_token: 'search-pt',
    }))
    const { operations } = opsOf(runtime)
    const page = await operations.search!(
      { query: ' plan ', scope: { kind: 'drive', folderToken: 'fldRoot' }, limit: 500 },
      context(),
    )
    expect(runtime.requests[0]!.args).toEqual([
      'drive', '+search', '--query', 'plan',
      '--doc-types', 'docx,wiki',
      '--folder-tokens', 'fldRoot',
      '--page-size', '20',
      '--as', 'user', '--format', 'json',
    ])
    expect(runtime.requests[0]!.stdin).toBeUndefined()
    expectWindowsSafeArgs(runtime)
    expect(page.items).toHaveLength(2)
    expect(page.items[0]).toMatchObject({
      typeId: FEISHU_TYPE_IDS.docx,
      title: 'Quarterly plan',
      locator: {
        kind: 'docx',
        docToken: 'doccnA',
        url: 'https://acme.feishu.cn/docx/doccnA',
      },
      meta: { fileType: 'docx', editTime: '1700000000' },
    })
    expect(page.items[1]).toMatchObject({
      typeId: FEISHU_TYPE_IDS.wiki,
      title: 'Wiki page',
      locator: {
        kind: 'wiki',
        wikiToken: 'wikcnB',
        url: 'https://acme.feishu.cn/wiki/wikcnB',
      },
      meta: { objType: 'docx', editTime: '1700000001' },
    })
    expect(page.total).toBeUndefined()
    expect(page.limited).toBe(true)
    expect(page.nextCursor).toBeTruthy()
  })

  it('refuses an over-long keyword and an empty keyword without a range, with no CLI call', async () => {
    const runtime = new FakeLarkRuntime()
    const { operations } = opsOf(runtime)
    await expect(operations.search!({ query: 'x'.repeat(31) }, context()))
      .rejects.toMatchObject({ category: 'invalid-request' })
    await expect(operations.search!({ query: '   ' }, context()))
      .rejects.toMatchObject({ category: 'invalid-request' })
    expect(runtime.requests).toHaveLength(0)
  })

  it('treats a success envelope without a result array as a failure, not an empty page', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(okResult({}))
      .enqueue(okResult({ results: null }))
    const { operations } = opsOf(runtime)
    await expect(operations.search!({ query: 'plan' }, context()))
      .rejects.toMatchObject({ category: 'failed' })
    await expect(operations.search!({ query: 'plan' }, context()))
      .rejects.toMatchObject({ category: 'failed' })
  })

  it('binds a search cursor to the exact query + range', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({
      results: [], has_more: true, page_token: 'pt',
    }))
    const { operations } = opsOf(runtime)
    const page = await operations.search!({ query: 'alpha' }, context())
    await expect(operations.search!({ query: 'beta', cursor: page.nextCursor }, context()))
      .rejects.toMatchObject({ category: 'invalid-request' })
    expect(runtime.requests).toHaveLength(1)
  })
})

describe('docs resolve (URLs and wiki node unpacking)', () => {
  it('resolves a Docx URL without a CLI call and never fetches the body', async () => {
    const runtime = new FakeLarkRuntime()
    const { operations } = opsOf(runtime)
    const candidate = await operations.resolve!(
      { text: `${PROBE}/docx/doccnTOKEN?from=share`, explicit: true },
      context(),
    ) as ClueCandidate
    expect(candidate).toMatchObject({
      sourceId: 'builtin.feishu.docs',
      typeId: FEISHU_TYPE_IDS.docx,
      locator: { kind: 'docx', docToken: 'doccnTOKEN', url: `${PROBE}/docx/doccnTOKEN?from=share` },
    })
    expect(runtime.requests).toHaveLength(0)
  })

  it('resolves a Drive folder URL/token to a scope row without a CLI call', async () => {
    const runtime = new FakeLarkRuntime()
    const { operations } = opsOf(runtime)
    const fromUrl = await operations.resolve!(
      { text: `${PROBE}/drive/folder/fldChild?from=share`, explicit: true },
      context(),
    ) as ClueCandidate
    expect(fromUrl).toMatchObject({
      sourceId: 'builtin.feishu.docs',
      subtitle: 'Folder',
      locator: { kind: 'drive-folder', folderToken: 'fldChild' },
      meta: { role: 'scope', scopeKind: 'drive-folder' },
    })
    const fromToken = await operations.resolve!(
      { text: 'fldChildToken', explicit: true },
      context(),
    ) as ClueCandidate
    expect(fromToken.locator).toMatchObject({ kind: 'drive-folder', folderToken: 'fldChildToken' })
    expect(runtime.requests).toHaveLength(0)
  })

  it('resolves /wiki/space/<id> as a wiki-space scope and never calls node-get', async () => {
    const runtime = new FakeLarkRuntime()
    const { operations } = opsOf(runtime)
    const candidate = await operations.resolve!(
      { text: `${PROBE}/wiki/space/7123?from=share`, explicit: true },
      context(),
    ) as ClueCandidate
    expect(candidate).toMatchObject({
      sourceId: 'builtin.feishu.docs',
      typeId: FEISHU_TYPE_IDS.wiki,
      locator: { kind: 'wiki-space', spaceId: '7123' },
      subtitle: 'Wiki space',
      meta: { role: 'scope' },
    })
    expect(runtime.requests).toHaveLength(0)
  })

  it('answers "not mine" for another source locator shape in auto resolution', async () => {
    const runtime = new FakeLarkRuntime()
    const { operations } = opsOf(runtime)
    expect(await operations.resolve!(
      { locator: { kind: 'task', guid: '2f4d8c1e-7a3b-4c5d-9e8f-0123456789ab' } },
      context(),
    )).toBeUndefined()
    await expect(operations.resolve!(
      { locator: { kind: 'task', guid: '2f4d8c1e-7a3b-4c5d-9e8f-0123456789ab' }, explicit: true },
      context(),
    )).rejects.toMatchObject({ category: 'invalid-request' })
    expect(runtime.requests).toHaveLength(0)
  })

  it('ignores a foreign URL instead of guessing a Feishu resource', async () => {
    const runtime = new FakeLarkRuntime()
    const { operations } = opsOf(runtime)
    expect(await operations.resolve!({ text: 'https://github.com/o/r/issues/1' }, context())).toBeUndefined()
    expect(runtime.requests).toHaveLength(0)
  })

  it('unpacks a wiki URL to its underlying docx object (never uses the wiki token as docx)', async () => {
    // Real 1.0.55 `wiki +node-get` output: the node fields ARE the `data`
    // payload (no nested `node` object).
    const runtime = new FakeLarkRuntime().enqueue(okResult({
      obj_type: 'docx',
      obj_token: 'doccnUNDERLYING',
      node_token: 'wikcnNODE',
      space_id: '7123',
      title: 'Resolved wiki doc',
    }))
    const { operations } = opsOf(runtime)
    const url = `${PROBE}/wiki/wikcnNODE`
    const candidate = await operations.resolve!({ text: url, explicit: true }, context()) as ClueCandidate
    expect(runtime.requests[0]!.args).toEqual([
      'wiki', '+node-get', '--node-token', url, '--as', 'user', '--format', 'json',
    ])
    expect(candidate).toMatchObject({
      typeId: FEISHU_TYPE_IDS.wiki,
      title: 'Resolved wiki doc',
      locator: {
        kind: 'wiki',
        wikiToken: 'wikcnNODE',
        objToken: 'doccnUNDERLYING',
        objType: 'docx',
        spaceId: '7123',
      },
    })
    expect((candidate.locator as { docToken?: string }).docToken).toBeUndefined()
  })

  it('refuses a wiki node that wraps a non-document object without echoing its obj_type', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({
      obj_type: 'sheet <script>alert(1)</script>', obj_token: 'sht1', node_token: 'wikcnSheet',
    }))
    const { operations } = opsOf(runtime)
    let failure: unknown
    try {
      await operations.resolve!({ text: `${PROBE}/wiki/wikcnSheet`, explicit: true }, context())
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(ClueError)
    const clueError = failure as ClueError
    expect(clueError.category).toBe('unsupported')
    expect(clueError.message).not.toMatch(/script|sheet <|alert/)
    expect(clueError.message).toMatch(/non-document object/)

    const locatorFailure = await operations.read!(
      {
        typeId: FEISHU_TYPE_IDS.wiki,
        locator: { kind: 'wiki', wikiToken: 'wikcnN', objType: 'evil<script>' },
      },
      context(),
    ).catch(error => error)
    expect(locatorFailure).toBeInstanceOf(ClueError)
    expect((locatorFailure as ClueError).message).not.toMatch(/evil|script/)
    expect((locatorFailure as ClueError).message).toMatch(/non-document object/)
  })

  it('does not resolve a non-docx wiki LOCATOR into a stable candidate', async () => {
    const runtime = new FakeLarkRuntime()
    const { operations } = opsOf(runtime)
    const locator = {
      kind: 'wiki' as const,
      wikiToken: 'wikcnSheet',
      objToken: 'sht1',
      objType: 'sheet',
    }
    // Auto resolution answers "not mine" without a CLI call ...
    expect(await operations.resolve!({ locator }, context())).toBeUndefined()
    expect(runtime.requests).toHaveLength(0)
    // ... and an explicit docs resolution reports the unsupported object.
    await expect(operations.resolve!({ locator, explicit: true }, context()))
      .rejects.toMatchObject({ category: 'unsupported' })
  })
})

describe('docs read', () => {
  it('reads the latest XML with lightweight detail and keeps content + revision together', async () => {
    // A DocxXML title may carry attributes such as the block id (the old read
    // fixture only used a bare <title>, which hid a broken title regex).
    const content = '<title id="blk-title">Design notes</title><p>Hello</p>'
    const runtime = new FakeLarkRuntime().enqueue(okResult({
      document: {
        document_id: 'doccnA',
        revision_id: 12,
        content,
      },
    }))
    const { operations } = opsOf(runtime)
    const result = await operations.read!(
      { typeId: FEISHU_TYPE_IDS.docx, locator: { kind: 'docx', docToken: 'doccnA' } },
      context(),
    )
    // Ordinary reading is the lightweight `simple` detail (S4 §5); content and
    // revision still come from the same response.
    expect(runtime.requests[0]!.args).toEqual([
      'docs', '+fetch', '--api-version', 'v2', '--doc', 'doccnA',
      '--doc-format', 'xml',
      '--detail', 'simple',
      '--as', 'user', '--format', 'json',
    ])
    expect(result.format).toBe(FEISHU_FORMATS.docsXml)
    expect(result.revision).toBe('12')
    expect(result.text).toBe(content)
    expect(result.freshness).toBe('live')
    expect(result.data).toMatchObject({
      kind: 'docx',
      title: 'Design notes',
      projection: 'xml',
      content,
      docToken: 'doccnA',
      revisionId: '12',
    })
    expect(result.data).not.toHaveProperty('referenceMap')
  })

  it('treats an empty document body as content, not as a missing payload', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({
      document: { document_id: 'doccnA', revision_id: 3, content: '' },
    }))
    const { operations } = opsOf(runtime)
    const result = await operations.read!(
      { typeId: FEISHU_TYPE_IDS.docx, locator: { kind: 'docx', docToken: 'doccnA' } },
      context(),
    )
    expect(result.text).toBe('')
    expect(result.data).toMatchObject({
      kind: 'docx',
      content: '',
      title: 'Feishu document doccnA',
      docToken: 'doccnA',
      revisionId: '3',
    })
    expect(result.limited).toBeUndefined()
  })

  it('requests the Markdown projection only when the locator asks for it', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({
      document: { document_id: 'doccnA', revision_id: 13, content: '# Design notes\n\nHello' },
    }))
    const { operations } = opsOf(runtime)
    const result = await operations.read!(
      { typeId: FEISHU_TYPE_IDS.docx, locator: { kind: 'docx', docToken: 'doccnA', projection: 'markdown' } },
      context(),
    )
    expect(runtime.requests[0]!.args[7]).toBe('markdown')
    expect(result.format).toBe(FEISHU_FORMATS.docsMarkdown)
    // Markdown has no <title>; the exported first heading is the real title,
    // not a token-derived fallback.
    expect(result.data).toMatchObject({ projection: 'markdown', title: 'Design notes' })
  })

  it('prefers an explicit CLI document title over a Markdown heading fallback', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({
      document: {
        document_id: 'doccnA',
        revision_id: 14,
        title: 'Real document title',
        content: '# A section heading\n\nHello',
      },
    }))
    const { operations } = opsOf(runtime)
    const result = await operations.read!(
      { typeId: FEISHU_TYPE_IDS.docx, locator: { kind: 'docx', docToken: 'doccnA', projection: 'markdown' } },
      context(),
    )
    expect(result.data).toMatchObject({ title: 'Real document title' })
  })

  it('reads a resolved wiki document through its underlying docx token, without node-get', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({
      document: { document_id: 'doccnObj', revision_id: 1, content: '<title>W</title>' },
    }))
    const { operations } = opsOf(runtime)
    const result = await operations.read!(
      {
        typeId: FEISHU_TYPE_IDS.wiki,
        locator: { kind: 'wiki', wikiToken: 'wikcnN', objToken: 'doccnObj', objType: 'docx' },
      },
      context(),
    )
    expect(runtime.requests[0]!.args[5]).toBe('doccnObj')
    expect(runtime.requests[0]!.args[6]).toBe('--doc-format')
    expect(result.data).toMatchObject({ kind: 'wiki', wikiToken: 'wikcnN', objToken: 'doccnObj' })
  })

  it('unpacks an unresolved wiki locator before fetching it', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(okResult({ obj_type: 'docx', obj_token: 'doccnObj', node_token: 'wikcnN', title: 'W' }))
      .enqueue(okResult({
        document: { document_id: 'doccnObj', revision_id: 2, content: '<title>W</title>' },
      }))
    const { operations } = opsOf(runtime)
    const result = await operations.read!(
      { typeId: FEISHU_TYPE_IDS.wiki, locator: { kind: 'wiki', wikiToken: 'wikcnN' } },
      context(),
    )
    expect(runtime.requests.map(request => request.args.slice(0, 2))).toEqual([
      ['wiki', '+node-get'],
      ['docs', '+fetch'],
    ])
    expect(runtime.requests[1]!.args[5]).toBe('doccnObj')
    expect(result.data).toMatchObject({ title: 'W', objToken: 'doccnObj' })
  })

  it('returns only complete top-level blocks in a long XML fragment (no split tags)', async () => {
    const firstBlock = `<p>${'a'.repeat(200_000)}</p>`
    const secondBlock = `<p>${'b'.repeat(200_000)}</p>`
    const content = `${firstBlock}${secondBlock}`
    const runtime = new FakeLarkRuntime()
      .enqueue(okResult({ document: { document_id: 'doccnA', revision_id: 9, content } }))
      .enqueue(okResult({ document: { document_id: 'doccnA', revision_id: 9, content } }))
    const { operations } = opsOf(runtime)
    const first = await operations.read!(
      { typeId: FEISHU_TYPE_IDS.docx, locator: { kind: 'docx', docToken: 'doccnA' } },
      context(),
    )
    expect(first.limited).toBe(true)
    expect(first.nextOffset).toBe(new TextEncoder().encode(firstBlock).length)
    expect(first.text).toBe(firstBlock)
    expect(first.data).toMatchObject({ fragment: 'blocks' })
    const second = await operations.read!(
      {
        typeId: FEISHU_TYPE_IDS.docx,
        locator: { kind: 'docx', docToken: 'doccnA' },
        offset: first.nextOffset,
      },
      context(),
    )
    expect(second.limited).toBeUndefined()
    expect(second.nextOffset).toBeUndefined()
    expect(second.text).toBe(secondBlock)
    expect(second.data).toMatchObject({ fragment: 'blocks' })
    expect(first.text! + second.text!).toBe(content)
  })

  it('labels a raw byte window when one block is larger than the read cap', async () => {
    const content = `<p>${'x'.repeat(300_000)}</p>`
    const runtime = new FakeLarkRuntime()
      .enqueue(okResult({ document: { document_id: 'doccnA', revision_id: 9, content } }))
    const { operations } = opsOf(runtime)
    const first = await operations.read!(
      { typeId: FEISHU_TYPE_IDS.docx, locator: { kind: 'docx', docToken: 'doccnA' } },
      context(),
    )
    expect(first.limited).toBe(true)
    expect(first.data).toMatchObject({ fragment: 'bytes' })
    // The window is documented as raw, never claimed to be well-formed XML.
    expect(first.text!.endsWith('</p>')).toBe(false)
  })

  it('reports the bounded capture limit explicitly instead of returning a partial read', async () => {
    const runtime = new FakeLarkRuntime().enqueue(cliResult({ stdoutTruncated: true, stdout: '{"ok":true' }))
    const { operations } = opsOf(runtime)
    let failure: unknown
    try {
      await operations.read!(
        { typeId: FEISHU_TYPE_IDS.docx, locator: { kind: 'docx', docToken: 'doccnHuge' } },
        context(),
      )
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(ClueError)
    const clueError = failure as ClueError
    expect(clueError.category).toBe('failed')
    expect(clueError.message).toMatch(/plugin runner's 8 MiB stdout capture limit/)
    expect(clueError.message).toMatch(/S1 read contract carries only a byte offset/)
  })

  it('rejects an out-of-range byte offset instead of inventing an empty document', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({
      document: { document_id: 'doccnA', revision_id: 1, content: 'short' },
    }))
    const { operations } = opsOf(runtime)
    await expect(operations.read!(
      { typeId: FEISHU_TYPE_IDS.docx, locator: { kind: 'docx', docToken: 'doccnA' }, offset: 999 },
      context(),
    )).rejects.toMatchObject({ category: 'invalid-request' })
  })

  it('loads an editable XML model with block ids and keeps complex containers read-only', async () => {
    const runtime = new FakeLarkRuntime().enqueue(editFetch())
    const { source, operations } = opsOf(runtime)
    const loaded = await operations.loadEdit!(
      { typeId: FEISHU_TYPE_IDS.docx, locator: { kind: 'docx', docToken: 'doccnA' } },
      context(),
    )
    expect(runtime.requests[0]!.args).toEqual([
      'docs', '+fetch', '--api-version', 'v2', '--doc', 'doccnA',
      '--doc-format', 'xml',
      '--detail', 'full',
      '--as', 'user', '--format', 'json',
    ])
    expect(loaded.format).toBe(FEISHU_FORMATS.docsXml)
    expect(loaded.baseRevision).toBe('7')
    const data = loaded.data as unknown as FeishuDocEditData
    expect(data).toMatchObject({
      kind: 'docx',
      docToken: 'doccnA',
      title: 'Design notes',
      baselineTitle: 'Design notes',
      titleEditable: true,
      titleBlockId: 'blk-title',
      revisionId: '7',
    })
    expect(data.blocks.map(block => block.id)).toEqual([
      'blk-p1', 'blk-h2', 'blk-li1', 'blk-li2', 'blk-pre', 'blk-todo',
    ])
    expect(data.blocks.find(block => block.id === 'blk-p1')!.text).toBe('Hello <b>world</b>')
    expect(data.blocks.find(block => block.id === 'blk-pre')!.text).toBe('const x = 1')
    expect(data.blocks.find(block => block.id === 'blk-todo')!.attrs).toContain('done="false"')
    expect(data.readOnlyBlocks).toEqual([
      expect.objectContaining({ tag: 'table', text: 'Cell', order: 6 }),
    ])
    expect(source.descriptor.capabilities.edit).toBe(true)
    for (const type of source.types) {
      expect(type.capabilities).toMatchObject({ read: true, edit: true, concurrency: 'check-before-save' })
      expect(JSON.stringify(type.extensions)).toContain(DOCS_EDIT_SCOPE_NOTE)
    }
    expect(DOCS_EDIT_SCOPE_NOTE).toMatch(/text blocks/i)
    expect(DOCS_EDIT_SCOPE_NOTE).toMatch(/read-only/i)
    expect(DOCS_EDIT_SCOPE_NOTE).not.toMatch(/no lossless/i)
  })

  it('never advertises an unsafe title block id as editable', async () => {
    const runtime = new FakeLarkRuntime().enqueue(editFetch(
      7,
      '<title id="-1">Plan</title><p id="blk-p1">Body</p>',
    ))
    const { operations } = opsOf(runtime)
    const loaded = await operations.loadEdit!(
      { typeId: FEISHU_TYPE_IDS.docx, locator: { kind: 'docx', docToken: 'doccnA' } },
      context(),
    )
    const data = loaded.data as unknown as FeishuDocEditData
    expect(data.title).toBe('Plan')
    expect(data.titleEditable).toBe(false)
    expect(data.titleBlockId).toBeUndefined()
  })

  it('saves only the changed block through block_replace and returns the new revision', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(editFetch(7))
      // The save-time best-effort re-read: the changed block still matches.
      .enqueue(editFetch(7))
      .enqueue(okResult({ document: { revision_id: 8 }, result: 'success', updated_blocks_count: 1 }))
    const { operations } = opsOf(runtime)
    const locator = { kind: 'docx' as const, docToken: 'doccnA' }
    const loaded = await operations.loadEdit!(
      { typeId: FEISHU_TYPE_IDS.docx, locator },
      context(),
    )
    const data = withEditBlock(
      loaded.data as unknown as FeishuDocEditData,
      'blk-p1',
      'Hello <b>there</b>',
    )
    const result = await operations.saveEdit!(
      {
        typeId: FEISHU_TYPE_IDS.docx,
        locator,
        document: {
          format: FEISHU_FORMATS.docsXml,
          data: data as unknown as JsonValue,
          baseRevision: '7',
        },
      },
      context(),
    )
    expect(result.revision).toBe('8')
    const update = runtime.requests[2]!
    expect(update.args).toEqual([
      'docs', '+update',
      '--api-version', 'v2',
      '--doc', 'doccnA',
      '--command', 'block_replace',
      '--block-id', 'blk-p1',
      // `--content -` keeps the XML out of argv; the runner writes it to
      // stdin. A JSON/XML argv token is rejected by the Windows `.cmd` shim.
      '--content', '-',
      '--doc-format', 'xml',
      '--revision-id', '7',
      '--as', 'user', '--format', 'json',
    ])
    expect(update.stdin).toBe('<p>Hello <b>there</b></p>')
    expectWindowsSafeArgs(runtime)
    for (const request of runtime.requests) {
      expect(request.args.join(' ')).not.toMatch(/append|overwrite|block_delete|block_move_after|str_replace/)
    }
  })

  it('escapes plain text typed into an XML block instead of sending malformed XML', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(editFetch(7))
      .enqueue(editFetch(7))
      .enqueue(okResult({ document: { revision_id: 8 }, result: 'success', updated_blocks_count: 1 }))
    const { operations } = opsOf(runtime)
    const locator = { kind: 'docx' as const, docToken: 'doccnA' }
    const loaded = await operations.loadEdit!({ typeId: FEISHU_TYPE_IDS.docx, locator }, context())
    const data = withEditBlock(loaded.data as unknown as FeishuDocEditData, 'blk-p1', 'A & B')
    await operations.saveEdit!(
      {
        typeId: FEISHU_TYPE_IDS.docx,
        locator,
        document: { format: FEISHU_FORMATS.docsXml, data: data as unknown as JsonValue, baseRevision: '7' },
      },
      context(),
    )
    const update = runtime.requests[2]!
    expect(update.args).toEqual(expect.arrayContaining(['--content', '-']))
    expect(update.stdin).toBe('<p>A &amp; B</p>')
  })

  it('writes a large block through stdin instead of argv', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(editFetch(7))
      .enqueue(editFetch(7))
      .enqueue(okResult({ document: { revision_id: 8 }, result: 'success', updated_blocks_count: 1 }))
    const { operations } = opsOf(runtime)
    const locator = { kind: 'docx' as const, docToken: 'doccnA' }
    const loaded = await operations.loadEdit!({ typeId: FEISHU_TYPE_IDS.docx, locator }, context())
    const large = 'x'.repeat(40_000)
    const data = withEditBlock(loaded.data as unknown as FeishuDocEditData, 'blk-p1', large)
    await operations.saveEdit!(
      {
        typeId: FEISHU_TYPE_IDS.docx,
        locator,
        document: { format: FEISHU_FORMATS.docsXml, data: data as unknown as JsonValue, baseRevision: '7' },
      },
      context(),
    )
    const update = runtime.requests[2]!
    expect(update.args).toEqual(expect.arrayContaining(['--content', '-']))
    expect(update.stdin).toBe(`<p>${large}</p>`)
    // A >32 KiB payload is exactly what an argv-based call cannot carry safely.
    expect(update.args.every(arg => arg.length < 32 * 1024)).toBe(true)
    expectWindowsSafeArgs(runtime)
  })

  it('refuses malformed inline markup before issuing any write', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(editFetch(7))
      .enqueue(editFetch(7))
    const { operations } = opsOf(runtime)
    const locator = { kind: 'docx' as const, docToken: 'doccnA' }
    const loaded = await operations.loadEdit!({ typeId: FEISHU_TYPE_IDS.docx, locator }, context())
    const data = withEditBlock(loaded.data as unknown as FeishuDocEditData, 'blk-p1', '<b>unclosed')
    await expect(operations.saveEdit!(
      {
        typeId: FEISHU_TYPE_IDS.docx,
        locator,
        document: { format: FEISHU_FORMATS.docsXml, data: data as unknown as JsonValue, baseRevision: '7' },
      },
      context(),
    )).rejects.toMatchObject({ category: 'invalid-request' })
    // loadEdit + the save-time re-read only: the invalid block never reaches
    // docs +update.
    expect(runtime.requests).toHaveLength(2)
    expect(runtime.requests.every(request => request.args[1] !== '+update')).toBe(true)
  })

  it('edits the title only through its block id', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(editFetch(7))
      .enqueue(editFetch(7))
      .enqueue(okResult({ document: { revision_id: 9 }, result: 'success' }))
    const { operations } = opsOf(runtime)
    const locator = { kind: 'docx' as const, docToken: 'doccnA' }
    const loaded = await operations.loadEdit!(
      { typeId: FEISHU_TYPE_IDS.docx, locator },
      context(),
    )
    const data: FeishuDocEditData = { ...(loaded.data as unknown as FeishuDocEditData), title: 'Renamed' }
    await operations.saveEdit!(
      {
        typeId: FEISHU_TYPE_IDS.docx,
        locator,
        document: { format: FEISHU_FORMATS.docsXml, data: data as unknown as JsonValue, baseRevision: '7' },
      },
      context(),
    )
    expect(runtime.requests[2]!.args).toEqual(expect.arrayContaining([
      '--block-id', 'blk-title',
      '--content', '-',
    ]))
    expect(runtime.requests[2]!.stdin).toBe('<title>Renamed</title>')
  })

  it('re-fetches between block writes and advances the revision baseline', async () => {
    // lark-cli's guide: block_replace does not guarantee the target id survives,
    // so a multi-block save must re-fetch before the next block-level op.
    const runtime = new FakeLarkRuntime()
      .enqueue(editFetch(7))
      .enqueue(editFetch(7))
      .enqueue(okResult({ document: { revision_id: 8 }, result: 'success', updated_blocks_count: 1 }))
      .enqueue(editFetch(8))
      .enqueue(okResult({ document: { revision_id: 9 }, result: 'success', updated_blocks_count: 1 }))
    const { operations } = opsOf(runtime)
    const locator = { kind: 'docx' as const, docToken: 'doccnA' }
    const loaded = await operations.loadEdit!({ typeId: FEISHU_TYPE_IDS.docx, locator }, context())
    let data = withEditBlock(loaded.data as unknown as FeishuDocEditData, 'blk-p1', 'Hello <b>one</b>')
    data = withEditBlock(data, 'blk-h2', 'Section two')
    const result = await operations.saveEdit!(
      {
        typeId: FEISHU_TYPE_IDS.docx,
        locator,
        document: { format: FEISHU_FORMATS.docsXml, data: data as unknown as JsonValue, baseRevision: '7' },
      },
      context(),
    )
    expect(result.revision).toBe('9')
    expect(runtime.requests).toHaveLength(5)
    expect(runtime.requests.map(request => request.args.slice(0, 3))).toEqual([
      ['docs', '+fetch', '--api-version'],
      ['docs', '+fetch', '--api-version'],
      ['docs', '+update', '--api-version'],
      ['docs', '+fetch', '--api-version'],
      ['docs', '+update', '--api-version'],
    ])
    expect(runtime.requests[2]!.args).toEqual(expect.arrayContaining(['--revision-id', '7', '--block-id', 'blk-p1']))
    expect(runtime.requests[4]!.args).toEqual(expect.arrayContaining(['--revision-id', '8', '--block-id', 'blk-h2']))
  })

  it('reports a partial result when a re-fetch shows the next target changed externally', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(editFetch(7))
      .enqueue(editFetch(7))
      .enqueue(okResult({ document: { revision_id: 8 }, result: 'success', updated_blocks_count: 1 }))
      .enqueue(editFetch(8, EDIT_XML.replace('Section', 'Changed elsewhere')))
    const { operations } = opsOf(runtime)
    const locator = { kind: 'docx' as const, docToken: 'doccnA' }
    const loaded = await operations.loadEdit!({ typeId: FEISHU_TYPE_IDS.docx, locator }, context())
    let data = withEditBlock(loaded.data as unknown as FeishuDocEditData, 'blk-p1', 'Hello <b>one</b>')
    data = withEditBlock(data, 'blk-h2', 'Section two')
    await expect(operations.saveEdit!(
      {
        typeId: FEISHU_TYPE_IDS.docx,
        locator,
        document: { format: FEISHU_FORMATS.docsXml, data: data as unknown as JsonValue, baseRevision: '7' },
      },
      context(),
    )).rejects.toMatchObject({
      category: 'conflict',
      meta: { partial: 'true', written: 'blk-p1', unwritten: 'blk-h2' },
    })
    expect(runtime.requests).toHaveLength(4)
  })

  it('reports a first-block partial business result as partial, not plain failed', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(editFetch(7))
      .enqueue(editFetch(7))
      .enqueue(okResult({ document: { revision_id: 8 }, result: 'partial_success' }))
    const { operations } = opsOf(runtime)
    const locator = { kind: 'docx' as const, docToken: 'doccnA' }
    const loaded = await operations.loadEdit!({ typeId: FEISHU_TYPE_IDS.docx, locator }, context())
    const data = withEditBlock(loaded.data as unknown as FeishuDocEditData, 'blk-p1', 'Hello <b>one</b>')
    await expect(operations.saveEdit!(
      {
        typeId: FEISHU_TYPE_IDS.docx,
        locator,
        document: { format: FEISHU_FORMATS.docsXml, data: data as unknown as JsonValue, baseRevision: '7' },
      },
      context(),
    )).rejects.toMatchObject({
      meta: { partial: 'true', written: '', unwritten: 'blk-p1' },
    })
  })

  it('reports every unwritten block when the first of several is partial', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(editFetch(7))
      .enqueue(editFetch(7))
      .enqueue(okResult({ document: { revision_id: 8 }, result: 'partial_success' }))
    const { operations } = opsOf(runtime)
    const locator = { kind: 'docx' as const, docToken: 'doccnA' }
    const loaded = await operations.loadEdit!({ typeId: FEISHU_TYPE_IDS.docx, locator }, context())
    let data = withEditBlock(loaded.data as unknown as FeishuDocEditData, 'blk-p1', 'Hello <b>one</b>')
    data = withEditBlock(data, 'blk-h2', 'Section two')
    await expect(operations.saveEdit!(
      {
        typeId: FEISHU_TYPE_IDS.docx,
        locator,
        document: { format: FEISHU_FORMATS.docsXml, data: data as unknown as JsonValue, baseRevision: '7' },
      },
      context(),
    )).rejects.toMatchObject({
      meta: { partial: 'true', written: '', unwritten: 'blk-p1,blk-h2' },
    })
    // The business result was partial before any confirmed write: no retry and
    // no second block write is issued.
    expect(runtime.requests).toHaveLength(3)
  })

  it('returns conflict before writing when a changed block was already updated', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(editFetch(7))
      .enqueue(editFetch(8, EDIT_XML.replace('Hello <b>world</b>', 'Changed elsewhere')))
    const { operations } = opsOf(runtime)
    const locator = { kind: 'docx' as const, docToken: 'doccnA' }
    const loaded = await operations.loadEdit!(
      { typeId: FEISHU_TYPE_IDS.docx, locator },
      context(),
    )
    const data = withEditBlock(loaded.data as unknown as FeishuDocEditData, 'blk-p1', 'Hello <b>mine</b>')
    await expect(operations.saveEdit!(
      {
        typeId: FEISHU_TYPE_IDS.docx,
        locator,
        document: { format: FEISHU_FORMATS.docsXml, data: data as unknown as JsonValue, baseRevision: '7' },
      },
      context(),
    )).rejects.toMatchObject({ category: 'conflict' })
    expect(runtime.requests).toHaveLength(2)
  })

  it('detects an external revision-only change even when every changed block text is unchanged', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(editFetch(7))
      // Same text and same structure, but the document was revised elsewhere
      // (a comment, a style change, another unrelated block): the native
      // baseline no longer matches and the save must not proceed.
      .enqueue(editFetch(8, EDIT_XML))
    const { operations } = opsOf(runtime)
    const locator = { kind: 'docx' as const, docToken: 'doccnA' }
    const loaded = await operations.loadEdit!({ typeId: FEISHU_TYPE_IDS.docx, locator }, context())
    const data = withEditBlock(loaded.data as unknown as FeishuDocEditData, 'blk-p1', 'Hello <b>mine</b>')
    await expect(operations.saveEdit!(
      {
        typeId: FEISHU_TYPE_IDS.docx,
        locator,
        document: { format: FEISHU_FORMATS.docsXml, data: data as unknown as JsonValue, baseRevision: '7' },
      },
      context(),
    )).rejects.toMatchObject({ category: 'conflict' })
    expect(runtime.requests).toHaveLength(2)
  })

  it('detects an external attrs/tag-only change (p→h2, alignment, checkbox done)', async () => {
    const variants = [
      {
        content: EDIT_XML.replace('<p id="blk-p1">', '<p id="blk-p1" align="center">'),
        target: 'blk-p1',
      },
      {
        content: EDIT_XML
          .replace('<p id="blk-p1">', '<h3 id="blk-p1">')
          .replace('Hello <b>world</b></p>', 'Hello <b>world</b></h3>'),
        target: 'blk-p1',
      },
      {
        content: EDIT_XML.replace('done="false"', 'done="true"'),
        target: 'blk-todo',
      },
    ]
    for (const { content, target } of variants) {
      const runtime = new FakeLarkRuntime().enqueue(editFetch(7)).enqueue(editFetch(8, content))
      const { operations } = opsOf(runtime)
      const locator = { kind: 'docx' as const, docToken: 'doccnA' }
      const loaded = await operations.loadEdit!({ typeId: FEISHU_TYPE_IDS.docx, locator }, context())
      // Change the SAME block the external edit touched; its text still
      // matches, but the tag/attrs must make that a conflict.
      const data = withEditBlock(loaded.data as unknown as FeishuDocEditData, target, 'next text')
      await expect(operations.saveEdit!(
        {
          typeId: FEISHU_TYPE_IDS.docx,
          locator,
          document: { format: FEISHU_FORMATS.docsXml, data: data as unknown as JsonValue, baseRevision: '7' },
        },
        context(),
      )).rejects.toMatchObject({ category: 'conflict' })
      expect(runtime.requests).toHaveLength(2)
    }
  })

  it('rejects client-supplied block structure that does not match the loaded document', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(editFetch(7))
      .enqueue(editFetch(7))
      .enqueue(editFetch(7))
      .enqueue(editFetch(7))
    const { operations } = opsOf(runtime)
    const locator = { kind: 'docx' as const, docToken: 'doccnA' }
    const loaded = await operations.loadEdit!({ typeId: FEISHU_TYPE_IDS.docx, locator }, context())
    const base = loaded.data as unknown as FeishuDocEditData
    const forged: FeishuDocEditData = {
      ...base,
      blocks: base.blocks.map(block => block.id === 'blk-p1'
        ? { ...block, attrs: 'align="right"', text: 'forged' }
        : block),
    }
    await expect(operations.saveEdit!(
      {
        typeId: FEISHU_TYPE_IDS.docx,
        locator,
        document: { format: FEISHU_FORMATS.docsXml, data: forged as unknown as JsonValue, baseRevision: '7' },
      },
      context(),
    )).rejects.toMatchObject({ category: 'conflict' })
    expect(runtime.requests).toHaveLength(2)

    // A forged title block id is refused as well.
    const forgedTitle: FeishuDocEditData = {
      ...base,
      title: 'Renamed',
      titleBlockId: 'blk-p1',
    }
    await expect(operations.saveEdit!(
      {
        typeId: FEISHU_TYPE_IDS.docx,
        locator,
        document: { format: FEISHU_FORMATS.docsXml, data: forgedTitle as unknown as JsonValue, baseRevision: '7' },
      },
      context(),
    )).rejects.toMatchObject({ category: 'conflict' })
  })

  it('rejects an unsafe client block id before any write', async () => {
    const runtime = new FakeLarkRuntime()
    const { operations } = opsOf(runtime)
    const data = {
      kind: 'docx',
      docToken: 'doccnA',
      title: '',
      baselineTitle: '',
      titleEditable: false,
      titleAttrs: '',
      blocks: [{
        id: '-1',
        tag: 'p',
        attrs: '',
        text: 'x',
        baseline: 'y',
        kind: 'xml',
        order: 0,
      }],
      readOnlyBlocks: [],
    }
    await expect(operations.saveEdit!(
      {
        typeId: FEISHU_TYPE_IDS.docx,
        locator: { kind: 'docx', docToken: 'doccnA' },
        document: { format: FEISHU_FORMATS.docsXml, data: data as unknown as JsonValue },
      },
      context(),
    )).rejects.toMatchObject({ category: 'invalid-request' })
    expect(runtime.requests).toHaveLength(0)
  })

  it('sends only documented update flags (1.0.55 has no --reference-map)', async () => {
    // lark-cli 1.0.55's `docs +update --help` has no reference-map flag and its
    // fetch body never requests a sidecar. Passing the invented flag made every
    // save fail at argv parsing; the update must use only the real flags.
    const runtime = new FakeLarkRuntime()
      .enqueue(editFetch(7))
      .enqueue(editFetch(7))
      .enqueue(okResult({ document: { revision_id: 8 }, result: 'success', updated_blocks_count: 1 }))
    const { operations } = opsOf(runtime)
    const locator = { kind: 'docx' as const, docToken: 'doccnA' }
    const loaded = await operations.loadEdit!({ typeId: FEISHU_TYPE_IDS.docx, locator }, context())
    const data = withEditBlock(loaded.data as unknown as FeishuDocEditData, 'blk-p1', 'Hello <b>ref</b>')
    await operations.saveEdit!(
      {
        typeId: FEISHU_TYPE_IDS.docx,
        locator,
        document: { format: FEISHU_FORMATS.docsXml, data: data as unknown as JsonValue, baseRevision: '7' },
      },
      context(),
    )
    const update = runtime.requests[2]!
    expect(update.args).not.toContain('--reference-map')
    expect(update.args).toEqual(expect.arrayContaining(['--revision-id', '7']))
    // Load and save-time comparison both need block ids + styles.
    for (const request of runtime.requests.slice(0, 2)) {
      expect(request.args).toEqual(expect.arrayContaining(['--detail', 'full']))
    }
  })

  it('never reports a missing/unknown result, warnings or a wrong block count as full success', async () => {
    const badResults: JsonValue[] = [
      {},
      { result: 'unknown' },
      { result: 'failed' },
      { result: 'partial_success' },
      { result: 'success', warnings: ['one block was skipped'] },
      { result: 'success', warnings: 'not-an-array' },
      { result: 'success', updated_blocks_count: 2 },
      { result: 'success', updated_blocks_count: 'x' },
    ]
    for (const bad of badResults) {
      const runtime = new FakeLarkRuntime()
        .enqueue(editFetch(7))
        .enqueue(editFetch(7))
        .enqueue(okResult({ document: { revision_id: 8 }, ...(bad as Record<string, JsonValue>) }))
      const { operations } = opsOf(runtime)
      const locator = { kind: 'docx' as const, docToken: 'doccnA' }
      const loaded = await operations.loadEdit!({ typeId: FEISHU_TYPE_IDS.docx, locator }, context())
      const data = withEditBlock(loaded.data as unknown as FeishuDocEditData, 'blk-p1', 'Hello <b>x</b>')
      await expect(operations.saveEdit!(
        {
          typeId: FEISHU_TYPE_IDS.docx,
          locator,
          document: { format: FEISHU_FORMATS.docsXml, data: data as unknown as JsonValue, baseRevision: '7' },
        },
        context(),
      )).rejects.toMatchObject({ category: 'failed' })
    }
  })

  it('loads a title-less document but refuses a valid prefix followed by a malformed tail', async () => {
    const good = new FakeLarkRuntime().enqueue(editFetch(7, '<p id="blk-only">Body</p>'))
    const goodOps = opsOf(good).operations
    const loaded = await goodOps.loadEdit!(
      { typeId: FEISHU_TYPE_IDS.docx, locator: { kind: 'docx', docToken: 'doccnA' } },
      context(),
    )
    expect(loaded.data).toMatchObject({ title: '', titleEditable: false })
    expect((loaded.data as unknown as FeishuDocEditData).blocks.map(block => block.id)).toEqual(['blk-only'])

    const bad = new FakeLarkRuntime().enqueue(editFetch(7, '<p id="blk-a">ok</p><p id="blk-b>broken'))
    const badOps = opsOf(bad).operations
    await expect(badOps.loadEdit!(
      { typeId: FEISHU_TYPE_IDS.docx, locator: { kind: 'docx', docToken: 'doccnA' } },
      context(),
    )).rejects.toMatchObject({ category: 'failed' })
  })

  it('reports a partial success when a later block write fails', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(editFetch(7))
      .enqueue(editFetch(7))
      .enqueue(okResult({ document: { revision_id: 8 }, result: 'success' }))
      .enqueue(editFetch(8))
      .enqueue(failResult({
        type: 'permission',
        subtype: 'forbidden',
        message: 'raw failure with a Bearer secret-token',
      }))
    const { operations } = opsOf(runtime)
    const locator = { kind: 'docx' as const, docToken: 'doccnA' }
    const loaded = await operations.loadEdit!(
      { typeId: FEISHU_TYPE_IDS.docx, locator },
      context(),
    )
    let data = withEditBlock(loaded.data as unknown as FeishuDocEditData, 'blk-p1', 'Hello <b>one</b>')
    data = withEditBlock(data, 'blk-h2', 'Section two')
    let failure: unknown
    try {
      await operations.saveEdit!(
        {
          typeId: FEISHU_TYPE_IDS.docx,
          locator,
          document: { format: FEISHU_FORMATS.docsXml, data: data as unknown as JsonValue, baseRevision: '7' },
        },
        context(),
      )
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(ClueError)
    const clueError = failure as ClueError
    expect(clueError.category).toBe('permission-denied')
    expect(clueError.message).toMatch(/partial success/)
    expect(clueError.meta).toMatchObject({ partial: 'true', written: 'blk-p1', unwritten: 'blk-h2' })
    expect(clueError.message).not.toMatch(/secret-token|raw failure/)
  })

  it('refuses an agent save before any CLI call', async () => {
    const runtime = new FakeLarkRuntime()
    const { operations } = opsOf(runtime)
    await expect(operations.saveEdit!(
      {
        typeId: FEISHU_TYPE_IDS.docx,
        locator: { kind: 'docx', docToken: 'doccnA' },
        document: { format: FEISHU_FORMATS.docsXml, data: {} },
      },
      { ...context(), caller: 'agent' },
    )).rejects.toMatchObject({ category: 'permission-denied' })
    expect(runtime.requests).toHaveLength(0)
  })
})

describe('service integration: stable identity and block edits', () => {
  it('lets a foreign locator pass through the source order instead of aborting auto resolution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-clues-feishu-foreign-'))
    const runtime = new FakeLarkRuntime()
    const guid = '2f4d8c1e-7a3b-4c5d-9e8f-0123456789ab'
    const service = createCluesService({
      store: new CluesStore({ root }),
      builtinSources: [
        createFeishuDocsSource(() => runtime.asRuntime()),
        createFeishuTasksSource(() => runtime.asRuntime()),
      ],
      now: () => '2026-10-17T00:00:00.000Z',
    })
    try {
      // The docs source (order 3) sees `{kind:'task'}` first. Answering
      // invalid-request used to abort before the task source (order 4) ran.
      const tasks = await service.resolve({
        workspaceId: 'ws-feishu',
        locator: { kind: 'task', guid },
      })
      expect(tasks).toHaveLength(1)
      expect(tasks[0]).toMatchObject({
        sourceId: FEISHU_SOURCE_IDS.tasks,
        locator: { kind: 'task', guid },
      })
      // The wiki-space locator reaches the task source after docs declines it;
      // it must not throw either.
      const scope = await service.resolve({
        workspaceId: 'ws-feishu',
        locator: { kind: 'wiki-space', spaceId: '7123' },
      })
      expect(scope).toEqual([])
      expect(runtime.requests).toHaveLength(0)
    } finally {
      service.dispose()
      removeTree(root)
    }
  })

  it('dedupes a resolved wiki node with its underlying docx and edits through the service', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-clues-feishu-docs-'))
    const runtime = new FakeLarkRuntime()
      .enqueue(editFetch(7))
      .enqueue(editFetch(7))
      .enqueue(okResult({ document: { revision_id: 8 }, result: 'success' }))
    const service = createCluesService({
      store: new CluesStore({ root }),
      builtinSources: [sourceWith(runtime)],
      now: () => '2026-10-17T00:00:00.000Z',
    })
    try {
      const wiki = await service.ensure({
        workspaceId: 'ws-feishu',
        sourceId: 'builtin.feishu.docs',
        typeId: FEISHU_TYPE_IDS.wiki,
        locator: {
          kind: 'wiki',
          wikiToken: 'wikcnN',
          objToken: 'doccnO',
          objType: 'docx',
        },
        title: 'Same document',
      })
      const direct = await service.ensure({
        workspaceId: 'ws-feishu',
        sourceId: 'builtin.feishu.docs',
        typeId: FEISHU_TYPE_IDS.docx,
        locator: { kind: 'docx', docToken: 'doccnO' },
        title: 'Same document',
      })
      expect(direct.created).toBe(false)
      expect(direct.clue.id).toBe(wiki.clue.id)

      const loaded = await service.loadEdit({ workspaceId: 'ws-feishu', clueId: wiki.clue.id })
      const data = withEditBlock(
        loaded.data as unknown as FeishuDocEditData,
        'blk-p1',
        'Hello <b>service</b>',
      )
      const saved = await service.saveEdit({
        workspaceId: 'ws-feishu',
        clueId: wiki.clue.id,
        document: {
          format: FEISHU_FORMATS.docsXml,
          data: data as unknown as JsonValue,
          baseRevision: loaded.baseRevision,
        },
      })
      expect(saved.revision).toBe('8')

      // An agent-originated save is refused before the source runs.
      await expect(service.saveEdit({
        workspaceId: 'ws-feishu',
        clueId: wiki.clue.id,
        document: { format: FEISHU_FORMATS.docsXml, data: data as unknown as JsonValue },
      }, { caller: 'agent' })).rejects.toMatchObject({ category: 'permission-denied' })
      expect(runtime.requests).toHaveLength(3)
    } finally {
      service.dispose()
      removeTree(root)
    }
  })
})

describe('docs portable and errors', () => {
  it('propagates the safe missing-scope detail through the service and reports the connection observation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-clues-feishu-scope-'))
    const runtime = new FakeLarkRuntime().enqueue(failResult({
      type: 'authorization',
      subtype: 'missing_scope',
      missing_scopes: ['docx:document:read'],
      console_url: 'https://open.feishu.cn/app/cli_x/auth',
      message: 'Bearer secret-token leaked',
    }))
    const service = createCluesService({
      store: new CluesStore({ root }),
      builtinSources: [sourceWith(runtime)],
      now: () => '2026-10-17T00:00:00.000Z',
    })
    try {
      const ensured = await service.ensure({
        workspaceId: 'ws-feishu',
        sourceId: 'builtin.feishu.docs',
        typeId: FEISHU_TYPE_IDS.docx,
        locator: { kind: 'docx', docToken: 'doccnA' },
        title: 'A document',
      })
      let failure: unknown
      try {
        await service.read({ workspaceId: 'ws-feishu', clueId: ensured.clue.id })
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(ClueError)
      const clueError = failure as ClueError
      expect(clueError.category).toBe('auth-required')
      expect(clueError.message).toContain('docx:document:read')
      expect(clueError.message).toContain('https://open.feishu.cn/app/cli_x/auth')
      expect(clueError.message).not.toMatch(/secret-token/)
      expect(runtime.reports).toHaveLength(1)
      expect(runtime.reports[0]!.inspection.authorization).toBe('scope-insufficient')
    } finally {
      service.dispose()
      removeTree(root)
    }
  })

  it('exports only resource identifiers + original URL/host (never a token)', async () => {
    const runtime = new FakeLarkRuntime()
    const { operations } = opsOf(runtime)
    const portable = await operations.portable!(
      {
        typeId: FEISHU_TYPE_IDS.docx,
        locator: { kind: 'docx', docToken: 'doccnA', url: `${PROBE}/docx/doccnA` },
      },
      context(),
    )
    expect(portable).toEqual({
      portable: true,
      locator: {
        kind: 'docx',
        docToken: 'doccnA',
        url: `${PROBE}/docx/doccnA`,
        host: 'acme.feishu.cn',
      },
    })
    expect(JSON.stringify(portable)).not.toMatch(/accessToken|refreshToken|authorization|Bearer/i)
    expect(runtime.requests).toHaveLength(0)
  })

  it('exports a wiki node with its node + underlying identifiers and host', async () => {
    const { operations } = opsOf(new FakeLarkRuntime())
    const portable = await operations.portable!(
      {
        typeId: FEISHU_TYPE_IDS.wiki,
        locator: {
          kind: 'wiki',
          wikiToken: 'wikcnN',
          objToken: 'doccnO',
          objType: 'docx',
          url: `${PROBE}/wiki/wikcnN`,
        },
      },
      context(),
    )
    expect(portable).toMatchObject({
      portable: true,
      locator: {
        kind: 'wiki',
        wikiToken: 'wikcnN',
        objToken: 'doccnO',
        objType: 'docx',
        host: 'acme.feishu.cn',
      },
    })
  })

  it('refuses to export a browsing scope as a document', async () => {
    const { operations } = opsOf(new FakeLarkRuntime())
    const portable = await operations.portable!(
      { typeId: FEISHU_TYPE_IDS.wiki, locator: { kind: 'wiki-space', spaceId: '9' } },
      context(),
    )
    expect(portable).toMatchObject({ portable: false })
    expect(portable.reason).toMatch(/scope/)
    const folder = await operations.portable!(
      { typeId: FEISHU_TYPE_IDS.docx, locator: { kind: 'drive-folder', folderToken: 'fldX' } },
      context(),
    )
    expect(folder).toMatchObject({ portable: false })
    expect(folder.reason).toMatch(/folder.*scope|scope.*folder/)
  })

  it('maps a missing-scope failure to a safe auth error with no raw stderr', async () => {
    const runtime = new FakeLarkRuntime().enqueue(failResult({
      type: 'authorization',
      subtype: 'missing_scope',
      missing_scopes: ['docx:document:read'],
      console_url: 'https://open.feishu.cn/app/cli_x/auth',
      message: 'Bearer secret-token leaked',
      hint: 'raw hint',
    }))
    const { operations } = opsOf(runtime)
    let failure: unknown
    try {
      await operations.read!(
        { typeId: FEISHU_TYPE_IDS.docx, locator: { kind: 'docx', docToken: 'doccnA' } },
        context(),
      )
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(ClueError)
    const clueError = failure as ClueError
    expect(clueError.category).toBe('auth-required')
    expect(clueError.message).not.toMatch(/secret-token|raw hint/)
    expect(clueError.meta?.missingScopes).toBe('docx:document:read')
    // The wire only carries { code, message }; the actionable detail must be in
    // the message, and the resource request must update the shared connection.
    expect(clueError.message).toContain('docx:document:read')
    expect(clueError.message).toContain('https://open.feishu.cn/app/cli_x/auth')
    expect(runtime.reports).toHaveLength(1)
    expect(runtime.reports[0]).toMatchObject({
      connectionId: FEISHU_CONNECTION_ID,
      inspection: {
        configuration: 'ready',
        authorization: 'scope-insufficient',
      },
    })
    expect(runtime.reports[0]!.inspection.detail).toContain('docx:document:read')
    expect(runtime.reports[0]!.inspection.detail).toContain('https://open.feishu.cn/app/cli_x/auth')
  })

  it('does not publish a ready authorization from a 403 resource failure', async () => {
    const runtime = new FakeLarkRuntime().enqueue(failResult({
      type: 'permission',
      subtype: 'forbidden',
      code: 403,
      console_url: 'https://open.feishu.cn/app/cli_x/auth',
      message: 'raw permission detail',
    }))
    const { operations } = opsOf(runtime)
    await expect(operations.read!(
      { typeId: FEISHU_TYPE_IDS.docx, locator: { kind: 'docx', docToken: 'doccnA' } },
      context(),
    )).rejects.toMatchObject({ category: 'permission-denied' })
    expect(runtime.reports).toHaveLength(1)
    // A failed request is not evidence that the user authorization is ready.
    expect(runtime.reports[0]!.inspection).toMatchObject({
      configuration: 'ready',
      authorization: 'unknown',
    })
    expect(runtime.reports[0]!.inspection.authorization).not.toBe('ready')
    expect(runtime.reports[0]!.inspection.detail).toContain('https://open.feishu.cn/app/cli_x/auth')
    expect(JSON.stringify(runtime.reports[0])).not.toMatch(/raw permission detail/)
  })
})
