/**
 * S8 grouped settings section (interactive): the Side card section is
 * reorganized into five groups (General / Tabs / File viewers / Clue sources /
 * Appearance) with the existing preferences' values, names and save semantics
 * unchanged. This spec pins:
 *
 * - the group navigation (wide nav buttons + the narrow select) and the
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
 * - the add-source entry reusing the existing plugin modal.
 */
// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'

setupReactAct()
beforeAll(() => {
  Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
})

import { SideCardSection, type SideCardSectionProps } from '../src/client/SideCardSection.tsx'
import { createSidebarStore, type SidebarStore } from '../src/client/state.ts'
import {
  createBetterSidebarService,
  type BetterSidebarService,
  type BetterSidebarServiceHost,
} from '../src/client/service.ts'
import { cluesApi } from '../src/client/clues/api.ts'
import type { BetterSidebarCluesClientFace } from '../src/client/clues/registry.ts'
import type { ClueRuntimeApi } from '../src/client/clues/runtime-api.ts'
import { openClueSettings, peekClueSettingsTarget } from '../src/client/clues/settings/navigation.ts'
import { en } from '../src/client/locales.ts'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'
import type { CluesSourcesCatalogResult, ClueSourceDescriptor } from '../src/clues/types.ts'
import type { ConnectionStatusProjection, DependencyStatus } from '../src/clues/runtime/types.ts'

// ── Fixtures ───────────────────────────────────────────────────────────────

function source(sourceId: string, name: string, extra: Partial<ClueSourceDescriptor> = {}): ClueSourceDescriptor {
  return {
    sourceId,
    name,
    order: 10,
    pluginId: 'test.plugin',
    types: [],
    transport: 'files',
    capabilities: { resolve: true, list: true, search: true, read: true, edit: false, portable: true },
    ...extra,
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
    dependencyId: 'acme.cli',
    name: 'Acme CLI',
    command: 'acme',
    state: 'ready',
    platform: 'darwin',
    arch: 'arm64',
    supported: true,
    installable: true,
    minimumVersion: '1.0.0',
    recommendedVersion: '1.0.0',
    executablePath: '/usr/local/bin/acme',
    ...overrides,
  }
}

function connection(): ConnectionStatusProjection {
  return {
    connectionId: 'acme.auth',
    name: 'Acme Auth',
    pluginId: 'test.plugin',
    configuration: 'ready',
    authorization: 'ready',
    credentialOwner: 'tool',
    capabilities: [],
    action: 'none',
  }
}

/** A fake settings document matching the host's merge + revision semantics. */
class FakeSettings {
  value: Record<string, unknown> = {}
  revision = 0
  readonly updates: { patch: Record<string, unknown>; expectedRevision: number | undefined }[] = []
  /** Number of upcoming writes to answer with a 409 first. */
  conflicts = 0
  /** The "someone else wrote this" value applied when the conflict fires. */
  externalChange: Record<string, unknown> | undefined
  reads = 0

  async settingsGet(): Promise<{ value: unknown; revision: number }> {
    this.reads += 1
    return { value: { ...this.value }, revision: this.revision }
  }

  async settingsUpdate(patch: Record<string, unknown>, expectedRevision?: number): Promise<{ value: unknown; revision: number }> {
    this.updates.push({ patch, expectedRevision })
    if (this.conflicts > 0) {
      this.conflicts -= 1
      this.value = { ...this.value, ...(this.externalChange ?? {}) }
      this.externalChange = undefined
      this.revision += 1
      const error = new Error('the settings document moved on') as Error & { code: string }
      error.code = 'settings-conflict'
      throw error
    }
    if (expectedRevision !== undefined && expectedRevision !== this.revision) {
      const error = new Error('the settings document moved on') as Error & { code: string }
      error.code = 'settings-conflict'
      throw error
    }
    this.value = { ...this.value, ...patch }
    this.revision += 1
    return { value: { ...this.value }, revision: this.revision }
  }
}

