/**
 * S3 gh adapter contract (fake runtime; NO real gh, no network, no account).
 *
 * Pins the adapter's only reasons to exist: argv arrays only (`gh api graphql`
 * with an explicit host/repo, one page via `first`/`after`, never `--paginate`,
 * shared `github.gh` id); browse/search scoped to one `owner/repo` and kind
 * with widening qualifiers stripped; provider total/`nextAfter`/`limited` only
 * when the provider says so; strict JSON failures (never an empty page); live
 * issue/PR reads with a kind mismatch reported as unsupported; saveEdit re-read
 * + `conflict` on a stale baseline, only changed fields sent (body via stdin),
 * fixed permission/rate-limit/cancel/timeout categories with no stderr echo;
 * and a real 401 reported as `expired` to the shared connection, best-effort.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
vi.mock('../src/clues/request-gate.ts', () => vi.importActual('./fixtures/clues-source-request-gate.ts'))
import { ClueError } from '../src/clues/error.ts'
import type { CliResult, CliRunRequest, ClueRuntime } from '../src/clues/runtime/types.ts'
import {
  createGithubGhClient, githubSearchQuery, type GithubGhClient, type GithubPageQuery,
} from '../src/clues/sources/github/gh.ts'
import { GITHUB_CONNECTION_ID, GITHUB_DEPENDENCY_ID, type GithubResource } from '../src/clues/sources/github/ids.ts'
import { githubRevisionOf } from '../src/clues/sources/github/revision.ts'
const NOW = '2026-10-17T00:00:00.000Z'
const CWD = '/tmp/clues-github-adapter'
const ISSUE: GithubResource = { host: 'github.com', owner: 'cli', repo: 'cli', kind: 'issue', number: 14609 }
const PULL: GithubResource = { ...ISSUE, kind: 'pull', number: 14727 }
const REPO = { owner: 'cli', repo: 'cli' } as const
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/clues-github/${name}`, import.meta.url), 'utf8')
const cliResult = (overrides: Partial<CliResult> = {}): CliResult => ({
  exitCode: 0, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 1, ...overrides,
})
interface ReportedInspection { readonly connectionId: string; readonly authorization?: string }
interface FakeRuntime { readonly runtime: ClueRuntime; readonly runs: CliRunRequest[]; readonly reports: ReportedInspection[] }
/** A runtime whose only real verbs are `runCli` and the auth observation. */
function fakeRuntime(handler: (request: CliRunRequest) => CliResult | Promise<CliResult>): FakeRuntime {
  const runs: CliRunRequest[] = []
  const reports: ReportedInspection[] = []
  const runtime = {
    connections: { report: (connectionId: string, inspection: { authorization?: string }) => {
      reports.push({ connectionId, ...(inspection.authorization === undefined ? {} : { authorization: inspection.authorization }) })
    } },
    prepareCli: async (request: CliRunRequest) => () => runtime.runCli(request),
    runCli: async (request: CliRunRequest): Promise<CliResult> => { runs.push(request); return await handler(request) },
  } as unknown as ClueRuntime
  return { runtime, runs, reports }
}
const clientOf = (fake: FakeRuntime): GithubGhClient =>
  createGithubGhClient({ runtime: () => fake.runtime, cwd: CWD, now: () => NOW })
/** The value of one `-f`/`-F` `key=value` argument. */
function argValue(args: readonly string[], key: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (!['-f', '-F', '--field', '--raw-field'].includes(args[index] ?? '')) continue
    const pair = args[index + 1]
    if (pair !== undefined && pair.startsWith(`${key}=`)) return pair.slice(key.length + 1)
  }
  return undefined
}
const listQuery = (overrides: Partial<GithubPageQuery> = {}): GithubPageQuery =>
  ({ kind: 'issue', repo: REPO, state: 'open', limit: 30, ...overrides })
const listJson = (connection: unknown): string =>
  JSON.stringify({ data: { repository: { issues: connection } } })
/** The pull-read fixture with selected PR fields replaced. */
function pullRead(overrides: Record<string, unknown>): string {
  const payload = JSON.parse(fixture('pull-read.json')) as { data: { repository: { pullRequest: Record<string, unknown> } } }
  Object.assign(payload.data.repository.pullRequest, overrides)
  return JSON.stringify(payload)
}

