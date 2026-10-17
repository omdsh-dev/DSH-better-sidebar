/**
 * S7 ZIP codec contract (the only archive layer `.cluepack` uses).
 *
 * The package must round-trip text and arbitrary binary bytes, preserve
 * non-ASCII and long names, and — most importantly — refuse every archive
 * that a normal file import must not accept: absolute/traversing names,
 * duplicate entries, escaping symlinks, encrypted entries, unsupported
 * methods, CRC mismatches, truncation and resource limits. Limits are checked
 * BEFORE inflating, so a tiny compressed bomb cannot expand into memory.
 *
 * ZIPs are produced by {@link createZip} (node:zlib only, no system `zip`) and
 * the malicious fixtures are built by mutating those bytes, which is what an
 * attacker would actually hand us.
 */
import { describe, expect, it } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import {
  createZip,
  crc32,
  DEFAULT_ZIP_LIMITS,
  readZip,
  type ZipEntryInput,
} from '../src/clues/share/zip.ts'
import { ClueError } from '../src/clues/types.ts'

/** A byte pattern with every byte value, so a codec cannot sneak in UTF-8. */
function binaryFixture(length = 4096): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) bytes[index] = index % 256
  return bytes
}

/** One archive with a text entry (deflated) and a binary entry (stored). */
function sampleArchive(): Buffer {
  return createZip([
    { name: 'manifest.json', data: new TextEncoder().encode('{"hello":true}\n'), compress: true },
    { name: 'content/blob.bin', data: binaryFixture(), compress: false },
  ], { modifiedAt: new Date('2026-10-17T00:00:00.000Z') })
}

/** Replace one ASCII name everywhere it appears (local header + central dir). */
function renameEntry(zip: Buffer, from: string, to: string): Buffer {
  const source = Buffer.from(from, 'utf8')
  const target = Buffer.from(to, 'utf8')
  if (source.length !== target.length) throw new Error('renameEntry needs equal byte lengths')
  const copy = Buffer.from(zip)
  let offset = copy.indexOf(source)
  if (offset === -1) throw new Error(`entry name "${from}" not found`)
  while (offset !== -1) {
    target.copy(copy, offset)
    offset = copy.indexOf(source, offset + target.length)
  }
  return copy
}

/** Offset of the first central-directory header. */
function centralOffset(zip: Buffer): number {
  const offset = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  if (offset === -1) throw new Error('central directory not found')
  return offset
}

/** Offset of the end-of-central-directory record. */
function eocdOffset(zip: Buffer): number {
  const offset = zip.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (offset === -1) throw new Error('EOCD not found')
  return offset
}

/** Mark the first central-directory entry as a unix symlink. */
function markSymlink(zip: Buffer): Buffer {
  return markMode(zip, 0o120777)
}

/** Set the first entry's unix mode in the central directory. */
function markMode(zip: Buffer, mode: number): Buffer {
  const copy = Buffer.from(zip)
  const offset = centralOffset(copy)
  copy.writeUInt32LE(((mode << 16) >>> 0), offset + 38)
  return copy
}

/** Set one flag bit on the first central + local header. */
function setFlags(zip: Buffer, bit: number): Buffer {
  const copy = Buffer.from(zip)
  const central = centralOffset(copy)
  copy.writeUInt16LE(copy.readUInt16LE(central + 8) | bit, central + 8)
  const local = copy.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  copy.writeUInt16LE(copy.readUInt16LE(local + 6) | bit, local + 6)
  return copy
}

/** Set the first entry's compression method in both headers. */
function setMethod(zip: Buffer, method: number): Buffer {
  const copy = Buffer.from(zip)
  const central = centralOffset(copy)
  copy.writeUInt16LE(method, central + 10)
  const local = copy.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  copy.writeUInt16LE(method, local + 8)
  return copy
}

/** Corrupt the first entry's recorded CRC (central directory). */
function corruptCrc(zip: Buffer): Buffer {
  const copy = Buffer.from(zip)
  const central = centralOffset(copy)
  copy.writeUInt32LE((copy.readUInt32LE(central + 16) ^ 0xffff_ffff) >>> 0, central + 16)
  return copy
}

/** Corrupt the first entry's compressed bytes (after the local header name). */
function corruptPayload(zip: Buffer): Buffer {
  const copy = Buffer.from(zip)
  const local = copy.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  const nameLength = copy.readUInt16LE(local + 26)
  const extraLength = copy.readUInt16LE(local + 28)
  const dataOffset = local + 30 + nameLength + extraLength
  copy[dataOffset] = copy[dataOffset]! ^ 0xff
  return copy
}

describe('CRC32', () => {
  it('matches the canonical check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf4_3926)
    expect(crc32(new Uint8Array())).toBe(0)
  })
})

