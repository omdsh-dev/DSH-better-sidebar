/**
 * Explorer context-menu interaction tests (jsdom): right-clicking rows and
 * blank areas opens the portaled Menu; 新建目录/新建文件 route to
 * fs.mkdir/fs.write; 重命名 prefills an inline input and routes to
 * fs.rename; 删除 opens the confirmation Modal and routes to fs.remove;
 * 查找功能 replaces the tree with a debounced recursive search.
 *
 * The api module is mocked (network-free); the real store + a ctx stub
 * without betterSidebar exercise the state sync paths (expanded set, cache
 * reloads) without touching the service.
 */
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ExplorerView } from '../src/client/ExplorerView.tsx'
import { api } from '../src/client/api.ts'
import { createSidebarStore, type SidebarStore } from '../src/client/state.ts'
import type { Context } from '../src/context-types.ts'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

/** Dispatch a context menu event at a fixed cursor position. */
function contextMenuAt(target: Element): void {
  target.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 40,
  }))
}

/** Set an input's value the way a real user would (React onChange fires). */
function changeInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Press a key on an element. */
function keyDown(target: Element, key: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTree: vi.fn(),
    fsRead: vi.fn(),
    fsWrite: vi.fn(),
    fsMkdir: vi.fn(),
    fsRename: vi.fn(),
    fsRemove: vi.fn(),
    fsReveal: vi.fn(),
    fsSearch: vi.fn(),
  },
  downloadUrl: vi.fn(() => '/sidebar/file?download=1'),
}))

const CWD = '/workspace'

const fileEntry = {
  name: 'a.txt', path: `${CWD}/a.txt`, isDir: false, hidden: false, isSymlink: false, broken: false,
}
const dirEntry = {
  name: 'sub', path: `${CWD}/sub`, isDir: true, hidden: false, isSymlink: false, broken: false,
}

interface Harness {
  root: Root
  store: SidebarStore
  container: HTMLDivElement
  onOpenFile: ReturnType<typeof vi.fn>
  onToggle: ReturnType<typeof vi.fn>
  cleanup: () => void
}

async function mount(): Promise<Harness> {
  const store = createSidebarStore()
  store.setSession('s1')
  const onOpenFile = vi.fn()
  const onToggle = vi.fn()
  const ctx = { betterSidebar: undefined } as unknown as Context
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(createElement(ExplorerView, {
      sessionId: 's1',
      cwd: CWD,
      expanded: [],
      onToggle,
      onOpenFile,
      onReferenceFile: vi.fn(),
      ctx,
      store,
    }))
  })
  // Flush the initial fsTree load (mount effects resolve asynchronously).
  await act(async () => {})
  return {
    root,
    store,
    container,
    onOpenFile,
    onToggle,
    cleanup: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

/** A rendered tree row by its file/folder name. */
function rowByText(text: string): HTMLElement {
  const row = [...document.querySelectorAll('[role="button"]')].find(el => el.textContent?.includes(text))
  if (row === undefined) throw new Error(`row "${text}" not found`)
  return row as HTMLElement
}

/** The root row (the session cwd row at the top of the tree). */
function rootRow(): HTMLElement {
  const ref = [...document.querySelectorAll('button')].find(btn => btn.getAttribute('aria-label') === '@文件')
  if (ref === undefined) throw new Error('root row not found')
  return ref.parentElement as HTMLElement
}

/** A menu item button by its label text. */
function menuItemByText(text: string): HTMLButtonElement {
  const item = [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.includes(text))
  if (item === undefined) throw new Error(`menu item "${text}" not found`)
  return item as HTMLButtonElement
}

/** The single text input currently rendered (toolbar or search bar). */
function currentInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="text"]')
  if (input === null) throw new Error('no text input rendered')
  return input
}

