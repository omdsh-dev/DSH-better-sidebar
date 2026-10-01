/**
 * The comments of one Browser tab — the pure store (Tracy, 28/09/2026; people-only since 29/09/2026).
 *
 * The half with no DOM, no timers and no fetch: the record, what each action does to it, what the
 * page is told to track, and the window events the chat column reads and writes. The controller
 * (`comment-controller.ts`) runs it; `tests/comment-store.spec.ts` holds its rules.
 *
 * Stage 6 of comment-to-edit (TCH `tasks/todo-comment-people.md` rules 1–12, contract
 * `tasks/evidence/comment-people/contract.md` H1/H2): a comment is people talking to people. It is
 * open or resolved, nothing else — no Not sent / Working / Updated / Asked / Failed, no answer from
 * Tracy on it, no number on its pin. "Send to Tracy" never creates or changes a comment: it is a
 * chat message (`tracy:comment-send` v3, {@link commentSendDetailV3}) whose items the server numbers
 * (`POST /requests`); a comment it came from stays until someone resolves it. The only trace a send
 * leaves on a comment is the server's `sentToTracy`, which counts "Send N" and is never shown.
 *
 * Everyone with a seat may read, reply to, resolve and send any comment; only its author edits or
 * deletes it (`can`). A REPLY (`replyTo`) lives in its parent's thread and has no pin of its own.
 * A comment its author deleted while a live reply stands under it stays as a placeholder (`removed`,
 * author and time only) so the reply keeps its thread ({@link keepRemovedParents}).
 *
 * The persistence reader at the bottom only reads what stages 3–4 kept in the tab record, for the
 * one-time move to the server; old statuses read as open (or resolved).
 */
import { plainLabel, readPickTarget } from './comment-model.ts'
import { NO_ATTACHMENTS, type AttachmentLimits, type CommentAttachment } from './comment-attachments.ts'
import { DEFAULT_MAX_CHARS } from './comment-errors.ts'
import {
  PREVIEW_HIDDEN_REASONS,
  PREVIEW_LOST_REASONS,
  PREVIEW_PICK,
  PREVIEW_PICK_LIMITS,
  PREVIEW_TRACK_LIMITS,
  isPreviewMessage,
  previewRevealMessage,
  previewTrackMessage,
  type PreviewHidden,
  type PreviewLostReason,
  type PreviewPickRect,
  type PreviewPickTarget,
  type PreviewTrackItem,
  type PreviewTrackState,
} from './preview-protocol.generated.ts'

// ── The record ──────────────────────────────────────────────────────────────────────────────

/**
 * At most this many comments of one tab are held. Past it the oldest RESOLVED comment is dropped to
 * make room; it bounds what the one-time move reads back from a tab record.
 */
export const MAX_KEPT = 100

export type CommentStatus = 'open' | 'resolved'

export interface Comment {
  /** `randomId()` until the server answered, then the server's id; the id the page tracks it by. */
  id: string
  /** The server's number (one sequence per site, shared with requests); never shown on the page. */
  n: number
  /** The canonical address of the page it is about (`canonicalPageUrl`). */
  url: string
  /** The element it is about, as the page reported it; null = the page as a whole. */
  element: PreviewPickTarget | null
  /** The `content.locate` answer; null until (or unless) one came. */
  locate: Record<string, unknown> | null
  text: string
  status: CommentStatus
  /** When it was written (ms since the epoch). */
  createdAt: number
  /** When it was resolved; only while `status` is `resolved`. */
  resolvedAt?: number
  /** Who resolved it; only while `status` is `resolved`. */
  resolvedBy?: CommentAuthor
  /** The comment this one replies to: a reply lives in its parent's thread. */
  replyTo?: string
  /** Who wrote it, as the server names them; absent until the server answered for it. */
  author?: CommentAuthor
  /** What the viewer may do with it (the server's word); absent = the viewer's own, not saved yet. */
  can?: { edit: boolean; delete: boolean }
  /** The server's `updatedAt` (ISO): what the next poll asks `since`. */
  updatedAt?: string
  /** A `site_request` points at it (H1): it went to Tracy at least once. Counts "Send N"; never shown. */
  sentToTracy?: boolean
  /**
   * Its earlier sends to Tracy, who and when (H3 `thread: sent to Tracy by <name> (<when>)`), when the
   * server lists them (`sends` on a row); absent otherwise. Only the chat message reads them.
   */
  sends?: Array<{ author: CommentAuthor; at: number }>
  /** Its author deleted it while a live reply stood under it: a placeholder, no words, no rights. */
  removed?: true
  /** Files kept with it on the server (attachments contract §D); absent = none. */
  attachments?: CommentAttachment[]
}

/** A comment's author as the server sends it. */
export interface CommentAuthor {
  accountId: string
  email: string
  name?: string
  initial: string
}

/** The viewer's own comment (or one not saved yet): only these are edited or deleted. */
export function isMine(c: Comment): boolean {
  return c.can?.edit !== false
}

export interface CommentStore {
  v: 2
  /** The site workspace the comments belong to; another site's store is never read. */
  siteKey: string
  /** The number a comment not answered by the server yet shows meanwhile (the server's `n_next`). */
  next: number
  items: Comment[]
}

export function emptyCommentStore(siteKey: string): CommentStore {
  return { v: 2, siteKey, next: 1, items: [] }
}

export type CommentAction =
  | { type: 'add'; id: string; url: string; element: PreviewPickTarget; locate: Record<string, unknown> | null; text: string; now?: number }
  /** A comment about the page as a whole (no element): the Comments view's "Add a comment…". */
  | { type: 'addGeneral'; id: string; url: string; text: string; now?: number }
  /** A reply to `parentId`: about the same page and element; a resolved parent opens again. */
  | { type: 'reply'; id: string; parentId: string; text: string; now?: number }
  /** New words; with `attachments`, the stored files it keeps (new uploads arrive with the server's row). */
  | { type: 'save'; id: string; text: string; attachments?: CommentAttachment[] }
  | { type: 'remove'; id: string }
  /**
   * Delete all (rule 12; Brian 23:20: resolved ones too): EVERY comment on the page `url`, open and
   * resolved, everyone's, with their replies (a soft delete on the server). With `ids`, only those
   * threads (the Comments view names what it hid for its Undo window).
   */
  | { type: 'clear'; url: string; ids?: readonly string[] }
  | { type: 'setLocate'; id: string; locate: Record<string, unknown> | null }
  | { type: 'resolve'; id: string; now: number; by?: CommentAuthor }
  /** A resolved comment open again — only ever as the local echo of a reply's create. */
  | { type: 'reopen'; id: string }
  /** These comments went to Tracy (their `site_request` rows exist). */
  | { type: 'markSent'; ids: readonly string[] }
  /**
   * Rows the server answered with (`comment-api.ts` `commentFromServer`). `full` = the whole list:
   * comments it does not name leave, except those in `hold`. A poll merges its rows and drops the
   * ids in `gone`. A comment in `hold` has a write of this tab in flight; the server's older copy
   * never overwrites it. `next` = the server's `n_next`.
   */
  | { type: 'sync'; rows: readonly Comment[]; gone: readonly string[]; full: boolean; hold: readonly string[]; next?: number }
  /** The server created `localId`; it takes the server's row (id and number included). */
  | { type: 'confirm'; localId: string; row: Comment }
  /** A write the server did not take is undone: `rows` are the comments as they stood before it. */
  | { type: 'restore'; rows: readonly Comment[] }

