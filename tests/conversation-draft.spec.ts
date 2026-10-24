/**
 * conversation-draft spec — the composer draft insert path behind the
 * explorer's @-reference button and the viewer selection popup.
 *
 * `foldClipboardOffset` folds a draft-projection offset into the editor's
 * detect projection; `insertDraftReference` mints a chip through the host
 * facade; `appendToDraft` appends plain text, taking the span channel when
 * the draft already carries chips.
 *
 * There is no DOM here on purpose: the host composer is a Lexical
 * contenteditable and publishes no caret on the face this plugin reaches, so
 * every insert appends at the document end.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import {
  appendText,
  appendToDraft,
  foldClipboardOffset,
  insertDraftReference,
} from '../src/client/conversation-draft.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('appendText', () => {
  it('appends behind one separating space', () => {
    expect(appendText('hello', 'X')).toBe('hello X')
    expect(appendText('hello\n', 'X')).toBe('hello\nX')
  })

  it('replaces a blank draft outright', () => {
    expect(appendText('', 'X')).toBe('X')
    expect(appendText('   ', 'X')).toBe('   X')
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

  it('appends with a separating space', () => {
    const calls: string[] = []
    const ctx = fakeCtx(() => 'hi', (next) => { calls.push(next) })
    expect(appendToDraft(ctx, 's1', 'X')).toBe(true)
    expect(calls).toEqual(['hi X'])
  })

  it('appends to an empty draft without a separator', () => {
    const calls: string[] = []
    const ctx = fakeCtx(() => '', (next) => { calls.push(next) })
    appendToDraft(ctx, 's1', 'X')
    expect(calls).toEqual(['X'])
  })

  it('returns false and logs when the conversation service is unavailable', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const ctx = fakeCtx(() => '', (): void => undefined, false)
    expect(appendToDraft(ctx, 's1', 'X')).toBe(false)
    expect(consoleWarn).toHaveBeenCalledTimes(1)
  })
})

describe('foldClipboardOffset', () => {
  // 'ab' + chip('docs/a.md:12') + ' cd' — the clipboard projection expands the
  // chip; the detect projection collapses it to one character.
  const draft = 'abdocs/a.md:12 cd'
  const occurrences = [{ offset: 2, length: 12 }]

  it('leaves an offset alone when the draft carries no chips', () => {
    expect(foldClipboardOffset('abcdef', [], 4)).toBe(4)
  })

  it('leaves an offset before the first chip untouched', () => {
    expect(foldClipboardOffset(draft, occurrences, 1)).toBe(1)
  })

  it('shrinks an offset past a chip by its expansion minus the placeholder', () => {
    // 'ab' + 1 placeholder + ' cd'
    expect(foldClipboardOffset(draft, occurrences, draft.length)).toBe(6)
  })

  it('lands right after the placeholder for an offset at the chip end', () => {
    expect(foldClipboardOffset(draft, occurrences, 14)).toBe(3)
  })

  it('snaps an offset inside the chip to its trailing edge', () => {
    expect(foldClipboardOffset(draft, occurrences, 8)).toBe(3)
  })

  it('reads an offset at the chip start as the position before it', () => {
    expect(foldClipboardOffset(draft, occurrences, 2)).toBe(2)
  })

  it('folds several chips independently', () => {
    // 'x' + chip('a.md:1') + ' ' + chip('b.md:2') + ' z'
    const two = 'xa.md:1 b.md:2 z'
    const chips = [{ offset: 1, length: 6 }, { offset: 8, length: 6 }]
    expect(foldClipboardOffset(two, chips, two.length)).toBe(6)
  })

  it('clamps an out-of-range offset into the draft', () => {
    expect(foldClipboardOffset('ab', [], 99)).toBe(2)
    expect(foldClipboardOffset('ab', [], -3)).toBe(0)
  })
})

/**
 * A fake composer exposing the conversation face these two functions use:
 * the snapshot store, the `insertReference` facade, and the session-scope
 * `emit` the span channel goes through. Every write records what it was
 * called with so a test can assert which channel ran.
 */
