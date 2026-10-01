/**
 * Tracy's browser tab (`tracy:browser`): an address bar plus an iframe, drawn
 * as a page kind in DSH's native right Sidebar.
 *
 * Upstream 0.21.1 deleted its own browser tab (DSH ships one, which the Web
 * profile leaves disabled). Tracy keeps this one because a customer's site
 * preview needs three things DSH's does not do: a host-side fallback for a
 * site that refuses framing (`/sidebar/frame`), an unsandboxed frame for a
 * Tracy site (its assets need cookies), and an in-place stylesheet refresh
 * through Tracy's preview agent (`preview-protocol.generated.ts`).
 *
 * How a consumer opens it: `ctx.betterSidebar.openTab({ type: 'tracy:browser',
 * url, title })`. The kind is a single page per pane, so a second open
 * NAVIGATES the tab already there to the new address (the native surface
 * dedupes pages within a pane); `reloadTab(tabId, mode)` refreshes it.
 *
 * Security model (see browser.ts + the sandbox tokens below): the iframe is
 * sandboxed without `allow-top-navigation` (a page must not hijack the GUI)
 * and, for a page at the GUI's own origin, without `allow-same-origin` (the
 * visited page can never sit on the GUI's origin, read its storage, or reach
 * /sidebar/api); every other page keeps its own origin's cookies and storage
 * (`iframeSandboxFor`). A Tracy site (`isTracySiteUrl`) renders unsandboxed.
 * The address bar only accepts http(s) and refuses loopback.
 *
 * The URL is persisted onto the tab record (`meta.url` + title, through
 * `updateTab`) so a remount restores the visited page; the back/forward stack
 * tracks address-bar navigations and, on a Tracy site whose page reports its
 * own address (`ready.url`, runtime 4+), the pages reached by clicking inside
 * the frame. Any other in-frame click is cross-origin and invisible.
 *
 * Comments (stage 5, 29/09/2026): the site's comments are kept by tracy-web's
 * comment doors (`comment-api.ts`), read and written by `useCommentMode`. The
 * record's `meta.comments` and the localStorage mirror (stages 3–4) are only READ
 * now, once, to move what they hold to the server; then both copies are dropped
 * (`onMigrated`).
 *
 * Edit mode (Tracy, 27/09/2026): on a Tracy site in a site workspace the
 * tab asks tracy-web for a one-use preview ticket BEFORE the frame loads and
 * puts it in the iframe's `src` only — never in the tab record, the address
 * bar or the history. A page that then announces the picker gets the
 * Interactive | Edit control; see `comment-controller.ts` and `CommentLayer.tsx`.
 *
 * The mode bar (Brian, 27/09 pm, third pass): the zoom value and the mode are
 * the TAB's, kept in its record next to `meta.url` (and mirrored, with the
 * address, for a page reload, `browser-mode.ts`). A deep link's `?mode=edit|interactive` sets the
 * mode and is taken off the address before anything else sees it — the
 * ticket request, the iframe, the bar, the record and the history all hold
 * the clean address.
 *
 * The toolbar after option B2 (Brian, approved 29/09 ~16:00): no Go (Enter in the address navigates),
 * "Copy link" in Go's slot, and no strip under the address bar; the zoom chip hides under a 360 px frame.
 *
 * Stage 6 (29/09/2026, TCH `tasks/todo-comment-people.md` rules 5, 6 and 9): after Edit, ONE "Comments N"
 * button (every open comment on the site; `tracy:comments-open`). Refresh carries Tracy's progress
 * (`refresh-progress.ts`): the chat's `tracy:tracy-working` / `tracy:site-changed` / `tracy:turn-end`
 * for this session and site, and the poll's `siteChangedAt` against the time this page loaded; the page
 * reloads itself only after this person's own turn, and only when no comment box (popover, edit, reply)
 * is open and the page shown is the one the turn began on; the site tabs' `reloadTab` goes through the
 * same reducer, so a change reloads the page once. A comment's ⋮ Copy link is the site link plus
 * `&comment=<id>`; opened, that parameter takes the tab to the comment (`commentLink`) and leaves the
 * dsh page's address.
 */
import { dshUrl } from './page-base.ts'
import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useRef, useSyncExternalStore, type CSSProperties, type ReactElement } from 'react'
import { conversationShown, type MainSessionListSlice } from './main-session.ts'
import { createRefreshWatch, type RefreshWatch } from './refresh-watch.ts'
import {
  IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular,
  IconWarningOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { VscLinkExternal } from 'react-icons/vsc'
import { api, isForbiddenError } from './api.ts'
import { embeddabilityOf, normalizeBrowserUrl } from './browser.ts'
import { isPreviewMessage, previewRefreshMessage } from './preview-protocol.generated.ts'
import { t } from './locales.ts'
import type { SidebarTab, TabComponentProps } from './service.ts'
import css from './sidebar.module.css'
import { useCommentMode, type CommentMode } from './comment-controller.ts'
import { CommentOverlay, CommentsButton, CopyLinkButton, ModeBar, RefreshButton } from './CommentLayer.tsx'
import { hidesZoomChip, isCompactFrame, readReady, siteKeyOfBase, withReloadNonce, withoutReloadNonce } from './comment-model.ts'
import { COMMENTS_OPEN_EVENT, SITE_CHANGED_EVENT, TRACY_ASKING_EVENT, TRACY_WORKING_EVENT, TURN_END_EVENT, askTurnRunning, readTurnEvent, type Comment } from './comment-store.ts'
import { RELOAD_WAIT_MS, REFRESH_START, nextChange, refreshLook, refreshStep, type RefreshEvent, type RefreshState } from './refresh-progress.ts'
import { createCommentApi } from './comment-api.ts'
import {
  BROWSER_VIEW_EVENT,
  DEFAULT_ZOOM,
  canonicalPageUrl,
  centredScroll,
  commentStoreOf,
  loadViewState,
  mirroredAddressOf,
  siteDeepLink,
  readZoom,
  dropViewComments,
  saveViewAddress,
  saveViewState,
  takeModeParam,
  viewStateOf,
  type BrowserMode,
  type BrowserViewDetail,
  type BrowserViewState,
  type StageScroll,
} from './browser-mode.ts'

/** The native tab kind (and descriptor id) of Tracy's browser tab. */
export const TRACY_BROWSER_KIND = 'tracy:browser'

/**
 * The address a browser tab holds. A native navigation carries it as
 * `meta.url` (the tab adapter's `url` seed); a bottom-workbench tab — or a
 * record written before — carries it as `path`.
 * @param tab - the synthetic tab record.
 * @returns the address, or undefined for an empty tab.
 */
export function browserAddressOf(tab: SidebarTab): string | undefined {
  const meta = tab.meta as { url?: unknown } | undefined
  if (typeof meta?.url === 'string' && meta.url !== '') return meta.url
  return tab.path
}

/** The loopback allowlist: gone with upstream's browser prefs, so always empty. */
const NO_LOOPBACK_ALLOWLIST = ''

/** How long the loading line runs over a document whose `load` never comes (a killed frame). */
const LOADING_GIVE_UP_MS = 20_000

/** Whether an address is on an origin (a page may only report an address on the origin it sent from). */
function sameOriginAs(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}

/**
 * The browser iframe sandbox tokens. NO allow-same-origin (opaque origin —
 * no GUI storage/API access), NO allow-top-navigation (a browsed page must
 * not hijack the GUI). allow-forms/allow-popups/allow-downloads/allow-modals
 * keep login flows working; allow-popups-to-escape-sandbox lets OAuth
 * popups open as normal tabs (they are cross-origin to the GUI either way).
 */
export const BROWSER_IFRAME_SANDBOX =
  'allow-scripts allow-forms allow-popups allow-downloads allow-modals allow-popups-to-escape-sandbox'

/** `allow-same-origin` appended for every page that is not the GUI itself. */
const BROWSER_IFRAME_SANDBOX_SAME_ORIGIN =
  `${BROWSER_IFRAME_SANDBOX} allow-same-origin`

/**
 * The permissions the frame may ASK the browser for — what a page gets in a Chrome tab of its
 * own: fullscreen video, the clipboard, autoplay, picture-in-picture, sharing, DRM playback,
 * and the three the browser prompts for before granting (location, camera, microphone). A
 * cross-origin frame starts with none of them; `allow=""` (Tracy, until 29/09/2026) also took
 * them from the unsandboxed Tracy site — a video on the customer's own page could not go
 * fullscreen. The permission prompts stay the browser's: this only lets the frame raise them.
 */
export const BROWSER_IFRAME_ALLOW =
  'fullscreen; clipboard-read; clipboard-write; autoplay; picture-in-picture; web-share; encrypted-media; geolocation; camera; microphone'

/**
 * The sandbox tokens for one URL. Every page gets `allow-same-origin` — its OWN origin's
 * privileges: cookies, localStorage, fetch without CORS, a service worker — because without
 * them the frame has an opaque origin and a site behaves as if cookies were off: no sign-in
 * sticks, a cart empties on the next page, a bot challenge loops (Tracy, 29/09/2026; dsh's own
 * `ui-sidebar-browser` grants the same token to every page). It gives the page NO access to the
 * GUI — it stays cross-origin to it and to every other site — and `allow-top-navigation` is
 * still withheld, so it cannot take the GUI's tab over.
 *
 * The GUI itself is the one exception: a page at the GUI's exact origin must never get
 * `allow-same-origin` — that would make it same-origin with its parent and hand it the GUI's
 * storage/API (and the ability to shed the sandbox). The GUI keeps the opaque-origin sandbox.
 *
 * `allowedLoopback` is kept for the call shape; loopback addresses are refused by the address
 * bar before they get here, and one that came through is a page like any other.
 */
export function iframeSandboxFor(url: string | undefined, _allowedLoopback: string, selfOrigin?: string): string | undefined {
  if (url === undefined) return undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return BROWSER_IFRAME_SANDBOX
  }
  if (selfOrigin !== undefined && parsed.origin === selfOrigin) return BROWSER_IFRAME_SANDBOX
  return BROWSER_IFRAME_SANDBOX_SAME_ORIGIN
}

