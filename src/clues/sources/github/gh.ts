/**
 * The gh adapter of the GitHub source (S3).
 *
 * Everything provider-specific lives here:
 * - the exact argv (gh api graphql with an explicit host, one repository and
 *   a bounded `first`, never `--paginate`; `gh issue|pr edit` for writes);
 * - the GraphQL envelopes and strict field mapping;
 * - the single-page result shape (provider total only when reported, an
 *   opaque `nextAfter` only when the provider confirms another page, and the
 *   search-index cap as the only `limited` signal);
 * - read freshness (every read is a live fetch) and the kind-mismatch probe;
 * - the best-effort save check: re-read, compare the opaque revision, send
 *   only the changed title/body (body through stdin), then re-read to update
 *   the baseline. It is explicitly NOT an atomic CAS.
 *
 * The adapter never touches credentials itself: it runs through S2's
 * `ClueRuntime.runCli` (the shared `github.gh` dependency), and every failure
 * is classified by {@link mapGithubCliFailure} without echoing provider text.
 */
import { tmpdir } from 'node:os'
import { ClueError, isClueError } from '../../types.ts'
import type { CliResult, ClueRuntime } from '../../runtime/types.ts'
import { graphqlErrorsOf, mapGithubCliFailure } from './errors.ts'
import {
  GITHUB_DEPENDENCY_ID,
  GITHUB_HOST,
  GITHUB_LIST_MAX_OUTPUT_BYTES,
  GITHUB_LIST_TIMEOUT_MS,
  GITHUB_READ_MAX_OUTPUT_BYTES,
  GITHUB_READ_TIMEOUT_MS,
  GITHUB_SEARCH_RESULT_CAP,
  GITHUB_WRITE_TIMEOUT_MS,
  type GithubKind,
  type GithubRepoRef,
  type GithubResource,
  type GithubStateFilter,
} from './ids.ts'
import { githubRevisionOf } from './revision.ts'

// ── GraphQL documents (minimal fields: a browse page never downloads bodies) ─

/** One issue browse page (issues connection = issues only, never PRs). */
const ISSUE_LIST_QUERY = 'query($owner:String!,$repo:String!,$first:Int!,$after:String,$states:[IssueState!])'
  + '{repository(owner:$owner,name:$repo){issues(first:$first,after:$after,states:$states,'
  + 'orderBy:{field:UPDATED_AT,direction:DESC}){totalCount pageInfo{hasNextPage endCursor} '
  + 'nodes{number title state updatedAt url author{login}}}}}'

/** One pull request browse page. */
const PULL_LIST_QUERY = 'query($owner:String!,$repo:String!,$first:Int!,$after:String,$states:[PullRequestState!])'
  + '{repository(owner:$owner,name:$repo){pullRequests(first:$first,after:$after,states:$states,'
  + 'orderBy:{field:UPDATED_AT,direction:DESC}){totalCount pageInfo{hasNextPage endCursor} '
  + 'nodes{number title state isDraft updatedAt url author{login} mergedAt}}}}'

/** One issue read (live; also the repository's archived/permission state). */
const ISSUE_READ_QUERY = 'query($owner:String!,$repo:String!,$number:Int!)'
  + '{repository(owner:$owner,name:$repo){isArchived viewerPermission '
  + 'issue(number:$number){number title body state stateReason createdAt updatedAt url author{login} '
  + 'labels(first:20){nodes{name}}}}}'

/** One pull request read (live; includes draft/merged state). */
const PULL_READ_QUERY = 'query($owner:String!,$repo:String!,$number:Int!)'
  + '{repository(owner:$owner,name:$repo){isArchived viewerPermission '
  + 'pullRequest(number:$number){number title body state isDraft merged mergedAt createdAt updatedAt url '
  + 'author{login} labels(first:20){nodes{name}}}}}'

/** Same-repository issue search (the query carries the repo/kind qualifiers). */
const SEARCH_ISSUE_QUERY = 'query($q:String!,$first:Int!,$after:String)'
  + '{search(query:$q,type:ISSUE,first:$first,after:$after){issueCount pageInfo{hasNextPage endCursor} '
  + 'nodes{... on Issue{number title state updatedAt url author{login}}}}}'

/** Same-repository pull request search. */
const SEARCH_PULL_QUERY = 'query($q:String!,$first:Int!,$after:String)'
  + '{search(query:$q,type:ISSUE,first:$first,after:$after){issueCount pageInfo{hasNextPage endCursor} '
  + 'nodes{... on PullRequest{number title state isDraft updatedAt url author{login} mergedAt}}}}'

