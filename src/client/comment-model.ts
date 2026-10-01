/**
 * Comment mode in Tracy's browser tab — the pure half (Tracy, 27/09/2026).
 *
 * The person turns Comment on, points at something on their site, types what should change and
 * presses "Send to Tracy". The picker itself runs INSIDE the customer page (`@tracy/cms-preview`,
 * a cross-origin frame) and draws the outline; this tab keeps the button, the pin and the popover
 * (a text box and Send — Brian's cut-down design, 27/09 pm), and talks to the page over the
 * `tracy-preview` channel (`preview-protocol.generated.ts`).
 *
 * Everything here is a plain function of its arguments — no DOM, no fetch, no timers — so the
 * rules that fail quietly in a browser are held by tests:
 *   - which messages are believed (`readReady`, `readPick`);
 *   - where the preview ticket goes (only into the frame's `src`, `withPreviewTicket`);
 *   - the bounded recovery when a page stops carrying the picker (`recoveryStep`);
 *   - what one comment sends to the chat (`commentSendDetail`), and the plain words the chat chip
 *     shows for it (`plainLabel`). The `content.locate` answer rides along untouched for the agent;
 *     nothing on screen depends on it.
 *
 * The drawing is `packages/dev/tracy-design/src/mockups/browser-comment.mock.stories.tsx`; the plan
 * is `tasks/todo-comment-to-edit.md` (sections S, P3, P4, "UI cắt gọn") in the TCH repository.
 */
import {
  PREVIEW_FEATURES,
  PREVIEW_HIDDEN_REASONS,
  PREVIEW_PICK,
  PREVIEW_PICK_LIMITS,
  isPreviewMessage,
  type PreviewHidden,
  type PreviewPickRect,
  type PreviewPickTarget,
} from './preview-protocol.generated.ts'

// ── Messages from the page ──────────────────────────────────────────────────────────────────

/** The one feature this tab lights a button for. */
export const PICK_FEATURE: (typeof PREVIEW_FEATURES)[number] = 'pick'

/**
 * What a `ready` announcement says, or null when the value is not one.
 *
 * `features` is optional on the wire: a page built before the picker announces `ready` with no
 * list, and must keep its refresh without growing a Comment button.
 * @param data - the `data` of a received message event.
 * @returns the features the page named (possibly empty) and the page address when it sent one.
 */
export function readReady(data: unknown): { features: string[]; url: string | null } | null {
  if (!isPreviewMessage(data, 'ready')) return null
  const message = data as { features?: unknown; url?: unknown }
  const features = Array.isArray(message.features)
    ? message.features.filter((f): f is string => typeof f === 'string')
    : []
  return { features, url: typeof message.url === 'string' ? withoutReloadNonce(message.url) : null }
}

/**
 * One picker event from the page. A `picked` with `moved` is not a pick: it is the picked element's
 * box again, sent while the page scrolls or resizes, and may only move a pick that is open.
 */
export type PickEvent =
  | { kind: 'hover'; target: PreviewPickTarget; url: string | null }
  | { kind: 'picked'; target: PreviewPickTarget; url: string | null; moved: boolean }
  | { kind: 'cancel' }

function isRect(value: unknown): value is PreviewPickRect {
  if (value === null || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every(key => typeof r[key] === 'number' && Number.isFinite(r[key]))
}

/** How much of a container's subtree text a target carries (`INSIDE_MAX`, `@tracy/cms-preview` `protocol.mjs`). */
const INSIDE_CHARS = 200

function cap(text: unknown, limit: number): string {
  return typeof text === 'string' ? text.slice(0, limit) : ''
}

/**
 * The target a page reported, checked field by field and cut to the contract's limits.
 *
 * The page is a customer's site: whatever it posts is data from another origin, so nothing here
 * trusts a shape it did not check. A target without a usable box is not a target — the overlay
 * could not place anything against it.
 * @param value - the `target` field of a pick message.
 * @returns the target, or null.
 */
export function readPickTarget(value: unknown): PreviewPickTarget | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (!isRect(raw.rect)) return null
  const image = raw.image !== null && typeof raw.image === 'object'
    ? { src: cap((raw.image as { src?: unknown }).src, 2048), alt: cap((raw.image as { alt?: unknown }).alt, PREVIEW_PICK_LIMITS.text) }
    : null
  const levels = Array.isArray(raw.levels)
    ? raw.levels.slice(0, PREVIEW_PICK_LIMITS.levels).flatMap((level: unknown) => {
      if (level === null || typeof level !== 'object') return []
      const l = level as Record<string, unknown>
      if (!isRect(l.rect)) return []
      return [{
        tag: cap(l.tag, 32).toLowerCase(),
        mark: typeof l.mark === 'string' ? l.mark.slice(0, 200) : null,
        text: cap(l.text, PREVIEW_PICK_LIMITS.text),
        rect: l.rect,
      }]
    })
    : []
  const marks = Array.isArray(raw.marks)
    ? raw.marks.filter((m): m is string => typeof m === 'string').slice(0, PREVIEW_PICK_LIMITS.marks).map(m => m.slice(0, 200))
    : []
  const level = typeof raw.level === 'number' && Number.isInteger(raw.level) && raw.level >= 0 ? raw.level : 0
  // Kept whole at the cap: the page already cut a longer one and ended it in "…", and a second cut
  // here would drop that mark, so the agent would read a cut text as a whole one.
  const inside = typeof raw.inside === 'string' ? cap(raw.inside, INSIDE_CHARS) : ''
  // Runtime 14: what the page calls an element with no words (`name`), and why it must not be drawn
  // over (`hidden`, one of the contract's reasons, else nothing).
  const name = typeof raw.name === 'string' ? cap(raw.name, PREVIEW_PICK_LIMITS.text) : ''
  const hidden = (PREVIEW_HIDDEN_REASONS as readonly unknown[]).includes(raw.hidden) ? raw.hidden as PreviewHidden : null
  return {
    text: cap(raw.text, PREVIEW_PICK_LIMITS.text),
    ...(inside === '' ? {} : { inside }),
    ...(name.trim() === '' ? {} : { name }),
    ...(hidden === null ? {} : { hidden }),
    tag: cap(raw.tag, 32).toLowerCase(),
    image: image !== null && image.src !== '' ? image : null,
    domPath: cap(raw.domPath, 400),
    selector: cap(raw.selector, 400),
    rect: raw.rect,
    marks,
    levels,
    level: levels.length > 0 ? Math.min(level, levels.length - 1) : 0,
  }
}

