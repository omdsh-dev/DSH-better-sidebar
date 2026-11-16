/**
 * path-in-chat spec — the explorer's row-menu "add to conversation" action.
 *
 * It appends the row's ABSOLUTE path as plain text: DSH's `@` grammar is
 * workspace-root relative (#479), so an absolute path cannot mint a chip the
 * host resolves, and the tree also lists paths outside the workspace where no
 * relative spelling exists. The insert rides the shared draft channel, so the
 * only behaviour this spec pins is the text that reaches the composer (exact
 * path, one separating space on a non-empty draft, never flattened chips) and
 * the documented no-op when the conversation service is missing.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '../src/context-types.ts'
import { appendPathToConversation } from '../src/client/path-in-chat.ts'

/** What one fake composer saw: the drafts assigned (chipless path) and the
 *  span events emitted (chipped path). */
interface FakeComposer {
  ctx: Context
  drafts: string[]
  emitted: { text: string; span: { draftRev: number; start: number; end: number } }[]
  read: () => string
}

function fakeComposer(initial = '', chipped = false): FakeComposer {
  const drafts: string[] = []
  const emitted: FakeComposer['emitted'] = []
  let text = initial
  let draftRev = chipped ? 4 : 0
  const snapshot = (): Record<string, unknown> => ({
    draft: text,
    draftRev,
    phase: 'idle',
    occurrences: chipped ? [{ offset: 0, length: text.length, source: 'file' }] : [],
  })
  const input = {
    state: { getSnapshot: snapshot },
    setDraft: (next: string): void => {
      text = next
      draftRev += 1
      drafts.push(next)
    },
  }
  const scope = {
    emit: (name: string, payload: FakeComposer['emitted'][number]): void => {
      expect(name).toBe('slash/input-insert-text')
      emitted.push(payload)
      text += payload.text
      draftRev += 1
    },
  }
  const ctx = {
    sessions: { scope: (): unknown => scope },
    get: (name: string): unknown => (
      name === 'conversation' ? { input: { for: (): unknown => input } } : undefined
    ),
  } as unknown as Context
  return { ctx, drafts, emitted, read: () => text }
}

describe('appendPathToConversation', () => {
  it('appends the absolute path itself to an empty draft', () => {
    const composer = fakeComposer()
    expect(appendPathToConversation(composer.ctx, 's1', '/Users/me/notes/a.md')).toBe(true)
    expect(composer.drafts).toEqual(['/Users/me/notes/a.md'])
    expect(composer.read()).toBe('/Users/me/notes/a.md')
  })

  it('separates the path from existing text with exactly one space', () => {
    const composer = fakeComposer('look at')
    appendPathToConversation(composer.ctx, 's1', '/w/a.ts')
    expect(composer.drafts).toEqual(['look at /w/a.ts'])
  })

  it('does not double the separator when the draft already ends in whitespace', () => {
    const composer = fakeComposer('already ')
    appendPathToConversation(composer.ctx, 's1', '/w/a.ts')
    expect(composer.drafts).toEqual(['already /w/a.ts'])
  })

  it('goes through the span channel on a chipped draft instead of flattening it', () => {
    const composer = fakeComposer('@a.ts', true)
    expect(appendPathToConversation(composer.ctx, 's1', '/w/b.ts')).toBe(true)
    // `setDraft` would rebuild the document from a string and drop the chip;
    // the span event keeps it and lands the text after it.
    expect(composer.drafts).toEqual([])
    expect(composer.emitted).toHaveLength(1)
    expect(composer.emitted[0]?.text).toBe(' /w/b.ts')
    expect(composer.read()).toBe('@a.ts /w/b.ts')
  })

  it('degrades to a no-op when the conversation service is unavailable', () => {
    const ctx = {
      sessions: { scope: (): unknown => ({ emit: (): void => undefined }) },
      get: (): undefined => undefined,
    } as unknown as Context
    expect(appendPathToConversation(ctx, 's1', '/w/a.ts')).toBe(false)
  })
})