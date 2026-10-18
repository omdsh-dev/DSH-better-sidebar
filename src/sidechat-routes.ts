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
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import {
  installModelSelection,
  type Agent,
  type AgentSetup,
  type CreateAgentOptions,
  type ModelSelectionRef,
  type ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
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
  effectiveModelSelection,
  inheritedPendingIds,
  liveEventsOf,
  parentModelSelection,
  pendingInputId,
  pendingInputs,
  resolvePresetId,
  SIDE_BOUNDARY_PREFIX,
  SIDE_BOUNDARY_PROMPT,
  SIDE_INJECTION_SOURCE_KIND,
  SIDE_NEW_THREAD_TITLE,
  sideLabel,
  type SeedEvent,
  type SidechatLiveEvent,
  type SidechatLogEvent,
  type SidechatModelCatalog,
  type SidechatModelSelection,
  type SidechatPendingInput,
  type SidechatThreadInfo,
  threadOwnLogEvents,
} from './sidechat-core.ts'
import type { AssistantLiveBuffer } from './assistant-live.ts'
import { requireString, SidebarError } from './wire.ts'
import { readPersistedSession } from './session-store.ts'

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

/**
 * The session-local model selection event. Its owning package
 * (`dsh-api-session-controller`) is not a plugin dependency, but the event is
 * part of the durable session format the plugin must write to change a
 * thread's model the way the host's own composer does — so the key is
 * declared here with the exact shape that package's own projection folds
 * (provider, model, optional branded effort).
 */
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** Session-local model selection for the next request. */
    'model/selection': {
      provider: string
      model: string
      reasoningEffort?: ReasoningEffortId
    }
  }
}

/** The Side Chat routes of the sidebar API (wire method names). */
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
  /** Live state + the thread's EFFECTIVE model route and preset. */
  'sidechat.info'(payload: unknown): Promise<SidechatThreadInfo>
  /** The thread's OWN transcript events, seed-cut host-side (the inherited
   *  parent log never crosses the wire); `afterSeq` narrows the response to
   *  the delta beyond it (poll tail). `live` carries the thread's in-flight
   *  model deltas, which DSH 0.1.5 publishes outside the session log — it is
   *  the CURRENT attempt's rows on every poll, never a delta. `pending` is
   *  the thread's live UNCLAIMED inbox in claim order: accepted input that
   *  has not reached the log yet, so the transcript can show it instead of
   *  looking dead until a claim logs it. */
  'sidechat.events'(payload: unknown): Promise<{
    events: SidechatLogEvent[]
    live: SidechatLiveEvent[]
    pending: SidechatPendingInput[]
  }>
  /** Drop one unclaimed inbox message, or the whole queue when `messageId` is
   *  omitted. A cold thread has nothing live to drop and answers `removed: 0`. */
  'sidechat.dequeue'(payload: unknown): Promise<{ accepted: true; removed: number }>
  /** The host model catalog the composer itself lists (degraded to
   *  `available: false` when the host exposes no such service). */
  'sidechat.models'(payload: unknown): Promise<SidechatModelCatalog>
  /** Install one model selection on the thread: durably logged as
   *  `model/selection` (the host's own commit shape) and applied to the next
   *  request through the agent-scoped selection the host installs for its
   *  composer. */
  'sidechat.model'(payload: unknown): Promise<{ accepted: true; selection: SidechatModelSelection }>
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

/** Per-thread model-selection refs installed on the live agent. The host's
 *  own composer commits a model switch by appending `model/selection` AND
 *  installing this agent-scoped ref (`SessionController.selectForNextRequest`);
 *  the ref is what prompt assembly and request routing actually read, because
 *  the controller caches one selection object per agent and never re-reads the
 *  projection. A subagent-origin thread never passes through the controller's
 *  fence, so the plugin installs the same seam itself. */
const threadModelRefs = new Map<string, ModelSelectionRef>()

/** The host model catalog service's structural face (dsh-api-session-controller
 *  is not a plugin peer; only `modelCatalog()` is read, and its shape is
 *  mirrored by {@link SidechatModelCatalog}). */
interface SidebarModelCatalogService {
  modelCatalog(): Promise<unknown>
}

/** The host LLM service's structural face: the same call-config resolution the
 *  controller's own `selectModel` validates with. */
