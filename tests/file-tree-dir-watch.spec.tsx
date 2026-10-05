/**
 * The client half of the file tree's live refresh: one socket per session,
 * the expanded set announced as `watch` frames, directories that left the
 * set unwatched, and a `dir`-only frame routed to the staleness callback
 * while a refusal (`ok: false`) is NOT (a fenced/unwatchable directory must
 * not re-list forever).
 *
 * The identity guard: the hook derives its wanted set from the CONTENT of
 * `dirs` (a NUL-joined key), so a caller re-rendering with a fresh array of
 * the same directories reconciles nothing.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useDirectoryWatch } from '../src/client/use-dir-watch.ts'

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
  /** One host frame (a watch confirmation, a refusal, or a stale notice). */
  frame(payload: unknown): void { this.onmessage?.({ data: JSON.stringify(payload) }) }
  /** The frames the hook sent, as parsed objects. */
  frames(): { op: string; path: string }[] {
    return this.sent.map(frame => JSON.parse(frame) as { op: string; path: string })
  }
}

function Probe(props: { dirs: string[]; onStale: (dir: string) => void }): ReactNode {
  useDirectoryWatch({ sessionId: 's1', root: '/tmp', dirs: props.dirs, onStale: props.onStale })
  return null
}

interface Harness {
  rerender: (dirs: string[]) => void
  socket: () => FakeSocket
  unmount: () => void
}

function mountProbe(onStale: (dir: string) => void): Harness {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const render = (dirs: string[]): void => { root.render(createElement(Probe, { dirs, onStale })) }
  act(() => { render(['/tmp/a']) })
  return {
    rerender: (dirs: string[]) => { act(() => { render(dirs) }) },
    socket: () => {
      const socket = FakeSocket.instances[0]
      if (socket === undefined) throw new Error('no socket opened')
      return socket
    },
    unmount: () => { act(() => { root.unmount() }); container.remove() },
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

describe('useDirectoryWatch', () => {
  it('announces the root plus the expanded set once the socket opens', () => {
    const harness = mountProbe(() => {})
    const socket = harness.socket()
    expect(socket.url).toContain('/sidebar/ws/fs-watch')
    expect(socket.url).toContain('sessionId=s1')
    // Nothing is sent before the connection opens.
    expect(socket.sent).toEqual([])
    act(() => { socket.open() })
    expect(socket.frames()).toEqual([
      { op: 'watch', path: '/tmp' },
      { op: 'watch', path: '/tmp/a' },
    ])
    harness.unmount()
  })

  it('sends nothing when a re-render repeats the same directories in a fresh array', () => {
    const harness = mountProbe(() => {})
    const socket = harness.socket()
    act(() => { socket.open() })
    const before = socket.sent.length
    harness.rerender(['/tmp/a'])
    expect(FakeSocket.instances).toHaveLength(1)
    expect(socket.sent.length).toBe(before)
    harness.unmount()
  })

  it('watches the new directory and unwatches the one the host confirmed', () => {
    const harness = mountProbe(() => {})
    const socket = harness.socket()
    act(() => { socket.open() })
    // The host confirms both watches with its own resolved paths.
    act(() => {
      socket.frame({ dir: '/tmp', ok: true })
      socket.frame({ dir: '/tmp/a', ok: true })
    })
    harness.rerender(['/tmp/b'])
    expect(socket.frames().slice(-3)).toEqual([
      { op: 'watch', path: '/tmp' },
      { op: 'watch', path: '/tmp/b' },
      { op: 'unwatch', path: '/tmp/a' },
    ])
    harness.unmount()
  })

  it('routes a stale notice to the callback and ignores a refusal', () => {
    const onStale = vi.fn()
    const harness = mountProbe(onStale)
    const socket = harness.socket()
    act(() => { socket.open() })
    // A refusal (fenced path / watcher cap) must NOT re-list.
    act(() => { socket.frame({ dir: '/tmp/a', ok: false }) })
    expect(onStale).not.toHaveBeenCalled()
    act(() => { socket.frame({ dir: '/tmp/a' }) })
    expect(onStale).toHaveBeenCalledWith('/tmp/a')
    // A malformed frame is ignored outright.
    act(() => { socket.frame({ nope: 1 }) })
    expect(onStale).toHaveBeenCalledTimes(1)
    harness.unmount()
  })

  it('closes the socket on unmount', () => {
    const harness = mountProbe(() => {})
    const socket = harness.socket()
    act(() => { socket.open() })
    harness.unmount()
    expect(socket.closed).toBe(true)
  })
})
