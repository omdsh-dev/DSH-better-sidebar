/**
 * S9 clue tab — main page.
 *
 * Contract pinned here:
 * - the page resolves ONE stable workspace id for the session and never
 *   guesses a cwd; a session without a workspace shows the explicit empty
 *   state instead of firing any clue query;
 * - resources and collections are full-height views that stay mounted;
 *   only the active view reads, and collection interactions never re-query resources;
 * - a source that needs an explicit range shows the "choose a range" state and
 *   issues no list request until the reader opens the scope window and saves;
 * - scope and selection surfaces are REAL HostedWindow portals mounted by the
 *   production window host; their drafts stay in the parent so close/reopen and
 *   native-tab hiding lose nothing;
 * - resource and pack lists grow via the end sentinel, not Previous/Next;
 * - only `?` opens help, and closing returns focus to its trigger;
 * - a hidden tab body performs no query (keepMounted gating).
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createElement, Fragment } from 'react'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'

setupReactAct()
beforeAll(() => {
  Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
})

import { ClueBrowser } from '../src/client/clues/tab/browser.tsx'
import type { BetterSidebarCluesClientFace } from '../src/client/clues/registry.ts'
import { t, type CopyKey } from '../src/client/locales.ts'
import { CluesTab } from '../src/client/clues/tab/CluesTab.tsx'
import clueTabCss from '../src/client/clues/tab/clues-tab.module.css'
import { api as sidebarApi } from '../src/client/api.ts'
import { clueHelpSeen, forgetClueHelpSeen, markClueHelpSeen } from '../src/client/clues/tab/help.tsx'
import { clearClueCollectionDrafts } from '../src/client/clues/windows/collect.tsx'
import { clearClueNotice } from '../src/client/clues/notify.ts'
import { createSidebarStore } from '../src/client/state.ts'
import type { SidebarStore } from '../src/client/state.ts'
import { createWindowHost } from '../src/client/windows/host.ts'
import { WindowHost } from '../src/client/windows/WindowHost.tsx'
import type { WindowHostController, WindowOpenOptions } from '../src/client/windows/types.ts'
import type { FormatRendererRegistry } from '../src/client/windows/format-content.tsx'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'
import { cluesApi, invalidateClueRequests } from '../src/client/clues/api.ts'
import { BUILTIN_SOURCE_IDS } from '../src/clues/types.ts'
import type {
  ClueCandidate,
  ClueDefaultScopeResult,
  ClueListResult,
  CluePack,
  ClueSourceDescriptor,
  CluesPacksResult,
  CluesPinsResult,
  CluesSourcesCatalogResult,
} from '../src/clues/types.ts'

// ── fixtures ────────────────────────────────────────────────────────────────

/** Live window hosts, disposed after each case so no portal or record leaks. */
const hosts: WindowHostController[] = []

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
  packsList: number
  search: number
  resolve: number
  defaultScope: number
}

interface Fixture {
  store: SidebarStore
  ctx: unknown
  /** The REAL window host the tab and HostedWindow portals share. */
  host: WindowHostController
  calls: Calls
  enabled: Set<string>
  packs: CluePack[]
  listParams: Record<string, unknown>[]
  searchParams: Record<string, unknown>[]
  resolveParams: Record<string, unknown>[]
  ensureParams: Record<string, unknown>[]
  createParams: Record<string, unknown>[]
  addMemberParams: Record<string, unknown>[]
  defaultScopeParams: Record<string, unknown>[]
  defaultScopeSignals: (AbortSignal | undefined)[]
  inserted: unknown[]
  pinned: string[]
  /** Every window the tab opened (the pack/detail/share surfaces). */
  opened: WindowOpenOptions[]
}

