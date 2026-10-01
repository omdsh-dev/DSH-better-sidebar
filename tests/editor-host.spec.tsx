/**
 * EditorHost (the files window): in merged (in-place) mode a path-less tab
 * renders the empty-state hint with the tree dock open, and the header's
 * tree toggle persists its flag through ctx.betterSidebar.updateTab
 * (meta.treeOpen rides the tab's persisted layout). The editorExplorer pref
 * controls FILE-OPEN behavior — in-place rewrites the current tab via
 * updateTab, split opens a per-path dedupe tab via openSidebarFile — and in
 * split mode a PATH-LESS window becomes the standalone explorer (tree panel
 * only, no editor chrome); file tabs keep the full chrome in both modes.
 */
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createElement, useEffect, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { Context } from '../src/context-types.ts'
import { EditorHost } from '../src/client/EditorHost.tsx'
import { createBetterSidebarService, type FileViewerProps } from '../src/client/service.ts'
import { allLeaves, createSidebarStore, type SidebarTab } from '../src/client/state.ts'

// The tree mounts inside EditorHost in these scenarios, so the api seam must
// answer without a host (the sibling FileTree specs mock it the same way).
vi.mock('../src/client/api.ts', () => ({
  api: {
    // The tree lists its visible set in ONE batched call.
    fsTrees: async (_scope: unknown, paths: readonly string[]) => ({
      levels: paths.map(path => ({
        path,
        entries: [
          { name: 'sub', path: '/tmp/sub', isDir: true },
          { name: 'a.ts', path: '/tmp/a.ts', isDir: false },
        ],
        truncated: false,
      })),
    }),
    // The shared git-status store polls this; a non-repo answer keeps rows plain.
    gitStatus: async () => ({ isRepo: false, entries: [] }),
    archiveBuild: async () => ({ id: 'ar-1', entries: 1 }),
    archiveStatus: async () => ({ state: 'ready', done: 1, total: 1, bytes: 1 }),
    openExternal: async () => ({ started: true }),
  },
  archiveDownloadUrl: () => '/sidebar/archive?id=ar-1',
  downloadUrl: () => '/sidebar/file',
  mediaUrl: () => '/sidebar/file',
  archiveUrl: () => '/sidebar/archive',
  isOutsideWorkspaceMessage: () => false,
}))

// The act() environment flag (React 18.2 reads it before flushing effects).
import { setupReactAct } from './test-utils.ts'
setupReactAct()

/** A store with the seeded editor-home tab (default prefs: separate mode;
 *  merged-mode scenarios re-enable editorExplorer explicitly). */
function setup(): {
  store: ReturnType<typeof createSidebarStore>
  ctx: Context
  homeTab: () => SidebarTab
} {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  // The openTab path needs a registered editor descriptor (dedupe by path).
  service.registerTab({ id: 'editor', title: 'Editor', dedupeKey: (tab) => tab.path, component: () => null })
  store.setSession('editor-home-session')
  // The workbench seeds EMPTY (the right panel that used to carry the default
  // files window is DSH's native Sidebar now), so these editor-host scenarios
  // open the path-less files window explicitly — exactly what the shell does
  // when the files page is opened.
  service.openTab({ type: 'editor', title: 'Files', meta: { treeOpen: true } })
  const homeTab = (): SidebarTab =>
    allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
      .find(tab => tab.type === 'editor' && tab.path === undefined)!
  // openSidebarFile reads the session cwd from ctx.sessions.
  const sessionsSnapshot = { byId: { 'editor-home-session': { cwd: '/tmp' } }, current: 'editor-home-session' }
  const ctx = {
    betterSidebar: service,
    get: (name: string) => name === 'betterSidebar' ? service : undefined,
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } },
  } as unknown as Context
  return { store, ctx, homeTab }
}

