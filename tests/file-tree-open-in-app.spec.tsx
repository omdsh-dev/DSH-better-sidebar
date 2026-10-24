/**
 * FileTree's host "open in app" rows, arranged by round three's menu
 * hierarchy: the host's DEFAULT handler stays one click away at level 1, and
 * every other application — the host's registered handlers AND (per the
 * visibility rule) the plugin's own fixed targets — lives in the single
 * `openWithMenu` submenu. Reveal-in-file-manager stays at level 1 while the
 * host can hand paths to a desktop.
 *
 * Visibility ("有本机检测到的关联应用时就不显示固定的 openwith 项目"):
 *   - the host lists applications for the path → plugin targets are hidden
 *     unless `openWithShowPluginTargets` (the `openWithPluginTargets` setting)
 *     turns them on;
 *   - the host is unavailable, or the listing is empty/failed → the plugin
 *     targets show (the file manager target included, so reveal is never lost).
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import { createOpenInApp, type OpenInApp, type OpenInAppEntry } from '../src/client/open-in-app.ts'
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
    // every row plain (this spec is about the open-in-app rows).
    gitStatus: async () => ({ isRepo: false, entries: [] }),
  },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

/** What the host reports for a file (the default entry first). */
const FILE_APPS: readonly OpenInAppEntry[] = [
  { id: 'textedit', name: 'TextEdit', icon: null, isDefault: true },
  { id: 'preview', name: 'Preview', icon: 'data:image/svg+xml,%3Csvg/%3E', isDefault: false },
]

/** What the host reports for a directory (no default concept). */
const DIRECTORY_APPS: readonly OpenInAppEntry[] = [
  { id: 'vscode', name: 'VS Code', icon: null, isDefault: false },
  { id: 'finder', name: 'Finder', icon: null, isDefault: false },
]

/** The plugin's own targets a caller (EditorHost) may hand FileTree. */
const PLUGIN_TARGETS: OpenWithTarget[] = [
  { id: 'explorer', nameKey: 'openWithExplorer', name: '', kind: 'reveal', isVscodeFamily: false, localOnly: true },
  { id: 'custom:w', name: 'Windsurf', kind: 'url', urlTemplate: 'windsurf://file/{path}', isVscodeFamily: false, localOnly: false },
]

interface Handle {
  openInApp: OpenInApp
  open: ReturnType<typeof vi.fn>
  reveal: ReturnType<typeof vi.fn>
  fileApps: ReturnType<typeof vi.fn>
  directoryApps: ReturnType<typeof vi.fn>
}

function makeHandle(overrides: Partial<OpenInApp> = {}): Handle {
  const open = vi.fn(async () => true)
  const reveal = vi.fn(async () => true)
  const fileApps = vi.fn(async () => FILE_APPS)
  const directoryApps = vi.fn(async () => DIRECTORY_APPS)
  const openInApp: OpenInApp = {
    available: () => true,
    probe: async () => true,
    directoryApps,
    fileApps,
    open,
    reveal,
    ...overrides,
  }
  return { openInApp, open, reveal, fileApps, directoryApps }
}

interface Harness {
  container: HTMLDivElement
  onOpenWith: ReturnType<typeof vi.fn>
  onToggleOpenWithPin: ReturnType<typeof vi.fn>
  unmount: () => void
}

