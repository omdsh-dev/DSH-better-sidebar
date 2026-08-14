/**
 * Interactive tests for the settings popup's text/number rows and shortcut
 * recorder: typed setting drafts commit on blur, while shortcut buttons arm
 * explicitly and capture the next modifier-plus-key chord without allowing it
 * to escape into the app. Failed writes remount rows from committed prefs.
 *
 * Rendered with createRoot + act() in jsdom (the SSR specs stay in
 * side-card-section.spec.tsx; this file exercises the event paths).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
import type { SidebarSettingToggle } from '../src/client/service.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { api } from '../src/client/api.ts'
import { FeatureSettingsRows, ShortcutRow, SideCardSection, type SideCardSectionProps } from '../src/client/SideCardSection.tsx'
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

/** Dispatch one real, cancelable recorder keydown under React's act(). */
function pressKey(
  target: HTMLElement,
  init: { key: string; code?: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; repeat?: boolean },
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: init.key,
    code: init.code,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
    repeat: init.repeat ?? false,
    bubbles: true,
    cancelable: true,
  })
  act(() => { target.dispatchEvent(event) })
  return event
}

const prefs = { ...SIDEBAR_PREFS_DEFAULTS }

afterEach(() => { vi.restoreAllMocks() })

/** Let mounted effects and queued promise continuations settle under act(). */
async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  })
}

/** Controllable promise used to exercise serialized settings writes. */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

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

describe('ShortcutRow (interactive)', () => {
  it('renders the current chord and only records after explicit activation', () => {
    const commits: string[] = []
    const { container, unmount } = mount(createElement(ShortcutRow, {
      title: 'Toggle sidebar',
      value: 'Ctrl+B',
      onCommit: (chord) => { commits.push(chord) },
    }))
    const button = container.querySelector('button')!
    expect(button.textContent).toContain('Ctrl+B')
    expect(button.getAttribute('aria-pressed')).toBe('false')
    act(() => { button.click() })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.textContent).toContain('Press shortcut')
    expect(commits).toEqual([])
    unmount()
  })

  it('records and immediately commits a canonical chord', () => {
    const commits: string[] = []
    const { container, unmount } = mount(createElement(ShortcutRow, {
      title: 'Toggle sidebar',
      value: 'Ctrl+B',
      onCommit: (chord) => { commits.push(chord) },
    }))
    const button = container.querySelector('button')!
    act(() => { button.click() })
    const event = pressKey(button, { key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true })
    expect(commits).toEqual(['Ctrl+Shift+K'])
    expect(event.defaultPrevented).toBe(true)
    expect(button.getAttribute('aria-pressed')).toBe('false')
    unmount()
  })

  it('shows modifier-only presses as a live preview until the final key arrives', () => {
    const commits: string[] = []
    const { container, unmount } = mount(createElement(ShortcutRow, {
      title: 'Save editor',
      value: 'Ctrl+S',
      onCommit: (chord) => { commits.push(chord) },
    }))
    const button = container.querySelector('button')!
    act(() => { button.click() })
    pressKey(button, { key: 'Control', code: 'ControlLeft', ctrlKey: true })
    expect(button.textContent).toContain('Ctrl+')
    expect(commits).toEqual([])
    pressKey(button, { key: 'k', code: 'KeyK', ctrlKey: true })
    expect(commits).toEqual(['Ctrl+K'])
    unmount()
  })

  it('keeps recording and explains bare or unsupported keys without committing', () => {
    const commits: string[] = []
    const { container, unmount } = mount(createElement(ShortcutRow, {
      title: 'Git commit',
      value: 'Ctrl+Enter',
      onCommit: (chord) => { commits.push(chord) },
    }))
    const button = container.querySelector('button')!
    act(() => { button.click() })
    pressKey(button, { key: 'k', code: 'KeyK' })
    expect(commits).toEqual([])
    expect(button.getAttribute('aria-invalid')).toBe('true')
    expect(container.textContent).toContain('Hold Ctrl, Cmd, or Alt')
    pressKey(button, { key: 'K', code: 'KeyK', shiftKey: true })
    expect(commits).toEqual([])
    expect(container.textContent).toContain('Hold Ctrl, Cmd, or Alt')
    pressKey(button, { key: '?', code: 'Slash', ctrlKey: true })
    expect(commits).toEqual([])
    expect(container.textContent).toContain('That key is not supported')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    unmount()
  })

  it('cancels with Escape and leaves Tab available for focus navigation', () => {
    const commits: string[] = []
    const { container, unmount } = mount(createElement(ShortcutRow, {
      title: 'Toggle sidebar',
      value: 'Ctrl+B',
      onCommit: (chord) => { commits.push(chord) },
    }))
    const button = container.querySelector('button')!
    act(() => { button.click() })
    const escape = pressKey(button, { key: 'Escape', code: 'Escape' })
    expect(escape.defaultPrevented).toBe(true)
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.textContent).toContain('Ctrl+B')

    act(() => { button.click() })
    const tab = pressKey(button, { key: 'Tab', code: 'Tab' })
    expect(tab.defaultPrevented).toBe(false)
    expect(button.getAttribute('aria-pressed')).toBe('false')

    act(() => {
      button.focus()
      button.click()
    })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    act(() => { button.blur() })
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(commits).toEqual([])
    unmount()
  })

  it('contains a captured chord so document-level app shortcuts cannot fire', () => {
    const seen: KeyboardEvent[] = []
    const onDocumentKey = (event: KeyboardEvent): void => { seen.push(event) }
    document.addEventListener('keydown', onDocumentKey)
    const { container, unmount } = mount(createElement(ShortcutRow, {
      title: 'Toggle sidebar',
      value: 'Ctrl+B',
      onCommit: () => {},
    }))
    try {
      const button = container.querySelector('button')!
      act(() => { button.click() })
      pressKey(button, { key: 'b', code: 'KeyB', ctrlKey: true })
      expect(seen).toEqual([])
    } finally {
      document.removeEventListener('keydown', onDocumentKey)
      unmount()
    }
  })

  it('remounts with the stored chord after a failed commit reverts the pref', () => {
    // The section keys each row by `id:committed value` so a pref revert
    // changes the key and the row remounts with the stored chord; the test
    // mirrors that keying.
    let value = 'Ctrl+B'
    const row = (): ReactNode => createElement(ShortcutRow, {
      key: `toggle: ${value}`,
      title: 'Toggle sidebar',
      value,
      onCommit: (chord) => { value = chord },
    })
    const { container, rerender, unmount } = mount(row())
    const button = container.querySelector('button')!
    act(() => { button.click() })
    pressKey(button, { key: 'k', code: 'KeyK', ctrlKey: true })
    expect(value).toBe('Ctrl+K')
    // The optimistic pref lands; the keyed row remounts with the new chord.
    rerender(row())
    expect(container.querySelector('button')!.textContent).toContain('Ctrl+K')
    // The write fails: the stored value comes back through the key.
    value = 'Ctrl+B'
    rerender(row())
    expect(container.querySelector('button')!.textContent).toContain('Ctrl+B')
    unmount()
  })
})

