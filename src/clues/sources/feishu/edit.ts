/**
 * Pure Docx-XML block parsing/serialization for the docs editor (S4).
 *
 * `docs +fetch --detail full` returns one XML document whose top-level elements
 * are the Docx blocks, with `id="blk..."` on the blocks that can be targeted by
 * `docs +update --command block_replace --block-id`. This module turns that XML
 * into the editable model and turns one edited block back into the exact
 * `<tag attrs>inner</tag>` payload of `block_replace`.
 *
 * It is deliberately forgiving about what it DOES NOT understand: any container
 * or resource block (table, callout, grid, image, whiteboard, …) is classified
 * read-only and never serialized for a write. The editor cannot silently
 * rebuild it. Text blocks keep their original inline XML, so an untouched
 * `<b>`/`<a>`/`<cite>` survives a surrounding text edit verbatim.
 *
 * This is a scanner for the well-formed subset lark-cli emits, not a general
 * XML parser: it tracks quotes and nested same-name tags, skips comments/CDATA
 * and refuses clearly malformed input (returning no blocks) rather than
 * inventing a lossy structure.
 */
import type {
  FeishuDocEditBlock,
  FeishuDocReadOnlyBlock,
} from './format.ts'
import { ClueError } from '../../types.ts'

/** Tags whose whole inner XML can be replaced losslessly through block_replace. */
const EDITABLE_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'h7',
  'h8',
  'h9',
  'blockquote',
  'pre',
  'checkbox',
])

/**
 * Inline tags DocxXML permits inside an editable text block. The set follows
 * the XML skill's inline components/styles; an unknown tag is refused rather
 * than written back as markup.
 */
const INLINE_TAGS = new Set([
  'a',
  'b',
  'em',
  'i',
  'u',
  'del',
  's',
  'code',
  'span',
  'cite',
  'latex',
  'img',
  'source',
  'br',
  'time',
  'button',
])

/** Inline tags that are empty by definition (never pushed on the open stack). */
const VOID_INLINE_TAGS = new Set(['img', 'source', 'br'])

/** A parsed top-level element. */
interface ParsedElement {
  readonly tag: string
  /** Raw attribute text (without the surrounding `<tag` and `>`). */
  readonly attrs: string
  readonly inner: string
  readonly selfClosing: boolean
  /** Index just past the matching close tag. */
  readonly end: number
}

/** The parsed edit model of one document. */
export interface ParsedDocEdit {
  readonly title: string
  readonly titleBlockId?: string
  readonly titleAttrs: string
  readonly blocks: FeishuDocEditBlock[]
  readonly readOnlyBlocks: FeishuDocReadOnlyBlock[]
  /**
   * Whether every top-level element was parsed. A malformed tail leaves this
   * false; the caller must refuse the edit instead of silently dropping the
   * unparsed remainder.
   */
  readonly complete: boolean
}

/**
 * Decode the XML entities lark-cli emits in text nodes.
 *
 * Numeric references are decoded in the SAME pass as the named entities, so a
 * decoded `&` can never be re-consumed by a later `&amp;` replacement
 * (`&#38;amp;` must become `&amp;`, not `&`).
 */
export function decodeXmlEntities(text: string): string {
  return text.replace(
    /&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi,
    (match: string, hex: string | undefined, decimal: string | undefined, named: string | undefined) => {
      if (named !== undefined) {
        switch (named.toLowerCase()) {
          case 'amp': return '&'
          case 'lt': return '<'
          case 'gt': return '>'
          case 'quot': return '"'
          case 'apos': return "'"
          default: return match
        }
      }
      const code = Number.parseInt(hex ?? decimal ?? '', hex === undefined ? 10 : 16)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    },
  )
}

/** Escape text for an XML text node (never escape the tags themselves). */
export function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Text content of a fragment (tags stripped, `<br>` as a newline, entities decoded). */
function textContentOf(xml: string): string {
  return decodeXmlEntities(
    xml
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  )
}

/** Strip tags and decode entities (display-only projection of a complex block). */
export function plainTextOf(xml: string): string {
  return textContentOf(xml).trim()
}

