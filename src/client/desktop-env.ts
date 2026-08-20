/**
 * Desktop-shell detection for the sidebar. The official DSH Desktop shell
 * (Electron) stamps every render URL with `dsh-desktop-mode` and
 * `dsh-desktop-platform` and exposes `window.__DSH_DESKTOP_FILE_PATH__`
 * through its preload; community Tauri shells keep the native system frame
 * (no stamps — plain-browser semantics). Parsed once per page and memoized
 * (the URL never changes mid-session); `resetDesktopEnvForTests` clears the
 * memo for unit tests.
 *
 * Geometry facts the sidebar adapts to (from the Electron runtime):
 * - win32 `advanced` mode draws the window controls in a 32px overlay strip
 *   at the top-right of the web content (`titleBarOverlay: { height: 32 }`)
 *   — exactly where the toggle cluster sits, so it must drop below the
 *   strip and the right panel's content must clear it.
 * - darwin `advanced` mode keeps the traffic lights at (16,16) in the
 *   top-left; nothing on the plugin's side touches that corner today, but
 *   the platform is still reported so left-edge controls can avoid it.
 * - `compatibility` mode keeps the native frame — no adaptation needed.
 */
export interface DesktopEnv {
  /** Running inside a desktop shell (any URL stamp or preload marker). */
  readonly desktop: boolean
  /** `advanced` = frameless/custom-titlebar shell; `compatibility` = native frame. */
  readonly mode: 'compatibility' | 'advanced' | null
  /** Shell platform stamp ('darwin' | 'win32' | …), lowercased, or null. */
  readonly platform: string | null
  /** Pixels the win32 advanced shell reserves at the top-right for window
   *  controls (0 elsewhere). */
  readonly win32OverlayTop: number
}

let cached: DesktopEnv | undefined

/** Read the shell's desktop stamps (memoized per page). */
export function parseDesktopEnv(): DesktopEnv {
  if (cached !== undefined) return cached
  // location.search includes the leading '?', which URLSearchParams does NOT
  // strip (it would become part of the first key) — drop it explicitly.
  const params = new URLSearchParams(window.location.search.replace(/^\?/, ''))
  const modeParam = params.get('dsh-desktop-mode')
  const mode = modeParam === 'compatibility' || modeParam === 'advanced' ? modeParam : null
  const platformParam = params.get('dsh-desktop-platform')
  const platform = platformParam !== null && platformParam !== '' ? platformParam.toLowerCase() : null
  const desktop = mode !== null
    || typeof (window as { __DSH_DESKTOP_FILE_PATH__?: unknown }).__DSH_DESKTOP_FILE_PATH__ !== 'undefined'
  cached = {
    desktop,
    mode,
    platform,
    win32OverlayTop: desktop && mode === 'advanced' && platform === 'win32' ? 32 : 0,
  }
  return cached
}

/** Test hook: drop the memo so the next parse re-reads the URL/globals. */
export function resetDesktopEnvForTests(): void {
  cached = undefined
}
