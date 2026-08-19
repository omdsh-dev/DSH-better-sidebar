/**
 * The tab strip of one pane: tabs capped at TAB_MAX_WIDTH (ellipsized),
 * overflow scrolls horizontally, a close button per tab, a four-way split
 * button cluster, and the + menu that opens new tabs (explorer / git /
 * terminal). Tabs are draggable; dropping onto another tab inserts before it,
 * dropping on the strip background appends to this pane.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconCloseFill14, IconCloseOutline16, IconCopyOutline16, IconPlusOutline16, IconRightUpOutline16,
  Menu, writeClipboard, type MenuEntry,
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

/** A tab's local file paths (the tab context menu's path entries). */
export interface TabPathPayload {
  /** The absolute filesystem path. */
  absolute: string
  /** The path relative to the session cwd (falls back to absolute). */
  relative: string
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
  /** Context-menu "close tabs to the right" (absent → no entry). */
  onCloseRight?: (tabId: string) => void
  /** Context-menu "close tabs to the left" (absent → no entry). */
  onCloseLeft?: (tabId: string) => void
  /** Context-menu "close other tabs" (absent → no entry). */
  onCloseOthers?: (tabId: string) => void
  /** Per-tab path payload for the context menu's path entries (absent → no path entries). */
  getTabPath?: (tab: SidebarTab) => TabPathPayload | null
  /** Context-menu "open with the default app" (absent → no entry). */
  onOpenFileSystem?: (path: string) => void
}) {
  const {
    paneId, tabs, active, onActivate, onClose, onNewTab, newTabOptions, onDropTab, getTabIcon, getTabBadge,
    onCloseRight, onCloseLeft, onCloseOthers, getTabPath, onOpenFileSystem,
  } = props
  const [menuOpen, setMenuOpen] = useState(false)
  /** Open tab context menu: the right-clicked tab plus the cursor position. */
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

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

  /** The right-clicked tab (plus its strip index and path payload) driving
   *  the context menu below. */
  const menuTab = tabMenu === null ? null : tabs.find(tab => tab.id === tabMenu.tabId) ?? null
  const menuIndex = menuTab === null ? -1 : tabs.findIndex(tab => tab.id === menuTab.id)
  const menuPath = menuTab === null ? null : (getTabPath?.(menuTab) ?? null)

  /** The tab context menu entries: close group always; path group only for
   *  tabs carrying a local file path. Range entries disable at the edges. */
  const contextItems: MenuEntry[] = [
    { id: 'close-this', label: t('closeThisTab'), icon: <IconCloseOutline16 size={14} /> },
    ...(onCloseRight !== undefined
      ? [{ id: 'close-right', label: t('closeRightTabs'), disabled: menuIndex < 0 || menuIndex >= tabs.length - 1 }]
      : []),
    ...(onCloseLeft !== undefined
      ? [{ id: 'close-left', label: t('closeLeftTabs'), disabled: menuIndex <= 0 }]
      : []),
    ...(onCloseOthers !== undefined
      ? [{ id: 'close-others', label: t('closeOtherTabs'), disabled: tabs.length <= 1 }]
      : []),
    ...(menuPath !== null
      ? [
          { type: 'separator', id: 'tab-menu-path-sep' } as const,
          { id: 'copy-absolute', label: t('copyAbsolute'), icon: <IconCopyOutline16 size={14} /> },
          { id: 'copy-relative', label: t('copyRelative'), icon: <IconCopyOutline16 size={14} /> },
          ...(onOpenFileSystem !== undefined
            ? [{ id: 'open-system', label: t('openWithDefault'), icon: <IconRightUpOutline16 size={14} /> }]
            : []),
        ]
      : []),
  ]

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
            title={tab.title}
            draggable
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
            onContextMenu={(event) => {
              // Right-click opens the tab's context menu at the cursor.
              event.preventDefault()
              event.stopPropagation()
              setTabMenu({ tabId: tab.id, x: event.clientX, y: event.clientY })
            }}
          >
            {getTabIcon?.(tab) ?? null}
            {getTabBadge?.(tab) ?? null}
            <span className={css.tabTitle}>{tab.title}</span>
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
      {/*
        The shared tab context menu, positioned at the right-click cursor
        (portal so the strip's overflow clip cannot crop it).
      */}
      <Menu
        open={tabMenu !== null}
        onClose={() => { setTabMenu(null) }}
        items={contextItems}
        onSelect={(id) => {
          const target = menuTab
          if (target === null) return
          setTabMenu(null)
          if (id === 'close-this') {
            onClose(target.id)
            return
          }
          if (id === 'close-right') {
            onCloseRight?.(target.id)
            return
          }
          if (id === 'close-left') {
            onCloseLeft?.(target.id)
            return
          }
          if (id === 'close-others') {
            onCloseOthers?.(target.id)
            return
          }
          if (menuPath !== null && id === 'copy-absolute') {
            void writeClipboard(menuPath.absolute)
            return
          }
          if (menuPath !== null && id === 'copy-relative') {
            void writeClipboard(menuPath.relative)
            return
          }
          if (id === 'open-system' && menuPath !== null) {
            onOpenFileSystem?.(menuPath.absolute)
          }
        }}
        portal
        align="start"
        getAnchorRect={() => (tabMenu === null ? null : new DOMRect(tabMenu.x, tabMenu.y, 0, 0))}
        anchor={<span />}
      />
    </div>
  )
}
