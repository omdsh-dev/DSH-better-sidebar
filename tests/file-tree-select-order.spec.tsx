/**
 * The Shift range's COORDINATE SPACE: `selectRange` walks
 * `visibleRowsRef.current` and takes the slice between the anchor and the
 * clicked row, so that walk must enumerate rows in the order the user sees
 * them — the tree's sort choice, not the level cache's host order.
 *
 * The fixture is deliberately one where the two orders differ: with type +
 * folders-first-off the rendered order is `beta, zdir, Gamma.MD, alpha.ts`
 * while the host order is `zdir, alpha.ts, beta, Gamma.MD`. The walk keeping
 * the host order selected the wrong set for a visually contiguous range — the
 * batch bar's Copy paths / Zip and download / Delete selected all act on that
 * set, and the delete confirmation shows only a COUNT.
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import type { FileTreeSort } from '../src/client/file-tree-sort.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so the bar's copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const { fsTrees } = vi.hoisted(() => ({
  fsTrees: vi.fn(async (_scope: unknown, paths: readonly string[]) => ({
    levels: paths.map(path => ({
      path,
      entries: path === '/tmp' ? HOST_ORDER_ROWS : [],
      truncated: false,
    })),
  })),
}))

vi.mock('../src/client/api.ts', () => ({
  api: { fsTrees, gitStatus: async () => ({ isRepo: false, entries: [] }) },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

/** The fixture as the host ships it (the hoisted mock cannot close over it). */
const HOST_ORDER_ROWS = [
  { name: 'zdir', path: '/tmp/zdir', isDir: true },
  { name: 'alpha.ts', path: '/tmp/alpha.ts', isDir: false },
  { name: 'beta', path: '/tmp/beta', isDir: false },
  { name: 'Gamma.MD', path: '/tmp/Gamma.MD', isDir: false },
]

interface Harness {
  container: HTMLDivElement
  unmount: () => void
}

/** The root level's child rows, in render order. */
function renderedNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('[class*="explorerRow"]')]
    .filter(el => el.style.paddingLeft === '28px')
    .map(el => el.querySelector('[class*="explorerName"]')?.textContent ?? '')
}

/** The names of the rows rendered as SELECTED, in render order. */
function selectedNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('[class*="explorerRow"]')]
    .filter(el => el.getAttribute('data-dsh-selected') === 'true')
    .map(el => el.querySelector('[class*="explorerName"]')?.textContent ?? '')
}

/** One row by its displayed name. */
function rowByName(container: HTMLElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row not found: ${name}`)
  return row
}

function click(el: Element, init: MouseEventInit): void {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init })) })
}

let harness: Harness | undefined

afterEach(() => {
  harness?.unmount()
  harness = undefined
  document.body.innerHTML = ''
  fsTrees.mockClear()
})

describe('FileTree Shift range under a non-default sort', () => {
  function mountTree(sort: FileTreeSort): Harness {
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    act(() => {
      root.render(createElement(FileTree, {
        sessionId: 's1',
        cwd: '/tmp',
        expanded: [],
        revealed: [],
        onToggle: () => {},
        onOpenFile: () => {},
        onReferenceFile: () => {},
        refreshTick: 0,
        onUploadRequest: () => {},
        busy: false,
        sort,
      }))
    })
    return { container, unmount: () => { act(() => { root.unmount() }); container.remove() } }
  }

  it('covers the visually contiguous rows when the rendered order is not the host order', async () => {
    harness = mountTree({ key: 'type', dirsFirst: false })
    await act(async () => {})
    // The premise of the case: the rendered order really is the type order,
    // so rows 1..3 are beta / zdir / Gamma.MD.
    expect(renderedNames(harness.container)).toEqual(['beta', 'zdir', 'Gamma.MD', 'alpha.ts'])

    // Ctrl on the FIRST row seats the anchor, Shift on the THIRD one ranges to
    // it — the three rows the user sees between them are all selected.
    click(rowByName(harness.container, 'beta'), { ctrlKey: true })
    click(rowByName(harness.container, 'Gamma.MD'), { shiftKey: true })
    expect(selectedNames(harness.container)).toEqual(['beta', 'zdir', 'Gamma.MD'])
    // The row OUTSIDE the range stays out of it.
    expect(selectedNames(harness.container)).not.toContain('alpha.ts')
  })

  it('follows the default order too (the range is not merely "everything")', async () => {
    harness = mountTree({ key: 'name', dirsFirst: true })
    await act(async () => {})
    expect(renderedNames(harness.container)).toEqual(['zdir', 'alpha.ts', 'beta', 'Gamma.MD'])

    click(rowByName(harness.container, 'alpha.ts'), { ctrlKey: true })
    click(rowByName(harness.container, 'beta'), { shiftKey: true })
    expect(selectedNames(harness.container)).toEqual(['alpha.ts', 'beta'])
  })
})
