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
  document.body.append(strip)
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
})
