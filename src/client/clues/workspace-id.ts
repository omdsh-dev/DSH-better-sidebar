/**
 * Workspace identity for the clue surfaces (S9 glue).
 *
 * Every clue call is addressed by the STABLE host workspace id — never by a
 * session id, a cwd or a tab body. The browser's workspace list is the primary
 * source: on DSH 0.2.1 its `WorkspaceView` carries `workspaceId` beside the
 * path it exposes here. Older/trimmed shells expose only path + session
 * membership, so the host answers the same question through the read-only
 * `clues.workspaceForSession` method (registered by `src/clues/install-stack.ts`
 * and resolved with the host's own `workspaceRegistry.resolveByPath`, never a
 * client-side cwd guess).
 *
 * A missing workspace is a first-class answer: the caller renders an explicit
 * empty state and refuses to persist anything under a guessed id.
 */
import { call } from '../api.ts'
import type { Context } from '../../context-types.ts'

/** The workspace-list item subset this module reads (rc.1 view + optional id). */
interface WorkspaceListSnapshot {
  readonly phase: 'pending' | 'ready'
  readonly state: 'idle' | 'loading' | 'error'
  readonly items: readonly {
    readonly path: string
    readonly sessionIds: readonly string[]
    /** Present on the host 0.2.1 WorkspaceView; absent on older client faces. */
    readonly workspaceId?: string
  }[]
}

/** The client workspaces face (structural; the host may not provide it). */
interface WorkspacesFace {
  readonly list: { getSnapshot(): WorkspaceListSnapshot }
}

/** Result of the host fallback (`CLUES_WORKSPACE_FOR_SESSION_API`). */
interface WorkspaceForSessionResult {
  readonly workspaceId?: string | null
}

/** Read the workspaces face without assuming the deployment. */
function workspacesOf(ctx: Context): WorkspacesFace | undefined {
  try {
    const face = ctx.get('workspaces') as WorkspacesFace | undefined
    return face !== null && typeof face === 'object' ? face : undefined
  } catch {
    return undefined
  }
}

/**
 * The workspace id of one session from the browser's own workspace list.
 * @param ctx - the client plugin context.
 * @param sessionId - the session whose workspace is wanted.
 * @returns the stable id, or undefined when the list is not ready or the item
 *  carries no id (call {@link resolveWorkspaceIdForSession} for the fallback).
 */
export function workspaceIdOfSession(ctx: Context, sessionId: string): string | undefined {
  if (sessionId === '') return undefined
  const snapshot = workspacesOf(ctx)?.list.getSnapshot()
  if (snapshot === undefined || snapshot.phase !== 'ready') return undefined
  const item = snapshot.items.find(candidate => candidate.sessionIds.includes(sessionId))
  const id = item?.workspaceId
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * Resolve one session's workspace id, asking the host when the browser list
 * does not carry ids.
 * @param ctx - the client plugin context.
 * @param sessionId - the session whose workspace is wanted.
 * @param signal - optional cancellation of the host round trip.
 * @returns the stable workspace id, or undefined when the session has none.
 */
export async function resolveWorkspaceIdForSession(
  ctx: Context,
  sessionId: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const local = workspaceIdOfSession(ctx, sessionId)
  if (local !== undefined) return local
  if (sessionId === '') return undefined
  try {
    const result = await call<WorkspaceForSessionResult>('clues.workspaceForSession', { sessionId }, signal)
    const id = result?.workspaceId
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    // A host without the lookup, a removed workspace or a network failure all
    // answer "no workspace": the tab shows the explicit empty state.
    return undefined
  }
}

/** One workspace the clue surfaces may browse (id + display title). */
export interface ClueWorkspaceChoice {
  readonly workspaceId: string
  readonly title: string
}

/**
 * Every workspace the clue surfaces can browse, for explicit switching and for
 * the pack-binding picker. Items without an id are skipped: a binding must
 * address a stable workspace, never a path.
 * @param ctx - the client plugin context.
 */
export function listClueWorkspaces(ctx: Context): readonly ClueWorkspaceChoice[] {
  const snapshot = workspacesOf(ctx)?.list.getSnapshot()
  if (snapshot === undefined || snapshot.phase !== 'ready') return []
  const choices: ClueWorkspaceChoice[] = []
  for (const item of snapshot.items) {
    const id = item.workspaceId
    if (typeof id !== 'string' || id === '') continue
    choices.push({ workspaceId: id, title: item.path })
  }
  return choices
}
