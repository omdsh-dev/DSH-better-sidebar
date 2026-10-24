/**
 * The shared session-root store's OWNERSHIP contract.
 *
 * Every body of every native tab type calls `useSessionRoot`, and the host
 * keeps every visited tab body mounted. A per-hook 5 s poller therefore meant
 * one `POST /sidebar/api/session.cwd` per live body per tick, and each of
 * those lands in the host's `activeWorktreeRootOf` (9.6–44.7 ms and up to four
 * real `git` spawns on a cache miss, whose TTL is shorter than this cadence).
 * Four behaviours are pinned:
 *
 *  - ONE POLLER: three visible bodies on one session share a single timer and
 *    issue one request per interval, and the store owns exactly one
 *    `window.focus` listener however many bodies mount.
 *  - PARKED IS SILENT: a parked body (`visible: false`) issues nothing, the
 *    timer stops when the last visible subscriber leaves, and the parked body
 *    keeps the answer it already resolved.
 *  - IMMEDIATE RETURN: becoming visible again refreshes at once instead of
 *    waiting for the next tick.
 *  - PER SESSION: two sessions get one poller each with no cross-talk, and
 *    releasing one leaves the other polling.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { act } from 'react-dom/test-utils'

const { sessionCwd } = vi.hoisted(() => ({ sessionCwd: vi.fn() }))

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return { ...actual, api: { ...actual.api, sessionCwd } }
})

import { renderRoot, setupReactAct } from './test-utils.ts'
import { useSessionRoot } from '../src/client/use-session-root.ts'

setupReactAct()

type Ctx = Parameters<typeof useSessionRoot>[0]

/**
 * The one feed the hook reads: the session list, whose summary cwd is the
 * fallback behind the host's answer. `getSnapshot` returns ONE stable object —
 * a fresh one per call would make `useSyncExternalStore` re-render forever.
 */
function fakeContext(): Ctx {
  const listeners = new Set<() => void>()
  const snapshot = { byId: { shared: { cwd: '/summary/shared' } } as Record<string, { cwd: string }> }
  return {
    sessions: {
      list: {
        subscribe: (listener: () => void) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        getSnapshot: () => snapshot,
      },
    },
  } as unknown as Ctx
}

/** Renders the resolved root, so the parked-keeps-its-answer case is visible. */
function Probe(props: { ctx: Ctx; sessionId: string; visible?: boolean }): ReactNode {
  const cwd = useSessionRoot(props.ctx, props.sessionId, { visible: props.visible })
  return createElement('span', null, cwd ?? '')
}

/** Three bodies on one session (the native tab stack the host keeps mounted). */
function bodies(ctx: Ctx, sessionId: string, count: number, visible?: boolean): ReactNode {
  return createElement(
    'div',
    null,
    ...Array.from({ length: count }, (_, index) =>
      createElement(Probe, { key: index, ctx, sessionId, visible })),
  )
}

