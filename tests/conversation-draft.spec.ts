/**
 * conversation-draft spec — the caret-resolved composer insertion (upstream
 * issue #425 ②). `insertAtCaret` is pure string math (splice with
 * whitespace-aware joins); `probeComposerCaret` reads the live composer
 * `<textarea>` selection out of the DOM, guarded by a value-sync check so a
 * stale or wrong-composer caret is never applied; `placeComposerCaretAfterInsert`
 * restores the caret right after the inserted text once the setDraft value
 * commit lands, keeping stacked inserts at their running position.
 *
 * The chip path is covered too: `chipTextAt` derives the chip's own draft text
 * from that same splice, so `insertSelectionReference` composes a draft — and a
 * serialized prompt — identical to the plain-text insert it replaced.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import {
  appendToDraft,
  chipTextAt,
  insertAtCaret,
  insertSelectionReference,
  placeComposerCaretAfterInsert,
  probeComposerCaret,
} from '../src/client/conversation-draft.ts'

/**
 * Mount a fake composer textarea inside the DSH conversation column
 * (`#root [data-slot="conversation"] textarea[data-phase]`).
 */
function mountComposer(draft: string, selectionStart: number, selectionEnd: number): HTMLTextAreaElement {
  const root = document.createElement('div')
  root.id = 'root'
  const column = document.createElement('div')
  column.setAttribute('data-slot', 'conversation')
  const textarea = document.createElement('textarea')
  textarea.setAttribute('data-phase', 'plain')
  textarea.value = draft
  textarea.setSelectionRange(selectionStart, selectionEnd)
  column.append(textarea)
  root.append(column)
  document.body.append(root)
  return textarea
}

afterEach(() => {
  document.body.innerHTML = ''
})

/** Let the scheduled caret placement (rAF or setTimeout fallback) settle. */
const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 30) })

describe('probeComposerCaret', () => {
  it('returns the textarea selection when the DOM is in sync with the draft', () => {
    mountComposer('hello world', 5, 5)
    expect(probeComposerCaret('hello world')).toEqual({ start: 5, end: 5 })
  })

  it('reports a live selection range, not just a collapsed caret', () => {
    mountComposer('hello world', 6, 11)
    expect(probeComposerCaret('hello world')).toEqual({ start: 6, end: 11 })
  })

  it('returns null when no composer is mounted', () => {
    expect(document.querySelector('textarea')).toBeNull()
    expect(probeComposerCaret('anything')).toBeNull()
  })

  it('returns null when the composer DOM value is out of sync with the store draft', () => {
    mountComposer('hello', 0, 0)
    expect(probeComposerCaret('hello changed on the server')).toBeNull()
  })

  it('returns null for a disabled composer', () => {
    const input = mountComposer('hello', 2, 2)
    input.disabled = true
    expect(probeComposerCaret('hello')).toBeNull()
  })

  it('returns null for a read-only composer', () => {
    const input = mountComposer('hello', 2, 2)
    input.readOnly = true
    expect(probeComposerCaret('hello')).toBeNull()
  })

  it('clamps out-of-range selections into the draft bounds', () => {
    const input = mountComposer('hi', 0, 0)
    // Direct property writes (jsdom does not enforce bounds like browsers).
    input.selectionStart = 5
    input.selectionEnd = 9
    expect(probeComposerCaret('hi')).toEqual({ start: 2, end: 2 })
  })
})

