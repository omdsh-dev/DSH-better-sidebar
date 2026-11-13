/**
 * The clue workbench's responsive and density contract.
 *
 * The native sidebar is a COLUMN whose width is independent of the browser
 * viewport, so the tab owns its own container. Sections are VSCode-style
 * disclosures (28px bars, mounted bodies), sources are one segmented track that
 * becomes a select below 520px, and rows are a compact 30px with hover-only
 * actions. The native search field is the shared 32px recipe.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}
const tab = read('src/client/clues/tab/clues-tab.module.css')
const sections = read('src/client/ui/workbench-section.module.css')
const switcher = read('src/client/ui/source-switcher.module.css')
const search = read('src/client/ui/search-field.module.css')
const controls = read('src/client/ui/controls.module.css')
// The pack shelf's rows are the shared ListRow recipe now, so its density and
// touch-target contract lives in the shared patterns sheet, not in the tab's.
const patterns = read('src/client/ui/patterns.module.css')

describe('clue tab container-query layout', () => {
  it('makes the tab root an inline-size container and never a viewport column', () => {
    expect(tab).toMatch(/\.root\s*\{[^}]*container-type:\s*inline-size/)
    expect(tab).toMatch(/\.root\s*\{[^}]*overflow:\s*hidden/)
    expect(tab).not.toMatch(/@media[^{]*min-width/)
  })

  it('fills the sidebar width instead of centering a reading column', () => {
    const browser = /\.browser\s*\{([^}]+)\}/.exec(tab)?.[1]
    expect(browser).toBeDefined()
    expect(browser).not.toMatch(/max-width:\s*\d+px|margin-inline:\s*auto/)
  })

  it('gives each section body the available height and its results their own scroll', () => {
    expect(tab).toMatch(/\.packRegion\s*\{[^}]*flex:\s*1/)
    expect(tab).toMatch(/\.browseRegion\s*\{[^}]*flex:\s*1/)
    expect(tab).toMatch(/\.resultArea\s*\{[^}]*overflow:\s*auto/)
    // The disclosure body is mounted but hidden, never unmounted.
    expect(sections).toMatch(/\.body\[hidden\]\s*\{\s*display:\s*none/)
  })

  it('switches the source selector by its own container, not the viewport', () => {
    expect(switcher).toMatch(/\.root\s*\{[^}]*container-type:\s*inline-size/)
    expect(switcher).toMatch(/@container\s*\(max-width:\s*519px\)/)
    expect(switcher).toMatch(/\.wide\s*\{[^}]*display:\s*block/)
    expect(switcher).toMatch(/\.narrow\s*\{[^}]*display:\s*none/)
  })

  it('bounds the compact shelf so both open sections stay reachable', () => {
    expect(sections).toMatch(/\[data-size='compact'\]\[data-open='true'\]\s*\{[^}]*max-height:\s*40%/)
  })
})

describe('clue workbench density and affordances', () => {
  it('uses 28px disclosure bars with one indent level', () => {
    expect(sections).toMatch(/\.header\s*\{[^}]*min-height:\s*var\(--ds-workbench-bar, 28px\)/)
    expect(sections).toMatch(/\.toggle\s*\{[^}]*min-height:\s*var\(--ds-workbench-bar, 28px\)/)
    expect(sections).toMatch(/\[data-level='1'\][^{]*\.toggle\s*\{[^}]*padding-inline-start:\s*20px/)
  })

  it('keeps 30px rows and reveals row actions on hover, focus or touch', () => {
    expect(tab).toMatch(/\.resultRow,[\s\S]*?\.pinRow\s*\{[^}]*min-height:\s*30px/)
    // A pack row IS a ListRow: 30px, hover/focus-revealed actions, untouched at rest.
    expect(patterns).toMatch(/\.listRow\s*\{[^}]*min-height:\s*30px/)
    expect(patterns).toMatch(/\.listRowActions\s*\{[^}]*opacity:\s*0/)
    expect(patterns).toMatch(/\.listRow:hover \.listRowActions,[\s\S]*?\{\s*opacity:\s*1/)
    const actions = /\.rowActions\s*\{([^}]+)\}/.exec(tab)?.[1]
    expect(actions).toBeDefined()
    expect(actions).toMatch(/opacity:\s*0/)
    expect(tab).toMatch(/\.resultRow:hover \.rowActions,[\s\S]*?\{\s*opacity:\s*1/)
    expect(tab).toMatch(/@media \(hover: none\), \(pointer: coarse\)[\s\S]*\.rowActions\s*\{\s*opacity:\s*1/)
    expect(tab).toMatch(/\.rowActions \.iconButton\s*\{[^}]*width:\s*24px/)
  })

  it('keeps the touch targets from the older scales where the new rows are smaller', () => {
    expect(tab).toMatch(/@media[^}]*pointer:\s*coarse/)
    expect(tab).toContain('min-height: 44px')
    expect(tab).toMatch(/@media[^}]*pointer:\s*coarse[\s\S]*\.rowActions \.iconButton,[^}]*width:\s*44px/)
    // The ListRow's own coarse-pointer rule: the pack reference button is a
    // 44px target through the row, and the row itself grows to 44px.
    expect(patterns).toMatch(/@media \(pointer: coarse\) \{\s*\.listRow \{ min-height: 44px; \}/)
  })

  it('uses the shared 32px search field with a flat query wrapper', () => {
    expect(search).toMatch(/\.root\s*\{[^}]*min-height:\s*32px/)
    expect(search).toMatch(/\.root\s*\{[^}]*border:\s*1px solid/)
    expect(search).toMatch(/\.root:focus-within\s*\{\s*border-color:\s*var\(--dsw-alias-state-business-primary\)/)
    expect(search).toMatch(/\.input\s*\{[^}]*font-size:\s*13px/)
    expect(search).toMatch(/\.input\s*\{[^}]*line-height:\s*20px/)
    const row = /\.queryRow\s*\{([^}]+)\}/.exec(tab)?.[1]
    expect(row).toBeDefined()
    expect(row).not.toMatch(/border:/)
    expect(tab).toMatch(/\.searchField\s*\{\s*flex:\s*1/)
  })

  it('renders the segmented track with the host 28px segment', () => {
    expect(controls).toMatch(/\.tabSegmented\s*\{[^}]*min-height:\s*28px/)
    expect(controls).toMatch(/\.tabsSegmented\s*\{[^}]*background:\s*var\(--dsw-alias-bg-module-platform\)/)
  })

  it('keeps keyboard focus geometry stable and draws the shared accent ring', () => {
    const focused = /\.iconButton:focus-visible,[^{]+\{([^}]+)\}/.exec(tab)?.[1]
    expect(focused).toContain('outline: 2px solid var(--dsw-alias-brand-primary)')
    expect(focused).not.toMatch(/padding|gap|display|width|height/)
  })
})

describe('no pagination or dead chrome', () => {
  it('does not reintroduce the removed pagination/footer chrome', () => {
    expect(tab).not.toContain('.resultFooter')
    expect(tab).not.toContain('.packPager')
    expect(tab).not.toContain('.discoveryFilters')
    expect(tab).not.toContain('.sourceNavItem')
  })
})

describe('clue detail footer width', () => {
  it('stretches the footer content across the host action row', () => {
    const detail = read('src/client/clues/windows/detail.module.css')
    const footer = /\.footer\s*\{([^}]+)\}/.exec(detail)?.[1]
    expect(footer).toBeDefined()
    expect(footer).toMatch(/width:\s*100%/)
    expect(footer).toMatch(/min-width:\s*0/)
  })
})