beforeEach(() => {
  document.body.innerHTML = ''
  // The sidebar copy follows the active locale; force Chinese so the menu
  // labels asserted below match the zh dictionary.
  Object.defineProperty(navigator, 'language', { value: 'zh-CN', configurable: true })
  vi.clearAllMocks()
  vi.mocked(api.fsTree).mockResolvedValue({
    path: CWD,
    entries: [dirEntry, fileEntry],
    truncated: false,
  })
  vi.mocked(api.fsRename).mockResolvedValue({ path: `${CWD}/a.txt`, dest: `${CWD}/renamed.txt` })
  vi.mocked(api.fsRemove).mockResolvedValue({ path: `${CWD}/a.txt`, trashed: true })
  vi.mocked(api.fsMkdir).mockResolvedValue({ path: `${CWD}/new-dir` })
  vi.mocked(api.fsWrite).mockResolvedValue({ ok: true })
  vi.mocked(api.fsReveal).mockResolvedValue({ path: `${CWD}/a.txt` })
  vi.mocked(api.fsSearch).mockResolvedValue({
    path: CWD,
    query: 'needle',
    results: [{ path: `${CWD}/a.txt`, name: 'a.txt', rel: 'a.txt', type: 'file', size: 5, matchLine: 'needle line' }],
    truncated: false,
  })
})

