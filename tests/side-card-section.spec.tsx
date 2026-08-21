/**
 * Side card settings section render tests: the section is DECLARATIVE —
 * every small card (icon, title, type id, extensions, on/off state) derives
 * from the sidebar service's tab/viewer registries instead of hardcoded
 * copy. The toggles are CARDS in a responsive grid: the card's main area is
 * the switch, the visual state IS the state (highlighted = enabled),
 * announced via `aria-pressed`, and the check badge sits at the far right.
 * The general rows follow the DSH settings-row recipe with custom SWITCHES
 * (real checkboxes driving a styled track). Features that declare related
 * settings carry a gear corner button whose popup rows (switch controls)
 * are tested through the extracted FeatureSettingsRows component (the Modal
 * portal renders only while open).
 *
 * Rendered with renderToString (mount effects — the settings RPC sync — do
 * not run in SSR; the initial store prefs are the render input).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import { createSidebarStore, type SidebarStore } from '../src/client/state.ts'
// The copy assertions below are English; pin the browser language so the
// module-level t()/isZh() resolve en regardless of the host system locale
// (vitest 4.1.11+/jsdom follow the OS locale — zh-CN on this machine).
beforeAll(() => {
  Object.defineProperty(navigator, 'language', {
    value: 'en-US',
    configurable: true,
  })
})
import { createBetterSidebarService, type BetterSidebarService } from '../src/client/service.ts'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'
import { FeatureSettingsRows, mergePluginSetting, SideCardSection, type SideCardSectionProps } from '../src/client/SideCardSection.tsx'

/** One tab + one viewer + the subagent-style nested toggle under a tab. */
function mount(): { store: SidebarStore; service: BetterSidebarService } {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
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
    settings: {
      toggles: [{
        key: 'autoOpenSubagent',
        title: () => 'Auto-open Subagents',
        desc: () => 'Expand on new subagent',
      }],
    },
    component: () => null,
  })
  service.registerFileViewer({
    id: 'image',
    title: () => 'Image',
    icon: () => createElement('svg', { 'data-icon': 'image' }),
    exts: ['png', 'jpg'],
    fetchStrategy: 'mediaUrl',
    component: () => null,
  })
  return { store, service }
}

function renderSection(store: SidebarStore, service: BetterSidebarService): string {
  return renderToString(createElement(
    SideCardSection,
    { store, service } as unknown as SideCardSectionProps,
  ))
}

/** Count `aria-pressed` occurrences of one value in the rendered HTML. */
function pressedCount(html: string, value: string): number {
  return html.match(new RegExp(`aria-pressed="${value}"`, 'g'))?.length ?? 0
}

