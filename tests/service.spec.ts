/**
 * Tests for the BetterSidebar service registry: register/dispose lifecycle,
 * matchFileViewer priority/exts/detect algorithm, and openTab dedupe.
 */
import { describe, it, expect } from 'vitest'

// Mock browser globals (SidebarStore.reduce → schedulePersist uses window.setTimeout)
const g = globalThis as Record<string, unknown>
if (g.window === undefined) {
  g.window = {
    clearTimeout: () => {},
    setTimeout: (_fn: () => void) => 0,
    innerWidth: 1024,
  }
}
if (g.localStorage === undefined) {
  g.localStorage = {
    getItem: () => null,
    setItem: () => {},
  }
}

import { createBetterSidebarService, matchUrlTarget, SIDEBAR_FEATURES, SIDEBAR_SERVICE_VERSION } from '../src/client/service.ts'
import { createSidebarStore, allLeaves, makeDefaultState, openDiffTab, openTabInActivePane, sanitizeState } from '../src/client/state.ts'

describe('BetterSidebar service', () => {
  it('registerTab adds to the registry and dispose removes it', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    expect(service.getTabs()).toHaveLength(0)
    const dispose = service.registerTab({
      id: 'test:tab',
      title: 'Test',
      component: () => null,
    })
    expect(service.getTabs()).toHaveLength(1)
    expect(service.getTab('test:tab')?.id).toBe('test:tab')
    dispose()
    expect(service.getTabs()).toHaveLength(0)
    expect(service.getTab('test:tab')).toBeUndefined()
  })

  it('registerTab throws on duplicate id', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'dup', title: 'A', component: () => null })
    expect(() => service.registerTab({ id: 'dup', title: 'B', component: () => null })).toThrow()
  })

  it('registerFileViewer adds and dispose removes', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    expect(service.getFileViewers()).toHaveLength(0)
    const dispose = service.registerFileViewer({
      id: 'csv',
      exts: ['csv'],
      fetchStrategy: 'custom',
      component: () => null,
    })
    expect(service.getFileViewers()).toHaveLength(1)
    dispose()
    expect(service.getFileViewers()).toHaveLength(0)
  })

  it('subscribe fires on register and dispose', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    let calls = 0
    const unsub = service.subscribe(() => { calls++ })
    const dispose = service.registerTab({ id: 'x', title: 'X', component: () => null })
    expect(calls).toBe(1)
    dispose()
    expect(calls).toBe(2)
    unsub()
    service.registerTab({ id: 'y', title: 'Y', component: () => null })
    expect(calls).toBe(2)
  })
})

describe('enable switches (declarative settings)', () => {
  /** A fresh store + service with one tab and one viewer registered. */
  const setup = () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'explorer', title: 'Explorer', component: () => null })
    service.registerFileViewer({ id: 'image', exts: ['png'], fetchStrategy: 'mediaUrl', component: () => null })
    return { store, service }
  }

  it('an absent map key means enabled (default state)', () => {
    const { service } = setup()
    expect(service.isTabEnabled('explorer')).toBe(true)
    expect(service.isViewerEnabled('image')).toBe(true)
    // Unknown ids are enabled too (nothing registered → the check is open).
    expect(service.isTabEnabled('whatever')).toBe(true)
  })

  it('only an explicit false disables a tab type', () => {
    const { store, service } = setup()
    store.setPrefs({ ...store.getPrefs(), tabsEnabled: { explorer: false } })
    expect(service.isTabEnabled('explorer')).toBe(false)
    store.setPrefs({ ...store.getPrefs(), tabsEnabled: { explorer: true } })
    expect(service.isTabEnabled('explorer')).toBe(true)
  })

  it('openTab refuses a disabled tab type (no tab lands, no createTab)', () => {
    const { store, service } = setup()
    store.setPrefs({ ...store.getPrefs(), tabsEnabled: { explorer: false } })
    store.setSession('s1')
    service.openTab({ type: 'explorer', title: 'Explorer' })
    // The seeded files-window home tab stays; no EXPLORER tab landed.
    const tabs = allLeaves(store.getSnapshot().state!.splits).flatMap(l => l.tabs)
    expect(tabs.filter(t => t.type === 'explorer')).toHaveLength(0)
  })

  it('matchFileViewer skips a disabled viewer (files fall through)', () => {
    const { store, service } = setup()
    service.registerFileViewer({ id: 'code', exts: [], priority: -100, fetchStrategy: 'fsRead', component: () => null })
    // image claims .png; disabling it lets the catch-all take over.
    expect(service.matchFileViewer('photo.png')?.id).toBe('image')
    store.setPrefs({ ...store.getPrefs(), viewersEnabled: { image: false } })
    expect(service.matchFileViewer('photo.png')?.id).toBe('code')
    // Disabling the catch-all too → no viewer at all.
    store.setPrefs({ ...store.getPrefs(), viewersEnabled: { image: false, code: false } })
    expect(service.matchFileViewer('photo.png')).toBeUndefined()
    // Re-enabling restores the image viewer.
    store.setPrefs({ ...store.getPrefs(), viewersEnabled: {} })
    expect(service.matchFileViewer('photo.png')?.id).toBe('image')
  })
})

