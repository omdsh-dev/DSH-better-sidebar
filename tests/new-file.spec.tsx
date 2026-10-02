/**
 * New-file spec: the file tree's inline "new file" editor.
 *
 * Pure helpers (`joinChild` / `nameTaken`) plus the mounted flow: the menu
 * entry shows on directory rows (not file rows), committing creates an
 * EMPTY file through the existing `fs.write` route, taken names are refused
 * client-side (`fs.write` overwrites silently, so the tree must guard
 * itself), invalid names are refused, and Escape cancels without a write.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree, joinChild, nameTaken } from '../src/client/FileTree.tsx'
import type { BetterSidebarService } from '../src/client/service.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so any copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const { fsTree, fsTrees, gitStatus, fileApps, directoryApps, archiveBuild, archiveStatus, fsWrite } = vi.hoisted(() => ({
  fsTree: vi.fn(),
  fsTrees: vi.fn(),
  gitStatus: vi.fn(),
  fileApps: vi.fn(),
  directoryApps: vi.fn(),
  archiveBuild: vi.fn(),
  archiveStatus: vi.fn(),
  fsWrite: vi.fn(),
}))

vi.mock('../src/client/api.ts', () => ({
  api: { fsTree, fsTrees, gitStatus, fileApps, directoryApps, archiveBuild, archiveStatus, fsWrite },
  downloadUrl: () => '/sidebar/file',
  archiveDownloadUrl: (id: string) => `/sidebar/archive/${id}`,
  isOutsideWorkspaceMessage: () => false,
}))

const service = {
  subscribe: () => () => {},
  fileIcon: (_path: string) => null,
  folderIcon: (_path: string) => null,
} as unknown as BetterSidebarService

interface Harness {
  container: HTMLDivElement
  unmount: () => void
}

async function mountTree(expanded: string[] = []): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(createElement(FileTree, {
      sessionId: 'new-file',
      cwd: '/tmp',
      expanded,
      revealed: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
      service,
      openInApp: {
        available: () => true,
        probe: async () => true,
        directoryApps,
        fileApps,
        open: async () => true,
        reveal: async () => true,
      },
    }))
    await Promise.resolve()
  })
  return {
    container,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

function rowByName(container: HTMLElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find((el) => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row not found: ${name}`)
  return row
}

async function openRowMenu(container: HTMLElement, name: string): Promise<void> {
  await act(async () => {
    rowByName(container, name).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }),
    )
    await Promise.resolve()
    await Promise.resolve()
  })
}

function menuItem(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((item) => item.textContent?.trim() === label)
}

/** Open the inline editor for `dirName` and return its input. */
async function openNewFileEditor(container: HTMLElement, dirName: string): Promise<HTMLInputElement> {
  await openRowMenu(container, dirName)
  const item = menuItem('New file')
  expect(item).toBeDefined()
  await act(async () => {
    item!.click()
    await Promise.resolve()
  })
  const input = container.querySelector<HTMLInputElement>('input[aria-label="New file"]')
  expect(input).not.toBeNull()
  return input!
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function pressKey(input: HTMLInputElement, key: string): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    // Flush the commit chain (fsWrite → settle → retryDir → re-list) so its
    // state updates land inside act, not in a later test's window.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

let harness: Harness | undefined

beforeEach(() => {
  vi.useFakeTimers()
  fsTree.mockReset()
  fsTrees.mockReset()
  fsTrees.mockImplementation(async (_scope: unknown, paths: readonly string[]) => ({
    levels: paths.map((path) => ({
      path,
      entries: path === '/tmp/sub'
        ? [{ name: 'inner.md', path: '/tmp/sub/inner.md', isDir: false }]
        : [
            { name: 'sub', path: '/tmp/sub', isDir: true },
            { name: 'a.ts', path: '/tmp/a.ts', isDir: false },
            { name: 'b.ts', path: '/tmp/b.ts', isDir: false },
            { name: 'c.ts', path: '/tmp/c.ts', isDir: false },
          ],
      truncated: false,
    })),
  }))
  gitStatus.mockReset()
  gitStatus.mockResolvedValue({ isRepo: false, entries: [] })
  fileApps.mockReset()
  fileApps.mockResolvedValue([])
  directoryApps.mockReset()
  directoryApps.mockResolvedValue([])
  archiveBuild.mockReset()
  archiveStatus.mockReset()
  fsWrite.mockReset()
  fsWrite.mockResolvedValue({ ok: true })
})

afterEach(() => {
  harness?.unmount()
  harness = undefined
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('new-file helpers', () => {
  it('joins a child path with one separator', () => {
    expect(joinChild('/tmp/sub', 'notes.md')).toBe('/tmp/sub/notes.md')
    expect(joinChild('/tmp/sub/', 'notes.md')).toBe('/tmp/sub/notes.md')
    expect(joinChild('C:\\work', 'notes.md')).toBe('C:\\work/notes.md')
  })

  it('detects taken names case-insensitively and tolerates missing levels', () => {
    expect(nameTaken(undefined, 'x.md')).toBe(false)
    expect(nameTaken([], 'x.md')).toBe(false)
    expect(nameTaken([{ name: 'a.ts' }], 'a.ts')).toBe(true)
    expect(nameTaken([{ name: 'A.TS' }], 'a.ts')).toBe(true)
    expect(nameTaken([{ name: 'a.ts' }], 'b.ts')).toBe(false)
  })
})

describe('FileTree inline new file', () => {
  it('shows New file on directory rows but not on file rows', async () => {
    harness = await mountTree()
    await openRowMenu(harness.container, 'sub')
    expect(menuItem('New file')).toBeDefined()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await Promise.resolve()
    })

    await openRowMenu(harness.container, 'a.ts')
    expect(menuItem('New file')).toBeUndefined()
  })

  it('creates an empty file through fs.write on commit', async () => {
    // The target level must be rendered: startNewFile only expands via the
    // caller's onToggle, which is a noop here.
    harness = await mountTree(['/tmp/sub'])
    const input = await openNewFileEditor(harness.container, 'sub')
    setInputValue(input, 'notes.md')
    await pressKey(input, 'Enter')

    expect(fsWrite).toHaveBeenCalledTimes(1)
    const call = fsWrite.mock.calls[0]!
    expect(call[1]).toBe('/tmp/sub/notes.md')
    expect(call[2]).toBe('')
  })

  it('refuses taken names without touching fs.write', async () => {
    harness = await mountTree(['/tmp/sub'])
    const input = await openNewFileEditor(harness.container, 'sub')
    setInputValue(input, 'INNER.MD')
    await pressKey(input, 'Enter')

    expect(fsWrite).not.toHaveBeenCalled()
    expect(harness?.container.textContent).toContain('already exists')
  })

  it('refuses invalid names without touching fs.write', async () => {
    harness = await mountTree(['/tmp/sub'])
    const input = await openNewFileEditor(harness.container, 'sub')
    setInputValue(input, 'a/b')
    await pressKey(input, 'Enter')

    expect(fsWrite).not.toHaveBeenCalled()
  })

  it('cancels on Escape without a write', async () => {
    harness = await mountTree(['/tmp/sub'])
    const input = await openNewFileEditor(harness.container, 'sub')
    setInputValue(input, 'scratch.md')
    await pressKey(input, 'Escape')

    expect(fsWrite).not.toHaveBeenCalled()
    expect(harness.container.querySelector('input[aria-label="New file"]')).toBeNull()
  })
})
