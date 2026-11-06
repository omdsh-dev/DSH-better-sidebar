// @vitest-environment jsdom
/**
 * Side-chat composer keymap parity: the submit-key contract and the IME guard.
 *
 * CONTRACT PINNED HERE (the implementation is expected to match it):
 *
 * 1. The view takes one optional config prop —
 *
 *      submitKey?: 'enter' | 'mod-enter'      // default 'enter'
 *
 *    `'enter'` (the default, upstream semantics): a plain `Enter` submits and
 *    the gesture is CONSUMED (`preventDefault()`, no newline). `Shift+Enter`
 *    never submits and is left to the browser (native newline).
 *    `'mod-enter'`: exactly `Cmd+Enter` (metaKey) or `Ctrl+Enter` submits;
 *    a bare `Enter` and `Shift+Enter` insert a newline and never submit
 *    (neither is `preventDefault()`ed). `Shift+Enter` never submits in
 *    either mode.
 *
 * 2. The IME guard follows the host keymap's semantics
 *    (`packages/client/ui-conversation/src/client/input/editor/keymap.ts:40-81`):
 *    a keydown that belongs to a composition must never submit. Three signals:
 *    `isComposing === true`, the legacy `keyCode === 229` (engines that report
 *    229 with `isComposing === false`), and a 10 ms grace window after
 *    `compositionend` (Safari delivers the composition-closing keydown AFTER
 *    compositionend). The grace window is measured against `Date.now()`
 *    (the host's own basis) or a timer — this spec advances BOTH, so either
 *    implementation satisfies it.
 *
 * Every write goes through the real `sidechat.prompt` wire route: a keyboard
 * gesture "submits" exactly when that request is issued.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'
import type { RenderedRoot } from './test-utils.ts'

/** The modifiers/signals one synthesized Enter can carry. */
interface PressInit {
  meta?: boolean
  ctrl?: boolean
  shift?: boolean
  /** The engine's `KeyboardEvent#isComposing` flag. */
  isComposing?: boolean
  /** The legacy IME key code (229 while an engine hides composition). */
  keyCode?: number
}

/** The composer's textarea in a mounted view. */
function composerField(view: RenderedRoot): HTMLTextAreaElement {
  const field = view.container.querySelector('textarea')
  if (field === null) throw new Error('the composer textarea is missing')
  return field
}

/**
 * Dispatch one real Enter keydown at the composer. `keyCode`/`isComposing` are
 * not constructor options in jsdom, so they are defined on the event the way
 * tests/ime-guard.spec.ts does it.
 * @param field - the composer textarea.
 * @param init - modifiers and the IME signals to carry.
 * @returns the dispatched event (its `defaultPrevented` is the "was the
 *   gesture consumed" answer: an unconsumed Enter lets the browser insert the
 *   newline).
 */
function pressEnter(field: HTMLTextAreaElement, init: PressInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    bubbles: true,
    cancelable: true,
    metaKey: init.meta === true,
    ctrlKey: init.ctrl === true,
    shiftKey: init.shift === true,
  })
  if (init.isComposing !== undefined) {
    Object.defineProperty(event, 'isComposing', { value: init.isComposing })
  }
  if (init.keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  }
  act(() => { field.dispatchEvent(event) })
  return event
}

/** The text of every prompt the composer submitted (one entry per send). */
function sentTexts(harness: SidechatHarness): unknown[] {
  return harness.promptCalls.map(call => call.text)
}

let harness: SidechatHarness

