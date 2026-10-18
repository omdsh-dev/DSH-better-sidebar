/**
 * FileTree "new file": the directory rows (and the workspace root row) offer
 * it in the context menu beside "New folder"; choosing it inserts the inline
 * editor at the TOP of that level (expanding a collapsed directory first), and
 * the editor follows the rename contract — Enter commits through
 * `api.fsCreateFile` with the parent directory + single-segment name, Escape
 * cancels, blur commits, an invalid name reports `newFileInvalid`, a name the
 * level already lists is refused client-side with `newFileExists`, and any
 * other server refusal lands in the dismissable strip. The two inline creators
 * (folder / file) are mutually exclusive.
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree, joinChild, nameTaken } from '../src/client/FileTree.tsx'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so menu copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const { fsCreateFile, fsMkdir, fsTrees } = vi.hoisted(() => ({
  fsCreateFile: vi.fn(async (_scope: unknown, _path: string, name: string) => ({ path: `/tmp/${name}` })),
  fsMkdir: vi.fn(async (_scope: unknown, _path: string, name: string) => ({ path: `/tmp/${name}` })),
  // `listingFor` is a hoisted function declaration, so the factory may
  // reference it; it only runs when the mock is called (after module init).
  fsTrees: vi.fn(async (_scope: unknown, paths: readonly string[]) => ({ levels: paths.map(path => listingFor(path)) })),
}))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees,
    fsCreateFile,
    fsMkdir,
    // The tree reads the shared git-status store; a non-repo answer keeps
    // every row plain (this spec is about file creation).
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

/** Every inline editor input currently rendered (folder and file alike). */
function editorInputs(container: HTMLElement): HTMLInputElement[] {
  return [...container.querySelectorAll<HTMLInputElement>('input[class*="explorerRenameInput"]')]
}

function editorInput(container: HTMLElement): HTMLInputElement {
  const input = editorInputs(container)[0]
  if (input === undefined) throw new Error('inline editor not rendered')
  return input
}

/** The editor row's indent (depth * 22 + 6) — proof of WHICH level hosts it. */
function editorIndent(container: HTMLElement): string {
  return editorInput(container).closest<HTMLElement>('[class*="explorerRow"]')?.style.paddingLeft ?? ''
}

let harness: Harness
afterEach(() => {
  // The pure-helper cases never mount a tree; every other case assigns first.
  const tree: Harness | undefined = harness
  tree?.unmount()
  document.body.innerHTML = ''
  fsCreateFile.mockReset()
  fsCreateFile.mockImplementation(async (_scope: unknown, _path: string, name: string) => ({ path: `/tmp/${name}` }))
  fsMkdir.mockReset()
  fsMkdir.mockImplementation(async (_scope: unknown, _path: string, name: string) => ({ path: `/tmp/${name}` }))
  fsTrees.mockReset()
  fsTrees.mockImplementation(async (_scope: unknown, paths: readonly string[]) => ({ levels: paths.map(path => listingFor(path)) }))
})

describe('FileTree new file helpers', () => {
  it('joinChild appends one segment without doubling the separator', () => {
    expect(joinChild('/tmp', 'a.ts')).toBe('/tmp/a.ts')
    expect(joinChild('/tmp/', 'a.ts')).toBe('/tmp/a.ts')
    expect(joinChild('C:\\tmp\\', 'a.ts')).toBe('C:\\tmp/a.ts')
  })

  it('nameTaken compares case-insensitively and answers false for an unloaded level', () => {
    const entries = [{ name: 'a.ts' }, { name: 'Sub' }]
    expect(nameTaken(entries, 'a.ts')).toBe(true)
    expect(nameTaken(entries, 'A.TS')).toBe(true)
    expect(nameTaken(entries, 'sub')).toBe(true)
    expect(nameTaken(entries, 'b.ts')).toBe(false)
    expect(nameTaken(undefined, 'a.ts')).toBe(false)
  })
})

