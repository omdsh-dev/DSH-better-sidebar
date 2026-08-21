/**
 * The tab strip of one pane: tabs capped at TAB_MAX_WIDTH (ellipsized),
 * overflow scrolls horizontally, a close button per tab, a four-way split
 * button cluster, and the + menu that opens new tabs (explorer / git /
 * terminal). Tabs are draggable; dropping onto another tab inserts before it,
 * dropping on the strip background appends to this pane.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconCloseFill14, IconPlusOutline16, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarTab } from './state.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

/** One + menu option. */
export interface NewTabOption {
  id: string
  label: string
  disabled?: boolean
  /** Leading icon (Menu row). */
  icon?: ReactNode
}

/** Drag payload for tab moves (HTML5 DnD dataTransfer). */
export const TAB_DRAG_TYPE = 'application/x-dsh-tab'

export interface TabDragPayload {
  tabId: string
  paneId: string
}

export function serializeDrag(payload: TabDragPayload): string {
  return JSON.stringify(payload)
}

export function parseDrag(raw: string): TabDragPayload | null {
  try {
    const parsed = JSON.parse(raw) as TabDragPayload
    if (typeof parsed.tabId === 'string' && typeof parsed.paneId === 'string') return parsed
    return null
  } catch {
    return null
  }
}

/** Global tab-drag flag: PDF iframes become non-interactive synchronously. */
function setTabDragging(active: boolean): void {
  if (active) document.body.setAttribute('data-dsh-tab-dragging', '')
  else document.body.removeAttribute('data-dsh-tab-dragging')
}

