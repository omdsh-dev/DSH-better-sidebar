/**
 * Host route + push-feed tests for the plan page ('plans.events' and the
 * `/sidebar/ws/plans` feed). The route's shape and rationale live in
 * src/plans-routes.ts; what is pinned here is its behaviour: which rows it
 * ships, which it refuses, and what the feed announces and mirrors.
 */
import { describe, expect, it } from 'vitest'
import { buildPlansApi, createPlanPushes, type PlanRowMirror } from '../src/plans-routes.ts'
import { PLAN_EVENTS_WINDOW } from '../src/plan-events.ts'
import { SidebarError } from '../src/wire.ts'
import type { Context, SidebarSessionEvent } from '../src/context-types.ts'

/** A mirror serving no rows (most cases drive the store alone). */
const noMirror: PlanRowMirror = { rows: () => [] }

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
  it('ships only the plan rows, dropping unrelated tool traffic', async () => {
    const [noiseCall, noiseResult] = noise(1, 'b1')
    const events = [noiseCall, noiseResult, planCall(3, 'p1'), planResult(4, 'p1', 'approved')]
    const api = buildPlansApi(ctxWith({ get: () => session(events) }), noMirror, PLAN_EVENTS_WINDOW)
    const { events: shipped } = await api.events({ sessionId: 's1' })
    expect(shipped.map(event => event.seq)).toEqual([3, 4])
  })

  it('drops a result whose call is not a plan call', async () => {
    const [, noiseResult] = noise(1, 'b1')
    const api = buildPlansApi(ctxWith({ get: () => session([planCall(3, 'p1'), noiseResult]) }), noMirror, PLAN_EVENTS_WINDOW)
    expect((await api.events({ sessionId: 's1' })).events.map(event => event.seq)).toEqual([3])
  })

  it('drops a call whose result marks it aborted before dispatch, together with its result', async () => {
    // The harness mounts the error's `info` — not the error itself — on the
    // result, so the code rides `data.error.code` and reads
    // 'ABORTED_BEFORE_DISPATCH' (the dsh-tools constant's VALUE, not its name).
    // The call row carries a perfectly good body, but the user never saw a
    // review card, so neither face may ship or fold it.
    const abortedResult = planResult(4, 'p1', 'aborted', {
      isError: true,
      error: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' },
    })
    const events = [planCall(3, 'p1'), abortedResult, planCall(5, 'p2'), planResult(6, 'p2', 'approved')]
    const api = buildPlansApi(ctxWith({ get: () => session(events) }), noMirror, PLAN_EVENTS_WINDOW)
    expect((await api.events({ sessionId: 's1' })).events.map(event => event.seq)).toEqual([5, 6])
  })

  it('drops a submission the host itself would refuse', async () => {
    // The host validates `/^#\s+\S/` INSIDE execute — its call row is already
    // logged by then, so a name match alone would ship rows the user never saw
    // a review card for.
    const events = [
      planCall(1, 'bad1', '## 二级标题开头'),
      planCall(2, 'bad2', '没有标题的正文'),
      planCall(3, 'good', '# 合法计划'),
    ]
    const api = buildPlansApi(ctxWith({ get: () => session(events) }), noMirror, PLAN_EVENTS_WINDOW)
    expect((await api.events({ sessionId: 's1' })).events.map(event => event.seq)).toEqual([3])
  })

  it('recognizes a result past the cursor by collecting plan ids over the WHOLE log', async () => {
    const events = [planCall(1, 'p1'), planResult(2, 'p1', 'keep planning', { isError: true })]
    const api = buildPlansApi(ctxWith({ get: () => session(events) }), noMirror, PLAN_EVENTS_WINDOW)
    // A client that already holds seq 1 must still receive the seq-2 result.
    const { events: shipped, lastSeq } = await api.events({ sessionId: 's1', afterSeq: 1 })
    expect(shipped.map(event => event.seq)).toEqual([2])
    expect(lastSeq).toBe(2)
  })

  it('reports lastSeq as the newest shipped seq, and the cursor itself on an empty delta', async () => {
    const api = buildPlansApi(ctxWith({ get: () => session([planCall(1, 'p1')]) }), noMirror, PLAN_EVENTS_WINDOW)
    expect((await api.events({ sessionId: 's1' })).lastSeq).toBe(1)
    expect((await api.events({ sessionId: 's1', afterSeq: 5 })).lastSeq).toBe(5)
  })

  it('caps the response to the most recent window without splitting a pair', async () => {
    // Calls at 0, 2, 4 with results at 1, 3, 5 — a cap of 3 would slice
    // [3, 4, 5], whose head is a headless result: the fold pairs by call id,
    // so shipping it would drop a whole revision. The orphan is trimmed.
    const events = [
      planCall(0, 'p0'), planResult(1, 'p0', 'ok'),
      planCall(2, 'p1'), planResult(3, 'p1', 'ok'),
      planCall(4, 'p2'), planResult(5, 'p2', 'ok'),
    ]
    const api = buildPlansApi(ctxWith({ get: () => session(events) }), noMirror, 3)
    expect((await api.events({ sessionId: 's1' })).events.map(event => event.seq)).toEqual([4, 5])
  })

  it('falls back to the persisted log when the live store has no session', async () => {
    const api = buildPlansApi(
      ctxWith({ get: () => undefined }, persistenceWith([planCall(1, 'p1')])),
      noMirror,
      PLAN_EVENTS_WINDOW,
    )
    expect((await api.events({ sessionId: 'cold' })).events.map(event => event.seq)).toEqual([1])
  })

  it('answers an empty window (never an error) when neither source is available', async () => {
    const api = buildPlansApi(ctxWith({ get: () => undefined }), noMirror, PLAN_EVENTS_WINDOW)
    expect(await api.events({ sessionId: 'gone' })).toEqual({ events: [], lastSeq: 0 })
  })

  it('merges the mirrored rows a store frozen at its rehydration boundary misses', async () => {
    // The store session reports an empty log (the post-restart state), while
    // the push feed mirrored what the live append feed carried.
    const mirrored = [planCall(7, 'p7')]
    const api = buildPlansApi(
      ctxWith({ get: () => session([]) }),
      { rows: () => mirrored },
      PLAN_EVENTS_WINDOW,
    )
    expect((await api.events({ sessionId: 's1' })).events.map(event => event.seq)).toEqual([7])
  })

  it('serves a log that opens on a seq-0 call (the cursor floors at -1)', async () => {
    // A session whose log opens on the call itself carries seq 0: a literal
    // `> 0` comparison would drop it, and the page would claim "no plans"
    // while a review card sits in the log.
    const api = buildPlansApi(ctxWith({ get: () => session([planCall(0, 'p0')]) }), noMirror, PLAN_EVENTS_WINDOW)
    expect((await api.events({ sessionId: 's1' })).events.map(event => event.seq)).toEqual([0])
    // An EXPLICIT cursor of 0 still excludes it.
    expect((await api.events({ sessionId: 's1', afterSeq: 0 })).events).toEqual([])
  })

  it('rejects a malformed cursor and a missing sessionId', async () => {
    const api = buildPlansApi(ctxWith({ get: () => undefined }), noMirror, PLAN_EVENTS_WINDOW)
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
    // …and it is not mirrored either.
    expect(pushes.rows('s1')).toEqual([])
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
    expect(pushes.rows('s1')).toEqual([])
  })

  it('mirrors the submitted call and the result that pairs with it', () => {
    const { ctx, emit } = ctxWithFeed()
    const pushes = createPlanPushes(ctx)
    emit({ id: 's1' }, planCall(1, 'p1'))
    emit({ id: 's1' }, planResult(2, 'p1', 'approved'))
    expect(pushes.rows('s1').map(row => row.seq)).toEqual([1, 2])
  })

  it('mirrors no result whose call it never mirrored', () => {
    const { ctx, emit } = ctxWithFeed()
    const pushes = createPlanPushes(ctx)
    emit({ id: 's1' }, planResult(1, 'unknown', 'stray'))
    emit({ id: 's1' }, { type: 'tool/result', seq: 2, time: 2, data: { message: { content: [] } } })
    expect(pushes.rows('s1')).toEqual([])
  })

  it('keeps a working subscription face on a context without the event API', () => {
    const pushes = createPlanPushes(ctxWith({ get: () => undefined }))
    const received: unknown[] = []
    const detach = pushes.subscribe('s1', notice => received.push(notice))
    expect(() => { detach(); pushes.dispose() }).not.toThrow()
    expect(received).toEqual([])
    expect(pushes.rows('s1')).toEqual([])
  })
})
