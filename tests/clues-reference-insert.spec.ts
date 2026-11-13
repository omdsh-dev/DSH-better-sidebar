/**
 * Composer reference insertion contract (clue insert + file-reference insert).
 *
 * The composer keeps TWO projections of the same document:
 *
 * - `InputState.draft` — the clipboard projection: every reference chip is
 *   expanded to its `clipboardText` (`[[dsh-clue:<id>]]`, `@path`);
 * - the editor's detect projection — every chip occupies exactly ONE
 *   U+FFFC character, and `SessionInput.insertReference(ref, span)` takes
 *   its `span` in THIS coordinate space (see the host contract in
 *   `dsh-client-ui-conversation/lib/types/client/contract/draft-editor.d.ts`
 *   and `SessionInputShell.insertReference`, which resolves the span against
 *   `projection.detectText` and refuses an out-of-bounds span silently).
 *
 * `InputState.occurrences` is the public bridge between the two: each
 * occurrence carries `offset`/`length` in the clipboard projection, so the
 * detect end of a clipboard draft is `draft.length - Σ(length - 1)`.
 *
 * This spec pins the regression: the insert helpers used to pass
 * `draft.length` as the detect span end. With one chip already in the draft
 * that end is beyond `detectText.length`, so the SECOND insert was refused
 * while the first one still worked — "insert A, insert B" only ever kept A.
 *
 * The fake below is a small but faithful copy of the host's behaviour:
 * append inserts validate the revision, reject an out-of-bounds detect span,
 * insert one chip (plus a separating space unless one already follows) and
 * re-project the two views. It is deliberately strict: a wrong coordinate
 * space is a visible failure, not something the fake repairs.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import {
  insertClueReference,
  insertClueReferenceSpan,
  insertPackReference,
  type ClueChipReference,
} from '../src/client/clues/insert.ts'
import { detectOffsetOfDraftEnd, insertFileReference } from '../src/client/conversation-draft.ts'

/** One composer chip: the host's ReferenceChipNode projection. */
interface Chip {
  readonly source: string
  readonly ref: string
  readonly label: string
  readonly appearance?: 'session' | 'file' | 'folder'
  readonly clipboardText: string
}

/** One node of the fake composer document (chips are atomic). */
type ComposerNode = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'chip'; readonly chip: Chip }

/** One occurrence as the host projects it. */
interface FakeOccurrence {
  readonly occurrenceId: number
  readonly source: string
  readonly ref: string
  readonly offset: number
  readonly length: number
  readonly label: string
  readonly appearance?: Chip['appearance']
  readonly clipboardText: string
}

/** The published snapshot shape the helpers read. */
interface FakeSnapshot {
  readonly draft: string
  readonly draftRev: number
  readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
  readonly occurrences: readonly FakeOccurrence[]
}

/** The detect-projection span the host expects. */
interface FakeSpan {
  readonly start: number
  readonly end: number
  readonly draftRev: number
}

/**
 * A fake session composer that mirrors the host's public `SessionInput`
 * slice: two projections, revision CAS and a detect-span `insertReference`.
 */
