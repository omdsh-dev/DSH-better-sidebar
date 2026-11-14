/**
 * S3 GitHub source operations through the REAL S1 clue service (fake runtime,
 * fake gh, no network/account).
 *
 * Pins: registration identity/capabilities and the shared dependency/
 * connection; list/search in one explicit repository, one page, with a
 * range-bound opaque cursor and the provider total only when reported (an
 * empty search is the first browse page); pure resolve (no gh, no persistence)
 * that only names a target from a canonical URL or an EXPLICIT source's
 * `owner/repo#number`; live read with the opaque revision and the model text
 * projection; loadEdit read-only reasons and the baseline; saveEdit refusing
 * agent callers, validating title/body, comparing the baseline (`conflict`)
 * and mapping permission failures; the portable form is exactly the normalized
 * locator.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/clues/request-gate.ts', () => vi.importActual('./fixtures/clues-source-request-gate.ts'))
import { createCluesService, type CluesService } from '../src/clues/service.ts'
import { ClueError } from '../src/clues/error.ts'
import type { ClueRuntime, CliResult, CliRunRequest } from '../src/clues/runtime/types.ts'
import {
  createGithubSources, GITHUB_CONNECTION_ID, GITHUB_DEPENDENCY_ID, GITHUB_FORMAT,
  GITHUB_MAX_EDITABLE_CHARS, GITHUB_SOURCE_IDS, GITHUB_TYPE_IDS, type GithubSourcesInstall,
} from '../src/clues/sources/github/index.ts'
import { githubRevisionOf } from '../src/clues/sources/github/revision.ts'
import type { Locator } from '../src/clues/types.ts'
import { removeTree } from './temp-tree.ts'

const NOW = '2026-10-17T00:00:00.000Z'
const WORKSPACE = 'ws-github'
const roots: string[] = []
afterEach(() => { for (const path of roots.splice(0)) removeTree(path) })

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-clues-github-source-'))
  roots.push(path)
  return path
}
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/clues-github/${name}`, import.meta.url), 'utf8')
const cliResult = (overrides: Partial<CliResult> = {}): CliResult => ({
  exitCode: 0, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 1, ...overrides,
})
interface FakeRuntime { readonly runtime: ClueRuntime; readonly runs: CliRunRequest[] }

/** A runtime whose only real verb is `runCli`; auth observations are inert. */
function fakeRuntime(handler: (request: CliRunRequest) => CliResult | Promise<CliResult>): FakeRuntime {
  const runs: CliRunRequest[] = []
  const runtime = {
    connections: { report: () => undefined },
    prepareCli: async (request: CliRunRequest) => () => runtime.runCli(request),
    runCli: async (request: CliRunRequest): Promise<CliResult> => { runs.push(request); return await handler(request) },
  } as unknown as ClueRuntime
  return { runtime, runs }
}

interface Setup { readonly fake: FakeRuntime; readonly install: GithubSourcesInstall; readonly service: CluesService }
function setup(handler: (request: CliRunRequest) => CliResult | Promise<CliResult>): Setup {
  const fake = fakeRuntime(handler)
  const install = createGithubSources({ runtime: () => fake.runtime, now: () => Date.parse(NOW), cwd: '/tmp/clues-github-source' })
  let next = 0
  const service = createCluesService({ root: tempRoot(), now: () => NOW, newId: kind => `${kind}-${++next}`, builtinSources: install.registrations })
  return { fake, install, service }
}

function argValue(args: readonly string[], key: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (!['-f', '-F', '--field', '--raw-field'].includes(args[index] ?? '')) continue
    const pair = args[index + 1]
    if (pair !== undefined && pair.startsWith(`${key}=`)) return pair.slice(key.length + 1)
  }
  return undefined
}
const locatorOf = (kind: 'issue' | 'pull', number = kind === 'issue' ? 14609 : 14727): Locator =>
  ({ host: 'github.com', owner: 'cli', repo: 'cli', kind, number })
const readParams = (kind: 'issue' | 'pull', locator: Locator = locatorOf(kind)) =>
  ({ workspaceId: WORKSPACE, sourceId: GITHUB_SOURCE_IDS[kind], typeId: GITHUB_TYPE_IDS[kind], locator })