describe('matchFileViewer', () => {
  it('matches by extension', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerFileViewer({ id: 'img', exts: ['png', 'jpg'], fetchStrategy: 'mediaUrl', component: () => null })
    expect(service.matchFileViewer('photo.png')?.id).toBe('img')
    expect(service.matchFileViewer('photo.JPG')?.id).toBe('img')
    expect(service.matchFileViewer('doc.txt')).toBeUndefined()
  })

  it('higher priority wins on extension conflict', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerFileViewer({ id: 'basic', exts: ['png'], priority: 0, fetchStrategy: 'mediaUrl', component: () => null })
    service.registerFileViewer({ id: 'advanced', exts: ['png'], priority: 10, fetchStrategy: 'custom', component: () => null })
    expect(service.matchFileViewer('x.png')?.id).toBe('advanced')
  })

  it('catch-all (exts: []) matches anything at lowest priority', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerFileViewer({ id: 'catchall', exts: [], priority: -100, fetchStrategy: 'fsRead', component: () => null })
    service.registerFileViewer({ id: 'img', exts: ['png'], priority: 0, fetchStrategy: 'mediaUrl', component: () => null })
    expect(service.matchFileViewer('x.png')?.id).toBe('img')
    expect(service.matchFileViewer('x.txt')?.id).toBe('catchall')
  })

  it('detect claims files the viewer would otherwise miss, at its priority', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    // by-magic does not match 'bin' by extension; only its detect (PNG magic)
    // can claim it — and only when head bytes are available.
    service.registerFileViewer({ id: 'by-ext', exts: ['bin'], priority: 5, fetchStrategy: 'fsRead', component: () => null })
    service.registerFileViewer({
      id: 'by-magic',
      exts: ['mag'],
      priority: 10,
      fetchStrategy: 'fsRead',
      detect: (_path, head) => head[0] === 0x89,
      component: () => null,
    })
    // No head: by-magic's exts miss, by-ext claims .bin.
    expect(service.matchFileViewer('file.bin')?.id).toBe('by-ext')
    // Head with PNG magic: by-magic's detect fires at priority 10 before
    // by-ext (5) is consulted.
    expect(service.matchFileViewer('file.bin', new Uint8Array([0x89, 0x50]))?.id).toBe('by-magic')
    // Head without the magic: detect misses, by-ext claims .bin again.
    expect(service.matchFileViewer('file.bin', new Uint8Array([0x00, 0x50]))?.id).toBe('by-ext')
  })

  it('priority decides first: a higher-priority exts match beats a lower-priority detect', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerFileViewer({ id: 'by-ext', exts: ['bin'], priority: 10, fetchStrategy: 'fsRead', component: () => null })
    service.registerFileViewer({
      id: 'by-magic',
      exts: ['mag'],
      priority: 5,
      fetchStrategy: 'fsRead',
      detect: (_path, head) => head[0] === 0x89,
      component: () => null,
    })
    // Per-descriptor walk: by-ext (priority 10) claims .bin before by-magic's
    // detect (priority 5) is ever consulted — the design's priority-first rule.
    expect(service.matchFileViewer('file.bin', new Uint8Array([0x89, 0x50]))?.id).toBe('by-ext')
  })

  it('a catch-all with detect is sniff-only: it never blind-claims without head', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerFileViewer({ id: 'img', exts: ['png'], priority: 0, fetchStrategy: 'mediaUrl', component: () => null })
    service.registerFileViewer({
      id: 'magic-sniffer',
      exts: [],
      priority: 100,
      fetchStrategy: 'custom',
      detect: (_path, head) => head[0] === 0x89,
      component: () => null,
    })
    // No head: the sniff-only catch-all yields — the real png viewer wins.
    expect(service.matchFileViewer('photo.png')?.id).toBe('img')
    // Head with the magic: the sniffer claims it (detect at priority 100).
    expect(service.matchFileViewer('photo.png', new Uint8Array([0x89, 0x50]))?.id).toBe('magic-sniffer')
    // Head without the magic: the sniffer yields again, img claims it.
    expect(service.matchFileViewer('photo.png', new Uint8Array([0x00, 0x50]))?.id).toBe('img')
  })

  it('returns undefined when no viewer matches and no catch-all', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerFileViewer({ id: 'img', exts: ['png'], fetchStrategy: 'mediaUrl', component: () => null })
    expect(service.matchFileViewer('doc.txt')).toBeUndefined()
  })
})

describe('matchUrlTarget (v0.13.0)', () => {
  /** A tab descriptor that claims a URL host. */
  const claimingTab = (id: string, host: string) => ({
    id,
    title: id,
    urlTarget: (url: URL): boolean => url.hostname === host,
    component: () => null,
  })

  it('returns undefined when no tab declares urlTarget', () => {
    const tabs = [
      { id: 'explorer', title: 'E', component: () => null },
      { id: 'git', title: 'G', component: () => null },
    ]
    expect(matchUrlTarget(tabs, new URL('http://example.com/'))).toBeUndefined()
  })

  it('returns the first REGISTRATION-ORDER claim (first match wins)', () => {
    const tabs = [
      claimingTab('my:one', 'example.com'),
      claimingTab('my:two', 'example.com'),
    ]
    expect(matchUrlTarget(tabs, new URL('https://example.com/x'))?.id).toBe('my:one')
    // A non-matching earlier tab yields to the next match.
    const tabs2 = [
      claimingTab('my:one', 'other.com'),
      claimingTab('my:two', 'example.com'),
    ]
    expect(matchUrlTarget(tabs2, new URL('https://example.com/x'))?.id).toBe('my:two')
  })

  it('skips a throwing predicate (the next claim still wins)', () => {
    const tabs = [
      { id: 'my:broken', title: 'B', urlTarget: () => { throw new Error('boom') }, component: () => null },
      claimingTab('my:ok', 'example.com'),
    ]
    expect(matchUrlTarget(tabs, new URL('https://example.com/x'))?.id).toBe('my:ok')
  })

  it('never matches the built-in browser (no urlTarget declared — the caller falls back)', () => {
    const tabs = [
      { id: 'browser', title: 'Browser', component: () => null },
      { id: 'my:ok', title: 'OK', urlTarget: () => true, component: () => null },
    ]
    expect(matchUrlTarget(tabs, new URL('http://example.com/'))?.id).toBe('my:ok')
    expect(matchUrlTarget([{ id: 'browser', title: 'Browser', component: () => null }], new URL('http://example.com/'))).toBeUndefined()
  })
})

