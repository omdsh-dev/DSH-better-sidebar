/** FileTree folder controls, including the workspace root. */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTree: async (_scope: unknown, dir: string) => ({
      entries: dir === '/tmp'
        ? [{ name: 'src', path: '/tmp/src', isDir: true }]
        : dir === '/tmp/src'
          ? [
              { name: 'client', path: '/tmp/src/client', isDir: true },
              { name: 'index.ts', path: '/tmp/src/index.ts', isDir: false },
            ]
          : [{ name: 'view.tsx', path: '/tmp/src/client/view.tsx', isDir: false }],
    }),
  },
  downloadUrl: () => '/sidebar/file',
}))

interface Harness {
  container: HTMLDivElement
  references: string[]
  unmount: () => void
}

async function mountTree(): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const references: string[] = []

  function ControlledTree() {
    const [expanded, setExpanded] = useState<string[]>([])
    return createElement(FileTree, {
      sessionId: 's1',
      cwd: '/tmp',
      expanded,
      revealed: [],
      onToggle: (path: string) => {
        setExpanded(current => current.includes(path)
          ? current.filter(item => item !== path)
          : [...current, path])
      },
      onOpenFile: () => {},
      onReferenceFile: (path: string) => { references.push(path) },
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
    })
  }

  await act(async () => { root.render(createElement(ControlledTree)) })
  return {
    container,
    references,
    unmount: () => { act(() => { root.unmount() }) },
  }
}

function folderButton(container: HTMLElement, name: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]
    .find(item => item.textContent === name)
  if (button === undefined) throw new Error(`folder button not found: ${name}`)
  return button
}

function click(target: Element): void {
  act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

describe('FileTree directory toggles', () => {
  let harness: Harness | undefined
  afterEach(() => {
    harness?.unmount()
    harness = undefined
    document.body.innerHTML = ''
  })

  it('collapses and restores the workspace root while preserving nested state', async () => {
    harness = await mountTree()
    const root = folderButton(harness.container, 'tmp')
    click(folderButton(harness.container, 'src'))
    await act(async () => {})
    click(folderButton(harness.container, 'client'))
    await act(async () => {})
    expect(harness.container.textContent).toContain('view.tsx')

    click(root)
    expect(root.getAttribute('aria-expanded')).toBe('false')
    expect(harness.container.textContent).not.toContain('src')

    click(root)
    expect(root.getAttribute('aria-expanded')).toBe('true')
    expect(folderButton(harness.container, 'src').getAttribute('aria-expanded')).toBe('true')
    expect(folderButton(harness.container, 'client').getAttribute('aria-expanded')).toBe('true')
    expect(harness.container.textContent).toContain('view.tsx')
  })

  it('expands and collapses the same folder button on consecutive clicks', async () => {
    harness = await mountTree()
    const src = folderButton(harness.container, 'src')
    expect(src.getAttribute('aria-expanded')).toBe('false')
    click(src)
    await act(async () => {})
    expect(src.getAttribute('aria-expanded')).toBe('true')
    expect(harness.container.textContent).toContain('index.ts')
    click(src)
    expect(src.getAttribute('aria-expanded')).toBe('false')
    expect(harness.container.textContent).not.toContain('index.ts')
  })

  it('lets a nested folder toggle independently', async () => {
    harness = await mountTree()
    click(folderButton(harness.container, 'src'))
    await act(async () => {})
    const client = folderButton(harness.container, 'client')
    click(client)
    await act(async () => {})
    expect(harness.container.textContent).toContain('view.tsx')
    click(client)
    expect(harness.container.textContent).not.toContain('view.tsx')
    expect(folderButton(harness.container, 'src').getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps the @ reference action separate from the directory toggle', async () => {
    harness = await mountTree()
    const src = folderButton(harness.container, 'src')
    const reference = src.parentElement?.querySelector<HTMLButtonElement>('button:not([aria-expanded])')
    expect(reference).not.toBeNull()
    click(reference!)
    expect(harness.references).toEqual(['/tmp/src'])
    expect(src.getAttribute('aria-expanded')).toBe('false')
  })
})
