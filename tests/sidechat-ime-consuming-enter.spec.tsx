// @vitest-environment jsdom
/**
 * The IME guard's CONSUMPTION side: an Enter that closes a composition must
 * neither submit NOR leave a newline behind.
 *
 * CONTRACT PINNED HERE:
 *
 * - A keydown that arrives inside the composition-end grace window (the
 *   composition is no longer live, `compositionend` fired less than 10 ms ago,
 *   and the event carries no composition flag — Safari's late closing keydown)
 *   is CONSUMED: `sidechat.prompt` is never issued AND the event is
 *   `preventDefault()`ed, so the textarea inserts no line break. The host's own
 *   composer swallows the same Enter ("neither submit nor break the line").
 * - A keydown that belongs to a LIVE composition stays the input method's: it
 *   is not submitted and NOT consumed (the browser/IME owns the gesture, and
 *   `preventDefault()` there would fight the candidate picker).
 * - `Shift+Enter` keeps its native line break even inside the grace window
 *   (the host's keymap checks Shift before the composition guard).
 *
 * Freezing `Date` makes "inside the 10 ms window" a fact rather than a race.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'
import type { RenderedRoot } from './test-utils.ts'

/** The composer's textarea in a mounted view. */
function composerField(view: RenderedRoot): HTMLTextAreaElement {
  const field = view.container.querySelector('textarea')
  if (field === null) throw new Error('the composer textarea is missing')
  return field
}

/**
 * Dispatch one Enter keydown at the composer.
 * @param field - the composer textarea.
 * @param init - the composition flag / IME key code the engine reports.
 * @returns the dispatched event (`defaultPrevented` = "the gesture was
 *   consumed, so no newline is inserted").
 */
function pressEnter(field: HTMLTextAreaElement, init: { isComposing?: boolean, keyCode?: number, shift?: boolean } = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    bubbles: true,
    cancelable: true,
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

/** Dispatch one composition event at the composer. */
function composition(field: HTMLTextAreaElement, type: 'compositionstart' | 'compositionend'): void {
  act(() => { field.dispatchEvent(new CompositionEvent(type, { bubbles: true })) })
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
  vi.useRealTimers()
})

describe('composer IME guard — consumption of the composition-closing Enter', () => {
  it('consumes the Enter that closes a composition without submitting', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const view = harness.mount()
    await harness.flush()
    harness.typeComposer('nihaoma')
    const field = composerField(view)

    // The IME commits, then the engine delivers the closing keydown (Safari).
    composition(field, 'compositionend')
    const event = pressEnter(field, { isComposing: false })
    await harness.flush()

    expect(harness.promptCalls, 'the closing Enter must never submit').toEqual([])
    expect(event.defaultPrevented, 'the closing Enter must not leave a newline behind').toBe(true)
    expect(harness.composerValue(), 'the draft survives').toBe('nihaoma')
    view.unmount()
  })

  it('leaves a LIVE composition Enter to the input method (no submit, no consumption)', async () => {
    const view = harness.mount()
    await harness.flush()
    harness.typeComposer('nihao')
    const field = composerField(view)

    composition(field, 'compositionstart')
    const flagged = pressEnter(field, { isComposing: true })
    const unflagged = pressEnter(field, { isComposing: false })
    await harness.flush()

    expect(harness.promptCalls, 'no composition key may submit').toEqual([])
    expect(flagged.defaultPrevented, 'the IME owns a flagged composition Enter').toBe(false)
    expect(unflagged.defaultPrevented, 'the live composition flag alone also leaves the gesture to the IME').toBe(false)
    expect(harness.composerValue()).toBe('nihao')
    view.unmount()
  })

  it('keeps the native line break on Shift+Enter inside the grace window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const view = harness.mount()
    await harness.flush()
    harness.typeComposer('line one')
    const field = composerField(view)

    composition(field, 'compositionend')
    const event = pressEnter(field, { isComposing: false, shift: true })
    await harness.flush()

    expect(harness.promptCalls, 'Shift+Enter never submits').toEqual([])
    expect(event.defaultPrevented, 'Shift+Enter keeps its native newline even while closing').toBe(false)
    view.unmount()
  })
})
