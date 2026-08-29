// @vitest-environment jsdom
/**
 * Terminal URL hyperlink helpers: the regex that scopes xterm's
 * `registerLinkProvider`, the per-line scanner that turns matches into
 * buffer ranges, the modifier gate that keeps a plain click a
 * text-selection gesture, and the scheme guard that routes only http(s)
 * to `window.open`. Pure-module unit tests — no xterm mount.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_URL_REGEX,
  findTerminalUrlsInLine,
  buildTerminalLinks,
  shouldActivateTerminalLink,
  openTerminalUrl,
} from '../src/client/terminal-links.ts'

/** Reset the regex's lastIndex between tests (it carries the `g` flag). */
function reset(): void {
  TERMINAL_URL_REGEX.lastIndex = 0
}

afterEach(() => {
  reset()
  vi.restoreAllMocks()
})

/** Build a fake MouseEvent with only the modifier fields the gate reads. */
function fakeEvent(mods: { ctrlKey?: boolean; metaKey?: boolean } = {}): MouseEvent {
  return {
    ctrlKey: mods.ctrlKey ?? false,
    metaKey: mods.metaKey ?? false,
  } as MouseEvent
}

describe('TERMINAL_URL_REGEX', () => {
  it('matches a bare http(s) URL', () => {
    expect('https://example.com/path?x=1#frag'.match(TERMINAL_URL_REGEX))
      .toEqual(['https://example.com/path?x=1#frag'])
    expect('http://localhost:3000/'.match(TERMINAL_URL_REGEX))
      .toEqual(['http://localhost:3000/'])
  })

  it('does not match a scheme that is not http(s)', () => {
    expect('file:///etc/passwd'.match(TERMINAL_URL_REGEX)).toBeNull()
    expect('mailto:foo@bar.com'.match(TERMINAL_URL_REGEX)).toBeNull()
    expect('ssh://host/path'.match(TERMINAL_URL_REGEX)).toBeNull()
    expect('javascript:alert(1)'.match(TERMINAL_URL_REGEX)).toBeNull()
  })

  it('does not match a scheme glued to a word character (word-boundary guard)', () => {
    // Regression guard: a tool printing `nothttps://example.com` should not
    // surface a clickable link — the word boundary rejects the embedded scheme.
    expect('nothttps://example.com'.match(TERMINAL_URL_REGEX)).toBeNull()
    expect('xhttps://example.com'.match(TERMINAL_URL_REGEX)).toBeNull()
  })

  it('matches when preceded by a non-word character (quote, bracket, whitespace)', () => {
    expect('"https://example.com"'.match(TERMINAL_URL_REGEX))
      .toEqual(['https://example.com'])
    expect('<https://example.com>'.match(TERMINAL_URL_REGEX))
      .toEqual(['https://example.com'])
    expect('[see https://example.com for more]'.match(TERMINAL_URL_REGEX))
      .toEqual(['https://example.com'])
  })

  it('excludes trailing wrapping punctuation from the matched URL', () => {
    // Shells commonly wrap URLs in quotes / angle brackets / parentheses;
    // the closing wrapper must not become part of the link target. The
    // character class itself rejects quotes, angle brackets, square and
    // curly braces; round parens are kept (Wikipedia URLs carry real
    // parens) and trimmed by `findTerminalUrlsInLine` instead (covered
    // in its own describe block below).
    expect('"https://example.com"'.match(TERMINAL_URL_REGEX)?.[0]).toBe('https://example.com')
    expect('<https://example.com>'.match(TERMINAL_URL_REGEX)?.[0]).toBe('https://example.com')
    expect('[https://example.com]'.match(TERMINAL_URL_REGEX)?.[0]).toBe('https://example.com')
    expect('{https://example.com}'.match(TERMINAL_URL_REGEX)?.[0]).toBe('https://example.com')
    expect('`https://example.com`'.match(TERMINAL_URL_REGEX)?.[0]).toBe('https://example.com')
  })

  it('stops at whitespace (a URL never contains a space)', () => {
    expect('run https://example.com now'.match(TERMINAL_URL_REGEX))
      .toEqual(['https://example.com'])
  })

  it('finds multiple URLs on the same line (global flag)', () => {
    const matches = 'see https://a.com and http://b.com/path'.match(TERMINAL_URL_REGEX)
    expect(matches).toEqual(['https://a.com', 'http://b.com/path'])
  })

  it('keeps the path, query and fragment intact', () => {
    const url = 'https://example.com/a/b/c?d=1&e=2#section-3'
    expect(url.match(TERMINAL_URL_REGEX)?.[0]).toBe(url)
  })

  it('does not match plain text without a scheme', () => {
    expect('example.com'.match(TERMINAL_URL_REGEX)).toBeNull()
    expect('see the docs at example.com/path'.match(TERMINAL_URL_REGEX)).toBeNull()
  })
})

