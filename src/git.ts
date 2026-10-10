/**
 * Git operations for the sidebar source-control panel. Everything goes
 * through the system `git` binary spawned per request (no library, no state),
 * with porcelain-parseable output formats (`-z` NUL framing, unit separators)
 * so parsing never depends on locale or color config. All commands run with
 * `-C <cwd>` on the session's working directory and `--no-pager` /
 * `-c color.ui=false` / `-c core.quotePath=false` so output stays
 * machine-readable and paths stay literal (git's default C-quotes a non-ASCII
 * path, which every diff surface would render as the file name).
 *
 * Commits use the user's git global identity untouched (never sets
 * user.name/user.email).
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

/** A parsed `git status --porcelain=v1 -z` entry. */
export interface GitStatusEntry {
  path: string
  /** Two-letter index/worktree status (X Y), e.g. 'M ', ' M', 'A ', '??'. */
  xy: string
  /** How many lines this path gained and lost, index and worktree sides
   *  SUMMED (both are measured against HEAD). Absent when git has no numstat
   *  row for the path — an untracked file never gets one — so "no counts" is
   *  never rendered as a fabricated `0`. */
  counts?: GitLineCounts
}

/** One path's line-count summary from `git diff --numstat`. A binary change is
 *  its own variant because git reports `-`/`-` for it: there ARE no counts, and
 *  saying `+0 −0` would invent a number. */
export type GitLineCounts = { additions: number; deletions: number } | { binary: true }

/** The source-control panel snapshot. */
export interface GitStatusResult {
  isRepo: boolean
  branch?: string
  entries: GitStatusEntry[]
  /** True when the working tree had more rows than `GIT_STATUS_LIMIT`; the
   *  panel shows a truncation notice instead of freezing on a huge untracked
   *  set (issue #369). */
  truncated?: boolean
  /** Selected repository root, or the discovered roots when the cwd is a container. */
  root?: string
  repositories?: string[]
}

/** One linked checkout returned by `git worktree list --porcelain`. */
export interface GitWorktree {
  /** Absolute checkout root. */
  path: string
  /** Branch name without `refs/heads/`, or `HEAD` when detached. */
  branch: string
  /** Whether this checkout contains the session cwd. */
  current: boolean
  /** Number of staged + unstaged status rows (a file changed on both sides counts once). */
  changes: number
}

/** One `git log` row. */
export interface GitLogEntry {
  /** Short hash (7+ chars, display). */
  hash: string
  /** Full 40-char hash (advanced operations: revert / cherry-pick). */
  hashFull: string
  subject: string
  author: string
  /** ISO 8601 author date (`%ai`), e.g. `2024-01-01 10:00:00 +0800`. */
  date: string
  /** Ref decorations (`%D` with --decorate=short), e.g. `HEAD -> main, origin/main`; '' when none. */
  refs: string
}

/** One git failure (stderr text as the message). */
export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly code = 'git-error',
    readonly command: string,
  ) {
    super(message)
  }
}

/** Parse porcelain v1 -z output into entries (rename/copy pairs collapse to one row). */
export function parsePorcelainZ(output: string): GitStatusEntry[] {
  const tokens = output.split('\0')
  const entries: GitStatusEntry[] = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    index += 1
    if (token === '') continue
    const xy = token.slice(0, 2)
    const rest = token.slice(3)
    entries.push({ path: rest, xy })
    // Rename/copy entries carry the ORIGIN path as the next NUL field; the
    // new path (the file as it exists now) is the display path.
    if ((xy[0] === 'R' || xy[0] === 'C') && tokens[index] !== undefined && tokens[index] !== '') {
      index += 1
    }
  }
  return entries
}

/**
 * Resolve one `--numstat` path field to the path the file has NOW: the plain
 * (`old => new`) and brace (`src/{a => b}/x.ts`) rename notations both fold
 * into the new name, and anything else passes through verbatim.
 *
 * Only the LINE-framed output needs this: in `-z` framing git writes the two
 * names as separate NUL fields, so a path is never folded into rename notation
 * there — a file literally named `a => b.txt` keeps its own name.
 */
function resolveNumstatPath(path: string): string {
  const arrow = path.indexOf(' => ')
  if (arrow === -1) return path
  const open = path.indexOf('{')
  if (open !== -1 && open < arrow) {
    const close = path.indexOf('}', arrow + 4)
    if (close !== -1) return `${path.slice(0, open)}${path.slice(arrow + 4, close)}${path.slice(close + 1)}`
  }
  return path.slice(arrow + 4)
}