function issuePayload(options: {
  title?: string; body?: string; updatedAt?: string; archived?: boolean; permission?: string
} = {}): string {
  const payload = JSON.parse(fixture('issue-read.json')) as { data: { repository: Record<string, unknown> & { issue: Record<string, unknown> } } }
  payload.data.repository.isArchived = options.archived ?? false
  payload.data.repository.viewerPermission = options.permission ?? 'READ'
  if (options.title !== undefined) payload.data.repository.issue.title = options.title
  if (options.body !== undefined) payload.data.repository.issue.body = options.body
  if (options.updatedAt !== undefined) payload.data.repository.issue.updatedAt = options.updatedAt
  return JSON.stringify(payload)
}

const STATE = { title: 'old title', body: 'old body', updatedAt: '2026-10-16T07:44:20Z' }
/** The fixture's body, reused for exact revision expectations. */
const ISSUE_BODY = (JSON.parse(fixture('issue-read.json')) as { data: { repository: { issue: { body: string } } } }).data.repository.issue.body
const revisionOf = (state: { title: string; body: string; updatedAt: string }): string =>
  githubRevisionOf({ updatedAt: state.updatedAt, title: state.title, body: state.body, state: 'OPEN' })

describe('registration catalogue', () => {
  it('advertises two CLI sources sharing gh and the account connection', () => {
    const { service } = setup(() => cliResult())
    const sources = service.getSources()
    expect(sources.map(source => source.sourceId)).toEqual([GITHUB_SOURCE_IDS.issue, GITHUB_SOURCE_IDS.pull])
    for (const source of sources) {
      expect([source.transport, source.icon, source.pluginId]).toEqual(['cli', 'github', 'dsh-better-sidebar'])
      expect([source.dependencyIds, source.connectionId]).toEqual([[GITHUB_DEPENDENCY_ID], GITHUB_CONNECTION_ID])
      expect(source.capabilities).toEqual({ resolve: true, list: true, search: true, read: true, edit: true, portable: true, comments: { read: true, create: true, reply: 'quote' } })
      expect(source.filters).toEqual([{ scopeKey: 'state', appliesTo: 'both', defaultOptionId: 'open',
        options: [{ id: 'open', value: 'open' }, { id: 'closed', value: 'closed' }, { id: 'all', value: 'all' }] }])
    }
    const types = service.getTypes()
    expect(types.map(type => type.typeId)).toEqual([GITHUB_TYPE_IDS.issue, GITHUB_TYPE_IDS.pull])
    for (const type of types) expect([type.formats, type.capabilities]).toEqual([[GITHUB_FORMAT], { read: true, edit: true, concurrency: 'check-before-save' }])
  })
})

