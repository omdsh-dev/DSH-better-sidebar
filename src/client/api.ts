/**
 * Typed fetch wrapper over the /sidebar JSON API. Every call posts through
 * {@link hostRouteUrl} to `/sidebar/api/<method>` with the sessionId and —
 * when known — the session's cwd from the client's own list summary (the
 * route keeps a reverse-proxy prefix; see host-route-url.ts). The host prefers
 * its attached session header and uses the summary cwd only while the session
 * is still hydrating at page load (a detached session would otherwise fail the
 * request). Failures surface as {@link SidebarApiError} with the wire code.
 */
import { encodeHtmlUrl } from '../html-route.ts'
import { hostRouteUrl } from './host-route-url.ts'
import { resolveSidebarPath } from './paths.ts'
import type { SidechatLiveEvent, SidechatLogEvent, SidechatThreadInfo } from '../sidechat-core.ts'
import type {
  SidebarCreateTeamTaskRequest,
  SidebarChildLiveView,
  SidebarSessionEvent,
  SidebarTeamTaskView,
  SidebarUpdateTeamTaskRequest,
} from '../context-types.ts'
import type { WorkflowRunView } from '../workflow-runs.ts'

/** One wire failure. */
export class SidebarApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** Explorer row (host fs-tree shape). */
export interface FsEntry {
  name: string
  path: string
  isDir: boolean
  hidden: boolean
  /** Whether the row is a symlink; `isDir` then describes the link's target. */
  isSymlink: boolean
  /** For symlinks: the target is missing or unreadable (stat failed). */
  broken: boolean
  /** Directory rows only: the contents are exactly one non-symlink child
   *  — the explorer folds such chains into one breadcrumb row. */
  compact?: boolean
}

/** One level of a `fs.trees` batch: a listing, or that level's failure. */
export interface FsLevel {
  path: string
  entries: FsEntry[]
  truncated: boolean
  /** Present only when THIS level failed (the batch itself succeeded). */
  error?: string
}

/** Git status entry (host git shape). */
export interface GitStatusEntry {
  path: string
  xy: string
}

/** Git status snapshot. */
export interface GitStatusResult {
  isRepo: boolean
  branch?: string
  entries: GitStatusEntry[]
  /** True when the host capped `entries` (huge untracked set); the panel
   *  shows a truncation notice instead of freezing (#369). */
  truncated?: boolean
  root?: string
  repositories?: string[]
}

/** One linked Git checkout. */
export interface GitWorktree {
  path: string
  branch: string
  current: boolean
  changes: number
}

/** One model a provider advertises (the pinned commit-message dropdown). */
export interface GitModelInfo {
  /** Provider-side model id (dispatched verbatim). */
  id: string
  /** Display name; equals `id` when the adapter reports none. */
  name: string
}

/** One provider route with the models its adapter advertises. */
export interface GitModelProvider {
  provider: string
  name: string
  models: GitModelInfo[]
}

/** The model catalog `git.models` answers with. It merges three sources so
 *  the picker is usable even before a conversation has run:
 *  - `providers`: the adapters' own catalog (`llm.listModels`),
 *  - `recent`: routes THIS session already used (newest first),
 *  - `default`: the harness default selection (`agent-default-model`), which
 *    exists without any session at all.
 *  `llm` says whether the harness exposes an LLM surface: an empty catalog is
 *  then "no adapters registered", not "the route failed". */
export interface GitModelCatalog {
  llm: boolean
  providers: GitModelProvider[]
  recent: GitModelRoute[]
  default?: GitModelRoute
}

/** One pinned-model value: the route the host dispatches on. */
export interface GitModelRoute {
  provider: string
  model: string
}

/** One git log row. */
export interface GitLogEntry {
  /** Short hash (7+ chars, display). */
  hash: string
  /** Full 40-char hash (advanced operations). */
  hashFull: string
  subject: string
  author: string
  /** ISO 8601 author date (`%ai`). */
  date: string
  /** Ref decorations (--decorate=short), e.g. `HEAD -> main, origin/main`; '' when none. */
  refs: string
}

