/**
 * The `.cluepack` archive codec (S7): a small, dependency-free ZIP
 * implementation over `node:zlib`.
 *
 * Why not the system `zip`/`tar`: sharing must work on every host the plugin
 * runs on, including Windows installs that have neither, and importing an
 * archive must never create a system-level install side effect. `node:zlib`
 * ships with Node, so stored/deflate entries, CRC32 and the central directory
 * are all this module's own code.
 *
 * Security boundary (the reader is the untrusted-input side):
 * - every entry name must be a relative path with no `.`/`..` segment, no
 *   backslash, no drive/UNC prefix, no NUL and a bounded byte length;
 * - directory entries are skipped; symbolic links are refused (they would
 *   escape the extraction root if a future caller ever writes files);
 * - duplicate names are refused, so one name cannot resolve to two payloads;
 * - encrypted entries, unsupported compression methods, ZIP64 and multi-disk
 *   archives are refused explicitly instead of being guessed at;
 * - file count, per-entry size and total expanded size are checked BEFORE
 *   inflating, and `maxOutputLength` bounds a stream whose header lied;
 * - every payload's CRC32 is verified.
 *
 * Entries are returned in memory; the caller (the cluepack importer) never
 * extracts to a path derived from an archive name.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { ClueError } from '../types.ts'

/** Default resource limits of one archive read. */
export interface ZipReadLimits {
  /** Maximum number of central-directory entries. */
  readonly maxEntries: number
  /** Maximum expanded size of one entry, in bytes. */
  readonly maxEntryBytes: number
  /** Maximum expanded size of all entries together, in bytes. */
  readonly maxTotalBytes: number
  /** Maximum size of the archive bytes handed to `readZip`. */
  readonly maxArchiveBytes: number
  /** Maximum byte length of one entry name. */
  readonly maxNameBytes: number
}

/** Conservative defaults: a clue pack is small documents, not a backup. */
export const DEFAULT_ZIP_LIMITS: ZipReadLimits = {
  maxEntries: 4_096,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxArchiveBytes: 64 * 1024 * 1024,
  maxNameBytes: 1_024,
}

/** One entry to write. */
export interface ZipEntryInput {
  readonly name: string
  readonly data: Uint8Array
  /**
   * Try deflate for this entry. Deflate is only used when it actually shrinks
   * the payload; absent means "try" (metadata and text benefit, binary often
   * does not).
   */
  readonly compress?: boolean
}

/** One decoded entry. */
export interface ZipEntry {
  readonly name: string
  readonly data: Uint8Array
  /** CRC32 the archive recorded for this entry (already verified). */
  readonly crc32: number
}

/** Options of {@link createZip}. */
export interface ZipWriteOptions {
  /** Modification time recorded in every header (defaults to "now"). */
  readonly modifiedAt?: Date
}

const LOCAL_HEADER_SIGNATURE = 0x0403_4b50
const CENTRAL_HEADER_SIGNATURE = 0x0201_4b50
const EOCD_SIGNATURE = 0x0605_4b50
const UTF8_FLAG = 0x0800
const ENCRYPTED_FLAG = 0x0001
const METHOD_STORED = 0
const METHOD_DEFLATE = 8
const UNIX_SYMLINK_MODE = 0o120000
const UNIX_REGULAR_FILE_MODE = 0o100644
const LOCAL_HEADER_SIZE = 30
const CENTRAL_HEADER_SIZE = 46
const EOCD_SIZE = 22
/** ZIP's 32-bit fields cap a non-ZIP64 archive at 4 GiB / 65 535 entries. */
const MAX_UINT16 = 0xffff
const MAX_UINT32 = 0xffff_ffff

/** The standard CRC32 table (IEEE 802.3), computed once. */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/** CRC32 of arbitrary bytes (the value ZIP stores in both headers). */
export function crc32(data: Uint8Array): number {
  let value = 0xffff_ffff
  for (let index = 0; index < data.length; index += 1) {
    const byte = data[index]!
    value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8)
  }
  return (value ^ 0xffff_ffff) >>> 0
}

