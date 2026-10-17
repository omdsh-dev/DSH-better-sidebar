/**
 * S9 clue tab — main page.
 *
 * Contract pinned here:
 * - the page resolves ONE stable workspace id for the session and never
 *   guesses a cwd; a session without a workspace shows the explicit empty
 *   state instead of firing any clue query;
 * - the upper region lists the pack library (name + member count) and the
 *   lower region lists every ENABLED source, with the disabled ones absent;
 * - a source that needs an explicit range shows the "choose a range" state and
 *   issues no list request until the reader picks one;
 * - the first visit opens the help overlay once (browser-local preference),
 *   the header `?` reopens it, and closing returns focus to the trigger;
 * - a hidden tab body performs no query (keepMounted gating).
 */
// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createElement } from 'react'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'

setupReactAct()
beforeAll(() => {
  Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
})

import { CluesTab } from '../src/client/clues/tab/CluesTab.tsx'
import { CLUE_HELP_SEEN_KEY } from '../src/client/clues/tab/help.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import type { SidebarStore } from '../src/client/state.ts'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'
import { BUILTIN_SOURCE_IDS } from '../src/clues/types.ts'
import type {
  ClueCandidate,
  ClueListResult,
  CluePack,
  ClueSourceDescriptor,
  CluesPacksResult,
  CluesPinsResult,
  CluesSourcesCatalogResult,
} from '../src/clues/types.ts'

// ── fixtures ────────────────────────────────────────────────────────────────

function source(sourceId: string, name: string, order: number): ClueSourceDescriptor {
  return {
    sourceId,
    name,
    order,
    pluginId: 'dsh-better-sidebar',
    types: [],
    transport: 'files',
    capabilities: { resolve: true, list: true, search: true, read: true, edit: false, portable: true },
  }
}

const FILES = source(BUILTIN_SOURCE_IDS.files, 'Local files', 0)
const GITHUB = source(BUILTIN_SOURCE_IDS.githubIssues, 'GitHub Issues', 10)
const FEISHU_DOCS = source(BUILTIN_SOURCE_IDS.feishuDocs, 'Feishu docs', 3)

function pack(id: string, name: string, members: string[]): CluePack {
  return {
    id,
    name,
    workspaceId: 'ws-1',
    members,
    revision: 1,
    createdAt: '2026-10-17T00:00:00.000Z',
    updatedAt: '2026-10-17T00:00:00.000Z',
  }
}

interface Calls {
  list: number
  search: number
  resolve: number
}

interface Fixture {
  store: SidebarStore
  ctx: unknown
  calls: Calls
  enabled: Set<string>
  packs: CluePack[]
}

function fixture(options: { workspaceId?: string | undefined; enabled?: string[] } = {}): Fixture {
  const calls: Calls = { list: 0, search: 0, resolve: 0 }
  const enabled = new Set(options.enabled ?? [FILES.sourceId, GITHUB.sourceId])
  const packs = [pack('p1', 'Release clues', ['c1', 'c2']), pack('p2', 'Design notes', [])]
  const store = createSidebarStore()
  store.setPrefs({ ...SIDEBAR_PREFS_DEFAULTS })

  const emptyPins: CluesPinsResult = { pins: [], revision: 0 }
  const api = {
    sources: async (): Promise<CluesSourcesCatalogResult> => ({ sources: [FILES, FEISHU_DOCS, GITHUB], types: [] }),
    packsList: async (): Promise<CluesPacksResult> => ({ packs, revision: 3 }),
    pinsList: async (): Promise<CluesPinsResult> => emptyPins,
    pinsAdd: async (): Promise<CluesPinsResult> => emptyPins,
    pinsRemove: async (): Promise<CluesPinsResult> => emptyPins,
    clues: async () => ({ clues: [], revision: 0 }),
    list: async (): Promise<ClueListResult> => {
      calls.list += 1
      return { items: [] }
    },
    search: async (): Promise<ClueListResult> => {
      calls.search += 1
      return { items: [] }
    },
    resolve: async () => {
      calls.resolve += 1
      return { candidates: [] as ClueCandidate[] }
    },
    ensure: async () => ({ clue: { id: 'c9' }, created: true }),
    packsCreate: async () => ({ pack: pack('p3', 'New', []), revision: 4, packRevision: 1 }),
    packsAddMember: async () => ({ pack: packs[0]!, revision: 4, packRevision: 2 }),
    packsRename: async () => ({ pack: packs[0]!, revision: 4, packRevision: 2 }),
    packsRemoveMember: async () => ({ pack: packs[0]!, revision: 4, packRevision: 2 }),
    bindingsList: async () => ({ bindings: [], revision: 0 }),
    bindingsAdd: async () => ({ bindings: [], revision: 1 }),
    bindingsRemove: async () => ({ bindings: [], revision: 2 }),
  }

  const face = {
    api,
    registerSourceDisplay: () => () => {},
    getSourceDisplays: () => [],
    registerFormatRenderer: () => () => {},
    getFormatRenderer: () => undefined,
    getFormatRenderers: () => new Map(),
    subscribe: () => () => {},
    isSourceEnabled: (id: string) => enabled.has(id),
    isSourceMentionEnabled: (id: string) => enabled.has(id),
    isPacksMentionEnabled: () => true,
  }
  const service = { clues: face, windows: { open: () => ({ update: () => {}, focus: () => {}, close: async () => {}, navigation: {} }) } }
  const workspaces = {
    list: {
      getSnapshot: () => ({
        phase: 'ready',
        state: 'idle',
        items: [{
          path: '/repo',
          sessionIds: ['s1'],
          ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
        }],
      }),
    },
  }
  const ctx = {
    get: (name: string) => (name === 'betterSidebar' ? service : name === 'workspaces' ? workspaces : name === 'conversation' ? undefined : undefined),
    sessions: { scope: () => ({ emit: () => {} }) },
  }
  return { store, ctx: ctx as never, calls, enabled, packs }
}

