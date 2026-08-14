/**
 * Keyboard shortcuts: the plugin's chord vocabulary, the configurable shortcut
 * registry (Side card settings), and the sidebar open/close toggle listener.
 *
 * Chord syntax: modifiers joined by '+', then the key — e.g. 'Mod+B',
 * 'Ctrl+Shift+Enter', 'Cmd+S'. Modifiers (case-insensitive): Ctrl/Control,
 * Cmd/Command/Meta, Shift, Alt/Option, and Mod (the platform primary: Cmd on
 * macOS, Ctrl elsewhere). Keys: a single letter/digit, or a named key
 * (Enter, Space, Tab, Escape, Backspace, Delete, ArrowLeft/Up/Right/Down,
 * Home, End, PageUp, PageDown, F1–F12). At least one non-Shift modifier is
 * required — bare and Shift-only keys would hijack ordinary typing.
 *
 * Matching is EXACT on modifiers (after Mod resolution); an event that adds a
 * modifier the chord does not declare does not match (Ctrl+Shift+B never
 * matches 'Ctrl+B'). The user-configurable chords live in
 * `SidebarPrefs.shortcuts` (open map, absent = default); every consumer reads
 * the live pref at key-press time, so a settings change applies immediately
 * without re-registering anything.
 */
import { isImeComposition } from './ime-guard.ts'
import { togglePanel, type SidebarStore } from './state.ts'

/** The locale keys resolving the settings-row titles (kept in sync with locales.ts). */
export type ShortcutTitleKey = 'shortcutToggleSidebar' | 'shortcutSaveEditor' | 'shortcutCommitGit'

/** One configurable shortcut: stable id, locale key, platform default chord. */
export interface ShortcutDef {
  id: string
  /** Locale key resolving the settings-row title (locales.ts). */
  titleKey: ShortcutTitleKey
  defaultChord: string
}

/**
 * The plugin's configurable shortcuts. Keep in sync with the consumers:
 * - toggleSidebar: the document-level open/close toggle (this module);
 * - saveEditor:   the CodeMirror save binding (TextEditor);
 * - commitGit:    the git commit chord (GitView).
 */
export const SHORTCUT_DEFS: readonly ShortcutDef[] = [
  { id: 'toggleSidebar', titleKey: 'shortcutToggleSidebar', defaultChord: 'Mod+B' },
  { id: 'saveEditor', titleKey: 'shortcutSaveEditor', defaultChord: 'Mod+S' },
  { id: 'commitGit', titleKey: 'shortcutCommitGit', defaultChord: 'Mod+Enter' },
]

/** A parsed chord: which modifiers are required and which key. */
export interface ParsedChord {
  ctrl: boolean
  cmd: boolean
  shift: boolean
  alt: boolean
  /** The platform-primary modifier (Cmd on macOS, Ctrl elsewhere). */
  mod: boolean
  /** Lowercase single char, or a canonical named key ('enter', 'space', …). */
  key: string
}

/** Named keys parse/display canonicalization (event.key forms → canonical). */
const NAMED_KEYS: Record<string, string> = {
  enter: 'enter',
  space: 'space',
  tab: 'tab',
  escape: 'escape',
  esc: 'escape',
  backspace: 'backspace',
  delete: 'delete',
  del: 'delete',
  arrowleft: 'arrowleft',
  arrowup: 'arrowup',
  arrowright: 'arrowright',
  arrowdown: 'arrowdown',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pagedown: 'pagedown',
  insert: 'insert',
}
for (let i = 1; i <= 12; i += 1) NAMED_KEYS['f' + i] = 'f' + i

/** Canonical display of a named key ('enter' → 'Enter', 'arrowleft' → 'ArrowLeft'). */
const NAMED_DISPLAY: Record<string, string> = {
  enter: 'Enter',
  space: 'Space',
  tab: 'Tab',
  escape: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  arrowleft: 'ArrowLeft',
  arrowup: 'ArrowUp',
  arrowright: 'ArrowRight',
  arrowdown: 'ArrowDown',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  insert: 'Insert',
  f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', f5: 'F5', f6: 'F6',
  f7: 'F7', f8: 'F8', f9: 'F9', f10: 'F10', f11: 'F11', f12: 'F12',
}

/**
 * Parse a chord string into its parts, or null when malformed. Rules:
 * - '+' separated tokens; every token before the last must be a modifier;
 * - the last token is the key (single letter/digit or a named key);
 * - at least one non-Shift modifier is required (Shift may be additional).
 */