describe('SideCardSection shortcut persistence', () => {
  it('preserves two shortcut edits made while the first settings write is pending', async () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    const updates: Array<{ patch: Record<string, unknown>; expectedRevision?: number }> = []
    let resolveFirst!: (view: { value?: unknown; revision?: number }) => void
    const firstUpdate = new Promise<{ value?: unknown; revision?: number }>((resolve) => {
      resolveFirst = resolve
    })

    vi.spyOn(api, 'settingsGet').mockResolvedValue({ value: prefs, revision: 1 })
    vi.spyOn(api, 'settingsUpdate').mockImplementation((patch, expectedRevision) => {
      updates.push({ patch, expectedRevision })
      if (updates.length === 1) return firstUpdate
      return Promise.resolve({ value: { ...prefs, ...patch }, revision: 3 })
    })

    const rendered = mount(createElement(
      SideCardSection,
      { store, service } as unknown as SideCardSectionProps,
    ))
    try {
      await flushAsyncWork()
      const recorders = (): HTMLButtonElement[] => [
        ...rendered.container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'),
      ]

      act(() => { recorders()[0]!.click() })
      pressKey(recorders()[0]!, { key: 'k', code: 'KeyK', ctrlKey: true })
      await flushAsyncWork()
      expect(updates).toEqual([{
        patch: { shortcuts: { toggleSidebar: 'Ctrl+K' } },
        expectedRevision: 1,
      }])

      // The first route call is still unresolved. A second row edit queues but
      // must not compute its map from the store's still-old shortcuts value.
      act(() => { recorders()[1]!.click() })
      pressKey(recorders()[1]!, { key: 'l', code: 'KeyL', ctrlKey: true })
      await flushAsyncWork()
      expect(updates).toHaveLength(1)

      resolveFirst({
        value: { ...prefs, shortcuts: { toggleSidebar: 'Ctrl+K' } },
        revision: 2,
      })
      await flushAsyncWork()

      expect(updates).toEqual([{
        patch: { shortcuts: { toggleSidebar: 'Ctrl+K' } },
        expectedRevision: 1,
      }, {
        patch: {
          shortcuts: {
            toggleSidebar: 'Ctrl+K',
            saveEditor: 'Ctrl+L',
          },
        },
        expectedRevision: 2,
      }])
      expect(store.getPrefs().shortcuts).toEqual({
        toggleSidebar: 'Ctrl+K',
        saveEditor: 'Ctrl+L',
      })
    } finally {
      rendered.unmount()
    }
  })

  it('rolls the rows back to the store when two queued shortcut writes fail', async () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    const first = deferred<{ value?: unknown; revision?: number }>()
    const second = deferred<{ value?: unknown; revision?: number }>()
    const updates: Array<{ patch: Record<string, unknown>; expectedRevision?: number }> = []

    vi.spyOn(api, 'settingsGet').mockResolvedValue({ value: prefs, revision: 1 })
    vi.spyOn(api, 'settingsUpdate').mockImplementation((patch, expectedRevision) => {
      updates.push({ patch, expectedRevision })
      return updates.length === 1 ? first.promise : second.promise
    })

    const rendered = mount(createElement(
      SideCardSection,
      { store, service } as unknown as SideCardSectionProps,
    ))
    try {
      await flushAsyncWork()
      const recorders = (): HTMLButtonElement[] => [
        ...rendered.container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'),
      ]
      const initialLabels = recorders().map(button => button.textContent)

      act(() => { recorders()[0]!.click() })
      pressKey(recorders()[0]!, { key: 'k', code: 'KeyK', ctrlKey: true })
      await flushAsyncWork()
      act(() => { recorders()[1]!.click() })
      pressKey(recorders()[1]!, { key: 'l', code: 'KeyL', ctrlKey: true })
      await flushAsyncWork()

      first.reject(new Error('first failed'))
      await flushAsyncWork()
      expect(updates[1]).toEqual({
        patch: { shortcuts: { saveEditor: 'Ctrl+L' } },
        expectedRevision: 1,
      })

      second.reject(new Error('second failed'))
      await flushAsyncWork()
      expect(store.getPrefs().shortcuts).toEqual({})
      expect(recorders().map(button => button.textContent)).toEqual(initialLabels)
    } finally {
      rendered.unmount()
    }
  })

  it('omits a failed first edit when the queued second shortcut write succeeds', async () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    const first = deferred<{ value?: unknown; revision?: number }>()
    const updates: Array<{ patch: Record<string, unknown>; expectedRevision?: number }> = []

    vi.spyOn(api, 'settingsGet').mockResolvedValue({ value: prefs, revision: 1 })
    vi.spyOn(api, 'settingsUpdate').mockImplementation((patch, expectedRevision) => {
      updates.push({ patch, expectedRevision })
      if (updates.length === 1) return first.promise
      return Promise.resolve({ value: { ...prefs, ...patch }, revision: 2 })
    })

    const rendered = mount(createElement(
      SideCardSection,
      { store, service } as unknown as SideCardSectionProps,
    ))
    try {
      await flushAsyncWork()
      const recorders = (): HTMLButtonElement[] => [
        ...rendered.container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'),
      ]
      const initialToggleLabel = recorders()[0]!.textContent

      act(() => { recorders()[0]!.click() })
      pressKey(recorders()[0]!, { key: 'k', code: 'KeyK', ctrlKey: true })
      await flushAsyncWork()
      act(() => { recorders()[1]!.click() })
      pressKey(recorders()[1]!, { key: 'l', code: 'KeyL', ctrlKey: true })
      await flushAsyncWork()

      first.reject(new Error('first failed'))
      await flushAsyncWork()

      expect(updates[1]).toEqual({
        patch: { shortcuts: { saveEditor: 'Ctrl+L' } },
        expectedRevision: 1,
      })
      expect(store.getPrefs().shortcuts).toEqual({ saveEditor: 'Ctrl+L' })
      expect(recorders()[0]!.textContent).toBe(initialToggleLabel)
      expect(recorders()[1]!.textContent).toContain('Ctrl+L')
    } finally {
      rendered.unmount()
    }
  })

  it('preserves a newer mount refresh when the next shortcut write fails', async () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    const refreshed = { ...prefs, shortcuts: { toggleSidebar: 'Ctrl+K' } }
    const updates: Array<{ patch: Record<string, unknown>; expectedRevision?: number }> = []

    vi.spyOn(api, 'settingsGet').mockResolvedValue({ value: refreshed, revision: 4 })
    vi.spyOn(api, 'settingsUpdate').mockImplementation((patch, expectedRevision) => {
      updates.push({ patch, expectedRevision })
      return Promise.reject(new Error('write failed'))
    })

    const rendered = mount(createElement(
      SideCardSection,
      { store, service } as unknown as SideCardSectionProps,
    ))
    try {
      await flushAsyncWork()
      const recorders = (): HTMLButtonElement[] => [
        ...rendered.container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'),
      ]
      const initialSaveLabel = recorders()[1]!.textContent
      expect(recorders()[0]!.textContent).toContain('Ctrl+K')
      expect(store.getPrefs().shortcuts).toEqual({ toggleSidebar: 'Ctrl+K' })

      act(() => { recorders()[1]!.click() })
      pressKey(recorders()[1]!, { key: 'l', code: 'KeyL', ctrlKey: true })
      await flushAsyncWork()

      expect(updates).toEqual([{
        patch: {
          shortcuts: {
            toggleSidebar: 'Ctrl+K',
            saveEditor: 'Ctrl+L',
          },
        },
        expectedRevision: 4,
      }])
      expect(store.getPrefs().shortcuts).toEqual({ toggleSidebar: 'Ctrl+K' })
      expect(recorders()[0]!.textContent).toContain('Ctrl+K')
      expect(recorders()[1]!.textContent).toBe(initialSaveLabel)
    } finally {
      rendered.unmount()
    }
  })
})
