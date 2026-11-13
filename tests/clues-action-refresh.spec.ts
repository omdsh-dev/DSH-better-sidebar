import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createClueActionRefreshWatcher,
  type ClueActionDraftStatus,
  type ClueActionRefreshSessions,
} from '../src/client/clues/action-refresh.ts'

type TestResource = { clueId: string }

interface FakeSessions {
  readonly sessions: ClueActionRefreshSessions
  setRunning(running: boolean): void
  notify(): void
  listenerCount(): number
}

/** One session-list face with a single `session-1` row. */
function fakeSessions(initialRunning: boolean): FakeSessions {
  const listeners = new Set<() => void>()
  let running = initialRunning
  const list = {
    getSnapshot: () => ({
      byId: {
        'session-1': { id: 'session-1', displayTitle: 'Session', running },
      },
    }),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return {
    sessions: { list } as unknown as ClueActionRefreshSessions,
    setRunning(next) {
      running = next
      for (const listener of [...listeners]) listener()
    },
    notify() {
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.size,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** Let the watcher's microtask pump and the test's 0 ms settle run. */
async function flush(): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, 0) })
}

function request(resource: TestResource = { clueId: 'clue-1' }) {
  return { workspaceId: 'w', sessionId: 'session-1', target: 'main' as const, resource }
}

function result(draftId: string, deliveryId = 'session-1') {
  return { deliveryId, draft: { draftId } }
}

afterEach(() => { vi.restoreAllMocks() })

