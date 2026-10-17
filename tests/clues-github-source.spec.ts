/**
 * S3 GitHub source operations through the REAL S1 clue service (fake runtime,
 * fake gh, no network/account).
 *
 * The cases pin the approved S3 contract end to end at the seam later specs
 * consume:
 * - registration identity/capabilities and the shared dependency/connection;
 * - list/search stay in one explicit repository, one page, with a range-bound
 *   opaque cursor and the provider total only when reported; an empty search
 *   is the first browse page;
 * - resolve is pure (no gh, no persistence) and only a canonical URL or an
 *   EXPLICIT source's `owner/repo#number` names a target;
 * - read is live, carries the opaque revision and the model text projection;
 * - loadEdit exposes read-only reasons (archived/permission/size) and the
 *   baseline; saveEdit refuses agent callers, validates title/body, compares
 *   the baseline (`conflict`), and maps permission failures;
 * - the portable form is exactly the normalized locator.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCluesService, type CluesService } from '../src/clues/service.ts'
import { ClueError } from '../src/clues/error.ts'
import type { ClueRuntime, CliResult, CliRunRequest } from '../src/clues/runtime/types.ts'
import {
  createGithubSources,
  GITHUB_CONNECTION_ID,
  GITHUB_DEPENDENCY_ID,
  GITHUB_FORMAT,
  GITHUB_MAX_EDITABLE_CHARS,
  GITHUB_SOURCE_IDS,
  GITHUB_TYPE_IDS,
  type GithubSourcesInstall,
} from '../src/clues/sources/github/index.ts'
import { githubRevisionOf } from '../src/clues/sources/github/revision.ts'
import type { Locator } from '../src/clues/types.ts'
import { removeTree } from './temp-tree.ts'

const NOW = '2026-10-17T00:00:00.000Z'
const WORKSPACE = 'ws-github'
const roots: string[] = []

afterEach(() => {
  for (const path of roots.splice(0)) removeTree(path)
})

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-clues-github-source-'))
  roots.push(path)
  return path
}

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

function fakeRuntime(handler: (request: CliRunRequest) => CliResult | Promise<CliResult>): FakeRuntime {
  const runs: CliRunRequest[] = []
  const unused = async (): Promise<never> => { throw new Error('not used') }
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

interface Setup {
  readonly fake: FakeRuntime
  readonly install: GithubSourcesInstall
  readonly service: CluesService
}

function setup(handler: (request: CliRunRequest) => CliResult | Promise<CliResult>): Setup {
  const fake = fakeRuntime(handler)
  const install = createGithubSources({
    runtime: () => fake.runtime,
    now: () => Date.parse(NOW),
    cwd: '/tmp/clues-github-source',
  })
  let next = 0
  const service = createCluesService({
    root: tempRoot(),
    now: () => NOW,
    newId: kind => `${kind}-${++next}`,
    builtinSources: install.registrations,
  })
  return { fake, install, service }
}

function argValue(args: readonly string[], key: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (flag !== '-f' && flag !== '-F' && flag !== '--field' && flag !== '--raw-field') continue
    const pair = args[index + 1]
    if (pair !== undefined && pair.startsWith(`${key}=`)) return pair.slice(key.length + 1)
  }
  return undefined
}

function locatorOf(kind: 'issue' | 'pull', number = kind === 'issue' ? 14609 : 14727): Locator {
  return { host: 'github.com', owner: 'cli', repo: 'cli', kind, number }
}

function readParams(kind: 'issue' | 'pull', locator: Locator = locatorOf(kind)) {
  return {
    workspaceId: WORKSPACE,
    sourceId: GITHUB_SOURCE_IDS[kind],
    typeId: GITHUB_TYPE_IDS[kind],
    locator,
  }
}

function issuePayload(options: {
  title?: string
  body?: string
  updatedAt?: string
  archived?: boolean
  permission?: string
} = {}): string {
  const payload = JSON.parse(fixture('issue-read.json')) as {
    data: { repository: Record<string, unknown> & { issue: Record<string, unknown> } }
  }
  payload.data.repository.isArchived = options.archived ?? false
  payload.data.repository.viewerPermission = options.permission ?? 'READ'
  if (options.title !== undefined) payload.data.repository.issue.title = options.title
  if (options.body !== undefined) payload.data.repository.issue.body = options.body
  if (options.updatedAt !== undefined) payload.data.repository.issue.updatedAt = options.updatedAt
  return JSON.stringify(payload)
}

const STATE = { title: 'old title', body: 'old body', updatedAt: '2026-10-16T07:44:20Z' }

/** The fixture's body, reused for exact revision expectations. */
const ISSUE_BODY = (JSON.parse(fixture('issue-read.json')) as {
  data: { repository: { issue: { body: string } } }
}).data.repository.issue.body

