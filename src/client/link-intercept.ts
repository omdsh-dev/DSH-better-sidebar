/**
 * External-link interception: clicking an http(s) link that a REGISTERED tab
 * type CLAIMS through `urlTarget` opens that type in the sidebar. Everything
 * else is left alone — the plugin never `preventDefault`s a link it cannot
 * serve, because the destination of a chat link is not the plugin's call:
 * since DSH 0.1.7 the host's `ui-chat` `openExternalLink` applies the user's
 * `linkOpening` setting and the host's own browser tab (a kind the Web
 * profile disables), and inside plugin-drawn markdown (sidechat
 * transcripts, editor previews, HTML previews, diff panes) the anchor's own
 * default (`window.open`) applies.
 *
 * A Ctrl/Cmd/Shift/Alt-modified click always bypasses the takeover so the
 * user can still force a real browser tab.
 *
 * Only the GUI's OWN document is watched — links inside a sandboxed iframe
 * live in another document and never bubble here (and their clicks must keep
 * working inside the sidebar).
 */

/** `new URL(value)`, or null for an unparsable href. */
function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/** The pure decision: the URL a click may hand to the sidebar, or null to let
 *  the click fall through. Extracted so the policy is unit-testable without a
 *  DOM. `anchorHref` must be the ABSOLUTE href (`<a>.href` already is).
 *  The protocol/same-origin policy lives HERE; whether some enabled tab type
 *  actually claims the URL is the caller's `takeoverEnabled` callback. */
export function shouldInterceptLink(anchorHref: string, selfOrigin: string): string | null {
  const url = parseUrl(anchorHref)
  if (url === null) return null
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  // Same-origin links are GUI-internal navigation (settings pages, tool
  // docs) — never routed into the sidebar.
  try {
    if (url.origin === new URL(selfOrigin).origin) return null
  } catch {
    // Unparsable selfOrigin (never in practice): intercept defensively.
  }
  return url.href
}

/** Whether a left-click may be taken over (unmodified left click only). */
export function isPlainLeftClick(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
}

/**
 * The caller-side gate: take a link over only when the sidebar is not
 * suspended AND some enabled tab type claims the URL. An unclaimed link is
 * the host's to route (its `openExternalLink` / the anchor's own default).
 */
export function shouldTakeOverLink(url: URL, opts: {
  /** Another panel provider owns the right column — the sidebar must not act. */
  suspended: boolean
  /** The tab type claiming this URL through `urlTarget` (enabled tabs only). */
  resolveTarget: (url: URL) => string | undefined
}): boolean {
  if (opts.suspended) return false
  return opts.resolveTarget(url) !== undefined
}

/**
 * Whether a claimed type is still on offer at OPEN time: registered in the
 * tab registry AND not switched off in the settings. The claim (gate) and the
 * open are two separate turns of the event loop, so the type may disappear in
 * between — a plugin unloaded, the user disabled it, the registry reset.
 */
export function isTargetAvailable(
  type: string,
  tabs: readonly { id: string }[],
  tabsEnabled: Record<string, boolean>,
): boolean {
  return tabs.some(tab => tab.id === type && tabsEnabled[tab.id] !== false)
}

/**
 * Open an intercepted link: the sidebar tab when the claimed type is still
 * available, a real browser tab otherwise. The fallback is not decoration —
 * the plugin's own `openTab` silently ignores an unknown / disabled type
 * (service.ts returns early), so without it a taken-over click would do
 * nothing at all. Returns the path taken (tests assert the fallback).
 */
export function openInterceptedLink(url: string, deps: {
  /** The tab type claiming this URL through `urlTarget` (enabled tabs only). */
  resolveTarget: (url: URL) => string | undefined
  /** Whether that type is still registered and enabled ({@link isTargetAvailable}). */
  isAvailable: (type: string) => boolean
  /** The plugin's own tab service (`ctx.get('betterSidebar')`), when attached. */
  sidebar: { openTab: (seed: { type: string; url: string; title?: string }) => void } | undefined
}): 'sidebar' | 'window' {
  const parsed = parseUrl(url)
  const type = parsed === null ? undefined : deps.resolveTarget(parsed)
  if (parsed !== null && type !== undefined && deps.sidebar !== undefined && deps.isAvailable(type)) {
    deps.sidebar.openTab({ type, url, title: parsed.hostname })
    return 'sidebar'
  }
  // Nothing in the sidebar can serve this URL (unclaimed, the type is gone or
  // switched off, or the plugin's service is detached): hand it to the real
  // browser so the click is never a silent no-op. A click IS the user
  // gesture, so the popup blocker lets this through.
  window.open(url, '_blank', 'noopener,noreferrer')
  return 'window'
}

/**
 * Register the document-level click capture that funnels CLAIMED external
 * links into the sidebar. Returns the disposer (HMR-safe).
 */
export function registerLinkInterception(opts: {
  /** Whether the takeover may happen for THIS url (the caller's gate —
   *  {@link shouldTakeOverLink}: not suspended and claimed by an enabled
   *  tab type). */
  takeoverEnabled: (url: URL) => boolean
  /** Open the URL — the caller resolves the claimed type and falls back to a
   *  real browser tab when it is gone ({@link openInterceptedLink}). */
  openInSidebar: (url: string) => void
  /** The GUI's own origin (window.location.origin at registration). */
  selfOrigin: string
}): () => void {
  const onClick = (event: MouseEvent): void => {
    if (!isPlainLeftClick(event)) return
    if (event.defaultPrevented) return
    const target = event.target
    if (target === null || typeof (target as Element).closest !== 'function') return
    const anchor = (target as Element).closest('a[href]') as HTMLAnchorElement | null
    if (anchor === null) return
    const url = shouldInterceptLink(anchor.href, opts.selfOrigin)
    if (url === null) return
    if (!opts.takeoverEnabled(new URL(url))) return
    event.preventDefault()
    opts.openInSidebar(url)
  }
  document.addEventListener('click', onClick, true)
  return () => { document.removeEventListener('click', onClick, true) }
}
