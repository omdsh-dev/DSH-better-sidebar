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
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { usePointerGrace } from '@deepseek-ai/dsh-client-ui-primitives/client'
import { call } from '../api.ts'
import { t } from '../locales.ts'
import { useSelectionPopup } from '../selection-popup.ts'
import type { PendingReference } from '../conversation-draft.ts'
import { isLikelyImeKey } from '../ime-guard.ts'
import { useViewportSize } from '../breakpoints.ts'
import { ActionButton, LoadingIndicator } from '../ui/index.ts'
import { selectionSettingsOf, selectionPrompt, type SelectionSettings } from '../../selection-settings.ts'
import type { ClueClientResourceInput } from './api.ts'
import { categoryOf, clueErrorHint } from './copy.ts'
import css from './selection-actions.module.css'

/** Every menu entry, in visual order. */
export const CLUE_SELECTION_ACTIONS = [
  'insert',
  'explain',
  'rewrite',
  'expand',
  'humanize',
  'custom',
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
  readonly instruction?: string
  readonly actionLabel?: string
  readonly prepareOnly?: boolean
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
  settings: SelectionSettings
  language?: () => string
}
const SELECTION_BRIDGE_KEY = Symbol.for('dsh-better-sidebar.clue-selection-bridge')

function selectionBridge(): SelectionBridgeState {
  const page = globalThis as typeof globalThis & { [SELECTION_BRIDGE_KEY]?: SelectionBridgeState }
  return page[SELECTION_BRIDGE_KEY] ??= { context: undefined, starter: undefined, listeners: new Set(), settings: selectionSettingsOf({}) }
}

/**
 * Replace the default typed wire transport. Passing `undefined` restores it.
 * @internal Used by tests and the host-side integration seam.
 */
export function setClueSelectionActionStarter(starter: ClueSelectionActionStarter | undefined): void {
  selectionBridge().starter = starter
}

/** The live document is page-owned so lazy editor and core never diverge. */
export function setSelectionMenuSettings(settings: SelectionSettings, language: () => string): void {
  const bridge = selectionBridge()
  bridge.settings = settings
  bridge.language = language
  for (const listener of [...bridge.listeners]) listener()
}
export function useSelectionMenuSettings(): SelectionSettings {
  return useSyncExternalStore(subscribeClueSelectionActionContext, () => selectionBridge().settings, () => selectionBridge().settings)
}

/** Send one selection action through `clues.actions.start`. */
export function startClueSelectionAction(request: ClueSelectionActionRequest): Promise<unknown> {
  const starter = selectionBridge().starter
  if (starter !== undefined) return starter(request)
  return call('clues.actions.start', { ...request })
}

