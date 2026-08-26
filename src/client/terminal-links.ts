/**
 * Terminal URL hyperlinks: xterm's `registerLinkProvider` is fed per-line
 * link descriptors built from the pty stream, so URLs printed by any tool
 * become hoverable / clickable spans.
 *
 * To stay out of the user's way (a terminal's primary interaction is text
 * selection, not browsing), a click only activates when the user holds
 * Ctrl (Win/Linux) or Cmd (mac) — a plain click is left for xterm's
 * normal selection handling. Only http(s) URLs are dispatched to the
 * browser; other schemes (`file://`, `mailto:`, `javascript:`, …) are
 * underlined for visibility but rejected at activation, so a `file://`
 * URL printed by a tool stays inert instead of being handed to
 * `window.open`.
 *
 * Kept as a pure module (no xterm import) so the regex, the line
 * scanner, the modifier gate and the scheme guard are unit-testable
 * without mounting a terminal. `buildTerminalLinks` returns plain-object
 * descriptors whose shape matches xterm's `ILink` minus the `activate`
 * callback — the caller attaches `activate` (which closes over the
 * event modifier check + `openTerminalUrl`) so this module never
 * imports xterm types.
 */

/** Scheme allowlist for activation. Only http(s) is opened externally. */
const OPENABLE_SCHEMES = new Set(['http:', 'https:'])

/**
 * The URL pattern used to scan each terminal line.
 *
 * A word boundary (`\b`) guards the leading scheme so `notttps://…` does
 * not match. The character class excludes ASCII whitespace and the
 * wrapping punctuation that shells commonly emit around URLs (quotes,
 * angle brackets, brackets/braces, pipes, backslashes, backticks) so a
 * URL printed as `"https://example.com"` or `<https://example.com>` does
 * not drag the wrapping character into the link target.
 *
 * Carries the `g` flag so `findTerminalUrlsInLine` can iterate every
 * match on a line; callers must reset `lastIndex` before reuse (the
 * helper does this defensively).
 */
