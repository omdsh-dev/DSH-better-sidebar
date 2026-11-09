// @vitest-environment jsdom
/**
 * Composer correctness guards — the keydowns that must reach the composer but
 * must never SUBMIT the draft. Parity target: the host's own composer keymap,
 * `/root/dsh-web/app/packages/client/ui-conversation/src/client/input/editor/keymap.ts:138-162`.
 *
 * Why this spec exists: the side chat's keymap (src/client/composer-keymap.ts)
 * decides "does this Enter submit?" from `key` + `shiftKey` + the IME signals
 * only. It never looks at `altKey`, at the AltGraph modifier, at a
 * Ctrl+Meta chord, at Shift combined with Cmd/Ctrl, or at `repeat`. Consequences
 * the host composer does not have:
 *
 * - `Alt+Enter` and `AltGraph+Enter` submit and wipe the draft (on macOS the
 *   Option key is how a reader types an accented character or a symbol, and on
 *   many layouts AltGr+Enter is a layout-switcher gesture);
 * - `Ctrl+Meta+Enter` submits (a shortcut chord, not a send);
 * - `Shift+Ctrl/Meta+Enter` is neither submitted nor consumed, so the textarea
 *   inserts a newline the reader did not ask for;
 * - holding Enter down machine-guns one send per repeat event.
 *
 * ============================ CONTRACT ============================
 * The view feeds the native keydown — `key`, `shiftKey`, `ctrlKey`, `metaKey`,
 * `altKey`, `getModifierState('AltGraph')`, `repeat`, plus the existing
 * composition signals — into one decision, and the decision must satisfy:
 *
 * 1. MODIFIER GUARD (host keymap's first line, outranks everything else —
 *    including the Shift+Enter newline and the submit mode). An Enter carrying
 *    ANY of
 *      - `altKey`,
 *      - `getModifierState('AltGraph') === true`,
 *      - `ctrlKey && metaKey`,
 *      - `shiftKey && (ctrlKey || metaKey)`
 *    must NEITHER submit NOR insert a newline: zero `sidechat.prompt` requests
 *    AND `event.defaultPrevented === true`.
 *    (The host's line returns `true` — "stop the fallback line break without
 *    consuming the DOM event". A React textarea has no such middle state: the
 *    newline is suppressed by `preventDefault()`, which is why this spec pins
 *    `defaultPrevented === true` for the combos the host neutralizes.)
 * 2. HELD-DOWN ENTER. `repeat === true` never submits, in either mode and
 *    including the Cmd/Ctrl chord of `'mod-enter'`. The repeat guard sits AFTER
 *    the newline decision, exactly as in the host keymap (`keymap.ts:141`
 *    returns `false` for a plain Enter — the newline — before `:156-158`
 *    reaches `preventDefault()` and its `repeat` bail-out). A repeated keydown
 *    is therefore judged by the gesture it repeats:
 *      - a gesture that WOULD SUBMIT is CONSUMED (`defaultPrevented === true`):
 *        the bare Enter of `'enter'` mode, the Cmd/Ctrl+Enter of `'mod-enter'`;
 *      - a NEWLINE gesture keeps its native line break (`defaultPrevented ===
 *        false`): `Shift+Enter` in either mode, and the bare Enter of
 *        `'mod-enter'` mode. Consuming those repeats is a regression — holding
 *        Shift+Enter would insert exactly ONE newline instead of growing the
 *        paragraph.
 *    In neither case may a repeat submit.
 * 3. IME OWNERSHIP (`keyCode === 229`, the legacy signal engines report while a
 *    composition owns the keyboard): never submits AND is NOT consumed
 *    (`defaultPrevented === false`) — the browser and the IME own the gesture,
 *    and consuming it would fight the candidate picker / layout switcher. The
 *    existing IME spec only asserts the "does not submit" half; the
 *    "not consumed" half is pinned here.
 * 4. THE GUARD IS NOT A BLANKET: the plain gestures keep working — `Enter`
 *    submits in `'enter'` mode, `Cmd/Ctrl+Enter` submits in `'mod-enter'`, and a
 *    bare `Shift+Enter` still gets its native line break (not consumed).
 * 5. A guard never damages the draft: the composer keeps its text whenever the
 *    keydown did not submit.
 *
 * jsdom has no textarea default action, so "would a newline be inserted" is
 * observed as `defaultPrevented` on the dispatched event — the same reading
 * tests/sidechat-ime-consuming-enter.spec.tsx uses for the same reason.
 * `KeyboardEvent` does not expose AltGraph through its init in jsdom, and
 * `repeat` / `keyCode` are not constructor options there either, so those three
 * fields are defined on the dispatched event directly.
 * ==================================================================
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react-dom/test-utils'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'
import type { RenderedRoot } from './test-utils.ts'

/** What one synthesized Enter carries. */
interface PressInit {
  alt?: boolean
  /** `getModifierState('AltGraph')` — the AltGr modifier, not `altKey`. */
  altGraph?: boolean
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  /** `KeyboardEvent#repeat`: this keydown is an auto-repeat of a held key. */
  repeat?: boolean
  /** The legacy IME key code (229 while an engine hides its composition). */
  keyCode?: number
}

