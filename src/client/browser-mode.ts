/**
 * The Browser tab's mode bar — the rules (Tracy, 27/09/2026, Brian's third pass).
 *
 * Two per-tab settings sit at the right end of the address bar, like Claude Design: a zoom value
 * for the framed page, and a mode — Interactive (use the site as a visitor) or Edit (point at
 * something to change it). Both belong to the TAB, not to the page in it: they survive a reload,
 * a navigation inside the tab and a reopen. Pure and DOM-free, so every rule is testable alone;
 * `BrowserView.tsx` owns the state and the writes.
 *
 * Where they are kept: in the tab record's `meta` (`mode`, `zoom`), next to `meta.url`, which is
 * what a remount of the view reads. The native right Sidebar persists only a tab's id, kind and
 * title across a page reload — not its `meta` — so the same two values, and the tab's address,
 * are ALSO mirrored into this browser's localStorage under the tab's id; the record wins when
 * both exist.
 */
import type { PreviewPickRect } from './preview-protocol.generated.ts'
import { emptyCommentStore, persistedCommentStore, restoreCommentStore, type CommentStore } from './comment-store.ts'

export type BrowserMode = 'interactive' | 'edit'

/** The query parameter a deep link sets the mode with. Tracy's own: it never reaches the CMS. */
export const MODE_PARAM = 'mode'

/** The zoom values the bar offers, in percent — Claude Design's list (Brian, 27/09 evening). */
export const ZOOM_LEVELS = [50, 75, 90, 100, 110, 125, 150, 175, 200] as const

export const DEFAULT_ZOOM = 100

export interface BrowserViewState {
  mode: BrowserMode
  /** Percent, one of {@link ZOOM_LEVELS}. */
  zoom: number
}

export const DEFAULT_VIEW_STATE: BrowserViewState = { mode: 'interactive', zoom: DEFAULT_ZOOM }

/** @returns the mode a value names, or null for anything else. */
export function readMode(value: unknown): BrowserMode | null {
  return value === 'edit' || value === 'interactive' ? value : null
}

/** @returns the zoom a value names when it is one the bar offers, or null. */
export function readZoom(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && (ZOOM_LEVELS as readonly number[]).includes(n) ? n : null
}

/**
 * Take a deep link's `?mode=` off an address.
 *
 * Only `edit` and `interactive` are Tracy's: any other value may be the site's own parameter and
 * is left exactly where it was. An address without Tracy's parameter comes back byte for byte (no
 * re-serialisation), so a plain navigation is never rewritten.
 * @param url - the address as typed, opened or recorded.
 * @returns the address without the parameter, and the mode it asked for (null = none).
 */
export function takeModeParam(url: string): { url: string; mode: BrowserMode | null } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { url, mode: null }
  }
  const values = parsed.searchParams.getAll(MODE_PARAM)
  const mode = values.map(readMode).find(value => value !== null) ?? null
  if (mode === null) return { url, mode: null }
  const kept = values.filter(value => readMode(value) === null)
  parsed.searchParams.delete(MODE_PARAM)
  for (const value of kept) parsed.searchParams.append(MODE_PARAM, value)
  return { url: parsed.toString(), mode }
}

/**
 * The site address with the tab's mode, so whoever opens it in a Tracy Browser tab lands in the
 * same mode. The mode bar's "Copy link" hands out {@link siteDeepLink} instead — the dsh page's
 * door, which opens the Browser tab itself. "Open in browser" never carries it — a visitor's
 * own browser has no side card to act on it.
 */
export function withModeParam(url: string, mode: BrowserMode): string {
  const clean = takeModeParam(url).url
  try {
    const parsed = new URL(clean)
    parsed.searchParams.set(MODE_PARAM, mode)
    return parsed.toString()
  } catch {
    return clean
  }
}

// ── The page's real address (Brian, 27/09 evening) ─────────────────────────────────────────

/**
 * The window event the view dispatches whenever the page or the mode it shows changes, once on
 * mount, and with `url: null` when it goes away. Tracy's `@tracy/dsh-site-tabs` listens and keeps
 * the dsh page's own address on `?open=browser&page=&mode=`, so what Chrome shows is a link that
 * reopens this page in this mode.
 */
export const BROWSER_VIEW_EVENT = 'tracy:browser-view'

/** The detail of one {@link BROWSER_VIEW_EVENT}. */
export interface BrowserViewDetail {
  tabId: string
  sessionId: string
  /** The site workspace this page is (`siteKeyOfBase`); null elsewhere. */
  siteKey: string | null
  /** The address the tab shows (clean: no ticket, no Tracy `?mode=`); null = the view is gone. */
  url: string | null
  mode: BrowserMode
}

