/**
 * Where the plugin reads "which conversation is on screen".
 *
 * DSH 0.1.5 exposed it as `ctx.sessions.list.getSnapshot().current`. DSH 0.1.6
 * dropped that field from the client list snapshot (the store now projects only
 * `ids / byId / phase / subagentsByParent / jobsBySession`), so reading it
 * yields `undefined` forever — and every session-scoped flow in the plugin
 * starts with that id, which is why the whole layer went quiet without a single
 * error: `store.setSession(undefined)`, the auto-open effects' first guard, the
 * native surface's on-screen test.
 *
 * The live selection moved to the workspace service (`uiWorkspace`): the open
 * conversation is `mainReference.sessionId`, and the persisted one is the
 * `selection` store's `sessionId` (localStorage key `dsh.sessions.current`).
 * Both are probed structurally and defensively — `ctx.get` is this repo's
 * existing soft lookup (see the `jobs` / `remote` / `sessionPersistence` calls
 * elsewhere), and a host that only knows the old field keeps working because it
 * is read first.
 */
import type { Context } from '../context-types.ts'

/** One frame of the workspace selection store the plugin reads. */
export interface WorkspaceSelection {
  sessionId?: string | undefined
  subagentAddress?: unknown
}

/** The slice of `ctx.uiWorkspace` this plugin needs (a structural probe). */
interface WorkspaceFace {
  mainReference?: { sessionId?: string | undefined } | undefined
  selection?: {
    getSnapshot?: () => WorkspaceSelection | undefined
    subscribe?: (listener: () => void) => () => void
  } | undefined
}

/** Stable empty snapshot: `useSyncExternalStore` needs a cached reference. */
export const EMPTY_WORKSPACE_SELECTION: WorkspaceSelection = {}

/** The workspace service, when this host has one. */
export function workspaceFace(ctx: Context): WorkspaceFace | undefined {
  try {
    return ctx.get('uiWorkspace') as unknown as WorkspaceFace | undefined
  } catch {
    return undefined
  }
}

/** The selection store's snapshot, or a stable empty one. */
export function workspaceSelection(ctx: Context): WorkspaceSelection {
  const selection = workspaceFace(ctx)?.selection
  return selection?.getSnapshot?.() ?? EMPTY_WORKSPACE_SELECTION
}

/**
 * The active session id.
 *
 * The legacy list field wins when present (DSH 0.1.5, and any host that still
 * projects it); otherwise the workspace service answers. `undefined` means
 * "no conversation is open", which each caller already handles.
 */
export function activeSessionId(ctx: Context): string | undefined {
  try {
    const legacy = (ctx.sessions.list.getSnapshot() as { current?: string | undefined }).current
    if (legacy !== undefined) return legacy
  } catch {}
  const workspace = workspaceFace(ctx)
  return workspace?.mainReference?.sessionId ?? workspace?.selection?.getSnapshot?.()?.sessionId
}
