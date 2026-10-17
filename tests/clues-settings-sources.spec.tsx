/**
 * S8 clue source table (presentational): one compact row per registered
 * source with icon + name, the source switch, the @ switch, the derived
 * availability state and the configure entry; one independent pack @ row;
 * two batch controls over the currently registered set; the add-source
 * plugin entry.
 *
 * "Absent preference = ON" is S1's rule, so a source the user never touched
 * renders enabled. The @ switch reflects the STORED preference even while the
 * source is disabled (the value is preserved for re-enabling) but is inert in
 * that state — the effective mention is off, which is what the row announces.
 *
 * Rendered with renderToString: no RPC runs; the panel is pure props.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import { ClueSourcesPanel, type ClueSourcesPanelProps } from '../src/client/clues/settings/sources.tsx'
import type { ClueSourceStatus } from '../src/client/clues/settings/status.ts'
import { SIDEBAR_PREFS_DEFAULTS, type SidebarPrefs } from '../src/prefs-shared.ts'
import type { ClueSourceDescriptor } from '../src/clues/types.ts'

beforeAll(() => {
  Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
})

/** One registered source fixture. */
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

const SOURCES = [
  source('builtin.files', 'Local files', { order: 10 }),
  source('acme.docs', 'Acme Docs', {
    order: 20,
    transport: 'cli',
    dependencyIds: ['acme.cli'],
    connectionId: 'acme.auth',
  }),
]

/** A status map with every source ready unless overridden. */
function statuses(overrides: Record<string, ClueSourceStatus> = {}): ReadonlyMap<string, ClueSourceStatus> {
  return new Map([
    ['builtin.files', { kind: 'ready' }],
    ['acme.docs', { kind: 'ready' }],
    ...Object.entries(overrides),
  ])
}

/** Full shared prefs (the panel consumes the S1 object and its helpers). */
function prefs(overrides: Partial<SidebarPrefs> = {}): SidebarPrefs {
  return { ...SIDEBAR_PREFS_DEFAULTS, ...overrides }
}

/** Default props: everything enabled (S1 absent = ON). */
function props(overrides: Partial<ClueSourcesPanelProps> = {}): ClueSourcesPanelProps {
  return {
    sources: SOURCES,
    displays: [],
    statuses: statuses(),
    prefs: prefs(),
    loading: false,
    error: null,
    statusError: null,
    catalogueLoaded: true,
    onToggleSource: () => {},
    onToggleMention: () => {},
    onTogglePacksMention: () => {},
    onEnableAll: () => {},
    onDisableAll: () => {},
    onMentionAll: () => {},
    onMentionNone: () => {},
    onConfigure: () => {},
    onAddSource: () => {},
    onReload: () => {},
    ...overrides,
  }
}

function render(overrides: Partial<ClueSourcesPanelProps> = {}): string {
  return renderToString(createElement(ClueSourcesPanel, props(overrides)))
}

/** Every role=switch button in the HTML, by accessible name. */
function switches(html: string): { label: string; checked: boolean; disabled: boolean }[] {
  return [...html.matchAll(/<button[^>]*role="switch"[^>]*>/g)].map(match => {
    const tag = match[0]
    return {
      label: /aria-label="([^"]*)"/.exec(tag)?.[1] ?? '',
      checked: /aria-checked="true"/.test(tag),
      disabled: /disabled=""/.test(tag) || /\sdisabled(?:\s|>)/.test(tag),
    }
  })
}

