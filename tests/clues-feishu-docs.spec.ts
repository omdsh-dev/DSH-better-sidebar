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
 *   long content is an explicit fragment with `nextOffset`, the
 *   reference_map sidecar travels with the content, and an oversized document
 *   reports lark-cli's 8 MiB capture limit instead of returning a partial read;
 * - docs are READ-ONLY: no loadEdit/saveEdit exists, because lark-cli has no
 *   lossless local text-block write (append/overwrite/block rewrite forbidden);
 * - portable locators export only resource identifiers + original URL/host,
 *   never an access token.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClueError } from '../src/clues/types.ts'
import type { ClueCandidate, ClueOperationContext } from '../src/clues/types.ts'
import { createFeishuDocsSource } from '../src/clues/sources/feishu/docs.ts'
import { createCluesService } from '../src/clues/service.ts'
import { CluesStore } from '../src/clues/store.ts'
import { removeTree } from './temp-tree.ts'
import { DOCS_EDIT_LIMITATION, FEISHU_CONNECTION_ID, FEISHU_FORMATS, FEISHU_TYPE_IDS } from '../src/clues/sources/feishu/format.ts'
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

describe('docs browsing ranges', () => {
  it('refuses to list without an explicit range and performs no CLI call', async () => {
    const runtime = new FakeLarkRuntime()
    const { operations } = opsOf(runtime)
    await expect(operations.list!({}, context())).rejects.toMatchObject({
      category: 'invalid-request',
    })
    expect(runtime.requests).toHaveLength(0)
  })

  it('lists one Drive folder page with the native folder_token/page_size/page_token params', async () => {
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
      '--params', JSON.stringify({ folder_token: 'fldRoot', page_size: 200 }),
      '--as', 'user', '--format', 'json',
    ])
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
    expect(runtime.requests[1]!.args[4]).toBe(JSON.stringify({
      folder_token: 'fldRoot', page_size: 100, page_token: 'pt-2',
    }))
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
    expect(runtime.requests[1]!.args[4]).toBe(JSON.stringify({
      folder_token: 'fldChild', page_size: 100,
    }))
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
    expect(runtime.requests[0]!.args[4]).toBe(JSON.stringify({ folder_token: '', page_size: 100 }))
    expect(page.limited).toBe(true)
    expect(page.nextCursor).toBeUndefined()
    expect(page.total).toBeUndefined()
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

  it('lists wiki spaces as ONE explicit page (scope picker rows, not documents)', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({
      spaces: [{ space_id: '9001', name: 'Engineering', space_type: 'team', visibility: 'private' }],
      has_more: false,
    }))
    const { operations } = opsOf(runtime)
    const page = await operations.list!({ scope: { kind: 'wiki-spaces' } }, context())
    expect(runtime.requests[0]!.args).toEqual([
      'wiki', '+space-list', '--page-size', '50', '--as', 'user', '--format', 'json',
    ])
    expect(page.items[0]).toMatchObject({
      typeId: FEISHU_TYPE_IDS.wiki,
      locator: { kind: 'wiki-space', spaceId: '9001' },
      title: 'Engineering',
      meta: { role: 'scope' },
    })
  })
})