/** Mount the host for one tab; returns the container and an unmount helper. */
function mountHost(ctx: Context, store: ReturnType<typeof createSidebarStore>, tab: () => SidebarTab): {
  container: HTMLDivElement
  rerender: () => void
  unmount: () => void
} {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = (): void => {
    root.render(createElement(EditorHost, {
      ctx,
      store,
      scope: { sessionId: 'editor-home-session' },
      tab: tab(),
      expanded: [],
      revealed: [],
      onToggleDir: () => {},
      onReferenceFile: () => {},
    }))
  }
  act(render)
  return {
    container,
    // The real app re-renders the host with the fresh tab on every store
    // change (Sidebar subscribes); mirror that after mutating the store.
    rerender: () => { act(render) },
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

/**
 * Mount the host AND let the docked tree finish its async level load (the
 * context-menu scenarios need the file row in the DOM). The scope carries the
 * session cwd — without a root the docked tree has nothing to list.
 */
async function mountHostWithTreeWithCwd(ctx: Context, store: ReturnType<typeof createSidebarStore>, tab: () => SidebarTab): Promise<{
  container: HTMLDivElement
  unmount: () => void
}> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(EditorHost, {
      ctx,
      store,
      scope: { sessionId: 'editor-home-session', cwd: '/tmp' },
      tab: tab(),
      expanded: [],
      revealed: [],
      onToggleDir: () => {},
      onReferenceFile: () => {},
    }))
    await Promise.resolve()
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

/** Type into the controlled path input (native setter) and press Enter. */
function typeAndCommit(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

describe('EditorHost (files window)', () => {
  it('a path-less tab renders the empty-state hint with the tree panel open', () => {
    const { store, ctx, homeTab } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: true })
    const { container, unmount } = mountHost(ctx, store, homeTab)
    try {
      const html = container.innerHTML
      // The empty-state hint renders instead of the viewer loading flow.
      expect(html).toContain('Pick a file from the tree panel')
      expect(html).not.toContain('Loading…')
      // The header carries the path input and the pressed tree toggle; the
      // docked panel (search box) is open by default for path-less tabs.
      expect(container.querySelector('input')).not.toBeNull()
      const toggle = container.querySelector('button[aria-pressed]')
      expect(toggle?.getAttribute('aria-pressed')).toBe('true')
      // No cwd: the embedded tree renders its no-session placeholder
      // instead of touching the network.
      expect(html).toContain('Select a conversation')
    } finally {
      unmount()
    }
  })

  it('the tree toggle persists meta.treeOpen through updateTab', () => {
    const { store, ctx, homeTab } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: true })
    expect(homeTab().meta).toEqual({ treeOpen: true })
    const { container, rerender, unmount } = mountHost(ctx, store, homeTab)
    try {
      act(() => {
        container.querySelector('button[aria-pressed]')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(homeTab().meta).toEqual({ treeOpen: false })
      // The store change re-renders the host with the fresh tab (Sidebar's
      // subscription in the real app); the second click flips it back.
      rerender()
      expect(container.querySelector('button[aria-pressed]')?.getAttribute('aria-pressed')).toBe('false')
      act(() => {
        container.querySelector('button[aria-pressed]')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(homeTab().meta).toEqual({ treeOpen: true })
    } finally {
      unmount()
    }
  })

  it('in-place mode: the path input Enter switches the CURRENT tab (stable id, meta kept)', () => {
    const { store, ctx, homeTab } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: true })
    const { container, unmount } = mountHost(ctx, store, homeTab)
    try {
      const before = homeTab()
      typeAndCommit(container.querySelector('input')!, '/tmp/a.ts')
      // The same tab id now carries the file (homeTab's path-less finder no
      // longer matches — look the tab up by id).
      const after = allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.id === before.id)!
      expect(after.id).toBe(before.id)
      expect(after.path).toBe('/tmp/a.ts')
      expect(after.title).toBe('a.ts')
      expect(after.meta).toEqual({ treeOpen: true })
      // No new tab landed.
      expect(allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)).toHaveLength(1)
    } finally {
      unmount()
    }
  })

  it('split mode: a file tab\'s path input Enter opens a NEW per-path tab; the source tab keeps its path', () => {
    const { store, ctx } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: false })
    ctx.betterSidebar.openTab({ type: 'editor', title: 'a.ts', path: '/tmp/a.ts', id: 'editor:/tmp/a.ts' })
    const fileTab = (): SidebarTab =>
      allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.path === '/tmp/a.ts')!
    const { container, unmount } = mountHost(ctx, store, fileTab)
    try {
      typeAndCommit(container.querySelector('input[placeholder^="File path"]')!, '/tmp/b.ts')
      const tabs = allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
      // home + a.ts + b.ts
      expect(tabs).toHaveLength(3)
      expect(fileTab().path).toBe('/tmp/a.ts')
      const opened = tabs.find(tab => tab.path === '/tmp/b.ts')!
      expect(opened.type).toBe('editor')
      expect(opened.title).toBe('b.ts')
      expect(opened.id).toBe('editor:/tmp/b.ts')
    } finally {
      unmount()
    }
  })

  it('split mode: the path-less window is the standalone explorer (tree only, no chrome)', () => {
    const { store, ctx, homeTab } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: false })
    const { container, unmount } = mountHost(ctx, store, homeTab)
    try {
      // No editor chrome: no path input, no tree toggle, no resize handle.
      expect(container.querySelector('input[placeholder^="File path"]')).toBeNull()
      expect(container.querySelector('button[aria-pressed]')).toBeNull()
      expect(container.querySelector('[role="separator"]')).toBeNull()
      // The tree panel fills the whole window — its search box is the only
      // input, and (no cwd) the tree shows its no-session placeholder.
      expect(container.querySelector('input[placeholder^="Search files"]')).not.toBeNull()
      expect(container.innerHTML).toContain('Select a conversation')
    } finally {
      unmount()
    }
  })

  it('split mode: a file tab keeps the full chrome (path input + tree toggle + dock)', () => {
    const { store, ctx } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: false })
    ctx.betterSidebar.openTab({
      type: 'editor', title: 'a.ts', path: '/tmp/a.ts', id: 'editor:/tmp/a.ts', meta: { treeOpen: true },
    })
    const fileTab = (): SidebarTab =>
      allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.path === '/tmp/a.ts')!
    const { container, unmount } = mountHost(ctx, store, fileTab)
    try {
      expect(container.querySelector('input[placeholder^="File path"]')).not.toBeNull()
      expect(container.querySelector('button[aria-pressed]')?.getAttribute('aria-pressed')).toBe('true')
      expect(container.querySelector('[role="separator"]')).not.toBeNull()
    } finally {
      unmount()
    }
  })

  it('dragging the panel edge resizes the dock and persists meta.treeWidth on release', async () => {
    const { store, ctx, homeTab } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: true })
    const { container, unmount } = mountHost(ctx, store, homeTab)
    try {
      const handle = container.querySelector('[role="separator"]')!
      expect(handle).not.toBeNull()
      // The dock starts at the default width.
      const dock = handle.parentElement!
      expect(dock.style.width).toBe('240px')
      // Drag the left edge LEFT by 100px → the right-docked panel widens.
      // Pointer capture keeps move/up on the handle (jsdom: MouseEvent with
      // pointer* type names; setPointerCapture is absent and skipped).
      // Moves are batched to one application per frame (#315), so flush the
      // pending frame before asserting the width.
      act(() => {
        handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 300 }))
        handle.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 200 }))
      })
      await act(async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      })
      expect(dock.style.width).toBe('340px')
      // Release: the drag state clears and the width persists on the tab.
      act(() => { handle.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 200 })) })
      expect(homeTab().meta).toEqual({ treeOpen: true, treeWidth: 340 })
    } finally {
      unmount()
    }
  })

  it('the header hosts the viewer toolbar (mode toggle / dirty dot / save)', () => {
    const { store, ctx } = setup()
    const service = ctx.betterSidebar
    const calls: string[] = []
    // A viewer with a hoisted toolbar (the TextEditor contract): register
    // commands and report the state once on mount. Capitalized so the hooks
    // rules recognize it as a component.
    const FakeViewer = (viewerProps: FileViewerProps): ReactNode => {
      useEffect(() => {
        viewerProps.onToolbarControls?.({
          setMode: (next) => { calls.push(`mode:${next}`) },
          save: () => { calls.push('save') },
        })
        viewerProps.onToolbarState?.({ modes: true, mode: 'preview', dirty: true, editable: true, saveState: 'idle' })
        return () => { viewerProps.onToolbarControls?.(null) }
        // Mount-only: re-running would re-fire the toolbar registration.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])
      return null
    }
    service.registerFileViewer({
      id: 'test:fake',
      exts: ['fake'],
      fetchStrategy: 'none',
      component: FakeViewer,
    })
    service.openTab({ type: 'editor', title: 'x.fake', path: '/tmp/x.fake', id: 'editor:/tmp/x.fake' })
    const fileTab = (): SidebarTab =>
      allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.path === '/tmp/x.fake')!
    const { container, unmount } = mountHost(ctx, store, fileTab)
    try {
      // Mode toggle + dirty dot + save button sit in the header row.
      const header = container.querySelector('input')!.parentElement!
      const buttons = [...header.querySelectorAll('button')]
      expect(buttons.map(b => b.textContent)).toContain('Preview')
      expect(buttons.map(b => b.textContent)).toContain('Edit')
      expect(header.querySelector('button[aria-label="Save"]')).not.toBeNull()
      expect(header.querySelector('[title="Unsaved"]')).not.toBeNull()
      // The header commands reach the viewer's registered controls.
      act(() => { buttons.find(b => b.textContent === 'Edit')!.click() })
      act(() => { header.querySelector<HTMLButtonElement>('button[aria-label="Save"]')!.click() })
      expect(calls).toEqual(['mode:edit', 'save'])
    } finally {
      unmount()
    }
  })

  it('the header hides the save button for a truncated load (#732)', () => {
    const { store, ctx } = setup()
    const service = ctx.betterSidebar
    // The TextEditor contract reports `truncated` alongside `editable`; the
    // host's merged header must not offer save while only partial content
    // is loaded (fs.write would replace the whole file with the prefix).
    let report: ((truncated: boolean) => void) | undefined
    const FakeViewer = (viewerProps: FileViewerProps): ReactNode => {
      useEffect(() => {
        viewerProps.onToolbarControls?.({ setMode: () => {}, save: () => {} })
        viewerProps.onToolbarState?.({ modes: true, mode: 'preview', dirty: false, editable: true, truncated: true, saveState: 'idle' })
        report = (truncated) => {
          viewerProps.onToolbarState?.({ modes: true, mode: 'preview', dirty: false, editable: true, truncated, saveState: 'idle' })
        }
        return () => { viewerProps.onToolbarControls?.(null) }
        // Mount-only: re-running would re-fire the toolbar registration.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])
      return null
    }
    service.registerFileViewer({
      id: 'test:fake',
      exts: ['fake'],
      fetchStrategy: 'none',
      component: FakeViewer,
    })
    service.openTab({ type: 'editor', title: 'big.fake', path: '/tmp/big.fake', id: 'editor:/tmp/big.fake' })
    const fileTab = (): SidebarTab =>
      allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.path === '/tmp/big.fake')!
    const { container, unmount } = mountHost(ctx, store, fileTab)
    try {
      const header = container.querySelector('input')!.parentElement!
      expect(header.querySelector('button[aria-label="Save"]')).toBeNull()
      // A full read replacing the content re-enables saving.
      act(() => { report!(false) })
      expect(header.querySelector('button[aria-label="Save"]')).not.toBeNull()
    } finally {
      unmount()
    }
  })

  it('a folder tab (meta.dir) renders the tree rooted at the folder, no editor chrome', () => {
    const { store, ctx } = setup()
    ctx.betterSidebar!.openTab({
      type: 'editor',
      title: 'src',
      path: '/work/src',
      id: 'editor:/work/src',
      meta: { dir: true },
    }, { sessionId: 'editor-home-session' })
    const dirTab = (): SidebarTab =>
      allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.path === '/work/src')!
    const { container, unmount } = mountHost(ctx, store, dirTab)
    try {
      const html = container.innerHTML
      // The folder window is the full tree surface: the folder basename is
      // the tree root row and the search box is present; the editor empty
      // hint and the file path input are NOT.
      expect(html).toContain('src')
      expect(html).toContain('Search files by name…')
      expect(html).not.toContain('Pick a file from the tree panel')
      expect(html).not.toContain('File path (relative')
    } finally {
      unmount()
    }
  })
})

