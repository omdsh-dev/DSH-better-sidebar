/**
 * Optional native search engines (fd / ripgrep) for the editor's file-name
 * search (fs.search). The probe runs lazily once per process: each candidate
 * binary is verified with `--version` under a 500ms budget so a dead path is
 * never used. Engine stdout streams are always capped (fd's --max-results
 * included; rg is capped by killing the child) and every invocation honors
 * the caller's AbortSignal.
 *
 * Engine output is normalized to the plain-JS walk contract: root-relative,
 * '/'-separated path lines (encoded as a name-substring, case-insensitive
 * match — fd is pinned to literal semantics with --fixed-strings, rg globs
 * are escaped and forced case-insensitive). Directory entries are kept
 * where the engine can report them (fd); rg --files only reports files,
 * which is a documented lossy difference.
 *
 * A runtime failure disables that engine for the rest of the process (a
 * broken binary should not slow every later search); the caller falls back
 * to the plain walk. Hooks are swappable for tests (setEngineHooks).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { basename, dirname, join, sep } from 'node:path'
import { homedir } from 'node:os'
import { debugLog } from './search-debug.ts'

export type Engine = 'fd' | 'rg'

/** A probed, verified engine binary. */
export interface EngineProbe {
  engine: Engine
  binary: string
}

/** The engine output contract: root-relative, '/'-separated, UNSORTED. */
export interface EngineResult {
  paths: string[]
  /** true when the match cap cut the stream short. */
  truncated: boolean
}

const PROBE_TIMEOUT_MS = 500
const ENGINE_TIMEOUT_MS = 15_000

const PATH_SEPARATOR = process.platform === 'win32' ? ';' : ':'

/** Candidate binaries for one engine: PATH entries then fixed well-known
 *  locations. A PATH that misses Homebrew (seen in launchd-spawned
 *  processes) is covered by the fixed paths; rg additionally probes the
 *  ripgrep binary DeepSeek Harness itself ships (the @vscode/ripgrep
 *  optional platform package under the DSH CLI's global install — the
 *  harness's own agent search tool already runs on it). */
function candidates(engine: Engine): string[] {
  const env = process.env
  const pathNames: Record<Engine, readonly string[]> = {
    fd: ['fd', 'fdfind'],
    rg: ['rg'],
  }
  const out: string[] = []
  // DSH's bundled rg — the CLI's own dependency tree holds the platform
  // package (@vscode/ripgrep-<platform>-<arch>), resolved from the node
  // binary's global prefix like npm lays it out. The harness's agent-side
  // search tool already uses this binary — the sidebar search should too,
  // so it wins over any system rg.
  if (engine === 'rg') {
    const prefix = dirname(dirname(process.execPath))
    const dshGlobal = join(prefix, 'lib/node_modules/@deepseek-ai/dsh/node_modules')
    out.push(join(dshGlobal, `@vscode/ripgrep-${process.platform}-${process.arch}/bin/${process.platform === 'win32' ? 'rg.exe' : 'rg'}`))
  }
  for (const name of pathNames[engine]) {
    if (env.PATH !== undefined && env.PATH !== '') {
      for (const dir of env.PATH.split(PATH_SEPARATOR)) {
        if (dir !== '') out.push(join(dir, name))
      }
    }
  }
  if (engine === 'fd') {
    out.push('/opt/homebrew/bin/fd', '/usr/local/bin/fd', '/usr/bin/fd', join(homedir(), '.cargo/bin/fd'))
  } else if (engine === 'rg') {
    out.push('/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg')
  }
  return out
}

/** Verify one binary actually runs (a broken install must not be used). */
function verify(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    let child: ChildProcess
    try {
      child = spawn(binary, ['--version'], { stdio: 'ignore' })
    } catch {
      finish(false)
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(false)
    }, PROBE_TIMEOUT_MS)
    child.once('error', () => { finish(false) })
    child.once('exit', (code) => { finish(code === 0) })
  })
}

/** Escape glob metacharacters so a query matches literally inside -g. */
export function escapeGlob(query: string): string {
  return query.replace(/[\[\]*?\\]/g, '\\$&')
}

/** Stream a child's stdout line-by-line, capped at `max` lines (the child is
 *  killed past the cap so a huge result set never buffers into memory). */
function streamLines(
  child: ChildProcess,
  max: number,
  signal: AbortSignal | undefined,
): Promise<{ lines: string[]; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const lines: string[] = []
    let truncated = false
    let closed = false
    const finish = (error: unknown): void => {
      if (closed) return
      closed = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error !== undefined) {
        child.kill()
        reject(error)
      } else {
        resolve({ lines, truncated })
      }
    }
    const onAbort = (): void => { finish(new Error('search aborted')) }
    // A signal that already fired never dispatches again — check upfront.
    if (signal?.aborted) {
      finish(new Error('search aborted'))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => { finish(new Error('search engine timed out')) }, ENGINE_TIMEOUT_MS)
    child.once('error', (error) => { finish(error) })
    child.once('exit', (code) => {
      if (truncated) {
        finish(undefined)
      } else if (code !== 0 && code !== 1) {
        // rg exits 1 when nothing matched — that is a successful empty run,
        // not an error (fd exits 0 either way).
        finish(new Error(`search engine exited with ${String(code)}`))
      } else {
        finish(undefined)
      }
    })
    const stdout = child.stdout
    if (stdout === null) {
      finish(new Error('search engine stdout unavailable'))
      return
    }
    const rl = createInterface({ input: stdout })
    rl.on('line', (line) => {
      if (line === '' || truncated) return
      lines.push(line)
      if (lines.length > max) {
        truncated = true
        child.kill()
      }
    })
  })
}

