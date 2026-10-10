/**
 * Structural types for the cordis services this plugin consumes, plus the
 * Context face both halves share.
 *
 * The type base is the vendored `@deepseek-ai/cordis` Context (the runtime
 * DSH actually runs); the service members this plugin touches are restated
 * below as structural mirrors and combined with the base by INTERSECTION.
 * Intersection (not `declare module` augmentation) is deliberate: DSH's own
 * packages already augment `@deepseek-ai/cordis`, and the host and client
 * packages declare *different* types for the same member — host
 * `sessions: SessionStore` vs client runtime `sessions: ISessions` — so a
 * single program that re-declares them would fail interface merging
 * (TS2717). Intersecting keeps every face available and lets each call site
 * resolve against the member it needs without any module-level conflict.
 *
 * `effect`, `get`, `provide`, `inject`, `logger`, `emit`, `isolate` and the
 * event helpers come from the vendored cordis base and are intentionally NOT
 * restated here: their strict shapes are the runtime contract (e.g. an
 * effect body must return a disposer). Only the string-keyed session-feed
 * `on` overload is added, because the cordis `on` is keyed to its own
 * typed `Events` map and the harness session feed is a plain string event.
 *
 * This file must stay FREE of Node.js types (`node:http`, `node:stream`,
 * `Buffer`): it is part of the CLIENT-reachable declaration graph (the
 * `Context` in `TabComponentProps` and the `betterSidebar` augmentation),
 * so a Node import here would leak into browser-only consumer builds. The
 * webServer faces below are therefore structural mirrors with plain
 * interfaces (the host casts to real Node types at the few boundaries that
 * need them — e.g. the `ws` upgrade hook in src/index.ts).
 */
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type { BetterSidebarService } from './client/service.ts'
import type { ProcessActivitySummary } from './process-activity.ts'

/** The request face route handlers see (structural subset of node's
 *  IncomingMessage: the URL/method/header reads and the async body
 *  iteration `readJsonBody` uses). */
export interface SidebarHttpRequest {
  url?: string
  method?: string
  headers: Record<string, string | string[] | undefined>
  [Symbol.asyncIterator](): AsyncIterator<string | Uint8Array>
}

/** The response face route handlers write to (structural subset of node's
 *  ServerResponse: the status/header/body writes the routes use). */
export interface SidebarHttpResponse {
  statusCode: number
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string | Uint8Array): void
}

/** The upgrade socket face (structural subset: the destroy the fences use). */
export interface SidebarUpgradeSocket {
  destroy(): void
}

/** The upgrade head bytes (Buffer at runtime; typed as bytes so no Node
 *  global leaks into the declaration graph). */
export type SidebarUpgradeHead = Uint8Array

/** One named webserver route (mirror of the host-webserver WebRoute). */
export interface SidebarWebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: SidebarHttpRequest, res: SidebarHttpResponse) => void | Promise<void>
}

/** One exact-path HTTP upgrade registration (mirror of WebUpgradeRoute). */
export interface SidebarWebUpgradeRoute {
  path: string
  handler: (req: SidebarHttpRequest, socket: SidebarUpgradeSocket, head: SidebarUpgradeHead) => void | Promise<void>
}

/** The webServer service face this plugin uses. */
export interface SidebarWebServer {
  register(route: SidebarWebRoute): () => void
  registerUpgrade(route: SidebarWebUpgradeRoute): () => void
}

/** A published session's header slice the sidebar reads (authoritative cwd). */
export interface SidebarSessionHeader {
  cwd?: string
}

/** The host session store face (`ctx.sessions.get(id)` returns the live session). */
export interface SidebarSessionStore {
  get(id: string): {
    header: SidebarSessionHeader
    /**
     * The live session's append-only event log as an immutable snapshot.
     * Read-only access — the jobs.output route replays `job_output`
     * tool/result rows from it. (The `Session.events` property this face
     * mirrored was renamed to `snapshotEvents()` in DSH 0.1.2-alpha.4.)
     */
    snapshotEvents(): readonly SidebarSessionEvent[]
  } | undefined
}