describe('service.openTab dedupe', () => {
  it('dedupeKey focuses existing tab instead of duplicating', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({
      id: 'singleton',
      title: 'Singleton',
      dedupeKey: () => 'singleton',
      component: () => null,
    })
    store.setSession('s1')
    service.openTab({ type: 'singleton', title: 'Singleton' })
    service.openTab({ type: 'singleton', title: 'Singleton' })
    const state = store.getSnapshot().state!
    const tabs = allLeaves(state.splits).flatMap(l => l.tabs)
    expect(tabs.filter(t => t.type === 'singleton')).toHaveLength(1)
  })

  it('no dedupeKey opens a new tab for each distinct id', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({
      id: 'multi',
      title: 'Multi',
      component: () => null,
    })
    store.setSession('s1')
    service.openTab({ type: 'multi', title: 'Multi', id: 'multi:1' })
    service.openTab({ type: 'multi', title: 'Multi', id: 'multi:2' })
    const state = store.getSnapshot().state!
    const tabs = allLeaves(state.splits).flatMap(l => l.tabs)
    expect(tabs.filter(t => t.type === 'multi')).toHaveLength(2)
  })

  it('reopening with the same id focuses the existing tab (id safety net)', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({
      id: 'multi',
      title: 'Multi',
      component: () => null,
    })
    store.setSession('s1')
    service.openTab({ type: 'multi', title: 'Multi', id: 'multi:1' })
    service.openTab({ type: 'multi', title: 'Multi', id: 'multi:1' })
    const state = store.getSnapshot().state!
    const tabs = allLeaves(state.splits).flatMap(l => l.tabs)
    expect(tabs.filter(t => t.type === 'multi')).toHaveLength(1)
  })

  it('createTab mints custom ids and patches state', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({
      id: 'counter',
      title: 'Counter',
      createTab: (state) => ({
        tab: { id: `counter:${state.nextTerminal}`, type: 'counter', title: `C${state.nextTerminal}` },
        patch: { nextTerminal: state.nextTerminal + 1 },
      }),
      component: () => null,
    })
    store.setSession('s1')
    service.openTab({ type: 'counter', title: 'Counter' })
    service.openTab({ type: 'counter', title: 'Counter' })
    const state = store.getSnapshot().state!
    const tabs = allLeaves(state.splits).flatMap(l => l.tabs).filter(t => t.type === 'counter')
    expect(tabs).toHaveLength(2)
    expect(tabs[0]!.id).toBe('counter:1')
    expect(tabs[1]!.id).toBe('counter:2')
    expect(state.nextTerminal).toBe(3)
  })

  it('a caller-provided title wins over the descriptor title (editor shows the file name)', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'editor', title: () => 'Editor', component: () => null })
    store.setSession('s1')
    service.openTab({ type: 'editor', title: 'main.ts', path: '/p/main.ts' })
    const state = store.getSnapshot().state!
    // Find by path: the seeded files-window home tab is an editor tab too.
    const tab = allLeaves(state.splits).flatMap(l => l.tabs).find(t => t.type === 'editor' && t.path === '/p/main.ts')
    expect(tab?.title).toBe('main.ts')
  })

  it('a url seed lands the tab with its path pre-set (the sidebar-browser navigation seed)', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({
      id: 'browser',
      title: () => 'Browser',
      createTab: (state) => ({
        tab: { id: `browser:${state.nextBrowser}`, type: 'browser', title: 'Browser' },
        patch: { nextBrowser: state.nextBrowser + 1 },
      }),
      component: () => null,
    })
    store.setSession('s1')
    service.openTab({ type: 'browser', url: 'https://example.com/x', title: 'example.com' })
    const state = store.getSnapshot().state!
    const tab = allLeaves(state.splits).flatMap(l => l.tabs).find(t => t.type === 'browser')
    expect(tab?.id).toBe('browser:1')
    expect(tab?.path).toBe('https://example.com/x')
    expect(tab?.title).toBe('example.com')
    expect(state.nextBrowser).toBe(2)
  })

  it('the descriptor title is the default when no title is given', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'plain', title: () => 'Plain', component: () => null })
    store.setSession('s1')
    service.openTab({ type: 'plain' })
    const state = store.getSnapshot().state!
    const tab = allLeaves(state.splits).flatMap(l => l.tabs).find(t => t.type === 'plain')
    expect(tab?.title).toBe('Plain')
  })

  it('single: true dedupes like dedupeKey: () => id (sugar)', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'singleton', title: 'Singleton', single: true, component: () => null })
    store.setSession('s1')
    service.openTab({ type: 'singleton' })
    service.openTab({ type: 'singleton', id: 'singleton:extra' })
    const state = store.getSnapshot().state!
    const tabs = allLeaves(state.splits).flatMap(l => l.tabs).filter(t => t.type === 'singleton')
    expect(tabs).toHaveLength(1)
  })

  it('an explicit dedupeKey wins over single: true', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({
      id: 'multi',
      title: 'Multi',
      single: true,
      dedupeKey: (tab) => tab.id, // per-id, not per-type: two tabs coexist
      component: () => null,
    })
    store.setSession('s1')
    service.openTab({ type: 'multi', id: 'multi:1' })
    service.openTab({ type: 'multi', id: 'multi:2' })
    const state = store.getSnapshot().state!
    const tabs = allLeaves(state.splits).flatMap(l => l.tabs).filter(t => t.type === 'multi')
    expect(tabs).toHaveLength(2)
    service.openTab({ type: 'multi', id: 'multi:1' })
    const state2 = store.getSnapshot().state!
    const tabs2 = allLeaves(state2.splits).flatMap(l => l.tabs).filter(t => t.type === 'multi')
    expect(tabs2).toHaveLength(2)
  })

  it('available receives ctx, scope and the live state (superset signature)', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    const seen: unknown[] = []
    service.registerTab({
      id: 'gated',
      title: 'Gated',
      available: (ctx, scope, state) => {
        seen.push([ctx, scope, state])
        return true
      },
      component: () => null,
    })
    store.setSession('s1')
    expect(service.getTabs()[0]!.available?.({} as never, { sessionId: 's1', cwd: '/p' }, store.getSnapshot().state!)).toBe(true)
    expect(seen).toHaveLength(1)
  })

  it('openDiffTab and the service dedupeKey agree on diff identity (per-change id rule)', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({
      id: 'diff',
      title: 'Diff',
      dedupeKey: (tab) => tab.id,
      component: () => null,
    })
    store.setSession('s1')
    const seed = { kind: 'worktree' as const, path: '/p/a.ts', staged: false }
    const paneId = store.getSnapshot().state!.activePane!
    // The git view's placement path (split surgery) opens the diff tab...
    store.reduce(s => openDiffTab(s, paneId, { id: 'diff:1', type: 'diff', title: 'a.ts', diff: seed }))
    // ...and a service open of the same change focuses the existing tab
    // (the descriptor's dedupeKey is the same per-change id rule).
    service.openTab({ type: 'diff', title: 'a.ts', diff: seed, id: 'diff:1' })
    const state = store.getSnapshot().state!
    const tabs = allLeaves(state.splits).flatMap(l => l.tabs).filter(t => t.type === 'diff')
    expect(tabs).toHaveLength(1)
  })
})

