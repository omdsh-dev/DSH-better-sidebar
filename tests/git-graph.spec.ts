import { describe, expect, it } from 'vitest'
import { layoutGitGraph } from '../src/client/git-graph.ts'
import type { GitLogEntry } from '../src/client/api.ts'

function commit(hash: string, parents: string[] = []): GitLogEntry {
  return {
    hash: hash.slice(0, 7),
    hashFull: hash,
    subject: hash,
    author: 'Test',
    date: '2026-08-24 00:00:00 +0800',
    parents,
    refs: '',
  }
}

describe('git history graph layout', () => {
  it('keeps linear history in one lane', () => {
    const rows = layoutGitGraph([
      commit('ccccccc', ['bbbbbbb']),
      commit('bbbbbbb', ['aaaaaaa']),
      commit('aaaaaaa'),
    ])
    expect(rows.map(row => row.lane)).toEqual([0, 0, 0])
    expect(rows[0]).toMatchObject({ lanes: 1, edges: [{ from: 0, to: 0, color: 0 }] })
    expect(rows[2]!.edges).toEqual([])
  })

  it('puts a side branch in a second lane and merges it back', () => {
    const rows = layoutGitGraph([
      commit('mmmmmmm', ['nnnnnnn', 'sssssss']),
      commit('sssssss', ['nnnnnnn']),
      commit('nnnnnnn'),
    ])
    expect(rows[0]).toMatchObject({ lane: 0, lanes: 2 })
    expect(rows[0]!.edges).toEqual([
      { from: 0, to: 0, color: 0 },
      { from: 0, to: 1, color: 1 },
    ])
    expect(rows[1]!.lane).toBe(1)
    expect(rows[1]!.edges).toContainEqual({ from: 1, to: 0, color: 1 })
  })
})
