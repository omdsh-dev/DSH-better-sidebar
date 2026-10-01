/**
 * The unified-diff adapter: git's own hunks (from parseUnifiedDiff) convert
 * into the shared DiffRow segments — rewrite pairing applies inside git
 * hunks exactly like session-op diffs, the unemitted context gaps between
 * hunks become folds carrying their line ranges (expandable on demand via
 * foldRowsFromContents), and the header stats (+n −m) count mods on both
 * sides.
 */
import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff, unifiedSegments, diffLines, pairMods, diffStats, untrackedFile, foldRowsFromContents, decodeGitPath, type FoldSegment } from '../src/client/diff/rows.ts'

const twoHunks = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,4 +1,4 @@',
  ' context',
  '-old line',
  '+new line',
  ' tail',
  '@@ -20,3 +20,4 @@',
  ' far below',
  '-gone',
  '+kept',
  '+added',
  ' tail2',
].join('\n')

describe('unifiedSegments', () => {
  it('converts hunk lines to rows and pairs the rewrite as mod', () => {
    const file = parseUnifiedDiff(twoHunks).files[0]!
    const segments = unifiedSegments(file)
    // hunk, gap fold (lines 4..19 hidden), hunk
    expect(segments.map(s => s.kind)).toEqual(['hunk', 'fold', 'hunk'])
    const first = segments[0]!
    expect(first.kind === 'hunk' && first.rows.map(r => r.kind)).toEqual(['context', 'mod', 'mod', 'context'])
    // The paired rows keep their own side's line number.
    const modOld = first.kind === 'hunk' ? first.rows[1]! : undefined
    const modNew = first.kind === 'hunk' ? first.rows[2]! : undefined
    expect(modOld?.oldLine).toBe(2)
    expect(modOld?.newLine).toBeUndefined()
    expect(modNew?.oldLine).toBeUndefined()
    expect(modNew?.newLine).toBe(2)
  })

  it('emits a non-expandable fold for the unemitted gap between hunks', () => {
    const file = parseUnifiedDiff(twoHunks).files[0]!
    const gap = unifiedSegments(file)[1]!
    expect(gap.kind).toBe('fold')
    if (gap.kind === 'fold') {
      expect(gap.rows).toBeUndefined()
      // First hunk ends at line 3 on both sides, second starts at 20 → gap 16.
      expect(gap.count).toBe(16)
      expect(gap.oldStart).toBe(4)
      expect(gap.oldEnd).toBe(19)
      expect(gap.newStart).toBe(4)
      expect(gap.newEnd).toBe(19)
    }
  })

  it('emits a leading fold when the first hunk starts below line 1', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -10 +10 @@',
      '-old',
      '+new',
    ].join('\n')
    const file = parseUnifiedDiff(diff).files[0]!
    const segments = unifiedSegments(file)
    expect(segments.map(s => s.kind)).toEqual(['fold', 'hunk'])
    const lead = segments[0]!
    if (lead.kind === 'fold') {
      expect(lead.count).toBe(9)
      expect(lead.rows).toBeUndefined()
    }
  })

  it('carries the no-newline marker as a meta row', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
    ].join('\n')
    const file = parseUnifiedDiff(diff).files[0]!
    const rows = unifiedSegments(file).flatMap(s => (s.kind === 'hunk' ? s.rows : []))
    expect(rows.map(r => r.kind)).toEqual(['del', 'meta', 'add'])
    expect(rows[1]).toMatchObject({ kind: 'meta', text: ' No newline at end of file' })
  })

  it('counts header stats with mods on both sides', () => {
    const file = parseUnifiedDiff(twoHunks).files[0]!
    // Hunk 1 pairs 1 del + 1 add (2 mod rows); hunk 2 pairs 1 of its 1 del
    // with 1 of its 2 adds (2 mod rows) leaving 1 pure add: 5 added, 4 deleted.
    expect(diffStats(unifiedSegments(file))).toEqual({ added: 5, deleted: 4 })
    // A full-file addition (untracked fallback) counts every row once.
    const untracked = untrackedFile('new.ts', 'a\nb\n')
    expect(diffStats(unifiedSegments(untracked))).toEqual({ added: 2, deleted: 0 })
  })
})

