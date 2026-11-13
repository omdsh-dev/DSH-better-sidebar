/**
 * S8 client runtime API wrapper: the typed `clues.dependencies.*` /
 * `clues.connections.*` methods ride the plugin's ONE `/sidebar/api` transport
 * (S1's `call`), so S8 adds no second RPC, no route and no node import.
 *
 * The wrapper is a pure projection of the S2 wire contract: each method posts
 * exactly the payload the S2 handler validates (no `undefined` keys). Reads
 * own a shared wire signal while each caller can independently cancel its wait;
 * actions preserve the caller signal. A rejected envelope stays a
 * `SidebarApiError` with the wire code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cachedClueRequest, invalidateClueRequests } from '../src/client/clues/request-cache.ts'
import { subscribeClueDataChanges } from '../src/client/clues/api.ts'
import { publishClueStatuses, publishClueTask } from '../src/client/clues/settings/runtime-state.ts'
import type { DependencyInstallTask, DependencyStatus } from '../src/clues/runtime/types.ts'
import { SidebarApiError } from '../src/client/api.ts'
import { clueRuntimeApi, resetClueRuntimeAuthTracking } from '../src/client/clues/runtime-api.ts'

interface Posted {
  url: string
  body: Record<string, unknown>
  signal?: AbortSignal
}

/** Stub fetch: record POSTs, answer one envelope (`value` or an error). */
function stubFetch(answer: { value?: unknown; status?: number; code?: string; message?: string }): Posted[] {
  const posted: Posted[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    posted.push({
      url,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      signal: init?.signal ?? undefined,
    })
    const status = answer.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (status >= 200 && status < 300
        ? { ok: true, value: answer.value }
        : { ok: false, error: { code: answer.code ?? 'failed', message: answer.message ?? 'failed' } }),
    } as unknown as Response
  }))
  return posted
}

