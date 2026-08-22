/**
 * FileTree "open with" context menu: a file row's right-click menu gains the
 * pinned direct rows and the parent submenu row; the submenu lists every
 * resolved target with a per-row pushpin, pinning never selects/closes the
 * menu, and selecting a child invokes the caller's open handler with the
 * row's absolute path. When the caller wires nothing, the section is absent.
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import type { OpenWithTarget } from '../src/client/open-with.ts'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// vitest 4.1.11+ follows the OS locale; pin en-US so menu copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTree: async () => ({
      entries: [{ name: 'a.ts', path: '/tmp/a.ts', isDir: false }],
    }),
  },
  downloadUrl: () => '/sidebar/file',
}))

/** The resolved target list a caller (EditorHost) would hand FileTree. */
const targets: OpenWithTarget[] = [
  { id: 'explorer', nameKey: 'openWithExplorer', name: '', kind: 'reveal', isVscodeFamily: false, localOnly: true },
  { id: 'vscode', nameKey: 'openWithVscode', name: '', kind: 'url', urlTemplate: 'vscode://file/{path}', isVscodeFamily: true, localOnly: false },
  { id: 'cursor', nameKey: 'openWithCursor', name: '', kind: 'url', urlTemplate: 'cursor://file/{path}', isVscodeFamily: true, localOnly: false },
  { id: 'zed', nameKey: 'openWithZed', name: '', kind: 'url', urlTemplate: 'zed://file/{path}', isVscodeFamily: false, localOnly: true },
  { id: 'custom:w', name: 'Windsurf', kind: 'url', urlTemplate: 'windsurf://file/{path}', isVscodeFamily: false, localOnly: false },
]

interface Harness {
  container: HTMLDivElement
  onOpenWith: ReturnType<typeof vi.fn>
  onToggleOpenWithPin: ReturnType<typeof vi.fn>
  unmount: () => void
}

async function mountTree(overrides: {
  openWithTargets?: OpenWithTarget[]
  openWithPinned?: string[]
  openWithSsh?: boolean
} = {}): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const onOpenWith = vi.fn()
  const onToggleOpenWithPin = vi.fn()
  // Property-presence semantics: an explicit `openWithTargets: undefined`
  // must reach FileTree (the section hides) instead of falling back.
  const has = (key: 'openWithTargets' | 'openWithPinned' | 'openWithSsh'): boolean =>
    Object.prototype.hasOwnProperty.call(overrides, key)
  await act(async () => {
    root.render(createElement(FileTree, {
      sessionId: 's1',
      cwd: '/tmp',
      expanded: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onOpenFileNewTab: () => {},
      onOpenFileSide: () => {},
      openWithTargets: has('openWithTargets') ? overrides.openWithTargets : targets,
      openWithPinned: has('openWithPinned') ? overrides.openWithPinned : ['vscode'],
      openWithSsh: has('openWithSsh') ? overrides.openWithSsh : false,
      onOpenWith,
      onToggleOpenWithPin,
      onReferenceFile: () => {},
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
    }))
  })
  return {
    container,
    onOpenWith,
    onToggleOpenWithPin,
    unmount: () => { act(() => { root.unmount() }) },
  }
}

/** The file row of the one-level tree (role="button" with the name span). */
function fileRow(container: HTMLDivElement): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === 'a.ts')
  if (row === undefined) throw new Error('file row not found')
  return row
}

/** Open the row's context menu at a fixed cursor position. */
function openMenu(container: HTMLDivElement): void {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })
  act(() => { fileRow(container).dispatchEvent(event) })
}