interface SidebarLlmService {
  resolveCallConfig?(request: {
    provider: string
    model: string
    reasoningEffort?: ReturnType<typeof ReasoningEffortId>
  }): Promise<unknown>
}

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
  const inspected = await readPersistedSession(persistence, childId)
  const presetId = resolvePresetId(inspected.header, inspected.events)
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
function admitFirstContact(agent: Agent, injectionText: string, question: string): void {
  agent.inject(createUserMessage({
    content: textPrompt(injectionText),
    source: { kind: SIDE_INJECTION_SOURCE_KIND },
  }))
  admitFollowup(agent, textPrompt(question))
}

/** The live thread agent, or undefined (cold — the caller resumes). */
function liveThreadAgent(ctx: Context, childId: string): Agent | undefined {
  const agents = ctx.get('agents') as { get(id: string): Agent | undefined } | undefined
  return agents?.get(childId)
}

/**
 * The host's lightweight stored-session observation (`sessionPersistence.stat`),
 * read structurally: the plugin's own mirror of the service only models the
 * handle API, and a host without `stat` must degrade to an uncached read rather
 * than fail.
 */
interface SidebarStoredSessionStat {
  /** Opaque change token; the JSONL backend composes it from the file's
   *  dev/ino/size/mtimeNs/ctimeNs, i.e. it changes iff the artifact does. */
  readonly revision?: unknown
  /** Physical artifact size in bytes, when the backend can provide it. */
  readonly sizeBytes?: number
}

/**
 * Cold-thread log memo: how many THREADS keep their decoded log. The
 * transcript polls `sidechat.events` per open thread (15 s fallback, plus one
 * pull per push frame), so a handful of threads is the whole working set.
 */
const COLD_LOG_MEMO_MAX = 16
const coldLogMemo = new Map<string, readonly SidechatLogEvent[]>()

/**
 * Read one COLD thread's persisted log, memoized by the stored artifact's
 * IDENTITY: `childId` plus the host's change token (dev/ino/size/mtimeNs/
 * ctimeNs) and the physical size.
 *
 * Why: a cold thread is re-read on every poll, and each read opens the handle,
 * decodes the ENTIRE persisted log and scans it back to `session/end-seed` —
 * O(thread history) per tick for an answer that only changes when the artifact
 * does. With the memo a repeat poll costs one `stat`.
 *
 * Only the RESULT is memoized, never the handle:
 * {@link readPersistedSession} still opens and closes it (its `finally`), so a
 * concurrent writer is unaffected. A host without `stat`, or a session whose
 * stat is unreadable, reads uncached — the read itself then reports the real
 * error (404 for a gone thread) exactly as before.
 */
async function readColdThreadLog(
  persistence: SidebarSessionPersistenceService,
  childId: string,
): Promise<readonly SidechatLogEvent[]> {
  const identity = await storedIdentityOf(persistence, childId)
  if (identity === undefined) {
    return (await readPersistedSession(persistence, childId)).events as unknown as readonly SidechatLogEvent[]
  }
  const key = `${childId}\0${identity}`
  const hit = coldLogMemo.get(key)
  if (hit !== undefined) {
    // Refresh recency (the memo is a bounded LRU).
    coldLogMemo.delete(key)
    coldLogMemo.set(key, hit)
    return hit
  }
  const events = (await readPersistedSession(persistence, childId)).events as unknown as readonly SidechatLogEvent[]
  // One thread owns at most one entry: a changed artifact replaces the old
  // version instead of pinning a second copy of a potentially huge log.
  const prefix = `${childId}\0`
  for (const existing of coldLogMemo.keys()) {
    if (existing.startsWith(prefix)) coldLogMemo.delete(existing)
  }
  coldLogMemo.set(key, events)
  while (coldLogMemo.size > COLD_LOG_MEMO_MAX) {
    const oldest = coldLogMemo.keys().next().value
    if (oldest === undefined) break
    coldLogMemo.delete(oldest)
  }
  return events
}