/** The state filter's GraphQL enum, or undefined for "all". */
function stateEnum(state: GithubStateFilter): 'OPEN' | 'CLOSED' | undefined {
  if (state === 'open') return 'OPEN'
  if (state === 'closed') return 'CLOSED'
  return undefined
}

/**
 * Build a search query that can only address ONE repository and ONE kind.
 *
 * User text may contain GitHub search qualifiers; `repo:`/`org:`/`user:`
 * could widen the range and `is:`/`state:` could switch the resource kind, so
 * those tokens are dropped before the fixed qualifiers are prepended.
 *
 * @param input - scope, kind and the user's query text.
 */
export function githubSearchQuery(input: {
  readonly repo: GithubRepoRef
  readonly kind: GithubKind
  readonly state: GithubStateFilter
  readonly query: string
}): string {
  const cleaned = input.query
    .replace(/(^|\s)(?:repo|org|user|is|state):[^\s()]+/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  const qualifiers = [
    `repo:${input.repo.owner}/${input.repo.repo}`,
    input.kind === 'issue' ? 'is:issue' : 'is:pr',
  ]
  if (input.state === 'open') qualifiers.push('state:open')
  else if (input.state === 'closed') qualifiers.push('state:closed')
  if (cleaned !== '') qualifiers.push(cleaned)
  return qualifiers.join(' ')
}

/** argv of one browse page. */
export function listArgs(input: {
  readonly kind: GithubKind
  readonly repo: GithubRepoRef
  readonly state: GithubStateFilter
  readonly limit: number
  readonly after?: string
}): string[] {
  const args = [
    'api', 'graphql', '--hostname', GITHUB_HOST,
    '-f', `query=${input.kind === 'issue' ? ISSUE_LIST_QUERY : PULL_LIST_QUERY}`,
    '-f', `owner=${input.repo.owner}`,
    '-f', `repo=${input.repo.repo}`,
    '-F', `first=${input.limit}`,
  ]
  const states = stateEnum(input.state)
  if (states !== undefined) args.push('-F', `states[]=${states}`)
  if (input.after !== undefined) args.push('-f', `after=${input.after}`)
  return args
}

/** argv of one search page. */
export function searchArgs(input: {
  readonly kind: GithubKind
  readonly repo: GithubRepoRef
  readonly state: GithubStateFilter
  readonly limit: number
  readonly query: string
  readonly after?: string
}): string[] {
  const args = [
    'api', 'graphql', '--hostname', GITHUB_HOST,
    '-f', `query=${input.kind === 'issue' ? SEARCH_ISSUE_QUERY : SEARCH_PULL_QUERY}`,
    '-f', `q=${githubSearchQuery(input)}`,
    '-F', `first=${input.limit}`,
  ]
  if (input.after !== undefined) args.push('-f', `after=${input.after}`)
  return args
}

/** argv of one live resource read. */
export function readArgs(resource: GithubResource): string[] {
  return [
    'api', 'graphql', '--hostname', GITHUB_HOST,
    '-f', `query=${resource.kind === 'issue' ? ISSUE_READ_QUERY : PULL_READ_QUERY}`,
    '-f', `owner=${resource.owner}`,
    '-f', `repo=${resource.repo}`,
    '-F', `number=${resource.number}`,
  ]
}

/** argv of one title/body edit (only the changed fields are present). */
export function editArgs(
  resource: GithubResource,
  fields: { readonly title?: string; readonly body?: string },
): string[] {
  const args = [
    resource.kind === 'issue' ? 'issue' : 'pr',
    'edit',
    String(resource.number),
    '-R',
    `${resource.owner}/${resource.repo}`,
  ]
  if (fields.title !== undefined) args.push('--title', fields.title)
  if (fields.body !== undefined) args.push('--body-file', '-')
  return args
}

/** argv of the explicit status check (never run on a timer or a resource op). */
export function authStatusArgs(): string[] {
  return ['auth', 'status', '--hostname', GITHUB_HOST, '--json', 'hosts']
}

/** argv of the explicit web login flow (only started by an explicit connect). */
export function loginArgs(): string[] {
  return [
    'auth', 'login', '--web',
    '--hostname', GITHUB_HOST,
    '--git-protocol', 'https',
    '--clipboard',
  ]
}

// ── Process seam ───────────────────────────────────────────────────────────

/** One gh invocation through S2's shared CLI runner. */
export interface GhRunOptions {
  /** Explicit absolute working directory (never the session's implicit cwd). */
  readonly cwd: string
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly stdin?: string
  readonly signal?: AbortSignal
}

/**
 * Run one gh argv through `ClueRuntime.runCli` (dependency resolution, env
 * allowlist, timeout and cancellation belong to S2).
 */
export async function runGithubCli(
  runtime: ClueRuntime,
  args: readonly string[],
  options: GhRunOptions,
): Promise<CliResult> {
  try {
    return await runtime.runCli({
      dependencyId: GITHUB_DEPENDENCY_ID,
      args,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (error) {
    // The runner already answers the fixed `cancelled`/`timeout`/
    // `dependency-missing` categories; never re-label them as a generic
    // failure (and never echo a message that could carry transport output).
    if (isClueError(error)) throw error
    throw new ClueError('failed', 'the GitHub CLI command could not be run')
  }
}

/** Parse one non-zero/truncated-aware JSON result; a failure is never `[]`. */
export function parseGithubJson(result: CliResult): unknown {
  if (result.stdoutTruncated) {
    throw new ClueError('failed', 'the GitHub CLI output exceeded the capture limit and was not parsed')
  }
  if (result.exitCode !== 0) throw mapGithubCliFailure(result)
  const text = result.stdout.trim()
  if (text === '') throw new ClueError('failed', 'the GitHub CLI returned no JSON output')
  try {
    return JSON.parse(text)
  } catch {
    throw new ClueError('failed', 'the GitHub CLI did not return valid JSON')
  }
}

/** Run one GraphQL document and return its `data` payload. */
async function runGithubGraphql<T>(
  runtime: ClueRuntime,
  args: readonly string[],
  options: GhRunOptions,
): Promise<T> {
  const payload = parseGithubJson(await runGithubCli(runtime, args, options))
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ClueError('failed', 'the GitHub CLI returned an unexpected response')
  }
  const errors = graphqlErrorsOf(payload)
  if (errors.length > 0) {
    // Defensive: gh normally exits non-zero for GraphQL errors, but an exit 0
    // with an errors array must not be treated as success.
    throw mapGithubCliFailure({
      exitCode: 1,
      stdout: JSON.stringify(payload),
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 0,
    })
  }
  if (!('data' in payload)) {
    throw new ClueError('failed', 'the GitHub CLI returned an unexpected response')
  }
  return (payload as { data: T }).data
}

// ── Result shapes ──────────────────────────────────────────────────────────

/** One light-weight browse/search candidate. */
export interface GithubListItem {
  readonly number: number
  readonly title: string
  readonly state: string
  readonly updatedAt: string
  readonly url: string
  readonly author?: string
  readonly isDraft?: boolean
  readonly merged?: boolean
  readonly mergedAt?: string
}

/** One provider page. */
export interface GithubListPage {
  readonly items: readonly GithubListItem[]
  /** The provider-reported exact total, absent when it did not report one. */
  readonly total?: number
  /** Provider cursor of the next page; absent when the provider has no more. */
  readonly nextAfter?: string
  /** The provider's search-index cap was reached (not a normal next page). */
  readonly limited?: boolean
}

/** One live resource read. */
export interface GithubResourceSnapshot {
  readonly resource: GithubResource
  readonly title: string
  readonly body: string
  readonly state: string
  readonly stateReason?: string
  readonly author?: string
  readonly url: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly labels: readonly string[]
  readonly isDraft?: boolean
  readonly merged?: boolean
  readonly mergedAt?: string
  readonly isArchived: boolean
  readonly viewerPermission?: string
  /** Opaque check-before-save baseline (updatedAt + content fingerprint). */
  readonly revision: string
}

/** One edit request (validation happens in the source operations layer too). */
export interface GithubSaveInput {
  readonly resource: GithubResource
  readonly title: string
  readonly body: string
  /** The revision `loadEdit` handed out; required for the comparison. */
  readonly baseRevision?: string
}

/** One confirmed save. `revision` is absent when the post-save re-read failed. */
export interface GithubSaveOutcome {
  readonly revision?: string
  readonly savedAt: string
}

/** One page request: a browse page or a same-repository search page. */
export interface GithubPageQuery {
  readonly kind: GithubKind
  readonly repo: GithubRepoRef
  readonly state: GithubStateFilter
  readonly limit: number
  readonly after?: string
  /** Absent for a browse page; present (non-empty) for a search page. */
  readonly query?: string
}

/** The provider-facing client shared by both GitHub sources. */
export interface GithubGhClient {
  listPage(query: GithubPageQuery, signal?: AbortSignal): Promise<GithubListPage>
  readResource(resource: GithubResource, signal?: AbortSignal): Promise<GithubResourceSnapshot>
  saveEdits(input: GithubSaveInput, signal?: AbortSignal): Promise<GithubSaveOutcome>
}

/** Options of {@link createGithubGhClient}. */
export interface GithubGhOptions {
  /** Lazy runtime accessor (S9 installs the runtime after the sources). */
  readonly runtime: () => ClueRuntime
  readonly now?: () => string
  /** Explicit absolute working directory for every gh call. */
  readonly cwd?: string
}

/** Whether a value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A required string field of an untrusted provider node. */
function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string') {
    throw new ClueError('failed', `the GitHub CLI returned a malformed ${what}`)
  }
  return value
}

/** A required integer field of an untrusted provider node. */
function requireInteger(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ClueError('failed', `the GitHub CLI returned a malformed ${what}`)
  }
  return value
}