describe('list and search', () => {
  it('lists ONE explicit repository page and exposes an opaque continuation cursor', async () => {
    const { fake, service } = setup(() => cliResult({ stdout: fixture('issue-list.json') }))
    const page = await service.list({ workspaceId: WORKSPACE, sourceId: GITHUB_SOURCE_IDS.issue, scope: { repo: 'cli/cli' } })
    expect(fake.runs).toHaveLength(1)
    expect(['first', 'owner'].map(key => argValue(fake.runs[0]!.args, key))).toEqual(['30', 'cli'])
    expect(page.total).toBe(1038)
    expect(page.items[0]).toMatchObject({ sourceId: GITHUB_SOURCE_IDS.issue, typeId: GITHUB_TYPE_IDS.issue, locator: locatorOf('issue', 14728), meta: { kind: 'issue', number: 14728, state: 'OPEN' } })
    expect(page.items[0]?.info).toEqual({
      state: 'open', number: 14728, repository: 'cli/cli',
      author: { handle: 'cli-triage', name: 'CLI Triage', url: 'https://github.com/apps/cli-triage' },
      assignees: [{ handle: 'octocat', name: 'The Octocat', url: 'https://github.com/octocat' }],
      labels: ['triage'], createdAt: '2026-10-17T19:30:00.000Z', updatedAt: '2026-10-17T19:43:04.000Z',
    })
    // Absent provider metadata stays absent; no people/labels are invented.
    expect(page.items[1]?.info).toEqual({
      state: 'open', number: 14732, repository: 'cli/cli',
      author: { handle: 'phatcharaporn1134' }, updatedAt: '2026-10-17T19:32:31.000Z',
    })
    expect([page.nextCursor !== undefined, page.nextCursor?.includes('cli/cli'), page.nextCursor?.includes('Y3Vyc29yOnYyOpK0')]).toEqual([true, false, false])
  })

  it('requires an explicit repository and clamps the requested page size', async () => {
    const { fake, service } = setup(() => cliResult({ stdout: fixture('issue-list.json') }))
    await expect(service.list({ workspaceId: WORKSPACE, sourceId: GITHUB_SOURCE_IDS.issue })).rejects.toMatchObject({ category: 'invalid-request' })
    expect(fake.runs).toHaveLength(0)
    await service.list({ workspaceId: WORKSPACE, sourceId: GITHUB_SOURCE_IDS.issue, scope: 'cli/cli', limit: 500 })
    expect(argValue(fake.runs[0]!.args, 'first')).toBe('100')
  })

  it('searches only inside that repository and kind, treating an empty query as browse', async () => {
    const issueSearch = setup(() => cliResult({ stdout: fixture('search-issues.json') }))
    const page = await issueSearch.service.search({ workspaceId: WORKSPACE, sourceId: GITHUB_SOURCE_IDS.issue, scope: { repo: 'cli/cli', state: 'open' }, query: 'repo:evil/repo is:pr release' })
    expect([argValue(issueSearch.fake.runs[0]!.args, 'q'), page.total, page.items[0]?.locator]).toEqual(['repo:cli/cli is:issue state:open release', 519, locatorOf('issue', 14609)])
    const pullSearch = setup(() => cliResult({ stdout: fixture('search-pulls.json') }))
    await pullSearch.service.search({ workspaceId: WORKSPACE, sourceId: GITHUB_SOURCE_IDS.pull, scope: 'cli/cli', query: 'fix' })
    expect(argValue(pullSearch.fake.runs[0]!.args, 'q')).toBe('repo:cli/cli is:pr state:open fix')
    // An empty query is the first browse page, never a cross-repository search.
    const browse = setup(request => argValue(request.args, 'q') === undefined
      ? cliResult({ stdout: fixture('issue-list.json') })
      : cliResult({ stdout: fixture('search-issues.json') }))
    const empty = await browse.service.search({ workspaceId: WORKSPACE, sourceId: GITHUB_SOURCE_IDS.issue, scope: 'cli/cli', query: '   ' })
    expect([browse.fake.runs.length, argValue(browse.fake.runs[0]!.args, 'q')]).toEqual([1, undefined])
    expect(empty.items[0]?.meta).toMatchObject({ number: 14728 })
  })

  it('continues with the provider cursor and refuses a cursor from another scope or query', async () => {
    const { fake, service } = setup(request => {
      if (argValue(request.args, 'q') !== undefined) return cliResult({ stdout: fixture('search-issues.json') })
      if (argValue(request.args, 'after') !== undefined) {
        return cliResult({ stdout: JSON.stringify({ data: { repository: { issues: {
          totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ number: 42, title: 'second page', state: 'OPEN', updatedAt: '2026-10-17T00:00:00Z', url: 'https://github.com/cli/cli/issues/42', author: null }],
        } } } }) })
      }
      return cliResult({ stdout: fixture('issue-list.json') })
    })
    const list = { workspaceId: WORKSPACE, sourceId: GITHUB_SOURCE_IDS.issue, scope: { repo: 'cli/cli' } }
    const first = await service.list(list)
    const second = await service.list({ ...list, cursor: first.nextCursor })
    expect(argValue(fake.runs[1]!.args, 'after')).toBe('Y3Vyc29yOnYyOpK0MjAyNi0xMC0xN1QxOTozMjozMVrPAAAAAV_M_JY=')
    expect([second.nextCursor, second.items[0]?.meta]).toMatchObject([undefined, { number: 42 }])
    // A cursor belongs to its scope: switching repository or query restarts.
    const before = fake.runs.length
    await expect(service.list({ ...list, scope: { repo: 'octocat/Hello-World' }, cursor: first.nextCursor })).rejects.toMatchObject({ category: 'invalid-request' })
    expect(fake.runs).toHaveLength(before)
    const search = await service.search({ workspaceId: WORKSPACE, sourceId: GITHUB_SOURCE_IDS.issue, scope: 'cli/cli', query: 'bug' })
    await expect(service.search({ workspaceId: WORKSPACE, sourceId: GITHUB_SOURCE_IDS.issue, scope: 'cli/cli', query: 'different', cursor: search.nextCursor })).rejects.toMatchObject({ category: 'invalid-request' })
  })
})