/** Flush the async effects of one render pass (microtasks + a macrotask). */
async function flush(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
}

function mount(fx: Fixture, visible = true): RenderedRoot {
  return renderRoot(createElement(CluesTab, {
    ctx: fx.ctx as never,
    store: fx.store,
    scope: { sessionId: 's1' },
    visible,
  }))
}

beforeEach(() => {
  window.localStorage.clear()
})

// ── tests ───────────────────────────────────────────────────────────────────

describe('clue tab main page', () => {
  it('renders the pack library and the enabled source browser', async () => {
    const fx = fixture({ workspaceId: 'ws-1' })
    const view = mount(fx)
    await flush()

    expect(view.container.textContent).toContain('Clue packs')
    expect(view.container.textContent).toContain('Release clues')
    expect(view.container.textContent).toContain('2 members')
    expect(view.container.textContent).toContain('Browse sources')
    // Enabled sources are tabs; the disabled Feishu docs source is absent.
    expect(view.container.textContent).toContain('Local files')
    expect(view.container.textContent).toContain('GitHub Issues')
    expect(view.container.textContent).not.toContain('Feishu docs')

    view.unmount()
  })

  it('shows the explicit empty state without a workspace and never queries', async () => {
    const fx = fixture({ workspaceId: undefined })
    const view = mount(fx)
    await flush()

    expect(view.container.textContent).toContain('This session has no workspace yet')
    expect(fx.calls.list).toBe(0)
    expect(fx.calls.search).toBe(0)

    view.unmount()
  })

  it('shows the help once on first visit and remembers the closed state', async () => {
    const fx = fixture({ workspaceId: 'ws-1' })
    const view = mount(fx)
    await flush()

    const dialog = view.container.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('Provides resources')
    const close = [...view.container.querySelectorAll('button')]
      .find(button => button.getAttribute('aria-label') === 'Close help')
    expect(close).toBeDefined()
    act(() => { close?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(view.container.querySelector('[role="dialog"]')).toBeNull()
    expect(window.localStorage.getItem(CLUE_HELP_SEEN_KEY)).toBe('1')

    // The header `?` reopens it.
    const help = [...view.container.querySelectorAll('button')]
      .find(button => button.getAttribute('aria-label') === 'Show clues help')
    act(() => { help?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(view.container.querySelector('[role="dialog"]')).not.toBeNull()

    view.unmount()
  })

  it('does not render a second help overlay for an already-initialised browser', async () => {
    window.localStorage.setItem(CLUE_HELP_SEEN_KEY, '1')
    const fx = fixture({ workspaceId: 'ws-1' })
    const view = mount(fx)
    await flush()
    expect(view.container.querySelector('[role="dialog"]')).toBeNull()
    view.unmount()
  })

  it('asks for an explicit range before listing GitHub and issues no list request', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [GITHUB.sourceId] })
    const view = mount(fx)
    await flush()
    expect(view.container.textContent).toContain('No range chosen yet')
    expect(fx.calls.list).toBe(0)
    view.unmount()
  })

  it('performs no query while the tab body is hidden', async () => {
    const fx = fixture({ workspaceId: 'ws-1' })
    const view = mount(fx, false)
    await flush()
    expect(fx.calls.list).toBe(0)
    expect(fx.calls.search).toBe(0)
    view.unmount()
  })
})
