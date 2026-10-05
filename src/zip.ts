/**
 * Archive builder for the file tree's "zip and download" action.
 *
 * One self-contained ZIP writer: local file headers + central directory +
 * EOCD, CRC-32 computed locally, `store` (method 0) or `zlib`'s raw DEFLATE
 * (method 8) picked per entry by whichever is smaller, names written as
 * UTF-8 (general-purpose bit 11) and DOS timestamps taken from one `Date`
 * for the whole archive. No third-party dependency, no filesystem walking —
 * the caller supplies the entries, this module only reads their bytes.
 *
 * The entries are bounded by `maxEntries` / `maxBytes`: the count is checked
 * up front, and every source is stat'ed against the remaining byte budget
 * BEFORE it is read, so a runaway selection fails with a clear error instead
 * of filling memory with an archive nobody asked for.
 */
import { readFile, stat } from 'node:fs/promises'
import { deflateRaw } from 'node:zlib'
import { promisify } from 'node:util'
import { SidebarError } from './wire.ts'

/** One archive member: a file to read, or a directory to record. */
export interface ZipEntry {
  /** Absolute filesystem path (source of the bytes). Ignored for a directory
   *  entry (`isDir: true`), which only contributes its own header row. */
  path: string
  /** In-archive name: '/'-separated and relative. A directory name must end
   *  with '/'. */
  name: string
  /** Write a directory entry (zero-length name + trailing '/') instead of
   *  reading the path as a file. */
  isDir?: boolean
}

/** One progress report: entries finished, entries total, bytes read so far. */
export interface ZipProgress {
  /** Entries fully processed (payload read, compressed, hashed). */
  done: number
  /** Entries the archive will contain (known up front: the entries array). */
  total: number
  /** Uncompressed bytes accumulated so far. */
  bytes: number
}

/** The archive bounds and the optional progress hook. */
export interface ZipOptions {
  /** Total uncompressed byte bound; exceeding it throws fs-error. */
  maxBytes?: number
  /** Entry-count bound (directory entries included); exceeding it throws
   *  fs-error. */
  maxEntries?: number
  /** Called once per finished entry, in archive order (never for a failed
   *  one). A throw from the hook aborts the build. */
  onProgress?: (progress: ZipProgress) => void
}

/** Default total uncompressed payload bound of one archive (256 MiB). */
export const ZIP_MAX_BYTES = 256 * 1024 * 1024
/** Default entry-count bound of one archive. */
export const ZIP_MAX_ENTRIES = 10_000

/** DOS epoch (1980-01-01) — the smallest representable DOS timestamp. */
const DOS_YEAR_BASE = 1980

/** CRC-32 (IEEE 802.3, the ZIP polynomial), table built once per process. */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1)
    }
    table[i] = value >>> 0
  }
  return table
})()

/** CRC-32 of one buffer. */
export function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xFF]! ^ (crc >>> 8)
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

/** One prepared member: the bytes to store plus their header fields. */
interface ZipMember {
  name: Buffer
  data: Buffer
  crc: number
  method: 0 | 8
  /** Uncompressed size (the local/central header field). */
  size: number
}

const deflateRawAsync = promisify(deflateRaw)

/** DOS date + time words for one instant (clamped to the 1980 epoch). */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(date.getFullYear(), DOS_YEAR_BASE)
  const month = date.getMonth() + 1
  const day = date.getDate()
  const hours = date.getHours()
  const minutes = date.getMinutes()
  const seconds = date.getSeconds()
  return {
    time: (hours << 11) | (minutes << 5) | (seconds >> 1),
    date: ((year - DOS_YEAR_BASE) << 9) | (month << 5) | day,
  }
}

/**
 * Normalize an entry name to a '/'-separated relative archive path.
 *
 * A backslash is NOT a separator here: on POSIX (and on the host half, which
 * builds the names) `a\b.txt` is one legal file name, so converting it would
 * silently split one file into a directory. Windows separators never reach
 * this point — the walk composes names from `basename`/`join` results.
 * Leading slashes are dropped (names are archive-relative by definition) and
 * `..` segments are refused, so a name can never traverse.
 */
