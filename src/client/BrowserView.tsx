/**
 * The built-in browser tab: an address bar plus a sandboxed iframe.
 *
 * Security model (see browser.ts and the sandbox tokens below): every iframe
 * is sandboxed without `allow-top-navigation`. Remote pages get an opaque
 * origin. A loopback page gets its own origin only after the user trusts its
 * exact address and port, which local module and fetch pipelines need. The
 * GUI's exact origin never gets that permission. The address bar accepts
 * only http(s). The side card setting "关闭浏览器沙箱" can remove the sandbox
 * for fully trusted sites, so a persistent warning bar renders while it is
 * off.
 *
 * The URL is persisted onto the tab (path/title via the patchTab reducer)
 * so a reload restores the visited page; the back/forward stack only tracks
 * address-bar navigations (in-frame link clicks are cross-origin and
 * invisible — a documented limitation).
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import {
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconLinkOutline14,
  IconRefreshOutline14,
  IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { VscLinkExternal } from 'react-icons/vsc'
import { api } from './api.ts'
import {
  embeddabilityOf,
  isAllowedLoopbackUrl,
  isLoopbackUrl,
  normalizeBrowserUrl,
  type BrowserNavigateResult,
} from './browser.ts'
import { allowLoopbackUrl } from './prefs.ts'
import { patchTab } from './state.ts'
import { SandboxStatusBar } from './SandboxStatusBar.tsx'
import { t } from './locales.ts'
import type { TabComponentProps } from './service.ts'
import css from './sidebar.module.css'

/**
 * The browser iframe sandbox tokens. NO allow-same-origin (opaque origin —
 * no GUI storage/API access), NO allow-top-navigation (a browsed page must
 * not hijack the GUI). allow-forms/allow-popups/allow-downloads/allow-modals
 * keep login flows working; allow-popups-to-escape-sandbox lets OAuth
 * popups open as normal tabs (they are cross-origin to the GUI either way).
 */
export const BROWSER_IFRAME_SANDBOX =
  'allow-scripts allow-forms allow-popups allow-downloads allow-modals allow-popups-to-escape-sandbox'

/** allow-same-origin appended for explicitly allowlisted local addresses. */
const BROWSER_IFRAME_SANDBOX_SAME_ORIGIN =
  `${BROWSER_IFRAME_SANDBOX} allow-same-origin`

/**
 * The sandbox tokens for one URL: allowlisted loopback addresses (local dev
 * servers the user explicitly trusts) additionally get `allow-same-origin`
 * so Vite/module/HMR pipelines that need a real origin work; every other
 * site keeps the opaque-origin sandbox. `allow-same-origin` does NOT give
 * the page access to the GUI — it stays cross-origin to it and to every
 * other site — but it does give it its OWN origin privileges (localStorage,
 * fetch without CORS), so it is only granted for the explicit allowlist.
 *
 * The GUI itself is the one hard exception: even when its own host is
 * allowlisted (a bare-host entry covers every port, so the GUI origin
 * matches), a page at the GUI's exact origin must never get
 * `allow-same-origin` — that would make it same-origin with its parent and
 * hand it the GUI's storage/API (and the ability to shed the sandbox). The
 * GUI keeps the opaque-origin sandbox no matter what the allowlist says.
 */
export function iframeSandboxFor(url: string | undefined, allowedLoopback: string, selfOrigin?: string): string | undefined {
  if (url === undefined) return undefined
  if (selfOrigin !== undefined) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return BROWSER_IFRAME_SANDBOX
    }
    if (parsed.origin === selfOrigin) return BROWSER_IFRAME_SANDBOX
  }
  return isAllowedLoopbackUrl(url, allowedLoopback)
    ? BROWSER_IFRAME_SANDBOX_SAME_ORIGIN
    : BROWSER_IFRAME_SANDBOX
}

