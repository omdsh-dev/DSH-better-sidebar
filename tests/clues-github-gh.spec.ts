/**
 * S3 gh adapter contract (fake runtime; NO real gh, no network, no account).
 *
 * The adapter is the only place that knows the gh command lines and the
 * GraphQL envelopes of the GitHub source. The cases pin:
 * - argv arrays only: `gh api graphql` with an EXPLICIT host and repo, one
 *   page (`first`/`after` variables, never `--paginate`), and the shared
 *   `github.gh` dependency id;
 * - browse and search stay inside one `owner/repo` and one kind (issue vs
 *   pull); search qualifiers that could widen the range are stripped;
 * - the page result carries the provider total only when reported, an opaque
 *   `nextAfter` only when the provider confirms another page, and `limited`
 *   only when the search index cap is hit;
 * - JSON parsing is strict: a non-zero exit, invalid JSON or a truncated
 *   stream is a failure, never an empty page;
 * - read always re-fetches the live resource and maps issue/PR fields plus
 *   the repository state; a kind mismatch is reported as unsupported instead
 *   of being rewritten into the other reference;
 * - saveEdit re-reads first, refuses a stale baseline with `conflict`, sends
 *   ONLY the changed title/body (body through stdin), maps 403/404/rate
 *   limit/archived/cancel/timeout to the S1 categories and never echoes raw
 *   stderr or tokens;
 * - a real list/read/write 401 reports an `expired` observation to the shared
 *   connection (best-effort; a report failure never masks the source error).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
vi.mock('../src/clues/request-gate.ts', () => vi.importActual('./fixtures/clues-source-request-gate.ts'))
import { ClueError } from '../src/clues/error.ts'
import type { ClueRuntime } from '../src/clues/runtime/types.ts'
import type { CliResult, CliRunRequest } from '../src/clues/runtime/types.ts'
import {
  createGithubGhClient,
  githubSearchQuery,
  type GithubGhClient,
  type GithubPageQuery,
} from '../src/clues/sources/github/gh.ts'
import { mapGithubCliFailure } from '../src/clues/sources/github/errors.ts'
import { GITHUB_CONNECTION_ID, GITHUB_DEPENDENCY_ID } from '../src/clues/sources/github/ids.ts'
import { githubRevisionOf } from '../src/clues/sources/github/revision.ts'
import type { GithubResource } from '../src/clues/sources/github/ids.ts'

const NOW = '2026-10-17T00:00:00.000Z'
const CWD = '/tmp/clues-github-adapter'

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/clues-github/${name}`, import.meta.url), 'utf8')
}

function cliResult(overrides: Partial<CliResult> = {}): CliResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
    ...overrides,
  }
}

interface ReportedInspection {
  readonly connectionId: string
  readonly authorization?: string
}

interface FakeRuntime {
  readonly runtime: ClueRuntime
  readonly runs: CliRunRequest[]
  readonly reports: ReportedInspection[]
}

/** A runtime whose only real verb is `runCli`; everything else is inert. */
function fakeRuntime(handler: (request: CliRunRequest) => CliResult | Promise<CliResult>): FakeRuntime {
  const runs: CliRunRequest[] = []
  const reports: ReportedInspection[] = []
  const unused = async (): Promise<never> => { throw new Error('not used by the GitHub adapter') }
  const runtime = {
    dependencies: {
      register: () => () => undefined,
      getDefinition: () => undefined,
      getDefinitions: () => [],
      inspect: unused,
      resolve: unused,
      plan: unused,
      start: unused,
      tasks: () => [],
      cancel: unused,
      setManualPath: unused,
      clearManualPath: unused,
      invalidate: () => undefined,
      dispose: () => undefined,
    },
    connections: {
      register: () => () => undefined,
      getDefinition: () => undefined,
      getDefinitions: () => [],
      status: unused,
      connect: unused,
      poll: unused,
      cancel: unused,
      report: (connectionId: string, inspection: { authorization?: string }) => {
        reports.push({ connectionId, ...(inspection.authorization === undefined ? {} : { authorization: inspection.authorization }) })
      },
      dispose: () => undefined,
    },
    http: { request: unused },
    mcp: { callTool: unused },
    async prepareCli(request: CliRunRequest): Promise<() => Promise<CliResult>> { return () => runtime.runCli(request) },
    runCli: async (request: CliRunRequest): Promise<CliResult> => {
      runs.push(request)
      return await handler(request)
    },
    runCliJson: unused,
    dispose: () => undefined,
  } as unknown as ClueRuntime
  return { runtime, runs, reports }
}

function clientOf(fake: FakeRuntime): GithubGhClient {
  return createGithubGhClient({ runtime: () => fake.runtime, cwd: CWD, now: () => NOW })
}

/** The value of one `-f`/`-F` `key=value` argument. */
function argValue(args: readonly string[], key: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (flag !== '-f' && flag !== '-F' && flag !== '--field' && flag !== '--raw-field') continue
    const pair = args[index + 1]
    if (pair === undefined) continue
    if (pair.startsWith(`${key}=`)) return pair.slice(key.length + 1)
  }
  return undefined
}

const ISSUE: GithubResource = { host: 'github.com', owner: 'cli', repo: 'cli', kind: 'issue', number: 14609 }
const PULL: GithubResource = { host: 'github.com', owner: 'cli', repo: 'cli', kind: 'pull', number: 14727 }
const REPO = { owner: 'cli', repo: 'cli' } as const