/**
 * A picker event from the page, or null when the value is not one (or is malformed).
 *
 * `url` is read when a page sends it (the page's own address after in-frame navigation); the
 * contract does not require it, and without it the tab falls back to its address bar. `moved` is
 * true only for a `picked` the page sent again because the element's box moved (`moved: true` on
 * the wire; `@tracy/cms-preview` runtime 4+).
 * @param data - the `data` of a received message event.
 * @returns the event.
 */
export function readPick(data: unknown): PickEvent | null {
  if (isPreviewMessage(data, PREVIEW_PICK.cancel)) return { kind: 'cancel' }
  const kind = isPreviewMessage(data, PREVIEW_PICK.hover) ? 'hover' : isPreviewMessage(data, PREVIEW_PICK.picked) ? 'picked' : null
  if (kind === null) return null
  const message = data as { target?: unknown; url?: unknown; moved?: unknown }
  const target = readPickTarget(message.target)
  if (target === null) return null
  const url = typeof message.url === 'string' ? withoutReloadNonce(message.url) : null
  return kind === 'hover' ? { kind, target, url } : { kind, target, url, moved: message.moved === true }
}

// ── The preview ticket ──────────────────────────────────────────────────────────────────────

/** The query parameter the site proxy reads the ticket from (and strips with a 303). */
export const PREVIEW_TICKET_PARAM = 'tracy_preview'

/**
 * The frame address carrying a ticket.
 *
 * 🔒 THIS STRING GOES INTO THE IFRAME'S `src` AND NOWHERE ELSE. Not into the tab record
 * (`updateTab`, which agents can read), not into the address bar, not into the back/forward
 * stack, not into the chat. The site proxy trades it for a host-only cookie and answers 303 to
 * the same address without it, so the page itself never sees it.
 * @param url - the page address.
 * @param ticket - the ticket the ticket door handed out.
 * @returns the address to load.
 */
export function withPreviewTicket(url: string, ticket: string): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.set(PREVIEW_TICKET_PARAM, ticket)
    return parsed.href
  } catch {
    return url
  }
}

// ── The reload nonce ────────────────────────────────────────────────────────────────────────

/** The query parameter a reload adds so the browser asks the site again instead of its cache. */
export const RELOAD_NONCE_PARAM = 'tracy_reload'

let reloadCount = 0

/**
 * The frame address for a reload that must reach the site.
 *
 * 🔒 ASSIGNING `src` ITS OWN VALUE REPLAYS WHATEVER THE BROWSER KEPT FOR IT (28/09/2026). A site
 * copy once answered `/` with a 301 to the source site; Chrome kept it, and every reload of `/`
 * followed it again without a request, so the tab showed a broken page while the site answered
 * 200. A parent cannot force a hard reload of a cross-origin frame, but an address the cache has
 * never seen always goes to the network. Like the ticket, this lives in the iframe's `src` only:
 * the tab's address stays clean, and what the page reports back has it removed
 * ({@link withoutReloadNonce}).
 * @param url - the address the frame shows.
 * @param nonce - override for tests; a fresh value otherwise.
 * @returns the address to load.
 */
export function withReloadNonce(url: string, nonce?: string): string {
  try {
    const parsed = new URL(url)
    reloadCount += 1
    parsed.searchParams.set(RELOAD_NONCE_PARAM, nonce ?? `${Date.now().toString(36)}${reloadCount.toString(36)}`)
    return parsed.href
  } catch {
    return url
  }
}

/**
 * A page address as the page reported it, without the reload nonce: it must not reach a link, a
 * content lookup or the agent's message.
 * @param url - the address the page sent.
 * @returns the same address minus {@link RELOAD_NONCE_PARAM}.
 */
export function withoutReloadNonce(url: string): string {
  try {
    const parsed = new URL(url)
    if (!parsed.searchParams.has(RELOAD_NONCE_PARAM)) return url
    parsed.searchParams.delete(RELOAD_NONCE_PARAM)
    return parsed.href
  } catch {
    return url
  }
}

/** What the ticket door's status means for the tab. */
export type TicketAnswer =
  | { kind: 'ticket'; ticket: string; exp: number }
  /** 404: the feature is off on this deployment. No Comment button, and no point asking again. */
  | { kind: 'off' }
  /** 400/401/403: this viewer may not pick here (signed out, no seat, a role that cannot edit). */
  | { kind: 'refused' }
  /** Anything else, or no answer in time: load the page as before, no button. */
  | { kind: 'error' }

