/**
 * The native tab menu's close-family rows (close others / left / right / all).
 *
 * They are contributed through the host's public `sidebar.right.tab.menu.item`
 * seat, whose owner share is `{ tab, dismiss }` — no pane, no order. Closing
 * neighbours is only meaningful inside the right-clicked tab's own STRIP, so
 * the rows resolve it from the kit's chips (`[data-dockkit-tab]` inside
 * `[data-dockkit-strip-tabs]`, stable semantic attributes — never a CSS-module
 * class). Two panes are two strips: the lookup must follow the CLICKED chip.
 *
 * The contract this spec pins:
 *  - the four rows, in a stable order, acting only on the clicked strip;
 *  - every acting row dismisses the kit's menu before closing (the menu is the
 *    host's, and it closes on its own actions only);
 *  - nothing to do ⇒ the row stays visible but disabled (the menu's shape must
 *    not jump between tabs);
 *  - the strip cannot be resolved ⇒ NO rows at all. The kit's own "Close" is
 *    still there, so the menu never degrades into a dead row, and the plugin
 *    never guesses a scope (a session-wide "close others" would close the
 *    other pane's tabs).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

import { NativeTabMenuItems, stripOrderOf } from '../src/client/native/tab-menu.tsx'

/** Chinese so the row labels can be asserted verbatim. */
function stubZh(): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'zh-CN' },
    configurable: true,
  })
}

/** One kit filmstrip, as the host renders it: chips carry `data-dockkit-tab`. */
function filmstrip(ids: readonly string[], paneId: string): void {
  const strip = document.createElement('div')
  strip.setAttribute('data-dockkit-strip-tabs', paneId)
  for (const id of ids) {
    const chip = document.createElement('div')
    chip.setAttribute('data-dockkit-tab', id)
    strip.append(chip)
  }
  let panel = document.querySelector('[data-sidebar-right-panel]')
  if (panel === null) {
    panel = document.createElement('div')
    panel.setAttribute('data-sidebar-right-panel', 'push')
    panel.setAttribute('data-sidebar-right-session', 'session1')
    panel.setAttribute('data-sidebar-right-open', '')
    document.body.append(panel)
  }
  panel.append(strip)
}

const roots: Root[] = []

function mount(tabId: string): {
  container: HTMLElement
  dismiss: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
} {
  const container = document.createElement('div')
  document.body.append(container)
  const dismiss = vi.fn()
  const close = vi.fn()
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(createElement(NativeTabMenuItems, { tab: { id: tabId }, dismiss, close }))
  })
  return { container, dismiss, close }
}

function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

function row(container: HTMLElement, action: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`[data-dsh-better-sidebar-tab-menu-action="${action}"]`)
  if (found === null) throw new Error(`row not found: ${action}`)
  return found
}