/** The optional `author.login` summary. */
function loginOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  return typeof value.login === 'string' && value.login !== '' ? value.login : undefined
}

/** The label names of one node. */
function labelsOf(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return []
  const labels: string[] = []
  for (const node of value.nodes) {
    if (isRecord(node) && typeof node.name === 'string' && node.name !== '') labels.push(node.name)
  }
  return labels
}

/** Map one browse/search node; a malformed node fails the page. */
function listItemOf(value: unknown, kind: GithubKind): GithubListItem {
  if (!isRecord(value)) throw new ClueError('failed', 'the GitHub CLI returned a malformed list response')
  const author = loginOf(value.author)
  const mergedAt = typeof value.mergedAt === 'string' && value.mergedAt !== '' ? value.mergedAt : undefined
  return {
    number: requireInteger(value.number, 'list response'),
    title: requireString(value.title, 'list response'),
    state: requireString(value.state, 'list response'),
    updatedAt: requireString(value.updatedAt, 'list response'),
    url: requireString(value.url, 'list response'),
    ...(author === undefined ? {} : { author }),
    ...(kind === 'pull' && typeof value.isDraft === 'boolean' ? { isDraft: value.isDraft } : {}),
    ...(kind === 'pull' ? { merged: value.state === 'MERGED' || mergedAt !== undefined } : {}),
    ...(mergedAt === undefined ? {} : { mergedAt }),
  }
}