describe('SideCardSection declarative inventory', () => {
  it('renders one small card per registered tab: icon + title + type id + pressed state', () => {
    const { store, service } = mount()
    const html = renderSection(store, service)
    expect(html).toContain('data-icon="explorer"')
    expect(html).toContain('>Explorer<')
    // The type id is the card's desc (the declarative "type" surface).
    expect(html).toContain('>explorer<')
    expect(html).toContain('data-icon="subagent"')
    expect(html).toContain('>Subagents<')
    // Default prefs: only the interceptOpenPath switch is checked (openByDefault
    // now defaults off), and both tabs + the image viewer cards pressed
    // (3 aria-pressed cards).
    // The nested auto-open toggle is NOT an inline card (it lives in the popup).
    expect(pressedCount(html, 'true')).toBe(3)
    expect(pressedCount(html, 'false')).toBe(0)
    // The general toggles are custom switches (real checkboxes, one checked).
    expect(html.match(/checked=""/g)?.length).toBe(1)
    expect(html).not.toContain('Auto-open Subagents')
  })

  it('renders the section intro and group headings with inventory counts', () => {
    const { store, service } = mount()
    const html = renderSection(store, service)
    expect(html).toContain('Manage what the side card shows and how it behaves')
    // Group headings carry the inventory count badge (2 tabs, 1 viewer).
    expect(html).toContain('>Sidebar content</span><span')
    expect(html).toContain('>File viewers</span><span')
    expect(html).toContain('>2</span>')
    expect(html).toContain('>1</span>')
  })

  it('renders one small card per registered viewer: icon + title + exts', () => {
    const { store, service } = mount()
    const html = renderSection(store, service)
    expect(html).toContain('data-icon="image"')
    expect(html).toContain('>Image<')
    // The covered extensions are the card's desc.
    expect(html).toContain('png · jpg')
  })

  it('renders the gear corner button on features that declare related settings', () => {
    const { store, service } = mount()
    const html = renderSection(store, service)
    // Subagents declares a toggle → its card carries the settings gear
    // (aria-label = "<title> Feature settings"); Explorer and Image declare
    // none → no gear. The position-compat row is a DROPDOWN (no gear unless
    // the custom scheme is active), so the total is 1.
    expect(html.match(/aria-label="[^"]*Feature settings"/g)?.length).toBe(1)
    expect(html).toContain('Subagents Feature settings')
  })

  it('renders the two dashed "add plugin" cards (tab grid + viewer grid)', () => {
    const { store, service } = mount()
    const html = renderSection(store, service)
    // The tab grid's dashed card (tab registration).
    expect(html).toContain('Add tab plugins')
    expect(html).toContain('Register a new sidebar page')
    // The viewer grid's dashed card (file-previewer registration).
    expect(html).toContain('Add preview plugins')
    expect(html).toContain('Register a file-type preview')
    // The add cards are plain buttons (open the modals), never switches:
    // they carry no aria-pressed, so the pressed-card counts stay untouched.
    expect(pressedCount(html, 'true')).toBe(3)
  })

  it('a disabled feature renders pressed=false', () => {
    const { store, service } = mount()
    store.setPrefs({ ...store.getPrefs(), tabsEnabled: { subagent: false }, viewersEnabled: { image: false } })
    const html = renderSection(store, service)
    expect(html).toContain('>Subagents<')
    expect(html).toContain('>Image<')
    expect(pressedCount(html, 'false')).toBe(2)
    // The explorer card stays pressed; the one default-on general switch stays checked.
    expect(pressedCount(html, 'true')).toBe(1)
    expect(html.match(/checked=""/g)?.length).toBe(1)
  })

  it('hides the gear of a disabled feature (its related settings are dormant)', () => {
    const { store, service } = mount()
    store.setPrefs({ ...store.getPrefs(), tabsEnabled: { subagent: false } })
    const html = renderSection(store, service)
    // The disabled Subagents card loses its gear; the position-compat row
    // is a dropdown (default auto → no gear either).
    expect(html).not.toContain('Feature settings')
  })

  it('renders the position-compat mode row as a scheme dropdown: auto default, custom keeps the gear', () => {
    const { store, service } = mount()
    let html = renderSection(store, service)
    // The general row renders its title and description; the scheme is the
    // conservative auto by default and the row is the shared SelectMenu
    // dropdown (the closed anchor shows the picked option — NOT a native
    // <select>).
    expect(html).toContain('Position compatibility mode')
    expect(html).toContain('Pick the title-bar compatibility scheme: auto-detect (default, conservative) / DSH official web / known desktop shells / custom (shift distance + custom CSS)')
    expect(html).not.toContain('<select')
    expect(html).toContain('>Auto-detect<')
    // Two general-row switches remain (openByDefault + interceptOpenPath),
    // only interceptOpenPath checked by default — the scheme row is a
    // dropdown, not a switch.
    expect(html.match(/type="checkbox"/g)?.length).toBe(2)
    expect(html.match(/checked=""/g)?.length).toBe(1)
    // Auto (default) needs no further settings → no gear.
    expect(html).not.toContain('Position compatibility mode Feature settings')

    // The custom scheme keeps its settings button (the px + CSS popup);
    // the anchor now shows the picked custom option.
    store.setPrefs({ ...store.getPrefs(), titleBarScheme: 'custom', titleBarCompat: true })
    html = renderSection(store, service)
    expect(html).toContain('>Custom<')
    expect(html).toContain('aria-label="Position compatibility mode Feature settings"')
  })
})

describe('FeatureSettingsRows (the secondary settings popup body)', () => {
  const prefs: typeof SIDEBAR_PREFS_DEFAULTS = {
    ...SIDEBAR_PREFS_DEFAULTS,
    autoOpenSubagent: false,
  }
  const toggles = [{
    key: 'autoOpenSubagent',
    title: () => 'Auto-open Subagents',
    desc: () => 'Expand on new subagent',
  }]

  it('renders one switch row per declared toggle with its current value', () => {
    const html = renderToString(createElement(FeatureSettingsRows, {
      toggles,
      prefs,
      onToggle: () => {},
    }))
    expect(html).toContain('Auto-open Subagents')
    expect(html).toContain('Expand on new subagent')
    // The row's switch is a real checkbox (aria-label = the toggle title)
    // reflecting the prefs value (false here → unchecked).
    expect(html).toContain('aria-label="Auto-open Subagents"')
    expect(html).not.toContain('checked=""')
  })

  it('checks the row when the pref is on', () => {
    const html = renderToString(createElement(FeatureSettingsRows, {
      toggles,
      prefs: { ...prefs, autoOpenSubagent: true },
      onToggle: () => {},
    }))
    expect(html).toContain('checked=""')
  })

  it('renders a text row as an input seeded with the pref value (empty = theme default)', () => {
    const html = renderToString(createElement(FeatureSettingsRows, {
      toggles: [{
        key: 'terminalFontFamily',
        type: 'text',
        title: () => 'Font family',
        desc: () => 'CSS stack',
        placeholder: '"JetBrains Mono", monospace',
      }],
      prefs: { ...prefs, terminalFontFamily: '"JetBrains Mono", monospace' },
      onToggle: () => {},
      onCommit: () => '',
    }))
    expect(html).toContain('Font family')
    expect(html).toContain('placeholder="&quot;JetBrains Mono&quot;, monospace"')
    // The input carries the pref value (no switch for text rows).
    expect(html).toContain('value="&quot;JetBrains Mono&quot;, monospace"')
    expect(html).not.toContain('type="checkbox"')
  })

  it('renders a number row with the pref value, the declared bounds and a unit suffix', () => {
    const html = renderToString(createElement(FeatureSettingsRows, {
      toggles: [{
        key: 'terminalFontSize',
        type: 'number',
        title: () => 'Font size',
        min: 9,
        max: 32,
        unit: 'px',
      }],
      prefs: { ...prefs, terminalFontSize: 18 },
      onToggle: () => {},
      onCommit: () => '18',
    }))
    expect(html).toContain('Font size')
    expect(html).toContain('type="number"')
    expect(html).toContain('value="18"')
    expect(html).toContain('min="9"')
    expect(html).toContain('max="32"')
    expect(html).toContain('px')
    expect(html).not.toContain('type="checkbox"')
  })

  it('renders the title-bar strip row: the pref value, the 0–120 bounds and the px suffix', () => {
    const html = renderToString(createElement(FeatureSettingsRows, {
      toggles: [{
        key: 'titleBarStripPx',
        type: 'number',
        title: () => 'Shift distance',
        desc: () => 'Title-bar strip height in px',
        min: 0,
        max: 120,
        unit: 'px',
      }],
      prefs: { ...prefs, titleBarStripPx: 64 },
      onToggle: () => {},
      onCommit: () => '64',
    }))
    expect(html).toContain('Shift distance')
    expect(html).toContain('Title-bar strip height in px')
    expect(html).toContain('type="number"')
    expect(html).toContain('value="64"')
    expect(html).toContain('min="0"')
    expect(html).toContain('max="120"')
    expect(html).toContain('px')
    expect(html).not.toContain('type="checkbox"')
  })
})

describe('mergePluginSetting (v0.12.0, codex review fix)', () => {
  it('sequential merges are additive — a later write never drops an earlier key', () => {
    // Simulates two same-tick updatePluginSetting calls: each merge spreads
    // the map it was GIVEN, so building from the latest optimistic map
    // preserves both keys (the pre-fix code spread the stale render-time
    // prefs twice and the second write dropped the first key).
    let map: Record<string, Record<string, unknown>> = {}
    map = mergePluginSetting(map, 'my-plugin:db', 'pageSize', 25)
    map = mergePluginSetting(map, 'my-plugin:db', 'theme', 'dark')
    expect(map['my-plugin:db']).toEqual({ pageSize: 25, theme: 'dark' })
    // A second descriptor's blob stays independent.
    map = mergePluginSetting(map, 'other:view', 'refresh', true)
    expect(map['my-plugin:db']).toEqual({ pageSize: 25, theme: 'dark' })
    expect(map['other:view']).toEqual({ refresh: true })
    // Overwriting one key keeps the sibling keys.
    map = mergePluginSetting(map, 'my-plugin:db', 'pageSize', 50)
    expect(map['my-plugin:db']).toEqual({ pageSize: 50, theme: 'dark' })
  })
})

describe('FeatureSettingsRows valueSource (v0.12.0, independent CR fix)', () => {
  it('plugin rows read from their OWN value source — a plugin key colliding with a host pref never reads the host value', () => {
    const prefs = { ...SIDEBAR_PREFS_DEFAULTS, openByDefault: true }
    const toggle = { key: 'openByDefault', title: 'My flag' }
    // valueOf returns undefined (the plugin never wrote this key): the row
    // must render UNCHECKED even though the host pref openByDefault is true.
    let html = renderToString(createElement(FeatureSettingsRows, {
      toggles: [toggle],
      prefs,
      onToggle: () => {},
      valueSource: () => undefined,
    }))
    expect(html).not.toContain('checked=""')
    // The plugin wrote `true` into its own blob: the row is checked.
    html = renderToString(createElement(FeatureSettingsRows, {
      toggles: [toggle],
      prefs,
      onToggle: () => {},
      valueSource: () => true,
    }))
    expect(html).toContain('checked=""')
    // Without valueOf the row falls back to the prefs face (host semantics).
    html = renderToString(createElement(FeatureSettingsRows, {
      toggles: [toggle],
      prefs,
      onToggle: () => {},
    }))
    expect(html).toContain('checked=""')
  })
})
