/** SidebarToolbar contract: two slots on one flat 32px row. */
// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { createElement } from 'react'
import { SidebarToolbar } from '../src/client/ui/SidebarToolbar.tsx'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'

setupReactAct()
let view: RenderedRoot | undefined
afterEach(() => { view?.unmount(); document.body.replaceChildren() })

it('renders start and end slots around one toolbar row', () => {
  view = renderRoot(createElement(SidebarToolbar, {
    start: createElement('span', { 'data-slot': 'workspace' }, 'repo'),
    end: createElement('button', { type: 'button', 'data-slot': 'settings' }, 'Settings'),
  }))
  const toolbar = view.container.querySelector<HTMLElement>('[data-sidebar-toolbar]')!
  expect(toolbar.querySelector('[data-slot="workspace"]')).not.toBeNull()
  expect(toolbar.querySelector('[data-slot="settings"]')).not.toBeNull()
})
