/**
 * Open-PAGE reconciliation after a file-tree rename/delete (#915).
 *
 * The pages that display a file live in TWO carriers: the bottom workbench's
 * split trees (plugin store, per session) and the native right Sidebar's tab
 * records (native adapter). `tree-mutations.ts` used to walk the bottom
 * workbench ONLY — and with the native surface installed the editor lands on
 * the right Sidebar by default, so the common case was missed entirely: after
 * a rename the page kept pointing at the old path (its next save recreated the
 * renamed-away file), and after a delete it stayed open on a path that no
 * longer existed.
 *
 * These assertions go through the REAL service + REAL native surface over a
 * recording controller, so the routing is the production one: `pathTabs()`
 * hands back the session each id belongs to, `updateTab`/`closeTab` act in THAT
 * session (native ids restart per session — an id alone is ambiguous).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import { createNativeSurface } from '../src/client/native/surface.ts'
import { createNativeTabRecords } from '../src/client/native/tab-adapter.tsx'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore, allLeaves } from '../src/client/state.ts'
import { clearEditorDirty, setEditorDirty } from '../src/client/editor-dirty.ts'
import { closePathTabs, retargetPathTabs } from '../src/client/tree-mutations.ts'

const ACTIVE = 's1'
const OTHER = 's2'

interface Harness {
  ctx: Context
  store: ReturnType<typeof createSidebarStore>
  service: ReturnType<typeof createBetterSidebarService>
  records: ReturnType<typeof createNativeTabRecords>
  controller: {
    close: ReturnType<typeof vi.fn>
    closeIn?: ReturnType<typeof vi.fn>
  }
  /** One native editor page, as the host would have opened it. */
  nativeEditor: (sessionId: string, id: string, path: string, title?: string) => void
}

/** A real service + real native surface over a recording controller. */
function harness(withSurface = true): Harness {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  service.registerTab({ id: 'editor', title: 'Editor', dedupeKey: (tab) => tab.path, component: () => null })
  store.setSession(ACTIVE)
  const records = createNativeTabRecords()
  const controller = {
    openTab: vi.fn(),
    openTabIn: vi.fn(),
    openResource: vi.fn(),
    openResourceIn: vi.fn(),
    close: vi.fn(),
    closeIn: vi.fn(),
    focus: vi.fn(),
    mounted: { getSnapshot: () => ACTIVE, subscribe: () => () => {} },
  }
  const ctx = {
    betterSidebar: service,
    get: (name: string) => name === 'betterSidebar' ? service : name === 'sidebarRight' ? controller : undefined,
    sessions: { list: { getSnapshot: () => ({ byId: { [ACTIVE]: { cwd: '/ws' }, [OTHER]: { cwd: '/ws' } } }), subscribe: () => () => {} } },
  } as unknown as Context
  if (withSurface) service.setSurface(createNativeSurface(ctx, records))
  return {
    ctx,
    store,
    service,
    records,
    controller,
    nativeEditor: (sessionId, id, path, title) => {
      records.ensure({
        sessionId,
        id,
        kind: 'editor',
        title: title ?? path.slice(path.lastIndexOf('/') + 1),
        params: { path },
        scope: { sessionId, cwd: '/ws' },
      })
    },
  }
}

/** A bottom-workbench editor page (no native surface involved). */
function bottomEditor(service: ReturnType<typeof createBetterSidebarService>, store: ReturnType<typeof createSidebarStore>, path: string): void {
  service.openTab({ type: 'editor', title: path.slice(path.lastIndexOf('/') + 1), path, id: `editor:${path}` })
}

const pathsOf = (store: ReturnType<typeof createSidebarStore>): string[] =>
  allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs).map(tab => tab.path!)

afterEach(() => {
  for (const id of ['tab1', 'tab2', 'tab3']) clearEditorDirty(id)
  vi.unstubAllGlobals()
})