/**
 * Read the ticket door's answer.
 * @param status - HTTP status.
 * @param body - the parsed JSON body (anything).
 * @returns what the tab should do.
 */
export function ticketAnswerOf(status: number, body: unknown): TicketAnswer {
  if (status === 200) {
    const b = body as { ticket?: unknown; exp?: unknown } | null
    if (b !== null && typeof b === 'object' && typeof b.ticket === 'string' && b.ticket !== '') {
      return { kind: 'ticket', ticket: b.ticket, exp: typeof b.exp === 'number' ? b.exp : 0 }
    }
    return { kind: 'error' }
  }
  if (status === 404) return { kind: 'off' }
  if (status === 400 || status === 401 || status === 403) return { kind: 'refused' }
  return { kind: 'error' }
}

/**
 * The site key of the dsh page this tab is drawn in, from its `<base href="/<siteKey>/">`.
 *
 * tracy-web serves each site's workspace under its key and the creation workspace under `/new/`
 * (`apps/tracy-web/src/workspace/scope.js`); a page with no base, or at the bare root, is not a
 * site workspace, and has no ticket door to ask.
 * @param baseUri - `document.baseURI`.
 * @param origin - `location.origin`; a base on another origin is not this page's mount.
 * @returns the key, or null.
 */
export function siteKeyOfBase(baseUri: string | undefined, origin: string | undefined): string | null {
  if (baseUri === undefined || baseUri === '') return null
  let parsed: URL
  try {
    parsed = new URL(baseUri)
  } catch {
    return null
  }
  if (origin !== undefined && parsed.origin !== origin) return null
  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments.length !== 1) return null
  const key = decodeURIComponent(segments[0]!)
  if (key === 'new' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)) return null
  return key
}

// ── Which `ready` is news (measured on the stand, 27/09/2026) ─────────────────────────────

/**
 * How long after a frame `load` a second announcement still counts as the same document's.
 *
 * A page with the picker posts `ready {features:['pick']}` TWICE per load — once when its script
 * starts, once on `pageshow` — about 100 ms apart, and the `pageshow` one usually lands AFTER the
 * frame's `load` event. Counting it as news would carry "announced" into the NEXT load and hide a
 * page that lost its picker (the continuation cookie ran out) from the recovery below.
 */
export const READY_ECHO_MS = 1_500

/** What the tab remembers about announcements, per frame load. */
export interface ReadyState {
  /** A fresh announcement arrived since the last frame `load` (it belongs to the coming load). */
  pending: boolean
  /** When the last frame `load` fired (ms, any clock), or null before the first. */
  lastLoadAt: number | null
  /** Whether that load's document announced the picker (before or just after its `load`). */
  lastLoadAnnounced: boolean
  /** The address the last announcement named (runtime 4+), or null. */
  lastUrl?: string | null
}

export const READY_START: ReadyState = { pending: false, lastLoadAt: null, lastLoadAnnounced: false, lastUrl: null }

/**
 * One step of the announcement tracker. Pure; `now` comes from the caller.
 *
 * - `ready`: `fresh` says whether this announcement is news (a new document), so the tab resets
 *   what was picked and sends `pick-start` again; an echo is ignored entirely. A back/forward
 *   restore announces on `pageshow` with no `load`, and is news.
 * - `load`: `announced` says whether the document that just finished loading announced the picker
 *   (the recovery watches a load that did not).
 * @param state - the tracker.
 * @param event - a `ready` naming `pick`, or a frame `load`.
 * @returns the next state, and `fresh` (ready) or `announced` (load).
 */
export function readyStep(state: ReadyState, event: { type: 'ready' | 'load'; now: number; url?: string | null }): { state: ReadyState; fresh: boolean; announced: boolean } {
  if (event.type === 'load') {
    return { state: { pending: false, lastLoadAt: event.now, lastLoadAnnounced: state.pending, lastUrl: state.lastUrl ?? null }, fresh: false, announced: state.pending }
  }
  // Round 5 (runtime 14 `route`, acceptance v3 J16): a page announcing ANOTHER address than its last
  // announcement changed its route without loading (a single-page site's pushState) — news, however
  // close to the last one; the pins and the pick follow the new address. It belongs to the document
  // already announced, so nothing is carried into the next load (the recovery still sees a silent one).
  const url = typeof event.url === 'string' ? event.url : null
  if (url !== null && state.lastUrl != null && url !== state.lastUrl) {
    return { state: { ...state, lastUrl: url }, fresh: true, announced: false }
  }
  if (url !== null) state = { ...state, lastUrl: url }
  if (state.pending) return { state, fresh: false, announced: false }
  const sinceLoad = state.lastLoadAt === null ? Infinity : event.now - state.lastLoadAt
  if (sinceLoad < READY_ECHO_MS) {
    // Just after a load: the `pageshow` echo of that document, or its first (late) announcement.
    if (state.lastLoadAnnounced) return { state, fresh: false, announced: false }
    return { state: { ...state, lastLoadAnnounced: true }, fresh: true, announced: false }
  }
  return { state: { ...state, pending: true }, fresh: true, announced: false }
}