function composerCtx(options: {
  draft?: string
  occurrences?: { offset: number; length: number }[]
  draftRev?: number
  phase?: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
  /** Omit the `insertReference` facade (an older host without chip support). */
  withChipChannel?: boolean
  /** Return false from the facade to simulate the host refusing the insert. */
  accept?: boolean
  /** Apply the edit, then throw — the host's own update listeners failing. */
  throwAfterApply?: boolean
  withConversation?: boolean
} = {}) {
  let draft = options.draft ?? ''
  // `draftRev: undefined` is a meaningful case (a host with no revision), so
  // only an absent key takes the default.
  let rev: number | undefined = 'draftRev' in options ? options.draftRev : 0
  const bump = (): void => { if (rev !== undefined) rev += 1 }
  const setDrafts: string[] = []
  const emitted: { name: string; payload: unknown }[] = []
  const chipInserts: { ref: unknown; span: unknown }[] = []
  const input = {
    state: {
      getSnapshot: () => ({
        draft,
        ...rev === undefined ? {} : { draftRev: rev },
        occurrences: options.occurrences ?? [],
        ...options.phase === undefined ? {} : { phase: options.phase },
        ...options.phase !== 'claimed' ? {} : { claim: { token: '/goal ' } },
      }),
    },
    setDraft: (next: string): void => { setDrafts.push(next); draft = next; bump() },
    ...options.withChipChannel === false
      ? {}
      : {
          insertReference: (ref: unknown, span: unknown): boolean => {
            chipInserts.push({ ref, span })
            if (options.accept === false) return false
            bump()
            if (options.throwAfterApply === true) throw new Error('host listener blew up')
            return true
          },
        },
  }
  const actx = {
    emit: (name: string, payload: unknown): void => {
      emitted.push({ name, payload })
      bump()
    },
  }
  const ctx = {
    sessions: { scope: (): unknown => actx },
    get: (name: string): unknown =>
      options.withConversation === false || name !== 'conversation'
        ? undefined
        : { input: { for: (): unknown => input } },
  } as unknown as Context
  return { ctx, emitted, setDrafts, chipInserts }
}

describe('insertDraftReference', () => {
  it('hands the host one chip carrying the label and the model text apart', () => {
    const fake = composerCtx({ draft: 'hello' })
    expect(insertDraftReference(fake.ctx, 's1', { label: 'a.md:3', text: '```a.md:3\nx\n```' })).toBe(true)
    // `hello` ends in a non-space, so a separator is inserted first (the host
    // only adds one after the chip) — the chip then lands one place later.
    expect(fake.emitted).toEqual([{
      name: 'slash/input-insert-text',
      payload: { text: ' ', span: { draftRev: 0, start: 5, end: 5 } },
    }])
    expect(fake.chipInserts).toEqual([{
      ref: {
        source: 'reference',
        ref: '```a.md:3\nx\n```',
        label: 'a.md:3',
        // No `appearance`: this chip's text is a fenced block, not a path.
        clipboardText: 'a.md:3',
      },
      span: { draftRev: 1, start: 6, end: 6 },
    }])
  })

  it('folds the span past chips already in the draft', () => {
    const fake = composerCtx({ draft: 'abdocs/a.md:12 cd', occurrences: [{ offset: 2, length: 12 }] })
    insertDraftReference(fake.ctx, 's1', { label: 'b.md:1', text: 'B' })
    expect((fake.chipInserts[0]?.span as { start: number }).start).toBe(7)
  })

  it('reports false when the host refused the insert', () => {
    const fake = composerCtx({ draft: 'x', accept: false })
    expect(insertDraftReference(fake.ctx, 's1', { label: 'a', text: 'a' })).toBe(false)
  })

  it('reports false when the host has no chip facade', () => {
    const fake = composerCtx({ draft: 'x', withChipChannel: false })
    expect(insertDraftReference(fake.ctx, 's1', { label: 'a', text: 'a' })).toBe(false)
    expect(fake.chipInserts).toEqual([])
  })

  it('reports false when the host exposes no draft revision', () => {
    const fake = composerCtx({ draft: 'x', draftRev: undefined })
    expect(insertDraftReference(fake.ctx, 's1', { label: 'a', text: 'a' })).toBe(false)
  })

  it('reports false when the conversation service is missing', () => {
    const fake = composerCtx({ withConversation: false })
    expect(insertDraftReference(fake.ctx, 's1', { label: 'a', text: 'a' })).toBe(false)
  })

  it('omits appearance for a reference whose text is not a path', () => {
    const fake = composerCtx({ draft: 'hello' })
    insertDraftReference(fake.ctx, 's1', { label: 'a.md:3', text: '```a.md:3\nx\n```' })
    expect(fake.chipInserts[0]?.ref).not.toHaveProperty('appearance')
  })

  it('carries the appearance a path-shaped reference asks for', () => {
    const fake = composerCtx({ draft: 'hello' })
    insertDraftReference(fake.ctx, 's1', { label: 'a.md', text: '@a.md', appearance: 'file' })
    expect((fake.chipInserts[0]?.ref as { appearance?: string }).appearance).toBe('file')
  })

  it('offsets past a command chip, which never appears in occurrences', () => {
    // '/goal ' is a command chip: 6 draft characters, 1 detect character.
    const fake = composerCtx({ draft: '/goal ', phase: 'claimed' })
    insertDraftReference(fake.ctx, 's1', { label: 'a', text: 'a' })
    expect((fake.chipInserts[0]?.span as { start: number }).start).toBe(1)
  })

  it('adds both the command chip and reference chips to the offset', () => {
    // '/goal ' (1 detect) + chip 'docs/a.md:12' (1 detect) → append at 2.
    const fake = composerCtx({
      draft: '/goal docs/a.md:12',
      phase: 'claimed',
      occurrences: [{ offset: 6, length: 12 }],
    })
    insertDraftReference(fake.ctx, 's1', { label: 'b', text: 'b' })
    // 2 folded positions + the reserved separator space.
    expect((fake.chipInserts[0]?.span as { start: number }).start).toBe(3)
  })

  it('reports false while the submission is frozen', () => {
    const fake = composerCtx({ draft: 'x', phase: 'submitting' })
    expect(insertDraftReference(fake.ctx, 's1', { label: 'a', text: 'a' })).toBe(false)
    expect(fake.chipInserts).toEqual([])
  })

  it('reports true when the host applied the edit and then threw', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fake = composerCtx({ draft: 'x', throwAfterApply: true })
    expect(insertDraftReference(fake.ctx, 's1', { label: 'a', text: 'a' })).toBe(true)
    consoleWarn.mockRestore()
  })

  it('reserves a separator so the chip cannot stick to the last word', () => {
    // The host adds a space after a chip but not before it.
    const fake = composerCtx({ draft: 'hello' })
    insertDraftReference(fake.ctx, 's1', { label: 'a.md:3', text: 'A' })
    expect(fake.emitted[0]?.payload).toMatchObject({ text: ' ' })
    expect((fake.chipInserts[0]?.span as { start: number }).start).toBe(6)
  })

  it('reserves no separator when the draft already ends in whitespace', () => {
    const fake = composerCtx({ draft: 'hello ' })
    insertDraftReference(fake.ctx, 's1', { label: 'a.md:3', text: 'A' })
    expect(fake.emitted).toEqual([])
    expect((fake.chipInserts[0]?.span as { start: number }).start).toBe(6)
  })

  it('reserves no separator on an empty draft', () => {
    const fake = composerCtx({ draft: '' })
    insertDraftReference(fake.ctx, 's1', { label: 'a.md:3', text: 'A' })
    expect(fake.emitted).toEqual([])
    expect((fake.chipInserts[0]?.span as { start: number }).start).toBe(0)
  })
})

