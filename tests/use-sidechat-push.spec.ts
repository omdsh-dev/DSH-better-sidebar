/**
 * The client half of the Side Chat staleness push: one socket per mounted
 * tab, opened under `/sidebar/ws/sidechat`, whose `watch` frames carry the
 * WHOLE subscription set (a replacement, never an incremental add), whose
 * notices are routed to `onInvalidate` for WATCHED ids only, and which does
 * not exist at all while the id list is empty or the tab is parked.
 *
 * The identity guard mirrors the fs-watch hook's: the wanted set derives from
 * the CONTENT of the id list (a NUL-joined key), so a caller re-rendering
 * with a fresh array of the same ids neither reopens the socket nor re-sends
 * the watch frame.
 *
 * The visibility gate: the host keeps every visited tab body mounted, so a
 * parked side-chat tab must hold no socket (and must ignore a late notice
 * from the one it dropped — re-pulling there is a transcript request for a
 * panel nobody can see). Coming back subscribes again immediately and pulls
 * once, because the host's notices during the parked window went nowhere.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useSidechatPush } from '../src/client/use-sidechat-push.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

/** The smallest WebSocket the hook talks to: `send` records the frames. */
class FakeSocket {
  static instances: FakeSocket[] = []
  static readonly OPEN = 1
  static readonly CONNECTING = 0
  readonly url: string
  readyState = FakeSocket.CONNECTING
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  closed = false

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }

  send(frame: string): void { this.sent.push(frame) }
  close(): void { this.closed = true; this.readyState = 3 }
  /** The host's connection acknowledgement. */
  open(): void { this.readyState = FakeSocket.OPEN; this.onopen?.() }
  /** One host frame (an invalidation notice, or something malformed). */
  frame(payload: unknown): void { this.onmessage?.({ data: JSON.stringify(payload) }) }
  /** The frames the hook sent, as parsed objects. */
  frames(): { op: string; threadIds: string[] }[] {
    return this.sent.map(frame => JSON.parse(frame) as { op: string; threadIds: string[] })
  }
}

function Probe(props: { threadIds: string[]; visible: boolean; onInvalidate: (id: string) => void }): ReactNode {
  useSidechatPush({ threadIds: props.threadIds, visible: props.visible, onInvalidate: props.onInvalidate })
  return null
}

interface Harness {
  rerender: (threadIds: string[], visible?: boolean) => void
  /** The single open socket; throws when the list was empty. */
  socket: () => FakeSocket
  unmount: () => void
}

function mountProbe(
  onInvalidate: (id: string) => void,
  initial: string[] = ['t1'],
  visible = true,
): Harness {
  const container = document.createElement('div')
  document.body.append(container)
  const reactRoot: Root = createRoot(container)
  const render = (threadIds: string[], shown: boolean): void => {
    reactRoot.render(createElement(Probe, { threadIds, visible: shown, onInvalidate }))
  }
  act(() => { render(initial, visible) })
  return {
    rerender: (threadIds: string[], shown = visible) => { act(() => { render(threadIds, shown) }) },
    socket: () => {
      const socket = FakeSocket.instances[0]
      if (socket === undefined) throw new Error('no socket opened')
      return socket
    },
    unmount: () => { act(() => { reactRoot.unmount() }); container.remove() },
  }
}

