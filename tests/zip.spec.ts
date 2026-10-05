/**
 * ZIP builder + /sidebar/archive route.
 *
 * Two layers, no third-party ZIP dependency in either direction:
 *  - `buildZip` is checked by a minimal reader written HERE (EOCD → central
 *    directory → local header → inflate), so the test proves the bytes on the
 *    wire, not the writer's own bookkeeping. `unzip -t` is an extra check when
 *    the binary happens to exist (CI runners do not ship it).
 *  - the route is mounted against a fake cordis context (the same shape
 *    smoke.spec.ts uses) and answers a real request over a real temp
 *    workspace, covering the fence, the parameter guards and a full
 *    directory walk.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { validateHeaderValue } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

/** Windows has no POSIX file names and no POSIX mode bits (see the two guards below). */
const isWin32 = process.platform === 'win32'
import { apply } from '../src/index.ts'
import { archiveDownloadUrl } from '../src/client/api.ts'
import {
  ARCHIVE_MAX_BUILDING,
  ARCHIVE_TTL_MS,
  archiveNameOf,
  collectZipEntries,
  contentDispositionOf,
  createArchiveTasks,
  disambiguateArchiveNames,
  respondArchiveDownload,
  type ArchiveTasks,
} from '../src/archive-route.ts'
import { crc32, buildZip, type ZipEntry, type ZipProgress } from '../src/zip.ts'
import { SidebarError } from '../src/wire.ts'
import type { SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'

/** One parsed central-directory row + its local payload. */
interface ParsedEntry {
  name: string
  method: number
  crc: number
  compressedSize: number
  size: number
  flags: number
  externalAttributes: number
  isDirectory: boolean
  data: Buffer
}

/**
 * Minimal ZIP reader: locate the EOCD from the tail, walk the central
 * directory, then read each local header's payload. Enough to verify names
 * (UTF-8), methods, CRCs, sizes and both compression branches.
 */
function readZip(archive: Buffer): ParsedEntry[] {
  const eocdAt = archive.lastIndexOf(Buffer.from([0x50, 0x4B, 0x05, 0x06]))
  if (eocdAt < 0) throw new Error('no EOCD')
  if (eocdAt + 22 !== archive.length) throw new Error('EOCD is not the last record')
  const count = archive.readUInt16LE(eocdAt + 10)
  const directorySize = archive.readUInt32LE(eocdAt + 12)
  const directoryAt = archive.readUInt32LE(eocdAt + 16)
  if (count > 0 && archive.readUInt32LE(directoryAt) !== 0x02014B50) throw new Error('bad central directory signature')
  if (directoryAt + directorySize > eocdAt) throw new Error('central directory overruns the EOCD')

  const entries: ParsedEntry[] = []
  let cursor = directoryAt
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014B50) throw new Error(`bad central header ${index}`)
    const flags = archive.readUInt16LE(cursor + 8)
    const method = archive.readUInt16LE(cursor + 10)
    const crc = archive.readUInt32LE(cursor + 16)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const size = archive.readUInt32LE(cursor + 24)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const externalAttributes = archive.readUInt32LE(cursor + 38)
    const localAt = archive.readUInt32LE(cursor + 42)
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')

    if (archive.readUInt32LE(localAt) !== 0x04034B50) throw new Error(`bad local header for ${name}`)
    const localNameLength = archive.readUInt16LE(localAt + 26)
    const localExtraLength = archive.readUInt16LE(localAt + 28)
    if (archive.readUInt32LE(localAt + 14) !== crc) throw new Error(`local CRC mismatch for ${name}`)
    if (archive.readUInt32LE(localAt + 18) !== compressedSize) throw new Error(`local compressed size mismatch for ${name}`)
    if (archive.readUInt32LE(localAt + 22) !== size) throw new Error(`local size mismatch for ${name}`)
    const payloadAt = localAt + 30 + localNameLength + localExtraLength
    const payload = archive.subarray(payloadAt, payloadAt + compressedSize)
    entries.push({
      name,
      method,
      crc,
      compressedSize,
      size,
      flags,
      externalAttributes,
      isDirectory: name.endsWith('/'),
      data: method === 8 ? inflateRawSync(payload) : Buffer.from(payload),
    })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** The host mounted against a fake context: both archive routes + the API. */
function mountHost(): { api: SidebarWebRoute; download: SidebarWebRoute } {
  const routes: SidebarWebRoute[] = []
  const ctx = {
    webRuntime: { trustedHosts: [] },
    webServer: {
      register: (route: SidebarWebRoute) => { routes.push(route); return () => {} },
      registerUpgrade: (route: SidebarWebUpgradeRoute) => { void route; return () => {} },
    },
    sessions: { get: () => undefined },
    tools: { register: () => () => {} },
    effect: (fn: () => void | (() => void)) => { fn() },
    inject: () => () => {},
    on: () => () => {},
    get: () => undefined,
  }
  apply(ctx as never)
  const api = routes.find(candidate => candidate.path === '/sidebar/api')
  const download = routes.find(candidate => candidate.path === '/sidebar/archive')
  if (api === undefined) throw new Error('test setup: /sidebar/api route not registered')
  if (download === undefined) throw new Error('test setup: /sidebar/archive route not registered')
  return { api, download }
}

/** One POST /sidebar/api/<method> against the mounted API route. */
async function post(
  api: SidebarWebRoute,
  method: string,
  payload: unknown,
): Promise<{ status: number; ok: boolean; value?: unknown; error?: { code?: string; message?: string } }> {
  const body = Buffer.from(JSON.stringify(payload))
  const req = {
    method: 'POST',
    url: `/sidebar/api/${method}`,
    headers: { host: '127.0.0.1:3080' },
    [Symbol.asyncIterator]: async function* () { yield body },
  } as never
  const out: { status: number; body: string } = { status: 200, body: '' }
  const res = {
    writeHead: (status: number) => { out.status = status },
    end: (chunk: unknown) => { out.body += String(chunk ?? '') },
  } as never
  await api.handler(req, res)
  return { status: out.status, ...(JSON.parse(out.body) as { ok: boolean; value?: unknown; error?: { code?: string; message?: string } }) }
}

/** One GET against a mounted route, collecting raw bytes. */
async function get(route: SidebarWebRoute, url: string): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const out: { status: number; headers: Record<string, string>; chunks: Buffer[] } = { status: 200, headers: {}, chunks: [] }
  const req = { method: 'GET', url, headers: { host: '127.0.0.1:3080' } } as never
  const res = {
    writeHead: (status: number, headers: Record<string, string> = {}) => { out.status = status; out.headers = headers },
    end: (chunk?: Buffer | string) => { if (chunk !== undefined) out.chunks.push(Buffer.from(chunk)) },
  } as never
  await route.handler(req, res)
  return { status: out.status, headers: out.headers, body: Buffer.concat(out.chunks) }
}