function fixture(options: {
  workspaceId?: string | undefined
  /** A second browse workspace (session-less) for the owner/lock regression. */
  secondWorkspaceId?: string | undefined
  enabled?: string[]
  listItems?: ClueCandidate[]
  listError?: boolean
  searchError?: boolean
  packsError?: boolean
  resolveCandidates?: ClueCandidate[]
  listResponse?: (signal: AbortSignal | undefined, input: Record<string, unknown>) => Promise<ClueListResult>
  searchResponse?: (input: Record<string, unknown>) => Promise<ClueListResult>
  pinsError?: () => boolean | Promise<boolean>
  ensureResponse?: (input: Record<string, unknown>) => Promise<{ clue: { id: string }; created: boolean }>
  createResponse?: (input: Record<string, unknown>) => Promise<{ pack: CluePack; revision: number; packRevision: number }>
  addMemberResponse?: (input: Record<string, unknown>) => Promise<{ pack: CluePack; revision: number; packRevision: number }>
  /** Automatic workspace range answered by `clues.defaultScope`. */
  defaultScopeResponse?: ClueDefaultScopeResult
  /** Full override (deferred answers / abort observation) for one defaultScope call. */
  defaultScope?: (
    workspaceId: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<ClueDefaultScopeResult>
  /** Catalogue descriptors for cases that need source setup needs. */
  catalogSources?: readonly ClueSourceDescriptor[]
  /** Use the REAL registry API (and therefore the shared read cache). */
  realApi?: boolean
} = {}): Fixture {
  const calls: Calls = { list: 0, packsList: 0, search: 0, resolve: 0, defaultScope: 0 }
  const listParams: Record<string, unknown>[] = []
  const searchParams: Record<string, unknown>[] = []
  const resolveParams: Record<string, unknown>[] = []
  const ensureParams: Record<string, unknown>[] = []
  const createParams: Record<string, unknown>[] = []
  const addMemberParams: Record<string, unknown>[] = []
  const defaultScopeParams: Record<string, unknown>[] = []
  const defaultScopeSignals: (AbortSignal | undefined)[] = []
  const inserted: unknown[] = []
  const pinned: string[] = []
  const opened: WindowOpenOptions[] = []
  const enabled = new Set(options.enabled ?? [FILES.sourceId, GITHUB.sourceId])
  const packs = [pack('p1', 'Release clues', ['c1', 'c2']), pack('p2', 'Design notes', [])]
  const store = createSidebarStore()
  store.setPrefs({ ...SIDEBAR_PREFS_DEFAULTS })
  // A REAL host: windows are opened by the production code and rendered by
  // WindowHost, so HostedWindow content lands in the same document portal the
  // deployed tab uses. `open` is wrapped only to record the options for
  // assertions; every call reaches the real controller.
  const host = createWindowHost({ viewport: () => ({ width: 1280, height: 900 }) })
  hosts.push(host)

  const emptyPins: CluesPinsResult = { pins: [], revision: 0 }
  const api = {
    defaultScope: async (
      workspaceId: string,
      input: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<ClueDefaultScopeResult> => {
      calls.defaultScope += 1
      defaultScopeParams.push(input)
      defaultScopeSignals.push(signal)
      if (options.defaultScope !== undefined) return options.defaultScope(workspaceId, input, signal)
      return options.defaultScopeResponse ?? { reason: 'no-github-remote' as const }
    },
    sources: async (): Promise<CluesSourcesCatalogResult> => ({
      sources: (options.catalogSources ?? [FILES, FEISHU_DOCS, GITHUB])
        .map(source => ({ ...source, capabilities: { ...source.capabilities } })),
      types: [],
    }),
    read: async () => ({ format: 'text/markdown', data: { text: '# A note' }, fetchedAt: '2026-10-17T00:00:00Z' }),
    loadEdit: async () => ({ format: 'text/markdown', data: { text: '# A note' }, baseRevision: 'r1' }),
    saveEdit: async () => ({ savedAt: '2026-10-17T00:00:00Z' }),
    packsList: async (): Promise<CluesPacksResult> => {
      calls.packsList += 1
      if (options.packsError === true) throw new Error('packs failed')
      return { packs: [...packs], revision: 3 }
    },
    pinsList: async (): Promise<CluesPinsResult> => {
      if (await options.pinsError?.()) throw new Error('pins failed')
      return emptyPins
    },
    pinsAdd: async (_workspaceId: string, input: { clueId: string }): Promise<CluesPinsResult> => {
      pinned.push(input.clueId)
      return { pins: [{ workspaceId: 'ws-1', clueId: input.clueId, createdAt: '' }], revision: 1 }
    },
    pinsRemove: async (): Promise<CluesPinsResult> => emptyPins,
    clues: async () => ({ clues: [], revision: 0 }),
    list: async (_workspaceId: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<ClueListResult> => {
      calls.list += 1
      listParams.push(input)
      if (options.listError === true) throw new Error('catalogue failed')
      if (options.listResponse !== undefined) return options.listResponse(signal, input)
      return { items: options.listItems ?? [] }
    },
    search: async (_workspaceId: string, input: Record<string, unknown>): Promise<ClueListResult> => {
      calls.search += 1
      searchParams.push(input)
      if (options.searchError === true) throw new Error('search failed')
      if (options.searchResponse !== undefined) return options.searchResponse(input)
      return { items: options.listItems ?? [] }
    },
    resolve: async (_workspaceId: string, input: Record<string, unknown>) => {
      calls.resolve += 1
      resolveParams.push(input)
      return { candidates: options.resolveCandidates ?? [] as ClueCandidate[] }
    },
    ensure: async (_workspaceId: string, input: Record<string, unknown>) => {
      ensureParams.push(input)
      return options.ensureResponse?.(input) ?? { clue: { id: 'c9' }, created: true }
    },
    packsCreate: async (_workspaceId: string, input: Record<string, unknown>) => {
      createParams.push(input)
      if (options.createResponse !== undefined) return options.createResponse(input)
      const created = pack('p3', String(input.name), input.members as string[] ?? [])
      packs.push(created)
      return { pack: created, revision: 4, packRevision: 1 }
    },
    packsAddMember: async (_workspaceId: string, input: Record<string, unknown>) => {
      addMemberParams.push(input)
      if (options.addMemberResponse !== undefined) return options.addMemberResponse(input)
      const index = packs.findIndex(candidate => candidate.id === input.packId)
      const previous = packs[index]!
      const target = { ...previous, members: [...previous.members, String(input.clueId)], revision: previous.revision + 1 }
      packs[index] = target
      return { pack: target, revision: 4, packRevision: target.revision }
    },
    packsRename: async () => ({ pack: packs[0]!, revision: 4, packRevision: 2 }),
    packsRemoveMember: async () => ({ pack: packs[0]!, revision: 4, packRevision: 2 }),
    bindingsList: async () => ({ bindings: [], revision: 0 }),
    bindingsAdd: async () => ({ bindings: [], revision: 1 }),
    bindingsRemove: async () => ({ bindings: [], revision: 2 }),
  }

  const face = {
    api: options.realApi === true ? cluesApi : api,
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
  const service = {
    clues: face,
    windows: {
      open: (options: WindowOpenOptions) => {
        opened.push(options)
        return host.open(options)
      },
    },
  }
  const workspaces = {
    list: {
      getSnapshot: () => ({
        phase: 'ready',
        state: 'idle',
        items: [{
          path: '/repo',
          sessionIds: ['s1'],
          ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
        }, ...(options.secondWorkspaceId === undefined ? [] : [{
          path: '/other',
          sessionIds: ['s2'],
          workspaceId: options.secondWorkspaceId,
        }])],
      }),
    },
  }
  let draftRev = 1
  const conversation = {
    input: {
      for: () => ({
        // The public composer face (SessionInput): the insert path uses the
        // structured reference verb and reads `occurrences` for detect-offset
        // coordinates, never a synthetic slash event.
        state: {
          getSnapshot: () => ({
            draft: '',
            draftRev,
            occurrences: [] as readonly { readonly offset: number; readonly length: number }[],
          }),
        },
        setDraft: () => undefined,
        insertReference: (reference: unknown) => {
          inserted.push({ reference })
          draftRev += 1
          return true
        },
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
      // This worktree's pre-integration insert module still asks for the
      // session scope first; the legacy emit keeps local evidence runnable.
      // After the ref fix lands, `insertReference` above is the only path used.
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
    host,
    calls,
    enabled,
    packs,
    listParams,
    searchParams,
    resolveParams,
    ensureParams,
    createParams,
    addMemberParams,
    defaultScopeParams,
    defaultScopeSignals,
    inserted,
    pinned,
    opened,
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

/** jsdom ships no IntersectionObserver; a controllable stand-in for manual triggers. */
interface FakeObserver {
  callback: IntersectionObserverCallback
  options?: IntersectionObserverInit
  targets: Element[]
  disconnected: boolean
}

let fakeObservers: FakeObserver[] = []
let restoreObserver: (() => void) | undefined

function installIntersectionObserver(): void {
  const original = (globalThis as Record<string, unknown>).IntersectionObserver
  const observers: FakeObserver[] = []
  class FakeIntersectionObserver implements FakeObserver {
    readonly targets: Element[] = []
    disconnected = false
    constructor(
      public callback: IntersectionObserverCallback,
      public options?: IntersectionObserverInit,
    ) {
      observers.push(this)
    }
    observe(target: Element): void { this.targets.push(target) }
    unobserve(): void {}
    disconnect(): void { this.disconnected = true }
    takeRecords(): IntersectionObserverEntry[] { return [] }
  }
  ;(globalThis as Record<string, unknown>).IntersectionObserver = FakeIntersectionObserver
  fakeObservers = observers
  restoreObserver = () => {
    if (original === undefined) delete (globalThis as Record<string, unknown>).IntersectionObserver
    else (globalThis as Record<string, unknown>).IntersectionObserver = original
  }
}

/** The live observer whose sentinel lives inside `region` (the newest one). */
function liveObserverFor(region: ParentNode): FakeObserver | undefined {
  return [...fakeObservers].reverse().find(observer =>
    !observer.disconnected && observer.targets.some(target => region.contains(target)))
}

function observerFor(region: ParentNode): FakeObserver {
  const found = liveObserverFor(region)
  if (found === undefined) throw new Error('no live IntersectionObserver for this region')
  return found
}

/** Deliver one intersection to the region's sentinel, as the browser would. */
function intersect(region: ParentNode): void {
  const observer = observerFor(region)
  act(() => {
    observer.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      observer as unknown as IntersectionObserver,
    )
  })
}

function scrollRootFor(region: ParentNode): HTMLElement {
  const observer = observerFor(region)
  const root = observer.options?.root
  if (root === null || root === undefined) throw new Error('observer has no element root')
  return root as HTMLElement
}

/** The tab plus the REAL window host it opens windows into. */
function workbenchTree(fx: Fixture, visible: boolean, sessionId = 's1'): ReturnType<typeof createElement> {
  const service = (fx.ctx as { get(name: string): { clues: FormatRendererRegistry } }).get('betterSidebar')
  return createElement(Fragment, null,
    createElement(WindowHost, { host: fx.host, formats: service.clues }),
    createElement(CluesTab, {
      ctx: fx.ctx as never,
      store: fx.store,
      scope: { sessionId },
      visible,
    }),
  )
}

function mount(fx: Fixture, visible = true): RenderedRoot {
  return renderRoot(workbenchTree(fx, visible))
}

beforeEach(() => {
  window.localStorage.clear()
  invalidateClueRequests()
  clearClueCollectionDrafts()
  // Help is an automatic modal only on the FIRST visit. Every other case
  // starts as a returning reader; the first-visit case forgets the marker
  // explicitly instead of touching localStorage itself.
  markClueHelpSeen()
})
afterEach(() => {
  invalidateClueRequests()
  vi.unstubAllGlobals()
  clearClueNotice()
  // Dispose through the host so React owns the portal removal; never detach a
  // portal node by hand (React then cannot remove its own child).
  act(() => {
    for (const host of hosts.splice(0)) host.dispose()
  })
  restoreObserver?.()
  restoreObserver = undefined
  fakeObservers = []
})

/** The subset of the fixture API the two pin regressions override per test. */
interface PinApi {
  pinsList: () => Promise<CluesPinsResult>
  pinsAdd: (workspaceId: string, input: Record<string, unknown>) => Promise<CluesPinsResult>
  pinsRemove: (workspaceId: string, input: Record<string, unknown>) => Promise<CluesPinsResult>
  clues: () => Promise<{
    clues: readonly { id: string; sourceId: string; typeId: string; title: string; locator: unknown }[]
    revision: number
  }>
  ensure: (workspaceId: string, input: Record<string, unknown>) => Promise<{ clue: { id: string }; created: boolean }>
}

/** Reach the live clue API of one fixture (the browser calls it at click time). */
function pinApiOf(fx: Fixture): PinApi {
  const service = (fx.ctx as { get(name: string): unknown }).get('betterSidebar') as { clues: { api: PinApi } }
  return service.clues.api
}

// ── tests ───────────────────────────────────────────────────────────────────

describe('clue tab main page', () => {
  it('renders source identity icons and the built-in files label in Chinese', async () => {
    const previousLanguage = navigator.language
    Object.defineProperty(navigator, 'language', { value: 'zh-CN', configurable: true })
    const fx = fixture({ workspaceId: 'ws-1' })
    const view = mount(fx)
    try {
      await flush()
      const nav = view.container.querySelector<HTMLElement>('[data-clue-source-navigation]')!
      const tabs = [...nav.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      expect(tabs[0]?.textContent).toContain('本地文件')
      expect(nav.textContent).not.toContain('Local files')
      expect(tabs).toHaveLength(2)
      expect(tabs.every(tab => tab.querySelector('[aria-hidden="true"]') !== null)).toBe(true)
    } finally {
      view.unmount()
      Object.defineProperty(navigator, 'language', { value: previousLanguage, configurable: true })
    }
  })

  it('defaults to resources and reads only the visible mounted view', async () => {
    const fx = fixture({ workspaceId: 'ws-1' })
    const view = mount(fx)
    await flush()
    const packs = view.container.querySelector<HTMLElement>('[data-clue-pack-region]')!
    const browser = view.container.querySelector<HTMLElement>('[data-clue-browse-region]')!
    expect(sectionOf(view.container, t('clueViewPacks'))?.getAttribute('data-open')).toBe('false')
    expect(sectionOf(view.container, t('clueViewBrowse'))?.getAttribute('data-open')).toBe('true')
    expect(fx.calls.packsList).toBe(0)
    expect(fx.calls.list).toBe(1)
    expect(browser.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    const query = browser.querySelector('input[aria-label="Keyword, resource link or file path"]')!
    await showView(view.container, 'packs')
    expect(sectionOf(view.container, t('clueViewPacks'))?.getAttribute('data-open')).toBe('true')
    expect(sectionOf(view.container, t('clueViewBrowse'))?.getAttribute('data-open')).toBe('false')
    expect(fx.calls.packsList).toBe(1)
    expect(fx.calls.list).toBe(1)
    expect(packs.textContent).toContain('Release clues')
    await showView(view.container, 'browse')
    expect(browser.querySelector('input[aria-label="Keyword, resource link or file path"]')).toBe(query)
    expect(fx.calls.packsList).toBe(1)
    expect(fx.calls.list).toBe(1)
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

  it('shows first-visit help, supports the question control and remembers acknowledgment', async () => {
    forgetClueHelpSeen()
    const fx = fixture({ workspaceId: 'ws-1' })
    const view = mount(fx)
    await flush()

    // First visit opens the host dialog; the question control reopens it later.
    const guide = (): HTMLElement | null => document.body.querySelector<HTMLElement>('[data-clue-help]')
    expect(guide()).not.toBeNull()
    const panel = guide()!
    const dialog = panel.closest<HTMLElement>('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog!.getAttribute('aria-modal')).toBe('true')
    expect(dialog!.getAttribute('aria-label')).toBeTruthy()
    expect(dialog!.getAttribute('aria-label')).toBe(t('clueHelpTitle'))
    expect(panel.querySelectorAll('[data-clue-help-step]')).toHaveLength(3)
    // Three steps only: the old pin/binding/share help notes are gone.
    expect(panel.querySelectorAll(
      '[data-clue-help-flow], [data-clue-help-pin], [data-clue-help-binding], [data-clue-help-share]',
    )).toHaveLength(0)
    expect(clueHelpSeen()).toBe(false)

    // The explicit close control stores the marker and returns focus to the
    // header trigger.
    click(document.body, 'Close help')
    await flush()
    expect(guide()).toBeNull()
    expect(clueHelpSeen()).toBe(true)
    const helpTrigger = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.getAttribute('aria-label') === 'Show clues help')!
    expect(document.activeElement).toBe(helpTrigger)

    // The question control reopens the dialog, and Escape closes it.
    click(view.container, 'Show clues help')
    await flush()
    expect(guide()).not.toBeNull()
    act(() => {
      guide()!.closest('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }))
    })
    await flush()
    expect(guide()).toBeNull()
    expect(document.activeElement).toBe(helpTrigger)

    // The browser marker prevents a second automatic appearance after remount.
    view.unmount()
    const reopened = mount(fx)
    await flush()
    expect(reopened.container.querySelector('[data-clue-help]')).toBeNull()
    reopened.unmount()
  })

  it('does not mark help seen until the reader closes it', async () => {
    forgetClueHelpSeen()
    const fx = fixture({ workspaceId: 'ws-1' })
    const view = mount(fx)
    await flush()
    expect(document.body.querySelector('[data-clue-help]')).not.toBeNull()
    expect(clueHelpSeen()).toBe(false)
    view.unmount()
    const reopened = mount(fx)
    await flush()
    expect(document.body.querySelector('[data-clue-help]')).not.toBeNull()
    expect(clueHelpSeen()).toBe(false)
    click(document.body, 'Close help')
    await flush()
    expect(reopened.container.querySelector('[data-clue-help]')).toBeNull()
    expect(clueHelpSeen()).toBe(true)
    reopened.unmount()
  })

  it('explains a missing GitHub repository before any list request', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [GITHUB.sourceId] })
    const view = mount(fx)
    await flush()
    expect(view.container.textContent).toContain('No GitHub repository was detected in this workspace. Choose a repository.')
    expect(fx.calls.list).toBe(0)
    // The scope editor is EXPLICIT: no window opens by itself, but the state
    // offers the exact next step.
    expect(floatingContent('[data-clue-scope-window]')).toBeNull()
    expect([...view.container.querySelectorAll('button')]
      .some(button => /^(Choose range|No range chosen yet)/.test(buttonLabel(button))
        || /^Choose range/.test(button.getAttribute('aria-label') ?? ''))).toBe(true)
    view.unmount()
  })

  it('locks the workspace switch while any owned task window is open', async () => {
    const candidate: ClueCandidate = {
      sourceId: FILES.sourceId,
      typeId: 'file',
      clueId: 'c-lock',
      title: 'Locked note',
      locator: { path: 'locked.md' },
    }
    const fx = fixture({
      workspaceId: 'ws-1',
      secondWorkspaceId: 'ws-2',
      enabled: [FILES.sourceId],
      listItems: [candidate],
    })
    const view = mount(fx)
    await flush()
    const browser = view.container.querySelector<HTMLElement>('[data-clue-browse-region]')!
    const selectOf = (): HTMLButtonElement => view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Switch browse workspace"]',
    )!
    expect(selectOf()).not.toBeNull()
    expect(selectOf().disabled).toBe(false)

    // Browser task: scope window locks the selector.
    openScopeWindow(browser)
    await flush()
    expect(requiredContent('[data-clue-scope-window]')).not.toBeNull()
    expect(selectOf().disabled).toBe(true)
    closeFloatingWindow('[data-clue-scope-window]')
    await flush()
    expect(selectOf().disabled).toBe(false)

    // The collection window is host-owned and captures its workspace + target
    // set, so it does NOT lock the tab's workspace switch and keeps its draft
    // even after the session changes underneath.
    selectResults(view.container)
    openCollectionWindow(view.container)
    await flush()
    const collectionForm = requiredContent('[data-clue-collection]')
    const collection = collectionWindow()
    const name = startNewPack(collection)
    typeInto(name, 'Owner-safe draft')
    expect(selectOf().disabled).toBe(false)
    view.rerender(workbenchTree(fx, true, 's2'))
    await flush()
    expect(requiredContent('[data-clue-collection]')).toBe(collectionForm)
    expect(collection.querySelector('input[aria-label="Pack name"]')).toBe(name)
    expect(name.value).toBe('Owner-safe draft')
    expect(view.container.querySelector<HTMLButtonElement>('button[aria-label="Switch browse workspace"]')?.textContent).toContain('/other')
    closeFloatingWindow('[data-clue-collection]')
    await flush()

    // Pack task: create-pack window uses the same OR lock and releases on close.
    const packs = view.container.querySelector<HTMLElement>('[data-clue-pack-region]')!
    await showView(view.container, 'packs')
    click(packs, 'New')
    await flush()
    expect(document.querySelector('input[aria-label="Pack name"]')).not.toBeNull()
    expect(selectOf().disabled).toBe(true)
    const createFrame = document.querySelector<HTMLInputElement>('input[aria-label="Pack name"]')!
      .closest<HTMLElement>('[data-floating-window]')!
    click(createFrame, 'Close')
    await flush()
    expect(selectOf().disabled).toBe(false)
    view.unmount()
  })

  it('performs no query while the tab body is hidden', async () => {
    const fx = fixture({ workspaceId: 'ws-1' })
    const view = mount(fx, false)
    await flush()
    expect(fx.calls.list).toBe(0)
    expect(fx.calls.packsList).toBe(0)
    expect(fx.calls.search).toBe(0)
    view.unmount()
  })
})

// ── browser interactions ────────────────────────────────────────────────────

/** Ignore decorative glyphs when matching visible button labels. */
function buttonLabel(button: HTMLButtonElement): string {
  const content = button.cloneNode(true) as HTMLButtonElement
  for (const hidden of content.querySelectorAll('[aria-hidden="true"]')) hidden.remove()
  return (content.textContent ?? '').trim()
}

/** Click one button by its trimmed text or accessible name. */
function click(container: ParentNode, label: string): void {
  const button = [...container.querySelectorAll('button')]
    .find(candidate => buttonLabel(candidate) === label || candidate.getAttribute('aria-label') === label)
  if (button === undefined) throw new Error(`button "${label}" not found`)
  act(() => { button.focus(); button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

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
    .find(candidate => buttonLabel(candidate) === text || candidate.getAttribute('aria-label') === text)
  if (button === undefined) throw new Error(`button "${text}" not found`)
  act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

/** Click the first button whose text OR accessible name matches a pattern. */
function clickMatching(container: ParentNode, pattern: RegExp): void {
  const button = [...container.querySelectorAll('button')]
    .find(candidate => pattern.test(buttonLabel(candidate))
      || pattern.test(candidate.getAttribute('aria-label') ?? ''))
  if (button === undefined) throw new Error(`button matching ${String(pattern)} not found`)
  act(() => { button.focus(); button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

/** The content the production HostedWindow portaled into a real floating frame. */
function floatingContent(marker: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(marker)
}

/** Require one portal marker (fails with the marker name in the message). */
function requiredContent(marker: string): HTMLElement {
  const content = floatingContent(marker)
  if (content === null) throw new Error(`floating content ${marker} not found`)
  return content
}

/** The scope editor window's content. */
function scopeWindow(): HTMLElement {
  return requiredContent('[data-clue-scope-window]')
}

/** The selection/collection window's content (count line + destination form). */
function collectionWindow(): HTMLElement {
  const form = requiredContent('[data-clue-collection]')
  // The selection count is a sibling of the form inside the window body; the
  // marker sits on the form so close/query helpers stay specific.
  return form.parentElement ?? form
}

/** The floating frame that owns a marker (for its title-bar Close control). */
function floatingFrameOf(marker: string): HTMLElement {
  const content = floatingContent(marker)
  const frame = content?.closest<HTMLElement>('[data-floating-window]')
  if (frame === null || frame === undefined) throw new Error(`no floating frame for ${marker}`)
  return frame
}

/** Close one real floating window through its title-bar control. */
function closeFloatingWindow(marker: string): void {
  click(floatingFrameOf(marker), 'Close')
}

/** Open the scope window from the browser header or the needs-scope state. */
function openScopeWindow(container: ParentNode): void {
  clickMatching(container, /^(Choose range|No range chosen yet)/)
}

/** Open the collection window from the main compact selection action bar. */
function openCollectionWindow(container: ParentNode): void {
  click(container, 'Add to pack')
}

/** The workbench section whose header carries `title`. */
function workbenchSection(container: ParentNode, title: string): HTMLElement {
  const section = [...container.querySelectorAll<HTMLElement>('[data-workbench-section]')]
    .find(candidate => candidate.querySelector('h3')?.textContent?.includes(title) === true)
  if (section === undefined) throw new Error(`workbench section "${title}" not found`)
  return section
}

/** Toggle one WorkbenchSection through its disclosure button. */
function toggleSection(section: HTMLElement): void {
  const toggle = section.querySelector<HTMLButtonElement>('h3 button')!
  act(() => { toggle.focus(); toggle.click() })
}

describe('clue tab source browser', () => {
  it('persists an explicit GitHub range per workspace and lists with it', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [GITHUB.sourceId] })
    const view = mount(fx)
    await flush()
    expect(fx.calls.list).toBe(0)
    expect(floatingContent('[data-clue-scope-window]')).toBeNull()

    openScopeWindow(view.container)
    await flush()
    const scope = scopeWindow()
    // The draft lives in a REAL floating window (outside the tab container).
    expect(view.container.contains(scope)).toBe(false)
    expect(scope.closest('[data-floating-window]')).not.toBeNull()
    const states = scope.querySelector('fieldset')!
    expect([...states.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map(input => input.value)).toEqual(['open', 'closed', 'all'])
    expect(states.querySelector('select')).toBeNull()
    const repoInput = scope.querySelector<HTMLInputElement>('input[placeholder="owner/repo or repository URL"]')!
    typeInto(repoInput, 'acme/widgets')
    click(scope, 'Save range')
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

  it('applies a detected GitHub repository without persisting it and lists with no scope', async () => {
    const fx = fixture({
      workspaceId: 'ws-1',
      enabled: [GITHUB.sourceId],
      defaultScopeResponse: { scope: { repo: 'acme/widgets', state: 'open' } },
    })
    const view = mount(fx)
    await flush()
    expect(fx.calls.defaultScope).toBe(1)
    expect(fx.defaultScopeParams[0]).toMatchObject({ sourceId: GITHUB.sourceId })
    expect(fx.calls.list).toBe(1)
    // The client only sends a user-confirmed range. The detected default is
    // display-only: every list call lets the SERVICE re-resolve the latest
    // repository, so no stale scope can be cached or persisted.
    expect(fx.listParams[0]).toMatchObject({ sourceId: GITHUB.sourceId })
    expect(fx.listParams[0]).not.toHaveProperty('scope')
    expect(view.container.textContent).toContain('acme/widgets')
    expect((fx.store.getPrefs().pluginSettings.clues as { scopes?: unknown } | undefined)?.scopes)
      .toBeUndefined()
    const browser = view.container.querySelector<HTMLElement>('[data-clue-browse-region]')!
    click(browser, 'Refresh')
    await flush()
    expect(fx.calls.list).toBe(2)
    expect(fx.listParams.at(-1)).not.toHaveProperty('scope')
    view.unmount()
  })

  it('prefers an explicit GitHub range and never asks for a default', async () => {
    const fx = fixture({
      workspaceId: 'ws-1',
      enabled: [GITHUB.sourceId],
      defaultScopeResponse: { scope: { repo: 'auto/detected', state: 'open' } },
    })
    fx.store.setPrefs({
      ...fx.store.getPrefs(),
      pluginSettings: { clues: { scopes: { 'ws-1': {
        [GITHUB.sourceId]: { repo: 'explicit/range', state: 'closed' },
      } } } },
    })
    const view = mount(fx)
    await flush()
    expect(fx.calls.defaultScope).toBe(0)
    expect(fx.calls.list).toBe(1)
    expect(fx.listParams[0]).toMatchObject({
      sourceId: GITHUB.sourceId,
      scope: { repo: 'explicit/range', state: 'closed' },
    })
    const text = view.container.textContent ?? ''
    expect(text).toContain('explicit/range')
    expect(text).not.toContain('auto/detected')
    view.unmount()
  })

  it('aborts the pending automatic range lookup when the tab is hidden', async () => {
    let release!: (value: ClueDefaultScopeResult) => void
    let signal: AbortSignal | undefined
    const fx = fixture({
      workspaceId: 'ws-1',
      enabled: [GITHUB.sourceId],
      defaultScope: (_workspaceId, _input, pending) => {
        signal = pending
        return new Promise<ClueDefaultScopeResult>(resolve => { release = resolve })
      },
    })
    const view = mount(fx)
    await flush()
    expect(signal?.aborted).toBe(false)
    expect(fx.calls.list).toBe(0)
    setVisible(view, fx, false)
    await flush()
    expect(signal?.aborted).toBe(true)
    release({ reason: 'no-github-remote' })
    await flush()
    expect(fx.calls.list).toBe(0)
    // Visible again starts a fresh lookup; a no-remote answer still blocks LIST.
    setVisible(view, fx, true)
    await flush()
    expect(fx.calls.defaultScope).toBe(2)
    expect(fx.calls.list).toBe(0)
    view.unmount()
  })

  it('shows Feishu range kinds as native radio choices and saves the chosen wiki range', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FEISHU_DOCS.sourceId] })
    const view = mount(fx)
    await flush()
    // The default Drive root lists once on its own (the client sends no scope;
    // the service resolves the default fresh for this call).
    expect(fx.calls.list).toBe(1)
    expect(fx.listParams[0]).toMatchObject({ sourceId: FEISHU_DOCS.sourceId })
    expect(fx.listParams[0]).not.toHaveProperty('scope')

    openScopeWindow(view.container)
    await flush()
    const scope = scopeWindow()
    const choices = scope.querySelector('fieldset')!
    expect([...choices.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map(input => input.value))
      .toEqual(['drive-root', 'drive', 'wiki', 'wiki-spaces'])
    expect(choices.querySelector('select')).toBeNull()
    expect(choices.textContent).toContain('My Drive root')
    expect(choices.textContent).toContain('A wiki space')
    choose(choices, 'wiki')
    const space = scope.querySelector<HTMLInputElement>('input[placeholder="space id (my_library = personal library)"]')!
    typeInto(space, 'space-42')
    click(scope, 'Save range')
    await flush()
    expect(fx.calls.list).toBe(2)
    expect(fx.listParams.at(-1)).toMatchObject({ sourceId: FEISHU_DOCS.sourceId, scope: { kind: 'wiki', spaceId: 'space-42' } })
    view.unmount()
  })

  it('merges a later pack-window range with the newer range the tab just chose', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId, GITHUB.sourceId] })
    fx.store.setPrefs({
      ...fx.store.getPrefs(),
      pluginSettings: { clues: { scopes: { 'ws-1': { [FILES.sourceId]: { path: 'old' } } } } },
    })
    const view = mount(fx)
    await flush()

    // The pack window opens in the REAL host; its callback stays alive for the
    // whole lifetime of the floating surface.
    await showView(view.container, 'packs')
    press(view.container, 'Manage pack: Release clues')
    await flush()
    const packWindow = requiredContent('[data-clue-pack-window]')
    expect(packWindow.closest('[data-floating-window]')).not.toBeNull()

    await showView(view.container, 'browse')
    // The tab then writes a NEW files path through the same document.
    press(view.container, 'Choose range: old')
    await flush()
    const scope = scopeWindow()
    const pathInput = scope.querySelector<HTMLInputElement>('input[placeholder="e.g. docs/"]')!
    typeInto(pathInput, 'new')
    click(scope, 'Save range')
    await flush()
    const afterTab = fx.store.getPrefs().pluginSettings.clues as {
      scopes?: Record<string, Record<string, unknown>>
    }
    expect(afterTab.scopes?.['ws-1']?.[FILES.sourceId]).toEqual({ path: 'new' })

    // The still-open pack window saves a DIFFERENT source's range through
    // its own add page. Its older snapshot must not roll the files path back.
    click(packWindow, 'Add members')
    await flush()
    chooseSource(packWindow, GITHUB.sourceId)
    await flush()
    click(packWindow, 'Choose range')
    await flush()
    const repoInput = packWindow.querySelector<HTMLInputElement>('input[placeholder="owner/repo or repository URL"]')!
    typeInto(repoInput, 'acme/widgets')
    click(packWindow, 'Save range')
    await flush()
    const merged = fx.store.getPrefs().pluginSettings.clues as {
      scopes?: Record<string, Record<string, unknown>>
    }
    expect(merged.scopes?.['ws-1']?.[FILES.sourceId]).toEqual({ path: 'new' })
    expect(merged.scopes?.['ws-1']?.[GITHUB.sourceId]).toEqual({ repo: 'acme/widgets', state: 'open' })
    view.unmount()
  })

  it('persists a cleared files range as an explicit tombstone and reads it as no range', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId] })
    fx.store.setPrefs({
      ...fx.store.getPrefs(),
      pluginSettings: { clues: { scopes: { 'ws-1': { [FILES.sourceId]: { path: 'docs' } } } } },
    })
    const view = mount(fx)
    await flush()
    expect(fx.listParams[0]).toMatchObject({ sourceId: FILES.sourceId, scope: { path: 'docs' } })

    press(view.container, 'Choose range: docs')
    await flush()
    const scope = scopeWindow()
    const pathInput = scope.querySelector<HTMLInputElement>('input[placeholder="e.g. docs/"]')!
    expect(pathInput.value).toBe('docs')
    typeInto(pathInput, '')
    click(scope, 'Save range')
    await flush()

    const saved = fx.store.getPrefs().pluginSettings.clues as {
      scopes?: Record<string, Record<string, unknown>>
    }
    // Explicit tombstone: omitting the key would let the host's deep settings
    // merge keep the old `docs` path alive.
    expect(saved.scopes?.['ws-1']?.[FILES.sourceId]).toBeNull()
    // No explicit range is sent; the UI names the actual default directory.
    expect(fx.listParams.at(-1)).not.toHaveProperty('scope')
    expect(view.container.textContent).toContain('Workspace root')
    view.unmount()
  })

  it('searches the active source with the typed keyword', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId] })
    const view = mount(fx)
    await flush()
    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!
    typeInto(input, 'release notes')
    press(view.container, 'Search')
    await flush()
    expect(fx.calls.search).toBe(1)
    expect(fx.searchParams[0]).toMatchObject({ sourceId: FILES.sourceId, query: 'release notes' })
    view.unmount()
  })

  it('keeps submit and conditional clear inside the same query frame through search and reset', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId] })
    const view = mount(fx)
    await flush()
    const input = browserQueryInput(view.container)
    const frame = input.closest<HTMLElement>('[role="search"]')!
    const submit = frame.querySelector<HTMLButtonElement>('button')!
    expect(frame.classList.contains(clueTabCss.searchField!)).toBe(true)
    expect(submit.classList.contains(clueTabCss.querySubmit!)).toBe(true)
    expect(submit.closest('[role="search"]')).toBe(frame)
    expect(frame.querySelectorAll('button')).toHaveLength(1)
    typeInto(input, 'release notes')
    const clear = frame.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!
    expect(clear.classList.contains(clueTabCss.clearSearch!)).toBe(true)
    expect(clear.closest('[role="search"]')).toBe(frame)
    click(frame, 'Search')
    await flush()
    expect(fx.searchParams.at(-1)).toMatchObject({ query: 'release notes' })
    expect(input.closest('[role="search"]')).toBe(frame)
    click(frame, 'Clear search')
    await flush()
    expect(input.value).toBe('')
    expect(input.closest('[role="search"]')).toBe(frame)
    expect(frame.querySelectorAll('button')).toHaveLength(1)
    expect(frame.querySelector('button')).toBe(submit)
    expect(document.activeElement).toBe(input)
    view.unmount()
  })

  it('refreshes the active search without clearing query; Clear search restores listing', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId],
      searchResponse: async () => ({ items: selectionFiles }),
    })
    const view = mount(fx)
    await flush()
    const browser = view.container.querySelector<HTMLElement>('[data-clue-browse-region]')!
    const input = browser.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!
    typeInto(input, 'release notes')
    click(browser, 'Search')
    await flush()
    const before = { ...fx.calls }
    click(browser, 'Refresh')
    await flush()
    expect(input.value).toBe('release notes')
    expect(fx.calls.search).toBe(before.search + 1)
    expect(fx.calls.list).toBe(before.list)
    // No page cursor survives a search: the refresh replays the query itself.
    expect(fx.searchParams.at(-1)).toMatchObject({ query: 'release notes' })
    expect(fx.searchParams.at(-1)).not.toHaveProperty('cursor')
    expect(browser.querySelector('[data-clue-result-pagination]')).toBeNull()
    click(browser, 'Clear search')
    await flush()
    expect(input.value).toBe('')
    expect(fx.calls.list).toBe(before.list + 1)
    expect(fx.listParams.at(-1)).not.toHaveProperty('cursor')
    view.unmount()
  })

  it('appends the next page at the sentinel without dropping rows or focus', async () => {
    installIntersectionObserver()
    const firstPage: ClueCandidate[] = Array.from({ length: 25 }, (_, index) => ({
      sourceId: FILES.sourceId,
      typeId: 'file',
      title: `Note ${index + 1}`,
      locator: { path: `note-${index + 1}.md` },
    }))
    const secondPage: ClueCandidate[] = Array.from({ length: 5 }, (_, index) => ({
      sourceId: FILES.sourceId,
      typeId: 'file',
      title: `Later ${index + 1}`,
      locator: { path: `later-${index + 1}.md` },
    }))
    let resolveAppend: ((result: ClueListResult) => void) | undefined
    let appendRequests = 0
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId],
      listResponse: (_signal, input) => {
        if (input.cursor === 'page-two') {
          appendRequests += 1
          return new Promise<ClueListResult>(resolve => { resolveAppend = resolve })
        }
        return Promise.resolve({ items: firstPage, nextCursor: 'page-two' })
      },
    })
    const view = mount(fx)
    await flush()
    const browser = view.container.querySelector<HTMLElement>('[data-clue-browse-region]')!
    expect(browser.querySelectorAll('[data-clue-browser-state="page"] li')).toHaveLength(25)
    expect(browser.querySelector('[data-clue-result-pagination]')).toBeNull()

    const focusTarget = browser.querySelector<HTMLButtonElement>('button[aria-label="Insert Note 1"]')!
    act(() => { focusTarget.focus() })
    intersect(browser)
    await flush()
    expect(appendRequests).toBe(1)
    // `state.page` keeps the first page mounted while the next one is in flight:
    // no loading screen, no lost row nodes, no stolen focus.
    expect(browser.querySelectorAll('[data-clue-browser-state="page"] li')).toHaveLength(25)
    expect(browser.querySelector<HTMLButtonElement>('button[aria-label="Insert Note 1"]')).toBe(focusTarget)
    expect(document.activeElement).toBe(focusTarget)

    resolveAppend!({ items: secondPage })
    await flush()
    expect(browser.querySelectorAll('[data-clue-browser-state="page"] li')).toHaveLength(30)
    expect(browser.textContent).toContain('Later 1')
    expect(document.activeElement).toBe(focusTarget)
    expect(fx.listParams.at(-1)).toMatchObject({ cursor: 'page-two' })
    // The last page has no next cursor, so the observer is torn down.
    expect(liveObserverFor(browser)).toBeUndefined()
    expect(browser.querySelector('[data-clue-result-pagination]')).toBeNull()
    view.unmount()
  })

  it('ignores repeated sentinel triggers while an append is already in flight', async () => {
    installIntersectionObserver()
    let resolveAppend: ((result: ClueListResult) => void) | undefined
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId],
      listResponse: (_signal, input) => {
        if (input.cursor === 'page-two') {
          return new Promise<ClueListResult>(resolve => { resolveAppend = resolve })
        }
        return Promise.resolve({ items: selectionFiles, nextCursor: 'page-two' })
      },
    })
    const view = mount(fx)
    await flush()
    const browser = view.container.querySelector<HTMLElement>('[data-clue-browse-region]')!
    intersect(browser)
    await flush()
    expect(fx.calls.list).toBe(2)
    // A second intersection/scroll in the same in-flight window is a no-op.
    intersect(browser)
    await act(async () => { scrollRootFor(browser).dispatchEvent(new Event('scroll')) })
    await flush()
    expect(fx.calls.list).toBe(2)
    resolveAppend!({ items: [selectionFiles[0]!] })
    await flush()
    expect(fx.calls.list).toBe(2)
    expect(browser.querySelectorAll('[data-clue-browser-state="page"] li')).toHaveLength(3)
    view.unmount()
  })

  it('keeps rows and offers a manual Retry after an append failure; no automatic retry', async () => {
    installIntersectionObserver()
    let failing = true
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId],
      listResponse: async (_signal, input) => {
        if (input.cursor === 'page-two') {
          if (failing) throw new Error('append failed')
          return { items: [{ sourceId: FILES.sourceId, typeId: 'file', title: 'Recovered note', locator: { path: 'recovered.md' } }] }
        }
        return { items: selectionFiles, nextCursor: 'page-two' }
      },
    })
    const view = mount(fx)
    await flush()
    const browser = view.container.querySelector<HTMLElement>('[data-clue-browse-region]')!
    const scrollRoot = scrollRootFor(browser)
    intersect(browser)
    await flush()
    // The first page is still there, and the failure is a footer state — not a
    // full-pane error that would throw away what the reader was reading.
    expect(browser.querySelectorAll('[data-clue-browser-state="page"] li')).toHaveLength(3)
    expect(browser.textContent).toContain('Failed to load')
    expect([...browser.querySelectorAll('button')].some(button => buttonLabel(button) === 'Retry')).toBe(true)
    // `hasMore` is false while the failure stands: neither a sentinel callback
    // nor a scroll may spend another request automatically.
    expect(liveObserverFor(browser)).toBeUndefined()
    const callsAfterFailure = { ...fx.calls }
    act(() => { scrollRoot.dispatchEvent(new Event('scroll')) })
    await flush()
    expect(fx.calls).toEqual(callsAfterFailure)

    failing = false
    click(browser, 'Retry')
    await flush()
    expect(fx.calls.list).toBe(callsAfterFailure.list + 1)
    expect(browser.querySelectorAll('[data-clue-browser-state="page"] li')).toHaveLength(4)
    view.unmount()
  })

  it('stops when the first page has no next cursor', async () => {
    installIntersectionObserver()
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId], listItems: selectionFiles })
    const view = mount(fx)
    await flush()
    const browser = view.container.querySelector<HTMLElement>('[data-clue-browse-region]')!
    expect(browser.querySelectorAll('[data-clue-browser-state="page"] li')).toHaveLength(3)
    expect(liveObserverFor(browser)).toBeUndefined()
    const callsBefore = { ...fx.calls }
    const resultArea = browser.querySelector<HTMLElement>('[data-clue-browser-state]')!
    act(() => { resultArea.dispatchEvent(new Event('scroll')) })
    await flush()
    expect(fx.calls).toEqual(callsBefore)
    expect(browser.querySelector('[data-clue-result-pagination]')).toBeNull()
    view.unmount()
  })

  it('aborts an in-flight append when the source changes, and the old rows never land', async () => {
    installIntersectionObserver()
    let resolveAppend: ((result: ClueListResult) => void) | undefined
    let appendSignal: AbortSignal | undefined
    const issue: ClueCandidate = {
      sourceId: GITHUB.sourceId, typeId: 'issue', clueId: 'c-issue', title: 'A GitHub issue', locator: { number: 7 },
    }
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId, GITHUB.sourceId],
      listResponse: (signal, input) => {
        if (input.sourceId === GITHUB.sourceId) return Promise.resolve({ items: [issue] })
        if (input.cursor === 'page-two') {
          appendSignal = signal
          return new Promise<ClueListResult>(resolve => { resolveAppend = resolve })
        }
        return Promise.resolve({ items: selectionFiles, nextCursor: 'page-two' })
      },
    })
    fx.store.setPrefs({ ...fx.store.getPrefs(), pluginSettings: { clues: { scopes: { 'ws-1': {
      [GITHUB.sourceId]: { repo: 'acme/widgets', state: 'open' },
    } } } } })
    const view = mount(fx)
    await flush()
    const browser = view.container.querySelector<HTMLElement>('[data-clue-browse-region]')!
    intersect(browser)
    await flush()
    expect(appendSignal?.aborted).toBe(false)

    const beforeSwitch = { ...fx.calls }
    chooseSource(browser, GITHUB.sourceId)
    await flush()
    expect(appendSignal?.aborted).toBe(true)
    expect(fx.calls.list).toBe(beforeSwitch.list + 1)
    const switchList = fx.listParams.at(-1)!
    expect(switchList).toMatchObject({ sourceId: GITHUB.sourceId })
    expect(switchList).not.toHaveProperty('cursor')

    // The aborted page arrives late; it must not be merged into GitHub's rows.
    act(() => { resolveAppend!({ items: [selectionFiles[2]!] }) })
    await flush()
    expect(browser.textContent).toContain('A GitHub issue')
    expect(browser.textContent).not.toContain('Third note')
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
    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!
    typeInto(input, 'https://github.com/acme/widgets/issues/7')
    press(view.container, 'Resolve')
    await flush()
    expect(fx.calls.resolve).toBe(1)
    expect(fx.resolveParams[0]).toMatchObject({ text: 'https://github.com/acme/widgets/issues/7' })
    expect(view.container.textContent).toContain('Fix the widget')
    expect(view.container.querySelector('button[aria-label="Insert Fix the widget"]')).not.toBeNull()
    press(view.container, 'Insert Fix the widget')
    await flush()
    expect(fx.inserted).toHaveLength(1)
    expect(fx.inserted[0]).toMatchObject({
      reference: { source: 'better-sidebar:clues', clipboardText: '[[dsh-clue:c9]]', appearance: 'file' },
    })
    view.unmount()
  })

  it('resolves a complete GitHub URL before any explicit range is chosen', async () => {
    const candidate: ClueCandidate = {
      sourceId: GITHUB.sourceId,
      typeId: 'builtin.github.issue',
      locator: { host: 'github.com', owner: 'acme', repo: 'widgets', kind: 'issue', number: 7 },
      title: 'Fix the widget',
    }
    const fx = fixture({ workspaceId: 'ws-1', enabled: [GITHUB.sourceId], resolveCandidates: [candidate] })
    const view = mount(fx)
    await flush()
    expect(view.container.textContent).toContain('No GitHub repository was detected in this workspace. Choose a repository.')
    expect(fx.calls.list).toBe(0)

    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!
    typeInto(input, 'https://github.com/acme/widgets/issues/7')
    press(view.container, 'Resolve')
    await flush()

    // The direct resolve is independent of the browse range: it must run even
    // though this GitHub source still has no explicit repository range.
    expect(fx.calls.resolve).toBe(1)
    expect(fx.resolveParams[0]).toMatchObject({ text: 'https://github.com/acme/widgets/issues/7' })
    expect(fx.calls.list).toBe(0)
    expect(view.container.textContent).toContain('Fix the widget')
    expect(view.container.querySelector('[data-clue-browser-state]')?.getAttribute('data-clue-browser-state')).toBe('resolved')
    view.unmount()
  })

  it('requires a concrete Feishu folder/wiki before searching a browse-only range', async () => {
    const item: ClueCandidate = {
      sourceId: FEISHU_DOCS.sourceId,
      typeId: 'builtin.feishu.docs',
      locator: { kind: 'docx', docToken: 'doc-1' },
      title: 'Design doc',
    }
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FEISHU_DOCS.sourceId], listItems: [item] })
    const scopeFor = (scope: Record<string, unknown>) => ({
      ...fx.store.getPrefs(),
      pluginSettings: { clues: { scopes: { 'ws-1': { [FEISHU_DOCS.sourceId]: scope } } } },
    })
    fx.store.setPrefs(scopeFor({ kind: 'drive-root' }))
    const view = mount(fx)
    await flush()
    // The browse-only root is a valid LIST range...
    expect(fx.calls.list).toBeGreaterThan(0)

    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!
    typeInto(input, 'design')
    press(view.container, 'Search')
    await flush()
    // ...but not a searchable one: no request goes out with the browse range.
    expect(fx.calls.search).toBe(0)
    expect(view.container.textContent).toContain('Choose a specific folder or wiki space before searching.')

    // Choosing a concrete folder makes the same search run with that scope.
    act(() => { fx.store.setPrefs(scopeFor({ kind: 'drive', folderToken: 'fld-1' })) })
    await flush()
    expect(fx.calls.search).toBe(1)
    expect(fx.searchParams[0]).toMatchObject({
      sourceId: FEISHU_DOCS.sourceId,
      query: 'design',
      scope: { kind: 'drive', folderToken: 'fld-1' },
    })
    view.unmount()
  })

  it('searches Feishu docs account-wide when a keyword is given without a range', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FEISHU_DOCS.sourceId] })
    const view = mount(fx)
    await flush()
    // The default Drive root lists once; account-wide SEARCH stays scope-free
    // because a browse-only root cannot search "everything".
    expect(fx.calls.list).toBe(1)
    expect(fx.listParams[0]).not.toHaveProperty('scope')

    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!
    typeInto(input, 'design')
    press(view.container, 'Search')
    await flush()
    expect(fx.calls.search).toBe(1)
    expect(fx.searchParams[0]).toMatchObject({ sourceId: FEISHU_DOCS.sourceId, query: 'design' })
    expect(fx.searchParams[0]).not.toHaveProperty('scope')
    // The account-wide range is stated explicitly, never implied silently.
    expect(view.container.querySelector('[data-clue-global-search]')?.textContent)
      .toContain('searching all documents visible to this account')
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
    expect(candidateRow(view.container, 'A note').getAttribute('data-pinned')).toBe('false')
    await rowAction(view.container, 'A note', t('clueBrowserPin'))
    await flush()
    expect(fx.pinned).toEqual(['c9'])
    view.unmount()
  })

  it('re-lists the pin revision after ensure so pins.add cannot spend the stale one', async () => {
    const candidate: ClueCandidate = {
      sourceId: FILES.sourceId,
      typeId: 'builtin.files.markdown',
      locator: { path: 'docs/a.md' },
      title: 'A note',
    }
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId], listItems: [candidate] })
    const api = pinApiOf(fx)
    let revision = 18
    let pins: CluesPinsResult['pins'] = []
    const events: string[] = []
    const addInputs: Record<string, unknown>[] = []
    api.pinsList = async () => {
      events.push(`list:${revision}`)
      return { pins, revision }
    }
    api.ensure = async () => {
      events.push('ensure')
      // ensure itself commits and advances the workspace revision.
      revision = 19
      return { clue: { id: 'c9' }, created: true }
    }
    api.pinsAdd = async (_workspaceId, input) => {
      addInputs.push(input)
      events.push(`add:${String(input.expectedRevision)}`)
      pins = [{ workspaceId: 'ws-1', clueId: String(input.clueId), createdAt: '' }]
      revision = 20
      return { pins, revision }
    }
    const view = mount(fx)
    await flush()
    await rowAction(view.container, 'A note', t('clueBrowserPin'))
    await flush()
    expect(addInputs).toHaveLength(1)
    // The mount read revision 18; ensure moved it to 19. Spending 18 would
    // return 409, so the add must carry the freshly re-listed 19.
    expect(addInputs[0]).toMatchObject({ clueId: 'c9', expectedRevision: 19 })
    expect(events.indexOf('list:19')).toBeGreaterThan(events.indexOf('ensure'))
    expect(events.indexOf('add:19')).toBeGreaterThan(events.indexOf('list:19'))
    view.unmount()
  })

  it('shows Unpin for a pinned library locator even when the list candidate has no clueId', async () => {
    const candidate: ClueCandidate = {
      sourceId: FILES.sourceId,
      typeId: 'builtin.files.markdown',
      locator: { path: 'docs/a.md' },
      title: 'A note',
    }
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId], listItems: [candidate] })
    const api = pinApiOf(fx)
    let revision = 3
    let pins: CluesPinsResult['pins'] = [{ workspaceId: 'ws-1', clueId: 'c9', createdAt: '' }]
    const removeInputs: Record<string, unknown>[] = []
    const addInputs: Record<string, unknown>[] = []
    api.pinsList = async () => ({ pins, revision })
    api.clues = async () => ({
      clues: [{
        id: 'c9',
        sourceId: FILES.sourceId,
        typeId: 'builtin.files.markdown',
        title: 'A note',
        locator: { path: 'docs/a.md' },
      }],
      revision: 1,
    })
    api.ensure = async () => ({ clue: { id: 'c9' }, created: false })
    api.pinsAdd = async (_workspaceId, input) => {
      addInputs.push(input)
      pins = [{ workspaceId: 'ws-1', clueId: String(input.clueId), createdAt: '' }]
      revision += 1
      return { pins, revision }
    }
    api.pinsRemove = async (_workspaceId, input) => {
      removeInputs.push(input)
      pins = []
      revision += 1
      return { pins, revision }
    }
    const view = mount(fx)
    await flush()
    // The list candidate has no clueId; the pinned library locator is the link.
    expect(view.container.querySelector('button[aria-label="Pin A note"]')).toBeNull()
    expect(candidateRow(view.container, 'A note').getAttribute('data-pinned')).toBe('true')
    await rowAction(view.container, 'A note', t('clueBrowserUnpin'))
    await flush()
    expect(removeInputs).toHaveLength(1)
    expect(removeInputs[0]).toMatchObject({ clueId: 'c9' })
    expect(candidateRow(view.container, 'A note').getAttribute('data-pinned')).toBe('false')

    // A fresh ensure -> pin -> unpin cycle keeps the locator-derived row state.
    await rowAction(view.container, 'A note', t('clueBrowserPin'))
    await flush()
    expect(addInputs).toHaveLength(1)
    expect(addInputs[0]).toMatchObject({ clueId: 'c9' })
    expect(candidateRow(view.container, 'A note').getAttribute('data-pinned')).toBe('true')
    await rowAction(view.container, 'A note', t('clueBrowserUnpin'))
    await flush()
    expect(removeInputs).toHaveLength(2)
    expect(removeInputs[1]).toMatchObject({ clueId: 'c9' })
    expect(candidateRow(view.container, 'A note').getAttribute('data-pinned')).toBe('false')
    view.unmount()
  })

  it('renders pinned clues in the same workbench bar and keeps them mounted when collapsed', async () => {
    const candidate: ClueCandidate = {
      sourceId: FILES.sourceId,
      typeId: 'builtin.files.markdown',
      locator: { path: 'docs/a.md' },
      title: 'A note',
    }
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId], listItems: [candidate] })
    const api = pinApiOf(fx)
    api.pinsList = async () => ({ pins: [{ workspaceId: 'ws-1', clueId: 'c9', createdAt: '' }], revision: 1 })
    api.clues = async () => ({
      clues: [{
        id: 'c9',
        sourceId: FILES.sourceId,
        typeId: 'builtin.files.markdown',
        title: 'A note',
        locator: { path: 'docs/a.md' },
      }],
      revision: 1,
    })
    const view = mount(fx)
    await flush()
    const browser = view.container.querySelector<HTMLElement>('[data-clue-browse-region]')!
    const section = workbenchSection(browser, 'Pinned')
    expect(browser.hidden).toBe(false)
    expect(section.querySelector('h3 button')?.getAttribute('aria-expanded')).toBe('true')
    expect(section.textContent).toContain('A note')
    toggleSection(section)
    expect(section.getAttribute('data-open')).toBe('false')
    // Collapsed is hidden, not unmounted: the pinned row stays in the tree.
    expect(section.textContent).toContain('A note')
    toggleSection(section)
    expect(section.getAttribute('data-open')).toBe('true')
    view.unmount()
  })

  it('shows the pack-list failure as an error instead of an empty library', async () => {
    const fx = fixture({ workspaceId: 'ws-1', packsError: true })
    const view = mount(fx)
    await flush()
    await showView(view.container, 'packs')
    const alert = view.container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Failed to load')
    expect([...view.container.querySelectorAll('button')].some(button => (button.textContent ?? '').trim() === 'Retry')).toBe(true)
    expect(view.container.textContent).not.toContain('No clue packs yet')
    view.unmount()
  })

  it('retries the failed search (not a fresh list) from the error state', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId], searchError: true })
    const view = mount(fx)
    await flush()
    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!
    typeInto(input, 'release notes')
    press(view.container, 'Search')
    await flush()
    expect(fx.calls.search).toBe(1)
    const listBefore = fx.calls.list
    press(view.container, 'Retry')
    await flush()
    expect(fx.calls.search).toBe(2)
    expect(fx.calls.list).toBe(listBefore)
    expect(fx.searchParams[1]).toMatchObject({ query: 'release notes' })
    view.unmount()
  })

  it('shows a retryable error instead of pretending the source is empty', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId], listError: true })
    const view = mount(fx)
    await flush()
    const failed = view.container.querySelector<HTMLElement>('[data-clue-browser-state="error"]')
    expect(failed).not.toBeNull()
    expect(failed?.textContent).toContain('Failed to load')
    expect([...failed!.querySelectorAll('button')].some(button => (button.textContent ?? '').trim().toLowerCase() === 'retry')).toBe(true)
    expect(failed?.textContent).not.toContain('Nothing in this range yet')
    expect(view.container.textContent).not.toContain('Nothing in this range yet')
    view.unmount()
  })
})