describe('rename retargets BOTH carriers (#915)', () => {
  it('a native right-Sidebar editor page follows the file rename', () => {
    const h = harness()
    h.nativeEditor(ACTIVE, 'tab1', '/ws/a.md')

    retargetPathTabs(h.ctx, '/ws/a.md', '/ws/b.md')

    expect(h.records.get(ACTIVE, 'tab1')!.tab.path).toBe('/ws/b.md')
    // The title followed too: an editor page is titled with the basename.
    expect(h.records.get(ACTIVE, 'tab1')!.tab.title).toBe('b.md')
  })

  it('a DIRECTORY rename moves every page under it and keeps their titles', () => {
    const h = harness()
    h.nativeEditor(ACTIVE, 'tab1', '/ws/dir/a.md')
    h.nativeEditor(ACTIVE, 'tab2', '/ws/dir/sub/b.ts')
    h.nativeEditor(ACTIVE, 'tab3', '/ws/elsewhere/c.md')

    retargetPathTabs(h.ctx, '/ws/dir', '/ws/moved')

    expect(h.records.get(ACTIVE, 'tab1')!.tab.path).toBe('/ws/moved/a.md')
    expect(h.records.get(ACTIVE, 'tab2')!.tab.path).toBe('/ws/moved/sub/b.ts')
    // The basename did not change, so the title must stay as it is.
    expect(h.records.get(ACTIVE, 'tab1')!.tab.title).toBe('a.md')
    // Unrelated pages are untouched.
    expect(h.records.get(ACTIVE, 'tab3')!.tab.path).toBe('/ws/elsewhere/c.md')
  })

  it('does not rewrite an AUTHORED title (only a derived basename follows)', () => {
    const h = harness()
    h.nativeEditor(ACTIVE, 'tab1', '/ws/a.md', 'My Notes')

    retargetPathTabs(h.ctx, '/ws/a.md', '/ws/b.md')

    expect(h.records.get(ACTIVE, 'tab1')!.tab.path).toBe('/ws/b.md')
    expect(h.records.get(ACTIVE, 'tab1')!.tab.title).toBe('My Notes')
  })

  it('still retargets the bottom workbench (the pre-existing half)', () => {
    const h = harness(false)
    bottomEditor(h.service, h.store, '/ws/a.md')

    retargetPathTabs(h.ctx, '/ws/a.md', '/ws/b.md')

    expect(pathsOf(h.store)).toEqual(['/ws/b.md'])
  })

  it('retargets a BACKGROUND session’s bottom-workbench page (targeted store write)', () => {
    // The bottom workbench half needs the same session routing: the store's
    // plain `reduce` only ever touches the ACTIVE session, so a page opened in
    // another session would be looked up there and silently missed.
    const h = harness(false)
    h.service.openTab(
      { type: 'editor', title: 'a.md', path: '/ws/a.md', id: 'editor:/ws/a.md' },
      { sessionId: OTHER },
    )

    retargetPathTabs(h.ctx, '/ws/a.md', '/ws/b.md')

    const other = h.store.getSessionStates().get(OTHER)!
    expect(allLeaves(other.bottomSplits).flatMap(leaf => leaf.tabs).map(tab => tab.path)).toEqual(['/ws/b.md'])
  })

  it('retargets a BACKGROUND session’s native page in that session', () => {
    // Native ids restart per session: acting on the id without the session
    // would look it up in the active one and silently do nothing.
    const h = harness()
    h.nativeEditor(OTHER, 'tab1', '/ws/a.md')

    retargetPathTabs(h.ctx, '/ws/a.md', '/ws/b.md')

    expect(h.records.get(OTHER, 'tab1')!.tab.path).toBe('/ws/b.md')
  })
})

describe('delete closes the pages of BOTH carriers (#915)', () => {
  it('closes a native page showing the removed file, and leaves others alone', () => {
    const h = harness()
    h.nativeEditor(ACTIVE, 'tab1', '/ws/a.md')
    h.nativeEditor(ACTIVE, 'tab2', '/ws/keep.md')

    closePathTabs(h.ctx, '/ws/a.md', 'discard?')

    expect(h.records.has(ACTIVE, 'tab1')).toBe(false)
    expect(h.records.has(ACTIVE, 'tab2')).toBe(true)
    // The host controller really was told to close it (the page is on screen).
    expect(h.controller.close).toHaveBeenCalledWith('tab1')
  })

  it('takes the whole subtree of a removed directory', () => {
    const h = harness()
    h.nativeEditor(ACTIVE, 'tab1', '/ws/dir/a.md')
    h.nativeEditor(ACTIVE, 'tab2', '/ws/dir/sub/b.ts')
    h.nativeEditor(ACTIVE, 'tab3', '/ws/other.md')

    closePathTabs(h.ctx, '/ws/dir', 'discard?')

    expect(h.records.has(ACTIVE, 'tab1')).toBe(false)
    expect(h.records.has(ACTIVE, 'tab2')).toBe(false)
    expect(h.records.has(ACTIVE, 'tab3')).toBe(true)
  })

  it('asks before dropping an unsaved native draft, and keeps it when declined', () => {
    const confirmSpy = vi.fn().mockReturnValue(false)
    vi.stubGlobal('confirm', confirmSpy)
    const h = harness()
    h.nativeEditor(ACTIVE, 'tab1', '/ws/a.md')
    setEditorDirty('tab1', true, ACTIVE, '/ws/a.md')

    closePathTabs(h.ctx, '/ws/a.md', 'discard?')

    expect(confirmSpy).toHaveBeenCalledWith('discard?')
    expect(h.records.has(ACTIVE, 'tab1')).toBe(true)
  })

  it('closes a BACKGROUND session’s native page through ITS seat', () => {
    const h = harness()
    h.nativeEditor(OTHER, 'tab1', '/ws/a.md')

    closePathTabs(h.ctx, '/ws/a.md', 'discard?')

    expect(h.records.has(OTHER, 'tab1')).toBe(false)
    // Not on screen: the close goes through the cross-session entry point.
    expect(h.controller.closeIn).toHaveBeenCalledWith(OTHER, 'tab1')
    expect(h.controller.close).not.toHaveBeenCalled()
  })

  it('still closes bottom workbench pages (the pre-existing half)', () => {
    const h = harness(false)
    bottomEditor(h.service, h.store, '/ws/a.md')
    bottomEditor(h.service, h.store, '/ws/keep.md')

    closePathTabs(h.ctx, '/ws/a.md', 'discard?')

    expect(pathsOf(h.store)).toEqual(['/ws/keep.md'])
  })
})
