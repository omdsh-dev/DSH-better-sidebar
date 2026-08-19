/**
 * Interception of the chat's file-open funnel. The client runtime's
 * `ctx.workspaces.openPath` is the SINGLE door every chat-side file open goes
 * through — ui-conversation's apply.ts resolves the path against the session
 * cwd and calls it for tool-row path links, the produced-files row, and
 * prose file mentions alike (verified against the DSH source:
 * `packages/client/ui-conversation/src/client/apply.ts` is the only
 * production caller). Wrapping that one method reroutes those opens into the
 * sidebar editor instead of the Host OS — no DSH modification needed.
 *
 * The wrapper is dependency-free by design (no React / ui-primitives), so
 * the takeover logic is unit-testable and the file stays importable from the
 * test runtime.
 */

/** The one service method the wrapper replaces (mirror of the runtime IWorkspaces). */
export interface OpenPathService {
  openPath(path: string): Promise<void>
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
}

/**
 * The pre-wrap host openPath while the interception is active (undefined
 * otherwise). Opening a path through THIS reference reaches the Host OS's
 * default application — the wrapped `workspaces.openPath` would route the
 * open back into the sidebar editor instead.
 */
let rawOpenPath: ((path: string) => Promise<void>) | undefined

/**
 * Wrap `workspaces.openPath`: intercepted calls open the file in the sidebar
 * editor instead of the Host OS and resolve as success (the original's
 * callers ignore the result); anything that declines falls through to the
 * original method untouched.
 * @param workspaces - the client workspaces service to wrap.
 * @param deps - per-call takeover decisions.
 * @returns the disposer restoring the original method (HMR-safe).
 */
export function wrapOpenPath(workspaces: OpenPathService, deps: OpenPathInterceptDeps): () => void {
  // The RAW method reference (never a bound copy): restore must put back the
  // exact original so a chain of wrappers (other plugins wrapping the same
  // method) keeps working across disposals in any order.
  const original = workspaces.openPath
  // The context menus' "open with the default app" bypasses the sidebar
  // takeover: keep the pre-wrap call reachable while this wrap is active.
  const bypass: (path: string) => Promise<void> = (path) => original.call(workspaces, path)
  rawOpenPath = bypass
  workspaces.openPath = (path: string): Promise<void> => {
    if (deps.takeoverEnabled()) {
      const sessionId = deps.currentSessionId()
      if (sessionId !== undefined) {
        deps.openInSidebar(path, sessionId)
        return Promise.resolve()
      }
    }
    return original.call(workspaces, path)
  }
  return () => {
    if (rawOpenPath === bypass) rawOpenPath = undefined
    workspaces.openPath = original
  }
}

/**
 * Open a path with the Host OS's default application, BYPASSING the sidebar
 * open-path interception. This is the context menus' "open with the default
 * app" action.
 *
 * `fallback` runs when the raw reference is unavailable — only possible when
 * the interception was never registered, in which case `workspaces.openPath`
 * IS still the raw method. Failures log a warning and never throw.
 */
export function openPathWithSystem(path: string, fallback?: (path: string) => Promise<void>): void {
  const open = rawOpenPath ?? fallback
  if (open === undefined) {
    console.warn('[dsh-better-sidebar] cannot open with the default app: no host openPath available')
    return
  }
  void open(path).catch((error: unknown) => {
    console.warn('[dsh-better-sidebar] open with default app failed:', error)
  })
}