/**
 * Parse one `git diff --numstat` answer into a path → line-counts map. Both
 * framings are accepted: the production `-z` one (records NUL-framed, so paths
 * with newlines or quotes stay lossless) and the plain line-framed one.
 *
 * Three record shapes exist:
 *  - `2\t0\tpath` — an ordinary change,
 *  - `-\t-\tpath` — a binary change: no counts exist, so it maps to the binary
 *    variant rather than to `0 0`,
 *  - renames — the path field is the pair `old => new` (or the brace form
 *    `src/{a => b}/x.ts`) in line framing, and two NUL-framed fields (origin
 *    first) in `-z` framing.
 *
 * A rename is attributed to the NEW path: that is the file as it exists now,
 * and the exact path `git status --porcelain` reports for the same change, so
 * the counts land on the row the panel renders.
 */
export function parseNumstat(output: string): Map<string, GitLineCounts> {
  const counts = new Map<string, GitLineCounts>()
  const framed = output.includes('\0')
  const records = output.split(framed ? '\0' : '\n')
  let index = 0
  while (index < records.length) {
    const record = records[index]!
    index += 1
    if (record === '') continue
    const addedEnd = record.indexOf('\t')
    const deletedEnd = addedEnd === -1 ? -1 : record.indexOf('\t', addedEnd + 1)
    // Not a numstat record (a stray line, or a truncated answer).
    if (deletedEnd === -1) continue
    const added = record.slice(0, addedEnd)
    const deleted = record.slice(addedEnd + 1, deletedEnd)
    let path = record.slice(deletedEnd + 1)
    if (framed && path === '') {
      // A rename: the origin and the new name are the next two NUL fields.
      const renamed = records[index + 1]
      index += 2
      if (renamed === undefined) continue
      path = renamed
    } else if (!framed) {
      path = resolveNumstatPath(path)
    }
    if (path === '') continue
    if (added === '-' || deleted === '-') {
      counts.set(path, { binary: true })
      continue
    }
    const additions = Number(added)
    const deletions = Number(deleted)
    if (!Number.isFinite(additions) || !Number.isFinite(deletions)) continue
    counts.set(path, { additions, deletions })
  }
  return counts
}

/** One raw porcelain worktree record. Prunable checkouts are retained by
 * Git's administrative metadata after their directory disappears and must not
 * become selectable command targets. Locked checkouts remain usable. */
export interface GitWorktreeRecord {
  path: string
  branch: string
  locked: boolean
  prunable: boolean
}

/** Parse `git worktree list --porcelain` records. Production requests use
 * `-z` so even newlines and non-ASCII bytes in checkout paths stay lossless;
 * newline framing remains accepted for small fixtures and older Git output. */
export function parseWorktreeList(output: string): GitWorktreeRecord[] {
  const rows: GitWorktreeRecord[] = []
  let path: string | undefined
  let branch = 'HEAD'
  let locked = false
  let prunable = false
  const flush = (): void => {
    if (path !== undefined) rows.push({ path, branch, locked, prunable })
    path = undefined
    branch = 'HEAD'
    locked = false
    prunable = false
  }
  const sep = output.includes('\0') ? '\0' : '\n'
  const framed = output.endsWith(sep) ? output : `${output}${sep}`
  for (const line of framed.split(sep)) {
    if (line === '') {
      flush()
    } else if (line.startsWith('worktree ')) {
      path = line.slice('worktree '.length)
    } else if (line.startsWith('branch refs/heads/')) {
      branch = line.slice('branch refs/heads/'.length)
    } else if (line === 'locked' || line.startsWith('locked ')) {
      locked = true
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      prunable = true
    }
  }
  return rows
}

/** Parse `git log --pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D` rows. */
export function parseLogLines(output: string): GitLogEntry[] {
  const rows: GitLogEntry[] = []
  for (const line of output.split('\n')) {
    if (line === '') continue
    const [hash, subject, author, date, hashFull, refs] = line.split('\x1f')
    if (hash === undefined || subject === undefined) continue
    rows.push({
      hash,
      subject,
      author: author ?? '',
      date: date ?? '',
      hashFull: hashFull ?? hash,
      refs: refs ?? '',
    })
  }
  return rows
}