/**
 * Tracy (15/09/2026): a Tracy site's page renders unsandboxed, every other page stays sandboxed, and
 * there is no per-tab toggle. A sandboxed frame has an opaque origin, so the browser sends no cookies
 * with the site's stylesheets and images, and a site not open to guests answers them 403 — the tab
 * showed bare HTML. A site belongs to Tracy when its host is the deployment's site domain (or an
 * alias) or a subdomain of it, as `/api/config` states. The config door is Tracy's, at the root; a
 * dsh with no Tracy in front answers nothing there, and every page keeps the sandbox.
 * @param url - the page address.
 * @param domains - the deployment's site domain and its aliases.
 * @returns true when the page is a Tracy site.
 */
export function isTracySiteUrl(url: string | undefined, domains: readonly string[]): boolean {
  if (url === undefined) return false
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return domains.some(domain => domain !== '' && (host === domain || host.endsWith(`.${domain}`)))
}

let siteDomainsAsked: Promise<string[]> | null = null
/** The deployment's site domains from Tracy's `/api/config`, asked once per page; [] when there is no answer. */
function siteDomains(): Promise<string[]> {
  siteDomainsAsked ??= fetch('/api/config', { headers: { accept: 'application/json' } })
    .then(res => (res.ok ? res.json() : null))
    .then((body: { siteDomain?: unknown; siteDomainAliases?: unknown } | null) => {
      const aliases = Array.isArray(body?.siteDomainAliases) ? body.siteDomainAliases : []
      return [body?.siteDomain, ...aliases].filter((d): d is string => typeof d === 'string' && d !== '').map(d => d.toLowerCase())
    })
    .catch(() => [])
  return siteDomainsAsked
}

/** How long a refresh posted to the page's agent may go unanswered before the frame is reloaded. */
const REFRESH_ANSWER_MS = 1500

/**
 * How the frame is zoomed (Brian's approved drawing, story Zoomed75): the page keeps its layout
 * box — the stage — and is drawn at that scale from the top centre, on a neutral backdrop. Only
 * the framed page scales; the bar, the pin, the popover and the hint belong to this page and keep
 * their real size.
 *
 * 🔒 `transform: scale()`, NOT CSS `zoom` ON THE IFRAME. Whether `zoom` on an `<iframe>` reaches
 * the framed document (re-laying it out at another viewport and changing its pixel ratio) or only
 * scales the box differs between engines and versions, so the parent could not know which factor
 * the page's own coordinates are in. A transform is specified to leave the child's coordinate
 * space alone: the page keeps reporting boxes in its own CSS pixels (`picked.target.rect`),
 * hit-testing through the transform is the browser's job, and the parent maps a box with exactly
 * the transform it applied (`scaleRect`) to place the pin and the popover. The outline the page
 * draws itself is inside the page and scales with it.
 *
 * ABOVE 100 % (decision 6 in `tasks/todo-comment-to-edit.md`, like Claude Design): the first view
 * is still the top-centre crop, but the clipped edges stay reachable by scrolling the stage. A
 * transform does not enlarge the layout box, so the frame sits in a canvas of stage × f (the one
 * box that scrolls, `canvasZoomStyle`), keeps the stage's own size (1/f of the canvas) and is
 * scaled from the canvas' top-left corner, so the transformed frame fills the canvas exactly;
 * `ZoomStage` then scrolls it to the centre. The page's boxes map with the scroll offset
 * subtracted (`scaleRect`'s `scroll`).
 * @param zoom - percent.
 * @returns the iframe's extra style, or undefined at 100 %.
 */
export function frameZoomStyle(zoom: number): CSSProperties | undefined {
  if (zoom === DEFAULT_ZOOM) return undefined
  const f = zoom / 100
  if (f > 1) {
    return {
      position: 'absolute',
      top: 0,
      left: 0,
      width: `${String(100 / f)}%`,
      height: `${String(100 / f)}%`,
      transform: `scale(${String(f)})`,
      transformOrigin: '0 0',
    }
  }
  return {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    transform: `scale(${String(zoom / 100)})`,
    transformOrigin: '50% 0',
  }
}

/**
 * The canvas the frame sits in: the stage's size at or below 100 %, stage × f above it (the box
 * the stage scrolls over — `frameZoomStyle`).
 * @param zoom - percent.
 * @returns the canvas' extra style, or undefined where it simply fills the stage.
 */
export function canvasZoomStyle(zoom: number): CSSProperties | undefined {
  const f = zoom / 100
  if (f <= 1) return undefined
  return { flex: 'none', width: `${String(f * 100)}%`, height: `${String(f * 100)}%` }
}