function archiveName(raw: string, isDir: boolean): string {
  const normalized = raw.replace(/^\/+/, '')
  const segments = normalized.split('/').filter(segment => segment !== '' && segment !== '.')
  if (raw === '..' || segments.length === 0 || segments.includes('..')) {
    throw new SidebarError('bad-request', `invalid archive entry name "${raw}"`)
  }
  const name = segments.join('/')
  return isDir ? `${name}/` : name
}

/** The absolute filesystem path shape the builder accepts. */
function requireSourcePath(raw: string): string {
  if (raw === '' || raw.includes('\0')) {
    throw new SidebarError('bad-request', 'archive entry path is required')
  }
  return raw
}

/**
 * Read + compress one member (deflate only when it actually shrinks).
 * @param limit - the archive's total uncompressed ceiling (for the message).
 * @param budget - uncompressed bytes still available; the source is stat'ed
 *  FIRST and refused when it cannot fit, so an oversized archive never pulls
 *  the payload into memory (let alone deflates it) before failing.
 */
async function prepareFile(name: string, path: string, limit: number, budget: number): Promise<ZipMember> {
  let size: number
  try {
    size = (await stat(path)).size
  } catch (error) {
    throw new SidebarError('fs-error', `cannot read "${path}": ${error instanceof Error ? error.message : String(error)}`, 400)
  }
  // `budget <= 0` refuses even a zero-size source. That is not pedantry: a
  // FIFO stats as 0 bytes and reading one BLOCKS until a writer shows up, so
  // an exhausted budget must never reach open().
  if (budget <= 0 || size > budget) {
    throw new SidebarError('fs-error', `archive exceeds the ${limit} byte limit`, 400)
  }
  let data: Buffer
  try {
    data = await readFile(path)
  } catch (error) {
    throw new SidebarError('fs-error', `cannot read "${path}": ${error instanceof Error ? error.message : String(error)}`, 400)
  }
  const crc = crc32(data)
  const deflated = await deflateRawAsync(data)
  const useDeflate = deflated.byteLength < data.byteLength
  return {
    name: Buffer.from(name, 'utf8'),
    data: useDeflate ? deflated : data,
    crc,
    method: useDeflate ? 8 : 0,
    size: data.byteLength,
  }
}

/** One directory member (zero payload, name already carries the '/'). */
function directoryMember(name: string): ZipMember {
  return { name: Buffer.from(name, 'utf8'), data: Buffer.alloc(0), crc: 0, method: 0, size: 0 }
}

/** Write one local file header + payload into `out`. */
function writeLocalHeader(out: Buffer[], member: ZipMember, time: number, date: number): void {
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034B50, 0)
  header.writeUInt16LE(20, 4) // version needed: 2.0 (deflate)
  header.writeUInt16LE(0x0800, 6) // general purpose: UTF-8 names (bit 11)
  header.writeUInt16LE(member.method, 8)
  header.writeUInt16LE(time, 10)
  header.writeUInt16LE(date, 12)
  header.writeUInt32LE(member.crc, 14)
  header.writeUInt32LE(member.data.byteLength, 18)
  header.writeUInt32LE(member.size, 22)
  header.writeUInt16LE(member.name.byteLength, 26)
  header.writeUInt16LE(0, 28) // extra length
  out.push(header, member.name, member.data)
}

/**
 * Build one ZIP archive from the given entries.
 * @param entries - files to read and/or directory rows to record; a directory
 *  row contributes its own header, its children are separate entries.
 * @param opts - entry-count and total-byte bounds ({@link ZipOptions}).
 * @returns the ZIP bytes.
 * @throws {SidebarError} bad-request for malformed entry names/paths,
 *  fs-error when an entry cannot be read or a bound is exceeded.
 */
