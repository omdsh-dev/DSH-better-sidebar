import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
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
const MAX_GRAPH_TAGS = 5000
const MAX_HISTORY_REFS = 100_000
const MAX_SHALLOW_BYTES = 1024 * 1024
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const fail = (message: string, code = 'bad-request'): never => {
  throw new GitCommandError(message, code, 'graph')
}

/** Separate read-only runner: bounded buffers, no prompts/lazy network fetches,
 * replacement objects or optional index writes. Never pass client revisions. */
function readGit(cwd: string, args: string[], allowMissing = false, truncateOutput = false): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, '--no-pager', '--no-replace-objects', '-c', 'color.ui=false', ...args], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: MAX_OUTPUT, windowsHide: true,
      env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
    }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout)
      // Optional decorations may retain a complete-line prefix at MAX_OUTPUT;
      // oversized tag inventories must not make the whole graph unavailable.
      if (truncateOutput && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve(stdout.slice(0, stdout.lastIndexOf('\n') + 1))
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
  // Tags have their own count/output budgets: keep the first 5000 by refname
  // (or the complete-line prefix fitting MAX_OUTPUT), without consuming the
  // branch limit or adding tag-only history to the traversal.
  const rawTags = await readGit(root, ['for-each-ref', '--sort=refname', `--count=${MAX_GRAPH_TAGS}`,
    '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)', 'refs/tags/'], false, true)
  const tags = rawTags.trimEnd().split('\n').filter(Boolean).flatMap(line => {
    const [ref, object, type, peeled, peeledType] = line.split('\0')
    const hashFull = peeled || object
    // Use Git's peeled target for annotated tags; only commit targets
    // decorate graph entries, so tags pointing to trees/blobs are ignored.
    if ((peeled ? peeledType : type) !== 'commit') return []
    if (!ref?.startsWith('refs/tags/') || !hashFull || !OID.test(hashFull)) return fail('Invalid Git tag output', 'git-error')
    return [{ name: `tag: ${ref.slice('refs/tags/'.length)}`, hashFull }]
  })
  const fingerprint = createHash('sha256').update(JSON.stringify({ root, branch, branches, tags: rawTags, head, symbolicHead })).digest('hex')
  const selected = branch === undefined ? undefined : branches.find(item => item.ref === branch)
  const tips = branch === undefined
    ? [...new Set([...branches.map(item => item.hashFull), ...(head ? [head] : [])])].sort()
    : selected ? [selected.hashFull] : []
  const decorations = new Map<string, string[]>()
  for (const item of [...branches, ...tags]) {
    const refs = decorations.get(item.hashFull) ?? []
    refs.push(item.name)
    decorations.set(item.hashFull, refs)
  }
  if (head) decorations.set(head, ['HEAD', ...(decorations.get(head) ?? [])])
  return { branches, fingerprint, tips, decorations, selected }
}

/** 计算线性历史的状态指纹，限制引用输出与浅克隆边界文件的大小。 */
async function historySnapshot(root: string): Promise<string> {
  const refs = await readGit(root, ['for-each-ref', '--sort=refname', '--format=%(refname)%00%(objectname)'])
  const lines = refs.trimEnd().split('\n').filter(Boolean)
  if (lines.length > MAX_HISTORY_REFS) fail('Too many references to safely snapshot history (limit 100000)', 'graph-limit')
  const head = (await readGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], true)).trim()
  const shallowPath = (await readGit(root, ['rev-parse', '--git-path', 'shallow'])).trim()
  let shallow: string | null = null
  try {
    const bytes = await readFile(resolve(root, shallowPath))
    if (bytes.byteLength > MAX_SHALLOW_BYTES) fail('Shallow boundary metadata exceeds 1 MiB', 'graph-limit')
    shallow = bytes.toString('base64')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return createHash('sha256').update(JSON.stringify({ root, refs: lines, head, shallow })).digest('hex')
}

export interface GitHistoryOptions { cursor?: string; count?: number }
export interface GitHistoryResult { isRepo: boolean; root?: string; entries: GitGraphEntry[]; hasMore: boolean; nextCursor?: string; snapshot: string }

/** 图形界面超过分支上限时读取提交列表，并校验引用、HEAD 和浅克隆边界。 */
export async function gitHistory(cwd: string, options: GitHistoryOptions = {}, selectedRepo?: string): Promise<GitHistoryResult> {
  const count = options.count ?? 50
  if (!Number.isSafeInteger(count) || count < 1) fail('Invalid history count')
  const limit = Math.min(count, 200)
  let cursor: { fingerprint: string; offset: number } | undefined
  if (options.cursor !== undefined) {
    if (typeof options.cursor !== 'string' || options.cursor.length > 512) fail('Invalid history cursor')
    try {
      const parsed = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'))
      if (parsed?.version !== 1 || !/^[a-f0-9]{64}$/.test(parsed.fingerprint) || !Number.isSafeInteger(parsed.offset) || parsed.offset < 1 || parsed.offset > MAX_OFFSET) fail('Invalid history cursor')
      cursor = parsed
    } catch { fail('Invalid history cursor') }
  }
  const root = selectedRepo !== undefined ? await repoRoot(cwd, selectedRepo) : (await readGit(cwd, ['rev-parse', '--show-toplevel'])).trim()
  const before = await historySnapshot(root)
  if (cursor && cursor.fingerprint !== before) fail('History changed; refresh', 'graph-stale')
  const offset = cursor?.offset ?? 0
  const output = await readGit(root, ['log', '--branches', '--remotes', 'HEAD', '--topo-order', '--no-decorate', '--no-show-signature', '--encoding=UTF-8', `--max-count=${limit + 1}`, `--skip=${offset}`, '--format=%H%x00%P%x00%an%x00%ai%x00%s%x00%B%x00', '--'])
  const fields = output.split('\0')
  const entries: GitGraphEntry[] = []
  for (let i = 0; i + 5 < fields.length; i += 6) {
    const hashFull = fields[i]!.trim(), parents = fields[i + 1]!.split(' ').filter(Boolean)
    if (!OID.test(hashFull) || parents.some(parent => !OID.test(parent))) fail('Invalid Git history output', 'git-error')
    entries.push({ hash: hashFull.slice(0, 7), hashFull, parents, author: fields[i + 2]!, date: fields[i + 3]!, subject: fields[i + 4]!, message: fields[i + 5]!, refs: [] })
  }
  if (await historySnapshot(root) !== before) fail('History changed; refresh', 'graph-stale')
  const hasMore = entries.length > limit
  if (hasMore && offset + limit > MAX_OFFSET) fail('History limit reached (10000)', 'graph-limit')
  return { isRepo: true, root, entries: entries.slice(0, limit), hasMore, snapshot: before,
    ...(hasMore ? { nextCursor: Buffer.from(JSON.stringify({ version: 1, fingerprint: before, offset: offset + limit })).toString('base64url') } : {}) }
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
