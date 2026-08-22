/**
 * Lane-layout tests for the history graph (src/client/git-graph.ts) — the
 * pure geometry that feeds the GitGraphSvg renderer. The input is the
 * topo-ordered `git log` rows the host already returns; each test below
 * hand-builds a small commit DAG and asserts the classic git-graph shapes
 * (straight main line, branch/merge forks, diamond joins, octopus merges,
 * root commits, column recycling).
 */
import { describe, expect, it } from 'vitest'
import type { GitGraphEntry } from '../src/client/api.ts'
import {
  CELL_W, ROW_H, colX, computeGraphRows, laneColor, pathForkOut, pathMergeIn, pathV,
} from '../src/client/git-graph.ts'

/** A minimal graph log entry; hashes double as the full hashes. */
function commit(hash: string, parents: string[], refs = ''): GitGraphEntry {
  return {
    hash,
    hashFull: hash,
    subject: `commit ${hash}`,
    author: 'Alice',
    date: '2024-01-01 00:00:00 +0000',
    refs,
    parents,
  }
}

describe('computeGraphRows', () => {
  it('lays a linear history out on a single lane (straight line)', () => {
    const { rows, graphWidth } = computeGraphRows([
      commit('c1', ['c2']),
      commit('c2', ['c3']),
      commit('c3', []),
    ])
    expect(rows.map(r => r.dotCol)).toEqual([0, 0, 0])
    expect(rows[0]!.below.has(0)).toBe(true)
    expect(rows[1]!.below.has(0)).toBe(true)
    expect(rows[2]!.below.size).toBe(0) // root: the lane ends
    expect(rows.every(r => r.merges.length === 0 && r.forks.length === 0)).toBe(true)
    expect(graphWidth).toBe(1 * CELL_W + 6)
  })

  it('forks a second parent out and joins a diamond back with a merge arc', () => {
    const { rows } = computeGraphRows([
      commit('a', ['b']),      // main tip
      commit('b', ['c']),      //
      commit('c', ['d', 'e']), // merge: d continues col 0, e forks to col 1
      commit('d', ['f']),      // col 0 continues
      commit('e', ['f']),      // col 1 also carries f → diamond
      commit('f', []),         // displayed on the leftmost lane; col 1 arcs in
    ])
    expect(rows.map(r => r.dotCol)).toEqual([0, 0, 0, 0, 1, 0])
    // the merge row forks its second parent to a new lane
    expect(rows[2]!.forks.map(f => f.col)).toEqual([1])
    // the branch lane stays a straight vertical through the sibling rows
    expect(rows[3]!.below.has(1)).toBe(true)
    expect(rows[3]!.merges.length).toBe(0)
    // e's parent f is NOT a merge at e's row — the lane continues (f is later)
    expect(rows[4]!.merges.length).toBe(0)
    expect(rows[4]!.below.has(0)).toBe(true)
    // the diamond join: col 1 carries the same hash as the dot → merge arc
    expect(rows[5]!.dotCol).toBe(0)
    expect(rows[5]!.merges.map(m => m.col)).toEqual([1])
    expect(rows[5]!.below.has(1)).toBe(false)
  })

  it('forks every extra parent of an octopus merge, then joins them all', () => {
    const { rows } = computeGraphRows([
      commit('a', ['b', 'c', 'd']),
      commit('b', ['e']),
      commit('c', ['e']),
      commit('d', ['e']),
      commit('e', []),
    ])
    expect(rows[0]!.dotCol).toBe(0)
    expect(rows[0]!.forks.map(f => f.col)).toEqual([1, 2])
    expect(rows[1]!.dotCol).toBe(0)
    expect(rows[2]!.dotCol).toBe(1)
    expect(rows[3]!.dotCol).toBe(2)
    // e is displayed on the leftmost of the three lanes carrying it; the
    // other two end with merge arcs into the dot
    expect(rows[4]!.dotCol).toBe(0)
    expect(rows[4]!.merges.map(m => m.col).sort()).toEqual([1, 2])
    expect(rows[4]!.below.size).toBe(0) // root: everything ends
  })

  it('does not reuse a merge-freed column in the same row, but recycles it later', () => {
    const { rows } = computeGraphRows([
      commit('a', ['b']),          // 0
      commit('b', ['c', 'd']),     // 1: d forks to col 1
      commit('c', ['e']),          // 2: col 0 continues
      commit('d', ['e']),          // 3: col 1 also carries e
      commit('e', ['f', 'g']),     // 4: e joins at col 0 (col 1 merges in), g forks
      commit('f', ['h']),          // 5
      commit('g', ['h']),          // 6
      commit('h', ['i']),          // 7: col 2 merges in
      commit('i', ['j', 'k']),     // 8: k recycles the column freed at row e
      commit('j', []),             // 9
      commit('k', []),             // 10
    ])
    // row e: the fork for g must NOT reuse col 1 in the same row its merge
    // arc used it (no V bounce) — it takes a brand-new column instead
    const rowE = rows[4]!
    expect(rowE.merges.map(m => m.col)).toEqual([1])
    expect(rowE.forks.map(f => f.col)).toEqual([2])
    // row h: the second diamond also joins into the leftmost lane
    expect(rows[7]!.merges.map(m => m.col)).toEqual([2])
    // row i: col 1 (freed back at row e) is a normal free column again →
    // the fork for k recycles it instead of widening the graph
    expect(rows[8]!.forks.map(f => f.col)).toEqual([1])
    expect(rows[8]!.lanes.has(1)).toBe(true)
    expect(rows[9]!.dotCol).toBe(0)
    expect(rows[10]!.dotCol).toBe(1)
  })

  it('joins a fork into an existing lane when the parent was already promised', () => {
    const { rows } = computeGraphRows([
      commit('a', ['b', 'p']), // p forks to col 1
      commit('b', ['c']),      // main continues on col 0
      commit('c', ['d', 'p']), // merge: p's lane (col 1) already exists
      commit('d', []),         // main reaches a root
      commit('p', []),         // p is displayed on col 1
    ])
    // row c: the second parent p needs no new lane — the fork joins col 1
    expect(rows[2]!.dotCol).toBe(0)
    expect(rows[2]!.forks.map(f => f.col)).toEqual([1])
    // no diamond anywhere here → no merge arcs at all
    expect(rows.every(r => r.merges.length === 0)).toBe(true)
    // p is displayed on the lane the forks kept feeding
    expect(rows[4]!.dotCol).toBe(1)
    expect(rows[4]!.below.size).toBe(0)
  })

  it('assigns a stable color per column that cycles through the palette', () => {
    expect(laneColor(0)).toBe('var(--gg-lane-0)')
    expect(laneColor(5)).toBe('var(--gg-lane-5)')
    expect(laneColor(6)).toBe('var(--gg-lane-0)') // wraps
  })
})

describe('path geometry', () => {
  it('places the dot x at the column center', () => {
    expect(colX(0)).toBe(CELL_W / 2)
    expect(colX(2)).toBe(2 * CELL_W + CELL_W / 2)
  })

  it('spans a vertical line between arbitrary y bounds', () => {
    expect(pathV(12, 0, 20)).toBe('M 12 0 L 12 20')
    expect(pathV(12, 20, ROW_H)).toBe(`M 12 20 L 12 ${ROW_H}`)
  })

  it('ends a merge arc at the dot mid', () => {
    const d = pathMergeIn(12, 36, ROW_H / 2)
    expect(d.endsWith(`L 36 ${ROW_H / 2}`)).toBe(true)
    expect(d).toContain('M 12 0')
  })

  it('forks down to the nominal row bottom (y-stretch to the real row height happens in the SVG viewBox)', () => {
    expect(pathForkOut(12, 36, ROW_H / 2).endsWith(`L 36 ${ROW_H}`)).toBe(true)
    // same-column fork: a plain vertical to the row bottom
    expect(pathForkOut(12, 12, ROW_H / 2)).toBe(`M 12 ${ROW_H / 2} L 12 ${ROW_H}`)
  })
})