/** UTF-8 encoder shared by the writer and the manifest layer. */
const UTF8_ENCODER = new TextEncoder()
/** Fatal decoder: legacy/CP437 names are refused rather than mojibaked. */
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

/**
 * Assert that one archive entry name is a safe relative path.
 *
 * This is applied on BOTH sides: the writer refuses to emit a name a reader
 * would have to reject, and the reader refuses anything an attacker wrote by
 * hand. A trailing slash marks a directory entry and is the only empty
 * segment allowed.
 * @param name - the name exactly as it appears in the archive.
 * @param maxNameBytes - byte bound (defaults to the shared limit).
 */
export function assertZipEntryName(name: string, maxNameBytes = DEFAULT_ZIP_LIMITS.maxNameBytes): void {
  const fail = (reason: string): never => {
    throw new ClueError('invalid-request', `unsafe archive entry name "${name}": ${reason}`)
  }
  if (typeof name !== 'string' || name === '') fail('the name is empty')
  if (name.includes('\0')) fail('the name contains a NUL byte')
  if (name.includes('\\')) fail('backslash separators are not portable')
  if (name.startsWith('/')) fail('absolute paths are not allowed')
  if (/^[A-Za-z]:/.test(name)) fail('drive paths are not allowed')
  if (name.length > maxNameBytes || UTF8_ENCODER.encode(name).length > maxNameBytes) {
    fail(`the name exceeds ${maxNameBytes} bytes`)
  }
  const directory = name.endsWith('/')
  const body = directory ? name.slice(0, -1) : name
  if (body === '') fail('the name is empty')
  for (const segment of body.split('/')) {
    if (segment === '') fail('empty path segments are not allowed')
    if (segment === '.' || segment === '..') fail('path traversal is not allowed')
    if (segment.trim() !== segment) fail('segments must not have surrounding whitespace')
  }
}

/** Decode one entry name as strict UTF-8, or refuse the archive. */
function decodeEntryName(bytes: Uint8Array): string {
  try {
    return UTF8_DECODER.decode(bytes)
  } catch {
    throw new ClueError('invalid-request', 'an archive entry name is not valid UTF-8')
  }
}

/** DOS date/time pair of one JS date (clamped to the representable range). */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, date.getUTCFullYear()))
  const month = date.getUTCMonth() + 1
  const day = date.getUTCDate()
  const hours = date.getUTCHours()
  const minutes = date.getUTCMinutes()
  const seconds = Math.floor(date.getUTCSeconds() / 2)
  return {
    time: ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f),
  }
}

 /** Resolve the effective limits (partial overrides, validated once). */
function resolveLimits(overrides: Partial<ZipReadLimits> | undefined): ZipReadLimits {
  const limits: ZipReadLimits = { ...DEFAULT_ZIP_LIMITS, ...overrides }
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new ClueError('invalid-request', `archive limit "${key}" must be a positive integer`)
    }
  }
  return limits
}

/**
 * Build one ZIP archive from in-memory entries.
 * @param entries - payloads to write (names are validated and de-duplicated).
 * @param options - recorded modification time.
 * @returns the complete archive bytes.
 */