/** The browser region of a mounted tab. */
function browserRegion(container: ParentNode): HTMLElement {
  const browser = container.querySelector<HTMLElement>('[data-clue-browse-region]')
  if (browser === null) throw new Error('browser region not found')
  return browser
}

/** One deferred list response observed at the fixture seam. */
interface PendingPage {
  readonly signal: AbortSignal | undefined
  resolve(result: ClueListResult): void
  reject(error: unknown): void
}

describe('clue browser loading and precise refresh', () => {
  const firstPage = (): ClueListResult => ({
    items: [{
      sourceId: FILES.sourceId, typeId: 'file', clueId: 'c-a', title: 'First note', locator: { path: 'a.md' },
    }],
  })

  it('shows the first page as a placeholder inside the results, never as a moved search box', async () => {
    const pending: PendingPage[] = []
    const fx = fixture({
      workspaceId: 'ws-1', enabled: [FILES.sourceId],
      listResponse: (signal) => new Promise((resolve, reject) => { pending.push({ signal, resolve, reject }) }),
    })
    const view = mount(fx)
    await flush()
    const browser = browserRegion(view.container)
    const query = browser.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!
    const loading = browser.querySelector<HTMLElement>('[data-clue-browser-state="loading"]')
    expect(loading).not.toBeNull()
    expect(loading?.getAttribute('aria-busy')).toBe('true')
    expect(loading?.querySelector('[data-loading-indicator]')).not.toBeNull()
    // The placeholder lives in the scrollable results, not in the search row.
    expect(loading?.contains(query)).toBe(false)
    expect(query.closest('[data-clue-browser-state]')).toBeNull()

    await act(async () => { pending[0]!.resolve(firstPage()) })
    await flush()
    expect(browser.querySelector('[data-clue-browser-state="page"]')).not.toBeNull()
    expect(browser.querySelector('li')?.textContent).toContain('First note')
    view.unmount()
  })

  it('keeps the current rows, selection and scroll while a manual refresh is pending', async () => {
    const pending: PendingPage[] = []
    const fx = fixture({
      workspaceId: 'ws-1', enabled: [FILES.sourceId],
      listResponse: (signal) => new Promise((resolve, reject) => { pending.push({ signal, resolve, reject }) }),
    })
    const view = mount(fx)
    await flush()
    const browser = browserRegion(view.container)
    await act(async () => { pending[0]!.resolve(firstPage()) })
    await flush()
    const results = browser.querySelector<HTMLElement>('[data-clue-browser-state="page"]')!
    enterSelection(browser)
    const checkbox = browser.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    act(() => { checkbox.click() })
    results.scrollTop = 40
    const query = browser.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!
    query.focus()

    click(browser, 'Refresh')
    await flush()
    expect(pending).toHaveLength(2)
    // The old page stays visible with its selection and scroll position; the
    // refresh indicator replaces neither the list nor the search geometry.
    expect(browser.querySelector('[data-clue-browser-state="loading"]')).toBeNull()
    expect(browser.querySelector('[data-clue-browser-state="page"]')).toBe(results)
    expect(browser.textContent).toContain('First note')
    expect(browser.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true)
    expect(results.scrollTop).toBe(40)
    expect(browser.querySelector('[data-clue-refresh-status="refreshing"]')).not.toBeNull()
    expect(query.value).toBe('')

    await act(async () => {
      pending[1]!.resolve({
        items: [{
          sourceId: FILES.sourceId, typeId: 'file', clueId: 'c-a', title: 'First note (updated)', locator: { path: 'a.md' },
        }],
      })
    })
    await flush()
    expect(browser.textContent).toContain('First note (updated)')
    expect(browser.querySelector('[data-clue-refresh-status="refreshing"]')).toBeNull()
    expect(browser.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true)
    view.unmount()
  })

  it('keeps the old rows and offers Retry in the results when a refresh is denied', async () => {
    const pending: PendingPage[] = []
    const fx = fixture({
      workspaceId: 'ws-1', enabled: [FILES.sourceId],
      listResponse: (signal) => new Promise((resolve, reject) => { pending.push({ signal, resolve, reject }) }),
    })
    const view = mount(fx)
    await flush()
    const browser = browserRegion(view.container)
    await act(async () => { pending[0]!.resolve(firstPage()) })
    await flush()

    click(browser, 'Refresh')
    await flush()
    const denied = Object.assign(new Error('no access'), { code: 'permission-denied' })
    await act(async () => { pending[1]!.reject(denied) })
    await flush()
    expect(browser.textContent).toContain('First note')
    expect(browser.querySelectorAll('li')).toHaveLength(1)
    const error = browser.querySelector<HTMLElement>('[data-clue-refresh-status="error"]')
    expect(error?.getAttribute('role')).toBe('alert')
    expect(error?.textContent).toContain('Insufficient permissions')
    const retry = [...error!.querySelectorAll('button')]
      .find(button => (button.textContent ?? '').trim() === 'Retry')
    expect(retry).toBeDefined()

    act(() => { retry!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    expect(pending).toHaveLength(3)
    await act(async () => { pending[2]!.resolve(firstPage()) })
    await flush()
    expect(browser.querySelector('[data-clue-refresh-status="error"]')).toBeNull()
    expect(browser.textContent).toContain('First note')
    view.unmount()
  })

  it('starts one default-range read and one page read on the first visit even when readiness turns ready', async () => {
    const githubWithNeeds: ClueSourceDescriptor = {
      ...GITHUB,
      dependencyIds: ['github.cli'],
      connectionId: 'github.account',
    }
    const fetch = vi.fn(async (url: string) => {
      const value = url.includes('dependencies.inspect')
        ? {
            dependencies: [{
              dependencyId: 'github.cli', name: 'GitHub CLI', command: 'gh', state: 'ready',
              platform: 'darwin', arch: 'arm64', supported: true, installable: true,
              minimumVersion: '2.0.0', recommendedVersion: '2.0.0',
            }],
          }
        : {
            connections: [{
              connectionId: 'github.account', name: 'GitHub', pluginId: 'test',
              configuration: 'ready', authorization: 'ready', credentialOwner: 'tool',
              capabilities: [], action: 'none',
            }],
          }
      return { ok: true, json: async () => ({ ok: true, value }) } as Response
    })
    vi.stubGlobal('fetch', fetch)
    const fx = fixture({
      workspaceId: 'ws-1', enabled: [GITHUB.sourceId], catalogSources: [githubWithNeeds],
      defaultScopeResponse: { scope: { repo: 'acme/widgets', state: 'open' } },
    })
    const view = mount(fx)
    await flush()
    await flush()
    expect(fx.calls.defaultScope).toBe(1)
    expect(fx.calls.list).toBe(1)
    view.unmount()
  })
})


/** A native tab is retained, not reconstructed, when its visibility changes. */
function setVisible(view: RenderedRoot, fx: Fixture, visible: boolean): void {
  view.rerender(workbenchTree(fx, visible))
}

function choose(group: ParentNode, value: string): void {
  const radio = [...group.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(input => input.value === value)
  if (radio === undefined) throw new Error(`radio "${value}" not found`)
  act(() => { radio.click() })
}

/** The one collection form inside the open task window. */
function collectionForm(container: ParentNode): HTMLFormElement {
  const form = container.querySelector<HTMLFormElement>('[data-clue-collection]')
  if (form === null) throw new Error('collection form not found')
  return form
}

/** The implicit group holding the destination radios (fieldset = role group). */
function destinationFieldset(form: ParentNode): HTMLFieldSetElement {
  const fieldset = form.querySelector<HTMLFieldSetElement>('fieldset[aria-label="Add to pack"]')
  if (fieldset === null) throw new Error('collection destination fieldset not found')
  return fieldset
}

/** Select one existing pack radio without submitting. Throws when it is absent. */
function selectPackTarget(container: ParentNode, name: string): HTMLInputElement {
  const fieldset = destinationFieldset(collectionForm(container))
  const label = [...fieldset.querySelectorAll<HTMLElement>('label')]
    .find(candidate => candidate.title === name || (candidate.textContent ?? '').includes(name))
  const radio = label?.querySelector<HTMLInputElement>('input[type="radio"]')
  if (radio === undefined || radio === null) throw new Error(`pack target radio "${name}" not found`)
  act(() => { radio.focus(); radio.click() })
  return radio
}

/** The footer's ONE primary submit (Add to pack for a pack, Create for New). */
function collectionSubmit(container: ParentNode): HTMLButtonElement {
  const submit = collectionForm(container).querySelector<HTMLButtonElement>('button[type="submit"]')
  if (submit === null) throw new Error('collection submit not found')
  return submit
}

/** Submit the already-selected destination through the footer primary action. */
function submitCollection(container: ParentNode): void {
  const submit = collectionSubmit(container)
  act(() => { submit.focus(); submit.click() })
}

/** Choose a pack radio, then explicitly submit Add to pack. */
function addToPack(container: ParentNode, name: string): void {
  selectPackTarget(container, name)
  const submit = collectionSubmit(container)
  if (buttonLabel(submit) !== 'Add to pack') {
    throw new Error(`collection submit is not "Add to pack": ${buttonLabel(submit)}`)
  }
  submitCollection(container)
}

/** Select the New radio and return the revealed pack-name input. */
function startNewPack(container: ParentNode): HTMLInputElement {
  const form = collectionForm(container)
  const radio = form.querySelector<HTMLInputElement>('input[type="radio"][value="__new"]')
  if (radio === null) throw new Error('new-pack radio not found')
  act(() => { radio.focus(); radio.click() })
  const input = form.querySelector<HTMLInputElement>('input[aria-label="Pack name"]')
  if (input === null) throw new Error('pack name input not found after selecting New')
  return input
}

function chooseSource(container: ParentNode, sourceId: string): void {
  const labels: Record<string, string> = { [FILES.sourceId]: 'Local files', [GITHUB.sourceId]: 'GitHub Issues', [FEISHU_DOCS.sourceId]: 'Feishu docs' }
  const label = labels[sourceId] ?? sourceId
  const tab = [...container.querySelectorAll<HTMLButtonElement>('[data-clue-source-navigation] [role="tab"]')]
    .find(candidate => buttonLabel(candidate) === label)
  if (tab === undefined) throw new Error('missing source tab: ' + label)
  if (tab.getAttribute('aria-selected') !== 'true') act(() => { tab.click() })
}

/** The accordion section whose disclosure bar carries this title. */
function sectionOf(container: ParentNode, title: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>('[data-workbench-section]')]
    .find(node => (node.querySelector('button')?.textContent ?? '').trim() === title)
}

/**
 * Open one explorer section and close the other. The page itself allows both
 * open (VSCode-style); most behavioural tests exercise the exclusive switch
 * they used to get from the old tabs, so this helper keeps that frame.
 */
async function showView(container: ParentNode, value: 'browse' | 'packs'): Promise<void> {
  const title = value === 'browse' ? t('clueViewBrowse') : t('clueViewPacks')
  const other = value === 'browse' ? t('clueViewPacks') : t('clueViewBrowse')
  if (sectionOf(container, title)?.getAttribute('data-open') !== 'true') click(container, title)
  if (sectionOf(container, other)?.getAttribute('data-open') === 'true') click(container, other)
  await flush()
}

async function rowAction(container: ParentNode, title: string, action: string): Promise<void> {
  click(container, t('clueBrowserMoreRow', { title }))
  await flush()
  clickMenuItem(document.querySelector<HTMLElement>('[role="menu"]')!, action)
}

function enterSelection(container: ParentNode): void {
  const toggle = container.querySelector<HTMLButtonElement>('[data-clue-selection-mode]')
  if (toggle?.getAttribute('aria-pressed') === 'false') act(() => { toggle.click() })
}

function selectResults(container: ParentNode): void {
  enterSelection(container)
  act(() => {
    for (const checkbox of container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) checkbox.click()
  })
}


const selectionFiles: ClueCandidate[] = [
  { sourceId: FILES.sourceId, typeId: 'file', clueId: 'c-a', title: 'First note', locator: { path: 'a.md' } },
  { sourceId: FILES.sourceId, typeId: 'file', clueId: 'c-b', title: 'Second note', locator: { path: 'b.md' } },
  { sourceId: FILES.sourceId, typeId: 'file', clueId: 'c-c', title: 'Third note', locator: { path: 'c.md' } },
]

describe('clue selection confirmation', () => {
  it('keeps the main action bar compact and commits the collection through one explicit submit', async () => {
    const fx = fixture({ workspaceId: 'ws-1', listItems: selectionFiles.slice(0, 2) })
    const view = mount(fx)
    await flush()
    expect(view.container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    enterSelection(view.container)
    expect(view.container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2)
    selectResults(view.container)
    // The tab keeps only the compact action bar: no inline destination form.
    // The optional disclosure makes cross-source selections auditable without
    // adding a second collection surface.
    expect(view.container.querySelector('[data-clue-collection]')).toBeNull()
    expect(view.container.querySelector('[data-clue-selection-review]')).not.toBeNull()
    expect(view.container.querySelector('button[aria-label^="Remove "]')).not.toBeNull()
    const selectionBar = view.container.querySelector<HTMLElement>('[role="region"][aria-label="2 selected"]')!
    expect(selectionBar).not.toBeNull()
    // Packing is the secondary action; inserting into the draft is the primary
    // action and stays last (rightmost) in the bar.
    const barButtons = [...selectionBar.querySelectorAll<HTMLButtonElement>('[data-clue-selection-actions] button')]
    expect(buttonLabel(barButtons[0]!)).toBe('Add to pack')
    expect(barButtons[0]!.className).toContain('toolButton')
    expect(buttonLabel(barButtons[1]!)).toBe('Insert resources')
    expect(barButtons[1]!.className).toContain('primaryButton')

    const reads = fx.calls.packsList
    openCollectionWindow(view.container)
    await flush()
    const collection = collectionWindow()
    expect(collection.closest('[data-floating-window]')).not.toBeNull()
    expect(view.container.contains(collection)).toBe(false)
    // Opening reads the pack choices once, without waiting for a focus event.
    expect(fx.calls.packsList).toBe(reads + 1)
    // No duplicate review: one destination fieldset and one footer submit.
    expect(collection.querySelector('[data-workbench-section]')).toBeNull()
    expect(collection.querySelector('button[aria-label^="Remove "]')).toBeNull()
    expect(collection.textContent).toContain('2 selected')
    const targets = destinationFieldset(collection)
    expect(targets.tagName).toBe('FIELDSET')
    expect(targets.textContent).toContain('Release clues')
    expect(targets.querySelector('input[type="radio"][value="__new"]')).not.toBeNull()
    const submit = collectionSubmit(collection)
    expect(submit.disabled).toBe(true)
    expect(buttonLabel(submit)).toBe('Add to pack')
    expect(fx.ensureParams).toEqual([])
    expect(fx.addMemberParams).toEqual([])
    expect(fx.createParams).toEqual([])

    // Closing the title bar is not cancellation: the parent-owned selection
    // survives, and reopening shows the same count.
    closeFloatingWindow('[data-clue-collection]')
    await flush()
    expect(floatingContent('[data-clue-collection]')).toBeNull()
    expect(view.container.querySelector('[role="region"][aria-label="2 selected"]')).not.toBeNull()
    openCollectionWindow(view.container)
    await flush()
    const reopened = collectionWindow()
    expect(reopened.textContent).toContain('2 selected')

    // A radio only chooses the destination: nothing is written until submit.
    const chosen = selectPackTarget(reopened, 'Release clues')
    expect(chosen.checked).toBe(true)
    await flush()
    expect(fx.ensureParams).toEqual([])
    expect(fx.addMemberParams).toEqual([])
    expect(fx.createParams).toEqual([])
    expect(floatingContent('[data-clue-collection]')).not.toBeNull()
    expect(collectionSubmit(reopened).disabled).toBe(false)

    // Cancel closes the task and keeps the parent-owned selection: no write.
    click(reopened, 'Cancel')
    await flush()
    expect(floatingContent('[data-clue-collection]')).toBeNull()
    expect(view.container.querySelector('[role="region"][aria-label="2 selected"]')).not.toBeNull()
    expect(fx.ensureParams).toEqual([])
    expect(fx.addMemberParams).toEqual([])
    expect(fx.createParams).toEqual([])

    // Reopening after Cancel and submitting performs the one write.
    openCollectionWindow(view.container)
    await flush()
    const confirmed = collectionWindow()
    expect(confirmed.textContent).toContain('2 selected')
    const beforeSubmit = fx.calls.packsList
    addToPack(confirmed, 'Release clues')
    await flush()
    expect(fx.addMemberParams).toEqual([
      { packId: 'p1', clueId: 'c-a' },
      { packId: 'p1', clueId: 'c-b', expectedRevision: 2 },
    ])
    expect(fx.calls.packsList).toBe(beforeSubmit)
    await showView(view.container, 'packs')
    expect(fx.calls.packsList).toBe(beforeSubmit + 1)
    expect(view.container.querySelector('[data-clue-pack-region]')?.textContent).toContain('4 members')
    expect(view.container.querySelector('[role="region"][aria-label="2 selected"]')).toBeNull()
    expect([...view.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(input => !input.checked)).toBe(true)
    view.unmount()
  })

  it('keeps the selection count outside the destination form and offers no duplicate review', async () => {
    const fx = fixture({ workspaceId: 'ws-1', listItems: selectionFiles.slice(0, 2) })
    const view = mount(fx)
    await flush()
    selectResults(view.container)
    openCollectionWindow(view.container)
    await flush()
    const collection = collectionWindow()
    const form = collectionForm(collection)
    const count = collection.querySelector<HTMLElement>('[data-clue-collection-selection]')
    expect(count?.textContent).toContain('2 selected')
    expect(form.contains(count!)).toBe(false)
    // The collection window keeps the count and target review outside the
    // destination form; the tab owns the optional per-resource disclosure.
    expect(collection.querySelector('[data-workbench-section]')).toBeNull()
    expect(collection.querySelector('button[aria-label^="Remove "]')).toBeNull()
    expect(destinationFieldset(form)).not.toBeNull()
    // One destination group, one footer: the explicit submit starts disabled
    // until a destination is chosen.
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(submit).not.toBeNull()
    expect(submit.disabled).toBe(true)
    expect(buttonLabel(submit)).toBe('Add to pack')
    // One scroll section (search + destination fieldset) and a sibling footer:
    // the footer must stay outside the scrolling fields.
    expect([...form.children].map(child => child.tagName)).toEqual(['DIV', 'DIV'])
    const fields = form.children[0] as HTMLElement
    const footer = form.children[1] as HTMLElement
    expect(fields.querySelector('input[type="search"]')).not.toBeNull()
    expect(fields.querySelector('fieldset[aria-label="Add to pack"]')).not.toBeNull()
    expect(fields.contains(footer)).toBe(false)
    expect(footer.previousElementSibling).toBe(fields)
    expect(footer.querySelector('button[type="submit"]')).toBe(submit)
    expect(view.container.querySelector('[role="region"][aria-label="2 selected"]')).not.toBeNull()
    view.unmount()
  })

  it('keeps target empty and error feedback inside the destination fieldset, above the action footer', async () => {
    // Empty filter result: the hint belongs to the target list, not the form shell.
    const fx = fixture({ workspaceId: 'ws-1', listItems: selectionFiles.slice(0, 1) })
    const view = mount(fx)
    await flush()
    selectResults(view.container)
    openCollectionWindow(view.container)
    await flush()
    const collection = collectionWindow()
    const form = collectionForm(collection)
    const targets = destinationFieldset(form)
    const search = form.querySelector<HTMLInputElement>('input[type="search"][aria-label="Search clue packs"]')!
    typeInto(search, 'no-such-pack')
    await flush()
    const hint = [...targets.querySelectorAll<HTMLElement>('span')]
      .find(node => node.textContent === 'No matching packs. Try another name.')
    expect(hint).not.toBeUndefined()
    expect(hint!.closest('fieldset')).toBe(targets)
    // New stays available while the filter has no match; the one footer submit
    // remains disabled until a destination is chosen.
    expect(targets.querySelector('input[type="radio"][value="__new"]')).not.toBeNull()
    const footer = form.lastElementChild as HTMLElement
    expect(footer.tagName).toBe('DIV')
    expect([...footer.querySelectorAll<HTMLButtonElement>('button')].map(buttonLabel))
      .toEqual(['Cancel', 'Add to pack'])
    expect(footer.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
    view.unmount()

    // Load failure: the retryable error also stays inside the list, with the footer intact.
    const failing = fixture({ workspaceId: 'ws-1', listItems: selectionFiles.slice(0, 1), packsError: true })
    const failedView = mount(failing)
    await flush()
    selectResults(failedView.container)
    openCollectionWindow(failedView.container)
    await flush()
    const failedCollection = collectionWindow()
    const failedForm = collectionForm(failedCollection)
    const failedTargets = destinationFieldset(failedForm)
    const alert = failedTargets.querySelector<HTMLElement>('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert!.closest('fieldset')).toBe(failedTargets)
    expect(failedTargets.querySelector('input[type="radio"][value="__new"]')).not.toBeNull()
    const failedFooter = failedForm.lastElementChild as HTMLElement
    expect(failedFooter.tagName).toBe('DIV')
    expect([...failedFooter.querySelectorAll<HTMLButtonElement>('button')].map(buttonLabel))
      .toEqual(['Cancel', 'Add to pack'])
    expect(failedFooter.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
    failedView.unmount()
  })

  it('filters visible pack targets without adding until the footer submit', async () => {
    const fx = fixture({ workspaceId: 'ws-1', listItems: selectionFiles.slice(0, 1) })
    const view = mount(fx)
    await flush()
    selectResults(view.container)
    openCollectionWindow(view.container)
    await flush()
    const collection = collectionWindow()
    const form = collectionForm(collection)
    const targets = destinationFieldset(form)
    expect(targets.textContent).toContain('Release clues')
    expect(targets.textContent).toContain('2 members')
    expect(fx.addMemberParams).toEqual([])
    const search = form.querySelector<HTMLInputElement>('input[type="search"][aria-label="Search clue packs"]')!
    typeInto(search, 'Design')
    await flush()
    expect(targets.textContent).toContain('Design notes')
    expect(targets.textContent).not.toContain('Release clues')
    expect(fx.addMemberParams).toEqual([])
    typeInto(search, '')
    await flush()
    expect(targets.textContent).toContain('Release clues')
    // Filtering and choosing a radio are read-only; only the explicit submit writes.
    selectPackTarget(collection, 'Release clues')
    await flush()
    expect(fx.ensureParams).toEqual([])
    expect(fx.addMemberParams).toEqual([])
    expect(fx.createParams).toEqual([])
    expect(collectionSubmit(collection).disabled).toBe(false)
    submitCollection(collection)
    await flush()
    expect(fx.addMemberParams).toEqual([{ packId: 'p1', clueId: 'c-a' }])
    view.unmount()
  })

  it('creates a named pack from all selected resources only after Create and refreshes the shelf', async () => {
    const unresolved: ClueCandidate = { sourceId: FILES.sourceId, typeId: 'file', title: 'Unregistered note', locator: { path: 'new.md' } }
    const fx = fixture({ workspaceId: 'ws-1', listItems: [selectionFiles[0]!, unresolved] })
    const view = mount(fx)
    await flush()
    selectResults(view.container)
    openCollectionWindow(view.container)
    await flush()
    const collection = collectionWindow()
    const form = collectionForm(collection)
    // Selecting the New radio reveals the name field; the footer submit becomes
    // the explicit Create action.
    expect(form.querySelector('input[type="radio"][value="__new"]')).not.toBeNull()
    const name = startNewPack(collection)
    expect(form.querySelector<HTMLInputElement>('input[type="radio"][value="__new"]')!.checked).toBe(true)
    typeInto(name, '  Investigation  ')
    await flush()
    expect(fx.ensureParams).toEqual([])
    expect(fx.createParams).toEqual([])
    expect(buttonLabel(collectionSubmit(collection))).toBe('Create')
    expect(collectionSubmit(collection).disabled).toBe(false)
    const reads = fx.calls.packsList
    click(collection, 'Create')
    await flush()
    expect(fx.ensureParams).toHaveLength(1)
    expect(fx.createParams).toEqual([{ name: 'Investigation', members: ['c-a', 'c9'] }])
    expect(fx.addMemberParams).toEqual([])
    expect(fx.calls.packsList).toBe(reads)
    await showView(view.container, 'packs')
    expect(fx.calls.packsList).toBe(reads + 1)
    expect(view.container.querySelector('button[aria-label="Manage pack: Investigation"]')).not.toBeNull()
    expect(floatingContent('[data-clue-collection]')).toBeNull()
    expect(view.container.querySelector('[role="region"][aria-label="2 selected"]')).toBeNull()
    view.unmount()
  })

  it('keeps cross-source selections and adds all of them to the chosen pack', async () => {
    const issue: ClueCandidate = { sourceId: GITHUB.sourceId, typeId: 'issue', clueId: 'c-issue', title: 'Tracked issue', locator: { number: 7 } }
    const fx = fixture({ workspaceId: 'ws-1', listResponse: async (_signal, input) => ({ items: input.sourceId === FILES.sourceId ? [selectionFiles[0]!] : [issue] }) })
    fx.store.setPrefs({ ...fx.store.getPrefs(), pluginSettings: { clues: { scopes: { 'ws-1': {
      [GITHUB.sourceId]: { repo: 'acme/widgets', state: 'open' },
    } } } } })
    const view = mount(fx)
    await flush()
    selectResults(view.container)
    chooseSource(view.container, GITHUB.sourceId)
    await flush()
    selectResults(view.container)
    openCollectionWindow(view.container)
    await flush()
    const collection = collectionWindow()
    // Both sources' selections are present in one tray; choosing a target is
    // read-only and only the footer submit writes members.
    expect(collection.textContent).toContain('2 selected')
    expect(destinationFieldset(collection).textContent).toContain('Release clues')
    expect(fx.ensureParams).toEqual([])
    expect(fx.addMemberParams).toEqual([])
    selectPackTarget(collection, 'Release clues')
    await flush()
    expect(fx.ensureParams).toEqual([])
    expect(fx.addMemberParams).toEqual([])
    expect(fx.createParams).toEqual([])
    submitCollection(collection)
    await flush()
    expect(fx.addMemberParams.map(input => input.clueId)).toEqual(['c-a', 'c-issue'])
    expect(floatingContent('[data-clue-collection]')).toBeNull()
    expect(view.container.querySelector('[role="region"][aria-label="2 selected"]')).toBeNull()
    view.unmount()
  })

  it('retains uncompleted members after partial add failure and refreshes the changed shelf before retry', async () => {
    let failing = true
    const fx = fixture({ workspaceId: 'ws-1', listItems: selectionFiles,
      addMemberResponse: async input => {
        if (input.clueId === 'c-b' && failing) throw new Error('member rejected')
        const previous = fx.packs[0]!
        const target = { ...previous, members: [...previous.members, String(input.clueId)], revision: previous.revision + 1 }
        fx.packs[0] = target
        return { pack: target, revision: 4, packRevision: target.revision }
      },
    })
    const view = mount(fx)
    await flush()
    const query = view.container.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!
    typeInto(query, 'unfinished search')
    selectResults(view.container)
    openCollectionWindow(view.container)
    await flush()
    const collection = collectionWindow()
    const collectionForm = requiredContent('[data-clue-collection]')
    const reads = fx.calls.packsList
    addToPack(collection, 'Release clues')
    await flush()
    expect(fx.addMemberParams.map(input => input.clueId)).toEqual(['c-a', 'c-b'])
    expect(fx.calls.packsList).toBe(reads)
    await showView(view.container, 'packs')
    expect(fx.calls.packsList).toBe(reads + 1)
    expect(view.container.querySelector('[data-clue-pack-region]')?.textContent).toContain('3 members')
    await showView(view.container, 'browse')
    // The failure keeps the window and the uncompleted selection; the inserted
    // member already left the tray.
    expect(requiredContent('[data-clue-collection]')).toBe(collectionForm)
    expect(collection.textContent).toContain('2 selected')
    expect(destinationFieldset(collection).textContent).toContain('Release clues')
    expect(query.value).toBe('unfinished search')
    expect(document.querySelector('[data-dsh-better-sidebar-clue-notice]')?.textContent).toBe('Saving the pack failed.')
    failing = false
    addToPack(collection, 'Release clues')
    await flush()
    expect(fx.addMemberParams.map(input => input.clueId)).toEqual(['c-a', 'c-b', 'c-b', 'c-c'])
    expect(fx.packs[0]!.members).toEqual(['c1', 'c2', 'c-a', 'c-b', 'c-c'])
    expect(view.container.querySelector('[role="region"][aria-label="2 selected"]')).toBeNull()
    expect(floatingContent('[data-clue-collection]')).toBeNull()
    view.unmount()
  })

  it('preserves new-pack name, footer and all selections after failed creation and native hiding', async () => {
    const fx = fixture({ workspaceId: 'ws-1', listItems: selectionFiles,
      createResponse: async () => { throw new Error('creation rejected') },
    })
    const view = mount(fx)
    await flush()
    selectResults(view.container)
    openCollectionWindow(view.container)
    await flush()
    const collection = collectionWindow()
    const collectionForm = requiredContent('[data-clue-collection]')
    const name = startNewPack(collection)
    typeInto(name, 'Keep this draft')
    expect(fx.ensureParams).toEqual([])
    expect(fx.createParams).toEqual([])
    expect(buttonLabel(collectionSubmit(collection))).toBe('Create')
    const reads = fx.calls.packsList
    click(collection, 'Create')
    await flush()
    expect(fx.createParams).toEqual([{ name: 'Keep this draft', members: ['c-a', 'c-b', 'c-c'] }])
    expect(fx.calls.packsList).toBe(reads)
    expect(view.container.querySelector('[role="region"][aria-label="3 selected"]')).not.toBeNull()
    expect(document.querySelector('[data-dsh-better-sidebar-clue-notice]')?.textContent).toBe('Saving the pack failed.')

    // Native hiding is not a window close: the HostedWindow portals stay
    // mounted and keep the parent-owned draft.
    setVisible(view, fx, false)
    await flush()
    expect(floatingContent('[data-clue-collection]')).toBe(collectionForm)
    setVisible(view, fx, true)
    await flush()
    expect(floatingContent('[data-clue-collection]')).toBe(collectionForm)
    expect(collection.querySelector('input[aria-label="Pack name"]')).toBe(name)
    expect(name.value).toBe('Keep this draft')
    expect(collection.querySelector('[data-clue-collection] button[type="submit"]')?.textContent?.trim()).toBe('Create')
    expect(collection.textContent).toContain('3 selected')
    expect(fx.createParams).toHaveLength(1)
    view.unmount()
  })

  it('removes inserted items but keeps failed and later items for retry when ensure fails mid-batch', async () => {
    let failing = true
    const unresolved: ClueCandidate = { sourceId: FILES.sourceId, typeId: 'file', title: 'Unregistered note', locator: { path: 'new.md' } }
    const fx = fixture({ workspaceId: 'ws-1', listItems: [selectionFiles[0]!, unresolved, selectionFiles[2]!],
      ensureResponse: async () => {
        if (failing) throw new Error('ensure rejected')
        return { clue: { id: 'c-new' }, created: true }
      },
    })
    const view = mount(fx)
    await flush()
    selectResults(view.container)
    click(view.container, 'Insert resources')
    await flush()
    expect(fx.inserted).toHaveLength(1)
    // A successful chip belongs to the composer; the tab does not pull focus
    // back into its own search box.
    expect(document.activeElement).not.toBe(browserQueryInput(view.container))
    // The inserted item left the tray; the failed and later items remain.
    expect(view.container.querySelector('[role="region"][aria-label="2 selected"]')).not.toBeNull()
    failing = false
    click(view.container, 'Insert resources')
    await flush()
    expect(fx.inserted).toHaveLength(3)
    expect(fx.inserted).toEqual([
      expect.objectContaining({ reference: expect.objectContaining({ clipboardText: '[[dsh-clue:c-a]]' }) }),
      expect.objectContaining({ reference: expect.objectContaining({ clipboardText: '[[dsh-clue:c-new]]' }) }),
      expect.objectContaining({ reference: expect.objectContaining({ clipboardText: '[[dsh-clue:c-c]]' }) }),
    ])
    expect(view.container.querySelector('[role="region"][aria-label="2 selected"]')).toBeNull()
    view.unmount()
  })
})

describe('clue workbench UX regressions', () => {

  it('retains source, query, pack filter/create draft, selection and scope through native tab hiding', async () => {
    const fx = fixture({ workspaceId: 'ws-1', listItems: [
      { sourceId: GITHUB.sourceId, typeId: 'issue', title: 'A note', locator: { number: 7 } },
    ] })
    fx.store.setPrefs({ ...fx.store.getPrefs(), pluginSettings: { clues: { scopes: { 'ws-1': {
      [GITHUB.sourceId]: { repo: 'acme/widgets', state: 'open' },
    } } } } })
    const view = mount(fx)
    await flush()
    const sourceNavigation = view.container.querySelector<HTMLElement>('[data-clue-source-navigation]')!
    chooseSource(view.container, GITHUB.sourceId)
    await flush()
    const query = view.container.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!
    typeInto(query, 'unfinished query')
    enterSelection(view.container)
    const checkbox = view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    act(() => { checkbox.click() })

    // Scope draft: parent-owned, rendered through a HostedWindow.
    openScopeWindow(view.container)
    await flush()
    const scopeInput = scopeWindow().querySelector<HTMLInputElement>('input[placeholder="owner/repo or repository URL"]')!
    typeInto(scopeInput, 'unsaved/repository')

    // Pack filter and the create-pack draft are independent surfaces.
    await showView(view.container, 'packs')
    const filter = view.container.querySelector<HTMLInputElement>('input[aria-label="Search clue packs"]')!
    typeInto(filter, 'Release')
    await showView(view.container, 'packs')
    click(view.container, 'New')
    await flush()
    const name = document.querySelector<HTMLInputElement>('input[aria-label="Pack name"]')!
    typeInto(name, 'Unfinished pack')

    const before = { ...fx.calls }
    setVisible(view, fx, false)
    await flush()
    expect(fx.calls).toEqual(before)
    setVisible(view, fx, true)
    await flush()
    expect(view.container.querySelector('[data-clue-source-navigation]')).toBe(sourceNavigation)
    expect(sourceNavigation.getAttribute('data-clue-active-source')).toBe(GITHUB.sourceId)
    expect(view.container.querySelector('input[aria-label="Keyword, resource link or file path"]')).toBe(query)
    expect(query.value).toBe('unfinished query')
    expect(filter.value).toBe('Release')
    const restoredSelection = view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(restoredSelection.getAttribute('aria-label')).toBe(checkbox.getAttribute('aria-label'))
    expect(restoredSelection.checked).toBe(true)
    // Both floating drafts survive the visibility flip; they are outside the
    // tab container and keep the parent's state.
    expect(scopeWindow().querySelector('input[placeholder="owner/repo or repository URL"]')).toBe(scopeInput)
    expect(scopeInput.value).toBe('unsaved/repository')
    expect(document.querySelector('input[aria-label="Pack name"]')).toBe(name)
    expect(name.value).toBe('Unfinished pack')
    // The already-read page is restored from this view's memo (and, in
    // production, the shared cache): a visibility flip issues no page read.
    expect(fx.calls.list).toBe(before.list)
    expect(fx.calls.packsList).toBe(before.packsList)
    expect(fx.calls.search).toBe(before.search)
    view.unmount()
  })

  it('reuses a settled default range and its page across a native hide/show', async () => {
    const fx = fixture({
      workspaceId: 'ws-1',
      enabled: [GITHUB.sourceId],
      defaultScopeResponse: { scope: { repo: 'acme/widgets', state: 'open' } },
    })
    const view = mount(fx)
    await flush()
    expect(fx.calls.defaultScope).toBe(1)
    expect(fx.calls.list).toBe(1)
    setVisible(view, fx, false)
    await flush()
    setVisible(view, fx, true)
    await flush()
    // The range is an observation, not a per-visibility probe, and the
    // completed page is cached: returning does not silently re-read either.
    expect(fx.calls.defaultScope).toBe(1)
    expect(fx.calls.list).toBe(1)
    view.unmount()
  })

  it('paints a warm page and pack shelf from the shared cache on remount without reading again', async () => {
    const warm: ClueCandidate = {
      sourceId: FILES.sourceId, typeId: 'file', clueId: 'c-warm', title: 'Warm note', locator: { path: 'warm.md' },
    }
    const fetchMock = vi.fn(async (url: string) => {
      const method = String(url).split('?')[0]!.split('/sidebar/api/').at(-1)
      const value = method === 'clues.sources'
        ? { sources: [{ ...FILES, capabilities: { ...FILES.capabilities } }], types: [] }
        : method === 'clues.list' ? { items: [warm] }
          : method === 'clues.pins.list' ? { pins: [], revision: 0 }
            : method === 'clues.clues' ? { clues: [], revision: 0 }
              : method === 'clues.packs.list' ? { packs: [], revision: 0 }
                : { reason: 'no-github-remote' }
      return { ok: true, status: 200, json: async () => ({ ok: true, value }) } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    const reads = (method: string): number => fetchMock.mock.calls
      .filter(([url]) => String(url).split('?')[0]!.endsWith(`/sidebar/api/${method}`)).length
    const fx = fixture({
      workspaceId: 'ws-1', enabled: [FILES.sourceId], realApi: true, listItems: [warm],
    })
    const first = mount(fx)
    await flush()
    expect(browserRegion(first.container).textContent).toContain('Warm note')
    expect(reads('clues.list')).toBe(1)
    await showView(first.container, 'packs')
    expect(reads('clues.packs.list')).toBe(1)
    first.unmount()

    // A remount is a new component tree, not a new activation: the shared
    // cache paints the page and the shelf with no loader and no wire read.
    const second = mount(fx)
    await flush()
    // The first mount left the packs section expanded (persisted layout); open
    // resources again. The cached page paints without a read.
    await showView(second.container, 'browse')
    const browser = browserRegion(second.container)
    expect(browser.querySelector('[data-clue-browser-state="loading"]')).toBeNull()
    expect(browser.querySelector('[data-clue-browser-state="page"]')).not.toBeNull()
    expect(browser.textContent).toContain('Warm note')
    expect(reads('clues.list')).toBe(1)
    await showView(second.container, 'packs')
    expect(reads('clues.packs.list')).toBe(1)
    expect(reads('clues.sources')).toBe(1)
    second.unmount()
  })

  it('reuses a cached automatic GitHub range and page on remount without probing', async () => {
    const issue: ClueCandidate = {
      sourceId: GITHUB.sourceId, typeId: 'issue', clueId: 'c-issue', title: 'Cached issue', locator: { number: 7 },
    }
    const fetchMock = vi.fn(async (url: string) => {
      const method = String(url).split('?')[0]!.split('/sidebar/api/').at(-1)
      const value = method === 'clues.sources'
        ? { sources: [{ ...GITHUB, capabilities: { ...GITHUB.capabilities } }], types: [] }
        : method === 'clues.defaultScope' ? { scope: { repo: 'acme/widgets', state: 'open' } }
          : method === 'clues.list' ? { items: [issue] }
            : method === 'clues.pins.list' ? { pins: [], revision: 0 }
              : method === 'clues.clues' ? { clues: [], revision: 0 }
                : method === 'clues.packs.list' ? { packs: [], revision: 0 }
                  : { reason: 'no-github-remote' }
      return { ok: true, status: 200, json: async () => ({ ok: true, value }) } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    const reads = (method: string): number => fetchMock.mock.calls
      .filter(([url]) => String(url).split('?')[0]!.endsWith(`/sidebar/api/${method}`)).length
    const fx = fixture({ workspaceId: 'ws-1', enabled: [GITHUB.sourceId], realApi: true })
    const first = mount(fx)
    await flush()
    expect(fx.calls.defaultScope).toBe(0)
    expect(reads('clues.defaultScope')).toBe(1)
    expect(reads('clues.list')).toBe(1)
    expect(browserRegion(first.container).textContent).toContain('Cached issue')
    first.unmount()

    const second = mount(fx)
    await flush()
    const browser = browserRegion(second.container)
    // The range observation and its page are both activation-cached: a
    // remount neither probes the repository again nor shows a loader.
    expect(browser.querySelector('[data-clue-browser-state="loading"]')).toBeNull()
    expect(browser.querySelector('[data-clue-browser-state="page"]')).not.toBeNull()
    expect(browser.textContent).toContain('Cached issue')
    expect(reads('clues.defaultScope')).toBe(1)
    expect(reads('clues.list')).toBe(1)
    second.unmount()
  })

  it('aborts native-hidden requests, ignores late rows and refreshes once on return', async () => {
    const requests: { signal: AbortSignal | undefined; resolve: (result: ClueListResult) => void }[] = []
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId],
      listResponse: signal => new Promise(resolve => { requests.push({ signal, resolve }) }),
    })
    const view = mount(fx)
    await flush()
    const previous = requests.at(-1)!
    const packReads = fx.calls.packsList
    setVisible(view, fx, false)
    expect(previous.signal?.aborted).toBe(true)
    await act(async () => { previous.resolve({ items: [{ sourceId: FILES.sourceId, typeId: 'file', title: 'Late row', locator: { path: 'old.md' } }] }) })
    expect(view.container.textContent).not.toContain('Late row')
    const count = requests.length
    await flush()
    expect(requests).toHaveLength(count)
    expect(fx.calls.packsList).toBe(packReads)
    setVisible(view, fx, true)
    await flush()
    expect(requests).toHaveLength(count + 1)
    // The pack shelf kept its loaded library: returning is not a re-read.
    expect(fx.calls.packsList).toBe(packReads)
    expect(requests.at(-1)?.signal?.aborted).toBe(false)
    await act(async () => { requests.at(-1)!.resolve({ items: [] }) })
    view.unmount()
  })

  it('reacts to source preferences without closing the workbench', async () => {
    const fx = fixture({ workspaceId: 'ws-1' })
    const view = mount(fx)
    await flush()
    expect(view.container.querySelector('[data-clue-source-navigation]')?.getAttribute('data-clue-active-source')).toBe(FILES.sourceId)
    act(() => { fx.store.setPrefs({ ...fx.store.getPrefs(), clueSourcesEnabled: { [FILES.sourceId]: false } }) })
    await flush()
    expect(view.container.querySelector(`[data-clue-source="${FILES.sourceId}"]`)).toBeNull()
    expect(view.container.querySelector('[data-clue-source-navigation]')?.getAttribute('data-clue-active-source')).toBe(GITHUB.sourceId)
    view.unmount()
  })


  it('clears the previous source query before listing GitHub once while keeping selected files', async () => {
    const file: ClueCandidate = {
      sourceId: FILES.sourceId, typeId: 'file', clueId: 'c-files', title: 'Release note', locator: { path: 'release.md' },
    }
    const issue: ClueCandidate = {
      sourceId: GITHUB.sourceId, typeId: 'issue', clueId: 'c-issue', title: 'A GitHub issue', locator: { number: 7 },
    }
    const fx = fixture({
      workspaceId: 'ws-1',
      enabled: [FILES.sourceId, GITHUB.sourceId],
      listResponse: async (_signal, input) => ({ items: input.sourceId === FILES.sourceId ? [file] : [issue] }),
      searchResponse: async () => ({ items: [file] }),
    })
    fx.store.setPrefs({ ...fx.store.getPrefs(), pluginSettings: { clues: { scopes: { 'ws-1': {
      [FILES.sourceId]: { path: 'docs' },
      [GITHUB.sourceId]: { repo: 'acme/widgets', state: 'open' },
    } } } } })
    const view = mount(fx)
    await flush()
    const browser = view.container.querySelector<HTMLElement>('[data-clue-browse-region]')!
    const query = browser.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!
    typeInto(query, 'release notes')
    click(browser, 'Search')
    await flush()
    enterSelection(browser)
    act(() => { browser.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click() })
    const before = { ...fx.calls }
    chooseSource(browser, GITHUB.sourceId)
    await flush()
    expect(query.value).toBe('')
    expect(fx.calls.search).toBe(before.search)
    expect(fx.searchParams.every(input => input.sourceId === FILES.sourceId)).toBe(true)
    expect(fx.calls.list).toBe(before.list + 1)
    const githubLists = fx.listParams.filter(input => input.sourceId === GITHUB.sourceId)
    expect(githubLists).toHaveLength(1)
    expect(githubLists[0]).toMatchObject({ sourceId: GITHUB.sourceId, scope: { repo: 'acme/widgets', state: 'open' } })
    expect(githubLists[0]).not.toHaveProperty('cursor')
    expect(githubLists[0]).not.toHaveProperty('query')
    expect(browser.textContent).toContain('A GitHub issue')
    expect(browser.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false)
    expect(browser.querySelector('[role="region"][aria-label="1 selected"]')).not.toBeNull()
    click(browser, 'Insert resources')
    await flush()
    expect(fx.inserted).toHaveLength(1)
    expect(fx.inserted[0]).toMatchObject({ reference: { clipboardText: '[[dsh-clue:c-files]]' } })
    view.unmount()
  })

  it('restores each source query when returning without sending another source draft', async () => {
    const fx = fixture({
      workspaceId: 'ws-1',
      listItems: selectionFiles.slice(0, 1),
      searchResponse: async () => ({ items: selectionFiles.slice(0, 1) }),
    })
    fx.store.setPrefs({ ...fx.store.getPrefs(), pluginSettings: { clues: { scopes: { 'ws-1': {
      [GITHUB.sourceId]: { repo: 'acme/widgets', state: 'open' },
    } } } } })
    const view = mount(fx)
    await flush()
    const browser = view.container.querySelector<HTMLElement>('[data-clue-browse-region]')!
    const query = browser.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!
    typeInto(query, 'local release')
    click(browser, 'Search')
    await flush()
    typeInto(query, 'unfinished local draft')
    chooseSource(browser, GITHUB.sourceId)
    await flush()
    expect(query.value).toBe('')
    expect(fx.listParams.at(-1)).toMatchObject({ sourceId: GITHUB.sourceId })
    typeInto(query, 'remote issue')
    click(browser, 'Search')
    await flush()
    const beforeFiles = { ...fx.calls }
    const filesSearches = fx.searchParams.length
    chooseSource(browser, FILES.sourceId)
    await flush()
    expect(query.value).toBe('unfinished local draft')
    // The source's own page is restored from its memo: no source draft is
    // replayed onto another source and no cached search is re-sent.
    expect(fx.calls.list).toBe(beforeFiles.list)
    expect(fx.calls.search).toBe(beforeFiles.search)
    expect(fx.searchParams).toHaveLength(filesSearches)
    expect(browser.textContent).toContain('First note')
    const beforeGithub = { ...fx.calls }
    const githubSearches = fx.searchParams.length
    chooseSource(browser, GITHUB.sourceId)
    await flush()
    expect(query.value).toBe('remote issue')
    expect(fx.calls.list).toBe(beforeGithub.list)
    expect(fx.calls.search).toBe(beforeGithub.search)
    expect(fx.searchParams).toHaveLength(githubSearches)
    for (const request of fx.searchParams) {
      const local = request.sourceId === FILES.sourceId
      expect(request.query).toBe(local ? 'local release' : 'remote issue')
      expect(request).not.toHaveProperty('cursor')
    }
    view.unmount()
  })

  it('invalidates an unsaved range draft when the persisted scope changes while away', async () => {
    const fx = fixture({
      workspaceId: 'ws-1',
      listItems: selectionFiles.slice(0, 1),
      searchResponse: async () => ({ items: selectionFiles.slice(0, 1) }),
    })
    const githubScope = { repo: 'acme/widgets', state: 'open' }
    fx.store.setPrefs({ ...fx.store.getPrefs(), pluginSettings: { clues: { scopes: { 'ws-1': {
      [FILES.sourceId]: { path: 'old-docs' }, [GITHUB.sourceId]: githubScope,
    } } } } })
    const view = mount(fx)
    await flush()
    const browser = view.container.querySelector<HTMLElement>('[data-clue-browse-region]')!
    const query = browser.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!
    typeInto(query, 'release notes')
    click(browser, 'Search')
    await flush()
    expect(fx.searchParams.at(-1)).toMatchObject({ sourceId: FILES.sourceId, scope: { path: 'old-docs' } })
    expect(fx.searchParams.at(-1)).not.toHaveProperty('cursor')
    openScopeWindow(browser)
    await flush()
    const scopeInput = scopeWindow().querySelector<HTMLInputElement>('input[placeholder="e.g. docs/"]')!
    typeInto(scopeInput, 'unsaved/old-draft')
    closeFloatingWindow('[data-clue-scope-window]')
    chooseSource(browser, GITHUB.sourceId)
    await flush()
    const whileAway = { ...fx.calls }
    act(() => { fx.store.setPrefs({ ...fx.store.getPrefs(), pluginSettings: { clues: { scopes: { 'ws-1': {
      [FILES.sourceId]: { path: 'new-docs' }, [GITHUB.sourceId]: githubScope,
    } } } } }) })
    await flush()
    expect(fx.calls).toEqual(whileAway)
    const beforeReturn = fx.searchParams.length
    chooseSource(browser, FILES.sourceId)
    await flush()
    expect(query.value).toBe('release notes')
    expect(fx.searchParams.slice(beforeReturn)).toHaveLength(1)
    expect(fx.searchParams.at(-1)).toMatchObject({ sourceId: FILES.sourceId, query: 'release notes', scope: { path: 'new-docs' } })
    expect(fx.searchParams.at(-1)).not.toHaveProperty('cursor')
    openScopeWindow(browser)
    await flush()
    expect(scopeWindow().querySelector<HTMLInputElement>('input[placeholder="e.g. docs/"]')?.value).toBe('new-docs')
    view.unmount()
  })

  it('restores an unsubmitted scope window draft when the persisted scope is unchanged', async () => {
    const fx = fixture({ workspaceId: 'ws-1', listItems: selectionFiles.slice(0, 1) })
    fx.store.setPrefs({ ...fx.store.getPrefs(), pluginSettings: { clues: { scopes: { 'ws-1': {
      [FILES.sourceId]: { path: 'saved-docs' }, [GITHUB.sourceId]: { repo: 'acme/widgets', state: 'open' },
    } } } } })
    const view = mount(fx)
    await flush()
    const browser = view.container.querySelector<HTMLElement>('[data-clue-browse-region]')!
    openScopeWindow(browser)
    await flush()
    typeInto(scopeWindow().querySelector<HTMLInputElement>('input[placeholder="e.g. docs/"]')!, 'unsaved/new-folder')
    closeFloatingWindow('[data-clue-scope-window]')
    chooseSource(browser, GITHUB.sourceId)
    await flush()
    const beforeReturn = fx.listParams.length
    chooseSource(browser, FILES.sourceId)
    await flush()
    // The persisted range did not change, so the source's memoized page comes
    // back without another read.
    expect(fx.listParams.slice(beforeReturn)).toHaveLength(0)
    expect(browser.textContent).toContain('First note')
    openScopeWindow(browser)
    await flush()
    expect(scopeWindow().querySelector<HTMLInputElement>('input[placeholder="e.g. docs/"]')?.value).toBe('unsaved/new-folder')
    const settings = fx.store.getPrefs().pluginSettings.clues as { scopes: Record<string, Record<string, unknown>> }
    expect(settings.scopes['ws-1']?.[FILES.sourceId]).toEqual({ path: 'saved-docs' })
    view.unmount()
  })

  it('switching views keeps browser drafts and page; returning issues no page read', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId], listItems: selectionFiles.slice(0, 1) })
    const view = mount(fx)
    await flush()
    const browser = view.container.querySelector<HTMLElement>('[data-clue-browse-region]')!
    const query = browser.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!
    typeInto(query, 'notes')
    openScopeWindow(browser)
    await flush()
    const scopeInput = scopeWindow().querySelector<HTMLInputElement>('input[placeholder="e.g. docs/"]')!
    typeInto(scopeInput, 'unsaved/folder')
    closeFloatingWindow('[data-clue-scope-window]')
    const before = { ...fx.calls }
    await showView(view.container, 'packs')
    expect(fx.calls.list).toBe(before.list)
    // Collapsed is hidden, not unmounted: both drafts are still there.
    expect(browser.querySelector('input[aria-label="Keyword, resource link or file path"]')).toBe(query)
    expect(query.value).toBe('notes')
    expect(sectionOf(view.container, t('clueViewBrowse'))?.getAttribute('data-open')).toBe('false')
    await showView(view.container, 'browse')
    expect(sectionOf(view.container, t('clueViewBrowse'))?.getAttribute('data-open')).toBe('true')
    expect(query.value).toBe('notes')
    // The hidden section kept both its page and its requests: expanding is a
    // paint, not a refresh.
    expect(fx.calls.list).toBe(before.list)
    expect(browser.textContent).toContain('First note')
    openScopeWindow(browser)
    await flush()
    expect(scopeWindow().querySelector<HTMLInputElement>('input[placeholder="e.g. docs/"]')?.value).toBe('unsaved/folder')
    view.unmount()
  })

  it('opens a collection by title and inserts only through its explicit @ action', async () => {
    const fx = fixture({ workspaceId: 'ws-1' })
    const view = mount(fx)
    await flush()
    await showView(view.container, 'packs')
    click(view.container, 'Manage pack: Release clues')
    await flush()
    const packWindow = requiredContent('[data-clue-pack-window]')
    expect(packWindow.closest('[data-floating-window]')).not.toBeNull()
    expect(view.container.contains(packWindow)).toBe(false)
    expect(fx.inserted).toHaveLength(0)
    click(packWindow, 'Insert pack reference')
    await flush()
    expect(fx.inserted).toHaveLength(1)
    expect(fx.inserted[0]).toMatchObject({ reference: { clipboardText: '[[dsh-cluepack:p1]]' } })
    view.unmount()
  })

  it('keeps the pack shelf rows and scroll position while a refresh is running', async () => {
    const fx = fixture({ workspaceId: 'ws-1' })
    const view = mount(fx)
    await flush()
    await showView(view.container, 'packs')
    const packs = view.container.querySelector<HTMLElement>('[data-clue-pack-region]')!
    const scroll = packs.querySelector<HTMLElement>('[data-clue-pack-scroll]')!
    scroll.scrollTop = 37
    expect(packs.textContent).toContain('Release clues')
    const browserReads = fx.calls.list
    click(packs, 'Refresh')
    await flush()
    // A refresh keeps the existing shelf clickable and exactly where it was;
    // the progressive window is not rewound, and only the shelf re-reads.
    expect(packs.textContent).toContain('Release clues')
    expect(scroll.scrollTop).toBe(37)
    expect(fx.calls.packsList).toBe(2)
    expect(fx.calls.list).toBe(browserReads)
    expect(packs.querySelector('[data-clue-pack-sentinel]')).not.toBeNull()
    view.unmount()
  })

  it('keeps browser query, scope and selection stable across pack recency writes and refreshes pack choices', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId], listItems: [
      { sourceId: FILES.sourceId, typeId: 'file', title: 'A note', locator: { path: 'a.md' } },
    ] })
    fx.store.setPrefs({ ...fx.store.getPrefs(), pluginSettings: { clues: { scopes: { 'ws-1': { [FILES.sourceId]: { path: 'docs' } } } } } })
    const view = mount(fx)
    await flush()
    const query = view.container.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!
    typeInto(query, 'notes')
    click(view.container, 'Search')
    await flush()
    enterSelection(view.container)
    const checkbox = view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    act(() => { checkbox.click() })
    openCollectionWindow(view.container)
    await flush()
    const collection = collectionWindow()
    const packChoices = destinationFieldset(collection)
    // Opening already read the pack choices once; no focus round trip is needed.
    expect(packChoices.textContent).not.toContain('Newly organized collection')

    openScopeWindow(view.container)
    await flush()
    const scope = scopeWindow()
    const scopeInput = scope.querySelector<HTMLInputElement>('input[placeholder="e.g. docs/"]')!
    typeInto(scopeInput, 'unsaved/path')
    const before = { ...fx.calls }
    await showView(view.container, 'packs')
    click(view.container, 'Insert pack: Release clues')
    await flush()
    // The recency write must not disturb the browser query/selection or the
    // open collection/scope windows.
    expect(fx.calls.list).toBe(before.list)
    expect(fx.calls.search).toBe(before.search)
    expect(fx.calls.resolve).toBe(before.resolve)
    expect(query.value).toBe('notes')
    expect(scopeInput.value).toBe('unsaved/path')
    expect(checkbox.checked).toBe(true)

    // A later pack appears on the next collection open (the list is read on
    // open), not because focus happens to land in the search box.
    fx.packs.push(pack('p-new', 'Newly organized collection', []))
    closeFloatingWindow('[data-clue-collection]')
    await showView(view.container, 'browse')
    openCollectionWindow(view.container)
    await flush()
    expect(destinationFieldset(collectionWindow()).textContent)
      .toContain('Newly organized collection')
    expect(checkbox.checked).toBe(true)
    expect(query.value).toBe('notes')
    expect(fx.calls.list).toBe(before.list)
    expect(fx.calls.search).toBe(before.search)
    expect(fx.calls.resolve).toBe(before.resolve)
    view.unmount()
  })

  it('finishes creation while the native tab is hidden without stealing focus or duplicating a refreshed pack', async () => {
    let finish!: (value: { pack: CluePack; revision: number; packRevision: number }) => void
    const fx = fixture({ workspaceId: 'ws-1', createResponse: () => new Promise(resolve => { finish = resolve }) })
    const view = mount(fx)
    const external = document.createElement('button')
    document.body.append(external)
    await flush()
    await showView(view.container, 'packs')
    click(view.container, 'New')
    await flush()
    const name = document.querySelector<HTMLInputElement>('input[aria-label="Pack name"]')!
    typeInto(name, 'Background collection')
    const createFrame = name.closest<HTMLElement>('[data-floating-window]')!
    click(createFrame, 'Create')
    await flush()
    setVisible(view, fx, false)
    external.focus()
    const created = pack('p3', 'Background collection', [])
    // The server commits before acknowledging creation. Native reactivation
    // can already load that pack; adopting the later response must upsert it.
    fx.packs.push(created)
    setVisible(view, fx, true)
    await flush()
    const filter = view.container.querySelector<HTMLInputElement>('input[aria-label="Search clue packs"]')!
    typeInto(filter, 'Background collection')
    // The commit is not acknowledged yet: the shelf keeps its loaded library
    // instead of re-reading on reactivation.
    expect(view.container.querySelectorAll('button[aria-label="Manage pack: Background collection"]')).toHaveLength(0)
    setVisible(view, fx, false)
    external.focus()
    await act(async () => { finish({ pack: created, revision: 4, packRevision: 1 }) })
    await flush()
    expect(view.container.querySelectorAll('button[aria-label="Manage pack: Background collection"]')).toHaveLength(1)
    expect(document.activeElement).toBe(external)
    setVisible(view, fx, true)
    await flush()
    expect(filter.value).toBe('Background collection')
    expect(view.container.querySelectorAll('button[aria-label="Manage pack: Background collection"]')).toHaveLength(1)
    external.remove()
    view.unmount()
  })

  it('reveals the whole pack library progressively without paging controls', async () => {
    installIntersectionObserver()
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId], listItems: [
      { sourceId: FILES.sourceId, typeId: 'file', title: 'A note', locator: { path: 'a.md' } },
    ] })
    for (let index = 3; index <= 14; index += 1) {
      fx.packs.push(pack(`p${index}`, `Collection ${index}`, []))
    }
    const view = mount(fx)
    await flush()
    const shelf = view.container.querySelector<HTMLElement>('[data-clue-pack-region]')!
    const browser = view.container.querySelector<HTMLElement>('[data-clue-browse-region]')!
    const query = browser.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!
    typeInto(query, 'notes')
    click(browser, 'Search')
    await flush()
    enterSelection(browser)
    const checkbox = browser.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    act(() => { checkbox.click() })
    const before = { ...fx.calls }

    await showView(view.container, 'packs')
    const packReads = fx.calls.packsList
    // 12 first, no Previous/Next/Page controls anywhere.
    expect(shelf.querySelectorAll('button[aria-label^="Manage pack:"]')).toHaveLength(12)
    expect(shelf.querySelector('button[aria-label="Manage pack: Collection 14"]')).toBeNull()
    expect(shelf.querySelector('[data-clue-pack-pagination]')).toBeNull()
    expect(shelf.textContent).not.toContain('Page ')
    intersect(shelf)
    await flush()
    expect(shelf.querySelectorAll('button[aria-label^="Manage pack:"]')).toHaveLength(14)
    expect(shelf.querySelector('button[aria-label="Manage pack: Collection 14"]')).not.toBeNull()

    const filter = shelf.querySelector<HTMLInputElement>('input[aria-label="Search clue packs"]')!
    typeInto(filter, 'Release')
    expect(shelf.querySelectorAll('button[aria-label^="Manage pack:"]')).toHaveLength(1)
    expect(shelf.querySelector('button[aria-label="Manage pack: Release clues"]')).not.toBeNull()
    typeInto(filter, '')
    // Clearing the filter resets the progressive window to its first 12 rows.
    expect(shelf.querySelectorAll('button[aria-label^="Manage pack:"]')).toHaveLength(12)
    await flush()
    expect(fx.calls).toEqual({ ...before, packsList: packReads })
    expect(browser.querySelector('input[aria-label="Keyword, resource link or file path"]')).toBe(query)
    expect(query.value).toBe('notes')
    expect(browser.querySelector('input[type="checkbox"]')).toBe(checkbox)
    expect(checkbox.checked).toBe(true)
    expect(browser.querySelector('[data-clue-browser-state]')?.getAttribute('data-clue-browser-state')).toBe('page')
    view.unmount()
  })

  it('does not search on an IME composition Enter', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId] })
    const view = mount(fx)
    await flush()
    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!
    typeInto(input, '设计')
    const composingEnter = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })
    const legacyComposingEnter = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true })
    act(() => { input.dispatchEvent(composingEnter); input.dispatchEvent(legacyComposingEnter) })
    await flush()
    expect(composingEnter.defaultPrevented).toBe(false)
    expect(legacyComposingEnter.defaultPrevented).toBe(false)
    expect(fx.calls.search).toBe(0)
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    act(() => { input.dispatchEvent(enter) })
    await flush()
    expect(enter.defaultPrevented).toBe(true)
    expect(fx.calls.search).toBe(1)
    view.unmount()
  })

  it('distinguishes a pin read failure from an empty library and retries in place', async () => {
    let failing = true
    let finish!: (failure: boolean) => void
    const fx = fixture({ workspaceId: 'ws-1', pinsError: () => failing ? true : new Promise(resolve => { finish = resolve }) })
    const view = mount(fx)
    await flush()
    expect(view.container.textContent).toContain('Could not load pinned clues')
    expect(view.container.textContent).not.toContain('Pin frequently used clues')
    expect(fx.calls.list).toBeGreaterThan(0)
    failing = false
    const retryButton = view.container.querySelector<HTMLButtonElement>('[role="alert"] button')!
    retryButton.focus()
    click(view.container, 'Retry')
    await flush()
    expect(retryButton.isConnected).toBe(true)
    expect(retryButton.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(retryButton)
    expect(view.container.querySelector('[role="alert"]')?.getAttribute('aria-busy')).toBe('true')
    await act(async () => { finish(false) })
    await flush()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Keyword, resource link or file path')
    expect(view.container.textContent).not.toContain('Could not load pinned clues')
    expect(view.container.textContent).not.toContain('Pin frequently used clues')
    view.unmount()
  })

  it('keeps the workbench mounted behind the clue help dialog', async () => {
    const fx = fixture({ workspaceId: 'ws-1' })
    const view = mount(fx)
    await flush()
    const browser = view.container.querySelector('[data-clue-browse-region]')
    click(view.container, 'Show clues help')
    await flush()
    const panel = document.body.querySelector<HTMLElement>('[data-clue-help]')!
    expect(panel).not.toBeNull()
    expect(panel.closest('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true')
    // The browser remains mounted behind the modal, so closing restores the exact surface.
    expect(view.container.querySelector('[data-clue-browse-region]')).toBe(browser)
    expect(browser?.closest('[data-clue-help]')).toBeNull()
    click(document.body, 'Close help')
    await flush()
    expect(view.container.querySelector('[data-clue-help]')).toBeNull()
    expect(view.container.querySelector('[data-clue-browse-region]')).toBe(browser)
    view.unmount()
  })
})