describe('createZip / readZip round-trip', () => {
  it('keeps text, binary bytes, stored/deflated entries and names', () => {
    const zip = sampleArchive()
    const entries = readZip(zip)
    expect(entries.map(entry => entry.name)).toEqual(['manifest.json', 'content/blob.bin'])
    expect(new TextDecoder().decode(entries[0]!.data)).toBe('{"hello":true}\n')
    expect(entries[1]!.data).toEqual(binaryFixture())
  })

  it('uses the deflate method only when it is requested (and smaller)', () => {
    const zip = createZip([
      { name: 'plain.txt', data: new TextEncoder().encode('x'.repeat(1000)), compress: true },
      { name: 'stored.txt', data: new TextEncoder().encode('y'.repeat(1000)), compress: false },
    ])
    const central = centralOffset(zip)
    expect(zip.readUInt16LE(central + 10)).toBe(8)
    const secondCentral = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), central + 4)
    expect(zip.readUInt16LE(secondCentral + 10)).toBe(0)
    expect(readZip(zip).map(entry => new TextDecoder().decode(entry.data))).toHaveLength(2)
  })

  it('round-trips non-ASCII and long entry names', () => {
    const longName = `content/${'a'.repeat(200)}.json`
    const zip = createZip([
      { name: 'content/中文名称.json', data: new TextEncoder().encode('{"t":"中文"}') },
      { name: longName, data: new TextEncoder().encode('{}') },
    ])
    expect(readZip(zip).map(entry => entry.name)).toEqual(['content/中文名称.json', longName])
  })

  it('round-trips an empty archive', () => {
    expect(readZip(createZip([]))).toEqual([])
  })

  it('skips explicit directory entries', () => {
    const zip = createZip([
      { name: 'content/', data: new Uint8Array() },
      { name: 'content/a.txt', data: new TextEncoder().encode('a') },
    ])
    expect(readZip(zip).map(entry => entry.name)).toEqual(['content/a.txt'])
  })

  it('refuses to write unsafe or duplicate names', () => {
    for (const name of ['/abs.txt', '../up.txt', 'a/../b.txt', 'C:\\win.txt', 'a\\b.txt', '']) {
      expect(() => createZip([{ name, data: new Uint8Array() }]), name)
        .toThrowError(ClueError)
    }
    expect(() => createZip([
      { name: 'a.txt', data: new Uint8Array() },
      { name: 'a.txt', data: new Uint8Array() },
    ])).toThrowError(/duplicate/i)
  })
})

describe('readZip security boundary', () => {
  it('rejects a traversing entry name', () => {
    const zip = renameEntry(sampleArchive(), 'manifest.json', '../manifest.j')
    expect(() => readZip(zip)).toThrowError(/unsafe archive entry name/i)
  })

  it('rejects an absolute entry name', () => {
    // 'manifest.json' (13) -> '/manifest.jsn' (13).
    const zip = renameEntry(sampleArchive(), 'manifest.json', '/manifest.jsn')
    expect(() => readZip(zip)).toThrowError(/unsafe archive entry name/i)
  })

  it('rejects duplicate entry names', () => {
    const zip = createZip([
      { name: 'zaqx', data: new TextEncoder().encode('1') },
      { name: 'bbbb', data: new TextEncoder().encode('2') },
    ])
    const duplicated = renameEntry(zip, 'bbbb', 'zaqx')
    expect(() => readZip(duplicated)).toThrowError(/duplicate archive entry/i)
  })

  it('rejects a symlink entry', () => {
    expect(() => readZip(markSymlink(sampleArchive()))).toThrowError(/symbolic link/i)
  })

  it('rejects FIFO and other non-regular unix modes', () => {
    expect(() => readZip(markMode(sampleArchive(), 0o010777))).toThrowError(/not a regular file/i)
    expect(() => readZip(markMode(sampleArchive(), 0o140777))).toThrowError(/not a regular file/i)
  })

  it('rejects encrypted entries', () => {
    expect(() => readZip(setFlags(sampleArchive(), 0x1))).toThrowError(/encrypted/i)
  })

  it('rejects unsupported compression methods', () => {
    expect(() => readZip(setMethod(sampleArchive(), 12))).toThrowError(/compression method/i)
  })

  it('rejects a CRC mismatch', () => {
    expect(() => readZip(corruptCrc(sampleArchive()))).toThrowError(/checksum/i)
  })

  it('rejects corrupted payload bytes', () => {
    expect(() => readZip(corruptPayload(sampleArchive()))).toThrowError(ClueError)
  })

  it('rejects truncated and non-ZIP input', () => {
    const zip = sampleArchive()
    expect(() => readZip(zip.subarray(0, zip.length - 10))).toThrowError(/not a zip archive/i)
    expect(() => readZip(new Uint8Array([1, 2, 3]))).toThrowError(/not a zip archive/i)
  })

  it('rejects a ZIP64 marker instead of guessing', () => {
    const zip = Buffer.from(sampleArchive())
    zip.writeUInt16LE(0xffff, eocdOffset(zip) + 10)
    expect(() => readZip(zip)).toThrowError(/ZIP64/i)
  })

  it('rejects multi-disk archives', () => {
    const zip = Buffer.from(sampleArchive())
    zip.writeUInt16LE(1, eocdOffset(zip) + 4)
    expect(() => readZip(zip)).toThrowError(/multi-disk|not a zip archive/i)
  })

  it('enforces the entry-count limit before reading entries', () => {
    expect(() => readZip(sampleArchive(), { maxEntries: 1 })).toThrowError(/entry limit/i)
  })

  it('enforces the per-entry and total uncompressed limits', () => {
    expect(() => readZip(sampleArchive(), { maxEntryBytes: 100 })).toThrowError(/size limit/i)
    expect(() => readZip(sampleArchive(), { maxTotalBytes: 100 })).toThrowError(/size limit/i)
  })

  it('enforces the archive byte limit', () => {
    const zip = sampleArchive()
    expect(() => readZip(zip, { maxArchiveBytes: zip.length - 1 })).toThrowError(/too large/i)
  })

  it('checks the announced size before inflating a deflate bomb', () => {
    // The compressed bytes are tiny; the announced uncompressed size is what
    // trips the limit first. A lying header is caught by the post-inflate
    // length check / maxOutputLength guard.
    const bomb = createZip([{ name: 'bomb.bin', data: new Uint8Array(2 * 1024 * 1024), compress: true }])
    expect(bomb.length).toBeLessThan(10_000)
    expect(() => readZip(bomb, { maxEntryBytes: 1024 })).toThrowError(/size limit/i)
  })

  it('exposes conservative defaults', () => {
    expect(DEFAULT_ZIP_LIMITS.maxEntries).toBeGreaterThan(0)
    expect(DEFAULT_ZIP_LIMITS.maxEntryBytes).toBeGreaterThan(0)
    expect(DEFAULT_ZIP_LIMITS.maxTotalBytes).toBeGreaterThanOrEqual(DEFAULT_ZIP_LIMITS.maxEntryBytes)
    expect(DEFAULT_ZIP_LIMITS.maxArchiveBytes).toBeGreaterThan(0)
  })
})

