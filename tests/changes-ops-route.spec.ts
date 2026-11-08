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

  // The PTC sub-call pair (`tool/ptc-dispatch-start` + `tool/ptc-dispatch`) can
  // no longer be produced here: DSH 0.2.2 dropped both from the session event
  // TYPE map and from the store's append registry, so `SessionStore.append`
  // rejects them outright. The READER still has to understand them — logs
  // recorded on 0.2.1 keep those events, and `dsh-session`'s known-event-types
  // table still names them — but that contract belongs to the fold, which is
  // fed synthetic events directly in `tests/changes-ops.spec.ts` ("keeps PTC
  // sub-calls ..."). This route-level copy tested the store, not our filter, so
  // it is gone rather than faked.

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
