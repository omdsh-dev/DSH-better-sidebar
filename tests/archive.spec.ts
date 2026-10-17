/**
 * The archive flow: `archive.build` → `archive.status` → GET /sidebar/archive.
 *
 * The hand-written writer is gone (see archive-tools.ts), so nothing here
 * inflates bytes any more. What this file pins is the ROUTE contract: the
 * `{id, name, entries}` a build answers with, the `{state, bytes}` a poll
 * reads (no entry counters — a child process reports none), the six download
 * branches, the concurrency cap and the TTL, that a download CONSUMES the task
 * and deletes its temp file, and that teardown kills a running build.
 *
 * Two injection seams, both on purpose (AGENTS §6 — a spec may not depend on
 * `zip` being installed):
 *  - `createArchiveTasks({spawn, tempDir, resolveTool})` for everything that is
 *    really about the task table and the download mapping;
 *  - the module-level `spawn` for the cases that must go through a MOUNTED
 *    host, whose table is built inside `apply` and is not injectable. That fake
 *    intercepts `zip` / `tar` only and hands every other binary to the real
 *    spawn — resolving the session cwd runs a real `git rev-parse` on the way.
 * No case here runs a real zip/tar; the one real-binary case lives in
 * archive-tools.spec.ts and self-probes.
 *
 * Temp files: an injected table gets a real `mkdtemp` directory, and the
 * mounted host gets `TMPDIR`/`TEMP`/`TMP` pointed at one too (`os.tmpdir()`
 * reads the environment per call), so no case ever writes into — or asserts
 * about — the user's real temp directory.
 */
import './browser-globals.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  
  writeFileSync,
  writeSync,
} from 'node:fs'
import { validateHeaderValue } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { apply } from '../src/index.ts'
import { archiveDownloadUrl } from '../src/client/api.ts'
import {
  ARCHIVE_MAX_BUILDING,
  ARCHIVE_TTL_MS,
  contentDispositionOf,
  createArchiveTasks,
  respondArchiveDownload,
  type ArchiveStatus,
  type ArchiveTasks,
} from '../src/archive-route.ts'
import {
  archiveTempName,
  resetArchiveToolCache,
  type ArchiveSpawn,
  type ArchiveToolSpec,
} from '../src/archive-tools.ts'
import { writeError } from '../src/wire.ts'
import type { SidebarHttpResponse, SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'
import { removeTree } from './temp-tree.ts'

/** The OS temp directory as it was BEFORE this file points TMPDIR at a scratch dir. */
const realTmp = tmpdir()

/**
 * What the faked `spawn` answers. Shared with the `vi.mock` factory below,
 * which is hoisted above this module's imports (hence `vi.hoisted`).
 */
const tool = vi.hoisted(() => ({
  /** `ok` writes `payload` and exits 0; `fail` exits 2 with stderr; `hang`
   *  never settles; `missing` makes the probe answer non-zero (no tool at all). */
  mode: 'ok' as 'ok' | 'fail' | 'hang' | 'missing',
  /** The bytes a successful build leaves in the temp file. */
  payload: 'PK\u0003\u0004 fake archive bytes\n',
  /** Non-probe invocations, in order. */
  runs: 0,
  /** Children handed out for a run, so teardown assertions can read `kill`. */
  children: [] as Array<{ kill: (signal?: string) => boolean }>,
}))

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  const { writeSync } = await import('node:fs')
  const spawn = ((bin: string, args: readonly string[], options: { stdio?: unknown }) => {
    // Only the archive tools are faked: cwd resolution runs a real `git`.
    if (bin !== 'zip' && bin !== 'tar') {
      return actual.spawn(bin as never, args as never, options as never)
    }
    const child = new EventEmitter() as EventEmitter & {
      stderr: InstanceType<typeof PassThrough>
      kill: (signal?: string) => boolean
    }
    child.stderr = new PassThrough()
    child.kill = () => true
    if (options.stdio === 'ignore') {
      const code = tool.mode === 'missing' ? 1 : 0
      process.nextTick(() => { child.emit('exit', code) })
      return child
    }
    tool.runs += 1
    tool.children.push(child)
    const fd = Array.isArray(options.stdio) ? options.stdio[1] : undefined
    process.nextTick(() => {
      if (tool.mode === 'hang') return
      if (tool.mode === 'fail') {
        child.stderr.write('zip error: nothing to do\n')
        child.emit('close', 2)
        return
      }
      if (typeof fd === 'number') writeSync(fd, Buffer.from(tool.payload))
      child.emit('close', 0)
    })
    return child
  }) as unknown as typeof actual.spawn
  return { ...actual, spawn }
})

