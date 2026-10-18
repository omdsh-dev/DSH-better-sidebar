/**
 * Optional native search engines (fd / ripgrep) behind the editor's file-name
 * search (fs.search). The probe runs lazily once per process: each candidate
 * binary is verified with `--version` under a 500ms budget so a dead path is
 * never used. Engine stdout streams are always capped (fd's --max-results
 * included; rg is capped by killing the child).
 *
 * Engine output is normalized to the walk contract (see fs-search.ts):
 * root-relative, '/'-separated paths, case-insensitive NAME matching, sorted
 * by the caller, plus the directory/file split the client needs. fd reports
 * directories natively (`--type d`); rg --files reports files only, so
 * `deriveRgMatches` turns a matching path segment into the directory hit the
 * walk would have reported — the one real gap left is an EMPTY directory
 * whose name matches (no file path carries it, so rg cannot see it; fd and
 * the walk both report it).
 *
 * A runtime failure disables that engine for the rest of the process (a
 * broken binary must not slow every later search); the caller falls back to
 * the plain walk. A timeout is NOT a failure: it means this tree was too
 * large, so it must not strip every other root of the engine. Hooks are
 * swappable for tests (setEngineHooks).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join, posix, sep, win32 } from 'node:path'
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
  /** Every matching entry (files and directories). */
  paths: string[]
  /** The subset of `paths` that are directories. */
  dirs: string[]
  /** true when the match cap cut the stream short. */
  truncated: boolean
}

const PROBE_TIMEOUT_MS = 500
const ENGINE_TIMEOUT_MS = 15_000

const PATH_SEPARATOR = process.platform === 'win32' ? ';' : ':'

/**
 * Where DeepSeek Harness keeps its own `@vscode/ripgrep` platform package
 * (`@vscode/ripgrep-<platform>-<arch>/bin/rg` — the binary the harness's
 * agent-side search tools run on, so the sidebar search should prefer it
 * over a random PATH rg). The roots below are PACKAGE-MANAGER ROOTS (the
 * directory holding `@vscode/`), not `<root>/@deepseek-ai/dsh/node_modules`
 * style dependency dirs: npm and pnpm hoist the platform package next to
 * `@deepseek-ai`, not under it (verified against a real install: the
 * profile tree carries `<profile>/node_modules/@vscode/ripgrep-<…>` and no
 * `@deepseek-ai/dsh/node_modules` at all). Both shapes are still probed —
 * a tree that did not hoist keeps the package under the CLI. Deriving "the
 * node_modules that provided @deepseek-ai/dsh" from the running paths also
 * covers pnpm's `.pnpm/node_modules` hoist layer for free (verified on
 * fnm/pnpm: execPath `.../node/versions/v22/bin/node` walks
 * `bin/node_modules` → `versions/node_modules` → … → `.pnpm/node_modules`),
 * and `modulePath` (the CLI entry, `…/@deepseek-ai/dsh/lib/bin.js`) covers
 * a desktop shell whose bundled tree sits next to a node it did not ship —
 * a Homebrew node + this checkout's dependency tree is exactly that layout
 * (verified: the candidate resolves to the bundled rg on macOS).
 * Wrong guesses are cheap: every candidate goes through verify() and
 * unusable ones are dropped.
 *
 * Pure in `platform`: every path below is built with that platform's
 * `node:path` dialect (see `P` in the body), so the returned shape depends
 * only on the arguments — never on the OS running the probe.
 */
