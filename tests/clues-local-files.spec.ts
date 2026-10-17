/**
 * `builtin.files` source contract (S1).
 *
 * The source is an adapter over the existing filesystem capabilities, so these
 * cases pin the adapter semantics the clue line depends on:
 * - workspace-relative locators resolve against the OWNING workspace id (never
 *   the session cwd); external absolute paths keep their platform dialect;
 * - list/search paginate with opaque cursors and never invent a total;
 * - reads are honest: markdown / plain text carry a text projection, binary
 *   resources answer an asset entry, and large text is returned as EXPLICIT
 *   pages (`limited` / `nextOffset`) instead of a silent truncation;
 * - edits re-read the file's baseline (mtime+size), refuse a stale save with
 *   `conflict` WITHOUT writing, and preserve the on-disk encoding and EOL;
 * - portable locators exist only for workspace-relative references.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCluesService, type CluesService } from '../src/clues/service.ts'
import {
  createLocalFileSource,
  dialectOfText,
  localFileTypeOf,
  LOCAL_FILE_TYPE_IDS,
} from '../src/clues/local-files.ts'
import {
  ClueError,
  type ClueReadResult,
  type JsonValue,
  type Locator,
} from '../src/clues/types.ts'
import { encodeText, fileFormatOf, restoreEol } from '../src/text-encoding.ts'
import { PAGE_BYTES } from '../src/editor-limits.ts'
import { removeTree } from './temp-tree.ts'

const roots: string[] = []

afterEach(() => {
  for (const path of roots.splice(0)) removeTree(path)
})

const NOW = '2026-10-17T00:00:00.000Z'
const WORKSPACE_ID = 'ws-1'

interface Fixture {
  base: string
  workspace: string
  external: string
  service: CluesService
  root: string
}

/** One temp workspace + external dir + service with the local source registered. */
function fixture(options: { resolveWorkspace?: boolean } = {}): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'dsh-clues-files-'))
  roots.push(base)
  const workspace = join(base, 'workspace')
  const external = join(base, 'external')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(external, { recursive: true })
  let next = 0
  const service = createCluesService({
    root: join(base, 'store'),
    now: () => NOW,
    newId: kind => `${kind}-${++next}`,
    ...(options.resolveWorkspace === false
      ? {}
      : { resolveWorkspacePath: (id: string) => (id === WORKSPACE_ID ? workspace : undefined) }),
  })
  service.registerSource(createLocalFileSource())
  return { base, workspace, external, service, root: join(base, 'store') }
}

/** A workspace-root locator for a relative path (posix dialect). */
function workspaceLocator(path: string): Locator {
  return { root: { kind: 'workspace', workspaceId: WORKSPACE_ID }, path, dialect: 'posix' }
}

/** Ensure one workspace file as its extension-derived type. */
async function ensureFile(service: CluesService, path: string): Promise<string> {
  const result = await service.ensure({
    workspaceId: WORKSPACE_ID,
    sourceId: 'builtin.files',
    typeId: localFileTypeOf(path, 'posix'),
    locator: workspaceLocator(path),
    title: path,
  })
  return result.clue.id
}

/** Page through a large text read and return the concatenated pages. */
async function readAllPages(service: CluesService, clueId: string, first: ClueReadResult): Promise<string> {
  let page = first
  let text = first.text ?? ''
  let guard = 0
  while (page.limited === true && page.nextOffset !== undefined) {
    guard += 1
    if (guard > 20) throw new Error('pagination did not terminate')
    page = await service.read({ workspaceId: WORKSPACE_ID, clueId, offset: page.nextOffset })
    text += page.text ?? ''
  }
  return text
}