/** Why an action changed nothing. */
export type CommentRefusal = 'empty' | 'duplicate' | 'unknown'

function refuse(store: CommentStore, refused: CommentRefusal): { store: CommentStore; refused: CommentRefusal } {
  return { store, refused }
}

/** Room for one more comment under {@link MAX_KEPT}: the oldest resolved go first. */
function roomFor(items: Comment[]): Comment[] {
  if (items.length < MAX_KEPT) return items
  const resolved = items.filter(c => c.status === 'resolved').sort((a, b) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0) || a.n - b.n)
  const drop = new Set(resolved.slice(0, items.length - MAX_KEPT + 1).map(c => c.id))
  return items.filter(c => !drop.has(c.id))
}

/** A comment as its placeholder once its author removed it: who and when stay, nothing else. */
function placeholderOf(c: Comment): Comment {
  const { attachments: _files, ...rest } = c
  return { ...rest, locate: null, text: '', removed: true, can: { edit: false, delete: false } }
}

/** A reply not deleted stands under `id`. */
export const hasLiveReply = (items: readonly Comment[], id: string): boolean => items.some(r => r.replyTo === id && r.removed !== true)

/** A removed comment stays (as its placeholder) exactly while a live reply stands under it. */
function keepRemovedParents(items: Comment[]): Comment[] {
  return items.filter(c => c.removed !== true || hasLiveReply(items, c.id))
}

/** Remove `ids`: one a live reply still stands under becomes its placeholder, the rest leave. */
function removeFrom(items: readonly Comment[], ids: ReadonlySet<string>): Comment[] {
  const next = items.flatMap((c) => {
    if (!ids.has(c.id)) return [c]
    return hasLiveReply(items.filter(r => !ids.has(r.id)), c.id) ? [placeholderOf(c)] : []
  })
  return keepRemovedParents(next)
}

function update(store: CommentStore, id: string, change: (comment: Comment) => Comment | null): { store: CommentStore; refused: CommentRefusal | null } {
  const index = store.items.findIndex(c => c.id === id)
  if (index < 0) return refuse(store, 'unknown')
  const next = change(store.items[index]!)
  if (next === null) return refuse(store, 'unknown')
  const items = store.items.slice()
  items[index] = next
  return { store: { ...store, items }, refused: null }
}

const byN = (a: Comment, b: Comment): number => a.n - b.n

/**
 * One step of the store. Pure: the same store and action always give the same answer, and a
 * refused action returns the very store it was given.
 */
export function reduceComments(store: CommentStore, action: CommentAction): { store: CommentStore; refused: CommentRefusal | null } {
  switch (action.type) {
    case 'add':
    case 'addGeneral': {
      if (action.text.trim() === '') return refuse(store, 'empty')
      if (store.items.some(c => c.id === action.id)) return refuse(store, 'duplicate')
      const element = action.type === 'add' ? action.element : null
      const locate = action.type === 'add' ? action.locate : null
      const comment: Comment = { id: action.id, n: store.next, url: action.url, element, locate, text: action.text, status: 'open', createdAt: action.now ?? Date.now() }
      return { store: { ...store, next: store.next + 1, items: [...roomFor(store.items), comment] }, refused: null }
    }
    case 'reply': {
      const parent = store.items.find(c => c.id === action.parentId)
      // A tombstone (its first message deleted, a reply standing) is still a thread: anyone replies under it.
      if (parent === undefined) return refuse(store, 'unknown')
      const step = reduceComments(store, parent.element === null
        ? { type: 'addGeneral', id: action.id, url: parent.url, text: action.text, now: action.now }
        : { type: 'add', id: action.id, url: parent.url, element: parent.element, locate: parent.locate, text: action.text, now: action.now })
      if (step.refused !== null) return step
      const items = step.store.items.map((c) => {
        if (c.id === action.id) return { ...c, replyTo: parent.id }
        if (c.id === parent.id && c.status === 'resolved') return openAgain(c)
        return c
      })
      return { store: { ...step.store, items }, refused: null }
    }
    case 'save':
      if (action.text.trim() === '') return refuse(store, 'empty')
      return update(store, action.id, (c) => {
        if (c.removed === true) return null
        if (action.attachments === undefined) return { ...c, text: action.text }
        const { attachments: _old, ...rest } = c
        return action.attachments.length === 0 ? { ...rest, text: action.text } : { ...rest, text: action.text, attachments: action.attachments }
      })
    case 'remove':
      if (!store.items.some(c => c.id === action.id)) return refuse(store, 'unknown')
      return { store: { ...store, items: removeFrom(store.items, new Set([action.id])) }, refused: null }
    case 'clear': {
      // With ids (the Comments tab's Delete all, UI fine-tune 30/09) the named threads go on ANY page —
      // All pages names several; without, every thread of `url`.
      const hit = (c: Comment): boolean => (action.ids === undefined ? c.url === action.url : action.ids.includes(c.id))
      const roots = new Set(store.items.filter(c => c.replyTo === undefined && hit(c)).map(c => c.id))
      // A thread goes with its replies (a tombstone's too); a reply named by itself goes alone.
      const ids = new Set(store.items.filter(c => roots.has(c.id) || (c.replyTo !== undefined && roots.has(c.replyTo)) || (action.ids !== undefined && hit(c))).map(c => c.id))
      if (ids.size === 0) return refuse(store, 'unknown')
      return { store: { ...store, items: removeFrom(store.items, ids) }, refused: null }
    }
    case 'setLocate':
      return update(store, action.id, c => ({ ...c, locate: action.locate }))
    case 'resolve':
      return update(store, action.id, (c) => {
        if (c.status === 'resolved') return null
        const next: Comment = { ...c, status: 'resolved', resolvedAt: action.now }
        if (action.by !== undefined) next.resolvedBy = action.by
        return next
      })
    case 'reopen':
      return update(store, action.id, c => (c.status === 'resolved' ? openAgain(c) : null))
    case 'markSent': {
      const ids = new Set(action.ids)
      let changed = false
      const items = store.items.map((c) => {
        if (!ids.has(c.id) || c.sentToTracy === true) return c
        changed = true
        return { ...c, sentToTracy: true }
      })
      return changed ? { store: { ...store, items }, refused: null } : refuse(store, 'unknown')
    }
    case 'restore': {
      if (action.rows.length === 0) return refuse(store, 'unknown')
      const back = new Map(action.rows.map(r => [r.id, r]))
      const items = store.items.map(c => back.get(c.id) ?? c)
      for (const r of action.rows) if (!store.items.some(c => c.id === r.id)) items.push(r)
      return { store: { ...store, items: keepRemovedParents(items).sort(byN) }, refused: null }
    }
    case 'sync': {
      const hold = new Set(action.hold)
      const gone = new Set(action.gone)
      const incoming = new Map(action.rows.map(r => [r.id, r]))
      const items: Comment[] = []
      for (const c of store.items) {
        if (hold.has(c.id)) { items.push(c); continue }
        const r = incoming.get(c.id)
        if (r !== undefined) { items.push(r.removed === true ? r : mergeRow(c, r)); continue }
        if (action.full || gone.has(c.id)) continue
        items.push(c)
      }
      // A deleted row comes as its placeholder (`removed`), which `gone` does not drop.
      for (const r of action.rows) if (!store.items.some(c => c.id === r.id) && (!gone.has(r.id) || r.removed === true)) items.push(r)
      const kept = keepRemovedParents(items)
      const highest = kept.reduce((max, c) => Math.max(max, c.n), 0)
      return { store: { ...store, next: Math.max(action.next ?? 0, store.next, highest + 1), items: kept.sort(byN) }, refused: null }
    }
    case 'confirm': {
      const local = store.items.find(c => c.id === action.localId)
      if (local === undefined) return refuse(store, 'unknown')
      const merged = mergeRow(local, action.row)
      const items = store.items.filter(c => c.id !== action.row.id).map(c => (c.id === action.localId ? merged : c)).sort(byN)
      return { store: { ...store, next: Math.max(store.next, merged.n + 1), items }, refused: null }
    }
  }
}

