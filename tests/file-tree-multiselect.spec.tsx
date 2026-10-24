/**
 * FileTree multi-selection (VS Code semantics): Ctrl/Cmd+click toggles one
 * row and seats the Shift anchor, Shift+click selects the visible range from
 * that anchor, Escape and a blank click clear the selection, and a right
 * click outside the selection collapses it onto the row. A non-empty
 * selection shows the batch bar (count + copy paths / delete / clear); the
 * batch delete confirms once, removes sequentially, and stops on the first
 * failure with the error strip.
 *
 * The other half of the contract is what must NOT change: an unmodified click
 * still opens a file / toggles a directory and drops the selection.
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so the bar's copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const { fsRemove, fsTrees } = vi.hoisted(() => ({
  fsRemove: vi.fn(async (_scope: unknown, path: string) => ({ path })),
  // One BATCHED list call answers every requested level with the same shape.
  fsTrees: vi.fn(async (_scope: unknown, paths: readonly string[]) => ({
    levels: paths.map(path => ({
      path,
      entries: [
        { name: 'sub', path: '/tmp/sub', isDir: true },
        { name: 'a.ts', path: '/tmp/a.ts', isDir: false },
        { name: 'b.ts', path: '/tmp/b.ts', isDir: false },
      ],
      truncated: false,
    })),
  })),
}))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees,
    fsRemove,
    // The tree reads the shared git-status store; a non-repo answer keeps
    // every row plain (this spec is about the selection).
    gitStatus: async () => ({ isRepo: false, entries: [] }),
  },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

interface Harness {
  container: HTMLDivElement
  opened: string[]
  toggled: string[]
  unmount: () => void
}

async function mountTree(expanded: string[] = []): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const opened: string[] = []
  const toggled: string[] = []
  await act(async () => {
    root.render(createElement(FileTree, {
      sessionId: 's1',
      cwd: '/tmp',
      expanded,
      revealed: [],
      onToggle: (path: string) => { toggled.push(path) },
      onOpenFile: (path: string) => { opened.push(path) },
      onReferenceFile: () => {},
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
    }))
  })
  return {
    container,
    opened,
    toggled,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/** One tree row by its displayed name. */