/** A fake S2 runtime wrapper: ready dependency + ready connection, no calls. */
function fakeRuntime(dependencies: readonly DependencyStatus[] = [dependency()]): ClueRuntimeApi {
  return {
    dependenciesInspect: async () => dependencies,
    dependenciesPlan: async () => { throw new Error('unexpected plan') },
    dependenciesStart: async () => { throw new Error('unexpected start') },
    dependenciesStatus: async () => [],
    dependenciesCancel: async () => { throw new Error('unexpected cancel') },
    dependenciesSetPath: async () => { throw new Error('unexpected setPath') },
    dependenciesClearPath: async () => { throw new Error('unexpected clearPath') },
    connectionsStatus: async () => [connection()],
    connectionsConnect: async () => { throw new Error('unexpected connect') },
    connectionsPoll: async () => { throw new Error('unexpected poll') },
    connectionsCancel: async () => { throw new Error('unexpected cancel') },
  }
}

/** A service + store + fake wiring for one settings surface. */
interface Harness {
  store: SidebarStore
  service: BetterSidebarService
  settings: FakeSettings
  runtime: ClueRuntimeApi
  clues: BetterSidebarCluesClientFace
}

function harness(options: { catalogue?: CluesSourcesCatalogResult; runtime?: ClueRuntimeApi } = {}): Harness {
  const store = createSidebarStore()
  store.setPrefs({ ...SIDEBAR_PREFS_DEFAULTS })
  const service = createBetterSidebarService(store)
  /**
   * A tab and a viewer with declarative settings, so moving the inventories
   * into groups can be checked against the FULL pre-existing row surface.
   */
  service.registerTab({
    id: 'explorer',
    title: () => 'Explorer',
    icon: () => createElement('svg', { 'data-icon': 'explorer' }),
    order: 10,
    component: () => null,
  })
  service.registerTab({
    id: 'subagent',
    title: () => 'Subagents',
    icon: () => createElement('svg', { 'data-icon': 'subagent' }),
    order: 30,
    settings: { toggles: [{ key: 'autoOpenSubagent', title: () => 'Auto-open Subagents' }] },
    component: () => null,
  })
  service.registerFileViewer({
    id: 'image',
    title: () => 'Image',
    icon: () => createElement('svg', { 'data-icon': 'image' }),
    exts: ['png'],
    fetchStrategy: 'mediaUrl',
    component: () => null,
  })
  const settings = new FakeSettings()
  const runtime = options.runtime ?? fakeRuntime()
  const catalogue = options.catalogue ?? CATALOGUE
  const clues: BetterSidebarCluesClientFace = {
    ...service.clues,
    api: { ...cluesApi, sources: async () => catalogue },
  }
  return { store, service, settings, runtime, clues }
}

/** Render without flushing the mount read (the read-gate tests need that). */
function renderSection(h: Harness, injected: Partial<SideCardSectionProps> = {}): RenderedRoot {
  return renderRoot(createElement(SideCardSection, {
    store: h.store,
    service: h.service,
    settings: h.settings,
    clues: h.clues,
    runtime: h.runtime,
    ...injected,
  } as unknown as SideCardSectionProps))
}

/** Mount the section under act() and flush the mount reads' promises. */
async function mount(h: Harness, injected: Partial<SideCardSectionProps> = {}): Promise<RenderedRoot> {
  const rendered = renderSection(h, injected)
  await flush()
  return rendered
}

/** Flush the mount's chained promises (settings get + catalogue + statuses). */
async function flush(turns = 6): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

/** Click the first control whose accessible name or text matches. */
function click(container: ParentNode, label: string): void {
  const control = [...container.querySelectorAll<HTMLElement>('button, input, a, select, textarea')]
    .find(candidate => candidate.getAttribute('aria-label') === label
      || candidate.textContent?.trim() === label
      // Inventory cards render "<title><type-id>" inside one button.
      || candidate.textContent?.trim().startsWith(label))
  if (control === undefined) throw new Error(`no control labelled "${label}" in ${container.textContent}`)
  act(() => { control.click() })
}