/** Find the `>` that closes one start tag, respecting quoted attributes. */
function tagEndOf(xml: string, start: number): number {
  let quote = ''
  for (let index = start; index < xml.length; index += 1) {
    const char = xml[index]!
    if (quote !== '') {
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '>') return index
  }
  return -1
}

/** Read one start tag at `start` (which must point at `<`). */
function startTagOf(xml: string, start: number): {
  readonly tag: string
  readonly attrs: string
  readonly selfClosing: boolean
  readonly end: number
} | undefined {
  if (xml[start] !== '<') return undefined
  const end = tagEndOf(xml, start)
  if (end < 0) return undefined
  const raw = xml.slice(start + 1, end)
  const match = /^\s*([A-Za-z][A-Za-z0-9:_-]*)/.exec(raw)
  if (match === null) return undefined
  const selfClosing = /\/\s*$/.test(raw)
  const attrs = raw.slice(match[0].length, selfClosing ? raw.lastIndexOf('/') : raw.length).trim()
  return { tag: match[1]!, attrs, selfClosing, end: end + 1 }
}

/** Read one complete element (start tag + matching close tag) at `start`. */
function elementAt(xml: string, start: number): ParsedElement | undefined {
  const open = startTagOf(xml, start)
  if (open === undefined) return undefined
  if (open.selfClosing) {
    return { tag: open.tag, attrs: open.attrs, inner: '', selfClosing: true, end: open.end }
  }
  const tag = open.tag
  const lowerTag = tag.toLowerCase()
  let depth = 1
  let index = open.end
  while (index < xml.length) {
    const next = xml.indexOf('<', index)
    if (next < 0) return undefined
    if (xml.startsWith('<!--', next)) {
      const close = xml.indexOf('-->', next + 4)
      if (close < 0) return undefined
      index = close + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', next)) {
      const close = xml.indexOf(']]>', next + 9)
      if (close < 0) return undefined
      index = close + 3
      continue
    }
    if (xml.startsWith('<?', next)) {
      const close = xml.indexOf('?>', next + 2)
      if (close < 0) return undefined
      index = close + 2
      continue
    }
    if (xml.startsWith('<!', next)) {
      const close = xml.indexOf('>', next + 2)
      if (close < 0) return undefined
      index = close + 1
      continue
    }
    if (xml.startsWith('</', next)) {
      const close = tagEndOf(xml, next)
      if (close < 0) return undefined
      const closeTag = /^<\/\s*([A-Za-z][A-Za-z0-9:_-]*)/.exec(xml.slice(next, close + 1))
      if (closeTag === null) return undefined
      if (closeTag[1]!.toLowerCase() === lowerTag) depth -= 1
      if (depth === 0) {
        return {
          tag,
          attrs: open.attrs,
          inner: xml.slice(open.end, next),
          selfClosing: false,
          end: close + 1,
        }
      }
      index = close + 1
      continue
    }
    const child = startTagOf(xml, next)
    if (child === undefined) return undefined
    if (child.tag.toLowerCase() === lowerTag && !child.selfClosing) depth += 1
    index = child.end
  }
  return undefined
}

/** One parsed XML attribute and its span inside the raw attribute text. */
interface XmlAttribute {
  readonly name: string
  readonly value: string
  /** First character of the name. */
  readonly start: number
  /** Index just past the attribute value (or the name for a bare flag). */
  readonly end: number
}

/**
 * Tokenize the attributes of one start tag.
 *
 * A plain regex over the raw attribute text is NOT safe: `caption="note
 * id='blk-evil'"` contains an `id=` that belongs to the caption value, and
 * rewriting that span corrupts the caption. This scanner tracks quotes and
 * only yields real attribute tokens.
 */
