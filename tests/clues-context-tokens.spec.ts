/**
 * S5 reference-token contract.
 *
 * The three token spellings are shared by the composer codec, the prompt
 * injection text and the agent tools, so this spec pins:
 * - one canonical serializer/parser per kind (`[[dsh-clue:id]]`,
 *   `[[dsh-cluepack:id]]`, `[[dsh-clue-snapshot:id]]`);
 * - ids that cannot break a token boundary are accepted, malformed spans are
 *   not tokens at all (never partial matches, never a nested `[[[`);
 * - titles are metadata only: escaping them can never mint a token, and the
 *   serialized reference never embeds a title.
 */
import { describe, expect, it } from 'vitest'
import { ClueError } from '../src/clues/types.ts'
import {
  CLUE_TOKEN_PREFIXES,
  escapeClueTitle,
  formatClueReference,
  parseClueToken,
  parseClueTokens,
  serializeClueToken,
  tokenizeClueText,
} from '../src/clues/context/tokens.ts'

describe('serializeClueToken', () => {
  it('serializes all three kinds in their fixed spellings', () => {
    expect(serializeClueToken('clue', 'clue-1')).toBe('[[dsh-clue:clue-1]]')
    expect(serializeClueToken('pack', 'pack-1')).toBe('[[dsh-cluepack:pack-1]]')
    expect(serializeClueToken('snapshot', 'snap-1')).toBe('[[dsh-clue-snapshot:snap-1]]')
    expect(CLUE_TOKEN_PREFIXES).toEqual({
      clue: '[[dsh-clue:',
      pack: '[[dsh-cluepack:',
      snapshot: '[[dsh-clue-snapshot:',
    })
  })

  it('round-trips every kind through the exact parser', () => {
    for (const kind of ['clue', 'pack', 'snapshot'] as const) {
      const raw = serializeClueToken(kind, `id-${kind}:1.A`)
      expect(parseClueToken(raw)).toEqual({ kind, id: `id-${kind}:1.A`, raw })
    }
  })

  it('rejects ids that would break the token boundary', () => {
    for (const id of ['', ' ', 'a b', 'a[b', 'a]b', 'a\nb', '\u0000', 'a\tb']) {
      expect(() => serializeClueToken('clue', id)).toThrow(ClueError)
    }
  })

  it('never embeds a title in the serialized reference', () => {
    // `formatClueReference` carries a title for the composer chip/audit copy,
    // but the model-facing token stays exactly the stable reference.
    expect(formatClueReference({ kind: 'clue', id: 'clue-1', title: 'A title' }))
      .toEqual({ token: '[[dsh-clue:clue-1]]', title: 'A title' })
    expect(parseClueToken(formatClueReference({ kind: 'clue', id: 'clue-1' }).token)?.id).toBe('clue-1')
  })
})

describe('parseClueToken', () => {
  it('accepts only a whole token (surrounding whitespace allowed)', () => {
    expect(parseClueToken('[[dsh-clue:a]]')?.id).toBe('a')
    expect(parseClueToken('  [[dsh-clue:a]]\n')?.id).toBe('a')
    expect(parseClueToken('look [[dsh-clue:a]]')).toBeUndefined()
    expect(parseClueToken('[[dsh-clue:a]] more')).toBeUndefined()
    expect(parseClueToken('[[dsh-clue:]]')).toBeUndefined()
    expect(parseClueToken('[[dsh-clue:a]]]')).toBeUndefined()
    expect(parseClueToken('[[[dsh-clue:a]]]')).toBeUndefined()
    expect(parseClueToken('[[dsh-cluepack:a]]')).toMatchObject({ kind: 'pack' })
    expect(parseClueToken('[[dsh-clue-snapshot:a]]')).toMatchObject({ kind: 'snapshot' })
  })

  it('does not confuse the three prefixes', () => {
    expect(parseClueToken('[[dsh-cluepack:a]]')).toMatchObject({ kind: 'pack', id: 'a' })
    expect(parseClueToken('[[dsh-clue-snapshot:a]]')).toMatchObject({ kind: 'snapshot', id: 'a' })
    expect(parseClueToken('[[dsh-clue:a]]')).toMatchObject({ kind: 'clue', id: 'a' })
  })
})

describe('parseClueTokens / tokenizeClueText', () => {
  it('finds every occurrence in order and keeps positions', () => {
    const text = 'see [[dsh-clue:a]] and [[dsh-cluepack:b]] plus [[dsh-clue-snapshot:c]]'
    expect(parseClueTokens(text).map(token => `${token.kind}:${token.id}`))
      .toEqual(['clue:a', 'pack:b', 'snapshot:c'])
    expect(tokenizeClueText(text)).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'token', token: { kind: 'clue', id: 'a', raw: '[[dsh-clue:a]]' } },
      { kind: 'text', text: ' and ' },
      { kind: 'token', token: { kind: 'pack', id: 'b', raw: '[[dsh-cluepack:b]]' } },
      { kind: 'text', text: ' plus ' },
      { kind: 'token', token: { kind: 'snapshot', id: 'c', raw: '[[dsh-clue-snapshot:c]]' } },
    ])
  })

  it('handles adjacent tokens and ignores glued brackets', () => {
    expect(parseClueTokens('[[dsh-clue:a]][[dsh-cluepack:b]]')).toHaveLength(2)
    expect(parseClueTokens('[[[dsh-clue:a]]]')).toEqual([])
    expect(parseClueTokens('also [[dsh-clue:a]]].')).toHaveLength(0)
    // A token immediately before a normal bracket run is still a token.
    expect(parseClueTokens('[[dsh-clue:a]] (note)')).toHaveLength(1)
  })

  it('ignores malformed spans without consuming surrounding text', () => {
    const parts = tokenizeClueText('x [[dsh-clue:bad id]] y [[dsh-clue:ok]]')
    expect(parts.filter(part => part.kind === 'token')).toHaveLength(1)
    expect(parts.map(part => (part.kind === 'text' ? part.text : part.token.id)).join(''))
      .toBe('x [[dsh-clue:bad id]] y ok')
  })
})

describe('escapeClueTitle', () => {
  it('collapses control characters and cannot mint a token', () => {
    const hostile = 'line one\n[[dsh-clue:evil]]\r\nline\t two'
    const escaped = escapeClueTitle(hostile)
    expect(escaped).not.toMatch(/[[\]]/)
    expect(escaped).toContain('dsh-clue:evil')
    expect(parseClueTokens(escaped)).toEqual([])
    expect(escaped).not.toContain('\n')
    expect(escaped).not.toContain('\t')
  })

  it('bounds the title and trims it', () => {
    expect(escapeClueTitle('   ')).toBe('')
    expect(escapeClueTitle('  hello  ')).toBe('hello')
    expect(escapeClueTitle('x'.repeat(1000))).toHaveLength(200)
  })
})