export function BrowserView(props: TabComponentProps) {
  const { store, tab } = props
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store])
  const getSnapshot = useCallback(() => store.getSnapshot(), [store])
  const prefs = useSyncExternalStore(subscribe, getSnapshot, getSnapshot).prefs
  const [initialNavigation] = useState<BrowserNavigateResult | undefined>(() => (
    tab.path === undefined
      ? undefined
      : normalizeBrowserUrl(tab.path, window.location.origin, prefs.browserAllowedLoopback)
  ))
  // The current address (initialized from the persisted tab.path so a
  // reload restores the visited page after applying the same policy as the
  // address bar).
  const [url, setUrl] = useState<string | undefined>(
    initialNavigation?.kind === 'ok' ? initialNavigation.url : undefined,
  )
  const [input, setInput] = useState<string>(tab.path ?? '')
  /** Blocked/invalid hint shown under the address bar (null = none). */
  const [message, setMessage] = useState<string | null>(() => {
    if (initialNavigation?.kind === 'invalid') return t('browserInvalid')
    if (initialNavigation?.kind === 'blocked' && initialNavigation.reason === 'scheme') return t('browserBlockedScheme')
    return null
  })
  const [pendingLocal, setPendingLocal] = useState<Extract<BrowserNavigateResult, { reason: 'loopback' }> | null>(
    initialNavigation?.kind === 'blocked' && initialNavigation.reason === 'loopback'
      ? initialNavigation
      : null,
  )
  const [trustingLocal, setTrustingLocal] = useState(false)
  /** Address-bar navigation history (in-frame clicks are not tracked). */
  const [history, setHistory] = useState<string[]>(url !== undefined ? [url] : [])
  const [cursor, setCursor] = useState<number>(url !== undefined ? 0 : -1)
  /** Bumped on reload to remount the iframe (also remounts on sandbox flip). */
  const [reloadKey, setReloadKey] = useState(0)
  /** TEMPORARY sandbox unlock for THIS surface only (never writes the global
   *  side card setting; lasts until the tab unmounts or the user restores). */
  const [localUnlock, setLocalUnlock] = useState(false)
  const noSandbox = prefs.browserNoSandbox === true || localUnlock
  /** A site that refuses to be embedded (X-Frame-Options / frame-ancestors):
   *  the probe verdict shown instead of the blank iframe. */
  const [embedBlocked, setEmbedBlocked] = useState<string | null>(null)
  /** The user asked to load the refused site anyway (keeps the plain iframe). */
  const [forceEmbed, setForceEmbed] = useState(false)

  // Probe every navigation (address bar, history, restored path): when the
  // target forbids embedding, show the reason + open-in-browser instead of
  // the browser's cryptic "refused to connect" blank frame. A failed probe
  // (unreachable) keeps the plain iframe.
  useEffect(() => {
    if (url === undefined) return
    if (isLoopbackUrl(url)) {
      setEmbedBlocked(null)
      setForceEmbed(false)
      return
    }
    let cancelled = false
    setEmbedBlocked(null)
    setForceEmbed(false)
    void api.browserProbe(url).then((probe) => {
      if (!cancelled && embeddabilityOf(probe) === 'blocked') setEmbedBlocked(url)
    }).catch(() => { /* unreachable: keep the plain iframe */ })
    return () => { cancelled = true }
  }, [url])

  const persist = (nextUrl: string): void => {
    let host = nextUrl
    try { host = new URL(nextUrl).hostname } catch { /* keep the URL as title */ }
    store.reduce(state => patchTab(state, tab.id, { path: nextUrl, title: host }))
  }

  const showRefusal = (result: Exclude<BrowserNavigateResult, { kind: 'ok' }>): void => {
    if (result.kind === 'blocked' && result.reason === 'loopback') {
      setInput(result.url)
      setMessage(null)
      setPendingLocal(result)
      return
    }
    setPendingLocal(null)
    setMessage(result.kind === 'invalid' ? t('browserInvalid') : t('browserBlockedScheme'))
  }

  const commitNavigation = (next: string): void => {
    setUrl(next)
    setInput(next)
    setMessage(null)
    setPendingLocal(null)
    // Push onto the stack, dropping any stale forward entries.
    setHistory(previous => [...previous.slice(0, cursor + 1), next])
    setCursor(previous => previous + 1)
    setReloadKey(key => key + 1)
    persist(next)
  }

  const navigateTo = (raw: string): void => {
    const result = normalizeBrowserUrl(raw, window.location.origin, prefs.browserAllowedLoopback)
    if (result.kind === 'ok') {
      commitNavigation(result.url)
      return
    }
    showRefusal(result)
  }

  const trustAndOpen = async (): Promise<void> => {
    if (pendingLocal === null || trustingLocal) return
    setTrustingLocal(true)
    setMessage(null)
    try {
      const nextPrefs = await allowLoopbackUrl(api, pendingLocal.url)
      store.setPrefs(nextPrefs)
      commitNavigation(pendingLocal.url)
    } catch {
      setMessage(t('browserTrustFailed'))
    } finally {
      setTrustingLocal(false)
    }
  }

  const moveInHistory = (nextCursor: number): void => {
    const raw = history[nextCursor]
    if (raw === undefined) return
    const result = normalizeBrowserUrl(raw, window.location.origin, prefs.browserAllowedLoopback)
    setCursor(nextCursor)
    if (result.kind !== 'ok') {
      setUrl(undefined)
      showRefusal(result)
      return
    }
    setUrl(result.url)
    setInput(result.url)
    setPendingLocal(null)
    setMessage(null)
    setReloadKey(key => key + 1)
    persist(result.url)
  }

  const goBack = (): void => { moveInHistory(cursor - 1) }

  const goForward = (): void => { moveInHistory(cursor + 1) }

  // A settings edit can revoke a local grant while its tab is open. Apply
  // the updated policy immediately instead of leaving the old document in
  // an iframe until the next navigation.
  useEffect(() => {
    if (url === undefined || !isLoopbackUrl(url)) return
    const result = normalizeBrowserUrl(url, window.location.origin, prefs.browserAllowedLoopback)
    if (result.kind === 'blocked' && result.reason === 'loopback') {
      setUrl(undefined)
      showRefusal(result)
    }
  }, [prefs.browserAllowedLoopback, url])

  const iframeSandbox = url === undefined || noSandbox
    ? undefined
    : iframeSandboxFor(url, prefs.browserAllowedLoopback, window.location.origin)

  return (
    <div className={css.browser}>
      <div className={css.browserBar}>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('browserBack')}
          title={t('browserBack')}
          disabled={cursor <= 0}
          onClick={goBack}
        >
          <IconChevronLeftOutline14 />
        </button>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('browserForward')}
          title={t('browserForward')}
          disabled={cursor >= history.length - 1}
          onClick={goForward}
        >
          <IconChevronRightOutline14 />
        </button>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('refresh')}
          title={t('refresh')}
          onClick={() => { setReloadKey(key => key + 1) }}
        >
          <IconRefreshOutline14 />
        </button>
        <input
          className={css.browserInput}
          value={input}
          placeholder={t('browserPlaceholder')}
          spellCheck={false}
          onChange={event => { setInput(event.target.value) }}
          onKeyDown={event => {
            if (event.key === 'Enter') navigateTo(input)
          }}
        />
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('browserGo')}
          title={t('browserGo')}
          onClick={() => { navigateTo(input) }}
        >
          <IconLinkOutline14 />
        </button>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('browserOpenExternal')}
          title={t('browserOpenExternal')}
          disabled={url === undefined && pendingLocal === null}
          onClick={() => {
            const next = pendingLocal?.url ?? url
            if (next !== undefined) window.open(next, '_blank', 'noopener')
          }}
        >
          <VscLinkExternal size={15} />
        </button>
      </div>
      {message !== null && <div className={css.browserMessage}>{message}</div>}
      <SandboxStatusBar
        sandboxed={!noSandbox}
        local={localUnlock}
        dangerCopy={t('browserNoSandboxWarning')}
        onUnlock={() => { setLocalUnlock(true) }}
        onRestore={() => { setLocalUnlock(false) }}
      />
      {pendingLocal !== null ? (
        <BrowserLocalTrust
          authority={pendingLocal.authority}
          busy={trustingLocal}
          onTrust={() => { void trustAndOpen() }}
        />
      ) : url === undefined ? (
        <div className={css.browserStart}>{t('browserStart')}</div>
      ) : embedBlocked !== null && !forceEmbed ? (
        <BrowserEmbedBlocked
          url={embedBlocked}
          onOpenInBrowser={() => { window.open(embedBlocked, '_blank', 'noopener') }}
          onLoadAnyway={() => { setForceEmbed(true) }}
        />
      ) : (
        <iframe
          key={`${reloadKey}:${iframeSandbox ?? 'ns'}`}
          className={css.browserFrame}
          src={url}
          sandbox={iframeSandbox}
          referrerPolicy="no-referrer"
          allow=""
          title={url}
        />
      )}
    </div>
  )
}