describe('findTerminalUrlsInLine', () => {
  it('returns an empty array when the line has no URL', () => {
    expect(findTerminalUrlsInLine('just some text')).toEqual([])
    expect(findTerminalUrlsInLine('')).toEqual([])
    expect(findTerminalUrlsInLine('file:///etc/passwd')).toEqual([])
  })

  it('returns the URL text and its 0-based start offset', () => {
    expect(findTerminalUrlsInLine('see https://example.com now'))
      .toEqual([{ start: 4, text: 'https://example.com' }])
    expect(findTerminalUrlsInLine('https://example.com'))
      .toEqual([{ start: 0, text: 'https://example.com' }])
  })

  it('returns every URL on the line in source order', () => {
    expect(findTerminalUrlsInLine('https://a.com and http://b.com/path')).toEqual([
      { start: 0, text: 'https://a.com' },
      { start: 18, text: 'http://b.com/path' },
    ])
  })

  it('trims wrapping punctuation from the matched text', () => {
    expect(findTerminalUrlsInLine('"https://example.com"')).toEqual([
      { start: 1, text: 'https://example.com' },
    ])
    expect(findTerminalUrlsInLine('<https://example.com>')).toEqual([
      { start: 1, text: 'https://example.com' },
    ])
  })

  it('strips trailing closing parens not balanced by an opening paren', () => {
    // Shell-wrapped URLs: `(https://example.com)` — the regex captures the
    // trailing `)` (round parens are kept so Wikipedia-style URLs work),
    // and findTerminalUrlsInLine trims the unmatched excess.
    expect(findTerminalUrlsInLine('(https://example.com)')).toEqual([
      { start: 1, text: 'https://example.com' },
    ])
    expect(findTerminalUrlsInLine('see (https://example.com) here')).toEqual([
      { start: 5, text: 'https://example.com' },
    ])
  })

  it('keeps balanced parens inside Wikipedia-style URLs intact', () => {
    const url = 'https://en.wikipedia.org/wiki/Python_(programming_language)'
    expect(findTerminalUrlsInLine(`see ${url}`)).toEqual([{ start: 4, text: url }])
    // Trailing balanced closer is part of the URL, not a wrapper.
    expect(findTerminalUrlsInLine(url)).toEqual([{ start: 0, text: url }])
  })

  it('strips only the unmatched excess when the URL has both its own parens and a wrapper closer', () => {
    // URL has 1 opening and 1 closing paren of its own, plus a wrapper
    // closing paren: `https://en.wikipedia.org/wiki/Foo_(bar))`
    // → opens=1, closers=2, excess=1 → strip one trailing `)`.
    expect(findTerminalUrlsInLine('https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual([
      { start: 0, text: 'https://en.wikipedia.org/wiki/Foo_(bar)' },
    ])
  })

  it('does not carry lastIndex state across calls (the g flag is module-shared)', () => {
    // First call leaves lastIndex set; a second call on a different line
    // must still scan from the start.
    findTerminalUrlsInLine('https://a.com')
    expect(findTerminalUrlsInLine('https://b.com')).toEqual([
      { start: 0, text: 'https://b.com' },
    ])
    // And a third call after a partial match must also reset cleanly.
    TERMINAL_URL_REGEX.exec('https://c.com') // leaves lastIndex past the match
    expect(findTerminalUrlsInLine('https://d.com')).toEqual([
      { start: 0, text: 'https://d.com' },
    ])
  })
})

