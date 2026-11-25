/**
 * SourceSwitcher contract:
 * - ONE item list renders the full-width segmented track and the narrow select;
 * - the active value and the source count are exposed on the shared wrapper;
 * - the wide form keeps the tablist/keyboard contract; the narrow form is the
 *   host select (a menu trigger, never a native select);
 * - icons stay inside the tab label and each label carries its full title.
 */
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { SourceSwitcher } from '../src/client/ui/SourceSwitcher.tsx'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'

setupReactAct()
let view: RenderedRoot | undefined
afterEach(() => { view?.unmount(); document.body.replaceChildren() })

const items = [
  { value: 'files', label: 'Local files', icon: createElement('span', { 'data-glyph': 'files' }) },
  { value: 'feishu', label: 'Feishu docs', icon: createElement('span', { 'data-glyph': 'feishu' }) },
  { value: 'github', label: 'GitHub Issues', icon: createElement('span', { 'data-glyph': 'github' }) },
]

it('renders one full-width tablist for the items and marks the active source', () => {
  const onChange = vi.fn()
  view = renderRoot(createElement(SourceSwitcher, { items, value: 'feishu', onChange, ariaLabel: 'Source' }))
  const wrapper = view.container.querySelector<HTMLElement>('[data-clue-source-navigation]')!
  expect(wrapper.getAttribute('data-clue-active-source')).toBe('feishu')
  expect(wrapper.getAttribute('data-source-count')).toBe('3')
  const tabs = [...wrapper.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  expect(tabs).toHaveLength(3)
  expect(tabs.map(tab => tab.textContent)).toEqual(['Local files', 'Feishu docs', 'GitHub Issues'])
  expect(tabs[1]!.getAttribute('aria-selected')).toBe('true')
  expect(tabs[1]!.title).toBe('Feishu docs')
  expect(wrapper.querySelectorAll('[role="tablist"] [data-glyph]')).toHaveLength(3)
  expect(wrapper.querySelector('[role="tablist"]')!.getAttribute('data-variant')).toBe('segmented')
  act(() => tabs[2]!.click())
  expect(onChange).toHaveBeenCalledExactlyOnceWith('github')
})

it('offers the same values through the host select for the narrow form', () => {
  view = renderRoot(createElement(SourceSwitcher, { items, value: 'files', onChange: () => {}, ariaLabel: 'Source' }))
  const select = view.container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
  expect(select.getAttribute('aria-label')).toBe('Source')
  expect(select.textContent).toContain('Local files')
  expect(select.querySelector('[data-glyph="files"]')).not.toBeNull()
})

it('keeps a single enabled source visible (the strip is then one honest segment)', () => {
  view = renderRoot(createElement(SourceSwitcher, { items: [items[0]!], value: 'files', onChange: () => {}, ariaLabel: 'Source' }))
  expect(view.container.querySelectorAll('[role="tab"]')).toHaveLength(1)
  expect(view.container.querySelector('[data-clue-source-navigation]')).not.toBeNull()
})
