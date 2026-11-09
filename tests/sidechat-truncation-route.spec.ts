/**
 * D10 (route half) — `sidechat.events` must TELL the client when it cut the
 * head off the log. Design basis: `/tmp/bsb-parity/spec.md` §D10 / §3.8.
 *
 * Why this spec exists: the route keeps the newest `EVENTS_CAP = 8000` events
 * (`sidechat-routes.ts:156`) and returns `fresh.slice(fresh.length - EVENTS_CAP)`
 * with no marker (`:879`). The client cannot distinguish "this is the whole
 * thread" from "the first N events were dropped", so it renders the tail as if
 * it were the beginning.
 *
 * ============================ CONTRACT ============================
 * 1. The `sidechat.events` result carries an ADDITIVE boolean field
 *    `truncated`, describing the THREAD rather than this one response:
 *      - `true`  ⇔ the thread's own log EXCEEDS `EVENTS_CAP`, i.e. the reader
 *                  is looking at an incomplete history (the response's
 *                  `events` are then a tail slice of that log);
 *      - `false` ⇔ the own log fits, so `events` (+ any delta) is complete.
 *    The flag must NOT drift with the request shape: a small `afterSeq` poll
 *    against an over-cap log is the same incomplete thread and still reports
 *    `true`, while a delta on a log that fits reports `false`.
 * 2. The field is additive: `events`, `live` and `pending` keep their shapes,
 *    so an older client that ignores `truncated` parses the response unchanged.
 * 3. The boundary is exact: exactly `EVENTS_CAP` own events is NOT truncated;
 *    one more is.
 * 4. When truncated, the returned events are the NEWEST ones (the tail), which
 *    is what the reader's tail window is anchored to.
 * ==================================================================
 *
 * Kept as its own file (rather than appended to tests/sidechat-routes.spec.ts)
 * so the existing route assertions stay untouched. The fakes below are the
 * minimal live-agent face the `sidechat.events` handler reads.
 */
import { describe, expect, it, vi } from 'vitest'
import { buildSidechatApi } from '../src/sidechat-routes.ts'
import type { Context } from '../src/context-types.ts'

/** The route's documented head cap. */
const EVENTS_CAP = 8_000

/** The `sidechat.events` result this contract adds one field to. */
interface EventsResult {
  events: { seq: number; type: string }[]
  live: unknown[]
  pending: unknown[]
  truncated?: boolean
}

/** The narrowest live agent the events handler reads. */
function agent(id: string, events: unknown[]) {
  const inbox = { nextTurn: [] as unknown[], nextStep: [] as unknown[], clear: vi.fn(), remove: vi.fn(() => true) }
  return {
    id,
    status: 'idle' as const,
    options: { provider: 'test', model: 'model-x' },
    ctx: { on: vi.fn(() => () => {}) },
    session: {
      id,
      header: { cwd: '/p', delegationDepth: 0 },
      inheritedEventCount: 0,
      snapshotEvents: () => events,
      append: vi.fn((type: string, data: unknown) => ({ type, seq: 0, time: 0, data })),
    },
    inject: vi.fn(),
    followup: vi.fn(),
    cancel: vi.fn(),
    inbox,
  }
}

/** A context serving only the agents service the handler needs. */
function ctxWithAgents(child: ReturnType<typeof agent>): Context {
  return {
    get: (key: string) => (key === 'agents' ? { get: (id: string) => (id === child.id ? child : undefined) } : undefined),
  } as unknown as Context
}

/**
 * A thread-own log with `count` events after the seed marker.
 * @param count - how many own events (seq 1…count).
 */
function ownLog(count: number): unknown[] {
  const events: unknown[] = [{ type: 'session/end-seed', seq: 0, time: 0, data: {} }]
  for (let index = 1; index <= count; index += 1) {
    events.push({ type: 'user/message', seq: index, time: index * 1_000, data: { content: [{ type: 'text', text: `m${String(index)}` }], source: { kind: 'user' } } })
  }
  return events
}

/** Read the events route for a live thread holding `count` own events. */
async function eventsRoute(count: number, payload: Record<string, unknown> = {}): Promise<EventsResult> {
  const child = agent('child', ownLog(count))
  const api = buildSidechatApi(ctxWithAgents(child))
  const result = await api['sidechat.events']({ childId: 'child', ...payload })
  return result as unknown as EventsResult
}

describe('sidechat.events truncation flag (D10)', () => {
  it('reports truncated: true when the cap drops the head of the log', async () => {
    const result = await eventsRoute(EVENTS_CAP + 50)
    expect(result.events, 'the response is capped at EVENTS_CAP').toHaveLength(EVENTS_CAP)
    expect(result.truncated, 'a capped response says it was truncated').toBe(true)
  })

  it('returns the NEWEST events, not the oldest', async () => {
    const result = await eventsRoute(EVENTS_CAP + 50)
    // The own log runs 0…CAP+50 (the seed marker is part of it — it is only cut
    // when it carries `inherited: true`), so the kept window starts at 51.
    expect(result.events[0]?.seq, 'the head events are dropped').toBe(51)
    expect(result.events.at(-1)?.seq, 'the tail survives').toBe(EVENTS_CAP + 50)
  })

  it('reports truncated: false when the whole own log fits, at the exact boundary', async () => {
    // The seed marker counts toward the cap, so CAP-1 messages fill it exactly.
    const atCap = await eventsRoute(EVENTS_CAP - 1)
    expect(atCap.events, 'the whole own log comes back').toHaveLength(EVENTS_CAP)
    expect(atCap.truncated, 'a complete log says so').toBe(false)

    const oneMore = await eventsRoute(EVENTS_CAP)
    expect(oneMore.events, 'one event past the cap is still capped at EVENTS_CAP').toHaveLength(EVENTS_CAP)
    expect(oneMore.truncated, 'one event past the cap is truncated').toBe(true)

    const small = await eventsRoute(10)
    expect(small.events, 'a short log comes back whole (seed marker included)').toHaveLength(11)
    expect(small.truncated).toBe(false)
  })

  it('reports the THREAD\'s truncation on a delta poll of an over-cap log too', async () => {
    // The delta itself is tiny, but the thread's history is not: the reader is
    // still looking at an incomplete log, so the flag follows the thread, not
    // the request shape.
    const delta = await eventsRoute(EVENTS_CAP + 50, { afterSeq: EVENTS_CAP + 49 })
    expect(delta.events.map(event => event.seq)).toEqual([EVENTS_CAP + 50])
    expect(delta.truncated, 'an over-cap log stays truncated on a small delta').toBe(true)
  })

  it('leaves a delta on a log that fits untouched', async () => {
    const delta = await eventsRoute(10, { afterSeq: 9 })
    expect(delta.events.map(event => event.seq)).toEqual([10])
    expect(delta.truncated, 'a log that fits is never called truncated').toBe(false)
  })

  it('keeps the response additive: events, live and pending are unchanged', async () => {
    const result = await eventsRoute(10)
    expect(Array.isArray(result.events)).toBe(true)
    expect(Array.isArray(result.live), 'the live rows still ride the poll').toBe(true)
    expect(Array.isArray(result.pending), 'the unclaimed inbox still rides the poll').toBe(true)
    expect(typeof result.truncated, 'the new field is a boolean, not a payload').toBe('boolean')
  })
})
