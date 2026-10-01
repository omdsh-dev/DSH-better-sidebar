/**
 * Edit mode in Tracy's browser tab — what it draws (Tracy, 27/09/2026; people-only comments since
 * 29/09/2026).
 *
 * A port of the stories in TCH `packages/dev/tracy-design/src/mockups/browser-comment.mock.stories.tsx`
 * (the ONLY source of truth, "Browser comment") to plain CSS on dsh's `--dsw-*` tokens: this runs inside
 * the dsh page, where Tailwind and a second reset are forbidden (TCH RULE #4).
 *
 * The split with the page: the OUTLINE — dashed while pointing, solid once picked, a thin line round
 * each open comment — is drawn by the page itself (`@tracy/cms-preview`, inside the cross-origin
 * frame). The bubbles, the popover, the thread card and the hint are drawn here, in a layer laid over
 * the stage's visible area, placed with the boxes the page reports (multiplied by the tab's zoom).
 *
 * Stage 6 (TCH `tasks/todo-comment-people.md` rules 1–12; stories PopoverTwoButtonsEmpty ·
 * PopoverTwoButtonsTyped · PopoverEditPending · ThreadCardSendToChat · CommentsTabRowOpensCard ·
 * ToolbarCommentsButton[Zero|Compact] · Refresh*):
 *   - The popover (`CommentPopover`, 340 px): a header "Comment" + ✕; the text box ("Describe what
 *     should change…"); "Add comment" (outline, a click only) and "Send to Tracy ↵" (primary, its key
 *     small and muted), both disabled while empty. Enter (and ⌘/Ctrl+Enter) sends to Tracy, Shift+Enter
 *     is a new line — dsh's chat composer rule (`comment-keys.ts`, Brian 30/09); the text box grows with
 *     its words up to {@link TEXT_MAX_HEIGHT}, then scrolls inside. A comment reopened for editing: "Save ↵" (Enter saves), "Send to Tracy" (a
 *     click only) and a small red "Delete". No "+ Add another".
 *   - Pins (`AvatarPin`): the AUTHOR's bubble — the initial in a 22 px round badge filled in the
 *     author's colour, its bottom-left corner pointing at the block's top-left. No number, no status.
 *   - The thread card (`ThreadCard`, 340 px, at the pin): the messages in time order, ⋮ per message
 *     (Edit and Delete on one's own, Copy link on every one), "Reply…", Resolve, "Reply" (a click
 *     only) and "Send to Tracy ↵" (Enter). No ✕: Esc or a click outside closes it.
 *   - Files (TCH attachments contract; stories PopoverTwoButtons… · ThreadCardSendToChat): a paperclip at
 *     the foot's left of each box (the dsh composer's own icon) opens a file picker; files can also be
 *     dropped on the box or pasted into its text. They show as chips under the text (a thumbnail for an
 *     image, name + size otherwise, ✕ to remove), and a refused one is said in the box. A thread card
 *     shows each message's kept files: lazy thumbnails, name + size, a click opens it in a new tab. No
 *     paperclip when the server keeps no files (`attachments.enabled` false).
 *   - The toolbar: ONE button "Comments N" (`CommentsButton`), N = every open comment on the site,
 *     grey, always shown; a click opens the chat column's Comments tab. Refresh carries Tracy's
 *     progress (`RefreshButton`, `refresh-progress.ts`); nothing about a turn is drawn on the page.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { LuCheck, LuCopy, LuLink2, LuMessageSquare, LuMousePointer2, LuMousePointerClick, LuPencil, LuSearchX, LuTrash2, LuX } from 'react-icons/lu'
import { LuEllipsisVertical } from 'react-icons/lu'
import { IconPaperclipOutlineRegular, IconRefreshOutlineRegular, Menu, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import { COMPOSITION_TAIL_MS, enterGesture } from './comment-keys.ts'
import { aimedAtBox, boxStand, compactPopoverWidth, hiddenName, isCompactFrame, pinnable, popoverPlacement, threadCardMaxHeight, AIMED_MS, type BoxTrail, type CommentFailureCode, type ShownRect } from './comment-model.ts'
import { ZOOM_LEVELS, scaleRect, type StageScroll } from './browser-mode.ts'
import { DELETE_UNDO_MS, type AttachmentBox, type CommentMode } from './comment-controller.ts'
import { formatBytes, isImageType, type CommentAttachment, type DraftAttachment, type DraftRefusal } from './comment-attachments.ts'
import { authorColor, authorColours, authorLabels, isMine, pageOpenCount, type Comment, type CommentAuthor } from './comment-store.ts'
import { charCount, type SaveError } from './comment-errors.ts'
import type { RefreshLook } from './refresh-progress.ts'
import { relativeTime, t, type CopyKey } from './locales.ts'
import { PREVIEW_CHANNEL, PREVIEW_PICK, PREVIEW_VERSION, isPreviewMessage, type PreviewPickRect, type PreviewPickTarget } from './preview-protocol.generated.ts'
import css from './sidebar.module.css'

const cx = (...names: Array<string | false | null | undefined>): string => names.filter(Boolean).join(' ')

const FAILURE_COPY: Record<CommentFailureCode, CopyKey> = {
  'no-session': 'editFailedNoSession',
  'site-mismatch': 'editFailedSiteMismatch',
  'subagent-readonly': 'editFailedReadonly',
  rejected: 'editFailedRejected',
  timeout: 'editFailedTimeout',
  'no-listener': 'editFailedNoListener',
  'too-long': 'editFailedTooLong',
  'attachment-too-large': 'editFailedAttachmentTooLarge',
  'attachment-failed': 'editFailedAttachmentFailed',
  unknown: 'editFailedUnknown',
}

// ── The mode bar ────────────────────────────────────────────────────────────────────────────

/** The zoom control: a chip showing the value that opens dsh's Menu of the levels. */
function ZoomMenu(props: { zoom: number; onZoom: (zoom: number) => void }): ReactElement {
  const { zoom, onZoom } = props
  const [open, setOpen] = useState(false)
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={ZOOM_LEVELS.map(level => ({ id: String(level), label: `${String(level)}%` }))}
      selectedId={String(zoom)}
      onSelect={(id) => {
        setOpen(false)
        onZoom(Number(id))
      }}
      portal
      compact
      align="end"
      anchor={(
        <Pill
          className={css.zoomChip}
          aria-label={t('browserZoom')}
          aria-haspopup="menu"
          aria-expanded={open}
          title={t('browserZoom')}
          onClick={() => { setOpen(value => !value) }}
        >
          {`${String(zoom)}%`}
        </Pill>
      )}
    />
  )
}

/**
 * The right end of the address bar: the zoom value (hidden in a frame under 360 px), then
 * Interactive | Edit (only where the picker can run — `modes.visible`) and, after Edit, `children`
 * (the Comments button).
 */
export function ModeBar(props: {
  zoom: number
  onZoom: (zoom: number) => void
  modes: CommentMode['modes'] | null
  compact?: boolean
  hideZoom?: boolean
  children?: ReactNode
}): ReactElement {
  const { zoom, onZoom, modes, compact = false, hideZoom = false, children } = props
  return (
    <div className={css.modeBar}>
      {!hideZoom && <ZoomMenu zoom={zoom} onZoom={onZoom} />}
      {modes !== null && modes.visible && (
        // Round 5 (acceptance v3 J38): a press here keeps the focus in the page — a WordPress mobile menu
        // opened in Interactive closes as soon as the page loses it, so pressing Edit closed the menu
        // before its items could be picked. The click still switches; the keyboard still reaches both.
        <div className={css.modeSegments} role="group" aria-label={t('browserMode')} onMouseDown={(event) => { event.preventDefault() }}>
          <button
            type="button"
            className={cx(css.modeSegment, !modes.edit && css.modeSegmentOn, compact && css.modeSegmentIcon)}
            aria-label={t('modeInteractive')}
            aria-pressed={!modes.edit}
            title={t('modeInteractiveTitle')}
            onClick={modes.selectInteractive}
          >
            <LuMousePointer2 size={14} aria-hidden />
          </button>
          <button
            type="button"
            className={cx(css.modeSegment, modes.edit && !modes.unavailable && css.modeSegmentOn, modes.unavailable && css.modeSegmentUnavailable, compact && css.modeSegmentIcon)}
            aria-label={t('editButton')}
            aria-pressed={modes.edit}
            title={modes.unavailable ? t('editUnavailable') : t('editTitle')}
            onClick={modes.selectEdit}
          >
            {modes.unavailable ? <LuSearchX size={13} aria-hidden /> : <LuPencil size={13} aria-hidden />}
            {!compact && <span>{t('editButton')}</span>}
          </button>
        </div>
      )}
      {modes !== null && modes.visible && children}
    </div>
  )
}