export function createZip(entries: readonly ZipEntryInput[], options: ZipWriteOptions = {}): Buffer {
  if (entries.length > MAX_UINT16) {
    throw new ClueError('invalid-request', `a ZIP archive supports at most ${MAX_UINT16} entries`)
  }
  const { time, date } = dosDateTime(options.modifiedAt ?? new Date())
  const seen = new Set<string>()
  interface Prepared {
    nameBytes: Buffer
    data: Uint8Array
    method: number
    crc: number
    compressed: Uint8Array
    offset: number
  }
  const prepared: Prepared[] = []
  let offset = 0
  for (const entry of entries) {
    assertZipEntryName(entry.name)
    if (seen.has(entry.name)) {
      throw new ClueError('invalid-request', `duplicate archive entry "${entry.name}"`)
    }
    seen.add(entry.name)
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data)
    if (entry.name.endsWith('/') && data.length > 0) {
      throw new ClueError('invalid-request', `directory archive entry "${entry.name}" must not carry data`)
    }
    if (data.length > MAX_UINT32) {
      throw new ClueError('invalid-request', `archive entry "${entry.name}" is too large for a ZIP file`)
    }
    // Deflate only wins when it actually shrinks the payload; a stored entry
    // is both smaller on disk and cheaper to read for already-compressed data.
    const deflated = entry.compress === false ? undefined : deflateRawSync(data)
    const compressed = deflated !== undefined && deflated.length < data.length ? deflated : data
    const method = compressed === data ? METHOD_STORED : METHOD_DEFLATE
    const nameBytes = Buffer.from(UTF8_ENCODER.encode(entry.name))
    prepared.push({ nameBytes, data, method, crc: crc32(data), compressed, offset })
    offset += LOCAL_HEADER_SIZE + nameBytes.length + compressed.length
  }
  if (offset > MAX_UINT32) {
    throw new ClueError('invalid-request', 'the ZIP archive exceeds the non-ZIP64 size limit')
  }
  const centralSize = prepared.reduce(
    (total, entry) => total + CENTRAL_HEADER_SIZE + entry.nameBytes.length,
    0,
  )
  if (offset + centralSize + EOCD_SIZE > MAX_UINT32) {
    throw new ClueError('invalid-request', 'the ZIP archive exceeds the non-ZIP64 size limit')
  }
  const archive = Buffer.alloc(offset + centralSize + EOCD_SIZE)
  let cursor = 0
  for (const entry of prepared) {
    archive.writeUInt32LE(LOCAL_HEADER_SIGNATURE, cursor)
    archive.writeUInt16LE(20, cursor + 4)
    archive.writeUInt16LE(UTF8_FLAG, cursor + 6)
    archive.writeUInt16LE(entry.method, cursor + 8)
    archive.writeUInt16LE(time, cursor + 10)
    archive.writeUInt16LE(date, cursor + 12)
    archive.writeUInt32LE(entry.crc, cursor + 14)
    archive.writeUInt32LE(entry.compressed.length, cursor + 18)
    archive.writeUInt32LE(entry.data.length, cursor + 22)
    archive.writeUInt16LE(entry.nameBytes.length, cursor + 26)
    archive.writeUInt16LE(0, cursor + 28)
    entry.nameBytes.copy(archive, cursor + LOCAL_HEADER_SIZE)
    Buffer.from(entry.compressed).copy(archive, cursor + LOCAL_HEADER_SIZE + entry.nameBytes.length)
    cursor += LOCAL_HEADER_SIZE + entry.nameBytes.length + entry.compressed.length
  }
  const centralOffset = cursor
  for (const entry of prepared) {
    archive.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, cursor)
    archive.writeUInt16LE((3 << 8) | 20, cursor + 4) // made by UNIX
    archive.writeUInt16LE(20, cursor + 6)
    archive.writeUInt16LE(UTF8_FLAG, cursor + 8)
    archive.writeUInt16LE(entry.method, cursor + 10)
    archive.writeUInt16LE(time, cursor + 12)
    archive.writeUInt16LE(date, cursor + 14)
    archive.writeUInt32LE(entry.crc, cursor + 16)
    archive.writeUInt32LE(entry.compressed.length, cursor + 20)
    archive.writeUInt32LE(entry.data.length, cursor + 24)
    archive.writeUInt16LE(entry.nameBytes.length, cursor + 28)
    archive.writeUInt16LE(0, cursor + 30) // extra
    archive.writeUInt16LE(0, cursor + 32) // comment
    archive.writeUInt16LE(0, cursor + 34) // disk start
    archive.writeUInt16LE(0, cursor + 36) // internal attributes
    archive.writeUInt32LE((UNIX_REGULAR_FILE_MODE << 16) >>> 0, cursor + 38)
    archive.writeUInt32LE(entry.offset, cursor + 42)
    entry.nameBytes.copy(archive, cursor + CENTRAL_HEADER_SIZE)
    cursor += CENTRAL_HEADER_SIZE + entry.nameBytes.length
  }
  archive.writeUInt32LE(EOCD_SIGNATURE, cursor)
  archive.writeUInt16LE(0, cursor + 4) // this disk
  archive.writeUInt16LE(0, cursor + 6) // central directory disk
  archive.writeUInt16LE(prepared.length, cursor + 8)
  archive.writeUInt16LE(prepared.length, cursor + 10)
  archive.writeUInt32LE(centralSize, cursor + 12)
  archive.writeUInt32LE(centralOffset, cursor + 16)
  archive.writeUInt16LE(0, cursor + 20) // comment length
  return archive
}