function attributesOf(attrs: string): XmlAttribute[] {
  const tokens: XmlAttribute[] = []
  let index = 0
  while (index < attrs.length) {
    while (index < attrs.length && /\s/.test(attrs[index]!)) index += 1
    if (index >= attrs.length) break
    const start = index
    while (index < attrs.length && !/[\s=]/.test(attrs[index]!)) index += 1
    const name = attrs.slice(start, index)
    if (name === '') {
      index += 1
      continue
    }
    while (index < attrs.length && /\s/.test(attrs[index]!)) index += 1
    if (attrs[index] !== '=') {
      tokens.push({ name, value: '', start, end: index })
      continue
    }
    index += 1
    while (index < attrs.length && /\s/.test(attrs[index]!)) index += 1
    const quote = attrs[index]
    let value: string
    if (quote === '"' || quote === "'") {
      index += 1
      const valueStart = index
      while (index < attrs.length && attrs[index] !== quote) index += 1
      value = attrs.slice(valueStart, index)
      if (attrs[index] === quote) index += 1
    } else {
      const valueStart = index
      while (index < attrs.length && !/\s/.test(attrs[index]!)) index += 1
      value = attrs.slice(valueStart, index)
    }
    tokens.push({ name, value, start, end: index })
  }
  return tokens
}

/** One real attribute value (`id="…"` / `id='…'`), never a lookalike inside another value. */
function attributeOf(attrs: string, name: string): string | undefined {
  const token = attributesOf(attrs).find(candidate => candidate.name.toLowerCase() === name.toLowerCase())
  return token?.value
}

/** Remove only the real `id` token; quoted values keep their original spacing. */
function withoutId(attrs: string): string {
  const token = attributesOf(attrs).find(candidate => candidate.name.toLowerCase() === 'id')
  if (token === undefined) return attrs.trim()
  const before = attrs.slice(0, token.start).trimEnd()
  const after = attrs.slice(token.end).trimStart()
  return `${before}${before === '' || after === '' ? '' : ' '}${after}`.trim()
}

/** A safe http(s) origin carried by a resource block (`url` / `href` / `src`). */
function resourceUrlOf(attrs: string): string | undefined {
  for (const name of ['url', 'href', 'src']) {
    const value = attributeOf(attrs, name)
    if (value !== undefined && /^https?:\/\//i.test(value)) return value
  }
  return undefined
}

/** Direct child elements of one fragment (used for `<ul>`/`<ol>` items). */
function directChildren(xml: string): ParsedElement[] {
  const children: ParsedElement[] = []
  let index = 0
  while (index < xml.length) {
    const next = xml.indexOf('<', index)
    if (next < 0) break
    if (xml.startsWith('<!--', next)) {
      const close = xml.indexOf('-->', next + 4)
      if (close < 0) break
      index = close + 3
      continue
    }
    const element = elementAt(xml, next)
    if (element === undefined) break
    children.push(element)
    index = element.end
  }
  return children
}

/**
 * Whether a block id is a safe argv token (never a shell string).
 *
 * A leading `-` is rejected because lark-cli parses some `--block-id` values
 * as flags (`-1` means "end of document"); a real Docx block id never starts
 * with a dash.
 */
export function isSafeBlockId(id: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9:_-]{0,199}$/.test(id)
}

/**
 * The code text inside one `<pre>` block.
 *
 * Code is plain text: indentation and trailing whitespace are part of it and
 * must survive a load/save round trip, so this deliberately does NOT trim
 * (unlike the display-only {@link plainTextOf}).
 */
function codeTextOf(inner: string): string {
  const code = /<code(?:\s[^>]*)?>([\s\S]*?)<\/code>/i.exec(inner)
  return textContentOf(code === null ? inner : code[1]!)
}

/**
 * Parse one `docs +fetch --detail full` XML document into the edit model.
 * @param content - `data.document.content`.
 * @returns the parsed model; title/blocks are empty for malformed content, so
 * the caller can refuse an edit instead of writing a guessed structure.
 */