/** Let the store's in-flight request settle (inside act — it notifies React). */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** Advance the fake clock, letting the store's promises settle inside act. */
async function tick(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

let mounted: ReturnType<typeof renderRoot> | null = null
afterEach(() => {
  mounted?.unmount()
  mounted = null
  sessionCwd.mockReset()
  vi.useRealTimers()
})

describe('the shared session root store', () => {
  it('runs ONE poller (and one focus listener) for three visible bodies on one session', async () => {
    vi.useFakeTimers()
    sessionCwd.mockResolvedValue({ cwd: '/work/shared' })
    const ctx = fakeContext()
    // The store attaches its window listeners on the first slot of the file,
    // so count the DELTA: three bodies must add at most one focus listener
    // (the old shape added one per mounted hook).
    const spy = vi.spyOn(window, 'addEventListener')
    try {
      const before = spy.mock.calls.filter(([type]) => type === 'focus').length
      mounted = renderRoot(bodies(ctx, 'shared', 3))
      await tick(0)
      await flush()

      // One request for the first visible body, not one per body.
      expect(sessionCwd).toHaveBeenCalledTimes(1)
      expect(sessionCwd).toHaveBeenCalledWith({ sessionId: 'shared' })
      const after = spy.mock.calls.filter(([type]) => type === 'focus').length
      expect(after - before).toBeLessThanOrEqual(1)

      // The 5 s cadence is the store's, not each body's.
      await tick(5_000)
      await flush()
      expect(sessionCwd).toHaveBeenCalledTimes(2)
      await tick(5_000)
      await flush()
      expect(sessionCwd).toHaveBeenCalledTimes(3)
      expect(mounted.container.textContent).toBe('/work/shared/work/shared/work/shared')
    } finally {
      spy.mockRestore()
    }
  })

  it('issues nothing for a parked body and stops the timer when the last visible one leaves', async () => {
    vi.useFakeTimers()
    sessionCwd.mockResolvedValue({ cwd: '/work/parked' })
    const ctx = fakeContext()
    const tree = (visible: boolean): ReactNode => createElement(Probe, { ctx, sessionId: 'parked', visible })
    mounted = renderRoot(tree(false))
    await tick(0)
    await flush()
    expect(sessionCwd).toHaveBeenCalledTimes(0)
    // Ten minutes parked: no tick, no request.
    await tick(600_000)
    expect(sessionCwd).toHaveBeenCalledTimes(0)

    mounted.rerender(tree(true))
    await tick(0)
    await flush()
    expect(sessionCwd).toHaveBeenCalledTimes(1)
    await tick(5_000)
    await flush()
    expect(sessionCwd).toHaveBeenCalledTimes(2)

    // Parking the last visible body takes the timer with it...
    mounted.rerender(tree(false))
    await tick(600_000)
    expect(sessionCwd).toHaveBeenCalledTimes(2)
    // ...and the parked body keeps the root it resolved while visible.
    expect(mounted.container.textContent).toBe('/work/parked')
  })

  it('refreshes immediately once when a body becomes visible again', async () => {
    vi.useFakeTimers()
    sessionCwd.mockResolvedValue({ cwd: '/work/flip' })
    const ctx = fakeContext()
    const tree = (visible: boolean): ReactNode => createElement(Probe, { ctx, sessionId: 'flip', visible })
    mounted = renderRoot(tree(false))
    await tick(60_000)
    expect(sessionCwd).toHaveBeenCalledTimes(0)

    // Un-parked: one immediate refresh, no waiting for the next 5 s tick.
    mounted.rerender(tree(true))
    await tick(0)
    expect(sessionCwd).toHaveBeenCalledTimes(1)
    await flush()
    expect(mounted.container.textContent).toBe('/work/flip')

    // And the cadence starts from that moment.
    await tick(4_000)
    expect(sessionCwd).toHaveBeenCalledTimes(1)
    await tick(1_000)
    await flush()
    expect(sessionCwd).toHaveBeenCalledTimes(2)
  })

  it('keeps one poller per session, without cross-talk', async () => {
    vi.useFakeTimers()
    sessionCwd.mockImplementation((scope: { sessionId: string }) =>
      Promise.resolve({ cwd: `/work/${scope.sessionId}` }))
    const ctx = fakeContext()
    // A stable tree shape: dropping session A's body must not remount session
    // B's (a remount would legitimately re-fetch, which is not what this case
    // is about).
    const both = (withA: boolean): ReactNode => createElement(
      'div',
      null,
      withA ? createElement(Probe, { ctx, sessionId: 'iso-a' }) : null,
      createElement(Probe, { ctx, sessionId: 'iso-b' }),
    )
    mounted = renderRoot(both(true))
    await tick(0)
    await flush()
    expect(sessionCwd.mock.calls.map(([scope]) => scope.sessionId).sort()).toEqual(['iso-a', 'iso-b'])
    expect(mounted.container.textContent).toBe('/work/iso-a/work/iso-b')

    // One tick each, not four (two sessions x one body each).
    await tick(5_000)
    await flush()
    expect(sessionCwd).toHaveBeenCalledTimes(4)

    // Releasing one session leaves the other's timer alone.
    mounted.rerender(both(false))
    await tick(5_000)
    await flush()
    const perSession = (id: string): number =>
      sessionCwd.mock.calls.filter(([scope]) => scope.sessionId === id).length
    expect(perSession('iso-a')).toBe(2)
    expect(perSession('iso-b')).toBe(3)
    // The dropped body's session is not re-asked, and its neighbour still is.
    expect(mounted.container.textContent).toBe('/work/iso-b')
  })
})