// ── browser trailing search, IME and row-menu regressions ────────────────────
//
// The browser debounces keyword typing (500 ms trailing) while direct resource
// links/paths stay explicit. The row menu is a real portal, so these cases
// assert the user-visible outcome (one wire request, one draft chip, the real
// collection window) rather than the timer/menu implementation details.

/** Wait past the browser's 500 ms trailing window with real (bounded) timers. */
async function waitTrailingWindow(ms = 550): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
  await flush()
}

/** The query input shared by every browser case. */
function browserQueryInput(container: ParentNode): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!
}

/** The resource row whose visible title is exactly `title`. */
function candidateRow(container: ParentNode, title: string): HTMLElement {
  const button = [...container.querySelectorAll('button')]
    .find(candidate => (candidate.textContent ?? '').trim() === title)
  const row = button?.closest('li')
  if (row === null || row === undefined) throw new Error(`candidate row "${title}" not found`)
  return row
}

/** Open one candidate's context menu through the real pointer path. */
async function openCandidateContextMenu(container: ParentNode, title: string): Promise<HTMLElement> {
  act(() => {
    candidateRow(container, title).dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 40, clientY: 60,
    }))
  })
  await flush()
  const menu = document.querySelector<HTMLElement>('[role="menu"]')
  if (menu === null) throw new Error('the candidate context menu did not open')
  return menu
}

