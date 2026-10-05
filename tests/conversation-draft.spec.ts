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
  CHIP_PLACEHOLDER,
  appendToDraft,
  chipTextAt,
  foldClipboardOffset,
  insertAtCaret,
  insertFileReference,
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

/** One insert event, as the fake machine received it. */
interface InsertEvent {
  name: string
  /** Present on `slash/input-insert-reference`. */
  reference?: {
    source: string
    label: string
    appearance?: string
    clipboardText: string
    ref: string
  }
  /** Present on `slash/input-insert-text`. */
  text?: string
  span: { draftRev: number; start: number; end: number }
}

/** A chip's footprint in the draft, in clipboard-projection coordinates. */
interface ChipOccurrence {
  offset: number
  length: number
}

/**
 * A fake ctx whose scope `bail` applies an insert the way the input machine
 * does. It keeps *both* projections the real machine keeps: the event span
 * addresses the editor plane, where a chip is one placeholder character,
 * while `draft` reports the clipboard plane, where the chip is its whole
 * `clipboardText`. Modelling only one plane is how the second-insert bug
 * shipped green — here the span has to be folded to be accepted, exactly as
 * on the host. `rev` of null models a machine that exposes no revision.
 */
function fakeChipCtx(
  initial: string,
  rev: number | null = 1,
): {
  ctx: Context
  events: InsertEvent[]
  draft: () => string
  detect: () => string
  occurrences: () => ChipOccurrence[]
  setDraftCalls: () => number
  setPhase: (next: string) => void
} {
  let clipboard = initial
  let detect = initial
  let chips: ChipOccurrence[] = []
  let draftRev: number | undefined = rev === null ? undefined : rev
  let phase = 'plain'
  let setDraftCount = 0
  const events: InsertEvent[] = []

  /** Detect offset → clipboard offset; a span never splits a chip. */
  const toClipboard = (offset: number): number => {
    const before = detect.slice(0, offset).split(CHIP_PLACEHOLDER).length - 1
    return offset + chips.slice(0, before).reduce((sum, chip) => sum + chip.length - 1, 0)
  }

  const accepted = (span: InsertEvent['span']): boolean =>
    draftRev !== undefined && span.draftRev === draftRev && span.end <= detect.length

  /** Replace one detect span with `[chip, separator?]` (the host's rule). */
  const applyReference = (event: InsertEvent): void => {
    const reference = event.reference!
    // The host appends its own separating space unless one is already next.
    const separator = detect.slice(event.span.end, event.span.end + 1) === ' ' ? '' : ' '
    const start = toClipboard(event.span.start)
    const end = toClipboard(event.span.end)
    const delta = reference.clipboardText.length + separator.length - (end - start)
    chips = chips
      .filter((chip) => chip.offset + chip.length <= start)
      .concat({ offset: start, length: reference.clipboardText.length })
      .concat(
        chips
          .filter((chip) => chip.offset >= end)
          .map((chip) => ({ ...chip, offset: chip.offset + delta })),
      )
    clipboard = clipboard.slice(0, start) + reference.clipboardText + separator + clipboard.slice(end)
    detect = detect.slice(0, event.span.start) + CHIP_PLACEHOLDER + separator + detect.slice(event.span.end)
    draftRev = (draftRev ?? 0) + 1
  }

  /** Replace one detect span with plain text (no chip node). */
  const applyText = (event: InsertEvent): void => {
    const text = event.text!
    const start = toClipboard(event.span.start)
    const end = toClipboard(event.span.end)
    const delta = text.length - (end - start)
    chips = chips.map((chip) =>
      chip.offset >= start ? { ...chip, offset: chip.offset + delta } : chip,
    )
    clipboard = clipboard.slice(0, start) + text + clipboard.slice(end)
    detect = detect.slice(0, event.span.start) + text + detect.slice(event.span.end)
    draftRev = (draftRev ?? 0) + 1
  }

  const actx = {
    /**
     * `subject` is the session-scope Context the real dispatcher needs:
     * cordis applies a scope's listener filter only when the dispatch subject
     * is an object, so an insert that drops it would reach *every* mounted
     * composer (their revision counters all start at 0, so the span CAS would
     * not catch it).
     */
    bail(subject: unknown, name: string, payload: Omit<InsertEvent, 'name'>): unknown {
      if (subject !== actx) throw new Error('the insert must carry its own session scope')
      events.push({ name, ...payload })
      if (!accepted(payload.span)) return undefined
      const event = { name, ...payload }
      if (name === 'slash/input-insert-reference') applyReference(event)
      else applyText(event)
      return true
    },
  }
  const input = {
    state: {
      getSnapshot: (): {
        draft: string
        draftRev: number | undefined
        occurrences: ChipOccurrence[]
        phase: string
      } => ({ draft: clipboard, draftRev, occurrences: chips, phase }),
    },
    setDraft: (): void => {
      setDraftCount += 1
    },
  }
  const ctx = {
    sessions: { scope: () => actx },
    get: (name: string): unknown =>
      name === 'conversation' ? { input: { for: () => input } } : undefined,
  } as unknown as Context
  return {
    ctx,
    events,
    draft: () => clipboard,
    detect: () => detect,
    occurrences: () => chips,
    setDraftCalls: () => setDraftCount,
    setPhase: (next: string) => {
      phase = next
    },
  }
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

  it('refuses to write into a frozen composer on the chipless path too', () => {
    const { ctx, draft, setDraftCalls, setPhase } = fakeChipCtx('hello')
    setPhase('submitting')
    expect(appendToDraft(ctx, 's1', 'tail')).toBe(false)
    expect(setDraftCalls()).toBe(0)
    expect(draft()).toBe('hello')
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
    // The chip's own text is the payload; the host adds the separating space.
    expect(draft()).toBe(`${insert.text} `)
  })

  it('keeps the draft equal to the plain-text insert plus the host separator', () => {
    // The real composer is a contenteditable the caret probe cannot read (it
    // has no `<textarea>`), so the live path is always the end-of-draft
    // append, and the host appends its own separating space behind the chip.
    // The submitted prompt is trimmed, so the model receives the same text the
    // plain-text insert produced.
    const { ctx, events, draft } = fakeChipCtx('AB')
    insertSelectionReference(ctx, 's1', insert)
    expect(draft()).toBe(`${insertAtCaret('AB', insert.text, null)} `)
    // The model form the chip serializes to is the fenced payload itself, plus
    // the leading join space the splice added — not a lossy stand-in.
    expect(events[0]!.reference!.ref).toBe(` ${insert.text}`)
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
    // The chip's own text carries the leading join space; the trailing one is
    // the host's separator.
    expect(draft()).toBe('hello CODE ')
  })

  it('folds the span onto the editor projection so a chip-bearing draft takes a second chip', () => {
    // Regression: a session's first insert lands on an empty draft, where the
    // two projections coincide. Every later one addresses a draft whose chip
    // has already widened the clipboard plane, and a raw draft offset is then
    // refused by the host — which used to cost the draft every chip it held,
    // because the refused insert fell back to the whole-draft write.
    const { ctx, events, draft, detect, occurrences } = fakeChipCtx('')
    expect(insertSelectionReference(ctx, 's1', insert)).toBe(true)
    expect(detect()).toBe(`${CHIP_PLACEHOLDER} `)

    expect(insertSelectionReference(ctx, 's1', insert)).toBe(true)
    // The span is the folded document end (two editor characters), not the
    // clipboard offset the draft reports (the fenced payload plus two).
    expect(events[1]!.span).toEqual({ draftRev: 2, start: 2, end: 2 })
    expect(detect()).toBe(`${CHIP_PLACEHOLDER} ${CHIP_PLACEHOLDER} `)
    // Both payloads are still in the draft: the first chip survived.
    expect(occurrences()).toHaveLength(2)
    // And exactly one separator between them — the first chip's trailing space
    // is the draft's tail, so the second insert must add none of its own.
    expect(draft()).toBe(`${insert.text} ${insert.text} `)
  })

  it('keeps a literal chip placeholder out of the editor-facing text', () => {
    const { ctx, events, detect, occurrences } = fakeChipCtx('')
    const payload = `before${CHIP_PLACEHOLDER}after`
    expect(insertSelectionReference(ctx, 's1', { label: 'a.md:1', text: payload })).toBe(true)
    // A literal placeholder in a text node forges a chip position; the editor
    // projection must hold exactly the one belonging to this chip.
    expect(events[0]!.reference!.clipboardText).toBe('beforeafter')
    expect(detect().split(CHIP_PLACEHOLDER)).toHaveLength(2)
    expect(occurrences()).toHaveLength(1)
    // The model form keeps the payload exactly as it was selected.
    expect(events[0]!.reference!.ref).toBe(payload)
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
      sessions: { scope: () => ({ bail: (): void => { throw new Error('boom') } }) },
      get: () => ({ input: { for: () => ({ state: { getSnapshot: () => ({ draft: '', draftRev: 1 }) } }) } }),
    } as unknown as Context
    expect(insertSelectionReference(ctx, 's1', insert)).toBe(false)
    expect(consoleWarn).toHaveBeenCalledTimes(1)
    consoleWarn.mockRestore()
  })
})