/**
 * The web runtime service face (mirror of @deepseek-ai/dsh-web-app's
 * WebRuntimeValues): the bind-derived trust list the /api gateway's fence
 * accepts — LAN IP literals sampled when the server binds all interfaces,
 * plus explicit `--trusted-host` authorities. DSH 0.2.1-alpha.2 deleted this
 * service (the fence moved behind `connection`, see
 * {@link SidebarHostConnection}), so it is optional and only absent hosts
 * fall back to it.
 */
export interface SidebarWebRuntime {
  trustedHosts: readonly string[]
}

/**
 * The Host `connection` service's trust half (mirror of
 * `@deepseek-ai/dsh-client-connection`'s HostConnectionHandle, DSH
 * 0.2.1-alpha.2+). It is the authoritative Host/Origin fence the `/api`
 * gateway itself applies; this plugin reads it through `ctx.get('connection')`
 * because the client runtime publishes a *different* `connection` face under
 * the same key (the Remote transport's reconnect life cycle, see
 * {@link SidebarContextShape.connection}).
 */
export interface SidebarHostConnection {
  /**
   * Apply the Host/Origin fence and browser authentication to one Web route.
   * @param request - request headers from the HTTP or upgrade request.
   * @returns 403 for a refused authority, 401 for a trusted but unauthenticated
   *   request, or undefined when both pass.
   */
  requestRejection(request: { headers: SidebarHttpRequest['headers'] }): 401 | 403 | undefined
}

/** Registration options the sidebar passes to `ctx.slots.register` (subset of the real options). */
export interface SidebarSlotRegisterOptions {
  name: string
  key?: string
  id?: string
  order?: number
  label?: string | (() => string)
  /** Chain routing selector (returns the matched value, or null to pass on). */
  select?: (owner: unknown) => unknown
  priority?: number
  locale?: string
  registrant?: string
  /** Business-face factory; args depend on the slot scope. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors the host slots signature, where inject args are untyped; unknown[] would reject concrete-typed implementations (contravariance)
  inject?: (...args: any[]) => Record<string, unknown>
  children?: Record<string, unknown>
}

/** The client slots service face (register returns the disposer). */
export interface SidebarSlotsService {
  register(options: SidebarSlotRegisterOptions, component: unknown): () => void
  /**
   * Run a callback for each declaration lifetime of a slot (the runtime
   * SlotRegistry.inject): a no-op while the slot is undeclared, so the
   * settings section registration waits for the settings shell.
   */
  inject(key: string, callback: () => () => void): () => void
}

/** The client session list row the sidebar reads (cwd for the explorer). */
export interface SidebarSessionSummary {
  id: string
  cwd?: string
  displayTitle: string
  /** Coarse durable origin for navigation filtering (subagent children). */
  origin?: 'subagent'
  /** Durable direct parent session id (present on subagent children). */
  parentId?: string
  /** Whether the session's agent is currently running. */
  running?: boolean
}

/** Durable parent/child address that selects subagent transport in the client. */
export interface SidebarSubagentAddress {
  parentSessionId: string
  childSessionId: string
  /** `unknown` keeps a child visible without claiming continuation support. */
  mode: 'one-shot' | 'continuable' | 'unknown'
}

/** Minimal structural mirror of one session event (the subagent history tail). */
export interface SidebarSessionEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
}

/** One history row: the durable event plus an optional tool presentation view. */
export interface SidebarHistoryEntry {
  event: SidebarSessionEvent
  view?: unknown
}

/** Lifecycle status set of one background job (closed wire union). */
export type SidebarJobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

/**
 * One tree child's live view as the `subagents.live` route reports it: the
 * catalog's activity flag plus the fold of the child's newest process range
 * (see ./process-activity.ts).
 *
 * `running` is the catalog's flag and is therefore always present on a CHILD
 * row; the fold's fields are optional. The route used to report running
 * children only, so "absent from the map" meant "not running" — a reading that
 * cannot survive a route which also reports settled children's summaries.
 */
export interface SidebarChildLiveView {
  /**
   * The catalog's activity flag. Present on every CHILD row; ABSENT on the
   * topology root, which the host cannot classify (the caller already knows
   * its session's running state from the session list).
   */
  running?: boolean
  /** The child's newest assistant text (the card's detail line). */
  text?: string
  /** The newest range's merged activity; absent when that range called nothing. */
  summary?: ProcessActivitySummary
  /** Epoch ms of the newest event observed. */
  lastEventTime?: number
}

