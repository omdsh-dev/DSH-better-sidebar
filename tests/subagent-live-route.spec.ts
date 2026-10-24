/**
 * Host route tests for the Subagent live-preview batch API ('subagents.live').
 * The route must enumerate the tree ONCE, keep only catalog-running
 * non-Side-Chat children, fold only non-empty activity from their session
 * logs, and degrade to a 503 when the host subagent runtime is absent.
 */
import { describe, expect, it, vi } from 'vitest'
import { buildSubagentLiveApi } from '../src/subagent-live-route.ts'
import { SidebarError } from '../src/wire.ts'
import type {
  Context,
  SidebarSessionEvent,
  SidebarSubagentDescendantEntry,
  SidebarSubagentsService,
} from '../src/context-types.ts'

/** One child descendant row. */
function child(
  id: string,
  over: Partial<Extract<SidebarSubagentDescendantEntry, { kind: 'child' }>> = {},
): SidebarSubagentDescendantEntry {
  return {
    kind: 'child',
    id,
    activity: 'running',
    hasChildren: false,
    mode: 'one-shot',
    parentId: 'root',
    depth: 1,
    ...over,
  }
}

/** One diagnostic descendant row. */
function diagnostic(id: string): SidebarSubagentDescendantEntry {
  return { kind: 'diagnostic', id, reason: 'corrupt', parentId: 'root', depth: 1 }
}

/** A session with the given raw events. */
function session(events: SidebarSessionEvent[]): { header: { cwd: string }; snapshotEvents(): readonly SidebarSessionEvent[] } {
  return { header: { cwd: '/p' }, snapshotEvents: () => events }
}

/** A context whose `get` serves only the subagents face, with a session store. */
function ctxWith(subagents: unknown, sessions: unknown): Context {
  return {
    sessions,
    get: (key: string) => (key === 'subagents' ? subagents : undefined),
  } as unknown as Context
}

/** One tool call event. */
const call = (callId: string, name: string, args = '{}', seq = 0, time = 0): SidebarSessionEvent =>
  ({ type: 'tool/call', seq, time, data: { callId, name, arguments: args } })

/** A settled tool result for one call id. */
const result = (callId: string, seq = 0, time = 0): SidebarSessionEvent =>
  ({ type: 'tool/result', seq, time, data: { message: { source: { kind: 'tool', callId } } } })

/** An assistant message carrying text. */
const reply = (text: string, seq = 0, time = 0): SidebarSessionEvent =>
  ({ type: 'assistant/message', seq, time, data: { message: { content: [{ type: 'text', text }] } } })

describe('subagents.live route', () => {
  it('reports every child with its catalog flag and folded range', async () => {
    const subagents: SidebarSubagentsService = {
      listDescendants: vi.fn(async () => [
        child('running-a', { label: 'A' }),
        child('running-b', { label: 'B' }),
        child('inactive', { activity: 'inactive', label: 'C' }),
        child('side-chat', { label: 'Side: chat' }),
        diagnostic('corrupt-row'),
      ]),
    }
    const sessions = {
      get: (id: string) => {
        if (id === 'running-a') return session([reply('hello', 1, 1)])
        if (id === 'running-b') return session([call('c1', 'bash', '{"command":"ls"}', 1, 1)])
        return session([])
      },
    }
    const api = buildSubagentLiveApi(ctxWith(subagents, sessions))
    const live = (await api.live({ rootSessionId: 'root' })).live
    // The topology root is reported too (its activity flag is the caller's).
    expect(live.root).toEqual({})
    expect(live['running-a']?.running).toBe(true)
    expect(live['running-a']?.text).toBe('hello')
    expect(live['running-b']?.summary).toEqual({
      counts: [{ kind: 'commands', count: 1 }],
      running: 'commands',
      runningDetail: 'ls',
    })
    // A settled child is still a row: its summary drives its card.
    expect(live.inactive?.running).toBe(false)
    // Side Chat threads and diagnostics are not topology.
    expect(live['side-chat']).toBeUndefined()
    expect(live['corrupt-row']).toBeUndefined()
    expect(subagents.listDescendants).toHaveBeenCalledWith('root')
  })

  it('folds a settled child from its last range that did something', async () => {
    const subagents: SidebarSubagentsService = {
      listDescendants: vi.fn(async () => [child('done', { activity: 'inactive', label: 'D' })]),
    }
    const events = [
      call('c1', 'bash', '{"command":"npm test"}', 1, 1),
      result('c1', 2, 2),
      reply('all green', 3, 3),
    ]
    const api = buildSubagentLiveApi(ctxWith(subagents, { get: () => session(events) }))
    const live = (await api.live({ rootSessionId: 'root' })).live
    expect(live.done?.summary).toEqual({
      counts: [{ kind: 'commands', count: 1 }],
      runningDetail: '',
    })
    expect(live.done?.text).toBe('all green')
    expect(live.done?.lastEventTime).toBe(3)
  })

  it('stops the fold at the newest range boundary', async () => {
    // One stale tool call sits in an earlier range: the newest range is the
    // tail after the reply, so the stale call must not be counted.
    const subagents: SidebarSubagentsService = {
      listDescendants: vi.fn(async () => [child('windowed', { label: 'W' })]),
    }
    const events = [
      call('stale', 'bash', '{"command":"old"}', 1, 1),
      reply('done with the old work', 2, 2),
      call('fresh', 'read', '{"path":"a"}', 3, 3),
    ]
    const api = buildSubagentLiveApi(ctxWith(subagents, { get: () => session(events) }))
    const live = (await api.live({ rootSessionId: 'root' })).live
    expect(live.windowed?.summary).toEqual({
      counts: [{ kind: 'read', count: 1 }],
      running: 'read',
      runningDetail: 'a',
    })
  })

  it('keeps a child whose session log is unreadable (its flag is the catalog\'s)', async () => {
    const subagents: SidebarSubagentsService = {
      listDescendants: vi.fn(async () => [
        child('good', { label: 'Good' }),
        child('bad', { label: 'Bad' }),
      ]),
    }
    const sessions = {
      get: (id: string) => {
        if (id === 'good') return session([reply('ok', 0, 0)])
        throw new Error('missing')
      },
    }
    const api = buildSubagentLiveApi(ctxWith(subagents, sessions))
    const live = (await api.live({ rootSessionId: 'root' })).live
    expect(live.good?.text).toBe('ok')
    expect(live.bad).toEqual({ running: true })
  })

  it('degrades to a 503 when the subagent runtime is absent', async () => {
    const api = buildSubagentLiveApi(ctxWith(undefined, { get: () => undefined }))
    await expect(api.live({ rootSessionId: 'root' })).rejects.toThrowError(
      expect.objectContaining<Partial<SidebarError>>({ code: 'subagents-unavailable', status: 503 }),
    )
  })

  it('degrades to a 503 when listDescendants fails', async () => {
    const subagents: SidebarSubagentsService = {
      listDescendants: vi.fn(async () => { throw new Error('projection unavailable') }),
    }
    const api = buildSubagentLiveApi(ctxWith(subagents, { get: () => undefined }))
    await expect(api.live({ rootSessionId: 'root' })).rejects.toThrowError(
      expect.objectContaining<Partial<SidebarError>>({ code: 'subagents-unavailable', status: 503 }),
    )
  })

  it('rejects a missing rootSessionId as bad-request', async () => {
    const api = buildSubagentLiveApi(ctxWith(undefined, { get: () => undefined }))
    await expect(api.live({})).rejects.toThrowError(
      expect.objectContaining<Partial<SidebarError>>({ code: 'bad-request' }),
    )
  })
})