describe('builtin.files list', () => {
  it('lists one directory with dirs first, extension-derived types and a directory marker', async () => {
    const { workspace, service } = fixture()
    writeFileSync(join(workspace, 'a.md'), '# a\n')
    writeFileSync(join(workspace, 'b.txt'), 'b\n')
    writeFileSync(join(workspace, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))
    mkdirSync(join(workspace, 'sub'))
    writeFileSync(join(workspace, 'sub', 'c.txt'), 'c\n')

    const result = await service.list({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files' })
    expect(result.items.map(item => item.title)).toEqual(['sub', 'a.md', 'b.txt', 'image.png'])
    const byTitle = new Map(result.items.map(item => [item.title, item]))
    expect(byTitle.get('a.md')?.typeId).toBe(LOCAL_FILE_TYPE_IDS.markdown)
    expect(byTitle.get('b.txt')?.typeId).toBe(LOCAL_FILE_TYPE_IDS.text)
    expect(byTitle.get('image.png')?.typeId).toBe(LOCAL_FILE_TYPE_IDS.binary)
    expect(byTitle.get('sub')?.meta).toEqual({ kind: 'directory' })
    expect(result.total).toBe(4)
    expect(result.limited).toBeUndefined()
  })

  it('paginates a level with an opaque cursor and reports the total only when known', async () => {
    const { workspace, service } = fixture()
    for (const name of ['a.md', 'b.txt', 'c.txt', 'd.txt']) writeFileSync(join(workspace, name), name)
    const first = await service.list({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', limit: 2 })
    expect(first.items.map(item => item.title)).toEqual(['a.md', 'b.txt'])
    expect(first.nextCursor).toBe('2')
    // The listing was capped to prove the next page, so the exact total is
    // unknown and must not be invented.
    expect(first.total).toBeUndefined()
    expect(first.limited).toBe(true)

    const second = await service.list({
      workspaceId: WORKSPACE_ID,
      sourceId: 'builtin.files',
      limit: 2,
      cursor: first.nextCursor,
    })
    expect(second.items.map(item => item.title)).toEqual(['c.txt', 'd.txt'])
    expect(second.nextCursor).toBeUndefined()
    expect(second.total).toBe(4)
  })

  it('lists inside a scope carried as a string path or a locator', async () => {
    const { workspace, service } = fixture()
    mkdirSync(join(workspace, 'sub'))
    writeFileSync(join(workspace, 'sub', 'c.txt'), 'c\n')
    const byString = await service.list({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', scope: 'sub' })
    expect(byString.items.map(item => item.title)).toEqual(['c.txt'])
    const scope = { locator: workspaceLocator('sub') } as unknown as JsonValue
    const byLocator = await service.list({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', scope })
    expect(byLocator.items.map(item => item.title)).toEqual(['c.txt'])
  })

  it('normalizes an empty scope object to the workspace root', async () => {
    const { workspace, service } = fixture()
    writeFileSync(join(workspace, 'a.md'), '# a\n')
    const result = await service.list({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', scope: {} })
    expect(result.items.map(item => item.title)).toEqual(['a.md'])
  })
})

describe('builtin.files search', () => {
  it('searches below a scope with the shared walk and paginates', async () => {
    const { workspace, service } = fixture()
    writeFileSync(join(workspace, 'b.txt'), 'b\n')
    writeFileSync(join(workspace, 'other.txt'), 'o\n')
    mkdirSync(join(workspace, 'sub'))
    writeFileSync(join(workspace, 'sub', 'c.bin'), Buffer.from([0, 1, 2]))

    const first = await service.search({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', query: 'b', limit: 1 })
    expect(first.items.map(item => item.title)).toEqual(['b.txt'])
    expect(first.items[0]?.locator).toMatchObject({ path: 'b.txt' })
    expect(first.limited).toBe(true)
    // A capped search may have more matches than it reported, so the total is
    // unknown (an engine that enumerated everything would answer it).
    expect(first.total).toBeUndefined()

    // `sub` matches by name too; results are root-relative and sorted.
    const second = await service.search({
      workspaceId: WORKSPACE_ID,
      sourceId: 'builtin.files',
      query: 'b',
      limit: 2,
      cursor: first.nextCursor,
    })
    expect(second.items.map(item => item.title)).toEqual(['sub', 'c.bin'])
    const dir = second.items.find(item => item.title === 'sub')
    expect(dir?.meta).toEqual({ kind: 'directory' })
    expect(second.total).toBe(3)
  })

  it('returns an empty result (not an error) for a blank query', async () => {
    const { service } = fixture()
    const result = await service.search({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', query: '   ' })
    expect(result).toEqual({ items: [], total: 0 })
  })
})

describe('builtin.files read', () => {
  it('reads markdown and text with a model-facing text projection', async () => {
    const { workspace, service } = fixture()
    writeFileSync(join(workspace, 'a.md'), '# hello\n')
    writeFileSync(join(workspace, 'b.txt'), 'plain\n')
    const md = await service.read({ workspaceId: WORKSPACE_ID, clueId: await ensureFile(service, 'a.md') })
    expect(md.format).toBe('text/markdown')
    expect(md.text).toBe('# hello\n')
    expect(md.data).toEqual({ text: '# hello\n' })
    expect(md.revision).toMatch(/^\d+(\.\d+)?:\d+$/)
    const text = await service.read({ workspaceId: WORKSPACE_ID, clueId: await ensureFile(service, 'b.txt') })
    expect(text.format).toBe('text/plain')
    expect(text.text).toBe('plain\n')
  })

  it('answers a binary asset instead of decoding bytes into text', async () => {
    const { workspace, service } = fixture()
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    writeFileSync(join(workspace, 'image.png'), bytes)
    const clueId = await ensureFile(service, 'image.png')
    const read = await service.read({ workspaceId: WORKSPACE_ID, clueId })
    expect(read.format).toBe('application/octet-stream')
    expect(read.text).toBeUndefined()
    expect(read.data).toMatchObject({ kind: 'binary', size: bytes.length })
    expect(read.assets).toHaveLength(1)
    expect(read.assets?.[0]).toMatchObject({ kind: 'open', path: join(workspace, 'image.png'), size: bytes.length })
  })

  it('does not fake text for a text-shaped file declared as the binary type', async () => {
    const { workspace, service } = fixture()
    writeFileSync(join(workspace, 'b.txt'), 'looks like text\n')
    const clue = await service.ensure({
      workspaceId: WORKSPACE_ID,
      sourceId: 'builtin.files',
      typeId: LOCAL_FILE_TYPE_IDS.binary,
      locator: workspaceLocator('b.txt'),
      title: 'b.txt',
    })
    const read = await service.read({ workspaceId: WORKSPACE_ID, clueId: clue.clue.id })
    expect(read.format).toBe('application/octet-stream')
    expect(read.text).toBeUndefined()
    expect(read.assets?.[0]?.path).toBe(join(workspace, 'b.txt'))
  })

  it('pages an explicitly requested large read (limited + nextOffset, no silent truncation)', async () => {
    const { workspace, service } = fixture()
    const content = `${Array.from({ length: 4000 }, () => 'x'.repeat(63)).join('\n')}\n`
    expect(Buffer.byteLength(content)).toBeGreaterThan(PAGE_BYTES)
    writeFileSync(join(workspace, 'big.txt'), content)
    const clueId = await ensureFile(service, 'big.txt')
    // `offset: 0` is the explicit paged read; the source must not answer the
    // whole 256 KB document silently.
    const first = await service.read({ workspaceId: WORKSPACE_ID, clueId, offset: 0 })
    expect(first.format).toBe('text/plain')
    expect(first.limited).toBe(true)
    expect(first.nextOffset).toBeGreaterThan(0)
    expect(first.nextOffset).toBeLessThan(Buffer.byteLength(content))
    const all = await readAllPages(service, clueId, first)
    expect(all).toBe(content)
  })

  it('auto-pages a file above the editable threshold instead of truncating it', async () => {
    const { workspace, service } = fixture()
    // Just over the editor limit: the whole-document read answers "too large",
    // so the source serves the first explicit page (same contract as offset 0).
    const content = `${'y'.repeat(64 * 1024)}\n`.repeat(90)
    expect(Buffer.byteLength(content)).toBeGreaterThan(5 * 1024 * 1024)
    writeFileSync(join(workspace, 'huge.txt'), content)
    const clueId = await ensureFile(service, 'huge.txt')
    const first = await service.read({ workspaceId: WORKSPACE_ID, clueId })
    expect(first.limited).toBe(true)
    expect(first.nextOffset).toBeGreaterThan(0)
    expect(first.text?.length).toBeGreaterThan(0)
  })

  it('reads one explicit page at a byte offset', async () => {
    const { workspace, service } = fixture()
    const content = 'aaa\nbbb\nccc\n'
    writeFileSync(join(workspace, 'p.txt'), content)
    const clueId = await ensureFile(service, 'p.txt')
    const page = await service.read({ workspaceId: WORKSPACE_ID, clueId, offset: 4 })
    expect(page.text).toBe('bbb\nccc\n')
    expect(page.limited).toBe(false)
    expect(page.nextOffset).toBeUndefined()
  })

  it('reports a missing file as not-found and a missing workspace directory as dependency-missing', async () => {
    const { service } = fixture()
    await expect(service.read({
      workspaceId: WORKSPACE_ID,
      sourceId: 'builtin.files',
      typeId: LOCAL_FILE_TYPE_IDS.text,
      locator: workspaceLocator('missing.txt'),
    })).rejects.toMatchObject({ category: 'not-found' })

    const unwired = fixture({ resolveWorkspace: false })
    await expect(unwired.service.read({
      workspaceId: WORKSPACE_ID,
      sourceId: 'builtin.files',
      typeId: LOCAL_FILE_TYPE_IDS.text,
      locator: workspaceLocator('a.md'),
    })).rejects.toMatchObject({ category: 'dependency-missing' })
  })

  it('honors an aborted signal', async () => {
    const { workspace, service } = fixture()
    writeFileSync(join(workspace, 'a.md'), '# a\n')
    const clueId = await ensureFile(service, 'a.md')
    const controller = new AbortController()
    controller.abort()
    await expect(service.read({ workspaceId: WORKSPACE_ID, clueId }, { signal: controller.signal }))
      .rejects.toMatchObject({ category: 'cancelled' })
    await expect(service.list({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files' }, { signal: controller.signal }))
      .rejects.toMatchObject({ category: 'cancelled' })
  })
})

describe('builtin.files edits', () => {
  it('loads and saves a markdown document', async () => {
    const { workspace, service } = fixture()
    writeFileSync(join(workspace, 'a.md'), '# old\n')
    const clueId = await ensureFile(service, 'a.md')
    const edit = await service.loadEdit({ workspaceId: WORKSPACE_ID, clueId })
    expect(edit.format).toBe('text/markdown')
    expect(edit.data).toEqual({ text: '# old\n' })
    expect(edit.baseRevision).toBeTruthy()
    await service.saveEdit({
      workspaceId: WORKSPACE_ID,
      clueId,
      document: { format: 'text/markdown', data: { text: '# new\n' }, baseRevision: edit.baseRevision },
    })
    expect(readFileSync(join(workspace, 'a.md'), 'utf8')).toBe('# new\n')
    expect((await service.read({ workspaceId: WORKSPACE_ID, clueId })).text).toBe('# new\n')
  })

  it('restores the on-disk encoding and EOL on save (GBK + CRLF stay untouched)', async () => {
    const { workspace, service } = fixture()
    const path = join(workspace, 'legacy.txt')
    const original = '第一行\r\n第二行\r\n'
    const changed = '第一行\n改过了\n'
    writeFileSync(path, encodeText(restoreEol(original, 'crlf'), 'gbk'))
    const clueId = await ensureFile(service, 'legacy.txt')
    const edit = await service.loadEdit({ workspaceId: WORKSPACE_ID, clueId })
    expect(edit.data).toEqual({ text: '第一行\n第二行\n' })
    await service.saveEdit({
      workspaceId: WORKSPACE_ID,
      clueId,
      document: { format: 'text/plain', data: { text: changed }, baseRevision: edit.baseRevision },
    })
    expect(await fileFormatOf(path)).toEqual({ encoding: 'gbk', eol: 'crlf' })
    expect(readFileSync(path)).toEqual(encodeText(restoreEol(changed, 'crlf'), 'gbk'))
  })

  it('refuses a stale base revision with conflict and does NOT write', async () => {
    const { workspace, service } = fixture()
    const path = join(workspace, 'a.txt')
    writeFileSync(path, 'original\n')
    const clueId = await ensureFile(service, 'a.txt')
    const edit = await service.loadEdit({ workspaceId: WORKSPACE_ID, clueId })
    // Someone else changes the file while the draft is open.
    writeFileSync(path, 'external change that is longer\n')
    await expect(service.saveEdit({
      workspaceId: WORKSPACE_ID,
      clueId,
      document: { format: 'text/plain', data: { text: 'draft\n' }, baseRevision: edit.baseRevision },
    })).rejects.toMatchObject({ category: 'conflict' })
    expect(readFileSync(path, 'utf8')).toBe('external change that is longer\n')
  })

  it('refuses a save with no baseline and a mismatched format', async () => {
    const { workspace, service } = fixture()
    writeFileSync(join(workspace, 'a.txt'), 'a\n')
    const clueId = await ensureFile(service, 'a.txt')
    await expect(service.saveEdit({
      workspaceId: WORKSPACE_ID,
      clueId,
      document: { format: 'text/plain', data: { text: 'b' } },
    })).rejects.toMatchObject({ category: 'conflict' })
    const edit = await service.loadEdit({ workspaceId: WORKSPACE_ID, clueId })
    await expect(service.saveEdit({
      workspaceId: WORKSPACE_ID,
      clueId,
      document: { format: 'text/markdown', data: { text: 'b' }, baseRevision: edit.baseRevision },
    })).rejects.toMatchObject({ category: 'failed' })
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('a\n')
  })

  it('keeps binary resources read-only', async () => {
    const { workspace, service } = fixture()
    writeFileSync(join(workspace, 'image.png'), Buffer.from([0, 1, 2, 3]))
    const clueId = await ensureFile(service, 'image.png')
    await expect(service.loadEdit({ workspaceId: WORKSPACE_ID, clueId }))
      .rejects.toMatchObject({ category: 'unsupported' })
    await expect(service.saveEdit({
      workspaceId: WORKSPACE_ID,
      clueId,
      document: { format: 'application/octet-stream', data: { text: 'x' }, baseRevision: 'r' },
    })).rejects.toMatchObject({ category: 'unsupported' })
  })
})

describe('builtin.files resolve / portable / dialects', () => {
  it('resolves a relative path into a workspace locator and an absolute one into an external locator', async () => {
    const { workspace, external, service } = fixture()
    writeFileSync(join(workspace, 'a.md'), '# a\n')
    const externalFile = join(external, 'outside.txt')
    writeFileSync(externalFile, 'outside\n')

    const relative = await service.resolve({ workspaceId: WORKSPACE_ID, text: './sub/../a.md' })
    expect(relative).toHaveLength(1)
    expect(relative[0]?.locator).toMatchObject({
      root: { kind: 'workspace', workspaceId: WORKSPACE_ID },
      path: 'a.md',
      dialect: 'posix',
    })

    const absolute = await service.resolve({ workspaceId: WORKSPACE_ID, text: externalFile })
    expect(absolute[0]?.locator).toMatchObject({ root: { kind: 'external' }, path: externalFile, dialect: 'posix' })
    const ensured = await service.ensure({
      workspaceId: WORKSPACE_ID,
      sourceId: 'builtin.files',
      typeId: absolute[0]!.typeId,
      locator: absolute[0]!.locator,
      title: 'outside.txt',
    })
    expect((await service.read({ workspaceId: WORKSPACE_ID, clueId: ensured.clue.id })).text).toBe('outside\n')
    // An absolute path outside the workspace has no portable form.
    expect(await service.portable({ workspaceId: WORKSPACE_ID, clueId: ensured.clue.id })).toMatchObject({
      portable: false,
      reason: expect.any(String),
    })
  })

  it('deduplicates ensure across normalized spellings of the same workspace file', async () => {
    const { workspace, service } = fixture()
    writeFileSync(join(workspace, 'a.md'), '# a\n')
    const first = await service.ensure({
      workspaceId: WORKSPACE_ID,
      sourceId: 'builtin.files',
      typeId: LOCAL_FILE_TYPE_IDS.markdown,
      locator: workspaceLocator('./a.md'),
      title: 'a',
    })
    const second = await service.ensure({
      workspaceId: WORKSPACE_ID,
      sourceId: 'builtin.files',
      typeId: LOCAL_FILE_TYPE_IDS.markdown,
      locator: workspaceLocator('sub/../a.md'),
      title: 'a again',
    })
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.clue.id).toBe(first.clue.id)
    // A trailing separator names the same file, not a second clue.
    const third = await service.ensure({
      workspaceId: WORKSPACE_ID,
      sourceId: 'builtin.files',
      typeId: LOCAL_FILE_TYPE_IDS.markdown,
      locator: workspaceLocator('a.md/'),
      title: 'a',
    })
    expect(third.created).toBe(false)
    expect(third.clue.id).toBe(first.clue.id)
  })

  it('returns a portable workspace-relative locator', async () => {
    const { workspace, service } = fixture()
    writeFileSync(join(workspace, 'a.md'), '# a\n')
    const clueId = await ensureFile(service, 'a.md')
    const portable = await service.portable({ workspaceId: WORKSPACE_ID, clueId })
    expect(portable).toMatchObject({
      portable: true,
      locator: { root: { kind: 'workspace', workspaceId: WORKSPACE_ID }, path: 'a.md', dialect: 'posix' },
    })
  })

  it('normalizes each platform dialect with its own path module', () => {
    const source = createLocalFileSource()
    const normalize = (locator: Locator): Locator => source.operations!.normalizeLocator!(locator, { workspaceId: WORKSPACE_ID })
    expect(normalize({ root: { kind: 'external' }, path: 'C:/notes/../a.md', dialect: 'win32' }))
      .toEqual({ root: { kind: 'external' }, path: 'C:\\a.md', dialect: 'win32' })
    expect(normalize({ root: { kind: 'external' }, path: '/tmp/./a.md', dialect: 'posix' }))
      .toEqual({ root: { kind: 'external' }, path: '/tmp/a.md', dialect: 'posix' })
    // Trailing separators are one spelling of the same path, roots stay intact.
    expect(normalize({ root: { kind: 'external' }, path: '/tmp/a.md/', dialect: 'posix' }))
      .toEqual({ root: { kind: 'external' }, path: '/tmp/a.md', dialect: 'posix' })
    expect(normalize({ root: { kind: 'external' }, path: '/', dialect: 'posix' }))
      .toEqual({ root: { kind: 'external' }, path: '/', dialect: 'posix' })
    expect(normalize({ root: { kind: 'external' }, path: 'C:\\', dialect: 'win32' }))
      .toEqual({ root: { kind: 'external' }, path: 'C:\\', dialect: 'win32' })
    expect(normalize({ root: { kind: 'workspace', workspaceId: WORKSPACE_ID }, path: 'docs/', dialect: 'posix' }))
      .toEqual({ root: { kind: 'workspace', workspaceId: WORKSPACE_ID }, path: 'docs', dialect: 'posix' })
    expect(normalize({ root: { kind: 'workspace', workspaceId: WORKSPACE_ID }, path: 'docs\\a.md', dialect: 'win32' }))
      .toEqual({ root: { kind: 'workspace', workspaceId: WORKSPACE_ID }, path: 'docs\\a.md', dialect: 'win32' })
    // A workspace-relative path may not climb out of its workspace.
    expect(() => normalize({ root: { kind: 'workspace', workspaceId: WORKSPACE_ID }, path: '../escape.txt', dialect: 'posix' }))
      .toThrow(ClueError)
    // An external root must stay absolute.
    expect(() => normalize({ root: { kind: 'external' }, path: 'relative.txt', dialect: 'posix' }))
      .toThrow(ClueError)
  })

  it('folds case in win32 locator keys and detects the dialect of raw text', () => {
    const source = createLocalFileSource()
    const key = (locator: Locator): string => source.operations!.locatorKey!(locator)
    expect(key({ root: { kind: 'external' }, path: 'C:\\Notes\\A.md', dialect: 'win32' }))
      .toBe(key({ root: { kind: 'external' }, path: 'c:\\notes\\a.md', dialect: 'win32' }))
    expect(key({ root: { kind: 'workspace', workspaceId: WORKSPACE_ID }, path: 'Docs/A.md', dialect: 'posix' }))
      .not.toBe(key({ root: { kind: 'workspace', workspaceId: WORKSPACE_ID }, path: 'docs/a.md', dialect: 'posix' }))
    expect(dialectOfText('C:\\notes\\a.md')).toBe('win32')
    expect(dialectOfText('\\\\server\\share\\a.md')).toBe('win32')
    expect(dialectOfText('/tmp/a.md')).toBe('posix')
    expect(dialectOfText('docs/a.md')).toBe(process.platform === 'win32' ? 'win32' : 'posix')
  })

  it('refuses to reinterpret a foreign-dialect locator on this host', async () => {
    if (process.platform === 'win32') return
    const { service } = fixture()
    await expect(service.read({
      workspaceId: WORKSPACE_ID,
      sourceId: 'builtin.files',
      typeId: LOCAL_FILE_TYPE_IDS.text,
      locator: { root: { kind: 'external' }, path: 'C:\\notes\\a.md', dialect: 'win32' },
    })).rejects.toMatchObject({ category: 'unsupported' })
  })
})
