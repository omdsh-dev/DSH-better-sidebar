import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createSidebarStore,
  allLeaves,
  floatTab,
  firstLeaf,
  openTabInActivePane,
  togglePanel,
} from '../src/client/state.ts'
import { CHAT_PREVIEW_TAB_ID, applyChatPreview, locatePreviewTab } from '../src/client/chat-preview.ts'

// Browser globals for store persist (mirrors service.spec.ts setup)
const g = globalThis as Record<string, unknown>
beforeEach(() => {
  if (g.window === undefined) {
    g.window = { clearTimeout: () => {}, setTimeout: (_fn: () => void) => 0, innerWidth: 1024, innerHeight: 800 }
  }
  if (g.localStorage === undefined) {
    g.localStorage = { getItem: () => null, setItem: () => {} }
  }
})

describe('chat preview tab (single preview, VSCode semantics)', () => {
  const editorPreview = (path: string): import('../src/client/state.ts').SidebarTab => {
    const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    const title = at === -1 ? path : path.slice(at + 1)
    return { id: CHAT_PREVIEW_TAB_ID, type: 'editor', title, path }
  }
  const diffPreview = (relative: string, repoRoot = '/repo'): import('../src/client/state.ts').SidebarTab => ({
    id: CHAT_PREVIEW_TAB_ID,
    type: 'diff',
    title: relative.split('/').pop() ?? relative,
    diff: { kind: 'worktree', path: relative, staged: false, untracked: false, repoRoot },
  })

  const countTabs = (store: ReturnType<typeof createSidebarStore>) => {
    const state = store.getSnapshot().state!
    return allLeaves(state.splits).concat(allLeaves(state.bottomSplits)).flatMap(l => l.tabs).length + state.floats.length
  }
  const findPreview = (store: ReturnType<typeof createSidebarStore>) => {
    const state = store.getSnapshot().state!
    return locatePreviewTab(state)
  }

  it('first chat open creates a single editor preview tab pinned to the right panel and expands the panel', () => {
    const store = createSidebarStore()
    store.setSession('s1')
    // Start collapsed (store defaults openByDefault false → panelOpen false in node env).
    store.reduce(s => (s.panelOpen ? togglePanel(s) : s))
    expect(store.getSnapshot().state?.panelOpen).toBe(false)
    applyChatPreview(store, editorPreview('/repo/a.ts'))
    const state = store.getSnapshot().state!
    expect(state.panelOpen).toBe(true)
    expect(state.activePane).toBe(firstLeaf(state.splits).id)
    const preview = findPreview(store)
    expect(preview).not.toBeNull()
    expect(preview!.tab.type).toBe('editor')
    expect(preview!.tab.path).toBe('/repo/a.ts')
    // Only the seeded Files home + the preview (2 tabs in right leaf).
    expect(countTabs(store)).toBe(2)
  })

  it('second chat open with different file replaces path/title, does not add a tab (editor→editor)', () => {
    const store = createSidebarStore()
    store.setSession('s1')
    applyChatPreview(store, editorPreview('/repo/a.ts'))
    const before = countTabs(store)
    applyChatPreview(store, editorPreview('/repo/b.ts'))
    expect(countTabs(store)).toBe(before)
    const preview = findPreview(store)!
    expect(preview.tab.type).toBe('editor')
    expect(preview.tab.path).toBe('/repo/b.ts')
    expect(preview.tab.title).toBe('b.ts')
    expect(preview.tab.id).toBe(CHAT_PREVIEW_TAB_ID)
  })

  it('editor→diff closes and recreates with same id but type diff', () => {
    const store = createSidebarStore()
    store.setSession('s1')
    applyChatPreview(store, editorPreview('/repo/a.ts'))
    applyChatPreview(store, diffPreview('src/b.ts'))
    const preview = findPreview(store)!
    expect(preview.tab.id).toBe(CHAT_PREVIEW_TAB_ID)
    expect(preview.tab.type).toBe('diff')
    expect(preview.tab.diff).toMatchObject({ path: 'src/b.ts' })
    // Still single preview, not two.
    expect(countTabs(store)).toBe(2)
    // Ensure old editor preview gone: no editor preview path remains.
    const state = store.getSnapshot().state!
    const allTabs = allLeaves(state.splits).concat(allLeaves(state.bottomSplits)).flatMap(l => l.tabs).concat(state.floats.map(f => f.tab))
    expect(allTabs.filter(t => t.id === CHAT_PREVIEW_TAB_ID && t.type === 'editor')).toHaveLength(0)
  })

  it('diff→diff recreates (diff cannot be patched)', () => {
    const store = createSidebarStore()
    store.setSession('s1')
    applyChatPreview(store, diffPreview('src/a.ts'))
    const firstDiff = findPreview(store)!.tab.diff as { path?: string } | undefined
    applyChatPreview(store, diffPreview('src/b.ts'))
    const second = findPreview(store)!
    expect(second.tab.type).toBe('diff')
    expect(second.tab.diff).toMatchObject({ path: 'src/b.ts' })
    expect(firstDiff?.path).toBe('src/a.ts')
    expect(countTabs(store)).toBe(2)
  })

  it('diff→editor swap recreates as editor', () => {
    const store = createSidebarStore()
    store.setSession('s1')
    applyChatPreview(store, diffPreview('src/a.ts'))
    applyChatPreview(store, editorPreview('/repo/c.ts'))
    const preview = findPreview(store)!
    expect(preview.tab.type).toBe('editor')
    expect(preview.tab.path).toBe('/repo/c.ts')
  })

  it('floating preview editor→editor stays floating (patched) and is raised', () => {
    const store = createSidebarStore()
    store.setSession('s1')
    applyChatPreview(store, editorPreview('/repo/a.ts'))
    // Float the preview.
    const state = store.getSnapshot().state!
    const previewId = CHAT_PREVIEW_TAB_ID
    store.reduce(s => floatTab(s, previewId, 100, 100))
    expect(store.getSnapshot().state!.floats.some(f => f.tab.id === previewId)).toBe(true)
    // Add a second float above it to test raising.
    store.reduce(s => openTabInActivePane(s, { id: 'dummy:1', type: 'terminal', title: 'Dummy' }))
    store.reduce(s => floatTab(s, 'dummy:1', 200, 200))
    const before = store.getSnapshot().state!
    expect(before.floats).toHaveLength(2)
    expect(before.floats[0]!.tab.id).toBe(previewId)
    // Editor→editor should patch and raise preview to top.
    applyChatPreview(store, editorPreview('/repo/b.ts'))
    const after = store.getSnapshot().state!
    expect(after.floats).toHaveLength(2)
    expect(after.floats.at(-1)!.tab.id).toBe(previewId)
    expect(after.floats.at(-1)!.tab.path).toBe('/repo/b.ts')
    // Panel must NOT have been expanded for floating case (stay collapsed if was collapsed).
    // Start collapsed, floating keeps it collapsed.
    const collapsedStore = createSidebarStore()
    collapsedStore.setSession('s1')
    collapsedStore.reduce(s => (s.panelOpen ? togglePanel(s) : s))
    expect(collapsedStore.getSnapshot().state?.panelOpen).toBe(false)
    applyChatPreview(collapsedStore, editorPreview('/repo/a.ts'))
    collapsedStore.reduce(s => floatTab(s, CHAT_PREVIEW_TAB_ID, 100, 100))
    collapsedStore.reduce(s => (s.panelOpen ? s : s)) // ensure still collapsed before second preview
    collapsedStore.reduce(s => ({ ...s, panelOpen: false }))
    applyChatPreview(collapsedStore, editorPreview('/repo/b.ts'))
    expect(collapsedStore.getSnapshot().state!.panelOpen).toBe(false)
  })

  it('floating preview diff→diff and editor→diff close the float and recreate in panel (expanded)', () => {
    const store = createSidebarStore()
    store.setSession('s1')
    // Start with editor preview floated
    applyChatPreview(store, editorPreview('/repo/a.ts'))
    store.reduce(s => floatTab(s, CHAT_PREVIEW_TAB_ID, 100, 100))
    expect(store.getSnapshot().state!.floats).toHaveLength(1)
    // Collapse panel to test recreation expands it
    store.reduce(s => ({ ...s, panelOpen: false }))
    // editor→diff should close float and land in panel
    applyChatPreview(store, diffPreview('src/x.ts'))
    const after = store.getSnapshot().state!
    expect(after.floats).toHaveLength(0)
    expect(after.panelOpen).toBe(true)
    expect(findPreview(store)!.where).toBe('pane')
    expect(findPreview(store)!.tab.type).toBe('diff')

    // Diff floated → editor should also close and land in panel
    store.reduce(s => floatTab(s, CHAT_PREVIEW_TAB_ID, 100, 100))
    store.reduce(s => ({ ...s, panelOpen: false }))
    applyChatPreview(store, editorPreview('/repo/z.ts'))
    const after2 = store.getSnapshot().state!
    expect(after2.floats).toHaveLength(0)
    expect(after2.panelOpen).toBe(true)
    expect(findPreview(store)!.tab.type).toBe('editor')
  })

  it('tabs total stays bounded: repeated preview opens never exceed seeded + 1', () => {
    const store = createSidebarStore()
    store.setSession('s1')
    const paths = ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts', '/repo/d.ts', '/repo/e.ts']
    for (const path of paths) applyChatPreview(store, editorPreview(path))
    expect(countTabs(store)).toBe(2) // seeded Files + single preview
    // Intermix diffs
    applyChatPreview(store, diffPreview('src/a.ts'))
    applyChatPreview(store, diffPreview('src/b.ts'))
    applyChatPreview(store, editorPreview('/repo/f.ts'))
    expect(countTabs(store)).toBe(2)
  })

  it('resident editor tabs (per-path) coexist with preview and are never reused by preview', () => {
    const store = createSidebarStore()
    store.setSession('s1')
    // Create a resident editor tab via direct openTabInActivePane (simulates Files/openSidebarEditorFile)
    store.reduce(s => openTabInActivePane(s, { id: 'editor:/repo/resident.ts', type: 'editor', title: 'resident.ts', path: '/repo/resident.ts' }))
    const beforeResidentCount = countTabs(store)
    expect(beforeResidentCount).toBe(2) // seeded + resident
    // Preview opens a different file that would dedupe to resident if using service dedupe
    applyChatPreview(store, editorPreview('/repo/resident.ts'))
    // Preview must be separate tab with fixed id, not reuse resident
    const state = store.getSnapshot().state!
    const tabs = allLeaves(state.splits).concat(allLeaves(state.bottomSplits)).flatMap(l => l.tabs)
    expect(tabs.some(t => t.id === 'editor:/repo/resident.ts' && t.path === '/repo/resident.ts')).toBe(true)
    expect(tabs.some(t => t.id === CHAT_PREVIEW_TAB_ID && t.path === '/repo/resident.ts')).toBe(true)
    expect(tabs.filter(t => t.path === '/repo/resident.ts')).toHaveLength(2)
    // Total now 3 (seeded + resident + preview)
    expect(countTabs(store)).toBe(3)
    // Second preview with another file replaces preview, resident untouched
    applyChatPreview(store, editorPreview('/repo/other.ts'))
    const after = store.getSnapshot().state!
    const tabsAfter = allLeaves(after.splits).concat(allLeaves(after.bottomSplits)).flatMap(l => l.tabs)
    expect(tabsAfter.some(t => t.id === 'editor:/repo/resident.ts')).toBe(true)
    expect(tabsAfter.some(t => t.id === CHAT_PREVIEW_TAB_ID && t.path === '/repo/other.ts')).toBe(true)
    expect(countTabs(store)).toBe(3)
  })

  it('preview remains correct when activePane was in bottom panel (pins to right)', () => {
    const store = createSidebarStore()
    store.setSession('s1')
    // Move activePane to bottom panel
    const bottomId = (store.getSnapshot().state!.bottomSplits as { id: string }).id
    store.reduce(s => ({ ...s, activePane: bottomId }))
    store.reduce(s => ({ ...s, panelOpen: false }))
    applyChatPreview(store, editorPreview('/repo/a.ts'))
    const state = store.getSnapshot().state!
    expect(state.panelOpen).toBe(true)
    expect(state.activePane).toBe(firstLeaf(state.splits).id)
    expect(allLeaves(state.splits).flatMap(l => l.tabs).some(t => t.id === CHAT_PREVIEW_TAB_ID)).toBe(true)
    expect(allLeaves(state.bottomSplits).flatMap(l => l.tabs).some(t => t.id === CHAT_PREVIEW_TAB_ID)).toBe(false)
  })
})
