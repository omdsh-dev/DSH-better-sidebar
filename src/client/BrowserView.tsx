/**
 * The built-in browser tab: an address bar plus a sandboxed iframe.
 *
 * Security model (see browser.ts + the sandbox tokens below): the iframe is
 * sandboxed without `allow-top-navigation` (a page must not hijack the GUI).
 * Public pages use an opaque origin; explicitly approved loopback servers
 * get their own origin for local module/fetch pipelines but remain
 * cross-origin to the GUI. The address bar only accepts http(s) and gates
 * loopback behind an exact user approval. The side card setting "关闭浏览器沙箱" drops the
 * sandbox attribute entirely for fully trusted sites — the visited page then
 * runs with the GUI's own origin and full session access, so a persistent
 * warning bar renders while it is off.
 *
 * The URL is persisted onto the tab (path/title via the patchTab reducer)
 * so a reload restores the visited page; the back/forward stack only tracks
 * address-bar navigations (in-frame link clicks are cross-origin and
 * invisible — a documented limitation).
 */
import { useEffect, useState } from 'react'
import {
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconLinkOutline14,
  IconRefreshOutline14,
  IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { VscLinkExternal } from 'react-icons/vsc'
import { api } from './api.ts'
import { allowLoopbackUrl, embeddabilityOf, isAllowedLoopbackUrl, normalizeBrowserUrl } from './browser.ts'
import { parsePrefs } from './prefs.ts'
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
  // The current address (initialized from the persisted tab.path so a
  // reload restores the visited page).
  const [url, setUrl] = useState<string | undefined>(tab.path)
  const [input, setInput] = useState<string>(tab.path ?? '')
  /** Blocked/invalid hint shown under the address bar (null = none). */
  const [message, setMessage] = useState<
    | { kind: 'copy'; copy: string }
    | { kind: 'loopback'; url: string }
    | null
  >(null)
  const [allowingLoopback, setAllowingLoopback] = useState(false)
  /** Address-bar navigation history (in-frame clicks are not tracked). */
  const [history, setHistory] = useState<string[]>(tab.path !== undefined ? [tab.path] : [])
  const [cursor, setCursor] = useState<number>(tab.path !== undefined ? 0 : -1)
  /** Bumped on reload to remount the iframe (also remounts on sandbox flip). */
  const [reloadKey, setReloadKey] = useState(0)
  /** TEMPORARY sandbox unlock for THIS surface only (never writes the global
   *  side card setting; lasts until the tab unmounts or the user restores). */
  const [localUnlock, setLocalUnlock] = useState(false)
  const noSandbox = store.getPrefs().browserNoSandbox === true || localUnlock
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

  const navigateTo = (raw: string): void => {
    const result = normalizeBrowserUrl(raw, window.location.origin, store.getPrefs().browserAllowedLoopback)
    if (result.kind === 'ok') {
      const next = result.url
      setUrl(next)
      setInput(next)
      setMessage(null)
      // Push onto the stack, dropping any stale forward entries.
      setHistory(previous => [...previous.slice(0, cursor + 1), next])
      setCursor(previous => previous + 1)
      setReloadKey(key => key + 1)
      persist(next)
      return
    }
    setMessage(result.kind === 'invalid'
      ? { kind: 'copy', copy: t('browserInvalid') }
      : result.reason === 'scheme'
        ? { kind: 'copy', copy: t('browserBlockedScheme') }
        : { kind: 'loopback', url: result.url })
  }

  /** Persist an exact one-address loopback grant, then complete the blocked
   * navigation without weakening the browser sandbox. */
  const allowLoopback = (blockedUrl: string): void => {
    if (allowingLoopback) return
    const nextAllowlist = allowLoopbackUrl(store.getPrefs().browserAllowedLoopback, blockedUrl)
    setAllowingLoopback(true)
    void api.settingsUpdate({ browserAllowedLoopback: nextAllowlist }).then((view) => {
      store.setPrefs(parsePrefs(view.value))
      setMessage(null)
      setUrl(blockedUrl)
      setInput(blockedUrl)
      setHistory(previous => [...previous.slice(0, cursor + 1), blockedUrl])
      setCursor(previous => previous + 1)
      setReloadKey(key => key + 1)
      persist(blockedUrl)
      setAllowingLoopback(false)
    }).catch((error: unknown) => {
      console.error('browser loopback allow failed', error)
      setAllowingLoopback(false)
    })
  }

  const goBack = (): void => {
    if (cursor <= 0) return
    const next = history[cursor - 1]!
    setCursor(cursor - 1)
    setUrl(next)
    setInput(next)
    setReloadKey(key => key + 1)
  }

  const goForward = (): void => {
    if (cursor >= history.length - 1) return
    const next = history[cursor + 1]!
    setCursor(cursor + 1)
    setUrl(next)
    setInput(next)
    setReloadKey(key => key + 1)
  }

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
          disabled={url === undefined}
          onClick={() => {
            if (url !== undefined) window.open(url, '_blank', 'noopener')
          }}
        >
          <VscLinkExternal size={15} />
        </button>
      </div>
      {message !== null && (
        <div className={css.browserMessage}>
          <span>{message.kind === 'copy' ? message.copy : t('browserBlockedLoopback')}</span>
          {message.kind === 'loopback' && (
            <button
              type="button"
              className={css.browserMessageAction}
              disabled={allowingLoopback}
              onClick={() => { allowLoopback(message.url) }}
            >
              {allowingLoopback
                ? t('browserAllowLoopbackSaving')
                : t('browserAllowLoopback', { authority: new URL(message.url).host })}
            </button>
          )}
        </div>
      )}
      <SandboxStatusBar
        sandboxed={!noSandbox}
        local={localUnlock}
        dangerCopy={t('browserNoSandboxWarning')}
        onUnlock={() => { setLocalUnlock(true) }}
        onRestore={() => { setLocalUnlock(false) }}
      />
      {url === undefined ? (
        <div className={css.browserStart}>{t('browserStart')}</div>
      ) : embedBlocked !== null && !forceEmbed ? (
        <BrowserEmbedBlocked
          url={embedBlocked}
          onOpenInBrowser={() => { window.open(embedBlocked, '_blank', 'noopener') }}
          onLoadAnyway={() => { setForceEmbed(true) }}
        />
      ) : (
        <iframe
          key={`${reloadKey}:${noSandbox ? 'ns' : 'sb'}`}
          className={css.browserFrame}
          src={url}
          sandbox={noSandbox ? undefined : iframeSandboxFor(url, store.getPrefs().browserAllowedLoopback, window.location.origin)}
          referrerPolicy="no-referrer"
          allow=""
          title={url}
        />
      )}
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