export function parseChord(chord: string): ParsedChord | null {
  if (typeof chord !== 'string') return null
  const tokens = chord.split('+').map(token => token.trim().toLowerCase())
  if (tokens.some(token => token === '')) return null
  if (tokens.length < 2) return null
  const parsed: ParsedChord = { ctrl: false, cmd: false, shift: false, alt: false, mod: false, key: '' }
  for (const token of tokens.slice(0, -1)) {
    if (token === 'ctrl' || token === 'control') parsed.ctrl = true
    else if (token === 'cmd' || token === 'command' || token === 'meta') parsed.cmd = true
    else if (token === 'shift') parsed.shift = true
    else if (token === 'alt' || token === 'option') parsed.alt = true
    else if (token === 'mod') parsed.mod = true
    else return null
  }
  const key = tokens[tokens.length - 1]!
  if (key.length === 1) {
    if (!/[a-z0-9]/.test(key)) return null
    parsed.key = key
  } else {
    const named = NAMED_KEYS[key]
    if (named === undefined) return null
    parsed.key = named
  }
  // Shift alone is still ordinary typing/navigation (`Shift+B`,
  // `Shift+ArrowLeft`). Require a non-Shift accelerator so a configured
  // shortcut cannot silently hijack those actions across the whole app.
  if (!parsed.ctrl && !parsed.cmd && !parsed.alt && !parsed.mod) return null
  // 'Mod' already resolves to the platform primary; combining it with an
  // explicit Ctrl/Cmd would silently change meaning across platforms.
  if (parsed.mod && (parsed.ctrl || parsed.cmd)) return null
  return parsed
}

/**
 * Whether a chord would match an event's modifiers on this platform.
 * 'Mod' resolves to Cmd on macOS and Ctrl elsewhere; every declared modifier
 * must be present and no extra modifier may be pressed.
 */
export function chordMatchesEvent(
  chord: string,
  event: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean },
  isMac = MAC_PLATFORM,
): boolean {
  const parsed = parseChord(chord)
  if (parsed === null) return false
  const ctrl = parsed.ctrl || (parsed.mod && !isMac)
  const cmd = parsed.cmd || (parsed.mod && isMac)
  if (event.ctrlKey !== ctrl) return false
  if (event.metaKey !== cmd) return false
  if (event.shiftKey !== parsed.shift) return false
  if (event.altKey !== parsed.alt) return false
  return keyMatches(parsed, event, isMac)
}

/** The event.key form of a shift-modified digit (mirrors the DOM's shift layout). */
const SHIFT_DIGITS: Record<string, string> = {
  '1': '!', '2': '@', '3': '#', '4': '$', '5': '%',
  '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
}

/** Shifted event.key glyph back to the digit accepted by the chord grammar. */
const SHIFTED_DIGITS = Object.fromEntries(
  Object.entries(SHIFT_DIGITS).map(([digit, shifted]) => [shifted, digit]),
) as Record<string, string>

/**
 * Legacy-Edge event.key spellings ('Esc'/'Del'/'Left') never emitted by modern
 * engines — map them so a parsed chord still matches such events.
 */
const EVENT_KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  del: 'delete',
  left: 'arrowleft',
  up: 'arrowup',
  right: 'arrowright',
  down: 'arrowdown',
}

/**
 * Whether the event's key equals the chord's key (shift-aware for chars).
 * Letter identity ignores case after modifier equality is checked (Caps Lock
 * safe). Digits use event.code when available; the macOS Meta+Shift fallback
 * accepts the unshifted key that WebKit reports (w3c-keyname's ignoreKey rule,
 * WebKit bug 174782).
 */
function keyMatches(parsed: ParsedChord, event: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }, isMac: boolean): boolean {
  const key = parsed.key
  const eventKey = event.key
  if (key.length === 1) {
    const macHidesShift = isMac && parsed.shift && event.metaKey && event.shiftKey && !event.ctrlKey && !event.altKey
    if (/[a-z]/.test(key)) {
      // Modifier equality was already checked above. Letter identity is
      // therefore case-insensitive: Caps Lock may invert the key's case while
      // the requested Shift modifier is still physically held.
      return eventKey.toLowerCase() === key
    }
    // Digit identity comes from the physical number row when available. This
    // makes a recorded Ctrl+Shift+2 work on layouts where Shift+2 emits `"`
    // instead of the US-layout `@`. Synthetic/legacy events fall back below.
    if (event.code === `Digit${key}`) return true
    if (macHidesShift) return eventKey === key
    return parsed.shift ? eventKey === SHIFT_DIGITS[key] : eventKey === key
  }
  if (key === 'space') return eventKey === ' ' || eventKey === 'Spacebar'
  const alias = EVENT_KEY_ALIASES[eventKey.toLowerCase()]
  return (alias ?? eventKey.toLowerCase()) === key
}

