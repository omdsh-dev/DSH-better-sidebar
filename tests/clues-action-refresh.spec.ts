/** Local direct edits invalidate once on the observed turn end; remote drafts keep the ledger path. */
import { describe, expect, it, vi } from 'vitest'
import {
  createClueActionRefreshWatcher,
  type ClueActionDraftStatus,
  type ClueActionRefreshSessions,
} from '../src/client/clues/action-refresh.ts'

interface Resource { readonly clueId: string }
interface RunningRow { running?: boolean }
type RunningMap = Record<string, RunningRow>

/** A structural session list: one snapshot map plus a synchronous listener set. */
function sessionList(initial: RunningMap) {
  let snapshot: { byId: RunningMap } = { byId: initial }
  const listeners = new Set<() => void>()
  const list = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return {
    sessions: { list } as unknown as ClueActionRefreshSessions,
    set(byId: RunningMap): void {
      snapshot = { byId }
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.size,
  }
}

const request = { workspaceId: 'ws', sessionId: 'parent', target: 'side' as const, resource: { clueId: 'clue' } }

function watcherFor(sessions: ReturnType<typeof sessionList>, drafts: readonly ClueActionDraftStatus[] = []) {
  const readDrafts = vi.fn<() => Promise<readonly ClueActionDraftStatus[]>>().mockResolvedValue(drafts)
  const invalidate = vi.fn<(workspaceId: string, resource: Resource) => void>()
  const watcher = createClueActionRefreshWatcher<Resource>({ sessions: sessions.sessions, readDrafts, invalidate })
  return { watcher, readDrafts, invalidate }
}

describe('local-file completion refresh', () => {
  it('invalidates once on running → idle and never reads the draft ledger', () => {
    const sessions = sessionList({ child: { running: true } })
    const { watcher, readDrafts, invalidate } = watcherFor(sessions)
    watcher.track(request, { deliveryId: 'child', localFile: true })
    // A duplicate receipt for the same target/resource is a no-op.
    watcher.track(request, { deliveryId: 'child', localFile: true })
    expect(invalidate).not.toHaveBeenCalled()
    expect(readDrafts).not.toHaveBeenCalled()
    expect(sessions.listenerCount()).toBe(1)

    sessions.set({ child: { running: true } })
    expect(invalidate).not.toHaveBeenCalled()
    sessions.set({ child: { running: false } })
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledWith('ws', request.resource)
    expect(readDrafts).not.toHaveBeenCalled()
    expect(sessions.listenerCount()).toBe(0)

    sessions.set({ child: { running: false } })
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('does not invalidate an idle target before the turn is observed running', () => {
    const sessions = sessionList({ child: { running: false } })
    const { watcher, readDrafts, invalidate } = watcherFor(sessions)
    // This is the prepare-only case: the empty thread exists but the user has
    // not sent the queued prompt yet.
    watcher.track(request, { deliveryId: 'child', localFile: true })
    sessions.set({ child: { running: false } })
    expect(invalidate).not.toHaveBeenCalled()
    expect(readDrafts).not.toHaveBeenCalled()

    sessions.set({ child: { running: true } })
    sessions.set({ child: { running: false } })
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(readDrafts).not.toHaveBeenCalled()
  })

  it('uses the parent session for a main-target local edit without a delivery id', () => {
    const sessions = sessionList({ parent: { running: true } })
    const { watcher, invalidate } = watcherFor(sessions)
    watcher.track({ ...request, target: 'main' }, { localFile: true })
    sessions.set({ parent: { running: false } })
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledWith('ws', request.resource)
  })

  it('bounds local receipts on the same pending map', () => {
    const ids = Array.from({ length: 65 }, (_, index) => `child-${index}`)
    const sessions = sessionList(Object.fromEntries(ids.map(id => [id, { running: true }])))
    const { watcher, readDrafts, invalidate } = watcherFor(sessions)
    for (const [index, id] of ids.entries()) {
      watcher.track({ ...request, resource: { clueId: `clue-${index}` } }, { deliveryId: id, localFile: true })
    }
    sessions.set(Object.fromEntries(ids.map(id => [id, { running: false }])))
    expect(invalidate).toHaveBeenCalledTimes(64)
    expect(readDrafts).not.toHaveBeenCalled()
    expect(sessions.listenerCount()).toBe(0)
  })
})

describe('remote draft completion refresh', () => {
  it('keeps the ledger check and invalidates only after the observed turn end', async () => {
    const sessions = sessionList({ child: { running: true } })
    const { watcher, readDrafts, invalidate } = watcherFor(sessions, [{ draftId: 'draft', status: 'prepared' }])
    watcher.track(request, { deliveryId: 'child', draft: { draftId: 'draft' } })
    await vi.waitFor(() => expect(readDrafts).toHaveBeenCalledTimes(1))
    expect(invalidate).not.toHaveBeenCalled()

    sessions.set({ child: { running: false } })
    await vi.waitFor(() => expect(readDrafts).toHaveBeenCalledTimes(2))
    expect(invalidate).not.toHaveBeenCalled()

    readDrafts.mockResolvedValue([{ draftId: 'draft', status: 'committed' }])
    sessions.set({ child: { running: true } })
    sessions.set({ child: { running: false } })
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1))
    expect(invalidate).toHaveBeenCalledWith('ws', request.resource)
    expect(readDrafts).toHaveBeenCalledTimes(3)
    expect(sessions.listenerCount()).toBe(0)
  })
})