/** Text read result. `mtimeMs` is the save route's conflict baseline. */
export interface FsTextResult { kind: 'text'; content: string; truncated: boolean; mtimeMs?: number }
/** Binary read result (no content; images load through the media route).
 *  `head` carries the first bytes (base64) for viewer detect sniffing. */
export interface FsBinaryResult { kind: 'binary'; size: number; truncated: boolean; mtimeMs?: number; head: string }

/** The `subagents.live` response: one row per tree child (and the root). */
export type SubagentLiveResult = { live: Record<string, SidebarChildLiveView> }

/** The `workflows.list` response: the tree's folded workflow runs. */
export type WorkflowsListResult = { runs: WorkflowRunView[] }

/** The `teams.taskCreate` request payload (minus the rootSessionId). */
export type TeamsTaskCreateRequest = SidebarCreateTeamTaskRequest

/** The `teams.taskUpdate` request payload (minus the rootSessionId). */
export type TeamsTaskUpdateRequest = SidebarUpdateTeamTaskRequest

/**
 * One team-task write as CALLERS consume it. The board's READ path has no
 * route at all (it rides the Lead Session's `agentTeam` projection, see
 * team-projection.ts), and a rejected write is a RESULT rather than an
 * exception: the route answers 409 `team-conflict` for a stale revision and
 * 400 `team-error` otherwise, {@link writeTask} turns that failed envelope
 * back into `{ok:false, code, message}`, and the task window routes on the
 * code (a stale revision deserves its own wording, not "operation failed").
 */
export type TeamsTaskMutationResult =
  | { ok: true; value: SidebarTeamTaskView }
  | { ok: false; code?: string; message: string }

/**
 * Parse one `/sidebar` JSON response envelope into its value. A non-ok
 * status, an unparseable body, or any shape other than `{ok: true, value}`
 * surfaces as {@link SidebarApiError} carrying the wire code (falling back
 * to the HTTP status). Shared by the JSON api route and the raw upload
 * route, whose envelopes are identical.
 */
async function readEnvelope<T>(response: Response): Promise<T> {
  const parsed: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } } | null
    = await response.json().catch(() => null)
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
    throw new SidebarApiError(
      parsed?.error?.code ?? 'http',
      parsed?.error?.message ?? `HTTP ${response.status}`,
    )
  }
  return parsed.value as T
}

async function call<T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(hostRouteUrl(`sidebar/api/${method}`).href, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    })
  } catch (error) {
    throw new SidebarApiError('network', error instanceof Error ? error.message : String(error))
  }
  return readEnvelope<T>(response)
}

/**
 * One team-task write with the rejection turned back into a RESULT. Every
 * other `/sidebar/api` caller lets a failed envelope throw (that is what
 * {@link readEnvelope} is for); here the route's error CODE is data the task
 * window needs — `team-conflict` means "someone changed this task, refresh",
 * which is a different sentence from every other failure.
 * @param method - `teams.taskCreate` or `teams.taskUpdate`.
 * @param payload - the request plus its `rootSessionId`.
 */
async function writeTask(
  method: string,
  payload: Record<string, unknown>,
): Promise<TeamsTaskMutationResult> {
  try {
    return { ok: true, value: await call<SidebarTeamTaskView>(method, payload) }
  } catch (error) {
    if (error instanceof SidebarApiError) {
      return { ok: false, code: error.code, message: error.message }
    }
    throw error
  }
}

/**
 * Upload one file to the sidebar's raw upload route: the File goes straight
 * into the POST body (no JSON/base64 re-encoding — the host streams it into
 * the workspace). Failure surfaces as {@link SidebarApiError} with the wire
 * code, exactly like every `/sidebar/api` call. An aborted `signal` rejects
 * with the DOMException as-is (the caller decides whether that is an error).
 */