function createComposer(initial = ''): {
  readonly ctx: Context
  readonly snapshot: () => FakeSnapshot
  readonly focus: ReturnType<typeof vi.fn>
  readonly insertReference: ReturnType<typeof vi.fn>
  readonly refuseNext: () => void
  readonly setPhase: (phase: FakeSnapshot['phase']) => void
} {
  const nodes: ComposerNode[] = initial === '' ? [] : [{ kind: 'text', text: initial }]
  let draftRev = 1
  let phase: FakeSnapshot['phase'] = 'plain'
  let occurrenceSeq = 0
  const occurrenceIds = new Map<ComposerNode, number>()
  let refuse = false

  /** Project both views + occurrences exactly like the host. */
  const project = (): { draft: string; detect: string; occurrences: FakeOccurrence[] } => {
    let draft = ''
    let detect = ''
    const occurrences: FakeOccurrence[] = []
    for (const node of nodes) {
      if (node.kind === 'text') {
        draft += node.text
        detect += node.text
        continue
      }
      const offset = draft.length
      detect += '\uFFFC'
      draft += node.chip.clipboardText
      let occurrenceId = occurrenceIds.get(node)
      if (occurrenceId === undefined) {
        occurrenceId = ++occurrenceSeq
        occurrenceIds.set(node, occurrenceId)
      }
      occurrences.push({
        occurrenceId,
        source: node.chip.source,
        ref: node.chip.ref,
        offset,
        length: node.chip.clipboardText.length,
        label: node.chip.label,
        ...(node.chip.appearance === undefined ? {} : { appearance: node.chip.appearance }),
        clipboardText: node.chip.clipboardText,
      })
    }
    return { draft, detect, occurrences }
  }

  const snapshot = (): FakeSnapshot => {
    const view = project()
    return { draft: view.draft, draftRev, phase, occurrences: view.occurrences }
  }

  /** A detect offset that is a node boundary, or -1 when it splits a chip. */
  const boundaryIndex = (offset: number): number => {
    let detect = 0
    for (let index = 0; index < nodes.length; index += 1) {
      if (detect === offset) return index
      const node = nodes[index]!
      detect += node.kind === 'text' ? node.text.length : 1
    }
    return detect === offset ? nodes.length : -1
  }

  const insertReference = vi.fn((reference: ClueChipReference, span: FakeSpan): boolean => {
    if (phase !== 'plain' && phase !== 'claimed') return false
    if (span.draftRev !== draftRev) return false
    if (refuse) return false
    const view = project()
    if (span.start < 0 || span.end < span.start || span.end > view.detect.length) return false
    const startIndex = boundaryIndex(span.start)
    const endIndex = boundaryIndex(span.end)
    // The host resolves every endpoint to an element boundary; a span that
    // splits a chip is never produced by a pick-time caret or the helpers.
    if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) return false
    // The host appends one separating space unless the following character
    // already is one (the chip itself has no trailing space in its text).
    const tail = view.detect.slice(span.end, span.end + 1)
    nodes.splice(
      startIndex,
      endIndex - startIndex,
      { kind: 'chip', chip: reference },
      ...(tail === ' ' ? [] : [{ kind: 'text' as const, text: ' ' }]),
    )
    draftRev += 1
    return true
  })

  const focus = vi.fn()
  const input = {
    state: { getSnapshot: snapshot },
    insertReference,
    focus,
  }
  const scope = { emit: (): void => {} }
  const ctx = {
    sessions: { scope: () => scope },
    get: (name: string) => (name === 'conversation' ? { input: { for: () => input } } : undefined),
  } as unknown as Context

  return {
    ctx,
    snapshot,
    focus,
    insertReference,
    refuseNext: () => { refuse = true },
    setPhase: (next) => { phase = next },
  }
}

describe('detectOffsetOfDraftEnd', () => {
  it('folds reference chips and a claimed command chip onto the detect projection', () => {
    // Clipboard: '/goal' + ' ' + '[[dsh-clue:a]]' + ' tail'
    // Detect:    U+FFFC + ' ' + U+FFFC + ' tail'
    const draft = '/goal [[dsh-clue:a]] tail'
    expect(detectOffsetOfDraftEnd(draft, [{ offset: 6, length: 14 }], '/goal ')).toBe(8)
  })

  it('leaves plain text untouched and only folds the occurrence expansion', () => {
    const draft = 'hi [[dsh-clue:a]] '
    expect(detectOffsetOfDraftEnd(draft, [{ offset: 3, length: 14 }])).toBe(5)
    expect(detectOffsetOfDraftEnd('plain text')).toBe(10)
    // A claimed token outside the draft still folds (the host pattern never
    // produces this, the helper stays total).
    expect(detectOffsetOfDraftEnd('/goal', [], '/goal ')).toBe(1)
  })
})

