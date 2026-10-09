/**
 * Text encoding detection/round-trip helpers for the host filesystem API.
 *
 * The editor transports JavaScript strings, but Windows script/config files
 * are still commonly stored as the active ANSI code page (CP936/GBK) or
 * UTF-16. Detect before decoding and re-detect the on-disk file before save
 * so editing never silently converts an existing file to UTF-8.
 */
import { open } from 'node:fs/promises'

export type TextEncoding =
  | 'utf8'
  | 'utf8-bom'
  | 'utf16le'
  | 'utf16le-bom'
  | 'utf16be'
  | 'utf16be-bom'
  | 'utf32le-bom'
  | 'utf32be-bom'
  | 'gbk'
  | 'gb18030'

export interface DecodedText {
  content: string
  encoding: TextEncoding
}

/**
 * Line-ending style a save must round-trip. Only CRLF is recognized: a lone
 * `\r` (classic Mac) is neither counted by {@link detectEol} nor rewritten by
 * {@link restoreEol}, which mirrors the host filesystem backend
 * (`@deepseek-ai/dsh-fs-local`). Its `edit` tool is the reference behaviour
 * here — it restores the style detected at read time instead of normalizing the
 * file, so a model edit does not rewrite every line. The host's `write` tool
 * does NOT do this (it writes the model's LF text verbatim), which is why the
 * editor's own save has to carry the guarantee itself.
 */
export type TextEol = 'lf' | 'crlf'

/** The on-disk format of a file: how its bytes are encoded and how its lines
 *  end. Both are re-detected from disk before every save. */
export interface FileFormat {
  encoding: TextEncoding
  eol: TextEol
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const UTF16LE_BOM = Buffer.from([0xff, 0xfe])
const UTF16BE_BOM = Buffer.from([0xfe, 0xff])
const UTF32LE_BOM = Buffer.from([0xff, 0xfe, 0x00, 0x00])
const UTF32BE_BOM = Buffer.from([0x00, 0x00, 0xfe, 0xff])
const ENCODING_SNIFF_LIMIT = 64 * 1024

/** Sample the line-ending vote reads (characters, not bytes). Same window as
 *  the host backend's `detectLineEndings`, so the plugin and the host reach the
 *  same verdict about the same file. */
const EOL_SNIFF_LIMIT = 4096

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })
const GBK_DECODER = new TextDecoder('gbk', { fatal: true })
const GB18030_DECODER = new TextDecoder('gb18030', { fatal: true })
const GB18030_LOOSE_DECODER = new TextDecoder('gb18030')
const GB18030_POINTERS = 126 * 10 * 126 * 10

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) return false
  }
  return true
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  const length = bytes.length - (bytes.length % 2)
  const body = Buffer.from(bytes.subarray(0, length))
  if (!littleEndian) body.swap16()
  return body.toString('utf16le')
}

function encodeUtf16(text: string, littleEndian: boolean): Buffer {
  const body = Buffer.from(text, 'utf16le')
  if (!littleEndian) body.swap16()
  return body
}

function decodeUtf32(bytes: Buffer, littleEndian: boolean): string {
  const length = bytes.length - (bytes.length % 4)
  let content = ''
  for (let offset = 0; offset < length; offset += 4) {
    const codePoint = littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset)
    content += codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? String.fromCodePoint(codePoint)
      : '\ufffd'
  }
  return content
}

function encodeUtf32(text: string, littleEndian: boolean): Buffer {
  const codePoints = [...text].map(char => char.codePointAt(0) ?? 0xfffd)
  const body = Buffer.allocUnsafe(codePoints.length * 4)
  codePoints.forEach((codePoint, index) => {
    if (littleEndian) body.writeUInt32LE(codePoint, index * 4)
    else body.writeUInt32BE(codePoint, index * 4)
  })
  return body
}

/**
 * Whether one UTF-16 code unit is plausible as TEXT: tab / LF / CR, printable
 * ASCII, or anything from U+00A0 up (letters, CJK, full-width punctuation)
 * outside the surrogate range and the U+FFFE/FFFF tail. C0 controls other than
 * whitespace, DEL and the whole C1 block never appear in text, while a 16-bit
 * number stream spends a large share of its units exactly there.
 */
function isUtf16TextUnit(unit: number): boolean {
  if (unit === 0x09 || unit === 0x0a || unit === 0x0d) return true
  if (unit >= 0x20 && unit <= 0x7e) return true
  if (unit >= 0xa0 && unit <= 0xd7ff) return true
  return unit >= 0xe000 && unit <= 0xfffd
}

/**
 * Whether the lane sample reads as text in the given byte order: at least 90%
 * of its code units must be text units ({@link isUtf16TextUnit}). A low
 * amplitude 16-bit table sits far below that, real script/config text at or
 * near 100%.
 * @param bytes - the buffer (only the lane sample is read).
 * @param pairs - how many code units to judge (the caller's lane window).
 * @param littleEndian - the byte order of the candidate lane.
 */