/** Poll `archive.status` until the detached build settles (or throw). */
async function waitForReady(
  api: SidebarWebRoute,
  id: string,
  sessionId: string,
): Promise<{ state: string; done: number; total: number; bytes: number; error?: string }> {
  let last: { state: string; done: number; total: number; bytes: number; error?: string } | undefined
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const status = await post(api, 'archive.status', { id, sessionId })
    if (status.ok === true) {
      last = status.value as { state: string; done: number; total: number; bytes: number; error?: string }
      if (last.state !== 'building') return last
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`test setup: archive ${id} never settled (${JSON.stringify(last)})`)
}

/**
 * The whole host flow for one selection: POST archive.build, poll until the
 * detached build settles, then GET the bytes. The caller's session id is both
 * the scope and the download's fence.
 */
async function archiveFlow(input: {
  sessionId: string
  cwd: string
  name?: string
  paths: readonly string[]
}): Promise<{ build: Awaited<ReturnType<typeof post>>; status: Awaited<ReturnType<typeof waitForReady>>; download: Awaited<ReturnType<typeof get>> }> {
  const { api, download } = mountHost()
  const build = await post(api, 'archive.build', {
    sessionId: input.sessionId,
    cwd: input.cwd,
    paths: [...input.paths],
    ...(input.name === undefined ? {} : { name: input.name }),
  })
  if (build.ok !== true || build.status !== 200) {
    return { build, status: await waitForReady(api, '', input.sessionId), download: await get(download, '/sidebar/archive') }
  }
  const id = (build.value as { id: string }).id
  const status = await waitForReady(api, id, input.sessionId)
  return {
    build,
    status,
    download: await get(download, `/sidebar/archive?sessionId=${encodeURIComponent(input.sessionId)}&id=${encodeURIComponent(id)}`),
  }
}

