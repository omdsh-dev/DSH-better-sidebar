import { Context as CordisContext } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { createChangesOpsApi } from '../src/changes-ops.ts'
import type { Context } from '../src/context-types.ts'

describe('changes.ops waiting form', () => {
  it('parks an empty window and answers a real seq-0 event promptly', async () => {
    const runtime = new CordisContext()
    const fiber = await runtime.plugin(SessionStore)
    const session = runtime.sessions.create()
    const changesOps = createChangesOpsApi(runtime as Context)
    try {
      const baseline = await changesOps({ sessionId: session.id })
      expect(baseline).toEqual({ events: [], lastSeq: -1 })

      let settled = false
      const waiting = changesOps({ sessionId: session.id, afterSeq: -1, wait: true }).then(result => {
        settled = true
        return result
      })
      await new Promise(resolve => setTimeout(resolve, 2_600))
      expect(settled).toBe(false)

      const appendedAt = Date.now()
      session.append('tool/call', {
        turn: 0,
        step: 0,
        callId: ToolCallId('first-call'),
        name: 'write',
        arguments: JSON.stringify({ file_path: 'hello.txt', content: 'hello' }),
      })
      const answer = await waiting
      expect(Date.now() - appendedAt).toBeLessThan(1_000)
      expect(answer.events.map(event => [event.seq, event.type])).toEqual([[0, 'tool/call']])
      expect(answer.lastSeq).toBe(0)
      expect(await changesOps({ sessionId: session.id, afterSeq: 0 })).toEqual({ events: [], lastSeq: 0 })
    } finally {
      await fiber.dispose()
    }
  })

  it('ships the PTC sub-call pair, not just the plain tool pair', async () => {
    const runtime = new CordisContext()
    const fiber = await runtime.plugin(SessionStore)
    const session = runtime.sessions.create()
    const changesOps = createChangesOpsApi(runtime as Context)
    try {
      const at = () => ({
        turn: 0,
        step: 0,
        rootCallId: ToolCallId('root'),
        parentCallId: ToolCallId('root'),
        subCallId: ToolCallId('root:ptc:1'),
        name: 'write',
      })
      session.append('tool/ptc-dispatch-start', { ...at(), arguments: { file_path: 'notes.txt', content: 'x' } })
      session.append('tool/ptc-dispatch', {
        ...at(),
        arguments: { file_path: 'notes.txt', content: 'x' },
        isError: false,
        content: [{ type: 'text', text: 'written' }],
      })
      const answer = await changesOps({ sessionId: session.id })
      expect(answer.events.map(event => event.type))
        .toEqual(['tool/ptc-dispatch-start', 'tool/ptc-dispatch'])
    } finally {
      await fiber.dispose()
    }
  })

  it('ends the empty-window wait when the client disconnects', async () => {
    const runtime = new CordisContext()
    const fiber = await runtime.plugin(SessionStore)
    const session = runtime.sessions.create()
    const changesOps = createChangesOpsApi(runtime as Context)
    const controller = new AbortController()
    try {
      const waiting = changesOps({ sessionId: session.id, afterSeq: -1, wait: true }, controller.signal)
      controller.abort()
      expect(await waiting).toEqual({ events: [], lastSeq: -1 })
    } finally {
      await fiber.dispose()
    }
  })
})