/** The stored artifact's change identity, or undefined when unavailable. */
async function storedIdentityOf(
  persistence: SidebarSessionPersistenceService,
  childId: string,
): Promise<string | undefined> {
  const stat = (persistence as { stat?: (id: string) => Promise<SidebarStoredSessionStat | undefined> }).stat
  if (typeof stat !== 'function') return undefined
  try {
    const snapshot = await stat.call(persistence, childId)
    if (snapshot === undefined) return undefined
    return `${String(snapshot.revision ?? '')}\0${String(snapshot.sizeBytes ?? '')}`
  } catch {
    // Unreadable stat (an unknown session, a permission race): fall back to
    // the plain read, which reports the failure in the route's own shape.
    return undefined
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
    return await readColdThreadLog(persistence, childId)
  } catch (error: unknown) {
    throw new SidebarError(
      'not-found',
      `thread "${childId}" is not available: ${error instanceof Error ? error.message : String(error)}`,
      404,
    )
  }
}

/** The thread's unclaimed inbox as wire rows, in claim order. An inbox whose
 *  projection is not readable (a host without AgentLoop's inbox unit) reads as
 *  "nothing pending" instead of failing the transcript poll. */
function pendingOf(agent: Agent): SidechatPendingInput[] {
  try {
    return pendingInputs(agent.inbox.nextStep, agent.inbox.nextTurn)
  } catch {
    return []
  }
}

/** Whether the thread's inbox already holds a boundary injection.
 *  `boundaryDelivered` only sees the boundary once a CLAIM logged the durable
 *  `user/message`; a second prompt arriving before that claim would otherwise
 *  deliver a second boundary + question pair (two injections queued at once). */
function boundaryPending(agent: Agent): boolean {
  try {
    for (const message of [...agent.inbox.nextStep, ...agent.inbox.nextTurn]) {
      if (messageLeadTextOf(message).startsWith(SIDE_BOUNDARY_PREFIX)) return true
    }
  } catch {
    // Same degradation as pendingOf: an unreadable inbox claims nothing.
  }
  return false
}

/** The leading text of an inbox message's content (block array or bare string). */
function messageLeadTextOf(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content
  const first = Array.isArray(content) ? content[0] : content
  if (typeof first === 'string') return first
  if (first !== null && typeof first === 'object' && 'text' in first) return String((first as { text: unknown }).text)
  return ''
}

/**
 * Remove exactly the inbox messages a seeded thread INHERITED as still-pending
 * but never owned. The create path fences a fresh thread hard (nothing of its
 * own can be queued yet), but a COLD thread cannot use that blanket clear:
 * input the user genuinely queued in the thread before a host restart is
 * legitimate work. The inherited prefix fold identifies the ghosts by identity
 * instead, so only they are dropped.
 *
 * This closes the last documented hole of the 2026-09-13 leak fix — threads
 * created before that fence (or by any build without it) still leaked the
 * parent's already-claimed input after a cold resume.
 * See docs/plans/2026-10-12-sidechat-native-surface.md.
 * @param agent - the just-resumed thread agent.
 * @returns how many inherited ghosts were dropped.
 */
function dropInheritedGhosts(agent: Agent): number {
  const log = agent.session.snapshotEvents() as unknown as readonly SidechatLogEvent[]
  const ghosts = new Set(inheritedPendingIds(log, Number(agent.session.inheritedEventCount)))
  if (ghosts.size === 0) return 0
  let removed = 0
  for (const message of [...agent.inbox.nextStep, ...agent.inbox.nextTurn]) {
    const id = pendingInputId(message)
    if (id === undefined || !ghosts.has(id)) continue
    if (agent.inbox.remove(id as MessageId)) removed++
  }
  return removed
}

/** The thread's EFFECTIVE model route: what its log says it will request with
 *  (`pending ?? lastUsed` of the `model/selection` / `request/header` fold),
 *  falling back to the agent's frozen creation-time options only when the log
 *  records no selection at all. Reading `agent.options` alone ships the
 *  creation-time deployment default — the bug #368 fixed for inheritance. */
function selectionOf(agent: Agent): SidechatModelSelection | undefined {
  const logged = effectiveModelSelection(
    agent.session.snapshotEvents() as unknown as readonly SidechatLogEvent[],
  )
  if (logged !== undefined) return logged
  const { provider, model, reasoningEffort } = agent.options
  if (provider === undefined || model === undefined) return undefined
  return {
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort: String(reasoningEffort) }),
  }
}

