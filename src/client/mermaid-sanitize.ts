/**
 * SVG sanitization for mermaid-rendered diagrams (markdown preview). The
 * diagrams come from untrusted markdown sources, so the emitted SVG is
 * re-sanitized before it reaches dangerouslySetInnerHTML — defense in depth
 * on top of mermaid's own `securityLevel: 'strict'` (labels escaped, click
 * directives inert) and `htmlLabels: false` (labels as real SVG <text>).
 *
 * What is stripped, and why:
 * - `foreignObject`: the only channel that can carry raw HTML inside an
 *   SVG document — with it gone, a hostile label cannot smuggle an
 *   <img onerror> / <iframe> through the XML parse (any non-SVG element
 *   outside foreignObject makes the XML parse fail and the whole diagram
 *   is rejected).
 * - `script` and foreign HTML elements (`img`/`iframe`/`object`/`embed`/
 *   `video`/`audio`/`input`/`button`/`form`/`link`/`meta`/`base`): belt and
 *   braces — real browsers reject these outside foreignObject at XML parse
 *   time (→ '') while lenient parsers keep them, so they are stripped
 *   explicitly instead of relying on the parser alone.
 * - `@*` / `on*` attributes: event-handler channels (Vue-style directives
 *   and native listeners).
 * - ALL `href` / `xlink:href` attributes: the diagrams are static (no
 *   bindFunctions, no click navigation), so links carry no value — and an
 *   attacker-controlled URL (even an http(s) one) could otherwise navigate
 *   the whole GUI away from the sidebar. Removing every href keeps the
 *   surface deterministic.
 *
 * Parsing happens with `image/svg+xml`, so a malformed SVG fails the XML
 * parse and the function returns '' (the caller surfaces the error
 * fallback) instead of ever passing the raw string through; only a document
 * whose root is an `<svg>` element is accepted.
 */
const STRIP_ELEMENTS = [
  'foreignObject',
  'script',
  'img',
  'iframe',
  'object',
  'embed',
  'video',
  'audio',
  'input',
  'button',
  'form',
  'link',
  'meta',
  'base',
]

/** A parse failure keeps nothing of the input: the caller shows the error. */
export function sanitizeSvg(svg: string): string {
  if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') return ''
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  } catch {
    return ''
  }
  if (doc.querySelector('parsererror') !== null) return ''
  if (doc.documentElement === null || doc.documentElement.localName !== 'svg') return ''
  doc.querySelectorAll(STRIP_ELEMENTS.join(',')).forEach((node) => { node.remove() })
  doc.querySelectorAll('*').forEach((node) => {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name
      if (name.startsWith('@') || name.startsWith('on')) {
        node.removeAttribute(name)
        continue
      }
      if (name === 'href' || name === 'xlink:href') {
        node.removeAttribute(name)
      }
    }
  })
  return new XMLSerializer().serializeToString(doc.documentElement)
}