/** Locate the end-of-central-directory record (the last valid one). */
function findEocd(buffer: Buffer): number {
  if (buffer.length < EOCD_SIZE) {
    throw new ClueError('invalid-request', 'the file is not a zip archive')
  }
  const minimum = Math.max(0, buffer.length - EOCD_SIZE - MAX_UINT16)
  for (let offset = buffer.length - EOCD_SIZE; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIGNATURE) continue
    const commentLength = buffer.readUInt16LE(offset + 20)
    if (offset + EOCD_SIZE + commentLength === buffer.length) return offset
  }
  throw new ClueError('invalid-request', 'the file is not a zip archive')
}

/** Read one deflated payload with a hard output bound. */
function inflateEntry(compressed: Uint8Array, expectedBytes: number, name: string): Uint8Array {
  try {
    return inflateRawSync(compressed, { maxOutputLength: Math.max(1, expectedBytes) })
  } catch {
    throw new ClueError('invalid-request', `archive entry "${name}" is corrupt or exceeds its declared size`)
  }
}

/**
 * Read and validate one ZIP archive into memory.
 * @param input - the raw archive bytes (untrusted).
 * @param overrides - stricter limits for one call.
 * @returns every non-directory entry, in central-directory order.
 */
export function readZip(input: Uint8Array, overrides?: Partial<ZipReadLimits>): ZipEntry[] {
  const limits = resolveLimits(overrides)
  if (input.byteLength > limits.maxArchiveBytes) {
    throw new ClueError(
      'invalid-request',
      `the zip archive is too large (${input.byteLength} bytes; limit ${limits.maxArchiveBytes})`,
    )
  }
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  const eocd = findEocd(buffer)
  const diskNumber = buffer.readUInt16LE(eocd + 4)
  const centralDisk = buffer.readUInt16LE(eocd + 6)
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8)
  const totalEntries = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (
    totalEntries === MAX_UINT16
    || entriesOnDisk === MAX_UINT16
    || centralSize === MAX_UINT32
    || centralOffset === MAX_UINT32
  ) {
    throw new ClueError('unsupported', 'ZIP64 clue packs are not supported')
  }
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new ClueError('unsupported', 'multi-disk zip archives are not supported')
  }
  if (totalEntries > limits.maxEntries) {
    throw new ClueError(
      'invalid-request',
      `the zip archive exceeds the entry limit (${totalEntries} entries; limit ${limits.maxEntries})`,
    )
  }
  if (centralOffset + centralSize > buffer.length) {
    throw new ClueError('invalid-request', 'the zip central directory lies outside the archive')
  }
  const entries: ZipEntry[] = []
  const seen = new Set<string>()
  let cursor = centralOffset
  let totalBytes = 0
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + CENTRAL_HEADER_SIZE > buffer.length) {
      throw new ClueError('invalid-request', 'the zip central directory is truncated')
    }
    if (buffer.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE) {
      throw new ClueError('invalid-request', 'the zip central directory is corrupt')
    }
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const recordedCrc = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const entryDisk = buffer.readUInt16LE(cursor + 34)
    const externalAttributes = buffer.readUInt32LE(cursor + 38)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const nameStart = cursor + CENTRAL_HEADER_SIZE
    const nameEnd = nameStart + nameLength
    if (nameEnd > buffer.length) {
      throw new ClueError('invalid-request', 'the zip central directory is truncated')
    }
    const nameBytes = buffer.subarray(nameStart, nameEnd)
    const name = decodeEntryName(nameBytes)
    cursor = nameEnd + extraLength + commentLength
    if ((externalAttributes >>> 16 & 0o170000) === UNIX_SYMLINK_MODE) {
      throw new ClueError('invalid-request', `archive entry "${name}" is a symbolic link`)
    }
    if ((flags & ENCRYPTED_FLAG) !== 0) {
      throw new ClueError('unsupported', `archive entry "${name}" is encrypted`)
    }
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw new ClueError('unsupported', `archive entry "${name}" uses an unsupported compression method`)
    }
    if (entryDisk !== 0) {
      throw new ClueError('unsupported', 'multi-disk zip archives are not supported')
    }
    if (seen.has(name)) {
      throw new ClueError('invalid-request', `duplicate archive entry "${name}"`)
    }
    assertZipEntryName(name, limits.maxNameBytes)
    seen.add(name)
    const directory = name.endsWith('/')
    if (directory) {
      if (compressedSize !== 0 || uncompressedSize !== 0) {
        throw new ClueError('invalid-request', `archive directory entry "${name}" carries data`)
      }
      continue
    }
    if (uncompressedSize > limits.maxEntryBytes || compressedSize > limits.maxArchiveBytes) {
      throw new ClueError(
        'invalid-request',
        `archive entry "${name}" exceeds the size limit (${uncompressedSize} bytes; limit ${limits.maxEntryBytes})`,
      )
    }
    totalBytes += uncompressedSize
    if (totalBytes > limits.maxTotalBytes) {
      throw new ClueError(
        'invalid-request',
        `the zip archive exceeds the expanded size limit (${totalBytes} bytes; limit ${limits.maxTotalBytes})`,
      )
    }
    if (localOffset + LOCAL_HEADER_SIZE > buffer.length) {
      throw new ClueError('invalid-request', `archive entry "${name}" has an invalid local header offset`)
    }
    if (buffer.readUInt32LE(localOffset) !== LOCAL_HEADER_SIGNATURE) {
      throw new ClueError('invalid-request', `archive entry "${name}" has no local header`)
    }
    const localMethod = buffer.readUInt16LE(localOffset + 8)
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const localNameStart = localOffset + LOCAL_HEADER_SIZE
    const localNameEnd = localNameStart + localNameLength
    if (localNameEnd > buffer.length || !buffer.subarray(localNameStart, localNameEnd).equals(nameBytes)) {
      throw new ClueError('invalid-request', `archive entry "${name}" has a mismatched local header name`)
    }
    if (localMethod !== method) {
      throw new ClueError('invalid-request', `archive entry "${name}" has a mismatched compression method`)
    }
    const dataStart = localNameEnd + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buffer.length || dataEnd > centralOffset) {
      throw new ClueError('invalid-request', `archive entry "${name}" payload lies outside the archive`)
    }
    const compressed = buffer.subarray(dataStart, dataEnd)
    let data: Uint8Array
    if (method === METHOD_STORED) {
      if (compressedSize !== uncompressedSize) {
        throw new ClueError('invalid-request', `archive entry "${name}" has inconsistent stored sizes`)
      }
      data = new Uint8Array(buffer.buffer, buffer.byteOffset + dataStart, compressedSize)
    } else {
      const inflated = inflateEntry(compressed, uncompressedSize, name)
      data = new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength)
      if (data.length !== uncompressedSize) {
        throw new ClueError('invalid-request', `archive entry "${name}" does not match its declared size`)
      }
    }
    if (crc32(data) !== recordedCrc) {
      throw new ClueError('invalid-request', `archive entry "${name}" failed the checksum check`)
    }
    entries.push({ name, data, crc32: recordedCrc })
  }
  if (cursor > centralOffset + centralSize) {
    throw new ClueError('invalid-request', 'the zip central directory is corrupt')
  }
  return entries
}
