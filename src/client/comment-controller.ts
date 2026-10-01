/**
 * Edit mode in Tracy's browser tab — the controller (Tracy, 27/09/2026; people-only comments since
 * 29/09/2026).
 *
 * One React hook that owns everything stateful about picking and commenting, so `BrowserView` only
 * asks it what to put in the frame's `src`, whether a refresh must drop the ticket, and what to
 * draw. The rules live in `comment-model.ts` and `comment-store.ts` (pure, tested); the calls in
 * `comment-client.ts` and `comment-api.ts`.
 *
 * The MODE is not held here: it is a property of the tab (`browser-mode.ts`), owned by `BrowserView`
 * and passed in as `edit`. This hook follows it — `pick-start` into the page when it turns on,
 * `pick-stop` when it turns off — and asks for a change through `setMode`. A new address, a reload
 * or a remount does NOT leave Edit: the next `ready` naming `pick` arms the picker again.
 *
 * The order of events it keeps (unchanged since 27/09):
 *   1. A Tracy site in a site workspace → ask the ticket door FIRST and hold the frame's `src` until
 *      it answers. A refusal is not an error: the page loads with no picker.
 *   2. The page announces `ready {features:['pick', …]}` → the mode bar offers Edit.
 *   3. Edit on → `pick-start` into the page (its own origin, never `'*'`), and one warm of
 *      `content.locate`. A `picked` opens the popover and asks `content.locate` once in the background.
 *   4. A load with no picker while Edit is on → the bounded recovery (`recoveryStep`). Its reload is a
 *      new navigation, which the browser opens at the top, so the page it loads is put back where the
 *      last page with a picker said it was scrolled to (`pick-scroll` → `pick-scroll-to`, runtime 11).
 *
 * ── Stage 6: comments are people to people (TCH `tasks/todo-comment-people.md` rules 1–12, contract
 *    `tasks/evidence/comment-people/contract.md` H1/H2; the stories of "Browser comment") ──
 *
 * The popover of a new pick (`foot: 'new'`, PopoverTwoButtonsEmpty/Typed): "Add comment" (a click;
 * `addComment`: a people comment, POSTed; its author's bubble goes on the page) and "Send to Tracy ↵"
 * (Enter; `sendToTracy`: the words go to the chat as ONE message and NO comment is made). A comment
 * reopened from its thread card's ⋮ Edit (`foot: 'edit'`, PopoverEditPending): "Save ↵" (Enter;
 * `save`), "Send to Tracy" (a click; the comment, its new words and its replies to the chat; it
 * stays) and "Delete". Shift+Enter is a new line in every box (Brian 29/09 22:40).
 *
 * A pin is the author's bubble, one per open comment of the page (replies live in its thread). A
 * click opens the THREAD CARD (`openThread`): the messages in time order, ⋮ = Edit/Delete on one's
 * own + Copy link on every message, "Reply…" with "Reply" (a click; `reply`: a people reply) and "Send
 * to Tracy ↵" (Enter; `sendThread`: the typed words plus the whole thread; the words do NOT become a reply),
 * and Resolve (`resolve`, anyone). Esc or a click outside closes it.
 *
 * EVERY SEND TO TRACY goes one road (`sendItems`): each element's `content.locate` answer (within
 * `SEND_LOCATE_WAIT_MS`, round 11), then `POST /api/sites/:key/requests` — the server records the request and gives
 * each item its number — then `tracy:comment-send` v3 (`commentSendDetailV3`), which the chat input
 * turns into one chat message and answers `tracy:comment-sent` / `-failed`. A refused request says the
 * door's `next` and sends nothing. Nothing about the send is written on a comment but the server's
 * own `sentToTracy` (mirrored at once with `markSent`); Tracy's progress shows on the Refresh button
 * (`refresh-progress.ts`), never on the page.
 *
 * The chat column's Comments view talks to this hook over two window events (`comment-store.ts`):
 *   `tracy:comment-list`  OUT — the site's comments (`commentListDetail`: people only, `replyCount`,
 *                         `sentToTracy`), on every change and when asked; `active: false` at unmount.
 *   `tracy:comment-act`   IN — `resolve` · `remove` · `reveal` (scroll to it and open its thread card)
 *                         · `clear` (every open comment on the page, everyone's: `POST /clear {url}`
 *                         after the view's 6 s Undo) · `send` (ids = the ticked ones of "Send N" as
 *                         one message; `page: true` + text = ONLY those words, about the whole page)
 *                         · `edit` · `reply`
 *                         · `add` (a whole-page comment) · `list`
 *                         · `hide` / `show` (round 5, TH-7: the view's Delete all took ids off for its
 *                         Undo window / put them back; pins and "Comments N" follow at once).
 *   🔒 Round 6 (acceptance v4 SEND-v4-new-1): an act is taken by the ONE tab whose id and conversation
 *   it names (`actIsFor`: its `sessionId`, else the conversation on screen, `conversationShown`), and
 *   only the conversation on screen lists — the Browser tab of a conversation left behind stays
 *   mounted, dsh mints tab ids per conversation, and one "Send to Tracy" once ran in both.
 *
 * The site's comments live on tracy-web's doors (`api`): `GET` at mount, `GET ?since=` every
 * {@link POLL_MS} while the tab is shown and right after each own write. A change is reduced locally
 * first and written through its door; the door's row wins; a refusal puts the comments back as they
 * were, says it in plain words (`comment-errors.ts`, never the door's `next`) and reads the list again.
 * A failed Add comment, Reply or Save puts its box back open with its words and files (round 5, TH-2;
 * never over words typed meanwhile: those win and the failed box waits until they are closed), and
 * nothing longer than the list's `limits.maxChars` is sent at all. A comment with a write in flight
 * is HELD against polls. A 404 `COMMENT_NOT_FOUND` = deleted elsewhere: dropped quietly. The poll also
 * brings `siteChangedAt`, which the Refresh button compares with its page's load time.
 *
 * FILES (TCH `tasks/evidence/comment-people/attachments-contract.md`): each box holds a draft of files
 * (`draft` for the popover, `replyDraft` for the thread card; `addFiles` checks the limits first and
 * says a refusal in the box, `draftError`). "Add comment" / "Reply" upload each new file, then POST the
 * comment with their ids (`createOnServer`); "Save" uploads the new ones and PATCHes the whole list when
 * it changed. "Send to Tracy" never uploads: the box's `File`s, and a stored comment's files read back
 * through their door (`gatherFiles`), go with the chat message as `tracy:comment-send` v4 — v3 when
 * there is no file. The list's `attachments.enabled` says whether the server keeps files at all.
 *
 * REMOVED in stage 6 (git history holds them): statuses (`markStatus`, `expireStuck`, the
 * `tracy:comment-status` listener, status pin colours), the stage-5 automatic soft reload of another
 * seat's page, the one-pin `single` popover with its v1 send, "+ Add another", the discard sheet, the
 * cap of twelve, "Resolve all updated" and Reopen.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import {
  PICK_FEATURE,
  READY_START,
  RECOVERY_START,
  RECOVERY_WAIT_MS,
  locateParams,
  readPick,
  readReady,
  readyStep,
  recoveryStep,
  sameElement,
  samePage,
  silenceOf,
  siteKeyOfBase,
  withPreviewTicket,
  withReloadNonce,
  type CommentFailureCode,
  type ReadyState,
  type RecoveryEvent,
  type RecoveryState,
} from './comment-model.ts'
import { isUnavailable, locateElement, requestPreviewTicket, sendCommentToChat, waitForLocate, warmLocate } from './comment-client.ts'
import { commentFromServer, createBodyOf, wireElementOf, type CommentApi, type DoorAnswer, type ServerComment } from './comment-api.ts'
import { DEFAULT_MAX_CHARS, saveErrorOf, textLength, type SaveError } from './comment-errors.ts'
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_FILES,
  NO_ATTACHMENTS,
  addToDraft,
  draftFiles,
  draftKeeps,
  draftOfStored,
  draftStored,
  notSentLine,
  type AttachmentLimits,
  type DraftAttachment,
  type DraftRefusal,
} from './comment-attachments.ts'
import { createPickLookup, isFinalLocate, type LocateAsk, type PickLookup } from './pick-lookup.ts'
import { PREVIEW_PICK, isPreviewMessage, previewHoldMessage, previewPickMessage, previewScrollToMessage, previewWheelMessage, type PreviewPickRect, type PreviewPickTarget, type PreviewScroll } from './preview-protocol.generated.ts'
import { randomId } from './random-id.ts'
import { canonicalPageUrl, type BrowserMode } from './browser-mode.ts'
import {
  COMMENT_ACT_EVENT,
  COMMENT_ACT_FAILED_EVENT,
  COMMENT_LIST_EVENT,
  REVEAL_FEATURE,
  TRACK_FEATURE,
  actIsFor,
  changedBy,
  commentListDetail,
  commentSendDetailV3,
  emptyCommentStore,
  hasLiveReply,
  isOpenThread,
  isMine,
  pageCommentsOf,
  pickRevealMessage,
  pickTrackMessage,
  readCommentAct,
  readTrackReport,
  reduceComments,
  sendElementOf,
  threadEntriesOf,
  threadMessagesOf,
  trackItemsOf,
  trackCapOf,
  withPickItem,
  PICK_TRACK_PREFIX,
  withAttachments,
  type Comment,
  type CommentAction,
  type CommentActFailedDetail,
  type CommentRefusal,
  type CommentStore,
  type RequestItem,
} from './comment-store.ts'

/** The feature a page names in `ready` when it holds its own clicks on `pick-hold` (runtime 11). */
export const HOLD_FEATURE = 'hold'
/** The page says where it is scrolled to and goes back there when asked (runtime 11). */
const SCROLL_FEATURE = 'scroll'
/** The page scrolls the box an element sits in on `pick-wheel` (runtime 16). */
const WHEEL_FEATURE = 'wheel'
/** What a page that does not name `pins60` takes in one `pick-track`. */
const PREVIEW_TRACK_ITEMS_BEFORE_16 = trackCapOf([])

/** The ticket door said 404 once: the feature is off on this deployment, for this page's life. */
let pickerOffForPage = false
/** A deep link's `comment=` was taken by one Browser tab of this page already. */
let commentLinkTaken = false

/** Reset the page-lifetime memos (tests). */
export function resetCommentModeMemo(): void {
  pickerOffForPage = false
  commentLinkTaken = false
}

/** How long a failure said outside a popover stays on screen. */
export const NOTICE_MS = 8_000

/** How often a shown tab asks the comment doors what changed (no stream, a poll). */
export const POLL_MS = 15_000
/**
 * How long a send waits for `content.locate` (round 11, acceptance v5 IN5-7): a warm answer is used at
 * once, else the words go without it (the agent asks itself). The lookup still lands for the next send.
 */
export const SEND_LOCATE_WAIT_MS = 300
/** How often a link's comment page is loaded again when another page turns up in its place (round 11, EDGE-9). */
export const LINK_PAGE_TRIES = 2

/**
 * How far back of the newest change it has read each poll asks again (ms; round 6, acceptance v4
 * thread). The server stamps `updated_at` when a write's transaction BEGINS, so a row can become
 * visible after a poll that already passed its time; asking a little earlier than the cursor brings it
 * anyway. Rows come back twice at most, and the store takes a row it already holds as the same row.
 */
export const POLL_OVERLAP_MS = 5_000

/**
 * How long "Deleted 1 comment · Undo" stays, and the DELETE waits (Brian 29/09 22:45: the same window
 * as the Comments tab's Delete all, TCH `packages/ui/tracy-chat-input/src/client/comment-clear.mjs`
 * `CLEAR_UNDO_MS`; 10 s since TCH UI fine-tune round 2, rule 6, 30/09 — it was 6 s).
 */
export const DELETE_UNDO_MS = 10_000

/** One tick of the Undo countdown ("Undo (10)" → "Undo (1)", Brian 23:20). */
export const DELETE_TICK_MS = 1_000

/**
 * How old the last answer of the doors may be when the person sends before the tab reads what
 * changed first: a comment someone else deleted is then not sent.
 */
export const FRESH_MS = 5_000

/**
 * Two Esc reports from DIFFERENT sources (the page's `pick-cancel`, the parent's keydown) closer than
 * this are one press.
 */
export const ESC_SAME_PRESS_MS = 150

/**
 * After an Esc that acted on an open box (closed it, or flashed it), a report of Esc from the OTHER
 * source within this window is the same press arriving late, never a step of its own: it must not
 * also leave Edit (round 7, acceptance v4 IN4-3).
 */
export const ESC_BOX_ECHO_MS = 1_000

/**
 * Words typed in a box are never dropped by one keystroke or one press (round 4, acceptance v2 L03 ·
 * L05 · L10; rule 14 extended while Brian slept, 30/09/2026): Esc, ✕ (round 7, IN4-1), Interactive,
 * the address bar, Back or Forward, or a reveal to another page, with words waiting, first flashes the
 * box and keeps it. A second such attempt within this window goes ahead and drops them. A click outside
 * flashes too, but never drops them, is not an attempt, and closes any window already open (round 7,
 * IN4-2: it is the gesture most often made by accident).
 */
export const DISCARD_AGAIN_MS = 3_000

/**
 * How long comments the Comments view hid for its Delete all Undo window (`hide`, round 5 TH-7) stay
 * hidden when neither `show` nor `clear` follows (the chat column went away): the view's window is 6 s.
 */
export const HIDE_LAPSE_MS = 20_000

/** A wheel pause longer than this starts the next wheel step from where the page last said it was. */
export const WHEEL_IDLE_MS = 400

/**
 * Where a box whose element is not on the page (yet) waits: the frame's top-left corner, the same
 * spot as an edit popover whose comment has no box.
 */
export const TOP_ANCHOR = { x: 14, y: 4, width: 0, height: 0 } as const

/** The frame's gate: which address it is for, whether it is still waiting, and the ticket. */
interface Gate {
  url: string | undefined
  waiting: boolean
  ticket: string | null
  /** Where the frame should load (the address, or where the page said it was, for a recovery). */
  loadUrl: string | undefined
}

/** One pick. The popover draws its box; the rest goes to the chat or the doors. */
export interface PickedState {
  /** Which pick this is: its `content.locate` answer belongs to it, not to a selector. */
  id: number
  /** The document it was made in (one per fresh `ready`). */
  doc: number
  target: PreviewPickTarget
  /** The page address the pick was made on (the page's own when it said, else the address bar). */
  url: string
  /**
   * The document in the frame no longer draws this pick itself (it reloaded, navigated, or dropped
   * its picker on Esc while words were kept): the tab tracks it as the `active` item instead, and
   * moves the popover by that item's `pick-rect` (round 4, acceptance v2 L06).
   */
  carried?: boolean
}

/** Which popover is open: a new pick's, or a saved comment reopened for editing. */
export type CommentFoot = 'new' | 'edit'

