/**
 * Structural types for the cordis services this plugin consumes, plus the
 * Context augmentation both halves share. A third-party plugin resolves
 * outside the DSH monorepo's single cordis instance, so the upstream
 * `declare module 'cordis'` augmentations do not reach this Context — and
 * the npm cordis package does not declare the DSH-vendored runtime members
 * (`ctx.effect`, service properties). The members below mirror the actual
 * runtime shapes this plugin touches:
 * - webServer: @deepseek-ai/dsh-host-webserver (the WebServer)
 * - sessions: host side @deepseek-ai/dsh-session (SessionStore), client
 *   side the runtime ISessions list feed
 * - conversation: client side ui-conversation's IConversation (composer
 *   draft), read lazily through `ctx.get` — cross-plugin service reads need
 *   an inject declaration, so the direct property is never typed here
 * - webRuntime: @deepseek-ai/dsh-web-app (bind-derived trusted hosts)
 * - slots: the client runtime SlotRegistry
 * - effect: the DSH-vendored cordis lifecycle helper
 * Drift from upstream is contained to this file.
 *
 * This file must stay FREE of Node.js types (`node:http`, `node:stream`,
 * `Buffer`): it is part of the CLIENT-reachable declaration graph (the
 * `Context` in `TabComponentProps` and the `declare module` augmentation),
 * so a Node import here would leak into browser-only consumer builds. The
 * webServer faces below are therefore structural mirrors with plain
 * interfaces (the host casts to real Node types at the few boundaries that
 * need them — e.g. the `ws` upgrade hook in src/index.ts).
 */
import type { Context } from 'cordis'
import type { BetterSidebarService } from './client/service.ts'

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
     * The live session's append-only event log (immutable snapshot; absent
     * on sessions the runtime has not hydrated). Read-only access — the
     * jobs.output route replays `job_output` tool/result rows from it.
     */
    events?: readonly SidebarSessionEvent[]
  } | undefined
}

/**
 * The web runtime service face (mirror of @deepseek-ai/dsh-web-app's
 * WebRuntimeValues): the bind-derived trust list the /api gateway's fence
 * accepts — LAN IP literals sampled when the server binds all interfaces,
 * plus explicit `--trusted-host` authorities.
 */
