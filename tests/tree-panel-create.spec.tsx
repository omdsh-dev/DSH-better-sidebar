/** Directory context-menu creation/import: actions target the selected
 * folder, naming stays inline, and the compact search bar keeps only refresh. */
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TreePanel } from '../src/client/TreePanel.tsx'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const target = '/workspace/target'
const { fsCreate, fsTree, uploadFile } = vi.hoisted(() => ({
  fsCreate: vi.fn(),
  fsTree: vi.fn(),
  uploadFile: vi.fn(),
}))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsCreate,
    fsTree,
    fsSearch: async () => ({ matches: [], truncated: false }),
    uploadFile,
  },
  downloadUrl: () => '/sidebar/file',
}))

function folderRow(container: HTMLDivElement): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(element => element.querySelector('[class*="explorerName"]')?.textContent === 'target')
  if (row === undefined) throw new Error('target folder row not found')
  return row
}

function openFolderMenu(container: HTMLDivElement): void {
  act(() => {
    folderRow(container).dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 30, clientY: 40,
    }))
  })
}

function menuItem(label: string): HTMLElement {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(element => element.textContent?.trim() === label)
  if (item === undefined) throw new Error(`${label} menu item not found`)
  return item
}

function setInput(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('TreePanel directory actions', () => {
  let root: Root | undefined
  let container: HTMLDivElement
  const onOpenFile = vi.fn()
  const onToggle = vi.fn()

  beforeEach(async () => {
    fsCreate.mockReset()
    fsCreate.mockImplementation(async (_scope: unknown, dir: string, name: string, kind: 'file' | 'directory') => ({
      path: `${dir}/${name}`, kind,
    }))
    fsTree.mockReset()
    fsTree.mockImplementation(async (_scope: unknown, dir: string) => ({
      entries: dir === '/workspace' ? [{
        name: 'target', path: target, isDir: true, hidden: false, isSymlink: false, broken: false,
      }] : [],
    }))
    uploadFile.mockReset()
    uploadFile.mockImplementation(async (_scope: unknown, dir: string, relativePath: string) => ({
      path: `${dir}/${relativePath}`, size: 1,
    }))
    onOpenFile.mockClear()
    onToggle.mockClear()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(createElement(TreePanel, {
        sessionId: `create-session-${expect.getState().currentTestName}`,
        cwd: '/workspace',
        expanded: [target],
        onToggle,
        onOpenFile,
        onReferenceFile: () => {},
        initialScrollTop: 0,
        onScrollTopChange: () => {},
      }))
    })
  })

  afterEach(() => {
    if (root !== undefined) act(() => { root!.unmount() })
    root = undefined
    document.body.innerHTML = ''
  })

  it('keeps only refresh in the header and imports into the selected folder', async () => {
    expect(container.querySelector('button[aria-label="Refresh"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Upload files"]')).toBeNull()
    expect(container.querySelector('button[aria-label="Upload folder"]')).toBeNull()

    openFolderMenu(container)
    const labels = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .map(item => item.textContent?.trim())
    expect(labels).toEqual(expect.arrayContaining(['New File', 'New Folder', 'Import Files', 'Import Folder']))

    const [fileInput, folderInput] = [...container.querySelectorAll<HTMLInputElement>('input[type="file"]')]
    const filePicker = vi.spyOn(fileInput!, 'click')
    act(() => { menuItem('Import Files').click() })
    expect(filePicker).toHaveBeenCalledOnce()

    const imported = new File(['x'], 'child.txt', { type: 'text/plain' })
    Object.defineProperty(fileInput!, 'files', { configurable: true, value: [imported] })
    await act(async () => {
      fileInput!.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(uploadFile).toHaveBeenCalledWith(
      { sessionId: expect.stringContaining('create-session-'), cwd: '/workspace' },
      target,
      'child.txt',
      imported,
      expect.any(AbortSignal),
    )

    const folderPicker = vi.spyOn(folderInput!, 'click')
    openFolderMenu(container)
    act(() => { menuItem('Import Folder').click() })
    expect(folderPicker).toHaveBeenCalledOnce()
  })

  it('creates direct children inline, opens a new file, and expands a new folder', async () => {
    openFolderMenu(container)
    act(() => { menuItem('New File').click() })
    const fileName = container.querySelector<HTMLInputElement>('input[aria-label="File name"]')!
    expect(fileName).not.toBeNull()
    act(() => {
      setInput(fileName, 'child.ts')
      fileName.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      fileName.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(fsCreate).toHaveBeenCalledWith(
      { sessionId: expect.stringContaining('create-session-'), cwd: '/workspace' },
      target,
      'child.ts',
      'file',
    )
    expect(fsCreate).toHaveBeenCalledTimes(1)
    expect(onOpenFile).toHaveBeenCalledWith(`${target}/child.ts`)

    openFolderMenu(container)
    act(() => { menuItem('New Folder').click() })
    const folderName = container.querySelector<HTMLInputElement>('input[aria-label="Folder name"]')!
    act(() => {
      setInput(folderName, 'nested')
      folderName.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(fsCreate).toHaveBeenLastCalledWith(
      { sessionId: expect.stringContaining('create-session-'), cwd: '/workspace' },
      target,
      'nested',
      'directory',
    )
    expect(onToggle).toHaveBeenCalledWith(`${target}/nested`)
  })

  it('keeps invalid names inline and never sends them to the host', () => {
    openFolderMenu(container)
    act(() => { menuItem('New File').click() })
    const input = container.querySelector<HTMLInputElement>('input[aria-label="File name"]')!
    act(() => {
      setInput(input, '../escape')
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(fsCreate).not.toHaveBeenCalled()
    expect(container.textContent).toContain('contain path separators')
    expect(container.querySelector('input[aria-label="File name"]')).not.toBeNull()
  })
})