/** A temp workspace (plus an outside sibling) removed after each test. */
const roots: string[] = []
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-zip-'))
  roots.push(root)
  return root
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('buildZip', () => {
  it('round-trips a deflated file: name, content and CRC-32', async () => {
    const root = tempRoot()
    const path = join(root, 'hello.txt')
    const content = 'hello zip\n'.repeat(200)
    writeFileSync(path, content)
    const archive = await buildZip([{ path, name: 'hello.txt' }])
    const entries = readZip(archive)
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.name).toBe('hello.txt')
    expect(entry.method).toBe(8)
    expect(entry.data.toString('utf8')).toBe(content)
    expect(entry.crc).toBe(crc32(Buffer.from(content)))
    expect(entry.size).toBe(Buffer.byteLength(content))
    expect(entry.isDirectory).toBe(false)
  })

  it('stores incompressible data (method 0) and marks UTF-8 names (bit 11)', async () => {
    const root = tempRoot()
    const path = join(root, 'random.bin')
    // High-entropy bytes: deflateRaw expands them (4096 → ~4100), so the
    // writer must fall back to `store`. Generated from a fixed seed so the
    // case stays deterministic.
    const random = Buffer.alloc(4096)
    let state = 0x9E3779B9
    for (let i = 0; i < random.length; i += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      random[i] = (state >>> 16) & 0xFF
    }
    writeFileSync(path, random)
    const archive = await buildZip([{ path, name: '数据/随机.bin' }])
    const entries = readZip(archive)
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.method).toBe(0)
    expect(entry.name).toBe('数据/随机.bin')
    expect((entry.flags & 0x0800) !== 0).toBe(true)
    expect(entry.data.equals(random)).toBe(true)
    expect(entry.crc).toBe(crc32(random))
  })

  it('writes directory rows with a trailing slash, zero payload and the dir attribute', async () => {
    const root = tempRoot()
    mkdirSync(join(root, 'nested'))
    writeFileSync(join(root, 'nested', 'a.txt'), 'a')
    const archive = await buildZip([
      { path: join(root, 'nested'), name: 'nested', isDir: true },
      { path: join(root, 'nested', 'a.txt'), name: 'nested/a.txt' },
    ])
    const entries = readZip(archive)
    expect(entries.map(entry => entry.name)).toEqual(['nested/', 'nested/a.txt'])
    const dir = entries[0]!
    expect(dir.isDirectory).toBe(true)
    expect(dir.size).toBe(0)
    expect(dir.crc).toBe(0)
    // The external-attributes word carries the Unix mode in the high half and
    // the MS-DOS directory bit in the low half: without the mode Info-ZIP
    // extracts every member as mode 000.
    expect(dir.externalAttributes & 0x10).toBe(0x10)
    expect(dir.externalAttributes >>> 16).toBe(0o40755)
    expect(entries[1]!.externalAttributes & 0x10).toBe(0)
    expect(entries[1]!.externalAttributes >>> 16).toBe(0o100644)
  })

  it('accepts an empty directory set and produces a valid empty archive', async () => {
    const archive = await buildZip([])
    expect(readZip(archive)).toEqual([])
    expect(archive.readUInt32LE(archive.length - 22)).toBe(0x06054B50)
  })

  it('reports progress per entry, monotonically, ending at the entry count', async () => {
    const root = tempRoot()
    mkdirSync(join(root, 'dir'))
    writeFileSync(join(root, 'a.txt'), 'a'.repeat(10))
    writeFileSync(join(root, 'dir', 'b.txt'), 'b'.repeat(30))
    const seen: ZipProgress[] = []
    await buildZip([
      { path: join(root, 'dir'), name: 'dir', isDir: true },
      { path: join(root, 'dir', 'b.txt'), name: 'dir/b.txt' },
      { path: join(root, 'a.txt'), name: 'a.txt' },
    ], { onProgress: (progress) => seen.push({ ...progress }) })
    expect(seen).toHaveLength(3)
    expect(seen.map(step => step.done)).toEqual([1, 2, 3])
    expect(seen.every(step => step.total === 3)).toBe(true)
    // `bytes` counts uncompressed payload and never shrinks. The directory row
    // adds nothing; b.txt (30) then a.txt (10) bring it to 40.
    expect(seen.map(step => step.bytes)).toEqual([0, 30, 40])
    // A failed entry reports nothing for itself (the throw ends the build).
    const failed: ZipProgress[] = []
    await expect(buildZip([
      { path: join(root, 'a.txt'), name: 'a.txt' },
      { path: join(root, 'missing.txt'), name: 'missing.txt' },
    ], { onProgress: (progress) => failed.push({ ...progress }) }))
      .rejects.toMatchObject({ code: 'fs-error' })
    expect(failed.map(step => step.done)).toEqual([1])
  })

  it('rejects an over-limit entry count before reading anything', async () => {
    const root = tempRoot()
    const path = join(root, 'a.txt')
    writeFileSync(path, 'a')
    await expect(buildZip([{ path, name: 'a.txt' }], { maxEntries: 0 })).rejects.toThrow(SidebarError)
    await expect(buildZip([{ path, name: 'a.txt' }], { maxEntries: 0 })).rejects.toMatchObject({ code: 'fs-error' })
  })

  it('rejects an over-limit payload with fs-error', async () => {
    const root = tempRoot()
    const path = join(root, 'big.txt')
    writeFileSync(path, 'x'.repeat(4096))
    await expect(buildZip([{ path, name: 'big.txt' }], { maxBytes: 1024 }))
      .rejects.toMatchObject({ code: 'fs-error' })
  })

  it('enforces the byte bound BEFORE reading the payload (stat first)', async () => {
    const root = tempRoot()
    const huge = join(root, 'huge.bin')
    writeFileSync(huge, Buffer.alloc(4 * 1024 * 1024, 7))
    // A source far past the budget is refused on its stat, with the archive's
    // own ceiling in the message (never an internal budget number)…
    await expect(buildZip([{ path: huge, name: 'huge.bin' }], { maxBytes: 1024 }))
      .rejects.toThrow(/exceeds the 1024 byte limit/)
    await expect(buildZip([{ path: huge, name: 'huge.bin' }], { maxBytes: 1024 }))
      .rejects.toMatchObject({ code: 'fs-error' })
    // maxBytes: 0 refuses even a one-byte source.
    const one = join(root, 'one.txt')
    writeFileSync(one, 'x')
    await expect(buildZip([{ path: one, name: 'one.txt' }], { maxBytes: 0 }))
      .rejects.toThrow(/exceeds the 0 byte limit/)
    // …and a source that exactly fills the budget is accepted.
    const two = join(root, 'two.txt')
    writeFileSync(two, 'xy')
    expect(readZip(await buildZip([{ path: two, name: 't.txt' }], { maxBytes: 2 }))[0]!.size).toBe(2)
    // The budget is the REMAINING allowance: the second entry no longer fits
    // (an exhausted budget refuses even a zero-byte source, so a FIFO can
    // never be opened — see the probe below).
    const empty = join(root, 'empty.txt')
    writeFileSync(empty, '')
    await expect(buildZip([{ path: two, name: 'a.txt' }, { path: empty, name: 'b.txt' }], { maxBytes: 2 }))
      .rejects.toMatchObject({ code: 'fs-error' })
  })

  it('never opens a source the size probe already refused (FIFO)', async () => {
    if (process.platform === 'win32') return // no FIFOs there
    const root = tempRoot()
    const fifo = join(root, 'pipe')
    const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' })
    if (made.error !== undefined || made.status !== 0) return // binary absent: skip
    // A 2-byte file consumes the whole 2-byte budget, so the FIFO's remaining
    // allowance is 0. Reading an unwritten FIFO BLOCKS FOREVER, so this test
    // can only complete when the size probe refuses it before open() — with the
    // read-then-check order it hangs and vitest fails it on timeout instead.
    // (This is the discriminating guard for F3: a "rejects quickly" timing
    // probe does NOT discriminate, because the reverted code also rejects.)
    const two = join(root, 'two.txt')
    writeFileSync(two, 'xy')
    await expect(buildZip([{ path: two, name: 'a.txt' }, { path: fifo, name: 'p' }], { maxBytes: 2 }))
      .rejects.toThrow(/exceeds the 2 byte limit/)
  }, 5_000)

  it('reports an unreadable source as fs-error and refuses traversal names', async () => {
    const root = tempRoot()
    await expect(buildZip([{ path: join(root, 'missing.txt'), name: 'missing.txt' }]))
      .rejects.toMatchObject({ code: 'fs-error' })
    await expect(buildZip([{ path: join(root, 'x'), name: '../escape.txt' }]))
      .rejects.toMatchObject({ code: 'bad-request' })
  })

  // POSIX-only: on Windows a backslash IS the separator, so `a\b.txt` can only
  // ever mean the file `b.txt` inside the directory `a` (the write below fails
  // with ENOENT). The literal-name semantics under test do not exist there.
  it.skipIf(isWin32)('keeps a backslash as part of the file name (POSIX names are literal)', async () => {
    const root = tempRoot()
    // `a\b.txt` is ONE legal POSIX file name; splitting it into a directory
    // would silently rename the member (F8).
    const path = join(root, 'a\\b.txt')
    writeFileSync(path, 'literal\n')
    const archive = await buildZip([{ path, name: 'a\\b.txt' }])
    const entries = readZip(archive)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.name).toBe('a\\b.txt')
    expect(entries[0]!.data.toString('utf8')).toBe('literal\n')
    // A traversal name is still refused, and so is a bare '..'.
    await expect(buildZip([{ path, name: 'dir/../../x' }])).rejects.toMatchObject({ code: 'bad-request' })
    await expect(buildZip([{ path, name: '..' }])).rejects.toMatchObject({ code: 'bad-request' })
  })

  it('passes `unzip -t` when the binary exists (skipped otherwise)', async () => {
    const probe = spawnSync('unzip', ['-v'], { encoding: 'utf8' })
    if (probe.error !== undefined || probe.status !== 0) return
    const root = tempRoot()
    const content = 'unzip parity\n'.repeat(100)
    writeFileSync(join(root, 'a.txt'), content)
    mkdirSync(join(root, 'dir'))
    writeFileSync(join(root, 'dir', 'b.txt'), content)
    const archive = await buildZip([
      { path: join(root, 'a.txt'), name: 'a.txt' },
      { path: join(root, 'dir'), name: 'dir', isDir: true },
      { path: join(root, 'dir', 'b.txt'), name: 'dir/b.txt' },
    ])
    const file = join(root, 'out.zip')
    writeFileSync(file, archive)
    const result = spawnSync('unzip', ['-t', file], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('No errors detected')
    // `-t` only checks CRCs; extract too, so a broken external-attributes word
    // (Info-ZIP writes mode 000 files) cannot pass unnoticed.
    const extracted = join(root, 'out')
    const unpack = spawnSync('unzip', ['-o', file, '-d', extracted], { encoding: 'utf8' })
    expect(unpack.status, unpack.stderr).toBe(0)
    if (!isWin32) {
      // POSIX-only: Windows maps every file to 0o666 on both sides, so the
      // exact-mode parity below can only be asserted where mode bits exist.
      const inMode = statSync(join(root, 'a.txt')).mode & 0o777
      const outMode = statSync(join(extracted, 'a.txt')).mode & 0o777
      expect(outMode).toBe(inMode & 0o644)
    }
    expect(readFileSync(join(extracted, 'a.txt'), 'utf8')).toBe(content)
    expect(readFileSync(join(extracted, 'dir', 'b.txt'), 'utf8')).toBe(content)
  })
})