export function bundledRgCandidates(
  platform: NodeJS.Platform,
  arch: string,
  execPath: string,
  env: NodeJS.ProcessEnv,
  home: string,
  modulePath: string | undefined = process.argv[1],
): string[] {
  const binName = platform === 'win32' ? 'rg.exe' : 'rg'
  const platformPkg = `@vscode/ripgrep-${platform}-${arch}`
  // Everything below is derived from the PLATFORM ARGUMENT, so it must use
  // that platform's path dialect — never the host's. A host `sep`/`dirname`
  // makes this function a different function on every OS: on a Windows host
  // the `endsWith(sep + 'node_modules')` test below never matched a POSIX
  // start path, so the whole argv[1] walk produced nothing and the win32 /
  // darwin shapes could not be pinned from a non-Windows machine (the Windows
  // CI failure this fixes). With the dialect selected here the shape derived
  // from those arguments is the same everywhere: 'darwin' always yields
  // '/'-joined candidates, 'win32' always yields '\'-joined ones.
  const P = platform === 'win32' ? win32 : posix
  const roots: string[] = []
  const addRoot = (root: string): void => {
    if (root !== '' && !roots.includes(root)) roots.push(root)
  }
  // Every node_modules directory on the way up from a path inside the DSH
  // install: the CLI entry (argv[1] = …/@deepseek-ai/dsh/lib/bin.js) finds
  // the tree that actually provided @deepseek-ai/dsh — a desktop shell's
  // bundled tree, a project-local install, a checkout — even when the node
  // executable itself lives elsewhere (Homebrew node + a bundled tree).
  const walkRoots = (start: string): void => {
    if (start === '') return
    let current = P.dirname(start)
    while (current !== P.dirname(current)) {
      if (current.endsWith(`${P.sep}node_modules`)) addRoot(current)
      current = P.dirname(current)
    }
  }
  if (modulePath !== undefined && modulePath !== '') walkRoots(modulePath)
  walkRoots(execPath)
  // npm global installs. POSIX: <prefix>/lib/node_modules with the executable
  // at <prefix>/bin/node. Windows npm has NO lib/ layer — packages land in
  // %APPDATA%\npm\node_modules (nvm-windows keeps the same %APPDATA%\npm).
  if (platform === 'win32') {
    if (env.APPDATA !== undefined && env.APPDATA !== '') {
      addRoot(P.join(env.APPDATA, 'npm', 'node_modules'))
    }
  } else {
    addRoot(P.join(P.dirname(P.dirname(execPath)), 'lib', 'node_modules'))
    // Homebrew and pnpm global layouts missed by the execPath derivation.
    addRoot('/opt/homebrew/lib/node_modules')
    addRoot('/usr/local/lib/node_modules')
  }
  // The DSH profile layout: plugins and the host CLI share one tree.
  addRoot(P.join(home, '.dsh', 'profiles', 'node_modules'))
  const candidates: string[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    for (const candidate of [
      P.join(root, platformPkg, 'bin', binName),
      // A dependency tree that did NOT hoist (pnpm's strict layout, npm with
      // a conflicting top-level @vscode/ripgrep).
      P.join(root, '@deepseek-ai', 'dsh', 'node_modules', platformPkg, 'bin', binName),
    ]) {
      if (!seen.has(candidate)) {
        seen.add(candidate)
        candidates.push(candidate)
      }
    }
  }
  return candidates
}

/** Candidate binaries for one engine: the harness's bundled rg, then PATH
 *  entries, then fixed well-known locations. A PATH that misses Homebrew
 *  (seen in launchd-spawned processes) is covered by the fixed paths. */
