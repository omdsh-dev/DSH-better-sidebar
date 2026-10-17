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
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
  listParams: Record<string, unknown>[]
  searchParams: Record<string, unknown>[]
  resolveParams: Record<string, unknown>[]
  inserted: unknown[]
  pinned: string[]
}

function fixture(options: {
  workspaceId?: string | undefined
  enabled?: string[]
  listItems?: ClueCandidate[]
  listError?: boolean
  resolveCandidates?: ClueCandidate[]
} = {}): Fixture {
  const calls: Calls = { list: 0, search: 0, resolve: 0 }
  const listParams: Record<string, unknown>[] = []
  const searchParams: Record<string, unknown>[] = []
  const resolveParams: Record<string, unknown>[] = []
  const inserted: unknown[] = []
  const pinned: string[] = []
  const enabled = new Set(options.enabled ?? [FILES.sourceId, GITHUB.sourceId])
  const packs = [pack('p1', 'Release clues', ['c1', 'c2']), pack('p2', 'Design notes', [])]
  const store = createSidebarStore()
  store.setPrefs({ ...SIDEBAR_PREFS_DEFAULTS })

  const emptyPins: CluesPinsResult = { pins: [], revision: 0 }
  const api = {
    sources: async (): Promise<CluesSourcesCatalogResult> => ({ sources: [FILES, FEISHU_DOCS, GITHUB], types: [] }),
    packsList: async (): Promise<CluesPacksResult> => ({ packs, revision: 3 }),
    pinsList: async (): Promise<CluesPinsResult> => emptyPins,
    pinsAdd: async (_workspaceId: string, input: { clueId: string }): Promise<CluesPinsResult> => {
      pinned.push(input.clueId)
      return { pins: [{ workspaceId: 'ws-1', clueId: input.clueId, createdAt: '' }], revision: 1 }
    },
    pinsRemove: async (): Promise<CluesPinsResult> => emptyPins,
    clues: async () => ({ clues: [], revision: 0 }),
    list: async (_workspaceId: string, input: Record<string, unknown>): Promise<ClueListResult> => {
      calls.list += 1
      listParams.push(input)
      if (options.listError === true) throw new Error('catalogue failed')
      return { items: options.listItems ?? [] }
    },
    search: async (_workspaceId: string, input: Record<string, unknown>): Promise<ClueListResult> => {
      calls.search += 1
      searchParams.push(input)
      return { items: options.listItems ?? [] }
    },
    resolve: async (_workspaceId: string, input: Record<string, unknown>) => {
      calls.resolve += 1
      resolveParams.push(input)
      return { candidates: options.resolveCandidates ?? [] as ClueCandidate[] }
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
  let draftRev = 1
  const conversation = {
    input: {
      for: () => ({
        state: { getSnapshot: () => ({ draft: '', draftRev }) },
        setDraft: () => undefined,
      }),
    },
  }
  const ctx = {
    get: (name: string) => (name === 'betterSidebar'
      ? service
      : name === 'workspaces'
        ? workspaces
        : name === 'conversation'
          ? conversation
          : undefined),
    sessions: {
      scope: () => ({
        emit: (_name: string, payload: unknown) => {
          inserted.push(payload)
          draftRev += 1
        },
      }),
    },
  }
  return {
    store,
    ctx: ctx as never,
    calls,
    enabled,
    packs,
    listParams,
    searchParams,
    resolveParams,
    inserted,
    pinned,
  }
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
    // The resolver falls back to the host lookup, which rejects asynchronously
    // in jsdom (relative URL): wait for the settled empty state rather than
    // assuming a fixed number of microtask turns.
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('This session has no workspace yet')
    }, { timeout: 3_000 })
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

// ── browser interactions ────────────────────────────────────────────────────

/** Set one controlled input's value through React's change pipeline. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(container: ParentNode, text: string): void {
  const button = [...container.querySelectorAll('button')]
    .find(candidate => (candidate.textContent ?? '').trim() === text || candidate.getAttribute('aria-label') === text)
  if (button === undefined) throw new Error(`button "${text}" not found`)
  act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

describe('clue tab source browser', () => {
  it('persists an explicit GitHub range per workspace and lists with it', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [GITHUB.sourceId] })
    const view = mount(fx)
    await flush()
    expect(fx.calls.list).toBe(0)

    press(view.container, 'Choose range')
    await flush()
    const repoInput = view.container.querySelector<HTMLInputElement>('input[placeholder="owner/repo or repository URL"]')!
    typeInto(repoInput, 'acme/widgets')
    press(view.container, 'Save range')
    await flush()

    const saved = fx.store.getPrefs().pluginSettings.clues as {
      scopes?: Record<string, Record<string, unknown>>
    }
    expect(saved.scopes?.['ws-1']?.[GITHUB.sourceId]).toEqual({ repo: 'acme/widgets', state: 'open' })
    expect(fx.calls.list).toBeGreaterThan(0)
    expect(fx.listParams[0]).toMatchObject({
      sourceId: GITHUB.sourceId,
      scope: { repo: 'acme/widgets', state: 'open' },
    })
    view.unmount()
  })

  it('searches the active source with the typed keyword', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId] })
    const view = mount(fx)
    await flush()
    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="Search a keyword, or paste a resource URL / path"]')!
    typeInto(input, 'release notes')
    press(view.container, 'Search')
    await flush()
    expect(fx.calls.search).toBe(1)
    expect(fx.searchParams[0]).toMatchObject({ sourceId: FILES.sourceId, query: 'release notes' })
    view.unmount()
  })

  it('resolves a pasted URL into candidates and inserts a stable chip', async () => {
    const candidate: ClueCandidate = {
      sourceId: GITHUB.sourceId,
      typeId: 'builtin.github.issue',
      locator: { host: 'github.com', owner: 'acme', repo: 'widgets', kind: 'issue', number: 7 },
      title: 'Fix the widget',
    }
    const fx = fixture({ workspaceId: 'ws-1', enabled: [GITHUB.sourceId], resolveCandidates: [candidate] })
    fx.store.setPrefs({
      ...fx.store.getPrefs(),
      pluginSettings: { clues: { scopes: { 'ws-1': { [GITHUB.sourceId]: { repo: 'acme/widgets', state: 'open' } } } } },
    })
    const view = mount(fx)
    await flush()
    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="Search a keyword, or paste a resource URL / path"]')!
    typeInto(input, 'https://github.com/acme/widgets/issues/7')
    press(view.container, 'Search')
    await flush()
    expect(fx.calls.resolve).toBe(1)
    expect(fx.resolveParams[0]).toMatchObject({ text: 'https://github.com/acme/widgets/issues/7' })
    expect(view.container.textContent).toContain('Fix the widget')
    press(view.container, 'Insert')
    await flush()
    expect(fx.inserted).toHaveLength(1)
    expect(fx.inserted[0]).toMatchObject({
      reference: { source: 'better-sidebar:clues', clipboardText: '[[dsh-clue:c9]]', appearance: 'file' },
    })
    view.unmount()
  })

  it('pins a result through ensure + pins.add and marks the row', async () => {
    const candidate: ClueCandidate = {
      sourceId: FILES.sourceId,
      typeId: 'builtin.files.markdown',
      locator: { path: 'docs/a.md' },
      title: 'A note',
    }
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId], listItems: [candidate] })
    const view = mount(fx)
    await flush()
    press(view.container, 'Pin')
    await flush()
    expect(fx.pinned).toEqual(['c9'])
    view.unmount()
  })

  it('shows a retryable error instead of pretending the source is empty', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId], listError: true })
    const view = mount(fx)
    await flush()
    expect(view.container.textContent).toContain('Failed to load')
    expect([...view.container.querySelectorAll('button')].some(button => (button.textContent ?? '').trim().toLowerCase() === 'retry')).toBe(true)
    view.unmount()
  })
})
