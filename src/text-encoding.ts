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

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const UTF16LE_BOM = Buffer.from([0xff, 0xfe])
const UTF16BE_BOM = Buffer.from([0xfe, 0xff])
const UTF32LE_BOM = Buffer.from([0xff, 0xfe, 0x00, 0x00])
const UTF32BE_BOM = Buffer.from([0x00, 0x00, 0xfe, 0xff])
const ENCODING_SNIFF_LIMIT = 64 * 1024

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

/** Detect BOM-less UTF-16 from the NUL-byte lane typical of scripts/config. */
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
  if (oddZeros >= minimumZeros && oddZeros >= evenZeros * 4) return 'utf16le'
  if (evenZeros >= minimumZeros && evenZeros >= oddZeros * 4) return 'utf16be'
  return undefined
}

function tryDecode(decoder: TextDecoder, bytes: Uint8Array): string | undefined {
  try {
    return decoder.decode(bytes)
  } catch {
    return undefined
  }
}

export function decodeTextBytes(bytes: Buffer): DecodedText | null {
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

  // WHATWG's "gbk" decoder is CP936-compatible (including the Windows 0x80
  // euro extension), matching the ANSI encoding used on Simplified Chinese
  // Windows. Prefer it before GB18030 so ordinary legacy files keep GBK on save.
  const gbk = tryDecode(GBK_DECODER, bytes)
  if (gbk !== undefined) return { content: gbk, encoding: 'gbk' }

  const gb18030 = tryDecode(GB18030_DECODER, bytes)
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

export async function encodingOfFile(path: string): Promise<TextEncoding> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'utf8'
    throw error
  }
  try {
    const info = await handle.stat()
    const bytes = Buffer.alloc(Math.min(info.size, ENCODING_SNIFF_LIMIT))
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    return decodeTextBytes(bytes.subarray(0, bytesRead))?.encoding ?? 'utf8'
  } finally {
    await handle.close()
  }
}