beforeEach(() => { invalidateClueRequests(); resetClueRuntimeAuthTracking() })
afterEach(() => {
  invalidateClueRequests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('clueRuntimeApi dependency methods', () => {
  it('inspects everything with an empty payload and unwraps the dependency list', async () => {
    const posted = stubFetch({ value: { dependencies: [{ dependencyId: 'github.gh', state: 'ready' }] } })
    const dependencies = await clueRuntimeApi.dependenciesInspect()
    expect(dependencies).toEqual([{ dependencyId: 'github.gh', state: 'ready' }])
    expect(posted).toEqual([{
      url: 'http://dsh.internal/sidebar/api/clues.dependencies.inspect',
      body: {},
      signal: expect.any(AbortSignal),
    }])
  })

  it('forwards dependencyId, refresh and the abort signal; never sends undefined keys', async () => {
    const posted = stubFetch({ value: { dependencies: [] } })
    const controller = new AbortController()
    await clueRuntimeApi.dependenciesInspect(
      { dependencyId: 'feishu.lark', refresh: true },
      controller.signal,
    )
    expect(posted[0]).toEqual({
      url: 'http://dsh.internal/sidebar/api/clues.dependencies.inspect',
      body: { dependencyId: 'feishu.lark', refresh: true },
      signal: expect.any(AbortSignal),
    })
    expect(posted[0]!.signal).not.toBe(controller.signal)
    expect(Object.values(posted[0]!.body).every(value => value !== undefined)).toBe(true)
  })

  it('plans, starts, reports status, cancels and sets/clears the manual path on the exact wire methods', async () => {
    const plan = { planId: 'plan-1', dependencyId: 'github.gh' }
    const task = { taskId: 'task-1', dependencyId: 'github.gh', state: 'running' }
    const status = { dependencyId: 'github.gh', state: 'ready' }
    let posted = stubFetch({ value: { plan } })
    expect(await clueRuntimeApi.dependenciesPlan('github.gh')).toEqual(plan)
    expect(posted[0]!.url).toContain('/clues.dependencies.plan')
    expect(posted[0]!.body).toEqual({ dependencyId: 'github.gh' })

    posted = stubFetch({ value: { task } })
    expect(await clueRuntimeApi.dependenciesStart('github.gh', 'plan-1')).toEqual(task)
    expect(posted[0]!.url).toContain('/clues.dependencies.start')
    expect(posted[0]!.body).toEqual({ dependencyId: 'github.gh', planId: 'plan-1' })

    posted = stubFetch({ value: { task } })
    expect(await clueRuntimeApi.dependenciesCancel('github.gh', 'task-1')).toEqual(task)
    expect(posted[0]!.url).toContain('/clues.dependencies.cancel')
    expect(posted[0]!.body).toEqual({ dependencyId: 'github.gh', taskId: 'task-1' })

    posted = stubFetch({ value: { tasks: [task] } })
    expect(await clueRuntimeApi.dependenciesStatus('github.gh')).toEqual([task])
    expect(posted[0]!.url).toContain('/clues.dependencies.status')
    expect(posted[0]!.body).toEqual({ dependencyId: 'github.gh' })

    posted = stubFetch({ value: { dependency: status } })
    expect(await clueRuntimeApi.dependenciesSetPath('github.gh', '/opt/bin/gh')).toEqual(status)
    expect(posted[0]!.url).toContain('/clues.dependencies.setPath')
    expect(posted[0]!.body).toEqual({ dependencyId: 'github.gh', path: '/opt/bin/gh' })

    posted = stubFetch({ value: { dependency: status } })
    expect(await clueRuntimeApi.dependenciesClearPath('github.gh')).toEqual(status)
    expect(posted[0]!.url).toContain('/clues.dependencies.clearPath')
    expect(posted[0]!.body).toEqual({ dependencyId: 'github.gh' })
  })

  it('keeps the manual-path-only status request free of a plan or task payload', async () => {
    const posted = stubFetch({ value: { dependency: { dependencyId: 'github.gh', state: 'missing' } } })
    await clueRuntimeApi.dependenciesSetPath('github.gh', '/nope/gh')
    // A path change is a status read of the dependency, never an install start.
    expect(posted[0]!.url).not.toContain('.start')
    expect(posted[0]!.url).not.toContain('.plan')
  })
})

describe('clueRuntimeApi connection methods', () => {
  it('reads all connections and one connection with the exact payloads', async () => {
    const connections = [{ connectionId: 'feishu.auth', authorization: 'ready' }]
    let posted = stubFetch({ value: { connections } })
    expect(await clueRuntimeApi.connectionsStatus()).toEqual(connections)
    expect(posted[0]!.url).toContain('/clues.connections.status')
    expect(posted[0]!.body).toEqual({})

    posted = stubFetch({ value: { connections } })
    expect(await clueRuntimeApi.connectionsStatus('feishu.auth')).toEqual(connections)
    expect(posted[0]!.body).toEqual({ connectionId: 'feishu.auth' })
  })

  it('connect / poll / cancel post only the connection id and unwrap the projection', async () => {
    const connection = { connectionId: 'feishu.auth', authorization: 'authorizing' }
    for (const [method, call] of [
      ['connect', () => clueRuntimeApi.connectionsConnect('feishu.auth')],
      ['poll', () => clueRuntimeApi.connectionsPoll('feishu.auth')],
      ['cancel', () => clueRuntimeApi.connectionsCancel('feishu.auth')],
    ] as const) {
      const posted = stubFetch({ value: { connection } })
      expect(await call()).toEqual(connection)
      expect(posted[0]!.url).toContain(`/clues.connections.${method}`)
      expect(posted[0]!.body).toEqual({ connectionId: 'feishu.auth' })
    }
  })

  it('surfaces a rejected envelope as SidebarApiError with the wire code', async () => {
    stubFetch({ status: 403, code: 'permission-denied', message: 'human only' })
    const failure: unknown = await clueRuntimeApi.dependenciesPlan('github.gh')
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(SidebarApiError)
    expect((failure as SidebarApiError).code).toBe('permission-denied')
  })
})


it('posts only the explicit permission selection and preserves the abort signal', async () => {
  const posted = stubFetch({ value: { connection: { connectionId: 'feishu.auth' } } })
  const controller = new AbortController()
  await clueRuntimeApi.connectionsConnect('feishu.auth', controller.signal, ['tasks.read'])
  expect(posted[0]?.body).toEqual({ connectionId: 'feishu.auth', capabilities: ['tasks.read'] })
  expect(posted[0]?.signal).toBe(controller.signal)
})

const readyDependency: DependencyStatus = {
  dependencyId: 'github.gh', name: 'GitHub CLI', command: 'gh', state: 'ready',
  platform: 'darwin', arch: 'arm64', supported: true, installable: true,
  minimumVersion: '1.0.0', recommendedVersion: '1.0.0',
}
const installTask: DependencyInstallTask = {
  taskId: 'task-1', dependencyId: 'github.gh', planId: 'plan-1', version: '1.0.0',
  platform: 'darwin', arch: 'arm64', targetDir: '/managed/gh', state: 'running',
  startedAt: '2026-10-22T00:00:00Z',
}
const stateValue = {
  dependencies: [readyDependency], connections: [{ connectionId: 'github.auth', authorization: 'ready' }],
  dependency: readyDependency, connection: { connectionId: 'github.auth', authorization: 'ready' },
  task: installTask, tasks: [installTask], plan: { planId: 'plan-1' },
}

describe('shared runtime freshness', () => {
  it.each(['dependencies', 'connections'] as const)('serves %s reads until explicit refresh or invalidation', async kind => {
    vi.useFakeTimers()
    const posted = stubFetch({ value: stateValue })
    const read = kind === 'dependencies'
      ? () => clueRuntimeApi.dependenciesInspect({ dependencyId: 'github.gh' })
      : () => clueRuntimeApi.connectionsStatus('github.auth')
    await read(); await read()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    await read()
    expect(posted).toHaveLength(1)
    invalidateClueRequests()
    await read()
    expect(posted).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['dependencies', 'connections'] as const)('deduplicates in-flight %s and isolates consumer cancellation', async kind => {
    let finish!: (response: Response) => void
    let wireSignal: AbortSignal | undefined
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      wireSignal = init?.signal ?? undefined
      return new Promise<Response>(resolve => { finish = resolve })
    })
    vi.stubGlobal('fetch', fetch)
    const read = kind === 'dependencies'
      ? (signal: AbortSignal) => clueRuntimeApi.dependenciesInspect({ dependencyId: 'github.gh' }, signal)
      : (signal: AbortSignal) => clueRuntimeApi.connectionsStatus('github.auth', signal)
    const first = new AbortController()
    const second = new AbortController()
    const one = read(first.signal)
    const two = read(second.signal)
    const rejected = expect(one).rejects.toMatchObject({ name: 'AbortError' })
    first.abort(); await rejected
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(wireSignal).not.toBe(first.signal)
    expect(wireSignal?.aborted).toBe(false)
    finish({ ok: true, json: async () => ({ ok: true, value: stateValue }) } as Response)
    expect(await two).toEqual(stateValue[kind])
  })

  it('refreshes dependencies under the ordinary key and keeps aggregate/id reads isolated', async () => {
    const answer: { value: unknown } = { value: stateValue }
    const posted = stubFetch(answer)
    await clueRuntimeApi.dependenciesInspect()
    await clueRuntimeApi.dependenciesInspect({ dependencyId: 'github.gh' })
    expect(posted).toHaveLength(2)
    const fresh = [{ ...readyDependency, version: '2.0.0' }]
    answer.value = { dependencies: fresh }
    expect(await clueRuntimeApi.dependenciesInspect({ dependencyId: 'github.gh', refresh: true })).toEqual(fresh)
    expect(await clueRuntimeApi.dependenciesInspect({ dependencyId: 'github.gh' })).toEqual(fresh)
    expect(await clueRuntimeApi.dependenciesInspect()).toEqual(stateValue.dependencies)
    expect(posted).toHaveLength(3)
    expect(posted[2]?.body).toEqual({ dependencyId: 'github.gh', refresh: true })
  })

  it('refreshes a connection under the ordinary key without adding a wire refresh field', async () => {
    const answer: { value: unknown } = { value: stateValue }
    const posted = stubFetch(answer)
    await clueRuntimeApi.connectionsStatus('github.auth')
    const fresh = [{ connectionId: 'github.auth', authorization: 'not-authorized' }]
    answer.value = { connections: fresh }
    expect(await clueRuntimeApi.connectionsStatus('github.auth', undefined, true)).toEqual(fresh)
    expect(await clueRuntimeApi.connectionsStatus('github.auth')).toEqual(fresh)
    expect(posted).toHaveLength(2)
    expect(posted[1]?.body).toEqual({ connectionId: 'github.auth' })
  })

  it('a forced in-flight replacement cannot be overwritten by the older dependency response', async () => {
    let finish!: (response: Response) => void
    const fresh = [{ ...readyDependency, version: '2.0.0' }]
    const fetch = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
      .mockResolvedValue({ ok: true, json: async () => ({ ok: true, value: { dependencies: fresh } }) })
    vi.stubGlobal('fetch', fetch)
    const old = clueRuntimeApi.dependenciesInspect({ dependencyId: 'github.gh' })
    await Promise.resolve()
    expect(await clueRuntimeApi.dependenciesInspect({ dependencyId: 'github.gh', refresh: true })).toEqual(fresh)
    finish({ ok: true, json: async () => ({ ok: true, value: stateValue }) } as Response)
    expect(await old).toEqual(stateValue.dependencies)
    expect(await clueRuntimeApi.dependenciesInspect({ dependencyId: 'github.gh' })).toEqual(fresh)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['start', 'dependencies', () => clueRuntimeApi.dependenciesStart('github.gh', 'plan-1')],
    ['cancel', 'dependencies', () => clueRuntimeApi.dependenciesCancel('github.gh', 'task-1')],
    ['setPath', 'dependencies', () => clueRuntimeApi.dependenciesSetPath('github.gh', '/bin/gh')],
    ['clearPath', 'dependencies', () => clueRuntimeApi.dependenciesClearPath('github.gh')],
    ['connect', 'connections', () => clueRuntimeApi.connectionsConnect('github.auth')],
    ['poll', 'connections', () => clueRuntimeApi.connectionsPoll('github.auth')],
    ['cancelConnection', 'connections', () => clueRuntimeApi.connectionsCancel('github.auth')],
  ] as const)('%s invalidates its status family (and business only for executable/auth edits)', async (_name, family, action) => {
    const posted = stubFetch({ value: stateValue })
    const load = vi.fn(async () => 'directory')
    const business = () => cachedClueRequest('clues.list', 'workspace', {}, load)
    await business()
    await clueRuntimeApi.dependenciesInspect()
    await clueRuntimeApi.connectionsStatus()
    expect(posted).toHaveLength(2)
    await action()
    await clueRuntimeApi.dependenciesInspect()
    await clueRuntimeApi.connectionsStatus()
    await business()
    // The action itself plus the one invalidated status read. Ordinary install
    // start/cancel and a same-account poll leave business reads warm; explicit
    // executable/auth mutations conservatively evict them.
    expect(posted).toHaveLength(4)
    expect(posted[3]!.url).toContain(family === 'dependencies' ? 'dependencies.inspect' : 'connections.status')
    expect(load).toHaveBeenCalledTimes(
      ['setPath', 'clearPath', 'connect', 'cancelConnection'].includes(_name) ? 2 : 1,
    )
  })

  it('also invalidates status and business reads when an executable change rejects', async () => {
    stubFetch({ value: stateValue })
    const load = vi.fn(async () => 'directory')
    const business = () => cachedClueRequest('clues.list', 'workspace', {}, load)
    await business()
    await clueRuntimeApi.dependenciesInspect()
    await clueRuntimeApi.connectionsStatus()
    stubFetch({ status: 500, code: 'partial', message: 'partial change' })
    await expect(clueRuntimeApi.dependenciesSetPath('github.gh', '/bin/gh')).rejects.toThrow('partial change')
    const posted = stubFetch({ value: stateValue })
    await clueRuntimeApi.dependenciesInspect()
    await clueRuntimeApi.connectionsStatus()
    // The old executable may already have produced the cached page; keep no
    // business body after an explicit path mutation, even on rejection.
    await business()
    expect(load).toHaveBeenCalledTimes(2)
    expect(posted).toHaveLength(1)
    expect(posted[0]!.url).toContain('dependencies.inspect')
  })

  it('keeps business reads warm across same-account status checks and evicts on account drift', async () => {
    const connection = {
      connectionId: 'drift.auth', name: 'Drift', pluginId: 'test', configuration: 'ready' as const,
      authorization: 'ready' as const, credentialOwner: 'tool' as const,
      capabilities: ['docs.read'], account: 'alice@example.com', action: 'none' as const,
    }
    const answer: { value: unknown } = { value: { connections: [connection] } }
    stubFetch(answer)
    const load = vi.fn(async () => 'directory')
    const business = () => cachedClueRequest('clues.list', 'workspace', {}, load)
    await business()
    await clueRuntimeApi.connectionsStatus('drift.auth')
    await clueRuntimeApi.connectionsStatus('drift.auth', undefined, true)
    // Same account/authorization/capabilities: an ordinary check is not a nuke.
    expect(load).toHaveBeenCalledTimes(1)
    answer.value = {
      connections: [{ ...connection, account: 'bob@example.com' }],
    }
    await clueRuntimeApi.connectionsStatus('drift.auth', undefined, true)
    await business()
    expect(load).toHaveBeenCalledTimes(2)

    answer.value = {
      connections: [{ ...connection, account: 'bob@example.com', capabilities: ['docs.read', 'docs.edit'] }],
    }
    await clueRuntimeApi.connectionsStatus('drift.auth', undefined, true)
    await business()
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('treats an auth-required status error as an identity boundary', async () => {
    const answer: { value: unknown } = {
      value: {
        connections: [{
          connectionId: 'expired.auth', name: 'Expired', pluginId: 'test', configuration: 'ready',
          authorization: 'not-authorized', credentialOwner: 'tool', capabilities: [],
          account: 'new@example.com', action: 'connect',
          error: { category: 'auth-required', message: 'sign in again' },
        }],
      },
    }
    stubFetch(answer)
    const load = vi.fn(async () => 'directory')
    const business = () => cachedClueRequest('clues.list', 'workspace', {}, load)
    await business()
    await clueRuntimeApi.connectionsStatus('expired.auth', undefined, true)
    await business()
    expect(load).toHaveBeenCalledTimes(2)

    // A transport-level auth failure is also an identity boundary.
    await business()
    expect(load).toHaveBeenCalledTimes(2)
    stubFetch({ status: 403, code: 'auth-required', message: 'sign in again' })
    // A transport failure is a distinct first observation for this id.
    await expect(clueRuntimeApi.connectionsStatus('expired.transport.auth', undefined, true))
      .rejects.toMatchObject({ code: 'auth-required' })
    await business()
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('rejects an attached pending business read immediately on an auth boundary, even if the fetcher ignores abort', async () => {
    const connection = {
      connectionId: 'switch.auth', name: 'Switch', pluginId: 'test', configuration: 'ready' as const,
      authorization: 'ready' as const, credentialOwner: 'tool' as const,
      capabilities: ['docs.read'], account: 'alice@example.com', action: 'none' as const,
    }
    const answer: { value: unknown } = { value: { connections: [connection] } }
    stubFetch(answer)
    await clueRuntimeApi.connectionsStatus('switch.auth')
    const events: { kind: string; workspaceId?: string }[] = []
    const unsubscribe = subscribeClueDataChanges(change => { events.push(change) })

    let finish!: (value: string) => void
    const pending = cachedClueRequest('clues.list', 'workspace', {}, () => (
      new Promise<string>(resolve => { finish = resolve })
    ))
    await Promise.resolve()
    answer.value = { connections: [{ ...connection, account: 'bob@example.com' }] }
    await clueRuntimeApi.connectionsStatus('switch.auth', undefined, true)
    // The attached consumer rejects immediately; it never receives the old
    // account's body even though the fetcher ignores its abort signal.
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(events).toEqual([{ kind: 'auth' }])

    finish('old body')
    await Promise.resolve(); await Promise.resolve()
    const load = vi.fn(async () => 'fresh body')
    expect(await cachedClueRequest('clues.list', 'workspace', {}, load)).toBe('fresh body')
    expect(load).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('publishes auth only for the first auth-required observation, never on retries', async () => {
    const events: { kind: string; workspaceId?: string }[] = []
    const unsubscribe = subscribeClueDataChanges(change => { events.push(change) })
    const authFailure = {
      connectionId: 'loop.auth', name: 'Loop', pluginId: 'test', configuration: 'ready',
      authorization: 'not-authorized', credentialOwner: 'tool', capabilities: [],
      action: 'connect', error: { category: 'auth-required', message: 'sign in' },
    }
    const answer: { value: unknown } = { value: { connections: [authFailure] } }
    stubFetch(answer)
    await clueRuntimeApi.connectionsStatus('loop.auth', undefined, true)
    await clueRuntimeApi.connectionsStatus('loop.auth', undefined, true)
    expect(events).toHaveLength(1)

    stubFetch({ status: 403, code: 'auth-required', message: 'sign in' })
    await expect(clueRuntimeApi.connectionsStatus('loop.transport', undefined, true))
      .rejects.toMatchObject({ code: 'auth-required' })
    await expect(clueRuntimeApi.connectionsStatus('loop.transport', undefined, true))
      .rejects.toMatchObject({ code: 'auth-required' })
    expect(events).toHaveLength(2)
    unsubscribe()
  })

  it('clears business reads when an auth poll rejects with auth-required', async () => {
    const load = vi.fn(async () => 'directory')
    const business = () => cachedClueRequest('clues.list', 'workspace', {}, load)
    await business()
    const events: { kind: string; workspaceId?: string }[] = []
    const unsubscribe = subscribeClueDataChanges(change => { events.push(change) })
    stubFetch({ status: 403, code: 'auth-required', message: 'sign in again' })
    await expect(clueRuntimeApi.connectionsPoll('poll-expired.auth'))
      .rejects.toMatchObject({ code: 'auth-required' })
    await business()
    expect(load).toHaveBeenCalledTimes(2)
    expect(events).toEqual([{ kind: 'auth' }])
    unsubscribe()
  })

  it('evicts business reads when a completed poll changes account but not on an unchanged poll', async () => {
    const taskConnection = {
      connectionId: 'poll.auth', name: 'Poll', pluginId: 'test', configuration: 'ready' as const,
      authorization: 'ready' as const, credentialOwner: 'tool' as const,
      capabilities: ['docs.read'], account: 'alice@example.com', action: 'none' as const,
    }
    const answer: { value: unknown } = { value: { connection: taskConnection } }
    stubFetch(answer)
    const load = vi.fn(async () => 'directory')
    const business = () => cachedClueRequest('clues.list', 'workspace', {}, load)
    await business()
    await clueRuntimeApi.connectionsPoll('poll.auth')
    await business()
    expect(load).toHaveBeenCalledTimes(1)
    await clueRuntimeApi.connectionsPoll('poll.auth')
    await business()
    expect(load).toHaveBeenCalledTimes(1)
    answer.value = { connection: { ...taskConnection, account: 'bob@example.com' } }
    await clueRuntimeApi.connectionsPoll('poll.auth')
    await business()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('never caches install progress, plans or authorization actions', async () => {
    const posted = stubFetch({ value: stateValue })
    for (let index = 0; index < 2; index++) {
      await clueRuntimeApi.dependenciesStatus()
      await clueRuntimeApi.dependenciesPlan('github.gh')
      await clueRuntimeApi.connectionsPoll('github.auth')
    }
    expect(posted).toHaveLength(6)
  })

  it('ordinary status publications leave business reads warm', async () => {
    const load = vi.fn(async () => 'directory')
    const read = () => cachedClueRequest('clues.list', 'workspace', {}, load)
    await read()
    publishClueStatuses(clueRuntimeApi, [readyDependency])
    expect(await read()).toBe('directory')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('a bus publication evicts business reads only on an actual account change', async () => {
    const connection = {
      connectionId: 'bus.auth', name: 'Bus', pluginId: 'test', configuration: 'ready' as const,
      authorization: 'ready' as const, credentialOwner: 'tool' as const,
      capabilities: ['docs.read'], account: 'alice@example.com', action: 'none' as const,
    }
    const load = vi.fn(async () => 'directory')
    const business = () => cachedClueRequest('clues.list', 'workspace', {}, load)
    await business()
    publishClueStatuses(clueRuntimeApi, [readyDependency], [connection])
    await business()
    expect(load).toHaveBeenCalledTimes(1)
    publishClueStatuses(clueRuntimeApi, [readyDependency], [connection])
    await business()
    expect(load).toHaveBeenCalledTimes(1)
    publishClueStatuses(clueRuntimeApi, [readyDependency], [{ ...connection, account: 'bob@example.com' }])
    await business()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('task publications evict inspect answers without touching business reads', async () => {
    const posted = stubFetch({ value: stateValue })
    const load = vi.fn(async () => 'directory')
    const read = () => cachedClueRequest('clues.list', 'workspace', {}, load)
    await read()
    await clueRuntimeApi.dependenciesInspect()
    await clueRuntimeApi.dependenciesInspect({ dependencyId: 'github.gh' })
    publishClueTask(clueRuntimeApi, installTask)
    await clueRuntimeApi.dependenciesInspect()
    await clueRuntimeApi.dependenciesInspect({ dependencyId: 'github.gh' })
    await read()
    expect(posted).toHaveLength(4)
    expect(load).toHaveBeenCalledTimes(1)
    publishClueTask(clueRuntimeApi, { ...installTask, state: 'succeeded' })
    await clueRuntimeApi.dependenciesInspect()
    await read()
    // The terminal task forces a fresh dependency probe, not a global
    // business-cache nuke.
    expect(posted).toHaveLength(5)
    expect(load).toHaveBeenCalledTimes(1)
  })
})