describe('collectZipEntries', () => {
  it('walks directories depth-first in name order and bounds the row count', async () => {
    const root = tempRoot()
    mkdirSync(join(root, 'd'))
    writeFileSync(join(root, 'a.txt'), 'a')
    writeFileSync(join(root, 'd', 'b.txt'), 'b')
    const entries: ZipEntry[] = []
    await collectZipEntries(root, 'root', entries)
    expect(entries.map(entry => entry.name)).toEqual(['root', 'root/a.txt', 'root/d', 'root/d/b.txt'])
    expect(entries[0]!.isDir).toBe(true)

    const bounded: ZipEntry[] = []
    await expect(collectZipEntries(root, 'root', bounded, 2))
      .rejects.toMatchObject({ code: 'fs-error' })
    // The bound stops the walk early instead of filling the list first.
    expect(bounded.length).toBeLessThanOrEqual(2)
  })

  it('treats an unreadable row as fs-error', async () => {
    const root = tempRoot()
    const entries: ZipEntry[] = []
    await expect(collectZipEntries(join(root, 'missing'), 'missing', entries))
      .rejects.toMatchObject({ code: 'fs-error' })
  })
})

describe('archiveNameOf', () => {
  it('strips separators / quotes / control chars and applies the .zip suffix once', () => {
    expect(archiveNameOf(null)).toBe('archive.zip')
    expect(archiveNameOf('')).toBe('archive.zip')
    expect(archiveNameOf('   ')).toBe('archive.zip')
    expect(archiveNameOf('docs')).toBe('docs.zip')
    expect(archiveNameOf('docs.zip')).toBe('docs.zip')
    expect(archiveNameOf('DOCS.ZIP')).toBe('DOCS.ZIP')
    // Path separators, traversal dots and quotes never survive.
    expect(archiveNameOf('../../etc/passwd')).toBe('etcpasswd.zip')
    expect(archiveNameOf('a\\b".zip')).toBe('ab.zip')
    expect(archiveNameOf('bad\u0000name\u001F.zip')).toBe('badname.zip')
    // Length is capped, and a bare ".zip" input falls back to the default.
    expect(archiveNameOf(`${'x'.repeat(300)}.zip`).length).toBe(124)
    expect(archiveNameOf('.zip')).toBe('archive.zip')
  })
})