function looksLikeUtf16Text(bytes: Uint8Array, pairs: number, littleEndian: boolean): boolean {
  if (pairs === 0) return false
  let text = 0
  for (let index = 0; index < pairs; index += 1) {
    const unit = littleEndian
      ? bytes[index * 2]! | (bytes[index * 2 + 1]! << 8)
      : (bytes[index * 2]! << 8) | bytes[index * 2 + 1]!
    if (isUtf16TextUnit(unit)) text += 1
  }
  return text * 10 >= pairs * 9
}

/**
 * Detect BOM-less UTF-16 from the NUL-byte lane typical of scripts/config.
 *
 * The lane alone is NOT enough: a raw 16-bit little-endian stream (a sample
 * table, an audio buffer) leaves the high byte 0 for every value below 256 and
 * matches it exactly. Its code units then land all over the C0/C1 control
 * blocks instead of text, so the candidate must also read as text
 * ({@link looksLikeUtf16Text}) — otherwise a binary file opened as an editable
 * buffer, and a save rewrote it as UTF-16 (dropping the trailing byte of an
 * odd-length file, which `decodeUtf16` truncates in the same way).
 */
function bomlessUtf16(bytes: Uint8Array): 'utf16le' | 'utf16be' | undefined {
  if (bytes.length < 4) return undefined
  const pairs = Math.min(Math.floor(bytes.length / 2), 1024)
  let evenZeros = 0
  let oddZeros = 0
  for (let i = 0; i < pairs; i += 1) {
    if (bytes[i * 2] === 0) evenZeros += 1
    if (bytes[i * 2 + 1] === 0) oddZeros += 1
  }
  const minimumZeros = Math.max(2, Math.floor(pairs * 0.2))
  if (oddZeros >= minimumZeros && oddZeros >= evenZeros * 4
    && looksLikeUtf16Text(bytes, pairs, true)) return 'utf16le'
  if (evenZeros >= minimumZeros && evenZeros >= oddZeros * 4
    && looksLikeUtf16Text(bytes, pairs, false)) return 'utf16be'
  return undefined
}

function tryDecode(decoder: TextDecoder, bytes: Uint8Array): string | undefined {
  try {
    return decoder.decode(bytes)
  } catch {
    return undefined
  }
}

/** Detect the GB18030 four-byte sequences that are outside the GBK subset. */
function hasGb18030FourByteSequence(bytes: Uint8Array): boolean {
  for (let i = 0; i + 3 < bytes.length; i += 1) {
    const b1 = bytes[i]!
    const b2 = bytes[i + 1]!
    const b3 = bytes[i + 2]!
    const b4 = bytes[i + 3]!

    if (
      b1 >= 0x81 && b1 <= 0xfe &&
      b2 >= 0x30 && b2 <= 0x39 &&
      b3 >= 0x81 && b3 <= 0xfe &&
      b4 >= 0x30 && b4 <= 0x39
    ) {
      return true
    }
  }
  return false
}

/**
 * Whether a fatally-undecodable buffer fails only because the cap cut a
 * multi-byte character in half.
 *
 * A capped read (`readLimit` here, {@link ENCODING_SNIFF_LIMIT} on the save
 * side) may stop anywhere, and a partial CJK sequence is exactly what the
 * GB18030 decoder below accepts: two trailing bytes of a three-byte character
 * decode as one legacy glyph, so a >cap UTF-8 file used to come back as
 * mojibake on open and could be saved back under the wrong encoding. The
 * longest UTF-8 sequence is four bytes, so at most three are missing; the tail
 * is a read artifact rather than file content, which leaves the prefix — the
 * only bytes actually known — to decide the encoding.
 */
function hasIncompleteUtf8Tail(bytes: Uint8Array): boolean {
  for (let start = Math.max(0, bytes.length - 3); start < bytes.length; start += 1) {
    const lead = bytes[start]!
    const size = lead >= 0xf0 && lead <= 0xf4 ? 4
      : lead >= 0xe0 && lead <= 0xef ? 3
        : lead >= 0xc2 && lead <= 0xdf ? 2
          : 0
    // A sequence that fits entirely in the buffer is not a truncated tail:
    // its rejection is real evidence about the encoding.
    if (size === 0 || start + size <= bytes.length) continue
    let incomplete = true
    for (let i = start + 1; i < bytes.length; i += 1) {
      const trail = bytes[i]!
      if (trail < 0x80 || trail > 0xbf) {
        incomplete = false
        break
      }
    }
    if (incomplete && tryDecode(UTF8_DECODER, bytes.subarray(0, start)) !== undefined) return true
  }
  return false
}

