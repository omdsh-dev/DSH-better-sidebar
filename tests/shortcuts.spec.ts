/**
 * Shortcut combo vocabulary spec: the pure parse/normalize/match/label
 * helpers behind the panel-toggle shortcuts, plus the prefs-document
 * integration (parsePrefs must normalize the two shortcut fields to the
 * canonical form and fall back safely). Pure functions — no DOM needed,
 * though navigator is stubbed where isMacPlatform reads it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  comboFromEvent,
  isMacPlatform,
  matchesShortcut,
  normalizeShortcut,
  parseShortcut,
  shortcutLabel,
  type ShortcutEventLike,
} from '../src/client/shortcut-combo.ts'
import { parsePrefs } from '../src/client/prefs.ts'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'

/** A keydown event face for one chord. */
function key(key: string, mods: Partial<Record<'ctrl' | 'meta' | 'alt' | 'shift', boolean>> = {}): ShortcutEventLike {
  return {
    key,
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
  }
}

/** Stub (or clear) the platform navigator the module reads. */
function stubNavigator(platform: string | undefined): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: platform === undefined ? undefined : { platform, userAgent: '' },
    configurable: true,
  })
}

afterEach(() => { stubNavigator(undefined) })

describe('parseShortcut / normalizeShortcut', () => {
  it('parses the canonical defaults', () => {
    expect(parseShortcut('mod+b')).toEqual({ mod: true, meta: false, ctrl: false, alt: false, shift: false, key: 'b' })
    expect(parseShortcut('mod+t')).toEqual({ mod: true, meta: false, ctrl: false, alt: false, shift: false, key: 't' })
  })

  it('canonicalizes aliases, case, and spacing', () => {
    expect(normalizeShortcut('Cmd+B')).toBe('meta+b')
    expect(normalizeShortcut('CTRL + SHIFT + P')).toBe('ctrl+shift+p')
    expect(normalizeShortcut('Option+Shift+Escape')).toBe('alt+shift+escape')
    expect(normalizeShortcut('mod+alt+f12')).toBe('mod+alt+f12')
    expect(normalizeShortcut('ctrl+Space')).toBe('ctrl+space')
  })

  it('absorbs contradictory mod+ctrl/meta into mod', () => {
    expect(normalizeShortcut('mod+ctrl+b')).toBe('mod+b')
    expect(normalizeShortcut('ctrl+mod+b')).toBe('mod+b')
  })

  it('rejects invalid combos as disabled', () => {
    expect(normalizeShortcut('')).toBe('')
    expect(normalizeShortcut('b')).toBe('') // bare key would hijack typing
    expect(normalizeShortcut('shift+b')).toBe('') // shift-only is still typing
    expect(normalizeShortcut('mod')).toBe('') // modifiers only
    expect(normalizeShortcut('mod+b+c')).toBe('') // two keys
    expect(normalizeShortcut('mod+arrowup')).toBe('') // unsupported key
    expect(normalizeShortcut('mod++b')).toBe('') // empty token
    expect(parseShortcut('mod+b')).not.toBeNull()
    expect(parseShortcut('nonsense')).toBeNull()
  })
})

describe('matchesShortcut', () => {
  it('matches mod via Cmd on macOS and Ctrl elsewhere', () => {
    const mac = key('b', { meta: true })
    const win = key('b', { ctrl: true })
    expect(matchesShortcut('mod+b', mac, true)).toBe(true)
    expect(matchesShortcut('mod+b', key('b', { ctrl: true }), true)).toBe(false)
    expect(matchesShortcut('mod+b', win, false)).toBe(true)
    expect(matchesShortcut('mod+b', key('b', { meta: true }), false)).toBe(false)
  })

  it('matches pinned meta/ctrl across platforms', () => {
    expect(matchesShortcut('meta+b', key('b', { meta: true }), false)).toBe(true)
    expect(matchesShortcut('ctrl+b', key('b', { ctrl: true }), true)).toBe(true)
  })

  it('never fires on extra modifiers (exact chord match)', () => {
    expect(matchesShortcut('mod+b', key('b', { meta: true, alt: true }), true)).toBe(false)
    expect(matchesShortcut('mod+b', key('b', { meta: true, shift: true }), true)).toBe(false)
    expect(matchesShortcut('ctrl+alt+x', key('x', { ctrl: true }), false)).toBe(false)
    expect(matchesShortcut('mod+b', key('b', { meta: true, ctrl: true }), true)).toBe(false)
  })

  it('matches named and shifted keys case-insensitively', () => {
    expect(matchesShortcut('mod+shift+b', key('B', { meta: true, shift: true }), true)).toBe(true)
    expect(matchesShortcut('mod+escape', key('Escape', { ctrl: true }), false)).toBe(true)
    expect(matchesShortcut('ctrl+space', key(' ', { ctrl: true }), false)).toBe(true)
    expect(matchesShortcut('mod+f1', key('F1', { meta: true }), true)).toBe(true)
  })

  it('a disabled (empty) combo never matches', () => {
    expect(matchesShortcut('', key('b', { meta: true }), true)).toBe(false)
    expect(matchesShortcut('bogus', key('b', { meta: true }), true)).toBe(false)
  })

  it('never matches modifier-only presses', () => {
    expect(matchesShortcut('mod+b', key('Meta', { meta: true }), true)).toBe(false)
  })
})