function revisionOf(state: { title: string; body: string; updatedAt: string }): string {
  return githubRevisionOf({
    updatedAt: state.updatedAt,
    title: state.title,
    body: state.body,
    state: 'OPEN',
  })
}

describe('registration catalogue', () => {
  it('advertises two separate CLI sources sharing gh and the account connection', () => {
    const { service } = setup(() => cliResult())
    const sources = service.getSources()
    expect(sources.map(source => source.sourceId)).toEqual([
      GITHUB_SOURCE_IDS.issue,
      GITHUB_SOURCE_IDS.pull,
    ])
    for (const source of sources) {
      expect(source.transport).toBe('cli')
      expect(source.icon).toBe('github')
      expect(source.pluginId).toBe('dsh-better-sidebar')
      expect(source.dependencyIds).toEqual([GITHUB_DEPENDENCY_ID])
      expect(source.connectionId).toBe(GITHUB_CONNECTION_ID)
      expect(source.capabilities).toEqual({
        resolve: true, list: true, search: true, read: true, edit: true, portable: true,
      })
    }
    const types = service.getTypes()
    expect(types.map(type => type.typeId)).toEqual([GITHUB_TYPE_IDS.issue, GITHUB_TYPE_IDS.pull])
    for (const type of types) {
      expect(type.formats).toEqual([GITHUB_FORMAT])
      expect(type.capabilities).toEqual({ read: true, edit: true, concurrency: 'check-before-save' })
    }
  })
})