describe('buildTerminalLinks', () => {
  it('returns an empty array when the line has no URL', () => {
    expect(buildTerminalLinks('plain text', 5)).toEqual([])
    expect(buildTerminalLinks('', 0)).toEqual([])
  })

  it('builds a descriptor with xterm 1-based x coords and inclusive end', () => {
    // Line: "see https://example.com now"
    //       0123456789...
    // URL starts at 0-based index 4, length 19 ('https://example.com').
    // xterm x is 1-based: start cell = 4+1 = 5, last cell = 4+19 = 23.
    expect(buildTerminalLinks('see https://example.com now', 7)).toEqual([
      {
        range: { start: { x: 5, y: 7 }, end: { x: 23, y: 7 } },
        text: 'https://example.com',
      },
    ])
  })

  it('places a URL at the start of the line at x=1', () => {
    expect(buildTerminalLinks('https://example.com', 3)).toEqual([
      {
        range: { start: { x: 1, y: 3 }, end: { x: 19, y: 3 } },
        text: 'https://example.com',
      },
    ])
  })

  it('uses the buffer line number passed in as the range y', () => {
    const links = buildTerminalLinks('https://example.com', 42)
    expect(links[0]?.range.start.y).toBe(42)
    expect(links[0]?.range.end.y).toBe(42)
  })

  it('builds one descriptor per URL on a multi-URL line, in source order', () => {
    const links = buildTerminalLinks('https://a.com http://b.com', 1)
    expect(links).toHaveLength(2)
    expect(links[0]?.text).toBe('https://a.com')
    expect(links[1]?.text).toBe('http://b.com')
    // Non-overlapping ranges, in order.
    expect(links[0]!.range.end.x).toBeLessThan(links[1]!.range.start.x)
  })
})

describe('shouldActivateTerminalLink', () => {
  it('returns false for a plain click (no modifier)', () => {
    expect(shouldActivateTerminalLink(fakeEvent())).toBe(false)
  })

  it('returns true when Ctrl is held (Win/Linux convention)', () => {
    expect(shouldActivateTerminalLink(fakeEvent({ ctrlKey: true }))).toBe(true)
  })

  it('returns true when Cmd is held (mac convention)', () => {
    expect(shouldActivateTerminalLink(fakeEvent({ metaKey: true }))).toBe(true)
  })

  it('returns true when both modifiers are held (defensive — some remotes send both)', () => {
    expect(shouldActivateTerminalLink(fakeEvent({ ctrlKey: true, metaKey: true }))).toBe(true)
  })

  it('returns false when only Shift / Alt are held (those are not open modifiers)', () => {
    expect(shouldActivateTerminalLink(fakeEvent())).toBe(false)
    // Construct with shiftKey/altKey only; the gate ignores them.
    const event = { ctrlKey: false, metaKey: false, shiftKey: true, altKey: true } as MouseEvent
    expect(shouldActivateTerminalLink(event)).toBe(false)
  })
})

describe('openTerminalUrl', () => {
  it('opens an http URL in a new tab with noopener,noreferrer', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    expect(openTerminalUrl('http://example.com')).toBe(true)
    expect(open).toHaveBeenCalledWith('http://example.com/', '_blank', 'noopener,noreferrer')
  })

  it('opens an https URL', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    expect(openTerminalUrl('https://example.com/path?x=1')).toBe(true)
    expect(open).toHaveBeenCalledWith(
      'https://example.com/path?x=1',
      '_blank',
      'noopener,noreferrer',
    )
  })

  it('rejects file:// (printed by tools, never handed to window.open)', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    expect(openTerminalUrl('file:///etc/passwd')).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('rejects mailto:', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    expect(openTerminalUrl('mailto:foo@bar.com')).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('rejects javascript: (defense-in-depth even though the regex skips it)', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    expect(openTerminalUrl('javascript:alert(1)')).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('rejects a malformed URL string without throwing', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    expect(openTerminalUrl('https://')).toBe(false)
    expect(openTerminalUrl('not a url at all')).toBe(false)
    expect(openTerminalUrl('')).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
})

