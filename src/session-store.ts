/**
 * Cold-session reads over the host `sessionPersistence` service.
 *
 * DSH 0.1.5 removed the detached `inspect(id)` call: a persisted session is
 * read through an explicit handle — `open(id, 'read')` never takes write
 * ownership (so it works while the session is live in another process),
 * `handle.read()` returns one contiguous slice of the log, and `close()`
 * releases it. Every cold read in this plugin goes through
 * {@link readPersistedSession} so the handle is always released, even when
 * the read throws.
 *
 * {@link sessionEventWindow} is the same source, shaped the way the /sidebar
 * routes serve it (live snapshot first, persisted log as the cold fallback).
 */
import type { Context, SidebarSessionEvent, SidebarSessionPersistenceService } from './context-types.ts'
import { requireString, SidebarError } from './wire.ts'

/** One persisted session as this plugin reads it. */
export interface PersistedSession {
  /** Immutable stored header (cwd / agentPreset live here). */
  readonly header: { cwd?: string; agentPreset?: string } & Record<string, unknown>
  /** The full stored event log. */
  readonly events: readonly SidebarSessionEvent[]
  /** Exact fork-inherited prefix length (0 when the header is not seeded). */
  readonly inheritedEventCount: number
}

/**
 * Read one persisted session's header and full event log.
 * @param persistence - the live `sessionPersistence` service.
 * @param sessionId - the stored session to read.
 * @returns the header and log; rejects when the session does not exist.
 */
export async function readPersistedSession(
  persistence: SidebarSessionPersistenceService,
  sessionId: string,
): Promise<PersistedSession> {
  const handle = await persistence.open(sessionId, 'read')
  try {
    const { events } = await handle.read()
    return {
      header: handle.header,
      events,
      inheritedEventCount: handle.inheritedEventCount ?? 0,
    }
  } finally {
    await handle.close()
  }
}

/**
 * Resolve the service and read one persisted session, or `undefined` when
 * the service is absent or the session cannot be read.
 * @param ctx - host plugin context.
 * @param sessionId - the stored session to read.
 * @returns the persisted session, or `undefined`.
 */
export async function readPersistedSessionOf(
  ctx: Context,
  sessionId: string,
): Promise<PersistedSession | undefined> {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return undefined
  try {
    return await readPersistedSession(persistence, sessionId)
  } catch {
    return undefined
  }
}

/**
 * One session's event window as the /sidebar routes serve it.
 *
 * Every session-backed route shares this shape: the CLIENT runtime's sessions
 * face has no event-log access, so the log crosses the wire here — the live
 * store's snapshot first, the persisted logical log as the cold fallback, and
 * an empty window (never an error) when neither is available. `take` then
 * applies the route's own row predicate and cap, because what counts as a row
 * differs per route — and a route that pairs rows by call id has to see the
 * WHOLE log before it can decide which rows to ship.
 *
 * `extraRows` merges rows a route mirrored off the live append feed: after a
 * host restart the store session's in-memory log freezes at its rehydration
 * boundary (jobs-routes records the same hazard), so the bare snapshot would
 * serve a stale window forever.
 *
 * @param ctx - host plugin context.
 * @param payload - the route payload carrying `sessionId` + optional `afterSeq`.
 * @param take - given the session's full merged log (oldest first) and the
 *   resolved cursor, the rows to ship.
 * @param extraRows - live-mirrored rows for one session id, when the route has them.
 * @returns the window plus the newest shipped seq (the caller's next cursor).
 */
export async function sessionEventWindow(
  ctx: Context,
  payload: unknown,
  take: (log: readonly SidebarSessionEvent[], afterSeq: number) => readonly SidebarSessionEvent[],
  extraRows?: (sessionId: string) => readonly SidebarSessionEvent[],
): Promise<{ events: readonly SidebarSessionEvent[]; lastSeq: number }> {
  const sessionId = requireString(payload, 'sessionId')
  const rawAfter = (payload as { afterSeq?: unknown } | null)?.afterSeq
  if (rawAfter !== undefined
    && (typeof rawAfter !== 'number' || !Number.isSafeInteger(rawAfter) || rawAfter < 0)) {
    throw new SidebarError('bad-request', 'afterSeq must be a non-negative integer')
  }
  // An absent cursor means "from the very first event": a session whose log
  // opens on a tool event carries seq 0, which a literal `> 0` comparison
  // would drop, so the absent case floors at -1.
  const afterSeq = rawAfter ?? -1
  const live = ctx.sessions.get(sessionId)?.snapshotEvents()
  const base = live ?? (await readPersistedSessionOf(ctx, sessionId))?.events ?? []
  // Deduped by seq (the mirror overlaps the snapshot wherever the store IS
  // current). Routes without a mirror — the common case — skip the merge.
  const extra = extraRows?.(sessionId) ?? []
  let log: readonly SidebarSessionEvent[] = base
  if (extra.length > 0) {
    const rows = new Map<number, SidebarSessionEvent>()
    for (const event of base) rows.set(event.seq, event)
    for (const event of extra) rows.set(event.seq, event)
    log = [...rows.values()].sort((left, right) => left.seq - right.seq)
  }
  const shipped = take(log, afterSeq)
  // An empty window answers with a cursor the caller can reuse: `afterSeq` is
  // floored at 0 so a first poll of a session with no plan rows leaves the
  // client at 0 rather than at the -1 sentinel.
  return { events: shipped, lastSeq: shipped.at(-1)?.seq ?? Math.max(afterSeq, 0) }
}
