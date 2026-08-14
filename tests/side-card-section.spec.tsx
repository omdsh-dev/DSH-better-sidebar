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
import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import { createSidebarStore, type SidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService, type BetterSidebarService } from '../src/client/service.ts'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'
import { FeatureSettingsRows, SideCardSection, type SideCardSectionProps } from '../src/client/SideCardSection.tsx'

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
    // Default prefs: openByDefault + interceptOpenPath switches checked, and
    // both tabs + the image viewer cards pressed (3 aria-pressed cards).
    // The nested auto-open toggle is NOT an inline card (it lives in the popup).
    expect(pressedCount(html, 'true')).toBe(3)
    expect(pressedCount(html, 'false')).toBe(0)
    // The general toggles are custom switches (real checkboxes, checked).
    expect(html.match(/checked=""/g)?.length).toBe(2)
    expect(html).not.toContain('Auto-open Subagents')
  })

  it('renders the section intro and group headings with inventory counts', () => {
    const { store, service } = mount()
    const html = renderSection(store, service)
    // The intro follows the runtime language (zh/en).
    expect(html).toMatch(/Manage what the side card shows and how it behaves|管理侧边卡片的显示内容与默认行为/)
    // Group headings carry the inventory count badge (2 tabs, 1 viewer);
    // the headings follow the runtime language (zh/en).
    expect(html).toMatch(/>Sidebar content|侧边栏内容<\/span><span/)
    expect(html).toMatch(/>File viewers|文件预览<\/span><span/)
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
    // none → no gear. The label follows the runtime language (zh/en).
    expect(html.match(/aria-label="[^"]*(Feature settings|功能设置)"/g)?.length).toBe(1)
  })

  it('a disabled feature renders pressed=false', () => {
    const { store, service } = mount()
    store.setPrefs({ ...store.getPrefs(), tabsEnabled: { subagent: false }, viewersEnabled: { image: false } })
    const html = renderSection(store, service)
    expect(html).toContain('>Subagents<')
    expect(html).toContain('>Image<')
    expect(pressedCount(html, 'false')).toBe(2)
    // The explorer card stays pressed; the general switches stay checked.
    expect(pressedCount(html, 'true')).toBe(1)
    expect(html.match(/checked=""/g)?.length).toBe(2)
  })

  it('hides the gear of a disabled feature (its related settings are dormant)', () => {
    const { store, service } = mount()
    store.setPrefs({ ...store.getPrefs(), tabsEnabled: { subagent: false } })
    const html = renderSection(store, service)
    expect(html).not.toContain('Feature settings')
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
})
