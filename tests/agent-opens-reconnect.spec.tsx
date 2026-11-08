/**
 * The agent-opens push socket's LIVENESS contract (fixes #836 and the missing
 * heartbeat).
 *
 * The socket is the only delivery path for `sidebar_open`; a socket that is
 * never kept alive, or a reconnect loop that stops for good, silently drops
 * the feature until the page is reloaded. Three behaviours are pinned:
 *
 *  - HEARTBEAT: an idle socket still sends a small frame every
 *    HEARTBEAT_INTERVAL_MS, so a load balancer's idle/send timeout (60 s by
 *    default) never sees the connection idle. Nothing is sent before OPEN.
 *  - NO PERMANENT STOP: a connection that opened (or delivered a frame) ends
 *    the consecutive-failure series, so three scattered drops in a session no
 *    longer accumulate into the old `stopping reconnect loop` stop (#836).
 *  - BACKOFF: attempts that never reach OPEN double their delay (2 s → 4 s →
 *    8 s … capped at RECONNECT_MAX_MS) and never stop retrying.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import type { Context, SidebarSessionList } from '../src/context-types.ts'
import type { SidebarStore } from '../src/client/state.ts'
import { useHostFeeds } from '../src/client/sidebar/use-host-feeds.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'

setupReactAct()

/** One controllable stand-in for the browser WebSocket. */
class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeSocket[] = []

  readonly url: string
  readonly sent: string[] = []
  readyState = FakeSocket.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(url: string | URL) {
    this.url = String(url)
    FakeSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    if (this.readyState === FakeSocket.CLOSED) return
    this.readyState = FakeSocket.CLOSED
    this.onclose?.({} as CloseEvent)
  }

  /** Drive the socket to OPEN (the host accepted the upgrade). */
  open(): void {
    this.readyState = FakeSocket.OPEN
    this.onopen?.({} as Event)
  }

  /** Deliver one frame, then leave the socket open. */
  receive(data: string): void {
    this.onmessage?.({ data } as MessageEvent)
  }

  /** Drop the socket without a clean client-side close. */
  drop(): void {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.({} as CloseEvent)
  }
}

/** The only hook input the agent-opens effect reads. */
function mountFeeds(sessionId = 'session-1'): ReturnType<typeof renderRoot> {
  const ctx = { get: () => undefined } as unknown as Context
  const store = {
    getPrefs: () => ({ agentOpenTools: true }),
    markUnread: () => {},
  } as unknown as SidebarStore
  const sessionList: SidebarSessionList = { byId: {} }
  function Probe(): null {
    useHostFeeds({ ctx, store, sessionList, sessionId })
    return null
  }
  return renderRoot(createElement(Probe))
}

/** The socket created by the attempt at `index`. */
function socketAt(index: number): FakeSocket {
  const socket = FakeSocket.instances[index]
  if (socket === undefined) throw new Error(`no socket at index ${index}`)
  return socket
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('agent-opens push socket', () => {
  it('connects to the session-scoped endpoint', () => {
    const mounted = mountFeeds()
    expect(FakeSocket.instances).toHaveLength(1)
    expect(socketAt(0).url).toContain('/sidebar/ws/agent-opens')
    expect(socketAt(0).url).toContain('sessionId=session-1')
    mounted.unmount()
  })

  it('sends a heartbeat every interval once open, and nothing before', () => {
    const mounted = mountFeeds()
    const socket = socketAt(0)

    vi.advanceTimersByTime(60_000)
    expect(socket.sent).toEqual([])

    socket.open()
    vi.advanceTimersByTime(19_999)
    expect(socket.sent).toEqual([])
    vi.advanceTimersByTime(1)
    expect(socket.sent).toEqual(['{"kind":"ping"}'])
    vi.advanceTimersByTime(20_000)
    expect(socket.sent).toHaveLength(2)

    // Cleanup stops the heartbeat with the effect.
    mounted.unmount()
    vi.advanceTimersByTime(60_000)
    expect(socket.sent).toHaveLength(2)
  })

  it('never stops reconnecting after repeated successful connections (#836)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mounted = mountFeeds()

    // Three connections that each OPEN, deliver a frame and then drop — the
    // failure series must restart every time instead of accumulating into a stop.
    for (let round = 0; round < 3; round++) {
      const socket = socketAt(round)
      socket.open()
      socket.receive('{"kind":"file","target":"/tmp/a.ts","title":"a.ts"}')
      vi.advanceTimersByTime(20_000)
      socket.drop()
      // A live connection's drop backs off from the BASE delay, not a grown one.
      vi.advanceTimersByTime(2_000)
      expect(FakeSocket.instances).toHaveLength(round + 2)
    }

    expect(socketAt(3)).toBeDefined()
    expect(errorSpy.mock.calls.flat().join(' ')).not.toContain('stopping reconnect loop')
    mounted.unmount()
  })

  it('backs off exponentially for attempts that never open, and never gives up', () => {
    const mounted = mountFeeds()

    socketAt(0).drop()
    vi.advanceTimersByTime(1_999)
    expect(FakeSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(2)

    socketAt(1).drop()
    vi.advanceTimersByTime(3_999)
    expect(FakeSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(3)

    socketAt(2).drop()
    vi.advanceTimersByTime(7_999)
    expect(FakeSocket.instances).toHaveLength(3)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(4)

    // The ceiling holds, and the loop keeps scheduling attempts.
    for (let attempts = 0; attempts < 6; attempts++) {
      socketAt(FakeSocket.instances.length - 1).drop()
      vi.advanceTimersByTime(30_000)
    }
    expect(FakeSocket.instances.length).toBeGreaterThan(4)

    mounted.unmount()
  })

  it('stops reconnecting after unmount', () => {
    const mounted = mountFeeds()
    socketAt(0).drop()
    vi.advanceTimersByTime(2_000)
    expect(FakeSocket.instances).toHaveLength(2)

    mounted.unmount()
    socketAt(1).drop()
    vi.advanceTimersByTime(120_000)
    expect(FakeSocket.instances).toHaveLength(2)
  })
})
