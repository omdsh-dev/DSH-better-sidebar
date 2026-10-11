/**
 * Side Chat routes of the /sidebar JSON API ('sidechat.start' /
 * 'sidechat.prompt' / 'sidechat.cancel' / 'sidechat.dispose' /
 * 'sidechat.info' / 'sidechat.events').
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
import { createUserMessage, ReasoningEffortId, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import { type Agent, type AgentSetup, type CreateAgentOptions, type ModelSelectionRef, type ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type {
  Context,
  SidebarAgentPresetsService,
  SidebarSessionPersistenceService,
  SidebarSessionTitleService,
} from './context-types.ts'
import {
  boundaryDelivered,
  buildSidechatInheritance,
  liveEventsOf,
  parseSidechatModelSelection,
  parentModelSelection,
  resolvePresetId,
  SIDE_BOUNDARY_PROMPT,
  SIDE_INJECTION_SOURCE_KIND,
  SIDE_NEW_THREAD_TITLE,
  sideLabel,
  type SeedEvent,
  type SidechatLiveEvent,
  type SidechatLogEvent,
  type SidechatModelSelection,
  type SidechatThreadInfo,
  threadOwnLogEvents,
} from './sidechat-core.ts'
import type { AssistantLiveBuffer } from './assistant-live.ts'
import { requireString, SidebarError } from './wire.ts'
import { readPersistedSession, readPersistedSessionOf } from './session-store.ts'
import {
  recordSidechatSelection,
  installSidechatModelRouting,
  sidechatModelSelectionRef,
} from './sidechat-model-selection.ts'

/**
 * The plugin's producer-owned message source kind. Message sources are a
 * merge-extensible sum type — DSH 0.1.7 has no shared catch-all `plugin`
 * kind, so every producer declares its own in its own module (the same
 * `declare module` seam dsh-time-context / dsh-tmux-context use). The kind
 * itself is {@link SIDE_INJECTION_SOURCE_KIND}: exactly the `plugin:<name>`
 * value DSH's own v3→v4 migration derives for the rows this plugin wrote
 * under 0.1.6, so old and new logs carry one shape.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Side-chat context injection (boundary prompt + parked in-progress snapshot). */
    'dsh-better-sidebar': { kind: typeof SIDE_INJECTION_SOURCE_KIND }
  }
}

/** The six Side Chat routes of the sidebar API (wire method names). */
export interface SidechatRoutes {
  /** Create a side thread child seeded with the parent's log up to now.
   *  `question` is optional: empty creates an EMPTY thread (Codex-style
   *  immediate create); the first `sidechat.prompt` then carries the
   *  boundary + snapshot and earns the thread its real label. */
  'sidechat.start'(payload: unknown): Promise<{ childId: string }>
  /** Deliver one follow-up message to a thread (live, or cold-resumed). */
  'sidechat.prompt'(payload: unknown): Promise<{ accepted: true }>
  /** Abort the thread's running turn (queued work is preserved). */
  'sidechat.cancel'(payload: unknown): Promise<{ accepted: true }>
  /** Release the thread's live agent (session and history stay persisted). */
  'sidechat.dispose'(payload: unknown): Promise<{ accepted: true }>
  /** Live state + agent identity for the thread header. */
  'sidechat.info'(payload: unknown): Promise<SidechatThreadInfo>
  /** The thread's OWN transcript events, seed-cut host-side (the inherited
   *  parent log never crosses the wire); `afterSeq` narrows the response to
   *  the delta beyond it (poll tail). `live` carries the thread's in-flight
   *  model deltas, which DSH 0.1.5 publishes outside the session log — it is
   *  the CURRENT attempt's rows on every poll, never a delta. */
  'sidechat.events'(payload: unknown): Promise<{ events: SidechatLogEvent[]; live: SidechatLiveEvent[] }>
}

/** Timeout guarding the create call (the registry detaches it before the
 *  handle becomes visible, so the child is never cancelled by it). */