describe('turn-completion refresh for delivered clue actions', () => {
  it('keeps a prepared draft across the current turn and refreshes on the action turn', async () => {
    const sessions = fakeSessions(false)
    const readDrafts = vi.fn<() => Promise<readonly ClueActionDraftStatus[]>>()
      .mockResolvedValueOnce([{ draftId: 'd1', status: 'prepared' }])
      .mockResolvedValueOnce([{ draftId: 'd1', status: 'prepared' }])
      .mockResolvedValueOnce([{ draftId: 'd1', status: 'committed' }])
    const invalidate = vi.fn<(workspaceId: string, resource: { clueId: string }) => void>()
    const watcher = createClueActionRefreshWatcher<TestResource>({
      sessions: sessions.sessions, readDrafts, invalidate,
    })

    watcher.track(request(), result('d1'))
    await flush()
    expect(readDrafts).toHaveBeenCalledTimes(1)
    expect(invalidate).not.toHaveBeenCalled()

    // Ready but idle + prepared is not abandonment: the action may still be
    // queued behind the current turn.
    sessions.setRunning(true)
    expect(readDrafts).toHaveBeenCalledTimes(1)
    sessions.setRunning(false)
    await flush()
    expect(readDrafts).toHaveBeenCalledTimes(2)
    expect(invalidate).not.toHaveBeenCalled()

    sessions.setRunning(true)
    sessions.setRunning(false)
    await flush()
    expect(readDrafts).toHaveBeenCalledTimes(3)
    expect(invalidate).toHaveBeenCalledOnce()
    expect(invalidate).toHaveBeenCalledWith('w', { clueId: 'clue-1' })
    expect(sessions.listenerCount()).toBe(0)
    watcher.dispose()
  })

  it('invalidates once for a partial save and stops tracking', async () => {
    const sessions = fakeSessions(false)
    const readDrafts = vi.fn(async () => [{ draftId: 'd1', status: 'partial' }])
    const invalidate = vi.fn<(workspaceId: string, resource: { clueId: string }) => void>()
    const watcher = createClueActionRefreshWatcher<TestResource>({
      sessions: sessions.sessions, readDrafts, invalidate,
    })

    watcher.track(request(), result('d1'))
    await flush()
    expect(invalidate).toHaveBeenCalledOnce()
    expect(invalidate).toHaveBeenCalledWith('w', { clueId: 'clue-1' })
    expect(sessions.listenerCount()).toBe(0)

    sessions.notify()
    await flush()
    expect(readDrafts).toHaveBeenCalledTimes(1)
    watcher.dispose()
  })

  it('makes a late draft result inert after dispose and drops the listener', async () => {
    const sessions = fakeSessions(false)
    const late = deferred<readonly ClueActionDraftStatus[]>()
    const readDrafts = vi.fn(() => late.promise)
    const invalidate = vi.fn<(workspaceId: string, resource: { clueId: string }) => void>()
    const watcher = createClueActionRefreshWatcher<TestResource>({
      sessions: sessions.sessions, readDrafts, invalidate,
    })

    watcher.track(request(), result('d1'))
    await flush()
    expect(readDrafts).toHaveBeenCalledTimes(1)
    expect(sessions.listenerCount()).toBe(1)

    watcher.dispose()
    expect(sessions.listenerCount()).toBe(0)
    late.resolve([{ draftId: 'd1', status: 'committed' }])
    await flush()
    expect(invalidate).not.toHaveBeenCalled()

    sessions.notify()
    await flush()
    expect(readDrafts).toHaveBeenCalledTimes(1)
  })

  it('does not query drafts for unrelated list changes', async () => {
    const sessions = fakeSessions(false)
    const readDrafts = vi.fn(async () => [{ draftId: 'd1', status: 'prepared' }])
    const invalidate = vi.fn<(workspaceId: string, resource: { clueId: string }) => void>()
    const watcher = createClueActionRefreshWatcher<TestResource>({
      sessions: sessions.sessions, readDrafts, invalidate,
    })

    watcher.track(request(), result('d1'))
    await flush()
    expect(readDrafts).toHaveBeenCalledTimes(1)

    sessions.notify()
    sessions.setRunning(true)
    sessions.notify()
    await flush()
    expect(readDrafts).toHaveBeenCalledTimes(1)

    sessions.setRunning(false)
    await flush()
    expect(readDrafts).toHaveBeenCalledTimes(2)
    expect(invalidate).not.toHaveBeenCalled()
    watcher.dispose()
  })

  it('shares one read across pending checks and replays a turn-end observed in flight', async () => {
    const sessions = fakeSessions(true)
    const first = deferred<readonly ClueActionDraftStatus[]>()
    const second = deferred<readonly ClueActionDraftStatus[]>()
    const readDrafts = vi.fn<() => Promise<readonly ClueActionDraftStatus[]>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const invalidate = vi.fn<(workspaceId: string, resource: { clueId: string }) => void>()
    const watcher = createClueActionRefreshWatcher<TestResource>({
      sessions: sessions.sessions, readDrafts, invalidate,
    })

    watcher.track(request({ clueId: 'c0' }), result('d0'))
    watcher.track(request({ clueId: 'c1' }), result('d1'))
    await flush()
    expect(readDrafts).toHaveBeenCalledTimes(1)
    expect(sessions.listenerCount()).toBe(1)

    // The current turn ends while the shared read is still in flight. Both
    // pending entries keep their check for a follow-up query.
    sessions.setRunning(false)
    await flush()
    expect(readDrafts).toHaveBeenCalledTimes(1)

    first.resolve([{ draftId: 'd0', status: 'prepared' }, { draftId: 'd1', status: 'prepared' }])
    await flush()
    expect(readDrafts).toHaveBeenCalledTimes(2)

    second.resolve([{ draftId: 'd0', status: 'committed' }, { draftId: 'd1', status: 'committed' }])
    await flush()
    expect(invalidate).toHaveBeenCalledTimes(2)
    expect(sessions.listenerCount()).toBe(0)
    watcher.dispose()
  })

  it('caps pending at 64 without evicting active entries or tracking the 65th', async () => {
    const sessions = fakeSessions(false)
    const prepared = Array.from({ length: 64 }, (_, index) => ({
      draftId: `d${index}`, status: 'prepared',
    }))
    const firstSaved = prepared.map((draft, index) =>
      index === 0 ? { ...draft, status: 'committed' } : draft)
    const secondSaved = prepared.map((draft, index) =>
      index === 1 ? { ...draft, status: 'committed' } : draft)
    const readDrafts = vi.fn<() => Promise<readonly ClueActionDraftStatus[]>>()
      .mockResolvedValueOnce(prepared)
      // The 65th draft is present in the ledger but is not a pending target.
      .mockResolvedValueOnce([...firstSaved, { draftId: 'd64', status: 'committed' }])
      .mockResolvedValueOnce([...secondSaved, { draftId: 'd64', status: 'committed' }])
    const invalidate = vi.fn<(workspaceId: string, resource: { clueId: string }) => void>()
    const watcher = createClueActionRefreshWatcher<TestResource>({
      sessions: sessions.sessions, readDrafts, invalidate,
    })

    for (let index = 0; index < 64; index += 1) {
      watcher.track(request({ clueId: `c${index}` }), result(`d${index}`))
    }
    watcher.track(request({ clueId: 'c64' }), result('d64'))
    await flush()
    expect(readDrafts).toHaveBeenCalledTimes(1)
    expect(invalidate).not.toHaveBeenCalled()

    sessions.setRunning(true)
    sessions.setRunning(false)
    await flush()
    expect(readDrafts).toHaveBeenCalledTimes(2)
    expect(invalidate.mock.calls.map(([, resource]) => resource.clueId)).toEqual(['c0'])

    // d1 survived the first removal (active entries are never evicted) and the
    // 65th never invalidated even though its committed ledger row is present.
    sessions.setRunning(true)
    sessions.setRunning(false)
    await flush()
    expect(readDrafts).toHaveBeenCalledTimes(3)
    expect(invalidate.mock.calls.map(([, resource]) => resource.clueId)).toEqual(['c0', 'c1'])
    watcher.dispose()
  })

  it('stops tracking on failed, unknown and draft-route errors', async () => {
    for (const mode of ['failed', 'unknown', 'error'] as const) {
      const sessions = fakeSessions(false)
      const readDrafts = mode === 'error'
        ? vi.fn(() => Promise.reject(new Error('draft route unavailable')))
        : vi.fn(async () => [{ draftId: 'd1', status: mode === 'failed' ? 'failed' : 'mystery' }])
      const invalidate = vi.fn<(workspaceId: string, resource: { clueId: string }) => void>()
      const watcher = createClueActionRefreshWatcher<TestResource>({
        sessions: sessions.sessions, readDrafts, invalidate,
      })

      watcher.track(request(), result('d1'))
      await flush()
      expect(invalidate, mode).not.toHaveBeenCalled()
      expect(sessions.listenerCount(), mode).toBe(0)

      sessions.notify()
      await flush()
      expect(readDrafts, mode).toHaveBeenCalledTimes(1)
      watcher.dispose()
    }
  })
})
