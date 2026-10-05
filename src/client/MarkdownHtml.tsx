/**
 * The markdown preview's raw-HTML renderer. `markdown-html.ts` lifts HTML
 * runs out of the markdown stream; this module renders them as sanitized DOM
 * alongside the markdown runs (which keep flowing through the shared
 * `MarkdownText`), nests markdown into unclosed block elements the way
 * GitHub's linear HTML output does (`<details>` … fence … `</details>`), and
 * runs an inline pass that turns literal tag text inside rendered markdown
 * (table cells with `<br/>`, `<sub>`, `<img>`) back into elements.
 *
 * Security posture: every HTML string (block leaves, inline text, wrapper
 * open-tag attributes) goes through DOMPurify with an explicit denylist on
 * top of its defaults (no script/style/iframe/forms), anchors are forced to
 * open in a new tab with noopener, and local media goes through the
 * session-scoped `/sidebar/file` media route — markdown-syntax image
 * destinations are rewritten via `markdown-images.ts` and `src` attributes
 * through `resolveLocalMediaDest` (the same trust fence).
 */
import { useLayoutEffect, useMemo, useRef } from 'react'
import { createElement, type ReactNode } from 'react'
import DOMPurify from 'dompurify'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { markdownTextProps, type MarkdownCopyLabels } from './markdown-labels.tsx'
import { resolveLocalMediaDest, rewriteLocalImageUrls } from './markdown-images.ts'
import {
  analyzeHtmlSegment,
  type AnalyzedMarkdownHtml,
} from './markdown-html.ts'
import { splitMermaidBlocks } from './mermaid-blocks.ts'
import type { SessionScope } from './api.ts'
import css from './sidebar.module.css'

/** The chunk-resident markdown renderer (mermaid lazy chunk), shared with the
 *  legacy no-HTML preview path in TextEditor. Defined in mermaid-lazy.tsx (a
 *  light module) so core-bundle consumers can import the stub without
 *  dragging DOMPurify along. */
export { LazyMermaidMarkdown } from './mermaid-lazy.tsx'
import { LazyMermaidMarkdown } from './mermaid-lazy.tsx'

/** Everything the sanitizers need to resolve local media + scope the route. */
export interface MarkdownHtmlMedia {
  scope: SessionScope
  path: string
  origin: string
}

/** Tag-like text in a rendered text node — the inline pass gate. */
const TAGLIKE_TEXT_RE = /<\/?[a-zA-Z][a-zA-Z0-9-]*[\s/>]/

/**
 * A text node that is nothing but one close tag (`</a>`) at its edges. The host
 * renderer emits one text node per raw-HTML token, so an author's
 * `<a id="x"></a>` arrives as two sibling nodes: the open tag (which this pass
 * swaps for a sanitized element) and this stray close tag. DOMPurify drops a
 * lone close tag, so it can never be swapped — and unlike prose it carries no
 * text a reader should see, so the pass deletes it instead of printing it.
 */
const ORPHAN_CLOSE_TAG_RE = /^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>$/

/** Explicit denylist on top of DOMPurify's defaults: no active content, no
 *  form chrome, no document-level elements inside a preview. */
const PURIFY_FORBID_TAGS = [
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button',
  'select', 'textarea', 'meta', 'link', 'base', 'frame', 'frameset', 'applet',
]
const PURIFY_FORBID_ATTR = ['srcdoc', 'formaction']

/**
 * Post-sanitize hardening on a detached element tree: anchors open in a new
 * tab (never navigate the GUI), and local media sources go through the media
 * route so they render instead of being dropped by protocol allowlists.
 */
function postProcessSanitized(root: Element, media: MarkdownHtmlMedia): void {
  for (const anchor of root.querySelectorAll('a[href]')) {
    anchor.setAttribute('target', '_blank')
    anchor.setAttribute('rel', 'noopener noreferrer')
  }
  for (const element of root.querySelectorAll('img, video, audio, source')) {
    const src = element.getAttribute('src')
    if (src === null) continue
    element.setAttribute('src', resolveLocalMediaDest(src, media.scope, media.path, media.origin))
  }
}