/** Click one role=switch button by its accessible name. */
function toggle(container: ParentNode, label: string): void {
  const control = [...container.querySelectorAll<HTMLElement>('button[role="switch"]')]
    .find(candidate => candidate.getAttribute('aria-label') === label)
  if (control === undefined) throw new Error(`no switch labelled "${label}"`)
  act(() => { control.click() })
}

/** Click the wide group nav button with this label. */
function openGroup(container: ParentNode, label: string): void {
  const button = [...container.querySelectorAll<HTMLElement>('nav button')]
    .find(candidate => candidate.textContent?.trim() === label)
  if (button === undefined) throw new Error(`no group "${label}" in ${container.textContent}`)
  act(() => { button.click() })
}

/** The role=switch state by accessible name. */
function switchState(container: ParentNode, label: string): boolean | undefined {
  const control = [...container.querySelectorAll<HTMLElement>('button[role="switch"]')]
    .find(candidate => candidate.getAttribute('aria-label') === label)
  return control === undefined ? undefined : control.getAttribute('aria-checked') === 'true'
}

/** The checked state of one native checkbox row by accessible name. */
function checkboxState(container: ParentNode, label: string): boolean | undefined {
  const input = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    .find(candidate => candidate.getAttribute('aria-label') === label)
  return input?.checked
}

// ── Group navigation ───────────────────────────────────────────────────────

describe('SideCardSection grouped navigation', () => {
  it('renders the five groups in the spec order and opens on General by default', async () => {
    const h = harness()
    const rendered = await mount(h)
    const groups = [...rendered.container.querySelectorAll('nav button')].map(button => button.textContent?.trim())
    expect(groups).toEqual(['General', 'Tabs', 'File viewers', 'Clue sources', 'Appearance'])
    expect(rendered.container.querySelector('nav button[aria-current="page"]')?.textContent?.trim()).toBe('General')
    // General holds the existing general + mobile rows and nothing from the inventories.
    expect(rendered.container.textContent).toContain('Inject the sidebar-open tool for the model')
    expect(rendered.container.textContent).toContain("Don't auto-open on narrow screens")
    expect(rendered.container.textContent).toContain('Default the Tasks page to the tree')
    expect(rendered.container.textContent).not.toContain('Subagents')
    rendered.unmount()
  })

  it('offers a narrow group selector (same groups) alongside the wide nav', async () => {
    const h = harness()
    const rendered = await mount(h)
    const select = rendered.container.querySelector<HTMLSelectElement>('select')
    expect(select).not.toBeNull()
    expect(select?.getAttribute('aria-label')).toBe('Settings groups')
    expect([...(select?.options ?? [])].map(option => option.textContent)).toEqual([
      'General', 'Tabs', 'File viewers', 'Clue sources', 'Appearance',
    ])
    // Switching the narrow selector switches the pane, exactly like the nav.
    expect(select).not.toBeNull()
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
      setter?.call(select, 'appearance')
      select!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(rendered.container.textContent).toContain('Custom CSS')
    rendered.unmount()
  })

  it('switches the pane to Tabs / File viewers and keeps their counts', async () => {
    const h = harness()
    const rendered = await mount(h)
    openGroup(rendered.container, 'Tabs')
    expect(rendered.container.textContent).toContain('Subagents')
    expect(rendered.container.textContent).toContain('Add tab plugins')
    expect(rendered.container.querySelector('nav button[aria-current="page"]')?.textContent?.trim()).toBe('Tabs')

    openGroup(rendered.container, 'File viewers')
    expect(rendered.container.textContent).toContain('Image')
    expect(rendered.container.textContent).toContain('Add preview plugins')
    rendered.unmount()
  })

  it('starts on an explicitly requested group (deep-link/test seed)', async () => {
    const rendered = await mount(harness(), { initialGroup: 'appearance' })
    expect(rendered.container.querySelector('nav button[aria-current="page"]')?.textContent?.trim()).toBe('Appearance')
    expect(rendered.container.textContent).toContain('Custom CSS')
    rendered.unmount()
  })
})

// ── Existing preference regression ─────────────────────────────────────────

