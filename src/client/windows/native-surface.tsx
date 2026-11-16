/**
 * Native destination for retained windows. This type has no guide entry and no
 * second content tree: its body only lends a DOM destination to WindowHost.
 * All resource/session identity is explicit; background opens wait for their
 * original session rather than silently opening in the current conversation.
 */
import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import type { Context } from '../../context-types.ts'
import type { NativeTabInfo } from '../native/tab-adapter.tsx'
import type { WindowHostController } from './types.ts'
import { t } from '../locales.ts'
import design from '../ui/design.module.css'
import css from './windows.module.css'

export const WINDOW_SIDEBAR_KIND = 'better-sidebar-window'
const IMPLEMENTATION_ID = 'dsh-better-sidebar:retained-window'
const PREFIX = 'dsh-resource://better-sidebar-window/'

export function windowSidebarAddress(sessionId: string, id: string): string {
  return `${PREFIX}${encodeURIComponent(sessionId)}/${encodeURIComponent(id)}`
}

function identityOf(address: string): { sessionId: string; id: string } | undefined {
  if (!address.startsWith(PREFIX)) return undefined
  const parts = address.slice(PREFIX.length).split('/')
  if (parts.length !== 2) return undefined
  try {
    const sessionId = decodeURIComponent(parts[0]!)
    const id = decodeURIComponent(parts[1]!)
    return sessionId === '' || id === '' ? undefined : { sessionId, id }
  } catch { return undefined }
}

interface NativeWindowTab { readonly id: string; readonly contentId: string }
interface NativeWindowSidebar {
  readonly mounted: { getSnapshot(): string | undefined; subscribe(listener: () => void): () => void }
  openResource(address: string, options: { kind: string }): void
  closeIn(sessionId: string, tabId: string): void
  tabsIn(sessionId: string): readonly NativeWindowTab[]
  registerCloseHandler(kind: string, handler: (sessionId: string, tab: NativeWindowTab) => void): () => void
}
interface NativeWindowRegistry {
  register(definition: {
    id: string; kind: string; keepMounted: boolean; priority: 'extension'; patterns: string[]
    canOpen(address: string): boolean; title(address: string): string
  }): () => void
}

interface NativeWindowProps {
  readonly host: WindowHostController
  readonly sessionId: string
  readonly useTabInfo: () => NativeTabInfo
}

function NativeWindowBody({ host, sessionId, useTabInfo }: NativeWindowProps): ReactNode {
  const info = useTabInfo()
  const identity = identityOf(info.tab.contentId)
  const target = useRef<HTMLDivElement>(null)
  const id = identity?.sessionId === sessionId ? identity.id : undefined
  useLayoutEffect(() => {
    if (id === undefined || target.current === null) return
    const destination = target.current
    host.setSidebarTarget(id, sessionId, destination)
    return () => {
      const view = host.getSnapshot().windows.find(window => window.id === id && window.sessionId === sessionId)
      if (view?.sidebarTarget === destination) host.setSidebarTarget(id, sessionId, undefined)
    }
  }, [host, sessionId, id])
  return <div ref={target} className={`${design.surface} ${css.nativeDestination}`} data-window-sidebar-destination />
}

function NativeWindowTitle({ host, sessionId, useTabInfo }: NativeWindowProps): ReactNode {
  const info = useTabInfo()
  const identity = identityOf(info.tab.contentId)
  const snapshot = useSyncExternalStore(host.subscribe, host.getSnapshot, host.getSnapshot)
  const view = snapshot.windows.find(window => window.id === identity?.id && window.sessionId === sessionId)
  return <>{view?.title ?? info.tab.title}{view?.dirty === true ? ' •' : ''}</>
}

/** Install once in client/index beside registerNativeSurface, and dispose on teardown. */
export function registerWindowSidebarSurface(ctx: Context, host: WindowHostController): () => void {
  const seat = ctx.inject(['sidebarRightTabs', 'sidebarRight'], injected => {
    const tabs = injected.get('sidebarRightTabs') as unknown as NativeWindowRegistry
    const sidebar = injected.get('sidebarRight') as unknown as NativeWindowSidebar
    if (typeof sidebar.registerCloseHandler !== 'function') return
    const disposers: Array<() => void> = []
    let suppressClose = false
    let active = true
    // One pending identity per LIVE window. Host close/adapter close removes it;
    // teardown clears it. There is no historical or per-session cache.
    const pending = new Map<string, { sessionId: string; title: string }>()
    const open = (id: string, sessionId: string, title: string): void => {
      if (sidebar.mounted.getSnapshot() !== sessionId) {
        pending.set(id, { sessionId, title })
        return
      }
      sidebar.openResource(windowSidebarAddress(sessionId, id), { kind: WINDOW_SIDEBAR_KIND })
      pending.delete(id)
    }
    const close = (id: string, sessionId: string): void => {
      pending.delete(id)
      const address = windowSidebarAddress(sessionId, id)
      suppressClose = true
      try {
        for (const tab of sidebar.tabsIn(sessionId)) {
          if (tab.contentId === address) sidebar.closeIn(sessionId, tab.id)
        }
      } finally { suppressClose = false }
    }
    try {
      disposers.push(tabs.register({
        id: IMPLEMENTATION_ID, kind: WINDOW_SIDEBAR_KIND,
        keepMounted: true, priority: 'extension', patterns: [`${PREFIX}**`],
        canOpen: address => identityOf(address) !== undefined,
        title: address => {
          const identity = identityOf(address)
          return host.getSnapshot().windows.find(window => window.id === identity?.id)?.title ?? t('windowFloatingHint')
        },
      }))
      disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab', key: IMPLEMENTATION_ID,
        inject: (sessionId: string) => ({ host, sessionId }),
      }, NativeWindowBody)))
      disposers.push(ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title', key: IMPLEMENTATION_ID,
        inject: (sessionId: string) => ({ host, sessionId }),
      }, NativeWindowTitle)))
      disposers.push(sidebar.registerCloseHandler(WINDOW_SIDEBAR_KIND, (sessionId, tab) => {
        if (suppressClose || !active) return
        const identity = identityOf(tab.contentId)
        if (identity?.sessionId !== sessionId) return
        // DSH's cleanup hook is synchronous, not an async leave guard. Keep
        // React content alive while it removes the native occurrence, and on
        // refusal restore a destination for the SAME retained window. Never
        // throw from a user close (no pageerror), and never discard a draft.
        void host.closeFromSidebar(identity.id, sessionId)
      }))
      disposers.push(sidebar.mounted.subscribe(() => {
        for (const [id, request] of pending) open(id, request.sessionId, request.title)
      }))
      disposers.push(host.attachSidebar({ open, close, focus: (id, sessionId) => {
        const title = host.getSnapshot().windows.find(window => window.id === id)?.title ?? ''
        open(id, sessionId, title)
      } }))
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose()
      throw error
    }
    return () => {
      active = false
      pending.clear()
      for (const dispose of disposers.reverse()) dispose()
    }
  })
  return () => { void seat.dispose() }
}
