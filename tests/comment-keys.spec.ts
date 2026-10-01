/**
 * The Enter rule of every comment box — the dsh chat composer's own (`vendor/tracy/deepseek-harness/
 * packages/client/ui-conversation/src/client/input/editor/keymap.ts`, `KEY_ENTER_COMMAND`), as Brian
 * asked on 30/09/2026: plain Enter and ⌘/Ctrl+Enter press the box's ↵ button, Shift+Enter is a new line,
 * an Enter that belongs to an input method does nothing, a held-down Enter never presses twice, and an
 * empty box ignores Enter.
 */
import { describe, expect, it } from 'vitest'
import { COMPOSITION_TAIL_MS, enterGesture } from '../src/client/comment-keys.ts'

const key = (over: Partial<Parameters<typeof enterGesture>[0]> = {}): Parameters<typeof enterGesture>[0] => ({
  key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, altGraph: false, repeat: false, isComposing: false, keyCode: 13, ...over,
})
const ready = { composing: false, empty: false, disabled: false }

describe('enterGesture — the dsh composer\'s Enter', () => {
  it('plain Enter, ⌘+Enter and Ctrl+Enter press the ↵ button', () => {
    expect(enterGesture(key(), ready)).toBe('press')
    expect(enterGesture(key({ metaKey: true }), ready)).toBe('press')
    expect(enterGesture(key({ ctrlKey: true }), ready)).toBe('press')
  })

  it('Shift+Enter is the browser\'s own new line, also while composing', () => {
    expect(enterGesture(key({ shiftKey: true }), ready)).toBe('pass')
    expect(enterGesture(key({ shiftKey: true, isComposing: true }), ready)).toBe('pass')
  })

  it('Alt, AltGraph, ⌘+Ctrl and Shift with ⌘ or Ctrl are bound to nothing: no send, no new line', () => {
    for (const over of [{ altKey: true }, { altGraph: true }, { ctrlKey: true, metaKey: true }, { shiftKey: true, metaKey: true }, { shiftKey: true, ctrlKey: true }])
      expect(enterGesture(key(over), ready)).toBe('swallow')
  })

  it('an Enter the input method owns (isComposing, keyCode 229) is left to it: no send, the browser commits the words', () => {
    expect(enterGesture(key({ isComposing: true }), ready)).toBe('pass')
    expect(enterGesture(key({ keyCode: 229 }), ready)).toBe('pass')
  })

  it('the Enter that closes a composition, arriving just after compositionend (Safari, Vietnamese IMEs), never sends and is left to the browser, as dsh\'s composer leaves it (round 5, INPUT-new-3)', () => {
    expect(enterGesture(key(), { ...ready, composing: true })).toBe('pass')
    expect(enterGesture(key({ metaKey: true }), { ...ready, composing: true })).toBe('pass')
    expect(COMPOSITION_TAIL_MS).toBeGreaterThan(0)
  })

  it('a held-down Enter (repeat) never presses again', () => {
    expect(enterGesture(key({ repeat: true }), ready)).toBe('swallow')
    expect(enterGesture(key({ repeat: true, metaKey: true }), ready)).toBe('swallow')
  })

  it('an empty box, or one whose button is disabled, ignores Enter — not even a new line', () => {
    expect(enterGesture(key(), { ...ready, empty: true })).toBe('swallow')
    expect(enterGesture(key(), { ...ready, disabled: true })).toBe('swallow')
  })

  it('any other key is not its business', () => {
    expect(enterGesture(key({ key: 'a' }), ready)).toBe('pass')
    expect(enterGesture(key({ key: 'Escape' }), ready)).toBe('pass')
  })
})