async function mountTree(handle?: Handle, plugin: {
  targets?: OpenWithTarget[]
  pinned?: string[]
  ssh?: boolean
  showPluginTargets?: boolean
} = {}): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const onOpenWith = vi.fn()
  const onToggleOpenWithPin = vi.fn()
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
      ...(handle !== undefined ? { openInApp: handle.openInApp } : {}),
      ...(plugin.targets !== undefined ? {
        openWithTargets: plugin.targets,
        openWithPinned: plugin.pinned ?? [],
        openWithSsh: plugin.ssh ?? false,
        onOpenWith,
        onToggleOpenWithPin,
      } : {}),
      ...(plugin.showPluginTargets !== undefined ? { openWithShowPluginTargets: plugin.showPluginTargets } : {}),
      onReferenceFile: () => {},
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
    }))
    // Settle the async app listing / availability probe the menu triggers.
    await Promise.resolve()
    await Promise.resolve()
  })
  return {
    container,
    onOpenWith,
    onToggleOpenWithPin,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/** The row whose label text matches (rows are role="button" divs). */
function rowByName(container: HTMLElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row not found: ${name}`)
  return row
}

/** Open one row's context menu and settle the async app listing. */
async function openMenu(container: HTMLElement, name: string): Promise<void> {
  await act(async () => {
    rowByName(container, name).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }),
    )
    await Promise.resolve()
    await Promise.resolve()
  })
}

function menuItems(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

function menuLabels(): string[] {
  return menuItems().map(item => item.textContent ?? '')
}

/** The level-1 submenu parent row (the only one with aria-haspopup). */
function submenuParent(): HTMLElement {
  const parent = menuItems().find(item => item.getAttribute('aria-haspopup') === 'menu')
  if (parent === undefined) throw new Error('open-with submenu parent not found')
  return parent
}

/** Open the submenu and settle its rows. */
async function openSubmenu(): Promise<void> {
  await act(async () => {
    submenuParent().click()
    await Promise.resolve()
  })
}

function submenuRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menu"] [role="menuitem"]')]
}

function submenuLabels(): string[] {
  return submenuRows().map(item => item.textContent?.trim() ?? '')
}

function clickMenuitem(label: string): void {
  const item = menuItems().find(el => el.textContent === label)
  if (item === undefined) throw new Error(`menuitem not found: ${label}`)
  act(() => { item.click() })
}

function clickSubmenuRow(label: string): void {
  const item = submenuRows().find(el => el.textContent?.trim() === label)
  if (item === undefined) throw new Error(`submenu row not found: ${label}`)
  act(() => { item.click() })
}

let harness: Harness
afterEach(() => {
  harness.unmount()
  document.body.innerHTML = ''
})

describe('FileTree open-in-app rows in the menu hierarchy', () => {
  it('hoists the default application to level 1 and keeps every other app in the submenu', async () => {
    const handle = makeHandle()
    harness = await mountTree(handle)
    await openMenu(harness.container, 'a.ts')
    expect(handle.fileApps).toHaveBeenCalledWith('/tmp/a.ts')
    // Level 1: the default handler, the submenu and the host reveal.
    const level1 = menuLabels()
    expect(level1).toContain('Open with default app')
    expect(level1).toContain('Open with')
    expect(level1).toContain('Reveal in File Manager')
    // No application NAME sits at level 1 any more.
    expect(level1).not.toContain('TextEdit')
    expect(level1).not.toContain('Preview')
    // The submenu carries the remaining applications (and their icons).
    await openSubmenu()
    expect(submenuLabels()).toEqual(['Preview'])
    expect(submenuRows()[0]!.querySelector('img[class*="explorerAppIcon"]')).not.toBeNull()
    // No heading rows anywhere (the primitive's leaf label row is gone).
    const menu = document.querySelector('[role="menuitem"]')!.closest('[role="menu"]')
    expect([...(menu?.querySelectorAll('[role="presentation"]') ?? [])]
      .filter(row => row.children.length === 0)).toEqual([])
  })

  it('keeps the frozen level-1 order: open-with group, open escapes, zip, copy, mutations', async () => {
    const handle = makeHandle()
    harness = await mountTree(handle)
    await openMenu(harness.container, 'a.ts')
    const labels = menuLabels()
    const at = (label: string): number => {
      const index = labels.indexOf(label)
      expect(index, `missing menu row: ${label}`).toBeGreaterThanOrEqual(0)
      return index
    }
    // 1-3: default handler → the one submenu → reveal.
    expect(at('Open with default app')).toBeLessThan(at('Open with'))
    expect(at('Open with')).toBeLessThan(at('Reveal in File Manager'))
    // 4: the explicit open escapes.
    expect(at('Reveal in File Manager')).toBeLessThan(at('Open in New Tab'))
    expect(at('Open in New Tab')).toBeLessThan(at('Open to the Side'))
    // 5: the downloads (the plain file download row + the archive row).
    expect(at('Open to the Side')).toBeLessThan(at('Download'))
    // 6: copy, then the mutations.
    expect(at('Download')).toBeLessThan(at('Copy relative path'))
    expect(at('Copy relative path')).toBeLessThan(at('Rename'))
  })

  it('hands the path (and the chosen application id) to the open handle', async () => {
    const handle = makeHandle()
    harness = await mountTree(handle)
    await openMenu(harness.container, 'a.ts')
    clickMenuitem('Open with default app')
    expect(handle.open).toHaveBeenCalledWith('/tmp/a.ts')
    // Selecting closes the menu entirely.
    expect(menuItems()).toHaveLength(0)
    await openMenu(harness.container, 'a.ts')
    await openSubmenu()
    clickSubmenuRow('Preview')
    expect(handle.open).toHaveBeenCalledWith('/tmp/a.ts', 'preview')
    await openMenu(harness.container, 'a.ts')
    clickMenuitem('Reveal in File Manager')
    expect(handle.reveal).toHaveBeenCalledWith('/tmp/a.ts')
  })

  it('lists the host catalogue for a directory row, with no default row', async () => {
    const handle = makeHandle()
    harness = await mountTree(handle)
    await openMenu(harness.container, 'sub')
    expect(handle.directoryApps).toHaveBeenCalled()
    expect(handle.fileApps).not.toHaveBeenCalled()
    expect(menuLabels()).not.toContain('Open with default app')
    expect(menuLabels()).toContain('Reveal in File Manager')
    await openSubmenu()
    expect(submenuLabels()).toEqual(['VS Code', 'Finder'])
    clickSubmenuRow('Finder')
    expect(handle.open).toHaveBeenCalledWith('/tmp/sub', 'finder')
  })

  it('degrades to one DISABLED submenu row when the host knows no application', async () => {
    const handle = makeHandle({ fileApps: async () => [] })
    harness = await mountTree(handle)
    await openMenu(harness.container, 'a.ts')
    // No default handler to hoist.
    expect(menuLabels()).not.toContain('Open with default app')
    await openSubmenu()
    const empty = submenuRows().find(item => item.textContent === 'No application can open it')
    expect(empty).toBeDefined()
    expect((empty as HTMLButtonElement).disabled).toBe(true)
  })

  it('reports a failed hand-off in the error strip', async () => {
    const handle = makeHandle({ fileApps: async () => null })
    harness = await mountTree(handle)
    await openMenu(harness.container, 'a.ts')
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('Could not open: /tmp/a.ts')
  })

  it('reports a hand-off the host refused (open resolving false)', async () => {
    const handle = makeHandle()
    handle.open.mockResolvedValue(false)
    harness = await mountTree(handle)
    await openMenu(harness.container, 'a.ts')
    await act(async () => { clickMenuitem('Open with default app'); await Promise.resolve(); await Promise.resolve() })
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('Could not open: /tmp/a.ts')
  })

  it('hides the whole section when the host cannot open desktop paths', async () => {
    const handle = makeHandle({ available: () => false })
    harness = await mountTree(handle)
    await openMenu(harness.container, 'a.ts')
    expect(handle.fileApps).not.toHaveBeenCalled()
    expect(menuLabels()).not.toContain('Reveal in File Manager')
    expect(menuItems().some(item => item.getAttribute('aria-haspopup') === 'menu')).toBe(false)
    expect(document.body.textContent).not.toContain('Open with')
  })

  it('hides the section when no handle was injected at all', async () => {
    harness = await mountTree()
    await openMenu(harness.container, 'a.ts')
    expect(menuLabels()).not.toContain('Reveal in File Manager')
    expect(document.body.textContent).not.toContain('Open with')
  })

  it('probes the tri-state handle before deciding the section is unavailable', async () => {
    // The REAL adapter starts with `available() === null` and only publishes
    // an answer when `probe()` runs: a tree that reads the getter without
    // probing would hide the section forever. This case pins that lifecycle
    // with a handle that mimics it exactly.
    let probed = false
    let probes = 0
    const handle = makeHandle({
      available: () => (probed ? true : null),
      probe: async () => { probed = true; probes += 1; return true },
    })
    harness = await mountTree(handle)
    await openMenu(harness.container, 'a.ts')
    expect(handle.fileApps).toHaveBeenCalledWith('/tmp/a.ts')
    expect(menuLabels()).toContain('Open with default app')
    expect(probes).toBe(1)
  })

  it('drives the real host adapter end to end: probe, list, open, reveal', async () => {
    // No hand-written handle here — the production adapter over a fake Host
    // Remote, so the wiring (probe → fileApps → open/reveal) cannot drift.
    const calls = { canOpen: 0, applications: [] as string[], open: [] as { path: string; application?: string }[] }
    const openInApp = createOpenInApp({
      get: (name) => name !== 'remote' ? undefined : {
        session: {
          canOpenWorkspacePath: async () => { calls.canOpen += 1; return { ok: true, value: true } },
          workspacePathApplications: async (request: { path: string }) => {
            calls.applications.push(request.path)
            return { ok: true, value: [{ id: 'textedit', name: 'TextEdit', default: true, icon: null }] }
          },
          openWorkspacePath: async (request: { path: string; application?: string }) => {
            calls.open.push({ path: request.path, ...(request.application !== undefined ? { application: request.application } : {}) })
            return { ok: true }
          },
        },
      },
    })
    expect(openInApp.available()).toBeNull()
    harness = await mountTree({ openInApp } as Handle)
    await openMenu(harness.container, 'a.ts')
    expect(calls.canOpen).toBe(1)
    expect(calls.applications).toEqual(['/tmp/a.ts'])
    expect(menuLabels()).toContain('Open with default app')
    await act(async () => { clickMenuitem('Open with default app'); await Promise.resolve() })
    expect(calls.open).toEqual([{ path: '/tmp/a.ts' }])
  })
})

describe('FileTree host apps vs plugin open-with targets', () => {
  it('hides the plugin targets while the host lists applications (the default)', async () => {
    const handle = makeHandle()
    harness = await mountTree(handle, { targets: PLUGIN_TARGETS })
    await openMenu(harness.container, 'a.ts')
    await openSubmenu()
    expect(submenuLabels()).toEqual(['Preview'])
    expect(submenuLabels()).not.toContain('Windsurf')
    expect(submenuLabels()).not.toContain('File Manager')
  })

  it('keeps both lists side by side when openWithShowPluginTargets is on', async () => {
    const handle = makeHandle()
    harness = await mountTree(handle, { targets: PLUGIN_TARGETS, showPluginTargets: true })
    await openMenu(harness.container, 'a.ts')
    await openSubmenu()
    // Host applications first, then the plugin's own targets. The plugin's
    // `explorer` target stays filtered (the host reveal row stands in for it).
    expect(submenuLabels()).toEqual(['Preview', 'Windsurf'])
  })

  it('shows the plugin targets — explorer included — when the host cannot open desktop paths', async () => {
    const handle = makeHandle({ available: () => false })
    harness = await mountTree(handle, { targets: PLUGIN_TARGETS })
    await openMenu(harness.container, 'a.ts')
    // No host rows at all…
    expect(menuLabels()).not.toContain('Open with default app')
    expect(menuLabels()).not.toContain('Reveal in File Manager')
    // …but the plugin's own targets (and its reveal) survive.
    await openSubmenu()
    expect(submenuLabels()).toEqual(['File Manager', 'Windsurf'])
  })

  it('shows the plugin targets when the host listing is empty', async () => {
    const handle = makeHandle({ fileApps: async () => [] })
    harness = await mountTree(handle, { targets: PLUGIN_TARGETS })
    await openMenu(harness.container, 'a.ts')
    await openSubmenu()
    // The disabled "no application" line plus the plugin's own targets. The
    // plugin's `explorer` target stays filtered because the host IS available:
    // level 1 still carries its reveal row, so nothing is lost.
    expect(submenuLabels()).toEqual(['No application can open it', 'Windsurf'])
    expect(menuLabels()).toContain('Reveal in File Manager')
  })

  it('shows the plugin targets when no host handle was injected at all', async () => {
    harness = await mountTree(undefined, { targets: PLUGIN_TARGETS })
    await openMenu(harness.container, 'a.ts')
    expect(menuLabels()).not.toContain('Reveal in File Manager')
    await openSubmenu()
    expect(submenuLabels()).toEqual(['File Manager', 'Windsurf'])
  })

  it('routes a plugin row click from inside the submenu', async () => {
    const handle = makeHandle({ available: () => false })
    harness = await mountTree(handle, { targets: PLUGIN_TARGETS })
    await openMenu(harness.container, 'a.ts')
    await openSubmenu()
    expect(submenuRows().every(row => row.querySelector('[class*="openWithPin"]') !== null)).toBe(true)
    clickSubmenuRow('Windsurf')
    expect(harness.onOpenWith).toHaveBeenCalledWith('custom:w', '/tmp/a.ts')
  })

  it('toggles a plugin pin without selecting the row', async () => {
    const handle = makeHandle({ available: () => false })
    harness = await mountTree(handle, { targets: PLUGIN_TARGETS, pinned: ['custom:w'] })
    await openMenu(harness.container, 'a.ts')
    await openSubmenu()
    const pin = submenuRows().find(row => row.textContent?.trim() === 'Windsurf')!
      .querySelector<HTMLElement>('[class*="openWithPin"]')!
    expect(pin.getAttribute('title')).toBe('Unpin')
    act(() => { pin.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    expect(harness.onToggleOpenWithPin).toHaveBeenCalledWith('custom:w')
    expect(harness.onOpenWith).not.toHaveBeenCalled()
  })
})