describe('SideCardSection existing preferences', () => {
  it('keeps every general/mobile switch writing its original key through one revision-guarded update', async () => {
    const h = harness()
    const rendered = await mount(h)
    click(rendered.container, 'Inject the sidebar-open tool for the model')
    await flush()
    expect(h.settings.updates.at(-1)).toEqual({ patch: { agentOpenTools: true }, expectedRevision: 0 })
    expect(h.store.getPrefs().agentOpenTools).toBe(true)

    click(rendered.container, "Don't auto-open on narrow screens")
    await flush()
    expect(h.settings.updates.at(-1)?.patch).toEqual({ mobileNoAutoOpen: false })
    click(rendered.container, 'Default the Tasks page to the tree')
    await flush()
    expect(h.settings.updates.at(-1)?.patch).toEqual({ mobileDefaultTree: false })
    rendered.unmount()
  })

  it('keeps the tab and viewer enable switches writing tabsEnabled / viewersEnabled (values unchanged)', async () => {
    const h = harness()
    const rendered = await mount(h)
    openGroup(rendered.container, 'Tabs')
    click(rendered.container, 'Subagents')
    await flush()
    expect(h.settings.updates.at(-1)?.patch).toEqual({ tabsEnabled: { subagent: false } })
    expect(h.store.getPrefs().tabsEnabled.subagent).toBe(false)

    openGroup(rendered.container, 'File viewers')
    click(rendered.container, 'Image')
    await flush()
    expect(h.settings.updates.at(-1)?.patch).toEqual({ viewersEnabled: { image: false } })
    rendered.unmount()
  })

  it('writes both auto-open preferences from General (approved S8 IA)', async () => {
    const h = harness()
    const rendered = await mount(h)
    click(rendered.container, en.settingsSubagentTitle)
    await flush()
    expect(h.settings.updates.at(-1)).toEqual({ patch: { autoOpenSubagent: false }, expectedRevision: 0 })
    click(rendered.container, en.settingsJobsTitle)
    await flush()
    expect(h.settings.updates.at(-1)).toEqual({ patch: { autoOpenJobs: false }, expectedRevision: 1 })
    rendered.unmount()
  })

  it('keeps the custom-CSS escape hatch committing the same customCss key', async () => {
    const h = harness()
    const rendered = await mount(h, { initialGroup: 'appearance' })
    const textarea = rendered.container.querySelector<HTMLTextAreaElement>('textarea')
    expect(textarea).not.toBeNull()
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, 'html { --x: 1; }')
      textarea!.dispatchEvent(new Event('input', { bubbles: true }))
      textarea!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    await flush()
    expect(h.settings.updates.at(-1)?.patch).toEqual({ customCss: 'html { --x: 1; }' })
    rendered.unmount()
  })
})

// ── Clue sources: switches, batches, packs, configure ──────────────────────

