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
import type { TabDescriptor } from '../src/client/service.ts'
import { FeatureSettingsRows, mergePluginSetting, SettingsBody, SideCardSection, type SideCardSectionProps } from '../src/client/SideCardSection.tsx'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'

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
    // Default prefs: the general switch is off (agentOpenTools defaults off),
    // and both tabs + the image viewer cards are pressed (3 aria-pressed
    // cards). The mobile switches are NOT cards — they are rows in the 手机
    // group, and their own defaults (both on) show up as checked checkboxes.
    // The nested auto-open toggle is NOT an inline card (it lives in the popup).
    expect(pressedCount(html, 'true')).toBe(3)
    expect(pressedCount(html, 'false')).toBe(0)
    // The custom switches are real checkboxes: the two mobile adaptations are
    // on by default, agentOpenTools is not.
    // The two mobile adaptations are on by default.
    expect(html.match(/checked=""/g)?.length ?? 0).toBe(2)
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

  it('renders the mobile group: heading + both narrow-viewport switches, on by default', () => {
    const { store, service } = mount()
    const html = renderSection(store, service)
    expect(html).toContain('>Mobile</div>')
    expect(html).toContain('auto-open on narrow screens')
    expect(html).toContain('Default the Tasks page to the tree')
    // Both are ON by default; disarming one shows up as an unchecked box.
    expect(html).toContain('checked=""')
    store.setPrefs({ ...store.getPrefs(), mobileNoAutoOpen: false, mobileDefaultTree: false })
    const off = renderSection(store, service)
    expect(off).toContain('>Mobile</div>')
    expect(off).not.toContain('checked=""')
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
    // none → no gear, so the total is 1.
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
    // The explorer card stays pressed.
    expect(pressedCount(html, 'true')).toBe(1)
    // The two mobile adaptations are on by default.
    expect(html.match(/checked=""/g)?.length ?? 0).toBe(2)
  })

  it('hides the gear of a disabled feature (its related settings are dormant)', () => {
    const { store, service } = mount()
    store.setPrefs({ ...store.getPrefs(), tabsEnabled: { subagent: false } })
    const html = renderSection(store, service)
    // The disabled Subagents card loses its gear — nothing else renders one.
    expect(html).not.toContain('Feature settings')
  })

  it('renders the custom-CSS escape hatch as its own group (no scheme dropdown, no strip row)', () => {
    const { store, service } = mount()
    let html = renderSection(store, service)
    // The group heading and the textarea's accessible name are the copy key;
    // the placeholder carries the example (a stable selector + a token, NOT
    // the retired --dsh-title-bar-strip variable).
    expect(html).toContain('Custom CSS')
    expect(html).toContain('aria-label="Custom CSS"')
    expect(html).toContain('data-dsh-bottom-panel')
    expect(html).not.toContain('title-bar')
    // Three general-row switches remain (agentOpenTools off by default, plus
    // the two mobile adaptations on) — the removed scheme row was a dropdown.
    expect(html.match(/type="checkbox"/g)?.length).toBe(3)
    // The two mobile adaptations are on by default (agentOpenTools is not).
    expect(html.match(/checked=""/g)?.length ?? 0).toBe(2)
    // The escape hatch is always reachable: no gear, no scheme gate — the
    // only gear left on the page is the Subagents card's own.
    expect(html).not.toContain('Custom CSS Feature settings')
    expect(html.match(/aria-label="[^"]*Feature settings"/g)?.length).toBe(1)

    store.setPrefs({ ...store.getPrefs(), customCss: 'html { --x: 1; }' })
    html = renderSection(store, service)
    expect(html).toContain('html { --x: 1; }')
  })
})