function openAgain(c: Comment): Comment {
  const { resolvedAt: _at, resolvedBy: _by, ...rest } = c
  return { ...rest, status: 'open' }
}

/**
 * The comments of `before` that one step changed or dropped, as they stood before it — what a
 * `restore` puts back when the server refuses the write. The reducer copies only what it changes.
 */
export function changedBy(before: CommentStore, after: CommentStore): Comment[] {
  const now = new Map(after.items.map(c => [c.id, c]))
  return before.items.filter(c => now.get(c.id) !== c)
}

/** A server row over the tab's copy: the server wins, but a `content.locate` answer the tab found stays. */
function mergeRow(local: Comment, row: Comment): Comment {
  const merged: Comment = { ...row }
  if (merged.locate === null && local.locate !== null) merged.locate = local.locate
  // A send this tab made is known before the next poll says so.
  if (local.sentToTracy === true && merged.sentToTracy !== true) merged.sentToTracy = true
  return merged
}

// ── Reading the store ───────────────────────────────────────────────────────────────────────

/**
 * An open comment that stands on its own: a thread's first message (a pin, a row, a count). A deleted
 * first message with a live reply under it (a tombstone, round 5 TH-4) is still one: the thread stays
 * where it was, "Comment deleted" at its top.
 */
export function isOpenThread(c: Comment, items: readonly Comment[]): boolean {
  return c.status === 'open' && c.replyTo === undefined && (c.removed !== true || hasLiveReply(items, c.id))
}

/**
 * The toolbar's "Comments N" (rule 9): every open comment on the SITE, all authors — threads, not
 * their replies (a reply lives in its parent's thread).
 */
export function openCount(items: readonly Comment[]): number {
  return items.filter(c => isOpenThread(c, items)).length
}

/**
 * The page an address is on, as the Comments tab reads it (`tracy-chat-input` `comment-view.mjs` `pageOf`):
 * origin and path, no trailing slash, no query, no `#hash` — `/en/` and `/ru/` stay two pages.
 */
export function pageKeyOf(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
  } catch {
    return url
  }
}

/**
 * "Comments N" since the UI fine-tune (Brian 30/09, U16): open threads of the page the tab shows, all
 * authors — the Comments tab's `Current page` number, so the two never disagree.
 */
export function pageOpenCount(items: readonly Comment[], url: string | null): number {
  if (url === null) return 0
  const page = pageKeyOf(url)
  return items.filter(c => pageKeyOf(c.url) === page && isOpenThread(c, items)).length
}

/** "Send N to Tracy" (rule 1): open comments never sent to Tracy, of anyone, in number order. */
export function neverSentOf(items: readonly Comment[]): Comment[] {
  return items.filter(c => isOpenThread(c, items) && c.sentToTracy !== true).sort(byN)
}

/**
 * The comments the page `url` shows a pin for: open, about an element, not a reply, in number order —
 * plus `held`, a RESOLVED comment revealed from the Comments view whose thread card is open.
 */
export function pageCommentsOf(store: CommentStore, url: string | null, held: string | null = null): Comment[] {
  if (url === null) return []
  return store.items.filter(c => c.url === url && c.element !== null && (isOpenThread(c, store.items) || c.id === held)).sort(byN)
}

/** A comment's thread in time order: its first message, then every reply under it. */
export function threadMessagesOf(items: readonly Comment[], id: string): Comment[] {
  const hit = items.find(c => c.id === id)
  if (hit === undefined) return []
  const rootId = hit.replyTo ?? hit.id
  const root = items.find(c => c.id === rootId)
  const replies = items.filter(c => c.replyTo === rootId).sort((a, b) => a.createdAt - b.createdAt || a.n - b.n)
  return root === undefined ? replies : [root, ...replies]
}

// ── Persistence of stages 3–4 (read once, for the move to the server) ──────────────────────

/** Statuses a kept store may hold (stages 3–4, and `open`); every one but `resolved` reads as open now. */
const OLD_STATUSES = ['open', 'draft', 'saved', 'sent', 'working', 'done', 'failed', 'asked', 'lost', 'resolved'] as const

/** What the stage-3/4 mirror writes: a store as it is (drafts no longer exist). */
export function persistedCommentStore(store: CommentStore): CommentStore {
  return store
}

