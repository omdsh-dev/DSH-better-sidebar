/**
 * FsWatchHub regression coverage:
 * - watch/unwatch/removeSocket reference counting
 * - ignored directories never subscribe on their own
 * - ignored directory creation still refreshes its parent
 * - disposed hub cannot create new watchers
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebSocket as WsWebSocket } from 'ws'
import { FsWatchHub } from '../src/index.ts'

interface FakeSocket {
  readyState: number
  send: ReturnType<typeof vi.fn>
}

const OPEN = 1

function fakeSocket(): FakeSocket {
  return { readyState: OPEN, send: vi.fn() }
}

async function waitFor(expectation: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!expectation()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

let roots: string[]
let hub: FsWatchHub | null = null

beforeEach(() => {
  roots = []
  hub = null
})

afterEach(() => {
  hub?.dispose()
  hub = null
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // Windows may still be releasing handles; CI cleanup best effort.
    }
  }
  roots = []
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fs-watch-hub-'))
  roots.push(root)
  return root
}

function waitForWatcherStable(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100))
}

describe('FsWatchHub', () => {
  it('notifies a subscribed socket when a direct directory entry changes', async () => {
    const root = tempRoot()
    const socket = fakeSocket()
    hub = new FsWatchHub()
    hub.watch(root, socket as unknown as WsWebSocket, root)
    await waitForWatcherStable()

    writeFileSync(join(root, 'new-file.ts'), 'x')
    await waitFor(() => socket.send.mock.calls.length > 0)

    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'change', path: root }))
    hub.removeSocket(socket as unknown as WsWebSocket)
  })

  it('does not subscribe to an ignored directory itself', async () => {
    const root = tempRoot()
    const nodeModules = join(root, 'node_modules')
    mkdirSync(nodeModules)
    const socket = fakeSocket()
    hub = new FsWatchHub()
    hub.watch(nodeModules, socket as unknown as WsWebSocket, root)
    await waitForWatcherStable()

    writeFileSync(join(nodeModules, 'x.txt'), 'x')
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(socket.send).not.toHaveBeenCalled()
    hub.removeSocket(socket as unknown as WsWebSocket)
  })

  it('still refreshes the parent when an ignored directory is created', async () => {
    const root = tempRoot()
    const socket = fakeSocket()
    hub = new FsWatchHub()
    hub.watch(root, socket as unknown as WsWebSocket, root)
    await waitForWatcherStable()

    mkdirSync(join(root, 'node_modules'))
    await waitFor(() => socket.send.mock.calls.length > 0)

    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'change', path: root }))
    hub.removeSocket(socket as unknown as WsWebSocket)
  })

  it('reference-counts subscribers: one unwatch keeps the other live', async () => {
    const root = tempRoot()
    const first = fakeSocket()
    const second = fakeSocket()
    hub = new FsWatchHub()
    hub.watch(root, first as unknown as WsWebSocket, root)
    hub.watch(root, second as unknown as WsWebSocket, root)
    await waitForWatcherStable()

    writeFileSync(join(root, 'a.ts'), 'x')
    await waitFor(() => first.send.mock.calls.length > 0)

    expect(second.send).toHaveBeenCalled()
    hub.unwatch(root, first as unknown as WsWebSocket)

    writeFileSync(join(root, 'b.ts'), 'y')
    await waitFor(() => second.send.mock.calls.length > 1)

    expect(first.send).toHaveBeenCalledTimes(1)
    hub.removeSocket(second as unknown as WsWebSocket)
  })

  it('does not start new watchers after dispose', async () => {
    const root = tempRoot()
    const socket = fakeSocket()
    hub = new FsWatchHub()
    hub.watch(root, socket as unknown as WsWebSocket, root)
    await waitForWatcherStable()

    hub.dispose()
    writeFileSync(join(root, 'after-dispose.txt'), 'x')
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(socket.send).not.toHaveBeenCalled()
    // Explicit post-dispose watch must be a no-op, not re-create handles.
    hub.watch(root, socket as unknown as WsWebSocket, root)
    writeFileSync(join(root, 'after-post-dispose-watch.txt'), 'x')
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(socket.send).not.toHaveBeenCalled()
  })
})