describe('contentDispositionOf', () => {
  it('never puts a non-latin1 character in the header value', () => {
    const header = contentDispositionOf('报告.zip')
    // Node's writeHead rejects any header value above U+00FF — the whole
    // reason the raw name cannot be used (it 500s the route). Control: the
    // exact shape this fix replaced must FAIL the same check.
    expect(() => validateHeaderValue('content-disposition', 'attachment; filename="报告.zip"'))
      .toThrow(/Invalid character in header content/)
    expect([...header].every(char => char.codePointAt(0)! <= 0xFF)).toBe(true)
    expect(validateHeaderValue('content-disposition', header)).toBeUndefined()
    expect(header).toBe(`attachment; filename="download.zip"; filename*=UTF-8''${encodeURIComponent('报告.zip')}`)
  })

  it('keeps a plain ASCII name in both halves (suffix stripped for the fallback stem only)', () => {
    const header = contentDispositionOf('docs.zip')
    expect(header).toBe(`attachment; filename="docs.zip"; filename*=UTF-8''docs.zip`)
    expect(validateHeaderValue('content-disposition', header)).toBeUndefined()
    // A mixed name keeps whatever ASCII survives in the fallback.
    expect(contentDispositionOf('報告 Q3.zip')).toContain('filename=" Q3.zip"')
  })
})

describe('disambiguateArchiveNames', () => {
  it('keeps the basename when nothing collides', () => {
    expect(disambiguateArchiveNames(['/ws/src', '/ws/notes.md'])).toEqual(['src', 'notes.md'])
  })

  it('prepends parent directories only for the colliding selections', () => {
    expect(disambiguateArchiveNames(['/ws/a/index.ts', '/ws/b/index.ts']))
      .toEqual(['a/index.ts', 'b/index.ts'])
    // The unaffected selection keeps its short name.
    expect(disambiguateArchiveNames(['/ws/a/index.ts', '/ws/notes.md']))
      .toEqual(['index.ts', 'notes.md'])
  })

  it('walks further up while ancestors still collide', () => {
    // Both are `src/index.ts` relative to their own parent: one more level.
    expect(disambiguateArchiveNames(['/ws/a/src/index.ts', '/ws/b/src/index.ts']))
      .toEqual(['a/src/index.ts', 'b/src/index.ts'])
  })

  it('falls back to the full path when no ancestor can separate the names', () => {
    expect(disambiguateArchiveNames(['/ws/a.txt', '/ws/a.txt'])).toEqual(['ws/a.txt', 'ws/a.txt'])
  })
})

