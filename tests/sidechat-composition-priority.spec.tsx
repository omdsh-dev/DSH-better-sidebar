// @vitest-environment jsdom
/**
 * Composer priority — a LIVE IME composition outranks the modifier / repeat
 * guards. Design basis: `/tmp/bsb-parity/spec.md` §D7's keymap parity work plus
 * the host keymap (`/root/dsh-web/app/packages/client/ui-conversation/src/
 * client/input/editor/keymap.ts:145-149`: the composition check answers
 * "neither submit nor break the line. No preventDefault: the browser owns the
 * gesture").
 *
 * Why this spec exists: `SideChatView` now consumes every shortcut/layout and
 * repeated Enter (`isGuardedKeydown(gesture) || gesture.repeat === true` →
 * `preventDefault()`) BEFORE it asks whether a composition owns the keyboard.
 * So while an IME is composing, `Alt+Enter` (and a repeated Enter) is
 * swallowed: the key never reaches the candidate picker / layout switcher the
 * reader is actually using. The guards must not outrank the IME.
 *
 * ============================ CONTRACT ============================
 * 1. LIVE COMPOSITION = `compositionPhase(...) === 'active'` — an event with
 *    `isComposing === true`, an event with the legacy `keyCode === 229`, or a
 *    composition tracked live from `compositionstart`. Such a keydown is the
 *    input method's:
 *      - it never submits (`sidechat.prompt` stays at zero), AND
 *      - it is NEVER consumed (`event.defaultPrevented === false`), even when
 *        it also carries `altKey` or `repeat === true`. Consuming it fights the
 *        candidate picker / layout switcher.
 * 2. NON-COMPOSING keydowns keep the guards from
 *    tests/sidechat-composer-guards.spec.tsx: `Alt+Enter` and a repeated Enter
 *    are consumed (`defaultPrevented === true`) and never submit.
 * 3. The draft is never damaged: none of these keydowns may submit, so the
 *    composer keeps its text.
 *
 * The composition-CLOSING grace window (Safari's late keydown after
 * `compositionend`) is NOT part of this contract: it is owned by
 * tests/sidechat-ime-consuming-enter.spec.tsx, which pins "consumed, not
 * submitted" for it.
 * ==================================================================
 *
 * jsdom does not implement textarea default actions, so "consumed" is read as
 * `defaultPrevented`; `isComposing` / `keyCode` / `repeat` are not constructor
 * options there and are defined on the dispatched event.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react-dom/test-utils'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'
import type { RenderedRoot } from './test-utils.ts'

/** What one synthesized Enter carries. */
interface PressInit {
  alt?: boolean
  repeat?: boolean
  /** `KeyboardEvent#isComposing` — the engine's composition flag. */
  isComposing?: boolean
  /** The legacy IME key code (229 while an engine hides its composition). */
  keyCode?: number
}

/** The composer's textarea in a mounted view. */
function composerField(view: RenderedRoot): HTMLTextAreaElement {
  const field = view.container.querySelector('textarea')
  if (field === null) throw new Error('the composer textarea is missing')
  return field
}

/** Dispatch one real Enter keydown at the composer. */
function pressEnter(field: HTMLTextAreaElement, init: PressInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    bubbles: true,
    cancelable: true,
    altKey: init.alt === true,
  })
  if (init.repeat !== undefined) Object.defineProperty(event, 'repeat', { value: init.repeat })
  if (init.isComposing !== undefined) Object.defineProperty(event, 'isComposing', { value: init.isComposing })
  if (init.keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  act(() => { field.dispatchEvent(event) })
  return event
}

/** Mark the composer as being inside a live composition (the IME's own event). */
function startComposition(field: HTMLTextAreaElement): void {
  act(() => { field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })) })
}

let harness: SidechatHarness

beforeEach(() => {
  harness = installSidechatHarness({
    events: [
      { type: 'session/end-seed', seq: 0, time: 0, data: {} },
      { type: 'user/message', seq: 1, time: 1_000, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
    ],
  })
})

afterEach(() => {
  harness.cleanup()
})

/** Mount with a draft in the composer. */
async function mountWithDraft(draft = 'nihao'): Promise<{ view: RenderedRoot, field: HTMLTextAreaElement }> {
  const view = harness.mount()
  await harness.flush()
  harness.typeComposer(draft)
  await harness.flush(2)
  return { view, field: composerField(view) }
}

describe('a live IME composition outranks the composer guards', () => {
  it('leaves an Alt+Enter inside a composition to the input method (no submit, no consume)', async () => {
    const cases: Array<[string, PressInit, boolean]> = [
      ['isComposing + Alt', { isComposing: true, alt: true }, false],
      ['keyCode 229 + Alt', { keyCode: 229, alt: true }, false],
      ['live composition (compositionstart) + Alt', { alt: true }, true],
    ]
    for (const [label, init, viaCompositionStart] of cases) {
      const { view, field } = await mountWithDraft()
      try {
        if (viaCompositionStart) startComposition(field)
        const before = harness.promptCalls.length
        const event = pressEnter(field, init)
        await harness.flush(2)
        expect.soft(harness.promptCalls.length, `${label}: a composition key never submits`).toBe(before)
        expect.soft(
          event.defaultPrevented,
          `${label}: the IME owns the gesture — consuming it would fight the candidate picker`,
        ).toBe(false)
        expect.soft(harness.composerValue(), `${label}: the draft survives`).toBe('nihao')
      } finally {
        view.unmount()
      }
    }
  })

  it('leaves a repeated Enter inside a composition to the input method as well', async () => {
    const cases: Array<[string, PressInit, boolean]> = [
      ['isComposing + repeat', { isComposing: true, repeat: true }, false],
      ['keyCode 229 + repeat', { keyCode: 229, repeat: true }, false],
      ['live composition (compositionstart) + repeat', { repeat: true }, true],
    ]
    for (const [label, init, viaCompositionStart] of cases) {
      const { view, field } = await mountWithDraft()
      try {
        if (viaCompositionStart) startComposition(field)
        const before = harness.promptCalls.length
        const event = pressEnter(field, init)
        await harness.flush(2)
        expect.soft(harness.promptCalls.length, `${label}: a composition key never submits`).toBe(before)
        expect.soft(
          event.defaultPrevented,
          `${label}: a repeated key inside a composition belongs to the IME`,
        ).toBe(false)
        expect.soft(harness.composerValue(), `${label}: the draft survives`).toBe('nihao')
      } finally {
        view.unmount()
      }
    }
  })

  it('still consumes the same keydowns when no composition is live', async () => {
    const cases: Array<[string, PressInit]> = [
      ['Alt+Enter', { alt: true }],
      ['repeated Enter', { repeat: true }],
    ]
    for (const [label, init] of cases) {
      const { view, field } = await mountWithDraft()
      try {
        const before = harness.promptCalls.length
        const event = pressEnter(field, init)
        await harness.flush(2)
        expect.soft(harness.promptCalls.length, `${label}: never submits`).toBe(before)
        expect.soft(event.defaultPrevented, `${label}: outside a composition the guard still consumes it`).toBe(true)
        expect.soft(harness.composerValue(), `${label}: the draft survives`).toBe('nihao')
      } finally {
        view.unmount()
      }
    }
  })
})