/** Pick one item of the live menu portal by its visible label. */
function clickMenuItem(menu: HTMLElement, label: string): void {
  const item = [...menu.querySelectorAll('button')]
    .find(candidate => (candidate.textContent ?? '').trim() === label)
  if (item === undefined) throw new Error(`menu item "${label}" not found`)
  act(() => { item.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

/** One candidate row's selection checkbox. */
function candidateCheckbox(container: ParentNode, title: string): HTMLInputElement {
  enterSelection(container)
  const input = candidateRow(container, title).querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (input === null) throw new Error(`candidate checkbox "${title}" not found`)
  return input
}

describe('compact clue views and selection', () => {
  it('keeps pending query/filter, selection and scroll while collections are visible without hidden reads', async () => {
    const filters = [{ scopeKey: 'state', options: [{ id: 'all' }, { id: 'active', value: 'active' }] }]
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId], catalogSources: [{ ...FILES, filters }], listItems: selectionFiles.slice(0, 1) })
    const view = mount(fx)
    await flush()
    const browser = browserRegion(view.container)
    const input = browserQueryInput(view.container)
    const results = browser.querySelector<HTMLElement>('[data-clue-browser-state]')!
    selectResults(browser)
    const checkbox = candidateCheckbox(browser, 'First note')
    results.scrollTop = 87
    typeInto(input, 'unfinished')
    click(browser.querySelector('[data-clue-resource-filters]')!, t('clueResourceFilter'))
    clickMenuItem(document.querySelector<HTMLElement>('[role="menu"]')!, t('clueResourceStateActive'))
    await showView(view.container, 'packs')
    const reads = { ...fx.calls }
    const packSearch = view.container.querySelector<HTMLInputElement>('input[aria-label="Search clue packs"]')!
    typeInto(packSearch, 'Release')
    const packScroll = view.container.querySelector<HTMLElement>('[data-clue-pack-scroll]')!
    packScroll.scrollTop = 45
    await waitTrailingWindow()
    expect(fx.calls).toEqual(reads)
    await showView(view.container, 'browse')
    expect(browserQueryInput(view.container)).toBe(input)
    expect(input.value).toBe('unfinished')
    expect(checkbox.checked).toBe(true)
    expect(results.scrollTop).toBe(87)
    expect(browser.querySelector('[data-clue-resource-filters]')?.textContent).toContain(t('clueResourceStateActive'))
    await waitTrailingWindow()
    expect(fx.searchParams).toHaveLength(1)
    expect(fx.searchParams[0]).toMatchObject({ query: 'unfinished', scope: { state: 'active' } })
    const beforePacks = { ...fx.calls }
    await showView(view.container, 'packs')
    expect(packSearch.value).toBe('Release')
    expect(packScroll.scrollTop).toBe(45)
    await waitTrailingWindow()
    expect(fx.calls).toEqual(beforePacks)
    view.unmount()
  })

  it('restores each source pending filter and query together before its trailing search', async () => {
    const filters = [{ scopeKey: 'state', options: [{ id: 'all' }, { id: 'active', value: 'active' }] }]
    const fx = fixture({ workspaceId: 'ws-1', catalogSources: [{ ...FILES, filters }, GITHUB], listItems: selectionFiles.slice(0, 1) })
    fx.store.setPrefs({ ...fx.store.getPrefs(), pluginSettings: { clues: { scopes: { 'ws-1': { [GITHUB.sourceId]: { repo: 'acme/widgets' } } } } } })
    const view = mount(fx)
    await flush()
    const browser = browserRegion(view.container)
    typeInto(browserQueryInput(view.container), 'file draft')
    click(browser.querySelector('[data-clue-resource-filters]')!, t('clueResourceFilter'))
    clickMenuItem(document.querySelector<HTMLElement>('[role="menu"]')!, t('clueResourceStateActive'))
    chooseSource(browser, GITHUB.sourceId)
    await flush()
    await waitTrailingWindow()
    expect(fx.calls.search).toBe(0)
    chooseSource(browser, FILES.sourceId)
    await flush()
    expect(browserQueryInput(view.container).value).toBe('file draft')
    expect(browser.querySelector('[data-clue-resource-filters]')?.textContent).toContain(t('clueResourceStateActive'))
    await waitTrailingWindow()
    expect(fx.searchParams).toHaveLength(1)
    expect(fx.searchParams[0]).toMatchObject({ sourceId: FILES.sourceId, query: 'file draft', scope: { state: 'active' } })
    view.unmount()
  })

  it('keeps the selection footer stable at zero and lets review remove a chosen resource', async () => {
    const fx = fixture({ workspaceId: 'ws-1', listItems: selectionFiles.slice(0, 1) })
    const view = mount(fx)
    await flush()
    const browser = browserRegion(view.container)
    expect(browser.querySelector('input[type="checkbox"]')).toBeNull()
    enterSelection(browser)
    const footer = browser.querySelector<HTMLElement>('[role="region"][aria-label="0 selected"]')!
    expect(footer).not.toBeNull()
    expect(footer.querySelector<HTMLButtonElement>('[data-clue-selection-actions] button')!.disabled).toBe(true)
    const checkbox = candidateCheckbox(browser, 'First note')
    act(() => { checkbox.click() })
    expect(browser.querySelector('[role="region"][aria-label="1 selected"]')).toBe(footer)
    const review = footer.querySelector<HTMLDetailsElement>('[data-clue-selection-review]')!
    act(() => { review.querySelector('summary')!.click() })
    expect(review.open).toBe(true)
    click(review, t('clueSelectionRemove', { title: 'First note' }))
    expect(checkbox.checked).toBe(false)
    expect(browser.querySelector('[role="region"][aria-label="0 selected"]')).toBe(footer)
    expect(review.open).toBe(true)
    expect(fx.inserted).toHaveLength(0)
    view.unmount()
  })
})

