import { describe, expect, it } from 'vitest'
import { contentText, lastActivity } from '../src/client/subagent-activity.ts'
import type { SidebarHistoryEntry } from '../src/context-types.ts'

describe('subagent activity summary parser', () => {
  /** One history entry from raw event fields. */
  const entry = (type: string, data: Record<string, unknown>): SidebarHistoryEntry => ({
    event: { type, seq: 0, time: 0, data },
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

  it('lastActivity keeps only the fields the tail actually has', () => {
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
})