describe('SideCardSection clue sources', () => {
  async function mountSources(h: Harness = harness()): Promise<RenderedRoot> {
    const rendered = await mount(h, { initialGroup: 'sources' })
    await flush()
    return rendered
  }

  it('loads the catalogue + statuses only for the explicit Sources group read', async () => {
    const h = harness()
    const rendered = await mount(h)
    expect(rendered.container.textContent).not.toContain('Local files')
    openGroup(rendered.container, 'Clue sources')
    await flush()
    expect(rendered.container.textContent).toContain('Local files')
    expect(rendered.container.textContent).toContain('Acme Docs')
    expect(rendered.container.textContent).toContain('Ready')
    rendered.unmount()
  })

  it('writes one source switch as a merged clueSourcesEnabled map (one commit)', async () => {
    const h = harness()
    const rendered = await mountSources(h)
    h.settings.updates.length = 0
    toggle(rendered.container, 'Enable source: Local files')
    await flush()
    expect(h.settings.updates).toHaveLength(1)
    expect(h.settings.updates[0]!.patch).toEqual({ clueSourcesEnabled: { 'builtin.files': false } })
    rendered.unmount()
  })

  it('writes the @ switch and the independent pack switch to their own keys', async () => {
    const h = harness()
    const rendered = await mountSources(h)
    h.settings.updates.length = 0
    toggle(rendered.container, '@ candidates: Acme Docs')
    await flush()
    expect(h.settings.updates.map(update => update.patch)).toEqual([
      { clueSourcesMentionEnabled: { 'acme.docs': false } },
    ])
    h.settings.updates.length = 0
    toggle(rendered.container, '@ candidates: clue packs')
    await flush()
    expect(h.settings.updates.map(update => update.patch)).toEqual([{ cluePacksMentionEnabled: false }])
    // The pack switch never rewrites a source map (the earlier @ edit stands).
    expect(h.settings.value.clueSourcesMentionEnabled).toEqual({ 'acme.docs': false })
    rendered.unmount()
  })

  it('batch disable/all-on are ONE commit each, over the currently registered ids only', async () => {
    const h = harness()
    const rendered = await mountSources(h)
    h.settings.updates.length = 0
    click(rendered.container, 'Disable all sources')
    await flush()
    expect(h.settings.updates).toHaveLength(1)
    expect(h.settings.updates[0]!.patch).toEqual({
      clueSourcesEnabled: { 'builtin.files': false, 'acme.docs': false },
    })
    h.settings.updates.length = 0
    click(rendered.container, 'Enable all sources')
    await flush()
    expect(h.settings.updates).toHaveLength(1)
    expect(h.settings.updates[0]!.patch).toEqual({
      clueSourcesEnabled: { 'builtin.files': true, 'acme.docs': true },
    })
    rendered.unmount()
  })

  it('batch @ disable/enable follows the same one-commit rule', async () => {
    const h = harness()
    const rendered = await mountSources(h)
    h.settings.updates.length = 0
    click(rendered.container, 'Disable all @')
    await flush()
    expect(h.settings.updates[0]!.patch).toEqual({
      clueSourcesMentionEnabled: { 'builtin.files': false, 'acme.docs': false },
    })
    h.settings.updates.length = 0
    click(rendered.container, 'Enable all @')
    await flush()
    expect(h.settings.updates[0]!.patch).toEqual({
      clueSourcesMentionEnabled: { 'builtin.files': true, 'acme.docs': true },
    })
    rendered.unmount()
  })

  it('batch all-off never invents a global policy: a source registered later is still ON', async () => {
    const h = harness()
    const rendered = await mountSources(h)
    click(rendered.container, 'Disable all sources')
    await flush()
    // A source that appears after the batch was recorded: absent = ON.
    const nextCatalogue = {
      ...CATALOGUE,
      sources: [...CATALOGUE.sources, source('later.source', 'Later source')],
    }
    const nextClues = { ...h.clues, api: { ...h.clues.api, sources: async () => nextCatalogue } }
    const rerendered = renderRoot(createElement(SideCardSection, {
      store: h.store,
      service: h.service,
      settings: h.settings,
      clues: nextClues,
      runtime: h.runtime,
      initialGroup: 'sources',
    } as unknown as SideCardSectionProps))
    await flush()
    expect(switchState(rerendered.container, 'Enable source: Later source')).toBe(true)
    rendered.unmount()
    rerendered.unmount()
  })

  it('opens one source configuration through the S6 window face with a stable identity', async () => {
    const h = harness()
    const rendered = await mountSources(h)
    click(rendered.container, 'Configure source: Acme Docs')
    const windows = (h.service as unknown as BetterSidebarServiceHost).windowHost.getSnapshot().windows
    expect(windows).toHaveLength(1)
    expect(windows[0]!.id).toBe('clue-source:acme.docs')
    expect(windows[0]!.title).toBe('Source settings: Acme Docs')
    expect((windows[0]!.content as { props?: { sourceId?: string } }).props?.sourceId).toBe('acme.docs')
    rendered.unmount()
  })

  it('reuses the existing plugin modal for the add-source entry (no fake install success)', async () => {
    const h = harness()
    const rendered = await mountSources(h)
    click(rendered.container, 'Add source plugin')
    await flush()
    // The shared plugin discovery/install body is mounted under SOURCE copy
    // (not the tab-plugin title), and its per-entry action still only copies
    // the install command (nothing claims the plugin or the CLI was installed).
    expect(document.body.textContent).toContain('Add source plugin')
    expect(document.body.textContent).toContain('Copy')
    expect(rendered.container.textContent).not.toContain('installed successfully')
    rendered.unmount()
  })

  it('offers a retry when a status probe fails, and recovers without remounting', async () => {
    const h = harness()
    let fail = true
    const originalInspect = h.runtime.dependenciesInspect
    h.runtime.dependenciesInspect = async (...args) => {
      if (fail) {
        fail = false
        throw new Error('the dependency probe is down')
      }
      return originalInspect(...args)
    }
    const rendered = await mountSources(h)
    expect(rendered.container.textContent).toContain('the dependency probe is down')
    const retry = [...rendered.container.querySelectorAll<HTMLElement>('button')]
      .find(button => button.textContent?.trim() === 'Retry')
    expect(retry).toBeDefined()
    act(() => { retry!.click() })
    await flush()
    expect(rendered.container.textContent).not.toContain('the dependency probe is down')
    expect(rendered.container.textContent).toContain('Ready')
    rendered.unmount()
  })

  it('picks up a source registered while the section stays mounted', async () => {
    const h = harness()
    const rendered = await mountSources(h)
    expect(rendered.container.textContent).not.toContain('Later source')
    h.clues.api.sources = async () => ({
      ...CATALOGUE,
      sources: [...CATALOGUE.sources, source('later.source', 'Later source')],
    })
    act(() => {
      h.clues.registerSourceDisplay({ sourceId: 'later.source', name: 'Later source' })
    })
    await flush()
    expect(rendered.container.textContent).toContain('Later source')
    rendered.unmount()
  })

  it('keeps configured-but-unloaded sources visible without resurrecting them as ready', async () => {
    const h = harness()
    const prefs = {
      ...SIDEBAR_PREFS_DEFAULTS,
      clueSourcesEnabled: { 'gone.source': false },
      clueSourcesMentionEnabled: { 'gone.source': true },
    }
    h.store.setPrefs(prefs)
    // The persisted document is the authority the mount read adopts.
    h.settings.value = prefs
    const rendered = await mountSources(h)
    expect(rendered.container.textContent).toContain('gone.source')
    expect(rendered.container.textContent).toContain('The source plugin is not loaded')
    expect(switchState(rendered.container, 'Enable source: gone.source')).toBe(false)
    rendered.unmount()
  })
})