function rowByName(container: HTMLElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row not found: ${name}`)
  return row
}

function click(el: Element, init: MouseEventInit = {}): void {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init })) })
}

function rightClick(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
  })
}

function pressEscape(el: Element): void {
  act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
}

/** The batch bar (the kit's section band carries the page class). */
function selectionBar(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[class*="explorerSelectionBar"]')
}

/** The names of the rows currently rendered as selected. */
function selectedNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('[class*="explorerRowSelected"]')]
    .map(row => row.querySelector('[class*="explorerName"]')?.textContent ?? '')
}

/** One batch-bar action by its label. */
function barAction(container: HTMLElement, label: string): HTMLElement {
  const button = [...(selectionBar(container)?.querySelectorAll<HTMLElement>('button') ?? [])]
    .find(el => el.textContent === label)
  if (button === undefined) throw new Error(`bar action not found: ${label}`)
  return button
}

let harness: Harness
afterEach(() => {
  harness.unmount()
  document.body.innerHTML = ''
  fsRemove.mockReset()
  fsRemove.mockImplementation(async (_scope: unknown, path: string) => ({ path }))
  fsTrees.mockClear()
})

describe('FileTree multi-selection', () => {
  it('keeps the unmodified click semantics and drops the selection', async () => {
    harness = await mountTree()
    click(rowByName(harness.container, 'a.ts'), { ctrlKey: true })
    expect(selectionBar(harness.container)).not.toBeNull()
    // A plain click opens the file (and clears the batch).
    click(rowByName(harness.container, 'b.ts'))
    expect(harness.opened).toEqual(['/tmp/b.ts'])
    expect(selectionBar(harness.container)).toBeNull()
    // A plain click on a directory row still toggles it.
    click(rowByName(harness.container, 'sub'))
    expect(harness.toggled).toEqual(['/tmp/sub'])
    expect(harness.opened).toEqual(['/tmp/b.ts'])
  })

  it('Ctrl/Cmd+click toggles rows and the bar counts them', async () => {
    harness = await mountTree()
    click(rowByName(harness.container, 'a.ts'), { ctrlKey: true })
    expect(selectedNames(harness.container)).toEqual(['a.ts'])
    expect(selectionBar(harness.container)?.textContent).toContain('1 selected')
    click(rowByName(harness.container, 'b.ts'), { metaKey: true })
    expect(selectedNames(harness.container)).toEqual(['a.ts', 'b.ts'])
    expect(selectionBar(harness.container)?.textContent).toContain('2 selected')
    // Toggling the same row off again leaves exactly the other one.
    click(rowByName(harness.container, 'b.ts'), { ctrlKey: true })
    expect(selectedNames(harness.container)).toEqual(['a.ts'])
  })

  it('Shift+click selects the visible range from the Ctrl-seated anchor', async () => {
    harness = await mountTree()
    // The anchor is 'b.ts' (the last visible row), so the range reaches 'a.ts'.
    click(rowByName(harness.container, 'b.ts'), { ctrlKey: true })
    click(rowByName(harness.container, 'a.ts'), { shiftKey: true })
    expect(selectedNames(harness.container)).toEqual(['a.ts', 'b.ts'])
    // A collapsed directory between two rows is part of the visible order.
    click(rowByName(harness.container, 'sub'), { shiftKey: true })
    expect(selectedNames(harness.container)).toEqual(['sub', 'a.ts', 'b.ts'])
  })

  it('Escape, the bar\'s Clear selection, and a click on the tree body all clear the selection', async () => {
    harness = await mountTree()
    click(rowByName(harness.container, 'a.ts'), { ctrlKey: true })
    pressEscape(harness.container.querySelector('[class*="explorerBody"]')!)
    expect(selectionBar(harness.container)).toBeNull()
    click(rowByName(harness.container, 'a.ts'), { ctrlKey: true })
    act(() => { barAction(harness.container, 'Clear selection').click() })
    expect(selectionBar(harness.container)).toBeNull()
    click(rowByName(harness.container, 'a.ts'), { ctrlKey: true })
    click(harness.container.querySelector('[class*="explorerBody"]')!)
    expect(selectionBar(harness.container)).toBeNull()
  })

  it('right-click collapses the selection onto an unselected row and keeps a selected one', async () => {
    harness = await mountTree()
    click(rowByName(harness.container, 'a.ts'), { ctrlKey: true })
    click(rowByName(harness.container, 'b.ts'), { ctrlKey: true })
    // The row is already part of the selection: the whole batch survives.
    rightClick(rowByName(harness.container, 'b.ts'))
    expect(selectedNames(harness.container)).toEqual(['a.ts', 'b.ts'])
    // An unselected row collapses the batch onto itself.
    rightClick(rowByName(harness.container, 'sub'))
    expect(selectedNames(harness.container)).toEqual(['sub'])
  })

  it('copies every selected absolute path, newline separated', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true })
    harness = await mountTree()
    click(rowByName(harness.container, 'a.ts'), { ctrlKey: true })
    click(rowByName(harness.container, 'b.ts'), { ctrlKey: true })
    await act(async () => { barAction(harness.container, 'Copy paths').click() })
    expect(writeText).toHaveBeenCalledWith('/tmp/a.ts\n/tmp/b.ts')
  })

  it('deletes the whole selection through one confirmation, sequentially', async () => {
    harness = await mountTree()
    click(rowByName(harness.container, 'a.ts'), { ctrlKey: true })
    click(rowByName(harness.container, 'b.ts'), { ctrlKey: true })
    act(() => { barAction(harness.container, 'Delete selected').click() })
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Delete 2 selected items?')
    const confirm = [...document.querySelectorAll<HTMLElement>('button')]
      .find(el => el.textContent === 'Delete selected' && el.closest('[role="dialog"]') !== null)!
    await act(async () => { confirm.click() })
    expect(fsRemove.mock.calls.map(call => call[1])).toEqual(['/tmp/a.ts', '/tmp/b.ts'])
    expect(selectionBar(harness.container)).toBeNull()
  })

  it('docks the batch bar at the BOTTOM of the tree scroll container', async () => {
    harness = await mountTree()
    click(rowByName(harness.container, 'a.ts'), { ctrlKey: true })
    const body = harness.container.querySelector<HTMLElement>('[class*="explorerBody"]')!
    const bar = harness.container.querySelector<HTMLElement>('[class*="explorerSelectionBar"]')!
    // In flow AFTER every row (the menu's portal anchor and the hidden file
    // input are the only trailing siblings) — never absolutely positioned
    // over the rows, so scrolled to the bottom it sits BELOW the last row.
    const rows = [...body.querySelectorAll<HTMLElement>('[class*="explorerRow"]')]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[rows.length - 1]!.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The only trailing siblings are the menu's portal anchor and the hidden
    // file input, so the bar IS the last piece of tree content.
    const content = [...body.children].filter(child =>
      child.tagName !== 'INPUT' && !(child as HTMLElement).className.includes('_root_'))
    expect(content[content.length - 1]).toBe(bar)
    // jsdom has no layout: the sheet is the evidence for the docking mechanic.
    const sheet = readFileSync('src/client/sidebar.module.css', 'utf8')
    const rule = sheet.match(/\.explorerSelectionBar \{([\s\S]*?)\n\}/)?.[1]
    expect(rule, 'the .explorerSelectionBar rule must exist').toBeDefined()
    expect(rule).toContain('position: sticky')
    expect(rule).toContain('bottom: 0')
    expect(rule).not.toContain('position: absolute')
    expect(rule).not.toContain('position: fixed')
    // Narrow panels WRAP the chips instead of clipping them or scrolling.
    const actions = sheet.match(/\.explorerSelectionActions \{([\s\S]*?)\n\}/)?.[1]
    expect(actions).toContain('flex-wrap: wrap')
  })

  it('stops the batch at the first failure and reports it in the strip', async () => {
    // The first path lands; the second refuses — the walk must stop there.
    fsRemove
      .mockImplementationOnce(async (_scope: unknown, path: string) => ({ path }))
      .mockRejectedValueOnce(new Error('boom: refused'))
    harness = await mountTree()
    click(rowByName(harness.container, 'a.ts'), { ctrlKey: true })
    click(rowByName(harness.container, 'b.ts'), { ctrlKey: true })
    act(() => { barAction(harness.container, 'Delete selected').click() })
    const confirm = [...document.querySelectorAll<HTMLElement>('button')]
      .find(el => el.textContent === 'Delete selected' && el.closest('[role="dialog"]') !== null)!
    await act(async () => { confirm.click() })
    // Two attempts, in selection order, and nothing after the refusal.
    expect(fsRemove.mock.calls.map(call => call[1])).toEqual(['/tmp/a.ts', '/tmp/b.ts'])
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('boom: refused')
    // The removed row left the selection; the refused one stays for a retry.
    expect(selectedNames(harness.container)).toEqual(['b.ts'])
  })
})
