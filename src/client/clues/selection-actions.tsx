/**
 * UI19 selection actions: the ONE menu a rendered clue body (and the shared
 * text editor) opens for a non-empty text selection.
 *
 * Two integration seams, deliberately separate:
 * - `ResourceSelectionActions` wraps a rendered body/comments surface with the
 *   metadata the menu needs and captures native selections inside it;
 * - `setClueSelectionActionContext` is the page-wide bridge the parent
 *   installs once to supply `onInsert` (and, when the wrapper is not in the
 *   tree, the workspace/resource target the text editor should use).
 *
 * The menu itself never reads or mutates the composer draft. `insert` routes
 * through the bridge; every other action sends the RAW selected text to the
 * typed `clues.actions.start` wire method, where the host owns the agent turn.
 */
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { call } from '../api.ts'
import { t } from '../locales.ts'
import { useSelectionPopup } from '../selection-popup.ts'
import type { PendingReference } from '../conversation-draft.ts'
import { isLikelyImeKey } from '../ime-guard.ts'
import { ActionButton } from '../ui/index.ts'
import type { ClueClientResourceInput } from './api.ts'
import { categoryOf, clueErrorHint } from './copy.ts'
import css from './selection-actions.module.css'

/** Every menu entry, in visual order. */
export const CLUE_SELECTION_ACTIONS = [
  'insert',
  'explain',
  'rewrite',
  'expand',
  'continue',
  'shorten',
  'translate',
] as const

/** One menu entry. */
export type ClueSelectionAction = (typeof CLUE_SELECTION_ACTIONS)[number]

/** One server-owned selection action (insert is local-only). */
type ClueSelectionServerAction = Exclude<ClueSelectionAction, 'insert'>

/** The exact request payload of `clues.actions.start`. */
export interface ClueSelectionActionRequest {
  readonly workspaceId: string
  readonly sessionId: string
  readonly resource: ClueClientResourceInput
  readonly action: ClueSelectionServerAction
  readonly target: 'main' | 'side'
  /** One user intent; retained when that same intent is explicitly retried. */
  readonly requestId: string
  readonly selection: string
  /**
   * Comment selections are read-only apart from insertion: the server rejects
   * every action except `explain` when this is true.
   */
  readonly comment?: boolean
}

/** The editor identity a bridge target must match before it can be used. */
export interface ClueSelectionActionScope {
  readonly sessionId?: string
  readonly path?: string
}

/** The transport seam (tests and integration may replace it). */
type ClueSelectionActionStarter = (request: ClueSelectionActionRequest) => Promise<unknown>

/** Core and lazy editor bundles inline this module independently; only the page owns bridge state. */
interface SelectionBridgeState {
  context: ClueSelectionActionContext | undefined
  starter: ClueSelectionActionStarter | undefined
  listeners: Set<() => void>
}
const SELECTION_BRIDGE_KEY = Symbol.for('dsh-better-sidebar.clue-selection-bridge')

function selectionBridge(): SelectionBridgeState {
  const page = globalThis as typeof globalThis & { [SELECTION_BRIDGE_KEY]?: SelectionBridgeState }
  return page[SELECTION_BRIDGE_KEY] ??= { context: undefined, starter: undefined, listeners: new Set() }
}

/**
 * Replace the default typed wire transport. Passing `undefined` restores it.
 * @internal Used by tests and the host-side integration seam.
 */
export function setClueSelectionActionStarter(starter: ClueSelectionActionStarter | undefined): void {
  selectionBridge().starter = starter
}

/** Send one selection action through `clues.actions.start`. */
export function startClueSelectionAction(request: ClueSelectionActionRequest): Promise<unknown> {
  const starter = selectionBridge().starter
  if (starter !== undefined) return starter(request)
  return call('clues.actions.start', { ...request })
}

/** One insert decision: the parent appends the payload to its composer draft. */
export interface ClueSelectionInsertInput {
  readonly clueId?: string
  /** Present when the wrapper/bridge knows the owning clue target. */
  readonly workspaceId?: string
  readonly sessionId?: string
  readonly resource?: ClueClientResourceInput
  /** The RAW selected text (never the shortened insert projection). */
  readonly selection: string
  /** The formatted text a composer insert should append. */
  readonly insert: string
  /** Compact chip metadata; full text is expanded only on send. */
  readonly reference?: PendingReference
}