describe('createZip input guard', () => {
  it('accepts every safe relative path shape used by a pack', () => {
    const entries: ZipEntryInput[] = [
      { name: 'manifest.json', data: new TextEncoder().encode('{}') },
      { name: 'content/clue-1.json', data: new TextEncoder().encode('{}') },
      { name: 'content/sub.dir/文件.bin', data: deflateRawSync(new Uint8Array([1, 2, 3])) },
    ]
    expect(readZip(createZip(entries)).map(entry => entry.name)).toHaveLength(3)
  })
})

describe('createZip limits (writer/reader parity)', () => {
  /** One tiny JSON-shaped entry. */
  function tinyEntry(name: string): ZipEntryInput {
    return { name, data: new TextEncoder().encode('{}'), compress: false }
  }

  it('writes 4,097 entries with the shared defaults and reads them back', () => {
    // The old defaults (4,096 entries) let the exporter build an archive its
    // own importer rejected; 4,097 is exactly the first size that used to break.
    const entries = Array.from({ length: 4_097 }, (_, index) => tinyEntry(`content/item-${index}.json`))
    const zip = createZip(entries)
    expect(readZip(zip)).toHaveLength(4_097)
    expect(DEFAULT_ZIP_LIMITS.maxEntries).toBeGreaterThanOrEqual(10_001)
  })

  it('refuses to write beyond the entry/per-entry/total/archive limits', () => {
    expect(() => createZip([tinyEntry('a.json'), tinyEntry('b.json')], { limits: { maxEntries: 1 } }))
      .toThrowError(/entry limit/i)
    expect(() => createZip([{ name: 'a.json', data: new Uint8Array(64) }], { limits: { maxEntryBytes: 8 } }))
      .toThrowError(/size limit/i)
    expect(() => createZip([
      { name: 'a.json', data: new Uint8Array(64) },
      { name: 'b.json', data: new Uint8Array(64) },
    ], { limits: { maxTotalBytes: 100 } })).toThrowError(/expanded size limit/i)
    expect(() => createZip([{ name: 'a.json', data: new Uint8Array(64) }], { limits: { maxArchiveBytes: 20 } }))
      .toThrowError(/size limit/i)
  })

  it('applies the shared name-byte bound on the writer side too', () => {
    expect(() => createZip([tinyEntry('x'.repeat(200))], { limits: { maxNameBytes: 16 } }))
      .toThrowError(/exceeds 16 bytes/i)
    // A limit wider than the 16-bit ZIP field must be refused explicitly
    // instead of surfacing a raw RangeError from writeUInt16LE.
    expect(() => createZip([tinyEntry('a.json')], { limits: { maxNameBytes: 70_000 } }))
      .toThrowError(/maxNameBytes/i)
  })

  it('refuses canonically equivalent entry names', () => {
    expect(() => createZip([
      { name: 'café.txt', data: new TextEncoder().encode('a') },
      { name: 'cafe\u0301.txt', data: new TextEncoder().encode('b') },
    ])).toThrowError(/duplicate archive entry/i)
  })
})
