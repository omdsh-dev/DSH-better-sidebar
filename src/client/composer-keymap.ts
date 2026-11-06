/**
 * Side-chat composer keymap: which gesture submits a message, and the IME
 * guard that outranks it.
 *
 * The submission contract has two modes, picked by the user in the side card
 * settings page and carried into the view as `submitKey`:
 *
 * - `'enter'` (the default): a plain `Enter` submits and the gesture is
 *   CONSUMED (no newline). `Shift+Enter` never submits and keeps the
 *   textarea's native line break.
 * - `'mod-enter'`: exactly `Cmd+Enter` or `Ctrl+Enter` submits; a bare
 *   `Enter` and `Shift+Enter` insert a newline and are NOT consumed.
 *
 * The IME guard follows the host's own composer keymap
 * (`packages/client/ui-conversation/src/client/input/editor/keymap.ts`): a
 * keydown that belongs to a composition must never submit, and the guard wins
 * over a submit chord. Three signals make that decision:
 *
 * - `KeyboardEvent.isComposing` — most engines;
 * - the legacy `keyCode === 229`, which some engines report with
 *   `isComposing === false` while an IME owns the keyboard;
 * - a {@link COMPOSITION_END_GRACE_MS} window after `compositionend`: Safari
 *   delivers the composition-closing keydown AFTER compositionend, so the
 *   state flag is already false by the time the Enter arrives (the host's
 *   "old textarea's proven window", same 10 ms).
 *
 * The decisions are pure functions taking the clock as a parameter, so the
 * behavior is pinned without a DOM:
 * {@link compositionPhase} / {@link isComposingKeydown} / {@link isSubmitGesture}.
 * The vocabulary (the modes and their parser) lives with the other preference
 * vocabulary in `prefs-shared.ts`, because the stored value is a preference.
 *
 * Consumption is part of the contract, not just "don't submit": a keydown in
 * the composition-CLOSING window is swallowed (no submit, no newline) while a
 * LIVE composition key is left untouched so the candidate picker keeps it.
 *
 * The caller applies the decisions in the host keymap's order:
 *   1. a LIVE composition owns the key outright (no submit, no consumption —
 *      not even when the event also carries Alt or is a repeat);
 *   2. the submit gesture (see {@link isSubmitGesture}) is consumed and sends
 *      unless `repeat` marks it as a held key — a repeated submit gesture is
 *      consumed WITHOUT sending, while a repeated newline gesture keeps its
 *      native line break;
 *   3. a shortcut/layout chord ({@link isGuardedKeydown}) and the closing-window
 *      Enter are consumed without sending.
 */
import type { SidechatSubmitKey } from '../prefs-shared.ts'

/** How long after `compositionend` a keydown still belongs to the IME. */
export const COMPOSITION_END_GRACE_MS = 10

/** The key-event fields the decisions read (the view feeds the native event's
 *  `isComposing` / `keyCode` / modifiers beside React's flags). */
export interface ComposerKeyEvent {
  /** The key name (`'Enter'`). */
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  /** Option/Alt — on macOS the reader's way to type an accented character. */
  altKey?: boolean
  /** `KeyboardEvent.getModifierState('AltGraph')`: the AltGr modifier, which
   *  some layouts use as a switcher gesture (never a form submit). */
  altGraph?: boolean
  /** This keydown is an auto-repeat of a held key, not a fresh press. */
  repeat?: boolean
  /** The engine's composition flag (absent on events that do not carry it). */
  isComposing?: boolean
  /** The legacy IME key code (229 while an engine hides its composition). */
  keyCode?: number
}

/**
 * Whether this keydown is a SHORTCUT / layout gesture rather than a composer
 * gesture: the host keymap's first line (`altKey` / AltGraph / `Ctrl+Meta` /
 * `Shift` with `Ctrl` or `Meta`). Such a keydown must neither submit the draft
 * nor insert a newline — the host returns "stop the fallback line break
 * without consuming the DOM event", and a plain textarea only has the one
 * lever, so the caller consumes it.
 * @param event - the keydown's fields.
 * @returns true for a modifier chord the composer must leave alone.
 */
export function isGuardedKeydown(event: ComposerKeyEvent): boolean {
  if (event.altKey === true) return true
  if (event.altGraph === true) return true
  if (event.ctrlKey && event.metaKey) return true
  return event.shiftKey && (event.ctrlKey || event.metaKey)
}


