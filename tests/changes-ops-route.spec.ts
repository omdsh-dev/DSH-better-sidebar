import { Context as CordisContext } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { createChangesOpsApi } from '../src/changes-ops.ts'
import type { Context } from '../src/context-types.ts'

describe('changes.ops 等待请求', () => {
  it('空窗请求保持等待，并及时返回序号为 0 的真实会话事件', async () => {
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

  it('客户端断开连接后结束空窗等待', async () => {
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
