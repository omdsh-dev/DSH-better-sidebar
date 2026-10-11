import type { ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { installModelSelection, type Agent } from '@deepseek-ai/dsh-agent'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { parseSidechatModelSelection, threadOwnLogEvents, type SidechatLogEvent, type SidechatModelSelection } from './sidechat-core.ts'

/** 创建单个 Side Chat Agent 使用的 DSH 模型选择引用。 */
export function sidechatModelSelectionRef(selection: SidechatModelSelection | undefined): ModelSelectionRef {
  const current = selection === undefined
    ? undefined
    : {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort as ModelSelection['reasoningEffort'] }),
    }
  return { current, assembled: current }
}

/** 根据消息 ID 保存的模型路由设置被领取消息的选择。 */
export function installSidechatModelRouting(agentCtx: CordisContext, agent: Agent, selection: ModelSelectionRef): void {
  installModelSelection(agentCtx, selection)
  agentCtx.on('agent/inbox/claimed', ({ message }) => {
    const route = sidechatSelectionForMessage(
      threadOwnLogEvents(agent.session.snapshotEvents() as unknown as readonly SidechatLogEvent[]),
      message.id,
    )
    if (route === undefined) return
    selection.current = {
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }),
    }
  })
}

interface SidechatSelectionMetadata {
  messageId?: unknown
}

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'model/selection': ModelSelection & {
      sidechat?: {
        messageId: string
      }
    }
  }
}

/** 读取一条 Side Chat 消息入队时保存的 provider、model 与 reasoning effort。 */
export function sidechatSelectionForMessage(
  events: readonly SidechatLogEvent[],
  messageId: string,
): SidechatModelSelection | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'model/selection') continue
    const data = event.data as Record<string, unknown>
    const metadata = data.sidechat as SidechatSelectionMetadata | undefined
    if (metadata?.messageId !== messageId) continue
    return parseSidechatModelSelection(data)
  }
  return undefined
}

/** 在消息进入 inbox 前，保存该消息独立的模型路由记录。 */
export function recordSidechatSelection(
  session: Session,
  selection: SidechatModelSelection,
  messageId: string,
): void {
  const data = {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }),
    sidechat: { messageId },
  }
  session.append('model/selection', data)
}
