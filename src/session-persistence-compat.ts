/**
 * Session-persistence compatibility across the DSH persistence seam.
 *
 * DSH 0.1.3 replaced the twelve-method inspection service with a handle-based
 * seam: `open(id, 'read')` returns a `SessionHandle` whose `header` carries the
 * immutable stored metadata and whose `read()` returns the logical event
 * slice; `close()` releases it. The old `inspect(id)` method is gone, so a
 * cold read must go through the handle when it is available and only fall back
 * to `inspect` on older runtimes.
 *
 * Both halves share this module; it never imports a host package, so the
 * browser bundle stays free of runtime `@deepseek-ai/*` symbols.
 *
 * @module
 */
import type { SidebarSessionEvent, SidebarSessionPersistenceService } from './context-types.ts'

/** One persisted session read: the stored metadata plus its logical events. */
export interface PersistedSessionView {
  readonly meta: { cwd?: string; agentPreset?: string }
  readonly events: readonly SidebarSessionEvent[]
}

/**
 * Read one persisted session through whichever seam the running DSH exposes.
 *
 * The handle path (0.1.3+) always closes its handle, including when `read()`
 * rejects, so a failed cold read never leaks read ownership.
 *
 * @param persistence - the host `sessionPersistence` service.
 * @param sessionId - the stored session to read.
 * @returns the stored metadata and logical events.
 * @throws when the session is unknown/gone or the service exposes no seam.
 */
export async function readPersistedSession(
  persistence: SidebarSessionPersistenceService,
  sessionId: string,
): Promise<PersistedSessionView> {
  if (typeof persistence.open === 'function') {
    const handle = await persistence.open(sessionId, 'read')
    try {
      const result = await handle.read()
      return { meta: handle.header ?? {}, events: result.events }
    } finally {
      await handle.close()
    }
  }
  if (typeof persistence.inspect === 'function') {
    return await persistence.inspect(sessionId)
  }
  throw new Error('the session persistence service exposes neither open() nor inspect()')
}