/** The site's own parameters a link may carry, minus Tracy's own (ticket, reload nonce; mode apart). */
const LINK_DROPPED_PARAMS = ['tracy_preview', 'tracy_reload']

/**
 * The canonical address of a page a comment is pinned on (TCH contract H4): the address the page
 * reported, without Tracy's own parameters (the ticket, the reload nonce, a deep link's `?mode=`,
 * the same ones the address bar and "Copy link" drop) and without the fragment, which moves inside
 * a document and never names another page. Every other query parameter is the site's (language,
 * post id…) and stays. Two comments are "on the same page" when these strings are equal.
 * @param url - the page address.
 * @returns the canonical address; anything that is not an address comes back as it was.
 */
export function canonicalPageUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(takeModeParam(url).url)
  } catch {
    return url
  }
  // Only when present: `delete` re-serialises the whole query, and the site's own bytes stay as sent.
  for (const name of LINK_DROPPED_PARAMS) if (parsed.searchParams.has(name)) parsed.searchParams.delete(name)
  parsed.hash = ''
  return parsed.href
}

/**
 * The link "Copy link" hands out: the site workspace's door (NOT a session — the reader has their
 * own conversation, and needs a seat on the site anyway), asking for the Browser tab on this page
 * in this mode. `@tracy/dsh-site-tabs` reads it on arrival.
 * @param origin - the dsh page's origin (`location.origin`).
 * @param siteKey - the site workspace this page is.
 * @param url - the address the tab shows.
 * @param mode - the tab's mode.
 * @returns the link, or null when the address is not one.
 */
export function siteDeepLink(origin: string, siteKey: string, url: string, mode: BrowserMode): string | null {
  let parsed: URL
  try {
    parsed = new URL(takeModeParam(url).url)
  } catch {
    return null
  }
  for (const name of LINK_DROPPED_PARAMS) parsed.searchParams.delete(name)
  const page = `${parsed.pathname}${parsed.search}`
  const params = new URLSearchParams({ open: 'browser', page, mode })
  // A query value may carry `/`, `?`, `=` and `:` bare; the path then reads as a path.
  const query = params.toString().replace(/%2F/gi, '/').replace(/%3F/gi, '?').replace(/%3D/gi, '=').replace(/%3A/gi, ':')
  return `${origin}/${encodeURIComponent(siteKey)}/?${query}`
}

/**
 * The tab's settings, from its record first and the localStorage mirror second.
 * @param meta - the tab record's `meta`.
 * @param stored - what the mirror holds for this tab (null = nothing).
 */
export function viewStateOf(meta: unknown, stored: Partial<BrowserViewState> | null): BrowserViewState {
  const record = typeof meta === 'object' && meta !== null ? meta as Record<string, unknown> : {}
  return {
    mode: readMode(record.mode) ?? readMode(stored?.mode) ?? DEFAULT_VIEW_STATE.mode,
    zoom: readZoom(record.zoom) ?? readZoom(stored?.zoom) ?? DEFAULT_VIEW_STATE.zoom,
  }
}

/** How far the stage is scrolled, in the parent's pixels (0/0 wherever nothing scrolls). */
export type StageScroll = { left: number; top: number }

const NO_SCROLL: StageScroll = { left: 0, top: 0 }

/**
 * A box the page reported (in the page's own CSS pixels) in the parent's pixels over the stage's
 * visible area. Two layouts (`frameZoomStyle` in `BrowserView`):
 *   - at or below 100 % the frame keeps the stage's layout box and is scaled from its top centre,
 *     so a point moves toward the centre line: x' = x·f + W·(1 − f)/2, y' = y·f; nothing scrolls;
 *   - above 100 % the frame is scaled from the top-left corner of a canvas of stage × f inside a
 *     scroll box (decision 6: the clipped edges stay reachable), so a point is where the canvas
 *     puts it minus how far the person scrolled: x' = x·f − scrollLeft, y' = y·f − scrollTop.
 *     Scrolled to the centre (scrollLeft = W·(f − 1)/2, the first view) that is the same place the
 *     top-centre formula gives.
 * @param rect - the page's box.
 * @param zoom - percent.
 * @param stageWidth - the stage's (and the unscaled frame's) width in pixels.
 * @param scroll - the stage's scroll offset; omitted = not scrolled.
 */
export function scaleRect(rect: PreviewPickRect, zoom: number, stageWidth: number, scroll: StageScroll = NO_SCROLL): PreviewPickRect {
  const f = zoom / 100
  const originX = f < 1 ? (stageWidth * (1 - f)) / 2 : 0
  return {
    x: rect.x * f + originX - scroll.left,
    y: rect.y * f - scroll.top,
    width: rect.width * f,
    height: rect.height * f,
  }
}

