/**
 * Settings layout contract: shared product scale, continuous settings rows,
 * container-driven narrow layouts and one scroll owner per surface. Behavioral
 * saving/conflict coverage stays in clues-settings-section.spec.tsx.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToString } from 'react-dom/server'
import { createElement, isValidElement } from 'react'
import type { BetterSidebarWindowsClientFace, WindowHandle, WindowOpenOptions } from '../src/client/windows/types.ts'
import { openClueSettingsWindow } from '../src/client/clues/windows/settings.tsx'
import { consumeClueSettingsTarget } from '../src/client/clues/settings/navigation.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { SideCardSection, type SideCardSectionProps } from '../src/client/SideCardSection.tsx'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'
import design from '../src/client/ui/design.module.css'

beforeAll(() => {
  Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
})

const SECTION_SHEET = readFileSync(resolve(process.cwd(), 'src/client/SideCardSection.module.css'), 'utf8')
const KIT_SHEET = readFileSync(resolve(process.cwd(), 'src/client/ui/kit.module.css'), 'utf8')
const CLUE_SHEET = readFileSync(resolve(process.cwd(), 'src/client/clues/settings/settings.module.css'), 'utf8')

function ruleBody(sheet: string, selector: string): string | undefined {
  return new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*?)\\}`).exec(sheet)?.[1]
}

function containerBlock(sheet: string, name: string, width: number): string {
  const at = sheet.indexOf(`@container ${name} (max-width: ${width}px)`)
  expect(at, 'narrow layouts must follow their container, including a narrow column on a wide desktop').toBeGreaterThan(-1)
  return sheet.slice(at)
}

describe('grouped settings layout', () => {
  it('uses a 144px left rail and a group select when the settings container is narrow', () => {
    expect(ruleBody(SECTION_SHEET, '.section')).toContain('container: sidebar-settings / inline-size')
    expect(ruleBody(SECTION_SHEET, '.settingsShell')).toContain('flex-direction: row')
    expect(ruleBody(SECTION_SHEET, '.navRail')).toContain('width: 144px')
    expect(ruleBody(SECTION_SHEET, '.navRail')).toContain('border-inline-end: 1px solid')
    expect(ruleBody(SECTION_SHEET, '.groupNav')).toContain('flex-direction: column')
    expect(ruleBody(SECTION_SHEET, '.groupNav')).not.toContain('overflow-x: auto')
    const narrow = SECTION_SHEET.slice(SECTION_SHEET.indexOf('@container sidebar-settings (max-width: 639px)'))
    expect(narrow).toContain('.navRail { display: none; }')
    expect(narrow).toContain('.navSelect')
    expect(ruleBody(SECTION_SHEET, '.groupPane')).toContain('min-width: 0')
  })

  it('keeps settings shrinkable, wraps long names and stacks source controls by container width', () => {
    for (const selector of ['.settingsShell', '.groupPane']) expect(ruleBody(SECTION_SHEET, selector)).toContain('min-width: 0')
    expect(ruleBody(CLUE_SHEET, '.sources')).toContain('container: sidebar-clue-sources / inline-size')
    expect(ruleBody(CLUE_SHEET, '.sourceRow')).toContain('flex-wrap: wrap')
    for (const selector of ['.sourceName', '.sourceId', '.configValue']) expect(ruleBody(CLUE_SHEET, selector)).toContain('overflow-wrap: anywhere')
    const narrow = containerBlock(CLUE_SHEET, 'sidebar-clue-sources', 420)
    expect(narrow).toMatch(/\.sourceIdentity\s*\{[^}]*flex-basis: 100%;/)
    expect(narrow).toMatch(/\.sourceControls\s*\{[^}]*width: 100%;/)
    expect(containerBlock(CLUE_SHEET, 'sidebar-clue-config', 480)).toContain('grid-template-columns: 1fr')
  })

  it('uses grouped rows and one public Modal content scroller instead of nested cards', () => {
    expect(ruleBody(SECTION_SHEET, '.group')).toContain('padding: 0')
    expect(ruleBody(SECTION_SHEET, '.group')).toContain('border: 0')
    expect(ruleBody(SECTION_SHEET, '.grid')).toContain('flex-direction: column')
    expect(ruleBody(SECTION_SHEET, '.card')).not.toContain('106px')
    expect(ruleBody(SECTION_SHEET, '.popupRow')).toContain('border-bottom: 1px solid')
    for (const selector of ['.popupRows', '.pluginEntries']) {
      expect(ruleBody(SECTION_SHEET, selector)).not.toMatch(/overflow|max-height/)
    }
    expect(ruleBody(SECTION_SHEET, '.dialogContent')).toContain('overflow-y: auto')
    expect(ruleBody(SECTION_SHEET, '.popupDialog.popupDialog')).toContain('max-height: 100%')
    expect(ruleBody(CLUE_SHEET, '.configActions')).toContain('justify-content: flex-end')
    expect(ruleBody(SECTION_SHEET, '.pluginCopyBtn')).toContain('flex: none')
    expect(ruleBody(SECTION_SHEET, '.pluginCopyBtn')).not.toContain('button-primary-fill')
    expect(ruleBody(KIT_SHEET, '.button')).toContain('border: 1px solid')
  })

  it('gives fill-window pages one 16px gutter and one bounded scroll owner', () => {
    const config = ruleBody(CLUE_SHEET, '.config')!
    expect(config).toContain('height: 100%')
    expect(config).toContain('max-height: 100%')
    expect(config).toContain('overflow-y: auto')
    expect(config).toContain('box-sizing: border-box')
    expect(config).toContain('padding: var(--ds-sidebar-gutter)')
    expect(config).toContain('max-width: calc(var(--ds-sidebar-content-width) + var(--ds-sidebar-gutter) * 2)')
    expect(config).not.toContain('padding: 0 2px 8px')
    expect(ruleBody(SECTION_SHEET, '.section')).not.toContain('overflow')
    expect(ruleBody(SECTION_SHEET, '.groupPane')).toContain('min-width: 0')
    expect(ruleBody(SECTION_SHEET, '.groupNav')).toContain('overflow: visible')
  })

  it('preserves visible focus, reduced motion and coarse-pointer targets', () => {
    expect(CLUE_SHEET).toContain('.advancedSummary:focus-visible')
    expect(KIT_SHEET).toContain('.iconButton:focus-visible')
    expect(SECTION_SHEET).not.toMatch(/transition:|animation:/)
    for (const sheet of [SECTION_SHEET, CLUE_SHEET]) {
      const coarse = sheet.slice(sheet.indexOf('@media (pointer: coarse)'))
      expect(coarse).toContain('min-height: 44px')
    }
    expect(ruleBody(CLUE_SHEET, '.advancedRow')).toContain('flex-wrap: wrap')
  })

  it('uses existing theme aliases and the shared product-scale variables', () => {
    for (const sheet of [SECTION_SHEET, CLUE_SHEET]) {
      expect(sheet).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(sheet).not.toMatch(/\brgba?\(/)
      for (const match of sheet.matchAll(/var\((--[\w-]+)/g)) expect(match[1]).toMatch(/^--(?:dsw-|ds-)/)
    }
  })
})

describe('grouped settings markup', () => {
  function render(initialGroup: 'general' | 'sources'): string {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    return renderToString(createElement(SideCardSection, { store, service, initialGroup } as unknown as SideCardSectionProps))
  }

  it('renders icon-labeled accessible settings tabs and their selected panel', () => {
    const html = render('general')
    expect(html).toContain(design.surface)
    expect(html).toContain('data-sidebar-settings')
    expect(html).toContain('role="tablist"')
    expect(html).toContain('aria-label="Settings groups"')
    expect(html.match(/role="tab"/g)?.length).toBe(6)
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('role="tabpanel"')
    expect(html).toContain('aria-hidden="true"><svg')
    expect(html).toContain('<h2')
  })

  it('keeps the add entry without introductory copy or a repeated window title', () => {
    const html = render('sources')
    expect(html).not.toContain('Choose the sources you use.')
    expect(html).toContain('Add source plugin')
    expect(html).toContain('>0</span>')
    const sourceSettings = render('sources')
    expect(sourceSettings.match(/role="tab"/g)?.length).toBe(6)
    expect(sourceSettings).toContain('>Clue sources</span>')
  })

  it('opens the same full settings component from the gear on Clue sources', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    let opened: WindowOpenOptions | undefined
    const windows = {
      open(options: WindowOpenOptions) {
        opened = options
        return { id: options.id } as WindowHandle
      },
    } as BetterSidebarWindowsClientFace
    try {
      openClueSettingsWindow({ windows, store, service, group: 'sources' })
      expect(opened?.title).toBe('Sidebar settings')
      expect(opened?.id).toBe('clue-settings')
      const content = opened?.content
      expect(isValidElement(content)).toBe(true)
      if (!isValidElement(content)) throw new Error('settings window content is not a React element')
      const html = renderToString(content)
      expect(html.match(/role="tab"/g)?.length).toBe(6)
      expect(html).toContain('aria-selected="true"')
      expect(html).toContain('>Clue sources</span>')
      expect(html).not.toContain('data-sources-only')
    } finally {
      consumeClueSettingsTarget()
    }
  })

  it('shows an explicit visual switch for a disabled inventory row while retaining its accessible state', () => {
    const store = createSidebarStore()
    store.setPrefs({ ...SIDEBAR_PREFS_DEFAULTS, tabsEnabled: { sample: false } })
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'sample', title: 'Sample tab', component: () => null })
    const html = renderToString(createElement(SideCardSection, { store, service, initialGroup: 'tabs' } as unknown as SideCardSectionProps))
    expect(html).toContain('aria-checked="false"')
    expect(html).toContain('role="switch"')
    expect(html).toContain('data-settings-toggle="off"')
    expect(html).toContain('aria-hidden="true"')
  })
})
