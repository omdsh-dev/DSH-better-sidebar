// @vitest-environment jsdom
/**
 * Keyboard-shortcut spec: the chord vocabulary (parse/canonical/display/
 * match/CodeMirror mapping) and the document-level sidebar toggle listener
 * (session gating, terminal protection, defaultPrevented/IME yield, disposer).
 *
 * The listener is exercised with real KeyboardEvents on a deep element
 * exactly like the browser (bubbling to the document listener), mirroring the
 * ime-guard spec's dispatch style.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view'
import {
  canonicalChord,
  captureShortcutEvent,
  chordMatchesEvent,
  chordOf,
  chordToCodeMirrorKey,
  displayChord,
  isMacPlatform,
  parseChord,
  registerSidebarToggleShortcut,
} from '../src/client/shortcuts.ts'
import { createSidebarStore } from '../src/client/state.ts'

/** Build a KeyboardEvent the way jsdom allows (isComposing via defineProperty). */
function keyEvent(
  init: { key: string; code?: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; isComposing?: boolean; keyCode?: number; bubbles?: boolean },
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: init.key,
    code: init.code,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
    bubbles: init.bubbles ?? true,
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

describe('parseChord', () => {
  it('accepts the canonical defaults', () => {
    expect(parseChord('Mod+B')).toMatchObject({ mod: true, ctrl: false, cmd: false, shift: false, alt: false, key: 'b' })
    expect(parseChord('Mod+S')?.key).toBe('s')
    expect(parseChord('Mod+Enter')?.key).toBe('enter')
  })

  it('is case/space/alias tolerant on modifiers', () => {
    expect(parseChord('ctrl+b')).toMatchObject({ ctrl: true, key: 'b' })
    expect(parseChord('Cmd+Shift+Alt+Control+x')).toMatchObject({ cmd: true, shift: true, alt: true, ctrl: true, key: 'x' })
    expect(parseChord('Mod + B')).toMatchObject({ mod: true, key: 'b' })
    expect(parseChord('Control+b')?.ctrl).toBe(true)
    expect(parseChord('Command+b')?.cmd).toBe(true)
    expect(parseChord('Meta+b')?.cmd).toBe(true)
    expect(parseChord('Option+b')?.alt).toBe(true)
  })

  it('accepts named keys and function keys', () => {
    expect(parseChord('Ctrl+Space')?.key).toBe('space')
    expect(parseChord('Ctrl+Esc')?.key).toBe('escape')
    expect(parseChord('Ctrl+Del')?.key).toBe('delete')
    expect(parseChord('Ctrl+PageUp')?.key).toBe('pageup')
    expect(parseChord('Ctrl+F1')?.key).toBe('f1')
    expect(parseChord('Ctrl+ArrowLeft')?.key).toBe('arrowleft')
    expect(parseChord('Ctrl+0')?.key).toBe('0')
  })

  it('rejects chords without a modifier', () => {
    expect(parseChord('b')).toBeNull()
    expect(parseChord('Enter')).toBeNull()
    expect(parseChord('F1')).toBeNull()
  })

  it('rejects Shift-only chords that would hijack ordinary typing and navigation', () => {
    expect(parseChord('Shift+B')).toBeNull()
    expect(parseChord('Shift+Enter')).toBeNull()
    expect(parseChord('Shift+ArrowLeft')).toBeNull()
    expect(parseChord('Ctrl+Shift+B')).not.toBeNull()
    expect(parseChord('Alt+Shift+Enter')).not.toBeNull()
  })

  it('rejects Mod combined with an explicit Ctrl/Cmd (platform-divergent semantics)', () => {
    expect(parseChord('Mod+Ctrl+B')).toBeNull()
    expect(parseChord('Mod+Cmd+B')).toBeNull()
    expect(parseChord('Mod+Shift+B')).not.toBeNull()
  })

  it('rejects malformed chords', () => {
    expect(parseChord('')).toBeNull()
    expect(parseChord('Ctrl')).toBeNull()
    expect(parseChord('Ctrl+')).toBeNull()
    expect(parseChord('Ctrl++B')).toBeNull()
    expect(parseChord('Ctrl+?')).toBeNull()
    expect(parseChord('Ctrl+Enter+Shift')).toBeNull()
    expect(parseChord('Frobnicate+B')).toBeNull()
    expect(parseChord('Shift+Ctrl+Enter')).toMatchObject({ shift: true, ctrl: true, key: 'enter' })
  })
})

describe('canonicalChord / displayChord', () => {
  it('canonicalizes casing and named-key aliases', () => {
    expect(canonicalChord('ctrl+b')).toBe('Ctrl+B')
    expect(canonicalChord('mod + shift + s')).toBe('Mod+Shift+S')
    expect(canonicalChord('Mod+esc')).toBe('Mod+Escape')
    expect(canonicalChord('Ctrl+Del')).toBe('Ctrl+Delete')
    expect(canonicalChord('b')).toBeNull()
  })

  it('is idempotent on already-canonical chords', () => {
    expect(canonicalChord(canonicalChord('ctrl+b')!)).toBe('Ctrl+B')
    expect(canonicalChord(canonicalChord('Mod+Shift+Enter')!)).toBe('Mod+Shift+Enter')
  })

  it('resolves Mod per platform for display', () => {
    expect(displayChord('Mod+B', false)).toBe('Ctrl+B')
    expect(displayChord('Mod+B', true)).toBe('Cmd+B')
    expect(displayChord('Ctrl+B', true)).toBe('Ctrl+B')
    expect(displayChord('garbage', false)).toBe('garbage')
  })
})

describe('captureShortcutEvent', () => {
  const capture = (init: Parameters<typeof keyEvent>[0]) => captureShortcutEvent(keyEvent(init))

  it('records the exact modifiers and canonical key the user pressed', () => {
    expect(capture({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true }))
      .toEqual({ kind: 'complete', chord: 'Ctrl+Shift+K' })
    expect(capture({ key: 'Enter', code: 'Enter', metaKey: true, altKey: true }))
      .toEqual({ kind: 'complete', chord: 'Cmd+Alt+Enter' })
  })

  it('normalizes shifted digits, named keys, and legacy key names', () => {
    expect(capture({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }))
      .toEqual({ kind: 'complete', chord: 'Ctrl+Shift+1' })
    expect(capture({ key: ' ', code: 'Space', ctrlKey: true }))
      .toEqual({ kind: 'complete', chord: 'Ctrl+Space' })
    expect(capture({ key: 'Left', code: 'ArrowLeft', ctrlKey: true }))
      .toEqual({ kind: 'complete', chord: 'Ctrl+ArrowLeft' })
  })

  it('returns a live modifier preview without completing the recording', () => {
    expect(capture({ key: 'Control', code: 'ControlLeft', ctrlKey: true }))
      .toEqual({ kind: 'modifier', preview: 'Ctrl+' })
    expect(capture({ key: 'Shift', code: 'ShiftLeft', ctrlKey: true, shiftKey: true }))
      .toEqual({ kind: 'modifier', preview: 'Ctrl+Shift+' })
  })

  it('distinguishes a missing modifier from an unsupported final key', () => {
    expect(capture({ key: 'b', code: 'KeyB' }))
      .toEqual({ kind: 'invalid', reason: 'modifier-required' })
    expect(capture({ key: 'B', code: 'KeyB', shiftKey: true }))
      .toEqual({ kind: 'invalid', reason: 'modifier-required' })
    expect(capture({ key: '?', code: 'Slash', ctrlKey: true }))
      .toEqual({ kind: 'invalid', reason: 'unsupported-key' })
  })

  it('records physical number-row digits independently of the active layout', () => {
    // German Shift+2 emits `"`; the stored chord still names the physical 2.
    expect(capture({ key: '"', code: 'Digit2', ctrlKey: true, shiftKey: true }))
      .toEqual({ kind: 'complete', chord: 'Ctrl+Shift+2' })
  })
})

describe('chordMatchesEvent', () => {
  const ev = (init: Parameters<typeof keyEvent>[0]) => keyEvent(init)

  it('matches the platform primary modifier for Mod', () => {
    expect(chordMatchesEvent('Mod+B', ev({ key: 'b', ctrlKey: true }), false)).toBe(true)
    expect(chordMatchesEvent('Mod+B', ev({ key: 'b', metaKey: true }), true)).toBe(true)
    expect(chordMatchesEvent('Mod+B', ev({ key: 'b', ctrlKey: true }), true)).toBe(false)
    expect(chordMatchesEvent('Mod+B', ev({ key: 'b', metaKey: true }), false)).toBe(false)
  })

  it('requires every declared modifier and forbids extras', () => {
    expect(chordMatchesEvent('Ctrl+Shift+B', ev({ key: 'B', ctrlKey: true, shiftKey: true }), false)).toBe(true)
    expect(chordMatchesEvent('Ctrl+B', ev({ key: 'b', ctrlKey: true, shiftKey: true }), false)).toBe(false)
    expect(chordMatchesEvent('Ctrl+Shift+B', ev({ key: 'b', ctrlKey: true }), false)).toBe(false)
    expect(chordMatchesEvent('Alt+Ctrl+B', ev({ key: 'b', ctrlKey: true, altKey: true }), false)).toBe(true)
  })

  it('matches single-char keys case-insensitively and digits shift-aware', () => {
    expect(chordMatchesEvent('Ctrl+B', ev({ key: 'B', ctrlKey: true }), false)).toBe(true)
    expect(chordMatchesEvent('Ctrl+Shift+1', ev({ key: '!', ctrlKey: true, shiftKey: true }), false)).toBe(true)
    expect(chordMatchesEvent('Ctrl+1', ev({ key: '1', ctrlKey: true }), false)).toBe(true)
    // Caps Lock: 'B' without shift still matches the unshifted chord.
    expect(chordMatchesEvent('Ctrl+B', ev({ key: 'B', ctrlKey: true }), false)).toBe(true)
  })

  it('matches shifted letters with Caps Lock and shifted digits on non-US layouts', () => {
    // Caps Lock reverses the event.key case even though Shift is held.
    expect(chordMatchesEvent('Ctrl+Shift+B', ev({ key: 'b', code: 'KeyB', ctrlKey: true, shiftKey: true }), false)).toBe(true)
    // German Shift+2 emits `"`; event.code preserves the recorded digit.
    expect(chordMatchesEvent('Ctrl+Shift+2', ev({ key: '"', code: 'Digit2', ctrlKey: true, shiftKey: true }), false)).toBe(true)
  })

  it('accepts an unshifted digit on macOS while Meta+Shift are held (WebKit quirk)', () => {
    // macOS reports event.key WITHOUT the shift effect when Meta+Shift are
    // held without Ctrl/Alt (w3c-keyname ignoreKey, WebKit bug 174782).
    expect(chordMatchesEvent('Mod+Shift+B', ev({ key: 'b', metaKey: true, shiftKey: true }), true)).toBe(true)
    expect(chordMatchesEvent('Mod+Shift+1', ev({ key: '1', metaKey: true, shiftKey: true }), true)).toBe(true)
    // Without Meta (and without event.code), digits still use their shifted
    // event.key form; letters are case-insensitive for Caps Lock safety.
    expect(chordMatchesEvent('Ctrl+Shift+1', ev({ key: '1', ctrlKey: true, shiftKey: true }), true)).toBe(false)
    expect(chordMatchesEvent('Ctrl+Shift+1', ev({ key: '!', ctrlKey: true, shiftKey: true }), true)).toBe(true)
    expect(chordMatchesEvent('Ctrl+Shift+B', ev({ key: 'b', ctrlKey: true, shiftKey: true }), true)).toBe(true)
  })

  it('matches legacy-Edge event.key spellings (Esc/Del/Left)', () => {
    expect(chordMatchesEvent('Ctrl+Escape', ev({ key: 'Esc', ctrlKey: true }), false)).toBe(true)
    expect(chordMatchesEvent('Ctrl+Delete', ev({ key: 'Del', ctrlKey: true }), false)).toBe(true)
    expect(chordMatchesEvent('Ctrl+ArrowLeft', ev({ key: 'Left', ctrlKey: true }), false)).toBe(true)
  })

  it('matches named keys', () => {
    expect(chordMatchesEvent('Mod+Enter', ev({ key: 'Enter', metaKey: true }), true)).toBe(true)
    expect(chordMatchesEvent('Ctrl+Space', ev({ key: ' ', ctrlKey: true }), false)).toBe(true)
    expect(chordMatchesEvent('Ctrl+Escape', ev({ key: 'Escape', ctrlKey: true }), false)).toBe(true)
    expect(chordMatchesEvent('Ctrl+ArrowLeft', ev({ key: 'ArrowLeft', ctrlKey: true }), false)).toBe(true)
    expect(chordMatchesEvent('Ctrl+Enter', ev({ key: 'Enter' }), false)).toBe(false)
  })

  it('rejects malformed chords', () => {
    expect(chordMatchesEvent('b', ev({ key: 'b' }), false)).toBe(false)
    expect(chordMatchesEvent('', ev({ key: 'b', ctrlKey: true }), false)).toBe(false)
  })
})

describe('chordToCodeMirrorKey', () => {
  it('maps defaults to CodeMirror key syntax', () => {
    expect(chordToCodeMirrorKey('Mod+B')).toBe('Mod-b')
    expect(chordToCodeMirrorKey('Mod+S')).toBe('Mod-s')
    expect(chordToCodeMirrorKey('Mod+Enter')).toBe('Mod-Enter')
  })

  it('encodes Shift explicitly for character and named keys', () => {
    expect(chordToCodeMirrorKey('Ctrl+Shift+B')).toBe('Ctrl-Shift-b')
    expect(chordToCodeMirrorKey('Shift+Ctrl+1')).toBe('Ctrl-Shift-1')
    expect(chordToCodeMirrorKey('Ctrl+Shift+Enter')).toBe('Ctrl-Shift-Enter')
  })

  it('runs explicit-Shift CodeMirror bindings for Caps Lock and non-US digit keys', () => {
    const seen: string[] = []
    const state = EditorState.create({
      extensions: [keymap.of([{
        key: chordToCodeMirrorKey('Ctrl+Shift+B')!,
        run: () => { seen.push('letter'); return true },
      }, {
        key: chordToCodeMirrorKey('Ctrl+Shift+2')!,
        run: () => { seen.push('digit'); return true },
      }])],
    })
    const view = new EditorView({ state })
    try {
      expect(runScopeHandlers(view, keyEvent({ key: 'b', code: 'KeyB', keyCode: 66, ctrlKey: true, shiftKey: true }), 'editor')).toBe(true)
      expect(runScopeHandlers(view, keyEvent({ key: '"', code: 'Digit2', keyCode: 50, ctrlKey: true, shiftKey: true }), 'editor')).toBe(true)
      expect(seen).toEqual(['letter', 'digit'])
    } finally {
      view.destroy()
    }
  })

  it('maps Cmd/Meta and named keys', () => {
    expect(chordToCodeMirrorKey('Cmd+S')).toBe('Meta-s')
    expect(chordToCodeMirrorKey('Ctrl+Space')).toBe('Ctrl-Space')
    expect(chordToCodeMirrorKey('Ctrl+ArrowLeft')).toBe('Ctrl-ArrowLeft')
    expect(chordToCodeMirrorKey('Mod+PageUp')).toBe('Mod-PageUp')
  })

  it('returns null for malformed chords', () => {
    expect(chordToCodeMirrorKey('b')).toBeNull()
    expect(chordToCodeMirrorKey('')).toBeNull()
  })
})

describe('registerSidebarToggleShortcut', () => {
  let store: ReturnType<typeof createSidebarStore>
  let dispose: (() => void) | undefined

  const bindToggle = (chord: string): void => {
    store.setPrefs({ ...store.getPrefs(), shortcuts: { ...store.getPrefs().shortcuts, toggleSidebar: chord } })
  }

  beforeEach(() => {
    // The store persists per-session layout to localStorage (debounced);
    // clear it so earlier tests can never leak a toggled panel into the next.
    localStorage.clear()
    store = createSidebarStore()
    store.setSession('s1')
    dispose = registerSidebarToggleShortcut(store)
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  it('toggles the panel open/closed on the chord', () => {
    bindToggle('Ctrl+B')
    expect(store.getSnapshot().state?.panelOpen).toBe(true)
    document.body.dispatchEvent(keyEvent({ key: 'b', ctrlKey: true }))
    expect(store.getSnapshot().state?.panelOpen).toBe(false)
    document.body.dispatchEvent(keyEvent({ key: 'b', ctrlKey: true }))
    expect(store.getSnapshot().state?.panelOpen).toBe(true)
  })

  it('defaults to Mod+B when no pref override exists (platform-resolved)', () => {
    expect(chordOf(store, 'toggleSidebar')).toBe('Mod+B')
    // jsdom has no reliable platform signal: dispatch the event for WHICHEVER
    // modifier the platform resolver picked — the default chord must toggle.
    const event = isMacPlatform()
      ? keyEvent({ key: 'b', metaKey: true })
      : keyEvent({ key: 'b', ctrlKey: true })
    document.body.dispatchEvent(event)
    expect(store.getSnapshot().state?.panelOpen).toBe(false)
  })

  it('is a no-op without a session (the shared listener never toggles)', () => {
    // Runs INSIDE the shared describe: this listener must not consume the
    // chord, and the shared one must leave the state alone too (its chord
    // defaults to Mod+B on this platform, so it matches — but the store
    // reduce is gated the same way).
    const fresh = createSidebarStore()
    const off = registerSidebarToggleShortcut(fresh)
    try {
      fresh.setPrefs({ ...fresh.getPrefs(), shortcuts: { toggleSidebar: 'Ctrl+B' } })
      const event = keyEvent({ key: 'b', ctrlKey: true })
      expect(() => {
        document.body.dispatchEvent(event)
      }).not.toThrow()
      expect(fresh.getSnapshot().state).toBeUndefined()
    } finally {
      off()
    }
  })

  it('ignores the chord while focus is inside a terminal (.xterm)', () => {
    bindToggle('Ctrl+B')
    const term = document.createElement('div')
    term.className = 'xterm'
    const input = document.createElement('input')
    term.appendChild(input)
    document.body.appendChild(term)
    try {
      input.dispatchEvent(keyEvent({ key: 'b', ctrlKey: true }))
      expect(store.getSnapshot().state?.panelOpen).toBe(true)
    } finally {
      term.remove()
    }
  })

  it('yields to a handler that already claimed the event (defaultPrevented)', () => {
    bindToggle('Ctrl+B')
    const input = document.createElement('input')
    document.body.appendChild(input)
    const claim = (event: Event): void => { event.preventDefault() }
    input.addEventListener('keydown', claim)
    try {
      input.dispatchEvent(keyEvent({ key: 'b', ctrlKey: true }))
      expect(store.getSnapshot().state?.panelOpen).toBe(true)
    } finally {
      input.removeEventListener('keydown', claim)
      input.remove()
    }
  })

  it('yields during IME composition', () => {
    bindToggle('Ctrl+B')
    const input = document.createElement('input')
    document.body.appendChild(input)
    try {
      input.dispatchEvent(keyEvent({ key: 'b', ctrlKey: true, isComposing: true }))
      expect(store.getSnapshot().state?.panelOpen).toBe(true)
    } finally {
      input.remove()
    }
  })

  it('toggles when the event targets document itself (no Element ancestor)', () => {
    bindToggle('Ctrl+B')
    const event = keyEvent({ key: 'b', ctrlKey: true })
    document.dispatchEvent(event)
    expect(store.getSnapshot().state?.panelOpen).toBe(false)
  })

  it('ignores auto-repeat of a held chord (event.repeat)', () => {
    bindToggle('Ctrl+B')
    const input = document.createElement('input')
    document.body.appendChild(input)
    try {
      const event = keyEvent({ key: 'b', ctrlKey: true })
      Object.defineProperty(event, 'repeat', { value: true })
      input.dispatchEvent(event)
      expect(store.getSnapshot().state?.panelOpen).toBe(true)
    } finally {
      input.remove()
    }
  })

  it('uses the configured chord live (pref override wins over the default)', () => {
    bindToggle('Ctrl+K')
    document.body.dispatchEvent(keyEvent({ key: 'b', ctrlKey: true }))
    expect(store.getSnapshot().state?.panelOpen).toBe(true)
    document.body.dispatchEvent(keyEvent({ key: 'k', ctrlKey: true }))
    expect(store.getSnapshot().state?.panelOpen).toBe(false)
  })

  it('prevents the default action when it handles the chord', () => {
    bindToggle('Ctrl+B')
    const event = keyEvent({ key: 'b', ctrlKey: true })
    document.body.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('disposer stops the listener (HMR-safe)', () => {
    bindToggle('Ctrl+B')
    dispose?.()
    dispose = undefined
    document.body.dispatchEvent(keyEvent({ key: 'b', ctrlKey: true }))
    expect(store.getSnapshot().state?.panelOpen).toBe(true)
  })
})

describe('registerSidebarToggleShortcut — no session (standalone)', () => {
  it('is a no-op and leaves the default action alone', () => {
    // Standalone block: no other document listener may claim the chord (the
    // shared describe's listener would toggle ITS session and preventDefault).
    const fresh = createSidebarStore()
    const off = registerSidebarToggleShortcut(fresh)
    try {
      fresh.setPrefs({ ...fresh.getPrefs(), shortcuts: { toggleSidebar: 'Ctrl+B' } })
      const event = keyEvent({ key: 'b', ctrlKey: true })
      expect(() => {
        document.body.dispatchEvent(event)
      }).not.toThrow()
      expect(fresh.getSnapshot().state).toBeUndefined()
      // The chord was never ours to consume: the default action survives.
      expect(event.defaultPrevented).toBe(false)
    } finally {
      off()
    }
  })
})

describe('chordOf', () => {
  it('falls back to the default chord when the pref is absent', () => {
    const store = createSidebarStore()
    expect(chordOf(store, 'toggleSidebar')).toBe('Mod+B')
    expect(chordOf(store, 'saveEditor')).toBe('Mod+S')
    expect(chordOf(store, 'commitGit')).toBe('Mod+Enter')
  })

  it('prefers the stored chord', () => {
    const store = createSidebarStore()
    store.setPrefs({ ...store.getPrefs(), shortcuts: { toggleSidebar: 'Ctrl+Shift+K' } })
    expect(chordOf(store, 'toggleSidebar')).toBe('Ctrl+Shift+K')
  })
})