describe('foldClipboardOffset', () => {
  it('is the identity without chips', () => {
    expect(foldClipboardOffset(0, undefined)).toBe(0)
    expect(foldClipboardOffset(7, undefined)).toBe(7)
    expect(foldClipboardOffset(7, [])).toBe(7)
  })

  it('collapses every chip ahead of the offset by its own expansion', () => {
    // clipboard: 'abc' + chip(10) + ' def' → editor: 'abc￼ def'
    const chips = [{ offset: 3, length: 10 }]
    expect(foldClipboardOffset(0, chips)).toBe(0)
    expect(foldClipboardOffset(3, chips)).toBe(3) // the chip's start stays put
    expect(foldClipboardOffset(13, chips)).toBe(4) // the chip's trailing edge
    expect(foldClipboardOffset(17, chips)).toBe(8) // the document end
  })

  it('snaps an offset inside a chip to that chip trailing edge', () => {
    const chips = [{ offset: 3, length: 10 }]
    expect(foldClipboardOffset(4, chips)).toBe(4)
    expect(foldClipboardOffset(12, chips)).toBe(4)
  })

  it('folds a document holding several chips, in order', () => {
    // clipboard: chip(5) + 'ab' + chip(8) → editor: '￼ab￼'
    const chips = [
      { offset: 0, length: 5 },
      { offset: 7, length: 8 },
    ]
    expect(foldClipboardOffset(0, chips)).toBe(0)
    expect(foldClipboardOffset(5, chips)).toBe(1)
    expect(foldClipboardOffset(6, chips)).toBe(2)
    expect(foldClipboardOffset(7, chips)).toBe(3)
    expect(foldClipboardOffset(10, chips)).toBe(4) // inside the second chip
    expect(foldClipboardOffset(15, chips)).toBe(4) // the document end
  })

  it('reads a chip starting at the offset as the position before it', () => {
    // Deliberate deviation from the host's internal fold, which reads this as
    // "inside the chip" and answers its trailing edge; the position before the
    // chip is the real document position, and one its caret resolver addresses.
    const chips = [{ offset: 0, length: 5 }]
    expect(foldClipboardOffset(0, chips)).toBe(0)
  })

  it('never decreases and never goes below zero', () => {
    const chips = [
      { offset: 2, length: 6 },
      { offset: 12, length: 3 },
    ]
    let previous = foldClipboardOffset(-5, chips)
    expect(previous).toBe(0)
    for (let offset = -5; offset <= 20; offset += 1) {
      const folded = foldClipboardOffset(offset, chips)
      expect(folded).toBeGreaterThanOrEqual(previous)
      previous = folded
    }
  })
})

