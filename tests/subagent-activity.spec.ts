import { describe, expect, it } from 'vitest'
import { contentText, lastActivity } from '../src/subagent-activity.ts'
import type { SidebarSessionEvent } from '../src/context-types.ts'

describe('subagent activity summary parser', () => {
  /** One raw session event. */
  const entry = (type: string, data: Record<string, unknown>): SidebarSessionEvent => ({
    type, seq: 0, time: 0, data,
  })

  it('extracts text blocks and skips non-text content', () => {
    // Text blocks join as paragraphs (newline-separated).
    expect(contentText([{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }])).toBe('hello\n world')
    expect(contentText([{ type: 'tool_use', name: 'bash' }])).toBeUndefined()
    expect(contentText(undefined)).toBeUndefined()
    expect(contentText('nope')).toBeUndefined()
  })

  it('lastActivity returns the LAST text output and the LAST tool call', () => {
    const live = lastActivity([
      entry('turn/start', { turn: 1 }),
      entry('user/message', { content: [{ type: 'text', text: '请检查代码' }] }),
      entry('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"ls -la"}' }),
      entry('assistant/message', {
        turn: 1, step: 1,
        message: { content: [{ type: 'text', text: '检查完毕' }] },
      }),
      entry('tool/call', { callId: 'c2', name: 'read', arguments: '{"path":"a.ts"}' }),
      entry('assistant/message', {
        turn: 1, step: 2,
        message: { content: [{ type: 'text', text: '再看一眼' }] },
      }),
    ])
    expect(live).toEqual({
      text: '再看一眼',
      tool: { name: 'read', args: '{"path":"a.ts"}' },
    })
  })

  it('lastActivity keeps only the fields the log actually has', () => {
    expect(lastActivity([
      entry('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }),
    ])).toEqual({ tool: { name: 'bash', args: '{"command":"ls"}' } })
    expect(lastActivity([
      entry('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'ok' }] } }),
    ])).toEqual({ text: 'ok' })
  })

  it('lastActivity ignores lifecycle events, chunks, and text-less messages', () => {
    const live = lastActivity([
      entry('turn/end', { turn: 1, reason: 'success' }),
      entry('step/start', { turn: 1, step: 1 }),
      entry('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text', delta: 'x' } }),
      entry('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'tool_use', name: 'bash' }] } }),
    ])
    expect(live).toEqual({})
    expect(lastActivity([])).toEqual({})
  })

  it('lastActivity defaults a missing tool name and tolerates non-string arguments', () => {
    const live = lastActivity([
      entry('tool/call', { callId: 'c1' }),
      entry('tool/call', { callId: 'c2', name: 'web', arguments: { url: 'x' } }),
    ])
    expect(live.tool).toEqual({ name: 'web', args: '' })
  })

  it('lastActivity window excludes activity older than the last maxMessages messages', () => {
    // One stale tool call before the window: with maxMessages=1 only the
    // latest message (and the events around it) are considered.
    expect(lastActivity([
      entry('tool/call', { callId: 'stale', name: 'bash', arguments: '{"command":"old"}' }),
      entry('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'new text' }] } }),
    ], 1)).toEqual({ text: 'new text' })

    // The same log with a wider window surfaces the tool call again.
    expect(lastActivity([
      entry('tool/call', { callId: 'stale', name: 'bash', arguments: '{"command":"old"}' }),
      entry('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'new text' }] } }),
    ], 2)).toEqual({
      text: 'new text',
      tool: { name: 'bash', args: '{"command":"old"}' },
    })

    // Non-message events (tool calls) do not consume quota, but once the
    // window holds its messages, older events are dropped even without an
    // older message to stop at: the second message pushes the tool call out.
    expect(lastActivity([
      entry('tool/call', { callId: 'stale', name: 'bash', arguments: '{"command":"old"}' }),
      entry('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'first' }] } }),
      entry('user/message', { content: [{ type: 'text', text: '继续' }] }),
    ], 1)).toEqual({})

    // A tool call between the two in-window messages stays visible.
    expect(lastActivity([
      entry('tool/call', { callId: 'stale', name: 'bash', arguments: '{"command":"old"}' }),
      entry('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'first' }] } }),
      entry('tool/call', { callId: 'fresh', name: 'read', arguments: '{"path":"a.ts"}' }),
      entry('user/message', { content: [{ type: 'text', text: '继续' }] }),
    ], 2)).toEqual({
      text: 'first',
      tool: { name: 'read', args: '{"path":"a.ts"}' },
    })
  })
})
