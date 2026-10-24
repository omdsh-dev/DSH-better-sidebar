/**
 * `fs.readPage`: the byte-window reader behind the over-limit preview.
 *
 * The contract the client's pager depends on, pinned here:
 *
 * - a page is LINE-ALIGNED, so the client can treat one response as whole
 *   lines (and, for a JSONL file, whole records) without re-splitting;
 * - a single line longer than the window is returned UNTRIMMED rather than
 *   empty, so a pathological record cannot stall the pager in a loop that
 *   never advances;
 * - `nextOffset` always moves forward, and `eof` is exact, so "next page" can
 *   never revisit bytes;
 * - every page of one file decodes under the SAME encoding — a page that
 *   happens to be pure ASCII must not be decoded as UTF-8 while a later GBK
 *   page of the same document decodes as GBK, which would splice two
 *   spellings into one mojibake document.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'
import { encodeText } from '../src/text-encoding.ts'
import { PAGE_BYTES } from '../src/editor-limits.ts'
import type { SidebarWebRoute } from '../src/context-types.ts'
import { removeTree } from './temp-tree.ts'

interface FakeContext {
  connection: { requestRejection: () => undefined }
  webServer: {
    register: (route: SidebarWebRoute) => () => void
    registerUpgrade: () => () => void
  }
  sessions: { get: (id: string) => { header: { cwd?: string } } | undefined }
  tools: { register: () => () => void }
  effect: (fn: () => void | (() => void)) => void
  inject: (deps: readonly string[], callback: (sctx: never) => void) => () => void
  on: () => () => void
  get: (key: string) => undefined
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) removeTree(root)
})

/** A fresh workspace under the OS temp dir, cleaned up after the test. */
function workspaceWith(name: string, contents: Buffer | string): string {
  const root = mkdtempSync(join(tmpdir(), `dsh-sidebar-page-${name}-`))
  roots.push(root)
  writeFileSync(join(root, 'f.txt'), contents)
  return root
}

/** Mount the plugin and hand back the JSON api route (paging rides it). */
function mountApi(workspace: string): SidebarWebRoute {
  const routes: SidebarWebRoute[] = []
  const ctx: FakeContext = {
    connection: { requestRejection: () => undefined },
    webServer: { register: (route) => { routes.push(route); return () => {} }, registerUpgrade: () => () => {} },
    sessions: { get: () => ({ header: { cwd: workspace } }) },
    tools: { register: () => () => {} },
    effect: (fn) => { fn() },
    inject: () => () => {},
    on: () => () => {},
    get: () => undefined,
  }
  apply(ctx as never, {})
  return routes.find(route => route.path === '/sidebar/api')!
}

interface PageValue {
  kind?: string
  text?: string
  offset?: number
  nextOffset?: number
  eof?: boolean
  size?: number
  encoding?: string
}

async function readPage(
  route: SidebarWebRoute,
  path: string,
  offset: number,
): Promise<{ ok: boolean; status: number; value?: PageValue; error?: { code?: string; message?: string } }> {
  const body = Buffer.from(JSON.stringify({ sessionId: 's', path, offset }))
  const req = {
    method: 'POST',
    url: '/sidebar/api/fs.readPage',
    headers: { host: '127.0.0.1:3080' },
    [Symbol.asyncIterator]: async function* () { yield body },
  } as never
  const out = { status: 200, body: '' }
  const res = {
    writeHead: (status: number) => { out.status = status },
    end: (chunk: unknown) => { out.body += String(chunk ?? '') },
  } as never
  await route.handler(req, res)
  return { ...JSON.parse(out.body) as { ok: boolean; value?: PageValue; error?: { code?: string } }, status: out.status }
}

/** Walk every page of a file and concatenate what the client would render. */
async function readWhole(route: SidebarWebRoute, path: string): Promise<{ text: string; pages: number; eof: boolean }> {
  let offset = 0
  let text = ''
  let pages = 0
  for (;;) {
    const page = await readPage(route, path, offset)
    expect(page.ok, JSON.stringify(page)).toBe(true)
    text += page.value?.text ?? ''
    pages += 1
    // A page that neither advances nor claims EOF would loop forever; the
    // assertion turns that into a failure instead of a hung suite.
    expect(page.value!.nextOffset!, `page ${pages} did not advance`).toBeGreaterThan(offset)
    offset = page.value!.nextOffset!
    if (page.value!.eof === true) return { text, pages, eof: true }
    expect(pages).toBeLessThan(1000)
  }
}