/**
 * The stage: a scroll box holding the canvas and the frame, and the comment layer laid over the
 * stage's VISIBLE area (a sibling of the scroll box, not inside it, so the hint and the popover
 * stay in view and the popover is kept inside what the person sees). The same elements render at
 * every zoom, so crossing 100 % never remounts the frame (a remount would reload the page and drop
 * a pick). The scroll offset is state here, not in `BrowserView`, so scrolling re-renders the
 * layer only. The layer measures the stage (the frame's visible box) and reports its width up
 * (`onFrameWidth`): a frame under 600 px draws compact, the address bar included.
 */
function ZoomStage(props: { zoom: number; comment: CommentMode; onFrameWidth: (width: number) => void; children: ReactElement }): ReactElement {
  const { zoom, comment, onFrameWidth, children } = props
  const scroller = useRef<HTMLDivElement | null>(null)
  const [scroll, setScroll] = useState<StageScroll>({ left: 0, top: 0 })
  const read = useCallback((): void => {
    const el = scroller.current
    if (el === null) return
    setScroll(current => (current.left === el.scrollLeft && current.top === el.scrollTop ? current : { left: el.scrollLeft, top: el.scrollTop }))
  }, [])
  // A new zoom opens on the centre of the canvas (the approved top-centre look); at or below 100 %
  // there is nothing to scroll and this puts the box back at 0/0.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el === null) return
    el.scrollLeft = centredScroll(el.scrollWidth, el.clientWidth)
    el.scrollTop = 0
    read()
  }, [zoom, read])
  const zoomed = zoom !== DEFAULT_ZOOM
  return (
    <div className={zoomed ? `${css.browserStage} ${css.browserStageZoomed}` : css.browserStage}>
      <div
        ref={scroller}
        className={css.browserScroll}
        style={{ overflow: zoom > DEFAULT_ZOOM ? 'auto' : 'hidden' }}
        onScroll={read}
        data-browser-scroll=""
      >
        <div className={css.browserCanvas} style={canvasZoomStyle(zoom)} data-browser-canvas="">
          {children}
        </div>
      </div>
      <CommentOverlay mode={comment} zoom={zoom} scroll={scroll} onFrameWidth={onFrameWidth} />
    </div>
  )
}