describe('clue browser trailing query and row menu', () => {
  it('toggles only its own candidate through the native selection label without opening or inserting', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId], listItems: selectionFiles.slice(0, 2) })
    const view = mount(fx)
    await flush()
    const checkbox = candidateCheckbox(view.container, 'First note')
    const target = checkbox.closest('label')
    expect(target).not.toBeNull()
    expect(checkbox.getAttribute('aria-label')).toBe('Select First note')

    act(() => { target!.click() })
    expect(checkbox.checked).toBe(true)
    expect(candidateCheckbox(view.container, 'Second note').checked).toBe(false)
    expect(view.container.querySelector('[role="region"][aria-label="1 selected"]')).not.toBeNull()
    expect(fx.opened).toHaveLength(0)
    expect(fx.inserted).toHaveLength(0)

    act(() => { target!.click() })
    expect(checkbox.checked).toBe(false)
    expect(view.container.querySelector('[role="region"][aria-label="1 selected"]')).toBeNull()
    act(() => {
      target!.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 40, clientY: 60,
      }))
    })
    await flush()
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    expect(checkbox.checked).toBe(false)
    expect(fx.opened).toHaveLength(0)
    expect(fx.inserted).toHaveLength(0)
    view.unmount()
  })

  it('keeps row whitespace, title preview and insertion separate from the selection label', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId], listItems: selectionFiles.slice(0, 2) })
    const view = mount(fx)
    await flush()
    const first = candidateRow(view.container, 'First note')
    const selected = candidateCheckbox(view.container, 'Second note')
    act(() => { selected.click(); first.click() })
    expect(candidateCheckbox(view.container, 'First note').checked).toBe(false)
    expect(selected.checked).toBe(true)

    click(first, 'First note')
    await flush()
    expect(fx.opened.at(-1)).toMatchObject({ id: 'clue:c-a', title: 'First note' })
    expect(candidateCheckbox(view.container, 'First note').checked).toBe(false)
    expect(selected.checked).toBe(true)

    click(first, 'Insert First note')
    await flush()
    expect(fx.inserted).toHaveLength(1)
    expect(fx.inserted[0]).toMatchObject({ reference: { ref: 'c-a', clipboardText: '[[dsh-clue:c-a]]' } })
    expect(fx.opened).toHaveLength(1)
    expect(candidateCheckbox(view.container, 'First note').checked).toBe(false)
    expect(selected.checked).toBe(true)
    expect(view.container.querySelector('[role="region"][aria-label="1 selected"]')).not.toBeNull()
    view.unmount()
  })

  it('collapses two keystrokes inside 500 ms into one search with the final query', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId] })
    const view = mount(fx)
    await flush()
    const input = browserQueryInput(view.container)
    expect(fx.calls.search).toBe(0)

    // Two distinct change events far inside the 500 ms window: no leading
    // request may go out for the first one.
    typeInto(input, 'rel')
    typeInto(input, 'rele')
    expect(fx.calls.search).toBe(0)
    await waitTrailingWindow()

    expect(fx.calls.search).toBe(1)
    expect(fx.searchParams).toHaveLength(1)
    expect(fx.searchParams[0]).toMatchObject({ sourceId: FILES.sourceId, query: 'rele' })
    view.unmount()
  })

  it('does not search during an IME composition and searches the composed text after it ends', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId] })
    const view = mount(fx)
    await flush()
    const input = browserQueryInput(view.container)

    act(() => { input.dispatchEvent(new Event('compositionstart', { bubbles: true })) })
    typeInto(input, '设计')
    await waitTrailingWindow()
    expect(fx.calls.search).toBe(0)

    act(() => { input.dispatchEvent(new Event('compositionend', { bubbles: true })) })
    await waitTrailingWindow()
    expect(fx.calls.search).toBe(1)
    expect(fx.searchParams[0]).toMatchObject({ sourceId: FILES.sourceId, query: '设计' })

    // The trailing edge fired once; another window must not replay it.
    await waitTrailingWindow()
    expect(fx.calls.search).toBe(1)
    view.unmount()
  })

  it('runs an explicit Enter immediately and never replays it when the trailing window expires', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId] })
    const view = mount(fx)
    await flush()
    const input = browserQueryInput(view.container)
    typeInto(input, 'release notes')

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    act(() => { input.dispatchEvent(enter) })
    await flush()
    expect(enter.defaultPrevented).toBe(true)
    expect(fx.calls.search).toBe(1)
    expect(fx.searchParams[0]).toMatchObject({ sourceId: FILES.sourceId, query: 'release notes' })

    await waitTrailingWindow()
    expect(fx.calls.search).toBe(1)
    expect(fx.searchParams).toHaveLength(1)
    view.unmount()
  })

  it('cancels the queued query when the tab hides or the source changes', async () => {
    // Hiding the native tab body must clear the pending timer, not fire it.
    const hidden = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId] })
    const hiddenView = mount(hidden)
    await flush()
    typeInto(browserQueryInput(hiddenView.container), 'hidden draft')
    setVisible(hiddenView, hidden, false)
    await waitTrailingWindow()
    expect(hidden.calls.search).toBe(0)
    // Returning does not replay a view the hidden window already committed:
    // the query is still on the list view and starts a FRESH trailing window.
    setVisible(hiddenView, hidden, true)
    await flush()
    expect(hidden.calls.search).toBe(0)
    await waitTrailingWindow()
    expect(hidden.calls.search).toBe(1)
    expect(hidden.searchParams[0]).toMatchObject({ sourceId: FILES.sourceId, query: 'hidden draft' })
    hiddenView.unmount()

    // Switching source must not hand the old source's pending query to the new
    // active source (Feishu docs accepts a range-less search, so a leaked timer
    // would be visible as a real request).
    const switched = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId, FEISHU_DOCS.sourceId] })
    const switchedView = mount(switched)
    await flush()
    chooseSource(switchedView.container, FEISHU_DOCS.sourceId)
    await flush()
    typeInto(browserQueryInput(switchedView.container), 'design draft')
    chooseSource(switchedView.container, FILES.sourceId)
    await waitTrailingWindow()
    expect(switched.calls.search).toBe(0)
    expect(switched.searchParams.some(input => input.query === 'design draft')).toBe(false)
    switchedView.unmount()
  })

  it('opens the same collection window from detail with Add to pack before Insert', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId], listItems: selectionFiles.slice(0, 2) })
    const view = mount(fx)
    await flush()
    const row = candidateRow(view.container, 'First note')
    const title = row.querySelector<HTMLButtonElement>('button[title="First note"]')!
    act(() => { title.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    const detail = [...document.querySelectorAll<HTMLElement>('[data-floating-window]')]
      .find(node => node.querySelector('[data-clue-detail-insert]') !== null)
    expect(detail).toBeDefined()
    const add = detail!.querySelector<HTMLButtonElement>('[data-clue-detail-add-to-pack]')!
    const insert = detail!.querySelector<HTMLButtonElement>('[data-clue-detail-insert]')!
    // Reference actions are the rightmost pair, in this order; neither writes.
    expect(add.compareDocumentPosition(insert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    act(() => { add.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    // The tab's existing collection window/CAS flow is reused: the detail
    // footer itself performs no ensure/add-member write.
    const collection = collectionWindow()
    expect(collection.textContent).toContain('1 selected')
    expect(fx.ensureParams).toHaveLength(0)
    expect(fx.addMemberParams).toHaveLength(0)
    closeFloatingWindow('[data-clue-collection]')
    await flush()
    // Cancel writes nothing. The detail-opened window owns its target; it
    // does not create a browser tray selection as a side effect.
    expect(fx.addMemberParams).toHaveLength(0)
    expect(view.container.querySelector('[role="region"][aria-label="1 selected"]')).toBeNull()
    expect(document.querySelector('[data-clue-detail-insert]')).not.toBeNull()
    view.unmount()
  })

  it('previews from the context menu and inserts a draft chip from the keyboard menu', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId], listItems: selectionFiles })
    const view = mount(fx)
    await flush()

    // Pointer path: Preview is the same detail surface as the row title.
    const menu = await openCandidateContextMenu(view.container, 'First note')
    expect([...menu.querySelectorAll('button')].map(button => (button.textContent ?? '').trim()))
      .toEqual(expect.arrayContaining(['Preview', 'Insert resources', 'Add to pack', 'Pin', 'Copy']))
    clickMenuItem(menu, 'Preview')
    await flush()
    expect(fx.opened.at(-1)).toMatchObject({ id: 'clue:c-a', title: 'First note' })
    expect(document.querySelector('[data-floating-window]')).not.toBeNull()

    // Keyboard path: Shift+F10 opens the same menu; Insert only writes a chip.
    const windowsBeforeInsert = fx.opened.length
    act(() => {
      candidateRow(view.container, 'Second note').dispatchEvent(new KeyboardEvent('keydown', {
        key: 'F10', shiftKey: true, bubbles: true, cancelable: true,
      }))
    })
    await flush()
    const keyboardMenu = document.querySelector<HTMLElement>('[role="menu"]')
    expect(keyboardMenu).not.toBeNull()
    clickMenuItem(keyboardMenu!, 'Insert resources')
    await flush()

    expect(fx.inserted).toHaveLength(1)
    expect(fx.inserted[0]).toMatchObject({
      reference: {
        source: 'better-sidebar:clues',
        ref: 'c-b',
        clipboardText: '[[dsh-clue:c-b]]',
      },
    })
    // Insertion never opens a window and never sends; a stable candidate id
    // also skips the ensure round trip.
    expect(fx.opened).toHaveLength(windowsBeforeInsert)
    expect(fx.ensureParams).toHaveLength(0)
    view.unmount()
  })

  it('keeps a multi-selection on Add and narrows a non-selected row to itself', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId], listItems: selectionFiles })
    const view = mount(fx)
    await flush()
    enterSelection(view.container)

    act(() => {
      for (const checkbox of view.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
        checkbox.click()
      }
    })
    expect(view.container.querySelector('[role="region"][aria-label="3 selected"]')).not.toBeNull()

    // Right-click Add on a row that is PART of the group keeps the group.
    const groupMenu = await openCandidateContextMenu(view.container, 'First note')
    clickMenuItem(groupMenu, 'Add to pack')
    await flush()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    const groupCollection = collectionWindow()
    expect(groupCollection.closest('[data-floating-window]')).not.toBeNull()
    expect(groupCollection.textContent).toContain('3 selected')
    expect(fx.opened.at(-1)).toMatchObject({ title: 'Add to pack' })

    closeFloatingWindow('[data-clue-collection]')
    await flush()
    click(view.container, 'Cancel')
    await flush()
    expect(view.container.querySelector('[role="region"][aria-label="3 selected"]')).toBeNull()

    // Right-click Add on an UNSELECTED row selects exactly that row.
    const singleMenu = await openCandidateContextMenu(view.container, 'Second note')
    clickMenuItem(singleMenu, 'Add to pack')
    await flush()
    expect(collectionWindow().textContent).toContain('1 selected')
    expect(candidateCheckbox(view.container, 'First note').checked).toBe(false)
    expect(candidateCheckbox(view.container, 'Second note').checked).toBe(true)
    expect(candidateCheckbox(view.container, 'Third note').checked).toBe(false)
    view.unmount()
  })

  it('closes the row menu when the native tab hides', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId], listItems: selectionFiles })
    const view = mount(fx)
    await flush()
    expect(await openCandidateContextMenu(view.container, 'First note')).not.toBeNull()

    setVisible(view, fx, false)
    await flush()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    view.unmount()
  })
})


