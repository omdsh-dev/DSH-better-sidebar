/**
 * Cache-first surfaces: a remount inside one plugin activation paints the
 * warm pack library, members and destinations without a loader and without a
 * second wire read. These are user-facing seams of the shared clue cache: the
 * first mount owns the read, every later mount reuses the completed answer
 * until a mutation invalidates that family.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'
import { cluesApi, invalidateClueRequests } from '../src/client/clues/api.ts'
import { CluePacksSection } from '../src/client/clues/tab/packs.tsx'
import { clearClueCollectionDrafts, ClueCollectPage } from '../src/client/clues/windows/collect.tsx'
import { PackManagementPage, type PackDraftGuard } from '../src/client/clues/windows/pack.tsx'
import { SharePage } from '../src/client/clues/windows/share.tsx'
import type { BetterSidebarCluesClientFace } from '../src/client/clues/registry.ts'
import type { WindowHandle, WindowOpenOptions } from '../src/client/windows/types.ts'
import type { ClueCandidate, CluePack } from '../src/clues/types.ts'

setupReactAct()

const PACK: CluePack = {
  id: 'p1', name: 'Release clues', workspaceId: 'ws-1', members: ['c1'], revision: 1,
  createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:00.000Z',
}
const TARGET: ClueCandidate = {
  sourceId: 'builtin.files', typeId: 'builtin.files.markdown', clueId: 'c1',
  title: 'A note', locator: { path: 'a.md' },
}

function windows(): { open(options: WindowOpenOptions): WindowHandle } {
  return {
    open(options: WindowOpenOptions): WindowHandle {
      return {
        id: options.id, update: () => undefined, focus: () => undefined,
        close: async () => undefined,
        navigation: { push: () => undefined, pop: () => false, back: () => false, canGoBack: () => false, depth: () => 1 },
      }
    },
  }
}

function face(): BetterSidebarCluesClientFace {
  return {
    api: cluesApi,
    registerSourceDisplay: () => () => {},
    getSourceDisplays: () => [],
    registerFormatRenderer: () => () => {},
    getFormatRenderer: () => undefined,
    getFormatRenderers: () => new Map(),
    subscribe: () => () => {},
    isSourceEnabled: () => true,
    isSourceMentionEnabled: () => true,
    isPacksMentionEnabled: () => true,
  }
}

/** One successful clue envelope. */
function wire(value: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ ok: true, value }) } as Response
}

/** Stub the ONE client transport; count the reads per clue method. */
function stubWire(): (method: string) => number {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const method = String(url).split('?')[0]!.split('/sidebar/api/').at(-1) ?? ''
    calls.push(method)
    const value = method === 'clues.clues'
      ? {
          clues: [{
            id: 'c1', sourceId: 'builtin.files', typeId: 'builtin.files.markdown',
            locator: { path: 'a.md' }, title: 'A note', workspaceId: 'ws-1', createdAt: '', updatedAt: '',
          }],
          revision: 1,
        }
      : method === 'clues.packs.list' ? { packs: [PACK], revision: 2 }
        : method === 'clues.sources'
          ? {
              sources: [{
                sourceId: 'builtin.files', name: 'Local files', order: 0, pluginId: 'test', types: [],
                transport: 'files',
                capabilities: { resolve: true, list: true, search: true, read: true, edit: false, portable: true },
              }],
              types: [],
            }
          : method === 'clues.bindings.list' ? { bindings: [], revision: 0 }
            : { unexpected: method }
    return { ok: true, status: 200, json: async () => ({ ok: true, value }) } as Response
  }))
  return (method: string): number => calls.filter(item => item === method).length
}

const roots: RenderedRoot[] = []
function mount(node: ReturnType<typeof createElement>): RenderedRoot {
  const view = renderRoot(node)
  roots.push(view)
  return view
}
async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}
/** The root LoadingIndicator of a surface (not an inline progress glyph). */
function loader(root: RenderedRoot): Element | null {
  return root.container.querySelector('[data-loading-indicator]')
}

beforeEach(() => {
  invalidateClueRequests()
  clearClueCollectionDrafts()
})
afterEach(() => {
  for (const view of roots.splice(0)) view.unmount()
  invalidateClueRequests()
  vi.unstubAllGlobals()
})