/** The composer's textarea in a mounted view. */
function composerField(view: RenderedRoot): HTMLTextAreaElement {
  const field = view.container.querySelector('textarea')
  if (field === null) throw new Error('the composer textarea is missing')
  return field
}

/**
 * Dispatch one real Enter keydown at the composer.
 * @param field - the composer textarea.
 * @param init - modifiers and engine signals the event carries.
 * @returns the dispatched event (`defaultPrevented` = "the gesture was
 *   consumed, so the textarea inserts no newline").
 */
function pressEnter(field: HTMLTextAreaElement, init: PressInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    bubbles: true,
    cancelable: true,
    altKey: init.alt === true,
    ctrlKey: init.ctrl === true,
    metaKey: init.meta === true,
    shiftKey: init.shift === true,
  })
  // Not constructor options in jsdom (nor derivable from the flags above).
  if (init.repeat !== undefined) Object.defineProperty(event, 'repeat', { value: init.repeat })
  if (init.keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  if (init.altGraph === true) {
    // jsdom ignores `altGraphKey` in the init dict; the modifier query is the
    // API the view is expected to read.
    Object.defineProperty(event, 'getModifierState', { value: (key: string) => key === 'AltGraph' })
  }
  act(() => { field.dispatchEvent(event) })
  return event
}

/** How many prompts the harness saw (the array is shared across a test). */
function promptCount(harness: SidechatHarness): number {
  return harness.promptCalls.length
}