describe('fs.readPage', () => {
  it('returns the whole file in one page when it fits, reporting eof', async () => {
    const workspace = workspaceWith('small', 'one\ntwo\nthree\n')
    const route = mountApi(workspace)
    const page = await readPage(route, join(workspace, 'f.txt'), 0)
    expect(page.value).toMatchObject({ kind: 'text', text: 'one\ntwo\nthree\n', offset: 0, eof: true })
    expect(page.value!.nextOffset).toBe(14)
    expect(page.value!.size).toBe(14)
  })

  it('splits a large file into line-aligned pages that reassemble byte-identically', async () => {
    const line = `${'x'.repeat(79)}\n`
    const content = line.repeat(10_000)
    expect(content.length).toBeGreaterThan(PAGE_BYTES * 2)
    const workspace = workspaceWith('large', content)
    const route = mountApi(workspace)
    const walked = await readWhole(route, join(workspace, 'f.txt'))
    expect(walked.text).toBe(content)
    expect(walked.pages).toBeGreaterThan(1)

    // Every page but the last ends exactly on a newline: that is what makes a
    // page a whole number of lines (and a whole number of JSONL records).
    const first = await readPage(route, join(workspace, 'f.txt'), 0)
    expect(first.value!.text!.endsWith('\n')).toBe(true)
    expect(first.value!.eof).toBe(false)
    // Aligned AND bounded: a page never exceeds the window by more than the
    // one line it had to keep whole.
    expect(Buffer.byteLength(first.value!.text!, 'utf8')).toBeLessThanOrEqual(PAGE_BYTES)
  })

  it('returns an over-long single line untrimmed instead of an empty page', async () => {
    // One line, no newline at all, longer than the window: trimming to "the
    // last newline" would yield ''. The reader must hand back bytes, or the
    // client's next-page button would spin on an offset that never moves.
    const content = 'y'.repeat(PAGE_BYTES + 5000)
    const workspace = workspaceWith('oneline', content)
    const route = mountApi(workspace)
    const first = await readPage(route, join(workspace, 'f.txt'), 0)
    expect(first.value!.text!.length).toBe(PAGE_BYTES)
    expect(first.value!.nextOffset).toBe(PAGE_BYTES)
    expect(first.value!.eof).toBe(false)
    const walked = await readWhole(route, join(workspace, 'f.txt'))
    expect(walked.text).toBe(content)
  })

  it('answers an offset at or past the end with an empty eof page', async () => {
    const workspace = workspaceWith('past-end', 'abc\n')
    const route = mountApi(workspace)
    const page = await readPage(route, join(workspace, 'f.txt'), 999)
    expect(page.value).toMatchObject({ kind: 'text', text: '', eof: true })
    expect(page.value!.nextOffset).toBe(4)
  })

  it('treats a missing offset as 0 and clamps garbage to 0', async () => {
    const workspace = workspaceWith('defaults', 'abc\n')
    const route = mountApi(workspace)
    const body = Buffer.from(JSON.stringify({ sessionId: 's', path: join(workspace, 'f.txt') }))
    const req = {
      method: 'POST',
      url: '/sidebar/api/fs.readPage',
      headers: { host: '127.0.0.1:3080' },
      [Symbol.asyncIterator]: async function* () { yield body },
    } as never
    const out = { status: 200, body: '' }
    const res = {
      writeHead: (status: number) => { out.status = status },
      end: (chunk: unknown) => { out.body += String(chunk ?? '') },
    } as never
    await route.handler(req, res)
    const parsed = JSON.parse(out.body) as { ok: boolean; value?: PageValue }
    expect(parsed.value).toMatchObject({ text: 'abc\n', offset: 0 })
  })

  it('recovers the right text from a GBK file whose pages disagree about the encoding', async () => {
    // The genuinely hard case, and a real one (a GBK log with a long ASCII
    // preamble): a page that is pure ASCII sniffs as UTF-8, a later page with
    // GBK bytes sniffs as GBK. Locking the first verdict for the whole file
    // would decode the GBK tail as UTF-8 replacement characters; sniffing each
    // page is what recovers BOTH halves — and it is safe because pages are
    // line-aligned, so no character is ever split across the boundary.
    const asciiBlock = 'plain ascii filler line\n'.repeat(PAGE_BYTES / 22 + 200)
    const gbkPart = '中文内容第二段\n'.repeat(200)
    const content = Buffer.concat([Buffer.from(asciiBlock, 'utf8'), encodeText(gbkPart, 'gbk')])
    expect(Buffer.byteLength(asciiBlock, 'utf8')).toBeGreaterThan(PAGE_BYTES)
    const workspace = workspaceWith('gbk', content)
    const route = mountApi(workspace)
    const walked = await readWhole(route, join(workspace, 'f.txt'))
    expect(walked.pages).toBeGreaterThan(1)
    // The bytes are all there, and the GBK tail reads as the text it encodes
    // rather than as replacement characters.
    expect(walked.text).toBe(asciiBlock + gbkPart)
  })

  it('locks a WIDE encoding for the whole file even when a page cannot prove it', async () => {
    // The mirror image of the case above, and the reason the lock exists at
    // all. BOM-less UTF-16 is detected from its NUL pattern over a SAMPLE, and
    // a CJK-only stretch of UTF-16LE is almost all non-zero bytes: `中` is
    // `2D 4E`, and only the newlines contribute a NUL. A page that is pure CJK
    // therefore fails the detector outright — so without the lock the tail of
    // this document would come back as replacement characters while its ASCII
    // head came back fine.
    const asciiPrefix = 'ascii header line\n'.repeat(9000)
    const cjkTail = '中文字符测试\n'.repeat(20_000)
    // Buffer.from(_, 'utf16le') writes no BOM: this is BOM-less wide text,
    // exactly the shape the lock protects.
    const content = Buffer.concat([
      Buffer.from(asciiPrefix, 'utf16le'),
      Buffer.from(cjkTail, 'utf16le'),
    ])
    expect(Buffer.byteLength(cjkTail, 'utf16le')).toBeGreaterThan(PAGE_BYTES * 2)
    const workspace = workspaceWith('utf16', content)
    const route = mountApi(workspace)
    const first = await readPage(route, join(workspace, 'f.txt'), 0)
    expect(first.value!.encoding).toBe('utf16le')
    const walked = await readWhole(route, join(workspace, 'f.txt'))
    expect(walked.pages).toBeGreaterThan(2)
    expect(walked.text).toBe(asciiPrefix + cjkTail)
  })

  it('refuses a directory and a path outside any session', async () => {
    const workspace = workspaceWith('dir', 'x')
    mkdirSync(join(workspace, 'sub'))
    const route = mountApi(workspace)
    const onDir = await readPage(route, join(workspace, 'sub'), 0)
    expect(onDir).toMatchObject({ ok: false, error: { code: 'fs-error' } })
  })
})