/** Normalize one engine's stdout lines to the walk contract: root-relative,
 *  '/'-separated, no leading './'. fd/rg emit relative paths with the
 *  PLATFORM separator; the walk contract is '/'-separated on every platform.
 *  `separator` defaults to the platform separator — pass '\\' to model
 *  Windows engine output (rg on Windows emits '\' paths and '.\' prefixes;
 *  Windows file names can never contain '\' or '/', so the substitution is
 *  lossless there). A trailing '\r' is also stripped: Windows engines emit
 *  CRLF line endings, and while readline usually swallows the CR, a leftover
 *  one must never leak into a path (safe on every platform — a POSIX file
 *  whose name ends in CR is pathological). */
export function normalizeEnginePaths(lines: readonly string[], separator: string = sep): string[] {
  const out: string[] = []
  for (const line of lines) {
    if (line === '') continue
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
    if (trimmed === '') continue
    // A leading '.\' becomes './' after the separator substitution below;
    // the './' prefix strip then covers both POSIX and Windows output.
    const normalized = trimmed.split(separator).join('/')
    const clean = normalized.startsWith('./') ? normalized.slice(2) : normalized
    if (clean !== '' && clean !== '.') out.push(clean)
  }
  return out
}

/** One child invocation per engine, emitting normalized relative paths.
 *  rg's -g globs match the WHOLE path, while the walk contract matches
 *  entry NAMES only — the extra path-level hits are filtered back out here
 *  (a basename hit always implies a path hit under the same glob, so the
 *  glob can never drop a legitimate match). */
function runChild(
  probe: EngineProbe,
  root: string,
  query: string,
  maxMatches: number,
  signal: AbortSignal | undefined,
): Promise<EngineResult> {
  const cap = maxMatches + 1
  let child: ChildProcess
  if (probe.engine === 'fd') {
    child = spawn(probe.binary, [
      '--hidden', '--no-ignore', '--exclude', '.git', '--fixed-strings', '--ignore-case',
      '--path-separator', '/', '--max-results', String(cap), query, '.',
    ], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
  } else {
    // --iglob: case-insensitive glob (rg's globset has no (?i) inline flag).
    child = spawn(probe.binary, [
      '--files', '--hidden', '--no-ignore', '--glob', '!**/.git/**', '--iglob', `*${escapeGlob(query)}*`, '.',
    ], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
  }
  return streamLines(child, cap, signal).then(({ lines, truncated }) => {
    let paths = normalizeEnginePaths(lines)
    if (probe.engine === 'rg') {
      // rg reports files only, and its glob already guarantees the path
      // contains the query; the walk matches entry names, so drop hits
      // whose basename does not contain it.
      const needle = query.toLowerCase()
      paths = paths.filter(path => basename(path).toLowerCase().includes(needle))
    }
    return { paths, truncated }
  })
}

let prober = (): Promise<readonly EngineProbe[]> => probeOnce()
let runner = runChild
/** Engines failed at runtime: skipped for the rest of this process. */
const broken = new Set<Engine>()
let probePromise: Promise<readonly EngineProbe[]> | null = null

/** Probe once per process (lazy): each engine's first working candidate. */
async function probeOnce(): Promise<readonly EngineProbe[]> {
  const found: EngineProbe[] = []
  for (const engine of ['fd', 'rg'] as const) {
    for (const binary of candidates(engine)) {
      if (await verify(binary)) {
        found.push({ engine, binary })
        break
      }
    }
  }
  const names = found.length > 0 ? found.map(p => `${p.engine}(${p.binary})`).join(', ') : 'none (plain-walk fallback)'
  debugLog(`[dsh-search] engines probed: ${names}`)
  return found
}

/** The verified engines for this process (cached across searches). */
export function probeEngines(): Promise<readonly EngineProbe[]> {
  probePromise ??= prober()
  return probePromise
}

/** Run one engine and get capped, normalized matches; a runtime failure
 *  disables that engine for the rest of the process (a broken binary must
 *  not slow every later search). An aborted signal rethrows untouched so
 *  the caller skips the fallback walk too. */
export async function runEngine(
  probe: EngineProbe,
  root: string,
  query: string,
  maxMatches: number,
  signal: AbortSignal | undefined,
): Promise<EngineResult> {
  let result: EngineResult
  try {
    result = await runner(probe, root, query, maxMatches, signal)
  } catch (error) {
    if (!signal?.aborted) {
      broken.add(probe.engine)
      debugLog(`[dsh-search] engine ${probe.engine} failed at runtime, disabled: ${error instanceof Error ? error.message : String(error)}`)
    }
    throw error
  }
  return result
}

/** The engines a caller may actually try (verified, not broken). */
export async function usableEngines(): Promise<readonly EngineProbe[]> {
  const probes = await probeEngines()
  return probes.filter((probe) => !broken.has(probe.engine))
}

/** Test seam: replace the probe / child-runner implementations. */
export function setEngineHooks(next: { prober?: typeof prober; runner?: typeof runner }): void {
  if (next.prober !== undefined) prober = next.prober
  if (next.runner !== undefined) runner = next.runner
}

/** Reset probe cache, broken-set and hooks (test isolation). */
export function resetEngines(): void {
  probePromise = null
  broken.clear()
  prober = (): Promise<readonly EngineProbe[]> => probeOnce()
  runner = runChild
}