async function fetchUpload<T>(
  scope: SessionScope,
  dir: string,
  relativePath: string,
  body: Blob,
  signal?: AbortSignal,
): Promise<T> {
  const params = new URLSearchParams({ sessionId: scope.sessionId, dir, relativePath })
  if (scope.cwd !== undefined && scope.cwd !== '') params.set('cwd', scope.cwd)
  let response: Response
  try {
    response = await fetch(hostRouteUrl(`sidebar/upload?${params.toString()}`).href, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body,
      signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new SidebarApiError('network', error instanceof Error ? error.message : String(error))
  }
  return readEnvelope<T>(response)
}

/** One request's session scope: the conversation id plus its cwd when known. */
export interface SessionScope {
  sessionId: string
  /** The session's working directory from the client list summary (optional). */
  cwd?: string
  /** Selected Git repository when cwd is a workspace container. */
  repoRoot?: string
}

/** Fold a scope into a JSON payload ({cwd} only when present). */
function scopePayload(scope: SessionScope, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionId: scope.sessionId,
    ...(scope.cwd !== undefined && scope.cwd !== '' ? { cwd: scope.cwd } : {}),
    ...(scope.repoRoot !== undefined && scope.repoRoot !== '' ? { repoRoot: scope.repoRoot } : {}),
    ...extra,
  }
}

/** Add a linked-worktree selection to a scoped Git request. The host validates
 * membership before using it as a command cwd. */
function gitPayload(scope: SessionScope, worktree: string | undefined, extra: Record<string, unknown>): Record<string, unknown> {
  return scopePayload(scope, { ...(worktree !== undefined && worktree !== '' ? { worktree } : {}), ...extra })
}

/** One external-open request from the file tree. */
type OpenExternalPayload =
  | { action: 'reveal'; path: string }
  | { action: 'editor'; editor: 'vscode' | 'cursor'; path: string }
  | { action: 'url'; url: string }

/** The host route's success shape. */
type OpenExternalResult = { started: boolean }

/**
 * Remote VSCode-family URLs must be consumed on the browser/client machine:
 * the DSH host can be a headless remote server with no editor or DISPLAY.
 * Local editor URLs and reveal actions still belong to the host opener.
 */
function shouldOpenExternalOnClient(payload: OpenExternalPayload): payload is { action: 'url'; url: string } {
  if (payload.action !== 'url') return false
  let parsed: URL
  try {
    parsed = new URL(payload.url)
  } catch {
    return false
  }
  return parsed.protocol !== 'http:'
    && parsed.protocol !== 'https:'
    && parsed.hostname === 'vscode-remote'
    && parsed.pathname.startsWith('/ssh-remote+')
}

/**
 * Dispatch an external-open request to the correct machine. SSH remote-editor
 * URLs stay in the synchronous user-click chain and navigate the client so
 * its registered vscode:// / cursor:// handler can launch. Everything else
 * keeps using the DSH host route.
 */
function openExternal(payload: OpenExternalPayload): Promise<OpenExternalResult> {
  if (!shouldOpenExternalOnClient(payload)) {
    return call<OpenExternalResult>('open.external', payload)
  }
  try {
    window.location.assign(payload.url)
    return Promise.resolve({ started: true })
  } catch (error) {
    return Promise.reject(error)
  }
}

