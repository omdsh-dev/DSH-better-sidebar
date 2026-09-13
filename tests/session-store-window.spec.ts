/**
 * `sessionEventWindow` semantics (src/session-store.ts) — the shared window
 * every session-backed route reads through: cursor gating, the route's own
 * row cap, the live snapshot with the persisted log as fallback, and an empty
 * window that still answers a reusable cursor. `changes.ops` is the caller;
 * the plans route folds host-side and reads the same window.
 */
import { describe, expect, it } from 'vitest'
import { sessionEventWindow } from '../src/session-store.ts'
import { SidebarError } from '../src/wire.ts'
import type { Context, SidebarSessionEvent } from '../src/context-types.ts'

/** One generic log row (the window is shape-agnostic: take sees it all). */
function row(seq: number): SidebarSessionEvent {
  return { type: 'tool/call', seq, time: seq, data: { seq } }
}

/** A context serving one live store session and an optional persistence face. */
function ctxWith(
  live: readonly SidebarSessionEvent[] | undefined,
  persisted?: readonly SidebarSessionEvent[] | undefined,
): Context {
  return {
    sessions: {
      get: () => live === undefined ? undefined : { header: {}, snapshotEvents: () => live },
    },
    get: (key: string) => key === 'sessionPersistence' && persisted !== undefined
      ? {
          open: async () => ({
            header: {},
            read: async () => ({ events: persisted }),
            close: async () => {},
          }),
        }
      : undefined,
  } as unknown as Context
}

/** Ship everything past the cursor — the routes' common take shape. */
const takeAll = (
  log: readonly SidebarSessionEvent[],
  afterSeq: number,
): readonly SidebarSessionEvent[] => log.filter(event => event.seq > afterSeq)

describe('sessionEventWindow', () => {
  it('serves the whole log for an absent cursor, and gates on an explicit one', async () => {
    const log = [row(0), row(1), row(2)]
    const whole = await sessionEventWindow(ctxWith(log), { sessionId: 's' }, takeAll)
    // A log that opens on seq 0 still ships: the absent cursor floors at -1.
    expect(whole.events.map(event => event.seq)).toEqual([0, 1, 2])
    expect(whole.lastSeq).toBe(2)
    const gated = await sessionEventWindow(ctxWith(log), { sessionId: 's', afterSeq: 1 }, takeAll)
    expect(gated.events.map(event => event.seq)).toEqual([2])
    expect(gated.lastSeq).toBe(2)
  })

  it('answers a drained window with the cursor itself, floored at 0', async () => {
    const drained = await sessionEventWindow(ctxWith([row(0)]), { sessionId: 's', afterSeq: 9 }, takeAll)
    expect(drained.events).toEqual([])
    expect(drained.lastSeq).toBe(9)
    const fresh = await sessionEventWindow(ctxWith([]), { sessionId: 's' }, takeAll)
    expect(fresh.events).toEqual([])
    expect(fresh.lastSeq).toBe(0)
  })

  it('applies the route cap to the log tail after the cursor', async () => {
    const log = [row(0), row(1), row(2), row(3), row(4)]
    const capped = await sessionEventWindow(ctxWith(log), { sessionId: 's' }, (rows, afterSeq) => {
      const filtered = takeAll(rows, afterSeq)
      return filtered.slice(Math.max(0, filtered.length - 2))
    })
    expect(capped.events.map(event => event.seq)).toEqual([3, 4])
    expect(capped.lastSeq).toBe(4)
  })

  it('falls back to the persisted log when the live store has no session', async () => {
    const persisted = [row(0), row(1)]
    const { events, lastSeq } = await sessionEventWindow(ctxWith(undefined, persisted), { sessionId: 's' }, takeAll)
    expect(events.map(event => event.seq)).toEqual([0, 1])
    expect(lastSeq).toBe(1)
    expect(events[0]).toBe(persisted[0])
  })

  it('answers an empty window (never an error) when neither source is available', async () => {
    const { events, lastSeq } = await sessionEventWindow(ctxWith(undefined), { sessionId: 's' }, takeAll)
    expect(events).toEqual([])
    expect(lastSeq).toBe(0)
  })

  it('rejects a malformed cursor and a missing sessionId', async () => {
    // Input validation is shared, so the plans route inherits it even though
    // its own protocol no longer carries a cursor.
    await expect(sessionEventWindow(ctxWith([]), { sessionId: 's', afterSeq: -1 }, takeAll))
      .rejects.toBeInstanceOf(SidebarError)
    await expect(sessionEventWindow(ctxWith([]), { sessionId: 's', afterSeq: 1.5 }, takeAll))
      .rejects.toBeInstanceOf(SidebarError)
    await expect(sessionEventWindow(ctxWith([]), { sessionId: '' }, takeAll))
      .rejects.toBeInstanceOf(SidebarError)
  })
})
