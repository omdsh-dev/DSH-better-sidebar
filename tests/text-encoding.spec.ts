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
