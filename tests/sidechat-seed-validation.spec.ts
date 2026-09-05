/**
 * Seed-validator integration test: the seed built by {@link buildSidechatInheritance}
 * must be accepted by the REAL dsh-session validator (`Session.create`).
 *
 * Regression: the seed copy originally stripped the event envelope's
 * `surfaceOp` marker, and the real validator rejects surface-eligible events
 * (user/message, assistant/message, tool/result) without it — the live host
 * surfaced it as "invalid seed event at index N: ... requires a surfaceOp
 * marker" during real thread creation. This test runs the ACTUAL validator,
 * not a mock, so the class of bug cannot silently return.
 */
import { describe, expect, it } from 'vitest'
import { Session, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { Inbox } from '@deepseek-ai/dsh-agent'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import type { SidebarSessionEvent } from '../src/context-types.ts'
import { buildSidechatInheritance } from '../src/sidechat-core.ts'

/** One live-style event with the surface marker message events carry, and
 *  the REAL message shapes the validator demands (id/role/source/content;
 *  tool/result messages carry role 'user' + one tool-result block). */
function ev(type: string, seq: number, data: Record<string, unknown>): SidebarSessionEvent {
  const event: SidebarSessionEvent = { type, seq, time: seq * 1000, data }
  if (type === 'user/message' || type === 'assistant/message' || type === 'tool/result') {
    return { ...event, surfaceOp: 'append' } as SidebarSessionEvent
  }
  return event
}

function userMessage(text: string): Record<string, unknown> {
  return { id: `m-${text}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function assistantMessage(text: string): Record<string, unknown> {
  return {
    id: `m-${text}`,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'test', model: 'model-x' },
  }
}

/** A parent log with a completed turn, a pending question, and an open
 *  in-progress turn (the exact shape a mid-stream thread creation sees). */
function parentLog(): SidebarSessionEvent[] {
  return [
    ev('user/message', 0, userMessage('first question')),
    ev('turn/start', 1, { turn: 1 }),
    ev('step/start', 2, { turn: 1, step: 1 }),
    ev('assistant/message', 3, { turn: 1, step: 1, message: assistantMessage('first answer') }),
    ev('step/end', 4, { turn: 1, step: 1 }),
    ev('turn/end', 5, { turn: 1, reason: { kind: 'completed' } }),
    ev('user/message', 6, userMessage('pending question')),
    ev('turn/start', 7, { turn: 2 }),
    ev('step/start', 8, { turn: 2, step: 1 }),
    ev('assistant/chunk', 9, { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'in-progress' } }),
  ]
}

describe('sidechat seed against the real dsh-session validator', () => {
  it('accepts a seed with a completed turn + pending user message + synthetically closed open turn', () => {
    const { seed, snapshot } = buildSidechatInheritance(parentLog())
    expect(snapshot).toBeNull()
    // The REAL validator: this throws when an envelope field was stripped
    // (the reported regression) or the turn balance is off.
    const child = Session.create('session-validator-test' as SessionId, seed as never)
    const types = child.snapshotEvents().map(event => event.type)
    expect(types).toEqual([
      'user/message', 'turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end',
      'user/message', 'turn/start', 'step/start', 'assistant/chunk', 'step/end', 'turn/end',
      'session/end-seed',
    ])
    // The synthetic close is honest: the frozen turn ends interrupted.
    const turnEnd = child.snapshotEvents().findLast(event => event.type === 'turn/end')
    expect(turnEnd?.data).toEqual({ turn: 2, reason: { kind: 'interrupted' } })
  })

  it('accepts a dangling-tool-call fallback seed (cut before the open turn)', () => {
    const log = [
      ...parentLog().slice(0, 7),
      ev('turn/start', 7, { turn: 2 }),
      ev('step/start', 8, { turn: 2, step: 1 }),
      ev('tool/call', 9, { turn: 2, step: 1, callId: 'c1', name: 'bash', arguments: '{"cmd":"sleep"}' }),
    ]
    const { seed, snapshot } = buildSidechatInheritance(log)
    expect(snapshot).not.toBeNull()
    const child = Session.create('session-validator-fallback' as SessionId, seed as never)
    expect(child.snapshotEvents().map(event => event.type).at(-1)).toBe('session/end-seed')
  })

  it('accepts the durable subagent descriptor the routes append to the seed', () => {
    // Regression guard for the catalog-corrupt fix: a cold thread WITHOUT a
    // descriptor renders as a 'corrupt' diagnostic in the host subagents.list.
    // The descriptor is a log-only event appended INSIDE the seed (before the
    // end-seed marker); the real validator must accept the combined seed.
    const { seed } = buildSidechatInheritance(parentLog())
    const descriptor = snapshotSubagentDescriptor({
      mode: 'continuable',
      provider: 'sidechat',
      label: 'Side: test',
      agentProvider: 'test',
      agentModel: 'model-x',
    })
    const withDescriptor = [
      ...seed,
      { type: 'subagent/descriptor', seq: seed.length, time: Date.now(), data: descriptor },
    ]
    const child = Session.create('session-validator-descriptor' as SessionId, withDescriptor as never)
    const types = child.snapshotEvents().map(event => event.type)
    expect(types.at(-2)).toBe('subagent/descriptor')
    expect(types.at(-1)).toBe('session/end-seed')
  })
})

describe('sidechat seed fork markers vs the real dsh-agent Inbox replay', () => {
  /**
   * Regression: the thread-create call originally passed `seed` WITHOUT the
   * fork-marker pair (`meta.isSeeded: true` + `inheritedEventCount`). A seed
   * without them is REPLAY history, not an inherited prefix, so the child's
   * ownEvents() includes the whole seed and its Inbox constructor replays the
   * parent's `agent/inbox/spliced` events — inheriting whatever input sat
   * UNCLAIMED in the parent at the click moment (a queued follow-up, or a
   * tool-result context spliced into next-step between step boundaries of a
   * long-running turn). The first side prompt then claimed and SENT that stale
   * message before the boundary + question. These tests run the REAL
   * dsh-session Session and dsh-agent Inbox.
   */
  const pendingMessage = (id: string, kind: string, text: string) => ({
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind },
  })
  const inboxOver = (session: Session): { nextTurn: number; nextStep: number } => {
    const inbox = new Inbox(session, { inserted() {}, discarded() {}, claimed() {} })
    return { nextTurn: inbox.nextTurn.length, nextStep: inbox.nextStep.length }
  }
  /** The shape the routes pass since the fix: isSeeded + inheritedEventCount. */
  const forkMarkedSession = (id: string, seed: readonly SidebarSessionEvent[]): Session =>
    Session.create(
      id as SessionId,
      seed as never,
      { version: 0, id: id as SessionId, createdAt: Date.now(), isSeeded: true },
      SessionLogOffset(seed.length),
    )
  /** Real loop order: inbox insert → turn/start → claim deletion → step/start
   *  → user/message. One completed, fully claimed turn (seq 0-7). */
  const completedTurnLog = (): SidebarSessionEvent[] => [
    ev('agent/inbox/spliced', 0, { target: 'next-turn', start: 0, inserted: [pendingMessage('m-q', 'user', 'q')] }),
    ev('turn/start', 1, { turn: 1 }),
    ev('agent/inbox/spliced', 2, { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
    ev('step/start', 3, { turn: 1, step: 1 }),
    ev('user/message', 4, pendingMessage('m-q', 'user', 'q')),
    ev('assistant/message', 5, { turn: 1, step: 1, message: assistantMessage('a') }),
    ev('step/end', 6, { turn: 1, step: 1 }),
    ev('turn/end', 7, { turn: 1, reason: { kind: 'completed' } }),
  ]
  /** Mid-turn with an UNCLAIMED tool-result context in next-step (seq 15). */
  const midTurnLog = (): SidebarSessionEvent[] => [
    ...completedTurnLog(),
    ev('agent/inbox/spliced', 8, { target: 'next-turn', start: 0, inserted: [pendingMessage('m-q2', 'user', 'q2')] }),
    ev('turn/start', 9, { turn: 2 }),
    ev('agent/inbox/spliced', 10, { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
    ev('step/start', 11, { turn: 2, step: 1 }),
    ev('user/message', 12, pendingMessage('m-q2', 'user', 'q2')),
    ev('tool/call', 13, { turn: 2, step: 1, callId: 'c1', name: 'bash', arguments: '{}' }),
    ev('tool/result', 14, {
      turn: 2, step: 1,
      message: {
        id: 'm-r',
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }],
        source: { kind: 'tool', callId: 'c1' },
      },
    }),
    ev('agent/inbox/spliced', 15, {
      target: 'next-step',
      start: 0,
      inserted: [pendingMessage('m-ctx', 'tool', 'tool bash finished: exit 0 ... now continue the plan')],
    }),
  ]

  it('inherits the parent\'s UNCLAIMED next-step tool context without the fork markers (root cause)', () => {
    // Parent mid-turn (user queue empty): the bash tool returned and spliced
    // its follow-up context into next-step; the next step boundary has not
    // claimed it yet. The reported long-context scenario.
    const { seed } = buildSidechatInheritance(midTurnLog())
    // OLD call shape (seed only): the whole seed counts as own events and the
    // phantom context is inherited as pending input.
    const unmarked = Session.create('session-inbox-unmarked' as SessionId, seed as never)
    expect(unmarked.ownEvents().length).toBe(seed.length + 1)
    expect(inboxOver(unmarked)).toEqual({ nextTurn: 0, nextStep: 1 })
  })

  it('inherits the parent\'s QUEUED follow-up (next-turn) without the fork markers', () => {
    const queued = pendingMessage('m-queued', 'user', 'queued second message')
    const log: SidebarSessionEvent[] = [
      ...completedTurnLog(),
      ev('agent/inbox/spliced', 8, { target: 'next-turn', start: 0, inserted: [queued] }),
    ]
    const { seed } = buildSidechatInheritance(log)
    const unmarked = Session.create('session-inbox-unmarked-turn' as SessionId, seed as never)
    expect(inboxOver(unmarked)).toEqual({ nextTurn: 1, nextStep: 0 })
  })

  it('the fork-marker pair (isSeeded + inheritedEventCount) leaves the inherited inbox empty', () => {
    // Same mid-turn log as the root-cause case, plus the descriptor the
    // routes append — exactly what sidechat.start passes to agents.create.
    const { seed } = buildSidechatInheritance(midTurnLog())
    const withDescriptor = [
      ...seed,
      {
        type: 'subagent/descriptor',
        seq: seed.length,
        time: Date.now(),
        data: snapshotSubagentDescriptor({ mode: 'continuable', provider: 'sidechat', label: 'Side: test' }),
      } as unknown as SidebarSessionEvent,
    ]
    const marked = forkMarkedSession('session-inbox-marked', withDescriptor)
    // Only the end-seed marker is own; the transcript cut is unchanged.
    expect(marked.ownEvents().map(event => event.type)).toEqual(['session/end-seed'])
    expect(marked.snapshotEvents().map(event => event.type).at(-1)).toBe('session/end-seed')
    expect(inboxOver(marked)).toEqual({ nextTurn: 0, nextStep: 0 })
  })
})