/**
 * Decode a text buffer, or `null` when it looks binary (NUL-bearing and not
 * UTF-16/32). `truncated` says the buffer is a prefix of a larger file, which
 * lets a read cap cut mid-character without flipping the detected encoding.
 */
export function decodeTextBytes(bytes: Buffer, truncated = false): DecodedText | null {
  if (startsWith(bytes, UTF32LE_BOM)) {
    return { content: decodeUtf32(bytes.subarray(4), true), encoding: 'utf32le-bom' }
  }
  if (startsWith(bytes, UTF32BE_BOM)) {
    return { content: decodeUtf32(bytes.subarray(4), false), encoding: 'utf32be-bom' }
  }
  if (startsWith(bytes, UTF8_BOM)) {
    return { content: bytes.subarray(3).toString('utf8'), encoding: 'utf8-bom' }
  }
  if (startsWith(bytes, UTF16LE_BOM)) {
    return { content: decodeUtf16(bytes.subarray(2), true), encoding: 'utf16le-bom' }
  }
  if (startsWith(bytes, UTF16BE_BOM)) {
    return { content: decodeUtf16(bytes.subarray(2), false), encoding: 'utf16be-bom' }
  }

  const utf16 = bomlessUtf16(bytes)
  if (utf16 !== undefined) {
    return { content: decodeUtf16(bytes, utf16 === 'utf16le'), encoding: utf16 }
  }
  if (bytes.includes(0)) return null

  const utf8 = tryDecode(UTF8_DECODER, bytes)
  if (utf8 !== undefined) return { content: utf8, encoding: 'utf8' }

  if (truncated && hasIncompleteUtf8Tail(bytes)) {
    // Keep the previous replacement-character rendering of the partial tail
    // rather than dropping the bytes from the editor buffer.
    return { content: bytes.toString('utf8'), encoding: 'utf8' }
  }

  const gb18030 = tryDecode(GB18030_DECODER, bytes)
  if (gb18030 !== undefined && hasGb18030FourByteSequence(bytes)) {
    return { content: gb18030, encoding: 'gb18030' }
  }

  // WHATWG defines GBK as the GB18030 decoder, so a successful GBK decode
  // alone cannot distinguish ordinary CP936 data from GB18030's subset.
  const gbk = tryDecode(GBK_DECODER, bytes)
  if (gbk !== undefined) return { content: gbk, encoding: 'gbk' }

  if (gb18030 !== undefined) return { content: gb18030, encoding: 'gb18030' }

  // Keep the previous replacement-character behavior for unknown non-NUL
  // streams instead of newly classifying them as binary.
  return { content: bytes.toString('utf8'), encoding: 'utf8' }
}

let gbkEncodeMap: Map<string, number> | undefined

function getGbkEncodeMap(): Map<string, number> {
  if (gbkEncodeMap !== undefined) return gbkEncodeMap
  const map = new Map<string, number>()
  for (let byte = 0; byte <= 0x7f; byte += 1) map.set(String.fromCharCode(byte), byte)
  map.set('€', 0x80)
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue
      const char = tryDecode(GBK_DECODER, Uint8Array.of(lead, trail))
      if (char !== undefined && [...char].length === 1 && !map.has(char)) {
        map.set(char, (lead << 8) | trail)
      }
    }
  }
  gbkEncodeMap = map
  return map
}

function gb18030PointerBytes(pointer: number): readonly [number, number, number, number] {
  let value = pointer
  const fourth = value % 10
  value = Math.floor(value / 10)
  const third = value % 126
  value = Math.floor(value / 126)
  const second = value % 10
  value = Math.floor(value / 10)
  return [value + 0x81, second + 0x30, third + 0x81, fourth + 0x30]
}

const gb18030PointerCache = new Map<string, number>()

function resolveGb18030Pointers(chars: Set<string>): void {
  const pending = new Set([...chars].filter(char => !gb18030PointerCache.has(char)))
  if (pending.size === 0) return

  // WHATWG exposes decoders but not encoders. Materialize the compact
  // algorithmic four-byte space once, decode it in order, and retain only
  // the pointers needed by this save. This avoids shipping a large table.
  const bytes = Buffer.allocUnsafe(GB18030_POINTERS * 4)
  for (let pointer = 0; pointer < GB18030_POINTERS; pointer += 1) {
    bytes.set(gb18030PointerBytes(pointer), pointer * 4)
  }
  const decoded = GB18030_LOOSE_DECODER.decode(bytes)
  let pointer = 0
  for (const char of decoded) {
    if (char !== '\ufffd' && pending.has(char)) {
      gb18030PointerCache.set(char, pointer)
      pending.delete(char)
      if (pending.size === 0) break
    }
    pointer += 1
  }
  if (pending.size > 0) {
    throw new RangeError(`text contains characters not representable in GB18030: ${JSON.stringify([...pending])}`)
  }
}

