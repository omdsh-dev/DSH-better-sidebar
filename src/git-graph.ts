import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { GitCommandError, repoRoot } from './git.ts'

export interface GitGraphEntry {
  hash: string
  hashFull: string
  parents: string[]
  subject: string
  author: string
  date: string
  refs: string[]
  message: string
}
export interface GitGraphBranch { ref: string; name: string; hashFull: string }
export interface GitGraphOptions { branch?: string; count?: number; cursor?: string }
export interface GitGraphResult {
  isRepo: boolean
  root?: string
  entries: GitGraphEntry[]
  branches: GitGraphBranch[]
  hasMore: boolean
  nextCursor?: string
  snapshot: string
}

const MAX_OUTPUT = 8 * 1024 * 1024
const MAX_OFFSET = 10_000
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const fail = (message: string, code = 'bad-request'): never => {
  throw new GitCommandError(message, code, 'graph')
}

/** Separate read-only runner: bounded buffers, no prompts/lazy network fetches,
 * replacement objects or optional index writes. Never pass client revisions. */
function readGit(cwd: string, args: string[], allowMissing = false): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, '--no-pager', '--no-replace-objects', '-c', 'color.ui=false', ...args], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: MAX_OUTPUT, windowsHide: true,
      env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
    }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout)
      if (allowMissing && error.code === 1 && !stderr.trim()) return resolve('')
      reject(new GitCommandError(stderr.trim() || error.message, 'git-error', args[0] ?? 'graph'))
    })
  })
}

function cursorOf(value: unknown): { fingerprint: string; offset: number } | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) fail('Invalid graph cursor')
  try {
    const parsed = JSON.parse(Buffer.from(value as string, 'base64url').toString('utf8'))
    if (parsed?.version !== 1 || !/^[a-f0-9]{64}$/.test(parsed.fingerprint)
      || !Number.isSafeInteger(parsed.offset) || parsed.offset < 1 || parsed.offset > MAX_OFFSET) fail('Invalid graph cursor')
    return parsed
  } catch { return fail('Invalid graph cursor') }
}

async function snapshotOf(root: string, branch: string | undefined) {
  const raw = await readGit(root, ['for-each-ref', '--sort=refname', '--format=%(refname)%00%(objectname)', 'refs/heads/', 'refs/remotes/'])
  const branches: GitGraphBranch[] = raw.trimEnd().split('\n').filter(Boolean).map(line => {
    const [ref, hashFull] = line.split('\0')
    if (!ref || !hashFull || !OID.test(hashFull)) return fail('Invalid Git reference output', 'git-error')
    return { ref, name: ref.replace(/^refs\/(heads|remotes)\//, ''), hashFull }
  })
  // Bound argv as well as output on repositories with enormous ref inventories.
  if (branches.length > 1000) fail('Too many branches for graph (limit 1000)', 'graph-limit')
  const head = (await readGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], true)).trim()
  const symbolicHead = (await readGit(root, ['symbolic-ref', '--quiet', 'HEAD'], true)).trim()
  if (head && !OID.test(head)) fail('Invalid HEAD', 'git-error')
  if (!head && (!symbolicHead || branches.some(item => item.ref === symbolicHead))) fail('Cannot resolve HEAD', 'git-error')
  const fingerprint = createHash('sha256').update(JSON.stringify({ root, branch, branches, head, symbolicHead })).digest('hex')
  const selected = branch === undefined ? undefined : branches.find(item => item.ref === branch)
  const tips = branch === undefined
    ? [...new Set([...branches.map(item => item.hashFull), ...(head ? [head] : [])])].sort()
    : selected ? [selected.hashFull] : []
  const decorations = new Map<string, string[]>()
  for (const item of branches) decorations.set(item.hashFull, [...(decorations.get(item.hashFull) ?? []), item.name])
  if (head) decorations.set(head, ['HEAD', ...(decorations.get(head) ?? [])])
  return { branches, fingerprint, tips, decorations, selected }
}

/** Immutable OID traversal + before/after ref fingerprints prevents concatenating
 * pages from different histories. No server cache or repository mutation. */
export async function gitGraph(cwd: string, options: GitGraphOptions = {}, selectedRepo?: string): Promise<GitGraphResult> {
  const { branch, count = 50 } = options
  if (branch !== undefined && (typeof branch !== 'string' || branch.length > 1024 || !/^refs\/(heads|remotes)\/.+/.test(branch))) fail('Expected a full local or remote branch ref')
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) fail('Invalid graph count')
  const limit = Math.min(count, 200)
  const cursor = cursorOf(options.cursor)
  let root: string
  try {
    // Probe strictly first: existing discovery deliberately swallows errors;
    // graph must not turn permissions, broken Git or timeout into an empty UI.
    root = (await readGit(cwd, ['rev-parse', '--show-toplevel'])).trim()
    if (selectedRepo !== undefined) root = await repoRoot(cwd, selectedRepo)
  } catch (error) {
    if (!(error instanceof GitCommandError) || !/^fatal: not a git repository(?: \(|:)/.test(error.message)) throw error
    try { root = await repoRoot(cwd, selectedRepo) } catch (discoveryError) {
      if (!(discoveryError instanceof GitCommandError) || discoveryError.code !== 'not-repo') throw discoveryError
      if (cursor) fail('Graph repository changed; refresh', 'graph-stale')
      return { isRepo: false, entries: [], branches: [], hasMore: false, snapshot: '' }
    }
    root = (await readGit(root, ['rev-parse', '--show-toplevel'])).trim()
  }
  const before = await snapshotOf(root, branch)
  if (cursor && cursor.fingerprint !== before.fingerprint) fail('Graph changed; refresh', 'graph-stale')
  if (branch !== undefined && !before.selected) fail('Unknown graph branch')
  const offset = cursor?.offset ?? 0
  const entries: GitGraphEntry[] = []
  if (before.tips.length) {
    const output = await readGit(root, ['log', '--topo-order', '--no-decorate', '--no-show-signature', '--encoding=UTF-8',
      `--max-count=${limit + 1}`, `--skip=${offset}`, '--format=%H%x00%P%x00%an%x00%ai%x00%s%x00%B%x00', ...before.tips, '--'])
    // Git separates records with LF; only strip it from the next OID, never
    // from message fields. NUL framing preserves multiline/control text.
    const fields = output.split('\0')
    for (let i = 0; i + 5 < fields.length; i += 6) {
      const hashFull = fields[i]!.trim()
      const parents = fields[i + 1]!.split(' ').filter(Boolean)
      if (!OID.test(hashFull) || parents.some(parent => !OID.test(parent))) fail('Invalid Git graph output', 'git-error')
      entries.push({ hash: hashFull.slice(0, 7), hashFull, parents,
        author: fields[i + 2]!, date: fields[i + 3]!, subject: fields[i + 4]!, message: fields[i + 5]!, refs: before.decorations.get(hashFull) ?? [] })
    }
  }
  const after = await snapshotOf(root, branch)
  if (after.fingerprint !== before.fingerprint) fail('Graph changed; refresh', 'graph-stale')
  const hasMore = entries.length > limit
  if (hasMore && offset + limit > MAX_OFFSET) fail('Graph history limit reached (10000)', 'graph-limit')
  return { isRepo: true, root, entries: entries.slice(0, limit), branches: before.branches, hasMore,
    ...(hasMore ? { nextCursor: Buffer.from(JSON.stringify({ version: 1, fingerprint: before.fingerprint, offset: offset + limit })).toString('base64url') } : {}),
    snapshot: before.fingerprint }
}
