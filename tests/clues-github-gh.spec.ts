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
 *   stderr or tokens.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
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
import { GITHUB_DEPENDENCY_ID } from '../src/clues/sources/github/ids.ts'
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

interface FakeRuntime {
  readonly runtime: ClueRuntime
  readonly runs: CliRunRequest[]
}

/** A runtime whose only real verb is `runCli`; everything else is inert. */
function fakeRuntime(handler: (request: CliRunRequest) => CliResult | Promise<CliResult>): FakeRuntime {
  const runs: CliRunRequest[] = []
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
      report: () => undefined,
      dispose: () => undefined,
    },
    http: { request: unused },
    mcp: { callTool: unused },
    runCli: async (request: CliRunRequest): Promise<CliResult> => {
      runs.push(request)
      return await handler(request)
    },
    runCliJson: unused,
    dispose: () => undefined,
  } as unknown as ClueRuntime
  return { runtime, runs }
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
      updatedAt: '2026-10-17T19:43:04Z',
      url: 'https://github.com/cli/cli/issues/14728',
      author: 'cli-triage',
    })
    expect(page.items[1]?.author).toBe('phatcharaporn1134')
    expect(page.total).toBe(1038)
    expect(page.nextAfter).toBe('Y3Vyc29yOnYyOpK0MjAyNi0xMC0xN1QxOTozMjozMVrPAAAAAV_M_JY=')
    expect(page.limited).toBeUndefined()
  })

  it('uses the pull request connection for the pull kind and carries draft/merged data', async () => {
    const fake = fakeRuntime(() => cliResult({ stdout: fixture('pull-list.json') }))
    const page = await clientOf(fake).listPage(listQuery({ kind: 'pull' }))

    const request = fake.runs[0]!
    expect(argValue(request.args, 'query')).toContain('pullRequests(first:$first')
    expect(argValue(request.args, 'query')).toContain('PullRequestState')
    expect(argValue(request.args, 'states[]')).toBe('OPEN')
    expect(page.total).toBe(71)
    expect(page.items[0]?.isDraft).toBe(false)
    expect(page.items[1]?.state).toBe('MERGED')
    expect(page.items[1]?.merged).toBe(true)
    expect(page.items[1]?.mergedAt).toBe('2026-10-17T10:03:56Z')
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
    expect(argValue(request.args, 'query')).toContain('issue(number:$number)')
    expect(argValue(request.args, 'number')).toBe('14609')
    expect(argValue(request.args, 'owner')).toBe('cli')
    expect(argValue(request.args, 'repo')).toBe('cli')

    expect(snapshot.resource).toEqual(ISSUE)
    expect(snapshot.title).toBe('gh release list -R https://github.com/cli/cli/ -> error')
    expect(snapshot.body).toContain('### Describe the bug')
    expect(snapshot.state).toBe('OPEN')
    expect(snapshot.author).toBe('tps800')
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
    expect(argValue(fake.runs[0]!.args, 'query')).toContain('pullRequest(number:$number)')
    expect(snapshot.isDraft).toBe(false)
    expect(snapshot.merged).toBe(false)
    expect(snapshot.mergedAt).toBeUndefined()
    expect(snapshot.viewerPermission).toBe('TRIAGE')
    expect(snapshot.labels).toEqual([])
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
    permission?: string
    archived?: boolean
  }): FakeRuntime {
    let reads = 0
    return fakeRuntime((request) => {
      const query = argValue(request.args, 'query') ?? ''
      if (query.includes('issue(number:$number)') || query.includes('pullRequest(number:$number)')) {
        reads += 1
        const payload = JSON.parse(fixture('issue-read.json')) as Record<string, unknown>
        const data = payload.data as { repository: Record<string, unknown> & { issue: Record<string, unknown> } }
        data.repository.viewerPermission = options.permission ?? 'WRITE'
        data.repository.isArchived = options.archived ?? false
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