function readComment(raw: unknown, version: 1 | 2, now: number): Comment | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id === '' || r.id.length > PREVIEW_TRACK_LIMITS.id) return null
  if (typeof r.n !== 'number' || !Number.isInteger(r.n) || r.n < 1) return null
  if (typeof r.url !== 'string' || r.url === '') return null
  if (typeof r.text !== 'string' || r.text.trim() === '') return null
  if (!(OLD_STATUSES as readonly unknown[]).includes(r.status) || r.status === 'draft') return null
  if (version === 1 && r.status === 'resolved') return null
  if (r.locate !== null && (typeof r.locate !== 'object' || Array.isArray(r.locate))) return null
  const times = ['createdAt', 'resolvedAt', 'sentAt'] as const
  if (times.some(key => r[key] !== undefined && (typeof r[key] !== 'number' || !Number.isFinite(r[key])))) return null
  const rawElement = version === 1 ? r.target : r.element
  const element = version === 2 && rawElement === null ? null : readPickTarget(rawElement)
  if (element === null && !(version === 2 && rawElement === null)) return null
  const createdAt = typeof r.createdAt === 'number' ? r.createdAt : typeof r.sentAt === 'number' ? r.sentAt : now
  const comment: Comment = { id: r.id, n: r.n, url: r.url, element, locate: r.locate as Record<string, unknown> | null, text: r.text, status: r.status === 'resolved' ? 'resolved' : 'open', createdAt }
  if (comment.status === 'resolved') comment.resolvedAt = typeof r.resolvedAt === 'number' ? r.resolvedAt : now
  return comment
}

/**
 * Read a kept stage-3/4 store back, trusting nothing: the version, the site, at most
 * {@link MAX_KEPT} comments, every field's type. A bad comment is dropped on its own; a bad store
 * (unknown version, another site, not an object) is dropped whole.
 * @returns the store (null when none is usable) and how many comments were dropped.
 */
export function restoreCommentStore(raw: unknown, siteKey: string, now: number = Date.now()): { store: CommentStore | null; dropped: number } {
  if (raw === null || typeof raw !== 'object') return { store: null, dropped: 0 }
  const r = raw as Record<string, unknown>
  if ((r.v !== 1 && r.v !== 2) || r.siteKey !== siteKey || !Array.isArray(r.items)) return { store: null, dropped: 0 }
  const version = r.v
  const items: Comment[] = []
  let dropped = 0
  for (const entry of r.items as unknown[]) {
    const comment = readComment(entry, version, now)
    if (comment === null || items.some(c => c.id === comment.id || c.n === comment.n) || items.length >= MAX_KEPT) {
      if (!(typeof entry === 'object' && entry !== null && (entry as { status?: unknown }).status === 'draft')) dropped += 1
      continue
    }
    items.push(comment)
  }
  const highest = items.reduce((max, c) => Math.max(max, c.n), 0)
  const stored = typeof r.next === 'number' && Number.isInteger(r.next) && r.next > 0 ? r.next : 1
  return { store: { v: 2, siteKey, next: Math.max(stored, highest + 1), items }, dropped }
}

// ── The page tracks the set (H1 of stage 3) ─────────────────────────────────────────────────

/** The feature a page names in `ready` when it can track many elements (runtime 5+). */
export const TRACK_FEATURE = 'track'
export const PICK_TRACK = PREVIEW_PICK.track
export const PICK_RECT = PREVIEW_PICK.rect
export const PICK_LOST = PREVIEW_PICK.lost
/** Runtime 9: what a tracked element reads now, `pick-text {id, text}`. */
export const PICK_TEXT = PREVIEW_PICK.text
export const TEXT_FEATURE = 'text'
/** The feature a page names in `ready` when it knows `pick-reveal` and the `pending` state (runtime 7+). */
export const REVEAL_FEATURE = 'reveal'

export type TrackState = PreviewTrackState
export type TrackItem = PreviewTrackItem

/** How many elements a page takes in one `pick-track`: 60 when its `ready` names `pins60` (runtime 16), else 12. */
export const PINS_FEATURE = 'pins60'
export function trackCapOf(features: readonly string[]): number {
  return features.includes(PINS_FEATURE) ? PREVIEW_TRACK_LIMITS.items : PREVIEW_TRACK_LIMITS.itemsBefore16
}

/** When a thread last moved: its first message or its newest reply, written or edited. */
function lastActivityOf(root: Comment, items: readonly Comment[]): number {
  let at = root.createdAt
  for (const c of items) {
    if (c.id !== root.id && c.replyTo !== root.id) continue
    at = Math.max(at, c.createdAt, c.updatedAt === undefined ? 0 : Date.parse(c.updatedAt) || 0)
  }
  return at
}

/**
 * The set the page on `url` should outline: its open comments (a thin grey `pending` line — `saved`
 * on a page older than runtime 7), the one being edited as `active`, and a resolved comment being
 * revealed (`reveal`, held for the length of the reveal). Never a status colour: Tracy's progress
 * lives on Refresh, not on the page (rule 5).
 *
 * At most `cap` (what the page takes, {@link trackCapOf}). Round 10 (acceptance v5 PICK-new-13): the one
 * being edited or revealed first; then the comments the page can find (or has not answered for yet), by
 * last activity, newest first; a comment the page reported `missing`/`many` (`unfound`) only in the room
 * left — it never takes a slot from one the page can find. Only `url`'s comments.
 */
export function trackItemsOf(store: CommentStore, url: string | null, activeId: string | null, reveal: string | null = null, open: 'pending' | 'saved' = 'pending', loose: ReadonlySet<string> = NO_IDS, { cap = PREVIEW_TRACK_LIMITS.items, unfound = NO_IDS }: { cap?: number; unfound?: ReadonlySet<string> } = {}): TrackItem[] {
  const onPage = pageCommentsOf(store, url)
  const revealed = reveal === null ? undefined : store.items.find(c => c.id === reveal && c.url === url && c.element !== null && c.removed !== true && !onPage.includes(c))
  const rank = (c: Comment): number => (c.id === activeId || c.id === reveal ? 0 : unfound.has(c.id) ? 2 : 1)
  const active = new Map<string, number>()
  for (const c of onPage) active.set(c.id, lastActivityOf(c, store.items))
  const chosen = [...onPage, ...(revealed === undefined ? [] : [revealed])]
    .sort((a, b) => rank(a) - rank(b) || (active.get(b.id) ?? 0) - (active.get(a.id) ?? 0) || b.n - a.n)
    .slice(0, cap)
    .sort(byN)
  // 🔒 A COMMENT SENT TO TRACY IS HELD BY ITS SELECTOR (stage 6 acceptance F4, 29/09/2026). The page
  // checks a waiting item's words (`pick.mjs` `locate`), and Tracy is asked to change exactly those
  // words: after the page reloaded with its edit, the element read `changed`, its pin went and its open
  // card fell to the frame's top. Its words go out empty, which the page holds by the selector and the
  // tag it ends in — the `sent` state would do the same but draws a status colour (rule 5).
  // Round 5 (acceptance v3 TH-11): a comment the page reported `changed` (its words were rewritten, by
  // Tracy or anyone) is held the same way from then on (`loose`): its card opens at the element, not at
  // the frame's corner.
  return chosen.map(c => ({ id: c.id, selector: c.element!.selector, text: c.sentToTracy === true || loose.has(c.id) ? '' : c.element!.text, state: c.id === activeId ? 'active' : open }))
}

const NO_IDS: ReadonlySet<string> = new Set()

