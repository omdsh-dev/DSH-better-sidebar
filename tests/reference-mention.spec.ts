import { describe, expect, it } from 'vitest'
import { directoryMention, fileMention } from '../src/client/conversation-draft.ts'

describe('fileMention', () => {
  it('formats a plain relative file path as an @file mention', () => {
    expect(fileMention('src/client/paths.ts')).toEqual({
      mention: '@src/client/paths.ts',
      label: 'paths.ts',
    })
  })

  it('quotes a path containing whitespace and keeps the full basename', () => {
    expect(fileMention('docs/plan files/design notes.md')).toEqual({
      mention: '@"docs/plan files/design notes.md"',
      label: 'design notes.md',
    })
  })

  it('trims a trailing separator before deriving the basename', () => {
    expect(fileMention('src/client/')).toEqual({
      mention: '@src/client',
      label: 'client',
    })
  })

  it('rejects embedded quotes and control characters', () => {
    expect(fileMention('src/a"b.ts')).toBeUndefined()
    expect(fileMention('src/a\u0000b.ts')).toBeUndefined()
  })
})

describe('directoryMention', () => {
  it.each([
    ['src', '@src/'],
    ['my dir', '@"my dir/"'],
    ['docs/my dir/notes here', '@"docs/my dir/notes here/"'],
    ['src/', '@src/'],
    ['.', '@./'],
    ['src\\my dir\\', '@"src/my dir/"'],
    ['src\\my dir/nested', '@"src/my dir/nested/"'],
  ])('formats %s as a complete plain-text directory token', (path, mention) => {
    expect(directoryMention(path)).toBe(mention)
  })

  it.each(['a"b', 'a\n b', 'a\t b', 'a\u0000b', 'a\u007fb', 'a\u0085b'])('rejects an unrepresentable directory %j', path => {
    expect(directoryMention(path)).toBeUndefined()
  })
})
