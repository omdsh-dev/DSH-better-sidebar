/**
 * The unified-diff adapter: git's own hunks (from parseUnifiedDiff) convert
 * into the shared DiffRow segments — rewrite pairing applies inside git
 * hunks exactly like session-op diffs, the unemitted context gaps between
 * hunks become non-expandable folds carrying their line ranges, and the
 * header stats (+n −m) count mods on both sides.
 */
import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff, unifiedSegments, diffLines, pairMods, diffStats, untrackedFile } from '../src/client/diff/rows.ts'

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
