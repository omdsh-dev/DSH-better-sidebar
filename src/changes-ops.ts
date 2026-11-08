/**
 * The `changes.ops` route: the session's file-tool events, as a `seq > afterSeq`
 * delta. Split out of `src/index.ts` because the wait form keeps a request open
 * (see below) and that plumbing deserves its own module.
 *
 * A PRIMED client (one that already holds the baseline) asks with `wait: true`:
 * the request parks until a matching tool event lands — or {@link WAIT_MS}
 * expires — instead of re-reading an unchanged window every poll. The reply is
 * still the same delta shape, so the client never needs a second code path.
 */
import type { Context, SidebarSessionEvent } from './context-types.ts'
import { readPersistedSession } from './session-store.ts'
import { requireString, SidebarError } from './wire.ts'

/** Recent-window bound: the lens shows the recent tail, not eternity. */
const EVENTS_CAP = 4000
/** How long one `wait: true` request parks before answering with the window. */
const WAIT_MS = 25_000

/** The event types the session lens folds — a plain tool pair, or a PTC one. */
function isFileToolEvent(event: SidebarSessionEvent): boolean {
  return event.type === 'tool/call' || event.type === 'tool/result'
    || event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch'
}

/**
 * Build the `changes.ops` handler for one plugin context.
 * @param ctx - host plugin context (sessions + sessionPersistence).
 * @returns the route handler.
 */
export function createChangesOpsApi(ctx: Context): (payload: unknown, signal?: AbortSignal) => Promise<{ events: SidebarSessionEvent[]; lastSeq: number }> {
  return async (payload, signal) => {
    const sessionId = requireString(payload, 'sessionId')
    const record = payload as { afterSeq?: unknown; wait?: unknown }
    const rawAfter = record.afterSeq
    // An absent cursor means "from the very first event": a session whose log
    // opens on a tool event (subagent seeds do) carries seq 0, which a literal
    // `> 0` comparison would drop, so the floor is -1 and it is spelled out.
    if (rawAfter !== undefined && (typeof rawAfter !== 'number' || !Number.isSafeInteger(rawAfter) || rawAfter < -1)) {
      throw new SidebarError('bad-request', 'afterSeq must be an integer of at least -1')
    }
    if (record.wait !== undefined && typeof record.wait !== 'boolean') {
      throw new SidebarError('bad-request', 'wait must be a boolean')
    }
    const afterSeq = rawAfter ?? -1

    /** Read the live or persisted log, keeping only the delta past the cursor. */
    const readWindow = async (): Promise<{ events: SidebarSessionEvent[]; lastSeq: number }> => {
      let events: readonly SidebarSessionEvent[] | undefined = ctx.sessions.get(sessionId)?.snapshotEvents()
      if (events === undefined) {
        const persistence = ctx.get('sessionPersistence')
        if (persistence !== undefined) {
          try {
            events = (await readPersistedSession(persistence, sessionId)).events
          } catch {
            // Cold read unavailable (session never persisted): an empty window
            // is the honest answer, not a wire error.
          }
        }
      }
      const filtered = (events ?? []).filter(event => isFileToolEvent(event) && event.seq > afterSeq)
      const window = filtered.length > EVENTS_CAP ? filtered.slice(-EVENTS_CAP) : filtered
      return { events: window, lastSeq: window.at(-1)?.seq ?? afterSeq }
    }

    if (record.wait !== true) return readWindow()

    const pending: SidebarSessionEvent[] = []
    let wake: (() => void) | undefined
    const notified = new Promise<void>(resolve => { wake = resolve })
    // Subscribe BEFORE the read: an event appended while we read must still
    // wake this request (otherwise the poll would answer with nothing new).
    const dispose = ctx.on('session/event', (session, event) => {
      // The vendored cordis `on` overload wins over the string-keyed one and
      // types the event as the rich SessionEvent union; this route only needs
      // the minimal structural slice, so restate it (same as the workflow and
      // sidechat subscriptions do).
      const minimal: SidebarSessionEvent = {
        type: event.type,
        seq: event.seq,
        time: event.time,
        data: event.data as Record<string, unknown>,
      }
      if ((session as { id?: unknown } | null)?.id !== sessionId
        || !isFileToolEvent(minimal) || minimal.seq <= afterSeq) return
      pending.push(minimal)
      if (pending.length > EVENTS_CAP) pending.shift()
      wake?.()
    })
    const timer = setTimeout(() => wake?.(), WAIT_MS)
    const abort = (): void => { wake?.() }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const initial = await readWindow()
      if (initial.events.length > 0 || signal?.aborted === true) return initial
      await notified
      const current = await readWindow()
      if (pending.length === 0) return current
      // The notification can beat the snapshot refresh, so merge the events the
      // subscription already saw rather than answering "nothing happened".
      const merged = new Map(current.events.map(event => [event.seq, event]))
      for (const event of pending) merged.set(event.seq, event)
      const events = [...merged.values()].sort((left, right) => left.seq - right.seq).slice(-EVENTS_CAP)
      return { events, lastSeq: events.at(-1)?.seq ?? afterSeq }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      dispose()
    }
  }
}
