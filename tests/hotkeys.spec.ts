// @vitest-environment jsdom
/**
 * Panel-toggle hotkey tests (⌘B / ⌘J / ⌘⇧J / ⌘⌥B, VSCode-style).
 *
 * Two layers:
 *
 * 1. the PURE decision (`matchPanelHotkey`) — which modifier/key combos
 *    toggle which panel, and every guard (key repeat, IME composition,
 *    AltGraph, shift, wrong modifiers);
 * 2. the NATIVE path (`registerPanelHotkeys`) — a document-capture keydown
 *    toggles the store (or calls the host sidebar toggle) through real
 *    KeyboardEvents, a matched combo is fully consumed (preventDefault +
 *    stopPropagation: a document-bubble listener never sees it), the
 *    disposer restores normal flow (HMR-safe), and the bottom toggles are
 *    no-ops on narrow viewports (the bottom panel does not exist there —
 *    matching the hidden toggle button).
 *
 * Events are dispatched on a deep element (an `<input>` in document.body)
 * like the browser does, so capture-phase blocking behaves like in
 * production. Matching is by `event.code` (physical key) so the US-layout
 * Option+B quirk ("∫") and non-Latin layouts cannot break the bindings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  matchPanelHotkey,
  registerPanelHotkeys,
  type HotkeyEventLike,
} from '../src/client/hotkeys.ts'
import { createSidebarStore, type SidebarStore } from '../src/client/state.ts'

/** A bare event-like object for the pure matcher (no DOM needed). */
function like(overrides: Partial<HotkeyEventLike>): HotkeyEventLike {
  return {
    code: 'KeyJ',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 0,
    ...overrides,
  }
}

/** Build a real KeyboardEvent; jsdom lacks isComposing/keyCode, so pin them via defineProperty. */
function keyEvent(init: {
  key: string
  code: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  repeat?: boolean
  isComposing?: boolean
  keyCode?: number
}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: init.key,
    code: init.code,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    repeat: init.repeat ?? false,
    bubbles: true,
    cancelable: true,
  })
  if (init.isComposing !== undefined) {
    Object.defineProperty(event, 'isComposing', { value: init.isComposing })
  }
  if (init.keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  }
  return event
}

describe('matchPanelHotkey — the pure decision', () => {
  it('⌘J toggles the bottom panel', () => {
    expect(matchPanelHotkey(like({ code: 'KeyJ', metaKey: true }))).toBe('bottom')
  })

  it('Ctrl+J toggles the bottom panel (Windows/Linux equivalent)', () => {
    expect(matchPanelHotkey(like({ code: 'KeyJ', ctrlKey: true }))).toBe('bottom')
  })

  it('⌘B toggles the host LEFT sidebar', () => {
    expect(matchPanelHotkey(like({ code: 'KeyB', metaKey: true }))).toBe('left')
  })

  it('Ctrl+B toggles the host LEFT sidebar (Windows/Linux equivalent)', () => {
    expect(matchPanelHotkey(like({ code: 'KeyB', ctrlKey: true }))).toBe('left')
  })

  it('⌘⌥B toggles the right panel', () => {
    expect(matchPanelHotkey(like({ code: 'KeyB', metaKey: true, altKey: true }))).toBe('right')
  })

  it('Ctrl+Alt+B toggles the right panel (Windows/Linux equivalent)', () => {
    expect(matchPanelHotkey(like({ code: 'KeyB', ctrlKey: true, altKey: true }))).toBe('right')
  })

  it('matches by physical code — the matcher reads only `code`, never the layout-dependent `key` value', () => {
    // HotkeyEventLike carries no `key` at all: matching CANNOT be thrown off
    // by the US-layout Option+B "∫" or by non-Latin key values.
    expect(matchPanelHotkey(like({ code: 'KeyB', metaKey: true, altKey: true }))).toBe('right')
  })

  it('rejects bare keys without a command modifier', () => {
    expect(matchPanelHotkey(like({ code: 'KeyJ' }))).toBeNull()
    expect(matchPanelHotkey(like({ code: 'KeyB', altKey: true }))).toBeNull()
  })

  it('rejects ⌥J and ⌘⌥J (only B pairs with Option)', () => {
    expect(matchPanelHotkey(like({ code: 'KeyJ', altKey: true, metaKey: true }))).toBeNull()
    expect(matchPanelHotkey(like({ code: 'KeyJ', altKey: true }))).toBeNull()
  })

  it('rejects other keys under the same modifiers', () => {
    expect(matchPanelHotkey(like({ code: 'KeyK', metaKey: true }))).toBeNull()
    expect(matchPanelHotkey(like({ code: 'KeyK', metaKey: true, altKey: true }))).toBeNull()
    expect(matchPanelHotkey(like({ code: 'KeyK', metaKey: true, shiftKey: true }))).toBeNull()
  })

  it('⌘⇧J maximizes the bottom panel (the ONLY shift binding)', () => {
    expect(matchPanelHotkey(like({ code: 'KeyJ', metaKey: true, shiftKey: true }))).toBe('maximize')
    expect(matchPanelHotkey(like({ code: 'KeyJ', ctrlKey: true, shiftKey: true }))).toBe('maximize')
  })

  it('rejects every other shift-modified combo (exact modifier sets only)', () => {
    expect(matchPanelHotkey(like({ code: 'KeyJ', metaKey: true, altKey: true, shiftKey: true }))).toBeNull()
    expect(matchPanelHotkey(like({ code: 'KeyB', metaKey: true, shiftKey: true }))).toBeNull()
    expect(matchPanelHotkey(like({ code: 'KeyB', metaKey: true, altKey: true, shiftKey: true }))).toBeNull()
    // ⌘⇧J without the command modifier is not a binding either.
    expect(matchPanelHotkey(like({ code: 'KeyJ', shiftKey: true }))).toBeNull()
  })

  it('ignores auto-repeat: a held combo toggles once', () => {
    expect(matchPanelHotkey(like({ code: 'KeyJ', metaKey: true, repeat: true }))).toBeNull()
    expect(matchPanelHotkey(like({ code: 'KeyJ', metaKey: true, shiftKey: true, repeat: true }))).toBeNull()
    expect(matchPanelHotkey(like({ code: 'KeyB', metaKey: true, altKey: true, repeat: true }))).toBeNull()
  })

  it('ignores IME composition (isComposing and the legacy keyCode 229 signal)', () => {
    expect(matchPanelHotkey(like({ code: 'KeyJ', metaKey: true, isComposing: true }))).toBeNull()
    expect(matchPanelHotkey(like({ code: 'KeyJ', metaKey: true, keyCode: 229 }))).toBeNull()
    expect(matchPanelHotkey(like({ code: 'KeyJ', metaKey: true, shiftKey: true, isComposing: true }))).toBeNull()
  })

  it('ignores AltGr chords (Windows AltGr reports ctrlKey+altKey)', () => {
    const altGraph = like({
      code: 'KeyB',
      ctrlKey: true,
      altKey: true,
      getModifierState: (name) => name === 'AltGraph',
    })
    expect(matchPanelHotkey(altGraph)).toBeNull()
  })

  it('treats a missing getModifierState as no AltGraph (exotic engines)', () => {
    expect(matchPanelHotkey(like({ code: 'KeyB', ctrlKey: true, altKey: true }))).toBe('right')
  })
})

