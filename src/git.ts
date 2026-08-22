/**
 * Git operations for the sidebar source-control panel. Everything goes
 * through the system `git` binary spawned per request (no library, no state),
 * with porcelain-parseable output formats (`-z` NUL framing, unit separators)
 * so parsing never depends on locale or color config. All commands run with
 * `-C <cwd>` on the session's working directory and `--no-pager` /
 * `-c color.ui=false` so output stays machine-readable.
 *
 * Commits use the user's git global identity untouched (never sets
 * user.name/user.email).
 */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

/** A parsed `git status --porcelain=v1 -z` entry. */
export interface GitStatusEntry {
  path: string
  /** Two-letter index/worktree status (X Y), e.g. 'M ', ' M', 'A ', '??'. */
  xy: string
}

/** The source-control panel snapshot. */
export interface GitStatusResult {
  isRepo: boolean
  branch?: string
  entries: GitStatusEntry[]
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
  const full = ['-C', cwd, '--no-pager', '-c', 'color.ui=false', ...args]
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn('git', full, {
      stdio: ['ignore', 'pipe', 'pipe'],
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

/** Whether the directory is inside a git work tree (exit-0 `git rev-parse`). */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const out = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
    return out.trim() === 'true'
  } catch {
    return false
  }
}

/** The repository top level containing `cwd` (`git rev-parse --show-toplevel`). */
export async function repoRoot(cwd: string): Promise<string> {
  const out = await runGit(cwd, ['rev-parse', '--show-toplevel'])
  return out.trim()
}

/** The current branch name (`git rev-parse --abbrev-ref HEAD`; 'HEAD' when detached). */
export async function currentBranch(cwd: string): Promise<string> {
  const out = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return out.trim()
}

/** Working-tree status (untracked included). */
export async function status(cwd: string): Promise<GitStatusResult> {
  const repo = await isGitRepo(cwd)
  if (!repo) return { isRepo: false, entries: [] }
  const [branch, raw] = await Promise.all([
    currentBranch(cwd).catch(() => 'HEAD'),
    runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
  ])
  return { isRepo: true, branch, entries: parsePorcelainZ(raw) }
}

/** Platform-aware identity used only for comparing absolute checkout roots. */
function pathIdentity(path: string): string {
  const absolute = resolve(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** Raw usable checkout records, shared by inventory and target validation.
 * Prunable records point at missing paths and are deliberately excluded from
 * both the selector and the command-target allowlist. */
async function listedWorktrees(cwd: string): Promise<GitWorktreeRecord[]> {
  const raw = await runGit(cwd, ['worktree', 'list', '--porcelain', '-z'])
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
export async function diff(cwd: string, path: string | undefined, staged: boolean): Promise<string> {
  const args = ['diff', '--no-ext-diff', '--no-color', '-U3']
  if (staged) args.push('--cached')
  if (path !== undefined) args.push('--', path)
  return runGit(cwd, args)
}

/** Stage paths (all when path is undefined). */
export async function stage(cwd: string, path: string | undefined): Promise<void> {
  await runGit(cwd, ['add', '-A', ...(path !== undefined ? ['--', path] : [])])
}

/** Unstage paths (all when path is undefined). */
export async function unstage(cwd: string, path: string | undefined): Promise<void> {
  await runGit(cwd, ['reset', '-q', ...(path !== undefined ? ['--', path] : [])])
}

/** Commit the staged changes with a message (global identity untouched). */
export async function commit(cwd: string, message: string): Promise<void> {
  await runGit(cwd, ['commit', '-m', message])
}

/** Branch names (current first). */
export async function branches(cwd: string): Promise<{ current: string; names: string[] }> {
  const [current, raw] = await Promise.all([
    currentBranch(cwd).catch(() => 'HEAD'),
    runGit(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
  ])
  const names = raw.split('\n').filter(line => line !== '')
  return { current, names: names.includes(current) ? names : [current, ...names] }
}

/** Switch to an existing branch. */
export async function checkout(cwd: string, branch: string): Promise<void> {
  await runGit(cwd, ['checkout', branch])
}

/** Recent commit history (newest first), lazily pageable via skip/count. */
export async function log(cwd: string, count = 30, skip = 0): Promise<GitLogEntry[]> {
  const raw = await runGit(cwd, [
    'log', '-n', String(count), '--skip', String(skip), '--decorate=short',
    '--pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D',
  ])
  return parseLogLines(raw)
}

/**
 * Content of a file at a revision (`git show <rev>:<path>`), or null when the
 * revision has no such path (a new/untracked file has no HEAD side).
 */
export async function show(cwd: string, rev: string, path: string): Promise<string | null> {
  try {
    return await runGit(cwd, ['show', `${rev}:${path}`])
  } catch {
    return null
  }
}

/** Full patch text of one commit (`git show` with the commit header suppressed).
 *  Merge commits show their diff against the first parent (`-m --first-parent`
 *  is a no-op for regular commits), so a history click always has content. */
export async function commitDiff(cwd: string, hash: string): Promise<string> {
  return runGit(cwd, ['show', '--no-ext-diff', '--no-color', '--format=', '-m', '--first-parent', hash])
}

/** Discard the worktree changes of one path (`git checkout -- <path>`; the index is untouched). */
export async function discard(cwd: string, path: string): Promise<void> {
  await runGit(cwd, ['checkout', '--', path])
}

/** Revert one commit onto the current branch with an auto-generated message. */
export async function revert(cwd: string, hash: string): Promise<void> {
  await runGit(cwd, ['revert', '--no-edit', hash])
}

/** Cherry-pick one commit onto the current branch. */
export async function cherryPick(cwd: string, hash: string): Promise<void> {
  await runGit(cwd, ['cherry-pick', hash])
}