/**
 * One background job as the client mirror sees it (wire `JobView` shape:
 * id/kind/label/status/detail?/startedAt/finishedAt?).
 */
export interface SidebarJobView {
  /** Registry-issued `<kind>-N` identity, stable for the job's whole life. */
  id: string
  /** Producer kind (`bash`, `pwsh`, `subagent`, …; open string by design). */
  kind: string
  /** Producer-supplied one-line label: the command, or the delegation description. */
  label: string
  /**
   * Owning session; absent for an unowned job, which every caller can see.
   * The client service's roster is keyed by WATCHED session, so this is what
   * tells a row whether it belongs to the tree on screen.
   */
  owner?: string
  /** Current lifecycle state. */
  status: SidebarJobStatus
  /** The producer's live progress line ('3/10'), cleared at settlement. */
  progress?: string
  /** Kind-specific status detail ('exit code: 3'), present once supplied. */
  detail?: string
  /** Epoch ms when the job was registered. */
  startedAt: number
  /** Epoch ms when the job settled; absent while live. */
  finishedAt?: number
}

/**
 * The host jobs registry face the sidebar routes touch (structural mirror of
 * `JobRegistry`).
 *
 * DSH 0.1.7 moved the access fence from the live `Agent` to the reading
 * session id: `caller` is a `SessionId` string on every member. The plugin no
 * longer needs `ctx.agents` in order to call the registry, and the Tasks page
 * reads `list` through the plugin's own `jobs.list` route (the client session
 * snapshot stopped mirroring background jobs in the same release).
 */
/**
 * One job's retained output as the HOST's client service observes it
 * (mirror of `@deepseek-ai/dsh-api-job-controller/client`'s observed entry).
 * `gapBefore` marks output the observer missed between frames; `error` carries
 * a producer-side failure; `streaming` is true while the job still writes.
 */
export interface SidebarObservedJob {
  text: string
  gapBefore: boolean
  streaming: boolean
  error?: string
}

/** The host client jobs service's snapshot (roster by session + observations). */
export interface SidebarJobsSnapshot {
  /** Whole-set roster per WATCHED session: empty arrays are how a session ends. */
  rows: Record<string, SidebarJobView[]>
  /** Retained output per observed job id. */
  observed: Record<string, SidebarObservedJob | undefined>
}

/**
 * The host's CLIENT jobs service (`ctx.jobs`, mounted by the web profile's
 * `@deepseek-ai/dsh-api-job-controller/client`), structurally mirrored: the
 * plugin never imports the host package.
 *
 * It replaces the plugin's own three-route jobs transport: `watchRows` keeps
 * one session's roster current as a push stream, `observe` streams a job's
 * retained output WITHOUT moving the model's consuming cursor, and `kill` is
 * the same registry admission the old route forwarded.
 */
export interface SidebarClientJobsService {
  state: {
    getSnapshot(): SidebarJobsSnapshot
    subscribe(listener: () => void): () => void
  }
  /** Watch one session's roster; returns the release function (ref-counted). */
  watchRows(sessionId: string): () => void
  /**
   * Observe one job's output; returns the release function. `sessionId` may be
   * undefined for a job whose owner the roster has not resolved yet.
   */
  observe(sessionId: string | undefined, jobId: string): () => void
  /** Request cancellation of one job (owned by `sessionId`). */
  kill(sessionId: string, jobId: string): Promise<void>
}

/** The host agent registry face (structural mirror of the runtime `ctx.agents`). */
export interface SidebarAgentsService {
  /** The live agent registered under a session id, or undefined when not live. */
  get(id: string): SidebarAgent | undefined
  /**
   * Create a session + agent with a custom seed (mirror of the runtime
   * AgentRegistry.create) — the Side Chat thread-creation seam: the SAME
   * public seam api-proxy's session.fork and the subagent fork provider use.
   */
  create?(options: unknown): Promise<{ agent: SidebarAgent; dispose(): Promise<void> }>
  /**
   * Resume an agent on a persisted session (mirror of the runtime
   * AgentRegistry.resume) — the Side Chat cold-continuation seam after a
   * DSH restart or a closed thread.
   */
  resume?(options: unknown): Promise<{ agent: SidebarAgent; dispose(): Promise<void> }>
}