/** The wire shape of one API answer. */
interface Envelope<T = unknown> {
  ok: boolean
  value?: T
  error?: { code?: string; message?: string }
}

/** One recorded response: status, headers, raw bytes and the parsed envelope. */
interface Wire {
  status: number
  headers: Record<string, string>
  chunks: Buffer[]
  /** The JSON body as an envelope, read lazily (`{ok: false}` for byte responses). */
  readonly envelope: Envelope
}

/**
 * A response face that records what a route wrote — and is a real Writable, so
 * the streaming download path (`pipeline`) works against it exactly as it does
 * against a `node:http` response.
 *
 * The returned `wire` is one mutable object the route writes THROUGH (a fresh
 * one per read would hand the test an empty snapshot taken before the call).
 */
function responseRecorder(): { res: SidebarHttpResponse; wire: Wire } {
  const wire = {
    status: 200,
    headers: {} as Record<string, string>,
    chunks: [] as Buffer[],
    get envelope(): Envelope {
      const body = Buffer.concat(wire.chunks).toString('utf8')
      if (body === '') return { ok: false }
      try {
        return JSON.parse(body) as Envelope
      } catch {
        return { ok: false }
      }
    },
  }
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      wire.chunks.push(Buffer.from(chunk))
      done()
    },
  })
  const res = Object.assign(stream, {
    writeHead: (status: number, headers: Record<string, string> = {}) => {
      wire.status = status
      wire.headers = headers
    },
  })
  return { res: res as unknown as SidebarHttpResponse, wire }
}