/**
 * The scroll offset that centres a scrolled box (its first view above 100 %).
 * @param scrollSize - the box's `scrollWidth` (or `scrollHeight`).
 * @param clientSize - the box's `clientWidth` (or `clientHeight`).
 */
export function centredScroll(scrollSize: number, clientSize: number): number {
  return Math.max(0, (scrollSize - clientSize) / 2)
}

// ── The localStorage mirror ─────────────────────────────────────────────────────────────────

const STORAGE_PREFIX = 'tracy-browser-view:v1'

function storageKey(sessionId: string, tabId: string): string {
  return `${STORAGE_PREFIX}:${sessionId}:${tabId}`
}

/**
 * What the mirror holds for one tab: its settings, the address it last showed, and its comments
 * (`CommentStore`, stage 3 — kept as `unknown` here because a stored value is never trusted before
 * `restoreCommentStore` has read it).
 */
export type MirroredView = Partial<BrowserViewState> & { url?: string; siteKey?: string; comments?: unknown }

/** What the mirror holds for one tab; null when nothing (or storage is unavailable). */
export function loadViewState(sessionId: string, tabId: string): MirroredView | null {
  try {
    const raw = localStorage.getItem(storageKey(sessionId, tabId))
    if (raw === null) return null
    const value = JSON.parse(raw) as unknown
    return typeof value === 'object' && value !== null ? value as MirroredView : null
  } catch {
    return null
  }
}

/** @returns the address the mirror holds for a tab, or undefined when it holds none. */
export function mirroredAddressOf(stored: MirroredView | null): string | undefined {
  return typeof stored?.url === 'string' && stored.url !== '' ? stored.url : undefined
}

/** Merge a patch into one tab's mirror; a storage that refuses (private window, quota) is not an error. */
function mirror(sessionId: string, tabId: string, patch: MirroredView): void {
  try {
    const next = { ...loadViewState(sessionId, tabId), ...patch }
    localStorage.setItem(storageKey(sessionId, tabId), JSON.stringify(next))
  } catch { /* the tab record still holds it for this page's life */ }
}

/** Mirror one tab's settings, keeping the address already mirrored. */
export function saveViewState(sessionId: string, tabId: string, state: BrowserViewState): void {
  mirror(sessionId, tabId, state)
}

/** Mirror the address one tab shows, keeping its settings. */
export function saveViewAddress(sessionId: string, tabId: string, url: string): void {
  mirror(sessionId, tabId, { url })
}

/** Mirror canonical site identity even before the Browser body mounts. */
export function saveViewIdentity(sessionId: string, tabId: string, siteKey: string, url: string): void {
  mirror(sessionId, tabId, { siteKey, url })
}

/**
 * Drop one tab's mirrored comments (stage 5: they moved to the server), keeping everything else it
 * holds. A storage that refuses is not an error.
 */
export function dropViewComments(sessionId: string, tabId: string): void {
  try {
    const held = loadViewState(sessionId, tabId)
    if (held === null || !('comments' in held)) return
    const { comments: _moved, ...rest } = held
    localStorage.setItem(storageKey(sessionId, tabId), JSON.stringify(rest))
  } catch { /* nothing more to drop */ }
}

/**
 * Mirror one tab's comments (drafts left out), keeping everything else it holds. Quota is not an
 * error. Stage 5: nothing in the view writes it any more — comments live on the server — it stays
 * as the writer of the stage-3/4 shape the one-time move reads (`commentStoreOf`).
 */
export function saveViewComments(sessionId: string, tabId: string, store: CommentStore): void {
  mirror(sessionId, tabId, { comments: persistedCommentStore(store) })
}

/**
 * The tab's comments at mount (TCH contract H2): `meta.comments` when the record holds the key at
 * all — an empty list there is an answer, and beats an older mirror that still has pins the person
 * cleared — else the localStorage mirror (the native Sidebar keeps no `meta` across a page reload).
 * Whatever is read goes through `restoreCommentStore`: another site's store, a wrong version or a
 * malformed comment is dropped, with one warning line naming how many comments were.
 * @param meta - the tab record's `meta`.
 * @param stored - what the mirror holds for this tab.
 * @param siteKey - the site workspace this tab is in.
 * @returns the store to start from (empty when nothing usable was kept).
 */
export function commentStoreOf(meta: unknown, stored: MirroredView | null, siteKey: string): CommentStore {
  const record = typeof meta === 'object' && meta !== null ? meta as Record<string, unknown> : {}
  const raw = record.comments !== undefined ? record.comments : stored?.comments
  if (raw === undefined) return emptyCommentStore(siteKey)
  const { store, dropped } = restoreCommentStore(raw, siteKey)
  if (dropped > 0) console.warn(`[tracy:browser] Edit: ${String(dropped)} kept comment(s) were malformed and dropped`)
  return store ?? emptyCommentStore(siteKey)
}