beforeEach(() => {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('useSidechatPush', () => {
  it('opens the sidechat socket and announces the watched ids once it opens', () => {
    const harness = mountProbe(() => {})
    const socket = harness.socket()
    expect(socket.url).toContain('/sidebar/ws/sidechat')
    // Nothing is sent before the connection opens.
    expect(socket.sent).toEqual([])
    act(() => { socket.open() })
    expect(socket.frames()).toEqual([{ op: 'watch', threadIds: ['t1'] }])
    harness.unmount()
  })

  it('re-announces the full set on the SAME socket when the ids change', () => {
    const harness = mountProbe(() => {})
    const socket = harness.socket()
    act(() => { socket.open() })
    harness.rerender(['t1', 't2'])
    expect(FakeSocket.instances).toHaveLength(1)
    expect(socket.frames().at(-1)).toEqual({ op: 'watch', threadIds: ['t1', 't2'] })
    harness.unmount()
  })

  it('sends nothing when a re-render repeats the same ids in a fresh array', () => {
    const harness = mountProbe(() => {})
    const socket = harness.socket()
    act(() => { socket.open() })
    const before = socket.sent.length
    harness.rerender(['t1'])
    expect(FakeSocket.instances).toHaveLength(1)
    expect(socket.sent.length).toBe(before)
    harness.unmount()
  })

  it('invalidates a watched id and ignores everything else', () => {
    const onInvalidate = vi.fn()
    const harness = mountProbe(onInvalidate)
    const socket = harness.socket()
    act(() => { socket.open() })
    // A thread this socket does not watch (a late notice after a switch).
    act(() => { socket.frame({ threadId: 't9' }) })
    expect(onInvalidate).not.toHaveBeenCalled()
    // A malformed frame is ignored outright.
    act(() => { socket.frame({ nope: 1 }) })
    expect(onInvalidate).not.toHaveBeenCalled()
    // The notice is an invalidation: `running` rides along but changes nothing.
    act(() => { socket.frame({ threadId: 't1', running: true }) })
    expect(onInvalidate).toHaveBeenCalledWith('t1')
    expect(onInvalidate).toHaveBeenCalledTimes(1)
    harness.unmount()
  })

  it('opens no socket while the list is empty, and closes it when the list empties', () => {
    const harness = mountProbe(() => {}, [])
    expect(FakeSocket.instances).toHaveLength(0)

    harness.rerender(['t1'])
    const socket = harness.socket()
    act(() => { socket.open() })
    expect(socket.frames()).toEqual([{ op: 'watch', threadIds: ['t1'] }])

    harness.rerender([])
    expect(socket.closed).toBe(true)
    expect(FakeSocket.instances).toHaveLength(1)
    harness.unmount()
  })

  it('closes the socket on unmount', () => {
    const harness = mountProbe(() => {})
    const socket = harness.socket()
    act(() => { socket.open() })
    harness.unmount()
    expect(socket.closed).toBe(true)
  })

  it('holds no socket while parked, and a late notice from the dropped one pulls nothing', () => {
    const onInvalidate = vi.fn()
    // Parked from the start: not subscribed at all.
    const parked = mountProbe(onInvalidate, ['t1'], false)
    expect(FakeSocket.instances).toHaveLength(0)
    parked.unmount()

    // Parked after being visible: the socket goes with the subscription...
    const harness = mountProbe(onInvalidate)
    const socket = harness.socket()
    act(() => { socket.open() })
    harness.rerender(['t1'], false)
    expect(socket.closed).toBe(true)
    expect(FakeSocket.instances).toHaveLength(1)
    // ...and a notice that still reaches the torn-down socket must not re-pull
    // a transcript nobody can see.
    act(() => { socket.frame({ threadId: 't1' }) })
    expect(onInvalidate).not.toHaveBeenCalled()
    harness.unmount()
  })

  it('re-subscribes and pulls exactly once when it comes back', () => {
    const onInvalidate = vi.fn()
    const harness = mountProbe(onInvalidate, ['t1'], false)
    expect(FakeSocket.instances).toHaveLength(0)

    harness.rerender(['t1'], true)
    const socket = harness.socket()
    act(() => { socket.open() })
    // The whole watched set is re-announced on the new connection...
    expect(socket.frames()).toEqual([{ op: 'watch', threadIds: ['t1'] }])
    // ...and the parked window is covered by ONE re-pull through the same
    // invalidation path the host's own frames use.
    expect(onInvalidate.mock.calls.map(([id]) => id)).toEqual(['t1'])

    // Staying visible is not a refresh loop.
    harness.rerender(['t1'], true)
    expect(onInvalidate).toHaveBeenCalledTimes(1)
    // A second park/unpark cycle pulls once more, on its own new socket.
    harness.rerender(['t1'], false)
    harness.rerender(['t1'], true)
    expect(onInvalidate).toHaveBeenCalledTimes(2)
    expect(FakeSocket.instances).toHaveLength(2)
    harness.unmount()
  })
})