/** Map one provider page (list or search) strictly. */
function pageOf(kind: GithubKind, connection: unknown): GithubListPage {
  if (!isRecord(connection)) {
    throw new ClueError('failed', 'the GitHub CLI returned a malformed list response')
  }
  const nodes = connection.nodes
  if (!Array.isArray(nodes)) {
    throw new ClueError('failed', 'the GitHub CLI returned a malformed list response')
  }
  const rawTotal = connection.totalCount ?? connection.issueCount
  const total = typeof rawTotal === 'number' && Number.isFinite(rawTotal) && rawTotal >= 0
    ? rawTotal
    : undefined
  const pageInfo = isRecord(connection.pageInfo) ? connection.pageInfo : undefined
  const hasNext = pageInfo?.hasNextPage === true
  const endCursor = typeof pageInfo?.endCursor === 'string' && pageInfo.endCursor !== ''
    ? pageInfo.endCursor
    : undefined
  return {
    items: nodes.map(node => listItemOf(node, kind)),
    ...(total === undefined ? {} : { total }),
    ...(hasNext && endCursor !== undefined ? { nextAfter: endCursor } : {}),
  }
}

/** The `repository` object of one GraphQL payload, or a fixed not-found. */
function repositoryOf(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) {
    throw new ClueError('failed', 'the GitHub CLI returned an unexpected response')
  }
  const repository = data.repository
  if (repository === null) {
    throw new ClueError('not-found', 'the GitHub repository was not found or is not visible to this account')
  }
  if (!isRecord(repository)) {
    throw new ClueError('failed', 'the GitHub CLI returned an unexpected response')
  }
  return repository
}

