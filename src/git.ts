/**
 * Git operations for the sidebar source-control panel. Everything goes
 * through the system `git` binary spawned per request (no library, no state),
 * with porcelain-parseable output formats (`-z` NUL framing, unit separators)
 * so parsing never depends on locale or color config. Commands run with
 * `-C <cwd>` on the selected repository and `--no-pager` /
 * `-c color.ui=false` so output stays machine-readable.
 *
 * Commits use the user's git global identity untouched (never sets
 * user.name/user.email).
 */
import { spawn } from 'node:child_process'
import { readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'

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

/** One repository discovered under the session workspace. */
export interface GitRepositoryStatus extends GitStatusResult {
  root: string
}

const REPOSITORY_SCAN_IGNORES = new Set(['.git', 'node_modules'])
const REPOSITORY_SCAN_MAX_DIRECTORIES = 10_000

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

/** Status for the containing repository and independent repositories below cwd. */
export async function repositories(cwd: string): Promise<GitRepositoryStatus[]> {
  const roots = new Set<string>()
  try {
    roots.add(await realpath(await repoRoot(cwd)))
  } catch {
    // A workspace outside Git can still contain independent repositories.
  }

  const queue = [await realpath(cwd)]
  let cursor = 0
  while (cursor < queue.length && cursor < REPOSITORY_SCAN_MAX_DIRECTORIES) {
    const directory = queue[cursor]!
    cursor += 1
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    if (entries.some(entry => entry.name === '.git')) {
      try {
        const root = await realpath(await repoRoot(directory))
        if (root === directory) roots.add(root)
      } catch {
        // An unreadable or invalid .git marker is not a repository.
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || REPOSITORY_SCAN_IGNORES.has(entry.name)) continue
      queue.push(join(directory, entry.name))
    }
  }

  const sorted = [...roots].sort((left, right) => left.localeCompare(right))
  return Promise.all(sorted.map(async root => ({ root, ...await status(root) })))
}

/** Use an explicitly selected repository when one is supplied by the UI. */
function selectedCwd(cwd: string, repository?: string): string {
  return repository ?? cwd
}

/** Diff text of the worktree (unstaged) or the index (staged). */
export async function diff(cwd: string, path: string | undefined, staged: boolean, repository?: string): Promise<string> {
  const args = ['diff', '--no-ext-diff', '--no-color', '-U3']
  if (staged) args.push('--cached')
  if (path !== undefined) args.push('--', path)
  return runGit(selectedCwd(cwd, repository), args)
}

/** Stage paths (all when path is undefined). */
export async function stage(cwd: string, path: string | undefined, repository?: string): Promise<void> {
  await runGit(selectedCwd(cwd, repository), ['add', '-A', ...(path !== undefined ? ['--', path] : [])])
}

/** Unstage paths (all when path is undefined). */
export async function unstage(cwd: string, path: string | undefined, repository?: string): Promise<void> {
  await runGit(selectedCwd(cwd, repository), ['reset', '-q', ...(path !== undefined ? ['--', path] : [])])
}

/** Commit the staged changes with a message (global identity untouched). */
export async function commit(cwd: string, message: string, repository?: string): Promise<void> {
  await runGit(selectedCwd(cwd, repository), ['commit', '-m', message])
}

/** Branch names (current first). */
export async function branches(cwd: string, repository?: string): Promise<{ current: string; names: string[] }> {
  const target = selectedCwd(cwd, repository)
  const [current, raw] = await Promise.all([
    currentBranch(target).catch(() => 'HEAD'),
    runGit(target, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
  ])
  const names = raw.split('\n').filter(line => line !== '')
  return { current, names: names.includes(current) ? names : [current, ...names] }
}

/** Switch to an existing branch. */
export async function checkout(cwd: string, branch: string, repository?: string): Promise<void> {
  await runGit(selectedCwd(cwd, repository), ['checkout', branch])
}

/** Recent commit history (newest first), lazily pageable via skip/count. */
export async function log(cwd: string, count = 30, skip = 0, repository?: string): Promise<GitLogEntry[]> {
  const raw = await runGit(selectedCwd(cwd, repository), [
    'log', '-n', String(count), '--skip', String(skip), '--decorate=short',
    '--pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D',
  ])
  return parseLogLines(raw)
}

/**
 * Content of a file at a revision (`git show <rev>:<path>`), or null when the
 * revision has no such path (a new/untracked file has no HEAD side).
 */
export async function show(cwd: string, rev: string, path: string, repository?: string): Promise<string | null> {
  try {
    return await runGit(selectedCwd(cwd, repository), ['show', `${rev}:${path}`])
  } catch {
    return null
  }
}

/** Full patch text of one commit (`git show` with the commit header suppressed).
 *  Merge commits show their diff against the first parent (`-m --first-parent`
 *  is a no-op for regular commits), so a history click always has content. */
export async function commitDiff(cwd: string, hash: string, repository?: string): Promise<string> {
  return runGit(selectedCwd(cwd, repository), ['show', '--no-ext-diff', '--no-color', '--format=', '-m', '--first-parent', hash])
}

/** Discard the worktree changes of one path (`git checkout -- <path>`; the index is untouched). */
export async function discard(cwd: string, path: string, repository?: string): Promise<void> {
  await runGit(selectedCwd(cwd, repository), ['checkout', '--', path])
}

/** Revert one commit onto the current branch with an auto-generated message. */
export async function revert(cwd: string, hash: string, repository?: string): Promise<void> {
  await runGit(selectedCwd(cwd, repository), ['revert', '--no-edit', hash])
}

/** Cherry-pick one commit onto the current branch. */
export async function cherryPick(cwd: string, hash: string, repository?: string): Promise<void> {
  await runGit(selectedCwd(cwd, repository), ['cherry-pick', hash])
}
