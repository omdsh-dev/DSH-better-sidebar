// @vitest-environment jsdom
/**
 * Tracy's additions to the service face: the DiffView seam, and reloadTab /
 * openTabsOf rewritten for the native right Sidebar (0.21.1-tracy.1).
 */
import { describe, expect, it } from 'vitest'
import { createBetterSidebarService, SIDEBAR_FEATURES, type SidebarSurface } from '../src/client/service.ts'
import { allLeaves, createSidebarStore, type SidebarTab } from '../src/client/state.ts'
import { DiffFiles } from '../src/client/diff/DiffFiles.tsx'

/** A native surface fake holding records by id (what native/surface.ts does over NativeTabRecords). */
function fakeSurface(records: Map<string, SidebarTab>): SidebarSurface & { updates: unknown[] } {
  const updates: unknown[] = []
  return {
    updates,
    openTab: () => {},
    openResource: () => {},
    fileAddress: () => '',
    close: () => undefined,
    update: (tabId, patch) => {
      const tab = records.get(tabId)
      if (tab === undefined) return false
      updates.push({ tabId, patch })
      records.set(tabId, { ...tab, ...patch })
      return true
    },
    activate: tabId => records.has(tabId),
    has: tabId => records.has(tabId),
    tabOf: tabId => records.get(tabId),
    tabsOfType: type => [...records.values()].filter(tab => tab.type === type),
  }
}

describe('DiffView seam', () => {
  it('hands plugins the side card diff renderer and advertises it', () => {
    const service = createBetterSidebarService(createSidebarStore())
    expect(service.DiffView).toBe(DiffFiles)
    expect(SIDEBAR_FEATURES).toContain('diffView')
  })
})

describe('reloadTab on the native surface', () => {
  it('writes a fresh nonce and the mode into a native record, keeping its other meta', () => {
    const records = new Map<string, SidebarTab>([
      ['n1', { id: 'n1', type: 'tracy:browser', title: 'a', meta: { url: 'https://a.tracy.test/' } }],
    ])
    const service = createBetterSidebarService(createSidebarStore())
    service.setSurface(fakeSurface(records))
    service.reloadTab('n1', 'style')
    const first = records.get('n1')!.meta as Record<string, unknown>
    expect(first.url).toBe('https://a.tracy.test/')
    expect(first.reloadMode).toBe('style')
    expect(typeof first.reloadNonce).toBe('string')
    service.reloadTab('n1')
    const second = records.get('n1')!.meta as Record<string, unknown>
    expect(second.reloadNonce).not.toBe(first.reloadNonce)
    // A mode is never left over from the previous reload.
    expect(second.reloadMode).toBeUndefined()
    expect(SIDEBAR_FEATURES).toContain('reloadTab')
  })

  it('is a strict no-op for an unknown id', () => {
    const records = new Map<string, SidebarTab>()
    const surface = fakeSurface(records)
    const store = createSidebarStore()
    store.setSession('s1')
    const before = store.getSnapshot().state
    const service = createBetterSidebarService(store)
    service.setSurface(surface)
    service.reloadTab('missing', 'style')
    expect(surface.updates).toEqual([])
    expect(store.getSnapshot().state).toBe(before)
  })

  it('reaches a bottom-workbench tab through the store', () => {
    const store = createSidebarStore()
    store.setSession('s1')
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'tracy:browser', title: 'Browser', component: () => null })
    service.openTab({ type: 'tracy:browser', url: 'https://a.tracy.test/', target: 'bottom' })
    const tab = allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)[0]!
    service.reloadTab(tab.id, 'full')
    const reloaded = allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)[0]!
    expect((reloaded.meta as Record<string, unknown>).reloadMode).toBe('full')
  })
})

describe('openTabsOf', () => {
  it('lists the live native records of one type, then the bottom workbench tabs', () => {
    const records = new Map<string, SidebarTab>([
      ['n1', { id: 'n1', type: 'tracy:browser', title: 'a', meta: { url: 'https://a.tracy.test/' } }],
      ['n2', { id: 'n2', type: 'editor', title: 'x' }],
    ])
    const store = createSidebarStore()
    store.setSession('s1')
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'tracy:browser', title: 'Browser', component: () => null })
    service.setSurface(fakeSurface(records))
    service.openTab({ type: 'tracy:browser', url: 'https://b.tracy.test/', target: 'bottom' })
    const found = service.openTabsOf('tracy:browser')
    expect(found.map(tab => tab.id)[0]).toBe('n1')
    expect(found).toHaveLength(2)
    expect(service.openTabsOf('nothing')).toEqual([])
  })
})