describe('docs search', () => {
  it('uses one official drive +search page, scoped and without --page-all', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({
      results: [
        {
          doc_type: 'DOCX',
          token: 'doccnA',
          title: 'Quarterly <hb>plan</hb>',
          url: 'https://acme.feishu.cn/docx/doccnA',
          edit_time: '1700000000',
        },
        { doc_type: 'WIKI', token: 'wikcnB', title: 'Wiki page', url: 'https://acme.feishu.cn/wiki/wikcnB' },
        { doc_type: 'SHEET', token: 'sht1', title: 'Sheet' },
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
      '--doc-types', 'docx,wiki,doc',
      '--folder-tokens', 'fldRoot',
      '--page-size', '20',
      '--as', 'user', '--format', 'json',
    ])
    expect(page.items.map(item => item.typeId)).toEqual([FEISHU_TYPE_IDS.docx, FEISHU_TYPE_IDS.wiki])
    expect(page.items[0]!.title).toBe('Quarterly plan')
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

  it('ignores a foreign URL instead of guessing a Feishu resource', async () => {
    const runtime = new FakeLarkRuntime()
    const { operations } = opsOf(runtime)
    expect(await operations.resolve!({ text: 'https://github.com/o/r/issues/1' }, context())).toBeUndefined()
    expect(runtime.requests).toHaveLength(0)
  })

  it('unpacks a wiki URL to its underlying docx object (never uses the wiki token as docx)', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({
      node: {
        obj_type: 'docx',
        obj_token: 'doccnUNDERLYING',
        node_token: 'wikcnNODE',
        space_id: '7123',
        title: 'Resolved wiki doc',
      },
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
      node: { obj_type: 'sheet <script>alert(1)</script>', obj_token: 'sht1', node_token: 'wikcnSheet' },
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
})

describe('docs read', () => {
  it('reads the latest XML by default and keeps content + revision + reference_map together', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({
      document: {
        document_id: 'doccnA',
        revision_id: 12,
        content: '<title>Design notes</title><p>Hello</p>',
        reference_map: { p: {} },
      },
    }))
    const { operations } = opsOf(runtime)
    const result = await operations.read!(
      { typeId: FEISHU_TYPE_IDS.docx, locator: { kind: 'docx', docToken: 'doccnA' } },
      context(),
    )
    expect(runtime.requests[0]!.args).toEqual([
      'docs', '+fetch', '--doc', 'doccnA',
      '--doc-format', 'xml',
      '--detail', 'simple',
      '--as', 'user', '--format', 'json',
    ])
    expect(result.format).toBe(FEISHU_FORMATS.docsXml)
    expect(result.revision).toBe('12')
    expect(result.text).toBe('<title>Design notes</title><p>Hello</p>')
    expect(result.freshness).toBe('live')
    expect(result.data).toMatchObject({
      kind: 'docx',
      title: 'Design notes',
      projection: 'xml',
      content: '<title>Design notes</title><p>Hello</p>',
      docToken: 'doccnA',
      revisionId: '12',
      referenceMap: { p: {} },
    })
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
    expect(runtime.requests[0]!.args[5]).toBe('markdown')
    expect(result.format).toBe(FEISHU_FORMATS.docsMarkdown)
    // Markdown has no <title>; the exported first heading is the real title,
    // not a token-derived fallback.
    expect(result.data).toMatchObject({ projection: 'markdown', title: 'Design notes' })
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
    expect(runtime.requests[0]!.args[3]).toBe('doccnObj')
    expect(runtime.requests[0]!.args[4]).toBe('--doc-format')
    expect(result.data).toMatchObject({ kind: 'wiki', wikiToken: 'wikcnN', objToken: 'doccnObj' })
  })

  it('unpacks an unresolved wiki locator before fetching it', async () => {
    const runtime = new FakeLarkRuntime()
      .enqueue(okResult({
        node: { obj_type: 'docx', obj_token: 'doccnObj', node_token: 'wikcnN', title: 'W' },
      }))
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
    expect(runtime.requests[1]!.args[3]).toBe('doccnObj')
    expect(result.data).toMatchObject({ title: 'W', objToken: 'doccnObj' })
  })

  it('returns an explicit fragment and nextOffset for long content (no silent truncation)', async () => {
    const content = 'x'.repeat(300_000)
    const runtime = new FakeLarkRuntime()
      .enqueue(okResult({ document: { document_id: 'doccnA', revision_id: 9, content } }))
      .enqueue(okResult({ document: { document_id: 'doccnA', revision_id: 9, content } }))
    const { operations } = opsOf(runtime)
    const first = await operations.read!(
      { typeId: FEISHU_TYPE_IDS.docx, locator: { kind: 'docx', docToken: 'doccnA' } },
      context(),
    )
    expect(first.limited).toBe(true)
    expect(first.nextOffset).toBeGreaterThan(0)
    expect(first.text!.length).toBeLessThan(content.length)
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
    expect(first.text! + second.text!).toBe(content)
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
    expect(clueError.message).toMatch(/8 MiB capture limit/)
    expect(clueError.message).toMatch(/cannot be read/)
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

  it('is read-only: no loadEdit/saveEdit path and the type says why', () => {
    const runtime = new FakeLarkRuntime()
    const { source, operations } = opsOf(runtime)
    expect(operations.loadEdit).toBeUndefined()
    expect(operations.saveEdit).toBeUndefined()
    expect(source.descriptor.capabilities.edit).toBe(false)
    for (const type of source.types) {
      expect(type.capabilities.edit).toBe(false)
      expect(type.capabilities.concurrency).toBe('none')
      expect(JSON.stringify(type.extensions)).toContain(DOCS_EDIT_LIMITATION)
    }
    expect(DOCS_EDIT_LIMITATION).toMatch(/read-only/)
    expect(DOCS_EDIT_LIMITATION).toMatch(/append|overwrite/)
    // The user-visible reason names the actual documented verbs: str_replace is
    // a whole-document find/replace, not a block-scoped edit.
    expect(DOCS_EDIT_LIMITATION).toMatch(/str_replace/)
    expect(DOCS_EDIT_LIMITATION).toMatch(/block scope|whole-document/)
  })
})

describe('service integration: stable identity and the read-only path', () => {
  it('dedupes a resolved wiki node with its underlying docx and rejects edit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-clues-feishu-docs-'))
    const service = createCluesService({
      store: new CluesStore({ root }),
      builtinSources: [sourceWith(new FakeLarkRuntime())],
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

      // The service refuses the edit before the source is even asked.
      await expect(service.loadEdit({ workspaceId: 'ws-feishu', clueId: wiki.clue.id }))
        .rejects.toMatchObject({ category: 'unsupported' })
      await expect(service.saveEdit({
        workspaceId: 'ws-feishu',
        clueId: wiki.clue.id,
        document: { format: FEISHU_FORMATS.docsXml, data: {} },
      })).rejects.toMatchObject({ category: 'unsupported' })
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
})