describe('ClueSourcesPanel rows', () => {
  it('renders one row per registered source with its name and derived status', () => {
    const html = render()
    expect(html).toContain('data-clue-source="builtin.files"')
    expect(html).toContain('data-clue-source="acme.docs"')
    expect(html).toContain('Local files')
    expect(html).toContain('builtin.files')
    expect(html).toContain('Ready')
    // The intro explains that enabling is not "installed/authorized".
    expect(html).toContain('does not mean it is installed, authorized')
  })

  it('treats an absent preference as ON (the row renders an enabled source switch)', () => {
    const html = render()
    const on = switches(html)
    const sourceSwitches = on.filter(item => item.label === 'Enable source: Local files')
    expect(sourceSwitches).toEqual([{ label: 'Enable source: Local files', checked: true, disabled: false }])
    expect(switches(html).filter(item => item.label === '@ candidates: Local files'))
      .toEqual([{ label: '@ candidates: Local files', checked: true, disabled: false }])
  })

  it('renders an explicit false as off and preserves the stored @ value while the source is off', () => {
    const html = render({
      prefs: prefs({
        clueSourcesEnabled: { 'builtin.files': false },
        clueSourcesMentionEnabled: { 'builtin.files': true },
      }),
    })
    expect(switches(html)).toContainEqual({ label: 'Enable source: Local files', checked: false, disabled: false })
    // The stored @ pref is still true, but the control is inert while the
    // source is disabled (the effective mention is off).
    expect(switches(html)).toContainEqual({ label: '@ candidates: Local files', checked: true, disabled: true })
  })

  it('renders one @ switch per source and never a second enable switch for the pack row', () => {
    const html = render()
    const labels = switches(html).map(item => item.label)
    expect(labels).toContain('@ candidates: Acme Docs')
    expect(labels).toContain('@ candidates: clue packs')
    expect(labels).toContain('Enable source: Acme Docs')
    // The pack row has the @ switch only (it is not a remote source).
    expect(labels).not.toContain('Enable source: Clue packs')
    expect(html).toContain('data-clue-packs=""')
    expect(html).toContain('not a remote source')
  })

  it('renders the pack @ switch as off when the preference is false (independent of every source)', () => {
    const html = render({
      prefs: prefs({
        clueSourcesEnabled: { 'builtin.files': false, 'acme.docs': false },
        clueSourcesMentionEnabled: { 'builtin.files': false, 'acme.docs': false },
        cluePacksMentionEnabled: false,
      }),
    })
    expect(switches(html)).toContainEqual({ label: '@ candidates: clue packs', checked: false, disabled: false })
  })

  it('uses the client display name and icon override when one is registered', () => {
    const html = render({
      displays: [{ sourceId: 'acme.docs', name: 'Acme Cloud', icon: 'ACME-ICON' }],
    })
    expect(html).toContain('Acme Cloud')
    expect(html).not.toContain('>Acme Docs<')
    expect(html).toContain('ACME-ICON')
  })

  it('renders the derived state label and keeps a long name intact (layout wraps, never truncates)', () => {
    const longName = 'A very long source name that should still be announced in full by the accessible label'
    const html = render({
      sources: [source('acme.docs', longName)],
      statuses: statuses({ 'acme.docs': { kind: 'auth-expired' } }),
    })
    expect(html).toContain(longName)
    expect(html).toContain('Authorization expired')
    expect(html).toContain(`data-clue-source-status="auth-expired"`)
    expect(html).toContain(`aria-label="Enable source: ${longName}"`)
  })
})