/**
 * "Comments N" (rule 9, stories ToolbarCommentsButton · …Zero · …Compact): N = open comments of the
 * page the tab shows, all authors (`pageOpenCount`, UI fine-tune 30/09 U16 — the Comments tab's
 * `Current page` number), grey, "Comments 0" at zero so the toolbar never moves. A click
 * opens the chat column's Comments tab. No ▾, no menu. Compact: the icon with the count as a corner
 * badge; the word in the tooltip and `aria-label`.
 */
export function CommentsButton(props: { comments: readonly Comment[]; url: string | null; compact: boolean; onOpen: () => void }): ReactElement {
  const { comments, url, compact, onOpen } = props
  const count = pageOpenCount(comments, url)
  return (
    <button
      type="button"
      className={cx(css.commentsButton, compact && css.commentsButtonIcon)}
      aria-label={t('commentsButtonCount', { count })}
      title={t('commentsButton')}
      onClick={onOpen}
    >
      <LuMessageSquare size={13} aria-hidden />
      {!compact && <span>{t('commentsButton')}</span>}
      <span className={cx(css.commentsCount, compact && css.commentsCountCorner)}>{String(count)}</span>
    </button>
  )
}

/** How long the copy button's tooltip says "Link copied" (story ToolbarCopyLinkCopied: about 1.5 s). */
export const COPY_FEEDBACK_MS = 1_500

/**
 * "Copy link to this page in this mode", in Go's slot beside the address. After a click its OWN
 * tooltip reads "Link copied" with a tick for {@link COPY_FEEDBACK_MS}.
 */
export function CopyLinkButton(props: { onCopy: () => Promise<boolean> }): ReactElement {
  const { onCopy } = props
  const [said, setSaid] = useState<'copied' | 'failed' | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])
  return (
    <span className={css.copyLink}>
      <button
        type="button"
        className={css.iconButton}
        aria-label={t('browserCopyLink')}
        title={said === null ? t('browserCopyLink') : undefined}
        onClick={() => {
          void onCopy().then((copied) => {
            setSaid(copied ? 'copied' : 'failed')
            if (timer.current !== null) clearTimeout(timer.current)
            timer.current = setTimeout(() => {
              timer.current = null
              setSaid(null)
            }, COPY_FEEDBACK_MS)
          })
        }}
      >
        {said === 'copied' ? <LuCheck size={14} aria-hidden /> : <LuCopy size={14} aria-hidden />}
      </button>
      {said !== null && (
        <span role="status" className={css.copyLinkTip}>
          {t(said === 'copied' ? 'browserLinkCopied' : 'browserLinkCopyFailed')}
        </span>
      )}
    </span>
  )
}

const REFRESH_CHIP: Record<RefreshLook, CopyKey | null> = {
  idle: null,
  working: 'refreshWorking',
  'working-long': null,
  updated: 'refreshUpdated',
  ready: 'refreshReady',
}

/**
 * Refresh as the one place a turn's progress shows (rule 5; stories RefreshWorking · RefreshWorkingLong
 * · RefreshNewVersionUpdated · RefreshNewVersionReady · …Compact): spinning while Tracy works (chip for
 * the first 3 s), still with "New version updated" for 3 s once the page reloaded itself, terracotta
 * with "New version ready" until clicked. The chip is dark, under the button, its arrow on its centre.
 */
export function RefreshButton(props: { look: RefreshLook; onClick: () => void }): ReactElement {
  const { look, onClick } = props
  const chip = REFRESH_CHIP[look]
  const spin = look === 'working' || look === 'working-long'
  const label = chip !== null ? `${t('refresh')}: ${t(chip)}` : spin ? `${t('refresh')}: ${t('refreshWorking')}` : t('refresh')
  return (
    <span className={css.refreshWrap}>
      <button
        type="button"
        className={cx(css.iconButton, look === 'ready' && css.refreshReady)}
        aria-label={label}
        title={chip === null && !spin ? t('refresh') : undefined}
        data-refresh={look}
        onClick={onClick}
      >
        <IconRefreshOutlineRegular size={14} className={spin ? css.commentSpin : undefined} />
      </button>
      {chip !== null && (
        <span role="status" className={css.refreshChip}>{t(chip)}</span>
      )}
    </span>
  )
}

// ── Authors ─────────────────────────────────────────────────────────────────────────────────

/**
 * An author's colour and its list live with the store (`comment-store.ts` `authorColor`, round 5: keyed
 * by the account) so the list the Comments tab reads carries the same colour; re-exported here.
 */
export { AUTHOR_COLOURS, authorColor } from './comment-store.ts'

function initialOf(author: CommentAuthor | undefined): string {
  const initial = author?.initial?.trim()
  if (initial !== undefined && initial !== '') return initial.charAt(0).toUpperCase()
  return (author?.name ?? author?.email ?? '?').trim().charAt(0).toUpperCase() || '?'
}

function nameOf(author: CommentAuthor | undefined): string {
  const name = author?.name?.trim()
  if (name !== undefined && name !== '') return name
  return author?.email.split('@')[0] ?? t('commentYou')
}

/**
 * How the layer names people (round 5, acceptance v3 TH-6): `<name> (<email before @>)` when two
 * accounts among the site's comments share a name (`authorLabels`), the name otherwise; "You" for a
 * comment the server has not answered for yet.
 */
function namesOf(mode: CommentMode): (author: CommentAuthor | undefined) => string {
  const label = authorLabels(mode.comments)
  return author => (author === undefined ? nameOf(author) : label(author))
}

/** What a failed save's box says (round 5, TH-2), in its own box. */
function SaveErrorLine(props: { mode: CommentMode; box: AttachmentBox }): ReactElement | null {
  const error = props.mode.saveError
  if (error === null || error.box !== props.box) return null
  return <div className={css.commentError} role="status" data-save-error="">{saveErrorCopy(error)}</div>
}

function saveErrorCopy(error: SaveError): string {
  return t(error.key, error.params)
}

/** The count near the limit (round 5, TH-2): shown from 90 % of `maxChars`, red past it. */
function CharCount(props: { text: string; max: number }): ReactElement | null {
  const count = charCount(props.text, props.max)
  if (!count.shown) return null
  return (
    <>
      <div className={cx(css.commentCount, count.over && css.commentCountOver)} data-char-count="" data-over={count.over ? '' : undefined} aria-live="polite">
        {t('commentCharCount', { count: count.length, max: count.max })}
      </div>
      {/* Round 11 (L2): over the limit, why; the Comments tab's page box says the same sentence. */}
      {count.over && <div className={css.commentError} role="status" data-too-long="">{t('commentErrTooLong', { max: count.max })}</div>}
    </>
  )
}

// ── The popover ─────────────────────────────────────────────────────────────────────────────

/** The popover's width (the stories' `w-[340px]`). */
export const POPOVER_WIDTH_PEOPLE = 340

/** An estimate of the popover's height before it has painted once. */
const POPOVER_ESTIMATE = 150

/** The key the Enter button shows, small and muted after its label — the same on every system. */
const ENTER_HINT = '↵'

/** The tooltip of the button Enter presses: "Send to Tracy (Enter)", "Save (Enter)". */
function enterTitle(label: string): string {
  return `${label} (Enter)`
}

/**
 * A comment box's keys: the dsh chat composer's Enter rule (`comment-keys.ts`, Brian 30/09/2026) —
 * Enter and ⌘/Ctrl+Enter press the box's ↵ button, Shift+Enter is a new line, an input method's Enter
 * (its composition-closing one included) never sends and is left to the browser, a held-down Enter presses once,
 * and an empty box or a disabled button ignores Enter.
 * @param action - what ↵ does in this box.
 * @param disabled - whether ↵ cannot be pressed now.
 * @returns the text box's handlers.
 */
function useEnterKeys(action: () => void, disabled: boolean): {
  onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void
  onCompositionStart: () => void
  onCompositionEnd: () => void
} {
  const composing = useRef(false)
  const tail = useRef(0)
  return {
    onKeyDown: (event) => {
      const native = event.nativeEvent as KeyboardEvent
      const gesture = enterGesture(
        {
          key: event.key,
          shiftKey: event.shiftKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          altGraph: typeof native.getModifierState === 'function' && native.getModifierState('AltGraph'),
          repeat: event.repeat,
          isComposing: native.isComposing === true,
          // oxlint-disable-next-line typescript/no-deprecated -- keyCode 229 is the legacy composition signal
          keyCode: event.keyCode,
        },
        { composing: composing.current || Date.now() < tail.current, empty: event.currentTarget.value.trim() === '', disabled },
      )
      if (gesture === 'pass') return
      event.preventDefault()
      if (gesture === 'press') action()
    },
    onCompositionStart: () => { composing.current = true },
    onCompositionEnd: () => {
      composing.current = false
      tail.current = Date.now() + COMPOSITION_TAIL_MS
    },
  }
}