describe('comboFromEvent (the capture recorder)', () => {
  it('records the canonical combo', () => {
    expect(comboFromEvent(key('b', { meta: true }), true)).toBe('mod+b')
    expect(comboFromEvent(key('b', { ctrl: true }), false)).toBe('mod+b')
    expect(comboFromEvent(key('B', { meta: true, shift: true }), true)).toBe('mod+shift+b')
    // The platform primary maps to 'mod' regardless of which raw modifier.
    expect(comboFromEvent(key('Escape', { ctrl: true, alt: true }), false)).toBe('mod+alt+escape')
  })

  it('refuses bare keys and lone modifiers', () => {
    expect(comboFromEvent(key('b'), true)).toBe('')
    expect(comboFromEvent(key('b', { shift: true }), true)).toBe('')
    expect(comboFromEvent(key('Meta', { meta: true }), true)).toBe('')
    expect(comboFromEvent(key('Shift', { shift: true }), true)).toBe('')
  })
})

describe('shortcutLabel', () => {
  it('renders platform-aware labels', () => {
    expect(shortcutLabel('mod+b', true)).toBe('⌘B')
    expect(shortcutLabel('mod+b', false)).toBe('Ctrl+B')
    expect(shortcutLabel('ctrl+shift+p', true)).toBe('⌃⇧P')
    expect(shortcutLabel('ctrl+shift+p', false)).toBe('Ctrl+Shift+P')
    expect(shortcutLabel('mod+alt+f12', true)).toBe('⌘⌥F12')
  })

  it('renders empty for disabled combos', () => {
    expect(shortcutLabel('', true)).toBe('')
    expect(shortcutLabel('bogus', false)).toBe('')
  })
})

describe('isMacPlatform', () => {
  it('detects macOS from navigator.platform', () => {
    stubNavigator('MacIntel')
    expect(isMacPlatform()).toBe(true)
    stubNavigator('Win32')
    expect(isMacPlatform()).toBe(false)
    stubNavigator(undefined)
    expect(isMacPlatform()).toBe(false)
  })
})

describe('parsePrefs shortcut fields', () => {
  it('falls back to the defaults when absent or malformed', () => {
    expect(parsePrefs(undefined).shortcutPanel).toBe(SIDEBAR_PREFS_DEFAULTS.shortcutPanel)
    expect(parsePrefs({}).shortcutTerminal).toBe(SIDEBAR_PREFS_DEFAULTS.shortcutTerminal)
    expect(parsePrefs({ shortcutPanel: 42 }).shortcutPanel).toBe(SIDEBAR_PREFS_DEFAULTS.shortcutPanel)
  })

  it('normalizes present strings to the canonical form', () => {
    expect(parsePrefs({ shortcutPanel: 'Cmd+B' }).shortcutPanel).toBe('meta+b')
    expect(parsePrefs({ shortcutTerminal: 'CTRL + SHIFT + T' }).shortcutTerminal).toBe('ctrl+shift+t')
  })

  it('reads malformed strings as disabled (never armed while typing)', () => {
    expect(parsePrefs({ shortcutPanel: 'b' }).shortcutPanel).toBe('')
    expect(parsePrefs({ shortcutTerminal: 'mod' }).shortcutTerminal).toBe('')
    expect(parsePrefs({ shortcutPanel: '' }).shortcutPanel).toBe('')
  })
})
