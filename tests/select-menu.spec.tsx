/** Shared select: host Menu presentation, selected label, keyboard opening, disabled options and change callback. */
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { SelectMenu } from '../src/client/ui/SelectMenu.tsx'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'
setupReactAct()
let view: RenderedRoot | undefined
afterEach(() => { view?.unmount(); document.body.replaceChildren() })
const options = [{ value: 'one', label: 'First' }, { value: 'two', label: 'Second' }, { value: 'disabled', label: 'Unavailable', disabled: true }]
it('selects through the themed menu without a native select and returns focus', async () => {
  const onChange = vi.fn()
  view = renderRoot(createElement(SelectMenu, { value: 'one', options, onChange, ariaLabel: 'Workspace' }))
  const trigger = view.container.querySelector<HTMLButtonElement>('button')!
  expect(trigger.textContent).toContain('First')
  expect(document.getElementById(trigger.getAttribute('aria-describedby')!)?.textContent).toBe('First')
  expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
  expect(view.container.querySelector('select')).toBeNull()
  act(() => trigger.click())
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  const rows = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  const second = rows.find(row => row.textContent?.includes('Second'))!
  const disabled = rows.find(row => row.textContent?.includes('Unavailable'))!
  expect(disabled.disabled).toBe(true)
  act(() => disabled.click())
  expect(onChange).not.toHaveBeenCalled()
  act(() => second.click())
  await act(async () => {})
  expect(onChange).toHaveBeenCalledExactlyOnceWith('two')
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(trigger)
})
it('keeps multiple selection open and emits values in option order', () => {
  const onValuesChange = vi.fn()
  view = renderRoot(createElement(SelectMenu, { values: ['two'], options, onValuesChange, ariaLabel: 'Modes' }))
  const trigger = view.container.querySelector<HTMLButtonElement>('button')!
  act(() => trigger.click())
  const first = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(row => row.textContent?.includes('First'))!
  act(() => first.click())
  expect(onValuesChange).toHaveBeenCalledExactlyOnceWith(['one', 'two'])
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  act(() => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})
it('opens with ArrowDown and disables the entire control', () => {
  const onChange = vi.fn()
  view = renderRoot(createElement(SelectMenu, { value: 'two', options, onChange, ariaLabel: 'Mode' }))
  const trigger = view.container.querySelector<HTMLButtonElement>('button')!
  act(() => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  view.rerender(createElement(SelectMenu, { value: 'two', options, onChange, ariaLabel: 'Mode', disabled: true }))
  expect(trigger.disabled).toBe(true)
  view.rerender(createElement(SelectMenu, { value: 'two', options, onChange, ariaLabel: 'Mode' }))
  expect(trigger.disabled).toBe(false)
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(document.querySelector('[role="menu"]')).toBeNull()
})