describe('appendToDraft on a draft that already carries chips', () => {
  it('inserts through the span event instead of rebuilding the draft', () => {
    const fake = composerCtx({ draft: 'abdocs/a.md:12 cd', draftRev: 3, occurrences: [{ offset: 2, length: 12 }] })
    appendToDraft(fake.ctx, 's1', 'X')
    expect(fake.setDrafts).toEqual([])
    expect(fake.emitted).toHaveLength(1)
    expect(fake.emitted[0]?.name).toBe('slash/input-insert-text')
    const payload = fake.emitted[0]?.payload as { text: string; span: { start: number; end: number } }
    expect(payload.span).toEqual({ draftRev: 3, start: 6, end: 6 })
    // The draft ends in 'd', so the insert carries its own separating space.
    expect(payload.text).toBe(' X')
  })

  it('adds the separating space the draft end needs', () => {
    const fake = composerCtx({ draft: 'abdocs/a.md:12', draftRev: 3, occurrences: [{ offset: 2, length: 12 }] })
    appendToDraft(fake.ctx, 's1', 'X')
    expect((fake.emitted[0]?.payload as { text: string }).text).toBe(' X')
  })

  it('keeps the plain setDraft path when the draft has no chips', () => {
    const fake = composerCtx({ draft: 'hello', draftRev: 3 })
    appendToDraft(fake.ctx, 's1', 'X')
    expect(fake.emitted).toEqual([])
    expect(fake.setDrafts).toEqual(['hello X'])
  })

  it('never flattens a command chip, even though it is not an occurrence', () => {
    // `setDraft` would rebuild `/goal ` as literal text and drop the claim.
    const fake = composerCtx({ draft: '/goal ', draftRev: 3, phase: 'claimed' })
    appendToDraft(fake.ctx, 's1', 'X')
    expect(fake.setDrafts).toEqual([])
    expect(fake.emitted).toHaveLength(1)
    expect(fake.emitted[0]?.name).toBe('slash/input-insert-text')
    // '/goal ' folds to one detect character; nothing follows it.
    expect((fake.emitted[0]?.payload as { span: { start: number } }).span.start).toBe(1)
  })
})