describe('list and search', () => {
  it('lists ONE explicit repository page and exposes an opaque continuation cursor', async () => {
    const { fake, service } = setup(() => cliResult({ stdout: fixture('issue-list.json') }))
    const page = await service.list({
      workspaceId: WORKSPACE,
      sourceId: GITHUB_SOURCE_IDS.issue,
      scope: { repo: 'cli/cli' },
    })
    expect(fake.runs).toHaveLength(1)
    expect(argValue(fake.runs[0]!.args, 'first')).toBe('30')
    expect(argValue(fake.runs[0]!.args, 'owner')).toBe('cli')
    expect(page.total).toBe(1038)
    expect(page.items[0]?.sourceId).toBe(GITHUB_SOURCE_IDS.issue)
    expect(page.items[0]?.typeId).toBe(GITHUB_TYPE_IDS.issue)
    expect(page.items[0]?.locator).toEqual(locatorOf('issue', 14728))
    expect(page.items[0]?.meta).toMatchObject({ kind: 'issue', number: 14728, state: 'OPEN' })
    expect(page.nextCursor).toBeDefined()
    expect(page.nextCursor).not.toContain('cli/cli')
    expect(page.nextCursor).not.toContain('Y3Vyc29yOnYyOpK0')
  })

  it('requires an explicit repository instead of sweeping every repository', async () => {
    const { fake, service } = setup(() => cliResult({ stdout: fixture('issue-list.json') }))
    await expect(service.list({ workspaceId: WORKSPACE, sourceId: GITHUB_SOURCE_IDS.issue }))
      .rejects.toMatchObject({ category: 'invalid-request' })
    expect(fake.runs).toHaveLength(0)
  })

  it('clamps a large requested page size to the source bound', async () => {
    const { fake, service } = setup(() => cliResult({ stdout: fixture('issue-list.json') }))
    await service.list({
      workspaceId: WORKSPACE,
      sourceId: GITHUB_SOURCE_IDS.issue,
      scope: 'cli/cli',
      limit: 500,
    })
    expect(argValue(fake.runs[0]!.args, 'first')).toBe('100')
  })

  it('searches only inside that repository and kind, and selects the pull connection for pulls', async () => {
    const issueSearch = setup(() => cliResult({ stdout: fixture('search-issues.json') }))
    const page = await issueSearch.service.search({
      workspaceId: WORKSPACE,
      sourceId: GITHUB_SOURCE_IDS.issue,
      scope: { repo: 'cli/cli', state: 'open' },
      query: 'repo:evil/repo is:pr release',
    })
    expect(argValue(issueSearch.fake.runs[0]!.args, 'q'))
      .toBe('repo:cli/cli is:issue state:open release')
    expect(page.total).toBe(519)
    expect(page.items[0]?.locator).toEqual(locatorOf('issue', 14609))

    const pullSearch = setup(() => cliResult({ stdout: fixture('search-pulls.json') }))
    await pullSearch.service.search({
      workspaceId: WORKSPACE,
      sourceId: GITHUB_SOURCE_IDS.pull,
      scope: 'cli/cli',
      query: 'fix',
    })
    expect(argValue(pullSearch.fake.runs[0]!.args, 'q'))
      .toBe('repo:cli/cli is:pr state:open fix')
  })

  it('treats an empty search as the first browse page, never a cross-repository search', async () => {
    const fake = fakeRuntime((request) =>
      argValue(request.args, 'q') === undefined
        ? cliResult({ stdout: fixture('issue-list.json') })
        : cliResult({ stdout: fixture('search-issues.json') }))
    const install = createGithubSources({ runtime: () => fake.runtime, now: () => Date.parse(NOW), cwd: '/tmp/gh' })
    const service = createCluesService({
      root: tempRoot(),
      now: () => NOW,
      newId: kind => `${kind}-${fake.runs.length}`,
      builtinSources: install.registrations,
    })
    const page = await service.search({
      workspaceId: WORKSPACE,
      sourceId: GITHUB_SOURCE_IDS.issue,
      scope: 'cli/cli',
      query: '   ',
    })
    expect(fake.runs).toHaveLength(1)
    expect(argValue(fake.runs[0]!.args, 'q')).toBeUndefined()
    expect(page.items[0]?.meta).toMatchObject({ number: 14728 })
  })

  it('continues with the provider cursor and refuses a cursor from another scope or query', async () => {
    const { fake, service } = setup(request => {
      const search = argValue(request.args, 'q') !== undefined
      const after = argValue(request.args, 'after') !== undefined
      if (search) return cliResult({ stdout: fixture('search-issues.json') })
      if (after) {
        return cliResult({
          stdout: JSON.stringify({
            data: {
              repository: {
                issues: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [{
                    number: 42,
                    title: 'second page',
                    state: 'OPEN',
                    updatedAt: '2026-10-17T00:00:00Z',
                    url: 'https://github.com/cli/cli/issues/42',
                    author: null,
                  }],
                },
              },
            },
          }),
        })
      }
      return cliResult({ stdout: fixture('issue-list.json') })
    })
    const first = await service.list({
      workspaceId: WORKSPACE,
      sourceId: GITHUB_SOURCE_IDS.issue,
      scope: { repo: 'cli/cli' },
    })
    expect(first.nextCursor).toBeDefined()
    const second = await service.list({
      workspaceId: WORKSPACE,
      sourceId: GITHUB_SOURCE_IDS.issue,
      scope: { repo: 'cli/cli' },
      cursor: first.nextCursor,
    })
    expect(argValue(fake.runs[1]!.args, 'after')).toBe('Y3Vyc29yOnYyOpK0MjAyNi0xMC0xN1QxOTozMjozMVrPAAAAAV_M_JY=')
    expect(second.nextCursor).toBeUndefined()
    expect(second.items[0]?.meta).toMatchObject({ number: 42 })

    // A cursor belongs to its scope: switching repository or query restarts.
    const before = fake.runs.length
    await expect(service.list({
      workspaceId: WORKSPACE,
      sourceId: GITHUB_SOURCE_IDS.issue,
      scope: { repo: 'octocat/Hello-World' },
      cursor: first.nextCursor,
    })).rejects.toMatchObject({ category: 'invalid-request' })
    expect(fake.runs).toHaveLength(before)

    const searchCursor = await service.search({
      workspaceId: WORKSPACE,
      sourceId: GITHUB_SOURCE_IDS.issue,
      scope: 'cli/cli',
      query: 'bug',
    })
    await expect(service.search({
      workspaceId: WORKSPACE,
      sourceId: GITHUB_SOURCE_IDS.issue,
      scope: 'cli/cli',
      query: 'different',
      cursor: searchCursor.nextCursor,
    })).rejects.toMatchObject({ category: 'invalid-request' })
  })
})