const CREATE_TIMEOUT_MS = 15_000

/** Head cap of one `sidechat.events` response (the ceiling the old
 *  client-side walk could load: 40 pages × 200 events). A pathological
 *  thread beyond it renders its tail window — the same degradation the
 *  capped walk had, never a failed poll. */
const EVENTS_CAP = 8_000

/** Per-activation disposers of created thread agents (the dispose route
 *  releases them; the session and its history always stay persisted). */
const threadDisposers = new Map<string, () => Promise<void>>()

/** The in-progress-turn snapshot captured at creation of an EMPTY thread,
 *  waiting to ride the first prompt (lost on a host restart — the boundary
 *  prompt is then delivered alone, a logged degradation). */
const pendingSnapshots = new Map<string, string>()

const threadOperations = new Map<string, Promise<void>>()

/** 按子线程顺序确定消息模型并提交消息。
 *
 * @param childId - Side Chat 子线程标识
 * @param operation - 需要按顺序执行的操作
 * @returns 操作结果
 */
async function withSidechatThreadOperation<T>(childId: string, operation: () => Promise<T>): Promise<T> {
  const previous = threadOperations.get(childId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  threadOperations.set(childId, current)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (threadOperations.get(childId) === current) threadOperations.delete(childId)
  }
}

/** Resolve the parent's preset and install the thread-local model routing. */
async function composeChildSetup(
  ctx: Context,
  presetId: string | undefined,
  modelSelection: ModelSelectionRef,
): Promise<{ agentPreset?: string; setup: AgentSetup }> {
  const presets = ctx.get('agentPresets') as SidebarAgentPresetsService | undefined
  const resolved = presets === undefined ? undefined : await presets.resolve(presetId)
  return {
    ...(resolved === undefined ? {} : { agentPreset: resolved.id }),
    setup: async (agentCtx: CordisContext, agent: Agent) => {
      if (resolved !== undefined && presets !== undefined) await presets.mount(agentCtx, resolved.id)
      installSidechatModelRouting(agentCtx, agent, modelSelection)
    },
  }
}

/** 根据子线程记录与父会话当前模型构造恢复时使用的 setup。 */
async function composePersistedSetup(
  ctx: Context,
  childId: string,
): Promise<AgentSetup> {
  const persistence = ctx.get('sessionPersistence') as SidebarSessionPersistenceService | undefined
  if (persistence === undefined) {
    return () => Promise.resolve()
  }
  const inspected = await readPersistedSession(persistence, childId)
  const presetId = resolvePresetId(inspected.header, inspected.events)
  const parentSessionId = typeof inspected.header.parentSession === 'string' ? inspected.header.parentSession : undefined
  const ownEvents = threadOwnLogEvents(inspected.events as unknown as readonly SidechatLogEvent[])
  const parentSelection = parentSessionId === undefined ? undefined : await parentModelSelectionOf(ctx, parentSessionId)
  const initialSelection = parentSelection ?? parentModelSelection(ownEvents) ?? parseSidechatModelSelection({
    provider: inspected.header.provider,
    model: inspected.header.model,
    reasoningEffort: inspected.header.reasoningEffort,
  })
  return (await composeChildSetup(ctx, presetId, sidechatModelSelectionRef(initialSelection))).setup
}

/** 读取 Agent 尚无请求记录时使用的当前部署默认模型。 */
function defaultModelSelectionOf(ctx: Context): SidechatModelSelection | undefined {
  const service = ctx.get('agentDefaultModel') as { currentSelection(): unknown } | undefined
  return parseSidechatModelSelection(service?.currentSelection())
}

/** 父会话当前模型不可读时，读取旧子线程自身保存的模型路由。 */
function agentModelSelectionOf(agent: Agent): SidechatModelSelection | undefined {
  return parseSidechatModelSelection({
    provider: agent.options.provider,
    model: agent.options.model,
    reasoningEffort: agent.options.reasoningEffort,
  })
}

