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
function session(events: SidebarSessionEvent[]): { header: { cwd: string }; events: SidebarSessionEvent[] } {
  return { header: { cwd: '/p' }, events }
}

/** A context whose `get` serves only the subagents face, with a session store. */
function ctxWith(subagents: unknown, sessions: unknown): Context {
  return {
    sessions,
    get: (key: string) => (key === 'subagents' ? subagents : undefined),
  } as unknown as Context
}

describe('subagents.live route', () => {
  it('returns non-empty activity for running children only', async () => {
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
        if (id === 'running-a') {
          return session([
            { type: 'assistant/message', seq: 0, time: 0, data: { message: { content: [{ type: 'text', text: 'hello' }] } } },
          ])
        }
        if (id === 'running-b') {
          return session([
            { type: 'tool/call', seq: 0, time: 0, data: { name: 'bash', arguments: '{"command":"ls"}' } },
          ])
        }
        return session([])
      },
    }
    const api = buildSubagentLiveApi(ctxWith(subagents, sessions))
    await expect(api.live({ rootSessionId: 'root' })).resolves.toEqual({
      live: {
        'running-a': { text: 'hello' },
        'running-b': { tool: { name: 'bash', args: '{"command":"ls"}' } },
      },
    })
    expect(subagents.listDescendants).toHaveBeenCalledWith('root')
  })

  it('omits children with no text/tool yet', async () => {
    const subagents: SidebarSubagentsService = {
      listDescendants: vi.fn(async () => [child('empty', { label: 'Empty' })]),
    }
    const sessions = { get: () => session([]) }
    const api = buildSubagentLiveApi(ctxWith(subagents, sessions))
    await expect(api.live({ rootSessionId: 'root' })).resolves.toEqual({ live: {} })
  })

  it('folds only activity inside the recent 12-message window', async () => {
    // One stale tool call sits before 13 user messages; the recent window
    // (the tail's last 12 messages) must not surface it.
    const staleTool: SidebarSessionEvent = {
      type: 'tool/call', seq: 0, time: 0,
      data: { callId: 'stale', name: 'bash', arguments: '{"command":"old"}' },
    }
    const oldMessages: SidebarSessionEvent[] = Array.from({ length: 13 }, (_, i) => ({
      type: 'user/message', seq: i + 1, time: 0,
      data: { content: [{ type: 'text', text: `m${i}` }] },
    }))
    const recentText: SidebarSessionEvent = {
      type: 'assistant/message', seq: 99, time: 0,
      data: { message: { content: [{ type: 'text', text: 'recent' }] } },
    }
    const subagents: SidebarSubagentsService = {
      listDescendants: vi.fn(async () => [child('windowed', { label: 'W' })]),
    }
    const sessions = { get: () => session([staleTool, ...oldMessages, recentText]) }
    const api = buildSubagentLiveApi(ctxWith(subagents, sessions))
    await expect(api.live({ rootSessionId: 'root' })).resolves.toEqual({
      live: { windowed: { text: 'recent' } },
    })
  })

  it('skips a child whose session log is unavailable without failing the batch', async () => {
    const subagents: SidebarSubagentsService = {
      listDescendants: vi.fn(async () => [
        child('good', { label: 'Good' }),
        child('bad', { label: 'Bad' }),
      ]),
    }
    const sessions = {
      get: (id: string) => {
        if (id === 'good') {
          return session([
            { type: 'assistant/message', seq: 0, time: 0, data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
          ])
        }
        throw new Error('missing')
      },
    }
    const api = buildSubagentLiveApi(ctxWith(subagents, sessions))
    await expect(api.live({ rootSessionId: 'root' })).resolves.toEqual({
      live: { good: { text: 'ok' } },
    })
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