export function parseDocEditXml(content: string): ParsedDocEdit {
  const blocks: FeishuDocEditBlock[] = []
  const readOnlyBlocks: FeishuDocReadOnlyBlock[] = []
  let title = ''
  let titleBlockId: string | undefined
  let titleAttrs = ''
  let complete = true
  let order = 0
  let index = 0
  while (index < content.length) {
    const next = content.indexOf('<', index)
    if (next < 0) {
      if (content.slice(index).trim() !== '') complete = false
      break
    }
    if (content.slice(index, next).trim() !== '') complete = false
    if (content.startsWith('<!--', next)) {
      const close = content.indexOf('-->', next + 4)
      if (close < 0) {
        complete = false
        break
      }
      index = close + 3
      continue
    }
    const element = elementAt(content, next)
    if (element === undefined) {
      complete = false
      break
    }
    index = element.end
    const elementOrder = order
    order += 1
    const tag = element.tag.toLowerCase()
    const id = attributeOf(element.attrs, 'id')
    if (tag === 'title') {
      title = plainTextOf(element.inner)
      titleBlockId = id
      titleAttrs = withoutId(element.attrs)
      continue
    }
    if (tag === 'ul' || tag === 'ol') {
      // One list item is one Docx block; the group is not itself targetable.
      for (const child of directChildren(element.inner)) {
        if (child.tag.toLowerCase() !== 'li') continue
        const childId = attributeOf(child.attrs, 'id')
        const childOrder = order
        order += 1
        const block: FeishuDocEditBlock = {
          id: childId ?? '',
          tag: 'li',
          attrs: withoutId(child.attrs),
          text: child.inner,
          baseline: child.inner,
          kind: 'xml',
          order: childOrder,
        }
        if (childId === undefined || !isSafeBlockId(childId)) {
          readOnlyBlocks.push({
            tag: 'li',
            attrs: withoutId(child.attrs),
            text: plainTextOf(child.inner),
            reason: 'this list item has no block id, so it cannot be targeted safely',
            order: childOrder,
          })
        } else {
          blocks.push(block)
        }
      }
      continue
    }
    if (tag === 'pre') {
      const text = codeTextOf(element.inner)
      if (id !== undefined && isSafeBlockId(id)) {
        blocks.push({
          id,
          tag: 'pre',
          attrs: withoutId(element.attrs),
          text,
          baseline: text,
          kind: 'plain',
          order: elementOrder,
        })
      } else {
        readOnlyBlocks.push({
          tag: 'pre',
          attrs: withoutId(element.attrs),
          text,
          reason: 'this code block has no block id, so it cannot be targeted safely',
          order: elementOrder,
        })
      }
      continue
    }
    if (EDITABLE_TAGS.has(tag)) {
      if (id !== undefined && isSafeBlockId(id)) {
        blocks.push({
          id,
          tag,
          attrs: withoutId(element.attrs),
          text: element.inner,
          baseline: element.inner,
          kind: 'xml',
          order: elementOrder,
        })
      } else {
        readOnlyBlocks.push({
          tag,
          attrs: withoutId(element.attrs),
          text: plainTextOf(element.inner),
          reason: 'this text block has no block id, so it cannot be targeted safely',
          order: elementOrder,
        })
      }
      continue
    }
    const attrs = withoutId(element.attrs)
    const url = resourceUrlOf(attrs)
    readOnlyBlocks.push({
      tag,
      attrs,
      text: plainTextOf(element.inner),
      reason: `a ${tag} container stays read-only; rebuilding it is not a lossless text-block edit`,
      order: elementOrder,
      ...(url === undefined ? {} : { url }),
    })
  }
  return {
    title,
    ...(titleBlockId === undefined ? {} : { titleBlockId }),
    titleAttrs,
    blocks,
    readOnlyBlocks,
    complete,
  }
}

/** Character span of one top-level element. */
export interface TopLevelSpan {
  readonly start: number
  readonly end: number
}

/**
 * Character spans of the top-level elements of one Docx XML document.
 * Returns `undefined` when the document is not a complete sequence of
 * elements (the caller must not treat a malformed prefix as the document).
 */
export function topLevelSpans(content: string): TopLevelSpan[] | undefined {
  const spans: TopLevelSpan[] = []
  let index = 0
  while (index < content.length) {
    const next = content.indexOf('<', index)
    if (next < 0) {
      if (content.slice(index).trim() !== '') return undefined
      break
    }
    if (content.slice(index, next).trim() !== '') return undefined
    if (content.startsWith('<!--', next)) {
      const close = content.indexOf('-->', next + 4)
      if (close < 0) return undefined
      index = close + 3
      continue
    }
    const element = elementAt(content, next)
    if (element === undefined) return undefined
    spans.push({ start: next, end: element.end })
    index = element.end
  }
  return spans
}

