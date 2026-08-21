/**
 * Unit tests for the pure Side Chat core (src/sidechat-core.ts): the seed
 * construction (full-log inheritance with honest synthetic closing of an
 * in-progress parent turn), the structured in-progress snapshot (with the
 * dangling-tool-call fallback), thread-row derivation, save eligibility, and
 * the preset resolution.
 */
import { describe, expect, it } from 'vitest'
import type { SidebarHistoryEntry, SidebarSessionEvent, SidebarSessionSummary } from '../src/context-types.ts'
import {
  boundaryDelivered,
  buildOpenTurnSnapshot,
  buildSidechatInheritance,
  hasDanglingToolCall,
  resolvePresetId,
  sideLabel,
  sideThreadRows,
  threadHasCompletedTurn,
  threadTrailingPending,
  SIDE_BOUNDARY_PROMPT,
  SIDE_LABEL_PREFIX,
  type SeedEvent,
  type SidechatLogEvent,
} from '../src/sidechat-core.ts'

/** One log event fixture (structural, seq === index like the live contract).
 *  Surface-eligible events carry their required `surfaceOp: 'append'`
 *  marker, exactly like the live pipeline appends them. */
function ev(type: string, seq: number, data: Record<string, unknown> = {}): SidebarSessionEvent {
  const event: SidebarSessionEvent = { type, seq, time: seq * 1000, data }
  if (type === 'user/message' || type === 'assistant/message' || type === 'tool/result') {
    return { ...event, surfaceOp: 'append' } as SidebarSessionEvent
  }
  return event
}

/** A completed user→assistant turn block (turn T, step 1, optional tools). */
function completedTurn(seq: number, turn: number, over: {
  text?: string
  tools?: Array<{ callId: string; name?: string; args?: string; result?: string }>
} = {}): SidebarSessionEvent[] {
  const events: SidebarSessionEvent[] = [
    ev('user/message', seq, { content: [{ type: 'text', text: `q${turn}` }], source: { kind: 'user' } }),
    ev('turn/start', seq + 1, { turn }),
    ev('step/start', seq + 2, { turn, step: 1 }),
  ]
  let next = seq + 3
  for (const tool of over.tools ?? []) {
    events.push(ev('tool/call', next++, { turn, step: 1, callId: tool.callId, name: tool.name ?? 'bash', arguments: tool.args ?? '{}' }))
    events.push(ev('tool/result', next++, {
      turn,
      step: 1,
      message: {
        source: { kind: 'tool', callId: tool.callId },
        content: [{ type: 'tool-result', toolCallId: tool.callId, isError: false, content: [{ type: 'text', text: tool.result ?? 'ok' }] }],
      },
    }))
  }
  if (over.text !== undefined) {
    events.push(ev('assistant/message', next++, {
      turn,
      step: 1,
      message: { content: [{ type: 'text', text: over.text }] },
    }))
  }
  events.push(ev('step/end', next++, { turn, step: 1 }))
  events.push(ev('turn/end', next, { turn, reason: { kind: 'completed' } }))
  return events
}

/** Assert the seed is contiguous from seq 0. */
function expectContiguous(seed: readonly SeedEvent[]): void {
  seed.forEach((event, index) => expect(event.seq).toBe(index))
}