describe('pairMods', () => {
  it('pairs only the overlapping del/add rows within one run', () => {
    const rows = pairMods([
      { kind: 'context' as const, oldLine: 1, newLine: 1, text: 'x' },
      { kind: 'del' as const, oldLine: 2, text: 'a' },
      { kind: 'del' as const, oldLine: 3, text: 'b' },
      { kind: 'add' as const, newLine: 2, text: 'B' },
      { kind: 'add' as const, newLine: 3, text: 'c' },
      { kind: 'add' as const, newLine: 4, text: 'd' },
    ])
    expect(rows.map(r => r.kind)).toEqual(['context', 'mod', 'mod', 'mod', 'mod', 'add'])
  })

  it('matches diffLines output (the LCS walk pairs rewrites the same way)', () => {
    const rows = diffLines('hello world', 'hello dsh')
    expect(rows.map(r => r.kind)).toEqual(['mod', 'mod'])
  })
})

describe('foldRowsFromContents', () => {
  it('slices an aligned gap into context rows carrying both line numbers', () => {
    const fold: FoldSegment = { kind: 'fold', count: 4, oldStart: 4, oldEnd: 7, newStart: 6, newEnd: 9 }
    const rows = foldRowsFromContents(fold, 'a\nb\nc\nd\ne\nf\ng\nh\n', 'A\nB\nC\nD\nE\nF\nG\nH\nI\n')
    expect(rows).toEqual([
      { kind: 'context', oldLine: 4, newLine: 6, text: 'd' },
      { kind: 'context', oldLine: 5, newLine: 7, text: 'e' },
      { kind: 'context', oldLine: 6, newLine: 8, text: 'f' },
      { kind: 'context', oldLine: 7, newLine: 9, text: 'g' },
    ])
  })

  it('keeps the old-side number alone when the new range cannot map (pure deletion gap)', () => {
    const fold: FoldSegment = { kind: 'fold', count: 2, oldStart: 3, oldEnd: 4, newStart: 3, newEnd: 2 }
    const rows = foldRowsFromContents(fold, 'a\nb\nc\nd\n', 'a\nb\n')
    expect(rows).toEqual([
      { kind: 'context', oldLine: 3, text: 'c' },
      { kind: 'context', oldLine: 4, text: 'd' },
    ])
  })

  it('emits pure additions for new lines the old range never reached (pure addition gap)', () => {
    const fold: FoldSegment = { kind: 'fold', count: 3, oldStart: 3, oldEnd: 2, newStart: 3, newEnd: 5 }
    const rows = foldRowsFromContents(fold, 'a\nb\n', 'a\nb\nc\nd\ne\n')
    expect(rows).toEqual([
      { kind: 'add', newLine: 3, text: 'c' },
      { kind: 'add', newLine: 4, text: 'd' },
      { kind: 'add', newLine: 5, text: 'e' },
    ])
  })

  it('keeps \\r endings verbatim like git context lines', () => {
    const fold: FoldSegment = { kind: 'fold', count: 2, oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 2 }
    const rows = foldRowsFromContents(fold, 'a\r\nb\r\n', 'a\r\nb\r\n')
    expect(rows.map(r => r.text)).toEqual(['a\r', 'b\r'])
  })

  it('returns no rows for empty contents', () => {
    const fold: FoldSegment = { kind: 'fold', count: 5, oldStart: 1, oldEnd: 5, newStart: 1, newEnd: 5 }
    expect(foldRowsFromContents(fold, '', '')).toEqual([])
  })

  it('clips line numbers to the actual content (no-newline overrun)', () => {
    // A file without a trailing newline: the fold's ranges can overrun the
    // actual line count by one; the slice stops at the real last line.
    const fold: FoldSegment = { kind: 'fold', count: 3, oldStart: 2, oldEnd: 4, newStart: 2, newEnd: 4 }
    const rows = foldRowsFromContents(fold, 'a\nb\nc', 'a\nb\nc')
    expect(rows).toEqual([
      { kind: 'context', oldLine: 2, newLine: 2, text: 'b' },
      { kind: 'context', oldLine: 3, newLine: 3, text: 'c' },
    ])
  })
})

/**
 * Path recovery for the sections git emits WITHOUT `---`/`+++`: a binary
 * file, a pure rename and a mode-only change all reach the renderer as a
 * header whose path has to come from somewhere else — otherwise the row is a
 * badge with no file name, and the neighbouring rows' names make it look like
 * the badge is theirs.
 */