/** Sanitize one balanced HTML span into markup for dangerouslySetInnerHTML. */
function sanitizeHtmlBlock(source: string, media: MarkdownHtmlMedia): string {
  const holder = document.createElement('div')
  holder.innerHTML = DOMPurify.sanitize(source, {
    FORBID_TAGS: PURIFY_FORBID_TAGS,
    FORBID_ATTR: PURIFY_FORBID_ATTR,
  })
  postProcessSanitized(holder, media)
  return holder.innerHTML
}

/**
 * Sanitize literal tag text from a rendered markdown text node. Returns null
 * when nothing real survived (pure prose like `a < b` — the DOMPurify output
 * has no element children), so the caller leaves the text node untouched.
 * A node that is nothing but a close tag never reaches here — the caller drops
 * it (see {@link ORPHAN_CLOSE_TAG_RE}).
 */
function sanitizeInlineHtml(text: string, media: MarkdownHtmlMedia): string | null {
  const holder = document.createElement('span')
  holder.innerHTML = DOMPurify.sanitize(text, {
    FORBID_TAGS: PURIFY_FORBID_TAGS,
    FORBID_ATTR: PURIFY_FORBID_ATTR,
  })
  if (holder.firstElementChild === null) return null
  postProcessSanitized(holder, media)
  return holder.innerHTML
}

/**
 * React props for a sanitized element: `class`/`for` map to their React names,
 * `style` is dropped (React needs an object; wrappers with inline styles are
 * vanishingly rare and not worth a CSS parser), and event handlers / invalid
 * attribute names never survive DOMPurify's defaults but are filtered anyway.
 */
function propsFromElement(element: Element): Record<string, string> {
  const props: Record<string, string> = {}
  for (const attr of element.attributes) {
    if (/^on/i.test(attr.name) || !/^[a-zA-Z][a-zA-Z0-9:._-]*$/.test(attr.name)) continue
    if (attr.name === 'style') continue
    props[attr.name === 'class' ? 'className' : attr.name === 'for' ? 'htmlFor' : attr.name] = attr.value
  }
  return props
}

/**
 * Sanitize a wrapper open tag (`<details open>`) into React props. Returns
 * null when DOMPurify dropped the whole tag (denied element) — the renderer
 * then treats the wrapper as transparent.
 */
function sanitizeTagProps(tag: string, attrs: string): Record<string, string> | null {
  const probe = DOMPurify.sanitize(`<${tag}${attrs}></${tag}>`, {
    FORBID_TAGS: PURIFY_FORBID_TAGS,
    FORBID_ATTR: PURIFY_FORBID_ATTR,
  })
  const holder = document.createElement('div')
  holder.innerHTML = probe
  const element = holder.firstElementChild
  if (element === null || element.tagName.toLowerCase() !== tag) return null
  return propsFromElement(element)
}

/**
 * Split a sanitized HTML leaf whose first element is a `<summary>` into that
 * summary's props/inner markup plus the remainder. HTML's content model makes
 * the summary a disclosure widget **only** as a direct child of `<details>`,
 * but every balanced leaf renders inside a block wrapper — so a README's
 * `<details>` + `<summary>` would otherwise show the browser's own default
 * label ("Details") and demote the authored text to body content. Returns
 * null when the leaf's first element is anything else (or non-whitespace text
 * precedes it), leaving the plain leaf path untouched. Media and anchors
 * inside the hoisted summary go through the same hardening as any leaf.
 */
function splitLeadingSummary(
  html: string,
  media: MarkdownHtmlMedia,
): { props: Record<string, string>; inner: string; rest: string } | null {
  const holder = document.createElement('div')
  holder.innerHTML = html
  const first = holder.firstElementChild
  if (first === null || first.tagName.toLowerCase() !== 'summary') return null
  for (const node of holder.childNodes) {
    if (node === first) break
    if ((node.textContent ?? '').trim() !== '') return null
  }
  postProcessSanitized(first, media)
  const props = propsFromElement(first)
  const inner = first.innerHTML
  first.remove()
  return { props, inner, rest: holder.innerHTML }
}