// ── 409 conflict ───────────────────────────────────────────────────────────

describe('SideCardSection conflict handling', () => {
  it('re-reads the revision after a 409, retries the SAME patch once, and keeps the edit', async () => {
    const h = harness()
    h.settings.conflicts = 1
    h.settings.externalChange = { customCss: '/* written elsewhere */' }
    const rendered = await mount(h)
    const readsBefore = h.settings.reads
    click(rendered.container, 'Inject the sidebar-open tool for the model')
    await flush()
    // Re-read + retry with the refreshed revision (never a silent overwrite).
    expect(h.settings.reads).toBeGreaterThan(readsBefore)
    expect(h.settings.updates).toHaveLength(2)
    expect(h.settings.updates[1]).toEqual({ patch: { agentOpenTools: true }, expectedRevision: 1 })
    // Both the user's edit and the concurrent change survived; the UI saved it.
    expect(h.store.getPrefs().agentOpenTools).toBe(true)
    expect(h.store.getPrefs().customCss).toBe('/* written elsewhere */')
    expect(checkboxState(rendered.container, 'Inject the sidebar-open tool for the model')).toBe(true)
    rendered.unmount()
  })

  it('keeps the edit and reports the conflict when the retry also fails (never pretends it saved)', async () => {
    const h = harness()
    h.settings.conflicts = 2
    const rendered = await mount(h)
    h.settings.externalChange = { customCss: '/* moved again */' }
    click(rendered.container, 'Inject the sidebar-open tool for the model')
    await flush()
    expect(rendered.container.textContent).toContain('The setting changed in another window — please retry')
    expect(checkboxState(rendered.container, 'Inject the sidebar-open tool for the model')).toBe(true)
    // The store keeps the last SAVED document, not the optimistic edit.
    expect(h.store.getPrefs().agentOpenTools).toBe(false)
    rendered.unmount()
  })

  it('does not let a later store notification clobber a kept 409 edit, and saves it with the next write', async () => {
    const h = harness()
    h.settings.conflicts = 2
    const rendered = await mount(h)
    h.settings.externalChange = { customCss: '/* moved again */' }
    click(rendered.container, 'Inject the sidebar-open tool for the model')
    await flush()
    expect(checkboxState(rendered.container, 'Inject the sidebar-open tool for the model')).toBe(true)
    // Any store notification (session/tab/unread change, the other settings
    // entry saving) must not replace the edit the user still sees.
    h.store.setPrefs({ ...h.store.getPrefs(), customCss: '/* session change */' })
    await flush()
    expect(checkboxState(rendered.container, 'Inject the sidebar-open tool for the model')).toBe(true)

    // The next user write retries the kept patch too — the value the UI kept
    // is not left permanently unsaved.
    click(rendered.container, "Don't auto-open on narrow screens")
    await flush()
    expect(h.settings.updates.at(-1)?.patch).toEqual({
      agentOpenTools: true,
      mobileNoAutoOpen: false,
    })
    expect(h.settings.value.agentOpenTools).toBe(true)
    expect(h.store.getPrefs().agentOpenTools).toBe(true)
    expect(checkboxState(rendered.container, 'Inject the sidebar-open tool for the model')).toBe(true)
    rendered.unmount()
  })
})