export function TabBar(props: {
  paneId: string
  tabs: SidebarTab[]
  active: string | null
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onNewTab: (optionId: string) => void
  newTabOptions: NewTabOption[]
  /** Drop of a tab from any pane: (payload, insertBeforeTabId | null). */
  onDropTab: (payload: TabDragPayload, before: string | null) => void
  /** Icon resolver for tab labels (reads from the tab descriptor registry). */
  getTabIcon?: (tab: SidebarTab) => ReactNode
  /** Badge resolver for tab labels (reads the descriptor's `badge`; the
   *  resolver returns the rendered pill or null). */
  getTabBadge?: (tab: SidebarTab) => ReactNode
  /** Whether a tab may be renamed by double-clicking its label (only
   *  renamable tabs get the inline editor; others keep the plain label). */
  canRenameTab?: (tab: SidebarTab) => boolean
  /** Commit a tab's renamed label (the store persists it with the layout). */
  onRename?: (tabId: string, title: string) => void
}) {
  const {
    paneId, tabs, active, onActivate, onClose, onNewTab, newTabOptions, onDropTab, getTabIcon, getTabBadge,
    canRenameTab, onRename,
  } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  // Inline rename: the tab id being edited + the draft text. A ref mirrors
  // the state so Enter (commit → unmount → blur) and IME composition never
  // double-commit.
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const renamingRef = useRef<string | null>(null)
  useEffect(() => { renamingRef.current = renaming }, [renaming])

  /** Enter rename mode for one tab (double-click on its label). */
  const startRename = (tab: SidebarTab): void => {
    setDraft(tab.title)
    setRenaming(tab.id)
  }

  /**
   * Focus + select the whole draft when the rename editor mounts. MUST be a
   * stable callback: an inline arrow would be re-invoked on every keystroke
   * re-render (React re-runs ref callbacks whose identity changed), re-selecting
   * the value and making each new character replace the previous one.
   */
  const focusDraft = useCallback((el: HTMLInputElement | null): void => {
    if (el !== null) {
      el.focus()
      el.select()
    }
  }, [])

  /** Leave rename mode; `cancel` restores the old label, otherwise the
   *  trimmed draft is committed when non-empty and changed. */
  const commitRename = (tab: SidebarTab, cancel: boolean): void => {
    if (renamingRef.current !== tab.id) return
    setRenaming(null)
    if (cancel) return
    const next = draft.trim()
    if (next.length === 0 || next === tab.title) return
    onRename?.(tab.id, next)
  }

  // Middle-click close: the press target is recorded on middle mousedown
  // (preventDefaulted to disarm Chrome's middle-click autoscroll — its
  // indicator is inert here because the strip hides its scrollbar and only
  // the wheel handler scrolls) and the close settles on the first middle
  // mouseup OVER that same tab. Release-position semantics match VS Code
  // (microsoft/vscode#101028) and what users expect from Chrome tabs
  // (crbug/40679924): pressing on a tab and releasing elsewhere cancels the
  // close. The browser dispatches auxclick to the nearest common ancestor of
  // the press/release targets when they differ, so any drift, autoscroll
  // scroll, or tab-list reflow between press and release would otherwise
  // swallow the close; settling on the recorded press target at mouseup
  // keeps release semantics without depending on auxclick delivery.
  const onCloseRef = useRef(onClose)
  const middlePressed = useRef<{ id: string; node: HTMLElement } | null>(null)
  useEffect(() => {
    onCloseRef.current = onClose
  })
  useEffect(() => {
    const onMouseUp = (event: MouseEvent): void => {
      if (event.button !== 1) return
      const pressed = middlePressed.current
      middlePressed.current = null
      // Close only when the release lands on the pressed tab; a drag-away
      // release cancels the press (one-shot per press).
      if (pressed !== null && pressed.node.isConnected && pressed.node.contains(event.target as Node)) {
        onCloseRef.current(pressed.id)
      }
    }
    window.addEventListener('mouseup', onMouseUp)
    return () => { window.removeEventListener('mouseup', onMouseUp) }
  }, [])

  // Wheel over the strip scrolls the tab row horizontally (a plain mouse
  // wheel emits deltaY, which overflow-x alone never consumes). Bound as a
  // native NON-passive listener: React registers onWheel passively at the
  // root, where preventDefault() is a no-op. Modifier keys keep their native
  // meaning (shift = horizontal scroll, ctrl/cmd = zoom), and a strip that
  // does not overflow leaves the event alone so the page scrolls normally.
  useEffect(() => {
    const el = listRef.current
    if (el === null) return
    const onWheel = (event: WheelEvent): void => {
      if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
      if (el.scrollWidth <= el.clientWidth) return
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientWidth : 1
      el.scrollLeft += (event.deltaX + event.deltaY) * unit
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => { el.removeEventListener('wheel', onWheel) }
  }, [])

  useEffect(() => {
    const clear = (): void => { setTabDragging(false); setDragOver(false) }
    window.addEventListener('dragend', clear, true)
    window.addEventListener('drop', clear, true)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('dragend', clear, true)
      window.removeEventListener('drop', clear, true)
      window.removeEventListener('blur', clear)
    }
  }, [])

  return (
    <div
      className={clsx(css.tabBar, dragOver && css.tabBarDrop)}
      onDragOver={(event) => {
        // The strip owns drops on itself (merge into this pane); stopping
        // propagation keeps the pane root from also running its edge-zone
        // handler on the same drop.
        event.preventDefault()
        event.stopPropagation()
        setDragOver(true)
      }}
      onDragLeave={() => { setDragOver(false) }}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setDragOver(false)
        setTabDragging(false)
        const raw = event.dataTransfer.getData(TAB_DRAG_TYPE)
        const payload = parseDrag(raw)
        if (payload !== null) onDropTab(payload, null)
      }}
    >
      <div ref={listRef} className={css.tabList}>
        {tabs.map(tab => (
          <div
            key={tab.id}
            className={clsx(css.tab, active === tab.id && css.tabActive)}
            title={renaming === tab.id ? undefined : tab.title}
            draggable={renaming !== tab.id}
            onDragStart={(event) => {
              setTabDragging(true)
              event.dataTransfer.setData(TAB_DRAG_TYPE, serializeDrag({ tabId: tab.id, paneId }))
              event.dataTransfer.effectAllowed = 'move'
            }}
            onDragEnd={() => { setTabDragging(false); setDragOver(false) }}
            onDragOver={(event) => { event.preventDefault(); event.stopPropagation() }}
            onDrop={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setTabDragging(false)
              const raw = event.dataTransfer.getData(TAB_DRAG_TYPE)
              const payload = parseDrag(raw)
              if (payload !== null) onDropTab(payload, tab.id)
            }}
            onClick={() => { onActivate(tab.id) }}
            onMouseDown={(event) => {
              // Middle-click close: record the press target and disarm
              // Chrome's middle-click autoscroll (its indicator is inert
              // here — the strip scrolls via the wheel handler only). The
              // close itself settles on the first middle mouseup over this
              // same tab (window-level), keeping release semantics.
              if (event.button === 1) {
                event.preventDefault()
                middlePressed.current = { id: tab.id, node: event.currentTarget }
              }
            }}
          >
            {getTabIcon?.(tab) ?? null}
            {getTabBadge?.(tab) ?? null}
            {renaming === tab.id ? (
              <input
                ref={focusDraft}
                className={css.tabRename}
                value={draft}
                onChange={(event) => { setDraft(event.target.value) }}
                onKeyDown={(event) => {
                  // IME composition: let Enter confirm the candidate text
                  // instead of committing the draft mid-composition.
                  if (event.nativeEvent.isComposing) return
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitRename(tab, false)
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    commitRename(tab, true)
                  }
                }}
                onBlur={() => { commitRename(tab, false) }}
                onClick={(event) => { event.stopPropagation() }}
                onDoubleClick={(event) => { event.stopPropagation() }}
                onPointerDown={(event) => { event.stopPropagation() }}
                aria-label={t('renameTab')}
              />
            ) : (
              <span
                className={css.tabTitle}
                title={canRenameTab?.(tab) === true ? `${tab.title} · ${t('renameTabHint')}` : undefined}
                onDoubleClick={(event) => {
                  if (canRenameTab?.(tab) !== true) return
                  event.stopPropagation()
                  startRename(tab)
                }}
              >
                {tab.title}
              </span>
            )}
            <button
              type="button"
              className={css.tabClose}
              aria-label={t('close')}
              onClick={(event) => {
                event.stopPropagation()
                onClose(tab.id)
              }}
            >
              <IconCloseFill14 />
            </button>
          </div>
        ))}
        {/*
          The + sits immediately after the rightmost tab (sticky at the
          right edge of the scrollport when the tabs overflow, so it stays
          reachable no matter how many tabs are open).
        */}
        <Menu
          open={menuOpen}
          onClose={() => { setMenuOpen(false) }}
          items={newTabOptions.map(option => ({
            id: option.id,
            label: option.label,
            ...(option.disabled === true ? { disabled: true } : {}),
            ...(option.icon !== undefined ? { icon: option.icon } : {}),
          }))}
          onSelect={(id) => {
            onNewTab(id)
            setMenuOpen(false)
          }}
          portal
          align="end"
          anchor={(
            <button
              type="button"
              className={css.tabBarPlus}
              aria-label={t('newTab')}
              title={t('newTab')}
              onClick={() => { setMenuOpen(v => !v) }}
            >
              <IconPlusOutline16 />
            </button>
          )}
        />
      </div>
    </div>
  )
}
