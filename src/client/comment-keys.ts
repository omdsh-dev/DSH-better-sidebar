/**
 * The keys of a comment box (the new-comment and edit popovers, the thread card's reply box) — the
 * dsh chat composer's own Enter rule, copied so a person's fingers do the same thing in both places
 * (Brian 30/09/2026). The source is `vendor/tracy/deepseek-harness/packages/client/ui-conversation/
 * src/client/input/editor/keymap.ts` (`KEY_ENTER_COMMAND` and `isComposingEvent`):
 *
 *   - Alt / AltGraph + Enter, ⌘ + Ctrl + Enter, and Shift with ⌘ or Ctrl + Enter: bound to nothing.
 *   - Shift + Enter: the browser's own new line, also while an input method composes.
 *   - An Enter that belongs to an input method (Telex, VNI, pinyin, kana): `isComposing`, the legacy
 *     keyCode 229, or the Enter arriving just after `compositionend` (Safari's late closing keydown,
 *     which Vietnamese input methods also send) — never a send, and left to the browser exactly as
 *     dsh's composer leaves it (no `preventDefault`): whatever the browser does with it there, it does
 *     here (round 5, INPUT-new-3: the boxes used to swallow the late Enter while dsh's composer and the
 *     Comments page box let the browser break the line).
 *   - A held-down Enter (`repeat`) never presses twice; an empty box, or a disabled button, ignores it.
 *   - Otherwise plain Enter and ⌘ / Ctrl + Enter press the box's ↵ button (Send to Tracy; Save in the
 *     edit popover). "Add comment" and "Reply" stay a click only.
 */

/** How long after `compositionend` an Enter still belongs to the input method (dsh's composer: 10 ms). */
export const COMPOSITION_TAIL_MS = 10

/** The fields of a keydown the rule reads. */
export interface EnterKey {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  /** `getModifierState('AltGraph')`. */
  altGraph: boolean
  repeat: boolean
  isComposing: boolean
  keyCode: number
}

/**
 * What an Enter does in a comment box.
 * @param key - the keydown.
 * @param box - `composing`: a composition is running or just ended (within {@link COMPOSITION_TAIL_MS});
 *   `empty`: the box holds no words; `disabled`: its ↵ button cannot be pressed now (a send running).
 * @returns `'pass'` — leave the key to the browser (a new line, the input method's commit, its late
 *   closing Enter, any other key); `'swallow'` — stop the browser's default and do nothing; `'press'` — stop it and press ↵.
 */
export function enterGesture(key: EnterKey, box: { composing: boolean; empty: boolean; disabled: boolean }): 'pass' | 'swallow' | 'press' {
  if (key.key !== 'Enter') return 'pass'
  if (key.altKey || key.altGraph || (key.ctrlKey && key.metaKey) || (key.shiftKey && (key.ctrlKey || key.metaKey))) return 'swallow'
  if (key.shiftKey) return 'pass'
  // The input method's own Enter (a candidate picked, the words committed): the browser owns it.
  if (key.isComposing || key.keyCode === 229) return 'pass'
  // Its late closing Enter, after `compositionend`: not a send; the browser owns it, as in dsh's composer.
  if (box.composing) return 'pass'
  if (key.repeat || box.empty || box.disabled) return 'swallow'
  return 'press'
}
