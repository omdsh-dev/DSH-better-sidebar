/**
 * FileTree's PLUGIN open-with menu. Round three folded every application into
 * ONE submenu (`openWithMenu`), so with no host handle injected the level-1
 * menu carries just that submenu row, and the plugin's targets (file manager /
 * VS Code / Cursor / Zed / custom editors) are its rows — each with the
 * per-row pushpin that toggles without selecting the row, SSH suffixes in
 * remote mode, and (without the host) the reveal target kept, so reveal is
 * never lost. The host/plugin VISIBILITY rules live in
 * file-tree-open-in-app.spec.tsx.
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import type { OpenWithTarget } from '../src/client/open-with.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so menu copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees: async (_scope: unknown, paths: readonly string[]) => ({
      levels: paths.map(path => ({ path, entries: [
        { name: 'sub', path: '/tmp/sub', isDir: true },
        { name: 'a.ts', path: '/tmp/a.ts', isDir: false },
      ], truncated: false })),
    }),
    // The tree reads the shared git-status store; a non-repo answer keeps
    // every row plain.
    gitStatus: async () => ({ isRepo: false, entries: [] }),
  },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
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
      revealed: [],
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
    await Promise.resolve()
  })
  return {
    container,
    onOpenWith,
    onToggleOpenWithPin,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/** The file row of the one-level tree. */
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

function menuItems(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

function submenuRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menu"] [role="menuitem"]')]
}

function submenuParent(): HTMLElement {
  const parent = menuItems().find(item => item.getAttribute('aria-haspopup') === 'menu')
  if (parent === undefined) throw new Error('submenu parent not found')
  return parent
}

