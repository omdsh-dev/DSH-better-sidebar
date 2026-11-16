/**
 * S8 grouped settings section (interactive): the Side card section is
 * reorganized into six groups (General / Tabs / Start page / File viewers / Clue sources /
 * Appearance) with the existing preferences' values, names and save semantics
 * unchanged. This spec pins:
 *
 * - the horizontal group tab row and the
 *   per-group content;
 * - the existing preference regressions (general rows, tab/viewer switches,
 *   custom CSS) still write the same keys through the same revision-guarded
 *   settings route;
 * - the clue source table's single switch / @ switch / pack switch and the
 *   four ONE-COMMIT batch actions over the currently registered set;
 * - the 409 conflict rule: keep the user's edit, re-read the revision, retry
 *   once, and never claim the value was saved when it was not;
 * - two settings entry points reading/writing the SAME document through the
 *   SAME component;
 * - the deep link from the Tab gear into the Clue sources group (and one
 *   source's configuration window);
 * - the add-source entry opening the S8 source-plugin catalog (topic,
 *   category groups, jump/copy install command) without ever presenting the
 *   tab-plugin catalog as source recommendations or claiming an install.
 */
// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'
setupReactAct()
beforeAll(() => { Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true }) })
import { SideCardSection, type SideCardSectionProps } from '../src/client/SideCardSection.tsx'
import { createSidebarStore, type SidebarStore } from '../src/client/state.ts'
import {
  createBetterSidebarService, type BetterSidebarService, type BetterSidebarServiceHost,
} from '../src/client/service.ts'
import { cluesApi } from '../src/client/clues/api.ts'
import type { BetterSidebarCluesClientFace } from '../src/client/clues/registry.ts'
import type { ClueRuntimeApi } from '../src/client/clues/runtime-api.ts'
import { openClueSettings, peekClueSettingsTarget } from '../src/client/clues/settings/navigation.ts'
import { publishClueTask } from '../src/client/clues/settings/runtime-state.ts'
import { builtinClueSourcePlugins } from '../src/client/clues/settings/source-catalog.ts'
import { builtinTabPlugins } from '../src/client/plugins-tabs.ts'
import { en } from '../src/client/locales.ts'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'
import { selectionSettingsOf, REWRITE_PROMPTS } from '../src/selection-settings.ts'
import type { CluesSourcesCatalogResult, ClueSourceDescriptor } from '../src/clues/types.ts'
import type { ConnectionStatusProjection, DependencyInstallTask, DependencyStatus } from '../src/clues/runtime/types.ts'
function source(sourceId: string, name: string, extra: Partial<ClueSourceDescriptor> = {}): ClueSourceDescriptor {
  return {
    sourceId, name, order: 10, pluginId: 'test.plugin', types: [], transport: 'files',
    capabilities: { resolve: true, list: true, search: true, read: true, edit: false, portable: true }, ...extra,
  }
}
const CATALOGUE: CluesSourcesCatalogResult = {
  sources: [
    source('builtin.files', 'Local files'),
    source('acme.docs', 'Acme Docs', { transport: 'cli', dependencyIds: ['acme.cli'], connectionId: 'acme.auth' }),
  ],
  types: [],
}
function dependency(overrides: Partial<DependencyStatus> = {}): DependencyStatus {
  return {
    dependencyId: 'acme.cli', name: 'Acme CLI', command: 'acme', state: 'ready', platform: 'darwin', arch: 'arm64',
    supported: true, installable: true, minimumVersion: '1.0.0', recommendedVersion: '1.0.0',
    executablePath: '/usr/local/bin/acme', ...overrides,
  }
}
function installTask(overrides: Partial<DependencyInstallTask> = {}): DependencyInstallTask {
  return {
    taskId: 'task-1', dependencyId: 'acme.cli', planId: 'plan-1', version: '1.0.0', platform: 'darwin',
    arch: 'arm64', targetDir: '/home/u/.dsh/tools/acme.cli/1.0.0', state: 'running',
    progress: { stage: 'downloading', fraction: 0.5 }, startedAt: '2026-10-17T00:00:00.000Z', ...overrides,
  }
}
function connection(): ConnectionStatusProjection {
  return {
    connectionId: 'acme.auth', name: 'Acme Auth', pluginId: 'test.plugin', configuration: 'ready',
    authorization: 'ready', credentialOwner: 'tool', capabilities: [], action: 'none',
  }
}
/** Deep-merge plain objects exactly like the host's settings.update. */
function mergeSettings(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next = { ...target }
  for (const [key, value] of Object.entries(patch)) {
    const current = next[key]
    const plain = (item: unknown): item is Record<string, unknown> =>
      item !== null && typeof item === 'object' && !Array.isArray(item)
    next[key] = plain(current) && plain(value) ? mergeSettings(current, value) : value
  }
  return next
}
class FakeSettings {
  value: Record<string, unknown> = {}
  revision = 0
  readonly updates: { patch: Record<string, unknown>; expectedRevision: number | undefined }[] = []
  conflicts = 0
  externalChange: Record<string, unknown> | undefined
  reads = 0
  async settingsGet(): Promise<{ value: unknown; revision: number }> {
    this.reads += 1
    return { value: { ...this.value }, revision: this.revision }
  }
  async settingsUpdate(patch: Record<string, unknown>, expectedRevision?: number): Promise<{ value: unknown; revision: number }> {
    this.updates.push({ patch, expectedRevision })
    if (this.conflicts > 0 || (expectedRevision !== undefined && expectedRevision !== this.revision)) {
      if (this.conflicts > 0) {
        this.conflicts -= 1
        this.value = mergeSettings(this.value, this.externalChange ?? {})
        this.externalChange = undefined
      }
      this.revision += 1
      throw Object.assign(new Error('the settings document moved on'), { code: 'settings-conflict' })
    }
    this.value = mergeSettings(this.value, patch)
    this.revision += 1
    return { value: { ...this.value }, revision: this.revision }
  }
}
function fakeRuntime(dependencies: readonly DependencyStatus[] = [dependency()]): ClueRuntimeApi {
  const unexpected = async (name: string): Promise<never> => { throw new Error(`unexpected ${name}`) }
  return {
    dependenciesInspect: async () => dependencies, dependenciesPlan: () => unexpected('plan'),
    dependenciesStart: () => unexpected('start'), dependenciesStatus: async () => [],
    dependenciesCancel: () => unexpected('cancel'), dependenciesSetPath: () => unexpected('setPath'),
    dependenciesClearPath: () => unexpected('clearPath'), connectionsStatus: async () => [connection()],
    connectionsConnect: () => unexpected('connect'), connectionsPoll: () => unexpected('poll'),
    connectionsCancel: () => unexpected('cancel'),
  }
}
interface Harness { store: SidebarStore; service: BetterSidebarService; settings: FakeSettings; runtime: ClueRuntimeApi; clues: BetterSidebarCluesClientFace }
function harness(options: { catalogue?: CluesSourcesCatalogResult; runtime?: ClueRuntimeApi } = {}): Harness {
  const store = createSidebarStore()
  store.setPrefs({ ...SIDEBAR_PREFS_DEFAULTS })
  const service = createBetterSidebarService(store)
  service.registerTab({
    id: 'explorer', title: () => 'Explorer', order: 10,
    icon: () => createElement('svg', { 'data-icon': 'explorer' }), component: () => null,
  })
  service.registerTab({
    id: 'subagent', title: () => 'Subagents', order: 30,
    icon: () => createElement('svg', { 'data-icon': 'subagent' }), component: () => null,
    settings: { toggles: [{ key: 'autoOpenSubagent', title: () => 'Auto-open Subagents' }] },
  })
  service.registerFileViewer({
    id: 'image', title: () => 'Image', exts: ['png'], fetchStrategy: 'mediaUrl',
    icon: () => createElement('svg', { 'data-icon': 'image' }), component: () => null,
  })
  const catalogue = options.catalogue ?? CATALOGUE
  return {
    store, service, settings: new FakeSettings(), runtime: options.runtime ?? fakeRuntime(),
    clues: { ...service.clues, api: { ...cluesApi, sources: async () => catalogue } },
  }
}
function renderSection(h: Harness, injected: Partial<SideCardSectionProps> = {}): RenderedRoot {
  return renderRoot(createElement(SideCardSection, { store: h.store, service: h.service, settings: h.settings,
    clues: h.clues, runtime: h.runtime, ...injected } as unknown as SideCardSectionProps))
}
async function flush(turns = 6): Promise<void> {
  for (let index = 0; index < turns; index += 1) await act(async () => { await Promise.resolve() })
}
async function mount(h: Harness, injected: Partial<SideCardSectionProps> = {}): Promise<RenderedRoot> {
  const rendered = renderSection(h, injected); await flush(); return rendered
}
async function mountSources(h: Harness = harness()): Promise<RenderedRoot> {
  return mount(h, { initialGroup: 'sources' })
}
const selected = (c: ParentNode): string | undefined =>
  c.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? undefined