describe('registerPanelHotkeys — the native path', () => {
  let store: SidebarStore
  let input: HTMLInputElement
  let dispose: (() => void) | undefined
  let leftSpy: ReturnType<typeof vi.fn<() => void>>
  const seen: string[] = []

  const onDocumentBubble = (event: Event): void => {
    seen.push(`document:${event.type}`)
  }

  beforeEach(() => {
    store = createSidebarStore()
    // Fresh-session seed: right panel OPEN by default, bottom panel closed.
    store.setSession('s1')
    leftSpy = vi.fn<() => void>()
    input = document.createElement('input')
    document.body.appendChild(input)
    seen.length = 0
    document.addEventListener('keydown', onDocumentBubble)
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
    document.removeEventListener('keydown', onDocumentBubble)
    input.remove()
    document.body.innerHTML = ''
  })

  it('⌘J toggles the bottom panel and consumes the event', () => {
    dispose = registerPanelHotkeys(store, leftSpy)
    expect(store.getSnapshot().state?.bottomOpen).toBe(false)

    input.dispatchEvent(keyEvent({ key: 'j', code: 'KeyJ', metaKey: true }))

    expect(store.getSnapshot().state?.bottomOpen).toBe(true)
    expect(leftSpy).not.toHaveBeenCalled()
    // Consumed at the document capture phase: neither the input target nor
    // the document bubble phase ever sees the event.
    expect(seen).toEqual([])
  })

  it('⌘B calls the host sidebar toggle, consumes the event, and leaves the store alone', () => {
    dispose = registerPanelHotkeys(store, leftSpy)
    const panelOpenBefore = store.getSnapshot().state?.panelOpen

    input.dispatchEvent(keyEvent({ key: 'b', code: 'KeyB', metaKey: true }))

    expect(leftSpy).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().state?.panelOpen).toBe(panelOpenBefore)
    expect(store.getSnapshot().state?.bottomOpen).toBe(false)
    expect(seen).toEqual([])
  })

  it('⌘B still toggles the host sidebar without a current session (host-side transition)', () => {
    dispose = registerPanelHotkeys(store, leftSpy)
    store.setSession(undefined)

    input.dispatchEvent(keyEvent({ key: 'b', code: 'KeyB', metaKey: true }))

    expect(leftSpy).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().state).toBeUndefined()
  })

  it('⌘⌥B toggles the right panel and consumes the event', () => {
    dispose = registerPanelHotkeys(store, leftSpy)
    expect(store.getSnapshot().state?.panelOpen).toBe(true)

    input.dispatchEvent(keyEvent({ key: 'b', code: 'KeyB', metaKey: true, altKey: true }))

    expect(store.getSnapshot().state?.panelOpen).toBe(false)
    expect(leftSpy).not.toHaveBeenCalled()
    expect(seen).toEqual([])
  })

  it('⌘⇧J opens a closed bottom panel MAXIMIZED and consumes the event', () => {
    dispose = registerPanelHotkeys(store, leftSpy)
    expect(store.getSnapshot().state?.bottomOpen).toBe(false)
    expect(store.getSnapshot().state?.bottomMaximized).toBe(false)

    input.dispatchEvent(keyEvent({ key: 'J', code: 'KeyJ', metaKey: true, shiftKey: true }))

    const state = store.getSnapshot().state!
    expect(state.bottomOpen).toBe(true)
    expect(state.bottomMaximized).toBe(true)
    expect(leftSpy).not.toHaveBeenCalled()
    expect(seen).toEqual([])
  })

  it('⌘⇧J again restores the drag height (the panel stays open)', () => {
    dispose = registerPanelHotkeys(store, leftSpy)
    input.dispatchEvent(keyEvent({ key: 'J', code: 'KeyJ', metaKey: true, shiftKey: true }))
    input.dispatchEvent(keyEvent({ key: 'J', code: 'KeyJ', metaKey: true, shiftKey: true }))
    const state = store.getSnapshot().state!
    expect(state.bottomOpen).toBe(true)
    expect(state.bottomMaximized).toBe(false)
  })

  it('⌘⇧B / ⌘⌥⇧B pass through untouched', () => {
    dispose = registerPanelHotkeys(store, leftSpy)
    input.dispatchEvent(keyEvent({ key: 'B', code: 'KeyB', metaKey: true, shiftKey: true }))
    input.dispatchEvent(keyEvent({ key: 'B', code: 'KeyB', metaKey: true, altKey: true, shiftKey: true }))
    expect(seen).toEqual(['document:keydown', 'document:keydown'])
    expect(leftSpy).not.toHaveBeenCalled()
  })

  it('each panel toggles independently (⌘J then ⌘⌥B leaves both flipped)', () => {
    dispose = registerPanelHotkeys(store, leftSpy)
    input.dispatchEvent(keyEvent({ key: 'j', code: 'KeyJ', metaKey: true }))
    input.dispatchEvent(keyEvent({ key: 'b', code: 'KeyB', metaKey: true, altKey: true }))
    const state = store.getSnapshot().state!
    expect(state.bottomOpen).toBe(true)
    expect(state.panelOpen).toBe(false)
  })

  it('unmatched keys pass through untouched', () => {
    dispose = registerPanelHotkeys(store, leftSpy)
    input.dispatchEvent(keyEvent({ key: 'k', code: 'KeyK', metaKey: true }))
    input.dispatchEvent(keyEvent({ key: 'j', code: 'KeyJ' }))
    expect(seen).toEqual(['document:keydown', 'document:keydown'])
    expect(store.getSnapshot().state?.bottomOpen).toBe(false)
  })

  it('is a strict no-op without a current session', () => {
    dispose = registerPanelHotkeys(store, leftSpy)
    store.setSession(undefined)
    input.dispatchEvent(keyEvent({ key: 'j', code: 'KeyJ', metaKey: true }))
    expect(store.getSnapshot().state).toBeUndefined()
  })

  it('bottom toggles are no-ops on narrow viewports (no bottom panel there)', () => {
    dispose = registerPanelHotkeys(store, leftSpy)
    Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true })
    input.dispatchEvent(keyEvent({ key: 'j', code: 'KeyJ', metaKey: true }))
    expect(store.getSnapshot().state?.bottomOpen).toBe(false)
    input.dispatchEvent(keyEvent({ key: 'J', code: 'KeyJ', metaKey: true, shiftKey: true }))
    expect(store.getSnapshot().state?.bottomMaximized).toBe(false)
    // The right toggle still works on narrow (the drawer exists).
    input.dispatchEvent(keyEvent({ key: 'b', code: 'KeyB', metaKey: true, altKey: true }))
    expect(store.getSnapshot().state?.panelOpen).toBe(false)
  })

  it('disposer restores normal flow (HMR-safe)', () => {
    dispose = registerPanelHotkeys(store, leftSpy)
    dispose()
    dispose = undefined
    input.dispatchEvent(keyEvent({ key: 'j', code: 'KeyJ', metaKey: true }))
    expect(seen).toEqual(['document:keydown'])
    expect(store.getSnapshot().state?.bottomOpen).toBe(false)
  })
})