describe('FileTree open-with menu', () => {
  let harness: Harness
  afterEach(() => {
    harness.unmount()
    document.body.innerHTML = ''
  })

  it('renders the pinned direct row and the submenu parent for a file row', async () => {
    harness = await mountTree()
    openMenu(harness.container)
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    // The pinned VS Code sits at the top level (before the submenu parent).
    expect(items.map(item => item.textContent?.trim())).toContain('VS Code')
    const parent = items.find(item => item.getAttribute('aria-haspopup') === 'menu')
    expect(parent?.textContent).toContain('Open with')
    // The submenu parent carries the trailing chevron affordance (the
    // primitives Menu renders no arrow of its own), right-aligned inside a
    // full-width label row — the same structure the submenu children use.
    expect(parent?.querySelector('[class*="openWithChevron"]')).not.toBeNull()
    expect(parent?.querySelector('[class*="openWithLabel"]')).not.toBeNull()
  })

  it('opens the submenu on click and lists every target with pin toggles', async () => {
    harness = await mountTree()
    openMenu(harness.container)
    const parent = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find(item => item.getAttribute('aria-haspopup') === 'menu')
    expect(parent).toBeDefined()
    act(() => { parent!.click() })
    // Sub child rows = menuitems inside the nested menu.
    const children = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menu"] [role="menuitem"]')]
    expect(children.map(item => item.textContent?.trim())).toEqual([
      'File Manager', 'VS Code', 'Cursor', 'Zed', 'Windsurf',
    ])
    expect(children.every(item => item.querySelector('[class*="openWithPin"]') !== null)).toBe(true)
    // Pinned state is announced per row (and swaps the pushpin glyph).
    const vscodeRow = children.find(item => item.textContent?.trim() === 'VS Code')
    const cursorRow0 = children.find(item => item.textContent?.trim() === 'Cursor')
    expect(vscodeRow?.querySelector('[aria-label="Unpin"]')).not.toBeNull()
    expect(cursorRow0?.querySelector('[aria-label="Pin to menu"]')).not.toBeNull()
  })

  it('pin click toggles without selecting the row or closing the menu', async () => {
    harness = await mountTree()
    openMenu(harness.container)
    const parent = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find(item => item.getAttribute('aria-haspopup') === 'menu')
    act(() => { parent!.click() })
    const cursorRow = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menu"] [role="menuitem"]')]
      .find(item => item.textContent?.trim() === 'Cursor')
    const pin = cursorRow!.querySelector<HTMLElement>('[class*="openWithPin"]')
    expect(pin).not.toBeNull()
    act(() => { pin!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    expect(harness.onToggleOpenWithPin).toHaveBeenCalledWith('cursor')
    expect(harness.onOpenWith).not.toHaveBeenCalled()
    // The menu (and the submenu) stayed open.
    expect(document.querySelector('[role="menu"] [role="menu"]')).not.toBeNull()
  })

  it('selecting a submenu child invokes onOpenWith with the row path and closes the menu', async () => {
    harness = await mountTree()
    openMenu(harness.container)
    const parent = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find(item => item.getAttribute('aria-haspopup') === 'menu')
    act(() => { parent!.click() })
    const zedRow = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menu"] [role="menuitem"]')]
      .find(item => item.textContent?.trim() === 'Zed')
    act(() => { zedRow!.click() })
    expect(harness.onOpenWith).toHaveBeenCalledWith('zed', '/tmp/a.ts')
    // Selecting closes the row menu entirely.
    expect(document.querySelector('[role="menu"] [role="menu"]')).toBeNull()
    expect(document.querySelector('[role="menuitem"]')).toBeNull()
  })

  it('appends the SSH hint to VSCode-family labels in remote mode', async () => {
    harness = await mountTree({
      openWithSsh: true,
      openWithTargets: targets.filter(target => !target.localOnly),
      openWithPinned: [],
    })
    openMenu(harness.container)
    const parent = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find(item => item.getAttribute('aria-haspopup') === 'menu')
    act(() => { parent!.click() })
    const children = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menu"] [role="menuitem"]')]
    expect(children.map(item => item.textContent?.trim())).toEqual([
      'VS Code (SSH)', 'Cursor (SSH)', 'Windsurf (SSH)',
    ])
  })

  it('hides the whole section when the caller wires no targets', async () => {
    harness = await mountTree({ openWithTargets: undefined })
    openMenu(harness.container)
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(items.some(item => item.textContent?.includes('Open with'))).toBe(false)
    expect(items.some(item => item.getAttribute('aria-haspopup') === 'menu')).toBe(false)
  })
})