describe('resolve', () => {
  it('resolves canonical URLs without running gh or persisting a clue', async () => {
    const { fake, service } = setup(() => cliResult())
    const pull = await service.resolve({ workspaceId: WORKSPACE, text: 'https://github.com/cli/cli/pull/14727#discussion_r1' })
    expect(pull).toHaveLength(1)
    expect(pull[0]).toMatchObject({ sourceId: GITHUB_SOURCE_IDS.pull, typeId: GITHUB_TYPE_IDS.pull, locator: locatorOf('pull'), title: 'cli/cli#14727' })
    const issue = await service.resolve({ workspaceId: WORKSPACE, text: 'https://github.com/cli/cli/issues/14609' })
    expect(issue.map(candidate => candidate.sourceId)).toEqual([GITHUB_SOURCE_IDS.issue])
    expect(fake.runs).toHaveLength(0)
    expect((await service.listClues(WORKSPACE)).clues).toHaveLength(0)
  })

  it('resolves the kind-less shorthand only for an explicit source and rejects a URL mismatch', async () => {
    const { service } = setup(() => cliResult())
    expect(await service.resolve({ workspaceId: WORKSPACE, text: 'cli/cli#12' })).toEqual([])
    const issue = await service.resolve({ workspaceId: WORKSPACE, sourceId: GITHUB_SOURCE_IDS.issue, text: 'cli/cli#12' })
    const pull = await service.resolve({ workspaceId: WORKSPACE, sourceId: GITHUB_SOURCE_IDS.pull, text: 'cli/cli#12' })
    expect([issue[0]?.typeId, pull[0]?.typeId]).toEqual([GITHUB_TYPE_IDS.issue, GITHUB_TYPE_IDS.pull])
    await expect(service.resolve({ workspaceId: WORKSPACE, sourceId: GITHUB_SOURCE_IDS.issue, text: 'https://github.com/cli/cli/pull/14727' })).rejects.toMatchObject({ category: 'unsupported' })
  })

  it('reuses one stable reference for the same resource without copying extra locator fields', async () => {
    const { service } = setup(() => cliResult())
    const first = await service.ensure({ workspaceId: WORKSPACE, sourceId: GITHUB_SOURCE_IDS.issue, typeId: GITHUB_TYPE_IDS.issue, locator: locatorOf('issue', 12), title: 'one' })
    const again = await service.ensure({ workspaceId: WORKSPACE, sourceId: GITHUB_SOURCE_IDS.issue, typeId: GITHUB_TYPE_IDS.issue, locator: { ...locatorOf('issue', 12), token: 'gho_secret', path: '/tmp/x' }, title: 'two' })
    expect([first.created, again.created, again.clue.id]).toEqual([true, false, first.clue.id])
    expect([JSON.stringify(again.clue.locator).includes('gho_secret'), again.clue.locator]).toEqual([false, locatorOf('issue', 12)])
  })
})

