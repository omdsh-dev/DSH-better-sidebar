import { describe, expect, it } from 'vitest'
import { collectTurnChanges } from '../src/client/ChangesView.tsx'
import type { SidebarHistoryEntry } from '../src/context-types.ts'

/** One history row helper: an event plus an optional tool-call view. */
function row(event: Record<string, unknown>, view?: unknown): SidebarHistoryEntry {
  return { event: event as unknown as SidebarHistoryEntry['event'], ...(view === undefined ? {} : { view }) }
}

/** A tool/call row whose result carries a diff-card location. */
function writeCall(callId: string, path: string, seq: number): SidebarHistoryEntry {
  return row(
    { type: 'tool/call', seq, time: seq, data: { callId, name: 'write' } },
    { for: 'call', view: { card: 'diff', title: `Write ${path}`, locations: [{ path }] } },
  )
}

/** A tool/call row whose result carries a generic edit-card location. */
function editCall(callId: string, path: string, seq: number): SidebarHistoryEntry {
  return row(
    { type: 'tool/call', seq, time: seq, data: { callId, name: 'edit' } },
    { for: 'call', view: { card: 'generic', kind: 'edit', locations: [{ path }] } },
  )
}

/** A tool/call row that only reads (must contribute nothing). */
function readCall(callId: string, path: string, seq: number): SidebarHistoryEntry {
  return row(
    { type: 'tool/call', seq, time: seq, data: { callId, name: 'read' } },
    { for: 'call', view: { card: 'generic', kind: 'read', locations: [{ path }] } },
  )
}

/** The matching tool/result row (success, links the call id). */
function result(callId: string, seq: number, error = false): SidebarHistoryEntry {
  return row({
    type: 'tool/result', seq, time: seq,
    data: {
      message: {
        source: { callId },
        content: [{ isError: error }],
      },
    },
  })
}

function turnStart(turn: number, seq: number): SidebarHistoryEntry {
  return row({ type: 'turn/start', seq, time: seq, data: { turn } })
}

function turnEnd(turn: number, seq: number): SidebarHistoryEntry {
  return row({ type: 'turn/end', seq, time: seq, data: { turn } })
}

describe('collectTurnChanges', () => {
  it('folds each completed turn into its produced paths (first-seen order)', () => {
    const entries = [
      turnStart(1, 10),
      writeCall('c1', 'a.txt', 11),
      result('c1', 12),
      editCall('c2', 'b.txt', 13),
      editCall('c3', 'c.txt', 14),
      result('c2', 15),
      result('c3', 16),
      turnEnd(1, 17),
      turnStart(2, 20),
      writeCall('c4', 'd.txt', 21),
      result('c4', 22),
      turnEnd(2, 23),
    ]
    expect(collectTurnChanges(entries)).toEqual([
      { turn: 1, seq: 10, time: 10, paths: ['a.txt', 'b.txt', 'c.txt'] },
      { turn: 2, seq: 20, time: 20, paths: ['d.txt'] },
    ])
  })

  it('dedupes a path written twice in the same turn', () => {
    const entries = [
      turnStart(1, 10),
      writeCall('c1', 'a.txt', 11),
      result('c1', 12),
      editCall('c2', 'a.txt', 13),
      result('c2', 14),
      turnEnd(1, 15),
    ]
    expect(collectTurnChanges(entries)).toEqual([
      { turn: 1, seq: 10, time: 10, paths: ['a.txt'] },
    ])
  })

  it('ignores reads, errors, and turns with no changes', () => {
    const entries = [
      turnStart(1, 10),
      readCall('c1', 'r.txt', 11),
      result('c1', 12),
      writeCall('c2', 'x.txt', 13),
      result('c2', 14, true), // error result → nothing
      turnEnd(1, 15),
      turnStart(2, 20),
      turnEnd(2, 21),
    ]
    expect(collectTurnChanges(entries)).toEqual([])
  })

  it('does not leak a call across a turn boundary (result in a later turn contributes nothing)', () => {
    const entries = [
      turnStart(1, 10),
      writeCall('c1', 'a.txt', 11),
      turnEnd(1, 12),
      turnStart(2, 20),
      result('c1', 21),
      turnEnd(2, 22),
    ]
    expect(collectTurnChanges(entries)).toEqual([])
  })

  it('ignores events before the first turn/start (no attributed turn yet)', () => {
    const entries = [
      writeCall('c1', 'a.txt', 1),
      result('c1', 2),
      turnStart(1, 10),
      writeCall('c2', 'b.txt', 11),
      result('c2', 12),
      turnEnd(1, 13),
    ]
    // The pre-turn call has no owning turn yet (current is null when its
    // result lands), so it contributes nothing; only the in-turn write shows.
    expect(collectTurnChanges(entries)).toEqual([
      { turn: 1, seq: 10, time: 10, paths: ['b.txt'] },
    ])
  })
})