function listQuery(overrides: Partial<GithubPageQuery> = {}): GithubPageQuery {
  return { kind: 'issue', repo: REPO, state: 'open', limit: 30, ...overrides }
}

describe.each(['issue', 'pull'] as const)('%s GraphQL request completeness', (kind) => {
  it.each(['browse', 'search', 'read'] as const)('closes every selection set in the actual %s CLI request', async (operation) => {
    const name = operation === 'search'
      ? `search-${kind === 'issue' ? 'issues' : 'pulls'}.json`
      : `${kind}-${operation === 'browse' ? 'list' : 'read'}.json`
    const fake = fakeRuntime(() => cliResult({ stdout: fixture(name) }))
    const client = clientOf(fake)
    if (operation === 'read') await client.readResource(kind === 'issue' ? ISSUE : PULL)
    else await client.listPage(listQuery({ kind, ...(operation === 'search' ? { query: 'cache' } : {}) }))
    expect(fake.runs).toHaveLength(1)
    // A canned response alone cannot detect a query GitHub rejects before
    // execution. Check the outgoing wire document, not only field substrings.
    const query = argValue(fake.runs[0]!.args, 'query')!
    expect(query).toBeTypeOf('string')
    let selectionDepth = 0
    for (const char of query) {
      if (char === '{') selectionDepth += 1
      if (char === '}') selectionDepth -= 1
      expect(selectionDepth, 'a selection set cannot close before it opens').toBeGreaterThanOrEqual(0)
    }
    expect(selectionDepth, 'the GraphQL operation must close its outer selection set').toBe(0)
  })
})

describe('browse and search argv', () => {
  it('asks gh for ONE explicit repository page and never for --paginate', async () => {
    const fake = fakeRuntime(() => cliResult({ stdout: fixture('issue-list.json') }))
    const page = await clientOf(fake).listPage(listQuery())

    expect(fake.runs).toHaveLength(1)
    const request = fake.runs[0]!
    expect(request.dependencyId).toBe(GITHUB_DEPENDENCY_ID)
    expect(request.cwd).toBe(CWD)
    expect(request.args.slice(0, 3)).toEqual(['api', 'graphql', '--hostname'])
    expect(argValue(request.args, 'owner')).toBe('cli')
    expect(argValue(request.args, 'repo')).toBe('cli')
    expect(argValue(request.args, 'first')).toBe('30')
    expect(argValue(request.args, 'states[]')).toBe('OPEN')
    const query = argValue(request.args, 'query')!
    expect(query).toContain('issues(first:$first')
    expect(query).toContain('$states:[IssueState!]')
    expect(request.args.join(' ')).not.toContain('--paginate')

    expect(page.items).toHaveLength(2)
    expect(page.items[0]).toEqual({
      number: 14728,
      title: '[aw] Dependabot PR Triage (skills-driven) exceeded daily AI credits budget',
      state: 'OPEN',
      createdAt: '2026-10-17T19:30:00Z',
      updatedAt: '2026-10-17T19:43:04Z',
      url: 'https://github.com/cli/cli/issues/14728',
      author: 'cli-triage',
      authorName: 'CLI Triage',
      authorUrl: 'https://github.com/apps/cli-triage',
      assignees: [{ login: 'octocat', name: 'The Octocat', url: 'https://github.com/octocat' }],
      labels: ['triage'],
    })
    expect(query).toContain('assignees(first:10){nodes{login name url}}')
    expect(query).toContain('labels(first:20){nodes{name}}')
    expect(query).toContain('createdAt updatedAt closedAt')
    expect(query).toContain('author{login url ... on User{name} ... on Organization{name}}')
    // Absent provider fields stay absent (no empty arrays/people invented).
    expect(page.items[1]).toEqual({
      number: 14732,
      title: 'แบบร่างจำลอง',
      state: 'OPEN',
      updatedAt: '2026-10-17T19:32:31Z',
      url: 'https://github.com/cli/cli/issues/14732',
      author: 'phatcharaporn1134',
    })
    expect(page.total).toBe(1038)
    expect(page.nextAfter).toBe('Y3Vyc29yOnYyOpK0MjAyNi0xMC0xN1QxOTozMjozMVrPAAAAAV_M_JY=')
    expect(page.limited).toBeUndefined()
  })

  it('uses the pull request connection for the pull kind and carries draft/merged data', async () => {
    const fake = fakeRuntime(() => cliResult({ stdout: fixture('pull-list.json') }))
    const page = await clientOf(fake).listPage(listQuery({ kind: 'pull' }))

    const request = fake.runs[0]!
    const query = argValue(request.args, 'query')!
    expect(query).toContain('pullRequests(first:$first')
    expect(query).toContain('PullRequestState')
    expect(query).toContain('headRefName baseRefName headRepository{nameWithOwner}')
    // A browse page carries the rollup only: no page downloads check lists.
    expect(query).toContain('reviewDecision mergeable statusCheckRollup{state} ')
    expect(query).not.toContain('contexts(')
    expect(query).toContain('assignees(first:10){nodes{login name url}}')
    expect(argValue(request.args, 'states[]')).toBe('OPEN')
    expect(page.total).toBe(71)
    expect(page.items[0]?.isDraft).toBe(false)
    expect(page.items[0]?.review).toBe('approved')
    expect(page.items[0]?.mergeable).toBe('mergeable')
    expect(page.items[0]?.checks).toBe('success')
    expect(page.items[0]?.headRefName).toBe('fix/type-resolution')
    expect(page.items[0]?.baseRefName).toBe('trunk')
    expect(page.items[0]?.headRepository).toBe('umairnaeem0309/cli')
    expect(page.items[1]?.state).toBe('MERGED')
    expect(page.items[1]?.merged).toBe(true)
    expect(page.items[1]?.mergedAt).toBe('2026-10-17T10:03:56Z')
    expect(page.items[1]?.closedAt).toBe('2026-10-17T10:03:56Z')
  })

  it('maps the state filter and omits it for "all" instead of inventing one', async () => {
    const closed = fakeRuntime(() => cliResult({ stdout: fixture('issue-list.json') }))
    await clientOf(closed).listPage(listQuery({ state: 'closed' }))
    expect(argValue(closed.runs[0]!.args, 'states[]')).toBe('CLOSED')

    const all = fakeRuntime(() => cliResult({ stdout: fixture('issue-list.json') }))
    await clientOf(all).listPage(listQuery({ state: 'all' }))
    expect(argValue(all.runs[0]!.args, 'states[]')).toBeUndefined()
  })

  it('continues with the provider cursor of the previous page and stops when it is exhausted', async () => {
    const fake = fakeRuntime(() => cliResult({
      stdout: JSON.stringify({
        data: {
          repository: {
            issues: {
              totalCount: 2,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{
                number: 1,
                title: 'first',
                state: 'OPEN',
                updatedAt: '2026-10-17T00:00:00Z',
                url: 'https://github.com/cli/cli/issues/1',
                author: null,
              }],
            },
          },
        },
      }),
    }))
    const page = await clientOf(fake).listPage(listQuery({ after: 'PROVIDER_CURSOR' }))
    expect(argValue(fake.runs[0]!.args, 'after')).toBe('PROVIDER_CURSOR')
    expect(page.nextAfter).toBeUndefined()
    expect(page.items[0]?.author).toBeUndefined()
  })

  it('scopes search to exactly one repository and one kind, stripping widening qualifiers', async () => {
    const fake = fakeRuntime(() => cliResult({ stdout: fixture('search-issues.json') }))
    const page = await clientOf(fake).listPage(listQuery({
      limit: 20,
      query: 'repo:evil/repo org:other is:pr state:closed release bug',
    }))
    const args = fake.runs[0]!.args
    const q = argValue(args, 'q')!
    expect(q).toBe('repo:cli/cli is:issue state:open release bug')
    expect(q.match(/repo:/g)).toHaveLength(1)
    expect(q).not.toContain('evil')
    expect(q).not.toContain('is:pr')
    expect(argValue(args, 'first')).toBe('20')
    expect(argValue(args, 'query')).toContain('search(query:$q')
    expect(page.total).toBe(519)
    expect(page.limited).toBeUndefined()
    expect(page.items[0]?.number).toBe(14609)
  })

  it('marks a search result limited only when the 1000-result index cap is reached', async () => {
    const payload = JSON.parse(fixture('search-issues.json')) as {
      data: { search: { issueCount: number } }
    }
    payload.data.search.issueCount = 1500
    const fake = fakeRuntime(() => cliResult({ stdout: JSON.stringify(payload) }))
    const page = await clientOf(fake).listPage(listQuery({ query: 'release' }))
    expect(page.total).toBe(1500)
    expect(page.limited).toBe(true)
  })

  it('keeps a pull search inside pull requests', () => {
    expect(githubSearchQuery({ repo: REPO, kind: 'pull', state: 'all', query: 'fix (bug OR crash)' }))
      .toBe('repo:cli/cli is:pr fix (bug OR crash)')
    expect(githubSearchQuery({ repo: REPO, kind: 'issue', state: 'closed', query: '  ' }))
      .toBe('repo:cli/cli is:issue state:closed')
  })
})

