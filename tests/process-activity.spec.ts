/**
 * The ported main-agent process fold: category mapping, live-detail
 * extraction, and the range cut (`foldProcess`). These pin the parity claims
 * the live route and the Tasks page cards rest on, so a later host change
 * shows up as a red test rather than a silently different label.
 */
import { describe, expect, it } from 'vitest'
import {
  PROCESS_DETAIL_MAX_CHARS,
  PROCESS_TEXT_MAX_CHARS,
  activityOf,
  contentText,
  foldProcess,
  liveToolDetail,
  type ProcessActivity,
} from '../src/process-activity.ts'
import type { SidebarSessionEvent } from '../src/context-types.ts'

/** One raw session event. */
const entry = (type: string, data: Record<string, unknown>, seq = 0, time = 0): SidebarSessionEvent => ({
  type, seq, time, data,
})

/** A `tool/call` event. */
const call = (callId: string, name: string, args = '{}', seq = 0, time = 0): SidebarSessionEvent =>
  entry('tool/call', { callId, name, arguments: args }, seq, time)

/** A `tool/result` event paired by callId (0.1.7's tool-role message shape). */
const result = (callId: string, seq = 0, time = 0): SidebarSessionEvent =>
  entry('tool/result', { message: { source: { kind: 'tool', callId }, content: [{ type: 'text', text: 'ok' }] } }, seq, time)

/** An assistant message carrying text and/or announced tool-call blocks. */
const assistant = (content: unknown[], seq = 0, time = 0): SidebarSessionEvent =>
  entry('assistant/message', { turn: 1, step: 1, message: { content } }, seq, time)

/** A user message (a range boundary). */
const user = (text = 'continue', seq = 0, time = 0): SidebarSessionEvent =>
  entry('user/message', { content: [{ type: 'text', text }] }, seq, time)

describe('process activity: the host category map, verbatim', () => {
  const cases: [string, ProcessActivity][] = [
    ['read', 'read'],
    ['read_image', 'readImage'],
    ['grep', 'search'],
    ['glob', 'search'],
    ['bash_inspect', 'search'],
    ['write', 'write'],
    ['edit', 'edit'],
    ['apply_patch', 'edit'],
    ['bash', 'commands'],
    ['pwsh', 'commands'],
    ['exec_command', 'commands'],
    ['write_stdin', 'commands'],
    ['terminal_send', 'commands'],
    ['run_code', 'code'],
    ['web_search', 'webSearch'],
    ['web_fetch', 'webFetch'],
    ['subagent', 'subagents'],
    ['subagent_control', 'subagents'],
    ['todo_write', 'plan'],
    ['create_goal', 'plan'],
    ['update_goal', 'plan'],
    ['get_goal', 'plan'],
    ['ask_user_question', 'questions'],
    ['request_user_input', 'questions'],
    ['something_else', 'tools'],
    ['', 'tools'],
  ]
  for (const [name, kind] of cases) {
    it(`${name || '(empty)'} → ${kind}`, () => {
      expect(activityOf(name)).toBe(kind)
    })
  }
})