describe('FeatureSettingsRows (the secondary settings popup body)', () => {
  const prefs: typeof SIDEBAR_PREFS_DEFAULTS = {
    ...SIDEBAR_PREFS_DEFAULTS,
    autoOpenSubagent: false,
  }
  /** The row renderer reads `prefs[toggle.key]` for whatever key a descriptor
   *  declares, so a plugin-shaped fixture key needs a widened copy (a fresh
   *  literal with an undeclared key fails excess-property checking). */
  const withPluginKey = (key: string, value: unknown): typeof prefs => ({ ...prefs, [key]: value })
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

  it('renders a text row as an input seeded with the pref value', () => {
    // The row renderer is GENERIC: it reads `prefs[toggle.key]` for whatever
    // key a descriptor declares. These fixtures use plugin-shaped keys that
    // collide with no host pref on purpose.
    const html = renderToString(createElement(FeatureSettingsRows, {
      toggles: [{
        key: 'myPluginFontFamily',
        type: 'text',
        title: () => 'Font family',
        desc: () => 'CSS font stack',
        placeholder: '"JetBrains Mono", monospace',
      }],
      prefs: withPluginKey('myPluginFontFamily', '"JetBrains Mono", monospace'),
      onToggle: () => {},
      onCommit: () => '',
    }))
    expect(html).toContain('Font family')
    expect(html).toContain('placeholder="&quot;JetBrains Mono&quot;, monospace"')
    // The input carries the pref value (no switch for text rows).
    expect(html).toContain('value="&quot;JetBrains Mono&quot;, monospace"')
    expect(html).not.toContain('type="checkbox"')
  })

  it('renders a number row with the pref value, the declared bounds and a unit suffix (non-default bounds)', () => {
    const html = renderToString(createElement(FeatureSettingsRows, {
      toggles: [{
        key: 'myPluginRowPx',
        type: 'number',
        title: () => 'Row height',
        min: 9,
        max: 32,
        unit: 'px',
      }],
      prefs: withPluginKey('myPluginRowPx', 18),
      onToggle: () => {},
      onCommit: () => '18',
    }))
    expect(html).toContain('Row height')
    expect(html).toContain('type="number"')
    expect(html).toContain('value="18"')
    expect(html).toContain('min="9"')
    expect(html).toContain('max="32"')
    expect(html).toContain('px')
    expect(html).not.toContain('type="checkbox"')
  })

  it('renders a bounded number row with its desc line, the declared bounds and the px suffix', () => {
    const html = renderToString(createElement(FeatureSettingsRows, {
      toggles: [{
        key: 'myPluginRowPx',
        type: 'number',
        title: () => 'Row height',
        desc: () => 'Height in px',
        min: 0,
        max: 120,
        unit: 'px',
      }],
      prefs: withPluginKey('myPluginRowPx', 64),
      onToggle: () => {},
      onCommit: () => '64',
    }))
    expect(html).toContain('Row height')
    expect(html).toContain('Height in px')
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
    const prefs = { ...SIDEBAR_PREFS_DEFAULTS, agentOpenTools: true }
    const toggle = { key: 'agentOpenTools', title: 'My flag' }
    // valueOf returns undefined (the plugin never wrote this key): the row
    // must render UNCHECKED even though the host pref agentOpenTools is true.
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

describe('SettingsBody rows + custom render panel (open-with seam)', () => {
  it('renders the declarative rows AND the custom panel when both are declared', () => {
    const { store, service } = mount()
    const feature = {
      id: 'demo',
      title: () => 'Demo',
      component: () => null,
      settings: {
        toggles: [{
          key: 'autoOpenSubagent',
          title: () => 'Auto row',
          desc: () => 'row description',
        }],
        render: () => createElement('div', { 'data-custom-panel': true }, 'custom panel'),
      },
    } as unknown as TabDescriptor
    const html = renderToString(createElement(SettingsBody, {
      feature,
      prefs: SIDEBAR_PREFS_DEFAULTS,
      store,
      service,
      onToggle: () => {},
      onCommit: () => '',
      onSelectValue: () => {},
      onPatterns: () => {},
      onPluginToggle: () => {},
      onPluginCommit: () => '',
      onPluginSelectValue: () => {},
      onPluginPatterns: () => {},
      onPluginWrite: () => {},
      onClose: () => {},
    }))
    expect(html).toContain('Auto row')
    expect(html).toContain('row description')
    expect(html).toContain('data-custom-panel')
    expect(html).toContain('custom panel')
  })

  it('renders ONLY the custom panel when no rows are declared (unchanged behavior)', () => {
    const { store, service } = mount()
    const feature = {
      id: 'demo',
      title: () => 'Demo',
      component: () => null,
      settings: {
        render: () => createElement('div', { 'data-custom-panel': true }, 'custom panel'),
      },
    } as unknown as TabDescriptor
    const html = renderToString(createElement(SettingsBody, {
      feature,
      prefs: SIDEBAR_PREFS_DEFAULTS,
      store,
      service,
      onToggle: () => {},
      onCommit: () => '',
      onSelectValue: () => {},
      onPatterns: () => {},
      onPluginToggle: () => {},
      onPluginCommit: () => '',
      onPluginSelectValue: () => {},
      onPluginPatterns: () => {},
      onPluginWrite: () => {},
      onClose: () => {},
    }))
    expect(html).toContain('custom panel')
    expect(html).not.toContain('Auto row')
  })
})
