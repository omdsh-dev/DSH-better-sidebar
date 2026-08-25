import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Context } from '../context-types.ts'
import { Sidebar } from './Sidebar.tsx'
import { createSidebarStore, type SidebarStore } from './state.ts'
import type {
  BetterSidebarPaneAttachment,
  BetterSidebarPaneCapability,
  BetterSidebarPaneTarget,
  BetterSidebarService,
  OpenTabSeed,
  SessionScope,
} from './service.ts'

interface PaneMount {
  target: BetterSidebarPaneTarget
  readonly root: Root
  readonly host: HTMLElement
  readonly detachStore: () => void
  readonly disposePrefs: () => void
  readonly rightReservation: HTMLElement
  readonly bottomReservation: HTMLElement
}

/** Create the versioned multi-Pane mounting capability for one client activation. */
export function createPaneCapability(
  ctx: Context,
  primaryStore: SidebarStore,
  service: BetterSidebarService,
  onActiveChange: () => void,
): BetterSidebarPaneCapability & { dispose(): void } {
  const mounts = new Map<string, PaneMount>()

  const syncFocusedSession = (): void => {
    const focused = [...mounts.values()].find(mount => mount.target.focused)?.target.sessionId
    primaryStore.setSession(focused ?? ctx.sessions.list.getSnapshot().current)
  }

  const disposeMount = (sessionId: string, mount: PaneMount): void => {
    if (mounts.get(sessionId) !== mount) return
    mounts.delete(sessionId)
    syncFocusedSession()
    mount.disposePrefs()
    mount.detachStore()
    mount.root.unmount()
    mount.host.remove()
    mount.rightReservation.remove()
    mount.bottomReservation.remove()
    onActiveChange()
  }

  const capability: BetterSidebarPaneCapability & { dispose(): void } = {
    protocol: 1,
    get activeCount() { return mounts.size },
    mountPane(target): BetterSidebarPaneAttachment {
      if (mounts.has(target.sessionId)) {
        throw new Error(`[dsh-better-sidebar] Pane "${target.sessionId}" is already mounted`)
      }
      const store = createSidebarStore()
      store.setPrefs(primaryStore.getPrefs())
      store.setSession(target.sessionId)
      const detachStore = service.attachPaneStore(target.sessionId, store)
      let prefsFingerprint = JSON.stringify(primaryStore.getPrefs())
      const disposePrefs = primaryStore.subscribe(() => {
        const prefs = primaryStore.getPrefs()
        const fingerprint = JSON.stringify(prefs)
        if (fingerprint === prefsFingerprint) return
        prefsFingerprint = fingerprint
        store.setPrefs(prefs)
      })
      const host = document.createElement('div')
      host.setAttribute('data-dsh-better-sidebar', '')
      host.setAttribute('data-dsh-better-sidebar-pane', target.sessionId)
      if (target.focused) host.setAttribute('data-focused', '')
      target.pane.appendChild(host)
      const rightReservation = document.createElement('span')
      rightReservation.hidden = true
      rightReservation.setAttribute('data-dsh-pane-panel-reservation', 'right')
      target.rightHost.appendChild(rightReservation)
      const bottomReservation = document.createElement('span')
      bottomReservation.hidden = true
      bottomReservation.setAttribute('data-dsh-pane-panel-reservation', 'bottom')
      target.bottomHost.appendChild(bottomReservation)
      const root = createRoot(host)
      const paneCtx = scopedContext(ctx, service, store, target.sessionId)
      root.render(createElement(Sidebar, { ctx: paneCtx, store, paneTarget: target }))
      const mount: PaneMount = {
        target,
        root,
        host,
        detachStore,
        disposePrefs,
        rightReservation,
        bottomReservation,
      }
      mounts.set(target.sessionId, mount)
      syncFocusedSession()
      onActiveChange()
      return {
        update(next): void {
          if (next.sessionId !== mount.target.sessionId) {
            throw new Error('[dsh-better-sidebar] Pane attachment cannot change Session identity')
          }
          mount.target = next
          if (next.focused) host.setAttribute('data-focused', '')
          else host.removeAttribute('data-focused')
          syncFocusedSession()
        },
        dispose(): void { disposeMount(target.sessionId, mount) },
      }
    },
    dispose(): void {
      for (const [sessionId, mount] of [...mounts]) disposeMount(sessionId, mount)
    },
  }
  return capability
}

/** Scope current-session reads and unscoped service calls to one Pane store. */
function scopedContext(
  ctx: Context,
  service: BetterSidebarService,
  store: SidebarStore,
  sessionId: string,
): Context {
  const scope: SessionScope = { sessionId }
  const paneService = new Proxy(service, {
    get(target, property) {
      if (property === 'openTab') return (seed: OpenTabSeed, requested?: SessionScope) => target.openTab(seed, requested ?? scope)
      if (property === 'closeTab') return (tabId: string, requested?: SessionScope) => target.closeTab(tabId, requested ?? scope)
      if (property === 'activateTab') return (tabId: string, requested?: SessionScope) => target.activateTab(tabId, requested ?? scope)
      if (property === 'updateTab') {
        return (tabId: string, patch: { title?: string; path?: string; meta?: unknown }, requested?: SessionScope) =>
          target.updateTab(tabId, patch, requested ?? scope)
      }
      if (property === 'getSnapshot') return () => store.getSnapshot()
      if (property === 'subscribeState') return (listener: () => void) => store.subscribe(listener)
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  let sourceListSnapshot = ctx.sessions.list.getSnapshot()
  let scopedListSnapshot = { ...sourceListSnapshot, current: sessionId }
  const getListSnapshot = (): typeof sourceListSnapshot => {
    const next = ctx.sessions.list.getSnapshot()
    if (next !== sourceListSnapshot) {
      sourceListSnapshot = next
      scopedListSnapshot = { ...next, current: sessionId }
    }
    return scopedListSnapshot
  }
  const list = new Proxy(ctx.sessions.list, {
    get(target, property) {
      if (property === 'getSnapshot') return getListSnapshot
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const sessions = new Proxy(ctx.sessions, {
    get(target, property) {
      if (property === 'list') return list
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'sessions') return sessions
      if (property === 'get') {
        return (name: string) => name === 'betterSidebar' ? paneService : target.get(name as never)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