/** The host subagent runtime face (`ctx.subagents`; optional — the live
 *  batch route degrades to a 503 when the deployment lacks it). Only the
 *  read-only descendant enumeration this plugin needs is mirrored. */
export interface SidebarSubagentsService {
  /**
   * Enumerate the root's complete session-backed subagent tree in stable
   * pre-order without loading or resuming an Agent (mirror of
   * `SubagentRuntime.listDescendants`).
   */
  listDescendants(
    rootSessionId: string,
    signal?: AbortSignal,
  ): Promise<SidebarSubagentDescendantEntry[]>
}

/** One descendant row of `ctx.subagents.listDescendants` (structural mirror). */
export type SidebarSubagentDescendantEntry =
  | {
    kind: 'child'
    id: string
    activity: 'running' | 'inactive'
    hasChildren: boolean
    mode: 'one-shot' | 'continuable'
    label?: string
    parentId: string
    depth: number
  }
  | {
    kind: 'diagnostic'
    id: string
    reason: 'corrupt' | 'unsupported' | 'unavailable'
    parentId: string
    depth: number
  }

/** The host agent-presets service face (mirror of the runtime agentPresets
 *  service): resolves and mounts the preset composition a session recorded,
 *  so a resumed or forked session rebuilds the same tool/prompt world its
 *  history was produced under. */
export interface SidebarAgentPresetsService {
  /** Resolve a preset id; undefined resolves the deployment default. */
  resolve(presetId?: string): Promise<{ id: string }>
  /** Mount a preset's composition into an agent scope before publication. */
  mount(agentCtx: unknown, presetId: string): Promise<void>
}

/**
 * The experimental Agent Teams service face (`ctx.agentTeams`, mounted only
 * when the deployment loads `dsh-experimental-agent-team-profile`; absent →
 * `ctx.get` returns undefined and the Teams block hides).
 *
 * Only the WRITE half is mirrored here. DSH 0.1.7 deleted the 0.1.6
 * `remoteView` / `remoteCreateTask` / `remoteUpdateTask` trio (the browser UI
 * that consumed it went away with `ctx.remote`) and moved the board's READ
 * path onto the Lead Session's `agentTeam` projection — which the client
 * already receives in `SessionListState.projectionsBySession`. So the reads
 * never touch this service any more; the two remaining calls each need the
 * exact live Lead Agent as their authority credential, hence the host routes.
 *
 * Rejections are THROWN now, not returned: `createTask` / `updateTask` hand
 * back the committed view, and a stale revision throws a `TeamError`
 * (`HarnessError` subclass, `code === 'TEAM_TASK_STALE_REVISION'`) instead of
 * resolving the 0.1.6 `TeamTaskMutationResult` union.
 */
export interface SidebarAgentTeamsService {
  /** The agent's team membership, or undefined for a non-team/stale agent. */
  tryMembership(agent: unknown): unknown
  /** Create one shared task (CAS-free; ids are server-issued). */
  createTask(agent: unknown, req: SidebarCreateTeamTaskRequest): Promise<SidebarTeamTaskView>
  /** Compare-and-set mutation of one shared task (stale revision → throws). */
  updateTask(agent: unknown, req: SidebarUpdateTeamTaskRequest): Promise<SidebarTeamTaskView>
}

/**
 * One team member as the runtime-enriched `listMembers` view reports it.
 * NOT consumed by this plugin any more (the projection below carries the
 * durable half and the live channel carries activity, see
 * ./client/team-projection.ts); kept as the mirror of the service's own
 * vocabulary so a future reader does not re-derive it.
 */
export interface SidebarTeamMemberView {
  /** The member's session id (the teammate's child session under the lead). */
  id: string
  name: string
  role: 'lead' | 'teammate'
  status: 'running' | 'idle' | 'inactive' | 'provisioning' | 'failed'
  description?: string
  provider?: string
  context?: 'fresh' | 'fork'
  model?: string
  diagnostics: string[]
}

/**
 * One durable roster row of the Lead Session's `agentTeam` projection. Phase
 * is the DURABLE lifecycle (the Lead row is always `active`); turn activity is
 * overlaid from the session's own status (see ./client/team-projection.ts).
 */
export interface SidebarTeamMemberProjection {
  /** The member's session id (the teammate's child session under the lead). */
  id: string
  name: string
  role: 'lead' | 'teammate'
  phase: 'provisioning' | 'active' | 'failed'
  /** The provisioning failure, when the durable row records one. */
  error?: string
}