describe('FileTree plugin open-with menu', () => {
  let harness: Harness
  afterEach(() => {
    harness.unmount()
    document.body.innerHTML = ''
    document.body.removeAttribute('data-dsh-sidebar-submenu')
  })

  it('keeps application rows out of level 1 and lists them under the open-with submenu', async () => {
    harness = await mountTree()
    openMenu(harness.container)
    // Level 1: the one submenu parent — no application name sits on it.
    expect(menuItems().map(item => item.textContent?.trim())).toContain('Open with')
    for (const name of ['File Manager', 'VS Code', 'Cursor', 'Zed', 'Windsurf']) {
      expect(menuItems().map(item => item.textContent?.trim())).not.toContain(name)
    }
    const parent = submenuParent()
    // The submenu parent carries the trailing chevron affordance (the
    // primitives Menu renders no arrow of its own), right-aligned inside a
    // full-width label row — the same structure the submenu children use.
    expect(parent.querySelector('[class*="openWithChevron"]')).not.toBeNull()
    expect(parent.querySelector('[class*="openWithLabel"]')).not.toBeNull()
  })

  it('lists every target in the submenu, each with a pin toggle', async () => {
    harness = await mountTree()
    openMenu(harness.container)
    act(() => { submenuParent().click() })
    expect(submenuRows().map(item => item.textContent?.trim())).toEqual([
      'File Manager', 'VS Code', 'Cursor', 'Zed', 'Windsurf',
    ])
    expect(submenuRows().every(item => item.querySelector('[class*="openWithPin"]') !== null)).toBe(true)
    // Pinned state is carried per row by the pin's TITLE (it swaps the glyph
    // and the hover hint).
    const vscodeRow = submenuRows().find(item => item.textContent?.trim() === 'VS Code')
    const cursorRow = submenuRows().find(item => item.textContent?.trim() === 'Cursor')
    expect(vscodeRow?.querySelector('[title="Unpin"]')).not.toBeNull()
    expect(cursorRow?.querySelector('[title="Pin to menu"]')).not.toBeNull()
  })

  it('keeps the pin a mouse hot zone, never a fake nested control', async () => {
    // The Menu renders each row as `<button role="menuitem">`, so ANY
    // role=button/tabIndex on the pin would be invalid nesting AND
    // unreachable by keyboard (the row button owns focus). It is deliberately
    // a plain span: the pin's nameable affordance is its `title`, and the
    // reachable path to the same pinned list is the settings panel.
    harness = await mountTree()
    openMenu(harness.container)
    act(() => { submenuParent().click() })
    const vscodePin = submenuRows().find(item => item.textContent?.trim() === 'VS Code')!
      .querySelector<HTMLElement>('[class*="openWithPin"]')!
    expect(vscodePin.tagName).toBe('SPAN')
    expect(vscodePin.getAttribute('role')).toBeNull()
    expect(vscodePin.hasAttribute('tabindex')).toBe(false)
    expect(vscodePin.getAttribute('title')).toBe('Unpin')
    // The row itself stays the only interactive element of the entry.
    expect(vscodePin.closest('[role="menuitem"]')?.tagName).toBe('BUTTON')
  })

  it('pin click toggles without selecting the row or closing the menu', async () => {
    harness = await mountTree()
    openMenu(harness.container)
    act(() => { submenuParent().click() })
    const cursorRow = submenuRows().find(item => item.textContent?.trim() === 'Cursor')!
    const pin = cursorRow.querySelector<HTMLElement>('[class*="openWithPin"]')
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
    act(() => { submenuParent().click() })
    const zedRow = submenuRows().find(item => item.textContent?.trim() === 'Zed')!
    act(() => { zedRow.click() })
    expect(harness.onOpenWith).toHaveBeenCalledWith('zed', '/tmp/a.ts')
    // Selecting closes the row menu entirely.
    expect(document.querySelector('[role="menu"] [role="menu"]')).toBeNull()
    expect(menuItems()).toHaveLength(0)
  })

  it('appends the SSH hint to VSCode-family labels in remote mode (reveal stays)', async () => {
    // The SSH-resolved list keeps `explorer` (see resolveOpenWithTargets):
    // reveal runs on the machine that owns the workspace, and it is the only
    // reveal left when the DSH host's open-in-app capability is unavailable.
    // Dropping it here would test a list the caller never produces.
    harness = await mountTree({
      openWithSsh: true,
      openWithTargets: targets.filter(target => !target.localOnly || target.kind === 'reveal'),
      openWithPinned: [],
    })
    openMenu(harness.container)
    act(() => { submenuParent().click() })
    expect(submenuRows().map(item => item.textContent?.trim())).toEqual([
      'File Manager', 'VS Code (SSH)', 'Cursor (SSH)', 'Windsurf (SSH)',
    ])
  })

  it('hides the submenu when the caller wires no targets (and no host handle)', async () => {
    harness = await mountTree({ openWithTargets: undefined })
    openMenu(harness.container)
    expect(menuItems().some(item => item.textContent?.includes('Open with'))).toBe(false)
    expect(menuItems().some(item => item.getAttribute('aria-haspopup') === 'menu')).toBe(false)
  })

  /**
   * #412's failure mode was a click that produced NO feedback at all: the host
   * route answered `{ started: true }` for a launch that opened nothing. The
   * caller now answers whether the hand-off was accepted, and both refusals
   * (a `false` answer and a rejected launch) must land in the strip the
   * host-backed rows already use.
   */
  it('reports a refused hand-off (caller answers false) in the action strip', async () => {
    harness = await mountTree()
    harness.onOpenWith.mockReturnValue(false)
    openMenu(harness.container)
    act(() => { submenuParent().click() })
    const zedRow = submenuRows().find(item => item.textContent?.trim() === 'Zed')!
    await act(async () => {
      zedRow.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('Could not open: /tmp/a.ts')
  })

  it('reports a rejected hand-off in the same action strip', async () => {
    harness = await mountTree()
    harness.onOpenWith.mockRejectedValue(new Error('spawn cmd.exe ENOENT'))
    openMenu(harness.container)
    act(() => { submenuParent().click() })
    const zedRow = submenuRows().find(item => item.textContent?.trim() === 'Zed')!
    await act(async () => {
      zedRow.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('Could not open: /tmp/a.ts')
  })
})

describe('FileTree plugin open-with menu flip geometry (submenu clamping)', () => {
  const ATTR = 'data-dsh-sidebar-submenu'

  let harness: Harness
  afterEach(() => {
    harness.unmount()
    document.body.innerHTML = ''
    document.body.removeAttribute(ATTR)
  })

  it('publishes "down" for a top-of-tree opening and clears on selection', async () => {
    harness = await mountTree()
    // openMenu() right-clicks at (20, 30) — the upper half, plenty of right
    // room in jsdom's default viewport.
    openMenu(harness.container)
    expect(document.body.getAttribute(ATTR)).toBe('down')
    act(() => { submenuParent().click() })
    const zedRow = submenuRows().find(item => item.textContent?.trim() === 'Zed')!
    act(() => { zedRow.click() })
    expect(menuItems()).toHaveLength(0)
    expect(document.body.hasAttribute(ATTR)).toBe(false)
  })

  it('adds "left" when the cursor sits within the right-hand submenu room', async () => {
    harness = await mountTree()
    const nearRight = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: window.innerWidth - 10, clientY: 30 })
    act(() => { fileRow(harness.container).dispatchEvent(nearRight) })
    expect(document.body.getAttribute(ATTR)).toBe('down left')
  })

  it('clears the attribute on unmount with the menu still open', async () => {
    harness = await mountTree()
    openMenu(harness.container)
    expect(document.body.getAttribute(ATTR)).toBe('down')
    harness.unmount()
    expect(document.body.hasAttribute(ATTR)).toBe(false)
  })
})