/** The sidebar API surface (session scope threaded through every call). */
export const api = {
  sessionCwd: (scope: SessionScope, signal?: AbortSignal) =>
    call<{ sessionId: string; cwd: string; root: string; parent: string | null }>('session.cwd', scopePayload(scope, {}), signal),
  fsTree: (scope: SessionScope, path: string, exclude?: readonly string[], signal?: AbortSignal) =>
    call<{ path: string; entries: FsEntry[]; truncated: boolean }>('fs.tree', scopePayload(scope, { path, exclude }), signal),
  /**
   * Batch listing: every requested level in ONE request (the tree's mount and
   * refresh send the expanded set instead of N `fsTree` calls). A level that
   * failed carries `error` in place — the batch itself still succeeds.
   * `exclude` carries the explorerExclude pref: matched entries never arrive
   * (the host filters, so no client-side pass is needed).
   */
  fsTrees: (scope: SessionScope, paths: readonly string[], exclude?: readonly string[], signal?: AbortSignal) =>
    call<{ levels: FsLevel[] }>('fs.trees', scopePayload(scope, { paths: [...paths], exclude }), signal),
  /** Global recursive file-name search rooted at the session cwd (the editor
   *  side panel's search box); matches are cwd-relative '/'-separated paths,
   *  and `dirs` names the subset that is a directory (the list navigates the
   *  tree for those — `fs.read` refuses a directory). `exclude` carries the
   *  explorerExclude pref: matched entries never match and are never
   *  descended (host-side, in lockstep with the tree). */
  fsSearch: (scope: SessionScope, query: string, exclude?: readonly string[], signal?: AbortSignal) =>
    call<{ matches: string[]; dirs: string[]; truncated: boolean }>('fs.search', scopePayload(scope, { query, exclude }), signal),
  fsRead: (scope: SessionScope, path: string, signal?: AbortSignal) =>
    call<FsTextResult | FsBinaryResult>('fs.read', scopePayload(scope, { path }), signal),
  /** Save a file. `expectedMtimeMs` is the mtime the draft was based on: a
   *  file that changed on disk since refuses with code `fs-conflict` (the
   *  editor then offers a reload) instead of clobbering those bytes. `null`
   *  (the file did not exist yet) and omitted (older callers) both mean no
   *  gate. The response carries the fresh baseline. */
  fsWrite: (scope: SessionScope, path: string, content: string, expectedMtimeMs?: number | null) =>
    call<{ ok: true; mtimeMs?: number }>('fs.write', scopePayload(scope, {
      path,
      content,
      ...(expectedMtimeMs !== undefined ? { expectedMtimeMs } : {}),
    })),
  /** Rename one tree row within its directory (single-segment name; the
   *  server refuses existing destinations, the workspace root, and — while
   *  the fence is armed — anything resolving outside the workspace). */
  fsRename: (scope: SessionScope, path: string, name: string) =>
    call<{ path: string }>('fs.rename', scopePayload(scope, { path, name })),
  /** Permanently delete one tree row (recursive for directories; a symlink
   *  row unlinks the link only). The UI confirms before calling this. */
  fsRemove: (scope: SessionScope, path: string) =>
    call<{ path: string }>('fs.remove', scopePayload(scope, { path })),
  /** Create one directory row inside `path` (single-segment name; the server
   *  refuses existing destinations, the workspace root, and — while the fence
   *  is armed — anything resolving outside the workspace). */
  fsMkdir: (scope: SessionScope, path: string, name: string) =>
    call<{ path: string }>('fs.mkdir', scopePayload(scope, { path, name })),
  /** Upload one file's raw bytes into `dir` (keeps the folder tree via
   *  `relativePath`); the host streams it under the session workspace. */
  uploadFile: (scope: SessionScope, dir: string, relativePath: string, body: Blob, signal?: AbortSignal) =>
    fetchUpload<{ path: string; size: number }>(scope, dir, relativePath, body, signal),
  gitWorktrees: (scope: SessionScope, signal?: AbortSignal) =>
    call<GitWorktree[]>('git.worktrees', scopePayload(scope, {}), signal),
  gitStatus: (scope: SessionScope, worktree?: string, signal?: AbortSignal) =>
    call<GitStatusResult>('git.status', gitPayload(scope, worktree, {}), signal),
  gitDiff: (scope: SessionScope, path: string | undefined, staged: boolean, worktree?: string, signal?: AbortSignal) =>
    call<{ diff: string }>('git.diff', gitPayload(scope, worktree, { ...(path !== undefined ? { path } : {}), staged }), signal),
  gitStage: (scope: SessionScope, path?: string, worktree?: string) =>
    call<{ ok: true }>('git.stage', gitPayload(scope, worktree, { ...(path !== undefined ? { path } : {}) })),
  gitUnstage: (scope: SessionScope, path?: string, worktree?: string) =>
    call<{ ok: true }>('git.unstage', gitPayload(scope, worktree, { ...(path !== undefined ? { path } : {}) })),
  gitCommit: (scope: SessionScope, message: string, worktree?: string) =>
    call<{ ok: true }>('git.commit', gitPayload(scope, worktree, { message })),
  /** Push the selected checkout's branch to its upstream; git's own failure
   *  message (no upstream, auth, non-fast-forward) crosses the wire as-is. */
  gitPush: (scope: SessionScope, worktree?: string) =>
    call<{ ok: true }>('git.push', gitPayload(scope, worktree, {})),
  /** Pull into the selected checkout (`--ff-only` host-side: a diverged branch
   *  fails loudly rather than opening a merge editor nobody can answer). */
  gitPull: (scope: SessionScope, worktree?: string) =>
    call<{ ok: true }>('git.pull', gitPayload(scope, worktree, {})),
  /** Ask the host to generate a commit message from the pending changes: it
   *  streams the diff through the harness LLM on the pinned route (or the
   *  conversation's own) and answers with the route actually used.
   *  `language` follows the sidebar's active locale ('zh' | 'en'). */
  gitSuggestMessage: (scope: SessionScope, language: 'zh' | 'en', worktree?: string) =>
    call<{ message: string; provider: string; model: string }>('git.suggest-message', gitPayload(scope, worktree, { language })),
  /** The discoverable provider/model catalog for the Git card's pinned-route
   *  setting (advisory; empty when the harness exposes no LLM service). */
  gitModels: (scope: SessionScope, signal?: AbortSignal) =>
    call<GitModelCatalog>('git.models', scopePayload(scope, {}), signal),
  /** The route the NEXT commit-message suggestion would use (pinned → the
   *  conversation's own → the harness default); absent when none resolves.
   *  Cheaper than `gitModels`: no catalog discovery. */
  gitCommitModel: (scope: SessionScope, signal?: AbortSignal) =>
    call<{ route?: GitModelRoute; pinned: boolean }>('git.commit-model', scopePayload(scope, {}), signal),
  gitBranch: (scope: SessionScope, worktree?: string, signal?: AbortSignal) =>
    call<{ current: string; names: string[] }>('git.branch', gitPayload(scope, worktree, {}), signal),
  gitCheckout: (scope: SessionScope, branch: string, worktree?: string) =>
    call<{ ok: true }>('git.checkout', gitPayload(scope, worktree, { branch })),
  /** Recent commit history, lazily pageable (skip/count; defaults 0/30). */
  gitLog: (scope: SessionScope, count?: number, skip?: number, worktree?: string, signal?: AbortSignal) =>
    call<GitLogEntry[]>('git.log', gitPayload(scope, worktree, {
      ...(count !== undefined ? { count } : {}),
      ...(skip !== undefined ? { skip } : {}),
    }), signal),
  /** Full patch text of one commit (diff display for the history rows). */
  gitCommitDiff: (scope: SessionScope, hash: string, worktree?: string, signal?: AbortSignal) =>
    call<{ diff: string }>('git.commit-diff', gitPayload(scope, worktree, { hash }), signal),
  /** One file's content at a revision (`git show <rev>:<path>`); null when the
   *  revision has no such path. The diff views' on-demand hunk-fold expansion
   *  reads both sides' full contents through this. */
  gitShow: (scope: SessionScope, rev: string, path: string, worktree?: string, signal?: AbortSignal) =>
    call<{ content: string | null }>('git.show', gitPayload(scope, worktree, { rev, path }), signal),
  /** The session's file-tool events for the changes tab's session lens: the
   *  `tool/call` + `tool/result` rows past `afterSeq` (0 = whole window),
   *  capped to the recent window host-side. The client runtime exposes no
   *  event-log face, so the lens polls this delta route. */
  changesOps: (scope: SessionScope, afterSeq?: number, signal?: AbortSignal) =>
    call<{ events: SidebarSessionEvent[]; lastSeq: number }>('changes.ops', scopePayload(scope, {
      ...(afterSeq !== undefined && afterSeq > 0 ? { afterSeq } : {}),
    }), signal),
  /** Discard the worktree changes of one file (the index is untouched). */
  gitDiscard: (scope: SessionScope, path: string, worktree?: string) =>
    call<{ ok: true }>('git.discard', gitPayload(scope, worktree, { path })),
  /** Revert one commit onto the current branch. */
  gitRevert: (scope: SessionScope, hash: string, worktree?: string) =>
    call<{ ok: true }>('git.revert', gitPayload(scope, worktree, { hash })),
  /** Cherry-pick one commit onto the current branch. */
  gitCherryPick: (scope: SessionScope, hash: string, worktree?: string) =>
    call<{ ok: true }>('git.cherry-pick', gitPayload(scope, worktree, { hash })),
  /**
   * One batch live-preview fetch for the whole Subagent tree. The payload is
   * the already-resolved topology ROOT (not a session scope); the host
   * enumerates descendants once and folds every child's newest process range
   * into the main agent's merged-activity summary.
   */
  subagentsLive: (rootSessionId: string, signal?: AbortSignal) =>
    call<SubagentLiveResult>('subagents.live', { rootSessionId }, signal),
  /**
   * The workflow runs of the whole tree, folded host-side from the
   * `tool-workflow/*` session events (the same four types the official
   * workflow-run panel folds). Empty when the tree never ran a workflow —
   * absence is the normal case, never an error.
   */
  workflowsList: (rootSessionId: string, signal?: AbortSignal) =>
    call<WorkflowsListResult>('workflows.list', { rootSessionId }, signal),
  /** Create one shared task on the root-led team. */
  teamsTaskCreate: (rootSessionId: string, req: TeamsTaskCreateRequest) =>
    writeTask('teams.taskCreate', { rootSessionId, ...req }),
  /** CAS-mutate one shared task; a stale revision yields `team-conflict`. */
  teamsTaskUpdate: (rootSessionId: string, req: TeamsTaskUpdateRequest) =>
    writeTask('teams.taskUpdate', { rootSessionId, ...req }),
  /** Create a Side Chat thread: a child session seeded with the parent's
   *  full log up to now. Empty question = immediate create (Codex-style):
   *  the thread opens empty, the first prompt carries the boundary. */
  sidechatStart: (sessionId: string, question?: string) =>
    call<{ childId: string }>('sidechat.start', { sessionId, question: question ?? '' }),
  /** Deliver one follow-up message to a Side Chat thread. */
  sidechatPrompt: (childId: string, text: string) =>
    call<{ accepted: true }>('sidechat.prompt', { childId, text }),
  /** Abort a Side Chat thread's running turn (queued work is preserved). */
  sidechatCancel: (childId: string) =>
    call<{ accepted: true }>('sidechat.cancel', { childId }),
  /** Release a Side Chat thread's live agent (history stays persisted). */
  sidechatDispose: (childId: string) =>
    call<{ accepted: true }>('sidechat.dispose', { childId }),
  /** Live state + agent identity (provider/model/preset) of a thread. */
  sidechatInfo: (childId: string) =>
    call<SidechatThreadInfo>('sidechat.info', { childId }),
  /** One transcript pull of a Side Chat thread: the thread's OWN events
   *  (the inherited seed is cut host-side and never crosses the wire).
   *  `afterSeq` narrows the response to the delta beyond it (poll tail).
   *  `live` is the thread's in-flight model deltas (DSH 0.1.5 publishes them
   *  outside the session log) — the CURRENT attempt on every pull, never a
   *  delta, so the caller replaces its live set instead of appending. */
  sidechatEvents: (childId: string, afterSeq?: number, signal?: AbortSignal) =>
    call<{ events: SidechatLogEvent[]; live: SidechatLiveEvent[] }>('sidechat.events', {
      childId,
      ...(afterSeq !== undefined ? { afterSeq } : {}),
    }, signal),
  /** Read the side card preferences (plugin-global, no session scope). */
  settingsGet: () =>
    call<{ value?: unknown; revision?: number; externalDisable?: boolean }>('settings.get', {}),
  /** Merge a patch into the side card preferences (revision-guarded). */
  settingsUpdate: (patch: Record<string, unknown>, expectedRevision?: number) =>
    call<{ value?: unknown; revision?: number }>('settings.update', {
      patch,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    }),
  /** External open for the file tree's "open with" menu. Remote SSH editor
   *  URLs are launched on the browser/client machine; reveal and local URLs
   *  keep using the host's platform opener. */
  openExternal,
}

