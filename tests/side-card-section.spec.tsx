/**
 * Side card settings section render tests: the section is DECLARATIVE —
 * every small card (icon, title, type id, extensions, on/off state) derives
 * from the sidebar service's tab/viewer registries instead of hardcoded
 * copy. The toggles are CARDS in a responsive grid: the card's main area is
 * the switch, the visual state IS the state (highlighted = enabled),
 * announced via `aria-pressed`, and the check badge sits at the far right.
 * Features that declare related settings carry a gear corner button whose
 * popup rows (native checkboxes) are tested through the extracted
 * FeatureSettingsRows component (the Modal portal renders only while open).
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
    settings: {
      texts: [{
        key: 'explorerExclude',
        title: () => 'Exclude patterns',
        desc: () => 'Hidden from the tree; one per line',
        placeholder: () => 'e.g. *.meta',
      }],
    },
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
    // Default prefs: openByDefault + interceptOpenPath + both tabs + the
    // image viewer are all enabled → 5 cards pressed, none pressed=false.
    // The nested auto-open toggle is NOT an inline card (it lives in the popup).
    expect(pressedCount(html, 'true')).toBe(5)
    expect(pressedCount(html, 'false')).toBe(0)
    expect(html).not.toContain('Auto-open Subagents')
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
    // Subagents declares a toggle and Explorer declares a text row → both
    // cards carry the settings gear (aria-label = "<title> Feature settings");
    // Image declares none → no gear.
    expect(html.match(/aria-label="[^"]*Feature settings"/g)?.length).toBe(2)
  })

  it('a disabled feature renders pressed=false', () => {
    const { store, service } = mount()
    store.setPrefs({ ...store.getPrefs(), tabsEnabled: { subagent: false }, viewersEnabled: { image: false } })
    const html = renderSection(store, service)
    expect(html).toContain('>Subagents<')
    expect(html).toContain('>Image<')
    expect(pressedCount(html, 'false')).toBe(2)
    // openByDefault + interceptOpenPath + the explorer stay pressed.
    expect(pressedCount(html, 'true')).toBe(3)
  })

  it('hides the gear of a disabled feature (its related settings are dormant)', () => {
    const { store, service } = mount()
    store.setPrefs({ ...store.getPrefs(), tabsEnabled: { subagent: false } })
    const html = renderSection(store, service)
    // The disabled Subagents card loses its gear; the enabled Explorer card
    // (text row) keeps its own.
    expect(html).not.toContain('Subagents Feature settings')
    expect(html).toContain('Explorer Feature settings')
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

  it('renders one native checkbox row per declared toggle with its current value', () => {
    const html = renderToString(createElement(FeatureSettingsRows, {
      toggles,
      texts: [],
      prefs,
      onToggle: () => {},
      onCommitText: () => {},
    }))
    expect(html).toContain('Auto-open Subagents')
    expect(html).toContain('Expand on new subagent')
    // The checkbox reflects the prefs value (false here → unchecked).
    expect(html).not.toContain('checked=""')
  })

  it('checks the row when the pref is on', () => {
    const html = renderToString(createElement(FeatureSettingsRows, {
      toggles,
      texts: [],
      prefs: { ...prefs, autoOpenSubagent: true },
      onToggle: () => {},
      onCommitText: () => {},
    }))
    expect(html).toContain('checked=""')
  })

  it('renders a text row per declared text with title, desc, placeholder, and the joined value', () => {
    const html = renderToString(createElement(FeatureSettingsRows, {
      toggles: [],
      texts: [{
        key: 'explorerExclude',
        title: () => 'Exclude patterns',
        desc: () => 'Hidden from the tree; one per line',
        placeholder: () => 'e.g. *.meta',
      }],
      prefs: { ...prefs, explorerExclude: ['*.meta', 'node_modules'] },
      onToggle: () => {},
      onCommitText: () => {},
    }))
    expect(html).toContain('Exclude patterns')
    expect(html).toContain('Hidden from the tree; one per line')
    expect(html).toContain('placeholder="e.g. *.meta"')
    // The textarea value is the patterns joined by newlines.
    expect(html).toContain('*.meta\nnode_modules')
  })
})
