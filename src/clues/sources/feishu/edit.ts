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
}

/** Decode the XML entities lark-cli emits in text nodes. */
export function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    })
    .replace(/&#(\d+);/g, (_match, dec: string) => {
      const code = Number.parseInt(dec, 10)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Escape text for an XML text node (never escape the tags themselves). */
export function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Strip tags and decode entities (display-only projection of a complex block). */
export function plainTextOf(xml: string): string {
  return decodeXmlEntities(
    xml
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  ).trim()
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

/** One attribute value (`id="…"` / `id='…'`). */
function attributeOf(attrs: string, name: string): string | undefined {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i')
  const match = pattern.exec(attrs)
  if (match === null) return undefined
  return match[1] ?? match[2]
}

/** Remove the `id` attribute from the serialized outer tag. */
function withoutId(attrs: string): string {
  return attrs
    .replace(/(^|\s)id\s*=\s*(?:"[^"]*"|'[^']*')/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
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

/** Whether a block id is a safe argv token (never a shell string). */
export function isSafeBlockId(id: string): boolean {
  return /^[A-Za-z0-9:_-]{1,200}$/.test(id)
}

/** The code text inside one `<pre>` block. */
function codeTextOf(inner: string): string {
  const code = /<code(?:\s[^>]*)?>([\s\S]*?)<\/code>/i.exec(inner)
  return plainTextOf(code === null ? inner : code[1]!)
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
  let index = 0
  while (index < content.length) {
    const next = content.indexOf('<', index)
    if (next < 0) break
    if (content.startsWith('<!--', next)) {
      const close = content.indexOf('-->', next + 4)
      if (close < 0) break
      index = close + 3
      continue
    }
    const element = elementAt(content, next)
    if (element === undefined) break
    index = element.end
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
        const block: FeishuDocEditBlock = {
          id: childId ?? '',
          tag: 'li',
          attrs: withoutId(child.attrs),
          text: child.inner,
          baseline: child.inner,
          kind: 'xml',
        }
        if (childId === undefined || !isSafeBlockId(childId)) {
          readOnlyBlocks.push({
            tag: 'li',
            text: plainTextOf(child.inner),
            reason: 'this list item has no block id, so it cannot be targeted safely',
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
        })
      } else {
        readOnlyBlocks.push({
          tag: 'pre',
          text,
          reason: 'this code block has no block id, so it cannot be targeted safely',
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
        })
      } else {
        readOnlyBlocks.push({
          tag,
          text: plainTextOf(element.inner),
          reason: 'this text block has no block id, so it cannot be targeted safely',
        })
      }
      continue
    }
    readOnlyBlocks.push({
      tag,
      text: plainTextOf(element.inner),
      reason: `a ${tag} container stays read-only; rebuilding it is not a lossless text-block edit`,
    })
  }
  return {
    title,
    ...(titleBlockId === undefined ? {} : { titleBlockId }),
    titleAttrs,
    blocks,
    readOnlyBlocks,
  }
}

/** Serialize `<tag attrs>inner</tag>` (attrs already stripped of `id`). */
function outerXml(tag: string, attrs: string, inner: string): string {
  const suffix = attrs === '' ? '' : ` ${attrs}`
  return `<${tag}${suffix}>${inner}</${tag}>`
}

/** Serialize one edited block to the `block_replace --content` payload. */
export function buildDocBlockXml(block: FeishuDocEditBlock, text: string): string {
  if (block.tag === 'pre') {
    return outerXml('pre', block.attrs, `<code>${escapeXmlText(text)}</code>`)
  }
  const inner = block.kind === 'plain' ? escapeXmlText(text) : text
  return outerXml(block.tag, block.attrs, inner)
}

/** Serialize the edited document title. */
export function buildDocTitleXml(titleAttrs: string, title: string): string {
  return outerXml('title', titleAttrs, escapeXmlText(title))
}