describe('ExplorerView context menu', () => {
  it('opens a file-row menu with rename/reveal/delete/download/copy actions', async () => {
    const h = await mount()
    try {
      act(() => { contextMenuAt(rowByText('a.txt')) })
      const body = document.body.textContent ?? ''
      expect(body).toContain('重命名')
      expect(body).toContain('在 Finder 中查看')
      expect(body).toContain('删除')
      expect(body).toContain('下载')
      expect(body).toContain('复制相对地址')
      expect(body).toContain('复制绝对地址')
    } finally {
      h.cleanup()
    }
  })

  it('opens a directory-row menu with expand/new/search/delete/reveal actions', async () => {
    const h = await mount()
    try {
      act(() => { contextMenuAt(rowByText('sub')) })
      const body = document.body.textContent ?? ''
      expect(body).toContain('展开目录')
      expect(body).toContain('新建目录')
      expect(body).toContain('新建文件')
      expect(body).toContain('查找功能')
      expect(body).toContain('删除目录')
      expect(body).toContain('在 Finder 中查看')
      expect(body).not.toContain('复制相对地址')
    } finally {
      h.cleanup()
    }
  })

  it('opens a blank-area menu with new/search actions', async () => {
    const h = await mount()
    try {
      // Right-click the explorer body (the root row's parent element).
      act(() => { contextMenuAt(rootRow().parentElement!) })
      const body = document.body.textContent ?? ''
      expect(body).toContain('新建目录')
      expect(body).toContain('新建文件')
      expect(body).toContain('查找功能')
      expect(body).not.toContain('删除')
    } finally {
      h.cleanup()
    }
  })

  it('creates a directory through the inline toolbar row', async () => {
    const h = await mount()
    try {
      act(() => { contextMenuAt(rowByText('sub')) })
      act(() => { menuItemByText('新建目录').click() })
      const input = currentInput()
      expect(input.placeholder).toBe('新目录名称')
      act(() => {
        changeInput(input, 'nested')
        keyDown(input, 'Enter')
      })
      await act(async () => {})
      expect(vi.mocked(api.fsMkdir)).toHaveBeenCalledWith(
        { sessionId: 's1', cwd: CWD },
        `${CWD}/sub/nested`,
      )
      // The parent dir is reloaded after creation.
      expect(vi.mocked(api.fsTree).mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(vi.mocked(api.fsTree).mock.calls.at(-1)?.[1]).toBe(`${CWD}/sub`)
    } finally {
      h.cleanup()
    }
  })

  it('creates a file and opens it in the editor', async () => {
    const h = await mount()
    try {
      act(() => { contextMenuAt(rootRow()) })
      act(() => { menuItemByText('新建文件').click() })
      const input = currentInput()
      act(() => {
        changeInput(input, 'notes.md')
        keyDown(input, 'Enter')
      })
      await act(async () => {})
      expect(vi.mocked(api.fsWrite)).toHaveBeenCalledWith(
        { sessionId: 's1', cwd: CWD },
        `${CWD}/notes.md`,
        '',
      )
      expect(h.onOpenFile).toHaveBeenCalledWith(`${CWD}/notes.md`)
    } finally {
      h.cleanup()
    }
  })

  it('renames a file through the inline toolbar row (Enter commits)', async () => {
    const h = await mount()
    try {
      act(() => { contextMenuAt(rowByText('a.txt')) })
      act(() => { menuItemByText('重命名').click() })
      const input = currentInput()
      // The input is prefilled with the current name.
      expect(input.value).toBe('a.txt')
      act(() => {
        changeInput(input, 'renamed.txt')
        keyDown(input, 'Enter')
      })
      await act(async () => {})
      expect(vi.mocked(api.fsRename)).toHaveBeenCalledWith(
        { sessionId: 's1', cwd: CWD },
        `${CWD}/a.txt`,
        'renamed.txt',
      )
      // A transient notice confirms the outcome.
      expect(document.body.textContent).toContain('已重命名为')
    } finally {
      h.cleanup()
    }
  })

  it('deletes a file only after the confirmation modal', async () => {
    const h = await mount()
    try {
      act(() => { contextMenuAt(rowByText('a.txt')) })
      act(() => { menuItemByText('删除').click() })
      // Nothing removed yet — the modal asks first.
      expect(vi.mocked(api.fsRemove)).not.toHaveBeenCalled()
      expect(document.body.textContent).toContain('确定要删除')
      expect(document.body.textContent).toContain('回收站')
      // Confirm via the modal's primary button.
      const confirm = [...document.querySelectorAll('button')].find(btn => btn.textContent?.includes('删除'))
      act(() => { confirm!.click() })
      await act(async () => {})
      expect(vi.mocked(api.fsRemove)).toHaveBeenCalledWith(
        { sessionId: 's1', cwd: CWD },
        `${CWD}/a.txt`,
      )
      expect(document.body.textContent).toContain('已移入回收站')
    } finally {
      h.cleanup()
    }
  })

  it('cancels the delete confirmation without removing', async () => {
    const h = await mount()
    try {
      act(() => { contextMenuAt(rowByText('a.txt')) })
      act(() => { menuItemByText('删除').click() })
      const cancel = [...document.querySelectorAll('button')].find(btn => btn.textContent?.includes('取消'))
      act(() => { cancel!.click() })
      expect(vi.mocked(api.fsRemove)).not.toHaveBeenCalled()
    } finally {
      h.cleanup()
    }
  })

  it('reveals the entry in the system file manager', async () => {
    const h = await mount()
    try {
      act(() => { contextMenuAt(rowByText('a.txt')) })
      act(() => { menuItemByText('在 Finder 中查看').click() })
      expect(vi.mocked(api.fsReveal)).toHaveBeenCalledWith(
        { sessionId: 's1', cwd: CWD },
        `${CWD}/a.txt`,
      )
    } finally {
      h.cleanup()
    }
  })

  it('searches the selected directory with a debounced query', async () => {
    vi.useFakeTimers()
    const h = await mount()
    try {
      act(() => { contextMenuAt(rowByText('sub')) })
      act(() => { menuItemByText('查找功能').click() })
      const input = currentInput()
      expect(input.placeholder).toContain('查找')
      act(() => { changeInput(input, 'needle') })
      // Nothing before the debounce elapses.
      expect(vi.mocked(api.fsSearch)).not.toHaveBeenCalled()
      await act(async () => { vi.advanceTimersByTime(300) })
      await act(async () => {})
      expect(vi.mocked(api.fsSearch)).toHaveBeenCalledWith(
        { sessionId: 's1', cwd: CWD },
        `${CWD}/sub`,
        'needle',
        expect.any(AbortSignal),
      )
      // The matching line renders under the result row.
      expect(document.body.textContent).toContain('needle line')
      // Clicking a file result opens it in the editor.
      act(() => { rowByText('a.txt').click() })
      expect(h.onOpenFile).toHaveBeenCalledWith(`${CWD}/a.txt`)
    } finally {
      vi.useRealTimers()
      h.cleanup()
    }
  })
})