describe('composer reference inserts use detect-projection spans', () => {
  it('keeps inserting clue, file and pack chips one after another', () => {
    const composer = createComposer()

    expect(insertClueReference(composer.ctx, 'session-1', { kind: 'clue', id: 'clue-a', title: 'Alpha' })).toBe(true)
    expect(insertClueReference(composer.ctx, 'session-1', { kind: 'clue', id: 'clue-b', title: 'Beta' })).toBe(true)
    expect(insertFileReference(composer.ctx, 'session-1', 'src/app.ts')).toBe(true)
    expect(insertPackReference(composer.ctx, 'session-1', 'pack-1', 'Reading list')).toBe(true)

    const snapshot = composer.snapshot()
    expect(snapshot.occurrences.map(occurrence => occurrence.clipboardText)).toEqual([
      '[[dsh-clue:clue-a]]',
      '[[dsh-clue:clue-b]]',
      '@src/app.ts',
      '[[dsh-cluepack:pack-1]]',
    ])
    expect(snapshot.draft).toBe(
      '[[dsh-clue:clue-a]] [[dsh-clue:clue-b]] @src/app.ts [[dsh-cluepack:pack-1]] ',
    )
    // Every occurrence must occupy its own clipboard slice of the draft.
    for (const occurrence of snapshot.occurrences) {
      expect(snapshot.draft.slice(occurrence.offset, occurrence.offset + occurrence.length))
        .toBe(occurrence.clipboardText)
    }
    expect(composer.insertReference).toHaveBeenCalledTimes(4)
    // The public method receives the detect end, never the expanded length.
    const spans = composer.insertReference.mock.calls.map(call => call[1])
    expect(spans.map(span => span.end)).toEqual([0, 2, 4, 6])
    expect(spans.every(span => span.start === span.end)).toBe(true)
    // Success returns the keyboard to the composer (all four inserts).
    expect(composer.focus).toHaveBeenCalledTimes(4)
  })

  it('still inserts after typed text and does not confuse the two projections', () => {
    const composer = createComposer('hello ')
    expect(insertClueReference(composer.ctx, 'session-1', { kind: 'clue', id: 'clue-a' })).toBe(true)
    expect(insertFileReference(composer.ctx, 'session-1', 'notes.md')).toBe(true)

    const snapshot = composer.snapshot()
    expect(snapshot.draft).toBe('hello [[dsh-clue:clue-a]] @notes.md ')
    expect(snapshot.occurrences).toHaveLength(2)
    expect(snapshot.occurrences[0]!.offset).toBe(6)
    expect(snapshot.occurrences[1]!.offset).toBe(26)
  })

  it('refuses a chip insert while the composer is submitting and keeps the draft', () => {
    const composer = createComposer()
    composer.setPhase('submitting')
    expect(insertClueReference(composer.ctx, 'session-1', { kind: 'clue', id: 'clue-a' })).toBe(false)
    expect(composer.snapshot().draft).toBe('')
    expect(composer.snapshot().occurrences).toEqual([])
    expect(composer.focus).not.toHaveBeenCalled()
  })

  it('reports a refused host insert instead of claiming success', () => {
    const composer = createComposer()
    composer.refuseNext()
    expect(insertClueReference(composer.ctx, 'session-1', { kind: 'clue', id: 'clue-a' })).toBe(false)
    expect(composer.snapshot().draft).toBe('')
    expect(composer.focus).not.toHaveBeenCalled()
  })
})

describe('pick-time span inserts (the @ menu ensure tail)', () => {
  const reference: ClueChipReference = {
    source: 'better-sidebar:clues',
    ref: 'clue-picked',
    label: 'Picked',
    appearance: 'file',
    clipboardText: '[[dsh-clue:clue-picked]]',
  }

  it('replaces the pick-time trigger token with the chip and focuses the composer', () => {
    const composer = createComposer('@pic')
    expect(insertClueReferenceSpan(composer.ctx, 'session-1', reference, {
      start: 0, end: 4, draftRev: 1,
    })).toBe('inserted')
    expect(composer.snapshot().draft).toBe('[[dsh-clue:clue-picked]] ')
    expect(composer.snapshot().occurrences.map(occurrence => occurrence.ref)).toEqual(['clue-picked'])
    expect(composer.focus).toHaveBeenCalledTimes(1)
  })

  it('answers stale when the draft moved after the pick, keeping the draft', () => {
    const composer = createComposer('@pic')
    expect(insertClueReferenceSpan(composer.ctx, 'session-1', reference, {
      start: 0, end: 4, draftRev: 2,
    })).toBe('stale')
    expect(composer.snapshot().draft).toBe('@pic')
    expect(composer.insertReference).not.toHaveBeenCalled()
    expect(composer.focus).not.toHaveBeenCalled()
  })

  it('answers stale while the composer is submitting', () => {
    const composer = createComposer('@pic')
    composer.setPhase('submitting')
    expect(insertClueReferenceSpan(composer.ctx, 'session-1', reference, {
      start: 0, end: 4, draftRev: 1,
    })).toBe('stale')
    expect(composer.snapshot().draft).toBe('@pic')
    expect(composer.focus).not.toHaveBeenCalled()
  })

  it('leaves the original draft untouched after navigation switches the mounted session', () => {
    const composer = createComposer('@pic')
    const originalGet = composer.ctx.get.bind(composer.ctx)
    const ctx = {
      ...composer.ctx,
      get: (name: string) => name === 'sidebarRight'
        ? { mounted: { getSnapshot: () => 'session-2' } }
        : originalGet(name as never),
    } as unknown as Context
    expect(insertClueReferenceSpan(ctx, 'session-1', reference, {
      start: 0, end: 4, draftRev: 1,
    })).toBe('stale')
    expect(composer.snapshot().draft).toBe('@pic')
    expect(composer.insertReference).not.toHaveBeenCalled()
    expect(composer.focus).not.toHaveBeenCalled()
  })

  it('answers failed when the session composer is no longer reachable', () => {
    expect(insertClueReferenceSpan(createComposer().ctx, '', reference, {
      start: 0, end: 0, draftRev: 1,
    })).toBe('failed')
  })
})