export const TERMINAL_URL_REGEX = /\bhttps?:\/\/[^\s"'<>\[\]{}|\\^`]+/gi

/** A URL match in a terminal line: the text and its 0-based start offset. */
export interface TerminalUrlMatch {
  /** 0-based start index of the URL within the line string. */
  start: number
  /** The matched URL text. */
  text: string
}

/**
 * Strip trailing closing parens that are not balanced by an opening paren
 * earlier in the URL.
 *
 * The regex's character class keeps `(` and `)` (Wikipedia-style URLs
 * carry real parens: `…/Python_(programming_language)`), so a URL wrapped
 * in parens by a shell (`(https://example.com)`) captures the trailing
 * `)`. Balanced pairs are kept intact; only the unmatched excess is
 * trimmed, so:
 * - `https://example.com)` → `https://example.com`
 * - `https://en.wikipedia.org/wiki/Python_(programming_language)` → unchanged
 * - `https://example.com/(` → unchanged (more openers than closers; the
 *   trailing `(` is the URL's own, not a wrapper)
 */
function trimUnbalancedTrailingParens(url: string): string {
  let opens = 0
  let closers = 0
  for (let i = 0; i < url.length; i += 1) {
    const ch = url[i]
    if (ch === '(') opens += 1
    else if (ch === ')') closers += 1
  }
  const excess = closers - opens
  if (excess <= 0) return url
  let end = url.length
  let stripped = 0
  while (end > 0 && url[end - 1] === ')' && stripped < excess) {
    end -= 1
    stripped += 1
  }
  return url.slice(0, end)
}

/**
 * Find every http(s) URL in a line of terminal text, in source order
 * with 0-based start offsets. A link provider maps these to buffer
 * ranges for xterm's `registerLinkProvider`.
 *
 * Trailing unmatched closing parens are trimmed from each match (see
 * {@link trimUnbalancedTrailingParens}), so a URL wrapped in parens by
 * a shell opens without the trailing `)`, while Wikipedia-style URLs
 * with balanced parens stay intact.
 *
 * Resets the regex's `lastIndex` before and after the scan so a
 * previous partial iteration can't desynchronize a later one (the
 * regex carries the `g` flag and is module-shared).
 */
export function findTerminalUrlsInLine(line: string): TerminalUrlMatch[] {
  TERMINAL_URL_REGEX.lastIndex = 0
  const matches: TerminalUrlMatch[] = []
  let m: RegExpExecArray | null
  while ((m = TERMINAL_URL_REGEX.exec(line)) !== null) {
    const trimmed = trimUnbalancedTrailingParens(m[0])
    if (trimmed.length > 0) {
      matches.push({ start: m.index, text: trimmed })
    }
  }
  TERMINAL_URL_REGEX.lastIndex = 0
  return matches
}

/**
 * A buffer range in xterm's coordinate system. xterm's cell `x` is
 * 1-based (1..cols) and `y` is the buffer line number; the `end` is
 * inclusive (the last cell covered by the link). Structurally
 * compatible with xterm's `IBufferRange` so the caller can pass it
 * straight through without importing xterm types here.
 */
export interface TerminalLinkRange {
  start: { x: number; y: number }
  end: { x: number; y: number }
}

/**
 * A link descriptor: a buffer range plus the URL text. The caller
 * (the link provider in `TerminalView`) attaches the `activate`
 * callback, which closes over the modifier gate and `openTerminalUrl`.
 */
export interface TerminalLinkDescriptor {
  range: TerminalLinkRange
  text: string
}

/**
 * Build link descriptors for every URL found in a terminal line.
 *
 * @param lineText - the line's text (e.g. from
 *   `IBufferLine.translateToString(true)`).
 * @param lineNumber - the buffer line number xterm passed to
 *   `ILinkProvider.provideLinks` (used as the `y` of every range; URLs
 *   never span wrapped lines because each wrapped row is its own
 *   buffer line).
 * @returns descriptors in source order; empty when the line has no URL.
 */
export function buildTerminalLinks(lineText: string, lineNumber: number): TerminalLinkDescriptor[] {
  return findTerminalUrlsInLine(lineText).map(({ start, text: url }) => ({
    range: {
      // xterm's cell `x` is 1-based; `start` is 0-based from
      // translateToString, so the first URL character sits at x = start + 1.
      start: { x: start + 1, y: lineNumber },
      // `end` is inclusive: the last URL character is at 0-based
      // (start + url.length - 1), which is 1-based (start + url.length).
      end: { x: start + url.length, y: lineNumber },
    },
    text: url,
  }))
}

/**
 * Decide whether a click on a terminal link should activate (open the URL).
 *
 * Mirrors what every modern terminal does (Windows Terminal, iTerm2, the
 * VSCode integrated terminal): a plain click stays a text-selection
 * gesture, and only Ctrl (Win/Linux) or Cmd (mac) hands the URL to the
 * browser. The modifier is read off the activating `MouseEvent`, not
 * tracked separately, so a key-up between hover and click never
 * desynchronizes the gate.
 */
export function shouldActivateTerminalLink(event: MouseEvent): boolean {
  return event.ctrlKey || event.metaKey
}

/**
 * Open a URL matched in the terminal, with a scheme guard so a printed
 * `file://` or anything that slipped past the regex cannot reach
 * `window.open`. The URL is constructed via `new URL(...)` which throws
 * on malformed input; the catch makes the function total so the xterm
 * handler never throws into the terminal's event loop.
 *
 * @returns `true` when the URL was dispatched to `window.open`, `false`
 *   when it was rejected (bad URL, disallowed scheme, no `window`).
 */
export function openTerminalUrl(uri: string): boolean {
  if (typeof window === 'undefined') return false
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return false
  }
  if (!OPENABLE_SCHEMES.has(url.protocol)) return false
  window.open(url.toString(), '_blank', 'noopener,noreferrer')
  return true
}
