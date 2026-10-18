/**
 * conversation-draft spec — composer insertion without whole-draft rewrites.
 *
 * `insertAtCaret` is pure string math (splice with whitespace-aware joins);
 * `probeComposerCaret` reads the live composer `<textarea>` selection out of
 * the DOM, guarded by a value-sync check so a stale or wrong-composer caret is
 * never applied (the 0.1.7+ composer is a contenteditable, so it answers null
 * there and inserts append at the draft end).
 *
 * Both insert paths ride DSH's scoped composer events, whose spans live in
 * **detect** coordinates (one chip = one character), never `setDraft`: the
 * host's whole-draft replacement is documented to remove inline reference
 * chips, so it would flatten every earlier `@` pick into plain text. The fake
 * composer below models both the projection folding and that refusal, so a
 * reintroduced `setDraft` insert (or a clipboard-coordinate span) fails here.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import {
  appendToDraft,
  clipboardToDetect,
  detectLength,
  insertAtCaret,
  insertFileReference,
  probeComposerCaret,
  type DraftOccurrence,
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

  it('keeps a directory separator when appending another reference', () => {
    expect(insertAtCaret('@src/ ', '@notes.md', null)).toBe('@src/ @notes.md')
    expect(insertAtCaret('@src/\n', '@notes.md', null)).toBe('@src/\n@notes.md')
  })

  it('uses the inserted directory separator before a following word', () => {
    expect(insertAtCaret('hello world', '@src/ ', { start: 6, end: 6 })).toBe('hello @src/ world')
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

describe('clipboard → detect projection folding', () => {
  it('counts every chip as one character', () => {
    expect(detectLength('', [])).toBe(0)
    expect(detectLength('@notes/ENV.md ', [{ offset: 0, length: 13 }])).toBe(2)
    expect(detectLength('a @x.md b @y.md', [{ offset: 2, length: 5 }, { offset: 10, length: 5 }])).toBe(7)
  })

  it('passes offsets through when the draft holds no chip', () => {
    expect(clipboardToDetect([], 0)).toBe(0)
    expect(clipboardToDetect([], 42)).toBe(42)
  })

  it('folds offsets around one chip, snapping an inside offset before that chip', () => {
    const chip: DraftOccurrence[] = [{ offset: 0, length: 13 }]
    expect(clipboardToDetect(chip, 0)).toBe(0)
    expect(clipboardToDetect(chip, 5)).toBe(0) // inside the chip: not addressable
    expect(clipboardToDetect(chip, 13)).toBe(1)
    expect(clipboardToDetect(chip, 14)).toBe(2)
  })

  it('folds offsets across several chips', () => {
    const chips: DraftOccurrence[] = [{ offset: 0, length: 5 }, { offset: 10, length: 4 }]
    expect(clipboardToDetect(chips, 0)).toBe(0)
    expect(clipboardToDetect(chips, 5)).toBe(1)
    expect(clipboardToDetect(chips, 9)).toBe(5)
    expect(clipboardToDetect(chips, 10)).toBe(6)
    expect(clipboardToDetect(chips, 14)).toBe(7)
  })
})

/** One composer event the plugin emitted. */
interface EmittedEvent {
  name: string
  payload: Record<string, unknown>
}

/**
 * A fake session-scope composer modelling the two host behaviours this module
 * depends on: (a) `setDraft` replaces the whole draft as plain text and drops
 * every chip occurrence, and (b) an insert whose span end is past the *detect*
 * length is refused (`selectSpan`'s bounds check), leaving the revision alone.
 */