describe('cache-first clue surfaces', () => {
  it('remounts the pack window from warm reads without a loader or wire read', async () => {
    const reads = stubWire()
    const guard: PackDraftGuard = { dirty: false }
    const props = {
      windows: windows(), workspaceId: 'ws-1', face: face(),
      workspaces: [{ workspaceId: 'ws-1', title: '/repo' }],
      pack: PACK, guard,
      onInsertClue: () => true, onInsertPack: () => true, onNotice: () => undefined,
    }
    const first = mount(createElement(PackManagementPage, props))
    await flush()
    expect(first.container.textContent).toContain('A note')
    expect(reads('clues.packs.list')).toBe(1)
    expect(reads('clues.clues')).toBe(1)
    first.unmount()
    roots.splice(roots.indexOf(first), 1)

    const second = mount(createElement(PackManagementPage, { ...props, guard: { dirty: false } }))
    expect(loader(second)).toBeNull()
    await flush()
    expect(second.container.textContent).toContain('A note')
    expect(loader(second)).toBeNull()
    expect(reads('clues.packs.list')).toBe(1)
    expect(reads('clues.clues')).toBe(1)
    expect(reads('clues.sources')).toBe(1)
  })

  it('remounts the collection destinations from the warm pack library', async () => {
    const reads = stubWire()
    const handle: WindowHandle = windows().open({ id: 'collect', title: 'x', content: null })
    const props = {
      windows: windows(), face: face(), workspaceId: 'ws-1',
      targets: [TARGET], onNotice: () => undefined,
      guard: { busy: false, handle },
    }
    const first = mount(createElement(ClueCollectPage, props))
    await flush()
    expect(first.container.textContent).toContain('Release clues')
    expect(reads('clues.packs.list')).toBe(1)
    first.unmount()
    roots.splice(roots.indexOf(first), 1)

    const second = mount(createElement(ClueCollectPage, {
      ...props, guard: { busy: false, handle },
    }))
    expect(loader(second)).toBeNull()
    await flush()
    expect(second.container.textContent).toContain('Release clues')
    expect(loader(second)).toBeNull()
    expect(reads('clues.packs.list')).toBe(1)
  })

  it('remounts the share picker from the warm pack library', async () => {
    const reads = stubWire()
    const props = { windows: windows(), workspaceId: 'ws-1', face: face() }
    const first = mount(createElement(SharePage, props))
    await flush()
    expect(first.container.textContent).toContain('Release clues')
    expect(reads('clues.packs.list')).toBe(1)
    first.unmount()
    roots.splice(roots.indexOf(first), 1)

    const second = mount(createElement(SharePage, props))
    expect(loader(second)).toBeNull()
    await flush()
    expect(second.container.textContent).toContain('Release clues')
    expect(loader(second)).toBeNull()
    expect(reads('clues.packs.list')).toBe(1)
  })

  it('clears a hidden shelf refresh and reuses the completed packs cache', async () => {
    let calls = 0
    let releaseSecond!: () => void
    const second = new Promise<Response>((resolve) => {
      releaseSecond = () => resolve(wire({ packs: [PACK], revision: 3 }))
    })
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const method = String(url).split('?')[0]!.split('/sidebar/api/').at(-1) ?? ''
      if (method !== 'clues.packs.list') return Promise.resolve(wire({ unexpected: method }))
      calls += 1
      if (calls === 1) return Promise.resolve(wire({ packs: [PACK], revision: 2 }))
      if (calls === 2) return second
      return Promise.resolve(wire({ packs: [PACK], revision: 4 }))
    }))
    const props = {
      workspaceId: 'ws-1', face: face(), windows: windows(), visible: true,
      settings: {}, onSettingsChange: () => undefined,
      onInsertPack: () => true, onOpenPack: () => undefined,
      onImport: () => undefined, onNotice: () => undefined,
    }
    const shelf = mount(createElement(CluePacksSection, props))
    await flush()
    expect(shelf.container.textContent).toContain('Release clues')
    expect(calls).toBe(1)

    // The revision arrives after a mutation invalidated the pack family.
    invalidateClueRequests('ws-1', 'clues.packs.list')
    shelf.rerender(createElement(CluePacksSection, { ...props, refreshRevision: 1 }))
    await flush()
    expect(calls).toBe(2)
    expect(shelf.container.querySelector('[data-clue-refresh-status="refreshing"]')).not.toBeNull()

    const scroll = shelf.container.querySelector<HTMLElement>('[data-clue-pack-scroll]')!
    scroll.scrollTop = 37
    shelf.rerender(createElement(CluePacksSection, { ...props, visible: false, refreshRevision: 1 }))
    await flush()
    expect(calls).toBe(2)
    expect(shelf.container.querySelector('[data-clue-refresh-status="refreshing"]')).toBeNull()

    releaseSecond()
    await flush()
    shelf.rerender(createElement(CluePacksSection, { ...props, visible: true, refreshRevision: 1 }))
    await flush()
    expect(calls).toBe(2)
    expect(shelf.container.querySelector('[data-clue-refresh-status="refreshing"]')).toBeNull()
    expect(shelf.container.textContent).toContain('Release clues')
    expect(shelf.container.querySelector<HTMLElement>('[data-clue-pack-scroll]')!.scrollTop).toBe(37)
    expect(loader(shelf)).toBeNull()
  })

  it('updates one open pack member from a real library event without remount', async () => {
    let state: 'active' | 'completed' = 'active'
    const counts: Record<string, number> = {}
    const source = {
      sourceId: 'builtin.files', name: 'Local files', order: 0, pluginId: 'test', types: [],
      transport: 'files',
      capabilities: { resolve: true, list: true, search: true, read: true, edit: false, portable: true },
    }
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const method = String(url).split('?')[0]!.split('/sidebar/api/').at(-1) ?? ''
      counts[method] = (counts[method] ?? 0) + 1
      if (method === 'clues.clues') {
        return Promise.resolve(wire({
          clues: [{
            id: 'c1', sourceId: 'builtin.files', typeId: 'builtin.files.markdown',
            locator: { path: 'a.md' }, title: 'A note', workspaceId: 'ws-1', createdAt: '', updatedAt: '',
            info: { state },
          }],
          revision: counts[method],
        }))
      }
      if (method === 'clues.packs.list') return Promise.resolve(wire({ packs: [PACK], revision: 2 }))
      if (method === 'clues.sources') return Promise.resolve(wire({ sources: [source], types: [] }))
      if (method === 'clues.bindings.list') return Promise.resolve(wire({ bindings: [], revision: 0 }))
      if (method === 'clues.saveEdit') {
        state = 'completed'
        return Promise.resolve(wire({ revision: 2, savedAt: '2026-10-17T00:00:00.000Z' }))
      }
      return Promise.resolve(wire({ unexpected: method }))
    }))
    const props = {
      windows: windows(), workspaceId: 'ws-1', face: face(),
      workspaces: [{ workspaceId: 'ws-1', title: '/repo' }],
      pack: PACK, guard: { dirty: false },
      onInsertClue: () => true, onInsertPack: () => true, onNotice: () => undefined,
    }
    const view = mount(createElement(PackManagementPage, props))
    await flush()
    // Locate the row by identity, not by a state word: an active resource is the
    // resting case and deliberately prints no state.
    const row = view.container.querySelector('[data-clue-pack-member="c1"]')
    expect(row).not.toBeNull()
    expect(loader(view)).toBeNull()

    await act(async () => {
      await cluesApi.saveEdit('ws-1', {
        clueId: 'c1',
        document: { format: 'text/markdown', data: { text: '# Changed' } },
      })
    })
    await flush()
    const completed = view.container.querySelector('[data-clue-resource-inline-state="completed"]')
    expect(completed).not.toBeNull()
    expect(completed!.closest('li')).toBe(row)
    expect(view.container.querySelector('[data-clue-resource-inline-state="active"]')).toBeNull()
    expect(loader(view)).toBeNull()
    expect(counts['clues.clues']).toBe(2)
    expect(counts['clues.packs.list']).toBe(1)
    expect(counts['clues.sources']).toBe(1)
    expect(counts['clues.bindings.list']).toBe(1)
  })
})
