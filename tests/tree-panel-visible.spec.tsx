/**
 * TreePanel auto-refresh visibility: a hidden/non-active editor tab must not
 * open a workspace watcher WebSocket. Only a visible tab with autoRefresh
 * enabled should connect.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TreePanel } from '../src/client/TreePanel.tsx'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  url: string
  closed = false
  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }
  close(): void { this.closed = true }
}

;(globalThis as Record<string, unknown>).WebSocket = FakeWebSocket

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTree: async () => ({ entries: [] }),
    fsSearch: async () => ({ matches: [], truncated: false }),
  },
  downloadUrl: () => '/sidebar/file',
}))

let container: HTMLDivElement
let root: Root
let visible: boolean

function render(): void {
  root.render(createElement(TreePanel, {
    sessionId: 's1',
    cwd: '/tmp',
    expanded: [],
    onToggle: () => {},
    onOpenFile: () => {},
    onReferenceFile: () => {},
    autoRefresh: true,
    visible,
  }))
}

beforeEach(async () => {
  FakeWebSocket.instances = []
  visible = false
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => { render() })
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('TreePanel watcher visibility', () => {
  it('does not open a WebSocket while the tab is hidden', () => {
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('opens the watcher when the tab becomes visible', async () => {
    visible = true
    await act(async () => { render() })
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0]!.url).toContain('/sidebar/ws/fs-events')
  })

  it('closes the watcher when the tab becomes hidden again', async () => {
    visible = true
    await act(async () => { render() })
    expect(FakeWebSocket.instances).toHaveLength(1)

    visible = false
    await act(async () => { render() })
    // The cleanup from the visible effect closes the socket; a new effect
    // returns early, so no second socket is created.
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0]!.closed).toBe(true)
  })
})