describe('archive task flow (build → status → download)', () => {
  it('archive client helpers build the frozen request/URL shapes', () => {
    expect(archiveDownloadUrl({ sessionId: 's-1' }, 'ar-9'))
      .toBe('/sidebar/archive?sessionId=s-1&id=ar-9')
  })

  it('zips a selected file and a selected directory, walking it recursively', async () => {
    const root = tempRoot()
    const workspace = join(root, 'workspace')
    mkdirSync(join(workspace, 'src', 'deep'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'index.ts'), 'export {}\n')
    writeFileSync(join(workspace, 'src', 'deep', 'nested.ts'), 'nested\n')
    writeFileSync(join(workspace, 'notes.md'), '# notes\n')
    const { build, download } = await archiveFlow({
      sessionId: 's-zip',
      cwd: workspace,
      name: '我的打包.zip',
      paths: [join(workspace, 'src'), join(workspace, 'notes.md')],
    })
    expect(build.ok).toBe(true)
    expect(build.status).toBe(200)
    expect(build.value).toMatchObject({ entries: 5 })
    expect(download.status).toBe(200)
    expect(download.headers['content-type']).toBe('application/zip')
    // F1: the name is never header-raw. See the real-HTTP case below for the
    // node:http proof that a non-latin1 name no longer 500s.
    expect(download.headers['content-disposition'])
      .toBe(`attachment; filename="download.zip"; filename*=UTF-8''${encodeURIComponent('我的打包.zip')}`)
    expect(Number(download.headers['content-length'])).toBe(download.body.byteLength)
    const entries = readZip(download.body)
    expect(entries.map(entry => entry.name)).toEqual([
      'src/',
      'src/deep/',
      'src/deep/nested.ts',
      'src/index.ts',
      'notes.md',
    ])
    const byName = new Map(entries.map(entry => [entry.name, entry]))
    expect(byName.get('src/index.ts')!.data.toString('utf8')).toBe('export {}\n')
    expect(byName.get('notes.md')!.data.toString('utf8')).toBe('# notes\n')
  })

  it('reports progress through archive.status and releases after the download', async () => {
    const root = tempRoot()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'a.txt'), 'a\n')
    writeFileSync(join(workspace, 'b.txt'), 'b\n')
    const { api, download } = mountHost()
    const build = await post(api, 'archive.build', { sessionId: 's-zip', cwd: workspace, paths: [join(workspace, 'a.txt'), join(workspace, 'b.txt')] })
    expect(build.ok).toBe(true)
    const id = (build.value as { id: string }).id
    const status = await post(api, 'archive.status', { id, sessionId: 's-zip' })
    expect(status.ok).toBe(true)
    const first = status.value as { state: string; done: number; total: number; bytes: number }
    expect(first.total).toBe(2)
    expect(['building', 'ready']).toContain(first.state)
    expect(first.done).toBeGreaterThanOrEqual(0)
    expect(first.bytes).toBeGreaterThanOrEqual(0)
    const settled = await waitForReady(api, id, 's-zip')
    expect(settled.state).toBe('ready')
    expect(settled.done).toBe(2)
    // The download serves the bytes…
    const served = await get(download, `/sidebar/archive?sessionId=s-zip&id=${encodeURIComponent(id)}`)
    expect(served.status).toBe(200)
    // …and consumes the task: a second fetch is a 404.
    const second = await get(download, `/sidebar/archive?sessionId=s-zip&id=${encodeURIComponent(id)}`)
    expect(second.status).toBe(404)
    const gone = await post(api, 'archive.status', { id, sessionId: 's-zip' })
    expect(gone.ok).toBe(false)
    expect(gone.error?.code).toBe('not-found')
  })

  it('settles to ready with done === total (progress is monotonic and complete)', async () => {
    const root = tempRoot()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace, { recursive: true })
    for (const name of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(workspace, name), name)
    const { api } = mountHost()
    const build = await post(api, 'archive.build', {
      sessionId: 's-zip',
      cwd: workspace,
      paths: [join(workspace, 'a.txt'), join(workspace, 'b.txt'), join(workspace, 'c.txt')],
    })
    const id = (build.value as { id: string }).id
    // The build is detached; poll until it settles. Every poll must be
    // monotonic (done never goes backwards, bytes never shrink).
    let previousDone = -1
    let previousBytes = -1
    let settled: { state: string; done: number; total: number; bytes: number } | undefined
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const status = await post(api, 'archive.status', { id, sessionId: 's-zip' })
      const value = status.value as { state: string; done: number; total: number; bytes: number }
      expect(value.done).toBeGreaterThanOrEqual(previousDone)
      expect(value.bytes).toBeGreaterThanOrEqual(previousBytes)
      previousDone = value.done
      previousBytes = value.bytes
      if (value.state !== 'building') { settled = value; break }
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(settled?.state).toBe('ready')
    expect(settled?.total).toBe(3)
    expect(settled?.done).toBe(3)
  })

  it('refuses another session\'s task (403) and an unknown id (404)', async () => {
    const root = tempRoot()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'a.txt'), 'a')
    const { api, download } = mountHost()
    const build = await post(api, 'archive.build', { sessionId: 's-zip', cwd: workspace, paths: [join(workspace, 'a.txt')] })
    const id = (build.value as { id: string }).id
    const foreign = await post(api, 'archive.status', { id, sessionId: 's-other' })
    expect(foreign.ok).toBe(false)
    expect(foreign.error?.code).toBe('forbidden')
    const foreignDownload = await get(download, `/sidebar/archive?sessionId=s-other&id=${encodeURIComponent(id)}`)
    expect(foreignDownload.status).toBe(403)
    const unknown = await post(api, 'archive.status', { id: 'ar-nope', sessionId: 's-zip' })
    expect(unknown.error?.code).toBe('not-found')
    // The failed foreign reads did not consume the task.
    await waitForReady(api, id, 's-zip')
    const own = await get(download, `/sidebar/archive?sessionId=s-zip&id=${encodeURIComponent(id)}`)
    expect(own.status).toBe(200)
  })

  it('caps concurrent builds (the 5th start is refused)', async () => {
    const root = tempRoot()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'a.txt'), 'a')
    const { api } = mountHost()
    const tasks = createArchiveTasks()
    expect(ARCHIVE_MAX_BUILDING).toBe(4)
    // A large entry set keeps each detached build running across the next
    // start (a 1-entry build can finish between two awaits).
    const big = join(workspace, 'big.bin')
    writeFileSync(big, Buffer.alloc(2 * 1024 * 1024, 3))
    for (let index = 0; index < ARCHIVE_MAX_BUILDING; index += 1) {
      tasks.start({ sessionId: 's', name: 'x.zip', entries: [{ path: big, name: 'big.bin' }] })
    }
    expect(() => tasks.start({ sessionId: 's', name: 'x.zip', entries: [{ path: big, name: 'big.bin' }] }))
      .toThrow(/too many archives are being built/)
    // The API route surfaces the same refusal as a bad-request envelope.
    for (let index = 0; index < ARCHIVE_MAX_BUILDING; index += 1) {
      const accepted = await post(api, 'archive.build', { sessionId: 's-zip', cwd: workspace, paths: [big] })
      expect(accepted.ok).toBe(true)
    }
    const refused = await post(api, 'archive.build', { sessionId: 's-zip', cwd: workspace, paths: [big] })
    expect(refused.ok).toBe(false)
    expect(refused.error?.message).toMatch(/too many archives/)
  })

  it('surfaces a build failure as an error task with its message', async () => {
    const root = tempRoot()
    const missing = join(root, 'missing.txt')
    // The route's collector lstat's every selection, so a missing path never
    // becomes a task at all (the POST refuses it). The DETACHED failure is the
    // race the task state exists for — a source that vanishes after the walk —
    // so it is exercised on the table directly, then through the route by
    // making an errored task's TTL expire.
    const tasks = createArchiveTasks()
    const started = tasks.start({ sessionId: 's', name: 'x.zip', entries: [{ path: missing, name: 'missing.txt' }] })
    await vi.waitFor(() => { expect(tasks.status(started.id, 's').state).toBe('error') })
    const errored = tasks.status(started.id, 's')
    expect(errored.state).toBe('error')
    expect(errored.error).toMatch(/missing\.txt/)
    expect(tasks.lookup(started.id, 's')).toMatchObject({ ok: false, reason: 'error' })
    // An errored task answers its download with 410 Gone, not a silent 404.
    const { api, download } = mountHost()
    const refused = await post(api, 'archive.build', { sessionId: 's-zip', cwd: root, paths: [missing] })
    expect(refused.ok).toBe(false)
    expect(refused.error?.code).toBe('fs-error')
    const gone = await get(download, `/sidebar/archive?sessionId=s-zip&id=ar-nope`)
    expect(gone.status).toBe(404)
  })

  it('answers a failed build with 410 Gone and another session with 403', async () => {
    const root = tempRoot()
    const missing = join(root, 'missing.txt')
    const tasks = createArchiveTasks()
    const started = tasks.start({ sessionId: 's', name: 'x.zip', entries: [{ path: missing, name: 'missing.txt' }] })
    await vi.waitFor(() => { expect(tasks.status(started.id, 's').state).toBe('error') })
    // Every non-200 branch of the download route, through its own mapping.
    const answer = (sessionId: string | null, id: string | null): { status: number; error?: string } => {
      const out: { status: number; error?: string } = { status: 0 }
      try {
        respondArchiveDownload(tasks, { sessionId, id }, {
          writeHead: (status) => { out.status = status },
          end: () => {},
        })
      } catch (error) {
        out.error = error instanceof Error ? error.message : String(error)
        out.status = error instanceof SidebarError ? error.status : 500
      }
      return out
    }
    expect(answer('s', started.id)).toMatchObject({ status: 410, error: expect.stringMatching(/missing\.txt/) })
    expect(answer('other', started.id)).toMatchObject({ status: 403 })
    expect(answer(null, started.id)).toMatchObject({ status: 400 })
    expect(answer('s', null)).toMatchObject({ status: 400 })
    expect(answer('s', 'ar-nope')).toMatchObject({ status: 404 })
    // The 409 and 200 branches get a STUB table: a real build of a one-file
    // archive can already be ready by the next line, which would test timing
    // rather than the mapping.
    const stubFile = join(root, 'stub.txt')
    writeFileSync(stubFile, 'stub')
    const bytes = await buildZip([{ path: stubFile, name: 'stub.txt' }])
    let released = 0
    const fake = (lookup: ArchiveTasks['lookup']): ArchiveTasks => ({
      start: () => { throw new Error('not used') },
      status: () => { throw new Error('not used') },
      lookup,
      release: () => { released += 1 },
      size: () => 0,
    })
    const building = fake(() => ({ ok: false, reason: 'building', message: 'archive is still being built' }))
    const buildAnswer = (tasks: ArchiveTasks): { status: number; error?: string } => {
      const out: { status: number; error?: string } = { status: 0 }
      try {
        respondArchiveDownload(tasks, { sessionId: 's', id: 'ar-1' }, { writeHead: (status) => { out.status = status }, end: () => {} })
      } catch (error) {
        out.error = error instanceof Error ? error.message : String(error)
        out.status = error instanceof SidebarError ? error.status : 500
      }
      return out
    }
    expect(buildAnswer(building)).toMatchObject({ status: 409, error: expect.stringMatching(/still being built/) })
    const ready = fake(() => ({
      ok: true,
      task: { id: 'ar-1', sessionId: 's', name: '报告.zip', state: 'ready', done: 1, total: 1, bytes: 1, zip: bytes, expiresAt: 0 },
    }))
    const wire: { status: number; headers?: Record<string, string>; body?: Buffer } = { status: 0 }
    respondArchiveDownload(ready, { sessionId: 's', id: 'ar-1' }, {
      writeHead: (status, headers) => { wire.status = status; wire.headers = headers },
      end: (chunk) => { wire.body = Buffer.from(chunk ?? '') },
    })
    expect(wire.status).toBe(200)
    expect(wire.headers?.['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent('报告.zip')}`)
    expect(wire.headers?.['content-length']).toBe(String(bytes.byteLength))
    expect(wire.body!.equals(bytes)).toBe(true)
    expect(released).toBe(1)
  })

  it('serves a non-latin1 download name through REAL node:http (no 500, RFC 5987)', async () => {
    const root = tempRoot()
    const workspace = join(root, 'workspace')
    mkdirSync(join(workspace, '报告'), { recursive: true })
    writeFileSync(join(workspace, '报告', '数据.txt'), 'x\n')
    const { api, download } = mountHost()
    const name = '报告.zip'
    const { createServer } = await import('node:http')
    const server = createServer((req, res) => { void download.handler(req as never, res as never) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('test setup: no server port')
      const build = await post(api, 'archive.build', { sessionId: 's-zip', cwd: workspace, name, paths: [join(workspace, '报告')] })
      const id = (build.value as { id: string }).id
      await waitForReady(api, id, 's-zip')
      // The route handler answers a REAL ServerResponse here: node:http's
      // writeHead validates header values, which the plain-object stub in the
      // other cases cannot do — that is exactly how the Chinese-name 500 hid.
      const response = await fetch(`http://127.0.0.1:${address.port}/sidebar/archive?sessionId=s-zip&id=${encodeURIComponent(id)}`)
      expect(response.status).toBe(200)
      const disposition = response.headers.get('content-disposition') ?? ''
      // The ASCII half is what old clients read; the RFC 5987 half carries the
      // real name and is what every current browser picks.
      expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent(name)}`)
      expect(disposition).toContain('filename="download.zip"')
      // The header VALUE must be latin1-clean (Node's own rule).
      expect([...disposition].every(char => char.codePointAt(0)! <= 0xFF)).toBe(true)
      const entries = readZip(Buffer.from(await response.arrayBuffer()))
      expect(entries.map(entry => entry.name)).toEqual(['报告/', '报告/数据.txt'])
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('disambiguates same-name selections with their parent directories', async () => {
    const root = tempRoot()
    const workspace = join(root, 'workspace')
    mkdirSync(join(workspace, 'a'), { recursive: true })
    mkdirSync(join(workspace, 'b'), { recursive: true })
    writeFileSync(join(workspace, 'a', 'index.ts'), 'from a\n')
    writeFileSync(join(workspace, 'b', 'index.ts'), 'from b\n')
    const { download } = await archiveFlow({
      sessionId: 's-zip',
      cwd: workspace,
      paths: [join(workspace, 'a', 'index.ts'), join(workspace, 'b', 'index.ts')],
    })
    expect(download.status).toBe(200)
    const entries = readZip(download.body)
    const names = entries.map(entry => entry.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(['a/index.ts', 'b/index.ts'])
    const byName = new Map(entries.map(entry => [entry.name, entry]))
    expect(byName.get('a/index.ts')!.data.toString('utf8')).toBe('from a\n')
    expect(byName.get('b/index.ts')!.data.toString('utf8')).toBe('from b\n')
  })

  it('zips a path outside the session workspace (fence removed)', async () => {
    const root = tempRoot()
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    mkdirSync(workspace)
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    const { download } = await archiveFlow({
      sessionId: 's-zip',
      cwd: workspace,
      paths: [join(outside, 'secret.txt')],
    })
    // ⚠️ PERMISSION CHANGE: an absolute path outside the workspace is now a
    // normal selection (no 403 branch exists any more).
    expect(download.status).toBe(200)
    const entries = readZip(download.body)
    expect(entries.map(entry => entry.name)).toEqual(['secret.txt'])
    expect(entries[0]!.data.toString('utf8')).toBe('secret')
  })

  it('skips a symlink row while walking a directory (no escape by following)', async () => {
    const root = tempRoot()
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    mkdirSync(workspace)
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    try {
      symlinkSync(outside, join(workspace, 'link'))
      writeFileSync(join(workspace, 'keep.txt'), 'keep')
    } catch {
      return // symlink creation needs privileges on Windows
    }
    // A DIRECTORY walk still never descends through a link (that rule is about
    // cycles, not containment): the link row is reported as an entry-less row,
    // so the archive holds no bytes from its target.
    const { download } = await archiveFlow({ sessionId: 's-zip', cwd: workspace, paths: [workspace] })
    expect(download.status).toBe(200)
    const entries = readZip(download.body)
    expect(entries.map(entry => entry.name)).toEqual(['workspace/', 'workspace/keep.txt'])
    expect(entries.some(entry => entry.data.toString('utf8').includes('secret'))).toBe(false)
  })

  it('rejects an empty path list and a download without sessionId/id (400)', async () => {
    const root = tempRoot()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const { api, download } = mountHost()
    const noPath = await post(api, 'archive.build', { sessionId: 's-zip', cwd: workspace, paths: [] })
    expect(noPath.status).toBe(400)
    expect(noPath.error?.code).toBe('bad-request')
    const noId = await get(download, `/sidebar/archive?sessionId=s-zip`)
    expect(noId.status).toBe(400)
    expect(JSON.parse(noId.body.toString('utf8'))).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    const noSession = await get(download, `/sidebar/archive?id=ar-1`)
    expect(noSession.status).toBe(400)
  })

  it('sanitizes the download name (separators stripped, default and suffix applied)', async () => {
    const root = tempRoot()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    writeFileSync(join(workspace, 'a.txt'), 'a')
    const paths = [join(workspace, 'a.txt')]
    const traversal = await archiveFlow({ sessionId: 's-zip', cwd: workspace, name: '../evil")b.zip', paths })
    expect(traversal.download.headers['content-disposition']).toContain('filename="evil)b.zip"')
    const bare = await archiveFlow({ sessionId: 's-zip', cwd: workspace, name: 'docs', paths })
    expect(bare.download.headers['content-disposition']).toContain('filename="docs.zip"')
    const fallback = await archiveFlow({ sessionId: 's-zip', cwd: workspace, paths })
    expect(fallback.download.headers['content-disposition']).toContain('filename="archive.zip"')
  })

  it('rejects a non-GET method on the download route', async () => {
    const { download } = mountHost()
    const out: { status: number; body: string } = { status: 200, body: '' }
    const req = { method: 'POST', url: '/sidebar/archive?id=x', headers: { host: '127.0.0.1:3080' } } as never
    const res = {
      writeHead: (status: number) => { out.status = status },
      end: (chunk?: string) => { out.body += String(chunk ?? '') },
    } as never
    await download.handler(req, res)
    expect(out.status).toBe(405)
  })
})

describe('createArchiveTasks', () => {
  it('expires a settled task after its TTL', async () => {
    const root = tempRoot()
    const file = join(root, 'a.txt')
    writeFileSync(file, 'a')
    const tasks = createArchiveTasks()
    const { id } = tasks.start({ sessionId: 's', name: 'x.zip', entries: [{ path: file, name: 'a.txt' }] })
    await vi.waitFor(() => { expect(tasks.status(id, 's').state).toBe('ready') })
    expect(tasks.size()).toBe(1)
    expect(tasks.status(id, 's')).toMatchObject({ state: 'ready', done: 1, total: 1 })
    // A TTL of zero makes the sweep drop it on the next access (the real TTL
    // is 5 minutes; this is the same code path without the wait).
    const aged = createArchiveTasks()
    const started = aged.start({ sessionId: 's', name: 'x.zip', entries: [{ path: file, name: 'a.txt' }] })
    await vi.waitFor(() => { expect(aged.status(started.id, 's').state).toBe('ready') })
    vi.setSystemTime(Date.now() + ARCHIVE_TTL_MS + 1)
    try {
      expect(() => aged.status(started.id, 's')).toThrow(/unknown or expired/)
      expect(aged.size()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