export function BrowserView(props: TabComponentProps) {
  const { ctx, tab } = props
  const sessionId = props.scope?.sessionId ?? ''
  /** The address the tab record itself holds; undefined after a page reload dropped its `meta`. */
  const inRecord = browserAddressOf(tab)
  /**
   * The recorded address, as written (it may still carry a deep link's `?mode=`). A record that
   * holds one always wins; only a record without one falls back to the localStorage mirror — the
   * native Sidebar keeps a tab's id across a page reload, not its `meta.url`.
   */
  const recordedAddress = inRecord ?? mirroredAddressOf(loadViewState(sessionId, tab.id))
  const address = recordedAddress === undefined ? undefined : takeModeParam(recordedAddress).url
  /** The tab's zoom and mode: the record, then the page-reload mirror, then a deep link. */
  const [view, setView] = useState<BrowserViewState>(() => {
    const kept = viewStateOf(tab.meta, loadViewState(sessionId, tab.id))
    const asked = recordedAddress === undefined ? null : takeModeParam(recordedAddress).mode
    return asked === null ? kept : { ...kept, mode: asked }
  })
  /**
   * The record as this view last wrote it. Two writes in one turn (a new address and the mode a
   * deep link asked for) must not each start from the same stale `tab.meta` and erase the other.
   */
  const metaRef = useRef<Record<string, unknown>>({})
  metaRef.current = typeof tab.meta === 'object' && tab.meta !== null ? { ...tab.meta as Record<string, unknown> } : {}
  const writeRecord = useCallback((patch: { url?: string; mode?: BrowserMode; zoom?: number }): void => {
    const meta = { ...metaRef.current, ...patch }
    metaRef.current = meta
    let title: string | undefined
    if (patch.url !== undefined) {
      saveViewAddress(sessionId, tab.id, patch.url)
      title = patch.url
      try { title = new URL(patch.url).hostname } catch { /* keep the URL as title */ }
    }
    ctx.get('betterSidebar')?.updateTab(tab.id, title === undefined ? { meta } : { meta, title })
  }, [ctx, sessionId, tab.id])
  const changeView = useCallback((patch: Partial<BrowserViewState>): void => {
    setView((previous) => {
      const next = { ...previous, ...patch }
      saveViewState(sessionId, tab.id, next)
      return next
    })
    writeRecord(patch)
  }, [sessionId, tab.id, writeRecord])
  const setMode = useCallback((mode: BrowserMode): void => { changeView({ mode }) }, [changeView])
  // The current address (initialized from the tab record so a remount
  // restores the visited page).
  const [url, setUrl] = useState<string | undefined>(address)
  const [input, setInput] = useState<string>(address ?? '')
  /** Blocked/invalid hint shown under the address bar (null = none). */
  const [message, setMessage] = useState<string | null>(null)
  /** Navigation history: address-bar navigations, plus the pages a Tracy site reported (`followPage`). */
  const [history, setHistory] = useState<string[]>(address !== undefined ? [address] : [])
  const [cursor, setCursor] = useState<number>(address !== undefined ? 0 : -1)
  /**
   * The address the PAGE reported after a click inside the frame (29/09/2026), undefined while the
   * frame shows the address it was navigated to. `url` stays what the frame was told to load —
   * changing it would reload the frame — so everything that names the page shown (the bar, the
   * deep link, "Copy link", the record, a reload) reads `shown` instead.
   */
  const [pageAddress, setPageAddress] = useState<string | undefined>(undefined)
  const shown = pageAddress ?? url
  /** The page shown and the address bar's navigation, as of the latest render (the Comments view's reveal). */
  const shownRef = useRef(shown)
  shownRef.current = shown
  const navigateRef = useRef<(next: string) => void>(() => {})
  /** The address `followPage` last wrote into the record, so following it back is not a reload. */
  const followed = useRef<string | undefined>(undefined)
  /** The frame is loading a document: from a `src` change or a reload until its `load` event. */
  const [loading, setLoading] = useState(false)
  /**
   * Bumped when the frame must be REPLACED — a sandbox flip or a switch to the host route. It is
   * deliberately no longer bumped for a reload.
   *
   * 🔒 A RELOAD USED TO REMOUNT, AND REMOUNTING IS WHY LIVE PREVIEW FELT BROKEN. Putting this in
   * the iframe's `key` makes React destroy the element and build a new one, which throws away the
   * document AND everything the browser knew about it: the scroll position, the open menu, the
   * half-typed form. Someone reading a footer while the agent edited a stylesheet was sent back to
   * the top of the page on every change. Keeping the element means the browser reloads it the way
   * it reloads any page — restoring the scroll position itself.
   */
  const [reloadKey, setReloadKey] = useState(0)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  /**
   * The frame's width as the comment layer measured it (0 until then, and while no page is shown).
   * Under 600 px the tab draws compact (plan rule 6): the address bar drops Forward, and the mode
   * bar's segments and the Comments button are icons; under 360 px the zoom chip goes too (Brian
   * 29/09). The FRAME decides, never the window: the right panel can be narrow on a wide screen.
   */
  const [frameWidth, setFrameWidth] = useState(0)
  const compact = isCompactFrame(frameWidth)
  /**
   * Whether the page in the frame carries Tracy's preview agent (`@tracy/cms-preview`, shipped in
   * both CMS themes) and has announced itself. Only then can a refresh be applied in place; every
   * other page — an imported site on its own theme, a page behind the host route — gets the plain
   * reload below, which is still better than what it had.
   */
  const [previewReady, setPreviewReady] = useState(false)
  /**
   * The refresh posted to the page's agent, waiting for `applied` (`refresh-watch.ts`). No answer in
   * time means this document has no agent any more: stop believing the old `ready` (the next document
   * says it again if it has one) and reload the frame the way every page can.
   */
  const refreshWatch = useRef<RefreshWatch | null>(null)
  /**
   * 🔒 THE FALLBACK RELOAD READS TODAY'S STATE, NOT THE FIRST RENDER'S (28/09/2026). The callback was
   * built once and closed over that render, so it could not see `dropTicket()` and reloaded `src` AS
   * IT STOOD — `…?tracy_preview=pv1…`. The proxy does not 303 a ticket it has already redeemed, so the
   * ticket stayed in the page's address, and from there it rode into `content.locate` and into the
   * message sent to the agent. A ref the render keeps current is what the timeout calls, so the rungs
   * it takes are the same ones `refresh()` takes.
   */
  const refreshFallback = useRef<() => void>(() => {})
  if (refreshWatch.current === null) {
    refreshWatch.current = createRefreshWatch(() => {
      setPreviewReady(false)
      refreshFallback.current()
    }, REFRESH_ANSWER_MS)
  }
  useEffect(() => () => { refreshWatch.current?.dispose() }, [])
  /** The deployment's site domains (`isTracySiteUrl`); empty until `/api/config` answers. */
  const [domains, setDomains] = useState<readonly string[]>([])
  /** `/api/config` has answered (or given up): whether a page is a Tracy site is now final. */
  const [domainsKnown, setDomainsKnown] = useState(false)
  useEffect(() => {
    let cancelled = false
    void siteDomains().then((answer) => {
      if (cancelled) return
      setDomains(answer)
      setDomainsKnown(true)
    })
    // A config door that never answers must not hold a site workspace's first load forever.
    const giveUp = setTimeout(() => { if (!cancelled) setDomainsKnown(true) }, 2_500)
    return () => { cancelled = true; clearTimeout(giveUp) }
  }, [])
  const noSandbox = isTracySiteUrl(url, domains)
  /** A site that refuses to be embedded (X-Frame-Options / frame-ancestors):
   *  the probe verdict shown instead of the blank iframe. */
  const [embedBlocked, setEmbedBlocked] = useState<string | null>(null)
  /** The user asked to load the refused site anyway (keeps the plain iframe). */
  const [forceEmbed, setForceEmbed] = useState(false)
  /**
   * The host could not serve the refused site either, so the panel is all that is left.
   *
   * Without this the tab would loop: the probe says blocked, the frame route fails, the iframe
   * shows the host's error page, and nothing tells the person what happened.
   */
  const [frameRouteFailed, setFrameRouteFailed] = useState(false)
  const viaHost = embedBlocked !== null && !forceEmbed
  /** The site workspace this dsh page is (`<base href="/<siteKey>/">`), or null. */
  const siteKey = useMemo(() => (
    typeof document === 'undefined' ? null : siteKeyOfBase(document.baseURI, location.origin)
  ), [])
  /**
   * The tab's comments (stage 3): `meta.comments`, else the mirror, validated — read once per tab id
   * (`commentStoreOf`); every change goes back to both (`keepComments`).
   */
  const initialComments = useMemo(
    () => commentStoreOf(tab.meta, loadViewState(sessionId, tab.id), siteKey ?? ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per tab id, never re-read from a record it wrote
    [tab.id],
  )
  /** The site's comment doors (stage 5); none outside a site workspace. */
  const commentApi = useMemo(() => (siteKey === null ? undefined : createCommentApi({ siteKey })), [siteKey])
  /** The one-time move is over: the record and the mirror drop their copy of the comments. */
  const dropKeptComments = useCallback((): void => {
    dropViewComments(sessionId, tab.id)
    if (!('comments' in metaRef.current)) return
    const { comments: _moved, ...meta } = metaRef.current
    metaRef.current = meta
    ctx.get('betterSidebar')?.updateTab(tab.id, { meta })
  }, [ctx, sessionId, tab.id])
  /** The view's `refresh`, for a caller built before it (Refresh's automatic reload). */
  const refreshRef = useRef<(mode: unknown) => void>(() => {})
  /** A deep link's `comment=<id>` on the dsh page's address, read once at mount (rule 6). */
  const [commentLink] = useState<string | null>(() => readCommentParam())
  // Round 6 (acceptance v4 SEND-v4-new-1): this tab's conversation is the one on screen. A tab kept
  // mounted behind another conversation answers none of the Comments view's acts and lists nothing.
  const visible = props.visible !== false
  const sessionsList = (ctx as { sessions?: { list?: { getSnapshot(): MainSessionListSlice; subscribe(fn: () => void): () => void } } }).sessions?.list
  const subscribeSessions = useCallback((fn: () => void): (() => void) => sessionsList?.subscribe(fn) ?? (() => {}), [sessionsList])
  const readShown = (): boolean => conversationShown(sessionsList?.getSnapshot(), sessionId, visible)
  const shownConversation = useSyncExternalStore(subscribeSessions, readShown, readShown)
  const comment = useCommentMode({
    url,
    frameRef,
    tracySite: noSandbox,
    domainsKnown,
    viaHost,
    sessionId,
    edit: view.mode === 'edit',
    setMode,
    tabId: tab.id,
    initialComments,
    api: commentApi,
    onMigrated: dropKeptComments,
    // Round 9 (V5S-6): Refresh spins at the press of a send, and goes back if it failed.
    onSend: (phase) => { sendProgressRef.current(phase) },
    active: visible,
    conversationShown: shownConversation,
    // A reveal from the chat column's Comments view: a hidden tab is brought on screen the way a deep
    // link opens it (`openTab` of this kind; the native surface focuses the page already open at that
    // address), and a comment on another page is loaded as the address bar would load it.
    revealTab: () => {
      const here = shownRef.current
      ctx.get('betterSidebar')?.openTab(here === undefined ? { type: TRACY_BROWSER_KIND } : { type: TRACY_BROWSER_KIND, url: here }, sessionId === '' ? undefined : { sessionId })
    },
    navigate: (next) => { navigateRef.current(next) },
    copyCommentLink: async (c: Comment): Promise<boolean> => {
      if (siteKey === null) return false
      const link = commentDeepLink(location.origin, siteKey, c)
      return link === null ? false : await copyText(link)
    },
    commentLink,
    onCommentLinkTaken: dropCommentParam,
  })

  // ── Refresh carries Tracy's progress (rule 5) ──
  /** A send's press and failure, for the controller built before `stepProgress` (round 9, V5S-6). */
  const sendProgressRef = useRef<(phase: 'start' | 'failed') => void>(() => {})
  const [progress, setProgress] = useState<RefreshState>(REFRESH_START)
  const progressRef = useRef(progress)
  const [, setTick] = useState(0)
  /** When the frame last loaded a document (ms): the poll's `siteChangedAt` is compared with it. */
  const loadedAt = useRef(Date.now())
  /** The page the running turn began on (canonical), for "the page shown is the one it changed". */
  const turnPage = useRef<string | null>(null)
  // What holds a reload (rule 5): a popover, or a thread card with words or files in its reply box —
  // not an open card with an empty one (round 5, acceptance v3 SEND-new-2).
  const boxOpenRef = useRef(comment.holdsReload)
  boxOpenRef.current = comment.holdsReload
  /** The tab is on screen, as of the latest render: a hidden tab never reloads (round 6, R13). */
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  /** The mode the site tabs' last `reloadTab` asked for, spent by a `reload-asked` effect. */
  const askedMode = useRef<unknown>(undefined)
  const stepProgress = useCallback((event: RefreshEvent): void => {
    const step = refreshStep(progressRef.current, event)
    progressRef.current = step.state
    setProgress(step.state)
    for (const effect of step.effects) refreshRef.current(effect === 'reload' ? 'full' : askedMode.current)
  }, [])
  sendProgressRef.current = (phase): void => {
    if (phase === 'start') turnPage.current = shownRef.current === undefined ? null : canonicalPageUrl(shownRef.current)
    stepProgress(phase === 'start' ? { type: 'sending', now: Date.now() } : { type: 'send-failed', now: Date.now() })
  }
  useEffect(() => {
    const mine = (event: Event): boolean => {
      const detail = readTurnEvent((event as CustomEvent).detail)
      return detail !== null && detail.sessionId === sessionId && (detail.siteKey === null || siteKey === null || detail.siteKey === siteKey)
    }
    const onWorking = (event: Event): void => {
      if (!mine(event)) return
      // The answer to a question card goes on with the same turn, which began where it began.
      if (progressRef.current.phase !== 'asking') turnPage.current = shownRef.current === undefined ? null : canonicalPageUrl(shownRef.current)
      stepProgress({ type: 'working', now: Date.now() })
    }
    const onAsking = (event: Event): void => { if (mine(event)) stepProgress({ type: 'asking', now: Date.now() }) }
    const onChanged = (event: Event): void => { if (mine(event)) stepProgress({ type: 'site-changed', now: Date.now() }) }
    const onEnd = (event: Event): void => {
      if (!mine(event)) return
      const here = shownRef.current === undefined ? null : canonicalPageUrl(shownRef.current)
      const canReload = !boxOpenRef.current && frameRef.current !== null && (turnPage.current === null || turnPage.current === here)
      stepProgress({ type: 'turn-end', now: Date.now(), canReload, hidden: !visibleRef.current })
    }
    window.addEventListener(TRACY_WORKING_EVENT, onWorking)
    window.addEventListener(TRACY_ASKING_EVENT, onAsking)
    window.addEventListener(SITE_CHANGED_EVENT, onChanged)
    window.addEventListener(TURN_END_EVENT, onEnd)
    return () => {
      window.removeEventListener(TRACY_WORKING_EVENT, onWorking)
      window.removeEventListener(TRACY_ASKING_EVENT, onAsking)
      window.removeEventListener(SITE_CHANGED_EVENT, onChanged)
      window.removeEventListener(TURN_END_EVENT, onEnd)
    }
  }, [sessionId, siteKey, stepProgress])
  // A chip runs out on its own; an automatic reload that never came back counts as not reloaded.
  useEffect(() => {
    const due = nextChange(progress, Date.now())
    const timers: Array<ReturnType<typeof setTimeout>> = []
    if (due !== null) timers.push(setTimeout(() => { setTick(n => n + 1) }, Math.max(0, due - Date.now())))
    if (progress.phase === 'reloading') timers.push(setTimeout(() => { stepProgress({ type: 'reload-timeout', now: Date.now() }) }, RELOAD_WAIT_MS))
    if (progress.phase === 'working' && progress.pendingUntil !== 0) timers.push(setTimeout(() => { stepProgress({ type: 'send-expired', now: Date.now() }) }, Math.max(0, progress.pendingUntil - Date.now())))
    return () => { for (const timer of timers) clearTimeout(timer) }
  }, [progress, stepProgress])
  // A reload held while the tab was hidden happens when it comes on screen (round 6, acceptance v4 R13).
  // Round 9 (acceptance v5 V5S-3): so does a turn end the tab never heard — it asks the chat whether a
  // turn still runs in its conversation, and a working state with none behind it ends here.
  useEffect(() => {
    if (visible) stepProgress({ type: 'shown', now: Date.now(), canReload: !boxOpenRef.current, turnRunning: askTurnRunning(sessionId) })
  }, [visible, sessionId, stepProgress])
  // Everyone else: a change newer than this page's load reads "New version ready" (never a reload).
  useEffect(() => {
    const at = comment.siteChangedAt === null ? Number.NaN : Date.parse(comment.siteChangedAt)
    if (Number.isFinite(at) && at > loadedAt.current) stepProgress({ type: 'others-changed', now: Date.now() })
  }, [comment.siteChangedAt, stepProgress])
  const pageLoaded = (): void => {
    loadedAt.current = Date.now()
    stepProgress({ type: 'loaded', now: Date.now() })
  }
  const pageLoadedRef = useRef(pageLoaded)
  pageLoadedRef.current = pageLoaded

  // The dsh page's own address follows this tab (`BROWSER_VIEW_EVENT`): announced on mount and on
  // every change of page or mode, and taken back when the view goes — or hands its place to
  // another tab's record.
  const announced = useRef<BrowserViewDetail | null>(null)
  useEffect(() => {
    const detail: BrowserViewDetail = { tabId: tab.id, sessionId, siteKey, url: props.visible === false ? null : shown ?? null, mode: view.mode }
    const before = announced.current
    if (before !== null && (before.tabId !== tab.id || before.sessionId !== sessionId)) announceView({ ...before, url: null })
    announced.current = detail
    announceView(detail)
  }, [tab.id, sessionId, siteKey, shown, view.mode, props.visible])
  useEffect(() => () => {
    if (announced.current !== null) announceView({ ...announced.current, url: null })
  }, [])

  /**
   * "Copy link": only on a Tracy site page, in a site workspace — the link opens THAT site's door.
   * Resolves whether it copied; the button says so in its own tooltip (`CopyLinkButton`, option B2).
   */
  const copyLink = siteKey !== null && shown !== undefined && noSandbox
    ? async (): Promise<boolean> => {
        const link = siteDeepLink(location.origin, siteKey, shown, view.mode)
        return link === null ? false : await copyText(link)
      }
    : null

  /**
   * The Comments button (rule 9): the chat column comes on
   * screen — a right panel in fullscreen covers it, so this tab's pane leaves fullscreen first — and
   * tracy-chat-input opens its Comments tab on `tracy:comments-open`.
   */
  const openComments = (): void => {
    leaveFullscreen(ctx, frameRef.current)
    window.dispatchEvent(new CustomEvent(COMMENTS_OPEN_EVENT, { detail: { sessionId, tabId: tab.id } }))
  }

  // A conversation switch can hand this view another tab's record: that tab's settings apply.
  const viewTab = useRef(tab.id)
  useEffect(() => {
    if (viewTab.current === tab.id) return
    viewTab.current = tab.id
    setView(viewStateOf(tab.meta, loadViewState(sessionId, tab.id)))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the tab identity only
  }, [tab.id])

  // An address restored from the mirror goes back into the record at once: agents read the address
  // there, and `tracy-my-sites` / `tracy-add-site` skip opening the site root on session load only
  // when a Browser tab's record already shows the site.
  useEffect(() => {
    if (inRecord !== undefined || address === undefined) return
    writeRecord({ url: address })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the two addresses only
  }, [inRecord, address])

  // An address the record gets from elsewhere (a second open navigating this tab) is mirrored too.
  useEffect(() => {
    if (address !== undefined) saveViewAddress(sessionId, tab.id, address)
  }, [sessionId, tab.id, address])

  // A deep link's mode, recorded (an `openTab` with `?mode=`, or a link opened into this tab):
  // take it, and put the clean address back in the record — the parameter is Tracy's, it must
  // not stay where agents and the next remount read the address from.
  useEffect(() => {
    if (recordedAddress === undefined) return
    const { url: clean, mode: asked } = takeModeParam(recordedAddress)
    if (asked === null) return
    // The clean address first, so the mode's write builds on it and no record ever holds both.
    writeRecord({ url: clean })
    changeView({ mode: asked })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the recorded address only
  }, [recordedAddress])

  // The page announces itself once it has loaded, and again after a back/forward restore. Only the
  // frame this view owns is believed: `event.source` is the one thing a sender cannot forge, so a
  // message from any other window or frame on the page is ignored whatever it says.
  //
  // A `ready` that names the page's own address (runtime 4+, sent only to this origin) moves the
  // bar there (`followPage`): the one thing a page can claim is an address on the origin it sent
  // from — which is what the bar would show for it anyway — so an address elsewhere is ignored.
  const followPageRef = useRef<(next: string) => void>(() => {})
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (frameRef.current === null || event.source !== frameRef.current.contentWindow) return
      if (isPreviewMessage(event.data, 'ready')) {
        setPreviewReady(true)
        const ready = readReady(event.data)
        if (ready?.url != null && event.origin !== 'null' && sameOriginAs(ready.url, event.origin)) followPageRef.current(ready.url)
      }
      if (isPreviewMessage(event.data, 'applied')) {
        refreshWatch.current?.answered()
        // Styles swapped in place: done. Any other answer is followed by the page reloading
        // itself, and the line runs on until that document's `load`.
        if ((event.data as { mode?: unknown }).mode === 'style') {
          setLoading(false)
          pageLoadedRef.current()
        }
      }
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [])

  /**
   * The page reports where it is now (29/09/2026): a click inside a Tracy site's page landed on
   * another page. The bar, the history, the record and the deep link follow; the frame is left
   * alone — it is already there. The address the frame was told to load (`url`) is kept, since
   * changing it is a reload (`frameSrc` is derived from it, ticket and all).
   * @param next - the page's own address, as it reported it.
   */
  const followPage = (next: string): void => {
    // The first document after a navigation that reports another address was REDIRECTED there
    // (a site sending `/` to `/ru/`): a browser replaces the entry, so Back does not lead to a
    // page that only forwards. A later document is a page the person went to: a new entry.
    const redirected = firstDocument.current
    firstDocument.current = false
    const clean = takeModeParam(next).url
    // The page it was navigated to, or the one already followed (a `pageshow` echo): nothing moved.
    if (canonicalPageUrl(clean) === canonicalPageUrl(shown ?? '')) return
    followed.current = clean
    setPageAddress(clean)
    setInput(clean)
    setMessage(null)
    if (redirected) {
      setHistory(previous => previous.map((entry, index) => (index === cursor ? clean : entry)))
    } else {
      setHistory(previous => [...previous.slice(0, cursor + 1), clean])
      setCursor(previous => previous + 1)
    }
    persist(clean)
  }
  followPageRef.current = followPage

  /** No document of the current navigation has announced itself yet (`followPage`). */
  const firstDocument = useRef(true)
  /** The frame is (about to be) told to load `url` again: what the page reported no longer holds. */
  const forgetPage = (): void => {
    setPageAddress(undefined)
    followed.current = undefined
    firstDocument.current = true
  }
  // A navigation (the bar, back/forward, the record) is a new document at the address it names.
  useEffect(() => { forgetPage() }, [url])

  /**
   * Load `next` in the frame: another address changes `src` (the frame navigates on its own);
   * the SAME address does not, and the frame may have left it (the page moved) — so it is told
   * again, at a fresh reload address, without replaying a single-use ticket.
   */
  const loadAgain = (next: string): void => {
    forgetPage()
    if (next !== url) {
      setUrl(next)
      setReloadKey(key => key + 1)
      return
    }
    const frame = frameRef.current
    if (frame !== null && frame.src !== '') {
      setLoading(true)
      frame.src = withReloadNonce(next)
      return
    }
    setReloadKey(key => key + 1)
  }

  // A new address is a new page, and it may be a site with no agent in it. The claim has to be
  // dropped before the page loads, or one Tracy site followed by one imported site would leave the
  // tab posting refreshes into something that never listens — and silently not refreshing.
  //
  // 🔒 AND THE WATCH OF THE PAGE THAT LEFT IS CANCELLED WITH IT (28/09/2026). It was not, so a refresh
  // posted into the OLD document could time out after the new one had loaded and reload THAT — which
  // also tore down a ticket exchange still in flight for it.
  useEffect(() => {
    setPreviewReady(false)
    refreshWatch.current?.answered()
  }, [url])

  /**
   * Show what the page says NOW, as cheaply as the page allows.
   *
   * Three rungs, and the tab climbs down them: ask the agent to swap stylesheets in place (nothing
   * reloads, nothing moves); failing that, reload the frame's document while KEEPING the element,
   * so the browser restores the scroll position; failing even that, replace the element.
   *
   * 🔒 THE LAST RUNG IS FOR A FRAME THAT CANNOT BE TOLD ANYTHING. Assigning `src` is what
   * reloads a cross-origin frame without remounting it — the parent may write the attribute even
   * though it may not read the document. The value carries a fresh reload nonce: the same address
   * would replay whatever the browser kept for it, a stale permanent redirect included
   * (`withReloadNonce`). A frame with no `src` yet (nothing loaded) has
   * nothing to reload, so it falls through to the remount that mounting would have done anyway.
   * @param mode - what the caller believes changed; anything unknown is treated as a full refresh.
   */
  const refresh = (mode: unknown): void => {
    const frame = frameRef.current
    if (previewReady && frame?.contentWindow != null) {
      // The line runs until the agent answers (`applied`) or the document it reloads has loaded.
      setLoading(true)
      frame.contentWindow.postMessage(previewRefreshMessage(typeof mode === 'string' ? mode : ''), '*')
      refreshWatch.current?.posted()
      return
    }
    reloadFrame()
  }

  /** The two rungs below the agent: drop the single-use ticket, else reload the element's own `src`. */
  const reloadFrame = (): void => {
    const frame = frameRef.current
    // The page moved on inside the frame (`followPage`): reloading the element's `src` — or the
    // ticketed address the gate holds — would bring back the page it was navigated to, not the
    // one shown. The reported address, with a fresh nonce, is the reload of the page shown.
    if (pageAddress !== undefined && frame !== null) {
      setLoading(true)
      frame.src = withReloadNonce(pageAddress)
      return
    }
    // A ticket is single-use: dropping it from `src` IS the reload (to the clean address, which
    // the picker's own cookie now carries), and assigning the ticketed `src` again would replay it.
    if (comment.dropTicket()) return
    if (frame !== null && frame.src !== '') {
      setLoading(true)
      // A fresh nonce, not `src` itself: the same address replays what the browser kept for it.
      frame.src = withReloadNonce(withoutReloadNonce(frame.src))
      return
    }
    setReloadKey(key => key + 1)
  }
  refreshRef.current = refresh
  // What the refresh watchdog calls when this document's agent never answered: the same rungs, read at
  // the time it fires rather than at the first render (`refreshFallback`).
  refreshFallback.current = reloadFrame


  // Probe every navigation (address bar, history, restored path): when the
  // target forbids embedding, show the reason + open-in-browser instead of
  // the browser's cryptic "refused to connect" blank frame. A failed probe
  // (unreachable) keeps the plain iframe.
  //
  // Tracy: a 403 means this account may not probe at all (dsh-passwords keeps
  // `browser.probe` owner-only for seat accounts — it fetches any address),
  // so the tab stops asking for the rest of its life instead of drawing one
  // refusal per navigation (TCH #515). Any other failure is per address: the
  // next navigation probes again.
  //
  // A Tracy site is never probed (29/09/2026): its proxy names Tracy's own origin in
  // `frame-ancestors` on every answer, so the verdict is known — and the probe route is
  // owner-only, so for every other seat it was one 403 per site page for nothing. The verdict
  // waits for `/api/config` (2.5 s at most) so a Tracy site is not probed before it is known as one.
  const probeForbidden = useRef(false)
  useEffect(() => {
    if (url === undefined) return
    let cancelled = false
    setEmbedBlocked(null)
    setForceEmbed(false)
    setFrameRouteFailed(false)
    if (probeForbidden.current || !domainsKnown || noSandbox) return
    void api.browserProbe(url).then((probe) => {
      if (!cancelled && embeddabilityOf(probe, window.location.origin) === 'blocked') setEmbedBlocked(url)
    }).catch((error: unknown) => {
      // Unreachable: keep the plain iframe.
      if (isForbiddenError(error)) probeForbidden.current = true
    })
    return () => { cancelled = true }
  }, [url, domainsKnown, noSandbox])

  // A reload was requested (`BetterSidebarService.reloadTab`): the service
  // writes a nonce into this tab's meta; the ref means only a change AFTER
  // mount reloads — a nonce carried by a remounted record must not fire a
  // spurious reload on top of the load the fresh mount already does.
  const seenReloadNonce = useRef<unknown>((tab.meta as { reloadNonce?: unknown } | undefined)?.reloadNonce)
  useEffect(() => {
    const nonce = (tab.meta as { reloadNonce?: unknown } | undefined)?.reloadNonce
    if (nonce === seenReloadNonce.current) return
    seenReloadNonce.current = nonce
    // 🔒 ONE OWNER PER CHANGE (TCH `fix/comment-reload-once`, 30/09/2026). The site tabs ask every
    // Browser tab on the site to reload after each turn of the conversation on screen that changed it;
    // this tab's own turn events (rule 5) may already have reloaded it for that change, or held it
    // under an open comment box. So the request is not obeyed here: it goes through the same reducer
    // as the turn events (`refreshStep` 'reload-request'), which reloads once, keeps a hold, and holds
    // under an open box ("New version ready" until clicked — stage 6 acceptance F1/R3). The seam is
    // this tab and not the site tabs because only the tab knows its box and what it already did.
    askedMode.current = (tab.meta as { reloadMode?: unknown } | undefined)?.reloadMode
    stepProgress({ type: 'reload-request', now: Date.now(), canReload: !boxOpenRef.current, hidden: !visibleRef.current })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on the nonce, not on `refresh`
  }, [tab.meta])

  // The tab record's address is the truth for a tab; follow it when it moves.
  // On the native surface this kind is ONE page per pane, so a second open
  // with another URL navigates this very tab (the adapter rewrites
  // `meta.url`), and a conversation switch can hand this view another
  // session's record. Measured on 0.18.1 (15/09/2026): the tab titled
  // namdemo22 kept showing namdemo21 until this followed the record.
  // Back/forward change `url` without touching the record, and do not
  // trigger this.
  useEffect(() => {
    // The address `followPage` wrote is the page the frame already shows: not a move.
    if (address === undefined || address === url || address === followed.current) return
    setUrl(address)
    setInput(address)
    setHistory([address])
    setCursor(0)
    setMessage(null)
    setReloadKey(key => key + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the record's address only
  }, [address])

  const persist = (nextUrl: string): void => { writeRecord({ url: nextUrl }) }

  const navigateTo = (raw: string): void => {
    const result = normalizeBrowserUrl(raw, window.location.origin, NO_LOOPBACK_ALLOWLIST)
    if (result.kind === 'ok') {
      // Words typed in a comment box are asked about first (round 4, acceptance v2 L05): the box
      // flashes and nothing loads; the same press again within a few seconds loads and drops them.
      if (!comment.mayLeave()) return
      // A typed deep link: the mode it asks for applies, the parameter goes nowhere.
      const { url: next, mode: asked } = takeModeParam(result.url)
      if (asked !== null) changeView({ mode: asked })
      setUrl(next)
      setInput(next)
      setMessage(null)
      // Push onto the stack, dropping any stale forward entries.
      setHistory(previous => [...previous.slice(0, cursor + 1), next])
      setCursor(previous => previous + 1)
      // The SAME address, with the frame still on it: a refresh (pressing Enter twice would do
      // nothing at all without this). Anything else is a load (`loadAgain`).
      if (next === url && pageAddress === undefined) refresh(undefined)
      else loadAgain(next)
      persist(next)
      return
    }
    setMessage(result.kind === 'invalid'
      ? t('browserInvalid')
      : result.reason === 'scheme' ? t('browserBlockedScheme')
      : t('browserBlockedLoopback'))
  }

  navigateRef.current = navigateTo

  const goBack = (): void => {
    if (cursor <= 0 || !comment.mayLeave()) return
    const next = history[cursor - 1]!
    setCursor(cursor - 1)
    setInput(next)
    loadAgain(next)
  }

  const goForward = (): void => {
    if (cursor >= history.length - 1 || !comment.mayLeave()) return
    const next = history[cursor + 1]!
    setCursor(cursor + 1)
    setInput(next)
    loadAgain(next)
  }

  /** What the element loads: the host route for a refused site, else the gate's answer (ticket and all). */
  const frameSrc = url === undefined ? undefined : viaHost ? frameRouteUrl(url) : comment.frameSrc
  // A document is on its way from the moment the attribute names one (or the element is
  // replaced) until its `load`; `reloadFrame` says so itself for the reloads the attribute
  // cannot show. A load that never ends — a frame the browser killed answers nothing — is
  // given up after a while, so the bar does not run forever over a dead frame.
  useEffect(() => { if (frameSrc !== undefined) setLoading(true) }, [frameSrc, reloadKey])
  useEffect(() => {
    if (!loading) return
    const giveUp = setTimeout(() => { setLoading(false) }, LOADING_GIVE_UP_MS)
    return () => { clearTimeout(giveUp) }
  }, [loading])

  return (
    // `data-browser-tab`: while a comment box is open, a file dropped anywhere in this tab outside the
    // box is caught and ignored (`CommentOverlay`), never opened by the browser in place of the page.
    <div className={css.browser} data-browser-tab="">
      <div className={css.browserBar}>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('browserBack')}
          title={t('browserBack')}
          disabled={cursor <= 0}
          onClick={goBack}
        >
          <IconChevronLeftOutlineRegular size={14} />
        </button>
        {!compact && (
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('browserForward')}
            title={t('browserForward')}
            disabled={cursor >= history.length - 1}
            onClick={goForward}
          >
            <IconChevronRightOutlineRegular size={14} />
          </button>
        )}
        <RefreshButton
          look={refreshLook(progress, Date.now())}
          onClick={() => {
            // Round 9 (V5S-3): with no turn running in the conversation, the press ends the spinner.
            const step = refreshStep(progressRef.current, { type: 'pressed', now: Date.now(), turnRunning: askTurnRunning(sessionId) })
            progressRef.current = step.state
            setProgress(step.state)
            refresh(undefined)
          }}
        />
        <input
          className={css.browserInput}
          value={input}
          placeholder={t('browserPlaceholder')}
          spellCheck={false}
          onChange={event => { setInput(event.target.value) }}
          onKeyDown={event => {
            if (event.key !== 'Enter') return
            // Round 11 (IN5-4): the key is the bar's. A refused load flashes the popover and puts the
            // focus in its text while this key is still going; its new line must not land there.
            event.preventDefault()
            navigateTo(input)
          }}
        />
        {/* Option B2 (Brian 29/09): Go is gone in every width — Enter (above) navigates — and the copy
            button takes its slot. */}
        {copyLink !== null && <CopyLinkButton onCopy={copyLink} />}
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
        <ModeBar
          zoom={view.zoom}
          onZoom={(zoom) => { changeView({ zoom: readZoom(zoom) ?? DEFAULT_ZOOM }) }}
          modes={comment.modes}
          compact={compact}
          hideZoom={hidesZoomChip(frameWidth)}
        >
          <CommentsButton comments={comment.comments} url={comment.pageUrl} compact={compact} onOpen={openComments} />
        </ModeBar>
      </div>
      {/* No strip under the address bar any more (option B2): the count, Send and the list live in the
          Comments split button and the chat column's Comments tab. */}
      {/* The loading line: a document is on its way (Chrome's spinner, drawn as a line under the bar). */}
      <div className={css.browserProgress} data-loading={loading ? 'true' : 'false'} aria-hidden="true" />
      {message !== null && <div className={css.browserMessage}>{message}</div>}
      {url === undefined ? (
        <div className={css.browserStart}>{t('browserStart')}</div>
      ) : embedBlocked !== null && !forceEmbed && frameRouteFailed ? (
        <BrowserEmbedBlocked
          url={embedBlocked}
          onOpenInBrowser={() => { window.open(embedBlocked, '_blank', 'noopener') }}
          onLoadAnyway={() => { setForceEmbed(true) }}
        />
      ) : (
        <ZoomStage zoom={view.zoom} comment={comment} onFrameWidth={setFrameWidth}>
          <iframe
            ref={frameRef}
            key={`${reloadKey}:${noSandbox ? 'ns' : 'sb'}:${viaHost ? 'via-host' : 'direct'}`}
            className={view.zoom === DEFAULT_ZOOM ? css.browserFrame : `${css.browserFrame} ${css.browserFrameZoomed}`}
            style={frameZoomStyle(view.zoom)}
            /*
             * A site that refuses framing is fetched BY THE HOST and served back from this origin
             * (`/sidebar/frame`), so the iframe renders instead of showing the browser's blank
             * "refused to connect". Joomla and WordPress both refuse by default, so this is the
             * ordinary case for a customer's own site — not an edge case.
             *
             * The panel is still there, one `onError` away: if the host cannot fetch it either,
             * there is nothing left to try and the person deserves the explanation.
             *
             * 🔒 Cookies do not travel through the host, so a page behind a login renders logged
             * out. That is the honest trade for being able to see it at all.
             */
            /*
             * 🔒 `comment.frameSrc` may carry the preview ticket (`?tracy_preview=`). It lives in this
             * attribute ONLY: `persist` writes `url`, the bar shows `input`, the history holds `url`.
             * While the ticket is being asked the attribute is left out, so the first load is the
             * ticketed one (undefined = no navigation yet).
             */
            src={frameSrc}
            onLoad={() => { setLoading(false); comment.onFrameLoad(); pageLoaded() }}
            onError={() => { setLoading(false); setFrameRouteFailed(true) }}
            sandbox={noSandbox ? undefined : iframeSandboxFor(url, NO_LOOPBACK_ALLOWLIST, window.location.origin)}
            referrerPolicy="no-referrer"
            allow={BROWSER_IFRAME_ALLOW}
            allowFullScreen
            title={shown}
          />
        </ZoomStage>
      )}
    </div>
  )
}