/** Result of turning one recorder keydown into UI feedback or a saved chord. */
export type ShortcutCaptureResult =
  | { kind: 'modifier'; preview: string }
  | { kind: 'complete'; chord: string }
  | { kind: 'invalid'; reason: 'modifier-required' | 'unsupported-key' }

/** Modifier-only keydowns update the recorder preview instead of completing it. */
const MODIFIER_EVENT_KEYS = new Set(['control', 'meta', 'os', 'shift', 'alt', 'altgraph'])

/**
 * Convert a real keydown into the canonical chord stored in preferences.
 * Unlike the text parser, this records the ACTUAL primary key the user held:
 * Ctrl remains Ctrl and Meta becomes Cmd (existing `Mod` defaults still
 * display platform-resolved through {@link displayChord}). Shifted digits use
 * `event.code` first so `Ctrl+Shift+1` records the grammar's `...+1` rather
 * than the emitted `!` glyph.
 */
export function captureShortcutEvent(event: {
  key: string
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}): ShortcutCaptureResult {
  const eventKey = event.key.toLowerCase()
  // Some synthetic/legacy events do not set the modifier flag on the
  // modifier's own keydown, so the key name participates in the preview too.
  const ctrl = event.ctrlKey || eventKey === 'control'
  const cmd = event.metaKey || eventKey === 'meta' || eventKey === 'os'
  const shift = event.shiftKey || eventKey === 'shift'
  const alt = event.altKey || eventKey === 'alt' || eventKey === 'altgraph'
  const modifiers: string[] = []
  if (ctrl) modifiers.push('Ctrl')
  if (cmd) modifiers.push('Cmd')
  if (shift) modifiers.push('Shift')
  if (alt) modifiers.push('Alt')

  if (MODIFIER_EVENT_KEYS.has(eventKey)) {
    return { kind: 'modifier', preview: modifiers.length === 0 ? '' : `${modifiers.join('+')}+` }
  }
  // Shift-only chords still represent ordinary typing/navigation. The parser
  // rejects them too; report the more useful modifier error before key parsing.
  if (!ctrl && !cmd && !alt) return { kind: 'invalid', reason: 'modifier-required' }

  let key: string | undefined
  const named = eventKey === ' ' || eventKey === 'spacebar'
    ? 'space'
    : (NAMED_KEYS[eventKey] ?? EVENT_KEY_ALIASES[eventKey])
  if (named !== undefined) {
    key = NAMED_DISPLAY[named]
  } else if (/^[a-z0-9]$/i.test(event.key)) {
    key = event.key.toUpperCase()
  } else if (/^Digit[0-9]$/.test(event.code ?? '')) {
    key = event.code!.slice('Digit'.length)
  } else if (shift) {
    key = SHIFTED_DIGITS[event.key]
  }
  if (key === undefined) return { kind: 'invalid', reason: 'unsupported-key' }

  const chord = canonicalChord([...modifiers, key].join('+'))
  return chord === null
    ? { kind: 'invalid', reason: 'unsupported-key' }
    : { kind: 'complete', chord }
}

/** Canonical chord spelling ('ctrl+b' → 'Ctrl+B', 'esc' → 'Escape'); null when malformed. */
export function canonicalChord(chord: string): string | null {
  const parsed = parseChord(chord)
  if (parsed === null) return null
  const mods: string[] = []
  if (parsed.mod) mods.push('Mod')
  if (parsed.ctrl) mods.push('Ctrl')
  if (parsed.cmd) mods.push('Cmd')
  if (parsed.shift) mods.push('Shift')
  if (parsed.alt) mods.push('Alt')
  const key = parsed.key.length === 1
    ? (parsed.key >= 'a' && parsed.key <= 'z' ? parsed.key.toUpperCase() : parsed.key)
    : (NAMED_DISPLAY[parsed.key] ?? parsed.key)
  return [...mods, key].join('+')
}

