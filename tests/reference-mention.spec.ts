import { describe, expect, it } from 'vitest'
import { directoryMention, mentionFor } from '../src/client/conversation-draft.ts'

describe('mentionFor', () => {
  it('formats a plain relative file path as an @file mention', () => {
    expect(mentionFor('src/client/paths.ts', 'file')).toEqual({
      mention: '@src/client/paths.ts',
      label: 'paths.ts',
    })
  })

  it('quotes a path containing whitespace and keeps the full basename', () => {
    expect(mentionFor('docs/plan files/design notes.md', 'file')).toEqual({
      mention: '@"docs/plan files/design notes.md"',
      label: 'design notes.md',
    })
  })

  it('trims a trailing separator before deriving the basename', () => {
    expect(mentionFor('src/client/', 'file')).toEqual({
      mention: '@src/client',
      label: 'client',
    })
  })

  it('rejects embedded quotes and control characters for both kinds', () => {
    expect(mentionFor('src/a"b.ts', 'file')).toBeUndefined()
    expect(mentionFor('src/a\u0000b.ts', 'file')).toBeUndefined()
    expect(mentionFor('src/a"b', 'folder')).toBeUndefined()
  })

  it('keeps the trailing slash on a plain folder mention', () => {
    expect(mentionFor('docs', 'folder')).toEqual({ mention: '@docs/', label: 'docs' })
    expect(mentionFor('docs/', 'folder')).toEqual({ mention: '@docs/', label: 'docs' })
    // The cwd itself stays the relative root spelling the composer expects.
    expect(mentionFor('.', 'folder')).toEqual({ mention: '@./', label: '.' })
  })

  it('closes the quote around the trailing slash of a folder with whitespace', () => {
    expect(mentionFor('my dir', 'folder')).toEqual({ mention: '@"my dir/"', label: 'my dir' })
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
