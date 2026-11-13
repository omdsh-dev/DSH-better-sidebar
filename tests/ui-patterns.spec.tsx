/**
 * Shared page patterns (`src/client/ui/patterns.tsx`).
 *
 * These eight components replace ~968 lines of duplicated CSS across 10
 * near-identical families in the clue surface, so the contract pinned here is
 * deliberately structural rather than cosmetic:
 *
 * - a DEFAULT state is unstyled (a healthy row, a passing fact and an idle
 *   status line render no tone), because a 25-row list must not repaint itself;
 * - keyboard operation stays native (a navigating title is a `<button>`, a
 *   choice is a real `<input>`, a retry is a real `<button>`);
 * - nothing is filled unless it is a selection, and no component here invents a
 *   state of its own (an empty list renders the caller's `EmptyState`, never a
 *   built-in sentence);
 * - a coarse pointer gets 44px targets (CSS, asserted by the e2e lane).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import {
  ActionFooter, ChoiceCard, EmptyState, ErrorBlock, FactList, FactRow, Field, ListRow, StatusLine,
} from '../src/client/ui/patterns.tsx'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'

setupReactAct()
let view: RenderedRoot | undefined
afterEach(() => { view?.unmount(); view = undefined; document.body.replaceChildren() })

/** The single element matching one CSS-module class, by its own selector text. */
function byClass(container: HTMLElement, fragment: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[class*="${fragment}"]`)
}

describe('FactRow / FactList', () => {
  it('renders the label in the quiet rung and the value in the primary one', () => {
    view = renderRoot(createElement(FactRow, { label: 'Changes', value: '+12 −3' }))
    expect(byClass(view.container, 'factLabel')!.textContent).toBe('Changes')
    expect(byClass(view.container, 'factValue')!.textContent).toBe('+12 −3')
  })

  it('omits the label slot for a bare fact', () => {
    view = renderRoot(createElement(FactRow, { value: '#42' }))
    expect(byClass(view.container, 'factLabel')).toBeNull()
    expect(byClass(view.container, 'factValue')!.textContent).toBe('#42')
  })

  it('carries no tone by default and exactly the requested one otherwise', () => {
    view = renderRoot(createElement(FactRow, { label: 'CI', value: 'passing' }))
    const row = byClass(view.container, 'factRow')!
    expect(row.hasAttribute('data-tone')).toBe(false)

    view.rerender(createElement(FactRow, { label: 'CI', value: 'failing', tone: 'error' }))
    expect(byClass(view.container, 'factRow')!.dataset.tone).toBe('error')
  })

  it('gives a mono fact tabular figures through the shared class', () => {
    view = renderRoot(createElement(FactRow, { label: 'Hash', value: 'a1b2c3', mono: true }))
    expect(byClass(view.container, 'factValue')!.className).toContain('mono')
  })

  it('renders nothing for an empty list instead of an invented empty line', () => {
    view = renderRoot(createElement(FactList, { facts: [] }))
    expect(view.container.firstElementChild).toBeNull()
  })

  it('keeps the caller order and names the group when asked', () => {
    view = renderRoot(createElement(FactList, {
      label: 'Pull request',
      facts: [
        { key: 'number', label: '#', value: '#42' },
        { key: 'author', label: 'Author', value: 'Ada' },
      ],
    }))
    const group = view.container.querySelector('[role="group"]')!
    expect(group.getAttribute('aria-label')).toBe('Pull request')
    expect([...group.children].map(child => child.textContent)).toEqual(['##42', 'AuthorAda'])
  })
})

describe('ListRow', () => {
  it('renders no selection or dimming state by default', () => {
    view = renderRoot(createElement(ListRow, { title: 'Fix the thing' }))
    const row = byClass(view.container, 'listRow')!
    expect(row.hasAttribute('data-selected')).toBe(false)
    expect(row.hasAttribute('data-dimmed')).toBe(false)
  })

  it('makes the title a real button only when the row navigates', () => {
    view = renderRoot(createElement(ListRow, { title: 'Plain row' }))
    expect(view.container.querySelector('button')).toBeNull()

    const onClick = vi.fn()
    view.rerender(createElement(ListRow, { title: 'Nav row', titleAs: 'button', onTitleClick: onClick }))
    const button = view.container.querySelector('button')!
    expect(button.textContent).toBe('Nav row')
    button.click()
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('marks the roving-focus entry on the title button, not on the row shell', () => {
    // useListNavigation focuses the element carrying data-list-primary, so the
    // marker and the tab stop must both land on the real button.
    view = renderRoot(createElement(ListRow, { title: 'First', titleAs: 'button', primary: true }))
    const entry = view.container.querySelector('button')!
    expect(entry.hasAttribute('data-list-primary')).toBe(true)
    expect(entry.tabIndex).toBe(0)

    view.rerender(createElement(ListRow, { title: 'Second', titleAs: 'button', primary: false }))
    const other = view.container.querySelector('button')!
    expect(other.hasAttribute('data-list-primary')).toBe(true)
    expect(other.tabIndex).toBe(-1)
  })

  it('leaves the tab order alone when the row is not part of a roving list', () => {
    view = renderRoot(createElement(ListRow, { title: 'Plain', titleAs: 'button' }))
    const button = view.container.querySelector('button')!
    expect(button.hasAttribute('data-list-primary')).toBe(false)
    expect(button.tabIndex).toBe(0)
  })

  it('mounts every slot it is given and nothing it is not', () => {
    view = renderRoot(createElement(ListRow, {
      title: 'Clue title',
      leading: createElement('span', { 'data-slot': 'leading' }),
      subtitle: 'subtitle copy',
      meta: createElement('span', { 'data-slot': 'meta' }, '5 comments'),
      actions: createElement('button', { type: 'button', 'data-slot': 'action' }, 'pin'),
      selected: true,
    }))
    expect(view.container.querySelector('[data-slot="leading"]')).not.toBeNull()
    expect(view.container.querySelector('[data-slot="meta"]')!.textContent).toBe('5 comments')
    expect(view.container.querySelector('[data-slot="action"]')).not.toBeNull()
    expect(byClass(view.container, 'listRowSubtitle')!.textContent).toBe('subtitle copy')
    expect(byClass(view.container, 'listRow')!.dataset.selected).toBe('true')
  })

  it('passes data attributes through for a stable e2e locator', () => {
    view = renderRoot(createElement(ListRow, { title: 'Row', 'data-clue-result-row': 'clue-1' }))
    expect(view.container.querySelector('[data-clue-result-row]')).not.toBeNull()
  })
})

describe('EmptyState', () => {
  it('renders the title alone when nothing else is known', () => {
    view = renderRoot(createElement(EmptyState, { title: 'No clues yet' }))
    expect(byClass(view.container, 'emptyTitle')!.textContent).toBe('No clues yet')
    expect(byClass(view.container, 'emptyDescription')).toBeNull()
    expect(byClass(view.container, 'emptyActions')).toBeNull()
  })

  it('distinguishes a whole-pane empty state from a block inside a list', () => {
    view = renderRoot(createElement(EmptyState, { title: 'Pane', tone: 'page' }))
    expect(byClass(view.container, 'empty')!.className).toContain('emptyPage')
    view.rerender(createElement(EmptyState, { title: 'Well' }))
    expect(byClass(view.container, 'empty')!.className).toContain('emptyWell')
  })
})

describe('ErrorBlock', () => {
  it('announces the failure and pairs the retry with its own message', () => {
    const onRetry = vi.fn()
    view = renderRoot(createElement(ErrorBlock, { message: 'Request failed', retryLabel: 'Retry', onRetry }))
    expect(view.container.querySelector('[role="alert"]')).not.toBeNull()
    expect(byClass(view.container, 'errorMessage')!.textContent).toBe('Request failed')
    const retry = view.container.querySelector('button')!
    expect(retry.textContent).toBe('Retry')
    retry.click()
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('renders no retry when the caller cannot retry', () => {
    view = renderRoot(createElement(ErrorBlock, { message: 'Conflicted' }))
    expect(view.container.querySelector('button')).toBeNull()
  })

  it('locks the retry while one is in flight instead of offering a second', () => {
    view = renderRoot(createElement(ErrorBlock, {
      message: 'Request failed', retryLabel: 'Retry', onRetry: () => {}, busy: true,
    }))
    const retry = view.container.querySelector('button')!
    expect(retry.disabled).toBe(true)
    expect(retry.getAttribute('aria-busy')).toBe('true')
  })

  it('separates a sanitized detail from the message', () => {
    view = renderRoot(createElement(ErrorBlock, { message: 'Request failed', detail: 'github.gh' }))
    expect(byClass(view.container, 'errorDetail')!.textContent).toBe('github.gh')
  })
})

describe('Field', () => {
  it('ties the label to the control through a real label element', () => {
    view = renderRoot(createElement(Field, {
      label: 'Task name',
      htmlFor: 'task-name',
      children: createElement('input', { id: 'task-name' }),
    }))
    const label = view.container.querySelector('label')!
    expect(label.getAttribute('for')).toBe('task-name')
    expect(label.textContent).toBe('Task name')
  })

  it('renders the label as text when no control id exists', () => {
    view = renderRoot(createElement(Field, { label: 'Group', children: createElement('span', null, 'x') }))
    expect(view.container.querySelector('label')).toBeNull()
    expect(byClass(view.container, 'fieldLabel')!.textContent).toBe('Group')
  })

  it('puts the error under the control, in the alert role', () => {
    view = renderRoot(createElement(Field, {
      label: 'Url', error: 'Not a valid URL', children: createElement('input'),
    }))
    const error = view.container.querySelector('[role="alert"]')!
    expect(error.textContent).toBe('Not a valid URL')
    expect(byClass(view.container, 'fieldError')!.textContent).toBe('Not a valid URL')
  })

  it('switches the label beside the control for an inline field', () => {
    view = renderRoot(createElement(Field, { label: 'Name', layout: 'inline', children: createElement('input') }))
    expect(byClass(view.container, 'field')!.className).toContain('fieldInline')
  })
})

describe('ChoiceCard', () => {
  const options = [
    { value: 'snapshot', title: 'Snapshot', meta: 'Copies the content' },
    { value: 'references', title: 'References only', meta: 'Smaller archive' },
  ]

  it('keeps the native input so form and keyboard semantics survive', () => {
    view = renderRoot(createElement(ChoiceCard, {
      type: 'radio', name: 'mode', options, selected: ['snapshot'], onChange: () => {},
    }))
    const inputs = view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')
    expect(inputs).toHaveLength(2)
    expect(inputs[0]!.checked).toBe(true)
    expect(inputs[1]!.checked).toBe(false)
    expect(view.container.querySelector('[role="radiogroup"]')).not.toBeNull()
  })

  it('reports the value and the requested state, never a toggle of its own guess', () => {
    const onChange = vi.fn()
    view = renderRoot(createElement(ChoiceCard, {
      type: 'checkbox', name: 'caps', options, selected: [], onChange,
    }))
    const input = view.container.querySelectorAll<HTMLInputElement>('input')[1]!
    input.click()
    expect(onChange).toHaveBeenCalledWith('references', true)
  })

  it('carries the title and the explanation as two separate rungs', () => {
    view = renderRoot(createElement(ChoiceCard, {
      type: 'radio', name: 'mode', options, selected: ['snapshot'], onChange: () => {},
    }))
    const titles = [...view.container.querySelectorAll('[class*="choiceTitle"]')].map(node => node.textContent)
    const metas = [...view.container.querySelectorAll('[class*="choiceMeta"]')].map(node => node.textContent)
    expect(titles).toEqual(['Snapshot', 'References only'])
    expect(metas).toEqual(['Copies the content', 'Smaller archive'])
  })

  it('keeps the explanation slot empty when the option has none', () => {
    view = renderRoot(createElement(ChoiceCard, {
      type: 'radio', name: 'x', options: [{ value: 'a', title: 'A' }], selected: [], onChange: () => {},
    }))
    expect(view.container.querySelector('[class*="choiceMeta"]')).toBeNull()
  })

  it('refuses a disabled option without hiding it', () => {
    view = renderRoot(createElement(ChoiceCard, {
      type: 'checkbox', name: 'cap', options: [{ value: 'a', title: 'A', disabled: true }], selected: [], onChange: () => {},
    }))
    expect(view.container.querySelector<HTMLInputElement>('input')!.disabled).toBe(true)
    expect(byClass(view.container, 'choiceTitle')!.textContent).toBe('A')
  })
})

describe('StatusLine', () => {
  it('carries no tone by default', () => {
    view = renderRoot(createElement(StatusLine, { text: '3 selected' }))
    expect(byClass(view.container, 'statusLine')!.hasAttribute('data-tone')).toBe(false)
    expect(byClass(view.container, 'statusLineText')!.textContent).toBe('3 selected')
  })

  it('announces a live status only when the caller asks for it', () => {
    view = renderRoot(createElement(StatusLine, { text: 'Importing…' }))
    expect(view.container.querySelector('[role="status"]')).toBeNull()
    view.rerender(createElement(StatusLine, { text: 'Importing…', role: 'status' }))
    expect(view.container.querySelector('[role="status"]')).not.toBeNull()
  })

  it('separates the trailing action from the text', () => {
    view = renderRoot(createElement(StatusLine, {
      text: 'Failed', tone: 'error',
      action: createElement('button', { type: 'button', 'data-slot': 'retry' }, 'Retry'),
    }))
    expect(byClass(view.container, 'statusLine')!.dataset.tone).toBe('error')
    expect(view.container.querySelector('[data-slot="retry"]')).not.toBeNull()
  })
})

describe('ActionFooter', () => {
  it('renders only the seats the caller fills', () => {
    view = renderRoot(createElement(ActionFooter, {}))
    expect(view.container.firstElementChild!.children).toHaveLength(0)
  })

  it('keeps the leading fact and the trailing actions apart', () => {
    view = renderRoot(createElement(ActionFooter, {
      start: '2 of 12 selected',
      end: createElement('button', { type: 'button', 'data-slot': 'save' }, 'Save'),
    }))
    const footer = view.container.firstElementChild!
    expect(footer.firstElementChild!.textContent).toBe('2 of 12 selected')
    expect(footer.querySelector('[data-slot="save"]')).not.toBeNull()
    expect(footer.querySelector('[class*="actionFooterEnd"]')).not.toBeNull()
  })
})
