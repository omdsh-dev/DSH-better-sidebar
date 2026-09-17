import { describe, it, expect } from 'vitest'
import { collectTaskMarkers, flipPreviewTask } from '../src/client/task-toggle.ts'
import { markdownPreviewSource } from '../src/client/markdown-frontmatter.ts'

describe('collectTaskMarkers', () => {
  it('finds bullet task items', () => {
    const markers = collectTaskMarkers('- [ ] one\n- [x] two\n- [X] three')
    expect(markers).toMatchObject([
      { lineIndex: 0, checked: false },
      { lineIndex: 1, checked: true },
      { lineIndex: 2, checked: true },
    ])
  })

  it('finds asterisk and plus bullets', () => {
    const markers = collectTaskMarkers('* [ ] a\n+ [x] b')
    expect(markers).toHaveLength(2)
    expect(markers[0].checked).toBe(false)
    expect(markers[1].checked).toBe(true)
  })

  it('finds ordered list tasks', () => {
    const markers = collectTaskMarkers('1. [ ] first\n2. [x] second')
    expect(markers).toHaveLength(2)
  })

  it('finds blockquote tasks', () => {
    const markers = collectTaskMarkers('> - [ ] in blockquote\nnormal text\n> - [x] done')
    expect(markers).toMatchObject([
      { lineIndex: 0, checked: false },
      { lineIndex: 2, checked: true },
    ])
  })

  it('skips task markers inside fenced code', () => {
    const markers = collectTaskMarkers('```\n- [ ] inside code\n```\n- [ ] outside')
    expect(markers).toMatchObject([{ lineIndex: 3, checked: false }])
  })

  it('handles fenced code with tilde', () => {
    const markers = collectTaskMarkers('~~~\n- [x] in tilde fence\n~~~\n- [ ] after')
    expect(markers).toMatchObject([{ lineIndex: 3, checked: false }])
  })

  it('ignores task markers inside a fenced block', () => {
    const markers = collectTaskMarkers('- [ ] visible\n```\n- [ ] hidden\n- [x] also hidden\n```\n- [ ] visible too')
    expect(markers).toMatchObject([
      { lineIndex: 0, checked: false },
      { lineIndex: 5, checked: false },
    ])
  })

  it('handles checkbox with trailing content', () => {
    const markers = collectTaskMarkers('- [x] buy milk\n- [ ] call home')
    expect(markers[0].checked).toBe(true)
    expect(markers[1].checked).toBe(false)
  })

  it('handles CRLF line endings', () => {
    const markers = collectTaskMarkers('- [ ] one\r\n- [x] two\r\n')
    expect(markers).toMatchObject([
      { lineIndex: 0, checked: false },
      { lineIndex: 1, checked: true },
    ])
  })
})

describe('flipPreviewTask', () => {
  it('unchecks a checked item', () => {
    const full = '- [x] done'
    const preview = markdownPreviewSource(full)
    const result = flipPreviewTask(full, preview, 0)
    expect(result.ok).toBe(true)
    expect(result.newLine).toBe('- [ ] done')
  })

  it('checks an unchecked item', () => {
    const full = '- [ ] todo'
    const preview = markdownPreviewSource(full)
    const result = flipPreviewTask(full, preview, 0)
    expect(result.ok).toBe(true)
    expect(result.newLine).toBe('- [x] todo')
  })

  it('respects frontmatter removal when mapping', () => {
    const full = '---\ntitle: x\n---\n- [ ] after fm'
    const preview = markdownPreviewSource(full)
    expect(preview).toBe('- [ ] after fm')
    const result = flipPreviewTask(full, preview, 0)
    expect(result.ok).toBe(true)
    // The task line is line index 3 in fullText (0-based).
    expect(result.fullLineIndex).toBe(3)
    expect(result.newLine).toBe('- [x] after fm')
  })

  it('does not flip past end of list', () => {
    const full = '- [ ] only one'
    const preview = markdownPreviewSource(full)
    const result = flipPreviewTask(full, preview, 5)
    expect(result.ok).toBe(false)
  })

  it('respects X uppercase as checked', () => {
    const full = '- [X] done'
    const preview = markdownPreviewSource(full)
    const result = flipPreviewTask(full, preview, 0)
    expect(result.ok).toBe(true)
    expect(result.newLine).toBe('- [ ] done')
  })

  it('handles CRLF frontmatter', () => {
    const full = '---\r\ntitle: x\r\n---\r\n- [ ] after\r\n'
    const preview = markdownPreviewSource(full)
    expect(preview).toBe('- [ ] after\r\n')
    const result = flipPreviewTask(full, preview, 0)
    expect(result.ok).toBe(true)
    expect(result.newLine).toBe('- [x] after\r')
    // Reconstructing the full document keeps the CRLF line endings.
    const fullLines = full.split('\n')
    fullLines[result.fullLineIndex] = result.newLine
    expect(fullLines.join('\n')).toBe('---\r\ntitle: x\r\n---\r\n- [x] after\r\n')
  })

  it('maps Nth task across multiple tasks correctly', () => {
    const full = '- [ ] first\n- [ ] second\n- [ ] third'
    const preview = markdownPreviewSource(full)
    const markers = collectTaskMarkers(preview)
    expect(markers).toHaveLength(3)
    // Flip the second task
    const result = flipPreviewTask(full, preview, 1)
    expect(result.ok).toBe(true)
    expect(result.newLine).toBe('- [x] second')
  })

  it('works with nested bullet list', () => {
    const full = '- [ ] outer\n  - [x] inner'
    const preview = markdownPreviewSource(full)
    // Both are task items
    expect(collectTaskMarkers(preview)).toHaveLength(2)
    // Flip inner
    const result = flipPreviewTask(full, preview, 1)
    expect(result.ok).toBe(true)
    expect(result.newLine).toBe('  - [ ] inner')
  })
})