/** The tallest a comment box's text grows (about nine lines) before it scrolls inside. */
export const TEXT_MAX_HEIGHT = 200

/**
 * A text box that grows with its words up to {@link TEXT_MAX_HEIGHT}, then scrolls inside, and shrinks
 * back as words go (Brian 30/09/2026). Measured before the box itself is measured (declare it first),
 * so the popover's flip and clamp see its new height in the same render.
 * @param field - the text box.
 * @param value - its words: measured again whenever they change.
 * @param width - the box's width, which re-wraps the words.
 */
function useAutoGrow(field: { current: HTMLTextAreaElement | null }, value: string, width: number): void {
  useLayoutEffect(() => {
    const el = field.current
    if (el === null) return
    el.style.height = 'auto'
    const full = el.scrollHeight + (el.offsetHeight - el.clientHeight)
    // Not laid out (hidden, or no layout at all): the rows and the CSS minimum stand.
    if (!(full > 0)) return
    el.style.height = `${String(Math.min(full, TEXT_MAX_HEIGHT))}px`
    el.style.overflowY = full > TEXT_MAX_HEIGHT ? 'auto' : 'hidden'
  }, [field, value, width])
}

/** The key hint after a button's label. */
function KeyHint(props: { keys: string }): ReactElement {
  return <span className={css.commentKeyHint} aria-hidden>{props.keys}</span>
}

/** How long a box flashes when a click outside cannot close it (words typed). */
export const FLASH_MS = 500

/** A box's flash: true for {@link FLASH_MS} after each bump of `flash`, which also puts the focus back in `field`. */
function useFlash(flash: number, field: { current: HTMLTextAreaElement | null }): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (flash === 0) return
    setOn(true)
    field.current?.focus()
    const timer = setTimeout(() => { setOn(false) }, FLASH_MS)
    return () => { clearTimeout(timer) }
  }, [flash, field])
  return on
}

/** One line of a line-based wheel (`deltaMode` 1), in CSS pixels. */
const WHEEL_LINE_PX = 16

/** Whether `from`, or a box between it and `stop`, can still scroll by (dx, dy) itself. */
function canScrollBy(from: EventTarget | null, stop: Element, dx: number, dy: number): boolean {
  for (let node = from instanceof Element ? from : null; node !== null; node = node.parentElement) {
    if (node instanceof HTMLElement) {
      const style = getComputedStyle(node)
      if (dy !== 0 && /auto|scroll/.test(style.overflowY)) {
        if (dy > 0 && node.scrollTop + node.clientHeight < node.scrollHeight - 1) return true
        if (dy < 0 && node.scrollTop > 0) return true
      }
      if (dx !== 0 && /auto|scroll/.test(style.overflowX)) {
        if (dx > 0 && node.scrollLeft + node.clientWidth < node.scrollWidth - 1) return true
        if (dx < 0 && node.scrollLeft > 0) return true
      }
    }
    if (node === stop) break
  }
  return false
}

/**
 * The wheel over a box scrolls the PAGE (round 4, item 8; acceptance v2 V2-8): the box sits over the
 * cross-origin frame, so its wheel never reached the page and the person had to move the pointer off
 * the box to scroll. A box (or list) under the pointer that can still scroll that way scrolls first —
 * the usual overscroll — and at its end the page takes the wheel, in the page's pixels (the tab's zoom
 * taken out). A pinch (ctrl + wheel) is left to the browser.
 * Round 10 (acceptance v5 B04, PICK-new-9): a pin too, and the step names whose box it was — `id` of a
 * thread card's or a pin's comment, null for the popover — so a page naming `wheel` scrolls the box
 * the element sits in (a nested list) instead of the page.
 * @param box - the popover, the thread card or a pin.
 * @param wheelPage - `CommentMode.wheelPage`.
 * @param zoom - the tab's zoom in percent.
 * @param open - what is open in the box: the listener is attached again when it changes.
 * @param id - the comment the box belongs to; null for the popover (the open pick).
 */
function useWheelToPage(box: { current: HTMLElement | null }, wheelPage: (dx: number, dy: number, id?: string | null) => void, zoom: number, open: string | null, id: string | null = null): void {
  const latest = useRef({ wheelPage, zoom, id })
  latest.current = { wheelPage, zoom, id }
  useEffect(() => {
    const el = box.current
    if (el === null) return
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey) return
      const unit = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? window.innerHeight : 1
      const dx = event.deltaX * unit
      const dy = event.deltaY * unit
      if ((dx === 0 && dy === 0) || canScrollBy(event.target, el, dx, dy)) return
      event.preventDefault()
      const scale = latest.current.zoom > 0 ? latest.current.zoom / 100 : 1
      latest.current.wheelPage(dx / scale, dy / scale, latest.current.id)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => { el.removeEventListener('wheel', onWheel) }
  }, [box, open])
}

// ── Files in a box ──────────────────────────────────────────────────────────────────────────

/** What a drop or a paste carries as files (never folders' entries, never text). */
function filesOf(list: FileList | readonly File[] | null | undefined): File[] {
  return list === null || list === undefined ? [] : Array.from(list as ArrayLike<File>)
}

const carriesFiles = (transfer: DataTransfer | null | undefined): boolean => Array.from(transfer?.types ?? []).includes('Files')

/** The drag handlers a comment box spreads on itself. */
type BoxDragProps = { onDragEnter: (event: ReactDragEvent) => void; onDragOver: (event: ReactDragEvent) => void; onDragLeave: (event: ReactDragEvent) => void; onDrop: (event: ReactDragEvent) => void }

/**
 * Drop files on a box: the whole box takes them (the text box included) and is highlighted while
 * files are dragged over it. Nothing when the server keeps no files.
 *
 * Round 11 (acceptance v5 V5-2): a file drag over a box ends at the box, whether it takes files or
 * not. dsh's chat box listens for drops on the whole document (`ui-attachment` drop-events.ts) and
 * takes every one that reaches it, prevented or not — the same file landed in the comment box AND in
 * the chat, and went to Tracy with the next chat message. A drag with no file (words, a link) passes.
 */
function useBoxDrop(mode: CommentMode, box: AttachmentBox): { over: boolean; props: BoxDragProps } {
  // A counter: entering a child of the box leaves the box itself first.
  const depth = useRef(0)
  const [over, setOver] = useState(false)
  const takes = mode.attachments.enabled
  /** A file drag: never past this box. Returns whether it is one. */
  const keep = (event: ReactDragEvent): boolean => {
    if (!carriesFiles(event.dataTransfer)) return false
    event.stopPropagation()
    return true
  }
  return {
    over: takes && over,
    props: {
      onDragEnter: (event) => {
        if (!keep(event) || !takes) return
        depth.current += 1
        setOver(true)
      },
      onDragOver: (event) => {
        if (!keep(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = takes ? 'copy' : 'none'
      },
      onDragLeave: (event) => {
        if (!keep(event) || !takes) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      },
      onDrop: (event) => {
        if (!keep(event)) return
        // Never opened in place by the browser, taken here or not.
        event.preventDefault()
        depth.current = 0
        setOver(false)
        const files = filesOf(event.dataTransfer?.files)
        if (takes && files.length > 0) mode.addFiles(box, files)
      },
    },
  }
}

/** Paste into a box's text: images become files; words stay words. */
function onPasteFiles(mode: CommentMode, box: AttachmentBox): ((event: ReactClipboardEvent) => void) | undefined {
  if (!mode.attachments.enabled) return undefined
  return (event) => {
    const images = filesOf(event.clipboardData?.files).filter(f => isImageType(f.type))
    if (images.length === 0) return
    event.preventDefault()
    mode.addFiles(box, images)
  }
}

/** The paperclip (dsh composer's icon) and its hidden file picker (many files). */
function AttachButton(props: { mode: CommentMode; box: AttachmentBox }): ReactElement | null {
  const { mode, box } = props
  const input = useRef<HTMLInputElement | null>(null)
  if (!mode.attachments.enabled) return null
  return (
    <>
      <button type="button" className={css.commentAttach} aria-label={t('attachButton')} title={t('attachTitle')} data-attach="" onClick={() => { input.current?.click() }}>
        <IconPaperclipOutlineRegular size={14} />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        onChange={(event) => {
          const files = filesOf(event.currentTarget.files)
          // The same file picked again must fire `change` again.
          event.currentTarget.value = ''
          if (files.length > 0) mode.addFiles(box, files)
        }}
      />
    </>
  )
}

/** A picked image's thumbnail, from an object URL held while the chip stands. */
function FileThumb(props: { file: File }): ReactElement | null {
  const { file } = props
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    if (typeof URL.createObjectURL !== 'function') return
    const url = URL.createObjectURL(file)
    setSrc(url)
    return () => { URL.revokeObjectURL(url) }
  }, [file])
  return src === null ? null : <img className={css.attachThumb} src={src} alt="" />
}