/**
 * Leave the right panel's fullscreen, where it covers the chat column (dsh marks the frame root
 * `data-rightbar-fullscreen`): the same action as the panel's own chrome button, through dsh's
 * `sidebarRight` controller for the pane holding `from` — under automatic fullscreen (a narrow window)
 * it folds the panel away, which is what shows the chat there. Nothing to do when not in fullscreen or
 * without the controller.
 */
function leaveFullscreen(ctx: TabComponentProps['ctx'], from: Element | null): void {
  if (typeof document === 'undefined' || document.querySelector('[data-rightbar-fullscreen]') === null) return
  try {
    const right = ctx.get('sidebarRight') as unknown as {
      commandTarget?: (element?: Element | null) => unknown
      toggleFullscreen?: (target: unknown) => void
    } | undefined
    const target = right?.commandTarget?.(from)
    if (target !== undefined) right?.toggleFullscreen?.(target)
  } catch { /* no controller: nothing of ours covers the chat */ }
}

/** The deep link's parameter naming one comment (rule 6): `…/?open=browser&page=…&mode=edit&comment=<id>`. */
export const COMMENT_PARAM = 'comment'

/**
 * A comment's ⋮ Copy link: the site link the toolbar hands out (`siteDeepLink`, in Edit, on the
 * comment's page) plus `&comment=<id>`. `@tracy/dsh-site-tabs` opens the Browser tab on the page in
 * Edit and leaves every parameter but its own three, so the tab reads `comment` itself.
 */
