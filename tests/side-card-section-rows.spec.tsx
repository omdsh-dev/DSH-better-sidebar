/**
 * Interactive tests for the settings popup's text/number/select rows: the
 * draft is local state committed on blur through the parent's onCommit; the
 * parent's canonical return is adopted (clamped numbers, stored value for
 * invalid input), and the row remounts when the committed pref value changes
 * (a failed commit reverts prefs → the stored value reappears). Select rows
 * commit the picked option's value (single) or the picked values in options
 * order (multi) through onSelectValue.
 *
 * Rendered with createRoot + act() in jsdom (the SSR specs stay in
 * side-card-section.spec.tsx; this file exercises the event paths).
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
import type { SidebarSettingToggle } from '../src/client/service.ts'
import { FeatureSettingsRows } from '../src/client/SideCardSection.tsx'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'

/** Render the rows into a detached container under React's act(). */
function mount(node: ReactNode): { container: HTMLDivElement; rerender: (node: ReactNode) => void; unmount: () => void } {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => { root.render(node) })
  return {
    container,
    rerender: (next) => { act(() => { root.render(next) }) },
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

/** Type into an input and commit it via blur (React 18: input event +
 *  focusout). The native setter bypasses React's value tracker so the
 *  change is actually seen. */
function typeAndBlur(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

const prefs = { ...SIDEBAR_PREFS_DEFAULTS }

describe('FeatureSettingsRows typed rows (interactive)', () => {
  it('commits the raw text on blur and adopts the canonical return', () => {
    const commits: Array<[string, string]> = []
    const toggle: SidebarSettingToggle = {
      key: 'terminalFontFamily',
      type: 'text',
      title: () => 'Font family',
    }
    const { container, unmount } = mount(createElement(FeatureSettingsRows, {
      toggles: [toggle],
      prefs,
      onToggle: () => {},
      onCommit: (t, raw) => {
        commits.push([t.key, raw])
        return raw
      },
    }))
    const input = container.querySelector('input')!
    typeAndBlur(input, 'Monaco')
    expect(commits).toEqual([['terminalFontFamily', 'Monaco']])
    // The canonical return is adopted into the draft.
    expect(input.value).toBe('Monaco')
    unmount()
  })

  it('clamps numbers into the declared bounds on commit', () => {
    const commits: Array<[string, number]> = []
    const toggle: SidebarSettingToggle = {
      key: 'terminalFontSize',
      type: 'number',
      title: () => 'Font size',
      min: 9,
      max: 32,
    }
    const { container, unmount } = mount(createElement(FeatureSettingsRows, {
      toggles: [toggle],
      prefs: { ...prefs, terminalFontSize: 13 },
      onToggle: () => {},
      onCommit: (t, raw) => {
        const parsed = Number(raw)
        const clamped = Math.min(32, Math.max(9, Math.round(parsed)))
        commits.push([t.key, clamped])
        return String(clamped)
      },
    }))
    const input = container.querySelector('input')!
    typeAndBlur(input, '40')
    expect(commits).toEqual([['terminalFontSize', 32]])
    expect(input.value).toBe('32')
    unmount()
  })

  it('clamps an emptied number input to the lower bound on commit (width-row precedent)', () => {
    const commits: Array<[string, number]> = []
    const toggle: SidebarSettingToggle = {
      key: 'terminalFontSize',
      type: 'number',
      title: () => 'Font size',
      min: 9,
      max: 32,
    }
    const { container, unmount } = mount(createElement(FeatureSettingsRows, {
      toggles: [toggle],
      prefs: { ...prefs, terminalFontSize: 13 },
      onToggle: () => {},
      // The parent mirrors the real handler: an emptied number parses to 0
      // and clamps into the bounds (a browser number input never holds a
      // non-numeric string — the draft can only be empty or numeric).
      onCommit: (t, raw) => {
        const clamped = Math.min(32, Math.max(9, Math.round(Number(raw))))
        commits.push([t.key, clamped])
        return String(clamped)
      },
    }))
    const input = container.querySelector('input')!
    typeAndBlur(input, '')
    expect(commits).toEqual([['terminalFontSize', 9]])
    expect(input.value).toBe('9')
    unmount()
  })

  it('reverts the draft to the committed value after a failed commit reverts prefs', () => {
    const toggle: SidebarSettingToggle = {
      key: 'terminalFontFamily',
      type: 'text',
      title: () => 'Font family',
    }
    // The parent mirrors the real handler: the optimistic commit adopts the
    // typed value, and a FAILED write reverts prefs to the stored one.
    let prefsNow = { ...prefs, terminalFontFamily: 'Old' }
    const { container, rerender, unmount } = mount(createElement(FeatureSettingsRows, {
      toggles: [toggle],
      prefs: prefsNow,
      onToggle: () => {},
      onCommit: (_t, raw) => raw,
    }))
    const input = container.querySelector('input')!
    typeAndBlur(input, 'New')
    // Optimistic commit: the draft adopts the typed value.
    expect(input.value).toBe('New')
    // The optimistic pref lands (parent state): the key changes, the row
    // remounts with the same value — no visible reset while editing.
    prefsNow = { ...prefsNow, terminalFontFamily: 'New' }
    rerender(createElement(FeatureSettingsRows, {
      toggles: [toggle],
      prefs: prefsNow,
      onToggle: () => {},
      onCommit: (_t, raw) => raw,
    }))
    expect(container.querySelector('input')!.value).toBe('New')
    // The write fails: prefs revert to the stored value and the row
    // remounts with it (the stale draft is gone).
    prefsNow = { ...prefsNow, terminalFontFamily: 'Old' }
    rerender(createElement(FeatureSettingsRows, {
      toggles: [toggle],
      prefs: prefsNow,
      onToggle: () => {},
      onCommit: (_t, raw) => raw,
    }))
    expect(container.querySelector('input')!.value).toBe('Old')
    unmount()
  })
})

/** Open one select row's dropdown: click the anchor, the Menu portals its
 *  list into document.body (role="menuitem" rows). */
function openSelect(container: HTMLDivElement): HTMLElement[] {
  const anchor = container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!
  act(() => { anchor.click() })
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

describe('FeatureSettingsRows select rows (interactive)', () => {
  const options: NonNullable<SidebarSettingToggle['options']> = [
    { value: true, icon: (size: number) => createElement('i', { 'data-size': size }), title: () => 'Merged', desc: () => 'Docked tree' },
    { value: false, icon: (size: number) => createElement('i', { 'data-size': size }), title: () => 'Split', desc: () => 'Two tabs' },
  ]

  it('commits the picked option value and closes (iconed single select)', () => {
    const commits: Array<[string, unknown]> = []
    const toggle: SidebarSettingToggle = {
      key: 'editorExplorer',
      type: 'select',
      title: () => 'Editor explorer',
      options,
    }
    const { container, unmount } = mount(createElement(FeatureSettingsRows, {
      toggles: [toggle],
      // Merged is the selected option for this scenario (the default is now
      // separate — the anchor must render whatever value the prefs carry).
      prefs: { ...prefs, editorExplorer: true },
      onToggle: () => {},
      onSelectValue: (t, next) => { commits.push([t.key, next]) },
    }))
    // The closed anchor shows the selected option's title (icon variant).
    expect(container.textContent).toContain('Merged')
    const items = openSelect(container)
    // Big-icon cards: title + desc per option.
    expect(items.map(item => item.textContent)).toEqual(['MergedDocked tree', 'SplitTwo tabs'])
    act(() => { items[1]!.click() })
    expect(commits).toEqual([['editorExplorer', false]])
    // Single-pick closes the dropdown.
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(0)
    unmount()
  })

  it('toggles membership and commits the picked values in options order (multi)', () => {
    const commits: Array<[string, unknown]> = []
    const plain: NonNullable<SidebarSettingToggle['options']> = [
      { value: 'a', title: () => 'Alpha' },
      { value: 'b', title: () => 'Beta' },
      { value: 'c', title: () => 'Gamma' },
    ]
    const toggle: SidebarSettingToggle = {
      key: 'pluginKey',
      type: 'select',
      multi: true,
      title: () => 'Pick several',
      options: plain,
    }
    const rows = (value: unknown) => createElement(FeatureSettingsRows, {
      toggles: [toggle],
      prefs,
      onToggle: () => {},
      onSelectValue: (t, next) => { commits.push([t.key, next]) },
      valueSource: () => value,
    })
    const { container, rerender, unmount } = mount(rows(['c', 'a']))
    // The anchor shows the picked titles; options follow the declared order.
    const items = openSelect(container)
    expect(items.map(item => item.textContent)).toEqual(['Alpha', 'Beta', 'Gamma'])
    // Deselect 'a' → ['c'] is normalized to options order… (['c'] here).
    act(() => { items[0]!.click() })
    expect(commits).toEqual([['pluginKey', ['c']]])
    // The menu stays open under multi; re-render with the committed value.
    rerender(rows(['c']))
    const again = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(again).toHaveLength(3)
    // Select 'b' → committed in OPTIONS order, not pick order.
    act(() => { again[1]!.click() })
    expect(commits[1]).toEqual(['pluginKey', ['b', 'c']])
    unmount()
  })

  it('shows an em dash when nothing is selected', () => {
    const toggle: SidebarSettingToggle = {
      key: 'editorExplorer',
      type: 'select',
      title: () => 'Editor explorer',
      options,
    }
    const { container, unmount } = mount(createElement(FeatureSettingsRows, {
      toggles: [toggle],
      prefs,
      onToggle: () => {},
      valueSource: () => undefined,
    }))
    expect(container.querySelector('button[aria-haspopup="listbox"]')!.textContent).toContain('—')
    unmount()
  })
})