describe('parseUnifiedDiff paths', () => {
  const first = (lines: readonly string[]): { oldPath: string; newPath: string; binary: boolean; hunks: number } => {
    const file = parseUnifiedDiff(lines.join('\n')).files[0]!
    return { oldPath: file.oldPath, newPath: file.newPath, binary: file.binary, hunks: file.hunks.length }
  }

  it('names a new binary file from its own Binary files line', () => {
    expect(first([
      'diff --git a/docs/20_D2_Tree_current.jpg b/docs/20_D2_Tree_current.jpg',
      'new file mode 100644',
      'index 0000000..1234567',
      'Binary files /dev/null and b/docs/20_D2_Tree_current.jpg differ',
    ])).toEqual({
      oldPath: '/dev/null',
      newPath: 'b/docs/20_D2_Tree_current.jpg',
      binary: true,
      hunks: 0,
    })
  })

  it('names a modified binary file on both sides', () => {
    expect(first([
      'diff --git a/docs/20.jpg b/docs/20.jpg',
      'index 1234567..89abcde 100644',
      'Binary files a/docs/20.jpg and b/docs/20.jpg differ',
    ])).toEqual({ oldPath: 'a/docs/20.jpg', newPath: 'b/docs/20.jpg', binary: true, hunks: 0 })
  })

  it('keeps a spaced binary path whole (the ` and `/` b/` split stays honest)', () => {
    expect(first([
      'diff --git a/docs/img one.png b/docs/img one.png',
      'index 1234567..89abcde 100644',
      'Binary files a/docs/img one.png and b/docs/img one.png differ',
    ])).toEqual({ oldPath: 'a/docs/img one.png', newPath: 'b/docs/img one.png', binary: true, hunks: 0 })
  })

  it('decodes a C-quoted binary header from a default-quotePath git', () => {
    expect(first([
      'diff --git "a/docs/\\344\\270\\255.jpg" "b/docs/\\344\\270\\255.jpg"',
      'index 1234567..89abcde 100644',
      'Binary files "a/docs/\\344\\270\\255.jpg" and "b/docs/\\344\\270\\255.jpg" differ',
    ])).toEqual({ oldPath: 'a/docs/中.jpg', newPath: 'b/docs/中.jpg', binary: true, hunks: 0 })
  })

  it('names a pure rename from its rename lines', () => {
    expect(first([
      'diff --git a/old/name.md b/new/name.md',
      'similarity index 100%',
      'rename from old/name.md',
      'rename to new/name.md',
    ])).toEqual({ oldPath: 'old/name.md', newPath: 'new/name.md', binary: false, hunks: 0 })
  })

  it('names a mode-only change (no ---/+++ either)', () => {
    expect(first([
      'diff --git a/tools/run.sh b/tools/run.sh',
      'old mode 100644',
      'new mode 100755',
    ])).toEqual({ oldPath: 'a/tools/run.sh', newPath: 'b/tools/run.sh', binary: false, hunks: 0 })
  })

  it('names a mode-only change whose path contains a space', () => {
    expect(first([
      'diff --git a/tools/run me.sh b/tools/run me.sh',
      'old mode 100644',
      'new mode 100755',
    ])).toEqual({ oldPath: 'a/tools/run me.sh', newPath: 'b/tools/run me.sh', binary: false, hunks: 0 })
  })

  it('strips the TAB git appends to a spaced ---/+++ path', () => {
    expect(first([
      'diff --git a/docs/sp ace.md b/docs/sp ace.md',
      '--- a/docs/sp ace.md\t',
      '+++ b/docs/sp ace.md\t',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ])).toEqual({ oldPath: 'a/docs/sp ace.md', newPath: 'b/docs/sp ace.md', binary: false, hunks: 1 })
  })

  it('lets ---/+++ win over the fallbacks (rename plus content change)', () => {
    expect(first([
      'diff --git a/old.md b/new.md',
      'similarity index 90%',
      'rename from old.md',
      'rename to new.md',
      '--- a/old.md',
      '+++ b/new.md',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ])).toEqual({ oldPath: 'a/old.md', newPath: 'b/new.md', binary: false, hunks: 1 })
  })
})

describe('decodeGitPath', () => {
  it('decodes git octal escapes as UTF-8 bytes', () => {
    expect(decodeGitPath('"b/docs/\\346\\226\\207.md"')).toBe('b/docs/文.md')
  })

  it('decodes the single-character escapes', () => {
    expect(decodeGitPath('"a/tab\\there.md"')).toBe('a/tab\there.md')
    expect(decodeGitPath('"a/quote\\"name.md"')).toBe('a/quote"name.md')
    expect(decodeGitPath('"a/back\\\\slash.md"')).toBe('a/back\\slash.md')
  })

  it('leaves an unquoted path alone', () => {
    expect(decodeGitPath('a/中文 空格.md')).toBe('a/中文 空格.md')
    expect(decodeGitPath('/dev/null')).toBe('/dev/null')
  })

  it('leaves a mismatched quote alone', () => {
    expect(decodeGitPath('"mismatched')).toBe('"mismatched')
  })
})