/** Run one git command; resolves with stdout, rejects with GitCommandError. */
function runGit(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  // `core.quotePath=false`: emit paths verbatim instead of C-quoting them
  // (git's default turns a CJK/space path into an octal-escaped, quoted
  // string, and every diff surface renders that string as the file name).
  // The `-z`-framed porcelain callers are unaffected: git never quotes
  // NUL-framed output.
  const full = ['-C', cwd, '--no-pager', '-c', 'color.ui=false', '-c', 'core.quotePath=false', ...args]
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn('git', full, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new GitCommandError(`git ${args[0] ?? ''} timed out after ${timeoutMs}ms`, 'git-error', args.join(' ')))
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new GitCommandError(`cannot run git: ${error.message}`, 'git-error', args.join(' ')))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolvePromise(stdout)
      } else {
        reject(new GitCommandError(stderr.trim() || `git exited with ${String(code)}`, 'git-error', args.join(' ')))
      }
    })
  })
}

/** Raw stdout of one git command. Callers that only need text (no status
 *  parsing) should use this instead of re-implementing the spawn. */
export function runGitRaw(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return runGit(cwd, args, timeoutMs)
}

/** One parsed `git blame --porcelain` row (the editor's hover blame). */
export interface GitBlameLine {
  /** 1-based line number in the file as it exists in the worktree. */
  line: number
  /** The blamed commit (40 hex chars; all zeros for a line that is not
   *  committed yet — a worktree edit git cannot attribute to a commit). */
  hash: string
  author: string
  /** Author time as ISO 8601 carrying the AUTHOR's UTC offset, so the value
   *  is stable regardless of the host machine's timezone. */
  date: string
  /** The commit's subject line (git's own placeholder for uncommitted rows). */
  summary: string
}

