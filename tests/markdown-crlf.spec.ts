/**
 * Line endings are not content: every line-based scanner in the markdown
 * pipeline must read a CRLF document exactly like the same document with LF
 * endings.
 *
 * WHY THIS FILE EXISTS: the pipeline's scanners split a document on `\n` and
 * then reason about each line (`isBlank`, a closed-ATX heading, a closing
 * fence). A Windows checkout — `core.autocrlf=true`, which is both the
 * `ci-windows` lane and every user who clones on Windows — hands them `\r\n`,
 * and a `\r` left at the end of a line is invisible in the rendered output but
 * not to those predicates. Measured on this repo's own README before the fix:
 * the HTML-run splitter produced 4 segments instead of 36 (an HTML run stayed
 * open across the blank line that should have ended it and swallowed the
 * markdown after it), `splitMermaidBlocks` never closed a fence, and
 * `maskCodeRegions` masked everything from the first fence to the end of the
 * file, so the link rewriter stopped claiming every `.md` link after it. The
 * same document with LF endings was correct in all three.
 *
 * The invariant pinned here is that whole contract, scanner by scanner: the
 * CRLF spelling's output must equal the LF spelling's output once `\r` is
 * ignored. These cases are DISCRIMINATING by construction — reverting any of
 * the three `\r` fixes in `src/client` turns them red (the CRLF half diverges
 * from the LF half), which is exactly how the `ci-windows` failures got here:
 * only the CRLF half of each pair was ever exercised there.
 */
import { describe, expect, it } from 'vitest'
import {
  analyzeMarkdownHtml,
  splitHtmlBlocks,
  type AnalyzedMarkdownHtml,
  type MdHtmlSegment,
} from '../src/client/markdown-html.ts'
import { splitMermaidBlocks, type MdBlock } from '../src/client/mermaid-blocks.ts'
import { maskCodeRegions } from '../src/client/markdown-code.ts'
import { rewriteLocalMarkdownLinks } from '../src/client/markdown-navigation.ts'
import { rewriteLocalImageUrls } from '../src/client/markdown-images.ts'
import type { SessionScope } from '../src/client/api.ts'

/** One document, both spellings — every case below compares the two. */
const LF = [
  '# 标题',
  '',
  '<!-- hero -->',
  '',
  '<div align="center">',
  '  <img alt="badge" src="https://img.shields.io/badge/x-y-blue" />',
  '</div>',
  '',
  '## 🚀 安装',
  '',
  '```sh',
  'dsh plugin --profile web add dsh-better-sidebar',
  '```',
  '',
  '[other](./other.md#安装)',
  '',
  '~~~text',
  '[demonstration](./demonstration.md#标题)',
  '~~~',
  '',
  '![image](./pic.png)',
  '',
].join('\n')
const CRLF = LF.replace(/\n/g, '\r\n')

/** `\r` is a line terminator, so dropping it reduces one spelling to the other. */
const stripCr = (value: string): string => value.replace(/\r/g, '')

/** The CRLF spelling of a split document, reduced to the LF one. */
function segmentsLf(segments: readonly MdHtmlSegment[]): MdHtmlSegment[] {
  return segments.map(segment => ({ kind: segment.kind, text: stripCr(segment.text) }))
}

/** The CRLF spelling of a whole-document analysis, reduced to the LF one. */
function analysisLf(info: AnalyzedMarkdownHtml): AnalyzedMarkdownHtml {
  return {
    ...info,
    segments: segmentsLf(info.segments),
    referenceDefinitions: stripCr(info.referenceDefinitions),
  }
}

/** The CRLF spelling of a mermaid split, reduced to the LF one. */
function blocksLf(blocks: readonly MdBlock[]): MdBlock[] {
  return blocks.map(block => block.kind === 'mermaid'
    ? { kind: 'mermaid' as const, code: stripCr(block.code) }
    : { kind: 'markdown' as const, text: stripCr(block.text) })
}

const SCOPE: SessionScope = { sessionId: 's1', cwd: '/p' }
const DOC = '/p/docs/README.md'