/**
 * The Lead Session's published team state: durable roster identities and
 * phases, member errors, the non-deleted task views (0.1.6's `TeamView` shape,
 * enriched per task exactly like the service's own views), and the first
 * rejected Team record when the board had to stop at its last valid state.
 */
export interface SidebarTeamProjection {
  members: readonly SidebarTeamMemberProjection[]
  tasks: readonly SidebarTeamTaskView[]
  failure?: string
}

/** One shared task-board row (durable fields plus derived readiness). */
export interface SidebarTeamTaskView {
  id: string
  revision: number
  subject: string
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  ownerName?: string
  blockedBy: string[]
  writeScopes: string[]
  ready: boolean
  writeScopeWarnings: string[]
}

/** Input for creating one shared task. */
export interface SidebarCreateTeamTaskRequest {
  subject: string
  description: string
  blockedBy?: readonly string[]
  writeScopes?: readonly string[]
}

/** Input for one CAS task mutation. */
export interface SidebarUpdateTeamTaskRequest {
  taskId: string
  expectedRevision: number
  action: 'claim' | 'release' | 'edit' | 'set_dependencies' | 'complete' | 'reopen' | 'reassign' | 'delete'
  subject?: string
  description?: string
  blockedBy?: readonly string[]
  writeScopes?: readonly string[]
  owner?: string
}

/** What a team-task write hands back: the committed view (0.1.7 shape). */
export interface SidebarTeamTaskMutationResult {
  ok: true
  value: SidebarTeamTaskView
}

/** The host session-title service face (mirror of the sessionTitle service). */
export interface SidebarSessionTitleService {
  /** Rename one live session's title (pins it against auto-regeneration). */
  rename(session: unknown, title: string): { title: string; eventSeq: number }
}

/**
 * The host session-persistence face (mirror of the `sessionPersistence`
 * service): durable, handle-addressed session storage.
 *
 * DSH 0.1.5 replaced the detached `inspect(id)` call with an explicit read
 * handle: `open(id, 'read')` never takes write ownership and works while
 * another process owns the session, `handle.read()` returns one contiguous
 * slice of the log, and `close()` releases it. Every cold read in this plugin
 * goes through {@link readPersistedSession} so the handle is always closed.
 */
export interface SidebarSessionPersistenceService {
  open(sessionId: string, access: 'read' | 'write'): Promise<SidebarSessionHandle>
}

/** One open channel onto a stored session (the fields this plugin reads). */
export interface SidebarSessionHandle {
  /** Immutable stored header (cwd / agentPreset live here). */
  readonly header: { cwd?: string; agentPreset?: string } & Record<string, unknown>
  /** Exact fork-inherited prefix length stored with the log. */
  readonly inheritedEventCount?: number
  /**
   * Read a slice of the valid contiguous log.
   * @param offset - first logical seq to include (defaults to 0).
   * @param length - maximum events (defaults to the rest of the log).
   */
  read(offset?: number, length?: number): Promise<{ events: readonly SidebarSessionEvent[] }>
  /** Release the handle (idempotent). */
  close(): Promise<void>
}

/** The client session list snapshot the sidebar subscribes to. */
export interface SidebarSessionList {
  byId: Record<string, SidebarSessionSummary>
  /**
   * Host-computed projection values per session (DSH 0.1.7). The only field
   * this plugin reads is `subagentCatalog`, the direct-child list the 0.1.6
   * runtime published as `subagentsByParent`.
   *
   * Three facts the 0.1.6 snapshot carried are gone and must not be brought
   * back: there is no `current` session id (`ctx.sidebarRight.mounted` is the
   * sanctioned feed for "which session's seat is on screen"), there is no
   * background-jobs mirror (the `jobs.list` route reads the registry itself),
   * and there is no per-parent observe handshake — 0.1.7 loads every session's
   * projections once per connection, so a catalog surface reads them instead
   * of observing and unobserving (0.1.6's `setSubagentCatalogOpen` is deleted,
   * not renamed).
   */
  projectionsBySession?: Readonly<Record<string, SidebarProjectionSnapshot>>
}