/** One wire selection as the agent-scoped ref's branded value. */
function brandedSelection(selection: SidechatModelSelection): {
  provider: string
  model: string
  reasoningEffort?: ReturnType<typeof ReasoningEffortId>
} {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }),
  }
}

/**
 * Hand the agent the model-selection seam, once per live agent: the ref prompt
 * assembly snapshots and request routing applies. Seeded from the thread's
 * recorded selection, so a resumed thread keeps the model the user picked
 * instead of reverting to the deployment default.
 * @param agent - the live thread agent.
 * @param childId - thread identity (the ref's key).
 * @returns the installed (or already installed) ref.
 */
function ensureModelSelection(agent: Agent, childId: string): ModelSelectionRef {
  const existing = threadModelRefs.get(childId)
  if (existing !== undefined) return existing
  const selection = selectionOf(agent)
  const ref: ModelSelectionRef = {
    current: selection === undefined ? undefined : brandedSelection(selection),
    assembled: undefined,
  }
  installModelSelection(agent.ctx, ref)
  threadModelRefs.set(childId, ref)
  return ref
}

/** Resolve the thread's live agent, cold-resuming the persisted session under
 *  its recorded composition. Every context-delivering route shares this. */
async function ensureLiveThread(ctx: Context, childId: string): Promise<Agent> {
  const live = liveThreadAgent(ctx, childId)
  if (live !== undefined) return live
  const agents = ctx.get('agents') as
    | { resume(options: ResumeAgentOptions): Promise<{ agent: Agent; dispose(): Promise<void> }> }
    | undefined
  if (agents?.resume === undefined) {
    throw new SidebarError('sidechat-error', 'the agents service is unavailable', 503)
  }
  const setup = await composePersistedSetup(ctx, childId)
  try {
    const handle = await agents.resume({ resumeSessionId: childId as SessionId, setup })
    threadDisposers.set(childId, () => handle.dispose())
    // A cold resume rebuilds the runtime inbox by folding the full log, so an
    // inherited prefix can resurrect the parent's already-claimed input here
    // even though the create path fenced it. Sweep it by identity BEFORE any
    // delivery — never blanket-clear, which would discard input the user
    // queued in this thread themselves.
    dropInheritedGhosts(handle.agent)
    ensureModelSelection(handle.agent, childId)
    return handle.agent
  } catch (error) {
    throw new SidebarError(
      'sidechat-error',
      `thread resume failed: ${error instanceof Error ? error.message : String(error)}`,
      500,
    )
  }
}

/** Reject a wire selection the deployment cannot route. Mirrors the
 *  controller's own `selectModel` validation when the LLM service exposes it;
 *  a host without the seam accepts the selection verbatim. */