describe('buildSidechatInheritance', () => {
  it('returns an empty seed for an empty log', () => {
    const { seed, snapshot } = buildSidechatInheritance([])
    expect(seed).toEqual([])
    expect(snapshot).toBeNull()
  })

  it('copies a log that ends outside any turn verbatim (pending user message)', () => {
    const events = [
      ...completedTurn(0, 1, { text: 'a' }),
      ev('user/message', 6, { content: [{ type: 'text', text: 'pending?' }], source: { kind: 'user' } }),
    ]
    const { seed, snapshot } = buildSidechatInheritance(events)
    expectContiguous(seed)
    expect(seed).toHaveLength(events.length)
    expect(seed.at(-1)?.type).toBe('user/message')
    expect(seed.some(event => event.type === 'turn/end')).toBe(true)
    expect(snapshot).toBeNull()
  })

  it('preserves the surface envelope of message events in the seed', () => {
    // Regression: the seed validator rejects surface-eligible events
    // (user/message, assistant/message, tool/result) whose `surfaceOp`
    // marker was stripped — the copy must keep the FULL event envelope.
    const events = [
      ev('user/message', 0, { content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }),
      ev('turn/start', 1, { turn: 1 }),
      ev('step/start', 2, { turn: 1, step: 1 }),
      ev('tool/call', 3, { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' }),
      ev('tool/result', 4, {
        turn: 1,
        step: 1,
        message: {
          source: { kind: 'tool', callId: 'c1' },
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }],
        },
      }),
      ev('assistant/message', 5, { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'a' }] } }),
      ev('step/end', 6, { turn: 1, step: 1 }),
      ev('turn/end', 7, { turn: 1, reason: { kind: 'completed' } }),
    ]
    const { seed } = buildSidechatInheritance(events)
    expect(seed.filter(event => event.type === 'user/message').every(event => event.surfaceOp === 'append')).toBe(true)
    expect(seed.filter(event => event.type === 'assistant/message').every(event => event.surfaceOp === 'append')).toBe(true)
    expect(seed.filter(event => event.type === 'tool/result').every(event => event.surfaceOp === 'append')).toBe(true)
    // Non-surface events never gain a marker.
    expect(seed.filter(event => event.type === 'turn/end').every(event => event.surfaceOp === undefined)).toBe(true)
  })

  it('copies a log with no turns at all', () => {
    const events = [ev('user/message', 0, { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })]
    const { seed } = buildSidechatInheritance(events)
    expectContiguous(seed)
    expect(seed).toHaveLength(1)
  })

  it('closes an open streaming turn with synthetic step/end + interrupted turn/end', () => {
    const events = [
      ...completedTurn(0, 1, { text: 'done' }),
      ev('user/message', 6, { content: [{ type: 'text', text: 'next?' }], source: { kind: 'user' } }),
      ev('turn/start', 7, { turn: 2 }),
      ev('step/start', 8, { turn: 2, step: 1 }),
      ev('assistant/chunk', 9, { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'partial answer' } }),
    ]
    const { seed, snapshot } = buildSidechatInheritance(events)
    expectContiguous(seed)
    expect(seed).toHaveLength(events.length + 2)
    const stepEnd = seed.at(-2)!
    const turnEnd = seed.at(-1)!
    expect(stepEnd).toMatchObject({ type: 'step/end', data: { turn: 2, step: 1 } })
    expect(turnEnd).toMatchObject({ type: 'turn/end', data: { turn: 2, reason: { kind: 'interrupted' } } })
    // The pending user message and the partial chunk survive as REAL events.
    expect(seed.some(event => event.type === 'user/message'
      && (event.data.content as Array<{ text: string }>)[0]?.text === 'next?')).toBe(true)
    expect(seed.some(event => event.type === 'assistant/chunk')).toBe(true)
    expect(snapshot).toBeNull()
  })

  it('closes an open turn whose tool calls already have results', () => {
    const events = [
      ev('user/message', 0, { content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }),
      ev('turn/start', 1, { turn: 1 }),
      ev('step/start', 2, { turn: 1, step: 1 }),
      ev('tool/call', 3, { turn: 1, step: 1, callId: 'c1', name: 'grep', arguments: '{"q":"x"}' }),
      ev('tool/result', 4, {
        turn: 1,
        step: 1,
        message: {
          source: { kind: 'tool', callId: 'c1' },
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'hit' }] }],
        },
      }),
      ev('assistant/chunk', 5, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'found ' } }),
    ]
    const { seed, snapshot } = buildSidechatInheritance(events)
    expectContiguous(seed)
    expect(seed.at(-1)?.type).toBe('turn/end')
    expect(hasDanglingToolCall(events, 1)).toBe(false)
    expect(snapshot).toBeNull()
  })

  it('falls back to a snapshot cut when a tool call is still executing', () => {
    const events = [
      ev('user/message', 0, { content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }),
      ev('turn/start', 1, { turn: 1 }),
      ev('step/start', 2, { turn: 1, step: 1 }),
      ev('assistant/chunk', 3, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'running ' } }),
      ev('tool/call', 4, { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"cmd":"sleep 9"}' }),
    ]
    expect(hasDanglingToolCall(events, 1)).toBe(true)
    const { seed, snapshot } = buildSidechatInheritance(events)
    expectContiguous(seed)
    // The seed stops BEFORE the open turn; the pending user message stays.
    expect(seed.at(-1)?.type).toBe('user/message')
    expect(seed.some(event => event.type === 'turn/start')).toBe(false)
    expect(snapshot).not.toBeNull()
    expect(snapshot).toContain('running ')
    expect(snapshot).toContain('`bash` (executing)')
    expect(snapshot).toContain('sleep 9')
  })

  it('closes only the current step when the open turn has completed steps', () => {
    const events = [
      ev('user/message', 0, { content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }),
      ev('turn/start', 1, { turn: 1 }),
      ev('step/start', 2, { turn: 1, step: 1 }),
      ev('assistant/message', 3, { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'first' }] } }),
      ev('step/end', 4, { turn: 1, step: 1 }),
      ev('step/start', 5, { turn: 1, step: 2 }),
      ev('assistant/chunk', 6, { turn: 1, step: 2, chunk: { type: 'text-delta', index: 0, text: 'second' } }),
    ]
    const { seed } = buildSidechatInheritance(events)
    expectContiguous(seed)
    expect(seed.at(-2)).toMatchObject({ type: 'step/end', data: { turn: 1, step: 2 } })
    expect(seed.at(-1)).toMatchObject({ type: 'turn/end', data: { turn: 1 } })
  })
})

