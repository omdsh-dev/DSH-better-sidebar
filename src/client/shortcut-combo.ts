/**
 * Panel-toggle shortcut combo vocabulary: pure parse/match/format helpers
 * for the shortcut strings stored in the Side card prefs (`shortcutPanel` /
 * `shortcutTerminal`). Deliberately import-free and DOM-free at module top
 * level, so the client prefs parser and the host-side consumers can share
 * the grammar without pulling react or the state store in.
 *
 * Combo grammar (canonical form, stored in prefs):
 *   <mod|meta|ctrl>[+alt][+shift]+<key>
 * - `mod` means Cmd on macOS and Ctrl elsewhere; `meta`/`ctrl` pin the exact
 *   modifier. `cmd`/`command` alias `meta`; `control` aliases `ctrl`;
 *   `option` aliases `alt`.
 * - `<key>` is one letter/digit/symbol character, a function key (`f1`–`f24`),
 *   or a named key (`space`, `enter`, `tab`, `escape`, `backspace`, `delete`).
 * - At least one of mod/meta/ctrl/alt is required — a bare key would hijack
 *   typing. An empty string disables the shortcut.
 *
 * Matching is exact on modifiers: a combo never fires on a chord with extra
 * modifiers (`mod+b` does not swallow `ctrl+alt+b`), so user chords keep
 * belonging to whoever bound them.
 */

/** The keyboard-event face the helpers need (unit-test friendly). */
export interface ShortcutEventLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/** One parsed shortcut combo (canonical modifier flags + normalized key). */
export interface ShortcutCombo {
  /** The platform modifier: Cmd on macOS, Ctrl elsewhere. */
  mod: boolean
  /** Explicit meta/Cmd. Mutually exclusive with `ctrl` (see {@link parseShortcut}). */
  meta: boolean
  /** Explicit Ctrl. Mutually exclusive with `meta` (see {@link parseShortcut}). */
  ctrl: boolean
  alt: boolean
  shift: boolean
  /** The non-modifier key, normalized (`'b'`, `'escape'`, `'space'`, `'f1'`, …). */
  key: string
}

/** Modifier-token aliases → canonical modifier. */
const MODIFIER_ALIASES: Record<string, 'mod' | 'meta' | 'ctrl' | 'alt' | 'shift'> = {
  mod: 'mod',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
}

/** Named non-modifier keys → canonical key token (both directions are lowercase input). */
const NAMED_KEYS: Record<string, string> = {
  esc: 'escape',
  escape: 'escape',
  return: 'enter',
  enter: 'enter',
  space: 'space',
  spacebar: 'space',
  tab: 'tab',
  backspace: 'backspace',
  del: 'delete',
  delete: 'delete',
}

/** Normalize one non-modifier key token: `'B'`→`'b'`, `'Escape'`→`'escape'`,
 * `'F1'`→`'f1'`; unknown tokens (arrows, lone modifiers) return undefined.
 * The space BAR arrives as `' '` from event.key — special-cased BEFORE the
 * trim so it normalizes to `'space'` instead of vanishing. */
function normalizeKeyToken(raw: string): string | undefined {
  const lower = raw.toLowerCase()
  if (lower === ' ') return 'space'
  const token = lower.trim()
  if (token === '') return undefined
  const named = NAMED_KEYS[token]
  if (named !== undefined) return named
  if (/^f\d{1,2}$/.test(token)) return token
  if (MODIFIER_ALIASES[token] !== undefined) return undefined
  // One single character: letters/digits/symbols. Codepoint-counted so a
  // stray multi-byte character cannot sneak through as a "single char".
  return [...token].length === 1 ? token : undefined
}

/**
 * Parse a raw shortcut string into its canonical combo. Invalid input (empty,
 * modifiers only, unknown token, two keys, a bare key with no modifier)
 * returns null — the caller treats null as "disabled".
 */
export function parseShortcut(raw: string): ShortcutCombo | null {
  const tokens = raw.trim().toLowerCase().split('+').map(token => token.trim())
  let mod = false
  let meta = false
  let ctrl = false
  let alt = false
  let shift = false
  let key: string | undefined
  for (const token of tokens) {
    if (token === '') return null
    const alias = MODIFIER_ALIASES[token]
    if (alias !== undefined) {
      switch (alias) {
        case 'mod': mod = true; break
        case 'meta': meta = true; break
        case 'ctrl': ctrl = true; break
        case 'alt': alt = true; break
        case 'shift': shift = true; break
      }
      continue
    }
    const normalized = normalizeKeyToken(token)
    if (normalized === undefined || key !== undefined) return null
    key = normalized
  }
  if (key === undefined) return null
  // `mod` absorbs an explicit meta/ctrl — a contradictory `mod+ctrl+b` is
  // read as `mod+b` rather than rejected.
  if (mod) {
    meta = false
    ctrl = false
  }
  // A bare key (including shift-only) would fire while typing: refuse it.
  if (!mod && !meta && !ctrl && !alt) return null
  return { mod, meta, ctrl, alt, shift, key }
}