describe('read', () => {
  it('reads the live issue with metadata, labels and repository state', async () => {
    const fake = fakeRuntime(() => cliResult({ stdout: fixture('issue-read.json') }))
    const snapshot = await clientOf(fake).readResource(ISSUE)

    const request = fake.runs[0]!
    const query = argValue(request.args, 'query')!
    expect(query).toContain('issue(number:$number)')
    expect(query).toContain('author{login url ... on User{name} ... on Organization{name}}')
    expect(query).toContain('assignees(first:10){nodes{login name url}}')
    expect(query).toContain('comments(first:1){totalCount}')
    expect(argValue(request.args, 'number')).toBe('14609')
    expect(argValue(request.args, 'owner')).toBe('cli')
    expect(argValue(request.args, 'repo')).toBe('cli')

    expect(snapshot.resource).toEqual(ISSUE)
    expect(snapshot.title).toBe('gh release list -R https://github.com/cli/cli/ -> error')
    expect(snapshot.body).toContain('### Describe the bug')
    expect(snapshot.state).toBe('OPEN')
    expect(snapshot.author).toBe('tps800')
    expect(snapshot.authorName).toBe('TPS')
    expect(snapshot.authorUrl).toBe('https://github.com/tps800')
    expect(snapshot.assignees).toEqual([
      { login: 'octocat', name: 'The Octocat', url: 'https://github.com/octocat' },
    ])
    expect(snapshot.commentsCount).toBe(7)
    expect(snapshot.closedAt).toBeUndefined()
    expect(snapshot.url).toBe('https://github.com/cli/cli/issues/14609')
    expect(snapshot.createdAt).toBe('2026-10-05T09:12:00Z')
    expect(snapshot.updatedAt).toBe('2026-10-16T07:44:20Z')
    expect(snapshot.labels).toEqual(['bug', 'release'])
    expect(snapshot.isArchived).toBe(false)
    expect(snapshot.viewerPermission).toBe('READ')
    expect(snapshot.isDraft).toBeUndefined()
    expect(snapshot.revision).toBe(githubRevisionOf({
      updatedAt: '2026-10-16T07:44:20Z',
      title: 'gh release list -R https://github.com/cli/cli/ -> error',
      body: snapshot.body,
      state: 'OPEN',
      stateReason: null,
    }))
  })

  it('carries the PR-only draft/merged fields', async () => {
    const fake = fakeRuntime(() => cliResult({ stdout: fixture('pull-read.json') }))
    const snapshot = await clientOf(fake).readResource(PULL)
    const query = argValue(fake.runs[0]!.args, 'query')!
    expect(query).toContain('pullRequest(number:$number)')
    expect(query).toContain('commits(first:1){totalCount}')
    expect(query).toContain('changedFiles additions deletions')
    expect(query).toContain('headRefName baseRefName headRepository{nameWithOwner}')
    expect(query).toContain('reviewDecision mergeable statusCheckRollup{state contexts(first:20)')
    expect(snapshot.isDraft).toBe(false)
    expect(snapshot.merged).toBe(false)
    expect(snapshot.mergedAt).toBeUndefined()
    expect(snapshot.viewerPermission).toBe('TRIAGE')
    expect(snapshot.labels).toEqual(['bug'])
    expect(snapshot.headRefName).toBe('fix/type-resolution')
    expect(snapshot.baseRefName).toBe('trunk')
    expect(snapshot.headRepository).toBe('umairnaeem0309/cli')
    expect(snapshot.commentsCount).toBe(5)
    // Read-only review/CI/mergeability facts are normalized, never invented.
    expect(snapshot.review).toBe('approved')
    expect(snapshot.mergeable).toBe('mergeable')
    expect(snapshot.checks).toBe('success')
    // Individual checks ride the SAME read (one request), bounded and in
    // provider order; a run without a conclusion is still pending.
    expect(query).toContain('contexts(first:20){nodes{__typename')
    expect(query).toContain('... on CheckRun{name status conclusion detailsUrl}')
    expect(query).toContain('... on StatusContext{context state targetUrl}')
    expect(snapshot.checkRuns).toEqual([
      { name: 'build (macos)', state: 'success', url: 'https://github.com/cli/cli/runs/1' },
      { name: 'test (ubuntu)', state: 'pending', url: 'https://github.com/cli/cli/runs/2' },
      { name: 'lint', state: 'failure', url: 'https://github.com/cli/cli/runs/3' },
      { name: 'ci/circleci: docs', state: 'success', url: 'https://circleci.example/1' },
    ])
    expect(snapshot.commitsCount).toBe(12)
    expect(snapshot.changedFiles).toBe(3)
    expect(snapshot.additions).toBe(42)
    expect(snapshot.deletions).toBe(7)
  })

  it('keeps unusable check nodes out of the list and leaves an empty one absent', async () => {
    const raw = JSON.parse(fixture('pull-read.json')) as {
      data: { repository: { pullRequest: Record<string, unknown> } }
    }
    raw.data.repository.pullRequest.statusCheckRollup = {
      state: 'PENDING',
      contexts: {
        nodes: [
          // A conclusion this adapter does not know must not be guessed at.
          { __typename: 'CheckRun', name: 'novel', status: 'COMPLETED', conclusion: 'SOMETHING_NEW' },
          // A node with no name cannot be rendered, so it is dropped.
          { __typename: 'CheckRun', conclusion: 'SUCCESS', detailsUrl: 'https://ci.example/1' },
          { __typename: 'StatusContext', context: 'ci/legacy', state: 'EXPECTED' },
        ],
      },
    }
    const fake = fakeRuntime(() => cliResult({ stdout: JSON.stringify(raw) }))
    const snapshot = await clientOf(fake).readResource(PULL)
    expect(snapshot.checks).toBe('pending')
    expect(snapshot.checkRuns).toEqual([{ name: 'ci/legacy', state: 'expected' }])

    // No rollup contexts at all (or an empty node list) stays absent.
    raw.data.repository.pullRequest.statusCheckRollup = { state: 'PENDING' }
    const quiet = fakeRuntime(() => cliResult({ stdout: JSON.stringify(raw) }))
    expect((await clientOf(quiet).readResource(PULL)).checkRuns).toBeUndefined()
    raw.data.repository.pullRequest.statusCheckRollup = { state: 'PENDING', contexts: { nodes: [] } }
    const empty = fakeRuntime(() => cliResult({ stdout: JSON.stringify(raw) }))
    expect((await clientOf(empty).readResource(PULL)).checkRuns).toBeUndefined()
  })

  it('bounds the check list and clips a name that exceeds the display contract', async () => {
    const raw = JSON.parse(fixture('pull-read.json')) as {
      data: { repository: { pullRequest: Record<string, unknown> } }
    }
    const node = (index: number, name: string) => ({
      __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS',
    })
    raw.data.repository.pullRequest.statusCheckRollup = {
      state: 'SUCCESS',
      contexts: {
        nodes: [
          node(0, 'x'.repeat(400)),
          ...Array.from({ length: 24 }, (_unused, index) => node(index + 1, `job-${index + 1}`)),
        ],
      },
    }
    const fake = fakeRuntime(() => cliResult({ stdout: JSON.stringify(raw) }))
    const snapshot = await clientOf(fake).readResource(PULL)
    expect(snapshot.checkRuns).toHaveLength(20)
    expect(snapshot.checkRuns?.[0]?.name).toHaveLength(200)
    expect(snapshot.checkRuns?.[0]?.name.endsWith('…')).toBe(true)
    expect(snapshot.checkRuns?.[19]?.name).toBe('job-19')
  })

  it('reports a kind mismatch as unsupported instead of rewriting the reference', async () => {
    const notFound = JSON.stringify({
      data: { repository: { isArchived: false, viewerPermission: 'READ', issue: null } },
      errors: [{
        type: 'NOT_FOUND',
        path: ['repository', 'issue'],
        message: 'Could not resolve to an Issue with the number of 1.',
      }],
    })
    const fake = fakeRuntime((request) => {
      const query = argValue(request.args, 'query') ?? ''
      if (query.includes('issue(number:$number)')) {
        return cliResult({
          exitCode: 1,
          stdout: notFound,
          stderr: 'gh: Could not resolve to an Issue with the number of 1.',
        })
      }
      return cliResult({ stdout: fixture('pull-read.json') })
    })
    await expect(clientOf(fake).readResource({ ...PULL, kind: 'issue' })).rejects.toMatchObject({
      category: 'unsupported',
    })
    expect(fake.runs).toHaveLength(2)
    expect(argValue(fake.runs[1]!.args, 'query')).toContain('pullRequest(number:$number)')
  })

  it('reports not-found when neither kind resolves', async () => {
    const notFound = (what: string): CliResult => cliResult({
      exitCode: 1,
      stdout: JSON.stringify({
        data: { repository: { issue: null, pullRequest: null } },
        errors: [{ type: 'NOT_FOUND', message: `Could not resolve to an ${what}` }],
      }),
      stderr: `gh: Could not resolve to an ${what}`,
    })
    const fake = fakeRuntime(request => {
      const query = argValue(request.args, 'query') ?? ''
      return query.includes('issue(number:$number)') ? notFound('Issue') : notFound('PullRequest')
    })
    await expect(clientOf(fake).readResource(ISSUE)).rejects.toMatchObject({ category: 'not-found' })
    expect(fake.runs).toHaveLength(2)
  })

  it('never invents a resource from a null repository', async () => {
    const fake = fakeRuntime(() => cliResult({
      stdout: JSON.stringify({ data: { repository: null } }),
    }))
    await expect(clientOf(fake).readResource(ISSUE)).rejects.toMatchObject({ category: 'not-found' })
  })

  it('fetches the live resource on every read (no cached body claimed as latest)', async () => {
    let version = 0
    const fake = fakeRuntime(() => {
      version += 1
      const payload = JSON.parse(fixture('issue-read.json')) as {
        data: { repository: { issue: Record<string, unknown> } }
      }
      payload.data.repository.issue.title = `title v${version}`
      payload.data.repository.issue.updatedAt = `2026-10-1${version}T00:00:00Z`
      return cliResult({ stdout: JSON.stringify(payload) })
    })
    const first = await clientOf(fake).readResource(ISSUE)
    const second = await clientOf(fake).readResource(ISSUE)
    expect(first.title).toBe('title v1')
    expect(second.title).toBe('title v2')
    expect(second.updatedAt).not.toBe(first.updatedAt)
    expect(second.revision).not.toBe(first.revision)
    expect(fake.runs).toHaveLength(2)
  })

  it('fails a malformed list page instead of reporting an empty list', async () => {
    const malformed = (connection: unknown): FakeRuntime => fakeRuntime(() => cliResult({
      stdout: JSON.stringify({ data: { repository: { issues: connection } } }),
    }))
    await expect(clientOf(malformed({ nodes: 'nope', totalCount: 1 })).listPage(listQuery()))
      .rejects.toMatchObject({ category: 'failed' })
    await expect(clientOf(malformed({ nodes: [null] })).listPage(listQuery()))
      .rejects.toMatchObject({ category: 'failed' })

    // A provider page without total/pageInfo is valid: no invented total and
    // no continuation.
    const minimal = malformed({ nodes: [] })
    const page = await clientOf(minimal).listPage(listQuery())
    expect(page.items).toEqual([])
    expect(page.total).toBeUndefined()
    expect(page.nextAfter).toBeUndefined()
  })
})