describe('insertAtCaret', () => {
  it('appends at the end when the caret is unknown (pre-fix behavior)', () => {
    expect(insertAtCaret('', 'X', null)).toBe('X')
    expect(insertAtCaret('hello', 'X', null)).toBe('hello X')
    expect(insertAtCaret('   ', 'X', null)).toBe('X')
  })

  it('inserts at the caret in the middle of a sentence with one space each side', () => {
    expect(insertAtCaret('hello world', 'CODE', { start: 5, end: 5 })).toBe('hello CODE world')
  })

  it('only adds the separating spaces the neighbors actually need', () => {
    expect(insertAtCaret('one two', 'CODE', { start: 3, end: 3 })).toBe('one CODE two')
    // Doubled gap, caret right after the word: the leading space is added,
    // the two after the caret stay untouched (like typing in the gap).
    expect(insertAtCaret('one  two', 'CODE', { start: 3, end: 3 })).toBe('one CODE  two')
    // Doubled gap, caret on the second space: neither side needs a new
    // space, both originals flank the insertion.
    expect(insertAtCaret('one  two', 'CODE', { start: 4, end: 4 })).toBe('one CODE two')
    expect(insertAtCaret('one two ', 'CODE', { start: 8, end: 8 })).toBe('one two CODE')
  })

  it('inserts at the start without a leading space', () => {
    expect(insertAtCaret('hello', 'CODE', { start: 0, end: 0 })).toBe('CODE hello')
  })

  it('inserts at the end with a single trailing space', () => {
    expect(insertAtCaret('hello', 'CODE', { start: 5, end: 5 })).toBe('hello CODE')
  })

  it('replaces the live selection', () => {
    expect(insertAtCaret('a little tale', 'CODE', { start: 2, end: 8 })).toBe('a CODE tale')
  })

  it('replaces a selection surrounded by words with single-space joins', () => {
    expect(insertAtCaret('abc def ghi', 'CODE', { start: 4, end: 7 })).toBe('abc CODE ghi')
  })

  it('replaces a selection spanning the whole draft', () => {
    expect(insertAtCaret('old', 'CODE', { start: 0, end: 3 })).toBe('CODE')
  })

  it('handles an empty draft with a resolved caret', () => {
    expect(insertAtCaret('', 'CODE', { start: 0, end: 0 })).toBe('CODE')
  })
})

describe('placeComposerCaretAfterInsert', () => {
  it('places the caret right after the inserted text once the value commits', async () => {
    const input = mountComposer('AB', 1, 1) // pre-insert draft still shown
    placeComposerCaretAfterInsert('A C B', 1 + 1)
    input.value = 'A C B' // the setDraft commit lands
    await tick()
    expect(input.selectionStart).toBe(2)
    expect(input.selectionEnd).toBe(2)
  })

  it('places the caret when the value already matches (no commit needed)', async () => {
    const input = mountComposer('A C B', 0, 0)
    placeComposerCaretAfterInsert('A C B', 2)
    await tick()
    expect(input.selectionStart).toBe(2)
  })

  it('clamps an out-of-range caret into the composer bounds', async () => {
    const input = mountComposer('A C B', 0, 0)
    placeComposerCaretAfterInsert('A C B', 99)
    await tick()
    expect(input.selectionStart).toBe(5)
  })

  it('does not clobber a composer that never matches the expected draft', async () => {
    const input = mountComposer('OLD', 0, 0)
    input.value = 'UNRELATED' // a competing update wins the race
    input.setSelectionRange(1, 1)
    placeComposerCaretAfterInsert('NEW DRAFT', 2)
    await tick()
    expect(input.selectionStart).toBe(1)
  })

  it('leaves the caret alone when no composer is mounted', async () => {
    placeComposerCaretAfterInsert('X', 0)
    await tick() // must not throw
    expect(document.querySelector('textarea')).toBeNull()
  })
})

describe('appendToDraft', () => {
  /** A fake ctx exposing the conversation service face appendToDraft uses. */
  function fakeCtx(
    getDraft: () => string,
    onSet: (next: string) => void,
    withConversation = true,
  ): Context {
    const input = {
      state: { getSnapshot: (): { draft: string } => ({ draft: getDraft() }) },
      setDraft: (next: string): void => { onSet(next) },
    }
    return {
      sessions: { scope: (): unknown => ({}) },
      get: (name: string): unknown =>
        withConversation && name === 'conversation'
          ? { input: { for: (): unknown => input } }
          : undefined,
    } as unknown as Context
  }

  it('splices at the probed caret and restores the caret right after the insert', async () => {
    const composer = mountComposer('AB', 1, 1)
    const calls: string[] = []
    const ctx = fakeCtx(() => 'AB', (next) => { calls.push(next); composer.value = next })
    expect(appendToDraft(ctx, 's1', 'C')).toBe(true)
    expect(calls).toEqual(['A C B'])
    await tick()
    // 'A C| B' — the caret sits right after the inserted text (the left
    // separating space shifts it past `start + text.length`).
    expect(composer.selectionStart).toBe(3)
    expect(composer.selectionEnd).toBe(3)
  })

  it('appends and places the caret at the end when the caret is unknown', async () => {
    const composer = mountComposer('hi', 0, 0)
    composer.value = 'hi changed' // out of sync → caret unresolved → append
    const calls: string[] = []
    const ctx = fakeCtx(() => 'hi', (next) => { calls.push(next); composer.value = next })
    appendToDraft(ctx, 's1', 'X')
    expect(calls).toEqual(['hi X'])
    await tick()
    expect(composer.selectionStart).toBe(4)
  })

  it('keeps stacked inserts at the running caret (A|B + C + D → ACD|B)', async () => {
    const composer = mountComposer('AB', 1, 1)
    let draft = 'AB'
    const ctx = fakeCtx(() => draft, (next) => { draft = next; composer.value = next })
    appendToDraft(ctx, 's1', 'C')
    await tick()
    expect(draft).toBe('A C B')
    expect(composer.selectionStart).toBe(3) // A C| B
    appendToDraft(ctx, 's1', 'D')
    await tick()
    expect(draft).toBe('A C D B')
    expect(composer.selectionStart).toBe(5) // A C D| B
  })

  it('returns false and logs when the conversation service is unavailable', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const ctx = fakeCtx(() => '', (): void => undefined, false)
    expect(appendToDraft(ctx, 's1', 'X')).toBe(false)
    expect(consoleWarn).toHaveBeenCalledTimes(1)
    consoleWarn.mockRestore()
  })
})

