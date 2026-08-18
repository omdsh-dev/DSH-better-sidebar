/**
 * FileTree local-path drag contract: every visible path row is draggable and
 * publishes the workspace-relative path through the shared DSH MIME type and
 * text/plain without changing the row's existing actions.
 */
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

const fsTree = vi.fn(async (_scope: unknown, dir: string) => ({
  entries: dir === 'C:\\work'
    ? [
        { name: 'src', path: 'C:\\work\\src', isDir: true, hidden: false, isSymlink: false, broken: false },
        { name: 'README.md', path: 'C:\\work\\README.md', isDir: false, hidden: false, isSymlink: false, broken: false },
      ]
    : [],
}))

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/client/api.ts')>()
  return { ...original, api: { ...original.api, fsTree } }
})

import { FileTree } from '../src/client/FileTree.tsx'
import { LOCAL_PATH_MIME, setLocalPathDragData } from '../src/client/path-drag.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

function transferRecorder(): { dataTransfer: DataTransfer; values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    dataTransfer: {
      setData: (type: string, value: string) => { values.set(type, value) },
      effectAllowed: 'uninitialized',
    } as unknown as DataTransfer,
  }
}

function dragStart(row: Element): Map<string, string> {
  const { dataTransfer, values } = transferRecorder()
  const event = new Event('dragstart', { bubbles: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  act(() => { row.dispatchEvent(event) })
  return values
}

async function mountTree(): Promise<{ container: HTMLDivElement; unmount: () => void }> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(FileTree, {
      sessionId: 'session-1',
      cwd: 'C:\\work',
      expanded: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
      refreshTick: 0,
    }))
    await Promise.resolve()
  })
  return {
    container,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

describe('local path drag payload', () => {
  it('writes the standard custom MIME and text/plain payload', () => {
    const { dataTransfer, values } = transferRecorder()
    setLocalPathDragData(dataTransfer, 'src/FileTree.tsx')
    expect(LOCAL_PATH_MIME).toBe('application/x-dsh-local-path')
    expect(values).toEqual(new Map([
      ['application/x-dsh-local-path', 'src/FileTree.tsx'],
      ['text/plain', 'src/FileTree.tsx'],
    ]))
  })

  it('makes the visible root, directory, and file rows draggable with relative payloads', async () => {
    const { container, unmount } = await mountTree()
    try {
      const rows = Array.from(container.querySelectorAll('[draggable="true"]'))
      expect(rows.map(row => row.textContent)).toEqual(expect.arrayContaining(['work@', 'src@', 'README.md@']))

      const root = rows.find(row => row.textContent === 'work@')!
      const directory = rows.find(row => row.textContent === 'src@')!
      const file = rows.find(row => row.textContent === 'README.md@')!
      expect(dragStart(root).get(LOCAL_PATH_MIME)).toBe('.')
      expect(dragStart(directory).get(LOCAL_PATH_MIME)).toBe('src')
      expect(dragStart(file).get('text/plain')).toBe('README.md')
    } finally {
      unmount()
    }
  })

  it('preserves file click, directory keyboard toggle, context menu, and @ actions', async () => {
    const onToggle = vi.fn()
    const onOpenFile = vi.fn()
    const onReferenceFile = vi.fn()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(FileTree, {
        sessionId: 'session-1', cwd: 'C:\\work', expanded: [], refreshTick: 0,
        onToggle, onOpenFile, onReferenceFile,
      }))
      await Promise.resolve()
    })
    try {
      const rows = Array.from(container.querySelectorAll('[draggable="true"]'))
      const directory = rows.find(row => row.textContent === 'src@')!
      const file = rows.find(row => row.textContent === 'README.md@')!
      act(() => { file.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      act(() => { directory.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
      act(() => { file.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 4, clientY: 8 })) })
      act(() => { file.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      expect(onOpenFile).toHaveBeenCalledWith('C:\\work\\README.md')
      expect(onToggle).toHaveBeenCalledWith('C:\\work\\src')
      expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
      expect(onReferenceFile).toHaveBeenCalledWith('C:\\work\\README.md')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})
