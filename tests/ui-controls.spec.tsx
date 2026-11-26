/** Interaction contracts of the controls used by every plugin page. */
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createElement, createRef } from 'react'
import { act } from 'react-dom/test-utils'
import { Checkbox, TextInput, ToggleSwitch, Tabs } from '../src/client/ui/controls.tsx'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'
setupReactAct()
let view: RenderedRoot | undefined
afterEach(() => { view?.unmount(); document.body.replaceChildren() })

it('keeps native field refs, form names, disabled and label behavior', () => {
  const ref = createRef<HTMLInputElement>()
  const onChange = vi.fn()
  view = renderRoot(createElement('label', null, 'Enabled', createElement(Checkbox, { ref, name: 'enabled', defaultChecked: false, onChange })))
  act(() => view!.container.querySelector('label')!.click())
  expect(ref.current?.checked).toBe(true)
  expect(onChange).toHaveBeenCalledOnce()
  const inputRef = createRef<HTMLInputElement>()
  view.rerender(createElement(TextInput, { ref: inputRef, value: 'draft', readOnly: true, 'aria-invalid': true }))
  expect(inputRef.current?.value).toBe('draft')
  expect(inputRef.current?.getAttribute('aria-invalid')).toBe('true')
})

it('exposes the current switch value and does not toggle while disabled', () => {
  const onChange = vi.fn()
  view = renderRoot(createElement(ToggleSwitch, { checked: true, onChange, 'aria-label': 'Feature' }))
  const button = view.container.querySelector('button')!
  expect(button.getAttribute('aria-checked')).toBe('true')
  act(() => button.click())
  expect(onChange).toHaveBeenCalledExactlyOnceWith(false)
  view.rerender(createElement(ToggleSwitch, { checked: true, onChange, disabled: true }))
  act(() => button.click())
  expect(onChange).toHaveBeenCalledOnce()
})

it('leaves composition and application shortcuts untouched', () => {
  const onChange = vi.fn()
  view = renderRoot(createElement(Tabs, { value: 'one', options: [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }], onChange, ariaLabel: 'View' }))
  const button = view.container.querySelector('button')!
  for (const modifiers of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { keyCode: 229 }]) {
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true, ...modifiers })
    act(() => button.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(false)
  }
  expect(onChange).not.toHaveBeenCalled()
})

it('walks enabled tabs with roving focus, Home/End and preserves panel bindings', () => {
  const onChange = vi.fn()
  const options = [{ value: 'one', label: 'One', id: 'first', controls: 'panel-one', 'data-mode': 'one' }, { value: 'off', label: 'Unavailable', disabled: true }, { value: 'two', label: 'Two' }]
  view = renderRoot(createElement(Tabs, { value: 'one', options, onChange, ariaLabel: 'View' }))
  const tabs = [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  expect(tabs[0]!.getAttribute('aria-controls')).toBe('panel-one')
  expect(tabs[0]!.dataset.mode).toBe('one')
  act(() => tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  expect(onChange).toHaveBeenLastCalledWith('two')
  expect(document.activeElement).toBe(tabs[2])
  act(() => tabs[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
  expect(onChange).toHaveBeenLastCalledWith('one')
  expect(document.activeElement).toBe(tabs[0])
})

it('renders the segmented skin with the same tab semantics', () => {
  const onChange = vi.fn()
  view = renderRoot(createElement(Tabs, {
    value: 'files',
    variant: 'segmented',
    ariaLabel: 'Source',
    options: [
      { value: 'files', label: 'Local files', title: 'Local files' },
      { value: 'docs', label: 'Feishu docs', title: 'Feishu docs' },
    ],
    onChange,
  }))
  const list = view.container.querySelector<HTMLElement>('[role="tablist"]')!
  expect(list.getAttribute('data-variant')).toBe('segmented')
  const tabs = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  expect(tabs).toHaveLength(2)
  expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
  expect(tabs[0]!.title).toBe('Local files')
  act(() => tabs[1]!.click())
  expect(onChange).toHaveBeenCalledExactlyOnceWith('docs')
})

