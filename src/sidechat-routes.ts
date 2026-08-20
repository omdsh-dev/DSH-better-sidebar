/**
 * Side Chat routes of the /sidebar JSON API ('sidechat.start' /
 * 'sidechat.prompt' / 'sidechat.cancel' / 'sidechat.dispose').
 *
 * A side thread is a child session the plugin creates ITSELF with a custom
 * seed — the parent's full event log up to the click moment, honestly closed
 * at an in-progress turn (see sidechat-core.ts). The child is marked
 * `origin: 'subagent'` so the main session list hides it, and EVERY
 * operation goes through these routes because the generic session RPCs are
 * fenced away from subagent-origin identities (the api-remotes
 * agent-lookup ownership fence). No DSH source is touched:
 *
 * - creation uses the public AgentRegistry.create seam (the same one
 *   api-proxy's session.fork and the subagent fork provider use), with the
 *   parent's preset composition and provider/model selection so the child's
 *   first request shares the parent's token prefix (provider-side prefix
 *   cache reuse);
 * - the first prompt (boundary + question) and every follow-up are admitted
 *   with the stock `agent.followup`;
 * - a cold thread (DSH restart, or a closed thread) is resumed with
 *   AgentRegistry.resume, composing the preset the child recorded.
 */
import { randomUUID } from 'node:crypto'
import { createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, AgentSetup, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {
  Context,
  SidebarAgentPresetsService,
  SidebarSessionPersistenceService,
  SidebarSessionTitleService,
} from './context-types.ts'
import {
  buildSidechatInheritance,
  resolvePresetId,
  SIDE_BOUNDARY_PROMPT,
  sideLabel,
  type SidechatLogEvent,
} from './sidechat-core.ts'
import { requireString, SidebarError } from './wire.ts'

/** The four Side Chat routes of the sidebar API (wire method names). */
export interface SidechatRoutes {
  /** Create a side thread child seeded with the parent's log up to now. */
  'sidechat.start'(payload: unknown): Promise<{ childId: string }>
  /** Deliver one follow-up message to a thread (live, or cold-resumed). */
  'sidechat.prompt'(payload: unknown): Promise<{ accepted: true }>
  /** Abort the thread's running turn (queued work is preserved). */
  'sidechat.cancel'(payload: unknown): Promise<{ accepted: true }>
  /** Release the thread's live agent (session and history stay persisted). */
  'sidechat.dispose'(payload: unknown): Promise<{ accepted: true }>
}

/** Timeout guarding the create call (the registry detaches it before the
 *  handle becomes visible, so the child is never cancelled by it). */
const CREATE_TIMEOUT_MS = 15_000

/** Per-activation disposers of created thread agents (the dispose route
 *  releases them; the session and its history always stay persisted). */
const threadDisposers = new Map<string, () => Promise<void>>()

/** Resolve the parent's preset and build the child's composition setup
 *  (mirror of api-proxy's composeAgent minus the model-selection install —
 *  the child carries the parent's provider/model in agentOptions). */
async function composeChildSetup(
  ctx: Context,
  presetId: string | undefined,
): Promise<{ agentPreset?: string; setup: AgentSetup }> {
  const presets = ctx.get('agentPresets') as SidebarAgentPresetsService | undefined
  if (presets === undefined) {
    return { setup: () => Promise.resolve() }
  }
  const resolved = await presets.resolve(presetId)
  return {
    agentPreset: resolved.id,
    setup: async (agentCtx: CordisContext) => { await presets.mount(agentCtx, resolved.id) },
  }
}

/** Build the cold-resume setup from the thread's PERSISTED record (the
 *  recorded preset wins, newest selection event first). */
async function composePersistedSetup(
  ctx: Context,
  childId: string,
): Promise<AgentSetup> {
  const persistence = ctx.get('sessionPersistence') as SidebarSessionPersistenceService | undefined
  if (persistence === undefined) {
    return () => Promise.resolve()
  }
  const inspected = await persistence.inspect(childId)
  const presetId = resolvePresetId(inspected.meta, inspected.events)
  const presets = ctx.get('agentPresets') as SidebarAgentPresetsService | undefined
  if (presets === undefined || presetId === undefined) {
    return () => Promise.resolve()
  }
  const resolved = await presets.resolve(presetId)
  return async (agentCtx: CordisContext) => { await presets.mount(agentCtx, resolved.id) }
}

/** One text-block prompt (the thread boundary + question, or a follow-up). */
function textPrompt(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

/** Admit one user message to a live agent through the stock followup path. */
function admitFollowup(agent: Agent, blocks: ContentBlock[]): void {
  const message: UserMessage = createUserMessage({ content: blocks, source: { kind: 'user' } })
  agent.followup(message)
}

/** The live thread agent, or undefined (cold — the caller resumes). */
function liveThreadAgent(ctx: Context, childId: string): Agent | undefined {
  const agents = ctx.get('agents') as { get(id: string): Agent | undefined } | undefined
  return agents?.get(childId)
}

/** Build the Side Chat routes (all optional services degrade to a wire
 *  error the tab surfaces inline). The record keys are the FULL wire method
 *  names the /sidebar/api dispatcher looks up (`api[method]`). */
export function buildSidechatApi(ctx: Context): SidechatRoutes {
  return {
    'sidechat.start': async (payload: unknown) => {
      const sessionId = requireString(payload, 'sessionId')
      const question = requireString(payload, 'question').trim()
      if (question === '') {
        throw new SidebarError('bad-request', 'question is required')
      }
      const parent = liveThreadAgent(ctx, sessionId)
      if (parent === undefined) {
        throw new SidebarError('sidechat-error', `parent session "${sessionId}" is not running`, 409)
      }
      const parentSession = parent.session
      const inheritance = buildSidechatInheritance(
        parentSession.events as unknown as readonly SidechatLogEvent[],
      )
      const promptParts = [SIDE_BOUNDARY_PROMPT]
      if (inheritance.snapshot !== null) promptParts.push(inheritance.snapshot)
      promptParts.push(question)
      const { agentPreset, setup } = await composeChildSetup(
        ctx,
        resolvePresetId(parentSession.header, parentSession.events),
      )
      const childId = `session-${randomUUID()}` as SessionId
      const options: CreateAgentOptions = {
        sessionId: childId,
        meta: {
          ...(parentSession.header.cwd === undefined ? {} : { cwd: parentSession.header.cwd }),
          parentSession: parentSession.id,
          seedLength: inheritance.seed.length,
          origin: 'subagent',
          delegationDepth: (parentSession.header.delegationDepth ?? 0) + 1,
          ...(agentPreset === undefined ? {} : { agentPreset }),
        },
        ...(inheritance.seed.length > 0
          ? { seed: inheritance.seed as unknown as readonly SessionEvent[] }
          : {}),
        agentOptions: { ...parent.options },
        setup,
        signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
      }
      const agents = ctx.get('agents') as { create(options: CreateAgentOptions): Promise<{ agent: Agent; dispose(): Promise<void> }> } | undefined
      if (agents?.create === undefined) {
        throw new SidebarError('sidechat-error', 'the agents service is unavailable', 503)
      }
      let handle: { agent: Agent; dispose(): Promise<void> }
      try {
        handle = await agents.create(options)
      } catch (error) {
        throw new SidebarError('sidechat-error', `thread creation failed: ${error instanceof Error ? error.message : String(error)}`, 500)
      }
      threadDisposers.set(childId, () => handle.dispose())
      admitFollowup(handle.agent, textPrompt(promptParts.join('\n\n')))
      // Pin the thread label so the client can identify its threads by
      // title prefix (the rename is a live-session op, no RPC fence).
      const titles = ctx.get('sessionTitle') as SidebarSessionTitleService | undefined
      if (titles !== undefined) {
        try {
          titles.rename(handle.agent.session, sideLabel(question))
        } catch {
          // Keep the auto-generated title; the thread stays usable.
        }
      }
      return { childId }
    },

    'sidechat.prompt': async (payload: unknown) => {
      const childId = requireString(payload, 'childId')
      const text = requireString(payload, 'text').trim()
      if (text === '') {
        throw new SidebarError('bad-request', 'text is required')
      }
      let agent = liveThreadAgent(ctx, childId)
      if (agent === undefined) {
        // Cold thread: resume the persisted session under its recorded
        // composition, then deliver the follow-up.
        const agents = ctx.get('agents') as { resume(options: ResumeAgentOptions): Promise<{ agent: Agent; dispose(): Promise<void> }> } | undefined
        if (agents?.resume === undefined) {
          throw new SidebarError('sidechat-error', 'the agents service is unavailable', 503)
        }
        const setup = await composePersistedSetup(ctx, childId)
        try {
          const handle = await agents.resume({ resumeSessionId: childId as SessionId, setup })
          threadDisposers.set(childId, () => handle.dispose())
          agent = handle.agent
        } catch (error) {
          throw new SidebarError('sidechat-error', `thread resume failed: ${error instanceof Error ? error.message : String(error)}`, 500)
        }
      }
      admitFollowup(agent, textPrompt(text))
      return { accepted: true as const }
    },

    'sidechat.cancel': async (payload: unknown) => {
      const childId = requireString(payload, 'childId')
      const agent = liveThreadAgent(ctx, childId)
      if (agent !== undefined) {
        agent.cancel({ kind: 'user' }, { keepInbox: true })
      }
      return { accepted: true as const }
    },

    'sidechat.dispose': async (payload: unknown) => {
      const childId = requireString(payload, 'childId')
      const dispose = threadDisposers.get(childId)
      if (dispose !== undefined) {
        threadDisposers.delete(childId)
        try {
          await dispose()
        } catch {
          // The agent may already be gone (restart); the session persists.
        }
      }
      return { accepted: true as const }
    },
  }
}