/** The host mounted against a fake context: both archive routes + the API. */
function mountHost(): { api: SidebarWebRoute; download: SidebarWebRoute } {
  const routes: SidebarWebRoute[] = []
  const ctx = {
    connection: { requestRejection: () => undefined },
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
async function post(api: SidebarWebRoute, method: string, payload: unknown): Promise<Wire> {
  const body = Buffer.from(JSON.stringify(payload))
  const req = {
    method: 'POST',
    url: `/sidebar/api/${method}`,
    headers: { host: '127.0.0.1:3080' },
    [Symbol.asyncIterator]: async function* () { yield body },
  } as never
  const { res, wire } = responseRecorder()
  await api.handler(req, res)
  return wire
}

/** One request against a mounted raw route. */
async function request(route: SidebarWebRoute, method: string, url: string): Promise<Wire> {
  const req = { method, url, headers: { host: '127.0.0.1:3080' } } as never
  const { res, wire } = responseRecorder()
  await route.handler(req, res)
  return wire
}

/** Poll `archive.status` until the detached build settles (or throw). */
async function waitForSettled(api: SidebarWebRoute, id: string, sessionId: string): Promise<ArchiveStatus> {
  let last: ArchiveStatus | undefined
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const status = await post(api, 'archive.status', { id, sessionId })
    if (status.envelope.ok === true) {
      last = status.envelope.value as ArchiveStatus
      if (last.state !== 'building') return last
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`test setup: archive ${id} never settled (${JSON.stringify(last)})`)
}

/**
 * One GET /sidebar/archive through the task table's own mapping: what the
 * route does, including the JSON envelope its catch block writes.
 */
async function download(tasks: ArchiveTasks, sessionId: string | null, id: string | null): Promise<Wire> {
  const { res, wire } = responseRecorder()
  try {
    await respondArchiveDownload(tasks, { sessionId, id }, res)
  } catch (error: unknown) {
    writeError(res, error)
  }
  return wire
}

/** Every temp directory and fixture tree the current case owns. */
let scratch = ''
/** The temp directory the plugin's own default would use (TMPDIR points here). */
let tempDir = ''
/** Every table this case built: disposed after it (a hanging build holds a descriptor). */
const tables: ArchiveTasks[] = []
const savedTmp = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP }

beforeEach(() => {
  scratch = mkdtempSync(join(realTmp, 'dsh-archive-spec-'))
  tempDir = mkdtempSync(join(realTmp, 'dsh-archive-tmp-'))
  process.env.TMPDIR = tempDir
  process.env.TEMP = tempDir
  process.env.TMP = tempDir
  tool.mode = 'ok'
  tool.runs = 0
  tool.children.length = 0
  resetArchiveToolCache()
})

afterEach(async () => {
  // Before the mocks go: `dispose()` kills through a fake whose `kill` is a
  // `vi.fn`, and those implementations do not survive a restore.
  for (const tasks of tables.splice(0)) tasks.dispose()
  // A killed child closes asynchronously; let the close land (and the packer
  // close its descriptor) before the directories underneath it disappear.
  await new Promise(resolve => setTimeout(resolve, 0))
  for (const [key, value] of Object.entries(savedTmp)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetArchiveToolCache()
  vi.useRealTimers()
  vi.restoreAllMocks()
  removeTree(scratch)
  removeTree(tempDir)
})

/** A directory inside the per-test fixture tree (removed with it). */
function workspace(name: string): string {
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Two real files to select (the faked tool never looks at them). */
function sampleSelection(): string[] {
  const dir = join(scratch, 'selection')
  mkdirSync(dir, { recursive: true })
  return ['a.txt', 'b.txt'].map((name) => {
    writeFileSync(join(dir, name), name)
    return join(dir, name)
  })
}

/** What one injected table's faked tool does. */
interface ToolBehavior {
  /** `missing` makes the probe fail (only useful with an injected resolveTool). */
  probe?: 'ok' | 'missing'
  run?: {
    bytes?: Buffer
    code?: number
    stderr?: string
    /** Keep running until `kill()` (a build teardown has to end). */
    hang?: boolean
  }
}

/** The minimum of a ChildProcess these specs touch. */
type ToolChild = EventEmitter & { stderr: PassThrough; kill: ReturnType<typeof vi.fn> }

/** A scripted `spawn`: a probe answers `--version`, a run writes the payload. */
function toolSpawn(behavior: ToolBehavior = {}): { spawner: ArchiveSpawn; children: ToolChild[] } {
  const children: ToolChild[] = []
  const spawner = ((_bin: string, _args: readonly string[], options: { stdio?: unknown }): ToolChild => {
    const child = new EventEmitter() as ToolChild
    child.stderr = new PassThrough()
    const run = behavior.run ?? {}
    let hangs = run.hang === true
    // A killed child exits BY SIGNAL — 'close' with no exit code, which is
    // exactly what a real SIGTERM looks like from here.
    child.kill = vi.fn(() => {
      if (hangs) {
        hangs = false
        child.emit('close', null)
      }
      return true
    })
    children.push(child)
    if (options.stdio === 'ignore') {
      const ok = (behavior.probe ?? 'ok') === 'ok'
      process.nextTick(() => { child.emit('exit', ok ? 0 : 1) })
      return child
    }
    const fd = Array.isArray(options.stdio) ? options.stdio[1] : undefined
    process.nextTick(() => {
      if (run.hang === true) return
      if (run.stderr !== undefined) child.stderr.write(run.stderr)
      if (run.bytes !== undefined && typeof fd === 'number') writeSync(fd, run.bytes)
      child.emit('close', run.code ?? 0)
    })
    return child
  }) as unknown as ArchiveSpawn
  return { spawner, children }
}

/** The zip spec as the route's own extension handling sees it. */
const ZIP_SPEC: ArchiveToolSpec = { tool: 'zip', bin: 'zip', flags: ['-r', '-q', '-X', '-y', '-'], ext: '.zip' }
/** A tar-only host's spec (Windows without Info-ZIP). */
const TAR_SPEC: ArchiveToolSpec = { tool: 'tar', bin: 'tar', flags: ['-czf', '-'], ext: '.tar.gz' }

/** One task table with all three injectable faces faked. */
function makeTable(input: { spec?: ArchiveToolSpec; behavior?: ToolBehavior } = {}): {
  tasks: ArchiveTasks
  tempDir: string
  children: ToolChild[]
} {
  const spec = 'spec' in input ? input.spec : ZIP_SPEC
  const dir = mkdtempSync(join(scratch, 'archives-'))
  const { spawner, children } = toolSpawn(input.behavior)
  const tasks = createArchiveTasks({ spawn: spawner, tempDir: dir, resolveTool: async () => spec })
  tables.push(tasks)
  return { tasks, tempDir: dir, children }
}

/** Poll one table until its task settles (never `building` on return). */
async function settledStatus(tasks: ArchiveTasks, id: string, sessionId: string): Promise<ArchiveStatus> {
  await vi.waitFor(() => { expect(tasks.status(id, sessionId).state).not.toBe('building') })
  return tasks.status(id, sessionId)
}

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

describe('archive task table (injected spawn)', () => {
  it('applies the tool\'s extension to the name the client asked for', async () => {
    const zip = makeTable()
    const paths = sampleSelection()
    const started = await zip.tasks.start({ sessionId: 's-1', name: 'docs.zip', paths })
    expect(started.id).toMatch(/^ar-/)
    expect(started.name).toBe('docs.zip')
    expect(started.entries).toBe(paths.length)

    // The same stem on a tar-only host: the client's guessed `.zip` is
    // replaced by what the tool actually produced.
    const tar = makeTable({ spec: TAR_SPEC })
    const guessed = await tar.tasks.start({ sessionId: 's-1', name: 'docs.zip', paths })
    expect(guessed.name).toBe('docs.tar.gz')
  })

  it('sanitizes the client\'s name into a flat, traversal-free download name', async () => {
    const { tasks } = makeTable()
    const paths = sampleSelection()
    const traversal = await tasks.start({ sessionId: 's-1', name: '../evil")b.zip', paths })
    expect(traversal.name).toBe('evil)b.zip')
    // The served header is the sanitized name, never the raw input.
    await settledStatus(tasks, traversal.id, 's-1')
    const served = await download(tasks, 's-1', traversal.id)
    expect(served.headers['content-disposition']).toContain('filename="evil)b.zip"')
    expect((await tasks.start({ sessionId: 's-1', name: 'docs', paths })).name).toBe('docs.zip')
    expect((await tasks.start({ sessionId: 's-1', name: '', paths })).name).toBe('archive.zip')
  })

  it('reports {state, bytes} — the entry counters are gone — and settles ready', async () => {
    const payload = Buffer.from('PK\u0003\u0004 payload')
    const { tasks } = makeTable({ behavior: { run: { bytes: payload } } })
    const { id } = await tasks.start({ sessionId: 's-1', name: 'a', paths: sampleSelection() })
    const first = tasks.status(id, 's-1')
    expect(['building', 'ready']).toContain(first.state)
    expect(first).not.toHaveProperty('done')
    expect(first).not.toHaveProperty('total')
    expect(first).not.toHaveProperty('error')
    expect(Object.keys(first).sort()).toEqual(['bytes', 'state'])

    const settled = await settledStatus(tasks, id, 's-1')
    expect(settled.state).toBe('ready')
    // Bytes are the temp file's size: the archive really is on disk, which is
    // what the download streams from.
    expect(settled.bytes).toBe(payload.byteLength)
    expect(Object.keys(settled).sort()).toEqual(['bytes', 'state'])
  })

  it('keeps a task building while the child runs', async () => {
    const { tasks } = makeTable({ behavior: { run: { hang: true } } })
    const { id } = await tasks.start({ sessionId: 's-1', name: 'a', paths: sampleSelection() })
    expect(tasks.status(id, 's-1')).toMatchObject({ state: 'building', bytes: 0 })
    expect(tasks.lookup(id, 's-1')).toMatchObject({ ok: false, reason: 'building' })
  })

  it('settles a failed build as error and carries the tool\'s stderr', async () => {
    const { tasks, tempDir: archives } = makeTable({
      behavior: { run: { code: 2, stderr: 'zip error: nothing to do\n' } },
    })
    const { id } = await tasks.start({ sessionId: 's-1', name: 'a', paths: sampleSelection() })
    const settled = await settledStatus(tasks, id, 's-1')
    expect(settled.state).toBe('error')
    expect(settled.error).toMatch(/nothing to do/)
    expect(settled.bytes).toBe(0)
    expect(tasks.lookup(id, 's-1')).toMatchObject({ ok: false, reason: 'error' })
    // A failed build leaves nothing behind for a download to serve.
    await vi.waitFor(() => { expect(readdirSync(archives)).toEqual([]) })
  })

  it('rejects start with `unavailable` (501) when no tool exists', async () => {
    const { tasks, tempDir: archives, children } = makeTable({ spec: undefined })
    await expect(tasks.start({ sessionId: 's-1', name: 'a', paths: sampleSelection() }))
      .rejects.toMatchObject({ code: 'unavailable', status: 501 })
    // Nothing was planned, spawned or written.
    expect(tasks.size()).toBe(0)
    expect(children).toHaveLength(0)
    expect(readdirSync(archives)).toEqual([])
  })

  it('caps concurrent builds at ARCHIVE_MAX_BUILDING (409)', async () => {
    expect(ARCHIVE_MAX_BUILDING).toBe(4)
    const { tasks } = makeTable({ behavior: { run: { hang: true } } })
    const paths = sampleSelection()
    for (let index = 0; index < ARCHIVE_MAX_BUILDING; index += 1) {
      await tasks.start({ sessionId: 's-1', name: `a${index}`, paths })
    }
    await expect(tasks.start({ sessionId: 's-1', name: 'one-too-many', paths }))
      .rejects.toMatchObject({ code: 'bad-request', status: 409 })
    expect(tasks.size()).toBe(ARCHIVE_MAX_BUILDING)
  })

  it('expires a settled task after ARCHIVE_TTL_MS and deletes its file', async () => {
    const { tasks, tempDir: archives } = makeTable({ behavior: { run: { bytes: Buffer.from('x') } } })
    const { id } = await tasks.start({ sessionId: 's-1', name: 'a', paths: sampleSelection() })
    await settledStatus(tasks, id, 's-1')
    expect(tasks.size()).toBe(1)
    const file = join(archives, archiveTempName(id, '.zip'))
    expect(existsSync(file)).toBe(true)
    // A clock jump is the same code path as waiting five minutes for it.
    vi.setSystemTime(Date.now() + ARCHIVE_TTL_MS + 1)
    try {
      expect(() => tasks.status(id, 's-1')).toThrow(/unknown or expired/)
      expect(tasks.lookup(id, 's-1')).toMatchObject({ ok: false, reason: 'missing' })
      expect(tasks.size()).toBe(0)
      // An expired task reads as missing on the download route too: 404.
      expect((await download(tasks, 's-1', id)).status).toBe(404)
      await vi.waitFor(() => { expect(existsSync(file)).toBe(false) })
    } finally {
      vi.useRealTimers()
    }
  })

  it('consumes the task on download, deleting the temp file after the stream', async () => {
    const payload = Buffer.from('PK\u0003\u0004 archive')
    const { tasks, tempDir: archives } = makeTable({ behavior: { run: { bytes: payload } } })
    const { id } = await tasks.start({ sessionId: 's-1', name: 'docs', paths: sampleSelection() })
    await settledStatus(tasks, id, 's-1')
    const file = join(archives, archiveTempName(id, '.zip'))
    expect(existsSync(file)).toBe(true)

    const first = await download(tasks, 's-1', id)
    expect(first.status).toBe(200)
    expect(first.headers['content-type']).toBe('application/zip')
    expect(first.headers['content-disposition']).toBe(`attachment; filename="docs.zip"; filename*=UTF-8''docs.zip`)
    expect(first.headers['content-length']).toBe(String(payload.byteLength))
    expect(Buffer.concat(first.chunks).equals(payload)).toBe(true)
    // The bytes are gone from disk once served — the task table is a queue,
    // not a store (the unlink is async, hence the wait).
    await vi.waitFor(() => { expect(existsSync(file)).toBe(false) })
    expect(readdirSync(archives)).toEqual([])

    const second = await download(tasks, 's-1', id)
    expect(second.status).toBe(404)
    expect(second.envelope.error?.code).toBe('not-found')
    expect(() => tasks.status(id, 's-1')).toThrow(/unknown or expired/)
  })

  it('releases the task only after the stream settles', async () => {
    const payload = Buffer.from('PK\u0003\u0004 slow reader')
    const { tasks, tempDir: archives } = makeTable({ behavior: { run: { bytes: payload } } })
    const { id } = await tasks.start({ sessionId: 's-1', name: 'slow', paths: sampleSelection() })
    await settledStatus(tasks, id, 's-1')
    const file = join(archives, archiveTempName(id, '.zip'))

    // A response that accepts the first chunk and then stalls: releasing the
    // task before the stream settles would unlink the file underneath it.
    let resume = (): void => {}
    const gate = new Promise<void>((resolve) => { resume = resolve })
    const chunks: Buffer[] = []
    const stalled = Object.assign(new Writable({
      write(chunk: Buffer | string, _encoding, done) {
        chunks.push(Buffer.from(chunk))
        void gate.then(() => { done() })
      },
    }), { writeHead: () => {} })
    const pending = respondArchiveDownload(tasks, { sessionId: 's-1', id }, stalled as unknown as SidebarHttpResponse)
    await vi.waitFor(() => { expect(chunks.length).toBeGreaterThan(0) })
    expect(existsSync(file)).toBe(true)
    expect(tasks.lookup(id, 's-1')).toMatchObject({ ok: true })

    resume()
    await pending
    await vi.waitFor(() => { expect(existsSync(file)).toBe(false) })
    expect(tasks.lookup(id, 's-1')).toMatchObject({ ok: false, reason: 'missing' })
  })

  it('dispose() kills a running build and deletes every temp file', async () => {
    const ready = makeTable({ behavior: { run: { bytes: Buffer.from('PK\u0003\u0004 done') } } })
    const running = makeTable({ behavior: { run: { hang: true } } })
    const paths = sampleSelection()
    const finished = await ready.tasks.start({ sessionId: 's-1', name: 'done', paths })
    await settledStatus(ready.tasks, finished.id, 's-1')
    const started = await running.tasks.start({ sessionId: 's-1', name: 'running', paths })
    const finishedFile = join(ready.tempDir, archiveTempName(finished.id, '.zip'))
    const runningFile = join(running.tempDir, archiveTempName(started.id, '.zip'))
    expect(existsSync(finishedFile)).toBe(true)
    // With resolveTool injected there is no probe: the only child is the build
    // (the temp file appears when it is OPENED, so the spawn is awaited).
    await vi.waitFor(() => { expect(running.children).toHaveLength(1) })
    await vi.waitFor(() => { expect(existsSync(runningFile)).toBe(true) })

    running.tasks.dispose()
    ready.tasks.dispose()
    expect(running.children[0]!.kill).toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(existsSync(runningFile)).toBe(false)
      expect(existsSync(finishedFile)).toBe(false)
    })
    expect(running.tasks.size()).toBe(0)
    expect(ready.tasks.size()).toBe(0)
  })
})

describe('respondArchiveDownload branches', () => {
  it('answers 400 when either parameter is missing', async () => {
    const { tasks } = makeTable()
    expect((await download(tasks, null, 'ar-1')).status).toBe(400)
    expect((await download(tasks, 's-1', null)).status).toBe(400)
    const empty = await download(tasks, 's-1', '')
    expect(empty.status).toBe(400)
    expect(empty.envelope.error?.code).toBe('bad-request')
  })

  it('answers 403 for another session\'s task (and does not consume it)', async () => {
    const { tasks } = makeTable({ behavior: { run: { bytes: Buffer.from('x') } } })
    const { id } = await tasks.start({ sessionId: 's-1', name: 'a', paths: sampleSelection() })
    await settledStatus(tasks, id, 's-1')
    const foreign = await download(tasks, 's-other', id)
    expect(foreign.status).toBe(403)
    expect(foreign.envelope.error?.code).toBe('forbidden')
    // The failed read left the task alone: its owner can still fetch it.
    expect((await download(tasks, 's-1', id)).status).toBe(200)
  })

  it('answers 409 while the build is still running', async () => {
    const { tasks } = makeTable({ behavior: { run: { hang: true } } })
    const { id } = await tasks.start({ sessionId: 's-1', name: 'a', paths: sampleSelection() })
    const answer = await download(tasks, 's-1', id)
    expect(answer.status).toBe(409)
    expect(answer.envelope.error?.message).toMatch(/still being built/)
  })

  it('answers 410 with the tool\'s message for a failed build', async () => {
    const { tasks } = makeTable({ behavior: { run: { code: 2, stderr: 'zip error: nothing to do\n' } } })
    const { id } = await tasks.start({ sessionId: 's-1', name: 'a', paths: sampleSelection() })
    await settledStatus(tasks, id, 's-1')
    const answer = await download(tasks, 's-1', id)
    expect(answer.status).toBe(410)
    expect(answer.envelope.error?.code).toBe('fs-error')
    expect(answer.envelope.error?.message).toMatch(/nothing to do/)
  })

  it('answers 404 for an unknown id', async () => {
    const { tasks } = makeTable()
    const answer = await download(tasks, 's-1', 'ar-nope')
    expect(answer.status).toBe(404)
    expect(answer.envelope.error?.code).toBe('not-found')
    expect(answer.envelope.error?.message).toMatch(/unknown or expired/)
  })

  it('serves a tar host as a real .tar.gz with application/gzip', async () => {
    const payload = Buffer.from('\u001F\u008B gzip bytes')
    const { tasks } = makeTable({ spec: TAR_SPEC, behavior: { run: { bytes: payload } } })
    const { id, name } = await tasks.start({ sessionId: 's-1', name: 'docs.zip', paths: sampleSelection() })
    expect(name).toBe('docs.tar.gz')
    await settledStatus(tasks, id, 's-1')
    const answer = await download(tasks, 's-1', id)
    expect(answer.status).toBe(200)
    // The extension follows the TOOL: never a `.zip` header over gzip bytes.
    expect(answer.headers['content-type']).toBe('application/gzip')
    expect(answer.headers['content-disposition'])
      .toBe(`attachment; filename="docs.tar.gz"; filename*=UTF-8''docs.tar.gz`)
    expect(Buffer.concat(answer.chunks).equals(payload)).toBe(true)
  })
})

describe('archive.build / archive.status through the mounted host', () => {
  it('builds, polls and downloads through the real routes (faked tool)', async () => {
    const { api, download: route } = mountHost()
    const ws = workspace('flow')
    writeFileSync(join(ws, 'a.txt'), 'a\n')
    writeFileSync(join(ws, 'b.txt'), 'b\n')

    const build = await post(api, 'archive.build', {
      sessionId: 's-flow',
      cwd: ws,
      name: 'bundle',
      paths: [join(ws, 'a.txt'), join(ws, 'b.txt')],
    })
    expect(build.status).toBe(200)
    expect(build.envelope.ok).toBe(true)
    const value = build.envelope.value as { id: string; name: string; entries: number }
    expect(value.id).toMatch(/^ar-/)
    // The tool's extension, applied by the host — the client sends a stem.
    expect(value.name).toBe('bundle.zip')
    // `entries` counts SELECTIONS: the walk is the tool's now.
    expect(value.entries).toBe(2)

    const polled = await post(api, 'archive.status', { id: value.id, sessionId: 's-flow' })
    expect(polled.envelope.ok).toBe(true)
    const status = polled.envelope.value as Record<string, unknown>
    expect(['building', 'ready']).toContain(status.state)
    expect(status).not.toHaveProperty('done')
    expect(status).not.toHaveProperty('total')
    expect(status.bytes).toBeGreaterThanOrEqual(0)

    const settled = await waitForSettled(api, value.id, 's-flow')
    expect(settled.state).toBe('ready')
    expect(settled.bytes).toBe(Buffer.byteLength(tool.payload))

    const url = `/sidebar/archive?sessionId=s-flow&id=${encodeURIComponent(value.id)}`
    const served = await request(route, 'GET', url)
    expect(served.status).toBe(200)
    expect(Buffer.concat(served.chunks).toString('utf8')).toBe(tool.payload)
    expect(served.headers['content-length']).toBe(String(Buffer.byteLength(tool.payload)))
    // The download consumed the task and its temp file (see the TMPDIR stub).
    await vi.waitFor(() => { expect(readdirSync(tempDir)).toEqual([]) })
    expect((await request(route, 'GET', url)).status).toBe(404)
  })

  it('refuses an empty path list before ever touching the tool (400)', async () => {
    const { api } = mountHost()
    const ws = workspace('empty')
    const build = await post(api, 'archive.build', { sessionId: 's-empty', cwd: ws, paths: [] })
    expect(build.status).toBe(400)
    expect(build.envelope.error?.code).toBe('bad-request')
    expect(tool.runs).toBe(0)
  })

  it('surfaces a missing tool as `unavailable` with status 501', async () => {
    const { api } = mountHost()
    const ws = workspace('missing')
    writeFileSync(join(ws, 'a.txt'), 'a')
    tool.mode = 'missing'
    const build = await post(api, 'archive.build', { sessionId: 's-missing', cwd: ws, paths: [join(ws, 'a.txt')] })
    expect(build.status).toBe(501)
    expect(build.envelope.error?.code).toBe('unavailable')
    expect(tool.runs).toBe(0)
  })

  it('surfaces a non-zero tool exit as an error status, before any download', async () => {
    const { api, download: route } = mountHost()
    const ws = workspace('failed')
    writeFileSync(join(ws, 'a.txt'), 'a')
    tool.mode = 'fail'
    const build = await post(api, 'archive.build', {
      sessionId: 's-fail',
      cwd: ws,
      name: 'bad',
      paths: [join(ws, 'a.txt')],
    })
    // The id is handed out immediately — the tool's failure arrives later.
    expect(build.status).toBe(200)
    const id = (build.envelope.value as { id: string }).id
    const settled = await waitForSettled(api, id, 's-fail')
    expect(settled.state).toBe('error')
    expect(settled.error).toMatch(/nothing to do/)
    // That ordering is the whole reason the bytes go to a temp file first: a
    // failed build is a 410 envelope, never a 200 carrying half an archive.
    const refused = await request(route, 'GET', `/sidebar/archive?sessionId=s-fail&id=${id}`)
    expect(refused.status).toBe(410)
    expect(refused.envelope.error?.message).toMatch(/nothing to do/)
    await vi.waitFor(() => { expect(readdirSync(tempDir)).toEqual([]) })
  })

  it('requires both status keys and fences the task by session', async () => {
    const { api } = mountHost()
    const ws = workspace('fence')
    writeFileSync(join(ws, 'a.txt'), 'a')
    const noKey = await post(api, 'archive.status', { id: 'ar-1' })
    expect(noKey.status).toBe(400)
    expect(noKey.envelope.error?.code).toBe('bad-request')

    const build = await post(api, 'archive.build', {
      sessionId: 's-own',
      cwd: ws,
      paths: [join(ws, 'a.txt')],
    })
    const id = (build.envelope.value as { id: string }).id
    const foreign = await post(api, 'archive.status', { id, sessionId: 's-other' })
    expect(foreign.status).toBe(403)
    expect(foreign.envelope.error?.code).toBe('forbidden')
    // The foreign read did not destroy the build: its owner still gets it.
    const own = await waitForSettled(api, id, 's-own')
    expect(own.state).toBe('ready')
  })

  it('caps concurrent builds through the API with 409', async () => {
    const { api } = mountHost()
    const ws = workspace('cap')
    writeFileSync(join(ws, 'a.txt'), 'a')
    tool.mode = 'hang'
    for (let index = 0; index < ARCHIVE_MAX_BUILDING; index += 1) {
      const accepted = await post(api, 'archive.build', {
        sessionId: 's-cap',
        cwd: ws,
        name: `a${index}`,
        paths: [join(ws, 'a.txt')],
      })
      expect(accepted.status).toBe(200)
    }
    const refused = await post(api, 'archive.build', {
      sessionId: 's-cap',
      cwd: ws,
      name: 'one-too-many',
      paths: [join(ws, 'a.txt')],
    })
    expect(refused.status).toBe(409)
    expect(refused.envelope.error?.message).toMatch(/too many archives/)
  })

  it('accepts a selection outside the session cwd (no fence)', async () => {
    const { api } = mountHost()
    const ws = workspace('ws')
    const outside = join(scratch, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    // ⚠️ PERMISSION CHANGE: an absolute path outside the workspace is a normal
    // selection — the old 403 branch is gone, and the tool runs from the
    // selection's own parent.
    const build = await post(api, 'archive.build', {
      sessionId: 's-outside',
      cwd: ws,
      name: 'secret',
      paths: [join(outside, 'secret.txt')],
    })
    expect(build.status).toBe(200)
    expect(build.envelope.value).toMatchObject({ name: 'secret.zip', entries: 1 })
  })

  it('refuses a non-GET download and a download without parameters', async () => {
    const { download: route } = mountHost()
    expect((await request(route, 'POST', '/sidebar/archive?id=x')).status).toBe(405)
    const noParams = await request(route, 'GET', '/sidebar/archive')
    expect(noParams.status).toBe(400)
    expect(noParams.envelope.error?.code).toBe('bad-request')
  })

  it('serves a non-latin1 download name through REAL node:http (no 500, RFC 5987)', async () => {
    const { api, download: route } = mountHost()
    const ws = workspace('http')
    writeFileSync(join(ws, '数据.txt'), 'x\n')
    const { createServer } = await import('node:http')
    const server = createServer((req, res) => { void route.handler(req as never, res as never) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('test setup: no server port')
      const build = await post(api, 'archive.build', {
        sessionId: 's-http',
        cwd: ws,
        name: '报告',
        paths: [join(ws, '数据.txt')],
      })
      const id = (build.envelope.value as { id: string }).id
      await waitForSettled(api, id, 's-http')
      // The route handler answers a REAL ServerResponse here and the bytes go
      // through the file streaming path. node:http's writeHead validates
      // header values, which the plain-object stubs cannot do — exactly how
      // the Chinese-name 500 hid.
      const url = `http://127.0.0.1:${address.port}/sidebar/archive?sessionId=s-http&id=${encodeURIComponent(id)}`
      const response = await fetch(url)
      expect(response.status).toBe(200)
      const disposition = response.headers.get('content-disposition') ?? ''
      // The ASCII half is what old clients read; the RFC 5987 half carries the
      // real name and is what every current browser picks.
      expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent('报告.zip')}`)
      expect(disposition).toContain('filename="download.zip"')
      expect([...disposition].every(char => char.codePointAt(0)! <= 0xFF)).toBe(true)
      expect(Buffer.from(await response.arrayBuffer()).toString('utf8')).toBe(tool.payload)
      // Released only once the stream settled: the file is gone, the task too.
      await vi.waitFor(() => { expect(readdirSync(tempDir)).toEqual([]) })
      expect((await fetch(url)).status).toBe(404)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('builds the download URL the client anchors on', () => {
    expect(archiveDownloadUrl({ sessionId: 's-1' }, 'ar-9'))
      .toBe('http://localhost/sidebar/archive?sessionId=s-1&id=ar-9')
  })
})