/**
 * "Open to the Side" from a NATIVE tab must reach the host's own split, not
 * the plugin's bottom workbench: a native right-Sidebar tab is absent from
 * `bottomSplits`, so the old code fell through to `firstLeaf` — a pane the
 * user had not expanded, i.e. "the menu item does nothing".
 */
describe('EditorHost "open to the side"', () => {
  /** A service whose openTab calls are recorded (surface undefined = native). */
  function spyService(store: ReturnType<typeof createSidebarStore>): {
    service: ReturnType<typeof createBetterSidebarService>
    opens: Array<{ type: string; path?: string; target?: string }>
  } {
    const service = createBetterSidebarService(store)
    const opens: Array<{ type: string; path?: string; target?: string }> = []
    const real = service.openTab.bind(service)
    service.openTab = ((seed, scope) => {
      opens.push({ type: seed.type, ...(seed.path === undefined ? {} : { path: seed.path }), ...(seed.target === undefined ? {} : { target: seed.target }) })
      real(seed, scope)
    }) as typeof service.openTab
    return { service, opens }
  }

  /** The fake client ctx (service + session feed); cwd matches api.fsTree. */
  function fakeCtx(service: ReturnType<typeof createBetterSidebarService>): Context {
    const sessionsSnapshot = { byId: { 'editor-home-session': { cwd: '/tmp' } }, current: 'editor-home-session' }
    return {
      betterSidebar: service,
      get: (name: string) => name === 'betterSidebar' ? service : undefined,
      sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } },
    } as unknown as Context
  }

  /** Mount a native-hosting editor window whose tab is NOT in bottomSplits. */
  async function mountNative(ctx: Context, store: ReturnType<typeof createSidebarStore>, service: ReturnType<typeof createBetterSidebarService>): Promise<{
    container: HTMLDivElement
    unmount: () => void
  }> {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    // The tab record the native seat hands the component: an editor window for
    // /tmp/a.ts whose id never enters the plugin's own layout.
    const nativeTab: SidebarTab = {
      id: 'native-editor-1',
      type: 'editor',
      title: 'a.ts',
      path: '/tmp/a.ts',
      meta: { treeOpen: true },
    }
    await act(async () => {
      root.render(createElement(EditorHost, {
        ctx,
        store,
        // The tree needs a root: the real seat hands the session cwd in scope.
        scope: { sessionId: 'editor-home-session', cwd: '/tmp' },
        visible: true,
        tab: nativeTab,
        expanded: [],
        revealed: [],
        onToggleDir: () => {},
        onReferenceFile: () => {},
      }))
      await Promise.resolve()
      await Promise.resolve()
    })
    void service
    return {
      container,
      unmount: () => {
        act(() => { root.unmount() })
        container.remove()
      },
    }
  }

  function clickOpenToSide(container: HTMLDivElement): void {
    const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
      .find(el => el.querySelector('[class*="explorerName"]')?.textContent === 'a.ts')
    if (row === undefined) {
      throw new Error(`file row not found; names=${[...container.querySelectorAll('[class*="explorerName"]')].map(el => el.textContent).join('|')}; html=${container.innerHTML.slice(0, 400)}`)
    }
    act(() => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
    })
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find(el => el.textContent?.trim() === 'Open to the Side')
    if (item === undefined) throw new Error('side-open menu item not found')
    act(() => { item.click() })
  }

  function tabCount(store: ReturnType<typeof createSidebarStore>): number {
    return allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs).length
  }

  it('asks the service for a side open and leaves the bottom workbench untouched', async () => {
    const store = createSidebarStore()
    const { service, opens } = spyService(store)
    service.registerTab({ id: 'editor', title: 'Editor', dedupeKey: (tab) => tab.path, component: () => null })
    store.setSession('editor-home-session')
    // A native surface is what makes the service native-hosted at all: the
    // fake records what the service asks of the host (the real one forwards to
    // `ctx.sidebarRight`).
    const placed: Array<{ address: string; preferNewPane?: boolean; revealIfOpened?: boolean }> = []
    service.setSurface({
      openTab: () => {},
      openResource: (input) => { placed.push({ address: input.address, ...(input.preferNewPane === undefined ? {} : { preferNewPane: input.preferNewPane }), revealIfOpened: input.revealIfOpened }) },
      fileAddress: (sessionId, cwd, path) => `dsh-resource://file/${sessionId}${path}`,
      close: () => undefined,
      update: () => false,
      activate: () => false,
      has: () => false,
    })
    const ctx = fakeCtx(service)
    const { container, unmount } = await mountNative(ctx, store, service)
    try {
      const before = tabCount(store)
      clickOpenToSide(container)
      // 1) EditorHost routed the gesture to the service with the side target…
      expect(opens).toContainEqual({ type: 'editor', path: '/tmp/a.ts', target: 'side' })
      // 2) …and the service asked the HOST for a second pane, permitting a
      //    duplicate resource so a split really happens.
      expect(placed).toHaveLength(1)
      expect(placed[0]).toMatchObject({ address: expect.stringContaining('/tmp/a.ts'), preferNewPane: true, revealIfOpened: false })
      // 3) The bottom workbench is untouched: the open went to the host.
      expect(tabCount(store)).toBe(before)
    } finally {
      unmount()
    }
  })

  it('keeps the bottom-workbench split for a tab that lives there', async () => {
    const store = createSidebarStore()
    const { service } = spyService(store)
    service.registerTab({ id: 'editor', title: 'Editor', dedupeKey: (tab) => tab.path, component: () => null })
    store.setSession('editor-home-session')
    const ctx = fakeCtx(service)
    const opens: Array<{ target?: string }> = []
    const real = service.openTab.bind(service)
    service.openTab = ((seed, scope) => { opens.push({ ...(seed.target === undefined ? {} : { target: seed.target }) }); real(seed, scope) }) as typeof service.openTab
    store.setPrefs({ ...store.getPrefs(), editorExplorer: false })
    service.openTab({
      type: 'editor', title: 'a.ts', path: '/tmp/a.ts', id: 'editor:/tmp/a.ts', meta: { treeOpen: true },
    })
    const fileTab = (): SidebarTab =>
      allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.path === '/tmp/a.ts')!
    // The tree needs a root: the real seat hands the session cwd in scope.
    const treeCtx = ctx as unknown as { betterSidebar: unknown }
    const { container, unmount } = await mountHostWithTreeWithCwd(treeCtx as unknown as Context, store, fileTab)
    try {
      const before = tabCount(store)
      clickOpenToSide(container)
      // A bottom-workbench tab keeps the plugin's own split: a NEW tab in the
      // same pane family, and no side open was requested.
      expect(opens.every(open => open.target === undefined)).toBe(true)
      expect(tabCount(store)).toBe(before + 1)
    } finally {
      unmount()
    }
  })
})