/**
 * The inline pass: walk the rendered markdown's text nodes and swap any that
 * contain tag-like text for a sanitized `<span data-html-inline>`. Rendered
 * code (inline `code`, `pre`, the host `.md-code-block`, mermaid mounts, and
 * spans this pass already produced) is skipped. The same commit-then-operate
 * pattern the mermaid swap uses: React keeps owning the host tree, only leaf
 * text nodes are replaced, and a text change re-renders the subtree fresh.
 */
function runInlineHtmlPass(container: HTMLElement, media: MarkdownHtmlMedia): void {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = (node as Text).parentElement
      if (parent === null) return NodeFilter.FILTER_REJECT
      if (parent.closest('code, pre, .md-code-block, [data-mermaid-processed], [data-html-inline]')) {
        return NodeFilter.FILTER_REJECT
      }
      return TAGLIKE_TEXT_RE.test((node as Text).data)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT
    },
  })
  const targets: Text[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) targets.push(node as Text)
  for (const node of targets) {
    // A lone close tag is not prose and cannot be sanitized into an element:
    // drop it so `</a>` never renders as text (the matching open tag already
    // became its element, so anchors keep their id and stay invisible).
    if (ORPHAN_CLOSE_TAG_RE.test(node.data.trim())) {
      node.remove()
      continue
    }
    const html = sanitizeInlineHtml(node.data, media)
    if (html === null) continue
    const span = document.createElement('span')
    span.setAttribute('data-html-inline', '')
    span.innerHTML = html
    node.replaceWith(span)
  }
}

interface MarkdownSegmentProps {
  text: string
  hasMermaid: boolean
  media: MarkdownHtmlMedia
  codeLabels: MarkdownCopyLabels
}

/**
 * One markdown run of a split document: the shared MarkdownText pass (or the
 * mermaid chunk renderer when the run contains a mermaid fence), plus the
 * inline HTML pass. The pass runs after every text change and is re-armed by
 * a MutationObserver so it also catches content that appears late (the lazy
 * mermaid chunk mounting, shiki highlighting settling) — it is idempotent and
 * skips its own output, so mutation feedback settles after one extra pass.
 */
function MarkdownSegment({ text, hasMermaid, media, codeLabels }: MarkdownSegmentProps): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const container = containerRef.current
    if (container === null) return
    runInlineHtmlPass(container, media)
    let scheduled = false
    const observer = new MutationObserver(() => {
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        runInlineHtmlPass(container, media)
      })
    })
    observer.observe(container, { childList: true, subtree: true })
    return () => { observer.disconnect() }
  }, [text, media])
  return (
    <div ref={containerRef}>
      {hasMermaid
        ? <LazyMermaidMarkdown text={text} codeLabels={codeLabels} />
        : <MarkdownText {...markdownTextProps(text, codeLabels)} />}
    </div>
  )
}

/** A sanitized, balanced HTML span rendered as its own block. */
function HtmlLeaf({ html }: { html: string }): ReactNode {
  return (
    <div className={css.editorHtmlBlock} data-dsh-html-segment dangerouslySetInnerHTML={{ __html: html }} />
  )
}

/** One fully-prepared HTML run: sanitized leaves + wrapper opens/closes. */
type PreparedHtmlPart =
  | { kind: 'html'; html: string }
  | { kind: 'open'; tag: string; props: Record<string, string> | null }
  | { kind: 'close' }
  /** A `<summary>` hoisted out of a leaf so it can be a `<details>` direct child. */
  | { kind: 'summary'; props: Record<string, string>; inner: string }

type PreparedSegment =
  | { kind: 'markdown'; text: string; hasMermaid: boolean }
  | { kind: 'html'; parts: PreparedHtmlPart[] }

interface MarkdownDocumentProps {
  info: AnalyzedMarkdownHtml
  media: MarkdownHtmlMedia
  codeLabels: MarkdownCopyLabels
}

/**
 * The split-document renderer: markdown runs render through MarkdownSegment,
 * HTML runs render as sanitized leaves, and unclosed block elements lower the
 * following runs into themselves until their close part pops the frame (the
 * renderer's frame stack persists across segments). Stray closes at the top
 * level render nothing (the sanitizer/parser would drop them anyway), and
 * frames still open at the end of the document are closed like a browser
 * parser would. Sanitization runs once per prepared change, in a memo.
 */