describe('service.openTab across the two panels', () => {
  it('openTab lands in the bottom tree when the active pane lives there', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'git', title: 'Git', component: () => null })
    store.setSession('s1')
    store.reduce(s => ({ ...s, activePane: (s.bottomSplits as { id: string }).id }))
    service.openTab({ type: 'git', title: 'Git' })
    const state = store.getSnapshot().state!
    expect(allLeaves(state.bottomSplits).flatMap(l => l.tabs).some(t => t.type === 'git')).toBe(true)
    expect(allLeaves(state.splits).flatMap(l => l.tabs).some(t => t.type === 'git')).toBe(false)
  })

  it('dedupeKey focuses an existing instance in the OTHER tree (single-instance across panels)', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({
      id: 'singleton',
      title: 'Singleton',
      single: true,
      component: () => null,
    })
    store.setSession('s1')
    // Open in the right tree first.
    service.openTab({ type: 'singleton', title: 'Singleton' })
    // Switch the active pane to the bottom tree and open again: the dedupe
    // scan covers both trees, so the existing instance is focused, not
    // duplicated in the bottom panel.
    store.reduce(s => ({ ...s, activePane: (s.bottomSplits as { id: string }).id }))
    service.openTab({ type: 'singleton', title: 'Singleton' })
    const state = store.getSnapshot().state!
    const total = allLeaves(state.splits).concat(allLeaves(state.bottomSplits))
      .flatMap(l => l.tabs).filter(t => t.type === 'singleton')
    expect(total).toHaveLength(1)
  })

  it('closeTab by id closes a tab living in the bottom tree', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'git', title: 'Git', component: () => null })
    store.setSession('s1')
    store.reduce(s => ({ ...s, activePane: (s.bottomSplits as { id: string }).id }))
    service.openTab({ type: 'git', title: 'Git' })
    const state = store.getSnapshot().state!
    const gitTab = allLeaves(state.bottomSplits).flatMap(l => l.tabs).find(t => t.type === 'git')!
    service.closeTab(gitTab.id)
    const after = store.getSnapshot().state!
    expect(allLeaves(after.bottomSplits).flatMap(l => l.tabs).some(t => t.id === gitTab.id)).toBe(false)
  })
})