describe.each(['issue', 'pull'] as const)('%s GraphQL request completeness', (kind) => {
  it.each(['browse', 'search', 'read'] as const)('closes every selection set in the actual %s CLI request', async (operation) => {
    const name = operation === 'search' ? `search-${kind === 'issue' ? 'issues' : 'pulls'}.json` : `${kind}-${operation === 'browse' ? 'list' : 'read'}.json`
    const fake = fakeRuntime(() => cliResult({ stdout: fixture(name) }))
    if (operation === 'read') await clientOf(fake).readResource(kind === 'issue' ? ISSUE : PULL)
    else await clientOf(fake).listPage(listQuery({ kind, ...(operation === 'search' ? { query: 'cache' } : {}) }))
    // A canned response cannot detect a query GitHub rejects before execution.
    const query = argValue(fake.runs[0]!.args, 'query')!
    let depth = 0
    for (const char of query) {
      if (char === '{') depth += 1
      if (char === '}') depth -= 1
      expect(depth, 'a selection set cannot close before it opens').toBeGreaterThanOrEqual(0)
    }
    expect(depth, 'the GraphQL operation must close its outer selection set').toBe(0)
  })
})

describe('browse and search argv', () => {
  it('asks gh for ONE explicit repository page, maps the state filter and never uses --paginate', async () => {
    const fake = fakeRuntime(() => cliResult({ stdout: fixture('issue-list.json') }))
    const page = await clientOf(fake).listPage(listQuery())
    const request = fake.runs[0]!
    const query = argValue(request.args, 'query')!
    expect(fake.runs).toHaveLength(1)
    expect([request.dependencyId, request.cwd, request.args.slice(0, 3)])
      .toEqual([GITHUB_DEPENDENCY_ID, CWD, ['api', 'graphql', '--hostname']])
    expect(['owner', 'repo', 'first', 'states[]'].map(key => argValue(request.args, key)))
      .toEqual(['cli', 'cli', '30', 'OPEN'])
    for (const fragment of ['issues(first:$first', '$states:[IssueState!]', 'createdAt updatedAt closedAt',
      'author{login url avatarUrl(size:48) ... on User{name} ... on Organization{name}}',
      'assignees(first:10){nodes{login name url}}', 'labels(first:20){nodes{name}}']) expect(query).toContain(fragment)
    expect(request.args.join(' ')).not.toContain('--paginate')
    expect(page.items).toHaveLength(2)
    expect(page.items[0]).toEqual({
      number: 14728, title: '[aw] Dependabot PR Triage (skills-driven) exceeded daily AI credits budget',
      state: 'OPEN', createdAt: '2026-10-17T19:30:00Z', updatedAt: '2026-10-17T19:43:04Z',
      url: 'https://github.com/cli/cli/issues/14728', author: 'cli-triage', authorName: 'CLI Triage',
      authorUrl: 'https://github.com/apps/cli-triage',
      assignees: [{ login: 'octocat', name: 'The Octocat', url: 'https://github.com/octocat' }], labels: ['triage'],
    })
    // Absent provider fields stay absent (no empty arrays/people invented).
    expect(page.items[1]).toEqual({ number: 14732, title: 'แบบร่างจำลอง', state: 'OPEN', updatedAt: '2026-10-17T19:32:31Z', url: 'https://github.com/cli/cli/issues/14732', author: 'phatcharaporn1134' })
    expect([page.items[1]?.assignees, page.items[1]?.labels, page.items[1]?.authorName]).toEqual([undefined, undefined, undefined])
    expect([page.total, page.nextAfter, page.limited]).toEqual([1038, 'Y3Vyc29yOnYyOpK0MjAyNi0xMC0xN1QxOTozMjozMVrPAAAAAV_M_JY=', undefined])
    // "closed" maps to the enum; "all" omits the filter instead of inventing one.
    const states: Array<string | undefined> = []
    for (const state of ['closed', 'all'] as const) {
      const probe = fakeRuntime(() => cliResult({ stdout: fixture('issue-list.json') }))
      await clientOf(probe).listPage(listQuery({ state }))
      states.push(argValue(probe.runs[0]!.args, 'states[]'))
    }
    expect(states).toEqual(['CLOSED', undefined])
  })
  it('uses the pull request connection for the pull kind and carries draft/merged data', async () => {
    const fake = fakeRuntime(() => cliResult({ stdout: fixture('pull-list.json') }))
    const page = await clientOf(fake).listPage(listQuery({ kind: 'pull' }))
    const args = fake.runs[0]!.args
    const query = argValue(args, 'query')!
    for (const fragment of ['pullRequests(first:$first', 'PullRequestState', 'headRefName baseRefName headRepository{nameWithOwner}',
      // A browse page carries the rollup only: no page downloads check lists.
      'reviewDecision mergeable statusCheckRollup{state} ', 'assignees(first:10){nodes{login name url}}']) {
      expect(query).toContain(fragment)
    }
    expect([query.includes('contexts('), argValue(args, 'states[]'), page.total]).toEqual([false, 'OPEN', 71])
    expect(page.items[0]).toMatchObject({ isDraft: false, review: 'approved', mergeable: 'mergeable', checks: 'success', headRefName: 'fix/type-resolution', baseRefName: 'trunk', headRepository: 'umairnaeem0309/cli' })
    expect(page.items[1]).toMatchObject({ state: 'MERGED', merged: true, mergedAt: '2026-10-17T10:03:56Z', closedAt: '2026-10-17T10:03:56Z' })
  })
  it('continues with the provider cursor of the previous page and stops when it is exhausted', async () => {
    const fake = fakeRuntime(() => cliResult({ stdout: listJson({
      totalCount: 2, pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ number: 1, title: 'first', state: 'OPEN', updatedAt: '2026-10-17T00:00:00Z', url: 'https://github.com/cli/cli/issues/1', author: null }],
    }) }))
    const page = await clientOf(fake).listPage(listQuery({ after: 'PROVIDER_CURSOR' }))
    expect([argValue(fake.runs[0]!.args, 'after'), page.nextAfter, page.items[0]?.author]).toEqual(['PROVIDER_CURSOR', undefined, undefined])
  })
  it('scopes search to one repository and kind, and marks only the index cap limited', async () => {
    const fake = fakeRuntime(() => cliResult({ stdout: fixture('search-issues.json') }))
    const page = await clientOf(fake).listPage(listQuery({ limit: 20, query: 'repo:evil/repo org:other is:pr state:closed release bug' }))
    const args = fake.runs[0]!.args
    const q = argValue(args, 'q')!
    expect(q).toBe('repo:cli/cli is:issue state:open release bug')
    expect([q.match(/repo:/g)?.length, q.includes('evil'), q.includes('is:pr'), argValue(args, 'first')]).toEqual([1, false, false, '20'])
    expect(argValue(args, 'query')).toContain('search(query:$q')
    expect([page.total, page.limited, page.items[0]?.number]).toEqual([519, undefined, 14609])
    // Only the documented 1000-result index cap sets `limited`.
    const payload = JSON.parse(fixture('search-issues.json')) as { data: { search: { issueCount: number } } }
    payload.data.search.issueCount = 1500
    const capped = await clientOf(fakeRuntime(() => cliResult({ stdout: JSON.stringify(payload) }))).listPage(listQuery({ query: 'release' }))
    expect([capped.total, capped.limited]).toEqual([1500, true])
    // A pull search stays in pulls; an empty query contributes no `q` text.
    expect([
      githubSearchQuery({ repo: REPO, kind: 'pull', state: 'all', query: 'fix (bug OR crash)' }),
      githubSearchQuery({ repo: REPO, kind: 'issue', state: 'closed', query: '  ' }),
    ]).toEqual(['repo:cli/cli is:pr fix (bug OR crash)', 'repo:cli/cli is:issue state:closed'])
  })
})

