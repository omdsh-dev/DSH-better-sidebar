/**
 * S8 client runtime API wrapper: the typed `clues.dependencies.*` /
 * `clues.connections.*` methods ride the plugin's ONE `/sidebar/api` transport
 * (S1's `call`), so S8 adds no second RPC, no route and no node import.
 *
 * The wrapper is a pure projection of the S2 wire contract: each method posts
 * exactly the payload the S2 handler validates (no `undefined` keys), passes
 * the caller's abort signal through, and answers the unwrapped DTO. A rejected
 * envelope stays a `SidebarApiError` with the wire code.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarApiError } from '../src/client/api.ts'
import { clueRuntimeApi } from '../src/client/clues/runtime-api.ts'

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

afterEach(() => {
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
      signal: undefined,
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
      signal: controller.signal,
    })
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