describe('resolve', () => {
  it('resolves a canonical URL without running gh or persisting a clue', async () => {
    const { fake, service } = setup(() => cliResult())
    const candidates = await service.resolve({
      workspaceId: WORKSPACE,
      text: 'https://github.com/cli/cli/pull/14727#discussion_r1',
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.sourceId).toBe(GITHUB_SOURCE_IDS.pull)
    expect(candidates[0]?.typeId).toBe(GITHUB_TYPE_IDS.pull)
    expect(candidates[0]?.locator).toEqual(locatorOf('pull'))
    expect(candidates[0]?.title).toBe('cli/cli#14727')
    expect(fake.runs).toHaveLength(0)
    expect((await service.listClues(WORKSPACE)).clues).toHaveLength(0)
  })

  it('resolves an issue URL to the issue source only', async () => {
    const { service } = setup(() => cliResult())
    const candidates = await service.resolve({
      workspaceId: WORKSPACE,
      text: 'https://github.com/cli/cli/issues/14609',
    })
    expect(candidates.map(candidate => candidate.sourceId)).toEqual([GITHUB_SOURCE_IDS.issue])
  })

  it('resolves the kind-less shorthand only for an explicit source', async () => {
    const { service } = setup(() => cliResult())
    expect(await service.resolve({ workspaceId: WORKSPACE, text: 'cli/cli#12' })).toEqual([])
    const issue = await service.resolve({
      workspaceId: WORKSPACE,
      sourceId: GITHUB_SOURCE_IDS.issue,
      text: 'cli/cli#12',
    })
    expect(issue[0]?.typeId).toBe(GITHUB_TYPE_IDS.issue)
    const pull = await service.resolve({
      workspaceId: WORKSPACE,
      sourceId: GITHUB_SOURCE_IDS.pull,
      text: 'cli/cli#12',
    })
    expect(pull[0]?.typeId).toBe(GITHUB_TYPE_IDS.pull)
  })

  it('reports a URL kind mismatch for an explicit source instead of rewriting it', async () => {
    const { service } = setup(() => cliResult())
    await expect(service.resolve({
      workspaceId: WORKSPACE,
      sourceId: GITHUB_SOURCE_IDS.issue,
      text: 'https://github.com/cli/cli/pull/14727',
    })).rejects.toMatchObject({ category: 'unsupported' })
  })

  it('reuses one stable reference for the same resource and keeps kinds apart', async () => {
    const { service } = setup(() => cliResult())
    const first = await service.ensure({
      workspaceId: WORKSPACE,
      sourceId: GITHUB_SOURCE_IDS.issue,
      typeId: GITHUB_TYPE_IDS.issue,
      locator: locatorOf('issue', 12),
      title: 'one',
    })
    const again = await service.ensure({
      workspaceId: WORKSPACE,
      sourceId: GITHUB_SOURCE_IDS.issue,
      typeId: GITHUB_TYPE_IDS.issue,
      locator: { ...locatorOf('issue', 12), token: 'gho_secret', path: '/tmp/x' },
      title: 'two',
    })
    expect(first.created).toBe(true)
    expect(again.created).toBe(false)
    expect(again.clue.id).toBe(first.clue.id)
    expect(JSON.stringify(again.clue.locator)).not.toContain('gho_secret')
    expect(again.clue.locator).toEqual(locatorOf('issue', 12))
  })
})

describe('read and loadEdit', () => {
  it('reads the live resource, its revision and the model text projection without any auth probe', async () => {
    const { fake, service } = setup(() => cliResult({ stdout: fixture('issue-read.json') }))
    const result = await service.read(readParams('issue'))
    expect(result.format).toBe(GITHUB_FORMAT)
    expect(result.freshness).toBe('live')
    expect(result.fetchedAt).toBe(NOW)
    expect(result.revision).toBe(revisionOf({
      title: 'gh release list -R https://github.com/cli/cli/ -> error',
      body: ISSUE_BODY,
      updatedAt: '2026-10-16T07:44:20Z',
    }))
    expect(result.data).toMatchObject({
      kind: 'issue',
      owner: 'cli',
      repo: 'cli',
      number: 14609,
      state: 'OPEN',
      author: 'tps800',
      labels: ['bug', 'release'],
      isArchived: false,
      viewerPermission: 'READ',
    })
    expect(result.text).toContain('gh release list')
    expect(result.text).toContain('- state: OPEN')
    expect(result.text).toContain('### Describe the bug')
    expect(fake.runs).toHaveLength(1)
    expect(fake.runs[0]!.args).not.toContain('auth')
  })

  it('reads PR-only draft/merged state', async () => {
    const { service } = setup(() => cliResult({ stdout: fixture('pull-read.json') }))
    const result = await service.read(readParams('pull'))
    expect(result.data).toMatchObject({ kind: 'pull', isDraft: false, merged: false })
  })

  it('reports a kind mismatch as unsupported and a rate limit as rate-limited', async () => {
    const notFound = JSON.stringify({
      data: { repository: { isArchived: false, viewerPermission: 'READ', issue: null } },
      errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to an Issue with the number of 1.' }],
    })
    const mismatch = setup(request =>
      (argValue(request.args, 'query') ?? '').includes('issue(number:$number)')
        ? cliResult({ exitCode: 1, stdout: notFound, stderr: 'gh: Could not resolve to an Issue with the number of 1.' })
        : cliResult({ stdout: fixture('pull-read.json') }))
    await expect(mismatch.service.read(readParams('issue', locatorOf('issue', 1))))
      .rejects.toMatchObject({ category: 'unsupported' })

    const limited = setup(() => cliResult({
      exitCode: 1,
      stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)',
    }))
    await expect(limited.service.read(readParams('issue'))).rejects.toMatchObject({ category: 'rate-limited' })
    expect(limited.fake.runs).toHaveLength(1)
  })

  it('refuses a type that belongs to the other source and a pre-aborted call', async () => {
    const { fake, service } = setup(() => cliResult({ stdout: fixture('issue-read.json') }))
    await expect(service.read({
      workspaceId: WORKSPACE,
      sourceId: GITHUB_SOURCE_IDS.issue,
      typeId: GITHUB_TYPE_IDS.pull,
      locator: locatorOf('pull'),
    })).rejects.toMatchObject({ category: 'unsupported' })

    const controller = new AbortController()
    controller.abort()
    await expect(service.read(readParams('issue'), { signal: controller.signal }))
      .rejects.toMatchObject({ category: 'cancelled' })
    expect(fake.runs).toHaveLength(0)
  })

  it('loads the editable document with the baseline and no read-only marker', async () => {
    const { service } = setup(() => cliResult({ stdout: issuePayload({ permission: 'WRITE' }) }))
    const document = await service.loadEdit(readParams('issue'))
    expect(document.format).toBe(GITHUB_FORMAT)
    expect(document.baseRevision).toBe(revisionOf({
      title: 'gh release list -R https://github.com/cli/cli/ -> error',
      body: ISSUE_BODY,
      updatedAt: '2026-10-16T07:44:20Z',
    }))
    expect(document.data).toMatchObject({ title: 'gh release list -R https://github.com/cli/cli/ -> error' })
    expect((document.data as Record<string, unknown>).readOnly).toBeUndefined()
  })

  it('marks archived, read-only and oversized documents read-only with the reason', async () => {
    const archived = setup(() => cliResult({
      stdout: issuePayload({ archived: true, permission: 'WRITE' }),
    }))
    expect((await archived.service.loadEdit(readParams('issue'))).data)
      .toMatchObject({ readOnly: true, readOnlyReason: 'archived' })

    const readOnly = setup(() => cliResult({ stdout: issuePayload({ permission: 'READ' }) }))
    expect((await readOnly.service.loadEdit(readParams('issue'))).data)
      .toMatchObject({ readOnly: true, readOnlyReason: 'permission-denied' })

    const huge = setup(() => cliResult({
      stdout: issuePayload({ permission: 'WRITE', body: 'x'.repeat(GITHUB_MAX_EDITABLE_CHARS + 1) }),
    }))
    expect((await huge.service.loadEdit(readParams('issue'))).data)
      .toMatchObject({ readOnly: true, readOnlyReason: 'size' })
  })
})

