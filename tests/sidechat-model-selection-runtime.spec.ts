import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import {
  installSidechatModelRouting,
  recordSidechatSelection,
  sidechatModelSelectionRef,
  sidechatSelectionForMessage,
} from '../src/sidechat-model-selection.ts'

describe('Side Chat model selection runtime', () => {
  it('routes each assembled turn to its recorded model and writes the same request header', async () => {
    const session = Session.create(SessionId('session-sidechat-route-test'))
    const firstMessageId = 'message-model-a'
    recordSidechatSelection(session, {
      provider: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'high',
    }, firstMessageId)

    const firstSelection = sidechatSelectionForMessage(session.snapshotEvents(), firstMessageId)
    expect(firstSelection).toEqual({ provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' })
    const selection = sidechatModelSelectionRef(firstSelection)
    const ctx = new Context()
    const agent = { session } as Agent
    installSidechatModelRouting(ctx, agent, selection)

    const assemble = async () => ctx.waterfall(
      'system-prompt/assemble',
      { sections: [], contexts: [], tools: [], variables: {} },
      { signal: new AbortController().signal },
      async () => ({ sections: [], contexts: [], tools: [], variables: { provider: 'deployment-default', model: 'deployment-model' } }),
    )
    const request = async () => ctx.waterfall(
      'agent/request',
      { agent, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'deployment-default', model: 'deployment-model', reasoningEffort: ReasoningEffortId('low'), maxTokens: 1200 }),
    )

    await assemble()
    const firstRequest = await request()
    session.append('request/header', { header: { config: firstRequest as LlmCallConfig }, reason: 'initial' })
    expect(firstRequest).toMatchObject({ provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' })
    expect(session.snapshotEvents().at(-1)).toMatchObject({
      type: 'request/header',
      data: { header: { config: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' } } },
    })

    const secondMessage = createUserMessage({ content: [{ type: 'text', text: 'second turn' }], source: { kind: 'user' } })
    recordSidechatSelection(session, { provider: 'provider-b', model: 'model-b' }, secondMessage.id)
    const secondSelection = sidechatSelectionForMessage(session.snapshotEvents(), secondMessage.id)
    if (secondSelection === undefined) throw new Error('the queued model selection was not persisted')
    ctx.emit('agent/inbox/claimed', {
      agent,
      message: secondMessage,
      turn: 2,
    })
    await assemble()
    const secondRequest = await request()
    session.append('request/header', { header: { config: secondRequest as LlmCallConfig }, reason: 'change' })
    expect(secondRequest).toMatchObject({ provider: 'provider-b', model: 'model-b' })
    expect(secondRequest).not.toHaveProperty('reasoningEffort')
    expect(session.snapshotEvents().at(-1)).toMatchObject({
      type: 'request/header',
      data: { header: { config: { provider: 'provider-b', model: 'model-b' } } },
    })

  })
})