describe('service.openTab auto-expand for content opens', () => {
  /** The window stub is a plain object (see the file header), so the width is writable. */
  const setWidth = (width: number): void => {
    ;(g.window as { innerWidth: number }).innerWidth = width
  }
  /** Collapse the right panel (the store defaults it open). */
  const collapseRightPanel = (store: ReturnType<typeof createSidebarStore>): void => {
    store.reduce(s => ({ ...s, panelOpen: false }))
  }

  it('expands the collapsed drawer for a path (file) open on a narrow viewport', () => {
    setWidth(390)
    try {
      const store = createSidebarStore()
      const service = createBetterSidebarService(store)
      service.registerTab({ id: 'editor', title: 'Editor', component: () => null })
      store.setSession('s1')
      store.reduce(s => ({ ...s, panelOpen: false }))
      service.openTab({ type: 'editor', title: 'main.ts', path: '/p/main.ts' })
      expect(store.getSnapshot().state?.panelOpen).toBe(true)
    } finally {
      setWidth(1024)
    }
  })

  it('expands the collapsed drawer for a URL (browser) open on a narrow viewport', () => {
    setWidth(390)
    try {
      const store = createSidebarStore()
      const service = createBetterSidebarService(store)
      service.registerTab({ id: 'browser', title: 'Browser', component: () => null })
      store.setSession('s1')
      store.reduce(s => ({ ...s, panelOpen: false }))
      service.openTab({ type: 'browser', url: 'https://example.com', title: 'example.com' })
      expect(store.getSnapshot().state?.panelOpen).toBe(true)
    } finally {
      setWidth(1024)
    }
  })

  it('keeps a collapsed drawer for a type-only open on a narrow viewport', () => {
    setWidth(390)
    try {
      const store = createSidebarStore()
      const service = createBetterSidebarService(store)
      service.registerTab({ id: 'explorer', title: 'Explorer', component: () => null })
      store.setSession('s1')
      store.reduce(s => ({ ...s, panelOpen: false }))
      service.openTab({ type: 'explorer', title: 'Explorer' })
      expect(store.getSnapshot().state?.panelOpen).toBe(false)
    } finally {
      setWidth(1024)
    }
  })

  it('expands the collapsed right panel for a path (file) open on a wide viewport', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'editor', title: 'Editor', component: () => null })
    store.setSession('s1')
    collapseRightPanel(store)
    service.openTab({ type: 'editor', title: 'main.ts', path: '/p/main.ts' })
    const state = store.getSnapshot().state!
    expect(state.panelOpen).toBe(true)
    expect(allLeaves(state.splits).flatMap(l => l.tabs).some(t => t.type === 'editor')).toBe(true)
  })

  it('expands the collapsed right panel for a URL (browser) open on a wide viewport', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'browser', title: 'Browser', component: () => null })
    store.setSession('s1')
    collapseRightPanel(store)
    service.openTab({ type: 'browser', url: 'https://example.com', title: 'example.com' })
    expect(store.getSnapshot().state!.panelOpen).toBe(true)
  })

  it('a wide-viewport path open landing in the bottom tree expands the bottom panel instead', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'editor', title: 'Editor', component: () => null })
    store.setSession('s1')
    // The last-touched pane lives in the bottom tree and BOTH panels are
    // collapsed: the open must surface the bottom panel, not the right one.
    store.reduce(s => ({ ...s, activePane: (s.bottomSplits as { id: string }).id, panelOpen: false, bottomOpen: false }))
    service.openTab({ type: 'editor', title: 'main.ts', path: '/p/main.ts' })
    const state = store.getSnapshot().state!
    expect(state.bottomOpen).toBe(true)
    expect(state.panelOpen).toBe(false)
    expect(allLeaves(state.bottomSplits).flatMap(l => l.tabs).some(t => t.type === 'editor')).toBe(true)
  })

  it('keeps a collapsed panel for a type-only open on a wide viewport', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'explorer', title: 'Explorer', component: () => null })
    store.setSession('s1')
    collapseRightPanel(store)
    service.openTab({ type: 'explorer', title: 'Explorer' })
    expect(store.getSnapshot().state?.panelOpen).toBe(false)
  })

  it('expands on a narrow viewport even when the open focuses an existing tab (id dedupe)', () => {
    setWidth(390)
    try {
      const store = createSidebarStore()
      const service = createBetterSidebarService(store)
      service.registerTab({ id: 'editor', title: 'Editor', component: () => null })
      store.setSession('s1')
      service.openTab({ type: 'editor', title: 'main.ts', path: '/p/main.ts' })
      store.reduce(s => ({ ...s, panelOpen: false }))
      service.openTab({ type: 'editor', title: 'main.ts', path: '/p/main.ts' })
      expect(store.getSnapshot().state?.panelOpen).toBe(true)
    } finally {
      setWidth(1024)
    }
  })

  it('expands on a wide viewport even when the open focuses an existing tab (id dedupe)', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'editor', title: 'Editor', component: () => null })
    store.setSession('s1')
    service.openTab({ type: 'editor', title: 'main.ts', path: '/p/main.ts' })
    collapseRightPanel(store)
    service.openTab({ type: 'editor', title: 'main.ts', path: '/p/main.ts' })
    const state = store.getSnapshot().state!
    expect(state.panelOpen).toBe(true)
    expect(allLeaves(state.splits).flatMap(l => l.tabs).filter(t => t.type === 'editor' && t.path === '/p/main.ts')).toHaveLength(1)
  })
})

describe('version and feature detection (v0.12.0)', () => {
  it('reports the plugin version in lockstep with package.json', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = JSON.parse(require('node:fs').readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(SIDEBAR_SERVICE_VERSION).toBe(pkg.version)
    expect(createBetterSidebarService(createSidebarStore()).version).toBe(SIDEBAR_SERVICE_VERSION)
  })

  it('advertises every v0.12.0 capability in the features list', () => {
    const service = createBetterSidebarService(createSidebarStore())
    for (const feature of SIDEBAR_FEATURES) {
      expect(service.features).toContain(feature)
    }
  })
})