/** The box's files under its text: a thumbnail for an image, name + size otherwise, ✕ to remove. */
function DraftChips(props: { mode: CommentMode; box: AttachmentBox; draft: readonly DraftAttachment[] }): ReactElement | null {
  const { mode, box, draft } = props
  if (draft.length === 0) return null
  return (
    <div className={css.attachChips}>
      {draft.map((d) => {
        const name = d.kind === 'file' ? d.file.name : d.attachment.name
        const size = d.kind === 'file' ? d.file.size : d.attachment.size
        const image = isImageType(d.kind === 'file' ? d.file.type : d.attachment.type)
        return (
          <span key={d.key} className={cx(css.attachChip, image && css.attachChipImage)} data-attach-chip={d.key} title={`${name} · ${formatBytes(size)}`}>
            {image
              ? (d.kind === 'file' ? <FileThumb file={d.file} /> : <img className={css.attachThumb} src={d.attachment.url} alt="" loading="lazy" />)
              : (
                  <span className={css.attachChipText}>
                    <span className={css.attachName}>{name}</span>
                    <span className={css.attachSize}>{formatBytes(size)}</span>
                  </span>
                )}
            <button type="button" className={css.attachRemove} aria-label={t('attachRemove', { name })} onClick={() => { mode.removeDraft(box, d.key) }}>
              <LuX size={10} aria-hidden />
            </button>
          </span>
        )
      })}
    </div>
  )
}

function refusalCopy(refusal: DraftRefusal): string {
  return refusal.code === 'too-large'
    ? t('attachTooLarge', { name: refusal.name, limit: formatBytes(refusal.limit) })
    : t('attachTooMany', { limit: refusal.limit })
}

/** Why a box did not take a file, in its own box. */
function DraftError(props: { mode: CommentMode; box: AttachmentBox }): ReactElement | null {
  const error = props.mode.draftError
  if (error === null || error.box !== props.box) return null
  return <div className={css.commentError} role="status" data-attach-error="">{refusalCopy(error.refusal)}</div>
}

/** A message's kept files in the thread card: each opens its own door in a new tab (cookie-carried, no public link). */
function MessageFiles(props: { files: readonly CommentAttachment[] }): ReactElement | null {
  const { files } = props
  if (files.length === 0) return null
  return (
    <span className={css.attachChips}>
      {files.map(a => (
        <a
          key={a.id}
          className={cx(css.attachChip, isImageType(a.type) && css.attachChipImage, css.attachLink)}
          href={a.url}
          // An image opens in a new tab; any other file downloads in place (round 5, acceptance v3 A07: a
          // new tab for a file the server sends as an attachment stayed blank).
          {...(isImageType(a.type) ? { target: '_blank', rel: 'noopener noreferrer' } : { download: a.name })}
          aria-label={t('attachOpen', { name: a.name })}
          title={`${a.name} · ${formatBytes(a.size)}`}
          data-attachment={a.id}
        >
          {isImageType(a.type)
            ? <img className={css.attachThumb} src={a.url} alt={a.name} loading="lazy" />
            : (
                <span className={css.attachChipText}>
                  <span className={css.attachName}>{a.name}</span>
                  <span className={css.attachSize}>{formatBytes(a.size)}</span>
                </span>
              )}
        </a>
      ))}
    </span>
  )
}

/**
 * Round 11 (acceptance v5 V5-3): the box's comment was deleted by someone else while words or files
 * waited in it. The box stays with them and says so in one plain line.
 */
function LostLine(): ReactElement {
  return <div className={css.commentLost} role="status" data-lost="">{t('commentLostKept')}</div>
}

/**
 * The foot of a lost box (V5-3): Discard at the left; "Add as new comment" (on the same element) and
 * "Send to Tracy". Enter keeps the box's own meaning: the card's goes to Tracy, the edit popover's keeps words.
 */
function LostFoot(props: { mode: CommentMode; box: AttachmentBox; enter: 'add' | 'send'; blocked: boolean; compact: boolean }): ReactElement {
  const { mode, box, enter, blocked, compact } = props
  const addLabel = t('commentLostAdd')
  const sendLabel = t('editSend')
  return (
    <div className={css.commentFoot} data-lost-foot="">
      <AttachButton mode={mode} box={box} />
      <button type="button" className={css.commentDelete} onClick={mode.discardLost}>
        {t('commentLostDiscard')}
      </button>
      <span className={css.commentFootEnd}>
        <button type="button" className={css.commentSecondary} disabled={blocked} title={enter === 'add' ? enterTitle(addLabel) : addLabel} onClick={mode.addLost}>
          {addLabel}
          {enter === 'add' && !compact && <KeyHint keys={ENTER_HINT} />}
        </button>
        <button type="button" className={css.commentSend} disabled={blocked || mode.sending} title={enter === 'send' ? enterTitle(sendLabel) : sendLabel} onClick={mode.sendLost}>
          {sendLabel}
          {enter === 'send' && !compact && <KeyHint keys={ENTER_HINT} />}
        </button>
      </span>
    </div>
  )
}

/**
 * "<name> (hidden now)" at the head of a box whose element hid (round 8). Only the NAME shortens with an
 * ellipsis; the suffix always shows whole (verify6 L2: "NewsletterDigest email template (hi…" lost the
 * part that says why the outline is gone). The copy key keeps the words' order per language.
 */
function HiddenNote(props: { name: string; className: string | undefined }): ReactElement {
  const MARK = '\u0000'
  const whole = t('commentHiddenNow', { name: props.name })
  const [before = '', after = ''] = t('commentHiddenNow', { name: MARK }).split(MARK)
  return (
    <span className={cx(props.className, css.hiddenNoteRow)} data-hidden-note="" title={whole}>
      {before !== '' && <span className={css.hiddenNoteFixed}>{before}</span>}
      <span className={css.hiddenNoteName} data-hidden-note-name="">{props.name}</span>
      {after !== '' && <span className={css.hiddenNoteFixed} data-hidden-note-suffix="">{after}</span>}
    </span>
  )
}

/**
 * The comment popover (rule 2): header "Comment" + ✕; the text box; a new pick has "Add comment"
 * (click) and "Send to Tracy ↵" (Enter), a reopened comment "Save ↵" (Enter) and "Send to Tracy"
 * (click) with a small "Delete" at the foot's left.
 */