describe('the markdown pipeline reads CRLF and LF documents identically', () => {
  it('splitHtmlBlocks: an HTML run ends at a blank line in both spellings', () => {
    // The regression: `isBlank` was `/^[ \t]*$/`, so a CRLF blank line (`'\r'`)
    // was content. The `<div>` run stayed open and swallowed `## 🚀 安装` and
    // everything after it as raw HTML, i.e. the preview rendered markdown as
    // text.
    expect(segmentsLf(splitHtmlBlocks(CRLF))).toEqual(splitHtmlBlocks(LF))
    // Guard the guard: the LF half really does carry the markdown after the
    // HTML run as MARKDOWN (a splitter that returned one HTML segment for the
    // whole document would satisfy the equality above for the wrong reason).
    const segments = splitHtmlBlocks(LF)
    const markdown = segments.filter(segment => segment.kind === 'markdown').map(segment => segment.text).join('\n')
    const html = segments.filter(segment => segment.kind === 'html').map(segment => segment.text).join('\n')
    expect(markdown).toContain('## 🚀 安装')
    expect(markdown).toContain('![image](./pic.png)')
    expect(html).not.toContain('安装')
    expect(html).toContain('<div align="center">')
  })

  it('splitHtmlBlocks: a minimal HTML block + blank line + markdown document', () => {
    const lf = '# a\n\n<div>x</div>\n\n# b\n'
    expect(segmentsLf(splitHtmlBlocks(lf.replace(/\n/g, '\r\n')))).toEqual(splitHtmlBlocks(lf))
    // `# b` is a markdown heading, not part of the `<div>` run.
    expect(splitHtmlBlocks(lf).map(segment => segment.kind)).toEqual(['markdown', 'html', 'markdown'])
  })

  it('analyzeMarkdownHtml: same segmentation, gates and reference definitions', () => {
    const lf = `${LF}\n[ref]: ./target.md#锚点\n`
    expect(analysisLf(analyzeMarkdownHtml(lf.replace(/\n/g, '\r\n')))).toEqual(analyzeMarkdownHtml(lf))
  })

  it('maskCodeRegions: a CRLF fence closes where its LF twin does', () => {
    // The regression: `closesFence` tested the fence tail with `/^[ \t]*$/`,
    // which a `\r` fails — no fence ever closed, so the masked region ran to
    // the end of the file and every later pass skipped a masked document.
    expect(stripCr(maskCodeRegions(CRLF).masked)).toEqual(maskCodeRegions(LF).masked)
    // The mask really does stop at the closing fence: the text right after it
    // survives unmasked in both spellings.
    expect(maskCodeRegions(LF).masked).toContain('[other](./other.md#安装)')
    expect(stripCr(maskCodeRegions(CRLF).masked)).toContain('[other](./other.md#安装)')
  })

  it('rewriteLocalMarkdownLinks: a `.md` link after a fence is still claimed', () => {
    // The regression's user-visible half: on CRLF the destination kept its own
    // `#`, the host parser refused it, and the link rendered as inert text.
    const rewrittenLf = rewriteLocalMarkdownLinks(LF, DOC, SCOPE.cwd)
    const rewrittenCrlf = rewriteLocalMarkdownLinks(CRLF, DOC, SCOPE.cwd)
    expect(stripCr(rewrittenCrlf)).toEqual(rewrittenLf)
    // Claimed: the heading fragment is carried past the host parser as %23.
    expect(rewrittenLf).toContain('[other](./other.md%23安装)')
    expect(rewrittenCrlf).toContain('[other](./other.md%23安装)')
    // Not claimed: the link demonstrated inside the `~~~` fence is untouched
    // (the fence is masked, in both spellings), and a non-markdown local
    // destination stays inert.
    expect(rewrittenLf).toContain('[demonstration](./demonstration.md#标题)')
    expect(rewrittenCrlf).toContain('[demonstration](./demonstration.md#标题)')
  })

  it('rewriteLocalImageUrls + rewriteLocalMarkdownLinks: byte parity', () => {
    const rewrite = (text: string): string =>
      rewriteLocalMarkdownLinks(rewriteLocalImageUrls(text, SCOPE, DOC, ''), DOC, SCOPE.cwd)
    expect(stripCr(rewrite(CRLF))).toEqual(rewrite(LF))
    // The image pass ran in the CRLF spelling too (its destination became the
    // session-scoped media URL).
    expect(rewrite(CRLF)).toContain('pic.png')
    expect(rewrite(CRLF)).not.toContain('](./pic.png)')
  })

  it('splitMermaidBlocks: a CRLF mermaid fence closes instead of swallowing the file', () => {
    const lf = '# t\n\n```mermaid\ngraph TD;\n  A-->B\n```\n\nafter\n'
    expect(blocksLf(splitMermaidBlocks(lf.replace(/\n/g, '\r\n')))).toEqual(splitMermaidBlocks(lf))
    // The diagram is exactly the fence's body — not the rest of the document.
    expect(splitMermaidBlocks(lf.replace(/\n/g, '\r\n'))).toEqual([
      { kind: 'markdown', text: '# t\r\n\r' },
      { kind: 'mermaid', code: 'graph TD;\r\n  A-->B\r' },
      { kind: 'markdown', text: '\r\nafter\r\n' },
    ])
  })
})
