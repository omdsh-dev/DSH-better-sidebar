/** SearchField contract: one 32px field, caller-owned input semantics. */
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createElement, createRef } from 'react'
import { act } from 'react-dom/test-utils'
import { SearchField } from '../src/client/ui/SearchField.tsx'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'

setupReactAct()
let view: RenderedRoot | undefined
afterEach(() => { view?.unmount(); document.body.replaceChildren() })

it('keeps native input props, the ref and the trailing actions', () => {
  const ref = createRef<HTMLInputElement>()
  const onChange = vi.fn()
  const onKeyDown = vi.fn()
  view = renderRoot(createElement(SearchField, {
    ref,
    value: 'draft',
    placeholder: 'Search resources',
    'aria-label': 'Search resources',
    onChange,
    onKeyDown,
    trailing: createElement('button', { type: 'button', 'data-action': 'clear' }, 'x'),
  }))
  const root = view.container.querySelector<HTMLElement>('[role="search"]')!
  const input = root.querySelector('input')!
  expect(input.value).toBe('draft')
  expect(input.placeholder).toBe('Search resources')
  expect(input.getAttribute('aria-label')).toBe('Search resources')
  expect(ref.current).toBe(input)
  expect(root.querySelector('[data-action="clear"]')).not.toBeNull()
  act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  expect(onKeyDown).toHaveBeenCalledOnce()
})

it('lets the caller replace the leading glyph', () => {
  view = renderRoot(createElement(SearchField, { 'aria-label': 'Find', icon: createElement('span', { 'data-glyph': 'custom' }) }))
  expect(view.container.querySelector('[data-glyph="custom"]')).not.toBeNull()
  expect(view.container.querySelector('svg')).toBeNull()
})