/** Absolute URL of the media route for one path (images only). */
export function mediaUrl(scope: SessionScope, path: string): string {
  return fileUrl(scope, path, false)
}

/** Absolute URL of the download route: serves raw bytes (binary-safe) with
 *  `Content-Disposition: attachment`, so the browser saves the file. */
export function downloadUrl(scope: SessionScope, path: string): string {
  return fileUrl(scope, path, true)
}

/**
 * Start one archive build. The host fences and walks the selection, then
 * returns an id IMMEDIATELY — the zip itself is produced in the background and
 * polled through {@link api.archiveStatus}. `paths` are absolute paths in the
 * session's namespace (the same values `fsTree` / `downloadUrl` take).
 */
export function archiveBuild(
  scope: SessionScope,
  paths: readonly string[],
  name: string,
): Promise<{ id: string; entries: number }> {
  return call<{ id: string; entries: number }>('archive.build', scopePayload(scope, { paths: [...paths], name }))
}

/** One archive build's progress (the shape `archive.status` returns). */
export interface ArchiveBuildStatus {
  state: 'building' | 'ready' | 'error'
  /** Entries finished so far. */
  done: number
  /** Entries the archive will contain. */
  total: number
  /** Uncompressed bytes read so far. */
  bytes: number
  /** Present only when `state === 'error'`. */
  error?: string
}