describe('saveEdit', () => {
  function saveSetup() {
    let reads = 0
    return setup(request => {
      const query = argValue(request.args, 'query') ?? ''
      if (query.includes('issue(number:$number)')) {
        reads += 1
        if (reads === 1) return cliResult({ stdout: issuePayload({ ...STATE, permission: 'WRITE' }) })
        return cliResult({ stdout: issuePayload({
          title: 'new title', body: 'old body', updatedAt: '2026-10-17T10:00:00Z', permission: 'WRITE',
        }) })
      }
      return cliResult({ stdout: 'https://github.com/cli/cli/issues/14609\n' })
    })
  }

  it('saves only the changed fields after comparing the baseline', async () => {
    const { fake, service } = saveSetup()
    const outcome = await service.saveEdit({
      ...readParams('issue'),
      document: {
        format: GITHUB_FORMAT,
        data: { title: 'new title', body: 'old body' },
        baseRevision: revisionOf(STATE),
      },
    })
    expect(outcome.revision).toBe(revisionOf({
      title: 'new title', body: 'old body', updatedAt: '2026-10-17T10:00:00Z',
    }))
    expect(outcome.savedAt).toBe(NOW)
    const edit = fake.runs[1]!
    expect(edit.args.slice(0, 3)).toEqual(['issue', 'edit', '14609'])
    expect(edit.args).toContain('--title')
    expect(edit.args).not.toContain('--body-file')
    expect(fake.runs.every(run => !run.args.includes('auth'))).toBe(true)
  })

  it('refuses an agent caller and never starts a write', async () => {
    const { fake, service } = saveSetup()
    await expect(service.saveEdit({
      ...readParams('issue'),
      document: { format: GITHUB_FORMAT, data: { title: 'x', body: 'y' }, baseRevision: revisionOf(STATE) },
    }, { caller: 'agent' })).rejects.toMatchObject({ category: 'unsupported' })
    expect(fake.runs).toHaveLength(0)
  })

  it('returns conflict for a stale baseline and keeps the draft (no write)', async () => {
    const { fake, service } = saveSetup()
    await expect(service.saveEdit({
      ...readParams('issue'),
      document: { format: GITHUB_FORMAT, data: { title: 'x', body: 'y' }, baseRevision: 'ghsb1-stale' },
    })).rejects.toMatchObject({ category: 'conflict' })
    expect(fake.runs).toHaveLength(1)
  })

  it('validates the document before touching gh', async () => {
    const { fake, service } = setup(() => cliResult())
    await expect(service.saveEdit({
      ...readParams('issue'),
      document: { format: 'text/plain', data: { title: 'x', body: 'y' }, baseRevision: 'r' },
    })).rejects.toMatchObject({ category: 'unsupported' })
    await expect(service.saveEdit({
      ...readParams('issue'),
      document: { format: GITHUB_FORMAT, data: { title: '', body: 'y' }, baseRevision: 'r' },
    })).rejects.toMatchObject({ category: 'invalid-request' })
    await expect(service.saveEdit({
      ...readParams('issue'),
      document: {
        format: GITHUB_FORMAT,
        data: { title: 'x', body: 'y'.repeat(GITHUB_MAX_EDITABLE_CHARS + 1) },
        baseRevision: 'r',
      },
    })).rejects.toMatchObject({ category: 'unsupported' })
    await expect(service.saveEdit({
      ...readParams('issue'),
      document: { format: GITHUB_FORMAT, data: { title: 'x', body: 'y' } },
    })).rejects.toMatchObject({ category: 'invalid-request' })
    expect(fake.runs).toHaveLength(0)
  })

  it('refuses to write an archived repository', async () => {
    const { fake, service } = setup(() => cliResult({
      stdout: issuePayload({ ...STATE, archived: true, permission: 'WRITE' }),
    }))
    await expect(service.saveEdit({
      ...readParams('issue'),
      document: { format: GITHUB_FORMAT, data: { title: 'x', body: 'y' }, baseRevision: revisionOf(STATE) },
    })).rejects.toMatchObject({ category: 'permission-denied' })
    expect(fake.runs).toHaveLength(1)
  })
})