async function normalizeSelection(
  ctx: Context,
  requested: SidechatModelSelection,
): Promise<SidechatModelSelection> {
  const llm = ctx.get('llm') as SidebarLlmService | undefined
  if (llm?.resolveCallConfig === undefined) return requested
  let resolved: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | null
  try {
    resolved = await llm.resolveCallConfig({
      provider: requested.provider,
      model: requested.model,
      ...(requested.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(requested.reasoningEffort) }),
    }) as { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | null
  } catch (error) {
    throw new SidebarError(
      'bad-request',
      `model "${requested.provider}/${requested.model}" is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      400,
    )
  }
  const provider = typeof resolved?.provider === 'string' ? resolved.provider : requested.provider
  const model = typeof resolved?.model === 'string' ? resolved.model : requested.model
  const effort = resolved?.reasoningEffort === undefined ? undefined : String(resolved.reasoningEffort)
  return { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
}

/** The host model catalog the composer lists, normalized for the side-chat
 *  picker. The service is not a plugin peer, so it is probed structurally; a
 *  deployment without it (headless, older host) degrades to
 *  `available: false`. */
async function modelCatalogOf(ctx: Context): Promise<SidechatModelCatalog> {
  const service = ctx.get('sessionController') as SidebarModelCatalogService | undefined
  if (service?.modelCatalog === undefined) {
    return { available: false, groups: [], failures: [] }
  }
  try {
    const catalog = await service.modelCatalog() as {
      default?: SidechatModelSelection
      groups?: SidechatModelCatalog['groups']
      failures?: SidechatModelCatalog['failures']
    } | null
    return {
      available: true,
      ...(catalog?.default === undefined ? {} : { default: catalog.default }),
      groups: catalog?.groups ?? [],
      failures: catalog?.failures ?? [],
    }
  } catch (error) {
    return {
      available: false,
      groups: [],
      failures: [{ id: 'host', message: error instanceof Error ? error.message : String(error) }],
    }
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
      const workingDirectory = ctx.get('workingDirectory')
      const parentCwd = workingDirectory?.get(parentSession) ?? parentSession.header.cwd
      // The parent's CURRENT model route. agent.options freezes the
      // creation-time deployment default — a composer model switch rides
      // `model/selection` events + the session-local selection and never
      // rewrites options — so the child inherits the durable projection
      // (falling back to the options snapshot only when the log carries no
      // selection at all). Inheriting parent.options verbatim silently
      // shipped the stale default instead of the model the user sees
      // selected in the parent composer (#368).
      const parentSelection = parentModelSelection(
        parentSession.snapshotEvents() as unknown as readonly SidechatLogEvent[],
      )
      const routeProvider = parentSelection?.provider ?? parent.options.provider
      const routeModel = parentSelection?.model ?? parent.options.model
      const inheritance = buildSidechatInheritance(
        parentSession.snapshotEvents() as unknown as readonly SidechatLogEvent[],
        live?.chunksFor(sessionId) ?? [],
      )
      const { agentPreset, setup } = await composeChildSetup(
        ctx,
        resolvePresetId(parentSession.header, parentSession.snapshotEvents()),
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
      // A truncated inheritance can end before the parent's last directory
      // change. Header cwd alone cannot win: the host projection replays seed
      // working-directory/change events over it. Stamp the committed directory
      // at the seed boundary, using the host-owned event rather than refolding
      // its history or asking set() to enqueue a synthetic user notice.
      const directorySeed: SeedEvent[] = workingDirectory === undefined ? [] : [{
        type: 'working-directory/change',
        seq: inheritance.seed.length,
        time: Date.now(),
        data: { cwd: parentCwd },
      }]
      const descriptorEvent: SeedEvent = {
        type: 'subagent/descriptor',
        seq: inheritance.seed.length + directorySeed.length,
        time: Date.now(),
        data: descriptor as unknown as Record<string, unknown>,
      }
      const seed = [...inheritance.seed, ...directorySeed, descriptorEvent]
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
      const targetEffort = parentSelection !== undefined
        ? (parentSelection.reasoningEffort === undefined ? undefined : ReasoningEffortId(parentSelection.reasoningEffort))
        : parent.options.reasoningEffort
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
          ...(parentCwd === undefined ? {} : { cwd: parentCwd }),
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
      // projection's init ignores `inheritedEventCount` (DSH 0.2.0-rc.2).
      // The seed also loses the parent's claim splices when it is truncated
      // before an open turn (they sit INSIDE that turn), so a fresh thread can
      // inherit input the parent already claimed. Whatever sat unclaimed in
      // the parent therefore replays into the child's live inbox, and the
      // first side prompt would claim and send it BEFORE the boundary +
      // question. Clearing durably right after create fences it completely:
      // NOTHING of this thread's own can be pending yet, so the blanket clear
      // costs nothing. A COLD resume cannot do this (the user may have queued
      // legitimate input before a restart) and sweeps by identity instead —
      // see dropInheritedGhosts / ensureLiveThread.
      // See docs/plans/2026-09-13-sidechat-inbox-projection-leak.md and
      // docs/plans/2026-10-12-sidechat-native-surface.md.
      handle.agent.inbox.clear()
      // Give the thread the same model-selection seam the host's composer
      // installs, seeded from the parent route it just inherited, so a later
      // per-thread switch is a ref update rather than a second install.
      ensureModelSelection(handle.agent, childId)
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
        admitFirstContact(handle.agent, promptParts.join('\n\n'), question)
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
      // Cold thread: resume the persisted session under its recorded
      // composition, sweep the inherited ghosts, then deliver the follow-up.
      const agent = await ensureLiveThread(ctx, childId)
      if (boundaryDelivered(agent.session.snapshotEvents() as unknown as readonly SidechatLogEvent[])
        || boundaryPending(agent)) {
        admitFollowup(agent, textPrompt(text))
      } else {
        // First message of an immediately-created thread: it carries the
        // boundary (+ the snapshot parked at creation, if still around)
        // and earns the thread its real label.
        const parts = [SIDE_BOUNDARY_PROMPT]
        const snapshot = pendingSnapshots.get(childId)
        pendingSnapshots.delete(childId)
        if (snapshot !== undefined) parts.push(snapshot)
        admitFirstContact(agent, parts.join('\n\n'), text)
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
      threadModelRefs.delete(childId)
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
        const preset = agent.session.header.agentPreset
        const selection = selectionOf(agent)
        return {
          live: true,
          status: agent.status,
          ...(selection === undefined ? {} : selectionFields(selection)),
          ...(preset === undefined ? {} : { preset }),
        }
      }
      // Cold thread: the persisted preset and the effective route its log
      // records are both worth reading back.
      const persistence = ctx.get('sessionPersistence') as SidebarSessionPersistenceService | undefined
      if (persistence !== undefined) {
        try {
          const inspected = await readPersistedSession(persistence, childId)
          const preset = resolvePresetId(inspected.header, inspected.events)
          const selection = effectiveModelSelection(inspected.events as unknown as readonly SidechatLogEvent[])
          return {
            live: false,
            ...(preset === undefined ? {} : { preset }),
            ...(selection === undefined ? {} : selectionFields(selection)),
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
      const agent = liveThreadAgent(ctx, childId)
      return {
        events: fresh.length > EVENTS_CAP ? fresh.slice(fresh.length - EVENTS_CAP) : fresh,
        // The live rows ride every poll: they are process-local, so there is
        // no durable seq to page them by. An idle thread has none.
        live: liveEventsOf(live?.chunksFor(childId) ?? [], tailSeq),
        // Accepted-but-unclaimed input, so the transcript can show it as
        // pending (with a dequeue affordance) instead of looking dead until a
        // claim logs the durable `user/message`. A cold thread has none.
        pending: agent === undefined ? [] : pendingOf(agent),
      }
    },

    'sidechat.dequeue': async (payload: unknown) => {
      const childId = requireString(payload, 'childId')
      const rawId = (payload as { messageId?: unknown }).messageId
      if (rawId !== undefined && (typeof rawId !== 'string' || rawId === '')) {
        throw new SidebarError('bad-request', 'messageId must be a non-empty string')
      }
      const agent = liveThreadAgent(ctx, childId)
      // Nothing live holds pending input: the queue is a runtime object, so a
      // cold thread has nothing to drop (its log's own splices stay history).
      if (agent === undefined) return { accepted: true as const, removed: 0 }
      if (rawId === undefined) {
        const queued = pendingOf(agent).length
        agent.inbox.clear()
        return { accepted: true as const, removed: queued }
      }
      return { accepted: true as const, removed: agent.inbox.remove(rawId as MessageId) ? 1 : 0 }
    },

    'sidechat.models': async () => modelCatalogOf(ctx),

    'sidechat.model': async (payload: unknown) => {
      const childId = requireString(payload, 'childId')
      const provider = requireString(payload, 'provider')
      const model = requireString(payload, 'model')
      const rawEffort = (payload as { reasoningEffort?: unknown }).reasoningEffort
      if (rawEffort !== undefined && (typeof rawEffort !== 'string' || rawEffort === '')) {
        throw new SidebarError('bad-request', 'reasoningEffort must be a non-empty string')
      }
      const requested: SidechatModelSelection = {
        provider,
        model,
        ...(rawEffort === undefined ? {} : { reasoningEffort: rawEffort }),
      }
      const selection = await normalizeSelection(ctx, requested)
      const agent = await ensureLiveThread(ctx, childId)
      // The host's own commit shape (`SessionController.selectForNextRequest`):
      // the durable intent lands in the log, and the agent-scoped ref is what
      // prompt assembly and request routing read for the NEXT step.
      agent.session.append('model/selection', brandedSelection(selection))
      ensureModelSelection(agent, childId).current = brandedSelection(selection)
      return { accepted: true as const, selection }
    },
  }
}

/** The wire fields of one model selection (shared by info's live/cold arms). */
function selectionFields(selection: SidechatModelSelection): {
  provider: string
  model: string
  reasoningEffort?: string
} {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
  }
}
