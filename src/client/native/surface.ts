/**
 * The plugin's write face over DSH's native right Sidebar (`ctx.sidebarRight`).
 *
 * The service speaks in the plugin's own vocabulary (tab type, seed, session
 * scope); this module turns those into the native surface's vocabulary
 * (kind + navigation params, or a `dsh-resource://` address) and forwards
 * tab-record operations to the plugin's native record registry.
 *
 * Two native limits shape the implementation:
 *
 * - the surface exists only while a session's panel is mounted, and the
 *   service's public face (`ISidebarRight`) writes only into THAT session.
 *   The controller also carries `openTabIn` / `openResourceIn` /
 *   `closeIn`, which act on any session whose store the runtime has minted;
 *   both are probed at call time, and an open for a session that has no
 *   store yet is QUEUED and replayed when that session comes on screen;
 * - layout state is memory-only, so a queued open is not durable either.
 */
import type { Context } from '../../context-types.ts'
import { fileAddressFor } from '../resource-address.ts'
import type { NativeTabParams, SidebarSurface } from '../service.ts'
import type { NativeTabRecords } from './tab-adapter.tsx'

/** One open the surface could not place yet. */
type Pending =
  | { kind: 'tab'; sessionId: string; tabKind: string; params: NativeTabParams; revealIfOpened: boolean }
  | { kind: 'resource'; sessionId: string; address: string; line: number | undefined; revealIfOpened: boolean }

/** The controller face this module uses (a structural slice of `ISidebarRight`). */
interface NativeController {
  openTab(kind: string, options?: { params?: unknown; revealIfOpened?: boolean }): void
  openResource(address: string, options?: { params?: unknown; revealIfOpened?: boolean }): void
  close(tabId: string): void
  /** Not part of `ISidebarRight`: the concrete controller's per-session writes. */
  openTabIn?(sessionId: string, kind: string, options?: { params?: unknown; revealIfOpened?: boolean }): void
  openResourceIn?(sessionId: string, address: string, options?: { params?: unknown; revealIfOpened?: boolean }): void
  closeIn?(sessionId: string, tabId: string): void
}

/** The plugin's write face over the native surface. */
export interface NativeSurface extends SidebarSurface {
  /** Replay opens that were queued for a session that had no mounted surface. */
  flushPending(): void
  /** Stop observing the session list. */
  dispose(): void
}

/** The active session id, as the client list reports it. */
function activeSessionId(ctx: Context): string | undefined {
  try {
    return ctx.sessions.list.getSnapshot().current
  } catch {
    return undefined
  }
}

/**
 * Bind the plugin's write face to the native controller.
 * @param ctx - the client context (session list + `ctx.sidebarRight`).
 * @param records - the plugin's native tab record registry.
 * @returns the surface, plus a disposer unbinding its session subscription.
 */
export function createNativeSurface(ctx: Context, records: NativeTabRecords): NativeSurface {
  const pending: Pending[] = []
  const controller = (): NativeController | undefined =>
    ctx.get('sidebarRight') as unknown as NativeController | undefined

  const place = (entry: Pending): boolean => {
    const api = controller()
    if (api === undefined) return false
    const active = activeSessionId(ctx)
    const onScreen = active !== undefined && active === entry.sessionId
    if (entry.kind === 'tab') {
      const options = { params: entry.params, revealIfOpened: entry.revealIfOpened }
      if (onScreen) {
        api.openTab(entry.tabKind, options)
        return true
      }
      if (api.openTabIn !== undefined) {
        api.openTabIn(entry.sessionId, entry.tabKind, options)
        return true
      }
      return false
    }
    const options = {
      ...(entry.line === undefined ? {} : { params: { line: entry.line } }),
      revealIfOpened: entry.revealIfOpened,
    }
    if (onScreen) {
      api.openResource(entry.address, options)
      return true
    }
    if (api.openResourceIn !== undefined) {
      api.openResourceIn(entry.sessionId, entry.address, options)
      return true
    }
    return false
  }

  const flushPending = (): void => {
    if (pending.length === 0) return
    for (let index = pending.length - 1; index >= 0; index--) {
      const entry = pending[index]
      if (entry !== undefined && place(entry)) pending.splice(index, 1)
    }
  }

  const enqueue = (entry: Pending): void => {
    if (!place(entry)) pending.push(entry)
  }

  const unsubscribe = ctx.sessions.list.subscribe(flushPending)
  return {
    openTab({ sessionId, kind, params, revealIfOpened }) {
      enqueue({ kind: 'tab', sessionId, tabKind: kind, params, revealIfOpened })
    },
    openResource({ sessionId, address, line, revealIfOpened }) {
      enqueue({ kind: 'resource', sessionId, address, line, revealIfOpened })
    },
    fileAddress(sessionId, cwd, path) {
      return fileAddressFor(sessionId, cwd, path)
    },
    close(sessionId, tabId) {
      const record = records.get(tabId)
      if (record === undefined) return undefined
      records.drop(tabId)
      const api = controller()
      if (api !== undefined) {
        if (sessionId === activeSessionId(ctx)) api.close(tabId)
        else if (api.closeIn !== undefined) api.closeIn(sessionId, tabId)
      }
      return { type: record.tab.type, title: record.tab.title }
    },
    update(tabId, patch) {
      if (!records.has(tabId)) return false
      records.update(tabId, patch)
      return true
    },
    activate(tabId) {
      // The native surface has no cross-pane activation face the plugin needs:
      // a tab is focused by opening its (kind, address) again, which the
      // native open already de-duplicates.
      return records.has(tabId)
    },
    has: tabId => records.has(tabId),
    flushPending,
    dispose: () => { unsubscribe() },
  }
}
