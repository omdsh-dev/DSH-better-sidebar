/**
 * Host route tests for the workflow-runs API ('workflows.list'): the route
 * must enumerate the tree (root + catalog descendants), merge each session's
 * stored log with the live `session/event` mirror (deduped by seq), skip
 * unreadable sessions, and degrade to a root-only fold when the subagent
 * runtime is absent. Absence of workflow events is an empty list, never an
 * error.
 */
import { describe, expect, it, vi } from 'vitest'
import { buildWorkflowsApi } from '../src/workflow-routes.ts'
import type {
  Context,
  SidebarSessionEvent,
  SidebarSubagentDescendantEntry,
} from '../src/context-types.ts'

/** One child descendant row. */
function child(id: string): SidebarSubagentDescendantEntry {
  return { kind: 'child', id, activity: 'running', hasChildren: false, mode: 'one-shot', parentId: 'root', depth: 1 }
}

/** A session with the given raw events. */
function session(events: SidebarSessionEvent[]) {
  return { header: { cwd: '/p' }, snapshotEvents: () => events }
}

/** One workflow event row. */
function ev(seq: number, type: string, data: Record<string, unknown>): SidebarSessionEvent {
  return { type, seq, time: 0, data }
}

/** A context with sessions + optional subagents service + optional event feed. */
function ctxWith(options: {
  sessions: Map<string, SidebarSessionEvent[]>
  subagents?: unknown
  on?: (event: string, listener: (session: unknown, event: SidebarSessionEvent) => void) => () => void
}): Context {
  return {
    sessions: { get: (id: string) => { const e = options.sessions.get(id); return e === undefined ? undefined : session(e) } },
    get: (key: string) => (key === 'subagents' ? options.subagents : undefined),
    ...(options.on === undefined ? {} : { on: options.on }),
    effect: () => () => {},
  } as unknown as Context
}

describe('workflows.list route', () => {
  it('folds the runs of every tree session, oldest first', async () => {
    const subagents = { listDescendants: vi.fn(async () => [child('child-a')]) }
    const sessions = new Map<string, SidebarSessionEvent[]>([
      ['child-a', [
        ev(1, 'tool-workflow/run-start', { runId: 'r1', name: 'child-run' }),
        ev(2, 'tool-workflow/run-end', { runId: 'r1', stopReason: 'completed' }),
      ]],
      ['root', [
        ev(5, 'tool-workflow/run-start', { runId: 'r2', name: 'root-run' }),
      ]],
    ])
    const api = buildWorkflowsApi(ctxWith({ sessions, subagents }))
    const { runs } = await api.list({ rootSessionId: 'root' })
    expect(runs.map(run => [run.runId, run.originSessionId, run.status])).toEqual([
      ['r1', 'child-a', 'completed'],
      ['r2', 'root', 'running'],
    ])
    expect(subagents.listDescendants).toHaveBeenCalledWith('root')
  })

  it('returns an empty list when the tree never ran a workflow', async () => {
    const subagents = { listDescendants: vi.fn(async () => [child('child-a')]) }
    const sessions = new Map<string, SidebarSessionEvent[]>([
      ['root', [ev(1, 'assistant/message', { message: { content: [] } })]],
      ['child-a', []],
    ])
    const api = buildWorkflowsApi(ctxWith({ sessions, subagents }))
    await expect(api.list({ rootSessionId: 'root' })).resolves.toEqual({ runs: [] })
  })

  it('folds the root alone when the subagent runtime is absent', async () => {
    const sessions = new Map<string, SidebarSessionEvent[]>([
      ['root', [ev(1, 'tool-workflow/run-start', { runId: 'r', name: 'solo' })]],
    ])
    const api = buildWorkflowsApi(ctxWith({ sessions }))
    const { runs } = await api.list({ rootSessionId: 'root' })
    expect(runs.map(run => run.runId)).toEqual(['r'])
  })

  it('folds the root alone when listDescendants fails', async () => {
    const subagents = { listDescendants: vi.fn(async () => { throw new Error('stale') }) }
    const sessions = new Map<string, SidebarSessionEvent[]>([
      ['root', [ev(1, 'tool-workflow/run-start', { runId: 'r', name: 'solo' })]],
    ])
    const api = buildWorkflowsApi(ctxWith({ sessions, subagents }))
    const { runs } = await api.list({ rootSessionId: 'root' })
    expect(runs.map(run => run.runId)).toEqual(['r'])
  })

  it('merges the live mirror with the stored log, deduped by seq', async () => {
    type Listener = (session: unknown, event: SidebarSessionEvent) => void
    let listener: Listener | undefined
    const on = (_event: string, bound: Listener) => { listener = bound; return () => {} }
    // The stored log ends at the run-start (a rehydrated store session); the
    // live mirror carries the rest, re-sending the stored start row too.
    const sessions = new Map<string, SidebarSessionEvent[]>([
      ['root', [ev(1, 'tool-workflow/run-start', { runId: 'r', name: 'live' })]],
    ])
    const api = buildWorkflowsApi(ctxWith({ sessions, on }))
    listener?.({ id: 'root' }, ev(1, 'tool-workflow/run-start', { runId: 'r', name: 'live' }))
    listener?.({ id: 'root' }, ev(2, 'tool-workflow/agent-start', { runId: 'r', seq: 1, label: 'a', childId: 'c' }))
    listener?.({ id: 'root' }, ev(3, 'tool-workflow/run-end', { runId: 'r', stopReason: 'completed' }))
    listener?.({ id: 'other' }, ev(1, 'tool-workflow/run-start', { runId: 'stray', name: 'stray' }))
    const { runs } = await api.list({ rootSessionId: 'root' })
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ runId: 'r', status: 'completed' })
    expect(runs[0]?.phases[0]?.members).toHaveLength(1)
  })

  it('skips a session whose log read throws without failing the batch', async () => {
    const subagents = { listDescendants: vi.fn(async () => [child('bad'), child('good')]) }
    const sessions = {
      get: (id: string) => {
        if (id === 'good') return session([ev(1, 'tool-workflow/run-start', { runId: 'g', name: 'good' })])
        if (id === 'root') return session([])
        throw new Error('missing')
      },
    }
    const ctx = {
      sessions,
      get: (key: string) => (key === 'subagents' ? subagents : undefined),
      effect: () => () => {},
    } as unknown as Context
    const api = buildWorkflowsApi(ctx)
    const { runs } = await api.list({ rootSessionId: 'root' })
    expect(runs.map(run => run.runId)).toEqual(['g'])
  })

  it('rejects a missing rootSessionId as bad-request', async () => {
    const api = buildWorkflowsApi(ctxWith({ sessions: new Map() }))
    await expect(api.list({})).rejects.toThrowError(
      expect.objectContaining({ code: 'bad-request' }),
    )
  })
})