// ── Revision fencing ──────────────────────────────────────────────────────

describe('SideCardSection revision fencing', () => {
  it('waits for the mount read before writing (never an unguarded settings update)', async () => {
    const h = harness()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = h.settings.settingsGet.bind(h.settings)
    let reads = 0
    h.settings.settingsGet = async () => {
      reads += 1
      if (reads === 1) await gate
      return original()
    }
    const rendered = renderSection(h)
    click(rendered.container, 'Inject the sidebar-open tool for the model')
    await flush()
    // The user's click is waiting on the (still pending) mount read.
    expect(h.settings.updates).toHaveLength(0)
    release()
    await flush()
    expect(h.settings.updates).toEqual([{ patch: { agentOpenTools: true }, expectedRevision: 0 }])
    rendered.unmount()
  })

  it('fails visibly instead of writing unguarded when no revision can be read', async () => {
    const h = harness()
    h.settings.settingsGet = async () => { throw new Error('the settings route is down') }
    const rendered = renderSection(h)
    await flush()
    click(rendered.container, 'Inject the sidebar-open tool for the model')
    await flush()
    // No expectedRevision could be obtained, so no update was sent at all.
    expect(h.settings.updates).toHaveLength(0)
    expect(rendered.container.textContent).toContain('the settings route is down')
    // The failed write reverts the optimistic toggle.
    expect(checkboxState(rendered.container, 'Inject the sidebar-open tool for the model')).toBe(false)
    rendered.unmount()
  })

  it('a slow mount read cannot resurrect values another entry already superseded', async () => {
    const h = harness()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = h.settings.settingsGet.bind(h.settings)
    let calls = 0
    h.settings.settingsGet = async () => {
      calls += 1
      // Capture the OLD document before the gate: this is the stale read.
      const snapshot = await original()
      if (calls === 1) await gate
      return snapshot
    }
    const slow = renderSection(h)
    // The second entry reads normally, saves a newer value, and notifies the
    // shared store; the slow read then resolves with the superseded document.
    h.settings.settingsGet = original
    const fast = await mount(h)
    click(fast.container, 'Inject the sidebar-open tool for the model')
    await flush()
    expect(h.settings.value.agentOpenTools).toBe(true)
    release()
    await flush()
    expect(h.store.getPrefs().agentOpenTools).toBe(true)
    expect(checkboxState(slow.container, 'Inject the sidebar-open tool for the model')).toBe(true)
    slow.unmount()
    fast.unmount()
  })
})