/** The tracked id of a pick the page no longer draws itself (never a comment id: those are uuids). */
export const PICK_TRACK_PREFIX = 'pick:'

/**
 * The tracked set with a pick the page no longer draws itself put first, as the solid `active`
 * outline (round 4, acceptance v2 L06): after a reload, a navigation inside the frame or a page-side
 * Esc that kept typed words, the new document knows nothing of the pick, so it is tracked like a
 * comment — held by its selector and words, never drawn on another element. Capped at what the page
 * takes (the newest comments give way); a pick the page would refuse is left out rather than make it
 * refuse the whole set.
 * @param items - the set `trackItemsOf` built.
 * @param pick - the pick's number, selector and words; null for none.
 * @param cap - what the page takes ({@link trackCapOf}).
 */
export function withPickItem(items: TrackItem[], pick: { id: number; selector: string; text: string } | null, cap: number = PREVIEW_TRACK_LIMITS.items): TrackItem[] {
  if (pick === null) return items
  const item: TrackItem = { id: `${PICK_TRACK_PREFIX}${String(pick.id)}`, selector: pick.selector, text: pick.text, state: 'active' }
  if (previewTrackMessage([item]) === null) return items
  return [item, ...items].slice(0, cap)
}

/** `pick-reveal {id}` (runtime 7): the page scrolls the tracked element to its centre and flashes it. */
export const PICK_REVEAL = PREVIEW_PICK.reveal

export function pickRevealMessage(id: string): { channel: string; v: number; kind: string; id: string } | null {
  return previewRevealMessage(id)
}

/** The `pick-track` message for a set, or null when the page would ignore it. */
export function pickTrackMessage(items: TrackItem[]): { channel: string; v: number; kind: string; items: TrackItem[] } | null {
  return previewTrackMessage(items)
}

