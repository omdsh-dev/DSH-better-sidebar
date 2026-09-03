/**
 * Optional client bridge to the '@michengai/dsh-archive-manager' plugin.
 *
 * The sidebar itself has no session-deletion service, so the Subagent page
 * delegates its right-click delete to archive-manager's mounted
 * remote.workspaceRegistry service. The plugin owns the permanent-delete
 * pipeline (live-session quiescence, workspace accounts, projection cache,
 * spill and transcript directory cleanup, child-agent cascade), so
 * better-sidebar does not duplicate it or touch DSH session files itself.
 *
 * The bridge resolves the service through ctx.get, exactly like the
 * archive-manager client does; it never value-imports the other plugin.
 */

import type { Context } from '../context-types.ts'

/** Structural mirror of the remote method this bridge calls. */
interface ArchiveDeleteRegistry {
  deleteSession(sessionId: string): Promise<{ ok: boolean; error?: { message?: string } }>
}

/** Resolve the optional mounted remote service without assuming every test
 *  composition carries a full Cordis `get`. */
function resolveRegistry(ctx: Context): ArchiveDeleteRegistry | undefined {
  const getter = (ctx as Context & { get?: (id: string) => unknown }).get
  return getter?.('remote.workspaceRegistry') as ArchiveDeleteRegistry | undefined
}

/** True once archive-manager has mounted its remote workspaceRegistry. */
export function archiveDeleteAvailable(ctx: Context): boolean {
  return resolveRegistry(ctx) !== undefined
}

/** Permanently delete one session (and its subagent children) through archive-manager. */
export async function deleteSessionViaArchiveManager(ctx: Context, sessionId: string): Promise<void> {
  const registry = resolveRegistry(ctx)
  if (registry === undefined) {
    throw new Error('archive-manager remote service is unavailable')
  }
  const result = await registry.deleteSession(sessionId)
  if (!result.ok) {
    throw new Error(result.error?.message ?? 'archive-manager could not delete the session')
  }
}
