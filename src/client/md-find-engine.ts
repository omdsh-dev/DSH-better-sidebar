/**
 * Find-in-preview match engine: turns a query into DOM Ranges over the
 * markdown preview's RENDERED text.
 *
 * Ranges, not DOM surgery. The preview is React-rendered (MarkdownText, the
 * mermaid lazy chunk, the sanitized HTML document renderer), so wrapping
 * matches in `<mark>` would fight React's next reconcile and corrupt the
 * sanitized subtrees. Ranges live entirely outside the DOM tree, which is
 * what lets the highlight layer (CSS Custom Highlight API) and the scroll
 * step read a match without touching a single node.
 *
 * Two details make matches behave the way a reader expects:
 *
 * - The haystack is searched RAW (never lowercased) and case-insensitivity
 *   rides the regex `i` flag. Lowercasing would be the obvious move and is a
 *   trap: some characters change LENGTH under `toLowerCase()` (Turkish 'İ'
 *   becomes two code units), which slides every later offset and lands the
 *   ranges on the wrong characters.
 * - Whitespace in the query matches any whitespace run. Rendered markdown
 *   keeps the source's soft line breaks inside a paragraph's text node, so a
 *   paragraph written across two lines holds "foo\nbar" and a reader
 *   searching "foo bar" would otherwise find nothing.
 *
 * Adjacent text nodes are joined by a single separator so inline elements do
 * not fuse ("hello <em>world</em>" stays two words). The same separator lets
 * a query match across a block boundary, which is a deliberate trade: the
 * alternative (block-aware separators) costs an ancestor walk per node for a
 * false positive the highlight makes obvious anyway.
 */

/** One text node's placement inside the flattened haystack. */
export interface TextSpan {
  node: Text
  /** Offset of `node.data[0]` within the haystack. */
  start: number
}

/** Flattened preview text plus the map back to the nodes it came from. */
export interface Haystack {
  text: string
  spans: TextSpan[]
}

/** Joins adjacent text nodes. Whitespace, so query whitespace spans it. */
const SEPARATOR = '\n'

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Query → matcher, or null when the query holds nothing to search for.
 * Trimming is load-bearing beyond tidiness: it guarantees the pattern starts
 * and ends on a non-whitespace character, so a match can never begin or end
 * on a {@link SEPARATOR} — every range boundary lands inside a real text
 * node and `rangeAt` never has to invent a position.
 */
export function queryPattern(query: string): RegExp | null {
  const trimmed = query.trim()
  if (trimmed === '') return null
  return new RegExp(trimmed.split(/\s+/).map(escapeRegExp).join('\\s+'), 'gi')
}

/**
 * Flatten a subtree's text. `skip` excludes whole subtrees — the find bar and
 * the outline bar render INSIDE the scroll container they serve, so without
 * it the find field would match its own query text.
 */
export function collectHaystack(
  root: HTMLElement,
  skip?: (element: Element) => boolean,
): Haystack {
  const spans: TextSpan[] = []
  let text = ''
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element
        const tag = element.tagName
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT
        if (skip?.(element) === true) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_SKIP
      }
      return (node as Text).data === '' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    },
  })
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const textNode = node as Text
    if (spans.length > 0) text += SEPARATOR
    spans.push({ node: textNode, start: text.length })
    text += textNode.data
  }
  return { text, spans }
}

/** The span covering `offset`, by binary search over the sorted spans. */
function spanAt(spans: readonly TextSpan[], offset: number): TextSpan | undefined {
  let low = 0
  let high = spans.length - 1
  let found: TextSpan | undefined
  while (low <= high) {
    const mid = (low + high) >> 1
    const span = spans[mid]
    if (span === undefined) break
    if (span.start <= offset) {
      found = span
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return found
}

/** A Range over `[start, end)` of the haystack, or null if it cannot be placed. */
export function rangeAt(haystack: Haystack, start: number, end: number): Range | null {
  const startSpan = spanAt(haystack.spans, start)
  const endSpan = spanAt(haystack.spans, end - 1)
  if (startSpan === undefined || endSpan === undefined) return null
  const range = document.createRange()
  range.setStart(startSpan.node, start - startSpan.start)
  range.setEnd(endSpan.node, end - endSpan.start)
  return range
}

/** Guards a pathological query ("e" on a huge document) from unbounded work. */
export const MAX_MATCHES = 2000

/** Every match of `query` in `root`, in document order (capped at {@link MAX_MATCHES}). */
export function findRanges(
  root: HTMLElement,
  query: string,
  skip?: (element: Element) => boolean,
): Range[] {
  const pattern = queryPattern(query)
  if (pattern === null) return []
  const haystack = collectHaystack(root, skip)
  const ranges: Range[] = []
  for (let match = pattern.exec(haystack.text); match !== null; match = pattern.exec(haystack.text)) {
    // A zero-length match cannot happen (the pattern always holds a literal
    // character) but would spin lastIndex forever if it ever did.
    if (match[0] === '') break
    const range = rangeAt(haystack, match.index, match.index + match[0].length)
    if (range !== null) ranges.push(range)
    if (ranges.length >= MAX_MATCHES) break
  }
  return ranges
}
