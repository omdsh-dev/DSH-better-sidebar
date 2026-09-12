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
 */
import type { Context, SidebarSessionEvent, SidebarSessionPersistenceService } from './context-types.ts'

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