function fakeComposer(initial: {
  draft?: string
  draftRev?: number
  occurrences?: readonly DraftOccurrence[]
} = {}): {
  ctx: Context
  events: EmittedEvent[]
  setDrafts: string[]
  read: () => { draft: string; draftRev: number; occurrences: readonly DraftOccurrence[] }
} {
  const events: EmittedEvent[] = []
  const setDrafts: string[] = []
  let draft = initial.draft ?? ''
  let draftRev = initial.draftRev ?? 0
  let occurrences: readonly DraftOccurrence[] = initial.occurrences ?? []

  /** Fold one detect offset back to clipboard coordinates (the host's document walk). */
  const detectToClipboard = (offset: number): number => {
    let absorbed = 0
    for (const occurrence of occurrences) {
      if (occurrence.offset - absorbed >= offset) break
      absorbed += occurrence.length - 1
    }
    return offset + absorbed
  }

  const apply = (name: string, payload: Record<string, unknown>): void => {
    const span = payload.span as { start: number; end: number } | undefined
    if (span === undefined) return
    if (span.start < 0 || span.start > span.end || span.end > detectLength(draft, occurrences)) return
    const start = detectToClipboard(span.start)
    const end = detectToClipboard(span.end)
    if (name === 'slash/input-insert-reference') {
      const reference = payload.reference as { clipboardText: string }
      const text = reference.clipboardText
      // The host mints the chip plus a separating space; the chip's mention
      // becomes one occurrence over the clipboard projection.
      draft = `${draft.slice(0, start)}${text} ${draft.slice(end)}`
      occurrences = [
        ...occurrences.filter(occurrence => occurrence.offset < start),
        { offset: start, length: text.length },
        ...occurrences
          .filter(occurrence => occurrence.offset >= end)
          .map(occurrence => ({ ...occurrence, offset: occurrence.offset + text.length + 1 })),
      ].sort((left, right) => left.offset - right.offset)
      draftRev += 1
      return
    }
    if (name === 'slash/input-insert-text') {
      const text = payload.text as string
      // Plain text replaces the range; a chip covered by the range is consumed
      // with it, and everything after it shifts.
      draft = `${draft.slice(0, start)}${text}${draft.slice(end)}`
      const delta = text.length - (end - start)
      occurrences = occurrences
        .filter(occurrence => occurrence.offset < start || occurrence.offset >= end)
        .map(occurrence => (
          occurrence.offset >= end ? { ...occurrence, offset: occurrence.offset + delta } : occurrence
        ))
      draftRev += 1
    }
  }

  const input = {
    state: {
      getSnapshot: (): { draft: string; draftRev: number; occurrences: readonly DraftOccurrence[] } =>
        ({ draft, draftRev, occurrences }),
    },
    setDraft: (next: string): void => {
      setDrafts.push(next)
      draft = next
      occurrences = [] // the documented chip-flattening behavior
      draftRev += 1
    },
  }
  const scope = {
    emit: (name: string, payload: Record<string, unknown>): void => {
      if (name !== 'slash/input-insert-reference' && name !== 'slash/input-insert-text') return
      events.push({ name, payload })
      apply(name, payload)
    },
  }
  const ctx = {
    sessions: { scope: (): unknown => scope },
    get: (name: string): unknown => (name === 'conversation' ? { input: { for: (): unknown => input } } : undefined),
  } as unknown as Context
  return { ctx, events, setDrafts, read: () => ({ draft, draftRev, occurrences }) }
}

describe('appendToDraft', () => {
  it('inserts through the plain-text event, never through setDraft', () => {
    const composer = fakeComposer()
    expect(appendToDraft(composer.ctx, 's1', '@docs/ ')).toBe(true)
    expect(composer.events.map(event => event.name)).toEqual(['slash/input-insert-text'])
    expect(composer.setDrafts).toEqual([])
    expect(composer.read().draft).toBe('@docs/ ')
  })

  it('appends at the end with the whitespace-aware separator when no caret is resolvable', () => {
    const composer = fakeComposer({ draft: 'hello' })
    appendToDraft(composer.ctx, 's1', '@docs/')
    expect(composer.read().draft).toBe('hello @docs/')
    appendToDraft(composer.ctx, 's1', '@src/ ')
    expect(composer.read().draft).toBe('hello @docs/ @src/ ')
    expect(composer.setDrafts).toEqual([])
  })

  it('replaces a whitespace-only draft instead of indenting it', () => {
    const composer = fakeComposer({ draft: '   ' })
    appendToDraft(composer.ctx, 's1', '@docs/ ')
    expect(composer.read().draft).toBe('@docs/ ')
    // The range insert replaces the blanks (the event carries a range, not a caret).
    expect(composer.events[0]?.payload.span).toEqual({ draftRev: 0, start: 0, end: 3 })
  })

  it('inserts at the probed caret when the composer exposes one', () => {
    mountComposer('AB', 1, 1)
    const composer = fakeComposer({ draft: 'AB' })
    appendToDraft(composer.ctx, 's1', 'C')
    expect(composer.read().draft).toBe('A C B')
    expect(composer.events[0]?.payload.span).toEqual({ draftRev: 0, start: 1, end: 1 })
  })

  it('keeps an existing chip: the span is folded into detect coordinates', () => {
    const composer = fakeComposer({
      draft: '@notes/ENV.md ',
      draftRev: 3,
      occurrences: [{ offset: 0, length: 13 }],
    })
    expect(appendToDraft(composer.ctx, 's1', '@docs/ ')).toBe(true)
    // Detect coordinates: the chip is one character, so the append offset is
    // 2 (chip + its trailing space) — not the clipboard length 14.
    expect(composer.events[0]?.payload.span).toEqual({ draftRev: 3, start: 2, end: 2 })
    expect(composer.read().draft).toBe('@notes/ENV.md @docs/ ')
    expect(composer.read().occurrences).toEqual([{ offset: 0, length: 13 }])
    expect(composer.setDrafts).toEqual([])
  })

  it('hands a multi-line payload to the host verbatim and keeps the chip (selection quote)', () => {
    const composer = fakeComposer({
      draft: '@notes/ENV.md ',
      draftRev: 1,
      occurrences: [{ offset: 0, length: 13 }],
    })
    const quote = ['```diagram.md:1-9', '# Diagram', 'tail text', '```'].join('\n')
    expect(appendToDraft(composer.ctx, 's1', quote)).toBe(true)
    // The draft already ends with whitespace, so the payload arrives untouched:
    // no leading separator, every newline intact (the host renders them under
    // the composer's `white-space: pre-wrap`).
    expect(composer.events[0]?.payload.text).toBe(quote)
    expect(composer.read().draft).toBe(`@notes/ENV.md ${quote}`)
    expect(composer.read().occurrences).toEqual([{ offset: 0, length: 13 }])
    expect(composer.setDrafts).toEqual([])
  })

  it('reports false — logs, and leaves the draft alone — when no listener handled the event', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const composer = fakeComposer({ draft: 'hi', draftRev: 2 })
    const ctx = {
      sessions: { scope: (): unknown => ({ emit: (): void => undefined }) },
      get: (name: string): unknown => composer.ctx.get(name),
    } as unknown as Context
    expect(appendToDraft(ctx, 's1', 'X')).toBe(false)
    expect(composer.read().draft).toBe('hi')
    expect(composer.setDrafts).toEqual([])
    expect(consoleWarn).toHaveBeenCalledTimes(1)
    consoleWarn.mockRestore()
  })

  it('returns false and logs when the draft carries no revision to address', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const composer = fakeComposer({ draft: 'hi' })
    const ctx = {
      sessions: { scope: (): unknown => ({ emit: (): void => undefined }) },
      get: (name: string): unknown => (
        name === 'conversation'
          ? { input: { for: (): unknown => ({ state: { getSnapshot: (): unknown => ({ draft: 'hi' }) } }) } }
          : undefined
      ),
    } as unknown as Context
    expect(appendToDraft(ctx, 's1', 'X')).toBe(false)
    expect(consoleWarn).toHaveBeenCalledTimes(1)
    expect(composer.read().draft).toBe('hi')
    consoleWarn.mockRestore()
  })

  it('returns false and logs when the conversation service is unavailable', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const ctx = {
      sessions: { scope: (): unknown => ({}) },
      get: (): unknown => undefined,
    } as unknown as Context
    expect(appendToDraft(ctx, 's1', 'X')).toBe(false)
    expect(consoleWarn).toHaveBeenCalledTimes(1)
    consoleWarn.mockRestore()
  })
})