function click(node: HTMLElement): void {
  act(() => { node.click() })
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('native tab menu rows', () => {
  it('offers the four close-family rows in a stable order', () => {
    stubZh()
    filmstrip(['t1', 't2', 't3'], 'pane:1')
    const { container } = mount('t2')
    expect(rows(container).map(node => node.dataset.dshBetterSidebarTabMenuAction))
      .toEqual(['closeOthers', 'closeLeft', 'closeRight', 'closeAll'])
    expect(rows(container).map(node => node.textContent)).toEqual([
      '关闭其他', '关闭左侧', '关闭右侧', '关闭全部',
    ])
  })

  it('gives every row a distinct leading glyph, split from the kit\'s own Close', () => {
    filmstrip(['t1', 't2'], 'pane:1')
    const { container } = mount('t1')
    const items = rows(container)
    // Four rows that share one verb are told apart by their glyphs, not by
    // the word at the end of the line.
    for (const item of items) expect(item.querySelector('svg'), item.textContent ?? '').not.toBeNull()
    const separator = container.querySelector('[role="separator"]')
    expect(separator).not.toBeNull()
    const first = items[0]
    if (separator === null || first === undefined) throw new Error('missing separator or row')
    // The rule sits ABOVE the group: the kit's "Close" row is not ours to move.
    expect(separator.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('closes the other tabs of the clicked strip after dismissing the menu', () => {
    filmstrip(['t1', 't2', 't3'], 'pane:1')
    const { container, dismiss, close } = mount('t2')
    click(row(container, 'closeOthers'))
    expect(dismiss).toHaveBeenCalledTimes(1)
    expect(close.mock.calls.map(call => call[0])).toEqual(['t1', 't3'])
  })

  it('slices left and right of the clicked tab, and closes everything', () => {
    filmstrip(['t1', 't2', 't3', 't4'], 'pane:1')

    const left = mount('t3')
    click(row(left.container, 'closeLeft'))
    expect(left.close.mock.calls.map(call => call[0])).toEqual(['t1', 't2'])

    const right = mount('t2')
    click(row(right.container, 'closeRight'))
    expect(right.close.mock.calls.map(call => call[0])).toEqual(['t3', 't4'])

    const all = mount('t3')
    click(row(all.container, 'closeAll'))
    expect(all.close.mock.calls.map(call => call[0])).toEqual(['t1', 't2', 't3', 't4'])
  })

  it('keeps the rows visible but disabled when there is nothing to close', () => {
    filmstrip(['only'], 'pane:1')
    const { container, dismiss, close } = mount('only')
    expect(rows(container)).toHaveLength(4)
    expect(row(container, 'closeOthers').disabled).toBe(true)
    expect(row(container, 'closeLeft').disabled).toBe(true)
    expect(row(container, 'closeRight').disabled).toBe(true)
    expect(row(container, 'closeAll').disabled).toBe(false)

    click(row(container, 'closeAll'))
    expect(dismiss).toHaveBeenCalledTimes(1)
    expect(close.mock.calls.map(call => call[0])).toEqual(['only'])
  })

  it('follows the CLICKED chip when the sidebar is split into two strips', () => {
    filmstrip(['a1', 'a2'], 'pane:left')
    filmstrip(['b1', 'b2', 'b3'], 'pane:right')
    const { container, close } = mount('b2')
    click(row(container, 'closeOthers'))
    // Not a1/a2: those live in the other pane's strip.
    expect(close.mock.calls.map(call => call[0])).toEqual(['b1', 'b3'])
  })

  it('renders nothing when the clicked tab is not inside a recognizable strip', () => {
    stubZh()
    // A chip with no strip around it (a host layout this plugin cannot scope).
    const orphan = document.createElement('div')
    orphan.setAttribute('data-dockkit-tab', 'x1')
    document.body.append(orphan)
    const { container } = mount('x1')
    expect(rows(container)).toHaveLength(0)

    // …and a tab that is not in the DOM at all.
    const missing = mount('ghost')
    expect(rows(missing.container)).toHaveLength(0)
  })

  it('resolves strip order from the kit attributes alone', () => {
    filmstrip(['s2', 's3'], 'pane:1')
    filmstrip(['q1'], 'pane:2')
    expect(stripOrderOf('s3')).toEqual(['s2', 's3'])
    expect(stripOrderOf('q1')).toEqual(['q1'])
    expect(stripOrderOf('nope')).toBeUndefined()
  })
  it('ignores retained hidden session duplicate ids before the visible session', () => {
    filmstrip(['t1', 'hidden-neighbor'], 'same-pane')
    const hidden = document.querySelector('[data-sidebar-right-panel]') as HTMLElement
    const seat = document.createElement('div')
    seat.hidden = true
    seat.setAttribute('data-sidebar-right-session', 'old')
    hidden.remove()
    filmstrip(['t1', 'visible-neighbor'], 'same-pane')
    seat.append(hidden)
    document.body.prepend(seat)
    const { container, close } = mount('t1')
    click(row(container, 'closeOthers'))
    expect(close.mock.calls.map(call => call[0])).toEqual(['visible-neighbor'])
  })

  it('fails closed on duplicate visible ids or multiple visible panels', () => {
    filmstrip(['t1', 't2'], 'left')
    filmstrip(['t1', 't3'], 'right')
    expect(stripOrderOf('t1')).toBeUndefined()
    const panel = document.querySelector('[data-sidebar-right-panel]') as HTMLElement
    document.body.append(panel.cloneNode(true))
    expect(stripOrderOf('t2')).toBeUndefined()
  })

  it('does not close a new session through a menu opened before the switch', () => {
    filmstrip(['t1', 't2'], 'left')
    const { container, close, dismiss } = mount('t1')
    const panel = document.querySelector('[data-sidebar-right-panel]') as HTMLElement
    panel.setAttribute('data-sidebar-right-session', 'new-session')
    click(row(container, 'closeAll'))
    expect(dismiss).toHaveBeenCalledOnce()
    expect(close).not.toHaveBeenCalled()
  })

  it('does not resolve collapsed or CSS-hidden session panels', () => {
    filmstrip(['t1', 't2'], 'left')
    const panel = document.querySelector('[data-sidebar-right-panel]') as HTMLElement
    panel.removeAttribute('data-sidebar-right-open')
    expect(stripOrderOf('t1')).toBeUndefined()
    panel.setAttribute('data-sidebar-right-open', '')
    panel.setAttribute('aria-hidden', 'true')
    expect(stripOrderOf('t1')).toBeUndefined()
    panel.removeAttribute('aria-hidden')
    panel.style.display = 'none'
    expect(stripOrderOf('t1')).toBeUndefined()
    panel.style.display = ''
    expect(stripOrderOf('t1')).toEqual(['t1', 't2'])
  })

  it('revalidates pane membership after synchronous dismiss', () => {
    filmstrip(['t1', 't2'], 'left')
    filmstrip(['s1'], 'right')
    const { container, close, dismiss } = mount('t1')
    dismiss.mockImplementation(() => {
      const strips = document.querySelectorAll('[data-dockkit-strip-tabs]')
      strips[1]?.append(document.querySelector('[data-dockkit-tab="t2"]') as Element)
    })
    click(row(container, 'closeAll'))
    expect(close).not.toHaveBeenCalled()
  })

  it('does not follow a pending target moved by an earlier close callback', () => {
    filmstrip(['t1', 't2', 't3'], 'left')
    filmstrip(['s1'], 'right')
    const { container, close } = mount('t1')
    close.mockImplementation((id: string) => {
      document.querySelector(`[data-dockkit-tab="${id}"]`)?.remove()
      if (id === 't1') document.querySelector('[data-dockkit-strip-tabs="right"]')
        ?.append(document.querySelector('[data-dockkit-tab="t2"]') as Element)
    })
    click(row(container, 'closeAll'))
    expect(close.mock.calls.map(call => call[0])).toEqual(['t1', 't3'])
  })

  it('rejects the entire unchanged source group moved into a different pane', () => {
    filmstrip(['t1', 't2'], 'left')
    filmstrip(['s1'], 'right')
    const { container, close, dismiss } = mount('t1')
    dismiss.mockImplementation(() => {
      const source = document.querySelector('[data-dockkit-strip-tabs="left"]') as Element
      const sibling = document.querySelector('[data-dockkit-strip-tabs="right"]') as Element
      sibling.replaceChildren(...source.children)
    })
    click(row(container, 'closeAll'))
    expect(close).not.toHaveBeenCalled()
  })

  it('rejects a stale menu after the source strip changes order', () => {
    filmstrip(['t1', 't2'], 'left')
    const { container, close } = mount('t1')
    const strip = document.querySelector('[data-dockkit-strip-tabs]') as HTMLElement
    strip.prepend(strip.lastElementChild as Element)
    click(row(container, 'closeAll'))
    expect(close).not.toHaveBeenCalled()
  })

})
