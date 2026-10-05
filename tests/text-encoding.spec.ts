import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  decodeTextBytes,
  encodeText,
  encodingOfFile,
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
    await expect(encodingOfFile(path)).resolves.toBe('utf8')
  })

  it('detects the on-disk encoding used for the next save', async () => {
    const path = join(root, 'legacy.cmd')
    writeFileSync(path, encodeText('@echo off\r\necho 中文\r\n', 'gbk'))
    await expect(encodingOfFile(path)).resolves.toBe('gbk')
  })

  it('defaults new files to UTF-8', async () => {
    await expect(encodingOfFile(join(root, 'missing.txt'))).resolves.toBe('utf8')
  })

  it('refuses silently lossy GBK writes', () => {
    expect(() => encodeText('中文😀', 'gbk')).toThrow(/GBK/)
  })
})
