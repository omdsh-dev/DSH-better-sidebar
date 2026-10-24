/**
 * Line counts in the change tree (#131).
 *
 * The status answer carries each path's added/deleted lines PER SIDE; the tree
 * is built once per band and keeps that band's reading on its leaves, so a row
 * prints its own numbers and a band's header total is the sum of exactly those
 * leaves. Binary rows and rows without counts (untracked files — git diffs
 * nothing for them) contribute NOTHING: the alternative, counting them as 0,
 * would make the header disagree with the numbers printed under it.
 */
import { describe, expect, it } from 'vitest'
import { buildChangeTree, sumLineCounts, type ChangeSide } from '../src/client/changes/change-tree.ts'
import type { GitLineCounts, GitStatusEntry } from '../src/client/api.ts'

/** One status entry carrying a reading on ONE side (the worktree by default).
 *  `xy` decides which bands the entry lands in; each band's tree reads its own
 *  side off the entry. */
function entry(path: string, xy: string, counts?: GitLineCounts, side: ChangeSide = 'unstaged'): GitStatusEntry {
  return counts === undefined ? { path, xy } : { path, xy, [side]: counts }
}

describe('change tree line counts', () => {
  it('keeps each entry counts on its own leaf', () => {
    const tree = buildChangeTree([
      entry('src/a.ts', ' M', { additions: 4, deletions: 2 }),
      entry('src/deep/b.ts', ' M', { binary: true }),
      entry('new.txt', '??'),
    ], 'unstaged')
    const src = tree.find(node => node.kind === 'dir' && node.path === 'src')!
    expect(src.kind).toBe('dir')
    const leaves = src.kind === 'dir' ? src.children : []
    expect(leaves.find(node => node.kind === 'file' && node.path === 'src/a.ts'))
      .toMatchObject({ counts: { additions: 4, deletions: 2 } })
    // The binary leaf keeps the binary marker, never a count of 0.
    const nested = leaves.find(node => node.kind === 'dir')!
    const nestedLeaves = nested.kind === 'dir' ? nested.children : []
    expect(nestedLeaves[0]).toMatchObject({ path: 'src/deep/b.ts', counts: { binary: true } })
    // The untracked leaf has NO counts property at all.
    const untracked = tree.find(node => node.kind === 'file' && node.path === 'new.txt')!
    expect(untracked.kind === 'file' && 'counts' in untracked).toBe(false)
  })

  it('reads ONLY the band\'s own side off a path that changed on both sides', () => {
    // The double-count regression (#131): the two diffs have different bases,
    // so `MM` carries two readings. Each band's tree must print its own, not
    // the sum — summing reported the same edited line as `+2 −2` in BOTH bands.
    // The two readings differ, so a band reading the WRONG side fails too.
    const both: GitStatusEntry = {
      path: 'a.txt',
      xy: 'MM',
      staged: { additions: 1, deletions: 1 },
      unstaged: { additions: 5, deletions: 0 },
    }
    expect(sumLineCounts(buildChangeTree([both], 'staged')))
      .toEqual({ additions: 1, deletions: 1, files: 1 })
    expect(sumLineCounts(buildChangeTree([both], 'unstaged')))
      .toEqual({ additions: 5, deletions: 0, files: 1 })
    // A side with no reading stays count-less in that band only.
    const stagedOnly = entry('b.txt', 'M ', { additions: 3, deletions: 0 }, 'staged')
    expect(buildChangeTree([stagedOnly], 'unstaged')[0]).not.toHaveProperty('counts')
    expect(buildChangeTree([stagedOnly], 'staged')[0]).toMatchObject({ counts: { additions: 3, deletions: 0 } })
  })

  it('sums a group to exactly the numbers its members carry', () => {
    const tree = buildChangeTree([
      entry('src/a.ts', ' M', { additions: 4, deletions: 2 }),
      entry('src/b.ts', ' M', { additions: 1, deletions: 0 }),
      entry('docs/c.md', ' M', { additions: 3, deletions: 3 }),
    ], 'unstaged')
    expect(sumLineCounts(tree)).toEqual({ additions: 8, deletions: 5, files: 3 })
  })

  it('counts only the rows that HAVE numbers (binary and untracked add nothing)', () => {
    const tree = buildChangeTree([
      entry('src/a.ts', ' M', { additions: 4, deletions: 2 }),
      entry('blob.bin', ' M', { binary: true }),
      entry('new.txt', '??'),
    ], 'unstaged')
    // 4/2 — not 4/2 plus a fabricated zero from either count-less row.
    expect(sumLineCounts(tree)).toEqual({ additions: 4, deletions: 2, files: 1 })
    // A group with nothing to sum reports zero files, so its header stays bare.
    expect(sumLineCounts(buildChangeTree([
      entry('blob.bin', ' M', { binary: true }), entry('n.txt', '??'),
    ], 'unstaged'))).toEqual({ additions: 0, deletions: 0, files: 0 })
  })

  it('counts only the rows that PRINT numbers: a 0/0 rename has none to sum (#131)', () => {
    // A rename with no content change is `0 0` in numstat (a mode-only change
    // reads the same way): its row prints nothing at all, so it must not make
    // a group's total claim it contributed numbers — otherwise a group holding
    // nothing but renames renders an empty `+N −M` cluster in its header.
    expect(sumLineCounts(buildChangeTree([
      entry('renamed.ts', 'R ', { additions: 0, deletions: 0 }, 'staged'),
    ], 'staged'))).toEqual({ additions: 0, deletions: 0, files: 0 })
    expect(sumLineCounts(buildChangeTree([
      entry('mode-only.ts', ' M', { additions: 0, deletions: 0 }),
    ], 'unstaged'))).toEqual({ additions: 0, deletions: 0, files: 0 })
    // A rename that DID move lines keeps contributing them...
    expect(sumLineCounts(buildChangeTree([
      entry('edited.ts', 'R ', { additions: 2, deletions: 1 }, 'staged'),
      entry('renamed.ts', 'R ', { additions: 0, deletions: 0 }, 'staged'),
    ], 'staged'))).toEqual({ additions: 2, deletions: 1, files: 1 })
  })

  it('counts every member regardless of how deep the directory chain folds', () => {
    // One compressed chain row stands for `src/client/changes`; the total must
    // still be the sum of the leaves under it.
    const tree = buildChangeTree([
      entry('src/client/changes/a.ts', ' M', { additions: 2, deletions: 1 }),
      entry('src/client/changes/b.ts', ' M', { additions: 5, deletions: 0 }),
    ], 'unstaged')
    expect(tree).toHaveLength(1)
    expect(tree[0]).toMatchObject({ kind: 'dir', name: 'src/client/changes' })
    expect(sumLineCounts(tree)).toEqual({ additions: 7, deletions: 1, files: 2 })
  })
})
