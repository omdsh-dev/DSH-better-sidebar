/**
 * The code-region mask must round-trip BYTE FOR BYTE, and it must stay
 * paragraph-scoped.
 *
 * WHY THIS FILE EXISTS (2026-11-07, real document): `markdown-code.ts` masks
 * fenced blocks first, then the inline spans still visible in the masked
 * text. Masked placeholders are `NUL + index + NUL`, and `restore` was a
 * SINGLE `String#replace` pass. An inline span can wrap a fence placeholder
 * (a fence line directly inside the surrounding paragraph, or — before the
 * paragraph bound — one stray backtick pairing with a run half a document
 * later), so its replacement text contained another placeholder that the one
 * pass never rescanned. Those NULs then rode through `rewriteLocalImageUrls` /
 * `rewriteLocalMarkdownLinks` into `MarkdownText`, whose markdown parser turns
 * a NUL into U+FFFD: every swallowed code block rendered as a literal
 * `�21�` paragraph. That is exactly what happened to
 * `dsh-perf-hud/docs/pack-schema.md` — §2.3 lost all three key lists to
 * `�17�` `�16�` `�15�`.
 *
 * The two cases below are DISCRIMINATING by construction: reverting either fix
 * turns them red.
 */
import { describe, expect, it } from 'vitest'
import { maskCodeRegions } from '../src/client/markdown-code.ts'
import { rewriteLocalImageUrls } from '../src/client/markdown-images.ts'
import { rewriteLocalMarkdownLinks } from '../src/client/markdown-navigation.ts'
import type { SessionScope } from '../src/client/api.ts'

const scope: SessionScope = { sessionId: 'abc', cwd: '/repo' }
const ORIGIN = 'http://gui.origin'

/** The one invariant every consumer of the mask relies on. */
function expectRoundTrip(text: string): void {
  const { masked, restore } = maskCodeRegions(text)
  expect(restore(masked)).toBe(text)
}

describe('maskCodeRegions', () => {
  it('round-trips fences and inline spans', () => {
    expectRoundTrip([
      '# Title',
      '',
      'Use `![i](./p.png)` in prose.',
      '',
      '```js',
      'const a = `[x](./a.md)`',
      '```',
      '',
      '~~~',
      '`fenced ` inside a tilde block',
      '~~~',
    ].join('\n'))
  })

  it('restores a fence whose placeholder an inline span swallowed', () => {
    // The fence sits directly after a paragraph (a fence interrupts a
    // paragraph in CommonMark), so the two stray backticks around it form ONE
    // inline span once the fence has been replaced by its placeholder. The
    // span's replacement text therefore contains the fence placeholder — the
    // inner one must still come back.
    const text = [
      'para with a stray ` tick',
      '```js',
      'const src = `![i](./p.png)`',
      '```',
      'and a closing ` tick',
    ].join('\n')
    const { masked, restore } = maskCodeRegions(text)
    expect(masked, 'the fence must be masked').toContain('\u0000')
    const restored = restore(masked)
    expect(restored).not.toContain('\u0000')
    expect(restored).toBe(text)
    // No escaped NUL may reach a markdown renderer through either rewriter.
    expect(rewriteLocalImageUrls(text, scope, '/repo/docs/README.md', ORIGIN)).toBe(text)
    expect(rewriteLocalMarkdownLinks(text, '/repo/docs/README.md', '/repo')).toBe(text)
  })

  it('does not pair backticks across a blank line', () => {
    // A code span is inline: a blank line ends the paragraph, so these two
    // lone backticks are NOT one span. Before the paragraph bound the pair
    // masked the whole region and the image between them was never rewritten.
    const text = 'stray ` tick\n\n![i](./p.png)\n\nclosing ` tick'
    const out = rewriteLocalImageUrls(text, scope, '/repo/docs/README.md', ORIGIN)
    expect(out).toContain(`${ORIGIN}/sidebar/file?sessionId=abc&path=%2Frepo%2Fdocs%2Fp.png&cwd=%2Frepo`)
    expectRoundTrip(text)
  })

  it('still masks a legitimate multi-line code span', () => {
    // A soft line break inside a span is legal CommonMark; documentation that
    // demonstrates image syntax across it must stay verbatim.
    const text = '`![i](./p.png)\nstill a span`\n'
    const out = rewriteLocalImageUrls(text, scope, '/repo/docs/README.md', ORIGIN)
    expect(out).toBe(text)
    expectRoundTrip(text)
  })
})