export function CommentPopover(props: {
  mode: CommentMode
  /** The box it stands by, in the layer's pixels (already zoomed). */
  rect: PreviewPickRect
  frame: { width: number; height: number }
  compact?: boolean
  /** Bumped by a click outside while words are typed: the box flashes and keeps the focus. */
  flash?: number
  /** The tab's zoom in percent (the wheel over the box scrolls the page in its own pixels). */
  zoom?: number
  /** Round 8: the element is hidden now — its name for the head ("Newsletter (hidden now)"), else null. */
  note?: string | null
}): ReactElement {
  const { mode, rect, frame, compact = false, flash = 0, zoom = 100, note = null } = props
  const box = useRef<HTMLDivElement | null>(null)
  const textarea = useRef<HTMLTextAreaElement | null>(null)
  const flashing = useFlash(flash, textarea)
  useWheelToPage(box, mode.wheelPage, zoom, 'popover')
  const drop = useBoxDrop(mode, 'popover')
  const boxWidth = compact ? compactPopoverWidth(frame.width) : POPOVER_WIDTH_PEOPLE
  useAutoGrow(textarea, mode.text, boxWidth)
  const [height, setHeight] = useState(POPOVER_ESTIMATE)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- measured after every render; the 2 px threshold ends it
  useLayoutEffect(() => {
    const measured = box.current?.offsetHeight
    if (measured !== undefined && measured > 0 && Math.abs(measured - height) > 2) setHeight(measured)
  })
  const edit = mode.foot === 'edit' ? mode.editing : null
  const focusKey = mode.picked !== null ? `pick:${String(mode.picked.id)}` : edit !== null ? `edit:${edit.id}` : null
  useEffect(() => { textarea.current?.focus() }, [focusKey])
  // The bubble stands at the block's top-left, so "by the pin" is under the block, left-aligned, for
  // a new pick and a reopened comment alike (story PopoverEditPending).
  const place = popoverPlacement(rect, frame, height, boxWidth, 'box')
  const empty = mode.text.trim() === ''
  // Over the limit nothing is kept or sent (round 5, TH-2): every button waits, and so does Enter.
  const over = charCount(mode.text, mode.maxChars).over
  // Enter presses Send to Tracy in a new pick and Save in a reopened comment; the other is a click.
  const enterSaves = edit !== null
  const lost = edit !== null && mode.lost === 'edit'
  const keys = useEnterKeys(lost ? mode.addLost : enterSaves ? mode.save : mode.sendToTracy, over || (enterSaves ? false : mode.sending))
  const people = enterSaves ? mode.save : mode.addComment
  const peopleLabel = t(enterSaves ? 'editSave' : 'commentAdd')
  const sendLabel = t('editSend')
  return (
    <div
      ref={box}
      role="dialog"
      aria-label={t('commentTitle')}
      className={cx(css.commentPopover, flashing && css.commentFlash, drop.over && css.commentDropOn)}
      style={{ left: place.left, top: place.top, width: place.width }}
      data-foot={mode.foot ?? undefined}
      data-comment-box=""
      data-drop={drop.over ? 'on' : undefined}
      {...drop.props}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          // The box takes this Esc whole: nothing behind it (the pointing layer, dsh) acts on it too (IN4-3).
          event.preventDefault()
          event.stopPropagation()
          mode.escape('parent', event.nativeEvent)
        }
      }}
    >
      <div className={css.commentHead}>
        <span className={css.commentHeadTitle}>{t('commentTitle')}</span>
        {note !== null && <HiddenNote name={note} className={css.commentHiddenNote} />}
        <button type="button" aria-label={t('editClose')} title={t('commentCloseTitle')} className={css.commentClose} onClick={mode.close}>
          <LuX size={14} aria-hidden />
        </button>
      </div>
      <textarea
        ref={textarea}
        className={cx(css.commentTextarea, !empty && css.commentTextareaFilled)}
        placeholder={t('editPlaceholder')}
        rows={3}
        value={mode.text}
        onChange={(event) => { mode.setText(event.target.value) }}
        {...keys}
        onPaste={onPasteFiles(mode, 'popover')}
      />
      <CharCount text={mode.text} max={mode.maxChars} />
      {lost && <LostLine />}
      <DraftChips mode={mode} box="popover" draft={mode.draft} />
      <DraftError mode={mode} box="popover" />
      <SaveErrorLine mode={mode} box="popover" />
      {mode.notice !== null && <div className={css.commentError} role="status">{t(FAILURE_COPY[mode.notice])}</div>}
      {lost ? <LostFoot mode={mode} box="popover" enter="add" blocked={empty || over} compact={compact} /> : (
      <div className={css.commentFoot}>
        <AttachButton mode={mode} box="popover" />
        {edit !== null && isMine(edit) && (
          <button type="button" className={css.commentDelete} onClick={() => { mode.deleteComment(edit.id) }}>
            {t('commentDelete')}
          </button>
        )}
        <span className={css.commentFootEnd}>
          <button type="button" className={css.commentSecondary} disabled={empty || over} title={enterSaves ? enterTitle(peopleLabel) : peopleLabel} onClick={people}>
            {peopleLabel}
            {enterSaves && !compact && <KeyHint keys={ENTER_HINT} />}
          </button>
          <button type="button" className={css.commentSend} disabled={empty || over || mode.sending} title={enterSaves ? sendLabel : enterTitle(sendLabel)} onClick={mode.sendToTracy}>
            {sendLabel}
            {!enterSaves && !compact && <KeyHint keys={ENTER_HINT} />}
          </button>
        </span>
      </div>
      )}
    </div>
  )
}

// ── The pins ────────────────────────────────────────────────────────────────────────────────

/** The bubble's size (the stories' `size-[22px]`). */
export const AVATAR_PIN_SIZE = 22

/**
 * Where an author's bubble stands: its bottom-left corner at the block's top-left (the stories'
 * `-top-8 -left-2`: 32 px above, 8 px left), kept inside the frame.
 */
export function avatarPinPlacement(rect: PreviewPickRect, frameWidth: number): { left: number; top: number } {
  const left = rect.x - 8
  const top = rect.y - 32
  const right = frameWidth > 0 ? frameWidth - AVATAR_PIN_SIZE : Number.POSITIVE_INFINITY
  return { left: Math.max(0, Math.min(left, right)), top: Math.max(0, top) }
}

/**
 * How far each further pin on the same spot moves right (round 5, acceptance v3 SEND-new-1: a second
 * comment on one element covered the first pin). Pins fan out in number order, oldest leftmost; the
 * chat still gets one grouped chip for them (contract H3 round 3).
 */
export const PIN_FAN_PX = 14

/** One open comment's pin: its author's bubble; a click opens its thread card. */
function AvatarPin(props: { comment: Comment; rect: PreviewPickRect; frameWidth: number; dim: boolean; who: string; colour?: string; fan?: number; onOpen: () => void; wheelPage: CommentMode['wheelPage']; zoom: number }): ReactElement {
  const { comment, rect, frameWidth, dim, who, colour = authorColor(comment.author), fan = 0, onOpen, wheelPage, zoom } = props
  const place = avatarPinPlacement(rect, frameWidth)
  const pin = useRef<HTMLButtonElement | null>(null)
  // The wheel over a pin scrolls the page too (round 10, acceptance v5 PICK-new-9: it did nothing).
  useWheelToPage(pin, wheelPage, zoom, comment.id, comment.id)
  return (
    <button
      ref={pin}
      type="button"
      // A resolved comment has a pin only while it is revealed with its card open: faded, as done.
      className={cx(css.commentAvatarPin, (dim || comment.status === 'resolved') && css.commentPinDim)}
      style={{ left: place.left + fan * PIN_FAN_PX, top: place.top, background: colour }}
      aria-label={t('commentPinLabel', { name: who })}
      title={who}
      onClick={onOpen}
      data-comment-pin={comment.id}
    >
      {initialOf(comment.author)}
    </button>
  )
}

// ── The thread card ─────────────────────────────────────────────────────────────────────────

/**
 * A message's ⋮: Edit and Delete on one's own, Copy link on every one. Delete is red with the trash
 * icon — the same word, look and Undo as the Comments tab's Delete all (Brian 29/09 22:45).
 */
function MessageMenu(props: { mode: CommentMode; message: Comment }): ReactElement {
  const { mode, message } = props
  const [open, setOpen] = useState(false)
  // F14: Copy link says whether it copied, in the toolbar copy button's own bubble.
  const [said, setSaid] = useState<'copied' | 'failed' | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])
  const own = isMine(message) && message.removed !== true
  const items = [
    ...(own
      ? [
          { id: 'edit', icon: <LuPencil size={12} aria-hidden />, label: t('commentEdit') },
          { id: 'delete', icon: <LuTrash2 size={12} aria-hidden data-icon="trash" />, label: t('commentDelete'), danger: true },
        ]
      : []),
    { id: 'link', icon: <LuLink2 size={12} aria-hidden />, label: t('commentCopyLink') },
  ]
  const menu = (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={items}
      onSelect={(id) => {
        setOpen(false)
        if (id === 'edit') mode.editMessage(message.id)
        else if (id === 'delete') mode.deleteComment(message.id)
        else {
          void mode.copyLink(message.id).then((copied) => {
            setSaid(copied ? 'copied' : 'failed')
            if (timer.current !== null) clearTimeout(timer.current)
            timer.current = setTimeout(() => {
              timer.current = null
              setSaid(null)
            }, COPY_FEEDBACK_MS)
          })
        }
      }}
      portal
      compact
      align="end"
      anchor={(
        <button
          type="button"
          className={css.threadMore}
          aria-label={t('commentMore')}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => { setOpen(value => !value) }}
        >
          <LuEllipsisVertical size={14} aria-hidden />
        </button>
      )}
    />
  )
  return (
    <>
      {menu}
      {said !== null && <span role="status" className={css.copyLinkTip}>{t(said === 'copied' ? 'browserLinkCopied' : 'browserLinkCopyFailed')}</span>}
    </>
  )
}

/** The air above a revealed reply when the card opens at it (round 6). */
const FOCUS_AIR_PX = 8

/** How often an open thread card redraws its messages' ages (F15). */
export const AGE_TICK_MS = 30_000

/**
 * The thread card of a people comment (rule 4, stories ThreadCardSendToChat · CommentsTabRowOpensCard):
 * the messages in order, ⋮ per message, "Reply…", Resolve (not on a resolved one), "Reply" (a click)
 * and "Send to Tracy ↵" (Enter) — both disabled while empty. Esc or a click outside closes it.
 */
