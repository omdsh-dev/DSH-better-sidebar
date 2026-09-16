/**
 * FileTree explorer mutations: the context menu's rename (inline row editor)
 * and delete (confirmation modal) — menu-item visibility (never on the
 * workspace root row), the commit/cancel flows, the API calls with the row
 * path, the tab-reconciliation callbacks, and the failure strip.
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import { createSidebarStore } from '../src/client/state.ts'

// The act() environment flag (React 18.2 reads it before flushing effects).
import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so menu copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

// vi.mock factories are hoisted above every declaration, so the shared
// mocks ride vi.hoisted (mockClear in afterEach keeps the implementations).
const { fsRename, fsRemove } = vi.hoisted(() => ({
  fsRename: vi.fn(async () => ({ path: '/tmp/renamed.ts' })),
  fsRemove: vi.fn(async () => ({ path: '/tmp/a.ts' })),
}))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTree: async () => ({
      entries: [
        { name: 'a.ts', path: '/tmp/a.ts', isDir: false },
        { name: 'sub', path: '/tmp/sub', isDir: true },
      ],
    }),
    fsRename,
    fsRemove,
  },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

interface Harness {
  container: HTMLDivElement
  onPathRenamed: ReturnType<typeof vi.fn>
  onPathDeleted: ReturnType<typeof vi.fn>
  unmount: () => void
}

async function mountTree(): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const onPathRenamed = vi.fn()
  const onPathDeleted = vi.fn()
  await act(async () => {
    root.render(createElement(FileTree, {
      sessionId: 's1',
      cwd: '/tmp',
      store: createSidebarStore(),
      expanded: [],
      revealed: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onOpenFileNewTab: () => {},
      onOpenFileSide: () => {},
      onReferenceFile: () => {},
      onPathRenamed,
      onPathDeleted,
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
    }))
  })
  return {
    container,
    onPathRenamed,
    onPathDeleted,
    unmount: () => { act(() => { root.unmount() }) },
  }
}

/** One tree row by its displayed name (the root row included; it carries no
 *  role="button", so the query rides the row class). */
function rowByName(container: HTMLDivElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[class*="explorerRow"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row "${name}" not found`)
  return row
}

function openMenu(container: HTMLDivElement, name: string): void {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })
  act(() => { rowByName(container, name).dispatchEvent(event) })
}

function menuLabels(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(item => item.textContent ?? '')
}

function clickMenuitem(label: string): void {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent === label)
  if (item === undefined) throw new Error(`menuitem "${label}" not found`)
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

let harness: Harness
afterEach(() => {
  harness.unmount()
  document.body.innerHTML = ''
  fsRename.mockClear()
  fsRemove.mockClear()
})

describe('FileTree rename/delete menu items', () => {
  it('offers rename and delete on file and directory rows, never on the root', async () => {
    harness = await mountTree()
    openMenu(harness.container, 'a.ts')
    expect(menuLabels()).toContain('Rename')
    expect(menuLabels()).toContain('Delete')
    openMenu(harness.container, 'sub')
    expect(menuLabels()).toContain('Rename')
    // The workspace root row (cwd itself) is the session — no mutations.
    openMenu(harness.container, 'tmp')
    expect(menuLabels()).not.toContain('Rename')
    expect(menuLabels()).not.toContain('Delete')
  })
})

describe('FileTree inline rename', () => {
  it('replaces the row with a prefilled editor; Enter commits via fsRename + onPathRenamed', async () => {
    harness = await mountTree()
    openMenu(harness.container, 'a.ts')
    clickMenuitem('Rename')
    const input = harness.container.querySelector<HTMLInputElement>('input[class*="explorerRenameInput"]')
    expect(input).not.toBeNull()
    expect(input!.value).toBe('a.ts')
    setNativeValue(input!, 'b.ts')
    await act(async () => { pressKey(input!, 'Enter') })
    expect(fsRename).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp/a.ts', 'b.ts')
    expect(harness.onPathRenamed).toHaveBeenCalledWith('/tmp/a.ts', '/tmp/renamed.ts')
    // The editor row is gone (the commit closed it).
    expect(harness.container.querySelector('input[class*="explorerRenameInput"]')).toBeNull()
  })

  it('Escape cancels without touching the API', async () => {
    harness = await mountTree()
    openMenu(harness.container, 'a.ts')
    clickMenuitem('Rename')
    const input = harness.container.querySelector<HTMLInputElement>('input[class*="explorerRenameInput"]')!
    setNativeValue(input, 'b.ts')
    await act(async () => { pressKey(input, 'Escape') })
    expect(fsRename).not.toHaveBeenCalled()
    expect(harness.onPathRenamed).not.toHaveBeenCalled()
    expect(harness.container.querySelector('input[class*="explorerRenameInput"]')).toBeNull()
  })

  it('rejects separator names client-side with the error strip, no API call', async () => {
    harness = await mountTree()
    openMenu(harness.container, 'a.ts')
    clickMenuitem('Rename')
    const input = harness.container.querySelector<HTMLInputElement>('input[class*="explorerRenameInput"]')!
    setNativeValue(input, 'a/b.ts')
    await act(async () => { pressKey(input, 'Enter') })
    expect(fsRename).not.toHaveBeenCalled()
    const alert = harness.container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('path separators')
  })
})

describe('FileTree delete confirmation', () => {
  it('confirms through the modal, then calls fsRemove + onPathDeleted', async () => {
    harness = await mountTree()
    openMenu(harness.container, 'a.ts')
    clickMenuitem('Delete')
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Delete "a.ts"?')
    expect(dialog?.textContent).toContain('permanently deletes the file')
    const confirm = [...document.querySelectorAll<HTMLElement>('button')].find(el => el.textContent === 'Delete' && el.closest('[role="dialog"]') !== null)!
    await act(async () => { confirm.click() })
    expect(fsRemove).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp/a.ts')
    expect(harness.onPathDeleted).toHaveBeenCalledWith('/tmp/a.ts', false)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('the directory copy names the recursive wipe', async () => {
    harness = await mountTree()
    openMenu(harness.container, 'sub')
    clickMenuitem('Delete')
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('everything inside it')
  })

  it('cancel closes the modal without calling anything', async () => {
    harness = await mountTree()
    openMenu(harness.container, 'a.ts')
    clickMenuitem('Delete')
    const cancel = [...document.querySelectorAll<HTMLElement>('button')].find(el => el.textContent === 'Cancel')!
    act(() => { cancel.click() })
    expect(fsRemove).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('a server failure lands in the dismissable strip', async () => {
    fsRemove.mockRejectedValueOnce(new Error('boom: refused'))
    harness = await mountTree()
    openMenu(harness.container, 'a.ts')
    clickMenuitem('Delete')
    const confirm = [...document.querySelectorAll<HTMLElement>('button')].find(el => el.textContent === 'Delete' && el.closest('[role="dialog"]') !== null)!
    await act(async () => { confirm.click() })
    const alert = harness.container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('boom: refused')
    expect(harness.onPathDeleted).not.toHaveBeenCalled()
  })
})