describe('process activity: live tool detail', () => {
  it('takes the first present key of the host priority list', () => {
    expect(liveToolDetail('bash', JSON.stringify({ command: 'npm test', path: 'x' }))).toBe('npm test')
    // `title` beats `command` because it is earlier in the host's list.
    expect(liveToolDetail('bash', JSON.stringify({ command: 'a', title: 'Build' }))).toBe('Build')
  })

  it('joins string arrays and reads the first question', () => {
    expect(liveToolDetail('grep', JSON.stringify({ queries: ['one', 'two'] }))).toBe('one, two')
    expect(liveToolDetail('ask_user_question', JSON.stringify({
      questions: [{ question: 'first?' }, { question: 'second?' }],
    }))).toBe('first?')
  })

  it('collapses whitespace and truncates on a grapheme boundary', () => {
    const long = 'a'.repeat(PROCESS_DETAIL_MAX_CHARS + 40)
    const detail = liveToolDetail('bash', JSON.stringify({ command: long }))
    expect(detail.endsWith('…')).toBe(true)
    expect(Array.from(detail).length).toBe(PROCESS_DETAIL_MAX_CHARS)
    expect(liveToolDetail('bash', JSON.stringify({ command: 'a\n\n  b\tc' }))).toBe('a b c')
  })

  it('falls back to the tool name for unusable arguments', () => {
    expect(liveToolDetail('bash', 'not json')).toBe('bash')
    expect(liveToolDetail('bash', '"scalar"')).toBe('bash')
    expect(liveToolDetail('bash', JSON.stringify({ unknownKey: 'x' }))).toBe('bash')
    expect(liveToolDetail('bash', '')).toBe('bash')
  })
})