describe('buildOpenTurnSnapshot', () => {
  it('returns null without an open turn', () => {
    expect(buildOpenTurnSnapshot([ev('user/message', 0, { content: [], source: { kind: 'user' } })])).toBeNull()
    expect(buildOpenTurnSnapshot(completedTurn(0, 1, { text: 'x' }))).toBeNull()
  })

  it('preserves streamed text and tool detail verbatim', () => {
    const events = [
      ev('turn/start', 0, { turn: 1 }),
      ev('step/start', 1, { turn: 1, step: 1 }),
      ev('assistant/chunk', 2, { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'think' } }),
      ev('assistant/chunk', 3, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '```js\ncode' } }),
      ev('assistant/chunk', 4, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '\n```' } }),
      ev('tool/call', 5, { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a.txt"}' }),
      ev('tool/result', 6, {
        turn: 1,
        step: 1,
        message: {
          source: { kind: 'tool', callId: 'c1' },
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'file body' }] }],
        },
      }),
      ev('tool/call', 7, { turn: 1, step: 1, callId: 'c2', name: 'bash', arguments: '{"cmd":"long"}' }),
    ]
    const snapshot = buildOpenTurnSnapshot(events)
    expect(snapshot).not.toBeNull()
    expect(snapshot).toContain('```js\ncode\n```')
    expect(snapshot).toContain('Reasoning so far')
    expect(snapshot).toContain('`read` — arguments: `{"path":"a.txt"}`')
    expect(snapshot).toContain('Result: file body')
    expect(snapshot).toContain('`bash` (executing)')
  })
})

describe('sideLabel', () => {
  it('prefixes and truncates', () => {
    expect(sideLabel('hello')).toBe('Side: hello')
    expect(sideLabel('  a   b ')).toBe('Side: a b')
    const long = 'x'.repeat(100)
    const label = sideLabel(long)
    expect(label.startsWith(SIDE_LABEL_PREFIX)).toBe(true)
    expect(label.length).toBeLessThanOrEqual(48)
    expect(label.endsWith('…')).toBe(true)
  })
})