/** Build the read snapshot (and the opaque revision) of one node. */
function snapshotOf(
  resource: GithubResource,
  repository: Record<string, unknown>,
  node: Record<string, unknown>,
): GithubResourceSnapshot {
  const number = requireInteger(node.number, 'read response')
  if (number !== resource.number) {
    throw new ClueError('failed', 'the GitHub CLI returned an unexpected resource')
  }
  const title = requireString(node.title, 'read response')
  const body = typeof node.body === 'string' ? node.body : ''
  const state = requireString(node.state, 'read response')
  const stateReason = typeof node.stateReason === 'string' && node.stateReason !== ''
    ? node.stateReason
    : undefined
  const author = loginOf(node.author)
  const url = requireString(node.url, 'read response')
  const createdAt = requireString(node.createdAt, 'read response')
  const updatedAt = requireString(node.updatedAt, 'read response')
  const labels = labelsOf(node.labels)
  const isArchived = repository.isArchived === true
  const viewerPermission = typeof repository.viewerPermission === 'string'
    ? repository.viewerPermission
    : undefined
  let isDraft: boolean | undefined
  let merged: boolean | undefined
  let mergedAt: string | undefined
  if (resource.kind === 'pull') {
    isDraft = typeof node.isDraft === 'boolean' ? node.isDraft : false
    mergedAt = typeof node.mergedAt === 'string' && node.mergedAt !== '' ? node.mergedAt : undefined
    merged = node.merged === true || state === 'MERGED' || mergedAt !== undefined
  }
  const revision = githubRevisionOf({
    updatedAt,
    title,
    body,
    state,
    ...(isDraft === undefined ? {} : { isDraft }),
    ...(merged === undefined ? {} : { merged }),
    ...(stateReason === undefined ? {} : { stateReason }),
  })
  return {
    resource,
    title,
    body,
    state,
    ...(stateReason === undefined ? {} : { stateReason }),
    ...(author === undefined ? {} : { author }),
    url,
    createdAt,
    updatedAt,
    labels,
    ...(isDraft === undefined ? {} : { isDraft }),
    ...(merged === undefined ? {} : { merged }),
    ...(mergedAt === undefined ? {} : { mergedAt }),
    isArchived,
    ...(viewerPermission === undefined ? {} : { viewerPermission }),
    revision,
  }
}

/** Permission values that cannot write, so an edit is refused before gh. */
const READ_ONLY_PERMISSIONS: ReadonlySet<string> = new Set(['READ', 'NONE'])

/**
 * Create the provider-facing client.
 * @param options - lazy runtime, clock and the explicit working directory.
 */
