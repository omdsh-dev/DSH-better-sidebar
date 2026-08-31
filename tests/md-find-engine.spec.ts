/**
 * Find engine spec: the query→regex translation and the haystack→Range
 * mapping that the markdown find bar is built on. The offset mapping is the
 * part worth guarding — an off-by-one there highlights the wrong characters,
 * which looks like a rendering bug rather than a search bug.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  MAX_MATCHES,
  collectHaystack,
  findRanges,
  queryPattern,
} from '../src/client/md-find-engine.ts'

/** Build a detached preview container from an HTML string. */
function preview(html: string): HTMLElement {
  const container = document.createElement('div')
  container.innerHTML = html
  document.body.appendChild(container)
  return container
}

/** What the reader would see highlighted, for each match. */
function texts(container: HTMLElement, query: string): string[] {
  return findRanges(container, query).map((range) => range.toString())
}

describe('queryPattern', () => {
  it('returns null for a query with nothing to search for', () => {
    expect(queryPattern('')).toBeNull()
    expect(queryPattern('   ')).toBeNull()
  })

  it('matches literally, not as a regex', () => {
    const pattern = queryPattern('a.c')
    expect(pattern?.test('a.c')).toBe(true)
    expect(queryPattern('a.c')?.test('abc')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(queryPattern('Hello')?.test('hELLO')).toBe(true)
  })

  it('lets query whitespace span any whitespace run', () => {
    expect(queryPattern('foo bar')?.test('foo\n   bar')).toBe(true)
  })
})

describe('collectHaystack', () => {
  it('separates adjacent text nodes so inline elements do not fuse', () => {
    const { text } = collectHaystack(preview('<p>hello <em>world</em></p>'))
    // "hello " and "world" are separate nodes; the separator is whitespace, so
    // a "hello world" query still matches across it.
    expect(text).toBe('hello \nworld')
  })

  it('drops script and style content', () => {
    const { text } = collectHaystack(preview('<p>keep</p><script>drop</script><style>drop</style>'))
    expect(text).toBe('keep')
  })

  it('honours the skip predicate for whole subtrees', () => {
    const container = preview('<div data-bar><input value="x">skipme</div><p>keep</p>')
    const { text } = collectHaystack(container, (el) => el.hasAttribute('data-bar'))
    expect(text).toBe('keep')
  })
})

describe('findRanges', () => {
  it('maps matches back to the exact rendered characters', () => {
    expect(texts(preview('<p>alpha beta gamma</p>'), 'beta')).toEqual(['beta'])
  })

  it('finds every occurrence in document order', () => {
    const container = preview('<p>one two</p><p>two three</p>')
    const ranges = findRanges(container, 'two')
    expect(ranges).toHaveLength(2)
    expect(ranges[0]?.startContainer.parentElement?.textContent).toBe('one two')
    expect(ranges[1]?.startContainer.parentElement?.textContent).toBe('two three')
  })

  it('matches regardless of case', () => {
    expect(texts(preview('<p>Markdown</p>'), 'markdown')).toEqual(['Markdown'])
  })

  it('matches across a soft line break inside one paragraph', () => {
    // Markdown source wrapped over two lines renders as one text node
    // containing the newline — the reader still searches for "foo bar".
    const container = preview('<p></p>')
    container.querySelector('p')!.append(document.createTextNode('foo\nbar'))
    expect(texts(container, 'foo bar')).toEqual(['foo\nbar'])
  })

  it('matches across inline element boundaries', () => {
    const ranges = findRanges(preview('<p>hello <em>world</em></p>'), 'hello world')
    expect(ranges).toHaveLength(1)
    // The separator exists only in the flattened haystack; the Range spans the
    // real nodes, so it stringifies to what the reader actually sees.
    expect(ranges[0]?.toString()).toBe('hello world')
    expect(ranges[0]?.startContainer.nodeValue).toBe('hello ')
    expect(ranges[0]?.endContainer.nodeValue).toBe('world')
  })

  it('returns nothing for an empty query', () => {
    expect(findRanges(preview('<p>anything</p>'), '   ')).toEqual([])
  })

  it('does not slide offsets on characters that change length when lowercased', () => {
    // 'İ'.toLowerCase() is two code units. A lowercase-the-haystack
    // implementation shifts every later offset by one and highlights the
    // wrong characters; the raw + /i/ search keeps them aligned.
    expect(texts(preview('<p>İstanbul target</p>'), 'target')).toEqual(['target'])
  })

  it('caps a pathological query', () => {
    const container = preview(`<p>${'a '.repeat(MAX_MATCHES + 50)}</p>`)
    expect(findRanges(container, 'a')).toHaveLength(MAX_MATCHES)
  })
})
