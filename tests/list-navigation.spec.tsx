// @vitest-environment jsdom
/** Native lists retain their semantics and secondary controls while titles share one Tab entry. */
import { createElement, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useListNavigation } from '../src/client/ui/use-list-navigation.ts'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'

setupReactAct()

function List({ keys, intercept = false }: { keys: readonly string[]; intercept?: boolean }): ReactNode {
  const navigation = useListNavigation(keys)
  return createElement('ul', {
    ref: navigation.ref,
    onKeyDown: navigation.onKeyDown,
    onFocusCapture: navigation.onFocusCapture,
    onClickCapture: navigation.onClickCapture,
  }, keys.map((key, index) => createElement('li', { key },
    createElement('input', { type: 'checkbox', 'aria-label': 'Select ' + key }),
    createElement('button', {
      'data-list-primary': key,
      tabIndex: navigation.itemTabIndex(index),
      onKeyDown: intercept ? (event: ReactKeyboardEvent<HTMLButtonElement>) => { event.preventDefault() } : undefined,
    }, createElement('span', null, key)),
    createElement('button', { 'data-action': key }, 'Pin'),
    createElement('input', { type: 'text', 'aria-label': 'Rename ' + key }),
  )))
}

let view: RenderedRoot | undefined
let scroll: ReturnType<typeof vi.fn>

beforeEach(() => {
  scroll = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll })
})
afterEach(() => { view?.unmount(); view = undefined })

function title(key: string): HTMLButtonElement {
  return view!.container.querySelector<HTMLButtonElement>('[data-list-primary="' + key + '"]')!
}
function entries(): string[] {
  return [...view!.container.querySelectorAll<HTMLButtonElement>('[data-list-primary]')]
    .filter(button => button.tabIndex === 0).map(button => button.dataset.listPrimary!)
}
function keydown(target: HTMLElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...init })
  act(() => { target.dispatchEvent(event) })
  return event
}

describe('useListNavigation', () => {
  it('keeps native list semantics, one title entry and all secondary controls in Tab order', () => {
    view = renderRoot(createElement(List, { keys: ['a', 'b', 'c'] }))
    expect(view.container.querySelector('ul')!.getAttribute('role')).toBeNull()
    expect(entries()).toEqual(['a'])
    expect([...view.container.querySelectorAll<HTMLInputElement>('input')].every(input => input.tabIndex === 0)).toBe(true)
    expect([...view.container.querySelectorAll<HTMLButtonElement>('[data-action]')].every(button => button.tabIndex === 0)).toBe(true)
    expect(keydown(title('a'), 'Tab').defaultPrevented).toBe(false)
  })

  it('moves titles with arrows/Home/End, scrolls nearest and never wraps', () => {
    view = renderRoot(createElement(List, { keys: ['a', 'b', 'c'] }))
    act(() => { title('a').focus() })
    expect(keydown(title('a'), 'ArrowDown').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(title('b'))
    expect(entries()).toEqual(['b'])
    expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest' })
    keydown(title('b'), 'End')
    expect(document.activeElement).toBe(title('c'))
    keydown(title('c'), 'ArrowDown')
    expect(document.activeElement).toBe(title('c'))
    keydown(title('c'), 'ArrowUp')
    expect(document.activeElement).toBe(title('b'))
    keydown(title('b'), 'Home')
    keydown(title('a'), 'ArrowUp')
    expect(document.activeElement).toBe(title('a'))
  })

  it('remembers title focus and clicks even when a click does not move focus', () => {
    view = renderRoot(createElement(List, { keys: ['a', 'b', 'c'] }))
    act(() => { title('b').focus() })
    expect(entries()).toEqual(['b'])
    act(() => { title('c').querySelector('span')!.click() })
    expect(entries()).toEqual(['c'])
    expect(document.activeElement).toBe(title('b'))
  })

  it('keeps the same entry after reorder, falls back on removal and handles an empty list', () => {
    view = renderRoot(createElement(List, { keys: ['a', 'b', 'c'] }))
    act(() => { title('b').focus() })
    view.rerender(createElement(List, { keys: ['c', 'a', 'b'] }))
    expect(entries()).toEqual(['b'])
    keydown(title('b'), 'ArrowUp')
    expect(document.activeElement).toBe(title('a'))
    view.rerender(createElement(List, { keys: ['c', 'b'] }))
    expect(entries()).toEqual(['c'])
    view.rerender(createElement(List, { keys: [] }))
    expect(entries()).toEqual([])
    view.rerender(createElement(List, { keys: ['d', 'e'] }))
    expect(entries()).toEqual(['d'])
  })

  it('leaves checkbox, input and inline action keyboard events alone', () => {
    view = renderRoot(createElement(List, { keys: ['a', 'b'] }))
    for (const control of view.container.querySelectorAll<HTMLElement>('input, [data-action]')) {
      act(() => { control.focus() })
      for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
        expect(keydown(control, key).defaultPrevented).toBe(false)
        expect(document.activeElement).toBe(control)
      }
    }
    expect(scroll).not.toHaveBeenCalled()
    expect(entries()).toEqual(['a'])
  })

  it('respects composition, repeat, modifiers and keys already handled by a child', () => {
    view = renderRoot(createElement(List, { keys: ['a', 'b'] }))
    act(() => { title('a').focus() })
    for (const init of [{ isComposing: true }, { repeat: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(keydown(title('a'), 'ArrowDown', init).defaultPrevented).toBe(false)
      expect(document.activeElement).toBe(title('a'))
    }
    view.rerender(createElement(List, { keys: ['a', 'b'], intercept: true }))
    expect(keydown(title('a'), 'ArrowDown').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(title('a'))
    expect(scroll).not.toHaveBeenCalled()
  })
})