describe('chipTextAt', () => {
  it('adds only the separating spaces the neighbors actually need', () => {
    // Between two words: the left gap needs one, the right one is already there.
    expect(chipTextAt('hello world', 'CODE', { start: 5, end: 5 })).toBe(' CODE')
    // At the draft head: only the right side needs one.
    expect(chipTextAt('hello', 'CODE', { start: 0, end: 0 })).toBe('CODE ')
    // Inside a word: both sides need one.
    expect(chipTextAt('onetwo', 'CODE', { start: 3, end: 3 })).toBe(' CODE ')
    // An empty draft takes the bare payload.
    expect(chipTextAt('', 'CODE', { start: 0, end: 0 })).toBe('CODE')
  })

  it('replaces a live selection through the same joins', () => {
    expect(chipTextAt('a little tale', 'CODE', { start: 2, end: 8 })).toBe('CODE')
    // A selection of the separating space itself re-earns both joins.
    expect(chipTextAt('ab cd', 'CODE', { start: 2, end: 3 })).toBe(' CODE ')
  })

  it('appends with the leading space when the caret is unknown', () => {
    expect(chipTextAt('hello', 'CODE', null)).toBe(' CODE')
    // A whitespace-only draft is dropped, so the chip carries the payload alone.
    expect(chipTextAt('   ', 'CODE', null)).toBe('CODE')
  })

  it('splices back to exactly the plain-text draft at the same caret', () => {
    // Every shape except an all-whitespace draft: there the plain-text splice
    // dropped the blank draft outright, while a chip insert only owns its own
    // span and leaves the blanks in front of it (the host trims the submitted
    // prompt, so the model receives the same text either way).
    const cases: { draft: string; caret: { start: number; end: number } | null }[] = [
      { draft: 'AB', caret: { start: 1, end: 1 } },
      { draft: 'one  two', caret: { start: 3, end: 3 } },
      { draft: 'a little tale', caret: { start: 2, end: 8 } },
      { draft: '', caret: { start: 0, end: 0 } },
      { draft: 'hello', caret: null },
    ]
    for (const { draft, caret } of cases) {
      const chip = chipTextAt(draft, 'CODE', caret)
      const start = caret === null ? draft.length : caret.start
      const end = caret === null ? draft.length : caret.end
      expect(draft.slice(0, start) + chip + draft.slice(end)).toBe(
        insertAtCaret(draft, 'CODE', caret),
      )
    }
  })
})

