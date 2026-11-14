/**
 * `builtin.files` source contract (S1).
 *
 * The source adapts the existing filesystem capabilities, so these cases pin:
 * - workspace-relative locators resolve against the OWNING workspace id (never
 *   the session cwd); external absolute paths keep their platform dialect;
 * - list/search paginate with opaque cursors and never invent a total;
 * - reads are honest: markdown/text carry a text projection, binary resources
 *   answer an asset entry, and large text is returned as EXPLICIT pages;
 * - edits re-read the baseline (mtime+size), refuse a stale save with `conflict`
 *   WITHOUT writing and preserve encoding/EOL; portable locators are workspace-only.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { createCluesService, type CluesService, type ClueSourceRegistration } from '../src/clues/service.ts'
import { CluesStore } from '../src/clues/store.ts'
import { createLocalFileSource, dialectOfText, localFileTypeOf, LOCAL_FILE_TYPE_IDS } from '../src/clues/local-files.ts'
import { ClueError, type ClueReadResult, type JsonValue, type Locator } from '../src/clues/types.ts'
import { encodeText, fileFormatOf, restoreEol } from '../src/text-encoding.ts'
import { MAX_EDITABLE_BYTES, PAGE_BYTES } from '../src/editor-limits.ts'
import { removeTree } from './temp-tree.ts'

const roots: string[] = []
afterEach(() => { for (const path of roots.splice(0)) removeTree(path) })
const NOW = '2026-10-17T00:00:00.000Z'
const WORKSPACE_ID = 'ws-1'
const CAN_LOCK_PERMISSIONS = process.platform !== 'win32' && (process.getuid?.() ?? 1) !== 0
const HOST_DIALECT = process.platform === 'win32' ? 'win32' : 'posix'
const HOST_PATH = HOST_DIALECT === 'win32' ? win32 : posix
interface Fixture { base: string; workspace: string; external: string; service: CluesService; root: string }
function fixture(options: { resolveWorkspace?: boolean } = {}): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'dsh-clues-files-')); roots.push(base)
  const workspace = join(base, 'workspace'), external = join(base, 'external')
  mkdirSync(workspace, { recursive: true }); mkdirSync(external, { recursive: true })
  let next = 0
  const service = createCluesService({
    root: join(base, 'store'), now: () => NOW, newId: kind => `${kind}-${++next}`,
    builtinSources: [createLocalFileSource()],
    ...(options.resolveWorkspace === false ? {} : { resolveWorkspacePath: (id: string) => (id === WORKSPACE_ID ? workspace : undefined) }),
  })
  return { base, workspace, external, service, root: join(base, 'store') }
}
function workspaceLocator(path: string, workspaceId = WORKSPACE_ID): Locator {
  return { root: { kind: 'workspace', workspaceId }, path, dialect: HOST_DIALECT }
}
async function ensureFile(service: CluesService, path: string): Promise<string> {
  const result = await service.ensure({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', typeId: localFileTypeOf(path, HOST_DIALECT), locator: workspaceLocator(path), title: path })
  return result.clue.id
}

async function readAllPages(service: CluesService, clueId: string, first: ClueReadResult): Promise<string> {
  let page = first, text = first.text ?? '', guard = 0
  while (page.limited === true && page.nextOffset !== undefined) {
    if (++guard > 20) throw new Error('pagination did not terminate')
    page = await service.read({ workspaceId: WORKSPACE_ID, clueId, offset: page.nextOffset }); text += page.text ?? ''
  }
  return text
}
describe('builtin.files list', () => {
  it('lists one directory dirs first with extension types and locator info', async () => {
    const { workspace, service } = fixture()
    writeFileSync(join(workspace, 'a.md'), '# a\n'); writeFileSync(join(workspace, 'b.txt'), 'b\n')
    writeFileSync(join(workspace, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])); mkdirSync(join(workspace, 'sub'))
    const result = await service.list({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files' })
    expect(result.items.map(item => item.title)).toEqual(['sub', 'a.md', 'b.txt', 'image.png'])
    const byTitle = new Map(result.items.map(item => [item.title, item]))
    expect(byTitle.get('a.md')?.typeId).toBe(LOCAL_FILE_TYPE_IDS.markdown)
    expect(byTitle.get('b.txt')?.typeId).toBe(LOCAL_FILE_TYPE_IDS.text)
    expect(byTitle.get('image.png')?.typeId).toBe(LOCAL_FILE_TYPE_IDS.binary)
    expect(byTitle.get('sub')).toMatchObject({ typeId: LOCAL_FILE_TYPE_IDS.directory, meta: { kind: 'directory' } })
    // The path comes from the locator; size/mtime are NOT stat-ed per row.
    expect(byTitle.get('a.md')?.info).toEqual({ path: 'a.md' })
    expect(result).toMatchObject({ total: 4 })
    expect(result.limited).toBeUndefined()
  })

  it('paginates a level with an opaque cursor and reports the total only when known', async () => {
    const { workspace, service } = fixture()
    for (const name of ['a.md', 'b.txt', 'c.txt', 'd.txt']) writeFileSync(join(workspace, name), name)
    const first = await service.list({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', limit: 2 })
    expect(first.items.map(item => item.title)).toEqual(['a.md', 'b.txt'])
    expect(first.nextCursor).toBe('2')
    expect(first).toMatchObject({ limited: true })
    expect(first.total).toBeUndefined()
    const second = await service.list({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', limit: 2, cursor: first.nextCursor })
    expect(second.items.map(item => item.title)).toEqual(['c.txt', 'd.txt'])
    expect(second.nextCursor).toBeUndefined()
    expect(second.total).toBe(4)
  })

  it('reports malformed pagination/scope inputs as invalid-request, not failed', async () => {
    const { workspace, service } = fixture()
    writeFileSync(join(workspace, 'a.txt'), 'a\n')
    // A bad cursor / limit / scope is a malformed REQUEST (HTTP 400), not an fs failure.
    await expect(service.list({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', cursor: 'not-a-cursor' })).rejects.toMatchObject({ category: 'invalid-request' })
    await expect(service.list({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', limit: 0 })).rejects.toMatchObject({ category: 'invalid-request' })
    await expect(service.list({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', scope: 42 as JsonValue })).rejects.toMatchObject({ category: 'invalid-request' })
    await expect(service.read({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', typeId: LOCAL_FILE_TYPE_IDS.text, locator: { root: { kind: 'nope' }, path: 'a.txt', dialect: HOST_DIALECT } as Locator }))
      .rejects.toMatchObject({ category: 'invalid-request' })
  })

  it('accepts string and locator scopes, normalizes empty and rejects missing/file scopes', async () => {
    const { workspace, service } = fixture()
    mkdirSync(join(workspace, 'sub')); writeFileSync(join(workspace, 'sub', 'c.txt'), 'c\n'); writeFileSync(join(workspace, 'a.md'), '# a\n')
    expect((await service.list({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', scope: 'sub' })).items.map(item => item.title)).toEqual(['c.txt'])
    expect((await service.list({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', scope: { locator: workspaceLocator('sub') } as unknown as JsonValue })).items.map(item => item.title)).toEqual(['c.txt'])
    expect((await service.list({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', scope: {} })).items.map(item => item.title)).toEqual(['sub', 'a.md'])
    await expect(service.list({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', scope: 'nope' })).rejects.toMatchObject({ category: 'not-found' })
    await expect(service.list({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', scope: 'a.md' })).rejects.toMatchObject({ category: 'unsupported' })
  })
})
describe('builtin.files search', () => {
  it('searches below a scope with the shared walk and paginates', async () => {
    const { workspace, service } = fixture()
    writeFileSync(join(workspace, 'b.txt'), 'b\n'); writeFileSync(join(workspace, 'other.txt'), 'o\n'); mkdirSync(join(workspace, 'sub'))
    writeFileSync(join(workspace, 'sub', 'c.bin'), Buffer.from([0, 1, 2]))
    const first = await service.search({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', query: 'b', limit: 1 })
    expect(first.items.map(item => item.title)).toEqual(['b.txt'])
    expect(first.items[0]?.locator).toMatchObject({ path: 'b.txt' })
    expect(first).toMatchObject({ limited: true })
    expect(first.total).toBeUndefined()
    const second = await service.search({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', query: 'b', limit: 2, cursor: first.nextCursor })
    expect(second.items.map(item => item.title)).toEqual(['sub', 'c.bin'])
    expect(second.items.find(item => item.title === 'sub')).toMatchObject({ typeId: LOCAL_FILE_TYPE_IDS.directory, meta: { kind: 'directory' } })
    expect(second.total).toBe(3)
    expect(await service.search({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', query: '   ' })).toEqual({ items: [], total: 0 })
    await expect(service.search({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', scope: 'nope', query: 'a' })).rejects.toMatchObject({ category: 'not-found' })
  })

  it('re-roots a direct-path hit and never reports a path escaping the scope', async () => {
    const { workspace, external, service } = fixture()
    writeFileSync(join(workspace, 'a.md'), '# a\n'); mkdirSync(join(workspace, 'sub'))
    const outside = join(external, 'outside.md'); writeFileSync(outside, '# outside\n')
    const resolved = await service.resolve({ workspaceId: WORKSPACE_ID, text: 'a.md' })
    // `./a.md` answers the RESOLVED absolute target; re-rooting it keeps one
    // locator (and one stable clue id) for the same file.
    const searched = await service.search({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', query: './a.md' })
    expect(searched.items).toHaveLength(1)
    expect(searched.items[0]?.locator).toEqual(resolved[0]?.locator)
    const first = await service.ensure({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', typeId: LOCAL_FILE_TYPE_IDS.markdown, locator: resolved[0]!.locator, title: 'a.md' })
    const second = await service.ensure({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', typeId: searched.items[0]!.typeId, locator: searched.items[0]!.locator, title: 'a.md' })
    expect(second).toMatchObject({ created: false, clue: { id: first.clue.id } })
    expect((await service.search({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', query: `../${HOST_PATH.basename(external)}/outside.md` })).items).toEqual([])
    expect((await service.search({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', scope: 'sub', query: '../a.md' })).items).toEqual([])
  })
})
describe('builtin.files read', () => {
  it('reads markdown and text with a text projection and millisecond mtime', async () => {
    const { workspace, service } = fixture()
    writeFileSync(join(workspace, 'a.md'), '# hello\n'); writeFileSync(join(workspace, 'b.txt'), 'plain\n')
    const md = await service.read({ workspaceId: WORKSPACE_ID, clueId: await ensureFile(service, 'a.md') })
    expect(md).toMatchObject({ format: 'text/markdown', text: '# hello\n', data: { text: '# hello\n' } })
    expect(md.revision).toMatch(/^\d+(\.\d+)?:\d+$/)
    // The read's own stat is the ONLY source of size/mtime.
    expect(md.info).toMatchObject({ path: 'a.md', sizeBytes: Buffer.byteLength('# hello\n') })
    expect(Number.isNaN(Date.parse(md.info?.updatedAt ?? ''))).toBe(false)
    expect(await service.read({ workspaceId: WORKSPACE_ID, clueId: await ensureFile(service, 'b.txt') })).toMatchObject({ format: 'text/plain', text: 'plain\n' })
    const old = join(workspace, 'old.md'); writeFileSync(old, 'old context')
    const date = new Date('1999-01-01T00:00:00.000Z'); utimesSync(old, date, date)
    const oldRead = await service.read({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', typeId: LOCAL_FILE_TYPE_IDS.markdown, locator: workspaceLocator('old.md') })
    expect(oldRead.info?.updatedAt).toBe(date.toISOString())
  })

  it('answers a binary asset instead of decoding bytes into text', async () => {
    const { workspace, service } = fixture()
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    writeFileSync(join(workspace, 'image.png'), bytes)
    const read = await service.read({ workspaceId: WORKSPACE_ID, clueId: await ensureFile(service, 'image.png') })
    expect(read).toMatchObject({ format: 'application/octet-stream', data: { kind: 'binary', size: bytes.length }, info: { path: 'image.png', sizeBytes: bytes.length } })
    expect(read.text).toBeUndefined()
    expect(read.assets).toHaveLength(1)
    expect(read.assets?.[0]).toMatchObject({ kind: 'open', path: join(workspace, 'image.png'), size: bytes.length })
    // A text-shaped file declared as the binary type gets no fake text.
    writeFileSync(join(workspace, 'b.txt'), 'looks like text\n')
    const clue = await service.ensure({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', typeId: LOCAL_FILE_TYPE_IDS.binary, locator: workspaceLocator('b.txt'), title: 'b.txt' })
    const declared = await service.read({ workspaceId: WORKSPACE_ID, clueId: clue.clue.id })
    expect(declared).toMatchObject({ format: 'application/octet-stream' })
    expect(declared.text).toBeUndefined()
    expect(declared.assets?.[0]?.path).toBe(join(workspace, 'b.txt'))
    // Binary resources are read-only: no edit protocol.
    await expect(service.loadEdit({ workspaceId: WORKSPACE_ID, clueId: clue.clue.id })).rejects.toMatchObject({ category: 'unsupported' })
    await expect(service.saveEdit({ workspaceId: WORKSPACE_ID, clueId: clue.clue.id, document: { format: 'application/octet-stream', data: { text: 'x' }, baseRevision: 'r' } })).rejects.toMatchObject({ category: 'unsupported' })
  })

  it('serves SVG as a read-only image asset, including an already saved text-typed clue', async () => {
    const { workspace, service } = fixture()
    const path = join(workspace, 'diagram.svg')
    writeFileSync(path, '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24"/>')
    const { clue } = await service.ensure({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files',
      typeId: LOCAL_FILE_TYPE_IDS.text, locator: workspaceLocator('diagram.svg'), title: 'diagram.svg' })
    const resource = { workspaceId: WORKSPACE_ID, clueId: clue.id }
    const read = await service.read(resource)
    expect(read).toMatchObject({ format: 'application/octet-stream', assets: [{ path, mime: 'image/svg+xml' }] })
    expect(read.text).toBeUndefined()
    await expect(service.loadEdit(resource)).rejects.toMatchObject({ category: 'unsupported' })
  })

  it('pages an explicitly requested large read without silent truncation', async () => {
    const { workspace, service } = fixture()
    const content = `${Array.from({ length: 4000 }, () => 'x'.repeat(63)).join('\n')}\n`
    expect(Buffer.byteLength(content)).toBeGreaterThan(PAGE_BYTES)
    writeFileSync(join(workspace, 'big.txt'), content)
    const clueId = await ensureFile(service, 'big.txt')
    const first = await service.read({ workspaceId: WORKSPACE_ID, clueId, offset: 0 })
    expect(first).toMatchObject({ format: 'text/plain', limited: true })
    expect(first.nextOffset).toBeGreaterThan(0)
    expect(first.nextOffset).toBeLessThan(Buffer.byteLength(content))
    expect(await readAllPages(service, clueId, first)).toBe(content)
  })

  it('auto-pages a file above the editable threshold and reads an explicit byte offset', async () => {
    const { workspace, service } = fixture()
    const content = `${'y'.repeat(64 * 1024)}\n`.repeat(90)
    expect(Buffer.byteLength(content)).toBeGreaterThan(5 * 1024 * 1024)
    writeFileSync(join(workspace, 'huge.txt'), content)
    const huge = await service.read({ workspaceId: WORKSPACE_ID, clueId: await ensureFile(service, 'huge.txt') })
    expect(huge).toMatchObject({ limited: true })
    expect(huge.nextOffset).toBeGreaterThan(0)
    expect(huge.text?.length).toBeGreaterThan(0)
    const pagePath = join(workspace, 'p.txt'); writeFileSync(pagePath, 'aaa\nbbb\nccc\n')
    const page = await service.read({ workspaceId: WORKSPACE_ID, clueId: await ensureFile(service, 'p.txt'), offset: 4 })
    expect(page).toMatchObject({ text: 'bbb\nccc\n', limited: false })
    expect(page.nextOffset).toBeUndefined()
  })

  it('reports a missing file as not-found and a missing workspace as dependency-missing', async () => {
    const { service } = fixture()
    await expect(service.read({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', typeId: LOCAL_FILE_TYPE_IDS.text, locator: workspaceLocator('missing.txt') })).rejects.toMatchObject({ category: 'not-found' })
    const unwired = fixture({ resolveWorkspace: false })
    await expect(unwired.service.read({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', typeId: LOCAL_FILE_TYPE_IDS.text, locator: workspaceLocator('a.md') })).rejects.toMatchObject({ category: 'dependency-missing' })
  })

  it('honors an aborted signal', async () => {
    const { workspace, service } = fixture()
    writeFileSync(join(workspace, 'a.md'), '# a\n')
    const clueId = await ensureFile(service, 'a.md')
    const controller = new AbortController(); controller.abort()
    await expect(service.read({ workspaceId: WORKSPACE_ID, clueId }, { signal: controller.signal })).rejects.toMatchObject({ category: 'cancelled' })
    await expect(service.list({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files' }, { signal: controller.signal })).rejects.toMatchObject({ category: 'cancelled' })
  })
})
describe('builtin.files edits', () => {
  it('loads and saves a markdown document', async () => {
    const { workspace, service } = fixture()
    writeFileSync(join(workspace, 'a.md'), '# old\n')
    const clueId = await ensureFile(service, 'a.md')
    const edit = await service.loadEdit({ workspaceId: WORKSPACE_ID, clueId })
    expect(edit).toMatchObject({ format: 'text/markdown', data: { text: '# old\n' }, info: { path: 'a.md', sizeBytes: 6 } })
    expect(edit.baseRevision).toBeTruthy()
    const saved = await service.saveEdit({ workspaceId: WORKSPACE_ID, clueId, document: { format: 'text/markdown', data: { text: '# new\n' }, baseRevision: edit.baseRevision } })
    expect(saved.info).toMatchObject({ path: 'a.md', sizeBytes: 6 })
    expect(Number.isNaN(Date.parse(saved.info?.updatedAt ?? ''))).toBe(false)
    expect(readFileSync(join(workspace, 'a.md'), 'utf8')).toBe('# new\n')
    expect((await service.read({ workspaceId: WORKSPACE_ID, clueId })).text).toBe('# new\n')
  })

  it('restores the on-disk encoding and EOL on save (GBK + CRLF stay untouched)', async () => {
    const { workspace, service } = fixture()
    const path = join(workspace, 'legacy.txt')
    const original = '第一行\r\n第二行\r\n', changed = '第一行\n改过了\n'
    writeFileSync(path, encodeText(restoreEol(original, 'crlf'), 'gbk'))
    const clueId = await ensureFile(service, 'legacy.txt')
    const edit = await service.loadEdit({ workspaceId: WORKSPACE_ID, clueId })
    expect(edit.data).toEqual({ text: '第一行\n第二行\n' })
    await service.saveEdit({ workspaceId: WORKSPACE_ID, clueId, document: { format: 'text/plain', data: { text: changed }, baseRevision: edit.baseRevision } })
    expect(await fileFormatOf(path)).toEqual({ encoding: 'gbk', eol: 'crlf' })
    expect(readFileSync(path)).toEqual(encodeText(restoreEol(changed, 'crlf'), 'gbk'))
  })

  it('refuses a baseline-bearing save with conflict without writing', async () => {
    const { workspace, service } = fixture()
    const gone = join(workspace, 'gone.txt'); writeFileSync(gone, 'original\n')
    const goneId = await ensureFile(service, 'gone.txt')
    const goneEdit = await service.loadEdit({ workspaceId: WORKSPACE_ID, clueId: goneId })
    rmSync(gone)
    await expect(service.saveEdit({ workspaceId: WORKSPACE_ID, clueId: goneId, document: { format: 'text/plain', data: { text: 'draft\n' }, baseRevision: goneEdit.baseRevision } })).rejects.toMatchObject({ category: 'conflict' })
    expect(() => readFileSync(gone, 'utf8')).toThrow()
    // A stale baseline is an external modification, not a silent overwrite.
    const path = join(workspace, 'a.txt'); writeFileSync(path, 'original\n')
    const clueId = await ensureFile(service, 'a.txt')
    const edit = await service.loadEdit({ workspaceId: WORKSPACE_ID, clueId })
    writeFileSync(path, 'external change that is longer\n')
    await expect(service.saveEdit({ workspaceId: WORKSPACE_ID, clueId, document: { format: 'text/plain', data: { text: 'draft\n' }, baseRevision: edit.baseRevision } })).rejects.toMatchObject({ category: 'conflict' })
    expect(readFileSync(path, 'utf8')).toBe('external change that is longer\n')
  })

  it('refuses a save with no baseline and a mismatched format', async () => {
    const { workspace, service } = fixture()
    writeFileSync(join(workspace, 'a.txt'), 'a\n')
    const clueId = await ensureFile(service, 'a.txt')
    await expect(service.saveEdit({ workspaceId: WORKSPACE_ID, clueId, document: { format: 'text/plain', data: { text: 'b' } } })).rejects.toMatchObject({ category: 'conflict' })
    const edit = await service.loadEdit({ workspaceId: WORKSPACE_ID, clueId })
    await expect(service.saveEdit({ workspaceId: WORKSPACE_ID, clueId, document: { format: 'text/markdown', data: { text: 'b' }, baseRevision: edit.baseRevision } })).rejects.toMatchObject({ category: 'invalid-request' })
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('a\n')
  })

  it('refuses an encoded document above the editable limit and counts encoded bytes', async () => {
    const { workspace, service } = fixture()
    const path = join(workspace, 'small.txt'); writeFileSync(path, 'original\n')
    const clueId = await ensureFile(service, 'small.txt')
    const edit = await service.loadEdit({ workspaceId: WORKSPACE_ID, clueId })
    await expect(service.saveEdit({ workspaceId: WORKSPACE_ID, clueId, document: { format: 'text/plain', data: { text: 'x'.repeat(MAX_EDITABLE_BYTES + 1) }, baseRevision: edit.baseRevision } })).rejects.toMatchObject({ category: 'unsupported' })
    expect(readFileSync(path, 'utf8')).toBe('original\n')
    expect((await service.loadEdit({ workspaceId: WORKSPACE_ID, clueId })).data).toEqual({ text: 'original\n' })
    // UTF-16 on-disk size is what counts: 2.7 M chars fit UTF-8 but not UTF-16.
    const wide = join(workspace, 'wide.txt'); writeFileSync(wide, encodeText('seed\n', 'utf16le-bom'))
    const wideId = await ensureFile(service, 'wide.txt')
    const wideEdit = await service.loadEdit({ workspaceId: WORKSPACE_ID, clueId: wideId })
    await expect(service.saveEdit({ workspaceId: WORKSPACE_ID, clueId: wideId, document: { format: 'text/plain', data: { text: 'x'.repeat(Math.floor(MAX_EDITABLE_BYTES / 2) + 1) }, baseRevision: wideEdit.baseRevision } })).rejects.toMatchObject({ category: 'unsupported' })
    expect(await fileFormatOf(wide)).toEqual({ encoding: 'utf16le-bom', eol: 'lf' })
  })
})
describe('builtin.files permission failures', () => {
  it.skipIf(!CAN_LOCK_PERMISSIONS)('maps unreadable files and directories to permission-denied', async () => {
    const { workspace, service } = fixture()
    const file = join(workspace, 'locked.txt'), dir = join(workspace, 'locked-dir')
    writeFileSync(file, 'locked\n'); mkdirSync(dir); writeFileSync(join(dir, 'inside.txt'), 'inside\n')
    const clueId = await ensureFile(service, 'locked.txt')
    const edit = await service.loadEdit({ workspaceId: WORKSPACE_ID, clueId })
    chmodSync(file, 0o000); chmodSync(dir, 0o000)
    try {
      await expect(service.read({ workspaceId: WORKSPACE_ID, clueId })).rejects.toMatchObject({ category: 'permission-denied' })
      await expect(service.loadEdit({ workspaceId: WORKSPACE_ID, clueId })).rejects.toMatchObject({ category: 'permission-denied' })
      await expect(service.saveEdit({ workspaceId: WORKSPACE_ID, clueId, document: { format: 'text/plain', data: { text: 'draft\n' }, baseRevision: edit.baseRevision } })).rejects.toMatchObject({ category: 'permission-denied' })
      // An unreadable scope must report, never answer an empty page.
      await expect(service.list({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', scope: 'locked-dir' })).rejects.toMatchObject({ category: 'permission-denied' })
      await expect(service.search({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', scope: 'locked-dir', query: 'inside' })).rejects.toMatchObject({ category: 'permission-denied' })
      await expect(service.resolve({ workspaceId: WORKSPACE_ID, text: 'locked-dir/inside.txt' })).rejects.toMatchObject({ category: 'permission-denied' })
    } finally {
      chmodSync(file, 0o600); chmodSync(dir, 0o700)
    }
  })
})
describe('builtin.files resolve / portable / dialects', () => {
  it('resolves relative and absolute paths, expands ~ and has no portable external form', async () => {
    const { workspace, external, service } = fixture()
    writeFileSync(join(workspace, 'a.md'), '# a\n')
    const externalFile = join(external, 'outside.txt'); writeFileSync(externalFile, 'outside\n')
    const relative = await service.resolve({ workspaceId: WORKSPACE_ID, text: './sub/../a.md' })
    expect(relative).toMatchObject([{
      locator: { root: { kind: 'workspace', workspaceId: WORKSPACE_ID }, path: 'a.md', dialect: HOST_DIALECT },
      info: { path: 'a.md', sizeBytes: Buffer.byteLength('# a\n') },
    }])
    expect(Number.isNaN(Date.parse(relative[0]?.info?.updatedAt ?? ''))).toBe(false)
    const absolute = await service.resolve({ workspaceId: WORKSPACE_ID, text: externalFile })
    expect(absolute[0]?.locator).toMatchObject({ root: { kind: 'external' }, path: HOST_PATH.normalize(externalFile), dialect: HOST_DIALECT })
    expect(absolute[0]?.info).toMatchObject({ path: HOST_PATH.normalize(externalFile), sizeBytes: Buffer.byteLength('outside\n') })
    const ensured = await service.ensure({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', typeId: absolute[0]!.typeId, locator: absolute[0]!.locator, title: 'outside.txt' })
    expect((await service.read({ workspaceId: WORKSPACE_ID, clueId: ensured.clue.id })).text).toBe('outside\n')
    expect(await service.portable({ workspaceId: WORKSPACE_ID, clueId: ensured.clue.id })).toMatchObject({ portable: false, reason: expect.any(String) })
    const home = await service.resolve({ workspaceId: WORKSPACE_ID, text: '~' })
    expect(home[0]).toMatchObject({ typeId: LOCAL_FILE_TYPE_IDS.directory, meta: { kind: 'directory' } })
    expect(home[0]?.locator).toMatchObject({ root: { kind: 'external' }, path: HOST_PATH.normalize(homedir()), dialect: HOST_DIALECT })
    expect((await service.resolve({ workspaceId: WORKSPACE_ID, text: '~/.' }))[0]?.locator).toMatchObject({ path: HOST_PATH.normalize(homedir()) })
  })

  it('resolves a directory as the read-only directory type and refuses it for a file', async () => {
    const { workspace, service } = fixture()
    mkdirSync(join(workspace, 'docs')); writeFileSync(join(workspace, 'a.md'), '# a\n')
    const [candidate] = await service.resolve({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', text: 'docs' })
    expect(candidate).toMatchObject({ typeId: LOCAL_FILE_TYPE_IDS.directory, meta: { kind: 'directory' } })
    // A directory is a browse/scope handle: no formats, not readable, not editable.
    expect(service.getTypes('builtin.files').find(type => type.typeId === LOCAL_FILE_TYPE_IDS.directory))
      .toEqual({ typeId: LOCAL_FILE_TYPE_IDS.directory, sourceId: 'builtin.files', formats: [], capabilities: { read: false, edit: false, concurrency: 'none' } })
    const ensured = await service.ensure({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', typeId: candidate!.typeId, locator: candidate!.locator, title: 'docs' })
    await expect(service.read({ workspaceId: WORKSPACE_ID, clueId: ensured.clue.id })).rejects.toMatchObject({ category: 'unsupported' })
    await expect(service.loadEdit({ workspaceId: WORKSPACE_ID, clueId: ensured.clue.id })).rejects.toMatchObject({ category: 'unsupported' })
    // An explicit directory type is accepted for a directory but refused for a file.
    expect((await service.resolve({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', typeId: LOCAL_FILE_TYPE_IDS.directory, text: 'docs' }))[0]).toMatchObject({ typeId: LOCAL_FILE_TYPE_IDS.directory })
    await expect(service.resolve({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', typeId: LOCAL_FILE_TYPE_IDS.directory, text: 'a.md' })).rejects.toMatchObject({ category: 'unsupported' })
    expect(service.getTypes('builtin.files').find(type => type.typeId === LOCAL_FILE_TYPE_IDS.binary))
      .toEqual({ typeId: LOCAL_FILE_TYPE_IDS.binary, sourceId: 'builtin.files', formats: ['application/octet-stream'], capabilities: { read: true, edit: false, concurrency: 'none' } })
  })

  it('auto-resolves a later remote source and explicit builtin keeps its own errors', async () => {
    const { workspace, service } = fixture()
    writeFileSync(join(workspace, 'a.md'), '# a\n')
    const remote: ClueSourceRegistration = {
      descriptor: { sourceId: 'test.remote', name: 'Remote docs', order: 20, pluginId: 'test-plugin', types: ['test.remote.page'], transport: 'http', capabilities: { resolve: true, list: false, search: false, read: false, edit: false, portable: false } },
      types: [{ typeId: 'test.remote.page', sourceId: 'test.remote', formats: ['text/plain'], capabilities: { read: false, edit: false, concurrency: 'none' } }],
      operations: {
        async resolve(input) { return typeof input.text === 'string' && input.text.startsWith('https://') ? { sourceId: 'test.remote', typeId: 'test.remote.page', locator: { url: input.text }, title: 'Remote doc' } : undefined },
      },
    }
    service.registerSource(remote)
    // `builtin.files` (order 0) must not stat a URL and fail before the remote source is asked.
    expect(await service.resolve({ workspaceId: WORKSPACE_ID, text: 'https://example.com/doc' })).toEqual([
      expect.objectContaining({ sourceId: 'test.remote', locator: { url: 'https://example.com/doc' } }),
    ])
    // A path-shaped miss must not poison other sources either.
    expect(await service.resolve({ workspaceId: WORKSPACE_ID, text: 'issue/owner/repo#1' })).toEqual([])
    expect(await service.resolve({ workspaceId: WORKSPACE_ID, locator: { url: 'https://example.com/doc' } })).toEqual([])
    // Explicit mode reports its own not-found/invalid-request instead of a miss.
    await expect(service.resolve({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', text: 'missing.md' })).rejects.toMatchObject({ category: 'not-found' })
    await expect(service.resolve({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', locator: { url: 'https://example.com/doc' } })).rejects.toMatchObject({ category: 'invalid-request' })
  })

  it('deduplicates ensure across normalized spellings and returns a portable locator', async () => {
    const { workspace, service } = fixture()
    writeFileSync(join(workspace, 'a.md'), '# a\n')
    const first = await service.ensure({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', typeId: LOCAL_FILE_TYPE_IDS.markdown, locator: workspaceLocator('./a.md'), title: 'a' })
    const second = await service.ensure({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', typeId: LOCAL_FILE_TYPE_IDS.markdown, locator: workspaceLocator('sub/../a.md'), title: 'a again' })
    expect(second).toMatchObject({ created: false, clue: { id: first.clue.id } })
    const third = await service.ensure({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', typeId: LOCAL_FILE_TYPE_IDS.markdown, locator: workspaceLocator('a.md/'), title: 'a' })
    expect(third).toMatchObject({ created: false, clue: { id: first.clue.id } })
    expect(await service.portable({ workspaceId: WORKSPACE_ID, clueId: first.clue.id })).toMatchObject({
      portable: true, locator: { root: { kind: 'workspace', workspaceId: WORKSPACE_ID }, path: 'a.md', dialect: HOST_DIALECT },
    })
  })

  it('normalizes each platform dialect with its own path module', () => {
    const source = createLocalFileSource()
    const normalize = (locator: Locator): Locator => source.operations!.normalizeLocator!(locator, { workspaceId: WORKSPACE_ID })
    const external = (path: string, dialect: 'win32' | 'posix'): Locator => ({ root: { kind: 'external' }, path, dialect })
    const workspace = (path: string, dialect: 'win32' | 'posix'): Locator => ({ root: { kind: 'workspace', workspaceId: WORKSPACE_ID }, path, dialect })
    for (const [input, expected] of [
      [external('C:/notes/../a.md', 'win32'), external('C:\\a.md', 'win32')],
      [external('/tmp/./a.md', 'posix'), external('/tmp/a.md', 'posix')],
      [external('/tmp/a.md/', 'posix'), external('/tmp/a.md', 'posix')],
      [external('/', 'posix'), external('/', 'posix')],
      [external('C:\\', 'win32'), external('C:\\', 'win32')],
      [workspace('docs/', 'posix'), workspace('docs', 'posix')],
      [workspace('docs\\a.md', 'win32'), workspace('docs\\a.md', 'win32')],
    ] as const) expect(normalize(input)).toEqual(expected)
    expect(() => normalize({ root: { kind: 'workspace', workspaceId: WORKSPACE_ID }, path: '../escape.txt', dialect: 'posix' })).toThrow(ClueError)
    expect(() => normalize({ root: { kind: 'external' }, path: 'relative.txt', dialect: 'posix' })).toThrow(ClueError)
  })

  it('folds case in win32 locator keys and detects the dialect of raw text', () => {
    const source = createLocalFileSource()
    const key = (locator: Locator): string => source.operations!.locatorKey!(locator)
    const normalize = (locator: Locator): Locator => source.operations!.normalizeLocator!(locator, { workspaceId: WORKSPACE_ID })
    expect(key({ root: { kind: 'external' }, path: 'C:\\Notes\\A.md', dialect: 'win32' })).toBe(key({ root: { kind: 'external' }, path: 'c:\\notes\\a.md', dialect: 'win32' }))
    expect(key({ root: { kind: 'workspace', workspaceId: WORKSPACE_ID }, path: 'Docs/A.md', dialect: 'posix' })).not.toBe(key({ root: { kind: 'workspace', workspaceId: WORKSPACE_ID }, path: 'docs/a.md', dialect: 'posix' }))
    // A forward-slash UNC spelling is classified with the host it was typed on.
    expect(dialectOfText('//server/share/a.md')).toBe(HOST_DIALECT)
    expect(dialectOfText('C:/notes/a.md')).toBe('win32')
    expect(dialectOfText('/tmp/a.md')).toBe('posix')
    expect(dialectOfText('docs/a.md')).toBe(HOST_DIALECT)
    expect(normalize({ root: { kind: 'external' }, path: '//server/share/dir/../a.md', dialect: 'win32' })).toEqual({ root: { kind: 'external' }, path: '\\\\server\\share\\a.md', dialect: 'win32' })
  })

  it('refuses a foreign workspace locator and a foreign-dialect locator', async () => {
    const { workspace, service, root } = fixture()
    writeFileSync(join(workspace, 'a.md'), '# a\n')
    const foreign = { root: { kind: 'workspace', workspaceId: 'ws-other' }, path: 'a.md', dialect: HOST_DIALECT }
    await expect(service.ensure({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', typeId: LOCAL_FILE_TYPE_IDS.markdown, locator: foreign, title: 'a.md' })).rejects.toMatchObject({ category: 'invalid-request' })
    await expect(service.read({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', typeId: LOCAL_FILE_TYPE_IDS.markdown, locator: foreign })).rejects.toMatchObject({ category: 'invalid-request' })
    // A reference persisted before the guard is not silently resolved either.
    await new CluesStore({ root }).transact(WORKSPACE_ID, undefined, (state) => {
      state.clues.push({ id: 'clue-foreign', sourceId: 'builtin.files', typeId: LOCAL_FILE_TYPE_IDS.markdown, locator: foreign, title: 'a.md', workspaceId: WORKSPACE_ID, createdAt: NOW, updatedAt: NOW })
    })
    await expect(service.read({ workspaceId: WORKSPACE_ID, clueId: 'clue-foreign' })).rejects.toMatchObject({ category: 'invalid-request' })
    expect(readFileSync(join(workspace, 'a.md'), 'utf8')).toBe('# a\n')
    // A locator written in the OTHER platform's dialect must not be reinterpreted here.
    const crossDialect: Locator = HOST_DIALECT === 'win32'
      ? { root: { kind: 'workspace', workspaceId: WORKSPACE_ID }, path: 'notes/a.md', dialect: 'posix' }
      : { root: { kind: 'external' }, path: 'C:\\notes\\a.md', dialect: 'win32' }
    await expect(service.read({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', typeId: LOCAL_FILE_TYPE_IDS.text, locator: crossDialect })).rejects.toMatchObject({ category: 'unsupported' })
  })
})
