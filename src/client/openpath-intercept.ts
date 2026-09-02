/**
 * Interception of the chat's file-open funnel. On DSH 0.1.2-alpha.x the
 * SINGLE door every chat-side file open goes through is
 * `ctx.remote.session.openWorkspacePath` — ui-chat's apply.ts resolves the
 * path against the session cwd and calls it for tool-row path links, the
 * produced-files row, and prose file mentions alike (verified against the
 * DSH source: `packages/client/ui-chat/src/client/apply.ts` is the only
 * production caller). Wrapping that one method reroutes those opens into the
 * sidebar editor instead of the Host OS — no DSH modification needed.
 *
 * The older `ctx.workspaces.openPath` funnel this wrapper used to target
 * never existed on the WorkspaceController (create/rename/delete/archive
 * only) and is not called by ui-chat, so wrapping it is a no-op on alpha.2
 * and alpha.3.
 *
 * The wrapper is dependency-free by design (no React / ui-primitives), so
 * the takeover logic is unit-testable and the file stays importable from the
 * test runtime.
 */

/** The request shape ui-chat passes to `session.openWorkspacePath`. */
export interface OpenWorkspacePathRequest {
  /** Absolute (or already-resolved) filesystem path to open. */
  path: string
}

/** The Remote-result envelope ui-chat inspects (`result.ok` / `result.error`). */
export interface OpenWorkspacePathResult {
  /** Whether the Host opener accepted the path. */
  ok: boolean
  /** Present on success. */
  value?: { opened: true }
  /** Present on failure; ui-chat throws `path open failed: ${error.message}`. */
  error?: { message: string }
}

/** The one service method the wrapper replaces (mirror of the Remote session face). */
export interface OpenWorkspacePathService {
  openWorkspacePath(request: OpenWorkspacePathRequest): Promise<OpenWorkspacePathResult>
}

/** Per-call decisions the wrapper needs (wired to the store + ctx in the client half). */
export interface OpenPathInterceptDeps {
  /**
   * Whether to take over this call: the `interceptOpenPath` pref AND the
   * editor tab's own enable switch must both be on (an editor that cannot
   * open must not swallow opens — they fall through to the Host).
   */
  takeoverEnabled(): boolean
  /** The session whose scope the sidebar editor loads the file in (current session). */
  currentSessionId(): string | undefined
  /** Route the open into the sidebar editor (the established openSidebarFile). */
  openInSidebar(path: string, sessionId: string): void
  /** Route a folder-reveal gesture ("Show in folder" passes '.') into the sidebar explorer. */
  revealInExplorer(path: string, sessionId: string): void
}

/**
 * Whether a path is the "Show in folder" folder-reveal gesture. The stock
 * ui-deliverables row passes `'.'` (the session workspace root, resolved by
 * the chat view to `"<cwd>/."`); any path whose final segment is `.` is the
 * same gesture. A directory has no editor content, so these opens must reach
 * the explorer instead of an editor tab.
 */
export function isFolderRevealPath(path: string): boolean {
  if (path === '.' || path === './') return true
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed === '.' || /[\\/]\.$/.test(trimmed)
}

/**
 * Wrap `session.openWorkspacePath`: intercepted calls open the file in the
 * sidebar editor instead of the Host OS and resolve as a successful Remote
 * result (the original's callers only check `result.ok`); anything that
 * declines falls through to the original method untouched. The one exception
 * is the folder-reveal gesture, which is routed to
 * {@link OpenPathInterceptDeps.revealInExplorer} instead.
 * @param session - the Remote session face to wrap.
 * @param deps - per-call takeover decisions.
 * @returns the disposer restoring the original method (HMR-safe).
 */
export function wrapOpenWorkspacePath(
  session: OpenWorkspacePathService,
  deps: OpenPathInterceptDeps,
): () => void {
  // The RAW method reference (never a bound copy): restore must put back the
  // exact original so a chain of wrappers (other plugins wrapping the same
  // method) keeps working across disposals in any order.
  const original = session.openWorkspacePath
  session.openWorkspacePath = (request: OpenWorkspacePathRequest): Promise<OpenWorkspacePathResult> => {
    if (deps.takeoverEnabled()) {
      const sessionId = deps.currentSessionId()
      if (sessionId !== undefined) {
        const path = request.path
        if (isFolderRevealPath(path)) deps.revealInExplorer(path, sessionId)
        else deps.openInSidebar(path, sessionId)
        return Promise.resolve({ ok: true, value: { opened: true } })
      }
    }
    return original.call(session, request)
  }
  return () => {
    session.openWorkspacePath = original
  }
}