describe('failed gh runs', () => {
  async function failureCategory(overrides: Partial<CliResult>): Promise<ClueError> {
    const fake = fakeRuntime(() => cliResult(overrides))
    try {
      await clientOf(fake).readResource(ISSUE)
    } catch (error) {
      if (error instanceof ClueError) return error
      throw error
    }
    throw new Error('expected a ClueError')
  }

  it('maps auth, permission, not-found, rate limit and archive failures to fixed categories', async () => {
    expect((await failureCategory({
      exitCode: 4,
      stderr: 'To get started with GitHub CLI, please run:  gh auth login',
    })).category).toBe('auth-required')

    expect((await failureCategory({
      exitCode: 1,
      stdout: '{"message":"Bad credentials","status":"401"}',
      stderr: 'gh: Bad credentials (HTTP 401)',
    })).category).toBe('auth-required')

    expect((await failureCategory({
      exitCode: 1,
      stdout: '{"message":"Forbidden","status":"403"}',
      stderr: 'gh: Forbidden (HTTP 403)',
    })).category).toBe('permission-denied')

    expect((await failureCategory({
      exitCode: 1,
      stderr: 'gh: Not Found (HTTP 404)',
    })).category).toBe('not-found')

    expect((await failureCategory({
      exitCode: 1,
      stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)',
    })).category).toBe('rate-limited')

    expect((await failureCategory({
      exitCode: 1,
      stderr: 'You have exceeded a secondary rate limit. Please wait a few minutes.',
    })).category).toBe('rate-limited')

    const archived = await failureCategory({
      exitCode: 1,
      stdout: '{"message":"Repository was archived so is read-only.","status":"403"}',
      stderr: 'gh: Repository was archived so is read-only. (HTTP 403)',
    })
    expect(archived.category).toBe('permission-denied')
    expect(archived.message).toContain('archived')
  })

  it('reports a real resource auth failure to the shared connection (best-effort)', async () => {
    const fake = fakeRuntime(() => cliResult({
      exitCode: 1,
      stderr: 'gh: Bad credentials (HTTP 401)',
    }))
    await expect(clientOf(fake).readResource(ISSUE)).rejects.toMatchObject({ category: 'auth-required' })
    expect(fake.reports).toEqual([{ connectionId: GITHUB_CONNECTION_ID, authorization: 'expired' }])

    // A non-auth failure is not a connection observation.
    const notFound = fakeRuntime(() => cliResult({ exitCode: 1, stderr: 'gh: Not Found (HTTP 404)' }))
    await expect(clientOf(notFound).readResource(ISSUE)).rejects.toMatchObject({ category: 'not-found' })
    expect(notFound.reports).toEqual([])

    // A report failure must never replace the source's own error.
    const broken = fakeRuntime(() => cliResult({ exitCode: 1, stderr: 'gh: Bad credentials (HTTP 401)' }))
    ;(broken.runtime.connections as unknown as { report: () => never }).report = () => {
      throw new Error('the connection is not registered')
    }
    await expect(clientOf(broken).readResource(ISSUE)).rejects.toMatchObject({ category: 'auth-required' })
  })

  it('never echoes raw stderr, tokens or response bodies', async () => {
    const error = await failureCategory({
      exitCode: 1,
      stderr: 'boom gho_ABCDEFGHIJKLMNOP Authorization: Bearer secret-value',
    })
    expect(error.category).toBe('failed')
    for (const secret of ['boom', 'gho_', 'Bearer', 'secret-value', 'stderr']) {
      expect(error.message).not.toContain(secret)
    }
  })

  it('treats malformed JSON, empty output and truncation as failures, never an empty page', async () => {
    expect((await failureCategory({ stdout: '{"data":' })).category).toBe('failed')
    expect((await failureCategory({ stdout: '' })).category).toBe('failed')
    const truncated = await failureCategory({ stdout: '{"data":{"repository":', stdoutTruncated: true })
    expect(truncated.category).toBe('failed')
    expect(truncated.message).toContain('limit')
  })

  it('propagates cancellation and timeout without retrying', async () => {
    const cancelled = fakeRuntime(() => { throw new ClueError('cancelled', 'the CLI operation was cancelled') })
    await expect(clientOf(cancelled).listPage(listQuery())).rejects.toMatchObject({ category: 'cancelled' })
    expect(cancelled.runs).toHaveLength(1)

    const timedOut = fakeRuntime(() => { throw new ClueError('timeout', 'the CLI operation timed out') })
    await expect(clientOf(timedOut).listPage(listQuery())).rejects.toMatchObject({ category: 'timeout' })
    expect(timedOut.runs).toHaveLength(1)
  })

  it('does not retry a rate-limited read', async () => {
    const fake = fakeRuntime(() => cliResult({
      exitCode: 1,
      stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)',
    }))
    await expect(clientOf(fake).readResource(ISSUE)).rejects.toMatchObject({ category: 'rate-limited' })
    expect(fake.runs).toHaveLength(1)
  })

  it('classifies a failure with no recognisable signature as failed', () => {
    const error = mapGithubCliFailure(cliResult({ exitCode: 1, stderr: 'gh: something odd' }))
    expect(error.category).toBe('failed')
    expect(error.message).not.toContain('something odd')
    // A CLI too old for a required flag is an incompatible dependency, not a
    // generic failure (the version probe normally catches this first).
    const old = mapGithubCliFailure(cliResult({ exitCode: 1, stderr: 'unknown flag: --json' }))
    expect(old.category).toBe('dependency-incompatible')
    expect(old.message).not.toContain('--json')
  })
})

