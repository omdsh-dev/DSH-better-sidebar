/**
 * FileTree continuity: a second editor tab in the same session/workspace
 * paints resolved tree levels from the shared cache and restores its scroll
 * position in a layout effect, before the browser can show a loading/top
 * frame between file clicks.
 */
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const { fsTree } = vi.hoisted(() => ({
  fsTree: vi.fn(async () => ({
    entries: [{
      name: 'bench.py',
      path: '/workspace/bench.py',
      isDir: false,
      hidden: false,
      isSymlink: false,
      broken: false,
    }],
  })),
}))

vi.mock('../src/client/api.ts', () => ({
  api: { fsTree },
  downloadUrl: () => '/sidebar/file',
}))

function renderTree(root: Root, initialScrollTop = 0, callbacks: {
  onOpenFile?: (path: string) => void
  onScrollTopChange?: (scrollTop: number) => void
} = {}): void {
  root.render(createElement(FileTree, {
    sessionId: 'cache-continuity-session',
    cwd: '/workspace',
    expanded: [],
    onToggle: () => {},
    onOpenFile: callbacks.onOpenFile ?? (() => {}),
    onReferenceFile: () => {},
    refreshTick: 0,
    onUploadRequest: () => {},
    busy: false,
    initialScrollTop,
    onScrollTopChange: callbacks.onScrollTopChange,
  }))
}

describe('FileTree cache continuity', () => {
  it('reuses resolved rows and restores scroll before the second tab paints', async () => {
    const firstContainer = document.createElement('div')
    const firstRoot = createRoot(firstContainer)
    await act(async () => { renderTree(firstRoot) })
    expect(firstContainer.textContent).toContain('bench.py')
    expect(fsTree).toHaveBeenCalledTimes(1)
    act(() => { firstRoot.unmount() })

    const secondContainer = document.createElement('div')
    const secondRoot = createRoot(secondContainer)
    act(() => { renderTree(secondRoot, 320) })
    const body = secondContainer.querySelector<HTMLDivElement>('[class*="explorerBody"]')!
    expect(secondContainer.textContent).toContain('bench.py')
    expect(secondContainer.textContent).not.toContain('Loading…')
    expect(body.scrollTop).toBe(320)
    expect(fsTree).toHaveBeenCalledTimes(1)
    act(() => { secondRoot.unmount() })
  })

  it('opens a mouse-selected file without moving focus or using a stale viewport', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const calls: string[] = []
    await act(async () => {
      renderTree(root, 0, {
        onScrollTopChange: scrollTop => { calls.push(`scroll:${scrollTop}`) },
        onOpenFile: path => { calls.push(`open:${path}`) },
      })
    })
    const body = container.querySelector<HTMLDivElement>('[class*="explorerBody"]')!
    const row = container.querySelector<HTMLElement>('[role="button"][title="/workspace/bench.py"]')!
    body.scrollTop = 320

    const primaryDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
    act(() => { row.dispatchEvent(primaryDown) })
    expect(primaryDown.defaultPrevented).toBe(true)

    act(() => { row.click() })
    expect(calls).toEqual(['scroll:320', 'open:/workspace/bench.py'])

    const secondaryDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 })
    act(() => { row.dispatchEvent(secondaryDown) })
    expect(secondaryDown.defaultPrevented).toBe(false)
    act(() => { root.unmount() })
  })
})
