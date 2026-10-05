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
 *   `openResourceIn` / `closeIn`, but the two open faces are silent no-ops for
 *   a session whose store the runtime never minted or adopted — they report
 *   nothing back — so an open aimed at a session that is not on screen is NOT
 *   handed to them: it stays QUEUED and is replayed once that session comes
 *   on screen;
 * - layout state is memory-only, so a queued open is not durable either.
 */
import type { Context } from '../../context-types.ts'
import { fileAddressFor } from '../resource-address.ts'
import type { NativeTabParams, SidebarSurface } from '../service.ts'
import type { NativeTabRecords } from './tab-adapter.tsx'

/** One open the surface could not place yet. */
type Pending =
  | { kind: 'tab'; sessionId: string; tabKind: string; params: NativeTabParams; revealIfOpened: boolean; preferNewPane: boolean }
  | { kind: 'resource'; sessionId: string; address: string; line: number | undefined; revealIfOpened: boolean; preferNewPane: boolean }

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
  openTab(kind: string, options?: { params?: unknown; revealIfOpened?: boolean; preferNewPane?: boolean }): void
  openResource(address: string, options?: { params?: unknown; revealIfOpened?: boolean; preferNewPane?: boolean }): void
  close(tabId: string): void
  /** The mounted-seat observation (0.1.7 `ISidebarRight.mounted`). */
  mounted?: MountedSessions
  /** `ISidebarRight.focus` — focuses the tab and the pane holding it (dsh >= 0.1.5). */
  focus?(tabId: string): void
  /**
   * Not part of `ISidebarRight`: the concrete controller's per-session writes.
   * The two open faces are kept as the seam a boolean-reporting host API would
   * plug into, but `place()` deliberately does not use them: they cannot tell
   * "written" from "no store adopted yet" (see the module header).
   */
  openTabIn?(sessionId: string, kind: string, options?: { params?: unknown; revealIfOpened?: boolean; preferNewPane?: boolean }): void
  openResourceIn?(sessionId: string, address: string, options?: { params?: unknown; revealIfOpened?: boolean; preferNewPane?: boolean }): void
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
      const options = {
        params: entry.params,
        revealIfOpened: entry.revealIfOpened,
        ...(entry.preferNewPane ? { preferNewPane: true } : {}),
      }
      if (onScreen) {
        api.openTab(entry.tabKind, options)
        return true
      }
      // Do not hand a non-current session's open to openTabIn(): for a session
      // whose rightbar store the runtime never adopted (it was not opened since
      // this page load) that call is a silent no-op that reports nothing back, so
      // trusting it drops the open instead of queueing it as this module
      // documents. Leave the entry queued — flushPending() replays it once that
      // session comes on screen.
      return false
    }
    const options = {
      ...(entry.line === undefined ? {} : { params: { line: entry.line } }),
      revealIfOpened: entry.revealIfOpened,
      ...(entry.preferNewPane ? { preferNewPane: true } : {}),
    }
    if (onScreen) {
      api.openResource(entry.address, options)
      return true
    }
    // Same as the tab branch: a session with no adopted rightbar store makes
    // openResourceIn() a silent no-op, so queue instead.
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

  /**
   * The seat session a bare tab id belongs to.
   *
   * The public write face speaks ids without sessions (its consumer contract),
   * while records are per seat session — the same native id names a tab in
   * EVERY session. The mounted seat answers for a caller acting on what is on
   * screen; with no seat mounted (a global panel) a unique match across the
   * live sessions still resolves, and an id that names a tab in more than one
   * session resolves to none — guessing would write into another conversation.
   * @param tabId - the native tab id.
   * @param sessionId - the explicit session, when the caller has one.
   * @returns the owning session, or undefined.
   */
  const sessionOf = (tabId: string, sessionId?: string): string | undefined => {
    if (sessionId !== undefined) return records.has(sessionId, tabId) ? sessionId : undefined
    const mounted = mountedSessionId(ctx)
    if (mounted !== undefined && records.has(mounted, tabId)) return mounted
    const byId = ctx.sessions.list.getSnapshot().byId ?? {}
    let found: string | undefined
    for (const candidate of Object.keys(byId)) {
      if (!records.has(candidate, tabId)) continue
      if (found !== undefined && found !== candidate) return undefined
      found = candidate
    }
    return found
  }

  /**
   * Forget the records of sessions that no longer exist.
   *
   * A `keepMounted` body survives until its tab or its session ends, and a
   * session the user DELETED never unmounts anything the plugin can hook, so
   * its records (and their tree/edit state) would live for the life of the
   * page. The mounted session is always kept: it can be missing from `byId`
   * for a moment while the list reloads.
   */
  const evictGoneSessions = (): void => {
    try {
      const live = new Set(Object.keys(ctx.sessions.list.getSnapshot().byId ?? {}))
      const mounted = mountedSessionId(ctx)
      if (mounted !== undefined) live.add(mounted)
      records.retain(live)
    } catch {
      // A read failure is not evidence that sessions are gone; keep everything.
    }
  }

  // Two feeds flush the queue: the mounted seat (a session coming on screen)
  // and the session list, which also stays the pulse that picks the native
  // service up when it is provided after this surface was created. The list
  // pulse additionally reclaims the records of sessions that are gone.
  let mountedUnsubscribe: (() => void) | undefined
  const onListChange = (): void => {
    if (mountedUnsubscribe === undefined) {
      const mounted = controller()?.mounted
      if (typeof mounted?.subscribe === 'function') mountedUnsubscribe = mounted.subscribe(flushPending)
    }
    flushPending()
    evictGoneSessions()
  }
  const unsubscribeList = ctx.sessions.list.subscribe(onListChange)
  evictGoneSessions()
  return {
    openTab({ sessionId, kind, params, revealIfOpened, preferNewPane }) {
      enqueue({ kind: 'tab', sessionId, tabKind: kind, params, revealIfOpened, preferNewPane: preferNewPane === true })
    },
    openResource({ sessionId, address, line, revealIfOpened, preferNewPane }) {
      enqueue({ kind: 'resource', sessionId, address, line, revealIfOpened, preferNewPane: preferNewPane === true })
    },
    fileAddress(sessionId, cwd, path) {
      return fileAddressFor(sessionId, cwd, path)
    },
    close(sessionId, tabId) {
      // Read through the SESSION: the same native id names a tab in every
      // session, so a bare read can hand back another session's record.
      const record = records.get(sessionId, tabId)
      if (record === undefined) return undefined
      records.drop(sessionId, tabId)
      const api = controller()
      if (api !== undefined) {
        if (sessionId === mountedSessionId(ctx)) api.close(tabId)
        else if (api.closeIn !== undefined) api.closeIn(sessionId, tabId)
      }
      return {
        type: record.tab.type,
        title: record.tab.title,
        ...(record.tab.meta === undefined ? {} : { meta: record.tab.meta }),
      }
    },
    update(tabId, patch, sessionId) {
      const owner = sessionOf(tabId, sessionId)
      if (owner === undefined) return false
      records.update(owner, tabId, patch)
      return true
    },
    activate(tabId, sessionId) {
      // External plugin tabs (multi-instance kinds like side chats) carry no
      // (kind, address) identity to re-open against, so "open again to focus"
      // cannot work for them — focus through the controller's own face.
      if (sessionOf(tabId, sessionId) === undefined) return false
      controller()?.focus?.(tabId)
      return true
    },
    has: (tabId, sessionId) => sessionOf(tabId, sessionId) !== undefined,
    flushPending,
    dispose: () => {
      unsubscribeList()
      mountedUnsubscribe?.()
    },
  }
}