/** One session's projection values, as the client snapshot publishes them. */
export interface SidebarProjectionSnapshot {
  values: {
    subagentCatalog?: readonly SidebarSubagentCatalogEntry[]
    /** The Lead Session's team board (only the team's Lead carries one). */
    agentTeam?: SidebarTeamProjection
  }
  state: 'idle' | 'loading' | 'ready' | 'error'
  error: { code?: string; message?: string } | null
}

/** One direct-child row of the host's `subagentCatalog` projection. */
export interface SidebarSubagentCatalogEntry {
  /** Child session id (`childId` in the durable event). */
  id: string
  /** Epoch ms the child was created. */
  createdAt: number
  /** `unknown` keeps a child visible without claiming continuation support. */
  mode: 'one-shot' | 'continuable' | 'unknown'
  /** Mode-specific label; continuable children always carry one. */
  label?: string
}

/** The client sessions service face (only the list feed is needed). */
export interface SidebarSessionsService {
  list: {
    getSnapshot(): SidebarSessionList
    subscribe(fn: () => void): () => void
  }
  /**
   * Select a listed session as current (mirror of the runtime ISessions.open)
   * — used to jump back to the main agent from the topology root node.
   */
  open?(id: string): void
  /**
   * Fork a session from a completed-turn prefix of the source and resolve
   * the child session id (mirror of the runtime ISessions.fork — throws on
   * failure). The Side Chat "save as new session" action uses this to
   * promote a hidden side thread into a top-level session.
   */
  fork?(opts: { sessionId: string; atSeq?: number; increaseTitle?: boolean }): Promise<string>
  /**
   * Resolve the stable session binding of one listed session (mirror of the
   * runtime ISessions.binding); the saved-session rename uses the face's
   * behavior verbs.
   */
  binding?(id: string): {
    session: {
      rename(title: string): Promise<unknown>
    }
  } | undefined
  /**
   * Resolve an Agent-scoped context view for one session (mirror of the
   * runtime ISessions.scope) — the ticket `ctx.conversation.input.for`
   * requires to reach that session's composer.
   */
  scope(id: string): Context | undefined
  /**
   * Open a healthy catalog child through its exact direct-parent address
   * (mirror of the runtime ISessions.openSubagent).
   */
  openSubagent?(address: SidebarSubagentAddress): void
  /**
   * Resolve an already discovered direct-parent address without opening it.
   */
  subagentAddress?(id: string): SidebarSubagentAddress | undefined
  /**
   * Refresh one direct-child catalog.
   */
  refreshSubagents?(parentSessionId: string): Promise<void>
}

/**
 * The client locale service face (mirror of @deepseek-ai/dsh-client-locale's
 * LocaleRuntime — only the slices the sidebar touches). The sidebar follows
 * the DSH i18n system: the active locale is the Host-backed preference
 * (`locale.preference` in settings.yaml) rather than the raw browser
 * language, and the sidebar's zh/en dictionaries register into the service's
 * namespace registry under `betterSidebar`.
 */
export interface SidebarLocaleService {
  /** Current immutable locale snapshot (uSES-safe; `active` is 'zh' | 'en' today). */
  getSnapshot(): { active: string }
  /** Subscribe to snapshot changes (locale switch or dictionary registration). */
  subscribe(fn: () => void): () => void
  /** Register one locale's dictionary for a namespace; returns the disposer. */
  register(ns: string, locale: string, dict: Record<string, string>): () => void
}

/** The composer draft face the sidebar reaches through `ctx.conversation.input`. */
export interface SidebarSessionInput {
  /** The live input store (draft read for append). `draftRev` is the machine's
   *  span-CAS revision — required to mint a structured file-reference chip. */
  state: {
    getSnapshot(): { draft: string; draftRev?: number }
  }
  /** Replace the draft text (the input machine's single public write path). */
  setDraft(text: string): void
}

/** The composer draft face the sidebar reaches through `ctx.get('conversation')`. */
export interface SidebarConversation {
  input: {
    for(actx: Context): SidebarSessionInput
  }
}

/** Read-only subset of api-workspace-controller's public IWorkspaces.list. */
export interface SidebarWorkspacesService {
  readonly list: {
    getSnapshot(): {
      readonly phase: 'pending' | 'ready'
      readonly state: 'idle' | 'loading' | 'error'
      readonly items: readonly {
        /** Canonical host directory, from WorkspaceView.path. */
        readonly path: string
        readonly sessionIds: readonly string[]
      }[]
    }
  }
}