export function ThreadCard(props: { mode: CommentMode; rect: PreviewPickRect | null; frame: { width: number; height: number }; compact?: boolean; flash?: number; zoom?: number; onOutside?: () => void; note?: string | null }): ReactElement | null {
  const { mode, rect, frame, compact = false, flash = 0, zoom = 100, note = null } = props
  const root = mode.thread
  const box = useRef<HTMLDivElement | null>(null)
  const reply = useRef<HTMLTextAreaElement | null>(null)
  const flashing = useFlash(flash, reply)
  useWheelToPage(box, mode.wheelPage, zoom, root?.id ?? null, root?.id ?? null)
  const drop = useBoxDrop(mode, 'reply')
  const onOutside = useRef(props.onOutside ?? mode.closeThread)
  onOutside.current = props.onOutside ?? mode.closeThread
  const cardWidth = compact ? compactPopoverWidth(frame.width) : POPOVER_WIDTH_PEOPLE
  useAutoGrow(reply, mode.replyText, cardWidth)
  const tooLong = charCount(mode.replyText, mode.maxChars).over
  const lost = mode.lost === 'thread'
  const keys = useEnterKeys(lost ? mode.sendLost : mode.sendThread, mode.sending || tooLong)
  // Round 5 (acceptance v3 TH-5): the messages scroll inside the card, opened at the newest; a message
  // arriving while the list sits at its end keeps it there. Round 6 (acceptance v4 thread): a revealed
  // reply (`threadFocus`, a link's `&comment=<reply>`) opens the card AT it instead, and this person's
  // own "Reply" brings the list down to show it even when it was scrolled up.
  const list = useRef<HTMLDivElement | null>(null)
  const atEnd = useRef(true)
  const count = mode.threadMessages.length
  const focus = mode.threadFocus
  // Round 11 (acceptance v5 V5-1): the list's aim — the newest message, or a revealed reply — holds
  // through every change of the list's size until the person scrolls it. A card opened from a link, or
  // from a tab row while the page still scrolls to its element, is drawn uncapped first and capped
  // beside its element only once the page reports where that is; a browser keeps `scrollTop` where the
  // tall list clamped it, so the card stood mid-thread with the newest (or the linked) reply out of view.
  const aim = useRef<{ to: string | null; held: boolean; top: number; size: string }>({ to: null, held: true, top: 0, size: '' })
  const sizeOf = (el: HTMLElement): string => `${String(el.clientHeight)}:${String(el.scrollHeight)}`
  const aimNow = (el: HTMLElement): void => {
    const to = aim.current.to
    const at = to === null ? undefined : [...el.querySelectorAll<HTMLElement>('[data-message]')].find(n => n.getAttribute('data-message') === to)
    if (at === undefined) {
      el.scrollTop = el.scrollHeight
      atEnd.current = true
    } else {
      // Both offsets are from the card (the positioned box): the message's place inside the list, a little air above.
      el.scrollTop = Math.max(0, at.offsetTop - el.offsetTop - FOCUS_AIR_PX)
      atEnd.current = false
    }
    aim.current.top = el.scrollTop
    aim.current.size = sizeOf(el)
  }
  /** Aim again when the list's size moved since the last aim, while the person has not scrolled it. */
  const keepAim = (): void => {
    const el = list.current
    if (el !== null && aim.current.held && sizeOf(el) !== aim.current.size) aimNow(el)
  }
  const keepAimRef = useRef(keepAim)
  keepAimRef.current = keepAim
  useLayoutEffect(() => {
    const el = list.current
    if (el === null) return
    aim.current.to = focus
    aim.current.held = true
    aimNow(el)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new thread or a new reveal only
  }, [root?.id, focus])
  useLayoutEffect(() => {
    const el = list.current
    if (el !== null && atEnd.current) el.scrollTop = el.scrollHeight
  }, [count])
  const repliesSeen = useRef(mode.ownReplies)
  useLayoutEffect(() => {
    if (mode.ownReplies === repliesSeen.current) return
    repliesSeen.current = mode.ownReplies
    const el = list.current
    if (el === null) return
    // This person's own reply: the newest is the aim now.
    aim.current.to = null
    aim.current.held = true
    aimNow(el)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the count of own replies
  }, [mode.ownReplies])
  // After every render (the card capped beside its element, a message added, its place settled)…
  // eslint-disable-next-line react-hooks/exhaustive-deps -- after every render; nothing happens when the size did not move
  useLayoutEffect(() => { keepAim() })
  // …and a size change no render causes (a thumbnail loading, a font arriving).
  const openThreadId = root?.id ?? null
  useEffect(() => {
    const el = list.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => { keepAimRef.current() })
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [openThreadId])
  const [height, setHeight] = useState(POPOVER_ESTIMATE)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- measured after every render; the 2 px threshold ends it
  useLayoutEffect(() => {
    const measured = box.current?.offsetHeight
    if (measured !== undefined && measured > 0 && Math.abs(measured - height) > 2) setHeight(measured)
  })
  const { closeThread } = mode
  // F15: the ages ("6 min ago") move on while the card stays open.
  const [, setTick] = useState(0)
  const openId = root?.id ?? null
  useEffect(() => {
    if (openId === null) return
    const timer = setInterval(() => { setTick(n => n + 1) }, AGE_TICK_MS)
    return () => { clearInterval(timer) }
  }, [openId])
  // A click outside closes it; a click in its own ⋮ menu (portaled) does not.
  useEffect(() => {
    if (root === null) return
    const onDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (box.current?.contains(target) === true) return
      if (target instanceof Element && target.closest('[role="menu"]') !== null) return
      // The click shield over the frame answers its own clicks (the same rule, once).
      if (target instanceof Element && target.closest('[data-comment-shield]') !== null) return
      onOutside.current()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        mode.escape('parent', event)
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the open thread
  }, [root?.id, closeThread])
  if (root === null) return null
  // A whole-page comment (or one the page cannot find): the card opens at the frame's top corner.
  const anchor = rect ?? { x: 8 + 6, y: 8 + 6 - 10 - 6, width: 0, height: 0 }
  // Round 6: a long card is capped to the room beside its element, so it never covers what it is about.
  const maxHeight = threadCardMaxHeight(rect, frame)
  const place = popoverPlacement(anchor, frame, maxHeight === undefined ? height : Math.min(height, maxHeight), cardWidth, 'box')
  const empty = mode.replyText.trim() === ''
  const over = charCount(mode.replyText, mode.maxChars).over
  const resolved = root.status === 'resolved'
  const who = namesOf(mode)
  return (
    <div
      ref={box}
      role="dialog"
      aria-label={t('commentThread')}
      className={cx(css.commentPopover, css.threadCard, flashing && css.commentFlash, drop.over && css.commentDropOn)}
      style={maxHeight === undefined ? { left: place.left, top: place.top, width: place.width } : { left: place.left, top: place.top, width: place.width, maxHeight }}
      data-thread={root.id}
      data-comment-box=""
      data-drop={drop.over ? 'on' : undefined}
      {...drop.props}
    >
      {note !== null && <HiddenNote name={note} className={cx(css.commentHiddenNote, css.threadHiddenNote)} />}
      <div
        ref={list}
        className={css.threadList}
        data-thread-list=""
        onScroll={(event) => {
          const el = event.currentTarget
          // A scroll the list did not cause by changing size (a scrollbar drag, keys) is the person's.
          if (aim.current.held && sizeOf(el) === aim.current.size && Math.abs(el.scrollTop - aim.current.top) > 1) aim.current.held = false
          atEnd.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8
        }}
        onWheel={() => { aim.current.held = false }}
        onTouchMove={() => { aim.current.held = false }}
      >
      {mode.threadMessages.map((m, i) => (mode.deleted?.id === m.id
        // In place of what was clicked (Brian 23:05): the message's spot says it for the Undo window.
        ? (
            <div key={m.id} className={cx(css.threadMessage, css.threadDeleted)} data-message={m.id} data-deleted="" role="status">
              {t('commentDeleted')}
              <span className={css.commentNoticeDot} aria-hidden>·</span>
              <button type="button" className={css.commentUndo} onClick={mode.undoDelete}>{`${t('commentUndo')} (${String(mode.deleted.left)})`}</button>
              {/* The countdown's thin bar (Brian 23:20): it empties over the window, a CSS animation. */}
              <span className={css.commentCountdown} style={{ animationDuration: `${String(DELETE_UNDO_MS)}ms` }} aria-hidden />
            </div>
          )
        : (
        <div key={m.id} className={cx(css.threadMessage, m.id === focus && css.threadFocus)} data-message={m.id} data-focus={m.id === focus ? '' : undefined}>
          <div className={css.threadMessageHead}>
            <span className={css.threadAuthor} title={who(m.author)}>{who(m.author)}</span>
            <span className={css.threadAge}>{relativeTime(new Date(m.createdAt).toISOString())}</span>
            {/* Brian 23:08: the Comments tab row's quick Resolve, by the first message's ⋮. */}
            {i === 0 && !resolved && !lost && (
              <button type="button" className={css.threadResolve} onClick={() => { mode.resolve([root.id]) }}>
                {t('commentResolve')}
              </button>
            )}
          </div>
          {m.removed === true
            // Round 5 (TH-4): a first message deleted under live replies is the thread's muted top.
            ? <div className={cx(css.threadText, css.threadTombstone)} data-tombstone="">{t(i === 0 ? 'commentRootDeleted' : 'commentRemoved')}</div>
            : <div className={css.threadText}>{m.text}</div>}
          {m.removed !== true && <MessageFiles files={m.attachments ?? []} />}
          {m.removed !== true && !lost && <span className={css.threadMoreSlot}><MessageMenu mode={mode} message={m} /></span>}
        </div>
          )))}
      {resolved && (
        <div className={css.threadResolved}>
          <LuCheck size={13} aria-hidden />
          {t('commentResolvedBy', { name: who(root.resolvedBy) })}
        </div>
      )}
      </div>
      {lost && <LostLine />}
      <textarea
        ref={reply}
        className={cx(css.commentTextarea, css.threadReply, !empty && css.commentTextareaFilled)}
        placeholder={t('commentReplyPlaceholder')}
        rows={1}
        value={mode.replyText}
        onChange={(event) => { mode.setReplyText(event.target.value) }}
        {...keys}
        onPaste={onPasteFiles(mode, 'reply')}
      />
      <CharCount text={mode.replyText} max={mode.maxChars} />
      <DraftChips mode={mode} box="reply" draft={mode.replyDraft} />
      <DraftError mode={mode} box="reply" />
      <SaveErrorLine mode={mode} box="reply" />
      {mode.notice !== null && <div className={css.commentError} role="status">{t(FAILURE_COPY[mode.notice])}</div>}
      {lost ? <LostFoot mode={mode} box="reply" enter="send" blocked={empty || over} compact={compact} /> : (
      <div className={css.commentFoot}>
        <AttachButton mode={mode} box="reply" />
        <span className={css.commentFootEnd}>
          <button type="button" className={css.commentSecondary} disabled={empty || over} title={t('commentReply')} onClick={mode.reply}>
            {t('commentReply')}
          </button>
          <button type="button" className={css.commentSend} disabled={empty || over || mode.sending} title={enterTitle(t('editSend'))} onClick={mode.sendThread}>
            {t('editSend')}
            {!compact && <KeyHint keys={ENTER_HINT} />}
          </button>
        </span>
      </div>
      )}
    </div>
  )
}

