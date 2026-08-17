/**
 * Family settings card render tests: the card is a thin adapter that hosts
 * the SAME declarative SideCardSection surface, so the two settings entry
 * points (standalone section vs family card) cannot drift. Rendered with
 * renderToString like the section spec (mount effects do not run in SSR).
 */
import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import { createSidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { FamilySettingsCard } from '../src/client/FamilySettingsCard.tsx'

describe('FamilySettingsCard', () => {
  it('renders the Side card settings surface with the registered inventory', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({
      id: 'explorer',
      title: () => 'Explorer',
      icon: () => createElement('svg', { 'data-icon': 'explorer' }),
      order: 10,
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

    const html = renderToString(createElement(FamilySettingsCard, { store, service }))
    // The section intro and the declarative inventory all come through.
    expect(html).toContain('Manage what the side card shows and how it behaves')
    expect(html).toContain('data-icon="explorer"')
    expect(html).toContain('>Explorer<')
    expect(html).toContain('data-icon="image"')
    expect(html).toContain('png · jpg')
  })
})