// ── Two entry points, one document ─────────────────────────────────────────

describe('SideCardSection dual entry', () => {
  it('two mounted sections share one settings document and observe each other’s saved writes', async () => {
    const h = harness()
    const first = await mount(h)
    const second = await mount(h)
    click(first.container, 'Inject the sidebar-open tool for the model')
    await flush()
    expect(h.settings.value.agentOpenTools).toBe(true)
    expect(checkboxState(second.container, 'Inject the sidebar-open tool for the model')).toBe(true)
    // Both speak the same namespace/revision chain: the second write fences on
    // the revision produced by the first.
    click(second.container, "Don't auto-open on narrow screens")
    await flush()
    expect(h.settings.updates.at(-1)).toEqual({ patch: { mobileNoAutoOpen: false }, expectedRevision: 1 })
    first.unmount()
    second.unmount()
  })

  it('a reopened entry reads the same persisted values back (no cached drift)', async () => {
    const h = harness()
    h.settings.value = { agentOpenTools: true, mobileNoAutoOpen: false }
    h.settings.revision = 4
    const rendered = await mount(h)
    expect(checkboxState(rendered.container, 'Inject the sidebar-open tool for the model')).toBe(true)
    expect(checkboxState(rendered.container, "Don't auto-open on narrow screens")).toBe(false)
    rendered.unmount()
  })

  it('never writes clue bodies, pack members or snapshots into settings (preferences only)', async () => {
    const h = harness()
    const rendered = await mount(h, { initialGroup: 'sources' })
    await flush()
    toggle(rendered.container, 'Enable source: Acme Docs')
    await flush()
    toggle(rendered.container, '@ candidates: Acme Docs')
    await flush()
    toggle(rendered.container, '@ candidates: clue packs')
    await flush()
    const allowed = new Set(Object.keys(SIDEBAR_PREFS_DEFAULTS))
    for (const update of h.settings.updates) {
      for (const key of Object.keys(update.patch)) expect(allowed.has(key), key).toBe(true)
    }
    expect(JSON.stringify(h.settings.value)).not.toContain('members')
    expect(JSON.stringify(h.settings.value)).not.toContain('snapshot')
    rendered.unmount()
  })
})

// ── Deep links ─────────────────────────────────────────────────────────────

describe('SideCardSection deep links', () => {
  it('lands on the Clue sources group and opens the named source configuration', async () => {
    openClueSettings({ group: 'sources', sourceId: 'acme.docs' })
    const h = harness()
    const rendered = await mount(h)
    await flush()
    expect(rendered.container.querySelector('nav button[aria-current="page"]')?.textContent?.trim()).toBe('Clue sources')
    const windows = (h.service as unknown as BetterSidebarServiceHost).windowHost.getSnapshot().windows
    expect(windows[0]?.id).toBe('clue-source:acme.docs')
    rendered.unmount()
  })

  it('a live deep link switches an already-mounted section and is consumed exactly once', async () => {
    const h = harness()
    const rendered = await mount(h)
    act(() => { openClueSettings({ group: 'appearance' }) })
    expect(rendered.container.textContent).toContain('Custom CSS')
    // The live receiver is the consumer: reopening Settings later must not
    // replay this target.
    expect(peekClueSettingsTarget()).toBeUndefined()
    rendered.unmount()

    const reopened = await mount(h)
    expect(reopened.container.querySelector('nav button[aria-current="page"]')?.textContent?.trim()).toBe('General')
    reopened.unmount()
  })

  it('does not open an empty configuration window for a source with nothing to configure', async () => {
    openClueSettings({ group: 'sources', sourceId: 'builtin.files' })
    const h = harness()
    const rendered = await mount(h)
    await flush()
    expect(rendered.container.querySelector('nav button[aria-current="page"]')?.textContent?.trim()).toBe('Clue sources')
    expect((h.service as unknown as BetterSidebarServiceHost).windowHost.getSnapshot().windows).toHaveLength(0)
    // The pending target was consumed by the mount, not left to replay.
    expect(peekClueSettingsTarget()).toBeUndefined()
    rendered.unmount()
  })
})