function encodeLegacy(text: string, gb18030: boolean): Buffer {
  const map = getGbkEncodeMap()
  const chars = [...text]
  if (gb18030) {
    resolveGb18030Pointers(new Set(chars.filter(char => !map.has(char))))
  }
  const bytes: number[] = []
  for (const char of chars) {
    const gbk = map.get(char)
    if (gbk !== undefined) {
      if (gbk <= 0xff) bytes.push(gbk)
      else bytes.push(gbk >> 8, gbk & 0xff)
      continue
    }
    if (!gb18030) {
      throw new RangeError(`text contains a character not representable in GBK: ${JSON.stringify(char)}`)
    }
    const pointer = gb18030PointerCache.get(char)
    if (pointer === undefined) {
      throw new RangeError(`text contains a character not representable in GB18030: ${JSON.stringify(char)}`)
    }
    bytes.push(...gb18030PointerBytes(pointer))
  }
  return Buffer.from(bytes)
}

export function encodeText(text: string, encoding: TextEncoding): Buffer {
  switch (encoding) {
    case 'utf8': return Buffer.from(text, 'utf8')
    case 'utf8-bom': return Buffer.concat([UTF8_BOM, Buffer.from(text, 'utf8')])
    case 'utf16le': return encodeUtf16(text, true)
    case 'utf16le-bom': return Buffer.concat([UTF16LE_BOM, encodeUtf16(text, true)])
    case 'utf16be': return encodeUtf16(text, false)
    case 'utf16be-bom': return Buffer.concat([UTF16BE_BOM, encodeUtf16(text, false)])
    case 'utf32le-bom': return Buffer.concat([UTF32LE_BOM, encodeUtf32(text, true)])
    case 'utf32be-bom': return Buffer.concat([UTF32BE_BOM, encodeUtf32(text, false)])
    case 'gbk': return encodeLegacy(text, false)
    case 'gb18030': return encodeLegacy(text, true)
  }
}

/**
 * Majority vote over the leading {@link EOL_SNIFF_LIMIT} characters: CRLF wins
 * only when the CRLF pairs outnumber the bare LFs. A file with a single trailing
 * CRLF among many LF lines therefore reads as LF, and a `\r`-only (classic Mac)
 * file reads as LF without its bytes being touched — both the same verdict the
 * host backend reaches, so a plugin save and a model `edit` agree.
 */
export function detectEol(text: string): TextEol {
  const sample = text.slice(0, EOL_SNIFF_LIMIT)
  const crlf = sample.split('\r\n').length - 1
  const lines = sample.split('\n').length - 1
  return crlf > lines - crlf ? 'crlf' : 'lf'
}

/**
 * Convert the editor's LF document back to the file's own style before
 * encoding. CRLF content is normalized first (unlike a naive `split('\n').join`
 * this can never turn an existing pair into `\r\r\n`) — the same guard the host
 * backend's `restoreLineEndings` documents. Everything else, including a lone
 * `\r`, is passed through untouched.
 */
export function restoreEol(text: string, eol: TextEol): string {
  if (eol === 'lf') return text
  return text.replaceAll('\r\n', '\n').split('\n').join('\r\n')
}

/**
 * Detect the on-disk format a save has to round-trip: byte encoding AND line
 * endings, from one sniff read. Called before the temp write on every save, so
 * the editor never silently converts GBK / UTF-16 / BOM'd UTF-8 bytes — nor a
 * CRLF file to LF, which for a one-line edit would land as a whole-file diff
 * (#871). A missing file yields UTF-8 + LF (see the comment below).
 */
export async function fileFormatOf(path: string): Promise<FileFormat> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    // A file that does not exist yet has no format to preserve. New files are
    // written as UTF-8 + LF; deriving a project-wide convention (a sibling
    // majority, a `.gitattributes` read, a preference) is a separate decision,
    // deliberately not taken here — this batch only stops CHANGING a format a
    // file already has.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { encoding: 'utf8', eol: 'lf' }
    throw error
  }
  try {
    const info = await handle.stat()
    // The sniff window can cut a multi-byte character like any other cap.
    const truncated = info.size > ENCODING_SNIFF_LIMIT
    const bytes = Buffer.alloc(Math.min(info.size, ENCODING_SNIFF_LIMIT))
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    const decoded = decodeTextBytes(bytes.subarray(0, bytesRead), truncated)
    return {
      encoding: decoded?.encoding ?? 'utf8',
      // A binary read has no line structure to preserve; the editor cannot be
      // showing one anyway (it falls back to the download pane).
      eol: decoded === null ? 'lf' : detectEol(decoded.content),
    }
  } finally {
    await handle.close()
  }
}
