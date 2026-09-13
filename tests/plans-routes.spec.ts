/**
 * Host route + push-feed tests for the plan page ('plans.events' and the
 * `/sidebar/ws/plans` feed). The route's shape and rationale live in
 * src/plans-routes.ts; what is pinned here is its behaviour: which revisions
 * it ships, which it refuses, and what the feed announces.
 */
import { describe, expect, it } from 'vitest'
import { buildPlansApi, createPlanPushes } from '../src/plans-routes.ts'
import { PLAN_EVENTS_WINDOW } from '../src/plan-events.ts'
import { SidebarError } from '../src/wire.ts'
import type { Context, SidebarSessionEvent } from '../src/context-types.ts'

/** A context whose `get` serves the session store and an optional persistence face. */
function ctxWith(sessions: unknown, persistence?: unknown): Context {
  return {
    sessions,
    get: (key: string) => (key === 'sessionPersistence' ? persistence : undefined),
  } as unknown as Context
}

/** A context that additionally captures the session/event listener (push feed). */
function ctxWithFeed(): {
  ctx: Context
  emit: (session: unknown, event: SidebarSessionEvent) => void
} {
  let listener: ((session: unknown, event: SidebarSessionEvent) => void) | undefined
  const base = ctxWith({ get: () => undefined }) as unknown as {
    on: (event: string, fn: (session: unknown, event: SidebarSessionEvent) => void) => () => void
    effect: (fn: () => void | (() => void)) => void
  }
  base.on = (_event: string, fn) => {
    listener = fn
    return () => { if (listener === fn) listener = undefined }
  }
  // The vendored cordis runs the registration effect immediately.
  base.effect = (fn) => { fn() }
  return {
    ctx: base as unknown as Context,
    emit: (session, event) => { listener?.(session, event) },
  }
}

/** One exit_plan_mode tool/call event. */
function planCall(seq: number, callId: string, plan = '# 计划'): SidebarSessionEvent {
  return { type: 'tool/call', seq, time: seq, data: { name: 'exit_plan_mode', callId, arguments: JSON.stringify({ plan }) } }
}

/** One tool/result event carrying the finalized text the model received. */
function planResult(
  seq: number,
  callId: string,
  text: string,
  over: { isError?: boolean; error?: unknown } = {},
): SidebarSessionEvent {
  return {
    type: 'tool/result',
    seq,
    time: seq,
    data: {
      ...(over.error === undefined ? {} : { error: over.error }),
      message: {
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, isError: over.isError === true, content: [{ type: 'text', text }] }],
      },
    },
  }
}

/** One bash tool/call + its result (rows the route must drop). */
function noise(seq: number, callId: string): [SidebarSessionEvent, SidebarSessionEvent] {
  return [
    { type: 'tool/call', seq, time: seq, data: { name: 'bash', callId, arguments: '{"command":"ls"}' } },
    planResult(seq + 1, callId, 'ok'),
  ]
}

/** The owner session with the given event log. */
function session(events: SidebarSessionEvent[]): unknown {
  return { header: { cwd: '/p' }, snapshotEvents: () => events }
}

/** A persistence face serving one fixed log through the read handle contract. */
function persistenceWith(events: SidebarSessionEvent[]): unknown {
  return {
    open: async () => ({
      header: { cwd: '/p' },
      inheritedEventCount: 0,
      read: async () => ({ events }),
      close: async () => {},
    }),
  }
}