describe('state subscription (v0.12.0)', () => {
  it('getSnapshot mirrors the store snapshot (sessionId/state/prefs)', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    store.setSession('s1')
    const snapshot = service.getSnapshot()
    expect(snapshot.sessionId).toBe('s1')
    expect(snapshot.state).toBeDefined()
    expect(snapshot.prefs.openByDefault).toBe(false)
  })

  it('subscribeState fires on state changes but NOT on registry changes', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    store.setSession('s1')
    let calls = 0
    const unsub = service.subscribeState(() => { calls++ })
    service.registerTab({ id: 'explorer', title: 'Explorer', component: () => null })
    service.openTab({ type: 'explorer', title: 'Explorer' })
    expect(calls).toBe(1)
    service.registerTab({ id: 'x', title: 'X', component: () => null })
    expect(calls).toBe(1) // registry changes are the registry subscription's job
    unsub()
    service.openTab({ type: 'explorer', title: 'Explorer' })
    expect(calls).toBe(1)
  })
})

describe('updateTab (v0.12.0)', () => {
  it('patches title / path / meta of an open tab', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'doc', title: 'Doc', component: () => null })
    store.setSession('s1')
    service.openTab({ type: 'doc', title: 'Doc', id: 'doc:1' })
    service.updateTab('doc:1', { title: 'Compiling…', meta: { progress: 42 } })
    const tab = allLeaves(store.getSnapshot().state!.splits).flatMap(l => l.tabs).find(t => t.id === 'doc:1')!
    expect(tab.title).toBe('Compiling…')
    expect(tab.meta).toEqual({ progress: 42 })
    // A missing tab id is a no-op (does not throw).
    service.updateTab('doc:missing', { title: 'X' })
  })
})

describe('activateTab (v0.12.0)', () => {
  it('activates a tab in either tree and fires onActivate with the session scope', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    const seen: Array<{ tab: string; sessionId: string }> = []
    service.registerTab({
      id: 'git',
      title: 'Git',
      single: true,
      onActivate: (tab, scope) => { seen.push({ tab: tab.id, sessionId: scope.sessionId }) },
      component: () => null,
    })
    store.setSession('s1')
    // Land in the bottom tree by switching the active pane.
    store.reduce(s => ({ ...s, activePane: (s.bottomSplits as { id: string }).id }))
    service.openTab({ type: 'git', title: 'Git' })
    const gitTab = allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(l => l.tabs).find(t => t.type === 'git')!
    expect(gitTab).toBeDefined()
    service.activateTab(gitTab.id)
    expect(seen).toEqual([{ tab: gitTab.id, sessionId: 's1' }])
    // The active pane followed the tab into the bottom tree.
    expect(store.getSnapshot().state!.activePane).toBe(gitTab.id === '' ? null : allLeaves(store.getSnapshot().state!.bottomSplits).find(l => l.tabs.some(t => t.id === gitTab.id))!.id)
  })
})

describe('targeted openTab (v0.12.0)', () => {
  it('lands the open in the target session without switching the UI session', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'notes', title: 'Notes', component: () => null })
    store.setSession('s1')
    service.openTab({ type: 'notes', title: 'Notes', id: 'notes:1' }, { sessionId: 's2' })
    // The UI snapshot still shows s1, untouched (its default files-window tab
    // is the only one — no notes tab landed there).
    const snapshot = store.getSnapshot()
    expect(snapshot.sessionId).toBe('s1')
    expect(allLeaves(snapshot.state!.splits).flatMap(l => l.tabs).filter(t => t.type === 'notes')).toHaveLength(0)
    // Switching to s2 reveals the tab.
    store.setSession('s2')
    const tabs = allLeaves(store.getSnapshot().state!.splits).flatMap(l => l.tabs)
    expect(tabs.map(t => t.id)).toContain('notes:1')
  })

  it('a scope naming the active session behaves exactly like a plain open (notify included)', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'explorer', title: 'Explorer', component: () => null })
    store.setSession('s1')
    let calls = 0
    store.subscribe(() => { calls++ })
    service.openTab({ type: 'explorer', title: 'Explorer' }, { sessionId: 's1' })
    expect(calls).toBe(1)
    expect(store.getSnapshot().state!.splits).not.toBe(undefined)
  })

  it('dedupe runs against the TARGET session (opens there focus an existing tab of that session)', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'notes', title: 'Notes', single: true, component: () => null })
    store.setSession('s1')
    service.openTab({ type: 'notes', title: 'Notes' }, { sessionId: 's2' })
    service.openTab({ type: 'notes', title: 'Notes' }, { sessionId: 's2' })
    store.setSession('s2')
    const tabs = allLeaves(store.getSnapshot().state!.splits).flatMap(l => l.tabs).filter(t => t.type === 'notes')
    expect(tabs).toHaveLength(1)
  })
})

describe('openFile (v0.12.0)', () => {
  it('opens the file in the editor tab of the scope session with a basename title', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'editor', title: () => 'Editor', component: () => null })
    store.setSession('s1')
    service.openFile({ sessionId: 's1', cwd: '/p' }, '/p/src/main.ts')
    const state = store.getSnapshot().state!
    // Find by path: the seeded files-window home tab is an editor tab too.
    const tab = allLeaves(state.splits).flatMap(l => l.tabs).find(t => t.type === 'editor' && t.path !== undefined)
    expect(tab?.title).toBe('main.ts')
    expect(tab?.path).toBe('/p/src/main.ts')
    // Windows separators are handled too.
    service.openFile({ sessionId: 's1' }, 'C:\\x\\y\\spec.ts', 'custom title')
    const tabs = allLeaves(store.getSnapshot().state!.splits).flatMap(l => l.tabs).filter(t => t.type === 'editor')
    expect(tabs[tabs.length - 1]?.title).toBe('custom title')
    expect(tabs[tabs.length - 1]?.path).toBe('C:\\x\\y\\spec.ts')
  })
})