describe('save', () => {
  interface SavedState {
    title: string
    body: string
    updatedAt: string
  }

  /** A stateful fake: reads return `state`, the edit returns `write`, then re-reads. */
  function saveFake(options: {
    state: SavedState
    write?: CliResult
    after?: SavedState
    afterFails?: boolean
    permission?: string | null
    archived?: boolean
    private?: boolean
  }): FakeRuntime {
    let reads = 0
    return fakeRuntime((request) => {
      const query = argValue(request.args, 'query') ?? ''
      if (query.includes('issue(number:$number)') || query.includes('pullRequest(number:$number)')) {
        reads += 1
        const payload = JSON.parse(fixture('issue-read.json')) as Record<string, unknown>
        const data = payload.data as { repository: Record<string, unknown> & { issue: Record<string, unknown> } }
        data.repository.viewerPermission = options.permission === null ? undefined : options.permission ?? 'WRITE'
        data.repository.isArchived = options.archived ?? false
        data.repository.isPrivate = options.private ?? false
        data.repository.visibility = options.private === true ? 'PRIVATE' : 'PUBLIC'
        const snapshot = reads === 1 ? options.state : options.after ?? options.state
        data.repository.issue.title = snapshot.title
        data.repository.issue.body = snapshot.body
        data.repository.issue.updatedAt = snapshot.updatedAt
        if (reads > 1 && options.afterFails === true) {
          return cliResult({ exitCode: 1, stderr: 'gh: Not Found (HTTP 404)' })
        }
        return cliResult({ stdout: JSON.stringify(payload) })
      }
      return options.write ?? cliResult({ stdout: 'https://github.com/cli/cli/issues/14609\n' })
    })
  }

  function baseRevisionOf(state: SavedState): string {
    return githubRevisionOf({ updatedAt: state.updatedAt, title: state.title, body: state.body, state: 'OPEN' })
  }

  const state: SavedState = { title: 'old title', body: 'old body', updatedAt: '2026-10-16T07:44:20Z' }

  it('re-reads, then sends ONLY the changed title and body (body through stdin)', async () => {
    const after: SavedState = { title: 'new title', body: 'new body', updatedAt: '2026-10-17T10:00:00Z' }
    const fake = saveFake({ state, after })
    const result = await clientOf(fake).saveEdits({
      resource: ISSUE,
      title: 'new title',
      body: 'new body',
      baseRevision: baseRevisionOf(state),
    })

    expect(fake.runs).toHaveLength(3)
    const edit = fake.runs[1]!
    expect(edit.args.slice(0, 2)).toEqual(['issue', 'edit'])
    expect(edit.args[2]).toBe('14609')
    expect(edit.args).toContain('-R')
    expect(edit.args[edit.args.indexOf('-R') + 1]).toBe('cli/cli')
    expect(edit.args).toContain('--title')
    expect(edit.args[edit.args.indexOf('--title') + 1]).toBe('new title')
    expect(edit.args).toContain('--body-file')
    expect(edit.stdin).toBe('new body')
    expect(edit.args.join(' ')).not.toContain('new body')
    expect(edit.timeoutMs).toBe(60_000)
    expect(result.savedAt).toBe(NOW)
    expect(result.revision).toBe(githubRevisionOf({
      updatedAt: after.updatedAt,
      title: after.title,
      body: after.body,
      state: 'OPEN',
    }))
  })

  it('omits display info when the post-save re-read fails instead of reusing the pre-save snapshot', async () => {
    const after: SavedState = { title: 'new title', body: 'new body', updatedAt: '2026-10-17T10:00:00Z' }
    const fake = saveFake({ state, after, afterFails: true })
    const result = await clientOf(fake).saveEdits({
      resource: ISSUE,
      title: 'new title',
      body: 'new body',
      baseRevision: baseRevisionOf(state),
    })
    // The remote edit is confirmed; only the optional display baseline is
    // omitted. The PRE-write snapshot must never masquerade as post-save info.
    expect(result.savedAt).toBe(NOW)
    expect(result.revision).toBeUndefined()
    expect(result.snapshot).toBeUndefined()
    expect(fake.runs).toHaveLength(4)
  })

  it('does not submit an unchanged field', async () => {
    const bodyOnly = saveFake({ state: { ...state, title: 'same' }, after: { ...state, title: 'same', body: 'patched' } })
    await clientOf(bodyOnly).saveEdits({ resource: ISSUE, title: 'same', body: 'patched', baseRevision: baseRevisionOf({ ...state, title: 'same' }) })
    const bodyEdit = bodyOnly.runs[1]!
    expect(bodyEdit.args).not.toContain('--title')
    expect(bodyEdit.args).toContain('--body-file')
    expect(bodyEdit.stdin).toBe('patched')

    const titleOnly = saveFake({ state: { ...state, body: 'same' }, after: { ...state, body: 'same', title: 'renamed' } })
    await clientOf(titleOnly).saveEdits({ resource: ISSUE, title: 'renamed', body: 'same', baseRevision: baseRevisionOf({ ...state, body: 'same' }) })
    const titleEdit = titleOnly.runs[1]!
    expect(titleEdit.args).toContain('--title')
    expect(titleEdit.args).not.toContain('--body-file')
    expect(titleEdit.stdin).toBeUndefined()
  })

  it('writes nothing when neither field changed', async () => {
    const fake = saveFake({ state })
    const result = await clientOf(fake).saveEdits({
      resource: ISSUE, title: state.title, body: state.body, baseRevision: baseRevisionOf(state),
    })
    expect(fake.runs).toHaveLength(1)
    expect(result.revision).toBe(baseRevisionOf(state))
    expect(result.savedAt).toBe(NOW)
  })

  it('refuses a stale baseline with conflict and keeps the draft (no write)', async () => {
    const fake = saveFake({ state })
    await expect(clientOf(fake).saveEdits({
      resource: ISSUE, title: 'mine', body: 'mine', baseRevision: 'ghsb1-stale',
    })).rejects.toMatchObject({ category: 'conflict' })
    expect(fake.runs).toHaveLength(1)
    expect(fake.runs.some(run => run.args.includes('--body-file'))).toBe(false)
  })

  it('requires the base revision and a non-empty title before any command', async () => {
    const missing = saveFake({ state })
    await expect(clientOf(missing).saveEdits({ resource: ISSUE, title: 'x', body: 'y' }))
      .rejects.toMatchObject({ category: 'invalid-request' })
    expect(missing.runs).toHaveLength(0)

    const blank = saveFake({ state })
    await expect(clientOf(blank).saveEdits({
      resource: ISSUE, title: '   ', body: 'y', baseRevision: baseRevisionOf(state),
    })).rejects.toMatchObject({ category: 'invalid-request' })
    expect(blank.runs).toHaveLength(0)
  })

  it('does not write when the pre-save re-read fails', async () => {
    const fake = fakeRuntime(() => cliResult({
      exitCode: 1,
      stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)',
    }))
    await expect(clientOf(fake).saveEdits({
      resource: ISSUE, title: 'new', body: 'new', baseRevision: baseRevisionOf(state),
    })).rejects.toMatchObject({ category: 'rate-limited' })
    expect(fake.runs).toHaveLength(1)
    expect(fake.runs.some(run => run.args.includes('--body-file'))).toBe(false)
  })

  it('covers all four visibility x permission combinations without using visibility as a rule', async () => {
    // public/private is display metadata; ONLY the account's write permission
    // (and the actual 403) decides. All four combinations are exercised.
    for (const combo of [
      { private: false, permission: 'WRITE', writable: true },
      { private: true, permission: 'WRITE', writable: true },
      { private: false, permission: 'READ', writable: false },
      { private: true, permission: 'READ', writable: false },
    ]) {
      const fake = saveFake({ state, permission: combo.permission, private: combo.private })
      const outcome = await clientOf(fake).saveEdits({
        resource: ISSUE, title: 'new', body: 'new', baseRevision: baseRevisionOf(state),
      }).catch((caught: unknown) => caught)
      if (combo.writable) {
        expect(outcome).not.toBeInstanceOf(ClueError)
        expect(fake.runs.some(run => run.args.includes('--body-file'))).toBe(true)
      } else {
        expect(outcome).toBeInstanceOf(ClueError)
        expect((outcome as ClueError).category).toBe('permission-denied')
        expect(fake.runs.some(run => run.args.includes('--body-file'))).toBe(false)
      }
    }
    // Unknown permission is NOT pre-disabled (the write is attempted).
    const unknown = saveFake({ state, permission: null })
    await clientOf(unknown).saveEdits({
      resource: ISSUE, title: 'new', body: 'new', baseRevision: baseRevisionOf(state),
    })
    expect(unknown.runs.some(run => run.args.includes('--body-file'))).toBe(true)
  })

  it('refuses to write an archived or read-only repository', async () => {
    for (const options of [{ archived: true }, { permission: 'READ' }]) {
      const fake = saveFake({ state, ...options })
      const error = await clientOf(fake).saveEdits({
        resource: ISSUE, title: 'new', body: 'new', baseRevision: baseRevisionOf(state),
      }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(ClueError)
      expect((error as ClueError).category).toBe('permission-denied')
      expect(fake.runs).toHaveLength(1)
    }
  })

  it('maps a write 403 to permission-denied and does not claim success', async () => {
    const fake = saveFake({
      state,
      write: cliResult({ exitCode: 1, stderr: 'gh: Resource not accessible by integration (HTTP 403)' }),
    })
    await expect(clientOf(fake).saveEdits({
      resource: ISSUE, title: 'new', body: 'new', baseRevision: baseRevisionOf(state),
    })).rejects.toMatchObject({ category: 'permission-denied' })
    expect(fake.runs).toHaveLength(2)
    expect(fake.reports).toEqual([])
  })

  it('reports a write 401 to the shared connection as an expired sign-in', async () => {
    const fake = saveFake({
      state,
      write: cliResult({ exitCode: 1, stderr: 'gh: Bad credentials (HTTP 401)' }),
    })
    await expect(clientOf(fake).saveEdits({
      resource: ISSUE, title: 'new', body: 'new', baseRevision: baseRevisionOf(state),
    })).rejects.toMatchObject({ category: 'auth-required' })
    expect(fake.reports).toEqual([{ connectionId: GITHUB_CONNECTION_ID, authorization: 'expired' }])
  })

  it('keeps the successful save when the post-save re-read fails (no fabricated revision)', async () => {
    const fake = saveFake({ state, afterFails: true, after: { ...state, title: 'new', body: 'new' } })
    const result = await clientOf(fake).saveEdits({
      resource: ISSUE, title: 'new', body: 'new', baseRevision: baseRevisionOf(state),
    })
    expect(result.revision).toBeUndefined()
    expect(result.savedAt).toBe(NOW)
  })

  it('edits a pull request through the pr command', async () => {
    const fake = fakeRuntime((request) => {
      const query = argValue(request.args, 'query') ?? ''
      if (query.includes('pullRequest(number:$number)')) return cliResult({ stdout: fixture('pull-read.json') })
      return cliResult({ stdout: 'https://github.com/cli/cli/pull/14727\n' })
    })
    const base = githubRevisionOf({
      updatedAt: '2026-10-17T15:26:56Z',
      title: 'fix(issue create): resolve --type before creating the issue',
      body: '## Summary\n\nFixes #14703.\n',
      state: 'OPEN',
      isDraft: false,
      merged: false,
    })
    await clientOf(fake).saveEdits({ resource: PULL, title: 'renamed', body: '## Summary\n\nFixes #14703.\n', baseRevision: base })
    const edit = fake.runs[1]!
    expect(edit.args.slice(0, 3)).toEqual(['pr', 'edit', '14727'])
    expect(edit.args).toContain('--title')
  })
})