describe('ClueSourcesPanel states', () => {
  it('renders each derived state as its own explicit label, never claiming ready for unknown work', () => {
    const kinds = [
      'unchecked', 'missing', 'incompatible', 'installing',
      'not-configured', 'not-authorized', 'authorizing', 'auth-expired',
      'request-failed', 'ready',
    ] as const
    const labels: Record<(typeof kinds)[number], string> = {
      unchecked: 'Not checked',
      missing: 'Missing dependency',
      incompatible: 'Incompatible version',
      installing: 'Installing',
      'not-configured': 'Not configured',
      'not-authorized': 'Not authorized',
      authorizing: 'Authorizing',
      'auth-expired': 'Authorization expired',
      'request-failed': 'Request failed',
      ready: 'Ready',
    }
    const html = render({
      sources: kinds.map(kind => source(`source.${kind}`, `Source ${kind}`)),
      statuses: new Map(kinds.map(kind => [`source.${kind}`, { kind }])),
    })
    for (const kind of kinds) {
      expect(html).toContain(`data-clue-source-status="${kind}"`)
      expect(html, kind).toContain(labels[kind])
    }
  })

  it('shows the sanitized failure detail as hover text, never as a fabricated success', () => {
    const html = render({
      statuses: statuses({
        'acme.docs': { kind: 'request-failed', detail: 'the probe timed out' },
      }),
    })
    expect(html).toContain('Request failed')
    expect(html).toContain('title="the probe timed out"')
  })

  it('keeps configured-but-not-loaded sources visible with their stored preferences', () => {
    const html = render({
      prefs: prefs({
        clueSourcesEnabled: { 'legacy.source': false },
        clueSourcesMentionEnabled: { 'legacy.source': true },
      }),
    })
    expect(html).toContain('data-clue-source="legacy.source"')
    expect(html).toContain('The source plugin is not loaded')
    expect(switches(html)).toContainEqual({ label: 'Enable source: legacy.source', checked: false, disabled: true })
    expect(switches(html)).toContainEqual({ label: '@ candidates: legacy.source', checked: true, disabled: true })
  })

  it('renders loading, failure and empty states as operable surfaces', () => {
    expect(render({ loading: true })).toContain('role="status"')
    expect(render({ loading: true })).toContain('Loading')

    const failed = render({ error: 'the source route answered 500' })
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('Could not load the source list.')
    expect(failed).toContain('Retry')

    const empty = render({ sources: [] })
    expect(empty).toContain('No clue sources are registered yet.')
    expect(empty).toContain('Add source plugin')
  })

  it('does not invent "plugin not loaded" rows before the catalogue was read', () => {
    // First paint / failed catalogue: the stored preference maps merely name
    // sources. Calling them unavailable fabricates a plugin-unloaded verdict.
    const html = render({
      sources: [],
      catalogueLoaded: false,
      loading: true,
      prefs: prefs({
        clueSourcesEnabled: { 'later.source': false },
        clueSourcesMentionEnabled: { 'later.source': true },
      }),
    })
    expect(html).not.toContain('data-clue-source="later.source"')
    expect(html).not.toContain('The source plugin is not loaded')
    // No batch scope is claimed while the registered set is unknown.
    expect(html).not.toContain('Batch actions apply')
  })

  it('offers a retry for a failed status probe without pretending the list failed', () => {
    const html = render({ statusError: 'the status route timed out' })
    expect(html).toContain('role="alert"')
    expect(html).toContain('the status route timed out')
    expect(html).toContain('Request failed')
    expect(html).toContain('Retry')
    // The catalogue itself is still shown (rows keep their derived request-failed state).
    expect(html).toContain('data-clue-source="builtin.files"')
    expect(html).not.toContain('Could not load the source list.')
  })
})

describe('ClueSourcesPanel batch controls', () => {
  it('renders exactly the four explicit batch actions (two per switch kind), as buttons', () => {
    const html = render()
    const batch = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(match => match[1]!)
    expect(batch).toContain('Enable all sources')
    expect(batch).toContain('Disable all sources')
    expect(batch).toContain('Enable all @')
    expect(batch).toContain('Disable all @')
    // Batch controls are not toggles (no aria-pressed / role=switch).
    expect(html.match(/aria-pressed=/g) ?? []).toHaveLength(0)
    expect(html).toContain('Batch actions apply to the currently registered sources only')
  })

  it('names every configure control with the source it configures (only sources that HAVE configuration)', () => {
    const html = render()
    // Local files declares no dependency and no connection: nothing to
    // configure, so no button (the empty-window trap).
    expect(html).not.toContain('aria-label="Configure source: Local files"')
    expect(html).toContain('aria-label="Configure source: Acme Docs"')
    // The not-loaded source has no configure action (there is no plugin to configure).
    expect(html).not.toContain('aria-label="Configure source: legacy.source"')
  })

  it('renders the add-source plugin entry with the CLI-vs-plugin distinction', () => {
    const html = render()
    expect(html).toContain('Add source plugin')
    expect(html).toContain('installing the plugin and installing the CLI it needs are separate steps')
  })
})