/** 按照 DSH 的顺序读取父会话当前有效模型。 */
async function parentModelSelectionOf(ctx: Context, parentSessionId: string): Promise<SidechatModelSelection | undefined> {
  const parent = liveThreadAgent(ctx, parentSessionId)
  if (parent !== undefined) return liveParentModelSelectionOf(ctx, parent)
  const inspected = await readPersistedSessionOf(ctx, parentSessionId)
  if (inspected === undefined) return undefined
  return parentModelSelection(inspected.events as unknown as readonly SidechatLogEvent[])
    ?? defaultModelSelectionOf(ctx)
}

/** 按 DSH 的 projection、请求记录和部署默认模型读取实时父会话选择。 */
function liveParentModelSelectionOf(ctx: Context, parent: Agent): SidechatModelSelection | undefined {
  const projectionService = ctx.get('sessionProjections') as {
    stateOf(session: Agent['session'], key: string): unknown
  } | undefined
  const projection = projectionService?.stateOf(parent.session, 'modelSelection') as { pending?: unknown } | undefined
  const pending = parseSidechatModelSelection(projection?.pending)
  if (pending !== undefined) return pending

  if (projection !== undefined) {
    const requestHeader = parent.session.requestHeader() as {
      config?: unknown
      adapterDefaults?: { reasoningEffort?: unknown }
    } | undefined
    const requestSelection = parseSidechatModelSelection(requestHeader?.config)
    if (requestSelection !== undefined) {
      return requestHeader?.adapterDefaults?.reasoningEffort === true || requestSelection.reasoningEffort === undefined
        ? { provider: requestSelection.provider, model: requestSelection.model }
        : requestSelection
    }
    return defaultModelSelectionOf(ctx) ?? agentModelSelectionOf(parent)
  }

  const events = parent.session.snapshotEvents() as unknown as readonly SidechatLogEvent[]
  return parentModelSelection(events) ?? defaultModelSelectionOf(ctx) ?? agentModelSelectionOf(parent)
}

/** Create and record the model route for one prompt before it enters the inbox. */
async function createRoutedSidechatMessage(ctx: Context, agent: Agent, text: string): Promise<UserMessage> {
  const parentSessionId = typeof agent.session.header.parentSession === 'string'
    ? agent.session.header.parentSession
    : undefined
  const ownEvents = threadOwnLogEvents(agent.session.snapshotEvents() as unknown as readonly SidechatLogEvent[])
  const selection = (parentSessionId === undefined ? undefined : await parentModelSelectionOf(ctx, parentSessionId))
    ?? parentModelSelection(ownEvents)
    ?? agentModelSelectionOf(agent)
  if (selection === undefined) {
    throw new SidebarError(
      'sidechat-error',
      `parent model selection is unavailable for thread "${agent.id}"`,
      409,
    )
  }
  const message = createUserMessage({ content: textPrompt(text), source: { kind: 'user' } })
  recordSidechatSelection(agent.session, selection, message.id)
  return message
}

