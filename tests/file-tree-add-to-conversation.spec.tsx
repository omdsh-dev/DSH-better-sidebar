/**
 * FileTree's row-menu "add to conversation" entry: the caller hands down
 * `onAddToConversation`, the menu offers one row for both files and
 * directories, and clicking it hands back the row's absolute path. A caller
 * that does not wire the callback (an external tab component, an older mount)
 * keeps exactly the menu it rendered before — the row is not drawn at all.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import { setupReactAct } from './test-utils.ts'

setupReactAct()

// Pin en-US so the menu copy is the English dictionary (as in the sibling
// FileTree menu specs).
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees: async (_scope: unknown, paths: readonly string[]) => ({
      levels: paths.map(path => ({
        path,
        entries: [
          { name: 'sub', path: '/tmp/sub', isDir: true },
          { name: 'a.ts', path: '/tmp/a.ts', isDir: false },
        ],
        truncated: false,
      })),
    }),
    gitStatus: async () => ({ isRepo: false, entries: [] }),
  },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

interface Harness {
  container: HTMLDivElement
  onAddToConversation: ReturnType<typeof vi.fn>
  unmount: () => void
}

async function mountTree(withCallback: boolean): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const onAddToConversation = vi.fn()
  await act(async () => {
    root.render(createElement(FileTree, {
      sessionId: 's1',
      cwd: '/tmp',
      expanded: [],
      revealed: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
      ...(withCallback ? { onAddToConversation } : {}),
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
    }))
    await Promise.resolve()
  })
  return {
    container,
    onAddToConversation,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/** One row of the mounted tree, matched by its displayed name. */
function row(container: HTMLDivElement, name: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('[class*="explorerRow"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (found === undefined) throw new Error(`row not found: ${name}`)
  return found
}

/** Open a row's context menu at a fixed cursor position. */
function openMenu(container: HTMLDivElement, name: string): void {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })
  act(() => { row(container, name).dispatchEvent(event) })
}

/** The visible menu rows, in DOM order. */
function menuLabels(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .map(item => item.textContent?.trim() ?? '')
}

/** Click the row whose label matches exactly. */
function clickRow(label: string): void {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(el => el.textContent?.trim() === label)
  if (item === undefined) throw new Error(`menu row not found: ${label}`)
  act(() => { item.click() })
}

describe('FileTree add-to-conversation row', () => {
  let harness: Harness

  afterEach(() => {
    harness.unmount()
    document.body.innerHTML = ''
  })

  it('offers the row for a file and hands back its absolute path', async () => {
    harness = await mountTree(true)
    openMenu(harness.container, 'a.ts')
    expect(menuLabels()).toContain('Add to conversation')
    clickRow('Add to conversation')
    expect(harness.onAddToConversation).toHaveBeenCalledTimes(1)
    expect(harness.onAddToConversation).toHaveBeenCalledWith('/tmp/a.ts', false)
  })

  it('claims directory rows too, with `isDir` set', async () => {
    harness = await mountTree(true)
    openMenu(harness.container, 'sub')
    clickRow('Add to conversation')
    expect(harness.onAddToConversation).toHaveBeenCalledWith('/tmp/sub', true)
  })

  it('draws no row when the caller did not wire the callback', async () => {
    harness = await mountTree(false)
    openMenu(harness.container, 'a.ts')
    expect(menuLabels()).not.toContain('Add to conversation')
    // The menu still opened: copy rows are always there.
    expect(menuLabels()).toContain('Copy relative path')
  })
})