/** Whether a tag may be serialized as an editable text block. */
export function isEditableBlockTag(tag: string): boolean {
  const lower = tag.toLowerCase()
  return lower === 'li' || EDITABLE_TAGS.has(lower)
}

/** Serialize `<tag attrs>inner</tag>` (attrs already stripped of `id`). */
function outerXml(tag: string, attrs: string, inner: string): string {
  const suffix = attrs === '' ? '' : ` ${attrs}`
  return `<${tag}${suffix}>${inner}</${tag}>`
}

/**
 * Whether every `&` in a text node starts a valid XML entity.
 *
 * The block scanner is structural and deliberately does not reject a bare
 * `&`; a document payload must not, so this is checked separately. Only the
 * five predefined XML entities and numeric character references are accepted.
 */
function hasValidEntities(text: string): boolean {
  let index = 0
  while ((index = text.indexOf('&', index)) >= 0) {
    const match = /^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/.exec(text.slice(index))
    if (match === null) return false
    index += match[0].length
  }
  return true
}

/**
 * One edited block's inline text cannot be serialized safely. The caller turns
 * this into a typed clue error BEFORE any write is issued.
 */
function invalidInlineMarkup(): ClueError {
  return new ClueError(
    'invalid-request',
    'the edited text is not well-formed Docx XML; fix the unclosed, mismatched or unsupported tags and retry',
  )
}

/** Escape raw text while keeping already-valid XML entities verbatim. */
function escapeTextPreservingEntities(text: string): string {
  let escaped = ''
  let index = 0
  while (index < text.length) {
    const character = text[index]!
    if (character === '&') {
      const match = /^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/.exec(text.slice(index))
      if (match !== null) {
        escaped += match[0]
        index += match[0].length
        continue
      }
      escaped += '&amp;'
      index += 1
      continue
    }
    if (character === '<') {
      escaped += '&lt;'
      index += 1
      continue
    }
    if (character === '>') {
      escaped += '&gt;'
      index += 1
      continue
    }
    escaped += character
    index += 1
  }
  return escaped
}

/**
 * Whether one start tag's raw attribute text is well-formed.
 *
 * Values must be quoted, must not contain `<`, and must use valid entities
 * (`href="…&…"` is invalid XML and would be sent back verbatim otherwise).
 */
function isValidInlineAttributes(attrs: string): boolean {
  let index = 0
  while (index < attrs.length) {
    while (index < attrs.length && /\s/.test(attrs[index]!)) index += 1
    if (index >= attrs.length) return true
    const nameStart = index
    while (index < attrs.length && !/[\s=]/.test(attrs[index]!)) index += 1
    const name = attrs.slice(nameStart, index)
    if (!/^[A-Za-z_:][A-Za-z0-9:._-]*$/.test(name)) return false
    while (index < attrs.length && /\s/.test(attrs[index]!)) index += 1
    if (attrs[index] !== '=') return false
    index += 1
    while (index < attrs.length && /\s/.test(attrs[index]!)) index += 1
    const quote = attrs[index]
    if (quote !== '"' && quote !== "'") return false
    index += 1
    const valueStart = index
    while (index < attrs.length && attrs[index] !== quote) {
      if (attrs[index] === '<') return false
      index += 1
    }
    if (attrs[index] !== quote) return false
    if (!hasValidEntities(attrs.slice(valueStart, index))) return false
    index += 1
  }
  return true
}

/**
 * Tokenize an edited block's inline XML: text nodes are escaped, well-formed
 * tags/attributes/entities are preserved VERBATIM.
 *
 * This is deliberately not "escape the whole fragment when it is not valid
 * XML": a user editing a paragraph may type plain text with `&`/`<` AND keep
 * an existing `<a href="…">link</a>`. Escaping everything turned the link into
 * literal text. Structural damage (an unclosed tag, `<b>x</i>`, an unsupported
 * block tag) is refused instead of being guessed at.
 *
 * A `<` that cannot start a tag (e.g. `a < b`) is text and is escaped.
 */
