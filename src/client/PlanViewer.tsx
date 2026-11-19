/**
 * The plan page: the plugin's takeover of the host's `kind='plan'` sidebar
 * tab. It renders the submitted (or temporarily reviewed) plan Markdown and
 * offers one action over a selection: quote the selected plan text into the
 * composer as a "plan annotation" chip.
 *
 * Flow: select plan text → a small "add annotation" button → a note box →
 * submit. The note and the quoted text become one quote chip in the composer
 * draft; the plan body itself is never mutated. The chip is the single carrier
 * (there is no separate plan-annotation store), so sending it later expands to
 * the note plus the quoted plan text on the model side. Closing the plan tab
 * needs no cleanup.
 *
 * Plan content comes from the host resource model: `useResource` (injected
 * into every tab body by the sidebar's slot framework) resolves a logged
 * `dsh-resource://plan/...` address through the host's own plan provider.
 * Temporary review previews (`dsh-resource://plan-review/...`) carry their
 * document in `navigation.params.planReview` and have no resource at all.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Button, IconCloseFillRegular, MarkdownText, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { IconButton } from './ui/index.ts'
import { markdownCopyLabels, markdownTextProps } from './markdown-labels.tsx'
import { t, type CopyKey } from './locales.ts'
import { useLocaleRefresh } from './locale-hooks.ts'
import { isLikelyImeKey } from './ime-guard.ts'
import { insertQuoteRecord } from './selection-quote.ts'
import { clipText } from './selection-payload.ts'
import { useSelectionPopup } from './selection-popup.ts'
import {
  floatingActionPlacement, noteBoxPlacement, surfaceOf, type PlanPopupAnchor,
} from './plan-placement.ts'
import { isPlanReviewAddress } from './plan-address.ts'
import type { NativeResourceSnapshot, TabComponentProps } from './service.ts'
import { useNoopResource } from './service.ts'
import css from './PlanViewer.module.css'

/** The plan document the host's resource (or the review params) carries. */
interface PlanDocument {
  readonly markdown: string
  readonly title: string
}

/** Hard cap on one note. Keeps a pasted essay from overflowing the persisted
 *  quote store (the payload keeps the note whole by design). */
const NOTE_MAX_LENGTH = 4000
/** Longest raw selection previewed in the note box. The sent quote is capped
 *  even lower; this only keeps an unbounded drag-select out of the popup. */
const QUOTE_PREVIEW_MAX = 480

/** Validate a host plan value (SubmittedPlan / PlanDocument are structural). */
function planDocumentOf(value: unknown): PlanDocument | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const plan = value as { markdown?: unknown; title?: unknown }
  if (typeof plan.markdown !== 'string' || typeof plan.title !== 'string') return undefined
  return { markdown: plan.markdown, title: plan.title }
}

/** Read the temporary review document from the tab's navigation params. */
function reviewDocumentOf(params: unknown): PlanDocument | undefined {
  if (typeof params !== 'object' || params === null) return undefined
  return planDocumentOf((params as { planReview?: unknown }).planReview)
}

/** The selection payload carried from the floating button into the note box. */
interface PlanSelection extends PlanPopupAnchor {
  readonly quote: string
}

/** The live note box (one at a time per plan page). */
interface NoteDraft extends PlanSelection {
  note: string
}

/**
 * Empty-state copy by status; a temporary review has no resource. A `live`
 * snapshot without a usable document is a failure, not a loading state.
 */
type PlanMessageStatus = 'expired' | NativeResourceSnapshot['status']
const PLAN_MESSAGE_BY_STATUS: Readonly<Record<PlanMessageStatus, CopyKey>> = {
  expired: 'planAnnotationExpired',
  none: 'planAnnotationUnavailable',
  loading: 'planAnnotationLoading',
  live: 'planAnnotationFailed',
  failed: 'planAnnotationFailed',
}

/**
 * Render one plan tab with the selection-to-chip action.
 * @param props - the native tab's body props (plus the optional native face).
 */