describe('insertFileReference', () => {
  it('inserts a chip at the draft end and keeps its occurrence', () => {
    const composer = fakeComposer()
    expect(insertFileReference(composer.ctx, 's1', 'notes/ENV.md')).toBe(true)
    expect(composer.events.map(event => event.name)).toEqual(['slash/input-insert-reference'])
    expect(composer.read().draft).toBe('@notes/ENV.md ')
    expect(composer.read().occurrences).toEqual([{ offset: 0, length: 13 }])
  })

  it('still applies on a draft that already holds a chip (the shipped regression)', () => {
    const composer = fakeComposer({
      draft: '@notes/ENV.md ',
      draftRev: 4,
      occurrences: [{ offset: 0, length: 13 }],
    })
    expect(insertFileReference(composer.ctx, 's1', 'notes/STATE.md')).toBe(true)
    // The chip lands at the draft end in *detect* coordinates (1 + the space).
    expect(composer.events[0]?.payload.span).toEqual({ draftRev: 4, start: 2, end: 2 })
    expect(composer.read().draft).toBe('@notes/ENV.md @notes/STATE.md ')
    expect(composer.read().occurrences).toEqual([
      { offset: 0, length: 13 },
      { offset: 14, length: 15 },
    ])
    expect(composer.setDrafts).toEqual([])
  })

  it('reports false — logs, and leaves the draft alone — when no listener handled the event', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const composer = fakeComposer({ draft: 'hi', draftRev: 2 })
    const ctx = {
      sessions: { scope: (): unknown => ({ emit: (): void => undefined }) },
      get: (name: string): unknown => composer.ctx.get(name),
    } as unknown as Context
    expect(insertFileReference(ctx, 's1', 'notes/ENV.md')).toBe(false)
    expect(composer.read().draft).toBe('hi')
    expect(composer.setDrafts).toEqual([])
    expect(consoleWarn).toHaveBeenCalledTimes(1)
    consoleWarn.mockRestore()
  })

  it('returns false without a revision to address', () => {
    const composer = fakeComposer({ draft: 'hi' })
    const ctx = {
      sessions: { scope: (): unknown => ({ emit: (): void => undefined }) },
      get: (name: string): unknown => (
        name === 'conversation'
          ? { input: { for: (): unknown => ({ state: { getSnapshot: (): unknown => ({ draft: 'hi' }) } }) } }
          : undefined
      ),
    } as unknown as Context
    expect(insertFileReference(ctx, 's1', 'notes/ENV.md')).toBe(false)
    expect(composer.events).toEqual([])
  })
})
