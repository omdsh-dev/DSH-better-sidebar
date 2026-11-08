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
 *
 * The visibility gate: the host keeps every visited tab body mounted, so a
 * parked tree (visible: false) must hold no socket at all — that is what
 * releases the host's own `fs.watch` handles — and must ignore a frame that
 * arrives from the socket it just dropped (that re-list is an `fs.trees`
 * request for a tree nobody can see). Coming back reconnects and re-lists
 * every watched directory once, because the parked window was noticed by
 * nobody.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
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

function Probe(props: { dirs: string[]; root: string | undefined; visible: boolean; onStale: (dirs: readonly string[]) => void }): ReactNode {
  useDirectoryWatch({
    sessionId: 's1',
    root: props.root,
    dirs: props.dirs,
    visible: props.visible,
    onStale: props.onStale,
  })
  return null
}

interface Harness {
  /** Re-render with a new expanded set (and, optionally, a new visibility). */
  rerender: (dirs: string[], visible?: boolean) => void
  socket: () => FakeSocket
  unmount: () => void
}

function mountProbe(
  onStale: (dirs: readonly string[]) => void,
  options: { visible?: boolean; dirs?: string[]; root?: string | undefined } = {},
): Harness {
  const { visible = true, dirs = ['/tmp/a'] } = options
  // `'root' in options` distinguishes "no root yet" from "the default root".
  const root: string | undefined = 'root' in options ? options.root : '/tmp'
  const container = document.createElement('div')
  document.body.append(container)
  const reactRoot = createRoot(container)
  const render = (nextDirs: string[], shown: boolean): void => {
    reactRoot.render(createElement(Probe, { dirs: nextDirs, root, visible: shown, onStale }))
  }
  act(() => { render(dirs, visible) })
  return {
    rerender: (nextDirs: string[], shown = visible) => { act(() => { render(nextDirs, shown) }) },
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

  it('opens the socket under the page prefix (reverse proxy, issue #753)', () => {
    // The prefix is part of the page's own base: a leading-slash route leaves
    // it, and the proxy never forwards the handshake to the host (1006).
    const page = document as { baseURI?: string }
    const previous = page.baseURI
    Object.defineProperty(page, 'baseURI', {
      value: 'https://host.test/dataops/proxy/3080/',
      configurable: true,
      writable: true,
    })
    try {
      const harness = mountProbe(() => {})
      expect(harness.socket().url)
        .toBe('wss://host.test/dataops/proxy/3080/sidebar/ws/fs-watch?sessionId=s1')
      harness.unmount()
    } finally {
      Object.defineProperty(page, 'baseURI', { value: previous, configurable: true, writable: true })
    }
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
    expect(onStale).toHaveBeenCalledWith(['/tmp/a'])
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

  it('opens no socket while parked, and a frame from the dropped one re-lists nothing', () => {
    const onStale = vi.fn()
    // Parked from the start: no connection, so the host holds no `fs.watch`
    // handle for this tree either.
    const parked = mountProbe(onStale, { visible: false })
    expect(FakeSocket.instances).toHaveLength(0)
    parked.unmount()

    // Parked after being visible: the socket is dropped outright...
    const harness = mountProbe(onStale)
    const socket = harness.socket()
    act(() => { socket.open() })
    harness.rerender(['/tmp/a'], false)
    expect(socket.closed).toBe(true)
    expect(FakeSocket.instances).toHaveLength(1)
    // ...and a stale notice that still reaches it must not re-list a parked
    // tree (that would be an `fs.trees` request for nobody).
    act(() => { socket.frame({ dir: '/tmp/a' }) })
    act(() => { socket.frame({ dir: '/tmp', ok: true }) })
    expect(onStale).not.toHaveBeenCalled()
    harness.unmount()
  })

  it('opens no socket when there is nothing to watch (no root, nothing expanded)', () => {
    const harness = mountProbe(() => {}, { dirs: [], root: undefined })
    expect(FakeSocket.instances).toHaveLength(0)
    harness.unmount()
  })

  it('reconnects and force-refreshes every watched directory once when it comes back', () => {
    const onStale = vi.fn()
    const harness = mountProbe(onStale, { visible: false })
    expect(FakeSocket.instances).toHaveLength(0)

    // Un-parked: a fresh socket announces the whole watched set...
    harness.rerender(['/tmp/a', '/tmp/a/b'], true)
    const socket = harness.socket()
    act(() => { socket.open() })
    expect(socket.frames()).toEqual([
      { op: 'watch', path: '/tmp' },
      { op: 'watch', path: '/tmp/a' },
      { op: 'watch', path: '/tmp/a/b' },
    ])
    // ...and every level is re-listed once: whatever changed while parked was
    // seen by nobody, so the parked listing may be minutes old.
    expect(onStale.mock.calls.map(([dirs]) => dirs)).toEqual([['/tmp', '/tmp/a', '/tmp/a/b']])

    // Re-rendering the same inputs refreshes nothing again.
    harness.rerender(['/tmp/a', '/tmp/a/b'], true)
    expect(onStale).toHaveBeenCalledTimes(1)

    // A parked-unparked cycle repeats exactly once more.
    harness.rerender(['/tmp/a', '/tmp/a/b'], false)
    harness.rerender(['/tmp/a', '/tmp/a/b'], true)
    expect(onStale).toHaveBeenCalledTimes(2)
    expect(FakeSocket.instances).toHaveLength(2)
    harness.unmount()
  })
})