const rowFor = (c: ParentNode, id: string): Element | null => c.querySelector(`[data-clue-source="${id}"]`)
const statusOf = (c: ParentNode, id: string): string | null | undefined =>
  rowFor(c, id)?.getAttribute('data-clue-source-status')
const errorOf = (c: ParentNode, id: string): string | null | undefined =>
  c.querySelector(`[data-settings-error="${id}"]`)?.textContent
const lastPatch = (h: Harness): Record<string, unknown> | undefined => h.settings.updates.at(-1)?.patch
const windowsOf = (h: Harness) => (h.service as unknown as BetterSidebarServiceHost).windowHost.getSnapshot().windows
function closeWindow(h: Harness, id: string): void {
  act(() => { (h.service as unknown as BetterSidebarServiceHost).windowHost.finishClose(id) })
}
function click(container: ParentNode, label: string): void {
  const control = [...container.querySelectorAll<HTMLElement>('button, input, a, select, textarea')]
    .find(candidate => candidate.getAttribute('aria-label') === label || candidate.textContent?.trim().startsWith(label))
  if (control === undefined) throw new Error(`no control labelled "${label}" in ${container.textContent}`)
  act(() => { control.click() })
}
function switchState(container: ParentNode, label: string): boolean | undefined {
  const control = [...container.querySelectorAll<HTMLElement>('button[role="switch"]')]
    .find(candidate => candidate.getAttribute('aria-label') === label)
  return control === undefined ? undefined : control.getAttribute('aria-checked') === 'true'
}