describe('portable', () => {
  it('exports exactly the normalized locator (no token, account or path)', async () => {
    const { fake, service } = setup(() => cliResult())
    const portable = await service.portable(readParams('issue', {
      ...locatorOf('issue', 7),
      token: 'gho_secret',
      path: '/Users/someone/private',
    }))
    expect(portable).toEqual({ portable: true, locator: locatorOf('issue', 7) })
    const text = JSON.stringify(portable)
    for (const forbidden of ['gho_secret', '/Users/', 'token', 'account']) {
      expect(text).not.toContain(forbidden)
    }
    expect(fake.runs).toHaveLength(0)
  })

  it('leaves already-saved local references untouched when a repository search fails', async () => {
    const fake = fakeRuntime(() => cliResult({
      exitCode: 1,
      stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)',
    }))
    const install = createGithubSources({ runtime: () => fake.runtime, now: () => Date.parse(NOW), cwd: '/tmp/gh' })
    const service = createCluesService({
      root: tempRoot(),
      now: () => NOW,
      newId: kind => `${kind}-saved`,
      builtinSources: install.registrations,
    })
    const ensured = await service.ensure({
      workspaceId: WORKSPACE,
      sourceId: GITHUB_SOURCE_IDS.issue,
      typeId: GITHUB_TYPE_IDS.issue,
      locator: locatorOf('issue', 14609),
      title: 'saved clue',
    })
    await expect(service.search({
      workspaceId: WORKSPACE,
      sourceId: GITHUB_SOURCE_IDS.issue,
      scope: 'cli/cli',
      query: 'anything',
    })).rejects.toMatchObject({ category: 'rate-limited' })
    const library = await service.listClues(WORKSPACE)
    expect(library.clues.map(clue => clue.id)).toEqual([ensured.clue.id])
  })

  it('keeps a ClueError category through the service boundary', async () => {
    const { service } = setup(() => cliResult({ exitCode: 1, stderr: 'gh: Not Found (HTTP 404)' }))
    const error = await service.read(readParams('issue')).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ClueError)
    expect((error as ClueError).category).toBe('not-found')
    expect((error as ClueError).message).not.toContain('Not Found')
  })
})
