/**
 * FileTree "new folder": the directory rows (and the workspace root row)
 * offer it in the context menu; choosing it inserts the inline editor at the
 * TOP of that level (expanding a collapsed directory first), and the editor
 * follows the rename contract — Enter commits through `api.fsMkdir` with the
 * parent directory + single-segment name, Escape cancels, blur commits, an
 * invalid name reports `newFolderInvalid` and never reaches the API, and a
 * server failure lands in the dismissable strip.
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so menu copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const { fsMkdir, fsTrees } = vi.hoisted(() => ({
  fsMkdir: vi.fn(async (_scope: unknown, _path: string, name: string) => ({ path: `/tmp/${name}` })),
  // `listingFor` is a hoisted function declaration, so the factory may
  // reference it; it only runs when the mock is called (after module init).
  fsTrees: vi.fn(async (_scope: unknown, paths: readonly string[]) => ({ levels: paths.map(path => listingFor(path)) })),
}))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees,
    fsMkdir,
    // The tree reads the shared git-status store; a non-repo answer keeps
    // every row plain (this spec is about folder creation).
    gitStatus: async () => ({ isRepo: false, entries: [] }),
  },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

const ROOT_ENTRIES = [
  { name: 'sub', path: '/tmp/sub', isDir: true },
  { name: 'a.ts', path: '/tmp/a.ts', isDir: false },
]

/** Per-directory listings: /tmp/sub must NOT list itself (a real host never
 *  returns a directory inside its own listing). */
function listingFor(path: string): { path: string; entries: typeof ROOT_ENTRIES; truncated: boolean } {
  return {
    path,
    entries: path === '/tmp/sub' ? [{ name: 'inner.txt', path: '/tmp/sub/inner.txt', isDir: false }] : ROOT_ENTRIES,
    truncated: false,
  }
}

interface Harness {
  container: HTMLDivElement
  /** Directories the tree asked the caller to expand/collapse. */
  toggled: string[]
  unmount: () => void
}

/**
 * The real caller owns the expansion set (EditorHost holds it in the store),
 * so the harness does too: a toggle really expands the tree and loads the
 * level beneath it.
 */