export interface CommentMode {
  /** What to put in the iframe's `src`; undefined = hold the load (the ticket is being asked). */
  frameSrc: string | undefined
  /** Call before a refresh: true when it dropped the ticket and so already reloads the frame. */
  dropTicket: () => boolean
  onFrameLoad: () => void
  /** The mode bar's Interactive | Edit control. */
  modes: {
    visible: boolean
    edit: boolean
    /**
     * Edit is on but cannot pick on the document in the frame: the bounded recovery gave up, or the page
     * said it has no picker (runtime 18 `address`, TCH e2e v7 ADDR-9). The layer says so with Reload.
     */
    unavailable: boolean
    selectEdit: () => void
    selectInteractive: () => void
    /** Reload: the page the frame shows now, with a new ticket, to bring the picker back. */
    reload: () => void
  }
  /**
   * Which document of the frame this is: bumped by every fresh `ready` (round 8). A box remembers where
   * its element was last seen only within one document (`boxStand` in `comment-model.ts`).
   */
  doc: number
  /** The new pick whose popover is open, or null. */
  picked: PickedState | null
  /** The open popover's words. */
  text: string
  setText: (text: string) => void
  /** Every comment of the site the tab holds (all pages). */
  comments: Comment[]
  /** The comments with a pin on the document in the frame: the open ones, and a resolved one revealed while its card is open. */
  pageComments: Comment[]
  /** The page the frame shows (canonical, no `#hash`): what "Comments N" counts (UI fine-tune U16). */
  pageUrl: string | null
  /** Each tracked comment's box, in the PAGE's pixels. */
  rects: ReadonlyMap<string, PreviewPickRect>
  foot: CommentFoot | null
  /** The comment the edit popover is for, or null. */
  editing: Comment | null
  /** A send to Tracy is on its way. */
  sending: boolean
  /** A send that failed: the chat did not take the words. Shown for {@link NOTICE_MS}. */
  notice: CommentFailureCode | null
  /** A door refused or did not answer: its `next` sentence (`''` = none). Shown for {@link NOTICE_MS}. */
  serverNotice: string | null
  /** What that refusal was about: a comment write ("Not saved.") or a send to Tracy ("Not sent."). */
  serverNoticeKind: 'save' | 'send'
  /**
   * A write with no box to say it in (Resolve, Delete, Delete all) refused or unanswered, in plain words
   * (round 5, TH-2); shown for {@link NOTICE_MS}. A send's refusal is still `serverNotice`.
   */
  serverError: SaveError | null
  /**
   * A failed Add comment / Save (`popover`) or Reply (`reply`) whose box came back open with its words
   * and files: what to tell the person in that box, until they type again.
   */
  saveError: (SaveError & { box: AttachmentBox }) | null
  /** The longest text a box may send or keep (the list's `limits.maxChars`, else 5000). */
  maxChars: number
  /** "Add comment" in a new popover: keep the words as a people comment. */
  addComment: () => void
  /** Enter / "Save" in the edit popover. */
  save: () => void
  /** "Send to Tracy" in either popover (Enter in a new one). */
  sendToTracy: () => void
  /**
   * ✕: the popover closes — with words typed, only as the second attempt within
   * {@link DISCARD_AGAIN_MS} (the first flashes the box and keeps them), exactly like Esc.
   */
  close: () => void
  /**
   * ⋮ Delete / Delete (Brian 29/09 22:45): a soft delete — the comment leaves the page, its pin, the
   * list and every count at once; the DELETE waits {@link DELETE_UNDO_MS} (sent at once if the page
   * hides or unloads first).
   */
  deleteComment: (id: string) => void
  /**
   * The Delete waiting out its Undo window: its message's spot in the thread card reads "Deleted ·
   * Undo (6)" (Brian 23:05, in place of what was clicked), `left` counting the seconds down (23:20);
   * null when none.
   */
  deleted: { id: string; left: number } | null
  /** Undo: the comment comes back as it stood; no DELETE is sent. */
  undoDelete: () => void
  escape: (source: 'page' | 'parent', key?: object) => void
  /** Bumped each time a box refused to drop its words ({@link DISCARD_AGAIN_MS}): the box flashes. */
  flash: number
  /** The open box holds words (or files) that closing it would lose; an untouched edit popover does not. */
  unsaved: boolean
  /**
   * Ask before the tab loads another address (the address bar, Back, Forward): false = refused, the
   * box flashed and keeps its words; true = go ahead (any words were dropped, {@link DISCARD_AGAIN_MS}).
   */
  mayLeave: () => boolean
  /**
   * A click outside the open box while it holds words: the layer flashes it. Not an attempt — the next
   * Esc, ✕, Interactive or navigation only flashes again ({@link DISCARD_AGAIN_MS}).
   */
  clickedOutside: () => void
  /**
   * The wheel over a box that cannot scroll that way itself (round 4, item 8): scroll the page by
   * `dx`/`dy` CSS pixels of the page, through `pick-scroll-to` (runtime 11 `scroll`). Nothing for a
   * page that does not say where it is. Round 10 (acceptance v5 B04): a page naming `wheel` (runtime 16)
   * gets `pick-wheel` and scrolls the box the element sits in — `id` names the comment of a thread card
   * or a pin; absent, the open pick.
   */
  wheelPage: (dx: number, dy: number, id?: string | null) => void
  // ── The thread card ──
  /** The thread whose card is open (its first message), or null. */
  thread: Comment | null
  /** The thread card's messages, in time order. */
  threadMessages: Comment[]
  /**
   * The message the card opens at and highlights (round 6): the reply a link or the Comments view
   * revealed. Null: the card opens at the newest (TH-5).
   */
  threadFocus: string | null
  /** Bumped by each "Reply" of this person: the card's list goes down to show it (round 6). */
  ownReplies: number
  replyText: string
  setReplyText: (text: string) => void
  openThread: (id: string) => void
  closeThread: () => void
  /** "Reply": a people reply in the open thread. */
  reply: () => void
  /** Enter / "Send to Tracy" in the thread card: the typed words plus the whole thread. */
  sendThread: () => void
  resolve: (ids: readonly string[]) => void
  /** ⋮ Edit on one's own message: the edit popover for it. */
  editMessage: (id: string) => void
  /** ⋮ Copy link: the deep link to the comment; resolves whether it copied. */
  copyLink: (id: string) => Promise<boolean>
  // ── A box whose comment someone else deleted (round 11, acceptance v5 V5-3) ──
  /**
   * The open thread card (`'thread'`) or edit popover (`'edit'`) holds words or files while its comment
   * was deleted elsewhere (Delete all on the page, or its only message deleted): the box stays with them
   * and what it showed (`thread`, `threadMessages` or `editing` as last seen), and says so. Null otherwise.
   */
  lost: 'thread' | 'edit' | null
  /** The lost box's words and files to Tracy, about the same element (no comment: it is gone); the box closes. */
  sendLost: () => void
  /** The lost box's words and files as a new people comment on the same element (or page); the box closes. */
  addLost: () => void
  /** Drop the lost box and its words. */
  discardLost: () => void
  // ── The Comments view ──
  reveal: (id: string) => void
  addGeneral: (text: string, files?: readonly File[]) => CommentRefusal | null
  clearAll: (ids?: readonly string[]) => void
  sendSome: (ids: readonly string[]) => void
  sendPage: (text: string, files?: readonly File[]) => void
  // ── The Refresh button ──
  /** The last successful write to the site, as the latest poll said (ISO), or null. */
  siteChangedAt: string | null
  /** The person is typing in a popover or a reply box. */
  typing: boolean
  /**
   * A comment box is open — the new-comment popover, the edit popover or a thread card's reply box —
   * typed into or not: the page must not reload under it (rule 5, R3).
   */
  boxOpen: boolean
  /**
   * The page must not reload now (rule 5): a popover is open (new or edit, typed into or not), or a
   * thread card's reply box holds words or files. An open card with an empty reply box does not hold
   * it (round 5, acceptance v3 SEND-new-2: after a Send from the card the reload never came).
   */
  holdsReload: boolean
  /**
   * The document in the frame holds its own clicks while a box is open (its `ready` named `hold`,
   * runtime 11): the tab sends `pick-hold`, the page answers `pick-outside`, and the layer draws no
   * shield (the wheel keeps scrolling the page). False: the layer shields the frame itself.
   */
  holdable: boolean
  /** Hear each `pick-outside {x, y}` the held page reports; returns the unsubscribe. */
  onPageOutside: (fn: (at: { x: number; y: number }) => void) => () => void
  // ── Files (attachments contract) ──
  /** Whether the server keeps files, and its limits (the list's `attachments`). Off: no attach button. */
  attachments: AttachmentLimits
  /** The popover's files: a reopened comment's kept ones, then those picked here. */
  draft: DraftAttachment[]
  /** The thread card's reply box's files. */
  replyDraft: DraftAttachment[]
  /** Files a box refused (too large, too many), said in that box until its next change. */
  draftError: { box: AttachmentBox; refusal: DraftRefusal } | null
  /** Files picked, dropped or pasted into a box. */
  addFiles: (box: AttachmentBox, files: readonly File[]) => void
  /** ✕ on a file of a box. */
  removeDraft: (box: AttachmentBox, key: string) => void
}

/** A `pick-scroll` from the page: where it is scrolled to, or null for anything else. */
function readScroll(data: unknown): PreviewScroll | null {
  if (!isPreviewMessage(data, PREVIEW_PICK.scroll)) return null
  const { x, y } = data as { x?: unknown; y?: unknown }
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return null
  return { x, y }
}

/** Which box files go in: the popover (new place or edit), or the thread card's reply box. */
export type AttachmentBox = 'popover' | 'reply'

/** Where a send was pressed: a box (its failure said in it), the Comments view's page box, or its list. */
type SendWhere = AttachmentBox | 'page' | 'view'

/** A box as it stood when its save went: what a refusal puts back (round 5, TH-2). */
type FailedBox =
  /** The Comments view's page box (`add`): its words go back to it (`tracy:comment-act-failed`). */
  | { box: 'page'; words: string; files?: readonly File[] }
  | { box: 'popover'; pick: PickedState; words: string; draft: DraftAttachment[] }
  | { box: 'edit'; id: string; words: string; draft: DraftAttachment[] }
  | { box: 'reply'; root: string; words: string; draft: DraftAttachment[] }

