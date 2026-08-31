/**
 * Review list derivation. The source-control panel splits a file into staged
 * and unstaged sections; review asks a different question ("what changed, and
 * have I looked at it?") so each path must appear exactly once, with the two
 * porcelain letters collapsed into one state.
 */
import { describe, expect, it } from 'vitest'
import {
  diffStats,
  pendingCount,
  reviewEntries,
  reviewFromStatus,
  reviewStateOf,
  untrackedStats,
} from '../src/client/review-list.ts'

describe('reviewStateOf', () => {
  it('treats a worktree-only change as pending', () => {
    expect(reviewStateOf(' M')).toBe('pending')
    expect(reviewStateOf(' D')).toBe('pending')
  })

  it('treats an untracked file as pending', () => {
    expect(reviewStateOf('??')).toBe('pending')
  })

  it('treats a fully staged change as accepted', () => {
    expect(reviewStateOf('M ')).toBe('accepted')
    expect(reviewStateOf('A ')).toBe('accepted')
  })

  it('treats staged-then-edited as partial', () => {
    // 'MM' means the file was staged and changed again; the new part still
    // needs a look, so it must not read as fully accepted.
    expect(reviewStateOf('MM')).toBe('partial')
    expect(reviewStateOf('AM')).toBe('partial')
  })
})

describe('reviewEntries', () => {
  it('gives each path exactly one row', () => {
    const rows = reviewEntries([
      { path: 'a.ts', xy: 'MM' },
      { path: 'b.ts', xy: ' M' },
    ])
    expect(rows.map((r) => r.path)).toEqual(['a.ts', 'b.ts'])
  })

  it('merges a duplicate path into the busier state', () => {
    // A file reported twice must never collapse to merely 'accepted' — that
    // would hide unreviewed work behind a green row.
    const rows = reviewEntries([
      { path: 'a.ts', xy: 'M ' },
      { path: 'a.ts', xy: ' M' },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.state).toBe('partial')
  })

  it('keeps git order', () => {
    const rows = reviewEntries([
      { path: 'z.ts', xy: ' M' },
      { path: 'a.ts', xy: ' M' },
    ])
    expect(rows.map((r) => r.path)).toEqual(['z.ts', 'a.ts'])
  })

  it('flags untracked files', () => {
    const rows = reviewEntries([{ path: 'new.ts', xy: '??' }])
    expect(rows[0]?.untracked).toBe(true)
    expect(reviewEntries([{ path: 'old.ts', xy: ' M' }])[0]?.untracked).toBe(false)
  })
})

describe('pendingCount', () => {
  it('counts everything not fully accepted', () => {
    const rows = reviewEntries([
      { path: 'a.ts', xy: ' M' },
      { path: 'b.ts', xy: 'M ' },
      { path: 'c.ts', xy: 'MM' },
    ])
    expect(pendingCount(rows)).toBe(2)
  })

  it('is zero when everything is staged', () => {
    expect(pendingCount(reviewEntries([{ path: 'a.ts', xy: 'M ' }]))).toBe(0)
  })
})

describe('reviewFromStatus', () => {
  it('is empty outside a repo', () => {
    expect(reviewFromStatus(null)).toEqual([])
    expect(reviewFromStatus({ isRepo: false, entries: [{ path: 'a', xy: ' M' }] })).toEqual([])
  })

  it('maps a repo snapshot', () => {
    expect(reviewFromStatus({ isRepo: true, entries: [{ path: 'a', xy: ' M' }] })).toHaveLength(1)
  })
})

describe('diffStats', () => {
  const diff = [
    'diff --git a/x.ts b/x.ts',
    'index 1234567..89abcde 100644',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -1,3 +1,4 @@',
    ' keep',
    '-gone',
    '+new one',
    '+new two',
  ].join('\n')

  it('counts added and removed lines', () => {
    expect(diffStats(diff)).toEqual({ added: 2, removed: 1 })
  })

  it('never counts the +++/--- file headers', () => {
    // Those start with the same characters as content lines; counting them
    // would add a phantom +1/-1 to every single file.
    expect(diffStats(diff).added).toBe(2)
    expect(diffStats(diff).removed).toBe(1)
  })

  it('ignores the preamble before the first hunk', () => {
    expect(diffStats('diff --git a/x b/x\nindex abc..def\n--- a/x\n+++ b/x\n')).toEqual({ added: 0, removed: 0 })
  })

  it('sums across several files in one diff', () => {
    const two = `${diff}\ndiff --git a/y.ts b/y.ts\n--- a/y.ts\n+++ b/y.ts\n@@ -1 +1 @@\n-old\n+fresh`
    expect(diffStats(two)).toEqual({ added: 3, removed: 2 })
  })

  it('handles an empty diff', () => {
    expect(diffStats('')).toEqual({ added: 0, removed: 0 })
  })
})

describe('untrackedStats', () => {
  it('counts every line as an addition', () => {
    expect(untrackedStats('a\nb\nc')).toEqual({ added: 3, removed: 0 })
  })

  it('does not count the trailing newline as a line', () => {
    expect(untrackedStats('a\nb\n')).toEqual({ added: 2, removed: 0 })
  })

  it('handles an empty file', () => {
    expect(untrackedStats('')).toEqual({ added: 0, removed: 0 })
  })
})