/**
 * How one keydown relates to an IME composition:
 *
 * - `'active'` — the composition is live, or the engine flags the key as its
 *   own (legacy 229). The key belongs to the input method: never submit and
 *   never consume it (`preventDefault()` there fights the candidate picker).
 * - `'closing'` — no composition is live and the event carries no flag, but
 *   `compositionend` fired inside the grace window. This is Safari's late
 *   composition-closing keydown: it must be CONSUMED (the host's composer
 *   "neither submits nor breaks the line"), because letting it through inserts
 *   a newline the user never asked for.
 * - `'none'` — an ordinary keydown.
 */
export type CompositionPhase = 'none' | 'active' | 'closing'

/**
 * Classify one keydown against the composition window.
 * @param event - the keydown's fields.
 * @param composing - whether a composition is LIVE right now (tracked from
 *   `compositionstart` / `compositionend`; some engines only signal it there).
 * @param composingUntil - the deadline of the composition-end grace window
 *   (`Date.now()` basis, 0 when no composition ever ended).
 * @param now - the current time (injectable for deterministic tests).
 * @returns the keydown's composition phase.
 */
export function compositionPhase(
  event: ComposerKeyEvent,
  composing: boolean,
  composingUntil: number,
  now: number = Date.now(),
): CompositionPhase {
  if (event.isComposing === true || composing) return 'active'
  // The legacy signal counts as ACTIVE, never as 'closing': engines emit 229
  // without the flag while an IME owns the key, and layout-switcher utilities
  // emit bare 229s outside any composition — a key this guard cannot place is
  // left to the browser instead of being consumed.
  // oxlint-disable-next-line typescript/no-deprecated
  if (event.keyCode === 229) return 'active'
  return now < composingUntil ? 'closing' : 'none'
}

/**
 * Whether this keydown belongs to an IME composition and must therefore be
 * left unsubmitted.
 * @param event - the keydown's fields.
 * @param composing - whether a composition is LIVE right now.
 * @param composingUntil - the deadline of the composition-end grace window.
 * @param now - the current time (injectable for deterministic tests).
 * @returns true while a composition owns the keyboard (active or closing).
 */
export function isComposingKeydown(
  event: ComposerKeyEvent,
  composing: boolean,
  composingUntil: number,
  now: number = Date.now(),
): boolean {
  return compositionPhase(event, composing, composingUntil, now) !== 'none'
}

/**
 * Whether this keydown REPRESENTS the submit gesture under the configured mode.
 *
 * The answer is about the gesture, not about how many times the key has fired:
 * an auto-repeat represents the gesture it repeats, so the caller decides what
 * to do with `repeat` AFTER this question — exactly the host keymap's order,
 * where the plain-Enter newline (`keymap.ts:141`) is settled before the
 * `preventDefault()` + repeat bail-out (`:156-158`). A repeated submit gesture
 * must not send; a repeated NEWLINE gesture must keep its native line break.
 *
 * Priority for the gesture itself (the host keymap's own order): a
 * shortcut/layout modifier chord outranks everything, then `Shift+Enter`'s
 * newline, then the IME guard, and only then the configured submit mode.
 * @param event - the keydown's fields.
 * @param submitKey - the configured submission mode.
 * @param composing - whether a composition is LIVE right now.
 * @param composingUntil - the composition-end grace deadline (see above).
 * @param now - the current time (injectable for deterministic tests).
 * @returns true when the gesture submits (the caller consumes it and, unless
 *   this is a repeat, sends the draft).
 */
export function isSubmitGesture(
  event: ComposerKeyEvent,
  submitKey: SidechatSubmitKey,
  composing: boolean,
  composingUntil: number,
  now: number = Date.now(),
): boolean {
  if (event.key !== 'Enter') return false
  // A shortcut / layout chord is not a composer gesture at all.
  if (isGuardedKeydown(event)) return false
  // Shift+Enter NEVER submits: it is the newline gesture in both modes.
  if (event.shiftKey) return false
  if (isComposingKeydown(event, composing, composingUntil, now)) return false
  if (submitKey === 'mod-enter') return event.metaKey || event.ctrlKey
  return true
}
