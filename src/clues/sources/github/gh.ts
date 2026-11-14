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
 * `ClueRuntime.prepareCli` (the shared `github.gh` dependency), and every failure
 * is classified by {@link mapGithubCliFailure} without echoing provider text.
 * When a real list/read/write comes back `auth-required`, the shared
 * connection observation is updated through `runtime.connections.report`
 * (best-effort), so the settings row does not stay `ready` until a manual
 * refresh.
 */
import { tmpdir } from 'node:os'
import { CLUE_MAX_CHECK_RUNS, ClueError, isClueError } from '../../types.ts'
import { runClueProviderRequest } from '../../request-gate.ts'
import type { CliResult, ClueRuntime } from '../../runtime/types.ts'
import { graphqlErrorsOf, mapGithubCliFailure } from './errors.ts'
import {
  GITHUB_CONNECTION_ID,
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
import {
  githubCommentsArgs, githubDiscussionOf, githubReplyParentArgs, githubQuotedReply,
  githubCommentOf, requireGithubCommentBody,
  type GithubDiscussionQuery, type GithubDiscussionPage, type GithubCommentInput,
} from './comments.ts'
import type { ClueCheckState, ClueComment, ClueResourceCheck } from '../../types.ts'

/** Discussion bodies are much larger than browse metadata; bound both bytes and nodes. */
const GITHUB_DISCUSSION_MAX_OUTPUT_BYTES = 8 << 20
// 20 × 65,536 chars × up to 6 JSON escape bytes stays below 8 MiB with metadata.
const GITHUB_DISCUSSION_MAX_PAGE_ITEMS = 20
/** Longest check name the display contract accepts (a matrix leg can be long). */
const GITHUB_CHECK_NAME_MAX = 200

// ── GraphQL documents (minimal fields: a browse page never downloads bodies) ─

/** One issue browse page (issues connection = issues only, never PRs). */
const ISSUE_LIST_QUERY = 'query($owner:String!,$repo:String!,$first:Int!,$after:String,$states:[IssueState!])'
  + '{repository(owner:$owner,name:$repo){issues(first:$first,after:$after,states:$states,'
  + 'orderBy:{field:UPDATED_AT,direction:DESC}){totalCount pageInfo{hasNextPage endCursor} '
  + 'nodes{number title state createdAt updatedAt closedAt url '
  + 'author{login url ... on User{name} ... on Organization{name}} '
  + 'assignees(first:10){nodes{login name url}} labels(first:20){nodes{name}}}}}}'

/** One pull request browse page. */
const PULL_LIST_QUERY = 'query($owner:String!,$repo:String!,$first:Int!,$after:String,$states:[PullRequestState!])'
  + '{repository(owner:$owner,name:$repo){pullRequests(first:$first,after:$after,states:$states,'
  + 'orderBy:{field:UPDATED_AT,direction:DESC}){totalCount pageInfo{hasNextPage endCursor} '
  + 'nodes{number title state isDraft mergedAt headRefName baseRefName headRepository{nameWithOwner} '
  + 'createdAt updatedAt closedAt url reviewDecision mergeable statusCheckRollup{state} '
  + 'author{login url ... on User{name} ... on Organization{name}} '
  + 'assignees(first:10){nodes{login name url}} labels(first:20){nodes{name}}}}}}'

/** One issue read (live; also the repository's archived/permission state). */
const ISSUE_READ_QUERY = 'query($owner:String!,$repo:String!,$number:Int!)'
  + '{repository(owner:$owner,name:$repo){isArchived viewerPermission '
  + 'issue(number:$number){number title body state stateReason createdAt updatedAt closedAt url '
  + 'author{login url ... on User{name} ... on Organization{name}} '
  + 'assignees(first:10){nodes{login name url}} labels(first:20){nodes{name}} '
  + 'comments(first:1){totalCount}}}}'

/**
 * One pull request read (live; includes draft/merged state, PR counts and the
 * individual checks).
 *
 * Only a READ asks for `contexts`: a browse/search row carries the rollup
 * state, so a page of 20 pull requests never downloads 20 check lists.
 */
const PULL_READ_QUERY = 'query($owner:String!,$repo:String!,$number:Int!)'
  + '{repository(owner:$owner,name:$repo){isArchived viewerPermission '
  + 'pullRequest(number:$number){number title body state isDraft merged mergedAt createdAt updatedAt closedAt url '
  + 'author{login url ... on User{name} ... on Organization{name}} '
  + 'assignees(first:10){nodes{login name url}} labels(first:20){nodes{name}} '
  + 'comments(first:1){totalCount} commits(first:1){totalCount} '
  + 'changedFiles additions deletions headRefName baseRefName headRepository{nameWithOwner} '
  + 'reviewDecision mergeable statusCheckRollup{state '
  + `contexts(first:${CLUE_MAX_CHECK_RUNS}){nodes{__typename `
  + '... on CheckRun{name status conclusion detailsUrl} '
  + '... on StatusContext{context state targetUrl}}}}}}}'

/** Same-repository issue search (the query carries the repo/kind qualifiers). */
const SEARCH_ISSUE_QUERY = 'query($q:String!,$first:Int!,$after:String)'
  + '{search(query:$q,type:ISSUE,first:$first,after:$after){issueCount pageInfo{hasNextPage endCursor} '
  + 'nodes{... on Issue{number title state createdAt updatedAt closedAt url '
  + 'author{login url ... on User{name} ... on Organization{name}} '
  + 'assignees(first:10){nodes{login name url}} labels(first:20){nodes{name}}}}}}'

/** Same-repository pull request search. */
const SEARCH_PULL_QUERY = 'query($q:String!,$first:Int!,$after:String)'
  + '{search(query:$q,type:ISSUE,first:$first,after:$after){issueCount pageInfo{hasNextPage endCursor} '
  + 'nodes{... on PullRequest{number title state isDraft mergedAt '
  + 'headRefName baseRefName headRepository{nameWithOwner} createdAt updatedAt closedAt url '
  + 'author{login url ... on User{name} ... on Organization{name}} '
  + 'assignees(first:10){nodes{login name url}} labels(first:20){nodes{name}}}}}}'

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
 * Prepare one gh request before provider admission; only the frozen execution
 * closure runs inside the gate (resolution, environment and cancellation belong to S2).
 */
export async function runGithubCli(
  runtime: ClueRuntime,
  args: readonly string[],
  options: GhRunOptions,
): Promise<CliResult> {
  try {
    const run = await runtime.prepareCli({
      dependencyId: GITHUB_DEPENDENCY_ID,
      args,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    return await runClueProviderRequest(GITHUB_CONNECTION_ID, async () => {
      const result = await run()
      // Let the scheduler observe rate-limit failures before higher-level parsing.
      if (result.exitCode !== 0 || (args[0] === 'api' && args[1] === 'graphql')) {
        const failure = mapGithubCliFailure(result)
        if (failure.category === 'rate-limited') throw failure
      }
      return result
    }, options.signal)
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

/** One person node exposed by GitHub (assignee/author). */
export interface GithubPerson {
  readonly login: string
  readonly name?: string
  readonly url?: string
}

/** One light-weight browse/search candidate. */
export interface GithubListItem {
  readonly number: number
  readonly title: string
  readonly state: string
  readonly createdAt?: string
  readonly updatedAt: string
  readonly closedAt?: string
  readonly url: string
  readonly author?: string
  readonly authorName?: string
  readonly authorUrl?: string
  readonly assignees?: readonly GithubPerson[]
  readonly labels?: readonly string[]
  readonly isDraft?: boolean
  readonly merged?: boolean
  readonly mergedAt?: string
  readonly headRefName?: string
  readonly baseRefName?: string
  readonly headRepository?: string
  readonly review?: 'approved' | 'changes-requested' | 'review-required'
  readonly mergeable?: 'mergeable' | 'conflicting' | 'unknown'
  readonly checks?: 'success' | 'failure' | 'pending' | 'expected' | 'error'
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
  readonly authorName?: string
  readonly authorUrl?: string
  readonly assignees: readonly GithubPerson[]
  readonly url: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly closedAt?: string
  readonly labels: readonly string[]
  readonly commentsCount?: number
  readonly commitsCount?: number
  readonly changedFiles?: number
  readonly additions?: number
  readonly deletions?: number
  readonly headRefName?: string
  readonly baseRefName?: string
  readonly headRepository?: string
  readonly isDraft?: boolean
  readonly merged?: boolean
  readonly mergedAt?: string
  /** Pull request review decision (APPROVED/CHANGES_REQUESTED/REVIEW_REQUIRED). */
  readonly review?: 'approved' | 'changes-requested' | 'review-required'
  /** Pull request mergeability (MERGEABLE/CONFLICTING/UNKNOWN). */
  readonly mergeable?: 'mergeable' | 'conflicting' | 'unknown'
  /** Rollup state of the pull request's status checks. */
  readonly checks?: ClueCheckState
  /** Individual checks of this read (check runs + legacy status contexts). */
  readonly checkRuns?: readonly ClueResourceCheck[]
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
  /** The authoritative snapshot already read by the save path (never extra). */
  readonly snapshot?: GithubResourceSnapshot
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
  listComments?(input: GithubDiscussionQuery, signal?: AbortSignal): Promise<GithubDiscussionPage>
  createComment?(input: GithubCommentInput, signal?: AbortSignal): Promise<ClueComment>
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

/** One optional non-empty string field of an untrusted provider node. */
function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** One optional integer count (null/absent stays absent). */
function countOf(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined
  const total = value.totalCount
  return typeof total === 'number' && Number.isSafeInteger(total) && total >= 0 ? total : undefined
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

/** The user nodes of one `assignees` connection (login is the identity). */
function peopleOf(value: unknown): GithubPerson[] {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return []
  const people: GithubPerson[] = []
  for (const node of value.nodes) {
    if (!isRecord(node) || typeof node.login !== 'string' || node.login === '') continue
    people.push({
      login: node.login,
      ...(stringField(node.name) === undefined ? {} : { name: stringField(node.name) }),
      ...(stringField(node.url) === undefined ? {} : { url: stringField(node.url) }),
    })
  }
  return people
}

/** Map one browse/search node; a malformed node fails the page. */
function listItemOf(value: unknown, kind: GithubKind): GithubListItem {
  if (!isRecord(value)) throw new ClueError('failed', 'the GitHub CLI returned a malformed list response')
  const author = loginOf(value.author)
  const authorRecord = isRecord(value.author) ? value.author : undefined
  const authorName = stringField(authorRecord?.name)
  const authorUrl = stringField(authorRecord?.url)
  const createdAt = stringField(value.createdAt)
  const closedAt = stringField(value.closedAt)
  const assignees = peopleOf(value.assignees)
  const mergedAt = typeof value.mergedAt === 'string' && value.mergedAt !== '' ? value.mergedAt : undefined
  const headRefName = stringField(value.headRefName)
  const baseRefName = stringField(value.baseRefName)
  const headRepositoryRecord = isRecord(value.headRepository) ? value.headRepository : undefined
  const headRepository = stringField(headRepositoryRecord?.nameWithOwner)
  const review = kind === 'pull' ? reviewOf(value.reviewDecision) : undefined
  const mergeable = kind === 'pull' ? mergeableOf(value.mergeable) : undefined
  const checks = kind === 'pull' ? checksOf(value.statusCheckRollup) : undefined
  return {
    number: requireInteger(value.number, 'list response'),
    title: requireString(value.title, 'list response'),
    state: requireString(value.state, 'list response'),
    ...(createdAt === undefined ? {} : { createdAt }),
    updatedAt: requireString(value.updatedAt, 'list response'),
    ...(closedAt === undefined ? {} : { closedAt }),
    url: requireString(value.url, 'list response'),
    ...(author === undefined ? {} : { author }),
    ...(authorName === undefined ? {} : { authorName }),
    ...(authorUrl === undefined ? {} : { authorUrl }),
    ...(assignees.length === 0 ? {} : { assignees }),
    ...(isRecord(value.labels) ? { labels: labelsOf(value.labels) } : {}),
    ...(kind === 'pull' && typeof value.isDraft === 'boolean' ? { isDraft: value.isDraft } : {}),
    ...(kind === 'pull' ? { merged: value.state === 'MERGED' || mergedAt !== undefined } : {}),
    ...(mergedAt === undefined ? {} : { mergedAt }),
    ...(headRefName === undefined ? {} : { headRefName }),
    ...(baseRefName === undefined ? {} : { baseRefName }),
    ...(headRepository === undefined ? {} : { headRepository }),
    ...(review === undefined ? {} : { review }),
    ...(mergeable === undefined ? {} : { mergeable }),
    ...(checks === undefined ? {} : { checks }),
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

/** Normalize the GraphQL review decision; unknown values stay absent. */
function reviewOf(raw: unknown): 'approved' | 'changes-requested' | 'review-required' | undefined {
  if (raw === 'APPROVED') return 'approved'
  if (raw === 'CHANGES_REQUESTED') return 'changes-requested'
  if (raw === 'REVIEW_REQUIRED') return 'review-required'
  return undefined
}

/** Normalize the GraphQL mergeable flag; unknown values stay absent. */
function mergeableOf(raw: unknown): 'mergeable' | 'conflicting' | 'unknown' | undefined {
  if (raw === 'MERGEABLE') return 'mergeable'
  if (raw === 'CONFLICTING') return 'conflicting'
  if (raw === 'UNKNOWN') return 'unknown'
  return undefined
}

/** Normalize the status-check rollup state; an empty rollup stays absent. */
function checksOf(raw: unknown): ClueCheckState | undefined {
  if (!isRecord(raw)) return undefined
  switch (raw.state) {
    case 'SUCCESS': return 'success'
    case 'FAILURE': return 'failure'
    case 'PENDING': return 'pending'
    case 'EXPECTED': return 'expected'
    case 'ERROR': return 'error'
    default: return undefined
  }
}

/**
 * The CI state of one check run.
 *
 * A run that has not finished yet carries no conclusion — that is a queued or
 * running check, not a passing one. Conclusions map onto the shared vocabulary:
 * neutral/skipped/stale never blocked a merge, timeout/action-required did, and
 * a cancelled run is reported as an error rather than silently passing.
 */
function checkRunStateOf(status: string | undefined, conclusion: string | undefined): ClueCheckState | undefined {
  if (conclusion === undefined) return status === undefined ? undefined : 'pending'
  switch (conclusion) {
    case 'SUCCESS':
    case 'NEUTRAL':
    case 'SKIPPED':
    case 'STALE':
      return 'success'
    case 'FAILURE':
    case 'TIMED_OUT':
    case 'ACTION_REQUIRED':
    case 'STARTUP_FAILURE':
      return 'failure'
    case 'CANCELLED':
      return 'error'
    default:
      return undefined
  }
}

/** Legacy status contexts spell the same states in their own enum. */
function statusContextStateOf(state: string | undefined): ClueCheckState | undefined {
  switch (state) {
    case 'SUCCESS': return 'success'
    case 'FAILURE': return 'failure'
    case 'ERROR': return 'error'
    case 'PENDING': return 'pending'
    case 'EXPECTED': return 'expected'
    default: return undefined
  }
}

/**
 * Normalize `statusCheckRollup.contexts.nodes` — check runs and the legacy
 * commit statuses GitHub still reports through the same connection.
 *
 * Absent rollup, absent contexts or an empty node list all answer undefined, so
 * a pull request without CI renders exactly as before. Provider order is kept:
 * ranking failures first is a display decision, not a provider fact.
 */
function checkRunsOf(raw: unknown): readonly ClueResourceCheck[] | undefined {
  if (!isRecord(raw) || !isRecord(raw.contexts) || !Array.isArray(raw.contexts.nodes)) return undefined
  const runs: ClueResourceCheck[] = []
  for (const node of raw.contexts.nodes) {
    if (!isRecord(node)) continue
    const statusContext = node.__typename === 'StatusContext'
    const name = stringField(statusContext ? node.context : node.name)
    if (name === undefined) continue
    const state = statusContext
      ? statusContextStateOf(stringField(node.state))
      : checkRunStateOf(stringField(node.status), stringField(node.conclusion))
    if (state === undefined) continue
    const url = stringField(statusContext ? node.targetUrl : node.detailsUrl)
    runs.push({
      // The provider owns the name; clip rather than drop a long matrix leg.
      name: name.length > GITHUB_CHECK_NAME_MAX ? name.slice(0, GITHUB_CHECK_NAME_MAX - 1) + '…' : name,
      state,
      ...(url === undefined ? {} : { url }),
    })
    if (runs.length >= CLUE_MAX_CHECK_RUNS) break
  }
  return runs.length === 0 ? undefined : runs
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
  const authorRecord = isRecord(node.author) ? node.author : undefined
  const authorName = stringField(authorRecord?.name)
  const authorUrl = stringField(authorRecord?.url)
  const assignees = peopleOf(node.assignees)
  const url = requireString(node.url, 'read response')
  const createdAt = requireString(node.createdAt, 'read response')
  const updatedAt = requireString(node.updatedAt, 'read response')
  const closedAt = stringField(node.closedAt)
  const labels = labelsOf(node.labels)
  const commentsCount = countOf(node.comments)
  const isArchived = repository.isArchived === true
  const viewerPermission = typeof repository.viewerPermission === 'string'
    ? repository.viewerPermission
    : undefined
  let isDraft: boolean | undefined
  let merged: boolean | undefined
  let mergedAt: string | undefined
  let commitsCount: number | undefined
  let changedFiles: number | undefined
  let additions: number | undefined
  let deletions: number | undefined
  let headRefName: string | undefined
  let baseRefName: string | undefined
  let headRepository: string | undefined
  let review: 'approved' | 'changes-requested' | 'review-required' | undefined
  let mergeable: 'mergeable' | 'conflicting' | 'unknown' | undefined
  let checks: ClueCheckState | undefined
  let checkRuns: readonly ClueResourceCheck[] | undefined
  if (resource.kind === 'pull') {
    isDraft = typeof node.isDraft === 'boolean' ? node.isDraft : false
    mergedAt = typeof node.mergedAt === 'string' && node.mergedAt !== '' ? node.mergedAt : undefined
    merged = node.merged === true || state === 'MERGED' || mergedAt !== undefined
    commitsCount = countOf(node.commits)
    // Scalar PR counts (no connection/list is downloaded for them).
    changedFiles = typeof node.changedFiles === 'number' ? node.changedFiles : undefined
    additions = typeof node.additions === 'number' ? node.additions : undefined
    deletions = typeof node.deletions === 'number' ? node.deletions : undefined
    headRefName = stringField(node.headRefName)
    baseRefName = stringField(node.baseRefName)
    const headRepositoryRecord = isRecord(node.headRepository) ? node.headRepository : undefined
    headRepository = stringField(headRepositoryRecord?.nameWithOwner)
    // Read-only provider facts: review decision, conflict state, CI rollup.
    review = reviewOf(node.reviewDecision)
    mergeable = mergeableOf(node.mergeable)
    checks = checksOf(node.statusCheckRollup)
    checkRuns = checkRunsOf(node.statusCheckRollup)
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
    ...(authorName === undefined ? {} : { authorName }),
    ...(authorUrl === undefined ? {} : { authorUrl }),
    assignees,
    url,
    createdAt,
    updatedAt,
    ...(closedAt === undefined ? {} : { closedAt }),
    labels,
    ...(commentsCount === undefined ? {} : { commentsCount }),
    ...(commitsCount === undefined ? {} : { commitsCount }),
    ...(changedFiles === undefined ? {} : { changedFiles }),
    ...(additions === undefined ? {} : { additions }),
    ...(deletions === undefined ? {} : { deletions }),
    ...(headRefName === undefined ? {} : { headRefName }),
    ...(baseRefName === undefined ? {} : { baseRefName }),
    ...(headRepository === undefined ? {} : { headRepository }),
    ...(isDraft === undefined ? {} : { isDraft }),
    ...(merged === undefined ? {} : { merged }),
    ...(mergedAt === undefined ? {} : { mergedAt }),
    ...(review === undefined ? {} : { review }),
    ...(mergeable === undefined ? {} : { mergeable }),
    ...(checks === undefined ? {} : { checks }),
    ...(checkRuns === undefined ? {} : { checkRuns }),
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

  const readResourceOnce = async (
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

  /**
   * Publish the shared "sign-in needed" observation of one real resource
   * failure. This is best-effort: an unregistered/disposed connection must not
   * replace the source's own error with a second one.
   */
  const reportAuthRequired = (error: unknown): void => {
    if (!isClueError(error) || error.category !== 'auth-required') return
    try {
      runtime().connections.report(GITHUB_CONNECTION_ID, {
        configuration: 'not-required',
        authorization: 'expired',
        detail: 'the stored GitHub sign-in is no longer valid',
      })
    } catch {
      // Best-effort observation only.
    }
  }

  /** Run one public resource operation and report an observed auth failure. */
  const withAuthReport = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation()
    } catch (error) {
      reportAuthRequired(error)
      throw error
    }
  }

  return {
    async listPage(query: GithubPageQuery, signal?: AbortSignal): Promise<GithubListPage> {
      return await withAuthReport(async () => {
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
      })
    },

    async readResource(resource: GithubResource, signal?: AbortSignal): Promise<GithubResourceSnapshot> {
      return await withAuthReport(async () => await readResourceOnce(resource, signal))
    },

    async listComments(input, signal) {
      return await withAuthReport(async () => {
        const data = await runGithubGraphql(runtime(), githubCommentsArgs({ ...input, limit: Math.min(input.limit, GITHUB_DISCUSSION_MAX_PAGE_ITEMS) }), {
          cwd, timeoutMs: GITHUB_READ_TIMEOUT_MS, maxOutputBytes: GITHUB_DISCUSSION_MAX_OUTPUT_BYTES,
          ...(signal === undefined ? {} : { signal }),
        })
        return githubDiscussionOf(data, input.resource)
      })
    },

    async createComment(input, signal) {
      return await withAuthReport(async () => {
        requireGithubCommentBody(input.body)
        const common = { cwd, timeoutMs: GITHUB_WRITE_TIMEOUT_MS, maxOutputBytes: GITHUB_READ_MAX_OUTPUT_BYTES,
          ...(signal === undefined ? {} : { signal }) }
        let body = input.body
        if (input.replyToId !== undefined) {
          const parent = await runGithubGraphql(runtime(), githubReplyParentArgs(input.resource, input.replyToId), common)
          body = githubQuotedReply(parent, input)
          requireGithubCommentBody(body)
        } else {
          // The REST comment endpoint serves both kinds; verify the requested source kind first.
          // Repository READ permission is not a comment-write denial: GitHub decides that grant.
          const target = await fetchNode(input.resource, signal)
          if (target.repository.isArchived === true) throw new ClueError('permission-denied', 'the GitHub repository is archived')
        }
        const response = parseGithubJson(await runGithubCli(runtime(), [
          'api', `repos/${input.resource.owner}/${input.resource.repo}/issues/${input.resource.number}/comments`,
          '--hostname', input.resource.host, '--method', 'POST', '--input', '-',
        ], { ...common, stdin: JSON.stringify({ body }) }))
        return { ...githubCommentOf(response, true), ...(input.replyToId === undefined ? {} : { replyToId: input.replyToId, kind: 'reply' as const }) }
      })
    },

    async saveEdits(input: GithubSaveInput, signal?: AbortSignal): Promise<GithubSaveOutcome> {
      return await withAuthReport(async () => {
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
        const fresh = await readResourceOnce(input.resource, signal)
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
        if (!titleChanged && !bodyChanged) {
          return { revision: fresh.revision, savedAt, snapshot: fresh }
        }
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
        // read fails the write is still confirmed, but no revision is
        // fabricated. That same already-needed read is the only source of the
        // returned display snapshot (no extra request for metadata).
        let snapshot: GithubResourceSnapshot | undefined
        try {
          snapshot = await readResourceOnce(input.resource, signal)
        } catch {
          snapshot = undefined
        }
        return {
          ...(snapshot === undefined ? {} : { revision: snapshot.revision }),
          savedAt,
          // NEVER fall back to the PRE-write snapshot: it predates the edit
          // (and would advertise stale state/counts). Display info is optional,
          // so a failed post-save read simply omits it.
          ...(snapshot === undefined ? {} : { snapshot }),
        }
      })
    },
  }
}