export function createGithubGhClient(options: GithubGhOptions): GithubGhClient {
  const now = options.now ?? (() => new Date().toISOString())
  const cwd = options.cwd ?? tmpdir()
  const runtime = (): ClueRuntime => options.runtime()

  /** One live read of exactly one kind (no mismatch probe). */
  const fetchNode = async (
    resource: GithubResource,
    signal: AbortSignal | undefined,
  ): Promise<{ repository: Record<string, unknown>; node: Record<string, unknown> }> => {
    const data = await runGithubGraphql<unknown>(runtime(), readArgs(resource), {
      cwd,
      timeoutMs: GITHUB_READ_TIMEOUT_MS,
      maxOutputBytes: GITHUB_READ_MAX_OUTPUT_BYTES,
      ...(signal === undefined ? {} : { signal }),
    })
    const repository = repositoryOf(data)
    const rawNode = resource.kind === 'issue' ? repository.issue : repository.pullRequest
    if (rawNode === null || rawNode === undefined) {
      throw new ClueError('not-found', 'the GitHub resource was not found or is not visible to this account')
    }
    if (!isRecord(rawNode)) {
      throw new ClueError('failed', 'the GitHub CLI returned an unexpected response')
    }
    return { repository, node: rawNode }
  }

  const readResource = async (
    resource: GithubResource,
    signal?: AbortSignal,
  ): Promise<GithubResourceSnapshot> => {
    try {
      const { repository, node } = await fetchNode(resource, signal)
      return snapshotOf(resource, repository, node)
    } catch (error) {
      // A number that does not resolve as the URL-named kind may still exist
      // as the OTHER kind; that is a type mismatch, not a missing resource.
      if (isClueError(error) && error.category === 'not-found') {
        const otherKind: GithubKind = resource.kind === 'issue' ? 'pull' : 'issue'
        const other: GithubResource = { ...resource, kind: otherKind }
        let otherExists = false
        try {
          await fetchNode(other, signal)
          otherExists = true
        } catch (otherError) {
          if (
            isClueError(otherError)
            && (otherError.category === 'cancelled' || otherError.category === 'timeout')
          ) {
            throw otherError
          }
        }
        if (otherExists) {
          throw new ClueError(
            'unsupported',
            `the GitHub resource at ${resource.owner}/${resource.repo}#${resource.number} is a `
            + `${otherKind === 'pull' ? 'pull request' : 'issue'}, not a ${resource.kind}`,
          )
        }
      }
      throw error
    }
  }

  return {
    async listPage(query: GithubPageQuery, signal?: AbortSignal): Promise<GithubListPage> {
      const common = {
        cwd,
        timeoutMs: GITHUB_LIST_TIMEOUT_MS,
        maxOutputBytes: GITHUB_LIST_MAX_OUTPUT_BYTES,
        ...(signal === undefined ? {} : { signal }),
      }
      if (query.query !== undefined) {
        const data = await runGithubGraphql<unknown>(runtime(), searchArgs({
          kind: query.kind,
          repo: query.repo,
          state: query.state,
          query: query.query,
          limit: query.limit,
          ...(query.after === undefined ? {} : { after: query.after }),
        }), common)
        if (!isRecord(data) || !isRecord(data.search)) {
          throw new ClueError('failed', 'the GitHub CLI returned a malformed search response')
        }
        const page = pageOf(query.kind, data.search)
        const capped = page.total !== undefined && page.total > GITHUB_SEARCH_RESULT_CAP
        return { ...page, ...(capped ? { limited: true } : {}) }
      }
      const data = await runGithubGraphql<unknown>(runtime(), listArgs({
        kind: query.kind,
        repo: query.repo,
        state: query.state,
        limit: query.limit,
        ...(query.after === undefined ? {} : { after: query.after }),
      }), common)
      const repository = repositoryOf(data)
      const connection = query.kind === 'issue' ? repository.issues : repository.pullRequests
      return pageOf(query.kind, connection)
    },

    readResource,

    async saveEdits(input: GithubSaveInput, signal?: AbortSignal): Promise<GithubSaveOutcome> {
      const baseRevision = input.baseRevision
      if (typeof baseRevision !== 'string' || baseRevision === '') {
        throw new ClueError('invalid-request', 'saving GitHub content needs the base revision from the editor load')
      }
      const title = input.title.trim()
      if (title === '') {
        throw new ClueError('invalid-request', 'a GitHub issue or pull request title cannot be empty')
      }
      // Best-effort check-before-save: re-read the CURRENT resource and compare
      // the opaque revision. This is not atomic; a concurrent edit can still
      // land between this read and the write.
      const fresh = await readResource(input.resource, signal)
      if (fresh.revision !== baseRevision) {
        throw new ClueError(
          'conflict',
          'the GitHub resource changed since it was loaded; re-read it before saving',
        )
      }
      if (fresh.isArchived) {
        throw new ClueError('permission-denied', 'the GitHub repository is archived and read-only')
      }
      if (fresh.viewerPermission !== undefined && READ_ONLY_PERMISSIONS.has(fresh.viewerPermission)) {
        throw new ClueError(
          'permission-denied',
          'the GitHub account has read-only permission for this repository',
        )
      }
      const titleChanged = title !== fresh.title
      const bodyChanged = input.body !== fresh.body
      const savedAt = now()
      if (!titleChanged && !bodyChanged) return { revision: fresh.revision, savedAt }
      const result = await runGithubCli(runtime(), editArgs(input.resource, {
        ...(titleChanged ? { title } : {}),
        ...(bodyChanged ? { body: input.body } : {}),
      }), {
        cwd,
        timeoutMs: GITHUB_WRITE_TIMEOUT_MS,
        maxOutputBytes: GITHUB_READ_MAX_OUTPUT_BYTES,
        ...(bodyChanged ? { stdin: input.body } : {}),
        ...(signal === undefined ? {} : { signal }),
      })
      if (result.exitCode !== 0 || result.stdoutTruncated) {
        throw mapGithubCliFailure(result)
      }
      // Success is exit 0. The new baseline is re-read best-effort: if that
      // read fails the write is still confirmed, but no revision is fabricated.
      let revision: string | undefined
      try {
        revision = (await readResource(input.resource, signal)).revision
      } catch {
        revision = undefined
      }
      return { ...(revision === undefined ? {} : { revision }), savedAt }
    },
  }
}