function candidates(engine: Engine): string[] {
  const env = process.env
  const pathNames: Record<Engine, readonly string[]> = {
    fd: ['fd', 'fdfind'],
    rg: ['rg'],
  }
  const out: string[] = []
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
  } else {
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
 *  internals, dependency forests, package-manager stores, build caches,
 *  worktree forests, language environments).
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
  // #879: git-worktree forests (both spellings; `.worktrees/` is the
  // layout DeepSeek Harness itself uses) burned the whole 100k visit budget
  // on real projects before the walk reached project files. Language
  // environments and their bytecode caches are noise of the same class.
  '.worktrees',
  '.worktree',
  'target',
  'venv',
  '.venv',
  '__pycache__',
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
): Promise<{ lines: string[]; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const lines: string[] = []
    let truncated = false
    let closed = false
    const finish = (error: unknown): void => {
      if (closed) return
      closed = true
      clearTimeout(timer)
      if (error !== undefined) {
        child.kill()
        reject(error)
      } else {
        resolve({ lines, truncated })
      }
    }
    const timer = setTimeout(() => { finish(new EngineTimeoutError('search engine timed out')) }, ENGINE_TIMEOUT_MS)
    child.once('error', (error) => { finish(error) })
    // `close`, not `exit` (#883): `exit` fires the moment the process dies,
    // while the stdout pipe may still hold undrained data — under host load
    // the exit event can win the race and resolve this promise with a still
    // EMPTY `lines` array (fd's second `--type d` run was the common victim:
    // matches intact, dirs silently empty). `close` fires only after every
    // stdio stream has ended, so every readline `line` event has fired
    // before the settlement. The truncation kill and the timeout/error
    // finishes above are unaffected: whichever finish ran first sets
    // `closed`, and this handler is idempotent.
    child.once('close', (code) => {
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
    const bare = normalized.startsWith('./') ? normalized.slice(2) : normalized
    // fd prints DIRECTORY hits with a trailing separator ('src/util/') while
    // rg --files reports files only, so the '--type d' run is the one that
    // carries it. The walk contract has no trailing separator ('src/util'),
    // and a whole class of consumers compares these rows against walk output
    // (dir sets, `kept.has(dir)` subsets, the row label), so the canonical
    // form is enforced HERE — the single point both engines and both runs
    // pass through. A bare '/' (the root) collapses to '' and is dropped
    // below, which is the same treatment the walk gives it.
    const clean = bare.endsWith('/') ? bare.replace(/\/+$/, '') : bare
    if (clean !== '' && clean !== '.') out.push(clean)
  }
  return out
}

/** The fd argv: the query as a literal substring, every SKIP_DIR_NAMES
 *  excluded (a bare name excludes the entry at any depth; a worktree-style
 *  `.git` FILE is covered too — verified against real fd), '/' separators
 *  pinned, and --max-results one ABOVE the stream sentinel (cap + 1) so a
 *  full result set overflows into the same truncation detected for rg
 *  (see runChild). Directory matches are read from a second invocation
 *  (`type: 'd'`, see runChild) because fd cannot label its matches. */
export function fdArgv(cap: number, query: string, type?: 'd'): string[] {
  return [
    '--hidden', '--no-ignore',
    ...SKIP_DIR_NAMES.flatMap(name => ['--exclude', name]),
    '--fixed-strings', '--ignore-case',
    ...(type === undefined ? [] : ['--type', type]),
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
    // Three query globs. The slash-free form matches BASENAMES only (rg
    // follows gitignore semantics — no '/' in the pattern means basename
    // match, verified on real rg 15: 'util/helper.ts' never matches
    // '*util*'). The other two admit files whose PATH carries a matching
    // segment, so deriveRgMatches can turn that into the directory match the
    // walk/fd contract reports: one '/*' level catches a DIRECT child
    // ('util/helper.ts' — the most common hit), '**' catches everything
    // deeper. Both are needed: '**' alone skips the direct child, '/*'
    // alone skips the nested one (verified against real rg 15).
    '--iglob', `*${escaped}*`,
    '--iglob', `**/*${escaped}*/*`,
    '--iglob', `**/*${escaped}*/**`,
    '--path-separator', '/',
    '.',
  ]
}

/** rg reports FILES only (`rg --files` never emits a directory line), while
 *  the walk contract matches entry names — files AND directories. Every rg
 *  line is a file path whose glob already guarantees the query appears
 *  somewhere in it, so: a basename hit stays a file match, and a matching
 *  DIRECTORY segment is derived as a directory match (a directory named X
 *  holding at least one file surfaces exactly as fd/walk report it).
 *  EMPTY directories stay invisible to rg — no file path carries them —
 *  the one gap left versus fd and the walk. Both lists are sorted and
 *  capped at the same sentinel (maxMatches + 1, the caller slices back and
 *  re-derives the directory subset from what it keeps, so `dirs` stays a
 *  subset of `matches`); `truncated` is raised when the derived set exceeded
 *  the budget — the budget, not the engine, cut the result short (runChild
 *  ORs it with the stream's own sentinel). */
export function deriveRgMatches(
  paths: readonly string[],
  query: string,
  maxMatches: number,
): { paths: string[]; dirs: string[]; truncated: boolean } {
  const needle = query.toLowerCase()
  const files = new Set<string>()
  const dirs = new Set<string>()
  for (const path of paths) {
    const segments = path.split('/')
    const base = segments[segments.length - 1]
    if (base !== undefined && base.toLowerCase().includes(needle)) files.add(path)
    let prefix = ''
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]
      if (segment === undefined) continue
      prefix = prefix === '' ? segment : `${prefix}/${segment}`
      if (segment.toLowerCase().includes(needle)) dirs.add(prefix)
    }
  }
  const derived = [...new Set([...files, ...dirs])].sort()
  return {
    paths: derived.slice(0, maxMatches + 1),
    dirs: [...dirs].sort().slice(0, maxMatches + 1),
    truncated: derived.length > maxMatches,
  }
}