describe('UI19 browser request inputs', () => {
  it('waits a full 500ms trailing interval before searching', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId] })
    const view = mount(fx)
    await flush()
    typeInto(browserQueryInput(view.container), 'release')
    await waitTrailingWindow(350)
    expect(fx.calls.search).toBe(0)
    await waitTrailingWindow(220)
    expect(fx.calls.search).toBe(1)
    view.unmount()
  })

  it('starts a fresh cursor chain after refreshing an appended page', async () => {
    installIntersectionObserver()
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId], listResponse: async (_signal, input) => input.cursor === 'second'
      ? { items: [selectionFiles[1]!] }
      : { items: [selectionFiles[0]!], nextCursor: 'second' } })
    const view = mount(fx)
    await flush()
    const browser = view.container.querySelector<HTMLElement>('[data-clue-browse-region]')!
    intersect(browser)
    await flush()
    expect(browser.querySelectorAll('[data-clue-browser-state="page"] li')).toHaveLength(2)
    click(browser, 'Refresh')
    await flush()
    expect(browser.querySelector('[data-clue-refresh-status="error"]')).toBeNull()
    expect(browser.querySelectorAll('[data-clue-browser-state="page"] li')).toHaveLength(1)
    intersect(browser)
    await flush()
    expect(browser.querySelectorAll('[data-clue-browser-state="page"] li')).toHaveLength(2)
    expect(fx.calls.list).toBe(4)
    view.unmount()
  })

  it('enters file folders as a scope rather than opening an unreadable detail and offers Up', async () => {
    const folder: ClueCandidate = { sourceId: FILES.sourceId, typeId: 'builtin.files.directory', title: 'docs', locator: { root: { kind: 'workspace', workspaceId: 'ws-1' }, path: 'docs', dialect: 'posix' } }
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId], listItems: [folder] })
    const view = mount(fx)
    await flush()
    click(view.container, 'docs')
    await flush()
    expect(fx.opened).toHaveLength(0)
    expect(fx.listParams.at(-1)?.scope).toEqual({ locator: folder.locator })
    const up = view.container.querySelector<HTMLButtonElement>('[data-clue-scope-up]')
    expect(up).not.toBeNull()
    act(() => { up!.click() })
    await flush()
    expect(fx.listParams.at(-1)).not.toHaveProperty('scope')
    view.unmount()
  })
})