/**
 * Whether the document in the frame loaded without announcing the picker — the page a lapsed
 * continuation cookie leaves behind: no picker script, so no `ready` is coming, and a `pick-start`
 * posted into it is heard by nobody.
 *
 * - `none`: nothing loaded yet, or the document announced the picker (or a newer one did).
 * - `settling`: it loaded without announcing less than {@link READY_ECHO_MS} ago. Its announcement
 *   may still come: the `pageshow` one lands just after the load, and a page's first one can be
 *   credited to the load before it (the blank frame loaded while the ticket was asked).
 * - `silent`: it loaded that long ago or more and has never announced.
 * @param state - the announcement tracker ({@link readyStep}).
 * @param now - the current time, on the clock `readyStep` was given.
 * @returns how silent the document is.
 */
export function silenceOf(state: ReadyState, now: number): 'none' | 'settling' | 'silent' {
  if (state.lastLoadAt === null || state.pending || state.lastLoadAnnounced) return 'none'
  return now - state.lastLoadAt < READY_ECHO_MS ? 'settling' : 'silent'
}

/**
 * Which pick a page report belongs to: the document it came from (the tab counts one per fresh
 * `ready`) and the element's selector.
 */
export interface PickIdentity {
  doc: number
  selector: string
}

/**
 * Whether two reports are the same element of the same document — a pick whose box moved, not a new
 * pick. A selector names a position in ONE document: the `h1` of another page, or of this page
 * reloaded after the agent changed it, is another element, and inherits nothing from the first
 * (not its `content.locate` answer, whose ids the chat turn would carry).
 * @param a - the pick held, or null.
 * @param b - the report that came in.
 * @returns true when `b` is `a` again.
 */
export function sameElement(a: PickIdentity | null, b: PickIdentity): boolean {
  return a !== null && a.doc === b.doc && a.selector === b.selector
}

/**
 * Whether two addresses show the same page: origin, path and query equal; the fragment ignored (it
 * moves within a document and never loads a new one).
 * @param a - one address.
 * @param b - the other.
 * @returns true for the same page.
 */
export function samePage(a: string, b: string): boolean {
  try {
    const x = new URL(a)
    const y = new URL(b)
    return x.origin === y.origin && x.pathname === y.pathname && x.search === y.search
  } catch {
    return a === b
  }
}

// ── Bounded recovery (plan §S) ──────────────────────────────────────────────────────────────

/** How long a load may go without a `ready` naming `pick` while Comment is on. */
export const RECOVERY_WAIT_MS = 5_000

/**
 * Where the tab stands on "does the page in the frame carry the picker right now".
 *
 * - `idle`: nothing to watch (Comment off, or the last load announced the picker).
 * - `watching`: a load finished while Comment was on and did not announce the picker; the 5 s
 *   timer runs.
 * - `unavailable`: a fresh ticket and one reload did not bring the picker back. The button says
 *   so and nothing retries until the address changes or the person presses Comment again.
 *
 * `retried` is the "once" in "reload once": it is set by the reload and cleared only by a new
 * address or a press.
 */
export interface RecoveryState {
  status: 'idle' | 'watching' | 'unavailable'
  retried: boolean
}

export const RECOVERY_START: RecoveryState = { status: 'idle', retried: false }

export type RecoveryEvent =
  /** A FRESH `ready` with `pick` (see {@link readyStep}). */
  | { type: 'ready-pick' }
  /** The frame fired `load`; whether Comment is on, and whether that document announced the picker. */
  | { type: 'load'; commentOn: boolean; announced: boolean }
  /** The 5 s timer ran out. */
  | { type: 'timeout' }
  /** The person pressed Comment while the button said unavailable. */
  | { type: 'press-unavailable' }
  /**
   * The person turned Edit on over a document that loaded without announcing the picker
   * ({@link silenceOf}) — its cookie lapsed while the tab was in Interactive, where no load is
   * watched, so nothing else would ever notice. `settled`: silent past the echo window.
   */
  | { type: 'press-silent'; settled: boolean }
  /** A new address, or Comment turned off: forget everything. */
  | { type: 'reset' }

export type RecoveryEffect =
  | { type: 'start-timer' }
  | { type: 'cancel-timer' }
  /** Ask for a new ticket and load the page again with it. */
  | { type: 'reload-with-ticket' }
  | { type: 'warn'; reason: string }

/**
 * One step of the bounded recovery. Pure: the caller runs the effects (timers, fetch, reload).
 *
 * Why it exists: the picker's continuation cookie lapses (with the Tracy session it was issued under
 * since 29/09/2026, after fifteen minutes before that); the next load after that carries no picker
 * script at all, so there is no `ready` to wait for — only its absence. The
 * tab notices the absence, trades a fresh ticket for one reload, and stops there: a page that
 * still has no picker (a site on another host, a proxy that refuses) must not loop.
 * @param state - the current state.
 * @param event - what happened.
 * @returns the next state and the effects to run.
 */