describe('sideThreadRows', () => {
  const summary = (over: Partial<SidebarSessionSummary>): SidebarSessionSummary => ({
    id: 's1',
    displayTitle: 'x',
    ...over,
  })

  it('keeps only subagent-origin children of the session with the label prefix', () => {
    const byId: Record<string, SidebarSessionSummary> = {
      main: summary({ id: 'main', displayTitle: 'Main' }),
      thread: summary({ id: 'thread', origin: 'subagent', parentId: 'main', displayTitle: 'Side: q', running: true }),
      plainSubagent: summary({ id: 'plain', origin: 'subagent', parentId: 'main', displayTitle: 'Read files' }),
      foreignThread: summary({ id: 'foreign', origin: 'subagent', parentId: 'other', displayTitle: 'Side: other' }),
    }
    const rows = sideThreadRows(byId, 'main')
    expect(rows).toEqual([{ id: 'thread', title: 'Side: q', running: true }])
  })
})

describe('save eligibility', () => {
  const entry = (event: SidebarSessionEvent): SidebarHistoryEntry => ({ event })

  it('requires a completed turn after the seed boundary', () => {
    const seed = [ev('session/end-seed', 0)]
    expect(threadHasCompletedTurn([entry(seed[0]!)])).toBe(false)
    expect(threadHasCompletedTurn([entry(seed[0]!), entry(ev('user/message', 1, { content: [], source: { kind: 'user' } }))])).toBe(false)
    const withTurn = [...completedTurn(2, 1, { text: 'a' })]
    const entries = [entry(seed[0]!), ...withTurn.map(entry)]
    expect(threadHasCompletedTurn(entries)).toBe(true)
  })

  it('detects a trailing unanswered follow-up', () => {
    const entries = [
      ...completedTurn(2, 1, { text: 'a' }).map(entry),
      entry(ev('user/message', 9, { content: [], source: { kind: 'user' } })),
    ]
    expect(threadTrailingPending(entries)).toBe(true)
    expect(threadTrailingPending(completedTurn(2, 1, { text: 'a' }).map(entry))).toBe(false)
  })
})

describe('resolvePresetId', () => {
  it('prefers the newest selection event over the header', () => {
    const events = [ev('agent-preset/selected', 0, { agentPreset: 'later' })]
    expect(resolvePresetId({ agentPreset: 'early' }, events)).toBe('later')
    expect(resolvePresetId({ agentPreset: 'early' }, [])).toBe('early')
    expect(resolvePresetId({}, [])).toBeUndefined()
  })
})

describe('SIDE_BOUNDARY_PROMPT contract', () => {
  it('opens with the boundary prefix the transcript drops', () => {
    expect(SIDE_BOUNDARY_PROMPT.startsWith('Side conversation boundary')).toBe(true)
  })
})

describe('boundaryDelivered', () => {
  it('detects the boundary message and ignores everything else', () => {
    expect(boundaryDelivered([])).toBe(false)
    expect(boundaryDelivered([ev('user/message', 0, {
      content: [{ type: 'text', text: 'ordinary question' }],
    })])).toBe(false)
    // The inherited seed never contains a boundary: parent messages are
    // ordinary user rows.
    expect(boundaryDelivered([
      ev('user/message', 0, { content: [{ type: 'text', text: 'parent q' }] }),
      ev('user/message', 1, {
        content: [{ type: 'text', text: `${SIDE_BOUNDARY_PROMPT}\n\nfirst` }],
      }),
    ])).toBe(true)
    // Bare-string content is tolerated too.
    expect(boundaryDelivered([ev('user/message', 0, {
      content: `${SIDE_BOUNDARY_PROMPT}\n\nfirst`,
    })])).toBe(true)
  })
})