describe('plans.events route', () => {
  it('ships a revision for every plan, dropping unrelated tool traffic', async () => {
    const [noiseCall, noiseResult] = noise(1, 'b1')
    const events = [noiseCall, noiseResult, planCall(3, 'p1', '# 计划'), planResult(4, 'p1', 'approved')]
    const api = buildPlansApi(ctxWith({ get: () => session(events) }), PLAN_EVENTS_WINDOW)
    const entries = await api.events({ sessionId: 's1' })
    expect(entries.map(entry => [entry.callId, entry.status])).toEqual([['p1', 'approved']])
  })

  it('drops a result whose call is not a plan call', async () => {
    const [, noiseResult] = noise(1, 'b1')
    const api = buildPlansApi(ctxWith({ get: () => session([planCall(3, 'p1'), noiseResult]) }), PLAN_EVENTS_WINDOW)
    const entries = await api.events({ sessionId: 's1' })
    expect(entries.map(entry => [entry.callId, entry.status])).toEqual([['p1', 'pending']])
  })

  it('drops a submission the host itself would refuse', async () => {
    // The host validates `/^#\s+\S/` INSIDE execute — its call row is already
    // logged by then, so a name match alone would show rows the user never saw
    // a review card for.
    const events = [
      planCall(1, 'bad1', '## 二级标题开头'),
      planCall(2, 'bad2', '没有标题的正文'),
      planCall(3, 'good', '# 合法计划'),
    ]
    const api = buildPlansApi(ctxWith({ get: () => session(events) }), PLAN_EVENTS_WINDOW)
    const entries = await api.events({ sessionId: 's1' })
    expect(entries.map(entry => entry.callId)).toEqual(['good'])
  })

  it('shows no revision for a call aborted before dispatch', async () => {
    // The stop lands between the call and its execution: the harness logs a
    // perfectly good body with an abort result, and the user never saw it. The
    // route ships both rows and the fold rules the pair out — the delivery is
    // what lets the result teach the fold that the call never ran.
    const events = [
      planCall(3, 'p1'),
      planResult(4, 'p1', 'aborted', { isError: true, error: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' } }),
      planCall(5, 'p2', '# 正常计划'),
      planResult(6, 'p2', 'approved'),
    ]
    const api = buildPlansApi(ctxWith({ get: () => session(events) }), PLAN_EVENTS_WINDOW)
    const entries = await api.events({ sessionId: 's1' })
    expect(entries.map(entry => [entry.callId, entry.status])).toEqual([['p2', 'approved']])
  })

  it('drops the abort result of a non-plan tool the stop also skipped', async () => {
    // The agent loop stamps a call + ABORTED_BEFORE_DISPATCH pair for EVERY
    // tool a stop skips, not just the exit tool. The abort set gates on the
    // paired call row being a plan call, or every stopped bash command rides
    // the plans wire as a result no plan face can use.
    const events: SidebarSessionEvent[] = [
      { type: 'tool/call', seq: 1, time: 1, data: { name: 'bash', callId: 'b1', arguments: '{"command":"ls"}' } },
      planResult(2, 'b1', 'aborted', { isError: true, error: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' } }),
      planCall(3, 'p1'),
      planResult(4, 'p1', 'approved'),
    ]
    const api = buildPlansApi(ctxWith({ get: () => session(events) }), PLAN_EVENTS_WINDOW)
    const entries = await api.events({ sessionId: 's1' })
    expect(entries.map(entry => entry.callId)).toEqual(['p1'])
  })

  it('serves a log that opens on a seq-0 call', async () => {
    // A session whose log opens on the call itself carries seq 0 — the row a
    // window that assumes a non-zero first seq would drop.
    const api = buildPlansApi(ctxWith({ get: () => session([planCall(0, 'p0')]) }), PLAN_EVENTS_WINDOW)
    const entries = await api.events({ sessionId: 's1' })
    expect(entries.map(entry => entry.seq)).toEqual([0])
  })

  it('caps the response to the most recent rows without splitting a pair', async () => {
    // Calls at 0, 2, 4 with results at 1, 3, 5 — a cap of 3 would slice
    // [3, 4, 5], whose head is a headless result: the fold pairs by call id,
    // so shipping it would drop a whole revision. The orphan is trimmed.
    const events = [
      planCall(0, 'p0'), planResult(1, 'p0', 'ok'),
      planCall(2, 'p1'), planResult(3, 'p1', 'ok'),
      planCall(4, 'p2'), planResult(5, 'p2', 'ok'),
    ]
    const api = buildPlansApi(ctxWith({ get: () => session(events) }), 3)
    const entries = await api.events({ sessionId: 's1' })
    expect(entries.map(entry => [entry.callId, entry.status])).toEqual([['p2', 'approved']])
  })

  it('falls back to the persisted log when the live store has no session', async () => {
    const api = buildPlansApi(ctxWith({ get: () => undefined }, persistenceWith([planCall(1, 'p1')])), PLAN_EVENTS_WINDOW)
    const entries = await api.events({ sessionId: 'cold' })
    expect(entries.map(entry => entry.callId)).toEqual(['p1'])
  })

  it('answers an empty list (never an error) when neither source is available', async () => {
    const api = buildPlansApi(ctxWith({ get: () => undefined }), PLAN_EVENTS_WINDOW)
    expect(await api.events({ sessionId: 'gone' })).toEqual([])
  })

  it('reads the WHOLE list whatever cursor field a stale caller still sends', async () => {
    // Leftover compatibility guard: the response is a complete fold, so an
    // `afterSeq` no longer selects a window — it must not silently truncate.
    const events = [planCall(1, 'p1'), planResult(2, 'p1', 'approved'), planCall(3, 'p2')]
    const api = buildPlansApi(ctxWith({ get: () => session(events) }), PLAN_EVENTS_WINDOW)
    const cursor = await api.events({ sessionId: 's1', afterSeq: 2 })
    const plain = await api.events({ sessionId: 's1' })
    expect(cursor.map(entry => entry.callId)).toEqual(['p1', 'p2'])
    expect(cursor).toEqual(plain)
  })

  it('answers the same fold for the same log, however often it is asked', async () => {
    // The page replaces its whole list on every poll, so a re-read that
    // drifted — a re-ordered Map, a status that settled differently — would
    // churn the view with no new input. Two reads must be indistinguishable.
    const events = [planCall(1, 'p1'), planResult(2, 'p1', 'approved'), planCall(3, 'p2')]
    const api = buildPlansApi(ctxWith({ get: () => session(events) }), PLAN_EVENTS_WINDOW)
    const first = await api.events({ sessionId: 's1' })
    expect(await api.events({ sessionId: 's1' })).toEqual(first)
    // Growing the log only ever appends or SETTLES the revision it names: the
    // revisions already behind it come back untouched.
    events.push(planResult(4, 'p2', 'kept planning', { isError: true }))
    const settled = await api.events({ sessionId: 's1' })
    expect(settled.slice(0, 1)).toEqual(first.slice(0, 1))
    expect(settled.at(-1)).toMatchObject({ callId: 'p2', status: 'unadopted', settledTime: 4 })
    events.push(planCall(5, 'p3'))
    const grown = await api.events({ sessionId: 's1' })
    expect(grown.slice(0, 2)).toEqual(settled)
    expect(grown.at(-1)).toMatchObject({ callId: 'p3', status: 'pending' })
  })

  it('rejects a malformed cursor and a missing sessionId', async () => {
    const api = buildPlansApi(ctxWith({ get: () => undefined }), PLAN_EVENTS_WINDOW)
    await expect(api.events({ sessionId: 's1', afterSeq: -1 })).rejects.toBeInstanceOf(SidebarError)
    await expect(api.events({ sessionId: 's1', afterSeq: 1.5 })).rejects.toBeInstanceOf(SidebarError)
    await expect(api.events({})).rejects.toBeInstanceOf(SidebarError)
  })
})

describe('createPlanPushes', () => {
  it('announces an accepted submission to the subscriber of that session', () => {
    const { ctx, emit } = ctxWithFeed()
    const pushes = createPlanPushes(ctx)
    const received: Array<{ sessionId: string; seq: number }> = []
    pushes.subscribe('s1', notice => received.push(notice))
    emit({ id: 's1' }, planCall(7, 'p1'))
    expect(received).toEqual([{ sessionId: 's1', seq: 7 }])
  })

  it('ignores a submission the host itself would refuse', () => {
    const { ctx, emit } = ctxWithFeed()
    const pushes = createPlanPushes(ctx)
    const received: unknown[] = []
    pushes.subscribe('s1', notice => received.push(notice))
    emit({ id: 's1' }, planCall(1, 'bad', '## 二级标题开头'))
    expect(received).toEqual([])
  })

  it('ignores other tools, other event types, and other sessions', () => {
    const { ctx, emit } = ctxWithFeed()
    const pushes = createPlanPushes(ctx)
    const received: unknown[] = []
    pushes.subscribe('s1', notice => received.push(notice))
    emit({ id: 's1' }, { type: 'tool/call', seq: 1, time: 1, data: { name: 'bash', callId: 'b1', arguments: '{}' } })
    emit({ id: 's1' }, planResult(2, 'p1', 'ok'))
    emit({ id: 's2' }, planCall(3, 'p2'))
    emit({}, planCall(4, 'p3'))
    emit(null, planCall(5, 'p4'))
    expect(received).toEqual([])
  })

  it('stops delivering to a view that detached (no replay for a reattached one)', () => {
    const { ctx, emit } = ctxWithFeed()
    const pushes = createPlanPushes(ctx)
    const received: unknown[] = []
    const detach = pushes.subscribe('s1', notice => received.push(notice))
    emit({ id: 's1' }, planCall(1, 'p1'))
    detach()
    emit({ id: 's1' }, planCall(2, 'p2'))
    // A fresh attachment gets nothing from the past: the feed keeps no queue,
    // so a reloaded page is never popped open by a stale notice.
    pushes.subscribe('s1', notice => received.push(notice))
    expect(received).toEqual([{ sessionId: 's1', seq: 1 }])
  })

  it('delivers to every attached view and drops them all on dispose', () => {
    const { ctx, emit } = ctxWithFeed()
    const pushes = createPlanPushes(ctx)
    const first: unknown[] = []
    const second: unknown[] = []
    pushes.subscribe('s1', notice => first.push(notice))
    pushes.subscribe('s1', notice => second.push(notice))
    emit({ id: 's1' }, planCall(1, 'p1'))
    pushes.dispose()
    emit({ id: 's1' }, planCall(2, 'p2'))
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
  })

  it('keeps a working subscription face on a context without the event API', () => {
    const pushes = createPlanPushes(ctxWith({ get: () => undefined }))
    const received: unknown[] = []
    const detach = pushes.subscribe('s1', notice => received.push(notice))
    expect(() => { detach(); pushes.dispose() }).not.toThrow()
    expect(received).toEqual([])
  })
})
