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
import { dirname, join, sep } from 'node:path'
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

/**
 * Where the DSH CLI's own dependency tree may live, as `@vscode/ripgrep`
 * platform-package candidates (@vscode/ripgrep-<platform>-<arch>/bin/rg).
 * npm global installs on POSIX lay out as <prefix>/lib/node_modules/
 * (execPath's node lives directly under <prefix>/bin); the Windows npm
 * global prefix has NO lib/ layer — packages land in %APPDATA%\npm\node_modules
 * instead (nvm-windows keeps the same %APPDATA%\npm global). The
 * launchd-spawned profile layout under ~/.dsh/profiles is covered last.
 * Wrong guesses are cheap: every candidate goes through verify()
 * (--version under a 500ms budget) and unusable ones are dropped.
 */
export function bundledRgCandidates(
  platform: NodeJS.Platform,
  arch: string,
  execPath: string,
  env: NodeJS.ProcessEnv,
  home: string,
): string[] {
  const binName = platform === 'win32' ? 'rg.exe' : 'rg'
  const pkg = `@vscode/ripgrep-${platform}-${arch}`
  const roots: string[] = []
  const dshDepRoot = (globalModules: string) =>
    join(globalModules, '@deepseek-ai/dsh/node_modules')
  if (platform === 'win32') {
    // Windows npm global: %APPDATA%\npm\node_modules (no lib/ layer).
    if (env.APPDATA !== undefined && env.APPDATA !== '') {
      roots.push(dshDepRoot(join(env.APPDATA, 'npm', 'node_modules')))
    }
    // Portable / per-user node installs next to the executable.
    roots.push(dshDepRoot(join(dirname(execPath), 'node_modules')))
  } else {
    // POSIX npm global: <prefix>/lib/node_modules — execPath's node is
    // <prefix>/bin/node, so the prefix is two dirnames up.
    roots.push(dshDepRoot(join(dirname(dirname(execPath)), 'lib', 'node_modules')))
    // Homebrew and pnpm global layouts missed by the execPath derivation.
    roots.push(dshDepRoot('/opt/homebrew/lib/node_modules'), dshDepRoot('/usr/local/lib/node_modules'))
    roots.push(dshDepRoot(join(home, '.local', 'share', 'pnpm')))
  }
  // The launchd-style profile layout (no user PATH, dsh deps under ~/.dsh).
  roots.push(dshDepRoot(join(home, '.dsh', 'profiles', 'node_modules')))
  const seen = new Set<string>()
  const out: string[] = []
  for (const root of roots) {
    const candidate = join(root, pkg, 'bin', binName)
    if (!seen.has(candidate)) {
      seen.add(candidate)
      out.push(candidate)
    }
  }
  return out
}

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
  // package (@vscode/ripgrep-<platform>-<arch>). The harness's agent-side
  // search tool already uses this binary — the sidebar search should too,
  // so it wins over any system rg.
  if (engine === 'rg') {
    out.push(...bundledRgCandidates(process.platform, process.arch, process.execPath, env, homedir()))
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

/** Escape glob metacharacters so a query matches literally inside -g.
 *  Braces are metacharacters too ({a,b} alternation): an unbalanced '{'
 *  makes rg fail to parse the glob (exit 2 → the engine looks broken), and
 *  a balanced one silently matches a DIFFERENT literal ('a{b}' searches
 *  'ab'). Verified against rg 15: '\{' is a valid brace escape. */
export function escapeGlob(query: string): string {
  // The output is a GLOB string, not a regex: rg globs are gitignore-style,
  // so '[' opens a character class and MUST be escaped there even though
  // escaping it is unnecessary inside this regex's own character class.
  // eslint-disable-next-line no-useless-escape
  return query.replace(/[\[\]{}*?\\]/g, '\\$&')
}

/** Directory names that are never useful filename-search results (VCS
 *  internals, dependency forests, package-manager stores, build caches).
 *  The plain walk in fs-search.ts builds its case-insensitive skip set
 *  from this list, and BOTH engine argvs exclude every name — with
 *  --no-ignore active an rg/fd run would otherwise re-enter node_modules
 *  and regress the budget-saving behavior of the walk. Excludes are
 *  matched case-insensitively (fd honors --ignore-case; rg uses --iglob),
 *  mirroring the walk's toLowerCase comparison. */
export const SKIP_DIR_NAMES: readonly string[] = [
  '.git',
  'node_modules',
  '.pnpm-store',
  '.yarn',
  '.turbo',
  '.turbopack',
  '.next',
  '.nuxt',
  '.output',
  '.cache',
  '.parcel-cache',
  'coverage',
  'dist',
  'build',
  'out',
  '.umi',
  '.umi-production',
  '.dumi',
]

/** A timeout means the tree is too big, not that the binary is broken —
 *  it must not disable the engine for every other search root. */
export class EngineTimeoutError extends Error {}

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
    const timer = setTimeout(() => { finish(new EngineTimeoutError('search engine timed out')) }, ENGINE_TIMEOUT_MS)
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

/** The fd argv: the query as a literal substring, '/' separators, every
 *  SKIP_DIR_NAMES excluded (a bare name excludes the entry at any depth;
 *  a worktree-style `.git` FILE is covered too — verified against real
 *  fd), and --max-results one ABOVE the stream sentinel (cap + 1) so a
 *  full result set overflows into the same truncation detected for rg
 *  (see runChild). */
export function fdArgv(cap: number, query: string): string[] {
  return [
    '--hidden', '--no-ignore',
    ...SKIP_DIR_NAMES.flatMap(name => ['--exclude', name]),
    '--fixed-strings', '--ignore-case',
    '--path-separator', '/', '--max-results', String(cap + 1), query, '.',
  ]
}

/** The rg argv: --files listing filtered by a case-insensitive literal-name
 *  glob, '/' separators pinned (rg emits '\' in cmd/PowerShell on Windows,
 *  '/' in Git Bash — rg#501; the flag exists since rg 0.8, a build without
 *  it fails at spawn and is disabled at runtime). Every SKIP_DIR_NAME gets
 *  a glob pair: a '<name>-anywhere' glob prunes the directory tree, and the second
 *  entry-only glob excludes an entry NAMED the skip word itself — a git
 *  worktree has a `.git` FILE (not a directory) at its root, and the
 *  directory-exclusion glob requires a path segment AFTER the word so it
 *  does not cover the pointer file (verified against real rg). fd's
 *  --exclude and the plain walk both skip it without the extra glob. */
export function rgArgv(query: string): string[] {
  const skipGlobs = SKIP_DIR_NAMES.flatMap(name => [
    '--iglob', `!**/${name}/**`,
    '--iglob', `!**/${name}`,
  ])
  const escaped = escapeGlob(query)
  return [
    '--files', '--hidden', '--no-ignore',
    ...skipGlobs,
    // Two query globs: the slash-free form matches BASENAMES only (rg
    // follows gitignore semantics — no '/' in the pattern means basename
    // match, verified on real rg 15: 'util/helper.ts' never matches
    // '*util*'), so a second path-level glob admits files UNDER a
    // matching directory — deriveRgMatches turns those into the
    // directory matches the walk/fd contract reports.
    '--iglob', `*${escaped}*`,
    '--iglob', `**/*${escaped}*/**`,
    '--path-separator', '/', '.',
  ]
}

/** One child invocation per engine, emitting normalized relative paths.
 *  rg's query globs admit basename hits AND files under matching
 *  directories; deriveRgMatches converts the latter into the directory
 *  matches the walk contract reports and drops nothing else.
 *
 *  Truncation symmetry: `streamLines` marks truncated when the stream
 *  exceeds `cap = maxMatches + 1` lines (the +1 is a sentinel proving
 *  "there is more"). rg has no --max-results so it naturally overflows
 *  into the sentinel; fd MUST NOT cap at `cap` (it would stop exactly at
 *  the sentinel and never be seen as truncated) — pin its --max-results
 *  one higher (maxMatches + 2) so a full result set trips the same
 *  sentinel and both engines report truncated identically, with the
 *  caller slicing back to maxMatches. */
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
    child = spawn(probe.binary, fdArgv(cap, query), { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
  } else {
    child = spawn(probe.binary, rgArgv(query), { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
  }
  return streamLines(child, cap, signal).then(({ lines, truncated }) => {
    const paths = normalizeEnginePaths(lines)
    if (probe.engine !== 'rg') return { paths, truncated }
    const derived = deriveRgMatches(paths, query, maxMatches)
    return { paths: derived.paths, truncated: truncated || derived.truncated }
  })
}

/** rg reports FILES only (`rg --files` never emits a directory line), while
 *  the walk contract matches entry names — files AND directories. Every rg
 *  line is a file path whose glob already guarantees the query appears
 *  somewhere in it, so: a basename hit stays a file match, and a matching
 *  DIRECTORY segment is derived as a directory match (a directory named X
 *  holding at least one file surfaces exactly as fd/walk report it).
 *  EMPTY directories stay invisible to rg — no file path carries them —
 *  the one irreducible gap versus fd (documented lossy, see the design
 *  doc). Output is deduped and sorted; when the derived set exceeds the
 *  match budget it is capped at maxMatches + 1 and truncated is raised —
 *  the budget, not the engine, cut the result short (the caller slices
 *  back to maxMatches on truncated, same as the fd/rg stream sentinel). */
export function deriveRgMatches(
  paths: readonly string[],
  query: string,
  maxMatches: number,
): { paths: string[]; truncated: boolean } {
  const needle = query.toLowerCase()
  const out = new Set<string>()
  for (const path of paths) {
    const segments = path.split('/')
    const base = segments[segments.length - 1]
    if (base !== undefined && base.toLowerCase().includes(needle)) out.add(path)
    let prefix = ''
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]
      if (segment === undefined) continue
      prefix = prefix === '' ? segment : `${prefix}/${segment}`
      if (segment.toLowerCase().includes(needle)) out.add(prefix)
    }
  }
  const derived = [...out].sort()
  return { paths: derived.slice(0, maxMatches + 1), truncated: derived.length > maxMatches }
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
 *  not slow every later search) — but a TIMEOUT does not: a timeout means
 *  THIS tree was too big, while the broken-set is per-engine, so disabling
 *  here would strip every other (small) root of the engine over one huge
 *  directory. An aborted signal rethrows untouched so the caller skips the
 *  fallback walk too. */
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
    if (error instanceof EngineTimeoutError && !signal?.aborted) {
      debugLog(`[dsh-search] engine ${probe.engine} timed out (tree too large), falling back`)
    } else if (!signal?.aborted) {
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