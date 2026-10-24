// @vitest-environment jsdom
/**
 * Width pinning for the plugin's OWN tab strip (the bottom workbench).
 *
 * Equal-width tabs are the point, but they also mean every close widens the
 * survivors — so closing a run of tabs turns into a chase for the ×. The strip
 * therefore pins the width it had when the run started, for as long as the
 * pointer stays inside it, and only re-lays-out when the pointer leaves
 * (Chrome's behavior). The pinning is a CSS custom property on the strip
 * (`data-frozen` + `--dsh-tab-frozen-width`), keyed by the stylesheet's
 * `.tabBar[data-frozen] .tab { flex: 0 0 var(…) }`.
 *
 * Pinned here:
 *  - a close under the pointer freezes; the same close with the pointer
 *    elsewhere does not;
 *  - the frozen value is the CONTENT width `flex-basis` uses (border box minus
 *    padding/borders), measured before the removed tab leaves the DOM;
 *  - the second and third close keep the same value (no re-measuring);
 *  - middle-click close freezes too (it is the same intent);
 *  - leaving the strip clears the pin, which is when the equal share returns.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

import { TabBar } from '../src/client/TabBar.tsx'
import type { SidebarTab } from '../src/client/state.ts'

const roots: Root[] = []

function makeTabs(count: number): SidebarTab[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `t${index}`,
    type: 'editor',
    title: `tab-${index}.ts`,
  }))
}

function mount(tabs: SidebarTab[]): { container: HTMLElement; bar: HTMLElement; onClose: ReturnType<typeof vi.fn>; rerender: (next: SidebarTab[]) => void } {
  const container = document.createElement('div')
  document.body.append(container)
  const onClose = vi.fn()
  const root = createRoot(container)
  roots.push(root)
  const element = (list: SidebarTab[]): ReturnType<typeof createElement> => createElement(TabBar, {
    paneId: 'pane:1',
    tabs: list,
    active: list[0]?.id ?? null,
    onActivate: () => {},
    onClose,
    onNewTab: () => {},
    newTabOptions: [],
    onDropTab: () => {},
  })
  act(() => { root.render(element(tabs)) })
  const bar = container.firstElementChild as HTMLElement
  return { container, bar, onClose, rerender: (next) => { act(() => { root.render(element(next)) }) } }
}

/** jsdom reports zero-sized boxes; give tab chips the 120px of a real strip. */
function stubGeometry(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const width = this.hasAttribute('data-dsh-tab') ? 120 : 0
    return { width, height: 34, top: 0, left: 0, right: width, bottom: 34, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  })
}

function hover(bar: HTMLElement): void {
  act(() => { bar.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, relatedTarget: null })) })
}

function leave(bar: HTMLElement): void {
  act(() => { bar.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body })) })
}

function closeButton(container: HTMLElement, index: number): HTMLElement {
  const buttons = [...container.querySelectorAll<HTMLElement>('[class*="tabClose"]')]
  const button = buttons[index]
  if (button === undefined) throw new Error(`no close button at ${index}`)
  return button
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('tab strip width freeze', () => {
  it('freezes the content width while the pointer is inside the strip', () => {
    stubGeometry()
    const { container, bar, onClose } = mount(makeTabs(4))
    hover(bar)

    act(() => { closeButton(container, 1).click() })

    expect(onClose).toHaveBeenCalledWith('t1')
    expect(bar.hasAttribute('data-frozen')).toBe(true)
    expect(bar.style.getPropertyValue('--dsh-tab-frozen-width')).toBe('120px')
  })

  it('does not freeze a close made from outside the strip', () => {
    stubGeometry()
    const { container, bar } = mount(makeTabs(3))

    act(() => { closeButton(container, 0).click() })

    expect(bar.hasAttribute('data-frozen')).toBe(false)
    expect(bar.style.getPropertyValue('--dsh-tab-frozen-width')).toBe('')
  })

  it('keeps the same width across a run of closes instead of re-measuring', () => {
    stubGeometry()
    const { container, bar, rerender } = mount(makeTabs(4))
    hover(bar)
    act(() => { closeButton(container, 3).click() })
    expect(bar.style.getPropertyValue('--dsh-tab-frozen-width')).toBe('120px')

    // The parent removes the tab and the survivors get narrower in reality;
    // the frozen value must not follow them.
    rerender(makeTabs(3))
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const width = this.hasAttribute('data-dsh-tab') ? 90 : 0
      return { width, height: 34, top: 0, left: 0, right: width, bottom: 34, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    })
    act(() => { closeButton(container, 2).click() })
    expect(bar.style.getPropertyValue('--dsh-tab-frozen-width')).toBe('120px')
    spy.mockRestore()
  })

  it('freezes a middle-click close as well', () => {
    stubGeometry()
    const { container, bar } = mount(makeTabs(3))
    hover(bar)
    const tab = container.querySelectorAll<HTMLElement>('[data-dsh-tab]')[1]
    if (tab === undefined) throw new Error('no tab')
    act(() => { tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 1 })) })
    act(() => { tab.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 1 })) })
    expect(bar.hasAttribute('data-frozen')).toBe(true)
  })

  it('releases the pin on pointer leave, restoring the equal share', () => {
    stubGeometry()
    const { container, bar } = mount(makeTabs(3))
    hover(bar)
    act(() => { closeButton(container, 0).click() })
    expect(bar.hasAttribute('data-frozen')).toBe(true)

    leave(bar)
    expect(bar.hasAttribute('data-frozen')).toBe(false)
    expect(bar.style.getPropertyValue('--dsh-tab-frozen-width')).toBe('')
  })
})