/**
 * The invariant service face (mirror of @deepseek-ai/dsh-invariants'
 * InvariantRegistry). The upstream augmentation does not reach this Context
 * (dual-cordis-instance resolution), so the register signature is restated
 * structurally, exactly like the other service faces above.
 */
export interface SidebarInvariantsService {
  /** Reserve one package's checks and install them in the service's child fiber. */
  register(
    packageName: string,
    installer: (ctx: Context, fail: (message: string) => never) => void | Promise<void>,
  ): () => void
}

/**
 * The settings service face (mirror of `@deepseek-ai/dsh-settings`'
 * `SettingsForms`).
 *
 * DSH 0.1.7 replaced the registrable-namespace provider with a forms service
 * over the profile's own entries: a form is addressed by the **Loader entry
 * id** of the plugin row (`better-sidebar` for this bundle's patch, whatever
 * id an aggregate bundle mounted it under), its schema is the row's exported
 * `Config`, and the value shown is the live fiber config. There is no
 * `register`/`get`/`watch` any more — reads go through {@link describe} and
 * writes through {@link update}, which also carries the revision guard.
 */
export interface SidebarSettingsService {
  /** Redacted descriptors of every configurable profile entry (secrets stripped). */
  describe(options?: { redactSecrets?: boolean }): Array<{
    /** Profile entry id — NOT a plugin-chosen namespace. */
    ns: string
    revision: number
    value?: unknown
    /**
     * The profile override layer alone, projected through the form. Empty
     * means nothing has been persisted for this entry yet, which is what the
     * one-time legacy import tests before seeding. Absent under
     * `redactSecrets`.
     */
    user?: unknown
  }>
  /** Merge editable fields into one entry's config (a stale writer is refused). */
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
  /**
   * Opt this plugin instance out of the auto-generated page: the plugin ships
   * its own Side card settings section, so the native form must not duplicate
   * it. The policy does not remove configuration reads or writes.
   * @param presentation - page policy; `auto: false` opts out.
   * @param owner - the plugin instance's fiber (the loader entry's fiber).
   * @returns Disposer; register it with the plugin's effects.
   */
  configure(presentation: { auto?: boolean }, owner?: unknown): () => void
}

/**
 * The Loader face this plugin consumes (structural mirror of the loader's
 * `Loader#entries`). Each entry carries the row's configured id/name and the
 * fiber it owns, which together identify this plugin's own row.
 */
export interface SidebarLoaderService {
  entries(): Iterable<SidebarLoaderEntry>
  /**
   * Resolves once every profile entry has been mounted (the Loader settles).
   * Optional: a composition without the loader imports immediately instead.
   */
  await?(): Promise<unknown>
}

/** One configured plugin row inside the profile's entry tree. */
export interface SidebarLoaderEntry {
  options: {
    id?: string
    name?: string
  }
  /** The fiber the row owns once it is loaded; compared by identity. */
  fiber?: unknown
  disabled?: boolean
}

/**
 * The tools service face (mirror of @deepseek-ai/dsh-tools' ToolRuntime).
 * The host half registers model-facing tools here; the registry attaches the
 * returned disposer to the contributing fiber so unloading unregisters them.
 */
export interface SidebarToolsService {
  /** Register one tool definition (raw JSON-Schema or defineTool-sugar form). */
  register(tool: unknown): () => void
}

/**
 * The agent face a tool sees on `exec.agent` (mirror of @deepseek-ai/dsh-agent's
 * Agent). Only the slices the terminal tools touch are restated: the live
 * session identity and its header cwd, both readonly.
 */
export interface SidebarAgent {
  /** The live session identity shared with the session log. */
  readonly id: string
  /** The live session this agent drives. */
  readonly session: {
    /** The session's header (validated cwd, lineage metadata). */
    readonly header: { readonly cwd?: string }
  }
}

/**
 * The shape this plugin actually consumes, intersected with the vendored
 * cordis `Context` below (see the file header for why intersection is used
 * instead of module augmentation).
 */