describe('read', () => {
  it('reads the live issue with metadata, labels and repository state', async () => {
    const fake = fakeRuntime(() => cliResult({ stdout: fixture('issue-read.json') }))
    const snapshot = await clientOf(fake).readResource(ISSUE)
    const args = fake.runs[0]!.args
    const query = argValue(args, 'query')!
    expect([query.includes('issue(number:$number)'), query.includes('author{login url'), query.includes('assignees(first:10){nodes{login name url}}'), query.includes('comments(first:1){totalCount}')]).toEqual([true, true, true, true])
    expect(['number', 'owner', 'repo'].map(key => argValue(args, key))).toEqual(['14609', 'cli', 'cli'])
    expect(snapshot).toMatchObject({
      resource: ISSUE, title: 'gh release list -R https://github.com/cli/cli/ -> error', state: 'OPEN',
      author: 'tps800', authorName: 'TPS', authorUrl: 'https://github.com/tps800',
      assignees: [{ login: 'octocat', name: 'The Octocat', url: 'https://github.com/octocat' }], commentsCount: 7,
      url: 'https://github.com/cli/cli/issues/14609', createdAt: '2026-10-05T09:12:00Z',
      updatedAt: '2026-10-16T07:44:20Z', labels: ['bug', 'release'], isArchived: false, viewerPermission: 'READ',
    })
    expect(snapshot.body).toContain('### Describe the bug')
    expect([snapshot.closedAt, snapshot.isDraft]).toEqual([undefined, undefined])
    expect(snapshot.revision).toBe(githubRevisionOf({ updatedAt: '2026-10-16T07:44:20Z', title: 'gh release list -R https://github.com/cli/cli/ -> error', body: snapshot.body, state: 'OPEN', stateReason: null }))
  })
  it('carries the PR-only draft/merged fields, counts and checks in one request', async () => {
    const fake = fakeRuntime(() => cliResult({ stdout: fixture('pull-read.json') }))
    const snapshot = await clientOf(fake).readResource(PULL)
    const query = argValue(fake.runs[0]!.args, 'query')!
    for (const fragment of ['pullRequest(number:$number)', 'commits(first:1){totalCount}', 'changedFiles additions deletions',
      'headRefName headRefOid baseRefName headRepository{nameWithOwner}', 'reviewDecision mergeable mergeStateStatus statusCheckRollup{state contexts(first:20)',
      'contexts(first:20){totalCount nodes{__typename', '... on CheckRun{name status conclusion detailsUrl}',
      '... on StatusContext{context state targetUrl}']) expect(query).toContain(fragment)
    // Read-only review/CI/mergeability facts are normalized, never invented.
    expect(snapshot).toMatchObject({
      isDraft: false, merged: false, viewerPermission: 'TRIAGE', labels: ['bug'], commentsCount: 5,
      headRefName: 'fix/type-resolution', baseRefName: 'trunk', headRepository: 'umairnaeem0309/cli',
      review: 'approved', mergeable: 'mergeable', checks: 'success', commitsCount: 12, changedFiles: 3,
      additions: 42, deletions: 7, checkCount: 28, mergeStatus: 'ready',
      imageRef: '2345678abc012345678abc012345678abc0123456',
      authorAvatarUrl: 'https://avatars.githubusercontent.com/u/1234?v=4',
      // Individual checks ride the SAME read (one request); an inconclusive run is pending.
      checkRuns: [
        { name: 'build (macos)', state: 'success', url: 'https://github.com/cli/cli/runs/1' },
        { name: 'test (ubuntu)', state: 'pending', url: 'https://github.com/cli/cli/runs/2' },
        { name: 'lint', state: 'failure', url: 'https://github.com/cli/cli/runs/3' },
        { name: 'ci/circleci: docs', state: 'success', url: 'https://circleci.example/1' },
      ],
    })
    expect([snapshot.mergedAt, fake.runs.length]).toEqual([undefined, 1])
  })
  it('normalizes check runs: drops unusable nodes, stays absent when empty, bounds and clips', async () => {
    const read = (rollup: unknown) => clientOf(fakeRuntime(() => cliResult({ stdout: pullRead({ statusCheckRollup: rollup }) }))).readResource(PULL)
    // Known names are retained even for new GitHub conclusions; a nameless node cannot render.
    const nodes = [
      { __typename: 'CheckRun', name: 'novel', status: 'COMPLETED', conclusion: 'SOMETHING_NEW' },
      { __typename: 'CheckRun', conclusion: 'SUCCESS', detailsUrl: 'https://ci.example/1' },
      { __typename: 'StatusContext', context: 'ci/legacy', state: 'EXPECTED' },
      { __typename: 'CheckRun', name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'CheckRun', name: 'nightly', status: 'COMPLETED', conclusion: 'CANCELLED' },
    ]
    const snapshot = await read({ state: 'PENDING', contexts: { nodes } })
    expect([snapshot.checks, snapshot.checkRuns]).toEqual(['pending', [
      { name: 'novel', state: 'unknown' }, { name: 'ci/legacy', state: 'expected' },
      { name: 'docs', state: 'skipped' }, { name: 'nightly', state: 'cancelled' },
    ]])
    // No rollup contexts at all (or an empty node list) stays absent.
    for (const rollup of [{ state: 'PENDING' }, { state: 'PENDING', contexts: { nodes: [] } }]) expect((await read(rollup)).checkRuns).toBeUndefined()
    // Bounded to 20 in provider order, with a name clipped to the display limit.
    const check = (name: string) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS' })
    const clipped = await read({ state: 'SUCCESS', contexts: { nodes: [check('x'.repeat(400)), ...Array.from({ length: 24 }, (_unused, index) => check(`job-${index + 1}`))] } })
    expect([clipped.checkRuns?.length, clipped.checkRuns?.[0]?.name.length, clipped.checkRuns?.[0]?.name.endsWith('…'), clipped.checkRuns?.[19]?.name])
      .toEqual([20, 200, true, 'job-19'])
  })
  it('reports unsupported for a kind mismatch and not-found when nothing resolves', async () => {
    const missing = (kind: 'Issue' | 'PullRequest'): string => JSON.stringify({
      data: { repository: { isArchived: false, viewerPermission: 'READ', [kind === 'Issue' ? 'issue' : 'pullRequest']: null } },
      errors: [{ type: 'NOT_FOUND', message: `Could not resolve to an ${kind} with the number of 1.` }],
    })
    const isIssue = (request: CliRunRequest): boolean => (argValue(request.args, 'query') ?? '').includes('issue(number:$number)')
    const fail = (stdout: string, stderr: string): CliResult => cliResult({ exitCode: 1, stdout, stderr })
    const mismatch = fakeRuntime(request => isIssue(request) ? fail(missing('Issue'), 'gh: Could not resolve to an Issue with the number of 1.') : cliResult({ stdout: fixture('pull-read.json') }))
    await expect(clientOf(mismatch).readResource({ ...PULL, kind: 'issue' })).rejects.toMatchObject({ category: 'unsupported' })
    expect([mismatch.runs.length, argValue(mismatch.runs[1]!.args, 'query')!.includes('pullRequest(number:$number)')]).toEqual([2, true])
    // Neither kind resolves, and a null repository never becomes a resource.
    const neither = fakeRuntime(request => isIssue(request) ? fail(missing('Issue'), 'gh: Could not resolve to an Issue') : fail(missing('PullRequest'), 'gh: Could not resolve to a PullRequest'))
    await expect(clientOf(neither).readResource(ISSUE)).rejects.toMatchObject({ category: 'not-found' })
    const nullRepository = fakeRuntime(() => cliResult({ stdout: JSON.stringify({ data: { repository: null } }) }))
    await expect(clientOf(nullRepository).readResource(ISSUE)).rejects.toMatchObject({ category: 'not-found' })
  })
  it('fetches the live resource on every read (no cached body claimed as latest)', async () => {
    let version = 0
    const fake = fakeRuntime(() => {
      version += 1
      const payload = JSON.parse(fixture('issue-read.json')) as { data: { repository: { issue: Record<string, unknown> } } }
      payload.data.repository.issue.title = `title v${version}`
      payload.data.repository.issue.updatedAt = `2026-10-1${version}T00:00:00Z`
      return cliResult({ stdout: JSON.stringify(payload) })
    })
    const first = await clientOf(fake).readResource(ISSUE)
    const second = await clientOf(fake).readResource(ISSUE)
    expect([first.title, second.title, second.updatedAt === first.updatedAt, second.revision === first.revision, fake.runs.length])
      .toEqual(['title v1', 'title v2', false, false, 2])
  })
  it('fails a malformed list page instead of reporting an empty list', async () => {
    const malformed = (connection: unknown): FakeRuntime => fakeRuntime(() => cliResult({ stdout: listJson(connection) }))
    await expect(clientOf(malformed({ nodes: 'nope', totalCount: 1 })).listPage(listQuery())).rejects.toMatchObject({ category: 'failed' })
    await expect(clientOf(malformed({ nodes: [null] })).listPage(listQuery())).rejects.toMatchObject({ category: 'failed' })
    // A provider page without total/pageInfo is valid: no invented total/continuation.
    const page = await clientOf(malformed({ nodes: [] })).listPage(listQuery())
    expect([page.items, page.total, page.nextAfter]).toEqual([[], undefined, undefined])
  })
})