/** Mount the view, put a draft in the composer and hand back the field. */
async function mountWithDraft(harness: SidechatHarness, draft = 'draft text'): Promise<{ view: RenderedRoot, field: HTMLTextAreaElement }> {
  const view = harness.mount()
  await harness.flush()
  harness.typeComposer(draft)
  await harness.flush(2)
  return { view, field: composerField(view) }
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

describe('composer modifier guard (host keymap parity)', () => {
  it('never submits nor breaks the line for Alt / AltGraph / Ctrl+Meta / Shift+Ctrl|Meta', async () => {
    const cases: Array<[string, PressInit]> = [
      ['Alt+Enter', { alt: true }],
      ['AltGraph+Enter', { altGraph: true }],
      ['Ctrl+Meta+Enter', { ctrl: true, meta: true }],
      ['Shift+Ctrl+Enter', { shift: true, ctrl: true }],
      ['Shift+Meta+Enter', { shift: true, meta: true }],
    ]
    // One fresh mount per case: a case that wrongly submits must not empty the
    // draft of the next one (each case has to answer on its own).
    for (const [label, init] of cases) {
      const { view, field } = await mountWithDraft(harness)
      try {
        const before = promptCount(harness)
        const event = pressEnter(field, init)
        await harness.flush(2)
        // Soft: every case answers on its own, so one regression reports all of
        // them instead of hiding the rest behind the first failure.
        expect.soft(promptCount(harness), `${label} must not submit the draft`).toBe(before)
        expect.soft(event.defaultPrevented, `${label} must not leave a newline behind`).toBe(true)
        expect.soft(harness.composerValue(), `${label} keeps the draft`).toBe('draft text')
      } finally {
        view.unmount()
      }
    }
  })

  it('applies the same guard in mod-enter mode, where Ctrl+Meta+Enter would otherwise submit', async () => {
    harness.extraProps.submitKey = 'mod-enter'
    const cases: Array<[string, PressInit]> = [
      ['Alt+Enter', { alt: true }],
      ['AltGraph+Enter', { altGraph: true }],
      ['Ctrl+Meta+Enter', { ctrl: true, meta: true }],
      ['Shift+Meta+Enter', { shift: true, meta: true }],
    ]
    for (const [label, init] of cases) {
      const { view, field } = await mountWithDraft(harness)
      try {
        const before = promptCount(harness)
        const event = pressEnter(field, init)
        await harness.flush(2)
        expect.soft(promptCount(harness), `${label} must not submit in mod-enter mode`).toBe(before)
        expect.soft(event.defaultPrevented, `${label} must not leave a newline behind in mod-enter mode`).toBe(true)
        expect.soft(harness.composerValue(), `${label} keeps the draft in mod-enter mode`).toBe('draft text')
      } finally {
        view.unmount()
      }
    }
  })

  it('never submits a held-down submit gesture, and consumes it (enter mode)', async () => {
    const { view, field } = await mountWithDraft(harness, 'held draft')
    try {
      // A held key arrives as one `repeat: false` keydown followed by repeat
      // events; only the first may send. In 'enter' mode the bare Enter IS the
      // submit gesture, so its repeats are consumed like the submit itself.
      const repeat = pressEnter(field, { repeat: true })
      await harness.flush(2)
      expect(promptCount(harness), 'a repeat Enter must not send').toBe(0)
      expect(repeat.defaultPrevented, 'a repeat of the submit gesture is consumed').toBe(true)
      expect(harness.composerValue(), 'the draft survives the auto-repeat').toBe('held draft')
    } finally {
      view.unmount()
    }
  })

  it('never submits a held-down Cmd/Ctrl chord either (mod-enter mode)', async () => {
    harness.extraProps.submitKey = 'mod-enter'
    const { view, field } = await mountWithDraft(harness, 'held chord draft')
    try {
      const repeat = pressEnter(field, { meta: true, repeat: true })
      await harness.flush(2)
      expect(promptCount(harness), 'a repeated Cmd+Enter must not send').toBe(0)
      expect(repeat.defaultPrevented, 'a repeated chord is consumed').toBe(true)
      expect(harness.composerValue()).toBe('held chord draft')
    } finally {
      view.unmount()
    }
  })

  it('lets a held-down NEWLINE gesture keep its native line break', async () => {
    // The repeat guard must not outrank the newline decision: holding
    // Shift+Enter (either mode) or the bare Enter of 'mod-enter' mode has to
    // keep inserting line breaks — one is what a consumed repeat would leave.
    const cases: Array<[string, string, PressInit]> = [
      ['enter mode: held Shift+Enter', 'enter', { shift: true, repeat: true }],
      ['mod-enter mode: held bare Enter', 'mod-enter', { repeat: true }],
      ['mod-enter mode: held Shift+Enter', 'mod-enter', { shift: true, repeat: true }],
    ]
    for (const [label, mode, init] of cases) {
      harness.extraProps.submitKey = mode
      const { view, field } = await mountWithDraft(harness, 'held newline')
      try {
        const before = promptCount(harness)
        const event = pressEnter(field, init)
        await harness.flush(2)
        expect.soft(promptCount(harness), `${label}: a repeated newline gesture never sends`).toBe(before)
        expect.soft(
          event.defaultPrevented,
          `${label}: a repeated newline gesture keeps its native line break`,
        ).toBe(false)
        expect.soft(harness.composerValue(), `${label}: the draft survives`).toBe('held newline')
      } finally {
        view.unmount()
      }
    }
  })

  it('leaves a 229 Enter to the input method: no submit AND no consumption', async () => {
    const { view, field } = await mountWithDraft(harness, 'nihao')
    try {
      const event = pressEnter(field, { keyCode: 229 })
      await harness.flush(2)
      expect(promptCount(harness), 'a 229 Enter never submits').toBe(0)
      expect(
        event.defaultPrevented,
        'a 229 Enter is the IME\'s (and the layout switcher\'s): consuming it would fight the candidate picker',
      ).toBe(false)
      expect(harness.composerValue()).toBe('nihao')
    } finally {
      view.unmount()
    }
  })
})

describe('composer guard does not swallow the real gestures', () => {
  it('still submits a plain Enter in enter mode and a Cmd+Enter in mod-enter mode', async () => {
    const first = await mountWithDraft(harness, 'first message')
    try {
      const event = pressEnter(first.field)
      await harness.flush(2)
      expect(event.defaultPrevented, 'the submit gesture is consumed').toBe(true)
      expect(harness.promptCalls, 'a plain Enter sends exactly once').toEqual([
        { childId: 't1', text: 'first message' },
      ])
    } finally {
      first.view.unmount()
    }

    harness.extraProps.submitKey = 'mod-enter'
    const second = await mountWithDraft(harness, 'second message')
    try {
      // A bare Enter in this mode is a newline, not a send.
      const bare = pressEnter(second.field)
      await harness.flush(2)
      expect(bare.defaultPrevented, 'a bare Enter keeps its newline in mod-enter mode').toBe(false)
      expect(promptCount(harness), 'a bare Enter never sends in mod-enter mode').toBe(1)

      const chord = pressEnter(second.field, { meta: true })
      await harness.flush(2)
      expect(chord.defaultPrevented, 'the Cmd+Enter submit chord is consumed').toBe(true)
      expect(harness.promptCalls.at(-1), 'Cmd+Enter sends the draft').toEqual({ childId: 't1', text: 'second message' })
    } finally {
      second.view.unmount()
    }
  })

  it('keeps the native line break on a bare Shift+Enter', async () => {
    const { view, field } = await mountWithDraft(harness, 'line one')
    try {
      const event = pressEnter(field, { shift: true })
      await harness.flush(2)
      expect(promptCount(harness), 'Shift+Enter never submits').toBe(0)
      expect(event.defaultPrevented, 'Shift+Enter keeps the textarea\'s newline').toBe(false)
      expect(harness.composerValue()).toBe('line one')
    } finally {
      view.unmount()
    }
  })
})