/** The parent-installed insert callback; `false` may mean "refused". */
export type ClueSelectionInsertHandler = (input: ClueSelectionInsertInput) => boolean | void | Promise<boolean | void>

/**
 * The page-wide bridge. It survives a component tree with no
 * `ResourceSelectionActions` wrapper (the shared TextEditor uses the target
 * fields; a bare bridge supplies `onInsert` only).
 */
interface ClueSelectionActionContext {
  readonly workspaceId?: string
  readonly sessionId?: string
  readonly resource?: ClueClientResourceInput
  readonly comment?: boolean
  /**
   * Exact editor file for a TextEditor bridge target. A target without this
   * must not be applied implicitly to whichever editor happens to render.
   */
  readonly path?: string
  readonly onInsert?: ClueSelectionInsertHandler
}

/** Install (or clear) the parent bridge, notifying subscribers from every bundle. */
export function setClueSelectionActionContext(context: ClueSelectionActionContext | null): void {
  const bridge = selectionBridge()
  bridge.context = context ?? undefined
  for (const listener of [...bridge.listeners]) listener()
}

/** The current page-owned bridge value (including event-time reads after HMR). */
export function getClueSelectionActionContext(): ClueSelectionActionContext | undefined {
  return selectionBridge().context
}

/** Subscribe across bundles; the idempotent disposer releases this listener. */
export function subscribeClueSelectionActionContext(listener: () => void): () => void {
  const listeners = selectionBridge().listeners
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** One resolved target the menu can address. */
export interface ClueSelectionActionTarget {
  readonly workspaceId: string
  readonly sessionId: string
  readonly resource: ClueClientResourceInput
  readonly comment?: boolean
  readonly onInsert?: ClueSelectionInsertHandler
}

// React Context identity stays local to each bundle; cross-bundle targets must be explicit props.
const TargetContext = createContext<ClueSelectionActionTarget | undefined>(undefined)

/**
 * The target for a selection surface: the nearest wrapper wins, with the
 * module bridge's `onInsert` layered on top. A bridge without a full target
 * is intentionally not returned here (it only supplies the legacy insert
 * handler through {@link useClueSelectionActionContext}).
 */
export function useClueSelectionActionTarget(scope?: ClueSelectionActionScope): ClueSelectionActionTarget | undefined {
  const local = useContext(TargetContext)
  const bridge = useSyncExternalStore(subscribeClueSelectionActionContext, getClueSelectionActionContext, getClueSelectionActionContext)
  if (local !== undefined) {
    return local.onInsert !== undefined || bridge?.onInsert === undefined ? local : { ...local, onInsert: bridge.onInsert }
  }
  if (bridge?.workspaceId === undefined || bridge.resource === undefined) return undefined
  // A module-level target is only safe for the surface it named. A caller
  // that supplies its own identity (the shared TextEditor) must match on every
  // identity the bridge declares; a bridge with no identity never applies
  // implicitly to an arbitrary editor.
  if (scope !== undefined) {
    // An editor target must name BOTH the session and the exact file: a
    // session-only bridge could still point the action at another resource,
    // and a path-only one could act under the wrong conversation.
    if (bridge.sessionId === undefined || bridge.path === undefined) return undefined
    if (bridge.sessionId !== scope.sessionId || bridge.path !== scope.path) return undefined
  }
  const target: ClueSelectionActionTarget = {
    workspaceId: bridge.workspaceId,
    sessionId: bridge.sessionId ?? '',
    resource: bridge.resource,
    ...(bridge.comment === undefined ? {} : { comment: bridge.comment }),
    ...(bridge.onInsert === undefined ? {} : { onInsert: bridge.onInsert }),
  }
  return target
}

/** Subscribe to the module bridge (the editor's legacy insert fallback uses it). */
export function useClueSelectionActionContext(): ClueSelectionActionContext | undefined {
  return useSyncExternalStore(subscribeClueSelectionActionContext, getClueSelectionActionContext, getClueSelectionActionContext)
}

/** Typed selection labels from the integrated locale dictionaries. */
const CLUE_SELECTION_LOCALE_KEYS = {
  menu: 'clueSelectionMenu',
  insert: 'clueSelectionInsert',
  explain: 'clueSelectionExplain',
  rewrite: 'clueSelectionRewrite',
  expand: 'clueSelectionExpand',
  continue: 'clueSelectionContinue',
  target: 'clueSelectionTarget',
  main: 'clueSelectionTargetMain',
  side: 'clueSelectionTargetSide',
  shorten: 'clueSelectionShorten',
  translate: 'clueSelectionTranslate',
  failed: 'clueSelectionFailed',
} as const

type SelectionLabelKey = keyof typeof CLUE_SELECTION_LOCALE_KEYS
/** The localized label of one key, checked against the integrated dictionary. */
function clueSelectionLabel(key: SelectionLabelKey): string {
  return t(CLUE_SELECTION_LOCALE_KEYS[key])
}

/** The localized label of one menu action. */
function clueSelectionActionLabel(action: ClueSelectionAction): string {
  return clueSelectionLabel(action)
}

/**
 * Request-safe resource: the server's `clues.actions.start` scope is exactly
 * `clueId` OR `sourceId+typeId+locator`; the session is its own field and a
 * paged read's `offset` is not an action target. Never forward UI-only keys.
 */
function requestResourceOf(resource: ClueClientResourceInput): ClueClientResourceInput {
  const { sessionId: _sessionId, offset: _offset, ...rest } = resource
  return rest as ClueClientResourceInput
}

/** The actions a surface offers; comments are intentionally narrower. */
function clueSelectionActionsFor(comment: boolean | undefined): readonly ClueSelectionAction[] {
  return comment === true ? ['insert', 'explain'] : CLUE_SELECTION_ACTIONS
}

/** One menu anchor (viewport coordinates, like `SelectionPopup`). */
interface SelectionActionMenuProps {
  readonly workspaceId: string
  readonly sessionId: string
  readonly resource: ClueClientResourceInput
  readonly selection: string
  /** The formatted composer insert; never substituted for `selection`. */
  readonly insert: string
  readonly reference?: PendingReference
  readonly comment?: boolean
  readonly left: number
  readonly top: number
  readonly onInsert?: ClueSelectionInsertHandler
  onClose?(): void
  /** The hook's whole-surface ref, so its outside-click guard keeps the menu. */
  readonly containerRef?: MutableRefObject<HTMLElement | null>
}

/**
 * The presentational menu. Both the wrapper and the shared TextEditor render
 * this same component in a portal, so keyboard, dismissal and wire behavior
 * cannot drift between surfaces.
 */
export function SelectionActionMenu(props: SelectionActionMenuProps): ReactNode {
  const {
    workspaceId, sessionId, resource, selection, insert, comment, left, top, onInsert, onClose, containerRef,
  } = props
  const actions = clueSelectionActionsFor(comment)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [busy, setBusy] = useState<ClueSelectionAction | null>(null)
  const [failure, setFailure] = useState<{ message: string; retry?: ClueSelectionServerAction } | null>(null)
  const [destination, setDestination] = useState<'main' | 'side'>('main')
  const busyRef = useRef(false)
  const lastRequestRef = useRef<{ key: string; requestId: string; action: ClueSelectionServerAction } | null>(null)

  const attachRef = (node: HTMLDivElement | null): void => {
    menuRef.current = node
    if (containerRef !== undefined) containerRef.current = node
  }

  // Focus the first entry once, so the menu is usable from the keyboard. The
  // selection was already captured, so moving focus cannot lose it.
  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('[data-clue-selection-target="main"], [data-clue-selection-action]')?.focus()
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (isLikelyImeKey(event.nativeEvent)) return
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose?.()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[data-clue-selection-target], [data-clue-selection-action]') ?? [])]
    if (items.length === 0) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (current + 1 + items.length) % items.length
          : (current - 1 + items.length) % items.length
    items[next]?.focus()
  }

  const chooseDestination = (next: 'main' | 'side'): void => {
    if (busyRef.current || next === destination) return
    lastRequestRef.current = null
    setDestination(next)
    setFailure(null)
  }

  const run = async (action: ClueSelectionAction): Promise<void> => {
    if (busyRef.current) return
    if (action === 'insert') {
      // A parent may refuse the insert (e.g. the composer moved); keep the
      // menu and the captured selection available for an explicit retry.
      const reference = props.reference ?? { label: selection.trim().split('\n')[0]!.slice(0, 80), text: insert }
      busyRef.current = true
      setBusy(action)
      setFailure(null)
      try {
        const accepted = await onInsert?.({ workspaceId, sessionId, resource, selection, insert, reference })
        if (accepted === false) setFailure({ message: t('clueInsertFailed') })
        else onClose?.()
      } catch (error) {
        setFailure({ message: error instanceof Error ? error.message : t('clueInsertFailed') })
      } finally {
        busyRef.current = false
        setBusy(null)
      }
      return
    }
    // Freeze synchronously as well as visually: two clicks in one render must not mint two intents.
    busyRef.current = true
    setBusy(action)
    setFailure(null)
    try {
      const requestResource = requestResourceOf(resource)
      const key = JSON.stringify([workspaceId, sessionId, requestResource, comment === true, action, destination, selection])
      if (lastRequestRef.current?.key !== key) lastRequestRef.current = { key, requestId: globalThis.crypto.randomUUID(), action }
      // The server needs the comment flag itself (not just the UI filter) so
      // a tampered client cannot turn a comment selection into a write.
      await startClueSelectionAction({
        workspaceId,
        sessionId,
        // The session id travels separately; leaving it inside the resource
        // would let an old target's scope fail the server's equality check.
        resource: requestResource,
        action,
        target: destination,
        requestId: lastRequestRef.current.requestId,
        selection,
        ...(comment === true ? { comment: true } : {}),
      })
      onClose?.()
    } catch (error) {
      busyRef.current = false
      setBusy(null)
      const category = categoryOf(error)
      const writerHeld = category === 'conflict' && error instanceof Error
        && error.message === 'The conversation is in use by another DSH instance.'
      const message = writerHeld ? t('clueSelectionWriterHeld')
        : category === 'cancelled' ? t('cancel')
          : category === 'not-found' || category === 'unsupported' || category === 'conflict' ? t('clueSelectionSessionUnavailable')
            : clueErrorHint(category) ?? (category === 'failed' ? t('clueSelectionReceiptUnknown') : clueSelectionLabel('failed'))
      setFailure({ message, ...(writerHeld ? { retry: action } : {}) })
    }
  }

  // A menu can be taller than the legacy one-button popup: flip below the
  // selection when there is no room above it, so a selection near the top of
  // the viewport never pushes the actions off-screen.
  const belowHeight = Math.max(0, window.innerHeight - top - 16)
  const aboveHeight = Math.max(0, top - 16)
  const placeBelow = aboveHeight < 320 && belowHeight > aboveHeight
  const availableHeight = Math.max(48, placeBelow ? belowHeight : aboveHeight)
  const halfWidth = Math.min(120, Math.max(0, (window.innerWidth - 16) / 2))
  const menuLeft = Math.min(Math.max(left, halfWidth + 8), window.innerWidth - halfWidth - 8)
  return createElement(
    'div',
    {
      ref: attachRef,
      className: placeBelow ? `${css.menu} ${css.menuBelow}` : css.menu,
      role: 'menu',
      'aria-label': clueSelectionLabel('menu'),
      'data-clue-selection-menu': '',
      style: { left: menuLeft, top, maxHeight: availableHeight },
      onKeyDown,
      // The hook's document-level capture handler already keeps a mousedown
      // inside `containerRef`; this stops a future outside handler from
      // treating the menu itself as an outside click.
      onMouseDown: (event: MouseEvent<HTMLDivElement>) => { event.stopPropagation() },
    },
    createElement('div', { className: css.destinationGroup, role: 'group', 'aria-label': clueSelectionLabel('target') },
      createElement('div', { className: css.destinations }, ...(['main', 'side'] as const).map(target => createElement('button', {
        key: target,
        type: 'button',
        role: 'menuitemradio',
        className: css.destination,
        'aria-checked': destination === target,
        'data-clue-selection-target': target,
        tabIndex: destination === target ? 0 : -1,
        disabled: busy !== null,
        onClick: () => { chooseDestination(target) },
        onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          event.stopPropagation()
          const next = target === 'main' ? 'side' : 'main'
          chooseDestination(next)
          menuRef.current?.querySelector<HTMLButtonElement>(`[data-clue-selection-target="${next}"]`)?.focus()
        },
      }, clueSelectionLabel(target)))),
    ),
    ...actions.map(action => createElement(
      ActionButton,
      {
        key: action,
        type: 'button',
        role: 'menuitem',
        variant: 'ghost',
        busy: busy === action,
        className: css.item,
        'data-clue-selection-action': action,
        disabled: busy !== null || (failure !== null && action !== 'insert' && failure.retry === undefined
          && action === lastRequestRef.current?.action),
        'aria-busy': busy === action ? 'true' : undefined,
        onClick: () => { void run(action) },
      },
      clueSelectionActionLabel(action),
    )),
    failure !== null
      ? createElement('div', {
          className: css.error,
          role: 'alert',
          'data-clue-selection-error': '',
        }, failure.message,
        failure.retry === undefined ? null : createElement(ActionButton, {
          size: 'sm', variant: 'ghost', className: css.item, role: 'menuitem',
          onClick: () => { if (failure.retry !== undefined) void run(failure.retry) },
        }, t('retry')))
      : null,
  )
}