export function PlanViewer(props: TabComponentProps): ReactNode {
  const { ctx, scope, visible, native } = props
  const address = native?.address ?? ''
  const useResource = native?.useResource ?? useNoopResource
  const resource = useResource(address)
  const temporary = isPlanReviewAddress(address)
  const plan = temporary ? reviewDocumentOf(native?.params) : planDocumentOf(resource.value)
  const planId = address
  const sessionId = scope.sessionId

  // A plan tab's static descriptor title is generic; once the resource (or the
  // review params) yields the document, retitle the chip to the plan's title.
  const onTitle = native?.onTitle
  useEffect(() => {
    if (plan?.title !== undefined && plan.title !== '') onTitle?.(plan.title)
  }, [plan?.title, onTitle])

  // The native body renders in the HOST's tree, outside the plugin shell, so a
  // locale switch does not re-render it by itself.
  useLocaleRefresh(ctx)

  // ── Selection → popup → note box ─────────────────────────────────────────
  const docRef = useRef<HTMLDivElement | null>(null)
  const noteRef = useRef<HTMLDivElement | null>(null)
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null)
  const [sendFailed, setSendFailed] = useState(false)
  const [added, setAdded] = useState(false)
  const selectionPopup = useSelectionPopup<PlanSelection>({
    onCommit: (selection) => {
      setSendFailed(false)
      // The pane can move between the mouseup snapshot and this click (an OS
      // window resize or zoom carries no pointerdown to dismiss the popup), so
      // the note box clamps to the pane's current box, not the stale one.
      setNoteDraft({
        ...selection,
        note: '',
        surface: surfaceOf(docRef.current) ?? selection.surface,
      })
    },
    getSurface: () => docRef.current,
  })
  // One reset for every way the box can close (cancel, Escape, outside click,
  // successful submit, tab hide/navigation): a path that forgets the failure
  // flag would leave a stale error line on the next note.
  const cancelNote = useCallback((): void => {
    setNoteDraft(null)
    setSendFailed(false)
  }, [])
  // The note box is portalled to document.body and is not part of the button
  // popup's own close contract, so hiding the tab (or navigating to another
  // plan address) must reset it explicitly; the button popup is already closed
  // by the hook's IntersectionObserver. The effect also runs when the tab
  // becomes visible again, a no-op after the hidden run reset everything.
  const hideSelectionPopup = selectionPopup.hide
  useEffect(() => {
    cancelNote()
    setAdded(false)
    hideSelectionPopup()
  }, [planId, visible, cancelNote, hideSelectionPopup])

  const noteOpen = noteDraft !== null

  const handleMouseUp = (): void => {
    // Mouse selection only: keyboard and touch selections dispatch no mouseup,
    // so they never open the button (a known limitation, not an oversight).
    // While the note box is open the gesture belongs to the reader's typing: a
    // new selection must not replace an unsubmitted note.
    if (noteOpen) {
      selectionPopup.hide()
      return
    }
    const container = docRef.current
    if (container === null || plan === undefined) return
    const selection = window.getSelection()
    if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
      selectionPopup.hide()
      return
    }
    const range = selection.getRangeAt(0)
    const quote = range.toString().trim()
    if (!container.contains(range.startContainer) || !container.contains(range.endContainer) || quote === '') {
      selectionPopup.hide()
      return
    }
    const rect = typeof range.getBoundingClientRect === 'function'
      ? range.getBoundingClientRect()
      : { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }
    const left = rect.left + rect.width / 2
    selectionPopup.show(
      { quote, left, top: rect.top, bottom: rect.bottom, surface: surfaceOf(container) },
      left,
      rect.top,
    )
  }

  // A failed insert keeps the box open so the typed note is never lost; the
  // reader can cancel explicitly or retry once the composer is available.
  // Escape and outside clicks are inert too — dismissing on either would undo
  // that promise (a stray Escape aimed at another surface included).
  useDismissOnOutsidePointer(noteRef, noteOpen && !sendFailed, cancelNote)
  useEffect(() => {
    if (!noteOpen || sendFailed) return
    const onKeyDown = (event: KeyboardEvent): void => {
      // An IME candidate window owns Escape; closing here would lose the
      // unsubmitted note. The global guard's stopPropagation cannot reach this
      // document capture listener, so guard explicitly.
      if (isLikelyImeKey(event)) return
      if (event.key === 'Escape') cancelNote()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [noteOpen, sendFailed, cancelNote])

  const submitNote = useCallback((): void => {
    const draft = noteDraft
    if (draft === null) return
    const note = draft.note.trim()
    if (note === '') return
    const record = insertQuoteRecord(ctx, sessionId, {
      kind: 'plan',
      planId,
      note,
      text: draft.quote,
      ...(plan?.title === undefined ? {} : { planTitle: plan.title }),
    })
    if (record === undefined) {
      setSendFailed(true)
      return
    }
    cancelNote()
    setAdded(true)
    window.getSelection()?.removeAllRanges()
  }, [noteDraft, ctx, sessionId, planId, plan?.title, cancelNote])

  // The success line is transient; it is not a state the reader must clear.
  useEffect(() => {
    if (!added) return
    const timer = setTimeout(() => { setAdded(false) }, 3500)
    return () => { clearTimeout(timer) }
  }, [added])

  // ── Render ───────────────────────────────────────────────────────────────
  let body: ReactNode
  if (plan === undefined) {
    body = (
      <div className={css.planMessage} role="status">
        {t(PLAN_MESSAGE_BY_STATUS[temporary ? 'expired' : resource.status])}
      </div>
    )
  } else {
    const markdownProps = markdownTextProps(plan.markdown, markdownCopyLabels())
    body = <MarkdownText {...markdownProps} />
  }

  const notePlacement = noteDraft === null ? undefined : noteBoxPlacement(noteDraft)
  const actionPlacement = selectionPopup.popup === null
    ? undefined
    : floatingActionPlacement(selectionPopup.popup.insert)
  const quotePreview = noteDraft === null ? '' : clipText(noteDraft.quote, QUOTE_PREVIEW_MAX)

  return (
    <div className={css.planViewer} data-plan-viewer={planId}>
      <div
        ref={docRef}
        className={css.planDocument}
        data-plan-document=""
        onMouseUp={handleMouseUp}
        // The button is position: fixed; without this it would float over
        // unrelated text after the selection scrolls away (capture catches
        // scrolls of nested code blocks too, which do not bubble).
        onScrollCapture={() => {
          if (selectionPopup.popup !== null) selectionPopup.hide()
        }}
      >
        {body}
      </div>
      {added && (
        <p className={css.planAnnotationToast} role="status" data-plan-annotation-toast="">{t('addToConversation')}</p>
      )}
      {selectionPopup.popup !== null && actionPlacement !== undefined && createPortal(
        <Button
          ref={selectionPopup.buttonRef}
          type="button"
          variant="primary"
          size="sm"
          className={css.planSelectionAction}
          data-plan-annotation-add=""
          style={{
            position: 'fixed',
            left: actionPlacement.left,
            top: actionPlacement.top,
            transform: `translate(-50%, ${actionPlacement.above ? '-100%' : '0'})`,
            zIndex: 65,
          }}
          onMouseDown={event => { event.preventDefault() }}
          onClick={() => { selectionPopup.commit() }}
        >
          {t('planAnnotationAdd')}
        </Button>,
        document.body,
      )}
      {noteDraft !== null && notePlacement !== undefined && createPortal(
        <div
          ref={noteRef}
          className={css.planNotePopup}
          data-plan-annotation-note=""
          role="dialog"
          aria-label={t('planAnnotation')}
          style={{
            left: notePlacement.left,
            top: notePlacement.top,
            width: notePlacement.width,
            maxHeight: notePlacement.maxHeight,
          }}
        >
          <div className={css.planNoteHead}>
            <span className={css.planNoteTitle}>{t('planAnnotation')}</span>
            <IconButton
              size="sm"
              icon={<IconCloseFillRegular size={12} />}
              label={t('cancel')}
              danger
              onClick={cancelNote}
            />
          </div>
          <div className={css.planNoteQuote}>{quotePreview}</div>
          <textarea
            className={css.planNoteInput}
            autoFocus
            maxLength={NOTE_MAX_LENGTH}
            aria-label={t('planAnnotationPlaceholder')}
            value={noteDraft.note}
            placeholder={t('planAnnotationPlaceholder')}
            onChange={event => { setNoteDraft(draft => (draft === null ? draft : { ...draft, note: event.target.value })) }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return
              // An IME composition's Enter belongs to the input method, never
              // to the note's submit action.
              if (isLikelyImeKey(event.nativeEvent)) return
              event.preventDefault()
              submitNote()
            }}
          />
          {sendFailed && <p className={css.planNoteError} data-plan-annotation-error="">{t('planAnnotationSendFailed')}</p>}
          <div className={css.planNoteRow}>
            <Button type="button" variant="outline" size="sm" data-plan-annotation-cancel="" onClick={cancelNote}>
              {t('cancel')}
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              data-plan-annotation-submit=""
              disabled={noteDraft.note.trim() === ''}
              onClick={submitNote}
            >
              {t('planAnnotationSubmit')}
            </Button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
