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
 *   "Which session that is" comes from the controller's `mounted` observation
 *   ({@link mountedSessions}) — never from the session list, which has no
 *   current-session field. The controller also carries `openTabIn` /
 *   `openResourceIn` / `closeIn`, which act on any session whose store the
 *   runtime has minted; both are probed at call time, and an open for a
 *   session that has no store yet is QUEUED and replayed when that session
 *   comes on screen;
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

/**
 * The observation "which session's seat is on screen": DSH 0.1.7 publishes it
 * as `ISidebarRight.mounted` (`ObservableSnapshot<SessionId | undefined>`, set
 * only when the mounted seat really changes). `undefined` means NO seat is
 * drawn — a global panel, or a right column that was never mounted.
 */
export interface MountedSessions {
  getSnapshot(): string | undefined
  subscribe(listener: () => void): () => void
}

/** The controller face this module uses (a structural slice of `ISidebarRight`). */
interface NativeController {
  openTab(kind: string, options?: { params?: unknown; revealIfOpened?: boolean }): void
  openResource(address: string, options?: { params?: unknown; revealIfOpened?: boolean }): void
  close(tabId: string): void
  /** The mounted-seat observation (0.1.7 `ISidebarRight.mounted`). */
  mounted?: MountedSessions
  /** Not part of `ISidebarRight`: the concrete controller's per-session writes. */
  openTabIn?(sessionId: string, kind: string, options?: { params?: unknown; revealIfOpened?: boolean }): void
  openResourceIn?(sessionId: string, address: string, options?: { params?: unknown; revealIfOpened?: boolean }): void
  closeIn?(sessionId: string, tabId: string): void
}

/** The plugin's write face over the native surface. */
export interface NativeSurface extends SidebarSurface {
  /** Replay opens that were queued for a session that had no mounted surface. */
  flushPending(): void
  /** Stop observing the session list and the mounted-seat feed. */
  dispose(): void
}

/** The native controller, probed at call time (the service can arrive late). */
function controllerOf(ctx: Context): NativeController | undefined {
  try {
    return ctx.get('sidebarRight') as unknown as NativeController | undefined
  } catch {
    return undefined
  }
}

/**
 * The on-screen-session feed, as anything outside this module should read it.
 *
 * The session-list snapshot carries NO current-session field in any DSH
 * release (0.1.6 and 0.1.7 both publish only `ids` / `byId` / `phase` plus
 * projections), so a read of one was always `undefined`: `mounted` is the
 * only sanctioned source, and the plugin's own type invented the field it
 * used to read.
 *
 * The probe tolerates a host without `mounted` (or a controller the runtime
 * has not provided yet — the seat race this plugin already hit once on
 * 0.1.5): the session list then doubles as the change pulse, so a late
 * service is still picked up on the next list publish instead of never.
 *
 * @param ctx - the client context.
 * @returns the observable face of the mounted seat's session id.
 */
export function mountedSessions(ctx: Context): MountedSessions {
  return {
    getSnapshot: () => {
      try {
        const mounted = controllerOf(ctx)?.mounted
        return typeof mounted?.getSnapshot === 'function' ? mounted.getSnapshot() : undefined
      } catch {
        return undefined
      }
    },
    subscribe: (listener) => {
      const mounted = controllerOf(ctx)?.mounted
      return typeof mounted?.subscribe === 'function'
        ? mounted.subscribe(listener)
        : ctx.sessions.list.subscribe(listener)
    },
  }
}

/**
 * The session whose seat is on screen, or `undefined` — no seat is mounted
 * (global panel, column not mounted) or the host has no mounted feed. Callers
 * treat `undefined` as "not this session": nothing the plugin draws belongs to
 * that surface, so it must neither write into it nor manage its column.
 *
 * @param ctx - the client context.
 * @returns the on-screen session id, when there is one.
 */
export function mountedSessionId(ctx: Context): string | undefined {
  return mountedSessions(ctx).getSnapshot()
}

/**
 * Bind the plugin's write face to the native controller.
 * @param ctx - the client context (session list + `ctx.sidebarRight`).
 * @param records - the plugin's native tab record registry.
 * @returns the surface, plus a disposer unbinding its two feed subscriptions.
 */
export function createNativeSurface(ctx: Context, records: NativeTabRecords): NativeSurface {
  const pending: Pending[] = []
  const controller = (): NativeController | undefined => controllerOf(ctx)

  const place = (entry: Pending): boolean => {
    const api = controller()
    if (api === undefined) return false
    const onScreen = mountedSessionId(ctx) === entry.sessionId
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

  // Two feeds flush the queue: the mounted seat (a session coming on screen)
  // and the session list, which also stays the pulse that picks the native
  // service up when it is provided after this surface was created.
  let mountedUnsubscribe: (() => void) | undefined
  const onListChange = (): void => {
    if (mountedUnsubscribe === undefined) {
      const mounted = controller()?.mounted
      if (typeof mounted?.subscribe === 'function') mountedUnsubscribe = mounted.subscribe(flushPending)
    }
    flushPending()
  }
  const unsubscribeList = ctx.sessions.list.subscribe(onListChange)
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
        if (sessionId === mountedSessionId(ctx)) api.close(tabId)
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
    dispose: () => {
      unsubscribeList()
      mountedUnsubscribe?.()
    },
  }
}
