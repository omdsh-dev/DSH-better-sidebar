import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  decodeTextBytes,
  detectEol,
  encodeText,
  fileFormatOf,
  restoreEol,
  type TextEncoding,
} from '../src/text-encoding.ts'

const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-encoding-'))

const ROUND_TRIPS: [TextEncoding, string][] = [
  ['utf8', '中文 test'],
  ['utf8-bom', '中文 test'],
  ['utf16le-bom', '中文 test'],
  ['utf16be-bom', '中文 test'],
  ['utf32le-bom', '中文 😀'],
  ['utf32be-bom', '中文 😀'],
  ['gbk', '中文测试 €'],
  ['gb18030', '中文 😀 𠀀'],
]

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('text encoding', () => {
  it.each(ROUND_TRIPS)('round-trips %s', (encoding, text) => {
    const decoded = decodeTextBytes(encodeText(text, encoding))
    expect(decoded).toEqual({ content: text, encoding })
  })

  it('detects BOM-less UTF-16 script text, including an odd truncated read', () => {
    const text = '@echo off\r\necho 中文测试\r\n'
    const little = Buffer.from(text, 'utf16le')
    expect(decodeTextBytes(little)).toEqual({ content: text, encoding: 'utf16le' })
    expect(decodeTextBytes(little.subarray(0, little.length - 1))?.encoding).toBe('utf16le')

    const big = Buffer.from(little)
    big.swap16()
    expect(decodeTextBytes(big)).toEqual({ content: text, encoding: 'utf16be' })
    expect(decodeTextBytes(big.subarray(0, big.length - 1))?.encoding).toBe('utf16be')
  })

  it('keeps NUL-heavy non-Unicode data binary', () => {
    expect(decodeTextBytes(Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02, 0x03]))).toBeNull()
  })

  it('keeps 16-bit little-endian data binary instead of reading it as UTF-16 text', () => {
    // A raw uint16 table leaves the high byte 0 for every value below 256 —
    // exactly the NUL lane BOM-less UTF-16 has — but its code units are C0/C1
    // control runs, not text. Read as text it opened a binary file in the
    // editor, and a save rewrote it as UTF-16 (an odd length also lost its
    // trailing byte).
    const samples = Buffer.alloc(4096)
    for (let index = 0; index < 2048; index += 1) samples.writeUInt16LE(100 + (index % 100), index * 2)
    expect(decodeTextBytes(samples)).toBeNull()
    expect(decodeTextBytes(Buffer.concat([samples, Buffer.from([0x7f])]))).toBeNull()
    expect(decodeTextBytes(Buffer.concat([Buffer.from('RIFF....WAVEfmt data'), samples.subarray(0, 4000)]))).toBeNull()
    // The same NUL lane spelled as text still reads as UTF-16: the lane vote
    // alone must not decide.
    expect(decodeTextBytes(Buffer.from('echo off\n', 'utf16le')))
      .toEqual({ content: 'echo off\n', encoding: 'utf16le' })
  })

  it('keeps a capped UTF-8 read UTF-8 when the cap cuts a character', () => {
    // A read cap stops wherever it lands, and the partial tail of a CJK
    // character is exactly what the GBK probe accepts: two of the three bytes
    // decode as one legacy glyph, so a >cap UTF-8 file used to open as
    // mojibake. The cap must not vote on the encoding.
    const cjk = Buffer.from('中文测试内容', 'utf8')
    const cutCjk = cjk.subarray(0, cjk.length - 2)
    expect(decodeTextBytes(cutCjk, true)).toEqual({ content: cutCjk.toString('utf8'), encoding: 'utf8' })
    // Without the truncation flag the same bytes fall through to the legacy
    // probe — that fall-through is what the flag exists to suppress.
    expect(decodeTextBytes(cutCjk)?.encoding).toBe('gbk')

    const emoji = Buffer.from('中文😀', 'utf8')
    const cutEmoji = emoji.subarray(0, emoji.length - 2)
    expect(decodeTextBytes(cutEmoji, true)?.encoding).toBe('utf8')

    // A complete (invalid) sequence at the tail is real evidence about the
    // encoding, so the legacy probe still wins there: 0xC0 0x80 is an
    // overlong UTF-8 pair the GBK decoder accepts.
    expect(decodeTextBytes(Buffer.from([0x41, 0xc0, 0x80]), true)?.encoding).toBe('gbk')
  })

  it('sniffs a > window UTF-8 file whose window boundary cuts a character', async () => {
    const path = join(root, 'big-utf8.txt')
    // The 64 KiB sniff window ends inside a three-byte character; the save
    // side must still recognize the file as UTF-8.
    writeFileSync(path, Buffer.from(`${'a'.repeat(64 * 1024 - 2)}中文`, 'utf8'))
    await expect(fileFormatOf(path)).resolves.toMatchObject({ encoding: 'utf8' })
  })

  it('detects the on-disk encoding used for the next save', async () => {
    const path = join(root, 'legacy.cmd')
    writeFileSync(path, encodeText('@echo off\r\necho 中文\r\n', 'gbk'))
    await expect(fileFormatOf(path)).resolves.toEqual({ encoding: 'gbk', eol: 'crlf' })
  })

  it('defaults new files to UTF-8 + LF', async () => {
    // A file that does not exist yet has no format to preserve. Deriving a
    // project-wide convention is deliberately out of scope (#871): this only
    // pins the default the route writes for a create.
    await expect(fileFormatOf(join(root, 'missing.txt'))).resolves.toEqual({ encoding: 'utf8', eol: 'lf' })
  })

  it('reads a CRLF file as CRLF and an LF file as LF', async () => {
    const crlf = join(root, 'crlf.txt')
    writeFileSync(crlf, 'one\r\ntwo\r\nthree\r\n')
    await expect(fileFormatOf(crlf)).resolves.toEqual({ encoding: 'utf8', eol: 'crlf' })

    const lf = join(root, 'lf.txt')
    writeFileSync(lf, 'one\ntwo\nthree\n')
    await expect(fileFormatOf(lf)).resolves.toEqual({ encoding: 'utf8', eol: 'lf' })
  })

  it('votes on the majority and ignores a lone CR', () => {
    // Same rule (and same 4096-char window) as the host backend's
    // detectLineEndings, so a plugin save and a model `edit` agree.
    expect(detectEol('a\r\nb\r\nc\n')).toBe('crlf')
    expect(detectEol('a\nb\nc\r\n')).toBe('lf')
    // A classic-Mac file is not CRLF and its `\r` bytes are never rewritten.
    expect(detectEol('a\rb\r')).toBe('lf')
    expect(restoreEol('a\rb\r', 'lf')).toBe('a\rb\r')
    // Past the window only the prefix votes.
    expect(detectEol(`${'a\r\n'.repeat(3000)}b\n`)).toBe('crlf')
  })

  it('restores CRLF without doubling an existing pair', () => {
    expect(restoreEol('a\nb\n', 'crlf')).toBe('a\r\nb\r\n')
    // The editor hands us LF, but a caller may pass CRLF through (a paste, a
    // future caller): the naive split/join would emit `\r\r\n` here.
    expect(restoreEol('a\r\nb\r\n', 'crlf')).toBe('a\r\nb\r\n')
    expect(restoreEol('a\r\nb', 'crlf')).toBe('a\r\nb')
  })

  it('refuses silently lossy GBK writes', () => {
    expect(() => encodeText('中文😀', 'gbk')).toThrow(/GBK/)
  })
})