export interface SidebarWebRuntime {
  trustedHosts: readonly string[]
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

/** One healthy subagent catalog child row (structural mirror of the runtime). */
export interface SidebarSubagentChildEntry {
  kind: 'child'
  id: string
  /** Whether the child Agent driver is running at the Host sampling boundary. */
  activity: 'running' | 'inactive'
  /** Whether a direct descendant has durable `origin: 'subagent'`. */
  hasChildren: boolean
  mode: 'one-shot' | 'continuable'
  label?: string
}

/** One unreadable catalog row (corrupt / unsupported / unavailable). */
export interface SidebarSubagentDiagnosticEntry {
  kind: 'diagnostic'
  id: string
  reason: 'corrupt' | 'unsupported' | 'unavailable'
}

/** The per-parent lazy catalog delivered through the sessions list feed. */
export interface SidebarSubagentCatalog {
  entries: Array<SidebarSubagentChildEntry | SidebarSubagentDiagnosticEntry>
  parentAvailable: boolean
  state: 'loading' | 'ready' | 'error'
  error: { code?: string; message?: string } | null
}

/** Durable parent/child address that selects subagent transport in the client. */
export interface SidebarSubagentAddress {
  parentSessionId: string
  childSessionId: string
  mode: 'one-shot' | 'continuable'
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
  /** Current lifecycle state. */
  status: SidebarJobStatus
  /** Kind-specific status detail ('exit code: 3'), present once supplied. */
  detail?: string
  /** Epoch ms when the job was registered. */
  startedAt: number
  /** Epoch ms when the job settled; absent while live. */
  finishedAt?: number
}

/** The host jobs registry face the sidebar routes touch (structural mirror of `JobRegistry`). */
export interface SidebarJobsService {
  /** Request cancellation; throws for an unknown or foreign job. */
  kill(id: string, caller?: SidebarAgent, reason?: string): 'requested' | 'already-finished'
}

/** The host agent registry face (structural mirror of the runtime `ctx.agents`). */
export interface SidebarAgentsService {
  /** The live agent registered under a session id, or undefined when not live. */
  get(id: string): SidebarAgent | undefined
}

/** RPC result slot mirror (`RpcResult<T>` on the wire). */
export type SidebarRpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

/** Unary response mirror (`RpcResponse<T>` on the wire). */
export interface SidebarRpcResponse<T> {
  rpcId: unknown
  result: SidebarRpcResult<T>
}

/** The wire face the Subagent activity summary needs (subset of `ctx.connection`). */
export interface SidebarConnectionHandle {
  api: {
    subagents: {
      history(
        payload: SidebarSubagentAddress & { beforeSeq?: number; maxMessages?: number },
        signal?: AbortSignal,
      ): Promise<SidebarRpcResponse<{ events: SidebarHistoryEntry[]; hasMore: boolean }>>
    }
  }
}

/** The client session list snapshot the sidebar subscribes to. */
export interface SidebarSessionList {
  current: string | undefined
  byId: Record<string, SidebarSessionSummary>
  /** Direct durable catalogs keyed by their selected parent address. */
  subagentsByParent?: Readonly<Record<string, SidebarSubagentCatalog>>
  /**
   * Background jobs per session, last-wins from the harness's `session/jobs`
   * push (a missing key is an empty set). Absent on runtime snapshots older
   * than the jobs mirror — the sidebar simply shows no job rows.
   */
  jobsBySession?: Readonly<Record<string, readonly SidebarJobView[]>>
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
   * Mark whether a catalog surface is consuming live membership updates.
   */
  setSubagentCatalogOpen?(parentSessionId: string, open: boolean): void
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
  /** The live input store (draft read for append). */
  state: {
    getSnapshot(): { draft: string }
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

/**
 * The client workspaces service face (mirror of the runtime IWorkspaces). Only
 * the chat's file-open funnel is touched: `openPath` hands an absolute path
 * to the Host OS's default application, and every chat-side file open
 * (tool rows, produced-files, prose mentions) funnels through it.
 */
export interface SidebarWorkspacesService {
  /** Open a filesystem path with the Host operating system's default application. */
  openPath(path: string): Promise<void>
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

/** The settings service face (mirror of @deepseek-ai/dsh-settings' SettingsProvider). */
export interface SidebarSettingsService {
  /**
   * Register one namespace schema (the resolved value layers schema defaults,
   * then the composition base, then the user document).
   */
  register<T>(
    ns: string,
    schema: unknown,
    options?: { base?: Partial<T>; applies?: 'live' | 'restart' },
  ): {
    get(): T
    watch(callback: (next: T, prev: T) => void | Promise<void>): () => void
    update(patch: object): Promise<void>
    replace(section: object): Promise<void>
  }
  /** Redacted descriptors of every registered namespace (secrets stripped). */
  describe(options?: { redactSecrets?: boolean }): Array<{
    ns: string
    value?: unknown
    base?: unknown
    user?: unknown
    applies: 'live' | 'restart'
    revision: number
  }>
  /** Service-level merge write with the revision guard (a stale writer is refused). */
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
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

declare module 'cordis' {
  interface Context {
    webServer: SidebarWebServer
    sessions: SidebarSessionStore & SidebarSessionsService
    connection: SidebarConnectionHandle
    webRuntime: SidebarWebRuntime
    slots: SidebarSlotsService
    workspaces: SidebarWorkspacesService
    settings: SidebarSettingsService
    invariants: SidebarInvariantsService
    tools: SidebarToolsService
    /**
     * The client locale service (`@deepseek-ai/dsh-client-locale`): the
     * sidebar's copy follows its active locale and registers its
     * dictionaries under the `betterSidebar` namespace. Client side only.
     */
    locale: SidebarLocaleService
    /**
     * The client module system (rc.8+): resolves module-table specifiers
     * (seed words, graph rows) — the chunk loader's externals go through it
     * (`ctx.modules.import`). rc.7 exposed the same surface as the
     * `window.__DSH_MODULES__` page global; the loader keeps that fallback.
     */
    modules: { import(specifier: string): Promise<unknown> }
    /**
     * The host background-job registry (`ctx.get('jobs')`; optional — the
     * sidebar routes degrade to a 503 when the deployment lacks it).
     */
    jobs: SidebarJobsService
    /**
     * The host live-agent registry (`ctx.get('agents')`; optional — used to
     * resolve the caller the jobs fence compares against).
     */
    agents: SidebarAgentsService
    /**
     * The client-side sidebar registry: external plugins register tab types
     * and file previewers here. Provided by the client half (see
     * {@link ./client/index.tsx}); undefined on the host side.
     */
    betterSidebar: BetterSidebarService
    /**
     * Subscribe to the session append feed (mirror of the cordis event API):
     * the listener receives every appended session event with the LIVE
     * Session instance that appended it. The api-proxy pushes the same feed
     * to browsers; the sidebar uses it to mirror job_output events the
     * session store's own log can lag behind (restart divergence). Returns
     * the disposer.
     */
    on(event: string, listener: (session: unknown, event: SidebarSessionEvent) => void): () => void
    /**
     * Register a lifecycle callback (DSH-vendored cordis): runs at plugin
     * activation; its returned cleanup runs at disposal.
     */
    effect(fn: () => void | (() => void), label?: string): void
  }
}

/**
 * Dual cordis-scope augmentation: DSH's runtime (and the public packages)
 * resolve against the vendored `@deepseek-ai/cordis` scope, which DSH's own
 * packages already augment with `effect`/`on`/service members. This side only
 * adds the sidebar service member so consumers importing `Context` from
 * `@deepseek-ai/cordis` (instead of the public `cordis` above) still see
 * `ctx.betterSidebar`.
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    betterSidebar: BetterSidebarService
  }
}

export type { Context }