describe('failed gh runs', () => {
  async function failureCategory(overrides: Partial<CliResult>): Promise<ClueError> {
    try {
      await clientOf(fakeRuntime(() => cliResult(overrides))).readResource(ISSUE)
    } catch (error) {
      if (error instanceof ClueError) return error
      throw error
    }
    throw new Error('expected a ClueError')
  }
  const FAILURES: Array<{ name: string; result: Partial<CliResult>; category: string; message?: string }> = [
    { name: 'a gh auth login prompt (exit 4)', result: { exitCode: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' }, category: 'auth-required' },
    { name: 'a 401 body', result: { exitCode: 1, stdout: '{"message":"Bad credentials","status":"401"}', stderr: 'gh: Bad credentials (HTTP 401)' }, category: 'auth-required' },
    { name: 'a 403 body', result: { exitCode: 1, stdout: '{"message":"Forbidden","status":"403"}', stderr: 'gh: Forbidden (HTTP 403)' }, category: 'permission-denied' },
    { name: 'a 404', result: { exitCode: 1, stderr: 'gh: Not Found (HTTP 404)' }, category: 'not-found' },
    { name: 'a primary rate limit', result: { exitCode: 1, stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)' }, category: 'rate-limited' },
    { name: 'a secondary rate limit', result: { exitCode: 1, stderr: 'You have exceeded a secondary rate limit. Please wait a few minutes.' }, category: 'rate-limited' },
    { name: 'an archived repository', result: { exitCode: 1, stdout: '{"message":"Repository was archived so is read-only.","status":"403"}', stderr: 'gh: Repository was archived so is read-only. (HTTP 403)' }, category: 'permission-denied', message: 'archived' },
    { name: 'a CLI without a required flag', result: { exitCode: 1, stderr: 'unknown flag: --json' }, category: 'dependency-incompatible' },
  ]
  it.each(FAILURES)('maps $name to a fixed category', async ({ result, category, message }) => {
    const error = await failureCategory(result)
    expect(error.category).toBe(category)
    if (message !== undefined) expect(error.message).toContain(message)
  })
  it('reports a real resource auth failure to the shared connection (best-effort)', async () => {
    const fake = fakeRuntime(() => cliResult({ exitCode: 1, stderr: 'gh: Bad credentials (HTTP 401)' }))
    await expect(clientOf(fake).readResource(ISSUE)).rejects.toMatchObject({ category: 'auth-required' })
    expect(fake.reports).toEqual([{ connectionId: GITHUB_CONNECTION_ID, authorization: 'expired' }])
    // A non-auth failure is not a connection observation.
    const notFound = fakeRuntime(() => cliResult({ exitCode: 1, stderr: 'gh: Not Found (HTTP 404)' }))
    await expect(clientOf(notFound).readResource(ISSUE)).rejects.toMatchObject({ category: 'not-found' })
    expect(notFound.reports).toEqual([])
    // A report failure must never replace the source's own error.
    const broken = fakeRuntime(() => cliResult({ exitCode: 1, stderr: 'gh: Bad credentials (HTTP 401)' }))
    ;(broken.runtime.connections as unknown as { report: () => never }).report = () => { throw new Error('the connection is not registered') }
    await expect(clientOf(broken).readResource(ISSUE)).rejects.toMatchObject({ category: 'auth-required' })
  })
  it('never echoes raw stderr, tokens or response bodies', async () => {
    const error = await failureCategory({ exitCode: 1, stderr: 'boom gho_ABCDEFGHIJKLMNOP Authorization: Bearer secret-value' })
    expect(error.category).toBe('failed')
    expect(['boom', 'gho_', 'Bearer', 'secret-value', 'stderr'].filter(secret => error.message.includes(secret))).toEqual([])
  })
  it('treats malformed JSON, empty output and truncation as failures, never an empty page', async () => {
    const malformed = await failureCategory({ stdout: '{"data":' })
    const empty = await failureCategory({ stdout: '' })
    const truncated = await failureCategory({ stdout: '{"data":{"repository":', stdoutTruncated: true })
    expect([malformed.category, empty.category, truncated.category, truncated.message.includes('limit')]).toEqual(['failed', 'failed', 'failed', true])
  })
  it.each([
    { category: 'cancelled' as const, message: 'the CLI operation was cancelled' },
    { category: 'timeout' as const, message: 'the CLI operation timed out' },
  ])('propagates $category without retrying', async ({ category, message }) => {
    const fake = fakeRuntime(() => { throw new ClueError(category, message) })
    await expect(clientOf(fake).listPage(listQuery())).rejects.toMatchObject({ category })
    expect(fake.runs).toHaveLength(1)
  })
  it('does not retry a rate-limited read', async () => {
    const fake = fakeRuntime(() => cliResult({ exitCode: 1, stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)' }))
    await expect(clientOf(fake).readResource(ISSUE)).rejects.toMatchObject({ category: 'rate-limited' })
    expect(fake.runs).toHaveLength(1)
  })
})

describe('save', () => {
  interface SavedState { title: string; body: string; updatedAt: string }
  const STATE: SavedState = { title: 'old title', body: 'old body', updatedAt: '2026-10-16T07:44:20Z' }
  const CHANGED: SavedState = { title: 'new title', body: 'new body', updatedAt: '2026-10-17T10:00:00Z' }
  /** A stateful fake: reads return `state`, the edit returns `write`, then re-reads. */
  function saveFake(options: {
    state?: SavedState; write?: CliResult; after?: SavedState; afterFails?: boolean
    readFails?: boolean; permission?: string | null; archived?: boolean; private?: boolean
  } = {}): FakeRuntime {
    const state = options.state ?? STATE
    let reads = 0
    return fakeRuntime((request) => {
      if (!(argValue(request.args, 'query') ?? '').includes('(number:$number)')) return options.write ?? cliResult({ stdout: 'https://github.com/cli/cli/issues/14609\n' })
      reads += 1
      if (options.readFails === true) return cliResult({ exitCode: 1, stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)' })
      const payload = JSON.parse(fixture('issue-read.json')) as { data: { repository: Record<string, unknown> & { issue: Record<string, unknown> } } }
      const repository = payload.data.repository
      repository.viewerPermission = options.permission === null ? undefined : options.permission ?? 'WRITE'
      repository.isArchived = options.archived ?? false
      repository.isPrivate = options.private ?? false
      repository.visibility = options.private === true ? 'PRIVATE' : 'PUBLIC'
      const snapshot = reads === 1 ? state : options.after ?? state
      repository.issue.title = snapshot.title
      repository.issue.body = snapshot.body
      repository.issue.updatedAt = snapshot.updatedAt
      if (reads > 1 && options.afterFails === true) return cliResult({ exitCode: 1, stderr: 'gh: Not Found (HTTP 404)' })
      return cliResult({ stdout: JSON.stringify(payload) })
    })
  }
  function baseRevisionOf(state: SavedState): string {
    return githubRevisionOf({ updatedAt: state.updatedAt, title: state.title, body: state.body, state: 'OPEN' })
  }
  function save(fake: FakeRuntime, input: { title?: string; body?: string; baseRevision?: string } = {}) {
    return clientOf(fake).saveEdits({ resource: ISSUE, title: input.title ?? 'new', body: input.body ?? 'new', baseRevision: input.baseRevision ?? baseRevisionOf(STATE) })
  }
  it('re-reads, then sends ONLY the changed title and body (body through stdin)', async () => {
    const fake = saveFake({ after: CHANGED })
    const result = await save(fake, { title: 'new title', body: 'new body' })
    const edit = fake.runs[1]!
    expect(edit.args.slice(0, 3)).toEqual(['issue', 'edit', '14609'])
    expect([edit.args[edit.args.indexOf('-R') + 1], edit.args[edit.args.indexOf('--title') + 1]]).toEqual(['cli/cli', 'new title'])
    expect([fake.runs.length, edit.args.includes('--body-file'), edit.stdin, edit.args.join(' ').includes('new body'), edit.timeoutMs]).toEqual([3, true, 'new body', false, 60_000])
    expect([result.savedAt, result.revision]).toEqual([NOW, githubRevisionOf({ updatedAt: CHANGED.updatedAt, title: CHANGED.title, body: CHANGED.body, state: 'OPEN' })])
  })
  it('keeps the confirmed save but omits display info when the post-save re-read fails', async () => {
    const fake = saveFake({ after: CHANGED, afterFails: true })
    const result = await save(fake, { title: 'new title', body: 'new body' })
    // The remote edit is confirmed; only the optional display baseline is omitted.
    // The PRE-write snapshot must never masquerade as post-save info.
    expect([result.savedAt, result.revision, result.snapshot, fake.runs.length]).toEqual([NOW, undefined, undefined, 4])
  })
  it.each([
    { name: 'title', state: { ...STATE, title: 'same' }, after: { ...STATE, title: 'same', body: 'patched' }, title: 'same', body: 'patched', present: '--body-file', absent: '--title', stdin: 'patched' },
    { name: 'body', state: { ...STATE, body: 'same' }, after: { ...STATE, body: 'same', title: 'renamed' }, title: 'renamed', body: 'same', present: '--title', absent: '--body-file', stdin: undefined },
  ])('does not submit an unchanged $name', async ({ state, after, title, body, present, absent, stdin }) => {
    const fake = saveFake({ state, after })
    await save(fake, { title, body, baseRevision: baseRevisionOf(state) })
    expect([fake.runs[1]!.args.includes(present), fake.runs[1]!.args.includes(absent), fake.runs[1]!.stdin]).toEqual([true, false, stdin])
  })
  it('writes nothing when neither field changed', async () => {
    const fake = saveFake()
    const result = await save(fake, { title: STATE.title, body: STATE.body })
    expect([fake.runs.length, result.revision, result.savedAt]).toEqual([1, baseRevisionOf(STATE), NOW])
  })
  it.each([
    { name: 'a stale baseline', options: {}, input: { baseRevision: 'ghsb1-stale' }, category: 'conflict' },
    { name: 'a failed pre-save re-read', options: { readFails: true }, input: {}, category: 'rate-limited' },
  ])('does not write for $name', async ({ options, input, category }) => {
    const fake = saveFake(options)
    await expect(save(fake, input)).rejects.toMatchObject({ category })
    expect([fake.runs.length, fake.runs.some(run => run.args.includes('--body-file'))]).toEqual([1, false])
  })
  it('requires the base revision and a non-empty title before any command', async () => {
    const missing = saveFake()
    await expect(clientOf(missing).saveEdits({ resource: ISSUE, title: 'x', body: 'y' })).rejects.toMatchObject({ category: 'invalid-request' })
    const blank = saveFake()
    await expect(save(blank, { title: '   ' })).rejects.toMatchObject({ category: 'invalid-request' })
    expect([missing.runs.length, blank.runs.length]).toEqual([0, 0])
  })
  it.each([
    { name: 'public write', permission: 'WRITE', private: false, writable: true },
    { name: 'private write', permission: 'WRITE', private: true, writable: true },
    { name: 'public read', permission: 'READ', private: false, writable: false },
    { name: 'private read', permission: 'READ', private: true, writable: false },
    // Unknown permission is NOT pre-disabled (the write is attempted).
    { name: 'unknown permission', permission: null, private: false, writable: true },
  ])('gates the write on the account permission, not on visibility ($name)', async ({ permission, private: isPrivate, writable }) => {
    const fake = saveFake({ permission, private: isPrivate })
    const outcome = await save(fake).catch((caught: unknown) => caught)
    if (writable) expect(outcome).not.toBeInstanceOf(ClueError)
    else expect((outcome as ClueError).category).toBe('permission-denied')
    expect(fake.runs.some(run => run.args.includes('--body-file'))).toBe(writable)
  })
  it.each([
    { name: 'an archived repository', options: { archived: true }, category: 'permission-denied', runs: 1, reports: [] },
    { name: 'a write 403', options: { write: cliResult({ exitCode: 1, stderr: 'gh: Resource not accessible by integration (HTTP 403)' }) }, category: 'permission-denied', runs: 2, reports: [] },
    { name: 'a write 401', options: { write: cliResult({ exitCode: 1, stderr: 'gh: Bad credentials (HTTP 401)' }) }, category: 'auth-required', runs: 2, reports: [{ connectionId: GITHUB_CONNECTION_ID, authorization: 'expired' }] },
  ])('refuses $name without claiming success', async ({ options, category, runs, reports }) => {
    const fake = saveFake(options)
    await expect(save(fake)).rejects.toMatchObject({ category })
    expect([fake.runs.length, fake.reports]).toEqual([runs, reports])
  })
  it('edits a pull request through the pr command', async () => {
    const fake = fakeRuntime(request => argValue(request.args, 'query') !== undefined
      ? cliResult({ stdout: fixture('pull-read.json') })
      : cliResult({ stdout: 'https://github.com/cli/cli/pull/14727\n' }))
    const base = githubRevisionOf({
      updatedAt: '2026-10-17T15:26:56Z', title: 'fix(issue create): resolve --type before creating the issue',
      body: '## Summary\n\nFixes #14703.\n', state: 'OPEN', isDraft: false, merged: false,
    })
    await clientOf(fake).saveEdits({ resource: PULL, title: 'renamed', body: '## Summary\n\nFixes #14703.\n', baseRevision: base })
    expect(fake.runs[1]!.args.slice(0, 3)).toEqual(['pr', 'edit', '14727'])
    expect(fake.runs[1]!.args).toContain('--title')
  })
})
