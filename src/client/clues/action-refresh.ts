/**
 * Turn-completion refresh for explicitly delivered clue actions.
 *
 * The fixed agent commit route writes through the server-side clue service, so
 * the client's `cluesApi.saveEdit` cache invalidation never runs. The only
 * existing general client completion feed is the session list's `running` bit;
 * this watcher uses it to re-check the durable draft ledger through the
 * existing `clues.drafts.list` route and, once the draft may have been saved,
 * runs the caller's cache invalidation.
 *
 * Deliberately no timers: an extremely fast turn that starts and ends between
 * two list snapshots simply keeps the explicit Refresh fallback. There is no
 * composer access here.
 *
 * The initial draft check is not an optimization: a ready target may already
 * be idle (`running === false`), and a `prepared` draft is NOT evidence that
 * the action was abandoned. It may be queued behind the current turn, so only
 * a terminal draft state may remove a pending entry.
 *
 * A local-file action edits the original file directly and has no draft ledger
 * row to read. Its resource is invalidated exactly once when the target session
 * is observed transitioning from running to idle; it is never invalidated on
 * the initial (idle) observation, because the turn may not have started yet.
 */
import type { Context } from '../../context-types.ts'

/** The part of the client session list this watcher observes. */
export type ClueActionRefreshSessions = Pick<Context['sessions'], 'list'>

/** One draft receipt as the existing `clues.drafts.list` route reports it. */
export interface ClueActionDraftStatus {
  readonly draftId: string
  readonly status: string
}

/** One delivered action the watcher should follow to turn completion. */
export interface ClueActionRefreshRequest<Resource> {
  readonly workspaceId: string
  readonly sessionId: string
  readonly target: 'main' | 'side'
  readonly resource: Resource
}

/** The action-start receipt fields this watcher needs. */
export interface ClueActionRefreshResult {
  readonly deliveryId?: string
  readonly draft?: { readonly draftId: string }
  /** The action edited the original local file directly; there is no draft ledger entry. */
  readonly localFile?: true
}

/** Dependencies: the existing session list, draft ledger and cache invalidator. */
export interface ClueActionRefreshDeps<Resource> {
  readonly sessions: ClueActionRefreshSessions
  readonly readDrafts: () => Promise<readonly ClueActionDraftStatus[]>
  readonly invalidate: (workspaceId: string, resource: Resource) => void
}

/** One live watcher. */
export interface ClueActionRefreshWatcher<Resource> {
  /** Follow one action; duplicate or over-capacity calls are no-ops. */
  track(request: ClueActionRefreshRequest<Resource>, result: ClueActionRefreshResult): void
  /** Stop observing and make every late route result inert. */
  dispose(): void
}

/** Pending actions are capped; active entries are never evicted. */
const MAX_PENDING = 64
/** Terminal states that mean the source may have changed. */
const SAVED = new Set(['committed', 'partial', 'uncertain'])
/** Terminal state that means no write was attempted. */
const UNSAVED = new Set(['failed'])

interface Pending<Resource> extends ClueActionRefreshRequest<Resource> {
  readonly key: string
  /** Remote draft ledger entry; absent for a direct local-file edit. */
  readonly draftId?: string
  /** Direct local-file edit: completion is the observed turn end, not a ledger read. */
  readonly localFile?: true
  readonly targetSessionId: string
  /** Last observed target run bit; undefined until the target row is seen. */
  lastRunning: boolean | undefined
}

/**
 * Create one activation-scoped completion watcher.
 * @param deps - existing session list feed, draft status read and cache invalidator.
 * @returns the track/dispose face; no timers and no composer access.
 */