describe('insertSelectionReference', () => {
  /** The composer's structured-reference insert event, as the fake machine sees it. */
  interface ChipEvent {
    name: string
    reference: {
      source: string
      label: string
      appearance?: string
      clipboardText: string
      ref: string
    }
    span: { draftRev: number; start: number; end: number }
  }

  /**
   * A fake ctx whose scope `emit` applies the chip the way the input machine
   * does: the draft takes the chip's `clipboardText` at the event's span and
   * the revision bumps — that bump is the span-CAS success signal. `rev` of
   * null models a machine that exposes no revision at all.
   */
  function fakeChipCtx(
    initial: string,
    rev: number | null = 1,
  ): { ctx: Context; events: ChipEvent[]; draft: () => string } {
    let draft = initial
    let draftRev: number | undefined = rev === null ? undefined : rev
    const events: ChipEvent[] = []
    const actx = {
      emit: (name: string, payload: Omit<ChipEvent, 'name'>): void => {
        events.push({ name, ...payload })
        draft = draft.slice(0, payload.span.start) + payload.reference.clipboardText + draft.slice(payload.span.end)
        draftRev = (draftRev ?? 0) + 1
      },
    }
    const input = {
      state: { getSnapshot: (): { draft: string; draftRev: number | undefined } => ({ draft, draftRev }) },
      setDraft: (): void => undefined,
    }
    const ctx = {
      sessions: { scope: () => actx },
      get: (name: string): unknown =>
        name === 'conversation' ? { input: { for: () => input } } : undefined,
    } as unknown as Context
    return { ctx, events, draft: () => draft }
  }

  const insert = { label: 'a.ts:2-4', text: '```a.ts:2-4\nconst x = 1\n```' }

  it('mints one file-appearance chip whose ref is the fenced payload', () => {
    const { ctx, events, draft } = fakeChipCtx('')
    expect(insertSelectionReference(ctx, 's1', insert)).toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0]!.name).toBe('slash/input-insert-reference')
    expect(events[0]!.reference).toEqual({
      source: 'reference',
      label: 'a.ts:2-4',
      appearance: 'file',
      clipboardText: insert.text,
      ref: insert.text,
    })
    expect(events[0]!.span).toEqual({ draftRev: 1, start: 0, end: 0 })
    expect(draft()).toBe(insert.text)
  })

  it('keeps the draft and the chip-serialized prompt equal to the plain-text insert', () => {
    mountComposer('AB', 1, 1)
    const { ctx, events, draft } = fakeChipCtx('AB')
    insertSelectionReference(ctx, 's1', insert)
    const caret = { start: 1, end: 1 }
    expect(draft()).toBe(insertAtCaret('AB', insert.text, caret))
    // What the model receives: the draft with the chip's span replaced by the
    // ref the `reference` source serializes (the identity).
    const event = events[0]!
    const model =
      draft().slice(0, event.span.start) +
      event.reference.ref +
      draft().slice(event.span.start + event.reference.clipboardText.length)
    expect(model).toBe(insertAtCaret('AB', insert.text, caret))
  })

  it('replaces the live selection at the probed caret', () => {
    mountComposer('a little tale', 2, 8)
    const { ctx, events, draft } = fakeChipCtx('a little tale')
    insertSelectionReference(ctx, 's1', { label: 'a.md:1', text: 'CODE' })
    expect(events[0]!.span).toEqual({ draftRev: 1, start: 2, end: 8 })
    expect(draft()).toBe(insertAtCaret('a little tale', 'CODE', { start: 2, end: 8 }))
  })

  it('appends at the end when the caret cannot be probed', () => {
    const { ctx, events, draft } = fakeChipCtx('hello')
    expect(insertSelectionReference(ctx, 's1', { label: 'a.md', text: 'CODE' })).toBe(true)
    expect(events[0]!.span).toEqual({ draftRev: 1, start: 5, end: 5 })
    expect(draft()).toBe('hello CODE')
  })

  it('returns false without emitting when the machine has no draftRev', () => {
    const { ctx, events } = fakeChipCtx('hello', null)
    expect(insertSelectionReference(ctx, 's1', insert)).toBe(false)
    expect(events).toEqual([])
  })

  it('returns false when the session scope or the conversation service is unavailable', () => {
    const noScope = {
      sessions: { scope: (): undefined => undefined },
      get: (): undefined => undefined,
    } as unknown as Context
    expect(insertSelectionReference(noScope, 's1', insert)).toBe(false)
    const noConversation = {
      sessions: { scope: (): unknown => ({}) },
      get: (): undefined => undefined,
    } as unknown as Context
    expect(insertSelectionReference(noConversation, 's1', insert)).toBe(false)
  })

  it('returns false and logs when the insert event throws', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const ctx = {
      sessions: { scope: () => ({ emit: (): void => { throw new Error('boom') } }) },
      get: () => ({ input: { for: () => ({ state: { getSnapshot: () => ({ draft: '', draftRev: 1 }) } }) } }),
    } as unknown as Context
    expect(insertSelectionReference(ctx, 's1', insert)).toBe(false)
    expect(consoleWarn).toHaveBeenCalledTimes(1)
    consoleWarn.mockRestore()
  })
})