export interface SidebarContextShape {
  /** The webServer service face this plugin uses. */
  webServer: SidebarWebServer
  /** The session store (host `.get`) and the client list feed (`.list`) faces. */
  sessions: SidebarSessionStore & SidebarSessionsService
  /**
   * The web runtime trust list (bind-derived). Optional: DSH 0.2.1-alpha.2
   * removed the service, and the fence then comes from the Host connection
   * service instead (see {@link SidebarHostConnection}).
   */
  webRuntime?: SidebarWebRuntime
  /** The client slot registry (register/inject). */
  slots: SidebarSlotsService
  /** The settings service face (prefs persistence + namespace reads). */
  settings: SidebarSettingsService
  /** The invariant registry face. */
  invariants: SidebarInvariantsService
  /** The tool registry face. */
  tools: SidebarToolsService
  /** The client locale service face. */
  locale: SidebarLocaleService
  /** The client module system (rc.8+ chunk-loader externals). */
  modules: { import(specifier: string): Promise<unknown> }
  /** The host background-job registry (optional; routes degrade to 503). */
  jobs: SidebarClientJobsService
  /** The host live-agent registry (optional; side chat thread agents). */
  agents: SidebarAgentsService
  /**
   * The active profile's context (optional). Only `home` is consumed: the
   * harness home is where DSH 0.1.7 leaves the removed `settings.yaml` under
   * its `.imported` name, which is the one surviving source of a pre-0.1.7
   * user's Side card preferences.
   */
  profileContext?: { home: string }
  /**
   * The Loader's entry list. This plugin reads it only to discover the id its
   * own row was mounted under — 0.1.7 addresses settings forms by profile
   * entry id, and the id is not knowable at author time (an aggregate bundle
   * mounts the same package under its own id).
   */
  loader: SidebarLoaderService
  /** The host subagent runtime (optional; live topology batch route). */
  subagents: SidebarSubagentsService
  /** The host agent-presets service (optional; side chat cold resume). */
  agentPresets: SidebarAgentPresetsService
  /** The host session-title service (optional; side chat thread label pin). */
  sessionTitle: SidebarSessionTitleService
  /** The host session-persistence service (optional; side chat cold resume). */
  sessionPersistence: SidebarSessionPersistenceService
  /**
   * The client connection lifecycle (DSH 0.1.2-alpha.2+; optional so older
   * hosts and test fakes simply hide the disconnect banner): the observable
   * recovery state of the Remote transport (`undefined` before the first
   * connection outcome) and an immediate-reconnect request.
   */
  connection?: {
    state: {
      getSnapshot(): 'connected' | 'disconnected' | 'connecting' | undefined
      subscribe(listener: () => void): () => void
    }
    reconnect(): void
  }
  /** The composer draft face (client ui-conversation, lazy `ctx.get` probe). */
  conversation: SidebarConversation
  /** Host-authoritative workspace membership; resolved lazily at reference insertion. */
  workspaces?: SidebarWorkspacesService
  /**
   * The client-side sidebar registry: external plugins register tab types
   * and file previewers here. Provided by the client half (see
   * {@link ./client/index.tsx}); undefined on the host side.
   */
  betterSidebar: BetterSidebarService
  /**
   * String-keyed session feed subscribe (the vendored cordis `on` is keyed
   * to its typed Events map; the harness session feed is a plain string
   * event). The listener receives every appended session event with the
   * LIVE Session instance that appended it.
   */
  on(event: string, listener: (session: unknown, event: SidebarSessionEvent) => void): () => void
  /**
   * The agent's process-local assistant stream (DSH 0.1.5+): one payload per
   * `start` / `chunk` / `end` frame, carrying the emitting agent and the
   * frame. These frames are NOT session events — see
   * {@link ./assistant-live.ts} for why the plugin needs them.
   */
  on(event: 'agent/assistant-stream', listener: (payload: { agent?: unknown; frame?: unknown }) => void): () => void
}

/**
 * The Context this plugin sees: the vendored cordis Context intersected with
 * the structural service faces above. Re-exported from the package root so a
 * consumer can `import type { Context } from 'dsh-better-sidebar'`.
 */
export type Context = CordisContext & SidebarContextShape

/**
 * Consumer-facing augmentation (deliberately the only one kept): a plugin
 * that imports `Context` from `@deepseek-ai/cordis` and does
 * `import type {} from 'dsh-better-sidebar'` sees `ctx.betterSidebar`
 * without importing this package's own Context type.
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    betterSidebar: BetterSidebarService
  }
}
