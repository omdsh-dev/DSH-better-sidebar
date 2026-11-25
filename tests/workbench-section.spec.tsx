/**
 * WorkbenchSection — the reusable VSCode-style disclosure bar.
 *
 * Contract pinned here:
 * - the header button is a native control inside its heading, so Enter/Space
 *   activation, focus order and `aria-expanded` are platform behaviour;
 * - `aria-controls` names the body, and the body stays MOUNTED while hidden so
 *   an input draft survives a collapse/expand round trip;
 * - header actions are siblings of the disclosure button: clicking one never
 *   toggles the section;
 * - `data-open` mirrors the controlled state for callers/tests, and a supplied
 *   `headingId` stays on the heading for compatibility with the owning page.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createElement } from 'react'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'
import { WorkbenchSection, type WorkbenchSectionProps } from '../src/client/ui/WorkbenchSection.tsx'

setupReactAct()

afterEach(() => {
  document.body.replaceChildren()
})

/** Render one section with a stable body and a fresh owner spy. */
function mount(overrides: Partial<WorkbenchSectionProps> = {}) {
  const onOpenChange = vi.fn<(open: boolean) => void>()
  const props: WorkbenchSectionProps = {
    title: 'Clue sources',
    open: true,
    onOpenChange,
    children: createElement('input', { 'data-draft': 'true', defaultValue: '' }),
    ...overrides,
  }
  return { view: renderRoot(createElement(WorkbenchSection, props)), onOpenChange }
}

function toggleOf(view: RenderedRoot): HTMLButtonElement {
  return view.container.querySelector<HTMLButtonElement>('[data-workbench-section] h3 button')!
}

function bodyOf(view: RenderedRoot): HTMLElement {
  const toggle = toggleOf(view)
  return document.getElementById(toggle.getAttribute('aria-controls')!)!
}

describe('header structure and ARIA', () => {
  it('wears the disclosure semantics and keeps the heading id', () => {
    const { view } = mount({
      headingId: 'clue-sources-heading',
      icon: createElement('span', { 'data-icon': 'source' }, 'I'),
      count: 12,
      actions: createElement('button', { type: 'button', 'data-action': 'refresh' }, 'Refresh'),
    })
    try {
      const root = view.container.querySelector<HTMLElement>('[data-workbench-section]')!
      expect(root.getAttribute('data-open')).toBe('true')

      const heading = root.querySelector('h3')!
      expect(heading.id).toBe('clue-sources-heading')
      expect(heading.textContent).toContain('Clue sources')
      expect(heading.textContent).toContain('12')
      expect(heading.querySelector('[data-icon]')).not.toBeNull()

      const toggle = toggleOf(view)
      expect(toggle.tagName).toBe('BUTTON')
      expect(toggle.getAttribute('type')).toBe('button')
      expect(toggle.getAttribute('aria-expanded')).toBe('true')

      const body = bodyOf(view)
      expect(toggle.getAttribute('aria-controls')).toBe(body.id)
      expect(body.hidden).toBe(false)
      expect(body.querySelector('[data-draft]')).not.toBeNull()
    } finally {
      view.unmount()
    }
  })

  it('exposes the toggle as a focusable native button (Enter/Space are native)', () => {
    const { view } = mount()
    try {
      const toggle = toggleOf(view)
      // jsdom has no browser key-activation default, so the contract asserted
      // here is the platform contract: a real, tabbable button. Its Enter/Space
      // activation is supplied by the browser, never by a bespoke key handler.
      expect(toggle.type).toBe('button')
      expect(toggle.tabIndex).toBe(0)
      act(() => { toggle.focus() })
      expect(document.activeElement).toBe(toggle)
    } finally {
      view.unmount()
    }
  })

  it('keeps header actions outside the disclosure button and never collapses on their click', () => {
    const action = createElement('button', { type: 'button', 'data-action': 'more' }, 'More')
    const { view, onOpenChange } = mount({ actions: action })
    try {
      const toggle = toggleOf(view)
      const actionButton = view.container.querySelector<HTMLButtonElement>('[data-action="more"]')!
      expect(toggle.contains(actionButton)).toBe(false)
      expect(toggle.closest('h3')!.contains(actionButton)).toBe(false)

      act(() => { actionButton.click() })
      expect(onOpenChange).not.toHaveBeenCalled()
      expect(bodyOf(view).hidden).toBe(false)
    } finally {
      view.unmount()
    }
  })
})

describe('controlled open state', () => {
  it('requests the inverse state on click and reflects the next render', () => {
    const { view, onOpenChange } = mount()
    try {
      const toggle = toggleOf(view)
      act(() => { toggle.click() })
      expect(onOpenChange).toHaveBeenCalledWith(false)

      view.rerender(createElement(WorkbenchSection, {
        title: 'Clue sources',
        open: false,
        onOpenChange,
        children: createElement('input', { 'data-draft': 'true', defaultValue: '' }),
      }))
      expect(toggleOf(view).getAttribute('aria-expanded')).toBe('false')
      expect(view.container.querySelector('[data-workbench-section]')!.getAttribute('data-open')).toBe('false')
      expect(bodyOf(view).hidden).toBe(true)

      act(() => { toggleOf(view).click() })
      expect(onOpenChange).toHaveBeenLastCalledWith(true)
    } finally {
      view.unmount()
    }
  })

  it('keeps the body mounted and its draft intact while collapsed', () => {
    const { view } = mount()
    try {
      const input = view.container.querySelector<HTMLInputElement>('[data-draft]')!
      act(() => { input.value = 'owner/repo' })

      view.rerender(createElement(WorkbenchSection, {
        title: 'Clue sources',
        open: false,
        onOpenChange: () => {},
        children: createElement('input', { 'data-draft': 'true', defaultValue: '' }),
      }))
      const collapsedInput = view.container.querySelector<HTMLInputElement>('[data-draft]')!
      expect(collapsedInput).toBe(input)
      expect(collapsedInput.value).toBe('owner/repo')
      expect(bodyOf(view).hidden).toBe(true)
      expect(view.container.querySelector('[data-workbench-section]')!.contains(input)).toBe(true)

      view.rerender(createElement(WorkbenchSection, {
        title: 'Clue sources',
        open: true,
        onOpenChange: () => {},
        children: createElement('input', { 'data-draft': 'true', defaultValue: '' }),
      }))
      expect(view.container.querySelector('[data-draft]')).toBe(input)
      expect(input.value).toBe('owner/repo')
      expect(bodyOf(view).hidden).toBe(false)
    } finally {
      view.unmount()
    }
  })
})

describe('nested and compact variants', () => {
  it('exposes the level and size for the explorer stack', () => {
    const { view } = mount({ level: 1, size: 'compact' })
    try {
      const root = view.container.querySelector<HTMLElement>('[data-workbench-section]')!
      expect(root.getAttribute('data-level')).toBe('1')
      expect(root.getAttribute('data-size')).toBe('compact')
      // The body is still mounted (a compact section is a layout cap, not a
      // different mounting rule).
      expect(bodyOf(view).hidden).toBe(false)
    } finally {
      view.unmount()
    }
  })
})