/** Props of the wrapper surface. */
interface ResourceSelectionActionsProps {
  readonly onInsert?: ClueSelectionInsertHandler
  readonly workspaceId: string
  readonly sessionId: string
  readonly resource: ClueClientResourceInput
  readonly children?: ReactNode
  /** Comment mode narrows the menu to insert/explain. */
  readonly comment?: boolean
}

/**
 * Wrap a rendered clue body/comments surface with the selection menu. The
 * wrapper is layout-neutral (`display: contents`); the first element child is
 * the observer surface, so a tab switch/collapse still dismisses the menu.
 */
export function ResourceSelectionActions(props: ResourceSelectionActionsProps): ReactNode {
  const { workspaceId, sessionId, resource, children, comment } = props
  const wrapperRef = useRef<HTMLDivElement>(null)
  const bridge = useClueSelectionActionContext()
  const onInsert = props.onInsert ?? bridge?.onInsert
  const target: ClueSelectionActionTarget = {
    workspaceId,
    sessionId,
    resource,
    ...(comment === undefined ? {} : { comment }),
    ...(onInsert === undefined ? {} : { onInsert }),
  }
  const popup = useSelectionPopup({
    onCommit: () => undefined,
    getSurface: () => {
      const wrapper = wrapperRef.current
      const first = wrapper?.firstElementChild
      return first instanceof HTMLElement ? first : wrapper
    },
  })

  const capture = (point?: MouseEvent<HTMLDivElement>): boolean => {
    const wrapper = wrapperRef.current
    const selection = window.getSelection()
    if (wrapper === null || selection === null || selection.isCollapsed
      || selection.anchorNode === null || selection.focusNode === null) {
      if (point === undefined) popup.hide()
      return false
    }
    if (!wrapper.contains(selection.anchorNode) || !wrapper.contains(selection.focusNode)) {
      if (point === undefined) popup.hide()
      return false
    }
    const text = selection.toString()
    if (text.trim() === '') {
      if (point === undefined) popup.hide()
      return false
    }
    const range = selection.getRangeAt(0)
    const rect = typeof range.getBoundingClientRect === 'function'
      ? range.getBoundingClientRect()
      : { left: 0, top: 0, width: 0 }
    if (point !== undefined && point.button !== 0 && !Array.from(range.getClientRects()).some(box =>
      point.clientX >= box.left && point.clientX <= box.right && point.clientY >= box.top && point.clientY <= box.bottom)) return false
    popup.show(text, point?.clientX ?? rect.left + rect.width / 2, point?.clientY ?? rect.top, text)
    return true
  }

  return createElement(
    TargetContext.Provider,
    { value: target },
    createElement(
      'div',
      {
        ref: wrapperRef,
        className: css.surface,
        'data-clue-selection-surface': '',
        onMouseUp: (event: MouseEvent<HTMLDivElement>) => { if (event.button === 0) capture() },
        onKeyUp: () => { capture() },
        onContextMenu: (event: MouseEvent<HTMLDivElement>) => {
          if (!capture(event)) return
          event.preventDefault()
          event.stopPropagation()
        },
      },
      children,
    ),
    popup.popup === null
      ? null
      : createPortal(
          createElement(SelectionActionMenu, {
            workspaceId,
            sessionId,
            resource,
            selection: popup.popup.selection,
            insert: popup.popup.insert,
            ...(comment === undefined ? {} : { comment }),
            left: popup.popup.left,
            top: popup.popup.top,
            ...(onInsert === undefined ? {} : { onInsert }),
            onClose: () => { popup.hide() },
            containerRef: popup.popupRef,
          }),
          document.body,
        ),
  )
}