/** Confirm and persist one exact local dev-server authority before loading it. */
export function BrowserLocalTrust(props: {
  authority: string
  busy: boolean
  onTrust: () => void
}) {
  const { authority, busy, onTrust } = props
  return (
    <div className={css.browserBlocked}>
      <IconWarningOutline16 size={16} />
      <div className={css.browserBlockedTitle}>{t('browserLocalBlockedTitle', { authority })}</div>
      <div className={css.browserBlockedDesc}>{t('browserLocalBlockedDesc')}</div>
      <div className={css.browserBlockedActions}>
        <button
          type="button"
          className={css.browserBlockedButton}
          disabled={busy}
          onClick={onTrust}
        >
          {busy ? t('browserTrusting') : t('browserTrustAndOpen')}
        </button>
      </div>
    </div>
  )
}

/**
 * The embed-refusal panel: shown when the probed site forbids being
 * displayed inside other pages (X-Frame-Options / frame-ancestors) — the
 * iframe would only show the browser's "refused to connect" blank. Explains
 * the reason and offers the real-browser open plus a load-anyway escape.
 * Exported so the copy and the actions are testable without a DOM.
 */
export function BrowserEmbedBlocked(props: {
  url: string
  onOpenInBrowser: () => void
  onLoadAnyway: () => void
}) {
  const { url, onOpenInBrowser, onLoadAnyway } = props
  let host = url
  try { host = new URL(url).hostname } catch { /* keep the raw URL */ }
  return (
    <div className={css.browserBlocked}>
      <IconWarningOutline16 size={16} />
      <div className={css.browserBlockedTitle}>{t('browserEmbedBlocked', { host })}</div>
      <div className={css.browserBlockedDesc}>{t('browserEmbedBlockedDesc')}</div>
      <div className={css.browserBlockedActions}>
        <button type="button" className={css.browserBlockedButton} onClick={onOpenInBrowser}>
          {t('browserOpenExternal')}
        </button>
        <button type="button" className={css.browserBlockedButton} onClick={onLoadAnyway}>
          {t('browserEmbedAnyway')}
        </button>
      </div>
    </div>
  )
}
