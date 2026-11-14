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
 * - only "?" opens help, and closing returns focus to its trigger;
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
import { t, type CopyKey } from '../src/client/locales.ts'
import { CluesTab } from '../src/client/clues/tab/CluesTab.tsx'
import { api as sidebarApi } from '../src/client/api.ts'
import { clueHelpSeen, forgetClueHelpSeen, markClueHelpSeen } from '../src/client/clues/tab/help.tsx'
import { clearClueCollectionDrafts } from '../src/client/clues/windows/collect.tsx'
import { clearClueNotice } from '../src/client/clues/notify.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { createWindowHost } from '../src/client/windows/host.ts'
import { WindowHost } from '../src/client/windows/WindowHost.tsx'
import type { WindowHostController, WindowOpenOptions } from '../src/client/windows/types.ts'
import type { FormatRendererRegistry } from '../src/client/windows/format-content.tsx'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'
import { cluesApi, invalidateClueRequests } from '../src/client/clues/api.ts'
import { BUILTIN_SOURCE_IDS } from '../src/clues/types.ts'
import type {
  ClueCandidate, ClueDefaultScopeResult, ClueListResult, CluePack,
  ClueSourceDescriptor, CluesPacksResult, CluesPinsResult, CluesSourcesCatalogResult,
} from '../src/clues/types.ts'
// ── fixtures ────────────────────────────────────────────────────────────────
const hosts: WindowHostController[] = []
function source(sourceId: string, name: string, order: number): ClueSourceDescriptor {
  return {
    sourceId, name, order, pluginId: 'dsh-better-sidebar', types: [], transport: 'files',
    capabilities: { resolve: true, list: true, search: true, read: true, edit: false, portable: true },
  }
}
const FILES = source(BUILTIN_SOURCE_IDS.files, 'Local files', 0)
const GITHUB = source(BUILTIN_SOURCE_IDS.githubIssues, 'GitHub Issues', 10)
const FEISHU_DOCS = source(BUILTIN_SOURCE_IDS.feishuDocs, 'Feishu docs', 3)
function pack(id: string, name: string, members: string[]): CluePack {
  return {
    id, name, workspaceId: 'ws-1', members, revision: 1,
    createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:00.000Z',
  }
}
interface Calls { list: number; packsList: number; search: number; resolve: number; defaultScope: number }
/** The workspace clue library (the source of a pin's dereferenced locator). */
interface PinClues {
  clues: readonly { id: string; sourceId: string; typeId: string; title: string; locator: unknown }[]
  revision: number
}
/** The subset of the fixture API the pin regressions override per test. */
interface PinApi {
  pinsList: () => Promise<CluesPinsResult>
  pinsAdd: (workspaceId: string, input: Record<string, unknown>) => Promise<CluesPinsResult>
  pinsRemove: (workspaceId: string, input: Record<string, unknown>) => Promise<CluesPinsResult>
  clues: () => Promise<PinClues>
  ensure: (workspaceId: string, input: Record<string, unknown>) => Promise<{ clue: { id: string }; created: boolean }>
}
interface FixtureOptions {
  /** null = the session has NO workspace (the explicit empty state). */
  workspaceId?: string | null
  secondWorkspaceId?: string
  enabled?: string[]
  listItems?: ClueCandidate[]
  listError?: boolean
  searchError?: boolean
  packsError?: boolean
  resolveCandidates?: ClueCandidate[]
  listResponse?: (signal: AbortSignal | undefined, input: Record<string, unknown>) => Promise<ClueListResult>
  searchResponse?: (input: Record<string, unknown>) => Promise<ClueListResult>
  pinsError?: () => boolean | Promise<boolean>
  pins?: CluesPinsResult
  clues?: PinClues
  ensureResponse?: (input: Record<string, unknown>) => Promise<{ clue: { id: string }; created: boolean }>
  createResponse?: (input: Record<string, unknown>) => Promise<{ pack: CluePack; revision: number; packRevision: number }>
  addMemberResponse?: (input: Record<string, unknown>) => Promise<{ pack: CluePack; revision: number; packRevision: number }>
  defaultScopeResponse?: ClueDefaultScopeResult
  defaultScope?: (workspaceId: string, input: Record<string, unknown>, signal?: AbortSignal) => Promise<ClueDefaultScopeResult>
  catalogSources?: readonly ClueSourceDescriptor[]
  /** Use the REAL registry API (and therefore the shared read cache). */
  realApi?: boolean
  /** Persisted range tombstones for the ONE browse workspace ('ws-1'). */
  scopes?: Record<string, Record<string, unknown>>
  clueSettings?: Record<string, unknown>
}
type Fixture = ReturnType<typeof fixture>
function fixture(options: FixtureOptions = {}) {
  const calls: Calls = { list: 0, packsList: 0, search: 0, resolve: 0, defaultScope: 0 }
  const listParams: Record<string, unknown>[] = []
  const searchParams: Record<string, unknown>[] = []
  const resolveParams: Record<string, unknown>[] = []
  const ensureParams: Record<string, unknown>[] = []
  const createParams: Record<string, unknown>[] = []
  const addMemberParams: Record<string, unknown>[] = []
  const defaultScopeParams: Record<string, unknown>[] = []
  const inserted: unknown[] = []
  const pinned: string[] = []
  const opened: WindowOpenOptions[] = []
  const enabled = new Set(options.enabled ?? [FILES.sourceId, GITHUB.sourceId])
  const packs = [pack('p1', 'Release clues', ['c1', 'c2']), pack('p2', 'Design notes', [])]
  const workspaceId = options.workspaceId === null ? undefined : options.workspaceId ?? 'ws-1'
  const store = createSidebarStore()
  const clueSettings: Record<string, unknown> = { ...(options.clueSettings ?? {}) }
  if (options.scopes !== undefined) clueSettings.scopes = { 'ws-1': options.scopes }
  store.setPrefs({
    ...SIDEBAR_PREFS_DEFAULTS,
    pluginSettings: Object.keys(clueSettings).length === 0 ? {} : { clues: clueSettings },
  })
  const host = createWindowHost({ viewport: () => ({ width: 1280, height: 900 }) })
  hosts.push(host)
  const emptyPins: CluesPinsResult = { pins: [], revision: 0 }
  const api = {
    defaultScope: async (
      id: string, input: Record<string, unknown>, signal?: AbortSignal,
    ): Promise<ClueDefaultScopeResult> => {
      calls.defaultScope += 1
      defaultScopeParams.push(input)
      if (options.defaultScope !== undefined) return options.defaultScope(id, input, signal)
      return options.defaultScopeResponse ?? { reason: 'no-github-remote' as const }
    },
    sources: async (): Promise<CluesSourcesCatalogResult> => ({
      sources: (options.catalogSources ?? [FILES, FEISHU_DOCS, GITHUB])
        .map(candidate => ({ ...candidate, capabilities: { ...candidate.capabilities } })),
      types: [],
    }),
    read: async () => ({ format: 'text/markdown', data: { text: '# A note' }, fetchedAt: '2026-10-17T00:00:00Z' }),
    packsList: async (): Promise<CluesPacksResult> => {
      calls.packsList += 1
      if (options.packsError === true) throw new Error('packs failed')
      return { packs: [...packs], revision: 3 }
    },
    pinsList: async (): Promise<CluesPinsResult> => {
      if (await options.pinsError?.()) throw new Error('pins failed')
      return options.pins ?? emptyPins
    },
    pinsAdd: async (_id: string, input: { clueId: string }): Promise<CluesPinsResult> => {
      pinned.push(input.clueId)
      return { pins: [{ workspaceId: 'ws-1', clueId: input.clueId, createdAt: '' }], revision: 1 }
    },
    pinsRemove: async (): Promise<CluesPinsResult> => emptyPins,
    clues: async (): Promise<PinClues> => options.clues ?? { clues: [], revision: 0 },
    list: async (_id: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<ClueListResult> => {
      calls.list += 1
      listParams.push(input)
      if (options.listError === true) throw new Error('catalogue failed')
      return options.listResponse !== undefined ? options.listResponse(signal, input) : { items: options.listItems ?? [] }
    },
    search: async (_id: string, input: Record<string, unknown>): Promise<ClueListResult> => {
      calls.search += 1
      searchParams.push(input)
      if (options.searchError === true) throw new Error('search failed')
      return options.searchResponse !== undefined ? options.searchResponse(input) : { items: options.listItems ?? [] }
    },
    resolve: async (_id: string, input: Record<string, unknown>) => {
      calls.resolve += 1
      resolveParams.push(input)
      return { candidates: options.resolveCandidates ?? [] }
    },
    ensure: async (_id: string, input: Record<string, unknown>) => {
      ensureParams.push(input)
      return options.ensureResponse?.(input) ?? { clue: { id: 'c9' }, created: true }
    },
    packsCreate: async (_id: string, input: Record<string, unknown>) => {
      createParams.push(input)
      if (options.createResponse !== undefined) return options.createResponse(input)
      const created = pack('p3', String(input.name), input.members as string[] ?? [])
      packs.push(created)
      return { pack: created, revision: 4, packRevision: 1 }
    },
    packsAddMember: async (_id: string, input: Record<string, unknown>) => {
      addMemberParams.push(input)
      if (options.addMemberResponse !== undefined) return options.addMemberResponse(input)
      const index = packs.findIndex(candidate => candidate.id === input.packId)
      const previous = packs[index]!
      const target = { ...previous, members: [...previous.members, String(input.clueId)], revision: previous.revision + 1 }
      packs[index] = target
      return { pack: target, revision: 4, packRevision: target.revision }
    },
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
      open: (windowOptions: WindowOpenOptions) => {
        opened.push(windowOptions)
        return host.open(windowOptions)
      },
    },
  }
  const workspaces = {
    list: {
      getSnapshot: () => ({
        phase: 'ready', state: 'idle',
        items: [
          { path: '/repo', sessionIds: ['s1'], ...(workspaceId === undefined ? {} : { workspaceId }) },
          ...(options.secondWorkspaceId === undefined ? [] : [{
            path: '/other', sessionIds: ['s2'], workspaceId: options.secondWorkspaceId,
          }]),
        ],
      }),
    },
  }
  let draftRev = 1
  const conversation = {
    input: {
      for: () => ({
        state: {
          getSnapshot: () => ({
            draft: '', draftRev,
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
      scope: () => ({
        emit: (_name: string, payload: unknown) => {
          inserted.push(payload)
          draftRev += 1
        },
      }),
    },
  }
  return {
    store, ctx: ctx as never, host, calls, packs, listParams, searchParams, resolveParams,
    ensureParams, createParams, addMemberParams, defaultScopeParams, inserted, pinned, opened,
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
    constructor(public callback: IntersectionObserverCallback, public options?: IntersectionObserverInit) {
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
function liveObserverFor(region: ParentNode): FakeObserver | undefined {
  return [...fakeObservers].reverse().find(observer =>
    !observer.disconnected && observer.targets.some(target => region.contains(target)))
}
function observerFor(region: ParentNode): FakeObserver {
  const found = liveObserverFor(region)
  if (found === undefined) throw new Error('no live IntersectionObserver for this region')
  return found
}
function intersect(region: ParentNode): void {
  const observer = observerFor(region)
  act(() => {
    observer.callback([{ isIntersecting: true } as IntersectionObserverEntry], observer as unknown as IntersectionObserver)
  })
}
function scrollRootFor(region: ParentNode): HTMLElement {
  const root = observerFor(region).options?.root
  if (root === null || root === undefined) throw new Error('observer has no element root')
  return root as HTMLElement
}
/** The tab plus the REAL window host it opens windows into. */
function workbenchTree(fx: Fixture, visible: boolean, sessionId = 's1'): ReturnType<typeof createElement> {
  const service = (fx.ctx as { get(name: string): { clues: FormatRendererRegistry } }).get('betterSidebar')
  return createElement(Fragment, null,
    createElement(WindowHost, { host: fx.host, formats: service.clues }),
    createElement(CluesTab, { ctx: fx.ctx as never, store: fx.store, scope: { sessionId }, visible }),
  )
}
/** The mounted root of the LAST tree: a new mount replaces (and unmounts) it. */
let live: RenderedRoot | undefined
function mountTree(node: ReturnType<typeof createElement>): RenderedRoot {
  live?.unmount()
  live = renderRoot(node)
  return live
}
function mount(fx: Fixture, visible = true): RenderedRoot {
  return mountTree(workbenchTree(fx, visible))
}
async function mountTab(options: FixtureOptions = {}): Promise<{ fx: Fixture; view: RenderedRoot }> {
  const fx = fixture(options)
  const view = mount(fx)
  await flush()
  return { fx, view }
}
function savedScopes(fx: Fixture): Record<string, Record<string, unknown>> | undefined {
  return (fx.store.getPrefs().pluginSettings.clues as
    { scopes?: Record<string, Record<string, unknown>> } | undefined)?.scopes
}
function setScopes(fx: Fixture, scopes: Record<string, Record<string, unknown>>): void {
  act(() => {
    fx.store.setPrefs({ ...fx.store.getPrefs(), pluginSettings: { clues: { scopes: { 'ws-1': scopes } } } })
  })
}
beforeEach(() => {
  window.localStorage.clear()
  invalidateClueRequests()
  clearClueCollectionDrafts()
  markClueHelpSeen()
})
afterEach(() => {
  live?.unmount()
  live = undefined
  invalidateClueRequests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  clearClueNotice()
  Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
  act(() => {
    for (const host of hosts.splice(0)) host.dispose()
  })
  restoreObserver?.()
  restoreObserver = undefined
  fakeObservers = []
})
// ── dom helpers ─────────────────────────────────────────────────────────────
/** Ignore decorative glyphs when matching visible button labels. */
function buttonLabel(button: HTMLButtonElement): string {
  const content = button.cloneNode(true) as HTMLButtonElement
  for (const hidden of content.querySelectorAll('[aria-hidden="true"]')) hidden.remove()
  return (content.textContent ?? '').trim()
}
function click(container: ParentNode, label: string): void {
  const button = [...container.querySelectorAll('button')]
    .find(candidate => buttonLabel(candidate) === label || candidate.getAttribute('aria-label') === label)
  if (button === undefined) throw new Error('button "' + label + '" not found')
  act(() => { button.focus(); button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
function clickMatching(container: ParentNode, pattern: RegExp): void {
  const button = [...container.querySelectorAll('button')]
    .find(candidate => pattern.test(buttonLabel(candidate))
      || pattern.test(candidate.getAttribute('aria-label') ?? ''))
  if (button === undefined) throw new Error('button matching ' + String(pattern) + ' not found')
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
function floatingContent(marker: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(marker)
}
function requiredContent(marker: string): HTMLElement {
  const content = floatingContent(marker)
  if (content === null) throw new Error('floating content ' + marker + ' not found')
  return content
}
function scopeWindow(): HTMLElement {
  return requiredContent('[data-clue-scope-window]')
}
function collectionWindow(): HTMLElement {
  const form = requiredContent('[data-clue-collection]')
  return form.parentElement ?? form
}
function closeFloatingWindow(marker: string): void {
  const frame = floatingContent(marker)?.closest<HTMLElement>('[data-floating-window]')
  if (frame === null || frame === undefined) throw new Error('no floating frame for ' + marker)
  click(frame, 'Close')
}
function openScopeWindow(container: ParentNode): void {
  clickMatching(container, /^(Choose range|No range chosen yet)/)
}
function openCollectionWindow(container: ParentNode): void {
  click(container, 'Add to pack')
}
function browserRegion(container: ParentNode): HTMLElement {
  const browser = container.querySelector<HTMLElement>('[data-clue-browse-region]')
  if (browser === null) throw new Error('browser region not found')
  return browser
}
function browserQueryInput(container: ParentNode): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!
}
function workbenchSection(container: ParentNode, title: string): HTMLElement {
  const section = [...container.querySelectorAll<HTMLElement>('[data-workbench-section]')]
    .find(candidate => candidate.querySelector('h3')?.textContent?.includes(title) === true)
  if (section === undefined) throw new Error('workbench section "' + title + '" not found')
  return section
}
function toggleSection(section: HTMLElement): void {
  const toggle = section.querySelector<HTMLButtonElement>('h3 button')!
  act(() => { toggle.focus(); toggle.click() })
}
function sectionOf(container: ParentNode, title: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>('[data-workbench-section]')]
    .find(node => (node.querySelector('button')?.textContent ?? '').trim() === title)
}
/** Open one explorer section and close the other (the old tabs' exclusive switch). */
async function showView(container: ParentNode, value: 'browse' | 'packs'): Promise<void> {
  const title = value === 'browse' ? t('clueViewBrowse') : t('clueViewPacks')
  const other = value === 'browse' ? t('clueViewPacks') : t('clueViewBrowse')
  if (sectionOf(container, title)?.getAttribute('data-open') !== 'true') click(container, title)
  if (sectionOf(container, other)?.getAttribute('data-open') === 'true') click(container, other)
  await flush()
}
function setVisible(view: RenderedRoot, fx: Fixture, visible: boolean): void {
  view.rerender(workbenchTree(fx, visible))
}
function choose(group: ParentNode, value: string): void {
  const radio = [...group.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(input => input.value === value)
  if (radio === undefined) throw new Error('radio "' + value + '" not found')
  act(() => { radio.click() })
}
function chooseSource(container: ParentNode, sourceId: string): void {
  const labels: Record<string, string> = {
    [FILES.sourceId]: 'Local files', [GITHUB.sourceId]: 'GitHub Issues', [FEISHU_DOCS.sourceId]: 'Feishu docs',
  }
  const label = labels[sourceId] ?? sourceId
  const tab = [...container.querySelectorAll<HTMLButtonElement>('[data-clue-source-navigation] [role="tab"]')]
    .find(candidate => buttonLabel(candidate) === label)
  if (tab === undefined) throw new Error('missing source tab: ' + label)
  if (tab.getAttribute('aria-selected') !== 'true') act(() => { tab.click() })
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
function collectionForm(container: ParentNode): HTMLFormElement {
  const form = container.querySelector<HTMLFormElement>('[data-clue-collection]')
  if (form === null) throw new Error('collection form not found')
  return form
}
function destinationFieldset(form: ParentNode): HTMLFieldSetElement {
  const fieldset = form.querySelector<HTMLFieldSetElement>('fieldset[aria-label="Add to pack"]')
  if (fieldset === null) throw new Error('collection destination fieldset not found')
  return fieldset
}
function selectPackTarget(container: ParentNode, name: string): HTMLInputElement {
  const fieldset = destinationFieldset(collectionForm(container))
  const label = [...fieldset.querySelectorAll<HTMLElement>('label')]
    .find(candidate => candidate.title === name || (candidate.textContent ?? '').includes(name))
  const radio = label?.querySelector<HTMLInputElement>('input[type="radio"]')
  if (radio === undefined || radio === null) throw new Error('pack target radio "' + name + '" not found')
  act(() => { radio.focus(); radio.click() })
  return radio
}
function collectionSubmit(container: ParentNode): HTMLButtonElement {
  const submit = collectionForm(container).querySelector<HTMLButtonElement>('button[type="submit"]')
  if (submit === null) throw new Error('collection submit not found')
  return submit
}
function submitCollection(container: ParentNode): void {
  const submit = collectionSubmit(container)
  act(() => { submit.focus(); submit.click() })
}
function addToPack(container: ParentNode, name: string): void {
  selectPackTarget(container, name)
  if (buttonLabel(collectionSubmit(container)) !== 'Add to pack') throw new Error('collection submit is not Add to pack')
  submitCollection(container)
}
function startNewPack(container: ParentNode): HTMLInputElement {
  const radio = collectionForm(container).querySelector<HTMLInputElement>('input[type="radio"][value="__new"]')
  if (radio === null) throw new Error('new-pack radio not found')
  act(() => { radio.focus(); radio.click() })
  const input = collectionForm(container).querySelector<HTMLInputElement>('input[aria-label="Pack name"]')
  if (input === null) throw new Error('pack name input not found after selecting New')
  return input
}
/** Select results, open the collection window and return its content. */
async function selectionWindow(view: RenderedRoot): Promise<HTMLElement> {
  selectResults(view.container)
  openCollectionWindow(view.container)
  await flush()
  return collectionWindow()
}
async function rowAction(container: ParentNode, title: string, action: string): Promise<void> {
  click(container, t('clueBrowserMoreRow', { title }))
  await flush()
  clickMenuItem(document.querySelector<HTMLElement>('[role="menu"]')!, action)
}
function candidateRow(container: ParentNode, title: string): HTMLElement {
  const button = [...container.querySelectorAll('button')]
    .find(candidate => (candidate.textContent ?? '').trim() === title)
  const row = button?.closest('li')
  if (row === null || row === undefined) throw new Error('candidate row "' + title + '" not found')
  return row
}
function candidateCheckbox(container: ParentNode, title: string): HTMLInputElement {
  enterSelection(container)
  const input = candidateRow(container, title).querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (input === null) throw new Error('candidate checkbox "' + title + '" not found')
  return input
}
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
function clickMenuItem(menu: HTMLElement, label: string): void {
  const item = [...menu.querySelectorAll('button')]
    .find(candidate => (candidate.textContent ?? '').trim() === label)
  if (item === undefined) throw new Error('menu item "' + label + '" not found')
  act(() => { item.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
/** Wait past the browser's 500 ms trailing window with real (bounded) timers. */
async function waitTrailingWindow(ms = 550): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
  await flush()
}
/** The page shown when a list resolves with exactly one row. */
const singlePage = (): ClueListResult => ({
  items: [{ sourceId: FILES.sourceId, typeId: 'file', clueId: 'c-a', title: 'First note', locator: { path: 'a.md' } }],
})
/** One deferred list response observed at the fixture seam. */
interface PendingPage {
  readonly signal: AbortSignal | undefined
  resolve(result: ClueListResult): void
  reject(error: unknown): void
}
/** Stub the real /sidebar/api/* fetch routes and count reads per method. */
function stubApiFetch(values: Record<string, unknown>): (method: string) => number {
  const fetchMock = vi.fn(async (url: string) => {
    const method = String(url).split('?')[0]!.split('/sidebar/api/').at(-1) ?? ''
    const value = values[method] ?? { reason: 'no-github-remote' }
    return { ok: true, status: 200, json: async () => ({ ok: true, value }) } as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return method => fetchMock.mock.calls
    .filter(([url]) => String(url).split('?')[0]!.endsWith('/sidebar/api/' + method)).length
}
/** Supply only the host read/open seams used by the integrated reveal callback. */
function revealHostOf(fx: Fixture) {
  const ctx = fx.ctx as { get(name: string): unknown; sessions: object }
  const get = ctx.get
  const openTab = vi.fn()
  Object.assign(get('betterSidebar') as object, { openTab, isTabEnabled: () => true })
  Object.assign(ctx.sessions, { list: { getSnapshot: () => ({ byId: { s1: {}, s2: {} } }) } })
  const workspaces = get('workspaces') as { list: { getSnapshot(): Record<string, unknown> } }
  ctx.get = name => name === 'sidebarRight' ? { mounted: { getSnapshot: () => 's1' } }
    : name === 'workspaces'
      ? { list: { getSnapshot: () => ({ ...workspaces.list.getSnapshot(), archivedSessionIds: [] }) } }
      : get(name)
  fx.store.setSession('s1')
  return openTab
}
function pinApiOf(fx: Fixture): PinApi {
  const service = (fx.ctx as { get(name: string): unknown }).get('betterSidebar') as { clues: { api: PinApi } }
  return service.clues.api
}
// ── tests ───────────────────────────────────────────────────────────────────
describe('clue tab main page', () => {
  it('renders source identity icons and the built-in files label in Chinese', async () => {
    Object.defineProperty(navigator, 'language', { value: 'zh-CN', configurable: true })
    const { view } = await mountTab()
    const nav = view.container.querySelector<HTMLElement>('[data-clue-source-navigation]')!
    const tabs = [...nav.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabs[0]?.textContent).toContain('本地文件')
    expect(nav.textContent).not.toContain('Local files')
    expect(tabs.every(tab => tab.querySelector('[aria-hidden="true"]') !== null)).toBe(true)
  })
  it('defaults to resources and reads only the visible mounted view', async () => {
    const { fx, view } = await mountTab()
    const query = browserQueryInput(view.container)
    expect(sectionOf(view.container, t('clueViewPacks'))?.getAttribute('data-open')).toBe('false')
    expect(sectionOf(view.container, t('clueViewBrowse'))?.getAttribute('data-open')).toBe('true')
    expect(fx.calls).toMatchObject({ packsList: 0, list: 1 })
    await showView(view.container, 'packs')
    expect(sectionOf(view.container, t('clueViewPacks'))?.getAttribute('data-open')).toBe('true')
    expect(fx.calls).toMatchObject({ packsList: 1, list: 1 })
    await showView(view.container, 'browse')
    expect(browserQueryInput(view.container)).toBe(query)
    expect(fx.calls).toMatchObject({ packsList: 1, list: 1 })
  })
  it('shows the explicit empty state without a workspace and never queries', async () => {
    const { fx, view } = await mountTab({ workspaceId: null })
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('This session has no workspace yet')
    }, { timeout: 3_000 })
    expect(fx.calls).toMatchObject({ list: 0, search: 0 })
  })
  it('shows first-visit help, reopens it with the question control and only remembers it on close', async () => {
    forgetClueHelpSeen()
    const { fx, view } = await mountTab()
    const guide = (): HTMLElement | null => document.body.querySelector<HTMLElement>('[data-clue-help]')
    expect(guide()!.querySelectorAll('[data-clue-help-step]')).toHaveLength(3)
    expect(clueHelpSeen()).toBe(false)
    click(document.body, 'Close help')
    await flush()
    expect(guide()).toBeNull()
    expect(clueHelpSeen()).toBe(true)
    const trigger = view.container.querySelector<HTMLButtonElement>('button[aria-label="Show clues help"]')!
    expect(document.activeElement).toBe(trigger)
    click(view.container, 'Show clues help')
    await flush()
    mount(fx)
    await flush()
    expect(guide()).toBeNull()
  })
  it('locks the workspace switch while an owned task window is open, except for host-owned collections', async () => {
    const candidate: ClueCandidate = {
      sourceId: FILES.sourceId, typeId: 'file', clueId: 'c-lock', title: 'Locked note', locator: { path: 'locked.md' },
    }
    const { fx, view } = await mountTab({ secondWorkspaceId: 'ws-2', enabled: [FILES.sourceId], listItems: [candidate] })
    const selectOf = (): HTMLButtonElement => view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Switch browse workspace"]',
    )!
    expect(selectOf().disabled).toBe(false)
    openScopeWindow(browserRegion(view.container))
    await flush()
    expect(selectOf().disabled).toBe(true)
    closeFloatingWindow('[data-clue-scope-window]')
    await flush()
    expect(selectOf().disabled).toBe(false)
    selectResults(view.container)
    openCollectionWindow(view.container)
    await flush()
    const name = startNewPack(collectionWindow())
    typeInto(name, 'Owner-safe draft')
    expect(selectOf().disabled).toBe(false)
    view.rerender(workbenchTree(fx, true, 's2'))
    await flush()
    expect(name.value).toBe('Owner-safe draft')
    expect(selectOf().textContent).toContain('/other')
  })
  it('performs no query while the tab body is hidden', async () => {
    const fx = fixture()
    mount(fx, false)
    await flush()
    expect(fx.calls).toMatchObject({ list: 0, packsList: 0, search: 0 })
  })
})
describe('clue tab source browser', () => {
  it('persists an explicit GitHub range per workspace and lists with it', async () => {
    const { fx, view } = await mountTab({ enabled: [GITHUB.sourceId] })
    expect(fx.calls.list).toBe(0)
    openScopeWindow(view.container)
    await flush()
    const scope = scopeWindow()
    expect(view.container.contains(scope)).toBe(false)
    expect([...scope.querySelectorAll<HTMLInputElement>('fieldset input[type="radio"]')].map(input => input.value))
      .toEqual(['open', 'closed', 'all'])
    typeInto(scope.querySelector<HTMLInputElement>('input[placeholder="owner/repo or repository URL"]')!, 'acme/widgets')
    click(scope, 'Save range')
    await flush()
    expect(savedScopes(fx)?.['ws-1']?.[GITHUB.sourceId]).toEqual({ repo: 'acme/widgets', state: 'open' })
    expect(fx.listParams[0]).toMatchObject({ sourceId: GITHUB.sourceId, scope: { repo: 'acme/widgets', state: 'open' } })
  })
  it('applies a detected GitHub range as display-only and prefers an explicit one', async () => {
    const detected = await mountTab({
      enabled: [GITHUB.sourceId], defaultScopeResponse: { scope: { repo: 'acme/widgets', state: 'open' } },
    })
    expect(detected.fx.calls.defaultScope).toBe(1)
    expect(detected.fx.listParams[0]).not.toHaveProperty('scope')
    expect(detected.view.container.textContent).toContain('acme/widgets')
    expect(savedScopes(detected.fx)).toBeUndefined()
    const explicit = await mountTab({
      enabled: [GITHUB.sourceId],
      scopes: { [GITHUB.sourceId]: { repo: 'explicit/range', state: 'closed' } },
      defaultScopeResponse: { scope: { repo: 'auto/detected', state: 'open' } },
    })
    expect(explicit.fx.calls.defaultScope).toBe(0)
    expect(explicit.fx.listParams[0]).toMatchObject({ scope: { repo: 'explicit/range', state: 'closed' } })
    expect(explicit.view.container.textContent).not.toContain('auto/detected')
  })
  it('scopes Feishu ranges: radio kinds persist a wiki range, browse-only roots cannot search', async () => {
    const { fx, view } = await mountTab({
      enabled: [FEISHU_DOCS.sourceId], scopes: { [FEISHU_DOCS.sourceId]: { kind: 'drive-root' } },
    })
    typeInto(browserQueryInput(view.container), 'design')
    click(view.container, 'Search')
    await flush()
    expect(fx.calls.search).toBe(0)
    expect(view.container.textContent).toContain('Choose a specific folder or wiki space before searching.')
    openScopeWindow(view.container)
    await flush()
    const scope = scopeWindow()
    const choices = scope.querySelector('fieldset')!
    expect([...choices.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map(input => input.value))
      .toEqual(['drive-root', 'drive', 'wiki', 'wiki-spaces'])
    choose(choices, 'wiki')
    typeInto(scope.querySelector<HTMLInputElement>('input[placeholder="space id (my_library = personal library)"]')!, 'space-42')
    click(scope, 'Save range')
    await flush()
    expect(fx.searchParams.at(-1)?.scope).toEqual({ kind: 'wiki', spaceId: 'space-42' })
    const global = await mountTab({ enabled: [FEISHU_DOCS.sourceId] })
    typeInto(browserQueryInput(global.view.container), 'design')
    click(global.view.container, 'Search')
    await flush()
    expect(global.fx.searchParams[0]).not.toHaveProperty('scope')
    expect(global.view.container.querySelector('[data-clue-global-search]')?.textContent)
      .toContain('searching all documents visible to this account')
  })
  it('merges a later pack-window range with the newer range the tab just chose', async () => {
    const { fx, view } = await mountTab({
      enabled: [FILES.sourceId, GITHUB.sourceId], scopes: { [FILES.sourceId]: { path: 'old' } },
    })
    await showView(view.container, 'packs')
    click(view.container, 'Manage pack: Release clues')
    await flush()
    const packWindow = requiredContent('[data-clue-pack-window]')
    click(packWindow, 'Insert pack reference')
    await flush()
    expect(fx.inserted[0]).toMatchObject({ reference: { clipboardText: '[[dsh-cluepack:p1]]' } })
    await showView(view.container, 'browse')
    click(view.container, 'Choose range: old')
    await flush()
    const scope = scopeWindow()
    typeInto(scope.querySelector<HTMLInputElement>('input[placeholder="e.g. docs/"]')!, 'new')
    click(scope, 'Save range')
    await flush()
    expect(savedScopes(fx)?.['ws-1']?.[FILES.sourceId]).toEqual({ path: 'new' })
    click(packWindow, 'Add members')
    await flush()
    chooseSource(packWindow, GITHUB.sourceId)
    await flush()
    click(packWindow, 'Choose range')
    await flush()
    typeInto(packWindow.querySelector<HTMLInputElement>('input[placeholder="owner/repo or repository URL"]')!, 'acme/widgets')
    click(packWindow, 'Save range')
    await flush()
    expect(savedScopes(fx)?.['ws-1']?.[FILES.sourceId]).toEqual({ path: 'new' })
    expect(savedScopes(fx)?.['ws-1']?.[GITHUB.sourceId]).toEqual({ repo: 'acme/widgets', state: 'open' })
  })
  it('persists a cleared files range as an explicit tombstone and reads it as no range', async () => {
    const { fx, view } = await mountTab({ enabled: [FILES.sourceId], scopes: { [FILES.sourceId]: { path: 'docs' } } })
    click(view.container, 'Choose range: docs')
    await flush()
    const pathInput = scopeWindow().querySelector<HTMLInputElement>('input[placeholder="e.g. docs/"]')!
    expect(pathInput.value).toBe('docs')
    typeInto(pathInput, '')
    click(scopeWindow(), 'Save range')
    await flush()
    expect(savedScopes(fx)?.['ws-1']?.[FILES.sourceId]).toBeNull()
    expect(fx.listParams.at(-1)).not.toHaveProperty('scope')
    expect(view.container.textContent).toContain('Workspace root')
  })
  it('keeps search controls inside one frame, refreshes the query and clears back to listing', async () => {
    const { fx, view } = await mountTab({ searchResponse: async () => ({ items: selectionFiles }) })
    const browser = browserRegion(view.container)
    const input = browserQueryInput(view.container)
    const frame = input.closest<HTMLElement>('[role="search"]')!
    const submit = frame.querySelector<HTMLButtonElement>('button')!
    typeInto(input, 'release notes')
    const clear = frame.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!
    click(frame, 'Search')
    await flush()
    expect(fx.searchParams.at(-1)).toMatchObject({ sourceId: FILES.sourceId, query: 'release notes' })
    click(browser, 'Refresh')
    await flush()
    expect(input.value).toBe('release notes')
    expect(fx.calls.search).toBe(2)
    expect(fx.searchParams.at(-1)).not.toHaveProperty('cursor')
    expect(clear.closest('[role="search"]')).toBe(frame)
    click(frame, 'Clear search')
    await flush()
    expect(input.value).toBe('')
    expect(frame.querySelector('button')).toBe(submit)
    expect(document.activeElement).toBe(input)
    expect(fx.calls.list).toBe(2)
  })
  it('appends at the sentinel without dropping rows/focus, and a refresh starts a fresh cursor chain', async () => {
    installIntersectionObserver()
    const firstPage: ClueCandidate[] = Array.from({ length: 25 }, (_, index) => ({
      sourceId: FILES.sourceId, typeId: 'file', title: 'Note ' + (index + 1), locator: { path: 'note-' + (index + 1) + '.md' },
    }))
    const secondPage: ClueCandidate[] = Array.from({ length: 5 }, (_, index) => ({
      sourceId: FILES.sourceId, typeId: 'file', title: 'Later ' + (index + 1), locator: { path: 'later-' + (index + 1) + '.md' },
    }))
    let resolveAppend: ((result: ClueListResult) => void) | undefined
    const fx = fixture({
      enabled: [FILES.sourceId],
      listResponse: (_signal, input) => {
        if (input.cursor === 'page-two') return new Promise<ClueListResult>(resolve => { resolveAppend = resolve })
        return Promise.resolve({ items: firstPage, nextCursor: 'page-two' })
      },
    })
    const view = mount(fx)
    await flush()
    const browser = browserRegion(view.container)
    const focusTarget = browser.querySelector<HTMLButtonElement>('button[aria-label="Insert Note 1"]')!
    act(() => { focusTarget.focus() })
    intersect(browser)
    await flush()
    expect(browser.querySelectorAll('[data-clue-browser-state="page"] li')).toHaveLength(25)
    expect(document.activeElement).toBe(focusTarget)
    resolveAppend!({ items: secondPage })
    await flush()
    expect(browser.querySelectorAll('[data-clue-browser-state="page"] li')).toHaveLength(30)
    expect(document.activeElement).toBe(focusTarget)
    expect(liveObserverFor(browser)).toBeUndefined()
    click(browser, 'Refresh')
    await flush()
    expect(browser.querySelectorAll('[data-clue-browser-state="page"] li')).toHaveLength(25)
    intersect(browser)
    await flush()
    resolveAppend!({ items: secondPage })
    await flush()
    expect(browser.querySelectorAll('[data-clue-browser-state="page"] li')).toHaveLength(30)
    expect(fx.calls.list).toBe(4)
  })
  it('ignores repeat triggers while appending and offers a manual Retry after failure', async () => {
    installIntersectionObserver()
    let rejectAppend!: (error: unknown) => void
    let resolveAppend!: (result: ClueListResult) => void
    const { fx, view } = await mountTab({
      enabled: [FILES.sourceId],
      listResponse: (_signal, input) => {
        if (input.cursor !== 'page-two') return Promise.resolve({ items: selectionFiles, nextCursor: 'page-two' })
        return new Promise<ClueListResult>((resolve, reject) => {
          resolveAppend = resolve
          rejectAppend = reject
        })
      },
    })
    const browser = browserRegion(view.container)
    const scrollRoot = scrollRootFor(browser)
    intersect(browser)
    await flush()
    expect(fx.calls.list).toBe(2)
    intersect(browser)
    await act(async () => { scrollRoot.dispatchEvent(new Event('scroll')) })
    await flush()
    expect(fx.calls.list).toBe(2)
    await act(async () => { rejectAppend(new Error('append failed')) })
    await flush()
    expect(browser.querySelectorAll('[data-clue-browser-state="page"] li')).toHaveLength(3)
    expect(browser.textContent).toContain('Failed to load')
    expect(liveObserverFor(browser)).toBeUndefined()
    const callsAfterFailure = { ...fx.calls }
    act(() => { scrollRoot.dispatchEvent(new Event('scroll')) })
    await flush()
    expect(fx.calls).toEqual(callsAfterFailure)
    click(browser, 'Retry')
    await flush()
    resolveAppend({ items: [{ sourceId: FILES.sourceId, typeId: 'file', title: 'Recovered note', locator: { path: 'recovered.md' } }] })
    await flush()
    expect(fx.calls.list).toBe(callsAfterFailure.list + 1)
    expect(browser.querySelectorAll('[data-clue-browser-state="page"] li')).toHaveLength(4)
  })
  it('resolves a pasted URL before any range is chosen and inserts a stable chip', async () => {
    const candidate: ClueCandidate = {
      sourceId: GITHUB.sourceId, typeId: 'builtin.github.issue',
      locator: { host: 'github.com', owner: 'acme', repo: 'widgets', kind: 'issue', number: 7 },
      title: 'Fix the widget',
    }
    const { fx, view } = await mountTab({ enabled: [GITHUB.sourceId], resolveCandidates: [candidate] })
    expect(view.container.textContent).toContain('No GitHub repository was detected in this workspace. Choose a repository.')
    expect([...view.container.querySelectorAll('button')]
      .some(button => /^Choose range/.test(buttonLabel(button))
        || /^Choose range/.test(button.getAttribute('aria-label') ?? ''))).toBe(true)
    expect(fx.calls.list).toBe(0)
    typeInto(browserQueryInput(view.container), 'https://github.com/acme/widgets/issues/7')
    click(view.container, 'Resolve')
    await flush()
    expect(fx.calls).toMatchObject({ resolve: 1, list: 0 })
    expect(view.container.querySelector('[data-clue-browser-state]')?.getAttribute('data-clue-browser-state')).toBe('resolved')
    click(view.container, 'Insert Fix the widget')
    await flush()
    expect(fx.inserted[0]).toMatchObject({
      reference: { source: 'better-sidebar:clues', clipboardText: '[[dsh-clue:c9]]', appearance: 'file' },
    })
  })
  it('shows Unpin for a pinned library locator without a candidate clueId, and keeps the bar mounted', async () => {
    const candidate: ClueCandidate = {
      sourceId: FILES.sourceId, typeId: 'builtin.files.markdown', locator: { path: 'docs/a.md' }, title: 'A note',
    }
    const fx = fixture({
      enabled: [FILES.sourceId], listItems: [candidate],
      pins: { pins: [{ workspaceId: 'ws-1', clueId: 'c9', createdAt: '' }], revision: 1 },
      clues: {
        clues: [{
          id: 'c9', sourceId: FILES.sourceId, typeId: 'builtin.files.markdown',
          title: 'A note', locator: { path: 'docs/a.md' },
        }],
        revision: 1,
      },
    })
    const view = mount(fx)
    await flush()
    const api = pinApiOf(fx)
    let pins: CluesPinsResult['pins'] = [{ workspaceId: 'ws-1', clueId: 'c9', createdAt: '' }]
    const removes: Record<string, unknown>[] = []
    const adds: Record<string, unknown>[] = []
    api.pinsList = async () => ({ pins, revision: 6 })
    api.pinsRemove = async (_workspaceId, input) => {
      removes.push(input)
      pins = []
      return { pins, revision: 7 }
    }
    api.pinsAdd = async (_workspaceId, input) => {
      adds.push(input)
      pins = [{ workspaceId: 'ws-1', clueId: String(input.clueId), createdAt: '' }]
      return { pins, revision: 8 }
    }
    expect(view.container.querySelector('button[aria-label="Pin A note"]')).toBeNull()
    expect(candidateRow(view.container, 'A note').getAttribute('data-pinned')).toBe('true')
    await rowAction(view.container, 'A note', t('clueBrowserUnpin'))
    await flush()
    expect(removes[0]).toMatchObject({ clueId: 'c9' })
    expect(candidateRow(view.container, 'A note').getAttribute('data-pinned')).toBe('false')
    await rowAction(view.container, 'A note', t('clueBrowserPin'))
    await flush()
    expect(adds[0]).toMatchObject({ clueId: 'c9', expectedRevision: 6 })
    const section = workbenchSection(browserRegion(view.container), 'Pinned')
    expect(section.textContent).toContain('A note')
    toggleSection(section)
    expect(section.getAttribute('data-open')).toBe('false')
    expect(section.textContent).toContain('A note')
  })
  it('shows pack/search/page failures as retryable errors instead of empty results', async () => {
    const packsFail = await mountTab({ packsError: true })
    await showView(packsFail.view.container, 'packs')
    expect(packsFail.view.container.querySelector('[role="alert"]')?.textContent).toContain('Failed to load')
    expect([...packsFail.view.container.querySelectorAll('button')].some(button => buttonLabel(button) === 'Retry')).toBe(true)
    const searchFail = await mountTab({ searchError: true })
    typeInto(browserQueryInput(searchFail.view.container), 'release notes')
    click(searchFail.view.container, 'Search')
    await flush()
    const listBefore = searchFail.fx.calls.list
    click(searchFail.view.container, 'Retry')
    await flush()
    expect(searchFail.fx.calls).toMatchObject({ search: 2, list: listBefore })
    const listFail = await mountTab({ listError: true })
    const failed = listFail.view.container.querySelector<HTMLElement>('[data-clue-browser-state="error"]')!
    expect(failed.textContent).toContain('Failed to load')
  })
})
describe('clue browser loading and precise refresh', () => {
  it('shows a result placeholder, keeps the page through refresh, and reports a denied refresh', async () => {
    const pending: PendingPage[] = []
    const { view } = await mountTab({
      listResponse: signal => new Promise((resolve, reject) => { pending.push({ signal, resolve, reject }) }),
    })
    const browser = browserRegion(view.container)
    const query = browserQueryInput(view.container)
    const loading = browser.querySelector<HTMLElement>('[data-clue-browser-state="loading"]')
    expect(loading?.querySelector('[data-loading-indicator]')).not.toBeNull()
    expect(loading?.contains(query)).toBe(false)
    await act(async () => { pending[0]!.resolve(singlePage()) })
    await flush()
    const results = browser.querySelector<HTMLElement>('[data-clue-browser-state="page"]')!
    expect(browser.querySelector('li')?.textContent).toContain('First note')
    enterSelection(browser)
    act(() => { browser.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click() })
    results.scrollTop = 40
    click(browser, 'Refresh')
    await flush()
    expect(browser.querySelector('[data-clue-browser-state="page"]')).toBe(results)
    expect(browser.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true)
    expect(results.scrollTop).toBe(40)
    expect(browser.querySelector('[data-clue-refresh-status="refreshing"]')).not.toBeNull()
    await act(async () => {
      pending[1]!.reject(Object.assign(new Error('no access'), { code: 'permission-denied' }))
    })
    await flush()
    expect(browser.querySelectorAll('[data-clue-browser-state="page"] li')).toHaveLength(1)
    const error = browser.querySelector<HTMLElement>('[data-clue-refresh-status="error"]')!
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent).toContain('Insufficient permissions')
  })
  it('starts one default-range read and one page read on the first visit even when readiness turns ready', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const value = url.includes('dependencies.inspect')
        ? { dependencies: [{
            dependencyId: 'github.cli', name: 'GitHub CLI', command: 'gh', state: 'ready',
            platform: 'darwin', arch: 'arm64', supported: true, installable: true,
            minimumVersion: '2.0.0', recommendedVersion: '2.0.0',
          }] }
        : { connections: [{
            connectionId: 'github.account', name: 'GitHub', pluginId: 'test',
            configuration: 'ready', authorization: 'ready', credentialOwner: 'tool',
            capabilities: [], action: 'none',
          }] }
      return { ok: true, json: async () => ({ ok: true, value }) } as Response
    }))
    const { fx } = await mountTab({
      enabled: [GITHUB.sourceId],
      catalogSources: [{ ...GITHUB, dependencyIds: ['github.cli'], connectionId: 'github.account' }],
      defaultScopeResponse: { scope: { repo: 'acme/widgets', state: 'open' } },
    })
    await flush()
    expect(fx.calls).toMatchObject({ defaultScope: 1, list: 1 })
  })
})
describe('clue selection confirmation', () => {
  it('keeps the action bar compact and commits the collection through one explicit submit', async () => {
    const { fx, view } = await mountTab({ listItems: selectionFiles.slice(0, 2) })
    expect(view.container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    selectResults(view.container)
    expect(view.container.querySelector('[data-clue-collection]')).toBeNull()
    expect(view.container.querySelector('[data-clue-selection-review]')).not.toBeNull()
    const bar = view.container.querySelector<HTMLElement>('[role="region"][aria-label="2 selected"]')!
    expect([...bar.querySelectorAll<HTMLButtonElement>('[data-clue-selection-actions] button')].map(buttonLabel))
      .toEqual(['Add to pack', 'Insert resources'])
    const reads = fx.calls.packsList
    openCollectionWindow(view.container)
    await flush()
    const collection = collectionWindow()
    expect(view.container.contains(collection)).toBe(false)
    expect(fx.calls.packsList).toBe(reads + 1)
    const count = collection.querySelector<HTMLElement>('[data-clue-collection-selection]')!
    expect(count.textContent).toContain('2 selected')
    expect(collectionSubmit(collection).disabled).toBe(true)
    expect(fx.addMemberParams).toEqual([])
    closeFloatingWindow('[data-clue-collection]')
    await flush()
    openCollectionWindow(view.container)
    await flush()
    expect(collectionWindow().textContent).toContain('2 selected')
    expect(selectPackTarget(collectionWindow(), 'Release clues').checked).toBe(true)
    expect(collectionSubmit(collectionWindow()).disabled).toBe(false)
    click(collectionWindow(), 'Cancel')
    await flush()
    expect(floatingContent('[data-clue-collection]')).toBeNull()
    expect(fx.addMemberParams).toEqual([])
    expect(view.container.querySelector('[role="region"][aria-label="2 selected"]')).not.toBeNull()
    openCollectionWindow(view.container)
    await flush()
    const beforeSubmit = fx.calls.packsList
    addToPack(collectionWindow(), 'Release clues')
    await flush()
    expect(fx.addMemberParams).toEqual([
      { packId: 'p1', clueId: 'c-a' },
      { packId: 'p1', clueId: 'c-b', expectedRevision: 2 },
    ])
    await showView(view.container, 'packs')
    expect(fx.calls.packsList).toBe(beforeSubmit + 1)
    expect(view.container.querySelector('[data-clue-pack-region]')?.textContent).toContain('4 members')
    expect(view.container.querySelector('[role="region"][aria-label="2 selected"]')).toBeNull()
  })
  it('keeps target empty and error feedback inside the destination fieldset, above the action footer', async () => {
    const empty = await mountTab({ listItems: selectionFiles.slice(0, 1) })
    const form = collectionForm(await selectionWindow(empty.view))
    const targets = destinationFieldset(form)
    typeInto(form.querySelector<HTMLInputElement>('input[type="search"][aria-label="Search clue packs"]')!, 'no-such-pack')
    await flush()
    expect([...targets.querySelectorAll<HTMLElement>('span')]
      .find(node => node.textContent === 'No matching packs. Try another name.')?.closest('fieldset')).toBe(targets)
    const footer = form.lastElementChild as HTMLElement
    expect([...footer.querySelectorAll<HTMLButtonElement>('button')].map(buttonLabel)).toEqual(['Cancel', 'Add to pack'])
    expect(footer.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
    typeInto(form.querySelector<HTMLInputElement>('input[type="search"][aria-label="Search clue packs"]')!, 'Design')
    await flush()
    expect(targets.textContent).toContain('Design notes')
    expect(targets.textContent).not.toContain('Release clues')
    const failing = await mountTab({ listItems: selectionFiles.slice(0, 1), packsError: true })
    const failedForm = collectionForm(await selectionWindow(failing.view))
    const failedTargets = destinationFieldset(failedForm)
    expect(failedTargets.querySelector('[role="alert"]')?.closest('fieldset')).toBe(failedTargets)
  })
  it('creates a named pack from all selected resources only after Create and refreshes the shelf', async () => {
    const unresolved: ClueCandidate = {
      sourceId: FILES.sourceId, typeId: 'file', title: 'Unregistered note', locator: { path: 'new.md' },
    }
    const { fx, view } = await mountTab({ listItems: [selectionFiles[0]!, unresolved] })
    const collection = await selectionWindow(view)
    const name = startNewPack(collection)
    typeInto(name, '  Investigation  ')
    await flush()
    expect(buttonLabel(collectionSubmit(collection))).toBe('Create')
    const reads = fx.calls.packsList
    click(collection, 'Create')
    await flush()
    expect(fx.createParams).toEqual([{ name: 'Investigation', members: ['c-a', 'c9'] }])
    expect(fx.calls.packsList).toBe(reads)
    await showView(view.container, 'packs')
    expect(fx.calls.packsList).toBe(reads + 1)
    expect(view.container.querySelector('button[aria-label="Manage pack: Investigation"]')).not.toBeNull()
    expect(floatingContent('[data-clue-collection]')).toBeNull()
  })
  it('keeps cross-source selections and adds all of them to the chosen pack', async () => {
    const issue: ClueCandidate = {
      sourceId: GITHUB.sourceId, typeId: 'issue', clueId: 'c-issue', title: 'Tracked issue', locator: { number: 7 },
    }
    const { fx, view } = await mountTab({
      scopes: { [GITHUB.sourceId]: { repo: 'acme/widgets', state: 'open' } },
      listResponse: async (_signal, input) => ({
        items: input.sourceId === FILES.sourceId ? [selectionFiles[0]!] : [issue],
      }),
    })
    selectResults(view.container)
    chooseSource(view.container, GITHUB.sourceId)
    await flush()
    selectResults(view.container)
    openCollectionWindow(view.container)
    await flush()
    const collection = collectionWindow()
    expect(collection.textContent).toContain('2 selected')
    expect(destinationFieldset(collection).textContent).toContain('Release clues')
    selectPackTarget(collection, 'Release clues')
    await flush()
    expect(fx.addMemberParams).toEqual([])
    submitCollection(collection)
    await flush()
    expect(fx.addMemberParams.map(input => input.clueId)).toEqual(['c-a', 'c-issue'])
    expect(floatingContent('[data-clue-collection]')).toBeNull()
  })
  it('retains uncompleted members after partial add failure and refreshes the changed shelf before retry', async () => {
    let failing = true
    const { fx, view } = await mountTab({
      listItems: selectionFiles,
      addMemberResponse: async input => {
        if (input.clueId === 'c-b' && failing) throw new Error('member rejected')
        const previous = fx.packs[0]!
        const target = { ...previous, members: [...previous.members, String(input.clueId)], revision: previous.revision + 1 }
        fx.packs[0] = target
        return { pack: target, revision: 4, packRevision: target.revision }
      },
    })
    const query = browserQueryInput(view.container)
    typeInto(query, 'unfinished search')
    const collection = await selectionWindow(view)
    const collectionNode = requiredContent('[data-clue-collection]')
    const reads = fx.calls.packsList
    addToPack(collection, 'Release clues')
    await flush()
    expect(fx.addMemberParams.map(input => input.clueId)).toEqual(['c-a', 'c-b'])
    await showView(view.container, 'packs')
    expect(fx.calls.packsList).toBe(reads + 1)
    expect(view.container.querySelector('[data-clue-pack-region]')?.textContent).toContain('3 members')
    await showView(view.container, 'browse')
    expect(requiredContent('[data-clue-collection]')).toBe(collectionNode)
    expect(collection.textContent).toContain('2 selected')
    expect(query.value).toBe('unfinished search')
    expect(document.querySelector('[data-dsh-better-sidebar-clue-notice]')?.textContent).toBe('Saving the pack failed.')
    failing = false
    addToPack(collection, 'Release clues')
    await flush()
    expect(fx.addMemberParams.map(input => input.clueId)).toEqual(['c-a', 'c-b', 'c-b', 'c-c'])
    expect(floatingContent('[data-clue-collection]')).toBeNull()
  })
  it('preserves new-pack name, footer and selections after failed creation and native hiding', async () => {
    const { fx, view } = await mountTab({
      listItems: selectionFiles, createResponse: async () => { throw new Error('creation rejected') },
    })
    const collection = await selectionWindow(view)
    const collectionNode = requiredContent('[data-clue-collection]')
    const name = startNewPack(collection)
    typeInto(name, 'Keep this draft')
    const reads = fx.calls.packsList
    click(collection, 'Create')
    await flush()
    expect(fx.createParams).toEqual([{ name: 'Keep this draft', members: ['c-a', 'c-b', 'c-c'] }])
    expect(fx.calls.packsList).toBe(reads)
    setVisible(view, fx, false)
    await flush()
    expect(floatingContent('[data-clue-collection]')).toBe(collectionNode)
    setVisible(view, fx, true)
    await flush()
    expect(collection.querySelector('input[aria-label="Pack name"]')).toBe(name)
    expect(name.value).toBe('Keep this draft')
    expect(buttonLabel(collectionSubmit(collection))).toBe('Create')
  })
  it('removes inserted items but keeps failed and later items for retry when ensure fails mid-batch', async () => {
    let failing = true
    const unresolved: ClueCandidate = {
      sourceId: FILES.sourceId, typeId: 'file', title: 'Unregistered note', locator: { path: 'new.md' },
    }
    const { fx, view } = await mountTab({
      listItems: [selectionFiles[0]!, unresolved, selectionFiles[2]!],
      ensureResponse: async () => {
        if (failing) throw new Error('ensure rejected')
        return { clue: { id: 'c-new' }, created: true }
      },
    })
    selectResults(view.container)
    click(view.container, 'Insert resources')
    await flush()
    expect(fx.inserted).toHaveLength(1)
    expect(view.container.querySelector('[role="region"][aria-label="2 selected"]')).not.toBeNull()
    failing = false
    click(view.container, 'Insert resources')
    await flush()
    expect(fx.inserted).toEqual([
      expect.objectContaining({ reference: expect.objectContaining({ clipboardText: '[[dsh-clue:c-a]]' }) }),
      expect.objectContaining({ reference: expect.objectContaining({ clipboardText: '[[dsh-clue:c-new]]' }) }),
      expect.objectContaining({ reference: expect.objectContaining({ clipboardText: '[[dsh-clue:c-c]]' }) }),
    ])
    expect(view.container.querySelector('[role="region"][aria-label="2 selected"]')).toBeNull()
  })
})
describe('clue workbench UX regressions', () => {
  it('retains source, query, selection and the scope draft through native tab hiding', async () => {
    const issue: ClueCandidate = { sourceId: GITHUB.sourceId, typeId: 'issue', title: 'A note', locator: { number: 7 } }
    const { fx, view } = await mountTab({
      listItems: [issue], scopes: { [GITHUB.sourceId]: { repo: 'acme/widgets', state: 'open' } },
    })
    const sourceNavigation = view.container.querySelector<HTMLElement>('[data-clue-source-navigation]')!
    chooseSource(view.container, GITHUB.sourceId)
    await flush()
    const query = browserQueryInput(view.container)
    typeInto(query, 'unfinished query')
    selectResults(view.container)
    openScopeWindow(view.container)
    await flush()
    const scopeInput = scopeWindow().querySelector<HTMLInputElement>('input[placeholder="owner/repo or repository URL"]')!
    typeInto(scopeInput, 'unsaved/repository')
    const before = { ...fx.calls }
    setVisible(view, fx, false)
    await flush()
    expect(fx.calls).toEqual(before)
    setVisible(view, fx, true)
    await flush()
    expect(view.container.querySelector('[data-clue-source-navigation]')).toBe(sourceNavigation)
    expect(browserQueryInput(view.container)).toBe(query)
    expect(query.value).toBe('unfinished query')
    expect(view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true)
    expect(scopeWindow().querySelector('input[placeholder="owner/repo or repository URL"]')).toBe(scopeInput)
    expect(scopeInput.value).toBe('unsaved/repository')
  })
  it('paints warm pages and the pack shelf from the shared cache after hide/show and remount', async () => {
    const warm: ClueCandidate = {
      sourceId: FILES.sourceId, typeId: 'file', clueId: 'c-warm', title: 'Warm note', locator: { path: 'warm.md' },
    }
    const reads = stubApiFetch({
      'clues.sources': { sources: [{ ...FILES, capabilities: { ...FILES.capabilities } }], types: [] },
      'clues.list': { items: [warm] },
      'clues.pins.list': { pins: [], revision: 0 },
      'clues.clues': { clues: [], revision: 0 },
      'clues.packs.list': { packs: [], revision: 0 },
    })
    const fx = fixture({ enabled: [FILES.sourceId], realApi: true })
    const first = mount(fx)
    await flush()
    expect(browserRegion(first.container).textContent).toContain('Warm note')
    await showView(first.container, 'packs')
    expect([reads('clues.list'), reads('clues.packs.list')]).toEqual([1, 1])
    setVisible(first, fx, false)
    await flush()
    setVisible(first, fx, true)
    await flush()
    const second = mount(fx)
    await flush()
    await showView(second.container, 'browse')
    const browser = browserRegion(second.container)
    expect(browser.querySelector('[data-clue-browser-state="loading"]')).toBeNull()
    expect(browser.textContent).toContain('Warm note')
    expect([reads('clues.list'), reads('clues.packs.list'), reads('clues.sources')]).toEqual([1, 1, 1])
    invalidateClueRequests()
    const ghReads = stubApiFetch({
      'clues.sources': { sources: [{ ...GITHUB, capabilities: { ...GITHUB.capabilities } }], types: [] },
      'clues.defaultScope': { scope: { repo: 'acme/widgets', state: 'open' } },
      'clues.list': { items: [] },
      'clues.pins.list': { pins: [], revision: 0 },
      'clues.clues': { clues: [], revision: 0 },
      'clues.packs.list': { packs: [], revision: 0 },
    })
    const gh = fixture({ enabled: [GITHUB.sourceId], realApi: true })
    mount(gh)
    await flush()
    const ghSecond = mount(gh)
    await flush()
    expect([ghReads('clues.defaultScope'), ghReads('clues.list')]).toEqual([1, 1])
    expect(browserRegion(ghSecond.container).querySelector('[data-clue-browser-state="loading"]')).toBeNull()
  })
  it('aborts native-hidden requests, ignores late rows and refreshes once on return', async () => {
    const requests: { signal: AbortSignal | undefined; resolve: (result: ClueListResult) => void }[] = []
    const { fx, view } = await mountTab({
      listResponse: signal => new Promise(resolve => { requests.push({ signal, resolve }) }),
    })
    const previous = requests.at(-1)!
    const packReads = fx.calls.packsList
    setVisible(view, fx, false)
    expect(previous.signal?.aborted).toBe(true)
    await act(async () => {
      previous.resolve({ items: [{ sourceId: FILES.sourceId, typeId: 'file', title: 'Late row', locator: { path: 'old.md' } }] })
    })
    expect(view.container.textContent).not.toContain('Late row')
    const count = requests.length
    await flush()
    expect(fx.calls.packsList).toBe(packReads)
    setVisible(view, fx, true)
    await flush()
    expect(requests).toHaveLength(count + 1)
    expect(fx.calls.packsList).toBe(packReads)
    await act(async () => { requests.at(-1)!.resolve({ items: [] }) })
  })
  it('reacts to source preferences without closing the workbench', async () => {
    const { fx, view } = await mountTab()
    expect(view.container.querySelector('[data-clue-source-navigation]')?.getAttribute('data-clue-active-source')).toBe(FILES.sourceId)
    act(() => { fx.store.setPrefs({ ...fx.store.getPrefs(), clueSourcesEnabled: { [FILES.sourceId]: false } }) })
    await flush()
    expect(view.container.querySelector('[data-clue-source="' + FILES.sourceId + '"]')).toBeNull()
    expect(view.container.querySelector('[data-clue-source-navigation]')?.getAttribute('data-clue-active-source')).toBe(GITHUB.sourceId)
  })
  it('clears the previous source query before listing GitHub once, then restores each source draft', async () => {
    const file: ClueCandidate = {
      sourceId: FILES.sourceId, typeId: 'file', clueId: 'c-files', title: 'Release note', locator: { path: 'release.md' },
    }
    const issue: ClueCandidate = {
      sourceId: GITHUB.sourceId, typeId: 'issue', clueId: 'c-issue', title: 'A GitHub issue', locator: { number: 7 },
    }
    const { fx, view } = await mountTab({
      enabled: [FILES.sourceId, GITHUB.sourceId],
      scopes: { [FILES.sourceId]: { path: 'docs' }, [GITHUB.sourceId]: { repo: 'acme/widgets', state: 'open' } },
      listResponse: async (_signal, input) => ({ items: input.sourceId === FILES.sourceId ? [file] : [issue] }),
      searchResponse: async () => ({ items: [file] }),
    })
    const browser = browserRegion(view.container)
    const query = browserQueryInput(view.container)
    typeInto(query, 'local release')
    click(browser, 'Search')
    await flush()
    enterSelection(browser)
    act(() => { browser.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click() })
    const before = { ...fx.calls }
    typeInto(query, 'unfinished local draft')
    chooseSource(browser, GITHUB.sourceId)
    await flush()
    expect(query.value).toBe('')
    expect(fx.calls).toMatchObject({ list: before.list + 1, search: before.search })
    const githubLists = fx.listParams.filter(input => input.sourceId === GITHUB.sourceId)
    expect(githubLists[0]).toMatchObject({ scope: { repo: 'acme/widgets', state: 'open' } })
    expect(browser.textContent).toContain('A GitHub issue')
    typeInto(query, 'remote issue')
    click(browser, 'Search')
    await flush()
    const beforeFiles = { ...fx.calls }
    chooseSource(browser, FILES.sourceId)
    await flush()
    expect(query.value).toBe('unfinished local draft')
    expect(fx.calls).toMatchObject({ list: beforeFiles.list, search: beforeFiles.search })
    click(browser, 'Insert resources')
    await flush()
    expect(fx.inserted[0]).toMatchObject({ reference: { clipboardText: '[[dsh-clue:c-files]]' } })
  })
  it('invalidates an unsaved range draft when the persisted scope changes while away', async () => {
    const githubScope = { repo: 'acme/widgets', state: 'open' }
    const { fx, view } = await mountTab({
      listItems: selectionFiles.slice(0, 1),
      scopes: { [FILES.sourceId]: { path: 'old-docs' }, [GITHUB.sourceId]: githubScope },
    })
    const browser = browserRegion(view.container)
    const query = browserQueryInput(view.container)
    typeInto(query, 'release notes')
    click(browser, 'Search')
    await flush()
    openScopeWindow(browser)
    await flush()
    typeInto(scopeWindow().querySelector<HTMLInputElement>('input[placeholder="e.g. docs/"]')!, 'unsaved/old-draft')
    closeFloatingWindow('[data-clue-scope-window]')
    chooseSource(browser, GITHUB.sourceId)
    await flush()
    const whileAway = { ...fx.calls }
    setScopes(fx, { [FILES.sourceId]: { path: 'new-docs' }, [GITHUB.sourceId]: githubScope })
    await flush()
    expect(fx.calls).toEqual(whileAway)
    const beforeReturn = fx.searchParams.length
    chooseSource(browser, FILES.sourceId)
    await flush()
    expect(query.value).toBe('release notes')
    expect(fx.searchParams.slice(beforeReturn)).toHaveLength(1)
    expect(fx.searchParams.at(-1)).toMatchObject({ scope: { path: 'new-docs' } })
    openScopeWindow(browser)
    await flush()
    expect(scopeWindow().querySelector<HTMLInputElement>('input[placeholder="e.g. docs/"]')?.value).toBe('new-docs')
    const kept = await mountTab({
      listItems: selectionFiles.slice(0, 1),
      scopes: { [FILES.sourceId]: { path: 'saved-docs' }, [GITHUB.sourceId]: githubScope },
    })
    const keptBrowser = browserRegion(kept.view.container)
    openScopeWindow(keptBrowser)
    await flush()
    typeInto(scopeWindow().querySelector<HTMLInputElement>('input[placeholder="e.g. docs/"]')!, 'kept-draft')
    closeFloatingWindow('[data-clue-scope-window]')
    chooseSource(keptBrowser, GITHUB.sourceId)
    await flush()
    chooseSource(keptBrowser, FILES.sourceId)
    await flush()
    openScopeWindow(keptBrowser)
    await flush()
    expect(scopeWindow().querySelector<HTMLInputElement>('input[placeholder="e.g. docs/"]')?.value).toBe('kept-draft')
  })
  it('keeps browser query, scope and selection stable across pack recency writes and refreshes pack choices', async () => {
    const { fx, view } = await mountTab({
      enabled: [FILES.sourceId], scopes: { [FILES.sourceId]: { path: 'docs' } },
      listItems: [{ sourceId: FILES.sourceId, typeId: 'file', title: 'A note', locator: { path: 'a.md' } }],
    })
    const query = browserQueryInput(view.container)
    typeInto(query, 'notes')
    click(view.container, 'Search')
    await flush()
    enterSelection(view.container)
    const checkbox = view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    act(() => { checkbox.click() })
    openCollectionWindow(view.container)
    await flush()
    expect(destinationFieldset(collectionWindow()).textContent).not.toContain('Newly organized collection')
    openScopeWindow(view.container)
    await flush()
    const scopeInput = scopeWindow().querySelector<HTMLInputElement>('input[placeholder="e.g. docs/"]')!
    typeInto(scopeInput, 'unsaved/path')
    const before = { ...fx.calls }
    await showView(view.container, 'packs')
    click(view.container, 'Insert pack: Release clues')
    await flush()
    expect(fx.calls).toMatchObject({ list: before.list, search: before.search })
    expect(query.value).toBe('notes')
    expect(scopeInput.value).toBe('unsaved/path')
    expect(checkbox.checked).toBe(true)
    fx.packs.push(pack('p-new', 'Newly organized collection', []))
    closeFloatingWindow('[data-clue-collection]')
    await showView(view.container, 'browse')
    openCollectionWindow(view.container)
    await flush()
    expect(destinationFieldset(collectionWindow()).textContent).toContain('Newly organized collection')
    expect(checkbox.checked).toBe(true)
  })
  it('finishes creation while the native tab is hidden without stealing focus or duplicating a refreshed pack', async () => {
    let finish!: (value: { pack: CluePack; revision: number; packRevision: number }) => void
    const { fx, view } = await mountTab({ createResponse: () => new Promise(resolve => { finish = resolve }) })
    const external = document.createElement('button')
    view.container.append(external)
    await showView(view.container, 'packs')
    click(view.container, 'New')
    await flush()
    const name = document.querySelector<HTMLInputElement>('input[aria-label="Pack name"]')!
    typeInto(name, 'Background collection')
    click(name.closest<HTMLElement>('[data-floating-window]')!, 'Create')
    await flush()
    setVisible(view, fx, false)
    external.focus()
    const created = pack('p3', 'Background collection', [])
    fx.packs.push(created)
    setVisible(view, fx, true)
    await flush()
    const filter = view.container.querySelector<HTMLInputElement>('input[aria-label="Search clue packs"]')!
    typeInto(filter, 'Background collection')
    expect(view.container.querySelectorAll('button[aria-label="Manage pack: Background collection"]')).toHaveLength(0)
    setVisible(view, fx, false)
    external.focus()
    await act(async () => { finish({ pack: created, revision: 4, packRevision: 1 }) })
    await flush()
    expect(view.container.querySelectorAll('button[aria-label="Manage pack: Background collection"]')).toHaveLength(1)
    expect(document.activeElement).toBe(external)
    setVisible(view, fx, true)
    await flush()
  })
  it('reveals the whole pack library progressively without paging controls', async () => {
    installIntersectionObserver()
    const { fx, view } = await mountTab({
      enabled: [FILES.sourceId],
      listItems: [{ sourceId: FILES.sourceId, typeId: 'file', title: 'A note', locator: { path: 'a.md' } }],
    })
    for (let index = 3; index <= 14; index += 1) fx.packs.push(pack('p' + index, 'Collection ' + index, []))
    const shelf = view.container.querySelector<HTMLElement>('[data-clue-pack-region]')!
    await showView(view.container, 'packs')
    expect(shelf.querySelectorAll('button[aria-label^="Manage pack:"]')).toHaveLength(12)
    expect(shelf.querySelector('[data-clue-pack-pagination]')).toBeNull()
    intersect(shelf)
    await flush()
    expect(shelf.querySelectorAll('button[aria-label^="Manage pack:"]')).toHaveLength(14)
    const filter = shelf.querySelector<HTMLInputElement>('input[aria-label="Search clue packs"]')!
    typeInto(filter, 'Release')
    expect(shelf.querySelectorAll('button[aria-label^="Manage pack:"]')).toHaveLength(1)
    typeInto(filter, '')
    expect(shelf.querySelectorAll('button[aria-label^="Manage pack:"]')).toHaveLength(12)
    await flush()
  })
  it('holds both the trailing search and Enter while an IME composition is active', async () => {
    const { fx, view } = await mountTab({ enabled: [FILES.sourceId] })
    const input = browserQueryInput(view.container)
    act(() => { input.dispatchEvent(new Event('compositionstart', { bubbles: true })) })
    typeInto(input, '设计')
    await waitTrailingWindow()
    expect(fx.calls.search).toBe(0)
    const composing = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })
    const legacy = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true })
    act(() => { input.dispatchEvent(composing); input.dispatchEvent(legacy) })
    await flush()
    expect(composing.defaultPrevented).toBe(false)
    expect(legacy.defaultPrevented).toBe(false)
    expect(fx.calls.search).toBe(0)
    act(() => { input.dispatchEvent(new Event('compositionend', { bubbles: true })) })
    await waitTrailingWindow()
    expect(fx.calls.search).toBe(1)
    expect(fx.searchParams[0]).toMatchObject({ sourceId: FILES.sourceId, query: '设计' })
  })
  it('distinguishes a pin read failure from an empty library and retries in place', async () => {
    let failing = true
    let finish!: (failure: boolean) => void
    const { view } = await mountTab({
      pinsError: () => failing ? true : new Promise(resolve => { finish = resolve }),
    })
    expect(view.container.textContent).toContain('Could not load pinned clues')
    expect(view.container.textContent).not.toContain('Pin frequently used clues')
    failing = false
    const retryButton = view.container.querySelector<HTMLButtonElement>('[role="alert"] button')!
    retryButton.focus()
    click(view.container, 'Retry')
    await flush()
    expect(retryButton.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(retryButton)
    await act(async () => { finish(false) })
    await flush()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Keyword, resource link or file path')
    expect(view.container.textContent).not.toContain('Could not load pinned clues')
  })
})
describe('compact clue views and selection', () => {
  it('keeps pending query/filter, selection and scroll while collections are visible without hidden reads', async () => {
    const filters = [{ scopeKey: 'state', options: [{ id: 'all' }, { id: 'active', value: 'active' }] }]
    const { fx, view } = await mountTab({
      enabled: [FILES.sourceId], catalogSources: [{ ...FILES, filters }], listItems: selectionFiles.slice(0, 1),
    })
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
    expect(input.value).toBe('unfinished')
    expect(checkbox.checked).toBe(true)
    expect(results.scrollTop).toBe(87)
    await waitTrailingWindow()
    expect(fx.searchParams).toHaveLength(1)
    expect(fx.searchParams[0]).toMatchObject({ query: 'unfinished', scope: { state: 'active' } })
    const beforePacks = { ...fx.calls }
    await showView(view.container, 'packs')
    expect(packSearch.value).toBe('Release')
    expect(packScroll.scrollTop).toBe(45)
    await waitTrailingWindow()
    expect(fx.calls).toEqual(beforePacks)
  })
  it('restores each source pending filter and query together before its trailing search', async () => {
    const filters = [
      { scopeKey: 'state', options: [{ id: 'all' }, { id: 'active', value: 'active' }] },
      { scopeKey: 'assigned', options: [{ id: 'all' }, { id: 'mine', value: true }] },
    ]
    const { fx, view } = await mountTab({
      catalogSources: [{ ...FILES, filters }, GITHUB], scopes: { [GITHUB.sourceId]: { repo: 'acme/widgets' } },
      listItems: selectionFiles.slice(0, 1),
    })
    const browser = browserRegion(view.container)
    typeInto(browserQueryInput(view.container), 'file draft')
    click(browser.querySelector('[data-clue-resource-filters]')!, t('clueResourceFilter'))
    clickMenuItem(document.querySelector<HTMLElement>('[role="menu"]')!, t('clueResourceStateActive'))
    act(() => {
      view.container.querySelectorAll<HTMLButtonElement>('[data-clue-resource-filters] button[aria-haspopup="menu"]')[1]!.click()
    })
    clickMenuItem(document.querySelector<HTMLElement>('[role="menu"]')!, 'mine')
    chooseSource(browser, GITHUB.sourceId)
    await flush()
    await waitTrailingWindow()
    expect(fx.calls.search).toBe(0)
    chooseSource(browser, FILES.sourceId)
    await flush()
    expect(browserQueryInput(view.container).value).toBe('file draft')
    await waitTrailingWindow()
    expect(fx.searchParams).toHaveLength(1)
    expect(fx.searchParams[0]).toMatchObject({ sourceId: FILES.sourceId, query: 'file draft', scope: { state: 'active', assigned: true } })
  })
  it('keeps the selection footer stable at zero and lets review remove a chosen resource', async () => {
    const { fx, view } = await mountTab({ listItems: selectionFiles.slice(0, 1) })
    const browser = browserRegion(view.container)
    expect(browser.querySelector('input[type="checkbox"]')).toBeNull()
    enterSelection(browser)
    const footer = browser.querySelector<HTMLElement>('[role="region"][aria-label="0 selected"]')!
    expect(footer.querySelector<HTMLButtonElement>('[data-clue-selection-actions] button')!.disabled).toBe(true)
    const checkbox = candidateCheckbox(browser, 'First note')
    act(() => { checkbox.click() })
    const review = footer.querySelector<HTMLDetailsElement>('[data-clue-selection-review]')!
    act(() => { review.querySelector('summary')!.click() })
    click(review, t('clueSelectionRemove', { title: 'First note' }))
    expect(checkbox.checked).toBe(false)
    expect(browser.querySelector('[role="region"][aria-label="0 selected"]')).toBe(footer)
    expect(fx.inserted).toHaveLength(0)
  })
})
describe('clue browser trailing query and row menu', () => {
  it('keeps selection-label, row preview and insertion independent', async () => {
    const { fx, view } = await mountTab({ enabled: [FILES.sourceId], listItems: selectionFiles.slice(0, 2) })
    const first = candidateRow(view.container, 'First note')
    const checkbox = candidateCheckbox(view.container, 'First note')
    const target = checkbox.closest('label')!
    expect(checkbox.getAttribute('aria-label')).toBe('Select First note')
    act(() => { target.click() })
    expect(checkbox.checked).toBe(true)
    expect(candidateCheckbox(view.container, 'Second note').checked).toBe(false)
    act(() => { target.click() })
    expect(checkbox.checked).toBe(false)
    click(first, 'First note')
    await flush()
    expect(fx.opened.at(-1)).toMatchObject({ id: 'clue:c-a', title: 'First note' })
    expect(checkbox.checked).toBe(false)
    click(first, 'Insert First note')
    await flush()
    expect(fx.inserted[0]).toMatchObject({ reference: { ref: 'c-a', clipboardText: '[[dsh-clue:c-a]]' } })
    expect(fx.opened).toHaveLength(1)
  })
  it('collapses keystrokes inside the 500 ms window into one trailing search with the final query', async () => {
    const { fx, view } = await mountTab({ enabled: [FILES.sourceId] })
    const input = browserQueryInput(view.container)
    typeInto(input, 'rel')
    typeInto(input, 'rele')
    expect(fx.calls.search).toBe(0)
    await waitTrailingWindow(350)
    expect(fx.calls.search).toBe(0)
    await waitTrailingWindow(220)
    expect(fx.calls.search).toBe(1)
    expect(fx.searchParams[0]).toMatchObject({ sourceId: FILES.sourceId, query: 'rele' })
  })
  it('runs an explicit Enter immediately and never replays it when the trailing window expires', async () => {
    const { fx, view } = await mountTab({ enabled: [FILES.sourceId] })
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
  })
  it('cancels the queued query when the tab hides or the source changes', async () => {
    const hidden = await mountTab({ enabled: [FILES.sourceId] })
    typeInto(browserQueryInput(hidden.view.container), 'hidden draft')
    setVisible(hidden.view, hidden.fx, false)
    await waitTrailingWindow()
    expect(hidden.fx.calls.search).toBe(0)
    setVisible(hidden.view, hidden.fx, true)
    await flush()
    expect(hidden.fx.calls.search).toBe(0)
    await waitTrailingWindow()
    expect(hidden.fx.calls.search).toBe(1)
    expect(hidden.fx.searchParams[0]).toMatchObject({ sourceId: FILES.sourceId, query: 'hidden draft' })
    const switched = await mountTab({ enabled: [FILES.sourceId, FEISHU_DOCS.sourceId] })
    chooseSource(switched.view.container, FEISHU_DOCS.sourceId)
    await flush()
    typeInto(browserQueryInput(switched.view.container), 'design draft')
    chooseSource(switched.view.container, FILES.sourceId)
    await waitTrailingWindow()
    expect(switched.fx.calls.search).toBe(0)
    expect(switched.fx.searchParams.some(input => input.query === 'design draft')).toBe(false)
  })
  it('opens the detail collection before Insert and previews/inserts from both menu paths', async () => {
    const { fx, view } = await mountTab({ enabled: [FILES.sourceId], listItems: selectionFiles })
    const row = candidateRow(view.container, 'First note')
    act(() => {
      row.querySelector<HTMLButtonElement>('button[title="First note"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    const detail = [...document.querySelectorAll<HTMLElement>('[data-floating-window]')]
      .find(node => node.querySelector('[data-clue-detail-insert]') !== null)!
    const add = detail.querySelector<HTMLButtonElement>('[data-clue-detail-add-to-pack]')!
    expect(add.compareDocumentPosition(detail.querySelector('[data-clue-detail-insert]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    act(() => { add.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    expect(collectionWindow().textContent).toContain('1 selected')
    expect(fx.addMemberParams).toHaveLength(0)
    closeFloatingWindow('[data-clue-collection]')
    await flush()
    expect(fx.addMemberParams).toHaveLength(0)
    expect(view.container.querySelector('[role="region"][aria-label="1 selected"]')).toBeNull()
    clickMenuItem(await openCandidateContextMenu(view.container, 'Second note'), 'Preview')
    await flush()
    expect(fx.opened.at(-1)).toMatchObject({ title: 'Second note' })
    const windowsBeforeInsert = fx.opened.length
    act(() => {
      candidateRow(view.container, 'Second note').dispatchEvent(new KeyboardEvent('keydown', {
        key: 'F10', shiftKey: true, bubbles: true, cancelable: true,
      }))
    })
    await flush()
    clickMenuItem(document.querySelector<HTMLElement>('[role="menu"]')!, 'Insert resources')
    await flush()
    expect(fx.inserted[0]).toMatchObject({
      reference: { source: 'better-sidebar:clues', ref: 'c-b', clipboardText: '[[dsh-clue:c-b]]' },
    })
    expect(fx.opened).toHaveLength(windowsBeforeInsert)
    expect(fx.ensureParams).toHaveLength(0)
  })
  it('keeps a multi-selection on Add and narrows a non-selected row to itself', async () => {
    const { view } = await mountTab({ enabled: [FILES.sourceId], listItems: selectionFiles })
    selectResults(view.container)
    clickMenuItem(await openCandidateContextMenu(view.container, 'First note'), 'Add to pack')
    await flush()
    expect(collectionWindow().textContent).toContain('3 selected')
    closeFloatingWindow('[data-clue-collection]')
    await flush()
    click(view.container, 'Cancel')
    await flush()
    expect(view.container.querySelector('[role="region"][aria-label="3 selected"]')).toBeNull()
    clickMenuItem(await openCandidateContextMenu(view.container, 'Second note'), 'Add to pack')
    await flush()
    expect(collectionWindow().textContent).toContain('1 selected')
    expect(candidateCheckbox(view.container, 'Second note').checked).toBe(true)
  })
  it('closes the row menu when the native tab hides', async () => {
    const { fx, view } = await mountTab({ enabled: [FILES.sourceId], listItems: selectionFiles })
    expect(await openCandidateContextMenu(view.container, 'First note')).not.toBeNull()
    setVisible(view, fx, false)
    await flush()
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
})
describe('UI19 browser request inputs', () => {
  it('enters file folders as a scope rather than opening an unreadable detail and offers Up', async () => {
    const folder: ClueCandidate = {
      sourceId: FILES.sourceId, typeId: 'builtin.files.directory', title: 'docs',
      locator: { root: { kind: 'workspace', workspaceId: 'ws-1' }, path: 'docs', dialect: 'posix' },
    }
    const { fx, view } = await mountTab({ enabled: [FILES.sourceId], listItems: [folder] })
    click(view.container, 'docs')
    await flush()
    expect(fx.opened).toHaveLength(0)
    expect(fx.listParams.at(-1)?.scope).toEqual({ locator: folder.locator })
    act(() => { view.container.querySelector<HTMLButtonElement>('[data-clue-scope-up]')!.click() })
    await flush()
    expect(fx.listParams.at(-1)).not.toHaveProperty('scope')
  })
})
describe('native reveal and provider filters', () => {
  it('reveals a workspace-local candidate from CluesTab through the native files tree, not an editor detail', async () => {
    const candidate: ClueCandidate = {
      sourceId: FILES.sourceId, typeId: 'builtin.files.markdown', title: 'Reveal locally',
      locator: { root: { kind: 'workspace', workspaceId: 'ws-1' }, path: 'docs/nested/a.md', dialect: 'posix' },
    }
    const fx = fixture({ enabled: [FILES.sourceId], listItems: [candidate] })
    const openTab = revealHostOf(fx)
    const cwd = vi.spyOn(sidebarApi, 'sessionCwd').mockResolvedValue({ sessionId: 's1', cwd: '/repo', root: '/repo', parent: null })
    const view = mount(fx)
    await flush()
    clickMenuItem(await openCandidateContextMenu(view.container, 'Reveal locally'), t('clueBrowserRevealTree' as CopyKey))
    await flush()
    expect(cwd).toHaveBeenCalledExactlyOnceWith({ sessionId: 's1' })
    expect(openTab).toHaveBeenCalledExactlyOnceWith({ type: 'editor' }, { sessionId: 's1', cwd: '/repo' })
    expect(fx.store.getSnapshot().state).toMatchObject({
      expanded: ['/repo/docs', '/repo/docs/nested'], revealed: ['/repo/docs/nested/a.md'],
    })
  })
  it('queues a candidate in its locator workspace session without changing the current conversation', async () => {
    const candidate: ClueCandidate = {
      sourceId: FILES.sourceId, typeId: 'builtin.files.markdown', title: 'Reveal elsewhere',
      locator: { root: { kind: 'workspace', workspaceId: 'ws-2' }, path: 'folder/a.md', dialect: 'posix' },
    }
    const fx = fixture({ secondWorkspaceId: 'ws-2', enabled: [FILES.sourceId], listItems: [candidate] })
    const openTab = revealHostOf(fx)
    vi.spyOn(sidebarApi, 'sessionCwd').mockResolvedValue({ sessionId: 's2', cwd: '/other', root: '/other', parent: null })
    const view = mount(fx)
    await flush()
    clickMenuItem(await openCandidateContextMenu(view.container, 'Reveal elsewhere'), t('clueBrowserRevealTree' as CopyKey))
    await flush()
    expect(openTab).toHaveBeenCalledExactlyOnceWith({ type: 'editor' }, { sessionId: 's2', cwd: '/other' })
    expect(fx.store.getSessionState('s2')!.revealed).toEqual(['/other/folder/a.md'])
    expect(document.body.textContent).toContain(t('clueBrowserRevealQueued' as CopyKey))
  })
  it.each([
    ['external root', { root: { kind: 'external' }, path: '/repo/a.md', dialect: 'posix' }, '/repo', 'clueBrowserRevealUnavailable'],
    ['foreign dialect', { root: { kind: 'workspace', workspaceId: 'ws-1' }, path: 'a.md', dialect: 'win32' }, '/repo', 'clueBrowserRevealUnavailable'],
    ['linked worktree', { root: { kind: 'workspace', workspaceId: 'ws-1' }, path: 'a.md', dialect: 'posix' }, '/linked-worktree', 'clueBrowserRevealRootMismatch'],
  ] as const)('explains that %s cannot be located instead of claiming a tree reveal', async (_label, locator, root, notice) => {
    const candidate: ClueCandidate = { sourceId: FILES.sourceId, typeId: 'builtin.files.markdown', title: 'Cannot locate', locator }
    const fx = fixture({ enabled: [FILES.sourceId], listItems: [candidate] })
    const openTab = revealHostOf(fx)
    vi.spyOn(sidebarApi, 'sessionCwd').mockResolvedValue({ sessionId: 's1', cwd: root, root: '/repo', parent: null })
    const view = mount(fx)
    await flush()
    clickMenuItem(await openCandidateContextMenu(view.container, 'Cannot locate'), t('clueBrowserRevealTree' as CopyKey))
    await flush()
    expect(openTab).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain(t(notice as CopyKey))
  })
})
describe('explorer accordion (S9)', () => {
  it('restores a persisted layout — including both collapsed', async () => {
    const { fx, view } = await mountTab({
      enabled: [FILES.sourceId], clueSettings: { layout: { browse: false, packs: false } },
    })
    expect(sectionOf(view.container, t('clueViewBrowse'))?.getAttribute('data-open')).toBe('false')
    expect(sectionOf(view.container, t('clueViewPacks'))?.getAttribute('data-open')).toBe('false')
    expect(fx.calls).toMatchObject({ list: 0, packsList: 0 })
    click(view.container, t('clueViewPacks'))
    await flush()
    expect(sectionOf(view.container, t('clueViewPacks'))?.getAttribute('data-open')).toBe('true')
    expect(fx.calls.packsList).toBe(1)
    click(view.container, t('clueViewBrowse'))
    await flush()
    expect((fx.store.getPrefs().pluginSettings.clues as { layout?: unknown }).layout).toEqual({ browse: true, packs: true })
    click(view.container, t('clueViewPacks'))
    await flush()
    expect(sectionOf(view.container, t('clueViewPacks'))?.getAttribute('data-open')).toBe('false')
    expect(sectionOf(view.container, t('clueViewBrowse'))?.getAttribute('data-open')).toBe('true')
    expect(view.container.querySelector<HTMLElement>('[data-clue-pack-region]')!.closest('[hidden]')).not.toBeNull()
  })
  it('restores the last source and remembers each explicit switch', async () => {
    const { fx, view } = await mountTab({
      enabled: [FILES.sourceId, GITHUB.sourceId], clueSettings: { activeSource: GITHUB.sourceId },
    })
    const tabs = [...view.container.querySelectorAll<HTMLButtonElement>('[data-clue-source-navigation] [role="tab"]')]
    expect(tabs.find(tab => tab.textContent?.includes('GitHub Issues'))?.getAttribute('aria-selected')).toBe('true')
    chooseSource(view.container, FILES.sourceId)
    await flush()
    expect((fx.store.getPrefs().pluginSettings.clues as { activeSource?: string }).activeSource).toBe(FILES.sourceId)
  })
})