function mountTree(initialExpanded: string[] = []): Harness {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const toggled: string[] = []
  function Host(): ReactNode {
    const [expanded, setExpanded] = useState<string[]>(initialExpanded)
    return createElement(FileTree, {
      sessionId: 's1',
      cwd: '/tmp',
      expanded,
      revealed: [],
      onToggle: (path: string) => {
        toggled.push(path)
        setExpanded(current => current.includes(path) ? current.filter(item => item !== path) : [...current, path])
      },
      onOpenFile: () => {},
      onReferenceFile: () => {},
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
    })
  }
  act(() => { root.render(createElement(Host)) })
  return {
    container,
    toggled,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/** One tree row by its displayed name (the root row included). */
function rowByName(container: HTMLElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[class*="explorerRow"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row not found: ${name}`)
  return row
}

function openMenu(container: HTMLElement, name: string): void {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })
  act(() => { rowByName(container, name).dispatchEvent(event) })
}

function menuLabels(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(el => el.textContent ?? '')
}

function clickMenuitem(label: string): void {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(el => el.textContent === label)
  if (item === undefined) throw new Error(`menuitem not found: ${label}`)
  act(() => { item.click() })
}

/** Set a controlled input's value the React way (native setter + input). */
function setNativeValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('no native value setter')
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function pressKey(el: HTMLElement, key: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

function editorInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[class*="explorerRenameInput"]')
  if (input === null) throw new Error('inline editor not rendered')
  return input
}

/** The editor row's indent (depth * 22 + 6) — proof of WHICH level hosts it. */
function editorIndent(container: HTMLElement): string {
  return editorInput(container).closest<HTMLElement>('[class*="explorerRow"]')?.style.paddingLeft ?? ''
}

let harness: Harness
afterEach(() => {
  harness.unmount()
  document.body.innerHTML = ''
  fsMkdir.mockReset()
  fsMkdir.mockImplementation(async (_scope: unknown, _path: string, name: string) => ({ path: `/tmp/${name}` }))
  fsTrees.mockReset()
  fsTrees.mockImplementation(async (_scope: unknown, paths: readonly string[]) => ({ levels: paths.map(path => listingFor(path)) }))
})

describe('FileTree new folder', () => {
  it('offers the entry on directory rows (the root included, never on files)', async () => {
    harness = mountTree()
    await act(async () => {})
    openMenu(harness.container, 'sub')
    expect(menuLabels()).toContain('New folder')
    openMenu(harness.container, 'tmp')
    expect(menuLabels()).toContain('New folder')
    openMenu(harness.container, 'a.ts')
    expect(menuLabels()).not.toContain('New folder')
  })

  it('inserts the editor at the root level and commits through api.fsMkdir', async () => {
    harness = mountTree()
    await act(async () => {})
    openMenu(harness.container, 'tmp')
    clickMenuitem('New folder')
    const input = editorInput(harness.container)
    expect(input.placeholder).toBe('Folder name')
    // The root level's rows sit at depth 1 (22 + 6); the editor replaces the
    // level's first row.
    expect(editorIndent(harness.container)).toBe('28px')
    setNativeValue(input, 'newdir')
    const listings = fsTrees.mock.calls.length
    await act(async () => { pressKey(input, 'Enter') })
    expect(fsMkdir).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp', 'newdir')
    expect(harness.container.querySelector('input[class*="explorerRenameInput"]')).toBeNull()
    // The level was dropped and re-listed, so the new folder shows up.
    expect(fsTrees.mock.calls.length).toBeGreaterThan(listings)
  })

  it('expands a collapsed directory, edits at ITS level, and creates there', async () => {
    harness = mountTree()
    await act(async () => {})
    openMenu(harness.container, 'sub')
    clickMenuitem('New folder')
    // The collapsed directory is expanded so its level can host the editor.
    expect(harness.toggled).toEqual(['/tmp/sub'])
    expect(editorIndent(harness.container)).toBe('50px')
    setNativeValue(editorInput(harness.container), 'inner')
    await act(async () => { pressKey(editorInput(harness.container), 'Enter') })
    expect(fsMkdir).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp/sub', 'inner')
  })

  it('Escape cancels without touching the API', async () => {
    harness = mountTree()
    await act(async () => {})
    openMenu(harness.container, 'tmp')
    clickMenuitem('New folder')
    const input = editorInput(harness.container)
    setNativeValue(input, 'newdir')
    await act(async () => { pressKey(input, 'Escape') })
    expect(fsMkdir).not.toHaveBeenCalled()
    expect(harness.container.querySelector('input[class*="explorerRenameInput"]')).toBeNull()
  })

  it('rejects an invalid name client-side with the strip, no API call', async () => {
    harness = mountTree()
    await act(async () => {})
    openMenu(harness.container, 'tmp')
    clickMenuitem('New folder')
    const input = editorInput(harness.container)
    setNativeValue(input, 'a/b')
    await act(async () => { pressKey(input, 'Enter') })
    expect(fsMkdir).not.toHaveBeenCalled()
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('Invalid folder name')
  })

  it('lands a server refusal in the dismissable strip', async () => {
    fsMkdir.mockRejectedValueOnce(new Error('boom: exists'))
    harness = mountTree()
    await act(async () => {})
    openMenu(harness.container, 'tmp')
    clickMenuitem('New folder')
    const input = editorInput(harness.container)
    setNativeValue(input, 'sub')
    await act(async () => { pressKey(input, 'Enter') })
    expect(fsMkdir).toHaveBeenCalledTimes(1)
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('boom: exists')
  })

  it('commits on blur (the same contract the rename editor has)', async () => {
    harness = mountTree()
    await act(async () => {})
    openMenu(harness.container, 'tmp')
    clickMenuitem('New folder')
    const input = editorInput(harness.container)
    setNativeValue(input, 'blurred')
    // React delegates onBlur from the native focusout event.
    await act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(fsMkdir).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp', 'blurred')
  })
})