it('persists selection switches, both orders, prompt override and reset through the real settings writer', async () => {
  const h = harness()
  const view = await mount(h)
  click(view.container, 'Selection actions')
  await flush()
  click(view.container, 'Run rewrites immediately'); await flush()
  click(view.container, 'Expand'); await flush()
  click(view.container, 'Move up: Translate'); await flush()
  click(view.container, 'Move up: Naturalize'); await flush()
  const persisted = selectionSettingsOf(h.store.getSnapshot().prefs)
  expect(persisted.autoRun).toBe(false)
  expect(persisted.disabled.expand).toBe(true)
  expect(persisted.menuOrder).toEqual(['translate', 'rewrite'])
  expect(persisted.rewriteOrder[0]).toBe('humanize')
  const editor = view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt: Expand"]')!
  act(() => {
    editor.value = 'Expand with concise examples.'
    editor.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
  await flush()
  expect(selectionSettingsOf(h.store.getSnapshot().prefs).prompts.expand).toBe('Expand with concise examples.')
  const expanded = view.container.querySelector('[data-selection-setting="expand"]')!
  click(expanded, 'Reset to default'); await flush()
  expect(selectionSettingsOf(h.store.getSnapshot().prefs).prompts.expand).toBe(REWRITE_PROMPTS.expand)
  expect(lastPatch(h)).toMatchObject({ pluginSettings: { clues: { selection: { autoRun: false } } } })
  expect(h.settings.updates.every(update => typeof update.expectedRevision === 'number')).toBe(true)
  view.unmount()
})

describe('SideCardSection grouped navigation', () => {
  it('renders six icon tabs in order, opens General by default and honors an explicit group', async () => {
    const rendered = await mount(harness())
    const tablist = rendered.container.querySelector('[role="tablist"][aria-label="Settings groups"]')!
    const tabs = [...tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabs.map(tab => tab.textContent?.trim())).toEqual([
      'General', 'Tabs', 'Start page', 'Selection actions', 'File viewers', 'Clue sources', 'Appearance',
    ])
    expect(tabs.every(tab => tab.querySelector('[aria-hidden="true"] svg') !== null)).toBe(true)
    expect(selected(rendered.container)).toBe('General')
    expect(['Inject the sidebar-open tool for the model', "Don't auto-open on narrow screens", 'Default the Tasks page to the tree']
      .map(text => rendered.container.textContent?.includes(text))).toEqual([true, true, true])
    expect(rendered.container.textContent).not.toContain('Subagents')
    click(rendered.container, 'Tabs')
    expect([selected(rendered.container), rendered.container.textContent?.includes('Subagents'),
      rendered.container.textContent?.includes('Add tab plugins')]).toEqual(['Tabs', true, true])
    click(rendered.container, 'File viewers')
    expect([rendered.container.textContent?.includes('Image'),
      rendered.container.textContent?.includes('Add preview plugins')]).toEqual([true, true])
    rendered.unmount()
    const explicit = await mount(harness(), { initialGroup: 'appearance' })
    expect([selected(explicit.container), explicit.container.textContent?.includes('Custom CSS')])
      .toEqual(['Appearance', true])
    explicit.unmount()
  })
})
describe('SideCardSection existing preferences', () => {
  it('keeps every General switch writing its original key and commits custom CSS', async () => {
    const h = harness()
    const rendered = await mount(h)
    const rows: [string, Record<string, unknown>][] = [
      ['Inject the sidebar-open tool for the model', { agentOpenTools: true }],
      ["Don't auto-open on narrow screens", { mobileNoAutoOpen: false }],
      ['Default the Tasks page to the tree', { mobileDefaultTree: false }],
      [en.settingsSubagentTitle, { autoOpenSubagent: false }],
      [en.settingsJobsTitle, { autoOpenJobs: false }],
    ]
    for (const [label, patch] of rows) {
      click(rendered.container, label); await flush()
      expect(h.settings.updates.at(-1)).toEqual({ patch, expectedRevision: h.settings.updates.length - 1 })
    }
    click(rendered.container, 'Appearance')
    const textarea = rendered.container.querySelector<HTMLTextAreaElement>('textarea')!
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'html { --x: 1; }')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    await flush()
    expect(lastPatch(h)).toEqual({ customCss: 'html { --x: 1; }' })
    expect(h.store.getPrefs()).toMatchObject({ agentOpenTools: true, mobileNoAutoOpen: false,
      mobileDefaultTree: false, autoOpenSubagent: false, autoOpenJobs: false })
    rendered.unmount()
  })
  it('sends sparse nested patches while two entry points keep BOTH edits', async () => {
    const h = harness()
    h.settings.value = { tabsEnabled: { explorer: true, subagent: true } }
    const first = await mount(h); const second = await mount(h)
    click(first.container, 'Tabs'); click(second.container, 'Tabs')
    click(first.container, 'Subagents'); await flush()
    expect(lastPatch(h)).toEqual({ tabsEnabled: { subagent: false } })
    click(second.container, 'Explorer'); await flush()
    expect(h.settings.value.tabsEnabled).toEqual({ explorer: false, subagent: false })
    expect(h.store.getPrefs().tabsEnabled).toEqual({ explorer: false, subagent: false })
    click(first.container, 'File viewers'); click(first.container, 'Image'); await flush()
    expect(lastPatch(h)).toEqual({ viewersEnabled: { image: false } })
    first.unmount(); second.unmount()
  })
  it('renders save failures on the writing control, not as a section banner', async () => {
    const h = harness(); const rendered = await mount(h)
    h.settings.settingsUpdate = async () => { throw new Error('the settings route is down') }
    click(rendered.container, 'Inject the sidebar-open tool for the model'); await flush()
    expect(errorOf(rendered.container, 'pref:agentOpenTools')).toContain('the settings route is down')
    expect(rendered.container.querySelector('[data-settings-error="pref:agentOpenTools"]')?.parentElement
      ?.querySelector('button[role="switch"][aria-label="Inject the sidebar-open tool for the model"]')).not.toBeNull()
    click(rendered.container, 'Tabs'); click(rendered.container, 'Subagents'); await flush()
    expect(errorOf(rendered.container, 'tab:subagent')).toContain('the settings route is down')
    rendered.unmount()
  })
})
describe('SideCardSection clue sources', () => {
  it('loads sources only for the explicit group, picks up a later registration and keeps unloaded persisted', async () => {
    const h = harness(); const rendered = await mount(h)
    expect(rendered.container.textContent).not.toContain('Local files')
    click(rendered.container, 'Clue sources'); await flush()
    expect(statusOf(rendered.container, 'builtin.files')).toBe('ready')
    h.clues.api.sources = async () => ({ ...CATALOGUE,
      sources: [...CATALOGUE.sources, source('later.source', 'Later source')] })
    act(() => { h.clues.registerSourceDisplay({ sourceId: 'later.source', name: 'Later source' }) }); await flush()
    expect(rendered.container.textContent).toContain('Later source')
    rendered.unmount()
    const stored = harness()
    const prefs = { ...SIDEBAR_PREFS_DEFAULTS, clueSourcesEnabled: { 'gone.source': false },
      clueSourcesMentionEnabled: { 'gone.source': true } }
    stored.store.setPrefs(prefs); stored.settings.value = prefs
    const unloaded = await mountSources(stored)
    expect(unloaded.container.textContent).toContain('gone.source')
    expect(unloaded.container.textContent).toContain('The source plugin is not loaded')
    expect(switchState(unloaded.container, 'Enable source: gone.source')).toBe(false)
    unloaded.unmount()
  })
  it('writes source/@/pack switches and batch actions as one sparse commit each, localizing failures', async () => {
    const h = harness(); const rendered = await mountSources(h)
    const update = h.settings.settingsUpdate.bind(h.settings)
    h.settings.settingsUpdate = async () => { throw new Error('the settings route is down') }
    click(rendered.container, 'Enable source: Local files'); await flush()
    expect(errorOf(rendered.container, 'source:builtin.files')).toContain('the settings route is down')
    h.settings.settingsUpdate = update; h.settings.updates.length = 0
    click(rendered.container, 'Enable source: Local files'); await flush()
    expect([h.settings.updates.length, lastPatch(h)]).toEqual([1, { clueSourcesEnabled: { 'builtin.files': false } }])
    h.settings.updates.length = 0
    click(rendered.container, '@ candidates: Acme Docs'); await flush()
    expect(lastPatch(h)).toEqual({ clueSourcesMentionEnabled: { 'acme.docs': false } })
    h.settings.updates.length = 0
    click(rendered.container, '@ candidates: clue packs'); await flush()
    expect([lastPatch(h), h.settings.value.clueSourcesMentionEnabled]).toEqual([{ cluePacksMentionEnabled: false }, { 'acme.docs': false }])
    const batches: [string, Record<string, unknown>][] = [
      ['Disable all sources', { clueSourcesEnabled: { 'builtin.files': false, 'acme.docs': false } }],
      ['Enable all sources', { clueSourcesEnabled: { 'builtin.files': true, 'acme.docs': true } }],
      ['Disable all @', { clueSourcesMentionEnabled: { 'builtin.files': false, 'acme.docs': false } }],
      ['Enable all @', { clueSourcesMentionEnabled: { 'builtin.files': true, 'acme.docs': true } }],
    ]
    for (const [label, patch] of batches) {
      h.settings.updates.length = 0
      click(rendered.container, label); await flush()
      expect([h.settings.updates.length, lastPatch(h)]).toEqual([1, patch])
    }
    click(rendered.container, 'Disable all sources'); await flush()
    const nextClues = { ...h.clues, api: { ...h.clues.api, sources: async () => ({
      ...CATALOGUE, sources: [...CATALOGUE.sources, source('later.source', 'Later source')],
    }) } }
    const rerendered = renderSection(h, { clues: nextClues, initialGroup: 'sources' }); await flush()
    expect(switchState(rerendered.container, 'Enable source: Later source')).toBe(true)
    rendered.unmount(); rerendered.unmount()
  })
  it('uses cached reads for entry/observations/close, forcing only Retry, and opens one stable window', async () => {
    const h = harness()
    h.clues.registerSourceDisplay({ sourceId: 'acme.docs', name: '   ' })
    const inspect = vi.fn(h.runtime.dependenciesInspect).mockRejectedValueOnce(new Error('probe failed'))
    const status = vi.fn(h.runtime.connectionsStatus)
    h.runtime.dependenciesInspect = inspect; h.runtime.connectionsStatus = status
    const rendered = await mountSources(h)
    expect(rendered.container.textContent).toContain('Acme Docs')
    expect(inspect).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal))
    expect(status).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal), false)
    inspect.mockClear(); status.mockClear()
    click(rendered.container, 'Retry'); await flush()
    expect(inspect).toHaveBeenLastCalledWith({ refresh: true }, expect.any(AbortSignal))
    expect(status).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal), true)
    inspect.mockClear(); status.mockClear()
    act(() => { publishClueTask(h.runtime, installTask({ state: 'succeeded' })) }); await flush()
    expect(inspect).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal))
    expect(status).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal), false)
    inspect.mockClear(); status.mockClear()
    click(rendered.container, 'Configure source: Acme Docs')
    const windows = windowsOf(h)
    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({ id: 'clue-source:acme.docs', title: 'Source settings: Acme Docs',
      size: 'collection', content: { props: { sourceId: 'acme.docs' } } })
    closeWindow(h, 'clue-source:acme.docs'); await flush()
    expect(inspect).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal))
    expect(status).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal), false)
    rendered.unmount()
  })
  it.each(['ready', 'missing'] as const)(
    'restores the real %s state after the config window closed while a task was installing',
    async state => {
      const h = harness(); const rendered = await mountSources(h)
      click(rendered.container, 'Configure source: Acme Docs')
      act(() => { publishClueTask(h.runtime, installTask()) })
      expect(statusOf(rendered.container, 'acme.docs')).toBe('installing')
      let reads = 0
      h.runtime.dependenciesInspect = async () => { reads += 1; return [dependency({ state })] }
      closeWindow(h, 'clue-source:acme.docs'); await flush()
      expect([reads > 0, statusOf(rendered.container, 'acme.docs'),
        rowFor(rendered.container, 'acme.docs')?.textContent?.includes('Installing')])
        .toEqual([true, state, false])
      rendered.unmount()
    },
  )
  it.each(['ready', 'missing'] as const)(
    'keeps observing a running install after the config window closed (settles on %s)',
    async state => {
      vi.useFakeTimers()
      try {
        const h = harness()
        h.runtime.dependenciesInspect = async () => [dependency({ state: 'installing' })]
        h.runtime.dependenciesStatus = async () => [installTask()]
        const rendered = await mountSources(h)
        expect(statusOf(rendered.container, 'acme.docs')).toBe('installing')
        click(rendered.container, 'Configure source: Acme Docs')
        const page = renderRoot(windowsOf(h)[0]!.content as ReactNode); await flush()
        page.unmount(); closeWindow(h, 'clue-source:acme.docs'); await flush()
        expect(statusOf(rendered.container, 'acme.docs')).toBe('installing')
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        const originalSources = h.clues.api.sources
        h.clues.api.sources = async () => { await gate; return originalSources() }
        h.runtime.dependenciesStatus = async () => [installTask({ state: 'succeeded',
          progress: { stage: 'completed' }, finishedAt: '2026-10-17T00:01:00.000Z' })]
        h.runtime.dependenciesInspect = async () => [dependency({ state })]
        await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
        expect(statusOf(rendered.container, 'acme.docs')).toBe('unchecked')
        release(); await flush()
        expect([statusOf(rendered.container, 'acme.docs'),
          rowFor(rendered.container, 'acme.docs')?.textContent?.includes('Installing')]).toEqual([state, false])
        rendered.unmount()
      } finally {
        vi.useRealTimers()
      }
    },
  )
  it('attributes dependency and connection probe failures to their own rows', async () => {
    const h = harness({ catalogue: { sources: [
      source('dep.only', 'Dependency source', { transport: 'cli', dependencyIds: ['dep.cli'] }),
      source('conn.only', 'Connection source', { transport: 'http', connectionId: 'conn.auth' }),
    ], types: [] } })
    h.runtime.dependenciesInspect = async () => { throw new Error('the dependency probe is down') }
    h.runtime.connectionsStatus = async () => { throw new Error('the connection probe is down') }
    const rendered = await mountSources(h)
    const dep = rowFor(rendered.container, 'dep.only')!; const conn = rowFor(rendered.container, 'conn.only')!
    expect([statusOf(rendered.container, 'dep.only'), statusOf(rendered.container, 'conn.only')])
      .toEqual(['request-failed', 'request-failed'])
    expect([dep.textContent?.includes('the dependency probe is down'),
      dep.textContent?.includes('the connection probe is down'),
      conn.textContent?.includes('the connection probe is down'),
      conn.textContent?.includes('the dependency probe is down')]).toEqual([true, false, true, false])
    rendered.unmount()
  })
  it('keeps the old table visible with a busy cue during reload and aborts the read on unmount', async () => {
    const h = harness(); const rendered = await mountSources(h)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalSources = h.clues.api.sources
    h.clues.api.sources = async () => { await gate; return originalSources() }
    act(() => { h.clues.registerSourceDisplay({ sourceId: 'acme.docs', name: 'Acme Docs' }) })
    await act(async () => { await Promise.resolve() })
    expect([rowFor(rendered.container, 'acme.docs') !== null,
      rendered.container.textContent?.includes('Loading')]).toEqual([true, true])
    release(); await flush()
    let signal: AbortSignal | undefined
    h.clues.api.sources = async nextSignal => {
      signal = nextSignal
      return new Promise<CluesSourcesCatalogResult>(() => {})
    }
    act(() => { h.clues.registerSourceDisplay({ sourceId: 'later.source', name: 'Later source' }) })
    await act(async () => { await Promise.resolve() })
    rendered.unmount(); expect([signal !== undefined, signal?.aborted]).toEqual([true, true])
  })
  it('opens the source-plugin catalog instead of tab-plugin recommendations', async () => {
    const rendered = await mountSources(harness())
    click(rendered.container, 'Add source plugin'); await flush()
    const modalBody = document.querySelector('[data-clue-add-source]')!
    expect([document.body.textContent?.includes(en.clueAddSource),
      document.body.textContent?.includes(en.clueAddSourceDesc),
      modalBody.textContent?.includes('Browse more plugins on GitHub'),
      modalBody.textContent?.includes(en.addPluginsRecommended),
      modalBody.querySelector('input[type="search"]') !== null,
      document.body.textContent?.includes('installed successfully')]).toEqual([true, false, true, true, true, false])
    for (const entry of builtinClueSourcePlugins) {
      const name = typeof entry.name === 'function' ? entry.name() : entry.name
      const category = typeof entry.category === 'function' ? entry.category() : entry.category
      expect([modalBody.textContent?.includes(name), modalBody.textContent?.includes(entry.install),
        modalBody.textContent?.includes(category), modalBody.querySelector(`[data-clue-source-plugin="${entry.id}"]`) !== null])
        .toEqual([true, true, true, true])
    }
    expect([modalBody.querySelectorAll(`button[aria-label^="${en.openPlugin}:"]`).length,
      modalBody.querySelectorAll(`button[aria-label^="${en.copyInstall}:"]`).length])
      .toEqual([builtinClueSourcePlugins.length * 2, builtinClueSourcePlugins.length])
    for (const entry of builtinTabPlugins) expect(modalBody.textContent).not.toContain(entry.install)
    rendered.unmount()
  })
  it('offers a retry when a status probe fails, and recovers without remounting', async () => {
    const h = harness(); let fail = true
    const originalInspect = h.runtime.dependenciesInspect
    h.runtime.dependenciesInspect = async (...args) => {
      if (fail) { fail = false; throw new Error('the dependency probe is down') }
      return originalInspect(...args)
    }
    const rendered = await mountSources(h)
    expect(rendered.container.textContent).toContain('the dependency probe is down')
    click(rendered.container, 'Retry'); await flush()
    expect([rendered.container.textContent?.includes('the dependency probe is down'),
      statusOf(rendered.container, 'acme.docs')]).toEqual([false, 'ready'])
    rendered.unmount()
  })
  it('keeps rows unchecked while a failed catalogue retry probes the new set', async () => {
    const h = harness(); let failCatalogue = true
    const originalSources = h.clues.api.sources
    h.clues.api.sources = async () => {
      if (failCatalogue) throw new Error('the source catalogue is down')
      return { ...CATALOGUE, sources: [...CATALOGUE.sources,
        source('later.source', 'Later source', { transport: 'cli', dependencyIds: ['later.cli'] })] }
    }
    const rendered = await mountSources(h)
    expect(rendered.container.textContent).toContain('the source catalogue is down')
    failCatalogue = false
    let releaseProbe!: () => void
    const probeGate = new Promise<void>(resolve => { releaseProbe = resolve })
    const originalInspect = h.runtime.dependenciesInspect
    h.runtime.dependenciesInspect = async () => {
      await probeGate
      return [dependency(), dependency({ dependencyId: 'later.cli', name: 'Later CLI' })]
    }
    click(rendered.container, 'Retry'); await flush()
    for (const id of ['acme.docs', 'later.source']) {
      expect([statusOf(rendered.container, id), rowFor(rendered.container, id)?.textContent?.includes('Not checked')])
        .toEqual(['unchecked', true])
    }
    releaseProbe(); await flush()
    expect([statusOf(rendered.container, 'acme.docs'), statusOf(rendered.container, 'later.source')])
      .toEqual(['ready', 'ready'])
    h.runtime.dependenciesInspect = originalInspect; h.clues.api.sources = originalSources
    rendered.unmount()
  })
})
describe('SideCardSection conflict handling', () => {
  it('re-reads the revision after a 409, retries the SAME patch once, and keeps both scalar and map edits', async () => {
    const h = harness(); h.settings.conflicts = 1
    h.settings.externalChange = { customCss: '/* written elsewhere */' }
    const rendered = await mount(h); const readsBefore = h.settings.reads
    click(rendered.container, 'Inject the sidebar-open tool for the model'); await flush()
    expect(h.settings.reads).toBeGreaterThan(readsBefore)
    expect(h.settings.updates).toHaveLength(2)
    expect(h.settings.updates[1]).toEqual({ patch: { agentOpenTools: true }, expectedRevision: 1 })
    expect([h.store.getPrefs().agentOpenTools, h.store.getPrefs().customCss])
      .toEqual([true, '/* written elsewhere */'])
    expect(switchState(rendered.container, 'Inject the sidebar-open tool for the model')).toBe(true)
    rendered.unmount()
    const map = harness(); map.settings.value = { tabsEnabled: { explorer: true, subagent: true } }
    map.settings.conflicts = 1; map.settings.externalChange = { tabsEnabled: { explorer: false } }
    const mapView = await mount(map)
    click(mapView.container, 'Tabs'); click(mapView.container, 'Subagents'); await flush()
    expect(map.settings.updates).toHaveLength(2)
    expect(map.settings.updates[1]!.patch).toEqual({ tabsEnabled: { subagent: false } })
    expect([map.settings.value.tabsEnabled, map.store.getPrefs().tabsEnabled])
      .toEqual([{ explorer: false, subagent: false }, { explorer: false, subagent: false }])
    expect(mapView.container.textContent).not.toContain('The setting changed in another window')
    mapView.unmount()
  })
  it('keeps the edit and reports the conflict when the retry also fails (never pretends it saved)', async () => {
    const h = harness(); h.settings.conflicts = 2
    const rendered = await mount(h); h.settings.externalChange = { customCss: '/* moved again */' }
    click(rendered.container, 'Inject the sidebar-open tool for the model'); await flush()
    expect(rendered.container.textContent).toContain('The setting changed in another window — please retry')
    expect([switchState(rendered.container, 'Inject the sidebar-open tool for the model'),
      h.store.getPrefs().agentOpenTools]).toEqual([true, false])
    rendered.unmount()
  })
  it('queues kept edits across a store notification, saves them next, and rolls back rapid failures', async () => {
    const h = harness(); h.settings.value = { tabsEnabled: { explorer: true, subagent: true } }
    h.settings.conflicts = 2
    const rendered = await mount(h)
    click(rendered.container, 'Tabs'); click(rendered.container, 'Subagents'); await flush()
    expect(rendered.container.textContent).toContain('The setting changed in another window')
    h.store.setPrefs({ ...h.store.getPrefs(), customCss: '/* session change */' }); await flush()
    expect(switchState(rendered.container, 'Subagents')).toBe(false)
    click(rendered.container, 'Explorer'); await flush()
    expect(lastPatch(h)).toEqual({ tabsEnabled: { subagent: false, explorer: false } })
    expect([h.settings.value.tabsEnabled, h.store.getPrefs().tabsEnabled])
      .toEqual([{ explorer: false, subagent: false }, { explorer: false, subagent: false }])
    rendered.unmount()
    const failed = harness(); const failedView = await mount(failed)
    failed.settings.settingsUpdate = async () => { throw new Error('the settings route is down') }
    click(failedView.container, 'Inject the sidebar-open tool for the model')
    click(failedView.container, "Don't auto-open on narrow screens"); await flush()
    expect([switchState(failedView.container, 'Inject the sidebar-open tool for the model'),
      switchState(failedView.container, "Don't auto-open on narrow screens"),
      failedView.container.textContent?.includes('the settings route is down'),
      failed.store.getPrefs().agentOpenTools, failed.store.getPrefs().mobileNoAutoOpen])
      .toEqual([false, true, true, false, true])
    failedView.unmount()
  })
})
describe('SideCardSection revision fencing', () => {
  it('never writes without a revision: queues on a pending mount read, refuses a failed one, ignores stale reads', async () => {
    const waiting = harness()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = waiting.settings.settingsGet.bind(waiting.settings)
    let reads = 0
    waiting.settings.settingsGet = async () => {
      reads += 1
      if (reads === 1) await gate
      return original()
    }
    const queued = renderSection(waiting)
    click(queued.container, 'Inject the sidebar-open tool for the model'); await flush()
    expect(waiting.settings.updates).toHaveLength(0)
    release(); await flush()
    expect(waiting.settings.updates).toEqual([{ patch: { agentOpenTools: true }, expectedRevision: 0 }])
    queued.unmount()
    const failed = harness()
    failed.settings.settingsGet = async () => { throw new Error('the settings route is down') }
    const failedView = renderSection(failed); await flush()
    click(failedView.container, 'Inject the sidebar-open tool for the model'); await flush()
    expect([failed.settings.updates.length,
      switchState(failedView.container, 'Inject the sidebar-open tool for the model'),
      failedView.container.textContent?.includes('the settings route is down')]).toEqual([0, false, true])
    failedView.unmount()
    const slowHarness = harness()
    let releaseSlow!: () => void
    const slowGate = new Promise<void>(resolve => { releaseSlow = resolve })
    const originalSlow = slowHarness.settings.settingsGet.bind(slowHarness.settings)
    let calls = 0
    slowHarness.settings.settingsGet = async () => {
      calls += 1
      const snapshot = await originalSlow()
      if (calls === 1) await slowGate
      return snapshot
    }
    const slow = renderSection(slowHarness)
    slowHarness.settings.settingsGet = originalSlow
    const fast = await mount(slowHarness)
    click(fast.container, 'Inject the sidebar-open tool for the model'); await flush()
    releaseSlow(); await flush()
    expect([slowHarness.store.getPrefs().agentOpenTools,
      switchState(slow.container, 'Inject the sidebar-open tool for the model')]).toEqual([true, true])
    slow.unmount(); fast.unmount()
  })
  it('does not adopt or hide stale write responses around another entry and a queued optimistic edit', async () => {
    const h = harness()
    const first = await mount(h); const second = await mount(h)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalUpdate = h.settings.settingsUpdate.bind(h.settings)
    let delay = true
    h.settings.settingsUpdate = async (patch, expectedRevision) => {
      const view = await originalUpdate(patch, expectedRevision)
      if (delay) { delay = false; await gate }
      return view
    }
    click(first.container, 'Inject the sidebar-open tool for the model'); await flush()
    click(second.container, "Don't auto-open on narrow screens"); await flush()
    expect(h.store.getPrefs().mobileNoAutoOpen).toBe(false)
    release(); await flush()
    expect([switchState(first.container, "Don't auto-open on narrow screens"),
      switchState(second.container, "Don't auto-open on narrow screens")]).toEqual([false, false])
    first.unmount(); second.unmount()
    const queuedHarness = harness(); const queued = await mount(queuedHarness)
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve })
    const originalQueued = queuedHarness.settings.settingsUpdate.bind(queuedHarness.settings)
    let calls = 0
    queuedHarness.settings.settingsUpdate = async (patch, expectedRevision) => {
      const view = await originalQueued(patch, expectedRevision)
      calls += 1
      if (calls === 1) await firstGate
      if (calls === 2) await secondGate
      return view
    }
    click(queued.container, 'Inject the sidebar-open tool for the model'); await flush()
    click(queued.container, "Don't auto-open on narrow screens")
    releaseFirst(); await flush()
    expect(switchState(queued.container, "Don't auto-open on narrow screens")).toBe(false)
    releaseSecond(); await flush()
    expect([queuedHarness.store.getPrefs().mobileNoAutoOpen,
      switchState(queued.container, "Don't auto-open on narrow screens")]).toEqual([false, false])
    queued.unmount()
  })
})
describe('SideCardSection dual entry', () => {
  it('two mounted sections share one document, a reopened entry reads it back, and only prefs are written', async () => {
    const h = harness()
    const first = await mount(h); const second = await mount(h)
    click(first.container, 'Inject the sidebar-open tool for the model'); await flush()
    expect(switchState(second.container, 'Inject the sidebar-open tool for the model')).toBe(true)
    click(second.container, "Don't auto-open on narrow screens"); await flush()
    expect(h.settings.updates.at(-1)).toEqual({ patch: { mobileNoAutoOpen: false }, expectedRevision: 1 })
    first.unmount(); second.unmount()
    const reopened = await mount(h)
    expect([switchState(reopened.container, 'Inject the sidebar-open tool for the model'),
      switchState(reopened.container, "Don't auto-open on narrow screens")]).toEqual([true, false])
    reopened.unmount()
    const clueHarness = harness(); const clueView = await mountSources(clueHarness)
    click(clueView.container, 'Enable source: Acme Docs'); await flush()
    click(clueView.container, '@ candidates: Acme Docs'); await flush()
    click(clueView.container, '@ candidates: clue packs'); await flush()
    const allowed = new Set(Object.keys(SIDEBAR_PREFS_DEFAULTS))
    for (const update of clueHarness.settings.updates) {
      for (const key of Object.keys(update.patch)) expect(allowed.has(key), key).toBe(true)
    }
    expect(JSON.stringify(clueHarness.settings.value)).not.toContain('members')
    expect(JSON.stringify(clueHarness.settings.value)).not.toContain('snapshot')
    clueView.unmount()
  })
})
describe('SideCardSection deep links', () => {
  it('lands on Clue sources, opens only a configurable source, and consumes a live link once', async () => {
    openClueSettings({ group: 'sources', sourceId: 'acme.docs' })
    const configuredHarness = harness()
    const configured = await mount(configuredHarness)
    expect([selected(configured.container), windowsOf(configuredHarness)[0]?.id, peekClueSettingsTarget()])
      .toEqual(['Clue sources', 'clue-source:acme.docs', undefined])
    configured.unmount()
    openClueSettings({ group: 'sources', sourceId: 'builtin.files' })
    const emptyHarness = harness(); const empty = await mount(emptyHarness)
    expect([selected(empty.container), windowsOf(emptyHarness).length, peekClueSettingsTarget()])
      .toEqual(['Clue sources', 0, undefined])
    empty.unmount()
    const liveHarness = harness(); const live = await mount(liveHarness)
    act(() => { openClueSettings({ group: 'appearance' }) })
    expect(live.container.textContent).toContain('Custom CSS')
    expect(peekClueSettingsTarget()).toBeUndefined()
    live.unmount()
    const reopened = await mount(liveHarness)
    expect(selected(reopened.container)).toBe('General')
    reopened.unmount()
  })
})