describe('appendToDraft over a chip-bearing draft', () => {
  it('splices through the host text event instead of the chip-destroying draft write', () => {
    const { ctx, events, draft, occurrences, setDraftCalls } = fakeChipCtx('')
    expect(insertSelectionReference(ctx, 's1', { label: 'a.md:1', text: 'CODE' })).toBe(true)
    const before = draft()

    expect(appendToDraft(ctx, 's1', 'tail')).toBe(true)
    // `setDraft` rebuilds the editor from plain paragraphs; it is never used
    // while a chip sits in the draft.
    expect(setDraftCalls()).toBe(0)
    expect(events[1]!.name).toBe('slash/input-insert-text')
    expect(events[1]!.span).toEqual({ draftRev: 2, start: 2, end: 2 })
    expect(draft()).toBe(insertAtCaret(before, 'tail', null))
    expect(occurrences()).toHaveLength(1)
  })

  it('strips the placeholder characters that would forge a chip position', () => {
    const { ctx, events, draft } = fakeChipCtx('')
    insertSelectionReference(ctx, 's1', { label: 'a.md:1', text: 'CODE' })
    expect(appendToDraft(ctx, 's1', `forged${CHIP_PLACEHOLDER}tail`)).toBe(true)
    // No leading space: the chip's own trailing separator is already there.
    expect(events[1]!.text).toBe('forgedtail')
    expect(draft()).toContain('forgedtail')
  })

  it('refuses to write into a frozen composer without falling back', () => {
    const { ctx, draft, setDraftCalls, setPhase } = fakeChipCtx('')
    insertSelectionReference(ctx, 's1', { label: 'a.md:1', text: 'CODE' })
    const before = draft()
    setPhase('submitting')
    expect(appendToDraft(ctx, 's1', 'tail')).toBe(false)
    expect(setDraftCalls()).toBe(0)
    expect(draft()).toBe(before)
  })
})

describe('insertFileReference', () => {
  it('mints a file chip at the folded end of a chip-bearing draft', () => {
    const { ctx, events, occurrences, setDraftCalls } = fakeChipCtx('')
    expect(insertSelectionReference(ctx, 's1', { label: 'a.md:1', text: 'CODE' })).toBe(true)
    expect(insertFileReference(ctx, 's1', 'src/app.ts')).toBe(true)
    expect(events[1]!.reference).toEqual({
      source: 'reference',
      label: 'app.ts',
      appearance: 'file',
      clipboardText: '@src/app.ts',
      ref: '@src/app.ts',
    })
    expect(events[1]!.span).toEqual({ draftRev: 2, start: 2, end: 2 })
    expect(occurrences()).toHaveLength(2)
    expect(setDraftCalls()).toBe(0)
  })

  it('refuses a path the host grammar cannot spell', () => {
    const { ctx, events } = fakeChipCtx('')
    expect(insertFileReference(ctx, 's1', 'bad"name.ts')).toBe(false)
    expect(events).toEqual([])
  })
})