/** The platform-resolved chord for display ('Mod+B' → 'Ctrl+B' / 'Cmd+B'). */
export function displayChord(chord: string, isMac = MAC_PLATFORM): string {
  const canonical = canonicalChord(chord)
  if (canonical === null) return chord
  return canonical.split('+').map(token => (token === 'Mod' ? (isMac ? 'Cmd' : 'Ctrl') : token)).join('+')
}

/**
 * The CodeMirror keymap key for a chord ('Mod+B' → 'Mod-b',
 * 'Ctrl+Shift+Enter' → 'Ctrl-Shift-Enter' …). Shift is always explicit:
 * CodeMirror can then use its keyCode fallback for non-US layouts and its
 * Shift-aware path when Caps Lock changes a letter's event.key case.
 * Null when the chord is malformed.
 */
export function chordToCodeMirrorKey(chord: string, isMac = MAC_PLATFORM): string | null {
  const parsed = parseChord(chord)
  if (parsed === null) return null
  const mods: string[] = []
  if (parsed.alt) mods.push('Alt')
  if (parsed.ctrl) mods.push('Ctrl')
  if (parsed.cmd) mods.push('Meta')
  if (parsed.mod) mods.push('Mod')
  if (parsed.shift) mods.push('Shift')
  let key: string
  if (parsed.key.length === 1) {
    key = parsed.key
  } else {
    key = NAMED_DISPLAY[parsed.key] ?? parsed.key
  }
  return [...mods, key].join('-')
}

/** The plugin's live chord for one shortcut id (pref override or default). */
export function chordOf(store: SidebarStore, id: string): string {
  const override = store.getPrefs().shortcuts[id]
  if (override !== undefined) return override
  const def = SHORTCUT_DEFS.find(shortcut => shortcut.id === id)
  return def?.defaultChord ?? ''
}

/**
 * Validate a raw shortcuts map from the settings wire: only canonical chord
 * strings survive (malformed entries and non-strings are dropped), so an
 * absent key keeps meaning "use the default chord".
 */
export function normalizeShortcutMap(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [id, chord] of Object.entries(value as Record<string, unknown>)) {
    // Special object keys are not shortcut ids: '__proto__' would silently
    // hit the prototype setter and 'constructor' creates an inert own
    // property — neither may be stored (no pollution, just hygiene).
    if (id === '__proto__' || id === 'constructor') continue
    if (typeof chord !== 'string') continue
    const canonical = canonicalChord(chord)
    if (canonical !== null) out[id] = canonical
  }
  return out
}

/** Whether the current browser platform is macOS (Mod = Cmd there). */
export function isMacPlatform(): boolean {
  try {
    const uad = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
    const platform = uad?.platform ?? navigator.platform ?? ''
    return /mac/i.test(platform)
  } catch {
    return false
  }
}

/**
 * The platform resolution, cached at module load: it cannot change at
 * runtime, and the document-level listener must not re-read the navigator
 * on every keydown (this module is safe to import in node — the read is
 * guarded and falls back to non-mac).
 */
export const MAC_PLATFORM: boolean = isMacPlatform()

/**
 * Register the document-level sidebar toggle: the configured chord flips the
 * current session's panel open/closed. The chord yields to:
 * - IME composition (composition keys belong to the input method);
 * - any handler that already claimed the event (defaultPrevented);
 * - the sidebar terminal (xterm forwards Ctrl+B to the pty as a control char
 *   / tmux prefix WITHOUT preventing the default, so the target check is the
 *   only protection there).
 * Returns the disposer (HMR-safe; call through `ctx.effect`).
 */
export function registerSidebarToggleShortcut(store: SidebarStore): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (isImeComposition(event)) return
    if (event.defaultPrevented) return
    // Auto-repeat of a held chord would flip the panel to an arbitrary state.
    if (event.repeat) return
    if (!chordMatchesEvent(chordOf(store, 'toggleSidebar'), event)) return
    if (event.target instanceof Element && event.target.closest('.xterm') !== null) return
    // Without a session the store reduce is a no-op: leave the default action
    // alone (the chord was never ours to consume).
    if (store.getSnapshot().state === undefined) return
    // preventDefault without stopPropagation: other document handlers may
    // still observe the chord (intentional — the app stays composable).
    event.preventDefault()
    store.reduce(togglePanel)
  }
  document.addEventListener('keydown', onKeyDown)
  return () => {
    document.removeEventListener('keydown', onKeyDown)
  }
}