export function commentDeepLink(origin: string, siteKey: string, c: Pick<Comment, 'id' | 'url'>): string | null {
  const link = siteDeepLink(origin, siteKey, c.url, 'edit')
  return link === null ? null : `${link}&${COMMENT_PARAM}=${encodeURIComponent(c.id)}`
}

/** The `comment=` of the dsh page's own address, or null. */
function readCommentParam(): string | null {
  if (typeof location === 'undefined') return null
  const id = new URLSearchParams(location.search).get(COMMENT_PARAM)
  return id === null || id.trim() === '' ? null : id
}

/** Take `comment=` off the dsh page's address once the tab acted on it, every other parameter kept. */
function dropCommentParam(): void {
  if (typeof location === 'undefined' || typeof history === 'undefined') return
  const params = new URLSearchParams(location.search)
  if (!params.has(COMMENT_PARAM)) return
  params.delete(COMMENT_PARAM)
  const query = params.toString()
  try { history.replaceState(history.state, '', `${location.pathname}${query === '' ? '' : `?${query}`}${location.hash}`) } catch { /* a sandboxed page */ }
}

/** Tell the page what this view shows (`BROWSER_VIEW_EVENT`); a page without listeners loses nothing. */
function announceView(detail: BrowserViewDetail): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(BROWSER_VIEW_EVENT, { detail }))
}

/**
 * Put text on the clipboard: the async Clipboard API, then the old `execCommand('copy')` through a
 * hidden textarea — the API is missing on a plain-http stand (no secure context) and may be refused.
 * @returns whether the text was copied.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* fall through to the textarea */ }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    return copied
  } catch {
    return false
  }
}

/**
 * The host route that serves a framing-refused document from this origin.
 *
 * Relative — the sidebar is served by the same dsh that hosts the route, and an absolute origin
 * here would turn a same-origin request into a cross-origin one that carries no session.
 * @param url The address the person navigated to.
 * @returns The URL to put in the iframe.
 */
export function frameRouteUrl(url: string): string {
  return dshUrl(`/sidebar/frame?url=${encodeURIComponent(url)}`)
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
      <IconWarningOutlineRegular size={16} />
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
