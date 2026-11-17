/**
 * The long-line guard (#1165): a document that CodeMirror cannot hold — one
 * line of hundreds of KB — must be classified non-editable BEFORE any edit
 * buffer is built, even when its byte size is far below
 * `MAX_EDITABLE_BYTES`. The host calls this predicate on the already-decoded
 * read (src/index.ts) and answers `too-large` with reason `line`, so the
 * client never scans the document and never mounts CodeMirror for it.
 *
 * The probe is deliberately BOUNDED to the document head: the reported files
 * are minified single-line artifacts whose long line starts at byte zero, and
 * the host must not walk a whole 5 MB document to answer.
 */
import { describe, expect, it } from 'vitest'
import { hasOverlongLine, LINE_PROBE_CHARS, MAX_EDITABLE_LINE_CHARS } from '../src/editor-limits.ts'

describe('hasOverlongLine', () => {
  it('classifies a document whose single line exceeds the limit as non-editable (#1165)', () => {
    // The reported shape: a 327 KB minified HTML file, one line, no newline.
    expect(hasOverlongLine('x'.repeat(327 * 1024))).toBe(true)
  })

  it('accepts a normal multi-line document', () => {
    const text = 'const value = 1\n'.repeat(2_000)
    // Long by BYTES, ordinary by lines: the guard must not flag it.
    expect(text.length).toBeGreaterThan(MAX_EDITABLE_LINE_CHARS)
    expect(hasOverlongLine(text)).toBe(false)
  })

  it('measures the longest line, not the document', () => {
    const justUnder = 'a\n' + 'x'.repeat(MAX_EDITABLE_LINE_CHARS - 1) + '\n'
    expect(hasOverlongLine(justUnder)).toBe(false)
    const atLimit = 'a\n' + 'x'.repeat(MAX_EDITABLE_LINE_CHARS) + '\n'
    expect(hasOverlongLine(atLimit)).toBe(true)
  })

  it('treats CRLF as one line separator', () => {
    const text = 'x'.repeat(MAX_EDITABLE_LINE_CHARS + 1) + '\r\nnext\r\n'
    expect(hasOverlongLine(text)).toBe(true)
  })

  it('keeps the probe bounded to the document head', () => {
    // Ordinary short lines fill the probe window, so a later over-limit line
    // is outside what the host inspects — the documented bound.
    const head = 'ok\n'.repeat(Math.ceil(LINE_PROBE_CHARS / 3))
    expect(head.length).toBeGreaterThanOrEqual(LINE_PROBE_CHARS)
    expect(hasOverlongLine(head + 'x'.repeat(MAX_EDITABLE_LINE_CHARS + 1))).toBe(false)
  })

  it('treats an empty document as editable', () => {
    expect(hasOverlongLine('')).toBe(false)
  })
})