/** Canonicalize a shortcut string (`'Cmd+B'` → `'meta+b'`, `'CTRL + SHIFT + P'`
 * → `'ctrl+shift+p'`). Invalid or empty input returns '' (disabled). */
export function normalizeShortcut(raw: string): string {
  const combo = parseShortcut(raw)
  if (combo === null) return ''
  const parts: string[] = []
  if (combo.mod) parts.push('mod')
  else if (combo.meta) parts.push('meta')
  else if (combo.ctrl) parts.push('ctrl')
  if (combo.alt) parts.push('alt')
  if (combo.shift) parts.push('shift')
  parts.push(combo.key)
  return parts.join('+')
}

/** Whether the current platform is macOS (Cmd-based `mod`). */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent)
}

/** Whether one keydown event matches a raw shortcut string, with EXACT
 * modifier semantics (see the module doc). */
export function matchesShortcut(raw: string, event: ShortcutEventLike, isMac: boolean): boolean {
  const combo = parseShortcut(raw)
  if (combo === null) return false
  if (normalizeKeyToken(event.key) !== combo.key) return false
  if (event.altKey !== combo.alt) return false
  if (event.shiftKey !== combo.shift) return false
  const primary = isMac ? event.metaKey : event.ctrlKey
  const secondary = isMac ? event.ctrlKey : event.metaKey
  if (combo.mod) return primary && !secondary
  if (combo.meta) return event.metaKey && !event.ctrlKey
  if (combo.ctrl) return event.ctrlKey && !event.metaKey
  return !event.ctrlKey && !event.metaKey
}

/** Human display label of a combo: `'mod+b'` → `'⌘B'` (mac) / `'Ctrl+B'`,
 * `'ctrl+shift+p'` → `'⌃⇧P'` / `'Ctrl+Shift+P'`; '' (disabled) → ''.
 * macOS symbol labels concatenate directly; word labels join with '+'. */
export function shortcutLabel(raw: string, isMac: boolean): string {
  const combo = parseShortcut(raw)
  if (combo === null) return ''
  const parts: string[] = []
  if (combo.mod) parts.push(isMac ? '⌘' : 'Ctrl')
  if (combo.meta) parts.push(isMac ? '⌘' : 'Meta')
  if (combo.ctrl) parts.push(isMac ? '⌃' : 'Ctrl')
  if (combo.alt) parts.push(isMac ? '⌥' : 'Alt')
  if (combo.shift) parts.push(isMac ? '⇧' : 'Shift')
  parts.push(keyLabel(combo.key))
  return parts.join(isMac ? '' : '+')
}

/** Display label of one normalized key token. */
function keyLabel(key: string): string {
  if (/^f\d{1,2}$/.test(key)) return key.toUpperCase()
  const named: Record<string, string> = {
    escape: 'Esc',
    enter: 'Enter',
    tab: 'Tab',
    space: 'Space',
    backspace: 'Backspace',
    delete: 'Delete',
  }
  return named[key] ?? key.toUpperCase()
}

/**
 * Build the canonical combo string from one keydown event (the capture
 * input's recorder). A press without mod/meta/ctrl/alt returns '' — bare
 * keys are refused so a shortcut can never fire while typing.
 */
export function comboFromEvent(event: ShortcutEventLike, isMac: boolean): string {
  const key = normalizeKeyToken(event.key)
  if (key === undefined) return ''
  // Refuse a press without mod/meta/ctrl/alt: a bare (or shift-only) key
  // would fire while typing. Checked BEFORE building parts — shift alone
  // would otherwise produce a 'shift+<key>' that later normalizes away,
  // silently disabling the shortcut instead of being refused.
  if (!event.ctrlKey && !event.metaKey && !event.altKey) return ''
  const parts: string[] = []
  const primary = isMac ? event.metaKey : event.ctrlKey
  const secondary = isMac ? event.ctrlKey : event.metaKey
  if (primary && !secondary) parts.push('mod')
  else if (event.metaKey) parts.push('meta')
  else if (event.ctrlKey) parts.push('ctrl')
  if (event.altKey) parts.push('alt')
  if (event.shiftKey) parts.push('shift')
  parts.push(key)
  return parts.join('+')
}
