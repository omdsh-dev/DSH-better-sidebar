/**
 * Regression guard for the terminal-tab inline rename (local fork feature).
 *
 * Pinned behaviors:
 * - double-clicking a renamable tab's label opens the inline editor with the
 *   whole draft selected (type-to-replace affordance),
 * - keystrokes ACCUMULATE — the editor must not re-select the value after
 *   every render (a previous implementation used an inline ref callback, so
 *   React re-ran focus()/select() on each keystroke and every new character
 *   replaced the previous one),
 * - Enter commits, Escape cancels, blur commits, IME Enter is ignored.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { TabBar, type NewTabOption } from '../src/client/TabBar.tsx'
import type { SidebarTab } from '../src/client/state.ts'

const TERMINAL_TAB: SidebarTab = { id: 'terminal:1', type: 'terminal', title: '终端 1' }

/**
 * Type text into a React-controlled input the way real keystrokes surface:
 * the native value setter (React ignores direct `input.value =` assignments)
 * plus a bubbling `input` event, one character at a time.
 */
function typeText(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  for (const ch of text) {
    setter.call(input, input.value + ch)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
}

describe('TabBar terminal-tab rename', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  const renderTabBar = (onRename: (tabId: string, title: string) => void): void => {
    act(() => {
      root.render(
        <TabBar
          paneId="pane-1"
          tabs={[TERMINAL_TAB]}
          active="terminal:1"
          onActivate={() => { /* no-op */ }}
          onClose={() => { /* no-op */ }}
          onNewTab={() => { /* no-op */ }}
          newTabOptions={[] as NewTabOption[]}
          onDropTab={() => { /* no-op */ }}
          canRenameTab={() => true}
          onRename={onRename}
        />,
      )
    })
  }

  /** Double-click the tab's label and return the opened rename editor. */
  const openRenameEditor = (): HTMLInputElement => {
    const label = [...container.querySelectorAll('span')].find(el => el.textContent === '终端 1')
    expect(label).toBeDefined()
    act(() => {
      label!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    const input = container.querySelector('input')
    expect(input).not.toBeNull()
    return input as HTMLInputElement
  }

  it('opens with the whole draft selected and accumulates keystrokes without re-selecting', () => {
    const onRename = vi.fn()
    renderTabBar(onRename)
    const input = openRenameEditor()

    // On entry the whole label is selected (type-to-replace affordance).
    expect(input.value).toBe('终端 1')
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)

    // Regression: keystrokes must accumulate. The broken implementation
    // re-ran select() on every re-render, so each new character replaced the
    // previous one (typing "ABC" ended with just "C").
    act(() => { typeText(input, 'A') })
    expect(input.value).toBe('终端 1A')
    act(() => { typeText(input, 'B') })
    expect(input.value).toBe('终端 1AB')
    act(() => { typeText(input, 'C') })
    expect(input.value).toBe('终端 1ABC')
  })

  it('commits the accumulated draft on Enter and leaves edit mode', () => {
    const onRename = vi.fn()
    renderTabBar(onRename)
    const input = openRenameEditor()
    act(() => { typeText(input, '部署机') })
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onRename).toHaveBeenCalledExactlyOnceWith('terminal:1', '终端 1部署机')
    expect(container.querySelector('input')).toBeNull()
  })

  it('cancels on Escape (no commit) and commits on blur', () => {
    const onRename = vi.fn()
    renderTabBar(onRename)
    let input = openRenameEditor()
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onRename).not.toHaveBeenCalled()
    expect(container.querySelector('input')).toBeNull()

    input = openRenameEditor()
    act(() => { typeText(input, 'X') })
    act(() => {
      // React implements onBlur through the bubbling `focusout` event
      // (native `blur` does not bubble), so the test must dispatch that.
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(onRename).toHaveBeenCalledExactlyOnceWith('terminal:1', '终端 1X')
  })

  it('ignores Enter while an IME composition is in progress', () => {
    const onRename = vi.fn()
    renderTabBar(onRename)
    const input = openRenameEditor()
    const keydown = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    Object.defineProperty(keydown, 'isComposing', { value: true })
    act(() => {
      input.dispatchEvent(keydown)
    })
    expect(onRename).not.toHaveBeenCalled()
    expect(container.querySelector('input')).not.toBeNull()
  })
})