// ── The layer ───────────────────────────────────────────────────────────────────────────────

const NOMINAL_FRAME = { width: 1024, height: 768 }

/**
 * Lockstep (runtime 14): the page posts the boxes of each scroll step, then `pick-step {step}`, and
 * lands the step only once told `pick-drawn {step}` — sent here from a layout effect, i.e. after the
 * render that placed those boxes has committed. A busy tab then slows the page's scroll instead of
 * drawing its popover, pins and card behind it (measured under heavy load: up to 105 px without it).
 * Only the page frame of this stage is answered, on its own origin; the answer carries a number only.
 * @param root - the layer, whose stage holds the page frame.
 */
function useLockstepAnswer(root: { current: HTMLDivElement | null }): void {
  const [step, setStep] = useState<{ n: number; to: Window; origin: string } | null>(null)
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (!isPreviewMessage(event.data, PREVIEW_PICK.step)) return
      const frame = root.current?.parentElement?.querySelector('iframe')
      const to = frame?.contentWindow ?? null
      if (to === null || event.source !== to || event.origin === 'null' || event.origin === '') return
      const n = (event.data as { step?: unknown }).step
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return
      setStep({ n, to, origin: event.origin })
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [root])
  useLayoutEffect(() => {
    if (step === null) return
    try {
      step.to.postMessage({ channel: PREVIEW_CHANNEL, v: PREVIEW_VERSION, kind: PREVIEW_PICK.drawn, step: step.n }, step.origin)
    } catch {
      // The frame navigated away: the page lands the step after its wait.
    }
  }, [step])
}

/**
 * Where a box's element was last reported shown, in page pixels, for as long as `key` names the same
 * box in the same document (round 8, `boxStand`); null when it has not been seen under this key.
 * @param key - the box and the document (`<doc>:pick:<id>`, `<doc>:edit:<id>`, `<doc>:thread:<id>`), or null.
 * @param rect - what the page reports now.
 */
function useSeen(key: string | null, rect: ShownRect | undefined): PreviewPickRect | null {
  const seen = useRef<{ key: string | null; rect: PreviewPickRect | null }>({ key: null, rect: null })
  if (seen.current.key !== key) seen.current = { key, rect: null }
  if (key !== null && rect !== undefined && rect.hidden !== 'clipped') seen.current.rect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  return seen.current.rect
}

/** Where a box waits when its element has no place on the page: the frame's top corner. */
const CORNER: PreviewPickRect = { x: 14, y: 4, width: 0, height: 0 }

/**
 * The layer over the frame. Sized by the frame's box; in Interactive it draws nothing but a notice.
 * @param props.zoom - the tab's zoom in percent: the page's boxes are multiplied by it.
 * @param props.scroll - how far the stage is scrolled (above 100 % only).
 * @param props.onFrameWidth - told the frame's width on mount and on every resize.
 */
