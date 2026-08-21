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
import { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
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

function toolResultMessage(callId: string, text: string): Record<string, unknown> {
  return {
    id: `m-${callId}`,
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
    source: { kind: 'tool', callId },
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
    const types = child.events.map(event => event.type)
    expect(types).toEqual([
      'user/message', 'turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end',
      'user/message', 'turn/start', 'step/start', 'assistant/chunk', 'step/end', 'turn/end',
      'session/end-seed',
    ])
    // The synthetic close is honest: the frozen turn ends interrupted.
    const turnEnd = child.events.findLast(event => event.type === 'turn/end')
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
    expect(child.events.map(event => event.type).at(-1)).toBe('session/end-seed')
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
    const types = child.events.map(event => event.type)
    expect(types.at(-2)).toBe('subagent/descriptor')
    expect(types.at(-1)).toBe('session/end-seed')
  })
})