export function recoveryStep(state: RecoveryState, event: RecoveryEvent): { state: RecoveryState; effects: RecoveryEffect[] } {
  switch (event.type) {
    // 🔒 A PICKER THAT ANSWERED CLEARS THE RETRY (28/09/2026). `retried` was carried through, so only
    // the FIRST cookie expiry on a tab ever recovered: the picker's continuation cookie lasts about
    // fifteen minutes, and from the second expiry on the tab had already "used" its one reload and
    // silently stopped offering to pick. A `ready` says the trade worked, which is the thing the cap
    // exists to stop looping on — a page that still has no picker never reaches here, so it still
    // cannot loop.
    case 'ready-pick':
      if (state.status === 'watching') return { state: { status: 'idle', retried: false }, effects: [{ type: 'cancel-timer' }] }
      if (state.status === 'unavailable') return { state: { status: 'idle', retried: false }, effects: [] }
      return { state: { status: state.status, retried: false }, effects: [] }
    case 'load': {
      const wasWatching = state.status === 'watching'
      if (!event.commentOn || event.announced) {
        const status = state.status === 'unavailable' ? 'unavailable' : 'idle'
        return { state: { status, retried: state.retried }, effects: wasWatching ? [{ type: 'cancel-timer' }] : [] }
      }
      if (state.status === 'unavailable') return { state, effects: [] }
      // (Re)start: a second silent load while watching gets its own full wait.
      return { state: { status: 'watching', retried: state.retried }, effects: [{ type: 'start-timer' }] }
    }
    case 'timeout':
      if (state.status !== 'watching') return { state, effects: [] }
      if (!state.retried) {
        return {
          state: { status: 'idle', retried: true },
          effects: [
            { type: 'warn', reason: `no picker announcement within ${RECOVERY_WAIT_MS / 1000} s of a load; reloading once with a new preview ticket` },
            { type: 'reload-with-ticket' },
          ],
        }
      }
      return {
        state: { status: 'unavailable', retried: true },
        effects: [{ type: 'warn', reason: 'still no picker announcement after one reload with a new preview ticket; Comment is unavailable until the address changes or Comment is pressed again' }],
      }
    case 'press-unavailable':
      return { state: { status: 'idle', retried: true }, effects: [{ type: 'reload-with-ticket' }] }
    case 'press-silent':
      // A load being watched already has its timer, and its one reload.
      if (state.status === 'watching') return { state, effects: [] }
      // Its announcement may still be on its way: watch it as a silent load in Edit is watched.
      if (!event.settled && state.status === 'idle') {
        return { state: { status: 'watching', retried: state.retried }, effects: [{ type: 'start-timer' }] }
      }
      // The reload a watched load would have earned, and the same "once": if it brings no picker
      // back, the load after it is watched and ends unavailable.
      return {
        state: { status: 'idle', retried: true },
        effects: [
          { type: 'warn', reason: 'Edit turned on over a page that loaded without the picker; reloading once with a new preview ticket' },
          { type: 'reload-with-ticket' },
        ],
      }
    case 'reset':
      return { state: RECOVERY_START, effects: state.status === 'watching' ? [{ type: 'cancel-timer' }] : [] }
  }
}

// ── What the chat chip calls the pick ─────────────────────────────────────────────────────