/** Format epoch seconds plus a `+HHMM`/`-HHMM` timezone as ISO 8601. */
function isoWithOffset(seconds: number, timezone: string): string {
  const zone = /^([+-])(\d{2})(\d{2})$/.exec(timezone)
  const offsetMinutes = zone === null
    ? 0
    : (zone[1] === '-' ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3]))
  const shifted = new Date((seconds + offsetMinutes * 60) * 1000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
    + `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
  return zone === null ? `${stamp}Z` : `${stamp}${zone[1]}${zone[2]}:${zone[3]}`
}

/**
 * Parse `git blame --porcelain -L <a>,<b>` output into one row per blamed
 * line. Porcelain repeats only the `<hash> <orig> <final>` header for the
 * SECOND and later lines of the same commit (the author / committer / summary
 * block is emitted once per commit per run), so metadata is carried forward
 * per hash; every record ends with its `\t`-prefixed content line, which is
 * where the walk resumes. Unknown lines are skipped, never fatal.
 */
export function parseBlamePorcelain(output: string): GitBlameLine[] {
  const rows: GitBlameLine[] = []
  const seen = new Map<string, { author: string; date: string; summary: string }>()
  const lines = output.split('\n')
  let index = 0
  while (index < lines.length) {
    const header = /^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/.exec(lines[index]!)
    if (header === null) {
      index += 1
      continue
    }
    const hash = header[1]!
    const line = Number(header[2])
    index += 1
    let author: string | undefined
    let date: string | undefined
    let summary: string | undefined
    while (index < lines.length && !lines[index]!.startsWith('\t')) {
      const text = lines[index]!
      index += 1
      if (text.startsWith('author ')) author = text.slice('author '.length)
      else if (text.startsWith('author-time ')) {
        const seconds = Number(text.slice('author-time '.length))
        const zone = /^author-tz (.+)$/.exec(lines[index] ?? '')
        if (Number.isFinite(seconds)) date = isoWithOffset(seconds, zone?.[1] ?? '')
      } else if (text.startsWith('summary ')) summary = text.slice('summary '.length)
    }
    // The record's content line; the next header follows it.
    if (index < lines.length && lines[index]!.startsWith('\t')) index += 1
    const known = seen.get(hash)
    if (known === undefined) {
      const record = { author: author ?? '', date: date ?? '', summary: summary ?? '' }
      seen.set(hash, record)
      rows.push({ hash, line, ...record })
    } else {
      rows.push({ hash, line, ...known })
    }
  }
  return rows
}

/**
 * Blame one line range of a file (`git blame --porcelain -L <a>,<b>`).
 * Every failure mode — not a repository, an untracked file (`git blame`
 * exits non-zero: no such path in HEAD), a bad revision, a stalled mount
 * hitting the command timeout — resolves to an EMPTY result: the editor's
 * hover tooltip shows nothing and a missing answer can never break the
 * editing surface.
 */
export async function blame(
  cwd: string,
  path: string,
  startLine: number,
  endLine: number,
  selected?: string,
): Promise<GitBlameLine[]> {
  try {
    const root = await repoRoot(cwd, selected)
    const output = await runGit(root, [
      'blame', '--porcelain', '-L', `${String(startLine)},${String(endLine)}`, '--', path,
    ])
    return parseBlamePorcelain(output)
  } catch {
    return []
  }
}

/** Cap on child directories probed by the workspace-container fallback scan.
 *  A home-directory cwd can hold hundreds of visible folders (Library, iCloud
 *  mounts…); probing them all serially is what froze the panel in #369. */
const DISCOVERY_LIMIT = 200
/** How many BFS levels the nested-repo discovery descends below cwd; repo
 *  roots up to depth DISCOVERY_MAX_DEPTH - 1 are detected (level d holds
 *  depth-(d-1) dirs, whose entries are read for `.git`). 4 is the minimum
 *  useful value. Cost stays bounded by the depth ≤ 3 directory count; the
 *  depth-4 frontier is collected but never expanded. */
const DISCOVERY_MAX_DEPTH = 4
/** Per-probe and direct-discovery budget. `rev-parse` is millisecond-scale on
 *  a healthy checkout; a probe that needs longer is a stalled mount and is
 *  better abandoned than waited on. */
const DISCOVERY_TIMEOUT_MS = 5_000
/** Discovery results are cheap to recompute but expensive to storm: the panel
 *  polls every 2s and each poll fans out into several git.* calls that all
 *  resolve the same roots. A short TTL keeps fan-out at one scan per cwd. */
const DISCOVERY_CACHE_TTL_MS = 60_000

const repoRootsCache = new Map<string, { roots: string[]; expires: number }>()
const repoRootsInFlight = new Map<string, Promise<string[]>>()

/** Whether the directory is inside a git work tree (exit-0 `git rev-parse`).
 *  Probe timeout is short: a cwd on a stalled mount must not hold the panel
 *  hostage for the full command budget (issue #369). */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const out = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'], DISCOVERY_TIMEOUT_MS)
    return out.trim() === 'true'
  } catch {
    return false
  }
}

/** The repository top level containing `cwd` (`git rev-parse --show-toplevel`). */
async function directRepoRoot(cwd: string): Promise<string> {
  const out = await runGit(cwd, ['rev-parse', '--show-toplevel'], DISCOVERY_TIMEOUT_MS)
  return out.trim()
}

/** Discover the current repository plus child repositories nested up to
 *  DISCOVERY_MAX_DEPTH - 1 levels below cwd. Results are cached per cwd and
 *  concurrent callers share one in-flight scan, so opening the panel (three
 *  parallel git.* requests) costs a single discovery pass. */
export function repoRoots(cwd: string): Promise<string[]> {
  const cached = repoRootsCache.get(cwd)
  if (cached !== undefined && cached.expires > Date.now()) return Promise.resolve(cached.roots)
  const pending = repoRootsInFlight.get(cwd)
  if (pending !== undefined) return pending
  const promise = discoverRepoRoots(cwd).then(
    (roots) => {
      repoRootsCache.set(cwd, { roots, expires: Date.now() + DISCOVERY_CACHE_TTL_MS })
      repoRootsInFlight.delete(cwd)
      return roots
    },
    (error: unknown) => {
      repoRootsInFlight.delete(cwd)
      throw error
    },
  )
  repoRootsInFlight.set(cwd, promise)
  return promise
}

/** Breadth-first scan below `cwd`: one `readdir` per visited directory, no
 *  per-child git process (dirent `.git` presence — directory, worktree file
 *  or symlink form — decides). Keeps the serial `rev-parse`-per-child storm
 *  that froze the panel in #369 structurally impossible. The scan descends
 *  into repositories it finds, so repos embedded inside other repos (vendored
 *  checkouts that are not submodules) are discovered too. */
async function discoverRepoRoots(cwd: string): Promise<string[]> {
  const roots: string[] = []
  try {
    roots.push(await directRepoRoot(cwd))
  } catch {
    // Current directory is not a Git repository root.
  }

  let level = [cwd]
  for (let depth = 1; depth <= DISCOVERY_MAX_DEPTH && level.length > 0; depth++) {
    const next: string[] = []
    for (const dir of level.slice(0, DISCOVERY_LIMIT)) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      let hasGit = false
      const subdirs: string[] = []
      for (const entry of entries) {
        if (entry.name === '.git') {
          // Worktrees and submodules carry `.git` as a file (or symlink), not a directory.
          if (entry.isDirectory() || entry.isFile() || entry.isSymbolicLink()) hasGit = true
        } else if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          subdirs.push(entry.name)
        }
      }
      if (hasGit && dir !== cwd && !roots.some(existing => pathIdentity(existing) === pathIdentity(dir))) roots.push(dir)
      for (const name of subdirs.sort((left, right) => left.localeCompare(right))) next.push(join(dir, name))
    }
    level = next
  }
  return roots
}

/** Resolve the selected repository, defaulting to the first discovered root. */
export async function repoRoot(cwd: string, selected?: string): Promise<string> {
  const roots = await repoRoots(cwd)
  if (roots.length === 0) throw new GitCommandError('not a git repository', 'not-repo', 'rev-parse')
  // Git for Windows may return forward-slash roots while callers pass
  // backslashes (or vice-versa); compare via the platform-aware identity.
  if (selected !== undefined) {
    const identity = pathIdentity(selected)
    const match = roots.find(root => pathIdentity(root) === identity)
    if (match !== undefined) return match
  }
  return roots[0]!
}

/** The current branch name (`git rev-parse --abbrev-ref HEAD`; 'HEAD' when detached). */
export async function currentBranch(cwd: string): Promise<string> {
  const out = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return out.trim()
}

/** Upper bound on status rows shipped to the client. Beyond this the result
 *  is truncated (with `truncated: true`) so a pathological untracked set —
 *  e.g. the working tree discovered under a home-directory cwd — cannot
 *  freeze the browser main thread on JSON parse or list render (#369). */
const GIT_STATUS_LIMIT = 2_000

/**
 * Fold one path's counts from both numstat sides into a running map. A file
 * changed in the index AND in the worktree is measured on each side against
 * HEAD, so the two readings ADD UP; a binary reading on either side wins,
 * because then there is no line count to add.
 */
function addLineCounts(into: Map<string, GitLineCounts>, from: Map<string, GitLineCounts>): void {
  for (const [path, counts] of from) {
    const previous = into.get(path)
    if (previous === undefined) {
      into.set(path, counts)
      continue
    }
    if (!('additions' in previous) || !('additions' in counts)) {
      into.set(path, { binary: true })
      continue
    }
    into.set(path, {
      additions: previous.additions + counts.additions,
      deletions: previous.deletions + counts.deletions,
    })
  }
}

/**
 * Working-tree status (untracked included). `--untracked-files=all` lists
 * the contents of new directories as individual entries, while preserving
 * repository discovery and explicit repository selection for workspace roots.
 *
 * The per-path line counts (#131) ride this SAME read: one batch of three git
 * processes answers status and both numstat sides together, never one process
 * per file, and callers keep their existing refresh cadence. A numstat failure
 * costs only the counts (the rows fall back to their count-less rendering) —
 * the status answer itself must never fail because of it.
 */
export async function status(cwd: string, selected?: string): Promise<GitStatusResult> {
  const repositories = await repoRoots(cwd)
  if (repositories.length === 0) return { isRepo: false, entries: [], repositories: [] }
  const root = await repoRoot(cwd, selected)
  const [branch, raw, unstagedNumstat, stagedNumstat] = await Promise.all([
    currentBranch(root).catch(() => 'HEAD'),
    runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    runGit(root, ['diff', '--numstat', '-z']).catch(() => ''),
    runGit(root, ['diff', '--cached', '--numstat', '-z']).catch(() => ''),
  ])
  const parsed = parsePorcelainZ(raw)
  const lineCounts = new Map<string, GitLineCounts>()
  addLineCounts(lineCounts, parseNumstat(stagedNumstat))
  addLineCounts(lineCounts, parseNumstat(unstagedNumstat))
  const truncated = parsed.length > GIT_STATUS_LIMIT
  const bounded = truncated ? parsed.slice(0, GIT_STATUS_LIMIT) : parsed
  return {
    isRepo: true,
    branch,
    // Paths git has no numstat row for (untracked files) keep their entry
    // untouched: the absence IS the information.
    entries: bounded.map((entry): GitStatusEntry => {
      const counts = lineCounts.get(entry.path)
      return counts === undefined ? entry : { ...entry, counts }
    }),
    truncated,
    root,
    repositories,
  }
}

/** Platform-aware identity used only for comparing absolute checkout roots. */
function pathIdentity(path: string): string {
  const absolute = resolve(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** Whether the current Git binary supports NUL-framed `worktree list` output.
 * Git < 2.36 rejects `-z`; cache the capability after the first attempt so
 * the SCM panel's polling does not repeatedly spawn a command known to fail. */
let worktreeListSupportsZ: boolean | undefined

/** Raw usable checkout records, shared by inventory and target validation.
 * Prunable records point at missing paths and are deliberately excluded from
 * both the selector and the command-target allowlist. */
async function listedWorktrees(cwd: string): Promise<GitWorktreeRecord[]> {
  let raw: string
  if (worktreeListSupportsZ === false) {
    raw = await runGit(cwd, ['worktree', 'list', '--porcelain'])
  } else {
    try {
      raw = await runGit(cwd, ['worktree', 'list', '--porcelain', '-z'])
      worktreeListSupportsZ = true
    } catch {
      worktreeListSupportsZ = false
      raw = await runGit(cwd, ['worktree', 'list', '--porcelain'])
    }
  }
  return parseWorktreeList(raw).filter(entry => !entry.prunable)
}

/** All linked checkouts of the repository containing `cwd`, enriched with a
 * live change count. The current checkout is first so a single-worktree repo
 * preserves the old UI ordering. */
export async function worktrees(cwd: string): Promise<GitWorktree[]> {
  if (!await isGitRepo(cwd)) return []
  const currentRoot = await repoRoot(cwd)
  const listed = await listedWorktrees(cwd)
  const rows = await Promise.all(listed.map(async (entry): Promise<GitWorktree> => ({
    path: entry.path,
    branch: entry.branch,
    current: pathIdentity(entry.path) === pathIdentity(currentRoot),
    // One stale/permission-raced linked checkout must not hide the valid
    // current repository from the panel. Targeted operations still fail loud.
    changes: await status(entry.path).then(result => result.entries.length, () => 0),
  })))
  return rows.sort((left, right) => Number(right.current) - Number(left.current))
}

/** Resolve an optional client-selected linked checkout. A caller may never use
 * this seam to point Git operations at an unrelated repository: the target
 * must occur in the authoritative session repository's worktree list. */
export async function resolveWorktree(cwd: string, requested?: string): Promise<string> {
  if (requested === undefined || requested === '') return cwd
  const identity = pathIdentity(requested)
  const match = (await listedWorktrees(cwd)).find(entry => pathIdentity(entry.path) === identity)
  if (match === undefined) {
    throw new GitCommandError(`unknown linked worktree: ${requested}`, 'git-worktree', 'worktree list')
  }
  return match.path
}

/** Diff text of the worktree (unstaged) or the index (staged). */
export async function diff(cwd: string, path: string | undefined, staged: boolean, selected?: string): Promise<string> {
  const root = await repoRoot(cwd, selected)
  const args = ['diff', '--no-ext-diff', '--no-color', '-U3']
  if (staged) args.push('--cached')
  if (path !== undefined) args.push('--', path)
  return runGit(root, args)
}

/**
 * Diff text of the worktree against HEAD — staged and unstaged changes in
 * ONE patch, which is what "uncommitted changes" means for the editor's
 * change gutter (the two-sided `diff()` above would each miss half of a file
 * that is partly staged). A repository whose HEAD is not born yet cannot
 * answer `diff HEAD`, so that one failure falls back to `diff --cached`
 * (index against the empty tree — the unborn-HEAD shape of the same
 * question). Untracked files never appear in either: the caller marks them
 * from the status store instead.
 */
export async function diffHead(cwd: string, path: string | undefined, selected?: string): Promise<string> {
  const root = await repoRoot(cwd, selected)
  const tail = path !== undefined ? ['--', path] : []
  try {
    return await runGit(root, ['diff', '--no-ext-diff', '--no-color', '-U3', 'HEAD', ...tail])
  } catch {
    return runGit(root, ['diff', '--no-ext-diff', '--no-color', '-U3', '--cached', ...tail])
  }
}

/** Stage paths (all when path is undefined). */
export async function stage(cwd: string, path: string | undefined, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['add', '-A', ...(path !== undefined ? ['--', path] : [])])
}

/** Unstage paths (all when path is undefined). */
export async function unstage(cwd: string, path: string | undefined, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['reset', '-q', ...(path !== undefined ? ['--', path] : [])])
}

/** Commit the staged changes with a message (global identity untouched). */
export async function commit(cwd: string, message: string, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['commit', '-m', message])
}

/** Branch names (current first). */
export async function branches(cwd: string, selected?: string): Promise<{ current: string; names: string[] }> {
  const root = await repoRoot(cwd, selected)
  const [current, raw] = await Promise.all([
    currentBranch(root).catch(() => 'HEAD'),
    runGit(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
  ])
  const names = raw.split('\n').filter(line => line !== '')
  return { current, names: names.includes(current) ? names : [current, ...names] }
}

/** Switch to an existing branch.
 *  `--end-of-options` precedes the operand: without it a caller-supplied
 *  branch beginning with `-` is parsed as an OPTION, so `-f` force-discarded
 *  the worktree changes and `--work-tree=…` redirected the checkout. Same
 *  guard as show / commitDiff / revert / cherryPick (4100e16). */
export async function checkout(cwd: string, branch: string, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['checkout', '--end-of-options', branch])
}

/** Recent commit history (newest first), lazily pageable via skip/count. */
export async function log(cwd: string, count = 30, skip = 0, selected?: string): Promise<GitLogEntry[]> {
  const raw = await runGit(await repoRoot(cwd, selected), [
    'log', '-n', String(count), '--skip', String(skip), '--decorate=short',
    '--pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D',
  ])
  return parseLogLines(raw)
}

/**
 * Content of a file at a revision (`git show <rev>:<path>`), or null when the
 * revision has no such path (a new/untracked file has no HEAD side).
 *
 * `--end-of-options` precedes the operand: without it a caller-supplied `rev`
 * beginning with `-` is parsed as an OPTION rather than a revision, so
 * `rev: "--output=NUL"` silently wrote to a file and returned empty instead of
 * failing (the Changes tab's diff/blame panes then rendered blank). The
 * sentinel ends option parsing, so the operand can never be a flag while every
 * legitimate revision form still works (`HEAD`, `:0`, `<hash>^`, `HEAD~2`,
 * `origin/main`, any branch name).
 */
export async function show(cwd: string, rev: string, path: string, selected?: string): Promise<string | null> {
  try {
    return await runGit(await repoRoot(cwd, selected), ['show', '--end-of-options', `${rev}:${path}`])
  } catch {
    return null
  }
}

/** Full patch text of one commit (`git show` with the commit header suppressed).
 *  Merge commits show their diff against the first parent (`-m --first-parent`
 *  is a no-op for regular commits), so a history click always has content.
 *  `--end-of-options` keeps a caller-supplied hash from parsing as an option. */
export async function commitDiff(cwd: string, hash: string, selected?: string): Promise<string> {
  return runGit(await repoRoot(cwd, selected), ['show', '--no-ext-diff', '--no-color', '--format=', '-m', '--first-parent', '--end-of-options', hash])
}

/** Discard the worktree changes of one path (`git checkout -- <path>`; the index is untouched). */
export async function discard(cwd: string, path: string, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['checkout', '--', path])
}

/** Revert one commit onto the current branch with an auto-generated message.
 *  `--end-of-options` keeps a caller-supplied hash from parsing as an option. */
export async function revert(cwd: string, hash: string, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['revert', '--no-edit', '--end-of-options', hash])
}

/** Cherry-pick one commit onto the current branch.
 *  `--end-of-options` keeps a caller-supplied hash from parsing as an option. */
export async function cherryPick(cwd: string, hash: string, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['cherry-pick', '--end-of-options', hash])
}

/** Push the current branch to its upstream (`git push`). A branch without a
 *  tracking remote fails loudly with git's own message — the panel shows it and
 *  the user fixes the tracking in a terminal. No operands, so there is nothing
 *  for a caller-supplied value to smuggle in as an option. */
export async function push(cwd: string, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['push'])
}

/** Pull upstream changes into the current branch (`git pull --ff-only`).
 *  Fast-forward-only keeps a headless panel out of merge/conflict editors: a
 *  diverged branch fails with git's own message instead of opening an
 *  interactive merge, so the user resolves it in a terminal. */
export async function pull(cwd: string, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['pull', '--ff-only'])
}