/** A poll's `since`: {@link POLL_OVERLAP_MS} before the cursor (the cursor itself when it is not a date). */
function overlapOf(cursor: string): string {
  const at = Date.parse(cursor)
  return Number.isFinite(at) ? new Date(at - POLL_OVERLAP_MS).toISOString() : cursor
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

/**
 * @param options - what the tab knows.
 * @returns the Edit mode state and actions.
 */
export function useCommentMode(options: {
  /** The address in the bar (the page being shown). */
  url: string | undefined
  frameRef: RefObject<HTMLIFrameElement | null>
  /** The address belongs to a Tracy site (`isTracySiteUrl`). */
  tracySite: boolean
  /** `/api/config` answered (or gave up), so `tracySite` is final. */
  domainsKnown: boolean
  /** The frame goes through the host's `/sidebar/frame` route: the picker never runs there. */
  viaHost: boolean
  sessionId: string
  /** The tab is in Edit (the tab's own, kept setting). */
  edit: boolean
  setMode: (mode: BrowserMode) => void
  /** The tab's id: its comments are read once per mount of this id. */
  tabId?: string
  /** What stages 3–4 kept in the tab record (`commentStoreOf`), for the one-time move to the server. */
  initialComments?: CommentStore
  /** This tab is the one on screen: `tracy:comment-list` `active`, and the poll runs. */
  active?: boolean
  /**
   * Round 6: the conversation this tab belongs to is the one on screen (dsh's main view). False: the
   * tab is kept mounted behind another conversation — it answers no `tracy:comment-act` and lists
   * nothing ({@link actIsFor}). Not given: true (a host with one conversation).
   */
  conversationShown?: boolean
  /** Bring this tab on screen (the deep link's `openTab` road). */
  revealTab?: () => void
  /** Load another address in this tab, as the address bar does. */
  navigate?: (url: string) => void
  /** The comment doors of this site (`createCommentApi`). Not given: comments live in this view only. */
  api?: CommentApi
  /** The one-time move of `meta.comments` is over: the record and the mirror may drop their copy. */
  onMigrated?: () => void
  /**
   * A Send to Tracy from this tab left at the press (`start`), or came to nothing (`failed`: refused,
   * timed out, nothing left to send) — round 9, acceptance v5 V5S-6: the Refresh button spins at the
   * press instead of 0.8–1.8 s later, and goes back when the send failed.
   */
  onSend?: (phase: 'start' | 'failed') => void
  /** ⋮ Copy link: copy the deep link to this comment (`BrowserView`: the site link + `&comment=<id>`). */
  copyCommentLink?: (comment: Comment) => Promise<boolean>
  /**
   * A deep link's `comment=<id>` (rule 6): once the list has it, the tab goes to its page, in Edit,
   * scrolls to it and opens its thread card; then `onCommentLinkTaken` (the view drops the parameter).
   */
  commentLink?: string | null
  onCommentLinkTaken?: () => void
}): CommentMode {
  const { url, frameRef, tracySite, domainsKnown, viaHost, sessionId, edit, setMode } = options
  const siteKey = useMemo(() => {
    if (typeof document === 'undefined' || typeof location === 'undefined') return null
    return siteKeyOfBase(document.baseURI, location.origin)
  }, [])
  const parentOrigin = typeof location === 'undefined' ? '' : location.origin
  /** The address this tab is on, as of the latest render: what a late answer is checked against. */
  const addressRef = useRef<string | undefined>(url)
  addressRef.current = url

  // ── The ticket gate ──
  /** A site workspace with the feature not known to be off: loads may need a ticket first. */
  const gated = siteKey !== null && !pickerOffForPage && !viaHost && url !== undefined
  /**
   * 🔒 THE ONE ANSWER TO "MAY THIS ADDRESS BE HANDED A TICKET". Only a Tracy site, which the site
   * proxy fronts, ever redeems one; any other page would just receive it in its URL. The recovery
   * asks this too (27/09: a tab in Edit on a customer's own domain loaded `…?tracy_preview=pv1…`).
   */
  const ticketable = gated && domainsKnown && tracySite
  const ticketableRef = useRef(ticketable)
  ticketableRef.current = ticketable
  /**
   * 🔒 ONLY THIS SITE'S OWN PAGE MAY DECLARE A PICKER (28/09/2026). A page reached by an outside link
   * inside the frame could otherwise announce one and send `picked` with words of its own into the
   * agent's turn. The page must be same-origin with the address the TAB is on.
   */
  const pickOriginRef = useRef<string | undefined>(url)
  pickOriginRef.current = url
  const ownPage = (origin: string): boolean => {
    const here = pickOriginRef.current
    return here !== undefined && origin !== 'null' && origin !== '' && sameOrigin(here, origin)
  }
  const ownPageRef = useRef(ownPage)
  ownPageRef.current = ownPage
  const [gate, setGate] = useState<Gate>({ url: undefined, waiting: false, ticket: null, loadUrl: undefined })
  useEffect(() => {
    if (!gated) {
      setGate({ url, waiting: false, ticket: null, loadUrl: url })
      return
    }
    if (!domainsKnown) {
      setGate({ url, waiting: true, ticket: null, loadUrl: url })
      return
    }
    if (!tracySite) {
      setGate({ url, waiting: false, ticket: null, loadUrl: url })
      return
    }
    let cancelled = false
    setGate({ url, waiting: true, ticket: null, loadUrl: url })
    void requestPreviewTicket({ siteKey: siteKey!, parentOrigin }).then((answer) => {
      if (cancelled || addressRef.current !== url) return
      if (answer.kind === 'off') pickerOffForPage = true
      setGate({ url, waiting: false, ticket: answer.kind === 'ticket' ? answer.ticket : null, loadUrl: url })
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new address or a settled domain list asks again
  }, [url, gated, domainsKnown, tracySite])

  let frameSrc: string | undefined
  if (url === undefined) frameSrc = undefined
  else if (!gated) frameSrc = url
  else if (gate.url !== url || gate.waiting) frameSrc = undefined
  else frameSrc = gate.ticket !== null ? withPreviewTicket(gate.loadUrl ?? url, gate.ticket) : (gate.loadUrl ?? url)

  const dropTicket = useCallback((): boolean => {
    if (gate.ticket === null) return false
    // A ticket is single-use: the clean address (with a reload nonce) is what a refresh asks for.
    setGate(previous => ({ ...previous, ticket: null, loadUrl: withReloadNonce(previous.loadUrl ?? previous.url ?? '') }))
    return true
  }, [gate.ticket])

  // ── What the page said ──
  const [pickAvailable, setPickAvailable] = useState(false)
  /** The document in the frame said where it is and that it has no picker (runtime 18 `address`). */
  const [pickerGone, setPickerGone] = useState(false)
  const pageOrigin = useRef<string | null>(null)
  const pageUrl = useRef<string | null>(null)
  const on = edit
  const onRef = useRef(edit)
  onRef.current = edit
  const [picked, setPicked] = useState<PickedState | null>(null)
  const pickedRef = useRef<PickedState | null>(null)
  pickedRef.current = picked
  const [text, setText] = useState('')
  const textRef = useRef(text)
  textRef.current = text
  const setWords = useCallback((words: string): void => { textRef.current = words; setText(words) }, [])
  /** The pick's one `content.locate` call, held for a send (`pick-lookup.ts`). */
  const lookup = useRef<PickLookup | null>(null)
  // Round 11 (IN5-7): a pick's warm lookup is used when it is in; a send never waits longer than this for it.
  lookup.current ??= createPickLookup(answer => waitForLocate(answer, SEND_LOCATE_WAIT_MS))
  const docSeq = useRef(0)
  const pickSeq = useRef(0)
  /** This page load has been warmed (reset by a new document or a new address). */
  const warmed = useRef(false)
  const warming = useRef<AbortController | null>(null)
  /**
   * The site said it cannot be looked up (`content.locate` → `unavailable`, server round 5): no pick of
   * this page asks again (every pick used to leave a 501 in the browser log). Reset with each page.
   */
  const locateOff = useRef(false)
  /** `content.locate` for one element, unless this page's site said it cannot answer. */
  const locateNow = (params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    if (locateOff.current || siteKey === null) return Promise.resolve(null)
    return locateElement({ siteKey, params, ...(signal === undefined ? {} : { signal }) }).then((answer) => {
      if (!isUnavailable(answer)) return answer
      locateOff.current = true
      return null
    })
  }
  const locateNowRef = useRef(locateNow)
  locateNowRef.current = locateNow

  const post = useCallback((kind: string, index?: number): void => {
    const target = frameRef.current?.contentWindow
    const origin = pageOrigin.current
    const message = previewPickMessage(kind, index)
    // 🔒 To the page's own origin, never '*'.
    if (target == null || origin === null || message === null) return
    try { target.postMessage(message, origin) } catch { /* the frame navigated away */ }
  }, [frameRef])

  /** Arm the picker in the page, and warm `content.locate` once for this page load. */
  const arm = useCallback((): void => {
    post(PREVIEW_PICK.start)
    if (warmed.current || siteKey === null || pageOrigin.current === null) return
    const address = pageUrl.current ?? url
    if (address === undefined) return
    warmed.current = true
    warming.current?.abort()
    const abort = new AbortController()
    warming.current = abort
    void warmLocate({ siteKey, url: address, signal: abort.signal }).then((said) => {
      if (said === 'unavailable' && !abort.signal.aborted) locateOff.current = true
    })
  }, [post, siteKey, url])

  // ── The comments ──
  const storeSiteKey = siteKey ?? ''
  const [store, setStore] = useState<CommentStore>(() => options.initialComments ?? emptyCommentStore(storeSiteKey))
  const storeRef = useRef(store)
  /** What a change writes to the doors; set below. */
  const persistRef = useRef<(action: CommentAction, before: CommentStore, after: CommentStore) => void>(() => {})
  const dispatch = useCallback((action: CommentAction, extra: { local?: boolean } = {}): CommentRefusal | null => {
    const before = storeRef.current
    const step = reduceComments(before, action)
    if (step.refused !== null) return step.refused
    storeRef.current = step.store
    setStore(step.store)
    if (extra.local !== true) persistRef.current(action, before, step.store)
    return null
  }, [])
  // ── Delete · Undo (Brian 29/09 22:45, placement 23:05) ──
  /**
   * The Delete waiting out its window. The store keeps the comment until then (Undo changes nothing);
   * what is SHOWN — pins, outlines, `comments`, the list the chat column counts — goes without it at
   * once ({@link shownOf}); the thread card keeps its spot as "Deleted · Undo".
   */
  const pendingDelete = useRef<{ id: string; left: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const [deleted, setDeleted] = useState<{ id: string; left: number } | null>(null)
  /**
   * Comments the Comments view took off for its Delete all Undo window (`hide`, round 5 TH-7): off the
   * pins, the count and the list at once, back on `show`; `clear` then writes. Each hide lapses after
   * {@link HIDE_LAPSE_MS} when nothing follows it.
   */
  const hidden = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const [hiddenTick, setHiddenTick] = useState(0)
  /** The store as the person sees it: the comment whose Delete waits already gone, and what the view hid. */
  const shownOf = (s: CommentStore): CommentStore => {
    const off = hidden.current
    let shown = off.size === 0 ? s : { ...s, items: s.items.filter(c => !off.has(c.id) && (c.replyTo === undefined || !off.has(c.replyTo))) }
    const p = pendingDelete.current
    if (p === null) return shown
    const step = reduceComments(shown, { type: 'remove', id: p.id })
    if (step.refused === null) shown = step.store
    return shown
  }
  const shownOfRef = useRef(shownOf)
  shownOfRef.current = shownOf
  const [trackable, setTrackable] = useState(false)
  const trackableRef = useRef(false)
  /** The document says where it is scrolled to and goes there when asked (`scroll`, runtime 11). */
  const scrollableRef = useRef(false)
  /** Where the page is being wheeled to (round 4, item 8); null = start again from `lastScroll`. */
  const wheelTo = useRef<PreviewScroll | null>(null)
  const wheelAt = useRef(0)
  /** The document answers `pick-hold` (runtime 11), and whether it is held now. */
  const [holdable, setHoldable] = useState(false)
  const holdableRef = useRef(false)
  const heldRef = useRef(false)
  /** Bumped per announced document: a new document starts unheld and is told again. */
  const [docTick, setDocTick] = useState(0)
  const outsideListeners = useRef(new Set<(at: { x: number; y: number }) => void>())
  const revealableRef = useRef(false)
  /**
   * A RESOLVED comment revealed from the Comments view, kept in the page's set while its thread card
   * is open (a resolved comment has no pin otherwise), or null. State as well as a ref: its pin is drawn.
   */
  const revealHold = useRef<string | null>(null)
  const [heldId, setHeldId] = useState<string | null>(null)
  /** A reveal waiting for its page to announce itself, or null. */
  const pendingReveal = useRef<{ id: string; then: 'thread' | 'edit'; link?: number } | null>(null)
  /** The canonical address of the document in the frame: which comments are "on this page". */
  const [docUrl, setDocUrl] = useState<string | null>(url === undefined ? null : canonicalPageUrl(url))
  const docUrlRef = useRef(docUrl)
  const setDoc = useCallback((next: string | null): void => { docUrlRef.current = next; setDocUrl(next) }, [])
  /** The saved comment whose edit popover is open, or null. */
  const [editId, setEditIdState] = useState<string | null>(null)
  const editIdRef = useRef<string | null>(null)
  const setEditing = useCallback((id: string | null): void => { editIdRef.current = id; setEditIdState(id) }, [])
  /** The thread whose card is open, or null. */
  const [threadId, setThreadIdState] = useState<string | null>(null)
  const threadIdRef = useRef<string | null>(null)
  const setThread = useCallback((id: string | null): void => { threadIdRef.current = id; setThreadIdState(id) }, [])
  /**
   * What the open card and the edit popover last showed (round 11, V5-3), and which of them lost its
   * comment under words (`thread:<id>` · `edit:<id>`): a box keeps them until it is closed.
   */
  const lastThread = useRef<{ root: Comment; messages: Comment[] } | null>(null)
  const lastEditing = useRef<{ comment: Comment; root: Comment } | null>(null)
  const lostBox = useRef<string | null>(null)
  /** The message the open card opens at and highlights (round 6): a revealed reply, else null (the newest). */
  const [threadFocus, setThreadFocus] = useState<string | null>(null)
  /** Each "Reply" of this person (round 6): the card's list goes down to show it. */
  const [ownReplies, setOwnReplies] = useState(0)
  const [replyText, setReplyTextState] = useState('')
  const replyTextRef = useRef('')
  const setReplyText = useCallback((words: string): void => { replyTextRef.current = words; setReplyTextState(words) }, [])
  // ── The boxes' files ──
  const [limits, setLimitsState] = useState<AttachmentLimits>(NO_ATTACHMENTS)
  const limitsRef = useRef(limits)
  const setLimits = useCallback((next: AttachmentLimits): void => {
    const was = limitsRef.current
    if (was.enabled === next.enabled && was.maxBytes === next.maxBytes && was.maxFiles === next.maxFiles) return
    limitsRef.current = next
    setLimitsState(next)
  }, [])
  /** The longest text a box may send or keep (round 5, TH-2): the list's `limits.maxChars`. */
  const [maxChars, setMaxCharsState] = useState(DEFAULT_MAX_CHARS)
  const maxCharsRef = useRef(DEFAULT_MAX_CHARS)
  const setMaxChars = useCallback((next: number): void => { maxCharsRef.current = next; setMaxCharsState(next) }, [])
  /** Words longer than the limit: nothing is sent or kept, the box stays with them. */
  const tooLong = (words: string): boolean => textLength(words) > maxCharsRef.current
  /** What a box that came back after a failed save tells the person (round 5, TH-2). */
  const [saveError, setSaveError] = useState<(SaveError & { box: AttachmentBox }) | null>(null)
  const [draft, setDraftState] = useState<DraftAttachment[]>([])
  const draftRef = useRef<DraftAttachment[]>([])
  const [replyDraft, setReplyDraftState] = useState<DraftAttachment[]>([])
  const replyDraftRef = useRef<DraftAttachment[]>([])
  const [draftError, setDraftError] = useState<{ box: AttachmentBox; refusal: DraftRefusal } | null>(null)
  const setDraftOf = useCallback((box: AttachmentBox, next: DraftAttachment[]): void => {
    if (box === 'popover') {
      draftRef.current = next
      setDraftState(next)
    } else {
      replyDraftRef.current = next
      setReplyDraftState(next)
    }
    setDraftError(current => (current?.box === box ? null : current))
  }, [])
  /** Files of a new comment (by its local id), or new files of a Save (by the comment's id), until their write runs. */
  const createFiles = useRef(new Map<string, File[]>())
  const saveFiles = useRef(new Map<string, File[]>())
  const [rects, setRects] = useState<ReadonlyMap<string, PreviewPickRect>>(() => new Map())
  const dropRect = useCallback((id: string): void => {
    setRects((previous) => {
      if (!previous.has(id)) return previous
      const next = new Map(previous)
      next.delete(id)
      return next
    })
  }, [])
  const tracked = useRef(new Set<string>())
  /** Comments the page reported `changed` (their words rewritten): tracked by selector from then on (round 5, TH-11). */
  const loose = useRef(new Set<string>())
  /**
   * Round 10 (acceptance v5 PICK-new-13): comments this document reported `missing`/`many` — they get
   * a slot only when every comment it can find has one. Cleared with each new document.
   */
  const unfound = useRef(new Set<string>())
  /** How many elements this document takes in one `pick-track` (`pins60`, runtime 16). */
  const trackCap = useRef(PREVIEW_TRACK_ITEMS_BEFORE_16)
  /** The document answers `pick-wheel` (runtime 16). */
  const wheelableRef = useRef(false)
  /** Runtime 9: what each tracked element reads now (`pick-text`), by tracked id. */
  const wordsNow = useRef(new Map<string, string>())
  const lastTrack = useRef<string | null>(null)
  const [sending, setSendingState] = useState(false)
  const sendingRef = useRef(false)
  const setSending = useCallback((busy: boolean): void => { sendingRef.current = busy; setSendingState(busy) }, [])
  const [notice, setNotice] = useState<{ code: CommentFailureCode; requestId: string } | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastEsc = useRef<{ source: 'page' | 'parent'; at: number; box: boolean } | null>(null)
  /** Bumped when a box refused to drop its words: it flashes. */
  const [flash, setFlash] = useState(0)
  /** When a box last refused to drop its words ({@link DISCARD_AGAIN_MS}); null = no refusal pending. */
  const refusedAt = useRef<number | null>(null)
  const seenKeys = useRef(new WeakSet<object>())

  /** Tell the page which open comments are on it, when that set changed since the last time. */
  const syncTrack = useCallback((): void => {
    if (!trackableRef.current || pageOrigin.current === null) return
    const open = pickedRef.current
    const carried = open !== null && open.carried === true && onRef.current ? { id: open.id, selector: open.target.selector, text: open.target.text } : null
    const cap = trackCap.current
    const items = withPickItem(trackItemsOf(shownOfRef.current(storeRef.current), docUrlRef.current, editIdRef.current, revealHold.current, revealableRef.current ? 'pending' : 'saved', loose.current, { cap, unfound: unfound.current }), carried, cap)
    const signature = JSON.stringify(items)
    if (signature === lastTrack.current) return
    const message = pickTrackMessage(items)
    if (message === null) {
      console.warn('[tracy:browser] Edit: a tracked set the page would ignore was not sent')
      return
    }
    const target = frameRef.current?.contentWindow
    if (target == null) return
    try { target.postMessage(message, pageOrigin.current) } catch { return }
    lastTrack.current = signature
    tracked.current = new Set(items.map(item => item.id))
    for (const id of [...wordsNow.current.keys()]) if (!tracked.current.has(id)) wordsNow.current.delete(id)
    setRects((previous) => {
      if ([...previous.keys()].every(id => tracked.current.has(id))) return previous
      return new Map([...previous].filter(([id]) => tracked.current.has(id)))
    })
  }, [frameRef])
  useEffect(() => { syncTrack() })

  // ── Bounded recovery ──
  const readiness = useRef<ReadyState>(READY_START)
  const [recovery, setRecovery] = useState<RecoveryState>(RECOVERY_START)
  const recoveryRef = useRef<RecoveryState>(RECOVERY_START)
  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Where the page with a picker last said it was scrolled to (`pick-scroll`); null for a new address. */
  const lastScroll = useRef<PreviewScroll | null>(null)
  /**
   * 🔒 THE RECOVERY PUTS THE PAGE BACK WHERE IT WAS (Brian 29/09/2026). Its reload is a new navigation at
   * a ticketed address, which the browser opens at the TOP: a page scrolled to a comment (3085 px) came
   * back at 0. The place is taken when the reload is asked for, and handed to the page it loads once
   * that page announces its picker (`ready` naming `scroll`) — once, never to a later load.
   */
  const scrollBack = useRef<{ address: string; at: PreviewScroll } | null>(null)
  const dispatchRecovery = useRef<(event: RecoveryEvent) => void>(() => {})
  dispatchRecovery.current = (event: RecoveryEvent): void => {
    const step = recoveryStep(recoveryRef.current, event)
    recoveryRef.current = step.state
    setRecovery(step.state)
    for (const effect of step.effects) {
      if (effect.type === 'start-timer' || effect.type === 'cancel-timer') {
        if (recoveryTimer.current !== null) clearTimeout(recoveryTimer.current)
        recoveryTimer.current = null
      }
      if (effect.type === 'start-timer') {
        recoveryTimer.current = setTimeout(() => {
          recoveryTimer.current = null
          dispatchRecovery.current({ type: 'timeout' })
        }, RECOVERY_WAIT_MS)
      }
      if (effect.type === 'warn') console.warn(`[tracy:browser] Comment: ${effect.reason}`)
      if (effect.type === 'reload-with-ticket') {
        if (!ticketableRef.current) continue
        const address = url
        if (address === undefined || siteKey === null) continue
        // The page the frame last said it shows, picker or not (runtime 18 `address`): the reload never
        // takes the person back to the last page that had a picker (TCH e2e v7 ADDR-9/11).
        const where = pageUrl.current !== null && sameOrigin(pageUrl.current, address) ? pageUrl.current : address
        void requestPreviewTicket({ siteKey, parentOrigin }).then((answer) => {
          // 🔒 A ticket that lands after the page changed belongs to no page (28/09/2026).
          if (addressRef.current !== address) return
          if (answer.kind !== 'ticket') {
            console.warn(`[tracy:browser] Comment: the ticket door answered ${answer.kind}; no reload`)
            dispatchRecovery.current({ type: 'load', commentOn: true, announced: false })
            dispatchRecovery.current({ type: 'timeout' })
            return
          }
          const at = lastScroll.current
          scrollBack.current = at !== null && (at.x > 0 || at.y > 0) ? { address: where, at } : null
          setGate({ url: address, waiting: false, ticket: answer.ticket, loadUrl: where })
        })
      }
    }
  }

  const clearPick = useCallback((): void => {
    lookup.current?.drop()
    // Now, not at the next render: a box the page sends before that render must not bring it back.
    pickedRef.current = null
    setPicked(null)
  }, [])

  /** Close the open popover (a new pick's words go with it) and let the page point again. */
  const closePopover = useCallback((): void => {
    const hadPick = pickedRef.current !== null
    if (editIdRef.current !== null) setEditing(null)
    clearPick()
    setWords('')
    setSaveError(current => (current?.box === 'popover' ? null : current))
    syncTrack()
    if (hadPick && onRef.current) post(PREVIEW_PICK.start)
  }, [clearPick, post, setEditing, setWords, syncTrack])

  const closeThread = useCallback((): void => {
    if (threadIdRef.current === null) return
    setThreadFocus(null)
    setThread(null)
    setReplyText('')
    setSaveError(current => (current?.box === 'reply' ? null : current))
  }, [setReplyText, setThread])

  /** The open box holds words (or new files) that closing it would lose. Read from refs: current at any time. */
  const unsavedNow = (): boolean => {
    if (!onRef.current) return false
    const editing = editIdRef.current
    if (editing !== null) {
      const saved = storeRef.current.items.find(c => c.id === editing)
      // A comment deleted elsewhere under changed words (round 11, V5-3): the box holds them still.
      if ((saved === undefined || saved.removed === true) && lostBox.current === `edit:${editing}`) return textRef.current.trim() !== '' || draftRef.current.some(d => d.kind === 'file')
      return (saved !== undefined && textRef.current !== saved.text) || draftRef.current.some(d => d.kind === 'file')
    }
    if (pickedRef.current !== null) return textRef.current.trim() !== '' || draftRef.current.some(d => d.kind === 'file')
    if (threadIdRef.current !== null) return replyTextRef.current.trim() !== '' || replyDraftRef.current.length > 0
    return false
  }
  const unsavedRef = useRef(unsavedNow)
  unsavedRef.current = unsavedNow

  /**
   * The document in the frame no longer draws the open pick (a reload, a navigation, a page-side Esc
   * that kept the words): track it as the active outline instead ({@link withPickItem}).
   * @param rect - where the box waits until the page reports the element; null = where it was.
   */
  const carryPick = (rect: PreviewPickRect | null): void => {
    const open = pickedRef.current
    if (open === null) return
    // Another page (round 11, IN5-3): once it finds the element, it is brought into view if it is not.
    if (rect === TOP_ANCHOR) seekCarried.current = open.id
    const next: PickedState = { ...open, carried: true, target: rect === null ? open.target : { ...open.target, rect: { ...rect } } }
    pickedRef.current = next
    setPicked(next)
    syncTrack()
  }
  const carryPickRef = useRef(carryPick)
  carryPickRef.current = carryPick
  /**
   * The pick carried to another page whose element that page has not reported yet (round 11, acceptance
   * v5 IN5-3). The page opens at its top; an element found below the fold left the popover and its outline
   * off screen, so the page looked empty and the words lost. Its first report scrolls it into view once.
   */
  const seekCarried = useRef<number | null>(null)
  const bringIntoView = (rect: PreviewPickRect): void => {
    const height = frameRef.current?.clientHeight ?? 0
    const target = frameRef.current?.contentWindow
    if (height <= 0 || !scrollableRef.current || pageOrigin.current === null || target == null) return
    if (rect.y >= 0 && rect.y + Math.min(rect.height, height / 2) <= height) return
    const at = lastScroll.current ?? { x: 0, y: 0 }
    // A quarter of the frame above it: room for the outline and the popover under it.
    const message = previewScrollToMessage(at.x, Math.max(0, at.y + rect.y - Math.round(height / 4)))
    // 🔒 To the page's own origin, never '*'.
    try { if (message !== null) target.postMessage(message, pageOrigin.current) } catch { /* the frame navigated away */ }
  }
  /** The carried pick's element was found (its box) or lost ({@link TOP_ANCHOR}): the popover follows. */
  const moveCarried = (rect: PreviewPickRect): void => {
    const open = pickedRef.current
    if (open === null) return
    const next: PickedState = { ...open, target: { ...open.target, rect: { ...rect } } }
    pickedRef.current = next
    setPicked(next)
  }

  /**
   * May the open box be dropped now? Nothing typed: yes. Words typed: the first attempt flashes the
   * box and says no; another within {@link DISCARD_AGAIN_MS} drops the words (every box) and says yes.
   */
  const guard = (): boolean => {
    if (!unsavedNow()) return true
    const now = Date.now()
    const last = refusedAt.current
    if (last !== null && now - last < DISCARD_AGAIN_MS) {
      refusedAt.current = null
      closePopover()
      closeThread()
      return true
    }
    refusedAt.current = now
    setFlash(n => n + 1)
    return false
  }
  const guardRef = useRef(guard)
  guardRef.current = guard
  const mayLeave = useCallback((): boolean => guardRef.current(), [])
  const clickedOutside = useCallback((): void => { refusedAt.current = null }, [])

  // A new address is a new page: everything about the old one is forgotten — but not the mode, and not
  // words typed in a box (round 4): a load the tab could not ask about first (the tab record moved)
  // keeps the box and its words; the pick is then tracked on the new page if it has that element.
  useEffect(() => {
    const keep = unsavedRef.current()
    setPickAvailable(false)
    setPickerGone(false)
    pageOrigin.current = null
    pageUrl.current = null
    warmed.current = false
    locateOff.current = false
    if (keep && pickedRef.current !== null) carryPickRef.current(TOP_ANCHOR)
    else if (!keep) clearPick()
    readiness.current = READY_START
    lastScroll.current = null
    wheelTo.current = null
    scrollableRef.current = false
    scrollBack.current = null
    dispatchRecovery.current({ type: 'reset' })
    trackableRef.current = false
    revealableRef.current = false
    setTrackable(false)
    holdableRef.current = false
    heldRef.current = false
    setHoldable(false)
    setDoc(url === undefined ? null : canonicalPageUrl(url))
    lastTrack.current = null
    tracked.current = new Set()
    wordsNow.current.clear()
    setRects(new Map())
    if (keep) return
    if (editIdRef.current !== null) setEditing(null)
    setWords('')
    // A reveal that navigated here keeps its thread to open once the page is ready.
    if (pendingReveal.current === null) closeThread()
  }, [url, clearPick, closeThread, setDoc, setEditing, setWords])

  /**
   * 🔒 THE CURRENT PAGE IS THE ONE THE FRAME LAST SAID IT SHOWS, PICKER OR NOT (TCH e2e v7 ADDR-6…12,
   * 30/09/2026). A document without the picker (its continuation lapsed, or no ticket came) announces
   * only its address (runtime 18 `address`), and a click inside it moves the frame without changing the
   * tab's `url`. That address is what the Comments list, "Comments N", a new comment and the recovery's
   * reload go by; nothing the previous document drew (pins, outlines) stays on it, and nothing is posted
   * into it. Edit says it cannot pick there ({@link CommentMode.modes} `unavailable`).
   */
  const noPicker = (address: string): void => {
    pageUrl.current = address
    pageOrigin.current = null
    setPickAvailable(false)
    setPickerGone(true)
    trackableRef.current = false
    revealableRef.current = false
    setTrackable(false)
    holdableRef.current = false
    heldRef.current = false
    setHoldable(false)
    scrollableRef.current = false
    wheelableRef.current = false
    lastTrack.current = null
    tracked.current = new Set()
    wordsNow.current.clear()
    setRects(new Map())
    const next = canonicalPageUrl(address)
    if (next === docUrlRef.current) return
    // Another page: what belonged to the last one goes, as for a new address — words typed stay (round 4).
    setDoc(next)
    lastScroll.current = null
    wheelTo.current = null
    warmed.current = false
    locateOff.current = false
    const keep = unsavedRef.current()
    if (keep && pickedRef.current !== null) carryPickRef.current(TOP_ANCHOR)
    else if (!keep) clearPick()
    if (!keep) {
      if (editIdRef.current !== null) setEditing(null)
      setWords('')
      if (pendingReveal.current === null) closeThread()
    }
    revealNowRef.current()
  }
  const noPickerRef = useRef(noPicker)
  noPickerRef.current = noPicker

  useEffect(() => () => {
    if (recoveryTimer.current !== null) clearTimeout(recoveryTimer.current)
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
    lookup.current?.drop()
    warming.current?.abort()
  }, [])

  /** The `content.locate` call for one pick (none without a site workspace). */
  const askFor = useCallback((pick: PickedState): LocateAsk => signal => locateNowRef.current(locateParams(pick.target, pick.url), signal), [])

  // The page's messages. Only the frame this view owns is believed (`event.source`), and a pick
  // message only from the origin that announced the picker.
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const frame = frameRef.current
      if (frame === null || event.source !== frame.contentWindow) return
      const report = readTrackReport(event.data)
      if (report !== null) {
        if (event.origin !== pageOrigin.current || !tracked.current.has(report.id)) return
        if (report.id.startsWith(PICK_TRACK_PREFIX)) {
          // The carried pick: where the page found its element moves the popover; not found, the box
          // waits at the frame's top corner with its words.
          const open = pickedRef.current
          if (report.kind === 'text' || open === null || report.id !== `${PICK_TRACK_PREFIX}${String(open.id)}`) return
          if (report.kind === 'rect' && seekCarried.current === open.id) {
            seekCarried.current = null
            bringIntoView(report.rect)
          }
          moveCarried(report.kind === 'rect' ? report.rect : TOP_ANCHOR)
          return
        }
        if (report.kind === 'text') {
          wordsNow.current.set(report.id, report.text)
          return
        }
        if (report.kind === 'rect') {
          const { rect } = report
          unfound.current.delete(report.id)
          setRects((previous) => {
            const held = previous.get(report.id)
            if (held !== undefined && held.x === rect.x && held.y === rect.y && held.width === rect.width && held.height === rect.height && (held as { hidden?: unknown }).hidden === rect.hidden) return previous
            return new Map(previous).set(report.id, rect)
          })
          return
        }
        // Not found on the page (any more): no pin; the comment stays in the list.
        dropRect(report.id)
        // Its element is there but reads other words (Tracy, or anyone, rewrote them): it is still that
        // element, so it is tracked again by its selector alone — the pin and the card come back there.
        if (report.reason === 'changed' && !loose.current.has(report.id)) {
          loose.current.add(report.id)
          syncTrack()
        } else if (report.reason !== 'changed' && !unfound.current.has(report.id)) {
          // Not on this page as it is now: its slot goes to a comment the page can find (round 10).
          unfound.current.add(report.id)
          syncTrack()
        }
        return
      }
      const scrolled = readScroll(event.data)
      if (scrolled !== null) {
        if (event.origin === pageOrigin.current) {
          lastScroll.current = scrolled
          // Where the page settled is where the next wheel step starts.
          wheelTo.current = null
        }
        return
      }
      const ready = readReady(event.data)
      if (ready !== null) {
        if (event.origin === 'null' || event.origin === '') return
        if (!ready.features.includes(PICK_FEATURE)) {
          // Runtime 18 `address`: a document with no picker still says where it is.
          if (ready.url !== null && sameOrigin(ready.url, event.origin) && ownPageRef.current(event.origin)) noPickerRef.current(ready.url)
          return
        }
        if (!ownPageRef.current(event.origin)) {
          setPickAvailable(false)
          return
        }
        const step = readyStep(readiness.current, { type: 'ready', now: Date.now(), url: ready.url })
        readiness.current = step.state
        // The `pageshow` echo of a document already announced: nothing new happened.
        if (!step.fresh && pageOrigin.current === event.origin) return
        pageOrigin.current = event.origin
        pageUrl.current = ready.url !== null && sameOrigin(ready.url, event.origin) ? ready.url : null
        warmed.current = false
        docSeq.current += 1
        setPickAvailable(true)
        setPickerGone(false)
        dispatchRecovery.current({ type: 'ready-pick' })
        const back = scrollBack.current
        scrollBack.current = null
        if (back !== null && ready.features.includes(SCROLL_FEATURE) && samePage(back.address, pageUrl.current ?? url ?? '')) {
          const message = previewScrollToMessage(back.at.x, back.at.y)
          // 🔒 To the page's own origin, never '*'.
          try { if (message !== null) frame.contentWindow?.postMessage(message, event.origin) } catch { /* the frame navigated away */ }
        }
        scrollableRef.current = ready.features.includes(SCROLL_FEATURE)
        wheelTo.current = null
        trackableRef.current = ready.features.includes(TRACK_FEATURE)
        trackCap.current = trackCapOf(ready.features)
        wheelableRef.current = ready.features.includes(WHEEL_FEATURE)
        unfound.current.clear()
        revealableRef.current = trackableRef.current && ready.features.includes(REVEAL_FEATURE)
        setTrackable(trackableRef.current)
        holdableRef.current = ready.features.includes(HOLD_FEATURE)
        heldRef.current = false
        setHoldable(holdableRef.current)
        setDocTick(n => n + 1)
        setDoc(canonicalPageUrl(pageUrl.current ?? url ?? ''))
        lastTrack.current = null
        tracked.current = new Set()
        wordsNow.current.clear()
        setRects(new Map())
        syncTrack()
        revealNowRef.current(true)
        // The same page again (Tracy's turn ended by reloading it, or Refresh) keeps the open pick and its
        // words; so does another page when words are typed (round 4). The new document knows nothing of
        // the pick: it is armed again and told to outline the element (acceptance v2 L06, where the
        // popover came back with no outline and the page was left unarmed).
        const open = pickedRef.current
        const same = open !== null && samePage(open.url, pageUrl.current ?? url ?? '')
        if (open !== null && onRef.current && (same || unsavedRef.current())) {
          carryPickRef.current(same ? null : TOP_ANCHOR)
          // A page that cannot track (runtime 4) could not outline it either: left unarmed, as before,
          // so it never points under the popover.
          if (trackableRef.current) arm()
          return
        }
        clearPick()
        if (onRef.current) arm()
        return
      }
      // Runtime 10: a click the held page swallowed — the layer decides (close, or flash).
      if (isPreviewMessage(event.data, PREVIEW_PICK.outside)) {
        if (event.origin !== pageOrigin.current || !heldRef.current) return
        const m = event.data as { x?: unknown; y?: unknown }
        const at = { x: typeof m.x === 'number' ? m.x : 0, y: typeof m.y === 'number' ? m.y : 0 }
        for (const fn of [...outsideListeners.current]) fn(at)
        return
      }
      const pick = readPick(event.data)
      if (pick === null || event.origin !== pageOrigin.current || !onRef.current) return
      if (pick.kind === 'cancel') {
        escapeRef.current('page')
        return
      }
      if (pick.kind === 'hover') return
      const pageAddress = pick.url !== null && sameOrigin(pick.url, event.origin) ? pick.url : (pageUrl.current ?? url ?? '')
      const previous = pickedRef.current
      const held = previous === null ? null : { doc: previous.doc, selector: previous.target.selector }
      if (previous !== null && sameElement(held, { doc: docSeq.current, selector: pick.target.selector })) {
        // The same element reported again (its box, while the page scrolls): the popover follows it.
        const id = previous.id
        setPicked(current => (current !== null && current.id === id ? { ...current, target: pick.target } : current))
        return
      }
      // A box for any other pick opens nothing.
      if (pick.moved) return
      // A new place: whatever was open closes (a card, an edit popover).
      if (editIdRef.current !== null) setEditing(null)
      closeThreadRef.current()
      setWords('')
      pickSeq.current += 1
      const next: PickedState = { id: pickSeq.current, doc: docSeq.current, target: pick.target, url: pageAddress }
      pickedRef.current = next
      setPicked(next)
      lookup.current?.start(next.id, askFor(next))
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [frameRef, arm, clearPick, askFor, url, dropRect, setDoc, syncTrack, setEditing, setWords])
  const closeThreadRef = useRef(closeThread)
  closeThreadRef.current = closeThread

  const onFrameLoad = useCallback((): void => {
    const step = readyStep(readiness.current, { type: 'load', now: Date.now() })
    readiness.current = step.state
    dispatchRecovery.current({ type: 'load', commentOn: onRef.current && ticketableRef.current, announced: step.announced })
  }, [])

  // Follow the tab's mode: Edit on arms the picker, off disarms it and hides the pins.
  const lastEdit = useRef(edit)
  useEffect(() => {
    if (lastEdit.current === edit) return
    lastEdit.current = edit
    if (edit) {
      arm()
      lastTrack.current = null
      syncTrack()
      revealNowRef.current()
      return
    }
    post(PREVIEW_PICK.stop)
    clearPick()
    setRects(new Map())
    if (editIdRef.current !== null) setEditing(null)
    setWords('')
    closeThread()
  }, [edit, arm, post, clearPick, syncTrack, setEditing, setWords, closeThread])

  const selectEdit = useCallback((): void => {
    if (recoveryRef.current.status === 'unavailable') {
      dispatchRecovery.current({ type: 'press-unavailable' })
    } else if (!onRef.current && ticketableRef.current) {
      const silence = silenceOf(readiness.current, Date.now())
      if (silence !== 'none') dispatchRecovery.current({ type: 'press-silent', settled: silence === 'silent' })
    }
    setMode('edit')
  }, [setMode])
  const selectInteractive = useCallback((): void => {
    if (!guardRef.current()) return
    setMode('interactive')
  }, [setMode])
  const reloadForPicker = useCallback((): void => { dispatchRecovery.current({ type: 'press-unavailable' }) }, [])
  const selectEditRef = useRef(selectEdit)
  selectEditRef.current = selectEdit

  /** Say a failed send over the page, for {@link NOTICE_MS}. */
  const showNotice = useCallback((code: CommentFailureCode, requestId: string): void => {
    setNotice({ code, requestId })
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => {
      noticeTimer.current = null
      setNotice(current => (current !== null && current.requestId === requestId ? null : current))
    }, NOTICE_MS)
  }, [])

  // ── The server ──
  const api = options.api
  const apiRef = useRef(api)
  apiRef.current = api
  const onMigratedRef = useRef(options.onMigrated)
  onMigratedRef.current = options.onMigrated
  const onSendRef = useRef(options.onSend)
  onSendRef.current = options.onSend
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  /** Comments with a write of this tab in flight (or not created yet): a poll never overwrites them. */
  const holds = useRef(new Map<string, number>())
  const hold = (id: string): void => { holds.current.set(id, (holds.current.get(id) ?? 0) + 1) }
  const release = (id: string): void => {
    const left = (holds.current.get(id) ?? 1) - 1
    if (left <= 0) holds.current.delete(id)
    else holds.current.set(id, left)
  }
  /**
   * The box each save in flight came from (round 5, TH-2): a failed one puts it back open with its words
   * and files. Keyed by the new comment's local id (Add comment, Reply) or `edit:<id>` (Save).
   */
  const failedBoxes = useRef(new Map<string, FailedBox>())
  /** Boxes that failed while another box held words: they come back, in order, once it closes. */
  const parked = useRef<Array<{ box: FailedBox; error: SaveError }>>([])
  /** The files of a box being given back, for the effects that start each new box's files. */
  const draftGiven = useRef<{ popover?: DraftAttachment[]; reply?: DraftAttachment[] }>({})
  /** Creates in flight, by the comment's local id → its server id (null = refused). */
  const creating = useRef(new Map<string, Promise<string | null>>())
  const serverIdOf = (id: string): Promise<string | null> => creating.current.get(id) ?? Promise.resolve(id)
  const serverIdOfRef = useRef(serverIdOf)
  serverIdOfRef.current = serverIdOf
  /**
   * 🔒 THE CURSOR MOVES ONLY ON WHAT A READ OF THE LIST BROUGHT (round 6, acceptance v4 thread): the
   * newest `updatedAt` a `GET` answered with. A write's own answer never moves it — it did, and a reply
   * or a Resolve another seat wrote a moment before this tab's own write fell behind the cursor and was
   * never read again until a reload (3/3 on the stand, 60 s+), so it was missing from sends to Tracy
   * too. Each poll asks from {@link POLL_OVERLAP_MS} before it.
   */
  const since = useRef<string | null>(null)
  const noteSince = (iso: string | null | undefined): void => {
    if (typeof iso === 'string' && (since.current === null || iso > since.current)) since.current = iso
  }
  const [siteChangedAt, setSiteChangedAt] = useState<string | null>(null)
  const [serverNotice, setServerNotice] = useState<string | null>(null)
  const [serverNoticeKind, setServerNoticeKind] = useState<'save' | 'send'>('save')
  const serverNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (serverNoticeTimer.current !== null) clearTimeout(serverNoticeTimer.current) }, [])
  const [serverError, setServerError] = useState<SaveError | null>(null)
  const showServerNotice = (next: string | null, kind: 'save' | 'send' = 'save'): void => {
    if (!alive.current) return
    setServerError(null)
    setServerNotice(next ?? '')
    setServerNoticeKind(kind)
    if (serverNoticeTimer.current !== null) clearTimeout(serverNoticeTimer.current)
    serverNoticeTimer.current = setTimeout(() => {
      serverNoticeTimer.current = null
      setServerNotice(null)
    }, NOTICE_MS)
  }
  /** A write with no box to say it in was refused: plain words, never the door's `next` (round 5, TH-2). */
  const showServerError = (answer: Extract<DoorAnswer<unknown>, { ok: false }>): void => {
    if (!alive.current) return
    setServerNotice(null)
    setServerError(saveErrorOf(answer, maxCharsRef.current))
    if (serverNoticeTimer.current !== null) clearTimeout(serverNoticeTimer.current)
    serverNoticeTimer.current = setTimeout(() => {
      serverNoticeTimer.current = null
      setServerError(null)
    }, NOTICE_MS)
  }
  const showServerNoticeRef = useRef(showServerNotice)
  showServerNoticeRef.current = showServerNotice

  /** Rows a door answered with, into the store (`full` = the whole list). */
  const applyRows = (list: readonly ServerComment[], full: boolean, next?: number): void => {
    if (!alive.current) return
    const gone = list.filter(r => r.deletedAt !== null).map(r => r.id)
    const live = list.flatMap((r) => {
      const c = commentFromServer(r)
      return c === null ? [] : [c]
    })
    const action: CommentAction = next === undefined
      ? { type: 'sync', rows: live, gone, full, hold: [...holds.current.keys()] }
      : { type: 'sync', rows: live, gone, full, hold: [...holds.current.keys()], next }
    dispatch(action, { local: true })
    const items = storeRef.current.items
    const editing = editIdRef.current
    // Round 11 (acceptance v5 V5-3): deleted elsewhere under words or files, the box stays with them.
    if (editing !== null && !items.some(c => c.id === editing && c.removed !== true)) {
      const was = lastEditing.current
      if (was?.comment.id === editing && (textRef.current !== was.comment.text || draftFiles(draftRef.current).length > 0)) lostBox.current = `edit:${editing}`
      else {
        setEditing(null)
        setWords('')
      }
    }
    const threadOpen = threadIdRef.current
    if (threadOpen !== null && !items.some(c => c.id === threadOpen)) {
      if (lastThread.current?.root.id === threadOpen && (replyTextRef.current.trim() !== '' || replyDraftRef.current.length > 0)) lostBox.current = `thread:${threadOpen}`
      else closeThread()
    }
    syncTrack()
  }

  /** A create answered: the local comment becomes the server's (id and number). */
  const confirmRow = (localId: string, row: ServerComment): string | null => {
    const c = commentFromServer(row)
    if (c === null || !alive.current) return null
    dispatch({ type: 'confirm', localId, row: c }, { local: true })
    if (editIdRef.current === localId) setEditing(c.id)
    if (threadIdRef.current === localId) setThread(c.id)
    if (pendingReveal.current?.id === localId) pendingReveal.current = { ...pendingReveal.current, id: c.id }
    setRects((previous) => {
      const rect = previous.get(localId)
      if (rect === undefined) return previous
      const moved = new Map(previous)
      moved.delete(localId)
      return moved.set(c.id, rect)
    })
    syncTrack()
    return c.id
  }

  const polling = useRef(false)
  const pollAgain = useRef(false)
  /** When the doors last answered a read (ms): what {@link FRESH_MS} is measured from. */
  const lastHeard = useRef(0)
  /** What changed since the newest change seen (the whole list when none was ever seen). */
  const poll = async (): Promise<void> => {
    const door = apiRef.current
    if (door === undefined || !alive.current) return
    if (polling.current) {
      pollAgain.current = true
      return
    }
    polling.current = true
    const asked = since.current
    const answer = await door.list(asked === null ? undefined : overlapOf(asked))
    polling.current = false
    if (answer.ok) {
      lastHeard.current = Date.now()
      for (const r of answer.value.comments) noteSince(r.updatedAt)
      if (alive.current) {
        setLimits(answer.value.attachments)
        setMaxChars(answer.value.maxChars)
      }
      if (answer.value.siteChangedAt !== null && alive.current) setSiteChangedAt(answer.value.siteChangedAt)
      applyRows(answer.value.comments, asked === null, answer.value.nNext)
    }
    if (pollAgain.current) {
      pollAgain.current = false
      void poll()
    }
  }
  const pollRef = useRef(poll)
  pollRef.current = poll
  const freshen = async (): Promise<void> => {
    if (apiRef.current === undefined || Date.now() - lastHeard.current <= FRESH_MS) return
    await poll()
  }
  const freshenRef = useRef(freshen)
  freshenRef.current = freshen

  /** A write answered 404 `COMMENT_NOT_FOUND`: deleted elsewhere. The row leaves quietly; read again. */
  const gone = (id: string): void => {
    console.info('[tracy:browser] Edit: a comment was gone from the server; dropped it from this tab')
    if (!alive.current) return
    dispatch({ type: 'remove', id }, { local: true })
    if (editIdRef.current === id) {
      setEditing(null)
      setWords('')
    }
    if (threadIdRef.current === id) closeThread()
    dropRect(id)
    syncTrack()
    void load(false)
  }

  /** A door refused: say it in plain words, then read the whole list again. */
  const refused = (answer: Extract<DoorAnswer<unknown>, { ok: false }>): void => {
    console.warn(`[tracy:browser] Edit: a comment door refused (${answer.code})`)
    showServerError(answer)
    void load(false)
  }

  /** A write the server did not take: what it changed goes back as it stood, then {@link refused}. */
  const undone = (answer: Extract<DoorAnswer<unknown>, { ok: false }>, undo: readonly Comment[]): void => {
    if (alive.current && undo.length > 0) {
      dispatch({ type: 'restore', rows: undo }, { local: true })
      syncTrack()
    }
    refused(answer)
  }

  /** The door's own word that the row is gone: the one 404 that stays quiet. */
  const rowGone = (answer: Extract<DoorAnswer<unknown>, { ok: false }>): boolean => answer.status === 404 && answer.code === 'COMMENT_NOT_FOUND'

  /** One write through a door for one comment, held against polls until it answers; then a poll. */
  const write = (id: string, run: (door: CommentApi, serverId: string) => Promise<DoorAnswer<ServerComment>>, undo: readonly Comment[] = [], onFail?: (answer: Extract<DoorAnswer<unknown>, { ok: false }>) => void): void => {
    const door = apiRef.current
    if (door === undefined) return
    hold(id)
    void serverIdOf(id).then(async (serverId) => {
      if (serverId === null) {
        release(id)
        return
      }
      if (serverId !== id) hold(serverId)
      const answer = await run(door, serverId)
      release(id)
      if (serverId !== id) release(serverId)
      if (!answer.ok) {
        if (rowGone(answer)) gone(serverId)
        else if (onFail !== undefined) {
          if (alive.current && undo.length > 0) {
            dispatch({ type: 'restore', rows: undo }, { local: true })
            syncTrack()
          }
          console.warn(`[tracy:browser] Edit: a comment was not saved (${answer.code})`)
          onFail(answer)
          void load(false)
        } else undone(answer, undo)
        return
      }
      applyRows([answer.value], false)
      void poll()
    })
  }

  /** Upload `files` one by one (§C); the ids in order, or the first refusal (nothing is kept then). */
  const uploadAll = async (door: CommentApi, files: readonly File[]): Promise<DoorAnswer<string[]>> => {
    const ids: string[] = []
    for (const file of files) {
      const answer = await door.upload(file)
      if (!answer.ok) return answer
      ids.push(answer.value.id)
    }
    return { ok: true, value: ids }
  }

  /** POST a comment the person just kept (its files uploaded first); its number and id come back from the server. */
  const createOnServer = (localId: string): void => {
    const door = apiRef.current
    const comment = storeRef.current.items.find(c => c.id === localId)
    if (door === undefined || comment === undefined) return
    hold(localId)
    const files = createFiles.current.get(localId) ?? []
    createFiles.current.delete(localId)
    const job = (async (): Promise<string | null> => {
      const parent = comment.replyTo === undefined ? undefined : await serverIdOf(comment.replyTo)
      const uploaded = await uploadAll(door, files)
      const answer = uploaded.ok
        ? await door.create(createBodyOf(parent === undefined || parent === null ? comment : { ...comment, replyTo: parent }, uploaded.value))
        : uploaded
      release(localId)
      if (!answer.ok) {
        // Not kept anywhere: it leaves the list; its box comes back with its words and files (round 5,
        // TH-2), and says why in plain words.
        dispatch({ type: 'remove', id: localId }, { local: true })
        if (threadIdRef.current === localId) closeThread()
        dropRect(localId)
        syncTrack()
        console.warn(`[tracy:browser] Edit: a comment was not saved (${answer.code})`)
        const box = failedBoxes.current.get(localId)
        failedBoxes.current.delete(localId)
        if (box !== undefined) giveBack(box, answer)
        else showServerError(answer)
        return null
      }
      failedBoxes.current.delete(localId)
      const id = confirmRow(localId, answer.value.comment)
      if (answer.value.parent !== null) applyRows([answer.value.parent], false)
      void poll()
      return id
    })()
    creating.current.set(localId, job)
  }

  /** The whole list; at the first one of a tab, the one-time move of what stages 3–4 kept. */
  const load = async (first: boolean): Promise<void> => {
    const door = apiRef.current
    if (door === undefined) return
    const answer = await door.list()
    if (!alive.current) return
    if (!answer.ok) {
      if (first) console.warn(`[tracy:browser] Edit: the comment list did not load (${answer.code}); comments stay in this page only`)
      return
    }
    lastHeard.current = Date.now()
    const { comments, nNext, siteChangedAt: changedAt } = answer.value
    for (const r of comments) noteSince(r.updatedAt)
    setLimits(answer.value.attachments)
    setMaxChars(answer.value.maxChars)
    if (changedAt !== null) setSiteChangedAt(changedAt)
    // Kept in this tab's record before stage 5: no server row ever answered for them.
    const legacy = first ? storeRef.current.items.filter(c => c.can === undefined && !creating.current.has(c.id)).sort((a, b) => a.n - b.n) : []
    if (legacy.length > 0 && comments.filter(r => r.deletedAt === null).length === 0) {
      for (const c of legacy) hold(c.id)
      applyRows(comments, true, nNext)
      let moved = 0
      for (const c of legacy) {
        const created = await door.create(createBodyOf(c))
        release(c.id)
        if (!created.ok) {
          dispatch({ type: 'remove', id: c.id }, { local: true })
          showServerError(created)
          continue
        }
        const id = confirmRow(c.id, created.value.comment)
        if (id === null) continue
        moved += 1
        if (c.status === 'resolved') {
          const after = await door.resolve(id)
          if (after.ok) applyRows([after.value], false)
        }
      }
      console.info(`[tracy:browser] Edit: moved ${String(moved)} kept comment(s) of this tab to the server`)
    } else {
      applyRows(comments, true, nNext)
      if (legacy.length > 0) console.info(`[tracy:browser] Edit: the server already holds this site's comments; ${String(legacy.length)} kept comment(s) of this tab were not moved`)
    }
    if (first) {
      loadedOnce.current = true
      setListLoaded(n => n + 1)
      onMigratedRef.current?.()
    }
  }
  const loadedOnce = useRef(false)
  const [listLoaded, setListLoaded] = useState(0)

  persistRef.current = (action, before, after) => {
    const door = apiRef.current
    if (door === undefined) return
    const undo = changedBy(before, after)
    switch (action.type) {
      case 'add':
      case 'addGeneral':
      case 'reply':
        createOnServer(action.id)
        return
      case 'save': {
        const keep = action.attachments
        const files = saveFiles.current.get(action.id) ?? []
        saveFiles.current.delete(action.id)
        const key = `edit:${action.id}`
        write(action.id, async (d, id) => {
          const answer = keep === undefined
            ? await d.patch(id, { text: action.text.trim() })
            : await (async (): Promise<DoorAnswer<ServerComment>> => {
                const uploaded = await uploadAll(d, files)
                if (!uploaded.ok) return uploaded
                return await d.patch(id, { text: action.text.trim(), attachments: [...keep.map(a => a.id), ...uploaded.value] })
              })()
          if (answer.ok) failedBoxes.current.delete(key)
          return answer
        }, undo, (answer) => {
          const box = failedBoxes.current.get(key)
          failedBoxes.current.delete(key)
          if (box !== undefined) giveBack(box, answer)
          else showServerError(answer)
        })
        return
      }
      case 'remove':
        write(action.id, (d, id) => d.remove(id), undo)
        return
      case 'clear':
        if (action.ids === undefined) {
          void door.clear(action.url).then((answer) => {
            if (!answer.ok && !rowGone(answer)) undone(answer, undo)
            else void load(false)
          })
          return
        }
        // Named threads (the Comments tab's Delete all, any page): exactly those, never the rest of a page.
        // e2e v7 INTH-1: the door takes every thread it can and names the ones already gone, so an answer
        // is success. Any refusal — a 404 included, from a server older than that — is a failure the
        // person must hear: the rows come back and the Comments view says it in its head row (it asked).
        {
          const named = [...action.ids]
          void door.clearThreads(named).then((answer) => {
            if (answer.ok) {
              void load(false)
              return
            }
            if (alive.current && undo.length > 0) {
              dispatch({ type: 'restore', rows: undo }, { local: true })
              syncTrack()
            }
            console.warn(`[tracy:browser] Edit: Delete all was not saved (${answer.code})`)
            clearFailedRef.current(named, answer.code, answer.next)
            void load(false)
          })
        }
        return
      case 'resolve':
        write(action.id, (d, id) => d.resolve(id), undo)
        return
      default:
    }
  }

  // The list at mount (and when the view gets another tab), then a poll while the tab is shown.
  useEffect(() => {
    if (api === undefined) return
    since.current = null
    void load(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per tab id and door client
  }, [api, options.tabId])
  const shownNow = options.active !== false
  useEffect(() => {
    if (api === undefined || !shownNow) return
    const timer = setInterval(() => { void pollRef.current() }, POLL_MS)
    return () => { clearInterval(timer) }
  }, [api, shownNow])

  // Another tab's record handed to this view (a conversation switch): start from its kept store.
  const restoredFor = useRef(options.tabId)
  useEffect(() => {
    if (restoredFor.current === options.tabId) return
    restoredFor.current = options.tabId
    const next = options.initialComments ?? emptyCommentStore(storeSiteKey)
    storeRef.current = next
    setStore(next)
    setEditing(null)
    closeThread()
    setRects(new Map())
    lastTrack.current = null
    syncTrack()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the tab identity only
  }, [options.tabId])

  // ── Sending to Tracy: the one road (rule 1, contract H1/H2) ──

  /**
   * Each item's `content.locate` answer when it holds none whole, one at a time within ONE
   * {@link SEND_LOCATE_WAIT_MS} (a slow index never holds the words back; the agent then asks itself).
   */
  const locateAll = async (items: RequestItem[]): Promise<RequestItem[]> => {
    const deadline = Date.now() + SEND_LOCATE_WAIT_MS
    const out: RequestItem[] = []
    for (const item of items) {
      const left = deadline - Date.now()
      const comment = item.commentId === undefined ? undefined : storeRef.current.items.find(c => c.id === item.commentId)
      const element = comment?.element ?? null
      if (element !== null && !isFinalLocate(item.locate) && siteKey !== null && left > 0) {
        const asked = locateNow(locateParams(element, item.url), new AbortController().signal)
        const answer = await waitForLocate(asked, left)
        if (answer === null) {
          // Not in time: the words go now; a late answer is kept for the next send.
          void asked.then((late) => {
            if (alive.current && late !== null && typeof late === 'object' && storeRef.current.items.some(c => c.id === comment!.id)) dispatch({ type: 'setLocate', id: comment!.id, locate: late as Record<string, unknown> }, { local: true })
          }, () => {})
        }
        if (answer !== null && typeof answer === 'object') {
          const locate = answer as Record<string, unknown>
          dispatch({ type: 'setLocate', id: comment!.id, locate }, { local: true })
          out.push({ ...item, locate, element: sendElementOf({ ...comment!, locate }, wordsNowOf(comment!)) })
          continue
        }
      }
      out.push(item)
    }
    return out
  }

  /**
   * The files of a send (§B): each item's stored files read back through their door into `File`s,
   * then the files picked in its box — at most {@link ATTACHMENT_MAX_FILES}, each at most
   * {@link ATTACHMENT_MAX_BYTES}. A stored file that cannot go is left out and the item's words say so
   * (`(<name> not sent: too large)`); the message itself still goes.
   */
  const gatherFiles = async (items: RequestItem[]): Promise<{ items: RequestItem[]; files: File[] }> => {
    const files: File[] = []
    const door = apiRef.current
    const out: RequestItem[] = []
    for (const item of items) {
      const notes: string[] = []
      for (const a of item.stored ?? []) {
        if (a.size > ATTACHMENT_MAX_BYTES) { notes.push(notSentLine(a.name, 'too-large')); continue }
        if (files.length >= ATTACHMENT_MAX_FILES) { notes.push(notSentLine(a.name, 'too-many')); continue }
        const file = door === undefined ? null : await door.fetchFile(a)
        if (file === null) notes.push(notSentLine(a.name, 'unreadable'))
        else files.push(file)
      }
      for (const file of item.files ?? []) {
        if (file.size > ATTACHMENT_MAX_BYTES) notes.push(notSentLine(file.name, 'too-large'))
        else if (files.length >= ATTACHMENT_MAX_FILES) notes.push(notSentLine(file.name, 'too-many'))
        else files.push(file)
      }
      const { files: _picked, stored: _kept, ...rest } = item
      out.push(notes.length === 0 ? rest : { ...rest, text: `${item.text.trim()}\n${notes.join('\n')}` })
    }
    return { items: out, files }
  }

  /** Why the last send did not go (round 11, IN5-1): the door's or the chat's code, and the door's sentence. */
  const lastSendFailure = useRef<{ code: string; next?: string } | null>(null)

  /**
   * Hand `items` to Tracy as ONE chat message: `POST /requests` (the server numbers each item and
   * keeps who sent what), then `tracy:comment-send` v3. Resolves whether the chat took it. Comments
   * the items came from stay as they are; `markSent` mirrors the server's `sentToTracy`.
   */
  const sendItems = async (pending: RequestItem[] | Promise<RequestItem[]>, where: SendWhere = 'view'): Promise<boolean> => {
    lastSendFailure.current = null
    if (sendingRef.current) {
      lastSendFailure.current = { code: 'BUSY' }
      return false
    }
    if (Array.isArray(pending) && pending.length === 0) return false
    // A box's own "Not sent." goes as the next try starts.
    if (where === 'popover' || where === 'reply') setSaveError(current => (current?.box === where ? null : current))
    // Busy at once: the buttons wait with the words, the element's lookup included.
    setSending(true)
    // …and Refresh spins at once (round 9): the lookup, the numbering and the chat's answer take seconds.
    onSendRef.current?.('start')
    let took = false
    const requestId = randomId()
    setNotice(null)
    try {
      const items = await pending
      await freshenRef.current()
      // A comment deleted meanwhile is not sent — unless it stays as a tombstone, a reply standing under it.
      const now = storeRef.current.items
      const live = items.filter(item => item.commentId === undefined || now.some(c => c.id === item.commentId && (c.removed !== true || hasLiveReply(now, c.id))))
      if (live.length === 0) return false
      // A comment the server has not numbered yet is waited for: the request names its server id.
      const ids = await Promise.all(live.map(item => (item.commentId === undefined ? Promise.resolve(undefined) : serverIdOfRef.current(item.commentId))))
      const withIds = live.flatMap((item, i) => {
        const id = ids[i]
        if (item.commentId === undefined) return [item]
        return id === null || id === undefined ? [] : [{ ...item, commentId: id }]
      })
      if (withIds.length === 0) return false
      const { items: located, files } = await gatherFiles(await locateAll(withIds))
      let numbers: number[]
      const door = apiRef.current
      if (door === undefined) {
        numbers = located.map((_, i) => i + 1)
      } else {
        const body = { sessionId, requestId, items: located.map(item => ({ url: item.url, element: item.wireElement, text: item.text.trim(), ...(item.commentId === undefined ? {} : { commentId: item.commentId }) })) }
        const answer = await door.requests(body)
        if (!alive.current) return false
        if (!answer.ok) {
          console.warn(`[tracy:browser] Edit: the request door refused (${answer.code}); nothing was sent`)
          lastSendFailure.current = answer.next === null || answer.next === undefined || answer.next === '' ? { code: answer.code } : { code: answer.code, next: answer.next }
          // Round 11 (IN5-5): no network, from a box: said in the box, in plain words. The page box is
          // told through `tracy:comment-act-failed` and says it itself (IN5-1).
          if ((where === 'popover' || where === 'reply') && answer.code === 'NETWORK') setSaveError({ box: where, key: 'commentErrNotSentNetwork' })
          else if (where !== 'page') showServerNoticeRef.current(answer.next, 'send')
          return false
        }
        numbers = answer.value.map(r => r.n)
      }
      const detail = withAttachments(commentSendDetailV3({ sessionId, requestId, siteKey, items: located, numbers }), files)
      const outcome = await sendCommentToChat(detail)
      if (!alive.current) return false
      if (!outcome.ok) {
        lastSendFailure.current = { code: outcome.code }
        // verify6 L5: the page box says why itself (`tracy:comment-act-failed`); the same sentence over
        // the page as well showed it twice. Only a send with no box of its own to say it gets the notice.
        if (where !== 'page') showNotice(outcome.code, requestId)
        return false
      }
      const sent = located.flatMap(item => (item.commentId === undefined ? [] : [item.commentId]))
      if (sent.length > 0) dispatch({ type: 'markSent', ids: sent }, { local: true })
      took = true
      return true
    } finally {
      if (alive.current) setSending(false)
      if (!took) onSendRef.current?.('failed')
    }
  }

  /** What the page says a comment's element reads now (runtime 9), when it said. */
  const wordsNowOf = (c: Comment): string | undefined => wordsNow.current.get(c.id) ?? (c.replyTo === undefined ? undefined : wordsNow.current.get(c.replyTo))

  /**
   * A comment (its first message) as one item: its own words, or `words` typed about it; its thread;
   * the files kept with it and with the replies under it.
   */
  const itemOf = (c: Comment, words: string | null, files: readonly File[] = []): RequestItem => {
    const all = storeRef.current.items
    const stored = [c, ...all.filter(r => r.replyTo === c.id && r.removed !== true).sort((a, b) => a.createdAt - b.createdAt || a.n - b.n)].flatMap(m => m.attachments ?? [])
    const item: RequestItem = {
      url: c.url,
      element: sendElementOf(c, wordsNowOf(c)),
      wireElement: wireElementOf(c),
      locate: c.locate,
      text: words ?? c.text,
      commentId: c.id,
      thread: threadEntriesOf(storeRef.current.items, c.id, words !== null),
    }
    if (c.author !== undefined) item.author = c.author
    item.at = c.createdAt
    if (stored.length > 0) item.stored = stored
    if (files.length > 0) item.files = [...files]
    return item
  }

  // ── A failed save gives its box back (round 5, acceptance v3 TH-2) ──

  /** Open a box that failed, with its words, files and why. The words typed now are never overwritten: see {@link giveBack}. */
  const openFailed = (failed: FailedBox, error: SaveError): void => {
    if (!alive.current) return
    if (failed.box === 'page') return
    if (failed.box === 'reply') {
      if (!storeRef.current.items.some(c => c.id === failed.root)) {
        setServerError(error)
        return
      }
      if (pickedRef.current !== null || editIdRef.current !== null) closePopover()
      setThread(failed.root)
      setReplyText(failed.words)
      draftGiven.current.reply = failed.draft
      setDraftOf('reply', failed.draft)
      setSaveError({ ...error, box: 'reply' })
    } else if (failed.box === 'edit') {
      const c = storeRef.current.items.find(x => x.id === failed.id)
      if (c === undefined || c.removed === true) {
        setServerError(error)
        return
      }
      closeThread()
      if (pickedRef.current !== null) clearPick()
      setEditing(failed.id)
      setWords(failed.words)
      draftGiven.current.popover = failed.draft
      setDraftOf('popover', failed.draft)
      setSaveError({ ...error, box: 'popover' })
    } else {
      closeThread()
      if (editIdRef.current !== null) setEditing(null)
      if (!onRef.current) setMode('edit')
      // The page drew the pick itself and has pointed again since: track it as the active outline.
      const pick: PickedState = { ...failed.pick, carried: true }
      pickedRef.current = pick
      setPicked(pick)
      setWords(failed.words)
      draftGiven.current.popover = failed.draft
      setDraftOf('popover', failed.draft)
      setSaveError({ ...error, box: 'popover' })
    }
    syncTrack()
  }
  const openFailedRef = useRef(openFailed)
  openFailedRef.current = openFailed

  /** A save was refused (or never answered): its box comes back now, or once the box holding words now closes. */
  const giveBack = (failed: FailedBox, answer: Extract<DoorAnswer<unknown>, { ok: false }>): void => {
    if (failed.box === 'page') {
      pageActFailed('add', failed.words, failed.files, answer.code, answer.next)
      return
    }
    const error = saveErrorOf(answer, maxCharsRef.current)
    if (unsavedNow()) {
      parked.current.push({ box: failed, error })
      return
    }
    openFailed(failed, error)
  }
  // A box that failed while another held words: back as soon as nothing typed would be covered.
  useEffect(() => {
    if (parked.current.length === 0 || unsavedRef.current()) return
    const next = parked.current.shift()!
    openFailedRef.current(next.box, next.error)
  })

  // ── The popovers ──

  /** "Add comment": the new pick's words become a people comment; the page points again. */
  const addComment = useCallback((): void => {
    const open = pickedRef.current
    const words = textRef.current
    if (open === null || editIdRef.current !== null || words.trim() === '' || tooLong(words)) return
    const id = randomId()
    const files = draftFiles(draftRef.current)
    if (files.length > 0) createFiles.current.set(id, files)
    failedBoxes.current.set(id, { box: 'popover', pick: open, words, draft: draftRef.current })
    if (dispatch({ type: 'add', id, url: canonicalPageUrl(open.url), element: open.target, locate: null, text: words, now: Date.now() }) !== null) {
      createFiles.current.delete(id)
      failedBoxes.current.delete(id)
      return
    }
    // The pick's own lookup fills the comment's `locate` when it lands.
    const held = lookup.current
    if (held !== null && siteKey !== null) {
      void held.forSend(open.id, signal => locateNowRef.current(locateParams(open.target, open.url), signal)).then((answer) => {
        if (answer !== null && typeof answer === 'object') dispatch({ type: 'setLocate', id, locate: answer as Record<string, unknown> }, { local: true })
      })
    }
    pickedRef.current = null
    setPicked(null)
    setWords('')
    syncTrack()
    post(PREVIEW_PICK.start)
  }, [dispatch, post, setWords, siteKey, syncTrack])

  /**
   * Keep the edit popover's words — and, when its files changed, the whole new list (kept ones, then
   * the new ones once uploaded; §C: a PATCH replaces the list). Unchanged files: `{text}` only.
   */
  const saveEdit = (id: string, words: string): void => {
    const c = storeRef.current.items.find(x => x.id === id)
    const box = draftRef.current
    failedBoxes.current.set(`edit:${id}`, { box: 'edit', id, words, draft: box })
    if (c === undefined || draftKeeps(box, c.attachments ?? [])) {
      dispatch({ type: 'save', id, text: words })
      return
    }
    const files = draftFiles(box)
    if (files.length > 0) saveFiles.current.set(id, files)
    if (dispatch({ type: 'save', id, text: words, attachments: draftStored(box) }) !== null) saveFiles.current.delete(id)
  }
  const saveEditRef = useRef(saveEdit)
  saveEditRef.current = saveEdit

  /** Enter / "Save" in the edit popover. */
  const save = useCallback((): void => {
    const id = editIdRef.current
    if (id === null || textRef.current.trim() === '' || tooLong(textRef.current)) return
    saveEditRef.current(id, textRef.current)
    setEditing(null)
    setWords('')
    syncTrack()
  }, [dispatch, setEditing, setWords, syncTrack])

  /**
   * "Send to Tracy" in a popover (Enter in a new pick's). A new pick: only the words typed here go, and no comment is
   * made (rule 1). The edit popover: the comment, with its words as they now read (saved first when
   * changed), and its replies; it stays.
   */
  const sendToTracy = (): void => {
    const words = textRef.current
    if (words.trim() === '' || sendingRef.current || tooLong(words)) return
    const editing = editIdRef.current
    if (editing !== null) {
      const c = storeRef.current.items.find(x => x.id === editing)
      if (c === undefined) return
      const picked = draftFiles(draftRef.current)
      if (words.trim() !== c.text.trim() || !draftKeeps(draftRef.current, c.attachments ?? [])) saveEdit(c.id, words)
      const now = storeRef.current.items.find(x => x.id === editing) ?? c
      void sendItems([itemOf(now, null, picked)], 'popover').then((ok) => {
        if (!ok || editIdRef.current !== editing) return
        setEditing(null)
        setWords('')
        syncTrack()
      })
      return
    }
    const open = pickedRef.current
    if (open === null) return
    const files = draftFiles(draftRef.current)
    const items = (lookup.current?.forSend(open.id, askFor(open)) ?? Promise.resolve(null)).then((answer): RequestItem[] => {
      const locate = answer !== null && typeof answer === 'object' ? answer as Record<string, unknown> : null
      const page = { url: canonicalPageUrl(open.url), element: open.target, locate }
      const item: RequestItem = { url: page.url, element: sendElementOf(page), wireElement: wireElementOf(page), locate, text: words }
      if (files.length > 0) item.files = files
      return [item]
    })
    void sendItems(items, 'popover').then((ok) => {
      // Sent: the popover closes (no pin: nothing was stored) and the page points again.
      if (!ok || pickedRef.current?.id !== open.id) return
      clearPick()
      setWords('')
      if (onRef.current) post(PREVIEW_PICK.start)
    })
  }
  const sendToTracyRef = useRef(sendToTracy)
  sendToTracyRef.current = sendToTracy

  const close = useCallback((): void => { if (guardRef.current()) closePopover() }, [closePopover])

  /** The window ended, another Delete came, or the page is going away: the comment goes, and its DELETE. */
  const commitDelete = (): void => {
    const p = pendingDelete.current
    if (p === null) return
    pendingDelete.current = null
    clearTimeout(p.timer)
    if (alive.current) setDeleted(null)
    const before = storeRef.current
    // Gone already (a poll said so, or a Delete all took it): nothing to send.
    if (dispatch({ type: 'remove', id: p.id }, { local: true }) !== null) return
    write(p.id, (d, serverId) => d.remove(serverId), changedBy(before, storeRef.current))
    if (!alive.current) return
    if (editIdRef.current === p.id) {
      setEditing(null)
      setWords('')
    }
    // The thread card closes when its first message went and no reply keeps it.
    if (threadIdRef.current === p.id && !storeRef.current.items.some(x => x.id === p.id)) closeThread()
    dropRect(p.id)
    syncTrack()
  }
  const commitDeleteRef = useRef(commitDelete)
  commitDeleteRef.current = commitDelete
  /** A second gone: the number on Undo goes down; at 0 the DELETE goes. */
  const tickDelete = (): void => {
    const p = pendingDelete.current
    if (p === null) return
    p.left -= 1
    if (p.left <= 0) {
      commitDeleteRef.current()
      return
    }
    p.timer = setTimeout(() => { tickDeleteRef.current() }, DELETE_TICK_MS)
    if (alive.current) setDeleted({ id: p.id, left: p.left })
  }
  const tickDeleteRef = useRef(tickDelete)
  tickDeleteRef.current = tickDelete

  const deleteComment = useCallback((id: string): void => {
    const c = storeRef.current.items.find(x => x.id === id)
    if (c === undefined || !isMine(c) || c.removed === true) return
    commitDeleteRef.current()
    // From the edit popover (opened from the card's ⋮ Edit): back to the card, where the spot says it.
    if (editIdRef.current === id) {
      setEditing(null)
      setWords('')
      setThread(c.replyTo ?? c.id)
      setReplyText('')
    }
    const left = DELETE_UNDO_MS / DELETE_TICK_MS
    pendingDelete.current = { id, left, timer: setTimeout(() => { tickDeleteRef.current() }, DELETE_TICK_MS) }
    setDeleted({ id, left })
    syncTrack()
  }, [setEditing, setReplyText, setThread, setWords, syncTrack])

  /** Undo: nothing was changed, so nothing comes back but what the person sees. */
  const undoDelete = useCallback((): void => {
    const p = pendingDelete.current
    if (p === null) return
    pendingDelete.current = null
    clearTimeout(p.timer)
    setDeleted(null)
    syncTrack()
  }, [syncTrack])

  // A Delete not undone is never lost: the page hiding (a tab switched away may be discarded), unloading
  // or this view going away sends it at once (the door client sends DELETE with keepalive).
  useEffect(() => {
    const onHide = (): void => { commitDeleteRef.current() }
    const onVisibility = (): void => { if (document.visibilityState === 'hidden') commitDeleteRef.current() }
    window.addEventListener('pagehide', onHide)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', onHide)
      document.removeEventListener('visibilitychange', onVisibility)
      commitDeleteRef.current()
    }
  }, [])

  /**
   * One physical Esc, wherever it landed (the parent's keydown — `key` = the event, counted once — or
   * the page's `pick-cancel`). One step per press: an open popover closes; else the thread card; else
   * back to Interactive.
   */
  const escape = useCallback((source: 'page' | 'parent', key?: object): void => {
    if (key !== undefined) {
      // A held Esc repeats its keydown: the repeats are the same press, never more steps (IN4-3).
      if ((key as { repeat?: unknown }).repeat === true) return
      if (seenKeys.current.has(key)) return
      seenKeys.current.add(key)
    }
    const now = Date.now()
    const last = lastEsc.current
    if (last !== null && last.source !== source && Math.abs(now - last.at) < (last.box ? ESC_BOX_ECHO_MS : ESC_SAME_PRESS_MS)) return
    const box = editIdRef.current !== null || pickedRef.current !== null || threadIdRef.current !== null
    lastEsc.current = { source, at: now, box }
    if (editIdRef.current !== null || pickedRef.current !== null) {
      const hadPick = pickedRef.current !== null
      if (!guardRef.current()) {
        // Kept. A page-side Esc also stopped the page's picker and took its outline down: arm it
        // again and have it outline the pick as the active item.
        if (source === 'page') {
          if (hadPick) carryPickRef.current(null)
          post(PREVIEW_PICK.start)
        }
        return
      }
      closePopover()
      // A page-side Esc stopped the page's picker: it points again.
      if (source === 'page' && !hadPick) post(PREVIEW_PICK.start)
      return
    }
    if (threadIdRef.current !== null) {
      const drop = guardRef.current()
      if (drop) closeThread()
      if (source === 'page') post(PREVIEW_PICK.start)
      return
    }
    setMode('interactive')
  }, [closePopover, closeThread, post, setMode])
  const escapeRef = useRef(escape)
  escapeRef.current = escape

  // ── The thread card ──

  const openThread = useCallback((id: string): void => {
    const c = storeRef.current.items.find(x => x.id === id)
    if (c === undefined) return
    const rootId = c.replyTo ?? c.id
    if (threadIdRef.current === rootId) return
    if (editIdRef.current !== null) setEditing(null)
    if (pickedRef.current !== null) {
      clearPick()
      post(PREVIEW_PICK.start)
    }
    setWords('')
    setThreadFocus(null)
    setThread(rootId)
    setReplyText('')
    syncTrack()
  }, [clearPick, post, setEditing, setReplyText, setThread, setWords, syncTrack])

  /** "Reply": a people reply in the open thread (a resolved thread opens again). */
  const reply = useCallback((): void => {
    const root = threadIdRef.current
    const words = replyTextRef.current
    if (root === null || words.trim() === '' || tooLong(words)) return
    const id = randomId()
    const files = draftFiles(replyDraftRef.current)
    if (files.length > 0) createFiles.current.set(id, files)
    failedBoxes.current.set(id, { box: 'reply', root, words, draft: replyDraftRef.current })
    if (dispatch({ type: 'reply', id, parentId: root, text: words, now: Date.now() }) !== null) {
      createFiles.current.delete(id)
      failedBoxes.current.delete(id)
      return
    }
    setReplyText('')
    setDraftOf('reply', [])
    setOwnReplies(n => n + 1)
    syncTrack()
  }, [dispatch, setDraftOf, setReplyText, syncTrack])

  /** Enter / "Send to Tracy" in the card: the typed words and the whole thread; the words are no reply. */
  const sendThread = (): void => {
    const root = threadIdRef.current
    const words = replyTextRef.current
    if (root === null || words.trim() === '' || sendingRef.current || tooLong(words)) return
    const c = storeRef.current.items.find(x => x.id === root)
    if (c === undefined) return
    const box = replyDraftRef.current
    void sendItems([itemOf(c, words, draftFiles(box))], 'reply').then((ok) => {
      if (!ok || threadIdRef.current !== root || replyTextRef.current !== words) return
      setReplyText('')
      if (replyDraftRef.current === box) setDraftOf('reply', [])
    })
  }

  // ── A box whose comment someone else deleted (round 11, acceptance v5 V5-3) ──

  /** The lost box now: what it was about (the thread's first message, or the edited comment's), its words and files. */
  const lostNow = (): { about: Comment; words: string; draft: readonly DraftAttachment[] } | null => {
    const key = lostBox.current
    const items = storeRef.current.items
    const edit = editIdRef.current
    if (edit !== null && key === `edit:${edit}` && lastEditing.current?.comment.id === edit && !items.some(c => c.id === edit && c.removed !== true)) {
      return { about: lastEditing.current.root, words: textRef.current, draft: draftRef.current }
    }
    const open = threadIdRef.current
    if (open !== null && key === `thread:${open}` && lastThread.current?.root.id === open && !items.some(c => c.id === open)) {
      return { about: lastThread.current.root, words: replyTextRef.current, draft: replyDraftRef.current }
    }
    return null
  }

  /** Close the lost box: its words and files go with it. */
  const discardLost = (): void => {
    const key = lostBox.current
    lostBox.current = null
    if (key === null) return
    if (key.startsWith('edit:') && editIdRef.current !== null) {
      setEditing(null)
      setWords('')
      setSaveError(current => (current?.box === 'popover' ? null : current))
    } else if (key.startsWith('thread:')) closeThread()
    syncTrack()
  }

  /** "Send to Tracy" in a lost box: its words and files, about the same element; no comment id (there is none now). */
  const sendLost = (): void => {
    const lost = lostNow()
    if (lost === null || lost.words.trim() === '' || sendingRef.current || tooLong(lost.words)) return
    const c = lost.about
    const item: RequestItem = { url: c.url, element: sendElementOf(c, wordsNowOf(c)), wireElement: wireElementOf(c), locate: c.locate, text: lost.words }
    const files = draftFiles(lost.draft)
    if (files.length > 0) item.files = files
    const key = lostBox.current
    void sendItems([item], key?.startsWith('edit:') === true ? 'popover' : 'reply').then((ok) => { if (ok && lostBox.current === key) discardLost() })
  }

  /** "Add as new comment" in a lost box: a new people comment on the same element (or the same page), with its files. */
  const addLost = (): void => {
    const lost = lostNow()
    if (lost === null || lost.words.trim() === '' || tooLong(lost.words)) return
    const c = lost.about
    const id = randomId()
    const files = draftFiles(lost.draft)
    if (files.length > 0) createFiles.current.set(id, files)
    // Refused by the server, the words go back to the Comments view's page box: never lost.
    failedBoxes.current.set(id, { box: 'page', words: lost.words })
    const now = Date.now()
    const refused = c.element === null
      ? dispatch({ type: 'addGeneral', id, url: c.url, text: lost.words, now })
      : dispatch({ type: 'add', id, url: c.url, element: c.element, locate: c.locate, text: lost.words, now })
    if (refused !== null) {
      createFiles.current.delete(id)
      failedBoxes.current.delete(id)
      return
    }
    discardLost()
  }

  /** Resolve (anyone, rule 3): kept, listed under Resolved, off the page; its card closes. */
  const resolve = useCallback((ids: readonly string[]): void => {
    const now = Date.now()
    for (const id of ids) {
      if (dispatch({ type: 'resolve', id, now }) !== null) continue
      if (editIdRef.current === id) {
        setEditing(null)
        setWords('')
      }
      if (threadIdRef.current === id) closeThread()
      dropRect(id)
    }
    syncTrack()
  }, [closeThread, dispatch, dropRect, setEditing, setWords, syncTrack])

  /** ⋮ Edit on one's own message: the edit popover opens for it (at its thread's pin). */
  const editMessage = useCallback((id: string): void => {
    const c = storeRef.current.items.find(x => x.id === id)
    if (c === undefined || !isMine(c) || c.removed === true) return
    closeThread()
    if (pickedRef.current !== null) {
      clearPick()
      post(PREVIEW_PICK.start)
    }
    setEditing(id)
    setWords(c.text)
    syncTrack()
  }, [clearPick, closeThread, post, setEditing, setWords, syncTrack])

  const copyLinkRef = useRef(options.copyCommentLink)
  copyLinkRef.current = options.copyCommentLink
  const copyLink = useCallback(async (id: string): Promise<boolean> => {
    const c = storeRef.current.items.find(x => x.id === id)
    const copy = copyLinkRef.current
    if (c === undefined || copy === undefined) return false
    return await copy(c)
  }, [])

  // ── The Comments view ──

  const releaseHold = useCallback((): void => {
    if (revealHold.current === null) return
    revealHold.current = null
    setHeldId(null)
    syncTrack()
  }, [syncTrack])
  // 🔒 A REVEALED RESOLVED COMMENT IS HELD FOR AS LONG AS ITS CARD IS OPEN (Brian 29/09/2026 22:33).
  // It was held 1.5 s, for the scroll and the flash: then the page let the element go, its box went
  // with it, and the open card fell back to the frame's top corner — to the person, the page "jumped
  // back to the top". Closing the card (or opening another thread) lets it go; it has no pin after.
  useEffect(() => {
    if (revealHold.current !== null && threadId !== revealHold.current) releaseHold()
  }, [threadId, releaseHold])

  /**
   * Play the waiting reveal once its page is the document in the frame, in Edit: scroll to it and
   * flash it (`pick-reveal`, runtime 7), then open its thread card (or its edit popover). A comment
   * about the whole page has no element: its card opens at the frame's top corner.
   */
  const revealNow = useCallback((announced = false): void => {
    const waiting = pendingReveal.current
    if (waiting === null) return
    const comment = storeRef.current.items.find(c => c.id === waiting.id)
    if (comment === undefined) {
      pendingReveal.current = null
      return
    }
    const root = storeRef.current.items.find(c => c.id === (comment.replyTo ?? comment.id)) ?? comment
    // Round 11 (acceptance v5 EDGE-9): a link's comment waits for its page, but the page announced is
    // another one (the link's `page=` named it, or the tab record moved the address back after the link
    // asked for the comment's page). Its page is loaded again, at most {@link LINK_PAGE_TRIES} times.
    if (announced && waiting.link !== undefined && docUrlRef.current !== null && docUrlRef.current !== root.url) {
      if (waiting.link >= LINK_PAGE_TRIES) {
        pendingReveal.current = null
        console.info('[tracy:browser] Edit: the linked comment\'s page did not stay loaded; the link opened nothing')
        return
      }
      pendingReveal.current = { ...waiting, link: waiting.link + 1 }
      navigateRef.current?.(root.url)
      return
    }
    if (root.element !== null && (!onRef.current || pageOrigin.current === null || docUrlRef.current !== root.url)) return
    if (root.element === null && docUrlRef.current !== root.url) return
    pendingReveal.current = null
    if (waiting.then === 'edit') editMessage(comment.id)
    else {
      openThread(root.id)
      // Round 6 (acceptance v4 thread): a link to a reply opens the card AT that reply, highlighted.
      setThreadFocus(comment.id === root.id ? null : comment.id)
    }
    if (root.element === null || !trackableRef.current || !revealableRef.current) return
    if (root.status === 'resolved') {
      revealHold.current = root.id
      setHeldId(root.id)
    }
    syncTrack()
    const message = pickRevealMessage(root.id)
    const target = frameRef.current?.contentWindow
    if (message === null || target == null) return
    try { target.postMessage(message, pageOrigin.current!) } catch { /* the frame navigated away */ }
  }, [editMessage, frameRef, openThread, syncTrack])
  const revealNowRef = useRef(revealNow)
  revealNowRef.current = revealNow

  const activeRef = useRef(options.active)
  activeRef.current = options.active
  const revealTabRef = useRef(options.revealTab)
  revealTabRef.current = options.revealTab
  const navigateRef = useRef(options.navigate)
  navigateRef.current = options.navigate

  /**
   * Show a comment: the tab comes on screen, turns to Edit, loads the comment's page when it shows
   * another, scrolls to it and opens its thread card at the pin (or its edit popover, `then`).
   */
  const revealAs = useCallback((id: string, then: 'thread' | 'edit'): void => {
    const comment = storeRef.current.items.find(c => c.id === id)
    if (comment === undefined) return
    // Opening another comment drops the open box: words typed there are asked about first.
    if (!guardRef.current()) return
    if (activeRef.current === false) revealTabRef.current?.()
    const root = storeRef.current.items.find(c => c.id === (comment.replyTo ?? comment.id)) ?? comment
    if (!onRef.current && root.element !== null) selectEditRef.current()
    pendingReveal.current = { id, then }
    if (docUrlRef.current !== root.url) {
      navigateRef.current?.(root.url)
      return
    }
    revealNow()
  }, [revealNow])
  const reveal = useCallback((id: string): void => { revealAs(id, 'thread') }, [revealAs])

  /** The page box's `add` was not kept: the Comments view puts its words (and files) back (round 5, TH-2). */
  const pageActFailed = (kind: 'add' | 'send', words: string, files: readonly File[] = [], code?: string, next?: string | null): void => {
    const tabId = listFacts.current.tabId
    if (tabId === undefined) return
    const detail: CommentActFailedDetail = { tabId, sessionId, kind, text: words }
    if (files.length > 0) detail.files = [...files]
    if (code !== undefined) detail.code = code
    if (typeof next === 'string' && next !== '') detail.next = next
    window.dispatchEvent(new CustomEvent(COMMENT_ACT_FAILED_EVENT, { detail }))
  }
  const pageActFailedRef = useRef(pageActFailed)
  pageActFailedRef.current = pageActFailed

  /** The Comments view's Delete all was not saved (e2e v7 INTH-1): it puts its rows back and says so. */
  const clearFailed = (ids: readonly string[], code: string, next?: string | null): void => {
    const tabId = listFacts.current.tabId
    if (tabId === undefined) return
    const detail: CommentActFailedDetail = { tabId, sessionId, kind: 'clear', ids: [...ids], text: '', code }
    if (typeof next === 'string' && next !== '') detail.next = next
    window.dispatchEvent(new CustomEvent(COMMENT_ACT_FAILED_EVENT, { detail }))
  }
  const clearFailedRef = useRef(clearFailed)
  clearFailedRef.current = clearFailed

  /** "Add a comment…" of the Comments view: a people comment about the page the tab shows, with the box's files. */
  const addGeneral = useCallback((words: string, files: readonly File[] = []): CommentRefusal | null => {
    const page = docUrlRef.current ?? (addressRef.current === undefined ? null : canonicalPageUrl(addressRef.current))
    if (page === null) return 'unknown'
    // Longer than the server keeps: nothing is made; the box gets its words back and says why.
    if (tooLong(words)) {
      pageActFailedRef.current('add', words, files, 'COMMENT_TOO_LONG')
      return 'unknown'
    }
    const id = randomId()
    if (files.length > 0) createFiles.current.set(id, [...files])
    failedBoxes.current.set(id, { box: 'page', words, files: [...files] })
    const refused = dispatch({ type: 'addGeneral', id, url: page, text: words, now: Date.now() })
    if (refused !== null) {
      createFiles.current.delete(id)
      failedBoxes.current.delete(id)
    }
    return refused
  }, [dispatch])

  /** Delete all (rule 12): every comment on the page, open and resolved, everyone's; the view's Undo came first. */
  const clearAll = useCallback((ids?: readonly string[]): void => {
    commitDeleteRef.current()
    const named = ids === undefined ? undefined : storeRef.current.items.find(c => ids.includes(c.id))
    const page = named?.url ?? docUrlRef.current
    if (page === null) return
    const threadOpen = threadIdRef.current
    if (dispatch(ids === undefined ? { type: 'clear', url: page } : { type: 'clear', url: page, ids }) !== null) return
    if (editIdRef.current !== null && !storeRef.current.items.some(c => c.id === editIdRef.current && c.removed !== true)) {
      setEditing(null)
      setWords('')
    }
    if (threadOpen !== null && !storeRef.current.items.some(c => c.id === threadOpen && c.removed !== true)) closeThread()
    setRects(new Map())
    syncTrack()
  }, [closeThread, dispatch, setEditing, setWords, syncTrack])

  /** "Send N to Tracy" (rule 1): the ticked comments (open), as ONE chat message; they stay. */
  const sendSome = (ids: readonly string[]): void => {
    const chosen = new Set(ids)
    // A tombstone (its first message deleted, a reply standing) is a thread and goes too: no words of its
    // own, its replies as the thread (chat-input reads it as "(comment deleted)"), so what is sent is what
    // "Send all (N)" counted.
    const all = storeRef.current.items
    const items = all.filter(c => chosen.has(c.id) && isOpenThread(c, all)).sort((a, b) => a.n - b.n)
    void sendItems(items.map(c => itemOf(c, null)))
  }

  /** The Comments view's "Add a comment…" → "Send to Tracy": whole-page words, no comment made. */
  const sendPage = (words: string, files: readonly File[] = []): void => {
    const page = docUrlRef.current ?? (addressRef.current === undefined ? null : canonicalPageUrl(addressRef.current))
    if (page === null || words.trim() === '' || tooLong(words)) return
    const item: RequestItem = { url: page, element: null, wireElement: null, locate: null, text: words }
    if (files.length > 0) item.files = [...files]
    // Round 11 (IN5-1): the page box emptied when it handed its words over; a send that did not go gives them back.
    void sendItems([item], 'page').then((ok) => {
      if (ok) return
      const why = lastSendFailure.current
      pageActFailedRef.current('send', words, files, why?.code ?? 'unknown', why?.next)
    })
  }

  // `tracy:comment-list`: the site's comments, for the chat column, on every change and when asked.
  //
  // 🔒 ONLY THE CONVERSATION ON SCREEN SPEAKS (round 6, acceptance v4 SEND-v4-new-1). A Browser tab of a
  // conversation left behind stays mounted (round 5), and dsh mints tab ids per conversation, so its
  // list would land on the entry of the tab on screen that holds the same id. Leaving says
  // `active: false` once; after that the tab is silent (no list on a change, no answer to `list`) until
  // its conversation is shown again, when it speaks after the retirement of the one left (a microtask:
  // every effect of that commit has run by then).
  const onScreen = options.active !== false
  const conversationShown = options.conversationShown !== false
  const listFacts = useRef({ sessionId, tabId: options.tabId, siteKey, active: onScreen, shown: conversationShown, url: docUrl, address: url })
  listFacts.current = { sessionId, tabId: options.tabId, siteKey, active: onScreen, shown: conversationShown, url: docUrl, address: url }
  const announceList = useCallback((shown?: boolean): void => {
    const facts = listFacts.current
    if (facts.tabId === undefined) return
    let host: string | null
    try { host = facts.address === undefined ? null : new URL(facts.address).hostname } catch { host = null }
    const detail = commentListDetail({ sessionId: facts.sessionId, tabId: facts.tabId, siteKey: facts.siteKey, host, active: shown ?? facts.active, url: facts.url, store: shownOfRef.current(storeRef.current), attachments: limitsRef.current, maxChars: maxCharsRef.current })
    window.dispatchEvent(new CustomEvent(COMMENT_LIST_EVENT, { detail }))
  }, [])
  /** This tab has spoken since its conversation came on screen (so leaving must retire it). */
  const saidShown = useRef(false)
  useEffect(() => {
    if (!conversationShown) {
      if (saidShown.current) {
        saidShown.current = false
        announceList(false)
      }
      return
    }
    if (saidShown.current) {
      announceList()
      return
    }
    saidShown.current = true
    let live = true
    queueMicrotask(() => { if (live && listFacts.current.shown) announceList() })
    return () => { live = false }
  }, [store, deleted, hiddenTick, onScreen, conversationShown, docUrl, url, options.tabId, sessionId, limits, maxChars, announceList])
  useEffect(() => () => { if (saidShown.current) announceList(false) }, [announceList])

  /** `hide` / `show` (round 5, TH-7): the view's Delete all window takes these off the page at once, or puts them back. */
  const setHidden = useCallback((ids: readonly string[], off: boolean): void => {
    const map = hidden.current
    for (const id of ids) {
      const timer = map.get(id)
      if (timer !== undefined) clearTimeout(timer)
      map.delete(id)
      if (off) map.set(id, setTimeout(() => { setHiddenRef.current([id], false) }, HIDE_LAPSE_MS))
    }
    if (!alive.current) return
    setHiddenTick(n => n + 1)
    syncTrack()
  }, [syncTrack])
  const setHiddenRef = useRef(setHidden)
  setHiddenRef.current = setHidden
  useEffect(() => () => { for (const timer of hidden.current.values()) clearTimeout(timer) }, [])

  // `tracy:comment-act`: the Comments view acting on THIS tab's comments.
  const actions = useRef({ resolve, reveal, clearAll, sendSome, sendPage, addGeneral, deleteComment, editFromList: (_id: string) => {}, replyTo: (_id: string, _text: string) => {} })
  useEffect(() => {
    const onAct = (event: Event): void => {
      const act = readCommentAct((event as CustomEvent).detail)
      const facts = listFacts.current
      if (act === null || !actIsFor(act, { tabId: facts.tabId, sessionId: facts.sessionId, shown: facts.shown })) return
      const a = actions.current
      const ids = act.ids ?? []
      switch (act.kind) {
        case 'resolve': a.resolve(ids); return
        case 'remove': for (const id of ids) a.deleteComment(id); return
        case 'reveal': if (ids[0] !== undefined) a.reveal(ids[0]); return
        case 'clear':
          if (act.ids !== undefined) setHiddenRef.current(act.ids, false)
          a.clearAll(act.ids)
          return
        case 'hide': if (act.ids !== undefined) setHiddenRef.current(act.ids, true); return
        case 'show': if (act.ids !== undefined) setHiddenRef.current(act.ids, false); return
        case 'send':
          // The page box: ONLY its words, never "everything pending" (there is no such thing now).
          if (act.page === true) { if (act.text !== undefined) a.sendPage(act.text, act.files) }
          else if (act.ids !== undefined) a.sendSome(ids)
          return
        case 'add': if (act.text !== undefined) a.addGeneral(act.text, act.files); return
        case 'list': announceList(); return
        case 'edit': if (ids[0] !== undefined) a.editFromList(ids[0]); return
        case 'reply': if (ids[0] !== undefined && act.text !== undefined) a.replyTo(ids[0], act.text); return
      }
    }
    window.addEventListener(COMMENT_ACT_EVENT, onAct)
    return () => { window.removeEventListener(COMMENT_ACT_EVENT, onAct) }
  }, [announceList])

  /** The view's Edit on a row: reveal, then the edit popover. */
  const editFromList = useCallback((id: string): void => {
    const c = storeRef.current.items.find(x => x.id === id)
    if (c === undefined || !isMine(c) || c.removed === true) return
    revealAs(id, 'edit')
  }, [revealAs])

  /** The view's `reply` act: a people reply to a comment, without opening its card. */
  const replyTo = useCallback((parentId: string, words: string): void => {
    if (words.trim() === '') return
    if (dispatch({ type: 'reply', id: randomId(), parentId, text: words, now: Date.now() }) === null) syncTrack()
  }, [dispatch, syncTrack])

  actions.current = { resolve, reveal, clearAll, sendSome, sendPage, addGeneral, deleteComment, editFromList, replyTo }

  // A deep link's `comment=<id>` (rule 6): once the first list is in, show it.
  const linkRef = useRef(options.commentLink ?? null)
  const takenRef = useRef(options.onCommentLinkTaken)
  takenRef.current = options.onCommentLinkTaken
  useEffect(() => {
    const id = linkRef.current
    if (id === null || commentLinkTaken || (api !== undefined && !loadedOnce.current)) return
    commentLinkTaken = true
    linkRef.current = null
    takenRef.current?.()
    if (storeRef.current.items.some(c => c.id === id)) {
      reveal(id)
      // Round 11 (EDGE-9): a link's reveal loads its comment's page again if another one turns up.
      if (pendingReveal.current?.id === id) pendingReveal.current = { ...pendingReveal.current, link: 0 }
    } else console.info('[tracy:browser] Edit: the linked comment is not on this site any more')
  }, [api, listLoaded, reveal])

  // A box's files belong to the box: a new pick starts empty, a reopened comment with its kept files,
  // another thread's reply box empty.
  const popoverKey = picked !== null ? `pick:${String(picked.id)}` : editId !== null ? `edit:${editId}` : null
  useEffect(() => {
    // A box a failed save gave back keeps the files it had (round 5, TH-2).
    const given = draftGiven.current.popover
    if (given !== undefined) {
      setDraftOf('popover', given)
      return
    }
    const reopened = editIdRef.current === null ? undefined : storeRef.current.items.find(c => c.id === editIdRef.current)
    setDraftOf('popover', reopened === undefined || popoverKey === null || !popoverKey.startsWith('edit:') ? [] : draftOfStored(reopened.attachments ?? []))
  }, [popoverKey, setDraftOf])
  useEffect(() => { setDraftOf('reply', draftGiven.current.reply ?? []) }, [threadId, setDraftOf])
  // Given back once: the next box starts as boxes do.
  useEffect(() => { draftGiven.current = {} })

  const addFiles = useCallback((box: AttachmentBox, files: readonly File[]): void => {
    if (files.length === 0) return
    const current = box === 'popover' ? draftRef.current : replyDraftRef.current
    const room = limitsRef.current
    // One cap for both roads: what the server keeps (§C) and what the chat takes (§A, 20 MiB · 20).
    const step = addToDraft(current, files, { maxBytes: Math.min(room.maxBytes, ATTACHMENT_MAX_BYTES), maxFiles: Math.min(room.maxFiles, ATTACHMENT_MAX_FILES) })
    setDraftOf(box, step.draft)
    if (step.refused !== null) setDraftError({ box, refusal: step.refused })
  }, [setDraftOf])
  const removeDraft = useCallback((box: AttachmentBox, key: string): void => {
    const current = box === 'popover' ? draftRef.current : replyDraftRef.current
    setDraftOf(box, current.filter(d => d.key !== key))
  }, [setDraftOf])

  const editingLive = editId === null ? null : store.items.find(c => c.id === editId && c.removed !== true) ?? null
  const threadLive = threadId === null ? null : store.items.find(c => c.id === threadId) ?? null
  // Round 11 (acceptance v5 V5-3): another seat deleted the comment of the open box (Delete all, or a
  // first message with no reply) while words or files waited in it. The box used to close with them at
  // the next poll, saying nothing; the poll now marks it lost (`applyRows`) and it stays with them and
  // what it showed, until it is sent, added or dropped.
  if (threadLive !== null) lastThread.current = { root: threadLive, messages: threadMessagesOf(store.items, threadLive.id) }
  if (editingLive !== null) lastEditing.current = { comment: editingLive, root: store.items.find(c => c.id === editingLive.replyTo) ?? editingLive }
  const threadLost = threadId !== null && threadLive === null && lastThread.current?.root.id === threadId && lostBox.current === `thread:${threadId}`
  const editLost = editId !== null && editingLive === null && lastEditing.current?.comment.id === editId && lostBox.current === `edit:${editId}`
  const editing = editingLive ?? (editLost ? lastEditing.current!.comment : null)
  const foot: CommentFoot | null = on && editing !== null ? 'edit' : on && picked !== null ? 'new' : null
  const threadRoot = threadLive ?? (threadLost ? lastThread.current!.root : null)
  const lost: 'thread' | 'edit' | null = foot === 'edit' && editLost ? 'edit' : foot === null && threadLost ? 'thread' : null
  const typing = (foot !== null && (text.trim() !== '' || draftFiles(draft).length > 0)) || (threadRoot !== null && (replyText.trim() !== '' || replyDraft.length > 0))
  // A box open (a popover or a thread card): a holdable page is told to hold its clicks, and let go after.
  const boxOpen = foot !== null || threadRoot !== null
  // The reload waits for a popover, or for a card whose reply box holds something (round 5, SEND-new-2).
  const holdsReload = foot !== null || (threadRoot !== null && (replyText.trim() !== '' || replyDraft.length > 0))
  useEffect(() => {
    const want = boxOpen && holdable
    if (heldRef.current === want || !holdableRef.current || pageOrigin.current === null) return
    const target = frameRef.current?.contentWindow
    if (target == null) return
    try { target.postMessage(previewHoldMessage(want), pageOrigin.current) } catch { return }
    heldRef.current = want
  }, [boxOpen, holdable, docTick, frameRef])
  const onPageOutside = useCallback((fn: (at: { x: number; y: number }) => void): (() => void) => {
    outsideListeners.current.add(fn)
    return () => { outsideListeners.current.delete(fn) }
  }, [])
  const wheelPage = useCallback((dx: number, dy: number, id: string | null = null): void => {
    const target = frameRef.current?.contentWindow
    if (pageOrigin.current === null || target == null) return
    if (wheelableRef.current) {
      // Runtime 16: the page scrolls the box the element sits in (or itself), from where it is now.
      const message = previewWheelMessage(dx, dy, id)
      // 🔒 To the page's own origin, never '*'.
      try { if (message !== null) target.postMessage(message, pageOrigin.current) } catch { /* the frame navigated away */ }
      return
    }
    if (!scrollableRef.current) return
    const now = Date.now()
    if (wheelTo.current === null || now - wheelAt.current > WHEEL_IDLE_MS) {
      if (lastScroll.current === null) return
      wheelTo.current = { ...lastScroll.current }
    }
    wheelAt.current = now
    const next = { x: Math.max(0, wheelTo.current.x + dx), y: Math.max(0, wheelTo.current.y + dy) }
    wheelTo.current = next
    const message = previewScrollToMessage(next.x, next.y)
    // 🔒 To the page's own origin, never '*'.
    try { if (message !== null) target.postMessage(message, pageOrigin.current) } catch { /* the frame navigated away */ }
  }, [frameRef])
  const shown = shownOf(store)
  const unsaved = unsavedNow()

  return {
    frameSrc,
    dropTicket,
    onFrameLoad,
    modes: {
      visible: pickAvailable || (on && gated && tracySite),
      edit: on,
      unavailable: on && (recovery.status === 'unavailable' || pickerGone),
      selectEdit,
      selectInteractive,
      reload: reloadForPicker,
    },
    doc: docTick,
    picked: on ? picked : null,
    text,
    setText: (words: string) => {
      setWords(words)
      setSaveError(current => (current?.box === 'popover' ? null : current))
    },
    comments: shown.items,
    pageComments: trackable || on ? pageCommentsOf(shown, docUrl, heldId) : [],
    pageUrl: docUrl,
    rects,
    foot,
    editing: foot === 'edit' ? editing : null,
    sending,
    notice: notice === null ? null : notice.code,
    serverNotice,
    serverNoticeKind,
    serverError,
    saveError,
    maxChars,
    addComment,
    save,
    sendToTracy: () => { sendToTracyRef.current() },
    close,
    deleteComment,
    deleted,
    undoDelete,
    escape,
    flash,
    unsaved,
    mayLeave,
    clickedOutside,
    wheelPage,
    thread: threadRoot,
    threadMessages: threadRoot === null ? [] : threadLive === null ? lastThread.current!.messages : threadMessagesOf(store.items, threadRoot.id),
    threadFocus: threadRoot === null ? null : threadFocus,
    ownReplies,
    replyText,
    setReplyText: (words: string) => {
      setReplyText(words)
      setSaveError(current => (current?.box === 'reply' ? null : current))
    },
    openThread,
    closeThread,
    reply,
    sendThread,
    resolve,
    editMessage,
    copyLink,
    lost,
    sendLost,
    addLost,
    discardLost,
    reveal,
    addGeneral,
    clearAll,
    sendSome,
    sendPage,
    siteChangedAt,
    typing,
    boxOpen,
    holdsReload,
    holdable,
    onPageOutside,
    attachments: limits,
    draft: foot === null ? [] : draft,
    replyDraft: threadRoot === null ? [] : replyDraft,
    draftError,
    addFiles,
    removeDraft,
  }
}