function shorten(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/** How long a quoted excerpt of the element's own words may be (quotes not counted). */
export const EXCERPT_CHARS = 40

/**
 * The record a `resolved` answer names, in a site owner's words (`Menu item "Services"`), or null.
 *
 * The answer lists its levels innermost first and ends with the record itself
 * (`apps/tracy-web/src/sites/content-locate.js` `levelsOf`).
 * @param locate - the raw `content.locate` answer, or null.
 * @returns the label, or null for any other answer.
 */
export function resolvedLabel(locate: unknown): string | null {
  if (locate === null || typeof locate !== 'object') return null
  const raw = locate as { status?: unknown; levels?: unknown }
  if (raw.status !== 'resolved' || !Array.isArray(raw.levels)) return null
  const last = raw.levels.at(-1) as { label?: unknown; name?: unknown } | undefined
  const label = typeof last?.label === 'string' ? last.label : typeof last?.name === 'string' ? last.name : ''
  return label.trim() !== '' ? shorten(label, 160) : null
}

/**
 * What the pick is called in plain words — never an HTML tag, never a status word.
 *
 * The INNERMOST meaningful name (round 5, acceptance v3 K05; decided by the agent while Brian slept):
 * the record's label when the record IS the element (a menu item, a module); the element's own name
 * when the record is only where it sits — a page, an article, a post, a shared template part — however
 * many levels (a field, a block) the answer found inside that record: its words
 * quoted (`"13 subsidiaries"`), else the page's plain name for it (runtime 14 `name`: an icon button's
 * accessible name, an image's caption, an embed), else the words inside it; an image is its alt, its
 * caption or `image` (round 9). Only an element with no name of its own falls back to the record, in
 * plain words (`Home page`), and never to a field path (`Home › hero.img`).
 *
 * The chat input picks the locate level it tells the agent about by this label when it equals a
 * level's (`comment-turn.mjs` `readLocate`); a label naming the element itself matches none, so the
 * agent is pointed at the innermost level (the field) instead of the whole page — "It's the Home page"
 * was the answer to an image picked with the label `page "Home"`.
 * @param target - what the page reported.
 * @param locate - the raw `content.locate` answer, or null.
 * @returns the label (possibly empty).
 */
export function plainLabel(target: PreviewPickTarget, locate: unknown): string {
  const raw = resolvedLabel(locate)
  // 🔒 NEVER A FIELD PATH (round 9, acceptance v5 V5S-5): a level named `Home › hero.img` is the
  // server's crumb for the agent, not words a person reads — an answer whose last level is a field or
  // a block names nothing here.
  const record = raw === null || FIELD_PATH.test(raw) ? null : raw
  const own = ownName(target)
  if (record !== null && !(own !== '' && containerRecord(record))) return plainRecord(record)
  return own || (record === null ? '' : plainRecord(record))
}

/** A locate level's crumb (`Home › hero.img`, `Home › hero`): a record's name, `›`, a field or block key. */
const FIELD_PATH = /\s›\s/

/** The container record kinds and how a person says each (`page "Home"` → `Home page`). */
const CONTAINER = /^(page|article|post|shared|template part|template|layout) "(.*)"$/is

/** A record label naming where an element sits rather than what it is (`page "Home"`, `shared "Header"`). */
function containerRecord(label: string): boolean {
  return CONTAINER.test(label.trim())
}

/**
 * A record label in plain words (round 9, V5S-5): `page "Home"` → `Home page`, `article "News"` →
 * `News article`, `post "Hello"` → `Hello post`; a shared part, template or layout by its name alone.
 * Any other record (`Menu item "Services"`) is already words and stays as it is.
 */
function plainRecord(label: string): string {
  const m = CONTAINER.exec(label.trim())
  if (m === null) return label
  const kind = m[1]!.toLowerCase()
  const name = m[2]!.trim()
  if (name === '') return label
  return kind === 'page' || kind === 'article' || kind === 'post' ? `${name} ${kind}` : name
}

/**
 * What the element names itself with: its words, else the page's plain name for it, else the words
 * inside it. An image (round 9, acceptance v5 V5S-5): its alt, else its caption (the page's `name`),
 * else `image` — never its file name, which no person gave it (`hero-ru-1024x640.png`).
 */
function ownName(target: PreviewPickTarget): string {
  if (target.text.trim() !== '') return `"${shorten(target.text, EXCERPT_CHARS)}"`
  const name = target.name?.trim() ?? ''
  if (target.image !== null) {
    if (target.image.alt.trim() !== '') return shorten(target.image.alt, EXCERPT_CHARS)
    return name !== '' ? shorten(name, 80) : 'image'
  }
  if (name !== '') return shorten(name, 80)
  const inside = target.inside?.trim() ?? ''
  if (inside !== '') return `"${shorten(inside.replace(/…$/, ''), EXCERPT_CHARS)}"`
  return ''
}

// ── Placing the overlay against the page's box ──────────────────────────────────────────────

/** A box the page reported, with why it must not be drawn over when it said so (runtime 14 `clip`). */
export type ShownRect = PreviewPickRect & { hidden?: PreviewHidden }

/**
 * Whether a box the page reported may carry a pin: not when the page said the block is `clipped` (a
 * box that scrolls itself has it out of sight) or `covered` (its top-left corner lies under a fixed bar
 * or an open menu of the page — acceptance v3 B13, PICK-new-4).
 * @param rect - the reported box.
 */
export function pinnable(rect: ShownRect): boolean {
  return rect.hidden === undefined
}

/**
 * Whether a popover or thread card stands by this box: not when the page said the block is `clipped`
 * — not shown at all (a closed menu or tab, an offcanvas slid away, a nested box scrolled past it) —
 * then the box waits at the frame's corner with its words, as for a pick the page cannot find
 * (acceptance v3 B04, J06, J38: a WordPress menu closes as soon as focus moves to the popover, and its
 * words must stay in sight). `covered` keeps it by the block: it sits under the block, not at its corner.
 * @param rect - the reported box, or the pick's target.
 */
export function anchored(rect: ShownRect | { hidden?: PreviewHidden }): boolean {
  return rect.hidden !== 'clipped'
}

/**
 * Where a popover or thread card stands for its element (round 8, acceptance v5 JS-v5-new-1, J38;
 * decided by the agent while Brian slept). A hover menu — Joomla T4's mega menu, WordPress's — closes
 * as the pointer leaves it on the way to the popover; the popover then jumped to the frame's corner,
 * the click meant for it landed on the page, and the empty popover closed with the pick. Now:
 * - shown (or only `covered`): by the element;
 * - hidden (`clipped`) after it was seen in this document: where it was last seen, `gone` — the
 *   page's outline is off, and the box's head names the element (`hiddenName`), so a WordPress mobile
 *   menu that closes when the popover takes the focus still says what was picked;
 * - hidden and never seen in this document (opened from the Comments tab on a closed menu, a new
 *   document), or not reported at all: no place (`rect: null`) — the frame's top corner.
 * @param rect - the box the page reported now (page pixels), or undefined when none.
 * @param seen - where it was last reported shown in this document, or null.
 */
export function boxStand(rect: ShownRect | undefined, seen: PreviewPickRect | null): { rect: ShownRect | null; gone: boolean } {
  if (rect === undefined) return { rect: null, gone: false }
  if (anchored(rect)) return { rect, gone: false }
  return { rect: seen, gone: true }
}

/**
 * The element in plain words for a box's head while it is hidden (`boxStand` `gone`): its words, else
 * the page's name for it, its image, the words inside it — unquoted and short — else its tag.
 * @param target - what the page reported when it was picked.
 */
export function hiddenName(target: PreviewPickTarget): string {
  const own = ownName(target).replace(/^"(.*)"$/s, '$1').trim()
  return own === '' ? target.tag : shorten(own, EXCERPT_CHARS)
}

/** How long a place the box just left still counts as where the person aimed a click, in ms. */
export const AIMED_MS = 700

/** One place a popover or thread card stood, in the layer's pixels, and since when (`Date.now()`). */
export interface BoxTrail {
  left: number
  top: number
  width: number
  height: number
  at: number
}

/**
 * Whether a click the page reported (`pick-outside`, turned into the layer's pixels) was aimed at the
 * open box: it lands where the box stands, or stood less than {@link AIMED_MS} ago (round 8, acceptance
 * v5 JS-v5-new-1: the box moved from under a pointer on its way to it, and the click went to the page).
 * Such a click is not a click outside: the box keeps its words and takes the focus.
 * @param point - the click, in the layer's pixels.
 * @param trail - the places the box stood, oldest first; the last is where it stands now.
 * @param now - `Date.now()`.
 */
export function aimedAtBox(point: { x: number; y: number }, trail: readonly BoxTrail[], now: number): boolean {
  return trail.some((box, i) => {
    const left = trail[i + 1]?.at
    if (left !== undefined && now - left > AIMED_MS) return false
    return point.x >= box.left && point.x <= box.left + box.width && point.y >= box.top && point.y <= box.top + box.height
  })
}

/** How far the page's outline sits outside the element (the drawing's `-inset-1.5`). */
export const OUTLINE_GAP = 6
/** The popover's width in the drawing. */
export const POPOVER_WIDTH = 300
/** The width of a popover with the many-comments foot (stories `PickedWithAdd`, `PinEditing`). */
export const POPOVER_WIDTH_MULTI = 360

/**
 * Below this FRAME width the Browser tab draws compact (plan rule 6; stories `PickedCompact ·
 * TwoPinsPendingCompact`): the wide popover (360 px + margins) would cover over 64 % of the frame.
 * Measured on the frame, never the window — the right panel can be narrow on a wide screen.
 */
export const COMPACT_BELOW = 600

/**
 * Whether a frame this wide draws compact. 0 is a frame not measured yet (or where nothing lays
 * out): wide, as before.
 * @param frameWidth - the frame's `clientWidth`.
 */
export function isCompactFrame(frameWidth: number): boolean {
  return frameWidth > 0 && frameWidth < COMPACT_BELOW
}

/** Below this FRAME width the mode bar drops its zoom chip (Brian 29/09: the bar overflows at 320 otherwise). */
export const ZOOM_CHIP_BELOW = 360

/**
 * Whether a frame is too narrow for the zoom chip (under {@link ZOOM_CHIP_BELOW}; 0 = not measured yet).
 * @param frameWidth - the frame's `clientWidth`.
 */
export function hidesZoomChip(frameWidth: number): boolean {
  return frameWidth > 0 && frameWidth < ZOOM_CHIP_BELOW
}

/**
 * The compact popover's width: 260 px, at most 60 % of the frame, never under 240 px.
 * @param frameWidth - the frame's `clientWidth`.
 */
export function compactPopoverWidth(frameWidth: number): number {
  return Math.max(240, Math.min(260, Math.floor(0.6 * frameWidth)))
}

/**
 * Where the popover goes: 10 px under the outline (over it when the frame has no room below),
 * aligned to the outline's nearer side, and inside the frame while the outline is in view — once the
 * page scrolled the outline out of the frame, the popover leaves with it.
 * @param rect - the element's box in the frame's viewport.
 * @param frame - the frame's size.
 * @param popoverHeight - the popover's height (measured, or an estimate before the first paint).
 * @param preferredWidth - the width it takes when the frame has room ({@link POPOVER_WIDTH} by default).
 * @param anchor - `'pin'` for a saved comment reopened (its pin sits on the outline's top-right corner):
 *   the popover ends at that corner whenever the frame has room for it, so on a block wider than the
 *   popover it opens by the pin that was clicked, not at the block's far side. `'box'` (default): the
 *   nearer side, as for a new pick.
 * @returns left/top inside the frame, the width to use, and which way it opened.
 */
export function popoverPlacement(
  rect: PreviewPickRect,
  frame: { width: number; height: number },
  popoverHeight: number,
  preferredWidth: number = POPOVER_WIDTH,
  anchor: 'box' | 'pin' = 'box',
): { left: number; top: number; width: number; above: boolean; align: 'left' | 'right' } {
  const margin = 8
  const width = Math.max(200, Math.min(preferredWidth, frame.width - margin * 2))
  const outline = { left: rect.x - OUTLINE_GAP, right: rect.x + rect.width + OUTLINE_GAP, top: rect.y - OUTLINE_GAP, bottom: rect.y + rect.height + OUTLINE_GAP }
  const byPin = anchor === 'pin' && outline.right - width >= margin
  const align: 'left' | 'right' = byPin || frame.width - outline.right < outline.left ? 'right' : 'left'
  let left = align === 'right' ? outline.right - width : outline.left
  left = Math.max(margin, Math.min(left, frame.width - width - margin))
  const below = frame.height - (outline.bottom + 10)
  const aboveRoom = outline.top - 10
  const above = below < popoverHeight && aboveRoom > below
  let top = above ? outline.top - 10 - popoverHeight : outline.bottom + 10
  // Kept inside the frame while its element's outline is in view; once the page has scrolled the
  // outline out, the popover goes with it instead of hanging on the frame's edge over other content
  // (Brian 30/09/2026: "it must follow the element exactly").
  const inView = outline.bottom > 0 && outline.top < frame.height
  if (inView) top = Math.max(margin, Math.min(top, frame.height - popoverHeight - margin))
  return { left, top, width, above, align }
}

/** The least height a thread card is capped to, whatever the room beside its element (round 6). */
export const THREAD_CARD_MIN = 160

/**
 * How tall a thread card may be so it fits beside its element instead of over it (round 6, acceptance
 * v4 thread: a card of 7+ messages covered the element it is about). The larger room — under the
 * outline or over it, with the popover's 10 px gap and the frame's 8 px margin — never under
 * {@link THREAD_CARD_MIN}; its message list scrolls inside (TH-5). Undefined (the CSS cap alone) for a
 * whole-page comment, an element out of view, or a frame not measured yet.
 * @param rect - the element's box in the frame's viewport, or null.
 * @param frame - the frame's size.
 */
export function threadCardMaxHeight(rect: PreviewPickRect | null, frame: { width: number; height: number }): number | undefined {
  if (rect === null || frame.height <= 0) return undefined
  const top = rect.y - OUTLINE_GAP
  const bottom = rect.y + rect.height + OUTLINE_GAP
  if (bottom <= 0 || top >= frame.height) return undefined
  const margin = 8
  const room = Math.max(frame.height - (bottom + 10) - margin, top - 10 - margin)
  return Math.max(THREAD_CARD_MIN, Math.floor(room))
}

// ── Sending one comment to the chat (plan §P4 contract) ────────────────────────────────────

/** The window event the chat input listens for. */
export const COMMENT_SEND_EVENT = 'tracy:comment-send'
export const COMMENT_SENT_EVENT = 'tracy:comment-sent'
export const COMMENT_FAILED_EVENT = 'tracy:comment-failed'
/** How long the tab waits for either answer before it says the chat did not answer. */
export const COMMENT_SEND_TIMEOUT_MS = 10_000
/**
 * The same wait when the message carries files (v4): the chat input answers only once dsh has
 * uploaded every non-image file, which takes as long as the network does.
 */
export const COMMENT_SEND_FILES_TIMEOUT_MS = 120_000

/**
 * The failure codes the chat input answers with, plus `timeout` from this side. `too-long` (stage 3,
 * TCH contract H5): a batch of comments whose chat turn would not fit even trimmed.
 */
// `attachment-too-large` / `attachment-failed`: a v4 send's files over dsh's limits, or one that did not
// upload (TCH attachments contract §B).
export const COMMENT_FAILURE_CODES = ['no-session', 'site-mismatch', 'subagent-readonly', 'rejected', 'timeout', 'no-listener', 'too-long', 'attachment-too-large', 'attachment-failed'] as const
export type CommentFailureCode = (typeof COMMENT_FAILURE_CODES)[number] | 'unknown'

/**
 * How long Send waits for the pick's `content.locate` answer before it sends without one. The
 * answer only saves the agent a lookup: its tool guidance tells it to call `content.locate` itself
 * when the comment carries none, so a slow index must never hold the person's words back.
 */
export const LOCATE_WAIT_MS = 3_000

export interface CommentSendDetail {
  v: 1
  requestId: string
  sessionId: string
  siteKey: string | null
  text: string
  element: {
    url: string
    selector: string
    /** Plain words for the chip ({@link plainLabel}). */
    label: string
    text: string
    /** A container's words when `text` is empty (see `readPickTarget`). */
    inside?: string
    rect: PreviewPickRect
    marks: string[]
  }
  /** The locate answer as the server gave it; null when it failed or did not come in time. */
  locate: Record<string, unknown> | null
  mode: 'queue'
}

/**
 * The detail of one `tracy:comment-send`.
 * @param input - everything the tab knows at the press.
 * @returns the detail to dispatch.
 */
export function commentSendDetail(input: {
  requestId: string
  sessionId: string
  siteKey: string | null
  text: string
  url: string
  target: PreviewPickTarget
  locate: unknown
}): CommentSendDetail {
  const { target } = input
  const locate = input.locate !== null && typeof input.locate === 'object' ? input.locate as Record<string, unknown> : null
  return {
    v: 1,
    requestId: input.requestId,
    sessionId: input.sessionId,
    siteKey: input.siteKey,
    text: input.text.trim(),
    element: {
      url: input.url,
      selector: target.selector,
      label: plainLabel(target, locate),
      text: target.text,
      ...(target.inside === undefined ? {} : { inside: target.inside }),
      rect: target.rect,
      marks: target.marks,
    },
    locate,
    mode: 'queue',
  }
}

/**
 * Read an answer event's detail for one request.
 * @param type - the event type.
 * @param detail - the event's `detail`.
 * @param requestId - the request waited for.
 * @returns the outcome, or null when the event is about another request.
 */
export function readCommentAnswer(type: string, detail: unknown, requestId: string): { ok: true; queued: boolean } | { ok: false; code: CommentFailureCode } | null {
  if (detail === null || typeof detail !== 'object') return null
  const d = detail as { requestId?: unknown; queued?: unknown; code?: unknown }
  if (d.requestId !== requestId) return null
  if (type === COMMENT_SENT_EVENT) return { ok: true, queued: d.queued === true }
  if (type === COMMENT_FAILED_EVENT) {
    const code = (COMMENT_FAILURE_CODES as readonly unknown[]).includes(d.code) ? d.code as CommentFailureCode : 'unknown'
    return { ok: false, code }
  }
  return null
}

/** The parameters `content.locate` is asked with, from a picked target. */
export function locateParams(target: PreviewPickTarget, url: string): Record<string, unknown> {
  return {
    url,
    text: target.text,
    image: target.image,
    marks: target.marks,
    domPath: target.domPath,
    selector: target.selector,
  }
}