/** One insert decision: the parent appends the payload to its composer draft. */
export interface ClueSelectionInsertInput {
  readonly target?: 'main' | 'side'
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
  readonly writable?: boolean
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
  humanize: 'selectionHumanize',
  custom: 'selectionCustom',
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

/** One menu anchor (viewport coordinates, like `SelectionPopup`). */
interface SelectionActionMenuProps {
  readonly workspaceId?: string
  readonly sessionId: string
  readonly resource?: ClueClientResourceInput
  readonly selection: string
  /** The formatted composer insert; never substituted for `selection`. */
  readonly insert: string
  readonly reference?: PendingReference
  readonly comment?: boolean
  readonly writable?: boolean
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
  const { workspaceId, sessionId, resource, selection, insert, left, top } = props
  const settings = useSelectionMenuSettings()
  const viewport = useViewportSize()
  const [submenu, setSubmenu] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ message: string; action: string } | null>(null)
  const [translation, setTranslation] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const flyoutRef = useRef<HTMLDivElement | null>(null)
  const rewriteRef = useRef<HTMLButtonElement | null>(null)
  const enterFlyout = useRef(false)
  const flyoutId = useId()
  const [flyoutPosition, setFlyoutPosition] = useState({ top: 8, maxHeight: viewport.height - 16 })
  const busyRef = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const lastRequest = useRef<{ key: string; id: string } | null>(null)
  const attachRef = (element: HTMLDivElement | null): void => {
    if (props.containerRef !== undefined) props.containerRef.current = element
  }
  useEffect(() => () => { controller.current?.abort() }, [])
  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }, [translation])
  const closeSubmenu = useCallback((): void => {
    if (flyoutRef.current?.contains(document.activeElement)) rewriteRef.current?.focus({ preventScroll: true })
    setSubmenu(false)
  }, [])
  const grace = usePointerGrace(closeSubmenu)
  const openSubmenu = (enter: boolean): void => {
    grace.cancel()
    enterFlyout.current = enter && !submenu
    if (submenu && enter) flyoutRef.current?.querySelector<HTMLButtonElement>('[data-clue-selection-action]:not(:disabled)')?.focus({ preventScroll: true })
    setSubmenu(true)
  }
  useEffect(() => {
    if (!submenu) return
    const onEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || isLikelyImeKey(event)) return
      event.preventDefault(); event.stopPropagation()
      closeSubmenu()
    }
    document.addEventListener('keydown', onEscape, true)
    return () => document.removeEventListener('keydown', onEscape, true)
  }, [submenu, closeSubmenu])
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (isLikelyImeKey(event.nativeEvent)) return
    if (event.key === 'Escape' || (submenu && event.key === 'ArrowLeft')) {
      event.preventDefault(); event.stopPropagation()
      if (submenu) closeSubmenu()
      else props.onClose?.()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    const activeMenu = flyoutRef.current?.contains(document.activeElement) ? flyoutRef.current : menuRef.current
    const items = Array.from(activeMenu?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (current + 1) % items.length : (current - 1 + items.length) % items.length
    items[next]?.focus()
  }
  const run = async (id: string): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    grace.cancel(); closeSubmenu()
    setBusy(id); setFailure(null)
    try {
      if (id === 'insertMain' || id === 'insertSide') {
        const reference = props.reference ?? { label: selection.trim().split('\n')[0]!.slice(0, 80), text: insert }
        const result = await props.onInsert?.({ workspaceId, sessionId, resource, selection, insert, reference, target: id === 'insertSide' ? 'side' : 'main' })
        if (result === false || props.onInsert === undefined) throw new Error(t('clueInsertFailed'))
        props.onClose?.()
      } else if (id === 'translate') {
        const abort = new AbortController()
        controller.current = abort
        const route = settings.translationModel
        const slash = route.indexOf('/')
        const result = await call<{ text: string }>('selection.translate', {
          sessionId, text: selection,
          language: settings.translationLanguage || selectionBridge().language?.() || navigator.language,
          ...(slash < 1 ? {} : { model: { provider: route.slice(0, slash), model: route.slice(slash + 1) } }),
        }, abort.signal)
        if (!abort.signal.aborted) setTranslation(result.text)
      } else {
        if (workspaceId === undefined || resource === undefined) throw new Error(t('selectionUnavailable'))
        const custom = settings.customActions.find(action => action.id === id)
        const action = custom === undefined ? id as ClueSelectionServerAction : 'custom'
        const instruction = selectionPrompt(settings, id)
        const payload = {
          workspaceId, sessionId, resource: requestResourceOf(resource), action,
          target: 'side' as const, selection, instruction,
          actionLabel: custom?.name ?? clueSelectionActionLabel(action),
          prepareOnly: !settings.autoRun,
          ...(props.comment === true ? { comment: true } : {}),
        }
        const key = JSON.stringify(payload)
        if (lastRequest.current?.key !== key) lastRequest.current = { key, id: crypto.randomUUID() }
        await startClueSelectionAction({ ...payload, requestId: lastRequest.current!.id })
        props.onClose?.()
      }
    } catch (error) {
      if (!controller.current?.signal.aborted) {
        const raw = error instanceof Error ? error.message : String(error)
        const message = /another DSH instance/u.test(raw) ? t('clueSelectionWriterHeld') : clueErrorHint(categoryOf(error)) ?? raw
        setFailure({ message, action: id })
      }
    } finally {
      busyRef.current = false
      setBusy(null)
    }
  }
  const menuTop = Math.min(top, viewport.height - 56)
  const belowHeight = Math.max(0, viewport.height - menuTop - 16)
  const aboveHeight = Math.max(0, menuTop - 16)
  const placeBelow = aboveHeight < 320 && belowHeight > aboveHeight
  const availableHeight = Math.max(48, placeBelow ? belowHeight : aboveHeight)
  const width = Math.min(translation === null ? 220 : 320, Math.max(0, viewport.width - 16))
  const menuLeft = Math.min(Math.max(left, width / 2 + 8), viewport.width - width / 2 - 8)
  const flyoutWidth = Math.min(180, Math.max(0, viewport.width - 16))
  const rightSpace = viewport.width - (menuLeft + width / 2) - 8
  const leftSpace = menuLeft - width / 2 - 8
  const flyoutSide = rightSpace >= flyoutWidth + 4 || (leftSpace < flyoutWidth + 4 && rightSpace >= leftSpace) ? 'right' : 'left'
  // On narrow screens keep the side card, overlapping the parent if needed.
  const flyoutLeft = Math.max(8, Math.min(viewport.width - flyoutWidth - 8,
    flyoutSide === 'right' ? menuLeft + width / 2 + 4 : menuLeft - width / 2 - flyoutWidth - 4))
  const flyoutOverlaps = flyoutLeft < menuLeft + width / 2 && flyoutLeft + flyoutWidth > menuLeft - width / 2
  useLayoutEffect(() => {
    if (!submenu || flyoutRef.current === null || rewriteRef.current === null) return
    const row = rewriteRef.current.getBoundingClientRect()
    let maxHeight = viewport.height - 16
    let top = row.top
    if (flyoutOverlaps) {
      // Keep an overlapping card off the trigger row, so opening it cannot
      // turn the same pointer/touch into an accidental rewrite selection.
      const below = viewport.height - row.bottom - 12
      const above = row.top - 12
      const placeBelow = below >= above
      maxHeight = Math.max(0, placeBelow ? below : above)
      const height = Math.min(flyoutRef.current.scrollHeight + 2, maxHeight)
      top = placeBelow ? row.bottom + 4 : row.top - height - 4
    }
    const height = Math.min(flyoutRef.current.scrollHeight + 2, maxHeight)
    setFlyoutPosition({ top: Math.max(8, Math.min(top, viewport.height - height - 8)), maxHeight })
    if (enterFlyout.current) {
      enterFlyout.current = false
      flyoutRef.current.querySelector<HTMLButtonElement>('[data-clue-selection-action]:not(:disabled)')?.focus({ preventScroll: true })
    }
  }, [submenu, viewport.height, viewport.width, menuLeft, menuTop, placeBelow, flyoutOverlaps, settings])
  const rewriteIds = settings.rewriteOrder.filter(id => !settings.disabled[id])
  const actionButton = (id: string, label: string): ReactNode => <ActionButton key={id} role="menuitem" variant="ghost"
    className={css.item} busy={busy === id} disabled={busy !== null} data-clue-selection-action={id}
    onPointerEnter={() => { if (id === 'translate' || id.startsWith('insert')) { grace.cancel(); closeSubmenu() } }}
    onFocus={() => { if (id === 'translate' || id.startsWith('insert')) closeSubmenu() }}
    onClick={() => { void run(id) }}>{label}</ActionButton>
  const canRewrite = !props.comment && props.writable !== false && workspaceId !== undefined && resource !== undefined && rewriteIds.length > 0
  const mainActions = settings.menuOrder.filter(id => !settings.disabled[id] && (id !== 'rewrite' || canRewrite))
  if (!settings.enabled || (mainActions.length === 0 && settings.disabled.insertMain && settings.disabled.insertSide)) return null
  // Both fixed cards stay inside the popup ref: outside-click and editor focus
  // guards must regard the flyout as part of this same selection interaction.
  return <div ref={attachRef} className={css.surface} data-selection-submenu={submenu} onKeyDown={onKeyDown}
    onMouseDown={(event: MouseEvent<HTMLDivElement>) => {
      event.stopPropagation()
      if (event.target === menuRef.current || event.target === flyoutRef.current) event.preventDefault()
    }}>
    <div ref={menuRef} className={[css.menu, placeBelow ? css.menuBelow : '', translation !== null ? css.translationView : ''].join(' ')} role="menu"
      aria-label={clueSelectionLabel('menu')} data-clue-selection-menu
      style={{ left: menuLeft, top: menuTop, width, maxHeight: availableHeight }} onScroll={closeSubmenu}>
      {translation !== null ? <>
        <div className={css.translation} data-selection-translation tabIndex={0}>{translation}</div>
        <div className={css.insertGroup} data-selection-translation-footer>
          <ActionButton variant="ghost" className={css.item} role="menuitem" onClick={() => { setTranslation(null) }}>{t('selectionBack')}</ActionButton>
          <ActionButton variant="ghost" className={css.item} role="menuitem" onClick={() => {
            void navigator.clipboard.writeText(translation).catch(error => { setFailure({ message: String(error), action: 'translate' }) })
          }}>{t('copy')}</ActionButton>
        </div>
      </> : <>
        {mainActions.map(id => id === 'rewrite'
          ? <ActionButton ref={rewriteRef} key={id} role="menuitem" variant="ghost" className={css.item + ' ' + css.rewrite}
            disabled={busy !== null} data-clue-selection-action="rewrite" aria-haspopup="menu" aria-expanded={submenu} aria-controls={submenu ? flyoutId : undefined}
            onPointerEnter={event => { if (event.pointerType !== 'touch' && busy === null) openSubmenu(false) }}
            onPointerLeave={event => { if (event.pointerType !== 'touch') grace.arm() }}
            onKeyDown={event => { if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); openSubmenu(true) } }}
            onClick={() => { openSubmenu(true) }}>{t('clueSelectionRewrite')} <span className={css.chevron} aria-hidden="true">{flyoutSide === 'left' ? '‹' : '›'}</span></ActionButton>
          : actionButton(id, t('clueSelectionTranslate')))}
        <div className={css.insertGroup}>
          {!settings.disabled.insertMain && actionButton('insertMain', t('selectionInsertMain'))}
          {!settings.disabled.insertSide && actionButton('insertSide', t('selectionInsertSide'))}
        </div>
      </>}
      {busy === 'translate' && <LoadingIndicator label={t('clueSelectionTranslate')} centered />}
      {failure !== null && <div className={css.error} role="alert" data-clue-selection-error>{failure.message}
        <ActionButton variant="ghost" size="sm" role="menuitem" disabled={busy !== null} onClick={() => { void run(failure.action) }}>{t('retry')}</ActionButton>
      </div>}
    </div>
    {submenu && <div ref={flyoutRef} id={flyoutId} role="menu" className={css.flyout} aria-label={t('clueSelectionRewrite')}
      data-selection-submenu-panel data-selection-submenu-side={flyoutSide}
      style={{ left: flyoutLeft, top: flyoutPosition.top, width: flyoutWidth, maxHeight: flyoutPosition.maxHeight }} onPointerEnter={grace.cancel} onPointerLeave={event => { if (event.pointerType !== 'touch') grace.arm() }}>
      {flyoutOverlaps && <ActionButton variant="ghost" className={css.item} role="menuitem" onClick={closeSubmenu}>{t('selectionBack')}</ActionButton>}
      {rewriteIds.map(id => actionButton(id, settings.customActions.find(action => action.id === id)?.name ?? clueSelectionActionLabel(id as ClueSelectionAction)))}
    </div>}
  </div>
}

/** Props of the wrapper surface. */
interface ResourceSelectionActionsProps {
  readonly onInsert?: ClueSelectionInsertHandler
  readonly workspaceId: string
  readonly sessionId: string
  readonly resource: ClueClientResourceInput
  readonly children?: ReactNode
  readonly writable?: boolean
  /** Comments offer only translation and insertion, never source edits. */
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
    ...(props.writable === undefined ? {} : { writable: props.writable }),
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

  const settings = useSelectionMenuSettings()
  const capture = (point?: MouseEvent<HTMLDivElement>): boolean => {
    if (!settings.enabled) return false
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
            writable: props.writable,
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
