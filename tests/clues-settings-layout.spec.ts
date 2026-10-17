/**
 * S8 settings layout/style contract: the grouped section and the clue settings
 * surfaces stay inside the DSH skin system and never overflow a narrow
 * viewport.
 *
 * - the wide form is a side navigation; below the repo's 768px narrow bracket
 *   it becomes ONE native select (the media query in the module sheet);
 * - every container is `min-width: 0` and long source names wrap
 *   (`overflow-wrap: anywhere`) instead of widening the page;
 * - no literal colors: every paint rides --dsw-* / --ds-* tokens (the global
 *   skin-contract spec enforces the same over all module sheets);
 * - the nav/select/switch controls are native focusable elements with
 *   accessible names.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import { createSidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { SideCardSection, type SideCardSectionProps } from '../src/client/SideCardSection.tsx'

beforeAll(() => {
  Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
})

const SECTION_SHEET = readFileSync(resolve(process.cwd(), 'src/client/SideCardSection.module.css'), 'utf8')
const CLUE_SHEET = readFileSync(resolve(process.cwd(), 'src/client/clues/settings/settings.module.css'), 'utf8')

/** The body of one CSS rule (first match), or undefined. */
function ruleBody(sheet: string, selector: string): string | undefined {
  return new RegExp(`${selector.replaceAll('.', '\\.')}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(sheet)?.[1]
}

/** The narrow media block of one sheet. */
function narrowBlock(sheet: string): string {
  const at = sheet.indexOf('@media (max-width: 767px)')
  expect(at, 'the 768px narrow bracket must be declared').toBeGreaterThan(-1)
  return sheet.slice(at)
}

describe('grouped settings layout', () => {
  it('switches from the wide side navigation to the narrow select at the 768px bracket', () => {
    const wideNav = ruleBody(SECTION_SHEET, '.groupNav')
    expect(wideNav).toBeDefined()
    expect(wideNav).toContain('display: flex')
    expect(ruleBody(SECTION_SHEET, '.groupSelectWrap')).toContain('display: none')
    const narrow = narrowBlock(SECTION_SHEET)
    expect(narrow).toMatch(/\.groupNav\s*\{\s*display: none;/)
    expect(narrow).toMatch(/\.groupSelectWrap\s*\{\s*display: flex;/)
    // The shell stacks instead of forcing a two-column minimum width.
    expect(narrow).toMatch(/\.settingsShell\s*\{[^}]*flex-direction: column;/)
  })

  it('keeps every settings container shrinkable and wraps long names', () => {
    expect(ruleBody(SECTION_SHEET, '.settingsShell')).toContain('min-width: 0')
    expect(ruleBody(SECTION_SHEET, '.groupPane')).toContain('min-width: 0')
    expect(ruleBody(CLUE_SHEET, '.sources')).toContain('min-width: 0')
    expect(ruleBody(CLUE_SHEET, '.sourceRow')).toContain('flex-wrap: wrap')
    expect(ruleBody(CLUE_SHEET, '.sourceName')).toContain('overflow-wrap: anywhere')
    expect(ruleBody(CLUE_SHEET, '.sourceId')).toContain('overflow-wrap: anywhere')
    expect(ruleBody(CLUE_SHEET, '.configValue')).toContain('overflow-wrap: anywhere')
    // The narrow form stacks the source row's controls under its identity.
    const narrow = narrowBlock(CLUE_SHEET)
    expect(narrow).toMatch(/\.sourceIdentity\s*\{[^}]*flex-basis: 100%;/)
    expect(narrow).toMatch(/\.sourceControls\s*\{[^}]*width: 100%;/)
  })

  it('paints only theme tokens on the clue settings surfaces', () => {
    for (const sheet of [SECTION_SHEET, CLUE_SHEET]) {
      expect(sheet).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(sheet).not.toMatch(/\brgba?\(/)
      for (const match of sheet.matchAll(/var\((--[\w-]+)/g)) {
        expect(match[1]).toMatch(/^--(?:dsw-|ds-)/)
      }
    }
  })
})

describe('grouped settings markup', () => {
  function render(initialGroup: 'general' | 'sources'): string {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    return renderToString(createElement(SideCardSection, {
      store,
      service,
      initialGroup,
    } as unknown as SideCardSectionProps))
  }

  it('renders the nav and the narrow select with explicit accessible names', () => {
    const html = render('general')
    expect(html).toContain('<nav')
    expect(html).toContain('aria-label="Settings groups"')
    // Wide nav items are real buttons (native tab order/focus), each labelled
    // by the group copy; the active one is announced with aria-current.
    expect(html).toContain('>General</button>')
    expect(html).toContain('>Tabs</button>')
    expect(html).toContain('aria-current="page"')
    // The narrow form is one native select with the same option labels.
    expect(html).toContain('<select')
    expect(html).toContain('aria-label="Settings groups"')
    expect(html).toContain('<option value="sources">Clue sources</option>')
    // No horizontal escape hatch: a tabindex=-1 nav or a fixed-width wrapper
    // would break keyboard reachability / narrow layout.
    expect(html).not.toContain('tabindex="-1"')
  })

  it('renders the Clue sources group with its intro and the add-source entry', () => {
    const html = render('sources')
    expect(html).toContain('Clue sources')
    expect(html).toContain('Sources decide where clues come from')
    expect(html).toContain('Add source plugin')
    expect(html).toContain('>0</span>')
  })
})