/** Poll one archive build (its id came from {@link archiveBuild}). The session
 *  scope rides along exactly like `archive.build`: the host requires BOTH keys
 *  (`requireString(payload, 'id')` + `requireString(payload, 'sessionId')`), so
 *  a bare `{ id }` payload is refused with a 400 and the status is never read. */
export function archiveStatus(scope: SessionScope, id: string): Promise<ArchiveBuildStatus> {
  return call<ArchiveBuildStatus>('archive.status', scopePayload(scope, { id }))
}

/**
 * Absolute URL of one FINISHED archive's bytes (the `archive.status` result
 * must be `ready` first): GET /sidebar/archive?id=…&sessionId=… The session
 * scope rides along because the host answers only the session that built it.
 */
export function archiveDownloadUrl(scope: SessionScope, id: string): string {
  return hostRouteUrl(`sidebar/archive?${new URLSearchParams({ sessionId: scope.sessionId, id }).toString()}`).href
}

/** Shared URL builder for the /sidebar/file route (media vs download). */
function fileUrl(scope: SessionScope, path: string, download: boolean): string {
  const params = new URLSearchParams({ sessionId: scope.sessionId, path: resolveSidebarPath(scope.cwd, path) })
  if (scope.cwd !== undefined && scope.cwd !== '') params.set('cwd', scope.cwd)
  if (download) params.set('download', '1')
  return hostRouteUrl(`sidebar/file?${params.toString()}`).href
}

/**
 * Absolute URL of the HTML preview route (see html-route.ts): the path is
 * fully encoded so the previewed page's relative assets resolve back into
 * the same route with the session scope intact. The UNC marker is
 * platform-neutral — the host's requireAbsolute resolves the decoded
 * forward-slash `//server/share/...` form on both win32 and POSIX — so no
 * client-side platform signal is needed.
 */
export function htmlUrl(scope: SessionScope, path: string): string {
  return hostRouteUrl(encodeHtmlUrl(scope.sessionId, resolveSidebarPath(scope.cwd, path))).href
}

/** One session-phase read: whether the session is still blank (no messages). */
export interface SessionPhase {
  /** True while the session has neither a user nor an assistant message. */
  blank: boolean
}

/**
 * Read one session's blank phase. Blank sessions do not render the host's
 * session header, so the plugin's header-registered dock entry is unreachable
 * there (issue #698/#623) — the client uses this to render its fallback entry.
 * @param sessionId - the session to read.
 * @param signal - optional abort signal.
 * @returns the phase (`blank: false` when the session does not exist).
 */
export async function sessionPhase(sessionId: string, signal?: AbortSignal): Promise<SessionPhase> {
  return call<SessionPhase>('session.phase', { sessionId }, signal)
}
