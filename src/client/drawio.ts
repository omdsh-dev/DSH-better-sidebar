/**
 * draw.io document decoding. A `.drawio` file stores either the plain
 * `<mxGraphModel>` XML, or the same XML percent-escaped, raw-DEFLATE
 * compressed and base64 encoded inside an `<mxfile><diagram>` body. The
 * preview only needs the model for the first page; both save forms are
 * normalized here so the renderer never sees a container it cannot parse.
 */
import { Inflate, strFromU8 } from 'fflate/browser'

/** The bytes are not a recognizable draw.io document. */
export class DrawioParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DrawioParseError'
  }
}

/** Base64 alphabet plus optional padding; XML and whitespace cannot match. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u

/**
 * Largest base64 body this decoder accepts, in characters.
 *
 * The host hands a viewer the file's text (up to 5 MiB); a draw.io body is
 * attacker-controlled input, so the decoder refuses anything past this size
 * instead of spending the browser's memory on it.
 */
const MAX_BODY_CHARS = 4_000_000

/**
 * Largest decompressed body this decoder produces, in bytes.
 *
 * DEFLATE reaches roughly 1000:1 on repetitive input, so a small file can ask
 * for gigabytes; the stream is aborted as soon as the running total crosses
 * this bound.
 */
const MAX_INFLATED_BYTES = 16 * 1024 * 1024

/**
 * Inflate a raw-DEFLATE body with a hard output bound.
 * @param bytes - the compressed input.
 * @returns the decompressed bytes.
 * @throws {DrawioParseError} when the stream is invalid or grows past the bound.
 */
function inflateBounded(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = []
  let total = 0
  const stream = new Inflate((chunk) => {
    total += chunk.length
    if (total > MAX_INFLATED_BYTES) {
      throw new DrawioParseError('drawio: diagram body decompresses past the size limit')
    }
    chunks.push(chunk)
  })
  stream.push(bytes, true)
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

/** Strip the whitespace draw.io may wrap a base64 body in. */
function compact(text: string): string {
  return text.replace(/\s+/gu, '')
}

/**
 * Inflate draw.io's saved diagram body: base64(raw-deflate(percent-escaped
 * XML)). A body that is already XML is returned unchanged.
 * @param payload - the `<diagram>` text content.
 * @returns the diagram's `<mxGraphModel>` XML.
 * @throws {DrawioParseError} when the body is not valid base64/DEFLATE.
 */
export function inflateDrawioBody(payload: string): string {
  const body = compact(payload)
  if (body === '') throw new DrawioParseError('drawio: diagram body is empty')
  if (body.startsWith('<')) return body
  if (!BASE64.test(body)) throw new DrawioParseError('drawio: diagram body is not base64')
  if (body.length > MAX_BODY_CHARS) {
    throw new DrawioParseError('drawio: diagram body is larger than the preview limit')
  }
  let inflated: string
  try {
    const bytes = Uint8Array.from(atob(body), character => character.charCodeAt(0))
    inflated = strFromU8(inflateBounded(bytes), true)
  } catch (error) {
    if (error instanceof DrawioParseError) throw error
    throw new DrawioParseError('drawio: compressed body is not a valid DEFLATE stream')
  }
  try {
    return decodeURIComponent(inflated)
  } catch {
    return inflated
  }
}

/** Parse one XML document and reject the browser parser's error node. */
function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'text/xml')
  if (doc.documentElement.tagName === 'parsererror') {
    throw new DrawioParseError('drawio: XML is malformed')
  }
  return doc
}

/** Serialize a nested `<mxGraphModel>` child without its outer `<mxfile>`. */
function graphModelOf(diagram: Element): string {
  const model = diagram.querySelector('mxGraphModel')
  if (model !== null) return new XMLSerializer().serializeToString(model)
  const body = diagram.textContent?.trim() ?? ''
  if (body === '') throw new DrawioParseError('drawio: page has no content')
  return inflateDrawioBody(body)
}

/**
 * Normalize a `.drawio` file to the `<mxGraphModel>` XML maxGraph consumes.
 *
 * The first page is used when the file contains an `<mxfile>` wrapper. A
 * malformed file throws {@link DrawioParseError}; callers render that as a
 * viewer error instead of unmounting the sidebar.
 * @param content - complete file text, either raw or compressed.
 * @returns mxGraph XML for the first page.
 * @throws {DrawioParseError} when no diagram can be recovered.
 */
export function decodeDrawio(content: string): string {
  const text = content.replace(/^\uFEFF/u, '').trim()
  if (text === '') throw new DrawioParseError('drawio: file is empty')

  if (text.startsWith('<')) {
    const doc = parseXml(text)
    if (doc.documentElement.tagName === 'mxGraphModel') return text
    if (doc.documentElement.tagName === 'mxfile') {
      const diagram = doc.documentElement.querySelector('diagram')
      if (diagram === null) throw new DrawioParseError('drawio: file has no diagram')
      return graphModelOf(diagram)
    }
    throw new DrawioParseError('drawio: no mxGraphModel element found')
  }

  const decoded = inflateDrawioBody(text)
  if (!decoded.trimStart().startsWith('<')) {
    throw new DrawioParseError('drawio: compressed body did not contain XML')
  }
  return decoded
}
