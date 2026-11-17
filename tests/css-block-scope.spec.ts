/**
 * Block-scope guard for the client stylesheets.
 *
 * layout.css shipped from 36fbc5a up to 0.27.0 with an unclosed
 * @media (prefers-reduced-motion: reduce) block (issue #955): every rule after
 * it became a descendant of that media query, so the styles that followed
 * applied only to users who had reduce-motion turned on.
 *
 * Text assertions could not see it: expect(css).toContain(...) matches
 * selector text wherever it sits, and nesting does not change text. These
 * assertions read the block structure instead — every client stylesheet has
 * to close what it opens — so the same mistake fails here.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')

interface Block {
  /** The selector (or at-rule prelude) that opened this block, normalised. */
  prelude: string
  /** The nesting depth the block opens at: 0 = top level. */
  depth: number
  /** Index of the enclosing block in the same list, or -1 at top level. */
  parent: number
}

interface Scan {
  blocks: Block[]
  /** Blocks still open at end of file. */
  unclosed: number
  /** Closing braces with nothing to close. */
  extraClosers: number
}

/**
 * Whitespace collapsed and attribute-value quotes dropped, so a reformatted or
 * re-quoted selector (div[role="menu"] vs div[role=menu]) still compares equal
 * to the selector a test names — this guard is about block structure, not text.
 */
function normalize(selector: string): string {
  return selector
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\[([-\w]+)\s*([~|^$*]?=)\s*"([^"]*)"\]/g, '[$1$2$3]')
    .replace(/\[([-\w]+)\s*([~|^$*]?=)\s*'([^']*)'\]/g, '[$1$2$3]')
}

/**
 * Walk a stylesheet and report every block it opens, with the depth it opens at.
 * Comment bodies are dropped as they are read and quoted strings are consumed
 * whole — including the quotes inside a url() token — so a brace inside
 * content: "}" or inside a data URI can neither open nor close a block.
 */
function scanBlocks(css: string): Scan {
  const blocks: Block[] = []
  const stack: number[] = []
  let extraClosers = 0
  let prelude = ''
  let i = 0

  /** The quoted string that starts at `from`. */
  function quoted(from: number): string {
    const quote = css.charAt(from)
    let text = quote
    let j = from + 1
    while (j < css.length) {
      const inner = css.charAt(j)
      text += inner
      j += 1
      if (inner === '\\') { text += css.charAt(j); j += 1; continue }
      if (inner === quote) break
    }
    i = j
    return text
  }

  /** The url(...) token that starts at `from`, unquoted payload included. */
  function urlToken(from: number): string {
    let text = ''
    let j = from
    let parens = 0
    while (j < css.length) {
      const inner = css.charAt(j)
      if (inner === '"' || inner === "'") { text += quoted(j); j = i; continue }
      text += inner
      j += 1
      if (inner === '(') parens += 1
      else if (inner === ')') { parens -= 1; if (parens === 0) break }
    }
    i = j
    return text
  }

  while (i < css.length) {
    const ch = css.charAt(i)
    if (ch === '/' && css.charAt(i + 1) === '*') {
      const close = css.indexOf('*/', i + 2)
      i = close === -1 ? css.length : close + 2
      prelude += ' '
      continue
    }
    if (ch === '"' || ch === "'") { prelude += quoted(i); continue }
    if (css.slice(i, i + 4).toLowerCase() === 'url(') { prelude += urlToken(i); continue }
    if (ch === '{') {
      const parent = stack.length > 0 ? (stack[stack.length - 1] ?? -1) : -1
      blocks.push({ prelude: normalize(prelude), depth: stack.length, parent })
      stack.push(blocks.length - 1)
      prelude = ''
      i += 1
      continue
    }
    if (ch === '}') {
      if (stack.length === 0) extraClosers += 1
      else stack.pop()
      prelude = ''
      i += 1
      continue
    }
    prelude += ch
    i += 1
  }
  return { blocks, unclosed: stack.length, extraClosers }
}

function cssFilesUnder(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...cssFilesUnder(path))
    else if (entry.name.toLowerCase().endsWith('.css')) found.push(path)
  }
  return found
}

describe('client stylesheet block scope', () => {
  it('closes every block it opens, in every stylesheet under src/', () => {
    const files = cssFilesUnder(join(ROOT, 'src'))
    // A walk that silently found nothing would make the assertion below vacuous.
    expect(files.length).toBeGreaterThan(0)
    const unbalanced = files
      .map(path => ({ path, ...scanBlocks(readFileSync(path, 'utf8')) }))
      .filter(({ unclosed, extraClosers }) => unclosed !== 0 || extraClosers !== 0)
      .map(({ path, unclosed, extraClosers }) => {
        const faults = [
          unclosed > 0 ? unclosed + ' unclosed block(s)' : '',
          extraClosers > 0 ? extraClosers + ' extra closing brace(s)' : '',
        ].filter(Boolean)
        return relative(ROOT, path) + ': ' + faults.join(', ')
      })
    expect(unbalanced).toEqual([])
  })
})
