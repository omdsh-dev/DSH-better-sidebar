/**
 * FileTree context-menu rename: a row's right-click menu gains a "Rename"
 * item on every row except the workspace root; picking it swaps the name
 * span for an in-place input that auto-focuses and selects the basename.
 * Enter commits through api.fsRename and hands the new path to the caller's
 * onRenamed; Escape (or blur) cancels without a call; a failed rename keeps
 * the input open and surfaces the error above the tree.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import { api } from '../src/client/api.ts'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// vitest 4.1.11+ follows the OS locale; pin en-US so menu copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTree: async () => ({
      entries: [
        { name: 'src', path: '/tmp/src', isDir: true, hidden: false, isSymlink: false, broken: false },
        { name: 'a.ts', path: '/tmp/a.ts', isDir: false, hidden: false, isSymlink: false, broken: false },
      ],
    }),
    // The rename mock derives the new absolute path from the inputs (so the
// caller's onRenamed sees the true target regardless of the row's name).
// Regex-based (not node:path) so the path keeps POSIX separators on Windows.
fsRename: vi.fn(async (_scope: unknown, path: string, newName: string) => ({
  ok: true,
  path: path.replace(/([/\\])[^/\\]+$/, `$1${newName}`),
})),
  },
  downloadUrl: () => '/sidebar/file',
}))

interface Harness {
  container: HTMLDivElement
  onRenamed: ReturnType<typeof vi.fn>
  unmount: () => void
}

async function mountTree(): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const onRenamed = vi.fn()
  await act(async () => {
    root.render(createElement(FileTree, {
      sessionId: 's1',
      cwd: '/tmp',
      expanded: [],
      revealed: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onOpenFileNewTab: () => {},
      onOpenFileSide: () => {},
      onReferenceFile: () => {},
      onRenamed,
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
    }))
  })
  return {
    container,
    onRenamed,
    unmount: () => { act(() => { root.unmount() }) },
  }
}

describe('FileTree context-menu rename', () => {
  let harness: Harness
  afterEach(() => {
    harness.unmount()
    document.body.innerHTML = ''
    vi.mocked(api.fsRename).mockClear()
  })

  /** The file row of the one-level tree (role="button" whose name is a.ts). */
  function fileRow(container: HTMLDivElement): HTMLElement {
    const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
      .find(el => el.querySelector('[class*="explorerName"]')?.textContent === 'a.ts')
    if (row === undefined) throw new Error('file row not found')
    return row
  }

  /** Open the row's context menu at a fixed cursor position. */
  function openMenu(container: HTMLDivElement, row = fileRow(container)): void {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })
    act(() => { row.dispatchEvent(event) })
  }

  /** Pick a top-level menu item by its exact label (the Menu is portaled). */
  function pickMenuItem(label: string): void {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find(el => el.textContent?.trim() === label)
    if (item === undefined) throw new Error(`menu item "${label}" not found`)
    act(() => { item.click() })
  }

  function renameInput(): HTMLInputElement {
    const input = document.querySelector<HTMLInputElement>('[class*="explorerRenameInput"]')
    if (input === null) throw new Error('rename input not found')
    return input
  }

  it('adds a Rename item to a file row context menu (and hides it on the root row)', async () => {
    harness = await mountTree()
    openMenu(harness.container)
    const fileItems = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(fileItems.map(item => item.textContent?.trim())).toContain('Rename')

    // The workspace root row never offers Rename (renaming the cwd would
    // strand the tree) — its menu keeps the upload/copy entries only.
    // The workspace root row is the only row whose name span is the cwd
    // basename ('tmp' — the file/dir rows are a.ts / src); the row body also
    // carries the reference button, so match the span, not the row text. The
    // root row has NO role="button" (only file/dir rows do), so walk up from
    // the span to its row instead of querying by role.
    const rootNameSpan = [...harness.container.querySelectorAll<HTMLElement>('[class*="explorerName"]')]
      .find(span => span.textContent === 'tmp')
    if (rootNameSpan === undefined) throw new Error('root row not found')
    const rootRow = rootNameSpan.parentElement
    if (rootRow === null) throw new Error('root row not found')
    act(() => {
      rootRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
    })
    const rootItems = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(rootItems.map(item => item.textContent?.trim())).not.toContain('Rename')
  })

  it('picking Rename swaps the name span for an auto-focused, pre-selected input', async () => {
    harness = await mountTree()
    openMenu(harness.container)
    pickMenuItem('Rename')
    const input = renameInput()
    expect(input.value).toBe('a.ts')
    expect(document.activeElement).toBe(input)
  })

  it('Enter commits through fsRename and reports the new path (file)', async () => {
    harness = await mountTree()
    openMenu(harness.container)
    pickMenuItem('Rename')
    const input = renameInput()
    input.value = 'b.ts'
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await act(async () => {})
    expect(vi.mocked(api.fsRename)).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp/a.ts', 'b.ts')
    expect(harness.onRenamed).toHaveBeenCalledWith('/tmp/a.ts', '/tmp/b.ts')
    // The in-place input closes after a successful commit.
    expect(document.querySelector('[class*="explorerRenameInput"]')).toBeNull()
  })

  it('Escape cancels without calling the host', async () => {
    harness = await mountTree()
    openMenu(harness.container)
    pickMenuItem('Rename')
    const input = renameInput()
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(document.querySelector('[class*="explorerRenameInput"]')).toBeNull()
    expect(vi.mocked(api.fsRename)).not.toHaveBeenCalled()
    expect(harness.onRenamed).not.toHaveBeenCalled()
  })

  it('blur cancels without calling the host', async () => {
    harness = await mountTree()
    openMenu(harness.container)
    pickMenuItem('Rename')
    const input = renameInput()
    act(() => { input.blur() })
    expect(document.querySelector('[class*="explorerRenameInput"]')).toBeNull()
    expect(vi.mocked(api.fsRename)).not.toHaveBeenCalled()
  })

  it('a failed rename keeps the input open and surfaces the error', async () => {
    vi.mocked(api.fsRename).mockRejectedValueOnce(new Error('target already exists'))
    harness = await mountTree()
    openMenu(harness.container)
    pickMenuItem('Rename')
    const input = renameInput()
    input.value = 'b.ts'
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await act(async () => {})
    expect(renameInput().value).toBe('b.ts')
    expect(harness.container.textContent).toContain('target already exists')
    expect(harness.onRenamed).not.toHaveBeenCalled()
  })

  it('an unchanged name commits as a no-op (no host call)', async () => {
    harness = await mountTree()
    openMenu(harness.container)
    pickMenuItem('Rename')
    const input = renameInput()
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(vi.mocked(api.fsRename)).not.toHaveBeenCalled()
    expect(harness.onRenamed).not.toHaveBeenCalled()
  })

  it('renames a directory row the same way', async () => {
    harness = await mountTree()
    const dirRow = [...harness.container.querySelectorAll<HTMLElement>('[role="button"]')]
      .find(el => el.querySelector('[class*="explorerName"]')?.textContent === 'src')
    if (dirRow === undefined) throw new Error('dir row not found')
    openMenu(harness.container, dirRow)
    pickMenuItem('Rename')
    const input = renameInput()
    expect(input.value).toBe('src')
    input.value = 'lib'
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await act(async () => {})
    expect(vi.mocked(api.fsRename)).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp/src', 'lib')
    expect(harness.onRenamed).toHaveBeenCalledWith('/tmp/src', '/tmp/lib')
  })
})