/** One child invocation per engine, emitting normalized relative paths.
 *  fd needs two runs to fill the walk contract: the plain literal match (both
 *  files and directories — the walk's own shape) and a `--type d` run for the
 *  directory subset. rg's query globs admit basename hits AND files under
 *  matching directories; deriveRgMatches converts the latter into the
 *  directory matches the walk contract reports and drops nothing else.
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
): Promise<EngineResult> {
  const cap = maxMatches + 1
  if (probe.engine === 'rg') {
    const child = spawner(probe.binary, rgArgv(query), { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
    return streamLines(child, cap).then(({ lines, truncated }) => {
      const derived = deriveRgMatches(normalizeEnginePaths(lines), query, maxMatches)
      return { paths: derived.paths, dirs: derived.dirs, truncated: truncated || derived.truncated }
    })
  }
  const child = spawner(probe.binary, fdArgv(cap, query), { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
  const dirChild = spawner(probe.binary, fdArgv(cap, query, 'd'), { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
  return Promise.all([
    streamLines(child, cap),
    // The directory run's failure is NOT swallowed (#883): a rejected dirs
    // stream rejects the whole engine call, so runEngine marks the engine
    // broken and this one search falls back to the plain walk — exactly
    // the main run's failure handling. The old swallow-catch degraded the
    // failure into "zero directories", invisible in every environment.
    streamLines(dirChild, cap),
  ]).then(([matches, dirs]) => {
    const paths = normalizeEnginePaths(matches.lines)
    const dirSet = new Set(normalizeEnginePaths(dirs.lines))
    return {
      paths,
      dirs: paths.filter(path => dirSet.has(path)),
      truncated: matches.truncated,
    }
  })
}

let prober = (): Promise<readonly EngineProbe[]> => probeOnce()
let runner = runChild
/**
 * The spawn signature runChild uses, narrowed from `typeof spawn` so a test
 * spawner returning a scripted `ChildProcess` satisfies the hook without
 * matching spawn's full overload surface.
 */
export type EngineSpawner = (
  binary: string,
  argv: readonly string[],
  options: { cwd: string; stdio: ['ignore', 'pipe', 'ignore'] },
) => ChildProcess
/** Child spawn behind runChild — injectable so tests can drive the real
 *  orchestration with scripted children (event order, stream timing). */
let spawner: EngineSpawner = spawn
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
 *  directory. */
export async function runEngine(
  probe: EngineProbe,
  root: string,
  query: string,
  maxMatches: number,
): Promise<EngineResult> {
  try {
    return await runner(probe, root, query, maxMatches)
  } catch (error) {
    if (error instanceof EngineTimeoutError) {
      debugLog(`[dsh-search] engine ${probe.engine} timed out (tree too large), falling back`)
    } else {
      broken.add(probe.engine)
      debugLog(`[dsh-search] engine ${probe.engine} failed at runtime, disabled: ${error instanceof Error ? error.message : String(error)}`)
    }
    throw error
  }
}

/** The engines a caller may actually try (verified, not broken). */
export async function usableEngines(): Promise<readonly EngineProbe[]> {
  const probes = await probeEngines()
  return probes.filter((probe) => !broken.has(probe.engine))
}

/** Test seam: replace the probe / child-runner / spawn implementations. */
export function setEngineHooks(next: { prober?: typeof prober; runner?: typeof runner; spawner?: typeof spawner }): void {
  if (next.prober !== undefined) prober = next.prober
  if (next.runner !== undefined) runner = next.runner
  if (next.spawner !== undefined) spawner = next.spawner
}

/** Reset probe cache, broken-set and hooks (test isolation). */
export function resetEngines(): void {
  probePromise = null
  broken.clear()
  prober = (): Promise<readonly EngineProbe[]> => probeOnce()
  runner = runChild
  spawner = spawn
}
