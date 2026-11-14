/** Three sections resize adjacent open neighbors, even across a collapsed pane. */
// @vitest-environment jsdom
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { expect, it, vi } from 'vitest'
import { SectionStack } from '../src/client/clues/tab/SectionStack.tsx'
import { renderRoot, setupReactAct } from './test-utils.ts'

setupReactAct()

it('resizes a pair without moving the third or unmounting it when collapsed', () => {
  const commit = vi.fn()
  const sections = ['first', 'second', 'third'].map(id => ({ id, title: id, open: true, weight: 1,
    content: createElement('input', { 'aria-label': id, defaultValue: id }) }))
  const view = renderRoot(createElement(SectionStack, { sections, onResize: commit }))
  try {
    const separators = () => Array.from(view.container.querySelectorAll<HTMLElement>('[role="separator"]'))
    const press = (node: HTMLElement, key: string) => {
      act(() => { node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
    }
    expect(separators()).toHaveLength(2)
    press(separators()[0]!, 'End')
    const firstResize = commit.mock.calls.at(-1)?.[0]
    expect(firstResize.first).toBeCloseTo(2)
    expect(firstResize.second).toBeCloseTo(0)
    expect(firstResize.third).toBe(1)
    const input = view.container.querySelector<HTMLInputElement>('[aria-label="second"]')!
    input.value = 'retained draft'
    view.rerender(createElement(SectionStack, { sections: sections.map(section => section.id === 'second'
      ? { ...section, open: false } : section), onResize: commit }))
    expect(separators()).toHaveLength(1)
    expect(separators()[0]!.getAttribute('aria-label')).toBe('first / third')
    press(separators()[0]!, 'Home')
    const secondResize = commit.mock.calls.at(-1)?.[0]
    expect(secondResize.first).toBeCloseTo(0)
    expect(secondResize.second).toBe(firstResize.second)
    expect(secondResize.third).toBeCloseTo(3)
    view.rerender(createElement(SectionStack, { sections, onResize: commit }))
    expect(view.container.querySelector<HTMLInputElement>('[aria-label="second"]')).toBe(input)
    expect(input.value).toBe('retained draft')
    expect(separators()).toHaveLength(2)
  } finally { view.unmount() }
})
