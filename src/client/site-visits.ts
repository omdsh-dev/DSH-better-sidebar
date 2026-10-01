/** Browser-local visit history, shared between site windows on the same origin. */
export const VISIT_PREFIX = 'tracy:site-visited:v1:'
export const VISITS_CHANGED = 'tracy:site-visits-changed'

/** The named mount owns this window's workspace, never the shared last-site cookie. */
export function workspaceSiteKey(): string | undefined {
  return /^\/([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+)(?:\/|$)/.exec(window.location.pathname)?.[1]
}

export function lastVisit(siteKey: string): number {
  try {
    const value = Number(localStorage.getItem(VISIT_PREFIX + siteKey))
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch { return 0 }
}

/** Lives with the plugin, including workspaces showing only Settings, Team or History. */
export function registerSiteVisits(): () => void {
  const record = () => {
    const siteKey = workspaceSiteKey()
    if (!siteKey || document.visibilityState === 'hidden') return
    try { localStorage.setItem(VISIT_PREFIX + siteKey, String(Date.now())) } catch { /* Storage may be disabled. */ }
    window.dispatchEvent(new Event(VISITS_CHANGED))
  }
  record()
  window.addEventListener('focus', record)
  window.addEventListener('popstate', record)
  document.addEventListener('visibilitychange', record)
  return () => {
    window.removeEventListener('focus', record)
    window.removeEventListener('popstate', record)
    document.removeEventListener('visibilitychange', record)
  }
}