describe('tab lifecycle callbacks (v0.12.0)', () => {
  /** A descriptor with recording callbacks, plus a count of onOpen/onActivate/onClose. */
  const setup = () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    const events: string[] = []
    service.registerTab({
      id: 'life',
      title: 'Life',
      single: true,
      onOpen: () => { events.push('open') },
      onActivate: () => { events.push('activate') },
      onClose: () => { events.push('close') },
      component: () => null,
    })
    return { store, service, events }
  }

  it('onOpen fires on creation; a dedupe-focus fires onActivate instead', () => {
    const { store, service, events } = setup()
    store.setSession('s1')
    service.openTab({ type: 'life', title: 'Life' })
    expect(events).toEqual(['open'])
    service.openTab({ type: 'life', title: 'Life' })
    expect(events).toEqual(['open', 'activate'])
  })

  it('onClose fires when closeTab closes the tab', () => {
    const { store, service, events } = setup()
    store.setSession('s1')
    service.openTab({ type: 'life', title: 'Life' })
    const tab = allLeaves(store.getSnapshot().state!.splits).flatMap(l => l.tabs).find(t => t.type === 'life')!
    events.length = 0
    service.closeTab(tab.id)
    expect(events).toEqual(['close'])
    // Closing a missing tab fires nothing.
    events.length = 0
    service.closeTab('nope')
    expect(events).toEqual([])
  })

  it('lifecycle callbacks receive the session scope (cwd included when given)', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    let seen: { sessionId: string; cwd?: string } | undefined
    service.registerTab({
      id: 'scoped',
      title: 'Scoped',
      onOpen: (_tab, scope) => { seen = scope },
      component: () => null,
    })
    store.setSession('s1')
    service.openTab({ type: 'scoped', title: 'Scoped' }, { sessionId: 's1', cwd: '/work' })
    expect(seen).toEqual({ sessionId: 's1', cwd: '/work' })
  })

  it('a throwing callback is swallowed and never breaks the open', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({
      id: 'boom',
      title: 'Boom',
      onOpen: () => { throw new Error('plugin bug') },
      onClose: () => { throw new Error('plugin bug') },
      component: () => null,
    })
    store.setSession('s1')
    expect(() => service.openTab({ type: 'boom', title: 'Boom' })).not.toThrow()
    const tab = allLeaves(store.getSnapshot().state!.splits).flatMap(l => l.tabs).find(t => t.type === 'boom')!
    expect(() => service.closeTab(tab.id)).not.toThrow()
  })

  it('a disabled tab type still refuses to open and fires no callbacks', () => {
    const { store, service, events } = setup()
    store.setSession('s1')
    store.setPrefs({ ...store.getPrefs(), tabsEnabled: { life: false } })
    service.openTab({ type: 'life', title: 'Life' })
    expect(events).toEqual([])
    expect(allLeaves(store.getSnapshot().state!.splits).flatMap(l => l.tabs).filter(t => t.type === 'life')).toHaveLength(0)
  })
})

describe('tab meta (v0.12.0)', () => {
  it('a seed meta rides onto the minted tab and survives a reload round-trip', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'db', title: 'DB', component: () => null })
    store.setSession('s1')
    service.openTab({ type: 'db', title: 'DB', id: 'db:1', meta: { table: 'users', page: 3 } })
    const tab = allLeaves(store.getSnapshot().state!.splits).flatMap(l => l.tabs).find(t => t.id === 'db:1')!
    expect(tab.meta).toEqual({ table: 'users', page: 3 })
    // Reload round-trip: the persisted shape sanitizes back with meta intact.
    const sanitized = sanitizeState(JSON.parse(JSON.stringify(store.getSnapshot().state!)))
    const restored = allLeaves(sanitized!.splits).flatMap(l => l.tabs).find(t => t.id === 'db:1')!
    expect(restored.meta).toEqual({ table: 'users', page: 3 })
  })

  it('older persisted tabs (no meta) sanitize unchanged', () => {
    const state = makeDefaultState(400, true, 'none')
    const withTab = openTabInActivePane(state, { id: 'tab:old', type: 'git', title: 'Git' })
    const sanitized = sanitizeState(JSON.parse(JSON.stringify(withTab)))
    const tabs = allLeaves(sanitized!.splits).flatMap(l => l.tabs)
    expect(tabs[0]?.meta).toBeUndefined()
  })
})