describe('FileTree new file', () => {
  it('offers the entry on directory rows (the root included, never on files)', async () => {
    harness = mountTree()
    await act(async () => {})
    openMenu(harness.container, 'sub')
    expect(menuLabels()).toContain('New file')
    openMenu(harness.container, 'tmp')
    expect(menuLabels()).toContain('New file')
    openMenu(harness.container, 'a.ts')
    expect(menuLabels()).not.toContain('New file')
  })

  it('inserts the editor at the root level and commits through api.fsCreateFile', async () => {
    harness = mountTree()
    await act(async () => {})
    openMenu(harness.container, 'tmp')
    clickMenuitem('New file')
    const input = editorInput(harness.container)
    expect(input.placeholder).toBe('File name')
    // The root level's rows sit at depth 1 (22 + 6); the editor replaces the
    // level's first row.
    expect(editorIndent(harness.container)).toBe('28px')
    setNativeValue(input, 'fresh.ts')
    const listings = fsTrees.mock.calls.length
    await act(async () => { pressKey(input, 'Enter') })
    expect(fsCreateFile).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp', 'fresh.ts')
    expect(editorInputs(harness.container)).toHaveLength(0)
    // The level was dropped and re-listed, so the new file shows up.
    expect(fsTrees.mock.calls.length).toBeGreaterThan(listings)
  })

  it('expands a collapsed directory, edits at ITS level, and creates there', async () => {
    harness = mountTree()
    await act(async () => {})
    openMenu(harness.container, 'sub')
    clickMenuitem('New file')
    // The collapsed directory is expanded so its level can host the editor.
    expect(harness.toggled).toEqual(['/tmp/sub'])
    expect(editorIndent(harness.container)).toBe('50px')
    setNativeValue(editorInput(harness.container), 'inner2.txt')
    await act(async () => { pressKey(editorInput(harness.container), 'Enter') })
    expect(fsCreateFile).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp/sub', 'inner2.txt')
  })

  it('Escape cancels without touching the API', async () => {
    harness = mountTree()
    await act(async () => {})
    openMenu(harness.container, 'tmp')
    clickMenuitem('New file')
    const input = editorInput(harness.container)
    setNativeValue(input, 'fresh.ts')
    await act(async () => { pressKey(input, 'Escape') })
    expect(fsCreateFile).not.toHaveBeenCalled()
    expect(editorInputs(harness.container)).toHaveLength(0)
  })

  it('rejects an invalid name client-side with the strip, no API call', async () => {
    harness = mountTree()
    await act(async () => {})
    openMenu(harness.container, 'tmp')
    clickMenuitem('New file')
    const input = editorInput(harness.container)
    setNativeValue(input, 'a/b')
    await act(async () => { pressKey(input, 'Enter') })
    expect(fsCreateFile).not.toHaveBeenCalled()
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('Invalid file name')
  })

  it('refuses a name the level already lists (case-insensitively) without a round trip', async () => {
    harness = mountTree()
    await act(async () => {})
    openMenu(harness.container, 'tmp')
    clickMenuitem('New file')
    const input = editorInput(harness.container)
    setNativeValue(input, 'A.TS')
    await act(async () => { pressKey(input, 'Enter') })
    expect(fsCreateFile).not.toHaveBeenCalled()
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('A file with this name already exists')
  })

  it('lands a server refusal in the dismissable strip', async () => {
    fsCreateFile.mockRejectedValueOnce(new Error('boom: reserved'))
    harness = mountTree()
    await act(async () => {})
    openMenu(harness.container, 'tmp')
    clickMenuitem('New file')
    const input = editorInput(harness.container)
    setNativeValue(input, 'CON')
    await act(async () => { pressKey(input, 'Enter') })
    expect(fsCreateFile).toHaveBeenCalledTimes(1)
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('boom: reserved')
  })

  it('commits on blur (the same contract the rename editor has)', async () => {
    harness = mountTree()
    await act(async () => {})
    openMenu(harness.container, 'tmp')
    clickMenuitem('New file')
    const input = editorInput(harness.container)
    setNativeValue(input, 'blurred.ts')
    // React delegates onBlur from the native focusout event.
    await act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(fsCreateFile).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp', 'blurred.ts')
  })

  it('keeps the two inline creators mutually exclusive', async () => {
    harness = mountTree()
    await act(async () => {})
    // New folder, then New file: only the file editor is left.
    openMenu(harness.container, 'tmp')
    clickMenuitem('New folder')
    expect(editorInputs(harness.container)).toHaveLength(1)
    openMenu(harness.container, 'tmp')
    clickMenuitem('New file')
    expect(editorInputs(harness.container)).toHaveLength(1)
    setNativeValue(editorInput(harness.container), 'only.ts')
    await act(async () => { pressKey(editorInput(harness.container), 'Enter') })
    expect(fsCreateFile).toHaveBeenCalledTimes(1)
    expect(fsMkdir).not.toHaveBeenCalled()
    // …and the other way around.
    openMenu(harness.container, 'tmp')
    clickMenuitem('New file')
    openMenu(harness.container, 'tmp')
    clickMenuitem('New folder')
    expect(editorInputs(harness.container)).toHaveLength(1)
    setNativeValue(editorInput(harness.container), 'only-dir')
    await act(async () => { pressKey(editorInput(harness.container), 'Enter') })
    expect(fsMkdir).toHaveBeenCalledTimes(1)
    expect(fsCreateFile).toHaveBeenCalledTimes(1)
  })
})