export function MarkdownDocument({ info, media, codeLabels }: MarkdownDocumentProps): ReactNode {
  const prepared = useMemo<PreparedSegment[]>(() => info.segments.map((segment): PreparedSegment => {
    if (segment.kind === 'markdown') {
      const defs = info.referenceDefinitions
      const raw = defs === '' ? segment.text : `${segment.text}\n\n${defs}`
      // MarkdownText drops non-http(s) image destinations (chat-security
      // stance), so rewrite local ones into /sidebar/file media URLs first —
      // the same trust fence the sanitized HTML leaves below go through.
      // Idempotent: already-absolute media URLs pass through untouched.
      const text = rewriteLocalImageUrls(raw, media.scope, media.path, media.origin)
      return {
        kind: 'markdown',
        text,
        hasMermaid: splitMermaidBlocks(text).some((block) => block.kind === 'mermaid'),
      }
    }
    const parts: PreparedHtmlPart[] = []
    /** Tag of the wrapper the previous part opened — the only place a
     *  following leaf can hoist a `<summary>` out of its block wrapper. */
    let openTag: string | null = null
    for (const part of analyzeHtmlSegment(segment.text).parts) {
      if (part.kind === 'html') {
        const html = sanitizeHtmlBlock(part.html, media)
        const summary = openTag === 'details' ? splitLeadingSummary(html, media) : null
        if (summary === null) {
          parts.push({ kind: 'html', html })
        } else {
          parts.push({ kind: 'summary', props: summary.props, inner: summary.inner })
          // Anything after the summary keeps the plain block-leaf treatment.
          if (summary.rest.trim() !== '') parts.push({ kind: 'html', html: summary.rest })
        }
        openTag = null
        continue
      }
      if (part.kind === 'open') {
        const props = sanitizeTagProps(part.tag, part.attrs)
        parts.push({ kind: 'open', tag: part.tag, props })
        // A denied wrapper renders transparent, so its children have no element
        // to be a direct child of — never hoist a summary into that case.
        openTag = props === null ? null : part.tag
        continue
      }
      parts.push({ kind: 'close' })
      openTag = null
    }
    return { kind: 'html', parts }
  // `media` is a memoized object in the host (TextEditor); identity tracks
  // scope/path/origin changes so sanitization re-runs exactly when needed.
  }), [info, media])

  const nodes: ReactNode[] = []
  const frames: { tag: string; props: Record<string, string> | null; children: ReactNode[] }[] = []
  const emit = (node: ReactNode): void => {
    const frame = frames[frames.length - 1]
    if (frame !== undefined) frame.children.push(node)
    else nodes.push(node)
  }
  let key = 0
  for (const segment of prepared) {
    if (segment.kind === 'markdown') {
      emit(<MarkdownSegment key={`md-${key += 1}`} text={segment.text} hasMermaid={segment.hasMermaid} media={media} codeLabels={codeLabels} />)
      continue
    }
    for (const part of segment.parts) {
      if (part.kind === 'html') {
        if (part.html.trim() === '') continue
        emit(<HtmlLeaf key={`html-${key += 1}`} html={part.html} />)
      } else if (part.kind === 'summary') {
        // Emitted as a real element (not a block leaf) so it stays a direct
        // child of the enclosing <details> — the content-model requirement for
        // it to act as the disclosure widget, with the authored label.
        emit(createElement('summary', { ...part.props, key: `summary-${key += 1}`, dangerouslySetInnerHTML: { __html: part.inner } }))
      } else if (part.kind === 'open') {
        frames.push({ tag: part.tag, props: part.props, children: [] })
      } else {
        const frame = frames.pop()
        if (frame === undefined) continue
        if (frame.props === null) {
          for (const child of frame.children) emit(child)
        } else {
          emit(createElement(frame.tag, { ...frame.props, key: `wrap-${key += 1}` }, ...frame.children))
        }
      }
    }
  }
  while (frames.length > 0) {
    const frame = frames.pop()!
    if (frame.props === null) {
      for (const child of frame.children) emit(child)
    } else {
      emit(createElement(frame.tag, { ...frame.props, key: `wrap-${key += 1}` }, ...frame.children))
    }
  }
  return <>{nodes}</>
}
