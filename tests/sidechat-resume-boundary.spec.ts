/** Real Session restore semantics, synthetic in-memory events only. No host/browser/provider. */
import { describe, expect, it } from 'vitest'
import { Session, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionId, SessionSeedEventState } from '@deepseek-ai/dsh-session'
import type { SidebarHistoryEntry } from '../src/context-types.ts'
import { threadOwnLogEvents, threadHasCompletedTurn, threadTrailingPending, type SidechatLogEvent } from '../src/sidechat-core.ts'
import { transcriptRows } from '../src/client/sidechat-transcript.ts'

const childContent = [
  { type: 'text', text: 'Synthetic child block zero.' },
  { type: 'reasoning', text: 'Synthetic non-text-block gap.' },
  { type: 'text', text: 'Synthetic child block two.' },
]
function turn(session: Session, number: number, label: string, content = childContent): void {
  session.append('turn/start', { turn: number })
  session.append('step/start', { turn: number, step: 1 })
  session.append('user/message', { id: `${label}-user`, role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: label }] } as never, { surfaceOp: 'append' })
  session.append('assistant/message', { turn: number, step: 1,
    message: { id: `${label}-assistant`, role: 'assistant', source: { kind: 'model', provider: 'synthetic', model: 'fixture' }, content },
    stream: [] } as never, { surfaceOp: 'append' })
  session.append('step/end', { turn: number, step: 1 })
  session.append('turn/end', { turn: number, reason: { kind: 'completed' } })
}
function fork(parent: Session, id: string): Session {
  return Session.create(id as SessionId, parent.snapshotEvents(), {
    version: SESSION_FORMAT_VERSION, id: id as SessionId, createdAt: 1, isSeeded: true,
  }, SessionLogOffset(parent.snapshotEvents().length))
}
function seed(): Session {
  const parent = Session.create('session-synthetic-parent' as SessionId)
  turn(parent, 1, 'synthetic inherited parent', [{ type: 'text', text: 'Inherited parent output must stay excluded.' }])
  const child = fork(parent, 'session-synthetic-child')
  turn(child, 2, 'synthetic child turn')
  return child
}
function restore(session: Session, mode: SessionSeedEventState): Session {
  return Session.fromRestore(session.id,
    mode === 'detached' ? structuredClone(session.snapshotEvents()) : session.snapshotEvents(),
    mode === 'detached' ? structuredClone(session.header) : session.header, session.inheritedEventCount, mode)
}
const log = (session: Session): readonly SidechatLogEvent[] => session.snapshotEvents()
const entries = (events: readonly SidechatLogEvent[]): SidebarHistoryEntry[] => events.map(event => ({ event } as SidebarHistoryEntry))
const assistants = (events: readonly SidechatLogEvent[]) => transcriptRows(entries(events)).filter(row => row.kind === 'assistant')
const marker = (seq: number, data: unknown): SidechatLogEvent => ({ type: 'session/end-seed', seq, time: seq, data })
const message = (seq: number): SidechatLogEvent => ({ type: 'user/message', seq, time: seq, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `synthetic-${seq}` }] } })

describe('inherited boundary is not a restore boundary', () => {
  it('cuts only the last tagged inherited prefix, including nested forks', () => {
    const events = [message(0), marker(1, { inherited: true }), message(2), marker(3, {}),
      marker(4, { inherited: true }), message(5), marker(6, {})]
    expect(threadOwnLogEvents(events).map(event => event.seq)).toEqual([5, 6])
  })
  it('is idempotent on the already-cut route payload containing restore markers', () => {
    const events = [message(0), marker(1, { inherited: true }), message(2), marker(3, {})]
    const own = threadOwnLogEvents(events)
    expect(own.map(event => event.seq)).toEqual([2, 3])
    expect(threadOwnLogEvents(own)).toEqual(own)
    expect(transcriptRows(entries(own))).toEqual([{ kind: 'user', seq: 2, text: 'synthetic-2' }])
  })
  it('does not invent a fork cut from replay, false, malformed or absent markers', () => {
    const events = [message(0), marker(1, {}), marker(2, { inherited: false }), marker(3, { inherited: 'true' }),
      marker(4, null), message(5)]
    expect(threadOwnLogEvents(events)).toEqual(events)
    expect(transcriptRows(entries(events)).filter(row => row.kind === 'user').map(row => row.seq)).toEqual([0, 5])
  })
  for (const mode of ['detached', 'shared-frozen'] as const) {
    it(`preserves both original text-block indexes across actual ${mode} restore and route→client composition`, () => {
      const child = seed(), before = assistants(log(child))
      expect(before.map(row => row.contentBlockIndex)).toEqual([0, 2])
      const resumed = restore(child, mode), events = log(resumed)
      expect(events.at(-1)).toMatchObject({ type: 'session/end-seed', data: {} })
      expect(resumed.inheritedEventCount).toBe(child.inheritedEventCount)
      expect(assistants(events)).toEqual(before)
      expect(assistants(threadOwnLogEvents(events))).toEqual(before)
      expect(JSON.stringify(transcriptRows(entries(threadOwnLogEvents(events))))).not.toContain('Inherited parent output')
      expect(threadHasCompletedTurn(entries(events))).toBe(true)
      expect(threadTrailingPending(entries(events))).toBe(false)
    })
    it(`retains earlier child turns across multiple actual ${mode} restore markers`, () => {
      const first = restore(seed(), mode)
      turn(first, 3, 'synthetic second child turn')
      const second = restore(first, mode), events = log(second)
      expect(events.filter(event => event.type === 'session/end-seed').map(event => event.data)).toEqual([
        { inherited: true }, {}, {},
      ])
      expect(assistants(threadOwnLogEvents(events)).map(row => row.contentBlockIndex)).toEqual([0, 2, 0, 2])
      expect(assistants(events)).toEqual(assistants(threadOwnLogEvents(events)))
      second.append('user/message', { id: 'synthetic pending', role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: 'synthetic follow-up' }] } as never, { surfaceOp: 'append' })
      expect(threadTrailingPending(entries(log(second)))).toBe(true)
    })
    it(`keeps nested parent history excluded after actual ${mode} restore`, () => {
      const parent = restore(seed(), mode)
      const empty = fork(parent, 'session-synthetic-empty-child')
      expect(assistants(log(restore(empty, mode)))).toEqual([])
      const grandchild = fork(parent, 'session-synthetic-grandchild')
      turn(grandchild, 4, 'synthetic grandchild')
      const resumed = restore(grandchild, mode)
      const output = assistants(threadOwnLogEvents(log(resumed)))
      expect(output.map(row => row.contentBlockIndex)).toEqual([0, 2])
      expect(output.every(row => row.seq > Number(grandchild.inheritedEventCount))).toBe(true)
    })
  }
})
