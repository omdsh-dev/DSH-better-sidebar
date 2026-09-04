/**
 * Interception of the chat's file-open funnel (DSH 0.1.2-alpha hosts).
 *
 * The alpha funnel is the Typert remote namespace `remote.session`: every
 * chat-side file open (tool-row path links, the produced-files row, prose
 * file mentions, inline-code paths) funnels through ChatView's injected
 * `openFile`, which calls `ctx.remote.session.openWorkspacePath({ path })`
 * with the path ALREADY resolved against the session cwd (verified against
 * the DSH source: `packages/client/ui-chat/src/client/apply.ts` is the only
 * production caller). The host side (`api/session-controller`) hands the
 * path to the OS's default application (`openNativePath` → xdg-open on
 * Linux). The pre-alpha funnel `ctx.workspaces.openPath` is gone — the
 * alpha `IWorkspaces` has no openPath at all.
 *
 * `remote.session` is a cordis service (the gateway client's
 * RemoteNamespaceService, key `remote.session`) whose methods are installed
 * as ACCESSOR properties (`Object.defineProperty(service, method, {
 * configurable: true, get })`) — the getter reads the method table at
 * ACCESS time and returns the invocation closure. A plain assignment would
 * not stick (no setter), so the wrapper shadows the method with a data
 * property and restores the captured accessor descriptor on dispose.
 *
 * The namespace service appears asynchronously (the session-controller
 * contribution mounts after the connection is up) and is disposed/recreated
 * on contribution remounts; the caller therefore enters through
 * `ctx.inject(['remote.session'], …)`, which re-fires on every remount.
 *
 * The wrapper is dependency-free by design (no React / ui-primitives), so
 * the takeover logic is unit-testable and the file stays importable from
 * the test runtime.
 */

/** The one request shape the funnel method takes (mirror of the host's
 *  SessionOpenWorkspacePathRequest). */
export interface OpenWorkspacePathRequest {
  /** Absolute path (the chat caller already resolved it against the cwd). */
  path: string
}

/**
 * What the funnel method resolves to (mirror of the typert `RemoteResult`
 * envelope): EVERY remote method folds its business value into
 * `{ ok: true, value }` / `{ ok: false, error }` — the chat caller branches
 * on `result.ok`, so a bare business value would be misread as a failure
 * (`result.error.message` reads `message` off undefined).
 */
export type OpenWorkspacePathResult =
  | { readonly ok: true; readonly value: { opened: boolean } }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: object } }

/** The namespace slice the wrapper shadows (mirror of the gateway client's
 *  RemoteNamespaceService for the `session` namespace). */
export interface OpenWorkspacePathService {
  openWorkspacePath(request: OpenWorkspacePathRequest, signal?: AbortSignal): Promise<OpenWorkspacePathResult>
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
 * Shadow `remote.session.openWorkspacePath`: intercepted calls open the file
 * in the sidebar editor and resolve with the remote SUCCESS ENVELOPE
 * (`{ ok: true, value: { opened: true } }`, so ChatView shows no error
 * dialog); anything that declines falls through to the captured original
 * closure (the host OS's default application) untouched.
 * The one exception is the folder-reveal gesture, which is routed to
 * {@link OpenPathInterceptDeps.revealInExplorer} instead.
 *
 * The original closure is captured by ACCESSING the accessor once at wrap
 * time — it invokes whatever method records are mounted at that moment. If
 * the contribution remounts its methods while the shadow is installed, the
 * captured closure points at the old records; the session namespace is
 * effectively permanent in practice, so this is accepted and the shadow is
 * re-applied anyway when the remount recreates the service (the caller's
 * `ctx.inject` re-fires).
 *
 * @param service - the `remote.session` namespace service.
 * @param deps - per-call takeover decisions.
 * @returns the disposer restoring the original accessor descriptor (HMR-safe).
 */
export function wrapOpenWorkspacePath(
  service: OpenWorkspacePathService,
  deps: OpenPathInterceptDeps,
): () => void {
  const KEY = 'openWorkspacePath'
  const target = service as object
  const descriptor = Object.getOwnPropertyDescriptor(target, KEY)
  // Invoke the accessor once to capture the CURRENT invocation closure.
  const original = service.openWorkspacePath
  // The gateway installs the namespace's whole method group in the same
  // synchronous window as the service registration, so an inject-observed
  // service always has the method — but a hand-rolled composition might not;
  // wrapping nothing would turn fall-throughs into crashes, so decline.
  if (typeof original !== 'function') return () => {}
  const wrapped = (request: OpenWorkspacePathRequest, signal?: AbortSignal): Promise<OpenWorkspacePathResult> => {
    if (deps.takeoverEnabled()) {
      const sessionId = deps.currentSessionId()
      if (sessionId !== undefined) {
        if (isFolderRevealPath(request.path)) deps.revealInExplorer(request.path, sessionId)
        else deps.openInSidebar(request.path, sessionId)
        return Promise.resolve({ ok: true, value: { opened: true } })
      }
    }
    return original.call(service, request, signal)
  }
  Object.defineProperty(target, KEY, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: wrapped,
  })
  return () => {
    // Restore the exact original property (the gateway's accessor) so a
    // chain of wrappers keeps working across disposals in any order.
    if (descriptor !== undefined) Object.defineProperty(target, KEY, descriptor)
    else Reflect.deleteProperty(target, KEY)
  }
}
