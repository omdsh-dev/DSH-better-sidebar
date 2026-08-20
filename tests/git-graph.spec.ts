import { describe, expect, it } from 'vitest'
import { computeGitGraph } from '../src/client/GitView.tsx'
import type { GitLogEntry } from '../src/git.ts'

describe('computeGitGraph', () => {
  it('computes linear branch line properly', () => {
    const entries: GitLogEntry[] = [
      { hash: 'c3', hashFull: 'c3', subject: 'third', author: 'a', date: '2024', refs: '', parents: ['c2'] },
      { hash: 'c2', hashFull: 'c2', subject: 'second', author: 'a', date: '2024', refs: '', parents: ['c1'] },
      { hash: 'c1', hashFull: 'c1', subject: 'first', author: 'a', date: '2024', refs: '', parents: [] },
    ]
    const graph = computeGitGraph(entries)
    expect(graph.maxLanes).toBe(1)
    expect(graph.rows).toHaveLength(3)

    // c3: top row, no line from top, line to bottom
    expect(graph.rows[0]?.lane).toBe(0)
    expect(graph.rows[0]?.fromTop).toBe(false)
    expect(graph.rows[0]?.hasBottom).toBe(true)

    // c2: middle row, line from top, line to bottom
    expect(graph.rows[1]?.lane).toBe(0)
    expect(graph.rows[1]?.fromTop).toBe(true)
    expect(graph.rows[1]?.hasBottom).toBe(true)

    // c1: bottom root row, line from top, no line to bottom
    expect(graph.rows[2]?.lane).toBe(0)
    expect(graph.rows[2]?.fromTop).toBe(true)
    expect(graph.rows[2]?.hasBottom).toBe(false)
  })

  it('computes branching and merge curves for multi-branch history', () => {
    // Feature branch (f1) branched from base (b1), then merged back into main (m1)
    const entries: GitLogEntry[] = [
      { hash: 'm1', hashFull: 'm1', subject: 'merge commit', author: 'a', date: '2024', refs: 'HEAD -> main', parents: ['b2', 'f1'] },
      { hash: 'f1', hashFull: 'f1', subject: 'feature commit', author: 'a', date: '2024', refs: 'feat', parents: ['b1'] },
      { hash: 'b2', hashFull: 'b2', subject: 'main commit 2', author: 'a', date: '2024', refs: '', parents: ['b1'] },
      { hash: 'b1', hashFull: 'b1', subject: 'root commit', author: 'a', date: '2024', refs: '', parents: [] },
    ]
    const graph = computeGitGraph(entries)
    expect(graph.maxLanes).toBeGreaterThanOrEqual(2)

    // m1 should have an outgoing merge curve to the feature lane
    expect(graph.rows[0]?.outgoingMerges.length).toBeGreaterThanOrEqual(1)

    // f1 should be on a separate lane
    expect(graph.rows[1]?.lane).not.toBe(graph.rows[0]?.lane)
  })
})