export async function buildZip(entries: readonly ZipEntry[], opts: ZipOptions = {}): Promise<Buffer> {
  const maxEntries = opts.maxEntries ?? ZIP_MAX_ENTRIES
  const maxBytes = opts.maxBytes ?? ZIP_MAX_BYTES
  if (entries.length > maxEntries) {
    throw new SidebarError('fs-error', `too many entries for one archive (${entries.length} > ${maxEntries})`, 400)
  }
  const now = new Date()
  const stamp = dosDateTime(now)

  const members: ZipMember[] = []
  /** Total uncompressed payload (the bound is checked against it). */
  let totalBytes = 0
  /** Entries finished so far (the progress hook's `done`). */
  let done = 0
  const report = (): void => {
    opts.onProgress?.({ done, total: entries.length, bytes: totalBytes })
  }
  for (const entry of entries) {
    if (entry.isDir === true) {
      members.push(directoryMember(archiveName(entry.name, true)))
      done += 1
      report()
      continue
    }
    const path = requireSourcePath(entry.path)
    // The bound is the archive's total UNCOMPRESSED payload: that is what the
    // reader materializes, and it makes the limit independent of how well the
    // input happens to compress.
    const member = await prepareFile(archiveName(entry.name, false), path, maxBytes, maxBytes - totalBytes)
    // A source can grow AFTER its stat (sparse files, concurrent writers), so
    // the ceiling is re-checked against what was actually read.
    if (totalBytes + member.size > maxBytes) {
      throw new SidebarError('fs-error', `archive exceeds the ${maxBytes} byte limit`, 400)
    }
    totalBytes += member.size
    members.push(member)
    done += 1
    report()
  }

  const out: Buffer[] = []
  const offsets: number[] = []
  let offset = 0
  for (const member of members) {
    offsets.push(offset)
    writeLocalHeader(out, member, stamp.time, stamp.date)
    offset += 30 + member.name.byteLength + member.data.byteLength
  }

  const directoryStart = offset
  members.forEach((member, index) => {
    const isDir = member.name.toString('utf8').endsWith('/')
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014B50, 0)
    header.writeUInt16LE(0x031E, 4) // version made by: 3.0 / Unix
    header.writeUInt16LE(20, 6) // version needed: 2.0
    header.writeUInt16LE(0x0800, 8) // general purpose: UTF-8 names (bit 11)
    header.writeUInt16LE(member.method, 10)
    header.writeUInt16LE(stamp.time, 12)
    header.writeUInt16LE(stamp.date, 14)
    header.writeUInt32LE(member.crc, 16)
    header.writeUInt32LE(member.data.byteLength, 20)
    header.writeUInt32LE(member.size, 24)
    header.writeUInt16LE(member.name.byteLength, 28)
    header.writeUInt16LE(0, 30) // extra length
    header.writeUInt16LE(0, 32) // comment length
    header.writeUInt16LE(0, 34) // disk number
    header.writeUInt16LE(0, 36) // internal attributes
    // "version made by" says Unix, so the high word is the Unix mode and the
    // low word carries the MS-DOS attributes. Both halves matter: without the
    // mode, Info-ZIP extracts every file as mode 000 (unreadable). The mode is
    // scaled with `* 0x10000` rather than `<< 16`: the shift is a signed int32
    // operation and `0o100644 << 16` is negative, which writeUInt32LE rejects.
    const mode = isDir ? 0o40755 : 0o100644
    header.writeUInt32LE(mode * 0x10000 + (isDir ? 0x10 : 0), 38)
    header.writeUInt32LE(offsets[index]!, 42)
    out.push(header, member.name)
    offset += 46 + member.name.byteLength
  })

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054B50, 0)
  eocd.writeUInt16LE(0, 4) // this disk
  eocd.writeUInt16LE(0, 6) // disk with the central directory
  eocd.writeUInt16LE(members.length, 8)
  eocd.writeUInt16LE(members.length, 10)
  eocd.writeUInt32LE(offset - directoryStart, 12)
  eocd.writeUInt32LE(directoryStart, 16)
  eocd.writeUInt16LE(0, 20) // comment length
  out.push(eocd)
  return Buffer.concat(out)
}
