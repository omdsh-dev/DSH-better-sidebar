/**
 * "Show in folder" reveal scrolling: the tree body is the ONLY thing that
 * may scroll. The reveal used native scrollIntoView, which scrolls every
 * scrollable ancestor — and the clipping fixed panel host
 * ([data-dsh-panel-host], overflow hidden at the time) is still
 * programmatically scrollable, so a deep reveal shifted the whole panel,
 * tab bar included, out of the viewport (reported on DSH 0.1.2-alpha.1).
 * The regression guard: body.scrollTo receives the centered, clamped
 * target; row.scrollIntoView is never called.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// jsdom defines no scrollIntoView; counting calls needs a real function.
const scrollIntoView = vi.fn()
beforeAll(() => {
  ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = scrollIntoView
})
afterEach(() => { scrollIntoView.mockClear() })

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTree: async () => ({
      entries: [
        { name: 'src', path: '/tmp/src', isDir: true },
        { name: 'a.ts', path: '/tmp/a.ts', isDir: false },
      ],
    }),
  },
  downloadUrl: () => '/sidebar/file',
}))

interface TreeHarness {
  /** Re-render with new props; the refresh tick reloads the level cache. */
  rerender: (revealed: string[], refreshTick: number) => Promise<void>
  body: HTMLElement
  /** Pin one row's geometry (jsdom has no layout). */
  layoutRow: (top: number, height: number) => void
  scrollTo: ReturnType<typeof vi.fn>
  unmount: () => void
}

async function mountTree(bodyScroll: { top: number; client: number; height: number }): Promise<TreeHarness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const render = (revealed: string[], refreshTick: number): void => {
    root.render(createElement(FileTree, {
      sessionId: 's1',
      cwd: '/tmp',
      expanded: [],
      revealed,
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
      refreshTick,
      onUploadRequest: () => {},
      busy: false,
    }))
  }
  await act(async () => { render([], 0) })
  const body = container.firstElementChild as HTMLElement
  const scrollTo = vi.fn()
  Object.defineProperty(body, 'scrollTo', { value: scrollTo })
  Object.defineProperty(body, 'getBoundingClientRect', { value: () => ({ top: 100, height: bodyScroll.client }) })
  Object.defineProperty(body, 'clientHeight', { value: bodyScroll.client })
  Object.defineProperty(body, 'scrollHeight', { value: bodyScroll.height })
  Object.defineProperty(body, 'scrollTop', { value: bodyScroll.top, writable: true })
  return {
    rerender: async (revealed, refreshTick) => { await act(async () => { render(revealed, refreshTick) }) },
    body,
    layoutRow: (top, height) => {
      const row = body.querySelector('[data-dsh-revealed]')
      expect(row).not.toBeNull()
      Object.defineProperty(row as Element, 'getBoundingClientRect', { value: () => ({ top, height }) })
    },
    scrollTo,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

afterEach(() => { document.body.innerHTML = '' })

describe('FileTree reveal scrolling (show in folder)', () => {
  it('centers the revealed row in the tree body only', async () => {
    // Body: top 100, 300 tall, scrolled 40; row lands at 400, 20 tall →
    // target = 40 + (400 + 10) − (100 + 150) = 200.
    const tree = await mountTree({ top: 40, client: 300, height: 1000 })
    await tree.rerender(['/tmp/a.ts'], 0)
    tree.layoutRow(400, 20)
    await tree.rerender(['/tmp/a.ts'], 1)
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(tree.scrollTo.mock.calls.map(call => call[0])).toContainEqual({ top: 200, behavior: 'smooth' })
    tree.unmount()
  })

  it('clamps the target to the scrollable range', async () => {
    // 5000px-tall scroller with 300 visible: max scrollTop 4700.
    const tree = await mountTree({ top: 0, client: 300, height: 5000 })
    await tree.rerender(['/tmp/a.ts'], 0)
    tree.layoutRow(9000, 20)
    await tree.rerender(['/tmp/a.ts'], 1)
    expect(tree.scrollTo.mock.calls.map(call => call[0]?.top)).toContainEqual(4700)
    tree.unmount()
  })

  it('scrolls nothing without a reveal', async () => {
    const tree = await mountTree({ top: 0, client: 300, height: 1000 })
    await tree.rerender([], 1)
    expect(tree.scrollTo).not.toHaveBeenCalled()
    tree.unmount()
  })
})