describe('process activity: content text', () => {
  it('joins text blocks and ignores everything else', () => {
    expect(contentText([{ type: 'text', text: 'hello' }, { type: 'tool-call', id: 'c' }])).toBe('hello')
    expect(contentText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb')
    expect(contentText(undefined)).toBeUndefined()
    expect(contentText('nope')).toBeUndefined()
  })
})

describe('process activity: the range fold', () => {
  it('returns an empty summary for an empty log', () => {
    expect(foldProcess([], { live: true })).toEqual({ current: { counts: [], runningDetail: '' } })
  })

  it('counts distinct calls per category and ranks by count', () => {
    const fold = foldProcess([
      user('go', 1, 10),
      call('c1', 'read', '{"path":"a"}', 2, 11),
      call('c2', 'read', '{"path":"b"}', 3, 12),
      call('c3', 'bash', '{"command":"ls"}', 4, 13),
    ], { live: true })
    expect(fold.current.counts).toEqual([{ kind: 'read', count: 2 }, { kind: 'commands', count: 1 }])
  })

  it('breaks count ties by first appearance', () => {
    const fold = foldProcess([
      call('c1', 'bash', '{}', 1, 1),
      call('c2', 'read', '{}', 2, 2),
    ], { live: true })
    expect(fold.current.counts).toEqual([{ kind: 'commands', count: 1 }, { kind: 'read', count: 1 }])
  })

  it('reports the newest unsettled call as running, with its detail', () => {
    const fold = foldProcess([
      call('c1', 'bash', '{"command":"npm test"}', 1, 1),
      result('c1', 2, 2),
      call('c2', 'grep', '{"pattern":"host"}', 3, 3),
    ], { live: true })
    expect(fold.current.running).toBe('search')
    expect(fold.current.runningDetail).toBe('host')
    expect(fold.current.counts).toEqual([{ kind: 'commands', count: 1 }, { kind: 'search', count: 1 }])
  })

  it('reports no running tool once the session settled (the host closed group)', () => {
    const fold = foldProcess([call('c1', 'bash', '{"command":"ls"}', 1, 1)], { live: false })
    expect(fold.current.running).toBeUndefined()
    expect(fold.current.runningDetail).toBe('')
    expect(fold.current.counts).toEqual([{ kind: 'commands', count: 1 }])
  })

  it('counts and flags a call the model announced but never dispatched', () => {
    const fold = foldProcess([
      user('go', 1, 5),
      assistant([{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }], 2, 6),
    ], { live: true })
    expect(fold.current.counts).toEqual([{ kind: 'commands', count: 1 }])
    expect(fold.current.running).toBe('commands')
    expect(fold.current.preparing).toBe(true)
    // The host shows no detail while preparing (the name only for `tools`).
    expect(fold.current.runningDetail).toBe('')
    expect(foldProcess([
      assistant([{ type: 'tool-call', id: 'c1', name: 'mystery_tool' }], 2, 6),
    ], { live: true }).current.runningDetail).toBe('mystery_tool')
  })

  it('does not double count an announced call that was dispatched and settled', () => {
    const fold = foldProcess([
      user('go', 1, 5),
      assistant([{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a"}' }], 2, 6),
      call('c1', 'read', '{"path":"a"}', 3, 7),
      result('c1', 4, 8),
    ], { live: true })
    expect(fold.current.counts).toEqual([{ kind: 'read', count: 1 }])
    expect(fold.current.running).toBeUndefined()
  })

  it('stops at the newest range boundary and keeps the newest text', () => {
    // The stale read lives in the PREVIOUS range: a reply ended it.
    const fold = foldProcess([
      user('go', 1, 10),
      call('c1', 'read', '{"path":"old"}', 2, 11),
      assistant([{ type: 'text', text: 'first answer' }], 3, 12),
      call('c2', 'bash', '{"command":"npm test"}', 4, 13),
      assistant([{ type: 'text', text: 'second answer' }], 5, 14),
    ], { live: false })
    expect(fold.current.counts).toEqual([{ kind: 'commands', count: 1 }])
    expect(fold.text).toBe('second answer')
    expect(fold.lastEventTime).toBe(14)
  })

  it('falls back to the previous range when the newest one is empty', () => {
    // The child replied and then did nothing: reporting the empty newest range
    // would show "nothing happened" for a node that just did real work.
    const fold = foldProcess([
      user('go', 1, 10),
      call('c1', 'read', '{"path":"a"}', 2, 11),
      call('c2', 'bash', '{"command":"npm test"}', 3, 12),
      assistant([{ type: 'text', text: 'all green' }], 4, 13),
    ], { live: false })
    // Forwards order is read → bash, so the tie ranks read first.
    expect(fold.current.counts).toEqual([{ kind: 'read', count: 1 }, { kind: 'commands', count: 1 }])
    expect(fold.text).toBe('all green')
    // The fallback range is CLOSED: it can never report a running tool.
    expect(fold.current.running).toBeUndefined()
  })

  it('never reports the fallback range as running even while the session lives', () => {
    const fold = foldProcess([
      call('c1', 'bash', '{"command":"npm test"}', 1, 1),
      assistant([{ type: 'text', text: 'done with that' }], 2, 2),
    ], { live: true })
    expect(fold.current.counts).toEqual([{ kind: 'commands', count: 1 }])
    expect(fold.current.running).toBeUndefined()
  })

  it('gives up after one empty range instead of scanning the whole log', () => {
    const events = [
      call('ancient', 'read', '{"path":"old"}', 1, 1),
      assistant([{ type: 'text', text: 'first' }], 2, 2),
      assistant([{ type: 'text', text: 'second' }], 3, 3),
      assistant([{ type: 'text', text: 'third' }], 4, 4),
    ]
    // Two replies in a row leave TWO empty ranges before the ancient call; the
    // fold stops after the first empty one and reports an empty summary.
    const fold = foldProcess(events, { live: false })
    expect(fold.current.counts).toEqual([])
    expect(fold.text).toBe('third')
  })

  it('stops the backward scan at the event cap', () => {
    const events: SidebarSessionEvent[] = []
    for (let index = 0; index < 900; index += 1) {
      events.push(call(`c${index}`, 'read', `{"path":"${index}"}`, index, index))
    }
    const fold = foldProcess(events, { live: true })
    expect(fold.current.counts[0]?.count).toBeLessThan(900)
    expect(fold.current.counts[0]?.kind).toBe('read')
  })

  it('caps the text line without splitting the ellipsis', () => {
    const long = 'x'.repeat(PROCESS_TEXT_MAX_CHARS + 30)
    const fold = foldProcess([assistant([{ type: 'text', text: long }], 1, 1)], { live: false })
    expect(Array.from(fold.text ?? '').length).toBe(PROCESS_TEXT_MAX_CHARS)
    expect(fold.text?.endsWith('…')).toBe(true)
  })
})