describe('read and loadEdit', () => {
  it('reads the live resource, its revision and the model text projection without any auth probe', async () => {
    const { fake, service } = setup(() => cliResult({ stdout: fixture('issue-read.json') }))
    const result = await service.read({ ...readParams('issue'), includeDiscussion: false })
    expect([result.format, result.freshness, result.fetchedAt]).toEqual([GITHUB_FORMAT, 'live', NOW])
    expect(result.revision).toBe(revisionOf({ title: 'gh release list -R https://github.com/cli/cli/ -> error', body: ISSUE_BODY, updatedAt: '2026-10-16T07:44:20Z' }))
    expect(result.data).toMatchObject({ kind: 'issue', owner: 'cli', repo: 'cli', number: 14609, state: 'OPEN', author: 'tps800', labels: ['bug', 'release'], isArchived: false, viewerPermission: 'READ' })
    const text = result.text ?? ''
    expect([text.includes('gh release list'), text.includes('- state: OPEN'), text.includes('### Describe the bug')]).toEqual([true, true, true])
    expect(result.info).toEqual({
      state: 'open', number: 14609, repository: 'cli/cli',
      author: { handle: 'tps800', name: 'TPS', url: 'https://github.com/tps800' },
      assignees: [{ handle: 'octocat', name: 'The Octocat', url: 'https://github.com/octocat' }],
      labels: ['bug', 'release'], createdAt: '2026-10-05T09:12:00.000Z',
      updatedAt: '2026-10-16T07:44:20.000Z', counts: { comments: 7 },
    })
    expect([fake.runs.length, fake.runs[0]!.args.includes('auth')]).toEqual([1, false])
  })

  it('reads and exports a saved clue by id through the stored locator', async () => {
    const { fake, service } = setup(() => cliResult({ stdout: fixture('issue-read.json') }))
    const ensured = await service.ensure({ workspaceId: WORKSPACE, sourceId: GITHUB_SOURCE_IDS.issue, typeId: GITHUB_TYPE_IDS.issue, locator: locatorOf('issue', 14609), title: 'saved issue' })
    const read = await service.read({ workspaceId: WORKSPACE, clueId: ensured.clue.id })
    expect(read.data).toMatchObject({ number: 14609, owner: 'cli', repo: 'cli' })
    expect(argValue(fake.runs[0]!.args, 'number')).toBe('14609')
    expect(await service.portable({ workspaceId: WORKSPACE, clueId: ensured.clue.id })).toEqual({ portable: true, locator: locatorOf('issue', 14609) })
  })

  it('reads PR-only draft/merged state and maps branches/counts into info', async () => {
    const { service } = setup(() => cliResult({ stdout: fixture('pull-read.json') }))
    const result = await service.read(readParams('pull'))
    const checkRuns = [
      { name: 'build (macos)', state: 'success', url: 'https://github.com/cli/cli/runs/1' },
      { name: 'test (ubuntu)', state: 'pending', url: 'https://github.com/cli/cli/runs/2' },
      { name: 'lint', state: 'failure', url: 'https://github.com/cli/cli/runs/3' },
      { name: 'ci/circleci: docs', state: 'success', url: 'https://circleci.example/1' },
    ]
    // The document half carries the same bounded check list the header reads.
    expect(result.data).toMatchObject({ kind: 'pull', isDraft: false, merged: false, checkRuns })
    expect(result.info).toEqual({
      state: 'open', number: 14727, repository: 'cli/cli',
      author: { handle: 'umairnaeem0309', name: 'Umair Naeem', url: 'https://github.com/umairnaeem0309', avatarUrl: 'https://avatars.githubusercontent.com/u/1234?v=4' },
      assignees: [{ handle: 'cli-triage', name: 'CLI Triage', url: 'https://github.com/apps/cli-triage' }],
      labels: ['bug'], createdAt: '2026-10-17T12:00:00.000Z', updatedAt: '2026-10-17T15:26:56.000Z',
      branches: { head: 'fix/type-resolution', base: 'trunk', headRepository: 'umairnaeem0309/cli', baseRepository: 'cli/cli' },
      counts: { comments: 5, commits: 12, changedFiles: 3, additions: 42, deletions: 7 },
      review: 'approved', mergeable: 'mergeable', checks: 'success', checkRuns, checkCount: 28, mergeStatus: 'ready',
    })
  })

  it.each([
    { name: 'merged', fields: { state: 'MERGED', merged: true, mergedAt: '2026-10-17T16:00:00Z', closedAt: '2026-10-17T16:00:01Z', isDraft: false }, expected: { state: 'merged', completedAt: '2026-10-17T16:00:00.000Z' } },
    { name: 'draft', fields: { isDraft: true, state: 'OPEN', merged: false }, expected: { state: 'draft', branches: { head: 'fix/type-resolution', base: 'trunk', baseRepository: 'cli/cli' } } },
  ])('maps a $name PR state from the same GraphQL response', async ({ fields, expected }) => {
    const payload = JSON.parse(fixture('pull-read.json')) as { data: { repository: { pullRequest: Record<string, unknown> } } }
    Object.assign(payload.data.repository.pullRequest, fields)
    const { service } = setup(() => cliResult({ stdout: JSON.stringify(payload) }))
    expect((await service.read(readParams('pull'))).info).toMatchObject(expected)
  })

  it('reports a kind mismatch as unsupported and a rate limit as rate-limited', async () => {
    const notFound = JSON.stringify({
      data: { repository: { isArchived: false, viewerPermission: 'READ', issue: null } },
      errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to an Issue with the number of 1.' }],
    })
    const mismatch = setup(request => (argValue(request.args, 'query') ?? '').includes('issue(number:$number)')
      ? cliResult({ exitCode: 1, stdout: notFound, stderr: 'gh: Could not resolve to an Issue with the number of 1.' })
      : cliResult({ stdout: fixture('pull-read.json') }))
    await expect(mismatch.service.read(readParams('issue', locatorOf('issue', 1)))).rejects.toMatchObject({ category: 'unsupported' })
    const limited = setup(() => cliResult({ exitCode: 1, stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)' }))
    await expect(limited.service.read(readParams('issue'))).rejects.toMatchObject({ category: 'rate-limited' })
    expect(limited.fake.runs).toHaveLength(1)
  })

  it('refuses a type that belongs to the other source and a pre-aborted call', async () => {
    const { fake, service } = setup(() => cliResult({ stdout: fixture('issue-read.json') }))
    await expect(service.read({ workspaceId: WORKSPACE, sourceId: GITHUB_SOURCE_IDS.issue, typeId: GITHUB_TYPE_IDS.pull, locator: locatorOf('pull') })).rejects.toMatchObject({ category: 'unsupported' })
    const controller = new AbortController()
    controller.abort()
    await expect(service.read(readParams('issue'), { signal: controller.signal })).rejects.toMatchObject({ category: 'cancelled' })
    expect(fake.runs).toHaveLength(0)
  })

  it('loads the editable document with the baseline and no read-only marker', async () => {
    const { service } = setup(() => cliResult({ stdout: issuePayload({ permission: 'WRITE' }) }))
    const document = await service.loadEdit(readParams('issue'))
    expect([document.format, document.baseRevision]).toEqual([GITHUB_FORMAT, revisionOf({ title: 'gh release list -R https://github.com/cli/cli/ -> error', body: ISSUE_BODY, updatedAt: '2026-10-16T07:44:20Z' })])
    expect(document.data).toMatchObject({ title: 'gh release list -R https://github.com/cli/cli/ -> error' })
    expect((document.data as Record<string, unknown>).readOnly).toBeUndefined()
  })

  it.each([
    { name: 'archived', payload: issuePayload({ archived: true, permission: 'WRITE' }), reason: 'archived' },
    { name: 'read-only', payload: issuePayload({ permission: 'READ' }), reason: 'permission-denied' },
    { name: 'oversized', payload: issuePayload({ permission: 'WRITE', body: 'x'.repeat(GITHUB_MAX_EDITABLE_CHARS + 1) }), reason: 'size' },
  ])('marks an $name document read-only with the reason', async ({ payload, reason }) => {
    const { service } = setup(() => cliResult({ stdout: payload }))
    expect((await service.loadEdit(readParams('issue'))).data).toMatchObject({ readOnly: true, readOnlyReason: reason })
  })
})

describe('saveEdit', () => {
  function saveSetup(): Setup {
    let reads = 0
    return setup((request) => {
      if (!(argValue(request.args, 'query') ?? '').includes('issue(number:$number)')) return cliResult({ stdout: 'https://github.com/cli/cli/issues/14609\n' })
      reads += 1
      return cliResult({ stdout: reads === 1
        ? issuePayload({ ...STATE, permission: 'WRITE' })
        : issuePayload({ title: 'new title', body: 'old body', updatedAt: '2026-10-17T10:00:00Z', permission: 'WRITE' }) })
    })
  }

  it('saves only the changed fields after comparing the baseline', async () => {
    const { fake, service } = saveSetup()
    const outcome = await service.saveEdit({ ...readParams('issue'), document: { format: GITHUB_FORMAT, data: { title: 'new title', body: 'old body' }, baseRevision: revisionOf(STATE) } })
    expect(outcome.revision).toBe(revisionOf({ title: 'new title', body: 'old body', updatedAt: '2026-10-17T10:00:00Z' }))
    expect(outcome.info).toMatchObject({ state: 'open', number: 14609, repository: 'cli/cli', updatedAt: '2026-10-17T10:00:00.000Z' })
    expect([outcome.savedAt, fake.runs.every(run => !run.args.includes('auth'))]).toEqual([NOW, true])
    expect(fake.runs[1]!.args.slice(0, 3)).toEqual(['issue', 'edit', '14609'])
    expect([fake.runs[1]!.args.includes('--title'), fake.runs[1]!.args.includes('--body-file')]).toEqual([true, false])
  })

  it('refuses an agent caller and a stale baseline without writing', async () => {
    const agent = saveSetup()
    await expect(agent.service.saveEdit({ ...readParams('issue'), document: { format: GITHUB_FORMAT, data: { title: 'x', body: 'y' }, baseRevision: revisionOf(STATE) } }, { caller: 'agent' })).rejects.toMatchObject({ category: 'unsupported' })
    expect(agent.fake.runs).toHaveLength(0)
    const stale = saveSetup()
    await expect(stale.service.saveEdit({ ...readParams('issue'), document: { format: GITHUB_FORMAT, data: { title: 'x', body: 'y' }, baseRevision: 'ghsb1-stale' } })).rejects.toMatchObject({ category: 'conflict' })
    expect(stale.fake.runs).toHaveLength(1)
  })

  it.each([
    { name: 'foreign format', document: { format: 'text/plain', data: { title: 'x', body: 'y' }, baseRevision: 'r' }, category: 'unsupported' },
    { name: 'empty title', document: { format: GITHUB_FORMAT, data: { title: '', body: 'y' }, baseRevision: 'r' }, category: 'invalid-request' },
    { name: 'oversized body', document: { format: GITHUB_FORMAT, data: { title: 'x', body: 'y'.repeat(GITHUB_MAX_EDITABLE_CHARS + 1) }, baseRevision: 'r' }, category: 'unsupported' },
    { name: 'missing baseline', document: { format: GITHUB_FORMAT, data: { title: 'x', body: 'y' } }, category: 'invalid-request' },
  ])('validates a $name document before touching gh', async ({ document, category }) => {
    const { fake, service } = setup(() => cliResult())
    await expect(service.saveEdit({ ...readParams('issue'), document })).rejects.toMatchObject({ category })
    expect(fake.runs).toHaveLength(0)
  })

  it('refuses to write an archived repository', async () => {
    const { fake, service } = setup(() => cliResult({ stdout: issuePayload({ ...STATE, archived: true, permission: 'WRITE' }) }))
    await expect(service.saveEdit({ ...readParams('issue'), document: { format: GITHUB_FORMAT, data: { title: 'x', body: 'y' }, baseRevision: revisionOf(STATE) } })).rejects.toMatchObject({ category: 'permission-denied' })
    expect(fake.runs).toHaveLength(1)
  })
})

describe('portable', () => {
  it('exports exactly the normalized locator (no token, account or path)', async () => {
    const { fake, service } = setup(() => cliResult())
    const portable = await service.portable(readParams('issue', { ...locatorOf('issue', 7), token: 'gho_secret', path: '/Users/someone/private' }))
    expect(portable).toEqual({ portable: true, locator: locatorOf('issue', 7) })
    expect(['gho_secret', '/Users/', 'token', 'account'].filter(forbidden => JSON.stringify(portable).includes(forbidden))).toEqual([])
    expect(fake.runs).toHaveLength(0)
  })

  it('leaves already-saved local references untouched when a repository search fails', async () => {
    const { service } = setup(() => cliResult({ exitCode: 1, stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)' }))
    const ensured = await service.ensure({ workspaceId: WORKSPACE, sourceId: GITHUB_SOURCE_IDS.issue, typeId: GITHUB_TYPE_IDS.issue, locator: locatorOf('issue', 14609), title: 'saved clue' })
    await expect(service.search({ workspaceId: WORKSPACE, sourceId: GITHUB_SOURCE_IDS.issue, scope: 'cli/cli', query: 'anything' })).rejects.toMatchObject({ category: 'rate-limited' })
    expect((await service.listClues(WORKSPACE)).clues.map(clue => clue.id)).toEqual([ensured.clue.id])
  })

  it('keeps a ClueError category through the service boundary', async () => {
    const { service } = setup(() => cliResult({ exitCode: 1, stderr: 'gh: Not Found (HTTP 404)' }))
    const error = await service.read(readParams('issue')).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ClueError)
    expect([(error as ClueError).category, (error as ClueError).message.includes('Not Found')]).toEqual(['not-found', false])
  })
})