function tokenizeInlineXml(text: string): string {
  if (text.includes('\u0000')) throw invalidInlineMarkup()
  let xml = ''
  const open: string[] = []
  let index = 0
  while (index < text.length) {
    const next = text.indexOf('<', index)
    if (next < 0) {
      xml += escapeTextPreservingEntities(text.slice(index))
      break
    }
    xml += escapeTextPreservingEntities(text.slice(index, next))
    const following = text[next + 1]
    if (following === undefined || !/[A-Za-z/!?]/.test(following)) {
      // `a < b`, a trailing `<`, `1 < 2`: plain text, not a tag opener.
      xml += '&lt;'
      index = next + 1
      continue
    }
    if (text.startsWith('<!--', next)) {
      const close = text.indexOf('-->', next + 4)
      if (close < 0) throw invalidInlineMarkup()
      xml += text.slice(next, close + 3)
      index = close + 3
      continue
    }
    if (text.startsWith('</', next)) {
      const close = text.indexOf('>', next + 2)
      if (close < 0) throw invalidInlineMarkup()
      const name = text.slice(next + 2, close).trim().toLowerCase()
      if (!INLINE_TAGS.has(name) || VOID_INLINE_TAGS.has(name)) throw invalidInlineMarkup()
      if (open.pop() !== name) throw invalidInlineMarkup()
      xml += text.slice(next, close + 1)
      index = close + 1
      continue
    }
    if (text.startsWith('<!', next) || text.startsWith('<?', next)) {
      // DOCTYPE / processing instruction / CDATA are not inline content.
      throw invalidInlineMarkup()
    }
    const end = tagEndOf(text, next)
    if (end < 0) throw invalidInlineMarkup()
    const raw = text.slice(next + 1, end)
    const nameMatch = /^([A-Za-z][A-Za-z0-9:_-]*)/.exec(raw)
    if (nameMatch === null) throw invalidInlineMarkup()
    const name = nameMatch[1]!.toLowerCase()
    if (!INLINE_TAGS.has(name)) throw invalidInlineMarkup()
    const selfClosing = /\/\s*$/.test(raw)
    const attrs = raw.slice(nameMatch[0].length, selfClosing ? raw.lastIndexOf('/') : raw.length)
    if (!isValidInlineAttributes(attrs)) throw invalidInlineMarkup()
    if (!selfClosing && !VOID_INLINE_TAGS.has(name)) open.push(name)
    xml += text.slice(next, end + 1)
    index = end + 1
  }
  if (open.length > 0) throw invalidInlineMarkup()
  return xml
}

/**
 * Whether one block's inner text is structurally well-formed inline XML.
 *
 * Text nodes may contain raw `&`/`<` (they are escaped by
 * {@link normalizeDocBlockInner}); the check is about TAGS: every opened inline
 * tag must close with the same name. It therefore rejects `<b>unclosed` and
 * `<b>x</i>` instead of matching only the block's own outer tag.
 */
export function isWellFormedXmlFragment(text: string): boolean {
  try {
    tokenizeInlineXml(text)
    return true
  } catch {
    return false
  }
}

/**
 * The safe inner XML of one edited block.
 *
 * `plain` blocks (title/code) are always escaped. XML blocks keep their
 * well-formed inline tags/attributes/entities and escape only text nodes. A
 * structurally invalid fragment throws `invalid-request`; the caller refuses
 * the save before issuing any write.
 */
export function normalizeDocBlockInner(block: FeishuDocEditBlock, text: string): string {
  if (block.kind === 'plain') return escapeXmlText(text)
  return tokenizeInlineXml(text)
}

/**
 * Serialize one edited block to the `block_replace --content` payload.
 *
 * A list item is serialized as a bare `<li>` because `block_replace` targets
 * ONE existing block (the list group is not targetable). The XML skill's
 * "new list items must be wrapped in `<ul>/<ol>`" rule applies to insertion,
 * which this source never performs.
 */
export function buildDocBlockXml(block: FeishuDocEditBlock, text: string): string {
  if (block.tag === 'pre') {
    return outerXml('pre', block.attrs, `<code>${escapeXmlText(text)}</code>`)
  }
  return outerXml(block.tag, block.attrs, normalizeDocBlockInner(block, text))
}

/** Serialize the edited document title. */
export function buildDocTitleXml(titleAttrs: string, title: string): string {
  return outerXml('title', titleAttrs, escapeXmlText(title))
}