it('merges rapid quick filters with the final keyword into one provider search', async () => {
  const tasks = { ...FILES, filters: [
    { scopeKey: 'state', options: [{ id: 'all' }, { id: 'active', value: 'active' }] },
    { scopeKey: 'assigned', options: [{ id: 'all' }, { id: 'mine', value: true }] },
  ] }
  const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId], catalogSources: [tasks] })
  const view = mount(fx)
  await flush()
  const selects = view.container.querySelectorAll<HTMLButtonElement>('[data-clue-resource-filters] button[aria-haspopup="menu"]')
  act(() => { selects[0]!.click() })
  clickMenuItem(document.querySelector<HTMLElement>('[role="menu"]')!, 'Incomplete')
  await waitTrailingWindow(80)
  act(() => { selects[1]!.click() })
  clickMenuItem(document.querySelector<HTMLElement>('[role="menu"]')!, 'mine')
  typeInto(browserQueryInput(view.container), 'release')
  await waitTrailingWindow()
  expect(fx.calls.list).toBe(1)
  expect(fx.calls.search).toBe(1)
  expect(fx.searchParams[0]).toMatchObject({ query: 'release', scope: { state: 'active', assigned: true } })
  view.unmount()
})


it('hands a native-tree reveal the exact workspace locator without opening a detail', async () => {
  const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId], listItems: [selectionFiles[0]!] })
  const service = (fx.ctx as { get(name: string): { clues: BetterSidebarCluesClientFace } }).get('betterSidebar')
  const reveal = vi.fn()
  const detail = vi.fn()
  const view = renderRoot(createElement(ClueBrowser, {
    workspaceId: 'ws-1', face: service.clues, windows: fx.host, visible: true,
    scopes: {}, onScopeChange: () => {}, onOpenDetail: detail, onRevealFile: reveal,
    onInsertClue: () => true, onOpenSettings: () => {}, onNotice: () => {},
  }))
  await flush()
  const menu = await openCandidateContextMenu(view.container, 'First note')
  clickMenuItem(menu, t('clueBrowserRevealTree' as CopyKey))
  await flush()
  expect(reveal).toHaveBeenCalledExactlyOnceWith(selectionFiles[0])
  expect(detail).not.toHaveBeenCalled()
  expect(fx.opened).toHaveLength(0)
  view.unmount()
})


/** Supply only the host read/open seams used by the integrated reveal callback. */
function revealHostOf(fx: Fixture) {
  const ctx = fx.ctx as { get(name: string): unknown; sessions: object }
  const get = ctx.get
  const openTab = vi.fn()
  Object.assign(get('betterSidebar') as object, { openTab, isTabEnabled: () => true })
  Object.assign(ctx.sessions, { list: { getSnapshot: () => ({ byId: { s1: {}, s2: {} } }) } })
  const workspaces = get('workspaces') as { list: { getSnapshot(): Record<string, unknown> } }
  ctx.get = name => name === 'sidebarRight' ? { mounted: { getSnapshot: () => 's1' } }
    : name === 'workspaces' ? { list: { getSnapshot: () => ({ ...workspaces.list.getSnapshot(), archivedSessionIds: [] }) } } : get(name)
  fx.store.setSession('s1')
  return openTab
}

it('reveals a workspace-local candidate from CluesTab through the native files tree, not an editor detail', async () => {
  const candidate: ClueCandidate = {
    sourceId: FILES.sourceId, typeId: 'builtin.files.markdown', title: 'Reveal locally',
    locator: { root: { kind: 'workspace', workspaceId: 'ws-1' }, path: 'docs/nested/a.md', dialect: 'posix' },
  }
  const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId], listItems: [candidate] })
  const openTab = revealHostOf(fx)
  const cwd = vi.spyOn(sidebarApi, 'sessionCwd').mockResolvedValue({ sessionId: 's1', cwd: '/repo', root: '/repo', parent: null })
  const view = mount(fx)
  try {
    await flush()
    const menu = await openCandidateContextMenu(view.container, 'Reveal locally')
    clickMenuItem(menu, t('clueBrowserRevealTree' as CopyKey))
    await flush()
    expect(cwd).toHaveBeenCalledExactlyOnceWith({ sessionId: 's1' })
    expect(openTab).toHaveBeenCalledExactlyOnceWith({ type: 'editor' }, { sessionId: 's1', cwd: '/repo' })
    expect(fx.opened).toHaveLength(0)
    expect(fx.store.getSnapshot().state).toMatchObject({
      expanded: ['/repo/docs', '/repo/docs/nested'], revealed: ['/repo/docs/nested/a.md'],
    })
  } finally { view.unmount(); cwd.mockRestore() }
})

it('queues a candidate in its locator workspace session without changing the current conversation', async () => {
  const candidate: ClueCandidate = {
    sourceId: FILES.sourceId, typeId: 'builtin.files.markdown', title: 'Reveal elsewhere',
    locator: { root: { kind: 'workspace', workspaceId: 'ws-2' }, path: 'folder/a.md', dialect: 'posix' },
  }
  const fx = fixture({ workspaceId: 'ws-1', secondWorkspaceId: 'ws-2', enabled: [FILES.sourceId], listItems: [candidate] })
  const openTab = revealHostOf(fx)
  const cwd = vi.spyOn(sidebarApi, 'sessionCwd').mockResolvedValue({ sessionId: 's2', cwd: '/other', root: '/other', parent: null })
  const view = mount(fx)
  try {
    await flush()
    const menu = await openCandidateContextMenu(view.container, 'Reveal elsewhere')
    clickMenuItem(menu, t('clueBrowserRevealTree' as CopyKey))
    await flush()
    expect(openTab).toHaveBeenCalledExactlyOnceWith({ type: 'editor' }, { sessionId: 's2', cwd: '/other' })
    expect(fx.store.getSnapshot().sessionId).toBe('s1')
    expect(fx.store.getSnapshot().state!.revealed).toEqual([])
    expect(fx.store.getSessionState('s2')!.revealed).toEqual(['/other/folder/a.md'])
    expect(document.body.textContent).toContain(t('clueBrowserRevealQueued' as CopyKey))
  } finally { view.unmount(); cwd.mockRestore() }
})


it.each([
  ['external root', { root: { kind: 'external' }, path: '/repo/a.md', dialect: 'posix' }, '/repo', 'clueBrowserRevealUnavailable'],
  ['foreign dialect', { root: { kind: 'workspace', workspaceId: 'ws-1' }, path: 'a.md', dialect: 'win32' }, '/repo', 'clueBrowserRevealUnavailable'],
  ['linked worktree', { root: { kind: 'workspace', workspaceId: 'ws-1' }, path: 'a.md', dialect: 'posix' }, '/linked-worktree', 'clueBrowserRevealRootMismatch'],
] as const)('explains that %s cannot be located instead of claiming a tree reveal', async (_label, locator, root, notice) => {
  const candidate: ClueCandidate = { sourceId: FILES.sourceId, typeId: 'builtin.files.markdown', title: 'Cannot locate', locator }
  const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId], listItems: [candidate] })
  const openTab = revealHostOf(fx)
  const cwd = vi.spyOn(sidebarApi, 'sessionCwd').mockResolvedValue({ sessionId: 's1', cwd: root, root: '/repo', parent: null })
  const view = mount(fx)
  try {
    await flush()
    const menu = await openCandidateContextMenu(view.container, 'Cannot locate')
    clickMenuItem(menu, t('clueBrowserRevealTree' as CopyKey))
    await flush()
    expect(openTab).not.toHaveBeenCalled()
    expect(fx.store.getSnapshot().state!.revealed).toEqual([])
    expect(document.body.textContent).toContain(t(notice as CopyKey))
  } finally { view.unmount(); cwd.mockRestore() }
})


describe('explorer accordion (S9)', () => {
  it('opens both sections independently and persists the layout', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId] })
    const view = mount(fx)
    try {
      await flush()
      await showView(view.container, 'packs')
      click(view.container, t('clueViewBrowse'))
      await flush()
      expect(sectionOf(view.container, t('clueViewBrowse'))?.getAttribute('data-open')).toBe('true')
      expect(sectionOf(view.container, t('clueViewPacks'))?.getAttribute('data-open')).toBe('true')
      const layout = (fx.store.getPrefs().pluginSettings.clues as { layout?: unknown }).layout
      expect(layout).toEqual({ browse: true, packs: true })
    } finally {
      view.unmount()
    }
  })

  it('restores a persisted layout — including both collapsed', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId] })
    fx.store.setPrefs({
      ...fx.store.getPrefs(),
      pluginSettings: { clues: { layout: { browse: false, packs: false } } },
    })
    const view = mount(fx)
    try {
      await flush()
      expect(sectionOf(view.container, t('clueViewBrowse'))?.getAttribute('data-open')).toBe('false')
      expect(sectionOf(view.container, t('clueViewPacks'))?.getAttribute('data-open')).toBe('false')
      expect(fx.calls.list).toBe(0)
      expect(fx.calls.packsList).toBe(0)
      click(view.container, t('clueViewPacks'))
      await flush()
      expect(sectionOf(view.container, t('clueViewPacks'))?.getAttribute('data-open')).toBe('true')
      expect(fx.calls.packsList).toBe(1)
    } finally {
      view.unmount()
    }
  })

  it('restores the last source and remembers each explicit switch', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId, GITHUB.sourceId] })
    fx.store.setPrefs({
      ...fx.store.getPrefs(),
      pluginSettings: { clues: { activeSource: GITHUB.sourceId } },
    })
    const view = mount(fx)
    try {
      await flush()
      const tabs = [...view.container.querySelectorAll<HTMLButtonElement>('[data-clue-source-navigation] [role="tab"]')]
      expect(tabs.find(tab => tab.textContent?.includes('GitHub Issues'))?.getAttribute('aria-selected')).toBe('true')
      chooseSource(view.container, FILES.sourceId)
      await flush()
      expect((fx.store.getPrefs().pluginSettings.clues as { activeSource?: string }).activeSource).toBe(FILES.sourceId)
    } finally {
      view.unmount()
    }
  })

  it('closes one section without disturbing the other', async () => {
    const fx = fixture({ workspaceId: 'ws-1', enabled: [FILES.sourceId] })
    const view = mount(fx)
    try {
      await flush()
      click(view.container, t('clueViewPacks'))
      await flush()
      expect(sectionOf(view.container, t('clueViewBrowse'))?.getAttribute('data-open')).toBe('true')
      expect(sectionOf(view.container, t('clueViewPacks'))?.getAttribute('data-open')).toBe('true')
      click(view.container, t('clueViewPacks'))
      await flush()
      expect(sectionOf(view.container, t('clueViewPacks'))?.getAttribute('data-open')).toBe('false')
      expect(sectionOf(view.container, t('clueViewBrowse'))?.getAttribute('data-open')).toBe('true')
      const packsRegion = view.container.querySelector<HTMLElement>('[data-clue-pack-region]')!
      expect(packsRegion.closest('[hidden]')).not.toBeNull()
    } finally {
      view.unmount()
    }
  })
})