/** One text-block prompt (the thread boundary + question, or a follow-up). */
function textPrompt(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

/** Admit one user message to a live agent through the stock followup path. */
function admitFollowup(agent: Agent, message: UserMessage): void {
  agent.followup(message)
}

/**
 * Deliver the thread's FIRST contact as TWO log-separated messages: the
 * boundary prompt (+ the parked in-progress snapshot) rides `agent.inject`
 * — queued model-facing context that does NOT wake the driver and is
 * claimed FIRST at the opening step (Inbox.claim drains next-step before
 * next-turn) — and the user's question is the follow-up that wakes it. The
 * log therefore records two user/message events (injection, then question)
 * instead of one wrapped blob: the transcript shows the question as a user
 * bubble and collapses the injection as a context row. The injection source
 * carries the plugin's producer-owned kind (`plugin:dsh-better-sidebar` —
 * session format v4 refuses the retired bare `kind: 'plugin'`) so recognition
 * is structural; its text still opens with SIDE_BOUNDARY_PREFIX, keeping
 * boundaryDelivered intact.
 */
function admitFirstContact(agent: Agent, injectionText: string, message: UserMessage): void {
  agent.inject(createUserMessage({
    content: textPrompt(injectionText),
    source: { kind: SIDE_INJECTION_SOURCE_KIND },
  }))
  admitFollowup(agent, message)
}

/** Build model information from the current parent route and active request. */
async function sidechatInfoOf(ctx: Context, agent: Agent, live: boolean): Promise<SidechatThreadInfo> {
  const parentSessionId = typeof agent.session.header.parentSession === 'string'
    ? agent.session.header.parentSession
    : undefined
  const events = threadOwnLogEvents(agent.session.snapshotEvents() as unknown as readonly SidechatLogEvent[])
  const selection = (parentSessionId === undefined ? undefined : await parentModelSelectionOf(ctx, parentSessionId))
    ?? parentModelSelection(events)
    ?? agentModelSelectionOf(agent)
  const header = agent.session.requestHeader()?.config
  const preset = agent.session.header.agentPreset
  return {
    live,
    ...(live ? { status: agent.status } : {}),
    ...(selection?.provider === undefined ? {} : { provider: selection.provider }),
    ...(selection?.model === undefined ? {} : { model: selection.model }),
    ...(selection?.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    ...(live && agent.status === 'running' && header !== undefined
      ? {
        ...(typeof header.provider === 'string' ? { activeProvider: header.provider } : {}),
        ...(typeof header.model === 'string' ? { activeModel: header.model } : {}),
        ...(header.reasoningEffort === undefined ? {} : { activeReasoningEffort: String(header.reasoningEffort) }),
      }
      : {}),
    ...(preset === undefined ? {} : { preset }),
  }
}

/** The live thread agent, or undefined (cold — the caller resumes). */
function liveThreadAgent(ctx: Context, childId: string): Agent | undefined {
  const agents = ctx.get('agents') as { get(id: string): Agent | undefined } | undefined
  return agents?.get(childId)
}

/** Return the live thread Agent, or resume it with its persisted setup. */
async function requireSidechatAgent(ctx: Context, childId: string): Promise<Agent> {
  const live = liveThreadAgent(ctx, childId)
  if (live !== undefined) return live
  const agents = ctx.get('agents') as {
    resume(options: ResumeAgentOptions): Promise<{ agent: Agent; dispose(): Promise<void> }>
  } | undefined
  if (agents?.resume === undefined) {
    throw new SidebarError('sidechat-error', 'the agents service is unavailable', 503)
  }
  const setup = await composePersistedSetup(ctx, childId)
  try {
    const handle = await agents.resume({ resumeSessionId: childId as SessionId, setup })
    threadDisposers.set(childId, () => handle.dispose())
    return handle.agent
  } catch (error) {
    throw new SidebarError('sidechat-error', `thread resume failed: ${error instanceof Error ? error.message : String(error)}`, 500)
  }
}

/**
 * The thread's event log (seed + its own events, already expanded): the live
 * agent's in-memory log while the thread is attached — the freshest read,
 * including events not yet flushed — else the persisted logical log. Both
 * DSH generations expose these seams with the same shape (the 0.1.2
 * persistence layer packs chunk rows on disk but expands them on inspect;
 * the live log is `Session.snapshotEvents()`, the 0.1.2-alpha.4 rename of
 * the `Session.events` property), which is why the transcript reads here
 * instead of the client's session-history RPC: that face
 * (`ctx.connection.api`) was removed in 0.1.2-alpha.1's Remote-gateway
 * migration.
 */
async function threadLogEvents(ctx: Context, childId: string): Promise<readonly SidechatLogEvent[]> {
  const agent = liveThreadAgent(ctx, childId)
  if (agent !== undefined) {
    return agent.session.snapshotEvents() as unknown as readonly SidechatLogEvent[]
  }
  const persistence = ctx.get('sessionPersistence') as SidebarSessionPersistenceService | undefined
  if (persistence === undefined) {
    throw new SidebarError('sidechat-error', 'the session persistence service is unavailable', 503)
  }
  try {
    const inspected = await readPersistedSession(persistence, childId)
    return inspected.events as unknown as readonly SidechatLogEvent[]
  } catch (error: unknown) {
    throw new SidebarError(
      'not-found',
      `thread "${childId}" is not available: ${error instanceof Error ? error.message : String(error)}`,
      404,
    )
  }
}

/** Build the Side Chat routes (all optional services degrade to a wire
 *  error the tab surfaces inline). The record keys are the FULL wire method
 *  names the /sidebar/api dispatcher looks up (`api[method]`).
 *  @param ctx - host plugin context.
 *  @param live - the live assistant stream buffer; absent only in tests that
 *    never exercise streaming (then every `live` response is empty). */
export function buildSidechatApi(ctx: Context, live?: AssistantLiveBuffer): SidechatRoutes {
  return {
    'sidechat.start': async (payload: unknown) => {
      const sessionId = requireString(payload, 'sessionId')
      const rawQuestion = (payload as { question?: unknown }).question
      const question = typeof rawQuestion === 'string' ? rawQuestion.trim() : ''
      const parent = liveThreadAgent(ctx, sessionId)
      if (parent === undefined) {
        throw new SidebarError('sidechat-error', `parent session "${sessionId}" is not running`, 409)
      }
      const parentSession = parent.session
      // 遵循 DSH 的选择顺序：会话待应用选择、最近请求、当前部署默认模型，最后读取 Agent 创建配置。
      const parentSelection = await parentModelSelectionOf(ctx, sessionId)
      const routeProvider = parentSelection?.provider
      const routeModel = parentSelection?.model
      const selectedEffort = parentSelection?.reasoningEffort
      const initialSelection: SidechatModelSelection | undefined = routeProvider === undefined || routeModel === undefined
        ? undefined
        : {
          provider: routeProvider,
          model: routeModel,
          ...(selectedEffort === undefined ? {} : { reasoningEffort: String(selectedEffort) }),
        }
      const inheritance = buildSidechatInheritance(
        parentSession.snapshotEvents() as unknown as readonly SidechatLogEvent[],
        live?.chunksFor(sessionId) ?? [],
      )
      const { agentPreset, setup } = await composeChildSetup(
        ctx,
        resolvePresetId(parentSession.header, parentSession.snapshotEvents()),
        sidechatModelSelectionRef(initialSelection),
      )
      const childId = `session-${randomUUID()}` as SessionId
      const label = question === '' ? SIDE_NEW_THREAD_TITLE : sideLabel(question)
      // Honest catalog citizenship: the durable descriptor keeps the thread
      // a HEALTHY row in the host's subagents.list — a cold child without
      // one is deterministically rendered as a 'corrupt' diagnostic. The
      // SubagentView filters the 'Side: ' label out, so the topology UI
      // stays noise-free; the row only serves enumeration correctness.
      const descriptor = snapshotSubagentDescriptor({
        mode: 'continuable',
        provider: 'sidechat',
        label,
        ...(routeProvider === undefined ? {} : { agentProvider: routeProvider }),
        ...(routeModel === undefined ? {} : { agentModel: routeModel }),
      })
      const descriptorEvent: SeedEvent = {
        type: 'subagent/descriptor',
        seq: inheritance.seed.length,
        time: Date.now(),
        data: descriptor as unknown as Record<string, unknown>,
      }
      const seed = [...inheritance.seed, descriptorEvent]
      // Fork-marker fields (the exact shape the host's own session.fork uses,
      // api-session-controller): without `isSeeded` + `inheritedEventCount` the
      // session treats the whole seed as the child's OWN events, so the child's
      // Inbox constructor replays the parent's `agent/inbox/spliced` events and
      // inherits whatever input sat UNCLAIMED in the parent at the click moment
      // (a queued follow-up, or a tool-result context spliced into next-step
      // between step boundaries of a long-running turn). The first side prompt
      // would then claim and send that stale message BEFORE the boundary +
      // question. The marker keeps `ownEvents()` at the end-seed boundary, so
      // the inherited inbox replays to empty.
      const targetEffort = selectedEffort === undefined ? undefined : ReasoningEffortId(selectedEffort)
      const childAgentOptions: CreateAgentOptions['agentOptions'] = {
        ...parent.options,
        ...(routeProvider === undefined ? {} : { provider: routeProvider }),
        ...(routeModel === undefined ? {} : { model: routeModel }),
      }
      if (targetEffort !== undefined) {
        childAgentOptions.reasoningEffort = targetEffort
      } else {
        delete childAgentOptions.reasoningEffort
      }
      const options: CreateAgentOptions = {
        sessionId: childId,
        meta: {
          ...(parentSession.header.cwd === undefined ? {} : { cwd: parentSession.header.cwd }),
          parentSession: parentSession.id,
          isSeeded: true,
          origin: 'subagent',
          delegationDepth: (parentSession.header.delegationDepth ?? 0) + 1,
          ...(agentPreset === undefined ? {} : { agentPreset }),
        },
        seed: seed as unknown as readonly SessionEvent[],
        // Branded number, compile-time only: DSH Desktop's plugin-facing
        // `@deepseek-ai/dsh-session` surface carries the type but not the runtime
        // stamp, so importing the value aborts the whole host half at load time.
        // `Array#length` is a non-negative safe integer by construction — exactly
        // what the upstream stamp asserts — so the cast is lossless here.
        inheritedEventCount: seed.length as SessionLogOffset,
        agentOptions: childAgentOptions,
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
      // The fork markers above cut `ownEvents()`, but the RUNTIME inbox
      // (`ReactLoopInbox` → ctx.sessionProjections) folds the FULL log —
      // inherited seed prefix included — because the standard inbox
      // projection's init ignores `inheritedEventCount` (DSH 0.1.5-rc.2).
      // Whatever input sat unclaimed in the parent at the click moment
      // therefore replays into the child's live inbox, and the first side
      // prompt would claim and send it BEFORE the boundary + question (the
      // long-conversation queued-input leak). Clearing durably right after
      // create fences it: the compensating splices are the child's own
      // events (persisted, so a cold resume stays clean; the transcript
      // never renders them), and nothing has been sent yet, so the idle
      // driver cannot have claimed anything — no race.
      // See docs/plans/2026-09-13-sidechat-inbox-projection-leak.md.
      handle.agent.inbox.clear()
      // Pin the thread label so the client can identify its threads by
      // title prefix (the rename is a live-session op, no RPC fence).
      const titles = ctx.get('sessionTitle') as SidebarSessionTitleService | undefined
      const pinTitle = (label: string): void => {
        if (titles === undefined) return
        try {
          titles.rename(handle.agent.session, label)
        } catch {
          // Keep the auto-generated title; the thread stays usable.
        }
      }
      if (question === '') {
        // Codex-style immediate create: no prompt yet — the composer owns
        // the first message; the snapshot waits for it.
        if (inheritance.snapshot !== null) pendingSnapshots.set(childId, inheritance.snapshot)
        pinTitle(SIDE_NEW_THREAD_TITLE)
      } else {
        const promptParts = [SIDE_BOUNDARY_PROMPT]
        if (inheritance.snapshot !== null) promptParts.push(inheritance.snapshot)
        const message = createUserMessage({ content: textPrompt(question), source: { kind: 'user' } })
        if (initialSelection !== undefined) {
          recordSidechatSelection(handle.agent.session, initialSelection, message.id)
        }
        admitFirstContact(handle.agent, promptParts.join('\n\n'), message)
        pinTitle(sideLabel(question))
      }
      return { childId }
    },

    'sidechat.prompt': async (payload: unknown) => {
      const childId = requireString(payload, 'childId')
      const text = requireString(payload, 'text').trim()
      if (text === '') {
        throw new SidebarError('bad-request', 'text is required')
      }
      return withSidechatThreadOperation(childId, async () => {
        const agent = await requireSidechatAgent(ctx, childId)
        const message = await createRoutedSidechatMessage(ctx, agent, text)
        if (boundaryDelivered(agent.session.snapshotEvents() as unknown as readonly SidechatLogEvent[])) {
          admitFollowup(agent, message)
        } else {
          // First message of an immediately-created thread: it carries the
          // boundary (+ the snapshot parked at creation, if still around)
          // and earns the thread its real label.
          const parts = [SIDE_BOUNDARY_PROMPT]
          const snapshot = pendingSnapshots.get(childId)
          pendingSnapshots.delete(childId)
          if (snapshot !== undefined) parts.push(snapshot)
          admitFirstContact(agent, parts.join('\n\n'), message)
          const titles = ctx.get('sessionTitle') as SidebarSessionTitleService | undefined
          if (titles !== undefined) {
            try {
              titles.rename(agent.session, sideLabel(text))
            } catch {
              // Keep the placeholder title; the thread stays usable.
            }
          }
        }
        return { accepted: true as const }
      })
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
      pendingSnapshots.delete(childId)
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

    'sidechat.info': async (payload: unknown) => {
      const childId = requireString(payload, 'childId')
      const agent = liveThreadAgent(ctx, childId)
      if (agent !== undefined) {
        return sidechatInfoOf(ctx, agent, true)
      }
      const persistence = ctx.get('sessionPersistence') as SidebarSessionPersistenceService | undefined
      if (persistence !== undefined) {
        try {
          const inspected = await readPersistedSession(persistence, childId)
          const preset = resolvePresetId(inspected.header, inspected.events)
          const events = threadOwnLogEvents(inspected.events as unknown as readonly SidechatLogEvent[])
          const parentSessionId = typeof inspected.header.parentSession === 'string'
            ? inspected.header.parentSession
            : undefined
          const parentSelection = parentSessionId === undefined ? undefined : await parentModelSelectionOf(ctx, parentSessionId)
          const selection = parentSelection ?? parentModelSelection(events)
          return {
            live: false,
            ...(selection?.provider === undefined ? {} : { provider: selection.provider }),
            ...(selection?.model === undefined ? {} : { model: selection.model }),
            ...(selection?.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
            ...(preset === undefined ? {} : { preset }),
          }
        } catch {
          // Unknown/gone session: report a bare cold info.
        }
      }
      return { live: false }
    },

    'sidechat.events': async (payload: unknown) => {
      const childId = requireString(payload, 'childId')
      const rawAfter = (payload as { afterSeq?: unknown }).afterSeq
      if (rawAfter !== undefined
        && (typeof rawAfter !== 'number' || !Number.isSafeInteger(rawAfter) || rawAfter < 0)) {
        throw new SidebarError('bad-request', 'afterSeq must be a non-negative integer')
      }
      const events = await threadLogEvents(ctx, childId)
      const own = threadOwnLogEvents(events)
      const fresh = rawAfter === undefined ? own : own.filter(event => event.seq > rawAfter)
      const tailSeq = own.at(-1)?.seq ?? -1
      return {
        events: fresh.length > EVENTS_CAP ? fresh.slice(fresh.length - EVENTS_CAP) : fresh,
        // The live rows ride every poll: they are process-local, so there is
        // no durable seq to page them by. An idle thread has none.
        live: liveEventsOf(live?.chunksFor(childId) ?? [], tailSeq),
      }
    },
  }
}