describe('lifecycle classification vs dedupe (codex review fixes)', () => {
  it('a key-dedupe focus with a NEW id fires onActivate with the REAL tab (no phantom onOpen)', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    const events: Array<{ kind: string; tabId?: string }> = []
    service.registerTab({
      id: 'doc',
      title: 'Doc',
      // Dedupe by PATH like the editor builtin — the focused tab's id
      // differs from the newly requested id.
      dedupeKey: (tab) => tab.path ?? '',
      onOpen: (tab) => { events.push({ kind: 'open', tabId: tab.id }) },
      onActivate: (tab) => { events.push({ kind: 'activate', tabId: tab.id }) },
      component: () => null,
    })
    store.setSession('s1')
    service.openTab({ type: 'doc', title: 'Doc', id: 'doc:1', path: '/a.md' })
    expect(events).toEqual([{ kind: 'open', tabId: 'doc:1' }])
    // Same path, NEW id: the existing tab is focused — onActivate must
    // carry the EXISTING tab, and onOpen must NOT fire with doc:2.
    service.openTab({ type: 'doc', title: 'Doc', id: 'doc:2', path: '/a.md' })
    expect(events).toEqual([
      { kind: 'open', tabId: 'doc:1' },
      { kind: 'activate', tabId: 'doc:1' },
    ])
    const tabs = allLeaves(store.getSnapshot().state!.splits).flatMap(l => l.tabs).filter(t => t.type === 'doc')
    expect(tabs.map(t => t.id)).toEqual(['doc:1'])
  })

  it('an id safety-net focus (same id) fires onActivate, not onOpen', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    const events: string[] = []
    service.registerTab({
      id: 'multi',
      title: 'Multi',
      onOpen: () => { events.push('open') },
      onActivate: () => { events.push('activate') },
      component: () => null,
    })
    store.setSession('s1')
    service.openTab({ type: 'multi', title: 'Multi', id: 'm:1' })
    expect(events).toEqual(['open'])
    service.openTab({ type: 'multi', title: 'Multi', id: 'm:1' })
    expect(events).toEqual(['open', 'activate'])
  })
})

describe('independent CR follow-up fixes', () => {
  it('onOpen for a url-created tab receives the LANDED tab (path = url)', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    let seenPath: string | undefined
    service.registerTab({
      id: 'web',
      title: 'Web',
      onOpen: (tab) => { seenPath = tab.path },
      component: () => null,
    })
    store.setSession('s1')
    service.openTab({ type: 'web', title: 'example.com', url: 'https://example.com/x' })
    expect(seenPath).toBe('https://example.com/x')
  })

  it('a url seed NEVER overwrites the path of a dedupe-focused tab', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({
      id: 'web',
      title: 'Web',
      dedupeKey: () => 'web',
      component: () => null,
    })
    store.setSession('s1')
    service.openTab({ type: 'web', title: 'first', url: 'https://a.example' })
    service.openTab({ type: 'web', title: 'second', url: 'https://b.example' })
    const tabs = allLeaves(store.getSnapshot().state!.splits).flatMap(l => l.tabs).filter(t => t.type === 'web')
    expect(tabs).toHaveLength(1)
    // The focused tab keeps its ORIGINAL url — the second open must not
    // repoint it.
    expect(tabs[0]!.path).toBe('https://a.example')
  })

  it('closing / activating an unknown tab id is a strict no-op (no notify)', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'x', title: 'X', component: () => null })
    store.setSession('s1')
    let calls = 0
    store.subscribe(() => { calls++ })
    service.closeTab('does-not-exist')
    service.activateTab('does-not-exist')
    expect(calls).toBe(0)
  })

  it('a targeted open into an INACTIVE session never auto-expands its panels', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'editor', title: 'Editor', component: () => null })
    store.setSession('s1')
    // The target session starts collapsed.
    store.reduceFor('s2', s => ({ ...s, panelOpen: false, bottomOpen: false }))
    service.openTab({ type: 'editor', title: 'main.ts', path: '/p/main.ts' }, { sessionId: 's2' })
    // Nothing is in sight for the user — the open must not expand s2.
    store.setSession('s2')
    expect(store.getSnapshot().state?.panelOpen).toBe(false)
    expect(store.getSnapshot().state?.bottomOpen).toBe(false)
    expect(allLeaves(store.getSnapshot().state!.splits).flatMap(l => l.tabs).some(t => t.type === 'editor')).toBe(true)
  })

  it('closeTab/activateTab accept an optional scope that rides to the callback', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    const seen: Array<{ kind: string; cwd?: string }> = []
    service.registerTab({
      id: 'life',
      title: 'Life',
      single: true,
      onActivate: (_tab, scope) => { seen.push({ kind: 'activate', cwd: scope.cwd }) },
      onClose: (_tab, scope) => { seen.push({ kind: 'close', cwd: scope.cwd }) },
      component: () => null,
    })
    store.setSession('s1')
    service.openTab({ type: 'life', title: 'Life' })
    const tab = allLeaves(store.getSnapshot().state!.splits).flatMap(l => l.tabs).find(t => t.type === 'life')!
    service.activateTab(tab.id, { sessionId: 's1', cwd: '/work' })
    service.closeTab(tab.id, { sessionId: 's1', cwd: '/work' })
    expect(seen).toEqual([
      { kind: 'activate', cwd: '/work' },
      { kind: 'close', cwd: '/work' },
    ])
  })

  it('SIDEBAR_FEATURES snapshot and service version checks', () => {
    expect(SIDEBAR_FEATURES).toContain('urlTarget')
    expect(SIDEBAR_FEATURES).toContain('pluginSettings')
    expect(SIDEBAR_FEATURES).toContain('tabLifecycle')
    expect(SIDEBAR_FEATURES).toContain('badge')
    expect(SIDEBAR_FEATURES).toContain('updateTab')
    expect(SIDEBAR_FEATURES).toContain('openFile')
    expect(SIDEBAR_FEATURES).toContain('targetedOpen')
    expect(SIDEBAR_FEATURES).toContain('stateSubscription')
    expect(SIDEBAR_FEATURES).toContain('tabMeta')
    expect(SIDEBAR_SERVICE_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('registerFileViewer throws on duplicate id', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerFileViewer({ id: 'csv', exts: ['csv'], fetchStrategy: 'custom', component: () => null })
    expect(() => service.registerFileViewer({ id: 'csv', exts: ['csv'], fetchStrategy: 'custom', component: () => null })).toThrow(/already registered/)
  })
})