export function CommentOverlay(props: { mode: CommentMode; zoom: number; scroll?: StageScroll; onFrameWidth?: (width: number) => void }): ReactElement | null {
  const { mode, zoom, scroll, onFrameWidth } = props
  const root = useRef<HTMLDivElement | null>(null)
  useLockstepAnswer(root)
  const [frame, setFrame] = useState({ width: 0, height: 0 })
  const reportWidth = useRef(onFrameWidth)
  reportWidth.current = onFrameWidth
  useLayoutEffect(() => {
    const el = root.current
    if (el === null) return
    const measure = (): void => {
      setFrame({ width: el.clientWidth, height: el.clientHeight })
      reportWidth.current?.(el.clientWidth)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [])
  const on = mode.modes.edit
  const { escape } = mode
  const pointing = on && mode.picked === null && mode.foot === null && mode.thread === null
  // Esc while pointing (the keyboard is in this page): back to Interactive, unless something already took it.
  useEffect(() => {
    if (!pointing) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) escape('parent', event)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [pointing, escape])
  const box = frame.width > 0 && frame.height > 0 ? frame : NOMINAL_FRAME
  const place = (rect: PreviewPickRect): PreviewPickRect => scaleRect(rect, zoom, box.width, scroll)
  const compact = isCompactFrame(frame.width)
  const editingId = mode.editing?.id ?? null
  const editRoot = mode.editing === null ? null : (mode.editing.replyTo ?? mode.editing.id)
  // Round 8 (`boxStand`): a box stands by its element while the page shows it; hidden after it was
  // seen in this document, it stays where it last stood (its head names the element); hidden and never
  // seen here, it waits at the frame's top corner with its words, and comes back when the element does.
  const popoverKey = mode.foot === 'new' && mode.picked !== null
    ? `${String(mode.doc)}:pick:${String(mode.picked.id)}`
    : mode.foot === 'edit' && editRoot !== null ? `${String(mode.doc)}:edit:${editRoot}` : null
  const popoverShown: ShownRect | undefined = mode.foot === 'new' && mode.picked !== null
    ? { ...mode.picked.target.rect, ...(mode.picked.target.hidden === undefined ? {} : { hidden: mode.picked.target.hidden }) }
    : popoverKey !== null && editRoot !== null ? mode.rects.get(editRoot) : undefined
  const popoverStand = boxStand(popoverShown, useSeen(popoverKey, popoverShown))
  const popoverRect: PreviewPickRect | null = popoverKey === null ? null : popoverStand.rect === null ? CORNER : place(popoverStand.rect)
  const popoverElement: PreviewPickTarget | null = mode.foot === 'new' && mode.picked !== null ? mode.picked.target : (mode.editing?.element ?? null)
  const shownRect = mode.thread === null ? undefined : mode.rects.get(mode.thread.id)
  const threadSeen = useSeen(mode.thread === null ? null : `${String(mode.doc)}:thread:${mode.thread.id}`, shownRect)
  const threadStand = boxStand(shownRect, threadSeen)
  // Round 11 (V5-3): a card whose comment was deleted elsewhere stays where it was last seen.
  const threadRect = threadStand.rect ?? (mode.lost === 'thread' ? threadSeen : null)
  const noteOf = (gone: boolean, element: PreviewPickTarget | null | undefined): string | null =>
    gone && mode.lost === null && element !== null && element !== undefined ? hiddenName(element) : null
  // Brian 23:08: while a box is open, the first click outside it — on the page or a pin — only
  // closes it; with words typed in it (`unsaved`: an untouched edit popover has none), it flashes and
  // keeps the focus instead. That click is not an attempt (round 7, IN4-2): the controller hears it and
  // the next Esc / ✕ / Interactive / navigation only flashes again; a second of those within 3 s drops
  // the words (round 4). The controller bumps `mode.flash` for the attempts it refused.
  const cardOpen = mode.thread !== null && mode.foot === null
  const boxOpen = popoverRect !== null || cardOpen
  const [flash, setFlash] = useState(0)
  // Round 8 (`aimedAtBox`): where the open box stood lately, so a click the page reports there — the box
  // moved from under the pointer on its way to it — is not a click outside.
  const trail = useRef<BoxTrail[]>([])
  useLayoutEffect(() => {
    const el = root.current?.querySelector<HTMLElement>('[data-comment-box]') ?? null
    if (el === null) {
      trail.current = []
      return
    }
    const now = Date.now()
    const at: BoxTrail = {
      left: Number.parseFloat(el.style.left) || 0,
      top: Number.parseFloat(el.style.top) || 0,
      width: Number.parseFloat(el.style.width) || el.offsetWidth,
      height: el.offsetHeight > 0 ? el.offsetHeight : POPOVER_ESTIMATE,
      at: now,
    }
    const last = trail.current.at(-1)
    if (last !== undefined && last.left === at.left && last.top === at.top && last.width === at.width && last.height === at.height) return
    trail.current = [...trail.current.filter((one, i, all) => now - (all[i + 1]?.at ?? now) <= AIMED_MS), at]
  })
  const focusBox = (): void => {
    root.current?.querySelector<HTMLTextAreaElement>('[data-comment-box] textarea')?.focus()
  }
  // Runtime 15 (`refocus`): the page frame took the focus while a box is open; it goes back to the box.
  useEffect(() => {
    if (!boxOpen) return
    const onMessage = (event: MessageEvent): void => {
      if (!isPreviewMessage(event.data, PREVIEW_PICK.refocus)) return
      const frame = root.current?.parentElement?.querySelector('iframe')
      if (frame?.contentWindow === undefined || frame.contentWindow === null || event.source !== frame.contentWindow) return
      root.current?.querySelector<HTMLTextAreaElement>('[data-comment-box] textarea')?.focus()
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [boxOpen])
  const outside = (): void => {
    if (mode.unsaved) {
      mode.clickedOutside()
      setFlash(n => n + 1)
    } else if (popoverRect !== null) mode.close()
    else mode.closeThread()
  }
  // A file dragged into the Browser tab while a box is open: dropped outside the box it is caught and
  // ignored (the browser would otherwise open it in place of the page). The tab's own listeners cover
  // the toolbar and the layer; over the page frame — whose events never reach this document — a
  // catcher stands for the length of the drag. Only the box takes files (its own `onDrop`).
  const [dragging, setDragging] = useState(false)
  const filesOn = mode.attachments.enabled
  useEffect(() => {
    const layer = root.current
    if (!boxOpen || layer === null) {
      setDragging(false)
      return
    }
    const tab = layer.closest('[data-browser-tab]') ?? layer
    const inBox = (event: Event): boolean => event.target instanceof Element && event.target.closest('[data-comment-box]') !== null
    const guard = (event: DragEvent): void => {
      if (!carriesFiles(event.dataTransfer)) return
      event.preventDefault()
      if (event.dataTransfer !== null && !(filesOn && inBox(event))) event.dataTransfer.dropEffect = 'none'
    }
    const onEnter = (event: DragEvent): void => { if (carriesFiles(event.dataTransfer)) setDragging(true) }
    const onLeave = (event: DragEvent): void => {
      const next = event.relatedTarget
      if (!(next instanceof Node) || !tab.contains(next)) setDragging(false)
    }
    const onDrop = (event: DragEvent): void => {
      guard(event)
      setDragging(false)
    }
    const onEnd = (): void => { setDragging(false) }
    tab.addEventListener('dragenter', onEnter as EventListener)
    tab.addEventListener('dragover', guard as EventListener)
    tab.addEventListener('dragleave', onLeave as EventListener)
    tab.addEventListener('drop', onDrop as EventListener)
    window.addEventListener('dragend', onEnd)
    return () => {
      tab.removeEventListener('dragenter', onEnter as EventListener)
      tab.removeEventListener('dragover', guard as EventListener)
      tab.removeEventListener('dragleave', onLeave as EventListener)
      tab.removeEventListener('drop', onDrop as EventListener)
      window.removeEventListener('dragend', onEnd)
    }
  }, [boxOpen, filesOn])

  // Runtime 10: the page holds its own clicks and reports them (`pick-outside`); the same rule applies.
  const outsideRef = useRef(outside)
  outsideRef.current = outside
  const { onPageOutside } = mode
  const placeRef = useRef(place)
  placeRef.current = place
  useEffect(() => onPageOutside((at) => {
    const point = placeRef.current({ x: at.x, y: at.y, width: 0, height: 0 })
    if (aimedAtBox(point, trail.current, Date.now())) focusBox()
    else outsideRef.current()
  }), [onPageOutside])
  const who = namesOf(mode)
  // U3 (round 2): namesakes never share a colour; the Comments tab reads the same map (commentListDetail).
  const colourOf = authorColours(mode.comments)
  // Pins on one spot fan out (round 5, SEND-new-1): how many earlier pins stand where this one would.
  const spots = new Map<string, number>()
  return (
    <div ref={root} className={css.commentOverlay}>
      {on && mode.pageComments.map((c) => {
        const rect = mode.rects.get(c.id)
        // Round 5: no pin on a block out of sight in a nested box, or whose corner a page bar covers.
        if (rect === undefined || !pinnable(rect)) return null
        // F9: a block whose top edge is out of view has no pin (it would stick to the frame's edge).
        const placed = place(rect)
        if (placed.y < 0 || placed.y >= box.height) return null
        const at = avatarPinPlacement(placed, frame.width)
        const spot = `${String(Math.round(at.left))}:${String(Math.round(at.top))}`
        const fan = spots.get(spot) ?? 0
        spots.set(spot, fan + 1)
        return (
          <AvatarPin
            key={c.id}
            comment={c}
            rect={placed}
            who={who(c.author)}
            colour={colourOf(c.author)}
            fan={fan}
            frameWidth={frame.width}
            dim={editingId !== null && c.id !== editRoot}
            onOpen={() => { if (boxOpen) outside(); else mode.openThread(c.id) }}
            wheelPage={mode.wheelPage}
            zoom={zoom}
          />
        )
      })}
      {/* Only for a page that cannot hold its clicks (runtime 9 and older): over the frame and the pins,
          under the box, so the page never sees that first click — at the cost of the wheel. */}
      {boxOpen && !mode.holdable && (
        <div
          className={css.commentShield}
          data-comment-shield=""
          aria-hidden
          onPointerDown={(event) => {
            event.preventDefault()
            outside()
          }}
        />
      )}
      {/* Over the frame during a file drag with a box open: the drop lands here and is ignored. */}
      {boxOpen && dragging && <div className={css.commentDropCatch} data-comment-dropcatch="" aria-hidden />}
      {popoverRect !== null && <CommentPopover mode={mode} rect={popoverRect} frame={box} compact={compact} flash={flash + mode.flash} zoom={zoom} note={noteOf(popoverStand.gone, popoverElement)} />}
      {cardOpen && <ThreadCard mode={mode} rect={threadRect === null ? null : place(threadRect)} frame={box} compact={compact} flash={flash + mode.flash} zoom={zoom} onOutside={outside} note={noteOf(threadStand.gone, mode.thread?.element)} />}
      {pointing && !mode.modes.unavailable && (
        // F13: in a compact frame the "· Esc for Interactive" tail goes and the rest may wrap.
        <div className={cx(css.commentHint, compact && css.commentHintCompact)}>
          <LuMousePointerClick size={13} aria-hidden />
          {t('editHint')}
          {!compact && <span className={css.commentHintExit}>· {t('editHintExit')}</span>}
        </div>
      )}
      {pointing && mode.modes.unavailable && (
        // TCH e2e v7 ADDR-9 (finding 4): Edit cannot pick on this page; a click there navigates, so say it.
        <div className={css.commentUnavailable} role="status" data-comment-unavailable="">
          <span>{t('editUnavailablePage')}</span>
          <button type="button" className={css.commentUnavailableReload} onClick={mode.modes.reload}>{t('editReloadPage')}</button>
        </div>
      )}
      {/* A send that failed with no popover or card to say it in. */}
      {mode.notice !== null && popoverRect === null && mode.thread === null && (
        <div className={css.commentNotice} role="status" data-comment-notice="">
          {t(FAILURE_COPY[mode.notice])}
        </div>
      )}
      {mode.notice === null && mode.serverError !== null && (
        <div className={css.commentNotice} role="status" data-comment-notice="server">
          {mode.serverError.key === 'commentErrUnknown' ? t('editNotSaved') : saveErrorCopy(mode.serverError)}
        </div>
      )}
      {mode.notice === null && mode.serverNotice !== null && (
        <div className={css.commentNotice} role="status" data-comment-notice="server">
          {(() => {
            const head = t(mode.serverNoticeKind === 'send' ? 'editNotSent' : 'editNotSaved')
            return mode.serverNotice === '' ? head : `${head} ${mode.serverNotice}`
          })()}
        </div>
      )}
    </div>
  )
}