export function createClueActionRefreshWatcher<Resource>(
  deps: ClueActionRefreshDeps<Resource>,
): ClueActionRefreshWatcher<Resource> {
  const pending = new Map<string, Pending<Resource>>()
  const checkWanted = new Set<string>()
  let unsubscribe: (() => void) | undefined
  let inFlight: Promise<void> | undefined
  let pumpScheduled = false
  let disposed = false

  function currentRunning(sessionId: string): boolean | undefined {
    const summary = deps.sessions.list.getSnapshot().byId[sessionId]
    return summary === undefined ? undefined : summary.running === true
  }

  function syncSubscription(): void {
    if (disposed) return
    if (pending.size > 0 && unsubscribe === undefined) {
      try {
        unsubscribe = deps.sessions.list.subscribe(onListChange)
      } catch {
        // A partially composed host without a session list still gets the
        // initial draft check; only turn-end observation degrades.
        unsubscribe = undefined
      }
      return
    }
    if (pending.size === 0 && unsubscribe !== undefined) {
      const stop = unsubscribe
      unsubscribe = undefined
      try { stop() } catch { /* an owner's disposer failure must not leak our state */ }
    }
  }

  function remove(key: string): void {
    pending.delete(key)
    checkWanted.delete(key)
  }

  function stopAll(): void {
    pending.clear()
    checkWanted.clear()
    syncSubscription()
  }

  function apply(
    drafts: readonly ClueActionDraftStatus[],
    targets: readonly Pending<Resource>[],
  ): void {
    if (disposed) return
    const statuses = new Map<string, string>()
    if (Array.isArray(drafts)) {
      for (const draft of drafts) {
        if (draft === null || typeof draft !== 'object') continue
        if (typeof draft.draftId !== 'string' || typeof draft.status !== 'string') continue
        statuses.set(draft.draftId, draft.status)
      }
    }
    for (const entry of targets) {
      if (disposed || pending.get(entry.key) !== entry) continue
      // Local-file entries never enter the ledger path; this guard keeps the
      // remote branch's types honest without a second pending map.
      if (entry.draftId === undefined) {
        remove(entry.key)
        continue
      }
      const status = statuses.get(entry.draftId)
      if (status === undefined || UNSAVED.has(status)) {
        remove(entry.key)
        continue
      }
      if (SAVED.has(status)) {
        // Remove before invalidating so a reentrant list event cannot call the
        // invalidator twice for the same action.
        remove(entry.key)
        try { deps.invalidate(entry.workspaceId, entry.resource) } catch { /* best effort */ }
        continue
      }
      if (status === 'prepared' || status === 'committing') continue
      // An unrecognized status is not a committed write; stop rather than
      // query forever, and leave the explicit Refresh path in charge.
      remove(entry.key)
    }
    syncSubscription()
  }

  function pump(): void {
    if (disposed || inFlight !== undefined || checkWanted.size === 0) return
    const keys = [...checkWanted]
    checkWanted.clear()
    const targets: Pending<Resource>[] = []
    for (const key of keys) {
      const entry = pending.get(key)
      if (entry !== undefined) targets.push(entry)
    }
    if (targets.length === 0) return
    inFlight = Promise.resolve()
      .then(() => deps.readDrafts())
      .then(
        drafts => { if (!disposed) apply(drafts, targets) },
        () => { if (!disposed) stopAll() },
      )
      .catch(() => { if (!disposed) stopAll() })
      .finally(() => {
        inFlight = undefined
        // A turn-end observed while the shared ledger read was in flight is
        // preserved in `checkWanted` and gets exactly one follow-up query.
        if (!disposed && checkWanted.size > 0) schedulePump()
      })
  }

  function schedulePump(): void {
    if (disposed || pumpScheduled) return
    pumpScheduled = true
    queueMicrotask(() => {
      pumpScheduled = false
      pump()
    })
  }

  function requestCheck(key: string): void {
    if (disposed || !pending.has(key)) return
    checkWanted.add(key)
    schedulePump()
  }

  function onListChange(): void {
    if (disposed || pending.size === 0) return
    const list = deps.sessions.list.getSnapshot()
    let removed = false
    for (const entry of pending.values()) {
      const running = list.byId[entry.targetSessionId]?.running === true
      if (running) {
        entry.lastRunning = true
        continue
      }
      // Only an observed true → false is a turn completion. An initial false
      // is never a completion; a repeated false is an unrelated list event.
      if (entry.lastRunning === true) {
        if (entry.localFile === true) {
          // Remove before invalidating so a reentrant list event cannot call
          // the invalidator twice for the same local action.
          remove(entry.key)
          try { deps.invalidate(entry.workspaceId, entry.resource) } catch { /* best effort */ }
          removed = true
        } else requestCheck(entry.key)
      }
      entry.lastRunning = false
    }
    if (removed) syncSubscription()
  }

  function track(
    request: ClueActionRefreshRequest<Resource>,
    result: ClueActionRefreshResult,
  ): void {
    if (disposed) return
    const delivered = typeof result.deliveryId === 'string' && result.deliveryId !== ''
      ? result.deliveryId
      : request.target === 'main' ? request.sessionId : undefined
    if (delivered === undefined || delivered === '') return
    if (result.localFile === true) {
      // No draft ledger exists for a direct local edit. Identify the action by
      // its target session and resource so a duplicate receipt is a no-op; the
      // same bounded map still owns the entry.
      const key = `${request.workspaceId}\u0000${delivered}\u0000local\u0000${JSON.stringify(request.resource)}`
      if (pending.has(key)) return
      if (pending.size >= MAX_PENDING) return
      pending.set(key, {
        key,
        localFile: true,
        targetSessionId: delivered,
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        target: request.target,
        resource: request.resource,
        lastRunning: currentRunning(delivered),
      })
      syncSubscription()
      return
    }
    const draftId = result.draft?.draftId
    if (typeof draftId !== 'string' || draftId === '') return
    const key = `${delivered}\u0000${draftId}`
    if (pending.has(key)) return
    if (pending.size >= MAX_PENDING) return
    pending.set(key, {
      key,
      draftId,
      targetSessionId: delivered,
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      target: request.target,
      resource: request.resource,
      lastRunning: currentRunning(delivered),
    })
    syncSubscription()
    requestCheck(key)
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    pending.clear()
    checkWanted.clear()
    const stop = unsubscribe
    unsubscribe = undefined
    try { stop?.() } catch { /* teardown is best effort; state is already inert */ }
  }

  return { track, dispose }
}