beforeEach(() => {
  harness = installSidechatHarness({
    events: [
      { type: 'session/end-seed', seq: 0, time: 0, data: {} },
      { type: 'user/message', seq: 1, time: 1_000, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
      { type: 'turn/start', seq: 2, time: 2_000, data: { turn: 1 } },
      { type: 'turn/end', seq: 3, time: 3_000, data: { turn: 1, reason: 'completed' } },
    ],
  })
})

afterEach(() => {
  harness.cleanup()
  vi.useRealTimers()
})

describe('composer submit key — default (Enter submits)', () => {
  it('submits on a plain Enter and consumes the gesture', async () => {
    const view = harness.mount()
    await harness.flush()
    harness.typeComposer('send me')

    const event = pressEnter(composerField(view))
    await harness.flush()

    expect(sentTexts(harness), 'a plain Enter must submit by default').toEqual(['send me'])
    // Consumed: an unconsumed Enter would ALSO insert a newline into the field.
    expect(event.defaultPrevented, 'the submitting Enter must not leave a newline behind').toBe(true)
    expect(harness.composerValue(), 'the sent draft is cleared').toBe('')
    view.unmount()
  })

  it('never submits on Shift+Enter and leaves the newline to the browser', async () => {
    const view = harness.mount()
    await harness.flush()
    harness.typeComposer('first line')

    const event = pressEnter(composerField(view), { shift: true })
    await harness.flush()

    expect(sentTexts(harness), 'Shift+Enter must never submit').toEqual([])
    // Not consumed → the textarea's native line break happens.
    expect(event.defaultPrevented, 'Shift+Enter must keep its native newline').toBe(false)
    expect(harness.composerValue(), 'the draft survives a Shift+Enter').toBe('first line')
    view.unmount()
  })
})

describe("composer submit key — 'mod-enter' (Cmd/Ctrl+Enter submits)", () => {
  beforeEach(() => {
    harness.extraProps.submitKey = 'mod-enter'
  })

  it('submits on Cmd+Enter', async () => {
    const view = harness.mount()
    await harness.flush()
    harness.typeComposer('mac send')

    const event = pressEnter(composerField(view), { meta: true })
    await harness.flush()

    expect(sentTexts(harness), 'Cmd+Enter must submit in mod-enter mode').toEqual(['mac send'])
    expect(event.defaultPrevented, 'a submitting chord must not also insert a newline').toBe(true)
    view.unmount()
  })

  it('submits on Ctrl+Enter', async () => {
    const view = harness.mount()
    await harness.flush()
    harness.typeComposer('pc send')

    pressEnter(composerField(view), { ctrl: true })
    await harness.flush()

    expect(sentTexts(harness), 'Ctrl+Enter must submit in mod-enter mode').toEqual(['pc send'])
    view.unmount()
  })

  it('inserts a newline on a bare Enter instead of submitting', async () => {
    const view = harness.mount()
    await harness.flush()
    harness.typeComposer('line one')

    const event = pressEnter(composerField(view))
    await harness.flush()

    expect(sentTexts(harness), 'a bare Enter must not submit in mod-enter mode').toEqual([])
    expect(event.defaultPrevented, 'a bare Enter must keep its native newline').toBe(false)
    expect(harness.composerValue(), 'the draft survives the newline').toBe('line one')
    view.unmount()
  })

  it('never submits on Shift+Enter', async () => {
    const view = harness.mount()
    await harness.flush()
    harness.typeComposer('line one')

    const event = pressEnter(composerField(view), { shift: true })
    await harness.flush()

    expect(sentTexts(harness), 'Shift+Enter must never submit, in any mode').toEqual([])
    expect(event.defaultPrevented, 'Shift+Enter keeps its native newline').toBe(false)
    view.unmount()
  })
})

describe('composer IME guard (composition keys never submit)', () => {
  it('does not submit while isComposing is set', async () => {
    const view = harness.mount()
    await harness.flush()
    harness.typeComposer('nihao')

    pressEnter(composerField(view), { isComposing: true })
    await harness.flush()

    expect(sentTexts(harness), 'an Enter that belongs to the IME must not submit').toEqual([])
    view.unmount()
  })

  it('does not submit on a legacy keyCode 229 Enter outside a flagged composition', async () => {
    const view = harness.mount()
    await harness.flush()
    harness.typeComposer('nihao')

    // The legacy signal: engines emit 229 with isComposing === false.
    pressEnter(composerField(view), { isComposing: false, keyCode: 229 })
    await harness.flush()

    expect(sentTexts(harness), 'a keyCode 229 Enter must never submit').toEqual([])
    view.unmount()
  })

  it('does not submit on Cmd+Enter while composing (the guard outranks the chord)', async () => {
    harness.extraProps.submitKey = 'mod-enter'
    const view = harness.mount()
    await harness.flush()
    harness.typeComposer('nihao')

    pressEnter(composerField(view), { meta: true, isComposing: true })
    await harness.flush()

    expect(sentTexts(harness), 'no submit gesture may fire while the IME owns the keys').toEqual([])
    view.unmount()
  })

  it('does not submit on the Enter that closes a composition (Safari late keydown)', async () => {
    // Freeze Date so "inside the 10 ms window" is a fact, not a race.
    vi.useFakeTimers({ toFake: ['Date'] })
    const view = harness.mount()
    await harness.flush()
    harness.typeComposer('nihaoma')
    const field = composerField(view)

    // The IME commits (compositionend) and THEN the engine delivers the
    // composition-closing keydown.
    act(() => { field.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })) })
    pressEnter(field, { isComposing: false })
    await harness.flush()

    expect(sentTexts(harness), 'the Enter that ends a composition must be swallowed').toEqual([])
    view.unmount()
  })

  it('submits again once the composition-end grace window has expired', async () => {
    // The control for the case above: the guard must not wedge the composer.
    vi.useFakeTimers({ toFake: ['Date'] })
    const view = harness.mount()
    await harness.flush()
    harness.typeComposer('nihaoma')
    const field = composerField(view)
    act(() => { field.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })) })

    // Past 10 ms on BOTH bases a guard can use: the faked clock (Date.now())
    // and real elapsed time (a setTimeout-based window).
    vi.setSystemTime(Date.now() + 1_000)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })

    harness.typeComposer('nihaoma ok')
    pressEnter(field)
    await harness.flush()

    expect(sentTexts(harness), 'a later Enter must submit normally').toEqual(['nihaoma ok'])
    view.unmount()
  })
})