function isRect(value: unknown): value is PreviewPickRect {
  if (value === null || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every(key => typeof r[key] === 'number' && Number.isFinite(r[key]))
}

export type TrackReport =
  | { kind: 'rect'; id: string; rect: PreviewPickRect & { hidden?: PreviewHidden } }
  | { kind: 'lost'; id: string; reason: PreviewLostReason }
  | { kind: 'text'; id: string; text: string }

/** A `pick-rect`, `pick-lost` or `pick-text` from the page, or null for anything else or anything malformed. */
export function readTrackReport(data: unknown): TrackReport | null {
  const kind = isPreviewMessage(data, PICK_RECT) ? 'rect' : isPreviewMessage(data, PICK_LOST) ? 'lost' : isPreviewMessage(data, PICK_TEXT) ? 'text' : null
  if (kind === null) return null
  const m = data as { id?: unknown; rect?: unknown; reason?: unknown; text?: unknown; hidden?: unknown }
  if (typeof m.id !== 'string' || m.id === '' || m.id.length > PREVIEW_TRACK_LIMITS.id) return null
  if (kind === 'text') return typeof m.text === 'string' && m.text.length <= PREVIEW_PICK_LIMITS.text ? { kind, id: m.id, text: m.text } : null
  // Runtime 14 (`clip`): why the block must not be drawn over rides on its rect.
  const hidden = (PREVIEW_HIDDEN_REASONS as readonly unknown[]).includes(m.hidden) ? { hidden: m.hidden as PreviewHidden } : {}
  if (kind === 'rect') return isRect(m.rect) ? { kind, id: m.id, rect: { x: m.rect.x, y: m.rect.y, width: m.rect.width, height: m.rect.height, ...hidden } } : null
  return (PREVIEW_LOST_REASONS as readonly unknown[]).includes(m.reason) ? { kind, id: m.id, reason: m.reason as PreviewLostReason } : null
}

// ── Sending to Tracy: one chat message (H2 `tracy:comment-send` v3) ────────────────────────

/** An element on the wire: its address, selector, plain label, words, box, marks, tag and image. */
export interface CommentSendElement {
  url: string
  selector: string
  label: string
  text: string
  rect: PreviewPickRect
  marks: string[]
  tag: string
  image: { src: string; alt: string } | null
  /** Runtime 9: the words when picked, beside a `text` that is the words NOW and differs. */
  was?: string
}

const flatWords = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * A comment's element as `tracy:comment-send` and `tracy:comment-list` carry it; null for a general one.
 * @param now - what the page says the element reads now (`pick-text`): the element then carries those
 *   words as `text` and the words from pick time as `was`, only when they differ.
 */
export function sendElementOf(c: Pick<Comment, 'url' | 'element' | 'locate'>, now?: string): CommentSendElement | null {
  if (c.element === null) return null
  const changed = now !== undefined && flatWords(now) !== flatWords(c.element.text)
  const element = changed ? { ...c.element, text: now } : c.element
  return {
    url: c.url,
    selector: element.selector,
    label: plainLabel(element, c.locate),
    text: element.text,
    rect: element.rect,
    marks: element.marks,
    tag: element.tag,
    image: element.image,
    ...(changed ? { was: c.element.text } : {}),
  }
}

/** A comment's author as a thread line names them: the name, else the email before `@`. */
export function authorLabel(author: CommentAuthor | undefined): string {
  const name = author?.name?.trim()
  if (name !== undefined && name !== '') return name
  return author?.email.split('@')[0] ?? ''
}

/** A name as two people could share it: lower case, spaces squeezed. */
const nameKey = (name: string): string => name.replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * How the page names people (round 5, acceptance v3 TH-6): the name, and when two ACCOUNTS among these
 * comments (authors and resolvers) share it, `<name> (<email before @>)` — the chat message's own rule
 * (contract H3), so the thread card, a pin's tooltip and "Resolved by" tell two Sams apart.
 * @param items - the comments the names are read among.
 * @returns the label of one author ('' for none).
 */
export function authorLabels(items: readonly Comment[]): (author: CommentAuthor | undefined) => string {
  const accounts = new Map<string, Set<string>>()
  const note = (a: CommentAuthor | undefined): void => {
    if (a === undefined) return
    const key = nameKey(authorLabel(a))
    if (key === '') return
    const seen = accounts.get(key) ?? new Set<string>()
    seen.add(a.accountId !== '' ? a.accountId : a.email)
    accounts.set(key, seen)
  }
  for (const c of items) {
    note(c.author)
    note(c.resolvedBy)
  }
  return (author) => {
    const name = authorLabel(author)
    if (author === undefined || name === '') return name
    const local = author.email.split('@')[0] ?? ''
    return (accounts.get(nameKey(name))?.size ?? 0) > 1 && local !== '' && local !== name ? `${name} (${local})` : name
  }
}

/**
 * The colours an author's bubble takes: Tailwind 600/700 fills that carry white text, never
 * terracotta (the primary action colour). The SAME list, in the same order, as tracy-chat-input's
 * `AUTHOR_COLOURS` (`packages/ui/tracy-chat-input/src/client/comment-view.mjs`).
 */
export const AUTHOR_COLOURS = ['#0284c7', '#7c3aed', '#059669', '#db2777', '#4f46e5', '#0d9488', '#c026d3', '#4d7c0f'] as const

/**
 * One person's colour: FNV-1a of their ACCOUNT id into {@link AUTHOR_COLOURS} (round 5, acceptance v3
 * TH-6: keyed by the name, two people called "Sam Tester" wore one colour; keyed by the account, a
 * person keeps it when renamed). No account yet (a comment the server has not answered for): the name
 * as shown, lower case, spaces squeezed — tracy-chat-input's own key, which the chat chip still uses
 * (a chat turn names people, never accounts). The Comments tab gets this colour with each row
 * (`tracy:comment-list` `author.color`), so its avatar matches the page's bubble.
 */
export function authorColor(author: CommentAuthor | undefined): string {
  const key = author !== undefined && author.accountId !== '' ? `account:${author.accountId}` : nameKey(authorLabel(author))
  let hash = 0x811c9dc5
  for (const ch of key) {
    hash ^= ch.codePointAt(0)!
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return AUTHOR_COLOURS[hash % AUTHOR_COLOURS.length]!
}

/**
 * The colours the page paints among these comments (UI fine-tune round 2, e2e L1, acceptance U3): each
 * person's {@link authorColor}, except that two people who SHARE a name (as {@link authorLabels} tells
 * them apart) never share a colour — 8 colours, so a hash alone clashed once in eight. The first of the
 * namesakes in number order keeps their own colour; each later one takes the next colour in
 * {@link AUTHOR_COLOURS} no earlier namesake holds. Stable for the same comments whatever their order.
 * Pins, the thread card and the Comments tab (`commentListDetail`) all read it, so one person wears one
 * colour everywhere on the page.
 * @param items - the comments the colours are read among.
 * @returns the colour of one author.
 */
export function authorColours(items: readonly Comment[]): (author: CommentAuthor | undefined) => string {
  const personOf = (a: CommentAuthor): string => (a.accountId !== '' ? `account:${a.accountId}` : `email:${a.email.toLowerCase()}`)
  /** Name key → the people of that name, in number order. */
  const byName = new Map<string, { person: string; author: CommentAuthor }[]>()
  for (const c of items.slice().sort(byN)) {
    for (const a of [c.author, c.resolvedBy]) {
      if (a === undefined) continue
      const key = nameKey(authorLabel(a))
      if (key === '') continue
      const people = byName.get(key) ?? []
      if (!people.some(p => p.person === personOf(a))) people.push({ person: personOf(a), author: a })
      byName.set(key, people)
    }
  }
  /** Person → the colour moved off its hash (only namesakes that clashed). */
  const moved = new Map<string, string>()
  for (const people of byName.values()) {
    if (people.length < 2) continue
    const taken = new Set<string>()
    for (const { person, author } of people) {
      const own = authorColor(author)
      const start = AUTHOR_COLOURS.indexOf(own as (typeof AUTHOR_COLOURS)[number])
      let colour = own
      for (let k = 0; k < AUTHOR_COLOURS.length && taken.has(colour); k += 1) colour = AUTHOR_COLOURS[(start + k + 1) % AUTHOR_COLOURS.length]!
      taken.add(colour)
      if (colour !== own) moved.set(person, colour)
    }
  }
  return author => (author === undefined ? authorColor(author) : moved.get(personOf(author)) ?? authorColor(author))
}

/** Who a thread line names: the name (else the chat uses the email before `@`) and the email, so two people of one name are told apart. */
export interface ThreadAuthor {
  name?: string
  email: string
}

/**
 * One line of a thread as the chat message quotes it (H3): a message `{author, at, text}`
 * (`thread: <name> (<time>): <text>`), or an earlier send `{author, at, sent: true}`
 * (`thread: sent to Tracy by <name> (<time>)`).
 */
export type CommentThreadEntry =
  | { author: ThreadAuthor; at: number; text: string }
  | { author: ThreadAuthor; at: number; sent: true }

function threadAuthorOf(author: CommentAuthor | undefined): ThreadAuthor {
  const name = author?.name?.trim()
  return name === undefined || name === '' ? { email: author?.email ?? '' } : { name, email: author?.email ?? '' }
}

/**
 * The thread a send quotes, in time order (rule 1, story ThreadCardSendToChat). From a thread card
 * (`withRoot`) the whole thread — its first message and every reply; from a comment row or "Send N"
 * the replies under it (its own words are the item's `text`). A placeholder names no words.
 */
export function threadEntriesOf(items: readonly Comment[], id: string, withRoot: boolean): CommentThreadEntry[] {
  const messages = threadMessagesOf(items, id)
  const kept = withRoot ? messages : messages.slice(1)
  const lines: CommentThreadEntry[] = kept.filter(c => c.removed !== true).map(c => ({ author: threadAuthorOf(c.author), at: c.createdAt, text: c.text.trim() }))
  // The thread's earlier sends to Tracy, as the server lists them on its first message.
  for (const send of messages[0]?.sends ?? []) lines.push({ author: threadAuthorOf(send.author), at: send.at, sent: true })
  return lines.sort((a, b) => a.at - b.at)
}

/**
 * One thing handed to Tracy: fresh words about an element (no comment made), or a comment / thread
 * that stays. What `POST /requests` records and the chat message carries, before the server numbered it.
 */
export interface RequestItem {
  url: string
  element: CommentSendElement | null
  /** The pick fields the doors keep beside the element (`wireElementOf`), for the request record. */
  wireElement: Record<string, unknown> | null
  locate: Record<string, unknown> | null
  text: string
  /** The comment it came from; absent for fresh words. */
  commentId?: string
  /** The chip's bubble: the comment's author; absent for fresh words (the sender, whom the chat names). */
  author?: CommentAuthor
  /** When the comment was written (ms), for the chip's age; absent for fresh words. */
  at?: number
  thread?: CommentThreadEntry[]
  /** Files picked in the box for this send (never stored on the server). */
  files?: File[]
  /** Files kept with the comment and its thread: read back into `File`s when it is sent. */
  stored?: CommentAttachment[]
}

export interface CommentSendItemV3 {
  n: number
  url: string
  element: CommentSendElement | null
  locate: Record<string, unknown> | null
  text: string
  author?: CommentAuthor
  /** When the comment was written (ms); absent for fresh words (chat-input contract §H2). */
  at?: number
  thread?: CommentThreadEntry[]
  commentId?: string
}

export interface CommentSendDetailV3 {
  v: 3
  sessionId: string
  requestId: string
  siteKey: string | null
  items: CommentSendItemV3[]
}

/**
 * `tracy:comment-send` v4 (attachments contract §B): v3 as it is, plus the `File`s of the message at
 * the root — dsh attaches files to the whole message, not to one chip. Sent ONLY when a file goes:
 * an older chat input that does not know `attachments` refuses the unknown `v` loudly instead of
 * dropping the files in silence.
 */
export interface CommentSendDetailV4 extends Omit<CommentSendDetailV3, 'v'> {
  v: 4
  attachments: File[]
}

/** v3, or v4 when `files` holds at least one file. */
export function withAttachments(detail: CommentSendDetailV3, files: readonly File[]): CommentSendDetailV3 | CommentSendDetailV4 {
  return files.length === 0 ? detail : { ...detail, v: 4, attachments: [...files] }
}

/**
 * The detail of one `tracy:comment-send` v3: ONE chat message, one chip per item, each numbered by
 * the server (`numbers[i]` for `items[i]`, from `POST /requests`).
 */
export function commentSendDetailV3(input: { sessionId: string; requestId: string; siteKey: string | null; items: readonly RequestItem[]; numbers: readonly number[] }): CommentSendDetailV3 {
  return {
    v: 3,
    sessionId: input.sessionId,
    requestId: input.requestId,
    siteKey: input.siteKey,
    items: input.items.map((item, i) => {
      const out: CommentSendItemV3 = { n: input.numbers[i]!, url: item.url, element: item.element, locate: item.locate, text: item.text.trim() }
      if (item.author !== undefined) out.author = item.author
      if (item.at !== undefined) out.at = item.at
      if (item.thread !== undefined && item.thread.length > 0) out.thread = item.thread
      if (item.commentId !== undefined) out.commentId = item.commentId
      return out
    }),
  }
}

// ── The chat column's Comments view (H2) ────────────────────────────────────────────────────

/** The window event the tab sends its comments in, for the chat column's Comments view. */
export const COMMENT_LIST_EVENT = 'tracy:comment-list'

/** The window event the Comments view sends to act on a tab's comments. */
export const COMMENT_ACT_EVENT = 'tracy:comment-act'

/**
 * The window event the toolbar's Comments button sends: open the chat column's Comments tab for
 * `{sessionId, tabId}` (the chat column opens first when hidden). tracy-chat-input listens.
 */
export const COMMENTS_OPEN_EVENT = 'tracy:comments-open'

/** One comment as `tracy:comment-list` carries it: people only, no status word, no Tracy line. */
export interface CommentListItem {
  id: string
  n: number
  url: string
  text: string
  createdAt: number
  /** Resolved (`resolvedAt`, and `resolvedBy` when the server named who) or open. */
  resolved: boolean
  resolvedAt?: number
  resolvedBy?: CommentAuthor
  /** Raw, as `tracy:comment-send` carries it (the chat input names it with its own chip); null = the whole page. */
  element: CommentSendElement | null
  replyTo?: string
  /** Its author, with the colour the page paints their bubble (`authorColours`), for the tab's avatar. */
  author?: CommentAuthor & { color?: string }
  /** What the viewer may do with it (the server's word); absent = the viewer's own. */
  can?: { edit: boolean; delete: boolean }
  /** Live replies under it ("N replies"); 0 on a reply. */
  replyCount: number
  /** It went to Tracy at least once: counts "Send N", never shown. */
  sentToTracy: boolean
  /** A placeholder: its author removed it while a reply still stands under it; `text` is ''. */
  removed?: true
  /** Its kept files (attachments contract §D), `[]` when none. */
  attachments: CommentAttachment[]
}

export interface CommentListDetail {
  sessionId: string
  tabId: string
  siteKey: string | null
  /** The site's host as the tab shows it. */
  host: string | null
  /** This tab is the one on screen. */
  active: boolean
  /** The canonical address of the page the tab shows now; null before it shows one. */
  url: string | null
  /** Every comment of the site the tab holds, every page, in number order. */
  comments: CommentListItem[]
  /** The comment list's `attachments` as the server said (§C): whether files may be kept, and how many, how big. */
  attachments: AttachmentLimits
  /** The list's `limits` (round 5, TH-2): the longest text, so the page box counts toward the server's own limit. */
  limits: { maxChars: number }
}

export function commentListDetail(input: { sessionId: string; tabId: string; siteKey: string | null; host: string | null; active: boolean; url: string | null; store: CommentStore; attachments?: AttachmentLimits; maxChars?: number }): CommentListDetail {
  const items = input.store.items
  const colour = authorColours(items)
  const comments = items.slice().sort(byN).map((c): CommentListItem => {
    const item: CommentListItem = {
      id: c.id,
      n: c.n,
      url: c.url,
      text: c.text,
      createdAt: c.createdAt,
      element: sendElementOf(c),
      resolved: c.status === 'resolved',
      replyCount: c.replyTo === undefined ? items.filter(r => r.replyTo === c.id && r.removed !== true).length : 0,
      sentToTracy: c.sentToTracy === true,
      attachments: c.removed === true ? [] : [...(c.attachments ?? [])],
    }
    if (c.status === 'resolved') {
      item.resolvedAt = c.resolvedAt ?? c.createdAt
      if (c.resolvedBy !== undefined) item.resolvedBy = c.resolvedBy
    }
    if (c.replyTo !== undefined) item.replyTo = c.replyTo
    if (c.author !== undefined) item.author = { ...c.author, color: colour(c.author) }
    if (c.can !== undefined) item.can = c.can
    if (c.removed === true) item.removed = true
    return item
  })
  return { sessionId: input.sessionId, tabId: input.tabId, siteKey: input.siteKey, host: input.host, active: input.active, url: input.url, comments, attachments: input.attachments ?? NO_ATTACHMENTS, limits: { maxChars: input.maxChars ?? DEFAULT_MAX_CHARS } }
}

/**
 * `hide` / `show` (round 5, acceptance v3 TH-7): the Comments view's Delete all took `ids` off for its
 * Undo window, or put them back (Undo); `clear` still comes when the window ends. Meanwhile the page's
 * pins and the toolbar's "Comments N" leave those out at once.
 */
export const COMMENT_ACT_KINDS = ['resolve', 'remove', 'reveal', 'clear', 'send', 'edit', 'reply', 'add', 'list', 'hide', 'show'] as const
export type CommentActKind = (typeof COMMENT_ACT_KINDS)[number]

export interface CommentActDetail {
  /**
   * The tab it is for; `''` only with `list` = the Browser tabs of the conversation on screen answer.
   * dsh mints tab ids per conversation (`tab1`, `tab2`, …), so an id alone can name a tab in each of
   * two conversations (round 6, acceptance v4 SEND-v4-new-1): {@link actIsFor} also asks that the tab
   * belongs to the conversation on screen.
   */
  tabId: string
  /**
   * Round 6: the conversation the act is for (chat-input sends the one on screen). A tab of any other
   * conversation ignores it; without it, only a tab of the conversation on screen acts.
   */
  sessionId?: string
  kind: CommentActKind
  /**
   * The comments it is about: `resolve`/`remove`; `reveal`/`edit`/`reply` — the first; `clear` — the
   * ones hidden for the Undo window; `send` — the ticked ones of "Send N".
   */
  ids?: string[]
  /** The words of `add` (a whole-page comment), `reply`, or `send` with `page` (whole-page words to Tracy). */
  text?: string
  /** `send` from the page box: ONLY `text`, as a whole-page chat message; no comment is made or sent. */
  page?: true
  /**
   * The page box's files (stage 6): `add` — kept with the new comment (this tab uploads them first);
   * page `send` — sent with the message (`tracy:comment-send` v4 `attachments`).
   */
  files?: File[]
}

/** A well-formed `tracy:comment-act` detail, or null. Whose tab it names is the caller's check ({@link actIsFor}). */
export function readCommentAct(detail: unknown): CommentActDetail | null {
  if (detail === null || typeof detail !== 'object') return null
  const d = detail as Record<string, unknown>
  if (typeof d.tabId !== 'string') return null
  if (!(COMMENT_ACT_KINDS as readonly unknown[]).includes(d.kind)) return null
  if (d.tabId === '' && d.kind !== 'list') return null
  if (d.sessionId !== undefined && typeof d.sessionId !== 'string') return null
  const out: CommentActDetail = { tabId: d.tabId, kind: d.kind as CommentActKind }
  if (typeof d.sessionId === 'string' && d.sessionId !== '') out.sessionId = d.sessionId
  if (d.ids !== undefined) {
    if (!Array.isArray(d.ids) || d.ids.length > MAX_KEPT || !d.ids.every(id => typeof id === 'string' && id !== '')) return null
    out.ids = d.ids as string[]
  }
  if (d.text !== undefined) {
    if (typeof d.text !== 'string') return null
    out.text = d.text
  }
  if (d.page === true) out.page = true
  if (d.files !== undefined) {
    if (!Array.isArray(d.files) || !d.files.every(f => typeof File !== 'undefined' && f instanceof File)) return null
    if (d.files.length > 0) out.files = d.files as File[]
  }
  return out
}

/**
 * The tab → the Comments view (round 5, TH-2; chat-input `ACT_FAILED_EVENT`): an `add` of the page box
 * was not kept, or (round 11, IN5-1) its `send` did not go (the door refused it or never answered, or the
 * chat did not take it), so the box puts its words and files back. e2e v7 INTH-1: a `clear` of the
 * Comments view's Delete all that the door refused, so the view brings its rows back and says it.
 * `code` is the door's refusal code (`NETWORK` for no answer), `next` its sentence when it gave one.
 */
export const COMMENT_ACT_FAILED_EVENT = 'tracy:comment-act-failed'

export interface CommentActFailedDetail {
  tabId: string
  /** The conversation of the tab that failed (round 11, IN5-1). */
  sessionId?: string
  /**
   * Round 11 (acceptance v5 IN5-1): a page `send` that did not go is handed back too. e2e v7 INTH-1: a
   * `clear` (Delete all) the door refused, with the `ids` it named (`text` is empty then).
   */
  kind: 'add' | 'send' | 'clear'
  text: string
  /** `clear` only: the threads the refused Delete all named. */
  ids?: string[]
  /** The box's files, given back with its words. */
  files?: File[]
  code?: string
  next?: string
}

/** The facts of one Browser tab {@link actIsFor} reads. */
export interface ActTarget {
  tabId: string | undefined
  sessionId: string
  /** The tab belongs to the conversation on screen (`BrowserView`: dsh's main view shows its session). */
  shown: boolean
}

/**
 * 🔒 ONE ACT, ONE TAB (round 6, acceptance v4 SEND-v4-new-1). Whether an act is for this tab: the act
 * names its id (or is `list` with an empty id) AND its conversation — by the act's `sessionId` (chat-input
 * round 6 sends the conversation on screen), or, from a sender without one, by this tab's conversation
 * being the one on screen. The Browser tab of a conversation left behind stays mounted (round 5) and dsh
 * mints tab ids per conversation, so by id alone one "Send to Tracy" from the Comments view ran in BOTH
 * conversations — two turns editing the site, one of them in a chat the person never wrote in. An act
 * that matches no tab is dropped, never broadcast.
 */
export function actIsFor(act: CommentActDetail, tab: ActTarget): boolean {
  if (tab.tabId === undefined) return false
  if (act.sessionId === undefined ? !tab.shown : act.sessionId !== tab.sessionId) return false
  return act.tabId === tab.tabId || (act.kind === 'list' && act.tabId === '')
}

// ── The Refresh button's events from the chat (H2) ─────────────────────────────────────────

/** A turn began (chat-input → the tab). */
export const TRACY_WORKING_EVENT = 'tracy:tracy-working'
/** A `tracy_site`/`tracy_emdash` write of the turn succeeded. */
export const SITE_CHANGED_EVENT = 'tracy:site-changed'
/** The turn ended. */
export const TURN_END_EVENT = 'tracy:turn-end'
/** The turn asked the person a question card and waits for the answer (its answer says working again). */
export const TRACY_ASKING_EVENT = 'tracy:tracy-asking'

/**
 * The tab asks the chat whether a turn runs in its conversation (round 9, acceptance v5 V5S-3):
 * dispatched synchronously with `detail = { sessionId }`; chat-input (`comment-status.mjs`) sets
 * `detail.running` when that conversation is the one on screen and its window has events.
 */
export const TURN_STATE_EVENT = 'tracy:turn-state'

/**
 * Whether a turn runs in this conversation, as the chat answers `tracy:turn-state`; undefined when
 * nobody answered (no chat input, another conversation on screen, a window not loaded yet).
 * @param sessionId - the tab's conversation.
 * @param target - where the chat listens (the window).
 */
export function askTurnRunning(sessionId: string, target: EventTarget = window): boolean | undefined {
  if (sessionId === '') return undefined
  const detail: { sessionId: string; running?: unknown } = { sessionId }
  target.dispatchEvent(new CustomEvent(TURN_STATE_EVENT, { detail }))
  return typeof detail.running === 'boolean' ? detail.running : undefined
}

export interface TurnEventDetail {
  sessionId: string
  requestId: string
  siteKey: string | null
}

/** A well-formed turn event detail (`tracy:tracy-working` · `tracy:tracy-asking` · `tracy:site-changed` · `tracy:turn-end`), or null. */
export function readTurnEvent(detail: unknown): TurnEventDetail | null {
  if (detail === null || typeof detail !== 'object') return null
  const d = detail as Record<string, unknown>
  if (typeof d.sessionId !== 'string' || d.sessionId === '') return null
  return { sessionId: d.sessionId, requestId: typeof d.requestId === 'string' ? d.requestId : '', siteKey: typeof d.siteKey === 'string' ? d.siteKey : null }
}
