/**
 * dsh-better-sidebar host half: the /sidebar JSON API (explorer listing, file
 * read/write, git), the /sidebar/file media route (images), the /sidebar/html
 * preview route, the /sidebar/bundle lazy-chunk route (client code splits),
 * and the two WebSocket upgrades (sidebar_open pushes). Every route passes the same
 * browser-trust fence as the /api gateway — Host-header loopback or the
 * web runtime's `trustedHosts` (LAN IP literals sampled at boot plus
 * `--trusted-host` authorities), read per request from the live service
 * value so the fence tracks the same trust source the /api gateway derives
 * its list from.
 *
 * All operations are conversation-scoped: requests carry a sessionId and the
 * session's authoritative cwd comes from the session store.
 */
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { parse as parseYaml } from 'yaml'
import type { Context, SidebarHttpRequest, SidebarSessionEvent, SidebarSettingsService } from './context-types.ts'
import {
  Config,
  resolveSidebarConfig,
  SIDEBAR_PREFS_DEFAULTS,
  SIDEBAR_PREFS_NS,
  type ResolvedSidebarConfig,
  type SidebarConfig,
  type SidebarPrefs,
} from './config.ts'
import { isWithin, parentOf, requireAbsolute, listDirectory, rootLabel } from './fs-tree.ts'
import { resolveSessionPath } from './session-path.ts'
import { renameWorkspaceEntry, removeWorkspaceEntry, writeWorkspaceUpload } from './fs-operations.ts'
import { ensureWorkspacePath, ensureWorkspaceWritePath } from './path-security.ts'
import { searchFiles } from './fs-search.ts'
import { decodeHtmlUrl } from './html-route.ts'
import { isTrustedApiRequest } from './trust-fence.ts'
import { registerBundleRoute } from './bundle-route.ts'
import { createDirectoryWatchers, type DirectoryWatchers } from './fs-watch.ts'
import { launchExternal } from './open-external.ts'
import * as git from './git.ts'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { AgentOpenRegistry, registerOpenTool, type AgentOpenRequest } from './agent-opens.ts'
import { buildJobsApi, type SidebarJobsRoutes } from './jobs-routes.ts'
import { buildSubagentLiveApi, type SidebarSubagentLiveRoutes } from './subagent-live-route.ts'
import { buildSidechatApi } from './sidechat-routes.ts'
import { createAssistantLiveBuffer, type AssistantLiveBuffer } from './assistant-live.ts'
import { readJsonBody, requireString, SidebarError, writeError, writeJson, writeOk } from './wire.ts'
import { readPersistedSession } from './session-store.ts'

export { Config }
export type { SidebarConfig, ResolvedSidebarConfig }
// Re-export the Context augmentation (`declare module '@deepseek-ai/cordis'`)
// so consumers `import type {} from 'dsh-better-sidebar'` and gain
// `ctx.betterSidebar`; the Context re-export below is the vendored cordis
// Context intersected with the structural service faces.
// Also re-export the service descriptor types so consumers can type their
// registerTab / registerFileViewer arguments without reaching into /client.
export type { Context } from './context-types.ts'
export type {
  BetterSidebarService,
  TabDescriptor,
  TabComponentProps,
  FileViewerDescriptor,
  FileViewerProps,
  FileFetchStrategy,
} from './client/service.ts'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-better-sidebar'

/** Services required before mounting: the webserver routes, the session store, the web runtime's trusted hosts, and the tool registry. */
export const inject = ['webServer', 'sessions', 'webRuntime', 'tools']

/** Content types for the media route, by extension. */
const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.html': 'text/html',
  '.htm': 'text/html',
}

/** Content type served by /sidebar/file (binary-safe fallback for unknowns). */
export function mediaTypeForPath(path: string): string {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Resolve a session's authoritative working directory. The attached session
 * header wins; while the session is still hydrating from persistence (the
 * web client attaches the current conversation a moment after page load, so
 * the very first sidebar requests can arrive detached) the caller's own
 * list-summary cwd is used; the session-persistence index is queried as a
 * last resort for cold (not-yet-attached) sessions so a detached first
 * request still resolves the correct project instead of the host process
 * cwd (which on Windows is the DSH source root after `dsh.cmd`'s `pushd`,
 * causing every user-project path to be misclassified as "outside
 * workspace"). The host process cwd is the FINAL fallback for deployments
 * without persistence (tests / stripped-down hosts); production always
 * provides persistence, so the bug-fix path (header → client → persistence)
 * always resolves the real session cwd before reaching it.
 */
async function sessionCwdOf(ctx: Context, sessionId: string, clientCwd?: string): Promise<string> {
  const session = ctx.sessions.get(sessionId)
  const headerCwd = session?.header.cwd
  if (headerCwd !== undefined && headerCwd !== '') return headerCwd
  if (clientCwd !== undefined && clientCwd !== '') {
    try {
      return requireAbsolute(clientCwd)
    } catch {
      throw new SidebarError('bad-request', `invalid working directory "${clientCwd}"`)
    }
  }
  const persistence = ctx.get('sessionPersistence')
  if (persistence !== undefined) {
    const persisted = await readPersistedSession(persistence, sessionId)
    const metaCwd = persisted.header.cwd
    if (metaCwd !== undefined && metaCwd !== '') {
      try {
        return requireAbsolute(metaCwd)
      } catch {
        throw new SidebarError('bad-request', `invalid working directory "${metaCwd}"`)
      }
    }
  }
  return process.cwd()
}

/** Optional repository selected by the Git panel when cwd is a container. */
function selectedRepoOf(payload: unknown): string | undefined {
  const record = payload as { repoRoot?: unknown }
  if (record.repoRoot === undefined) return undefined
  return requireAbsolute(requireString(payload, 'repoRoot'))
}

/**
 * Resolve a path that a git command reported — `git status`/`git diff`
 * print paths RELATIVE TO THE REPO TOP LEVEL, which may sit above the
 * session cwd (a session inside a subdirectory of a repository). Absolute
 * paths pass through; relative ones join the repo root (falling back to the
 * cwd when the root cannot be resolved, e.g. a bare directory).
 */
async function resolveGitPath(cwd: string, raw: string, selected?: string): Promise<string> {
  if (isAbsolute(raw)) return requireAbsolute(resolveSessionPath(cwd, raw))
  // Prefer the session-relative interpretation when it names an existing
  // path. Git status reports repository-root-relative names, but the sidebar
  // security boundary is the session workspace; this preference keeps files
  // inside a nested session readable without reopening the repository root.
  const sessionPath = requireAbsolute(join(cwd, raw))
  if (await stat(sessionPath).then(() => true).catch(() => false)) return sessionPath
  const root = await git.repoRoot(cwd, selected).catch(() => cwd)
  return requireAbsolute(join(root, raw))
}

/** How many leading bytes a binary read returns for client-side detect sniffing. */
const READ_HEAD_LIMIT = 4096

/** Text read of a file with the size cap; binary detection via NUL probe.
 *  Binary reads also return the first {@link READ_HEAD_LIMIT} bytes (base64)
 *  so the client can re-match viewers by content (`detect`). */
async function readText(path: string, readLimit: number): Promise<{
  content: string
  truncated: boolean
  binary: boolean
  size: number
  head?: string
}> {
  const info = await stat(path).catch((error: unknown) => {
    throw new SidebarError('fs-error', `cannot read "${path}": ${error instanceof Error ? error.message : String(error)}`, 400)
  })
  if (info.isDirectory()) {
    throw new SidebarError('fs-error', `"${path}" is a directory`, 400)
  }
  const size = info.size
  const truncated = size > readLimit
  const handle = await open(path, 'r').catch((error: unknown) => {
    throw new SidebarError('fs-error', `cannot read "${path}": ${error instanceof Error ? error.message : String(error)}`, 400)
  })
  try {
    const buffer = Buffer.alloc(Math.min(size, readLimit))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const slice = buffer.subarray(0, bytesRead)
    const binary = slice.includes(0)
    const head = binary
      ? slice.subarray(0, Math.min(slice.length, READ_HEAD_LIMIT)).toString('base64')
      : undefined
    return {
      content: binary ? '' : slice.toString('utf8'),
      truncated,
      binary,
      size,
      head,
    }
  } finally {
    await handle.close()
  }
}

/** One API method dispatch table entry. */
type ApiMethod = (payload: unknown) => Promise<unknown> | unknown

/**
 * The live face of the side card settings namespace, bound to the settings
 * service when it is mounted. The DSH settings RPC domain only serves
 * allowlisted namespaces (api-proxy exposedNamespaces), so the client reads
 * and writes THIS namespace through the plugin's own fenced /sidebar routes,
 * which call the seam in-process — no configuration-client gate involved.
 */
export interface SidebarSettingsFace {
  /** The current resolved value + revision (undefined while the settings service is absent). */
  get(): { value?: unknown; revision?: number }
  /**
   * Whether the dsh-web-ui family's aionui-panel has been selected as the
   * right-panel provider (the `aionui-panel` settings namespace resolves
   * `rightPanel: 'aionui-panel'`). While true the sidebar must not mount —
   * the two right panels are mutually exclusive. False when the namespace is
   * absent (no aionui installed) or the provider is anything else.
   */
  externalDisable(): boolean
  /** Merge a patch (revision-guarded) and return the fresh resolved view. */
  update(patch: Record<string, unknown>, expectedRevision?: number): Promise<{ value?: unknown; revision?: number }>
}

/**
 * Whether the workspace fence is armed for the sidebar's filesystem routes
 * (the settings-page `workspaceFence` switch under the files card's gear).
 * An absent settings service or a missing field keeps the fence ON — the
 * containment default never depends on the settings surface being reachable.
 */
function fenceEnabledOf(getSettings: () => SidebarSettingsFace | undefined): boolean {
  const settings = getSettings()
  const value = settings?.get().value
  if (value === null || typeof value !== 'object') return true
  return (value as Record<string, unknown>).workspaceFence !== false
}

function buildApi(
  ctx: Context,
  resolved: ResolvedSidebarConfig,
  getSettings: () => SidebarSettingsFace | undefined,
  assistantLive: AssistantLiveBuffer,
): Record<string, ApiMethod> {
  const cwdOf = async (payload: unknown): Promise<{ sessionId: string; cwd: string }> => {
    const sessionId = requireString(payload, 'sessionId')
    const record = payload as { cwd?: unknown } | null
    const clientCwd = typeof record?.cwd === 'string' && record.cwd !== '' ? record.cwd : undefined
    return { sessionId, cwd: await sessionCwdOf(ctx, sessionId, clientCwd) }
  }
  /** Resolve the optional Git-panel checkout selector against the authoritative
   * session repository. Unlike `cwd`, `worktree` is never trusted directly. */
  const gitCwdOf = async (payload: unknown): Promise<{ sessionId: string; cwd: string }> => {
    const base = await cwdOf(payload)
    const record = payload as { worktree?: unknown } | null
    const requested = typeof record?.worktree === 'string' && record.worktree !== '' ? record.worktree : undefined
    return { sessionId: base.sessionId, cwd: await git.resolveWorktree(base.cwd, requested) }
  }
  // Background jobs: the LIST rides the harness's `session/jobs` push
  // mirror, so these routes only replay output the model has read (from the
  // session's own event log — no DSH source is touched, the model's
  // job_output cursor is never consumed) and kill (the registry's stock
  // API). A deployment without the jobs registry downgrades kill to a 503.
  const jobsApi: SidebarJobsRoutes = buildJobsApi(ctx, resolved.readLimit)
  // Subagent live previews: one batch request instead of N per-child
  // `subagents.history` calls. The route degrades to a 503 when the host
  // subagent runtime is absent (the page has no topology to show anyway).
  const subagentLiveApi: SidebarSubagentLiveRoutes = buildSubagentLiveApi(ctx)
  return {
    'session.cwd': async (payload) => {
      const { sessionId, cwd } = await cwdOf(payload)
      return { sessionId, cwd, root: rootLabel(cwd), parent: parentOf(cwd) ?? null }
    },
    'fs.tree': async (payload) => {
      const { cwd } = await cwdOf(payload)
      const record = payload as { path?: unknown }
      const target = record.path === undefined ? cwd : await ensureWorkspacePath(cwd, requireString(payload, 'path'), fenceEnabledOf(getSettings))
      return listDirectory(target, resolved.listLimit)
    },
    'fs.search': async (payload) => {
      // The editor side panel's global name search: rooted at the session
      // cwd (not caller-targetable — the walk is unbounded by design and
      // must never escape the workspace), budgeted inside searchFiles.
      const { cwd } = await cwdOf(payload)
      const query = requireString(payload, 'query')
      return searchFiles(cwd, query)
    },
    'fs.read': async (payload) => {
      const { cwd } = await cwdOf(payload)
      // Relative paths are git-derived (status/diff report repo-root-relative
      // names; the untracked diff view reads the file through this route). A
      // child-repo path is relative to the selected repoRoot, not the session
      // cwd; thread it so the path resolves inside the authorized workspace.
      const selected = selectedRepoOf(payload)
      const path = await ensureWorkspacePath(cwd, await resolveGitPath(cwd, requireString(payload, 'path'), selected), fenceEnabledOf(getSettings))
      const { content, truncated, binary, size, head } = await readText(path, resolved.readLimit)
      if (binary) return { kind: 'binary', size, truncated, head }
      return { kind: 'text', content, truncated }
    },
    'fs.write': async (payload) => {
      const { cwd } = await cwdOf(payload)
      const path = await ensureWorkspaceWritePath(cwd, requireString(payload, 'path'), fenceEnabledOf(getSettings))
      const content = requireString(payload, 'content')
      const tmp = `${path}.dsh-sidebar-tmp-${process.pid}`
      try {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(tmp, content, 'utf8')
        await rename(tmp, path)
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => {})
        throw new SidebarError('fs-error', `cannot write "${path}": ${error instanceof Error ? error.message : String(error)}`, 400)
      }
      return { ok: true }
    },
    // The tree row's rename: single-segment name, destination-existence and
    // workspace-root refusals, link-aware (renames the row, not its target).
    // fs-operations.ts owns the containment and shape rules.
    'fs.rename': async (payload) => {
      const { cwd } = await cwdOf(payload)
      return renameWorkspaceEntry({
        cwd,
        path: requireString(payload, 'path'),
        name: requireString(payload, 'name'),
        fence: fenceEnabledOf(getSettings),
      })
    },
    // The tree row's delete (permanent — the host has no trash): recursive
    // for directories, unlinks a symlink row without touching its target.
    'fs.remove': async (payload) => {
      const { cwd } = await cwdOf(payload)
      return removeWorkspaceEntry({
        cwd,
        path: requireString(payload, 'path'),
        fence: fenceEnabledOf(getSettings),
      })
    },
    'git.worktrees': async (payload) => {
      const { cwd } = await gitCwdOf(payload)
      const selected = selectedRepoOf(payload)
      // A workspace container (no repo at cwd) has child repos; the worktree
      // list belongs to the SELECTED child, not the container. Thread the
      // validated repoRoot so linked checkouts of a chosen child appear.
      const base = selected !== undefined ? await git.repoRoot(cwd, selected).catch(() => cwd) : cwd
      return git.worktrees(base)
    },
    'git.status': async (payload) => {
      const { cwd } = await gitCwdOf(payload)
      return git.status(cwd, selectedRepoOf(payload))
    },
    'git.diff': async (payload) => {
      const { cwd } = await gitCwdOf(payload)
      const record = payload as { path?: unknown; staged?: unknown }
      const repoRoot = selectedRepoOf(payload)
      const path = record.path === undefined ? undefined : await resolveGitPath(cwd, requireString(payload, 'path'), repoRoot)
      return { diff: await git.diff(cwd, path, record.staged === true, repoRoot) }
    },
    'git.stage': async (payload) => {
      const { cwd } = await gitCwdOf(payload)
      const record = payload as { path?: unknown }
      const path = record.path === undefined ? undefined : requireString(payload, 'path')
      await git.stage(cwd, path, selectedRepoOf(payload))
      return { ok: true }
    },
    'git.unstage': async (payload) => {
      const { cwd } = await gitCwdOf(payload)
      const record = payload as { path?: unknown }
      const path = record.path === undefined ? undefined : requireString(payload, 'path')
      await git.unstage(cwd, path, selectedRepoOf(payload))
      return { ok: true }
    },
    'git.commit': async (payload) => {
      const { cwd } = await gitCwdOf(payload)
      const message = requireString(payload, 'message')
      await git.commit(cwd, message, selectedRepoOf(payload))
      return { ok: true }
    },
    'git.branch': async (payload) => {
      const { cwd } = await gitCwdOf(payload)
      return git.branches(cwd, selectedRepoOf(payload))
    },
    'git.checkout': async (payload) => {
      const { cwd } = await gitCwdOf(payload)
      await git.checkout(cwd, requireString(payload, 'branch'), selectedRepoOf(payload))
      return { ok: true }
    },
    'git.log': async (payload) => {
      const { cwd } = await gitCwdOf(payload)
      const record = payload as { count?: unknown; skip?: unknown }
      const count = typeof record.count === 'number' && Number.isInteger(record.count) && record.count > 0
        ? record.count
        : undefined
      const skip = typeof record.skip === 'number' && Number.isInteger(record.skip) && record.skip >= 0
        ? record.skip
        : undefined
      return git.log(cwd, count, skip, selectedRepoOf(payload))
    },
    'git.commit-diff': async (payload) => {
      const { cwd } = await gitCwdOf(payload)
      return { diff: await git.commitDiff(cwd, requireString(payload, 'hash'), selectedRepoOf(payload)) }
    },
    'git.discard': async (payload) => {
      const { cwd } = await gitCwdOf(payload)
      const repoRoot = selectedRepoOf(payload)
      await git.discard(cwd, await resolveGitPath(cwd, requireString(payload, 'path'), repoRoot), repoRoot)
      return { ok: true }
    },
    'git.revert': async (payload) => {
      const { cwd } = await gitCwdOf(payload)
      await git.revert(cwd, requireString(payload, 'hash'), selectedRepoOf(payload))
      return { ok: true }
    },
    'git.cherry-pick': async (payload) => {
      const { cwd } = await gitCwdOf(payload)
      await git.cherryPick(cwd, requireString(payload, 'hash'), selectedRepoOf(payload))
      return { ok: true }
    },
    'git.show': async (payload) => {
      const { cwd } = await gitCwdOf(payload)
      const repoRoot = selectedRepoOf(payload)
      // `git show <rev>:<path>` addresses the path inside the revision TREE:
      // repository-relative, exactly the unified diff's own path form (after
      // the a// b/ prefix). The absolute filesystem paths resolveGitPath
      // produces would break the rev:path syntax and fail every read, so the
      // path passes through as-is — it can only address blobs of this repo's
      // own revisions, the same surface git.diff/git.log already expose.
      const path = requireString(payload, 'path')
      const rev = requireString(payload, 'rev')
      return { content: await git.show(cwd, rev, path, repoRoot) }
    },
    // The session's file-tool events for the changes tab's session lens
    // (and its badge): the CLIENT runtime's sessions face has no event-log
    // access, so the events cross the wire here — live session log first,
    // the persisted logical log for not-yet-hydrated sessions. Only the
    // two event types the lens folds are sent, narrowed to `seq > afterSeq`
    // so polling is a small delta, with the same recent-window cap the
    // client accumulator applies.
    'changes.ops': async (payload) => {
      const sessionId = requireString(payload, 'sessionId')
      const rawAfter = (payload as { afterSeq?: unknown } | null)?.afterSeq
      if (rawAfter !== undefined
        && (typeof rawAfter !== 'number' || !Number.isSafeInteger(rawAfter) || rawAfter < 0)) {
        throw new SidebarError('bad-request', 'afterSeq must be a non-negative integer')
      }
      // An absent cursor means "from the very first event" — a session whose
      // log opens on a tool event (subagent seeds do) carries seq 0, which a
      // literal `> 0` comparison would drop, so the absent case floors at -1.
      const afterSeq = rawAfter ?? -1
      let events: readonly SidebarSessionEvent[] | undefined = ctx.sessions.get(sessionId)?.snapshotEvents()
      if (events === undefined) {
        const persistence = ctx.get('sessionPersistence')
        if (persistence !== undefined) {
          try {
            events = (await readPersistedSession(persistence, sessionId)).events
          } catch {
            // Cold read unavailable (session never persisted): an empty
            // window is the honest answer, not a wire error.
          }
        }
      }
      if (events === undefined) return { events: [], lastSeq: Math.max(afterSeq, 0) }
      const CHANGES_EVENTS_CAP = 4000
      const filtered = events.filter(
        event => (event.type === 'tool/call' || event.type === 'tool/result') && event.seq > afterSeq,
      )
      const window = filtered.length > CHANGES_EVENTS_CAP ? filtered.slice(filtered.length - CHANGES_EVENTS_CAP) : filtered
      return { events: window, lastSeq: window.at(-1)?.seq ?? afterSeq }
    },
    // Background jobs: list the caller's own jobs, read one job's output (a
    // REPLAY of what the model has read so far, from the owner session's
    // event log — the model's job_output cursor is never touched, so the
    // human pane can never steal the agent's bytes), and kill one job. The
    // list route exists because DSH 0.1.7 deleted the session/jobs push
    // mirror the Tasks page used to read. Kill is fenced to the owning
    // session by the jobs registry.
    'jobs.list': (payload) => jobsApi.list(payload),
    'jobs.output': (payload) => jobsApi.output(payload),
    'jobs.kill': (payload) => jobsApi.kill(payload),
    // Subagent live previews: one batch request per refresh; the route folds
    // the newest text/tool activity of every running child in the tree.
    'subagents.live': (payload) => subagentLiveApi.live(payload),
    // The side card preferences. The settings service is optional in the
    // composition; while absent the routes report undefined and the client
    // keeps the schema defaults. Writes are revision-guarded: a stale editor
    // is refused with settings-conflict so a concurrent change is never
    // silently overwritten (mirror of the settings seam's own guard).
    'settings.get': () => {
      const settings = getSettings()
      return settings === undefined
        ? { value: undefined, revision: undefined, externalDisable: false }
        : { ...settings.get(), externalDisable: settings.externalDisable() }
    },
    'settings.update': async (payload) => {
      const settings = getSettings()
      if (settings === undefined) {
        throw new SidebarError('settings-rejected', 'the settings service is not mounted in this deployment', 503)
      }
      const record = payload as { patch?: unknown; expectedRevision?: unknown } | null
      const patch = record?.patch
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new SidebarError('bad-request', 'patch must be a plain object')
      }
      const expectedRevision = typeof record?.expectedRevision === 'number' ? record.expectedRevision : undefined
      try {
        return await settings.update(patch as Record<string, unknown>, expectedRevision)
      } catch (error) {
        if (error instanceof SettingsConflictError) {
          throw new SidebarError('settings-conflict', error.message, 409)
        }
        throw new SidebarError('settings-rejected', error instanceof Error ? error.message : String(error), 400)
      }
    },
    // External open for the file tree's "open with" menu: reveal a path in
    // the OS file manager, or hand a custom-scheme URL (vscode://,
    // cursor://, zed://, custom editors) to its registered handler. The
    // client is a browser renderer where raw scheme navigation is
    // unreliable, so the launch always goes through the host — the same
    // fence as every other route, argv-only (no shell interpolation).
    'open.external': (payload) => {
      const record = payload as { action?: unknown } | null
      const action = record?.action
      if (action === 'reveal') return launchExternal('reveal', requireString(payload, 'path'))
      if (action === 'url') return launchExternal('url', requireString(payload, 'url'))
      throw new SidebarError('bad-request', 'action must be "reveal" or "url"')
    },
    // Side Chat: create a side-thread child seeded with the parent's full
    // log up to now, deliver follow-ups (cold-resuming when the thread's
    // agent is gone), abort a running thread, and release a thread's agent.
    // Every operation runs through these routes because subagent-origin
    // identities are fenced from the generic session RPCs (agent-lookup
    // ownership), and the thread is created with a CUSTOM seed the stock
    // fork APIs cannot express.
    ...buildSidechatApi(ctx, assistantLive),
  }
}

/** The npm package name of this plugin, exactly as its Loader row declares it. */
const SIDEBAR_PACKAGE_NAME = 'dsh-better-sidebar'

/**
 * Profile entry id of the sibling `dsh-web-ui` right panel this sidebar yields
 * to when it is the active provider. Kept as a literal: it is that plugin's
 * own mount choice, not a contract this plugin can derive.
 */
const AIONUI_PANEL_ENTRY = 'aionui-panel'

/** The file-backed settings document DSH 0.1.7 retired. */
const LEGACY_SETTINGS_FILE = 'settings.yaml'

/**
 * The Loader entry id of this plugin's own row.
 *
 * DSH 0.1.7 addresses settings forms by profile entry id, and that id is a
 * mount choice rather than a package property: this bundle's patch uses
 * `better-sidebar`, while an aggregate bundle mounts the same package under
 * its own id. The row is therefore identified by the package name plus fiber
 * identity, with an enabled same-name row as the fallback for the moment
 * before the fiber is attached.
 * @param ctx - the plugin's own context.
 * @returns the row's configured id, or undefined when no row can be identified.
 */
function ownEntryId(ctx: Context): string | undefined {
  let fallback: string | undefined
  try {
    for (const entry of ctx.loader.entries()) {
      const id = entry.options.id
      if (entry.options.name !== SIDEBAR_PACKAGE_NAME || typeof id !== 'string' || id === '') continue
      if (entry.fiber === ctx.fiber) return id
      if (entry.disabled !== true && fallback === undefined) fallback = id
    }
  } catch {
    // A loader that does not expose its entries leaves the settings face
    // absent; the client keeps the schema defaults, which is also what a
    // deployment without the settings service does.
    return undefined
  }
  return fallback
}

/**
 * Read this plugin's preference section out of the retired `settings.yaml`.
 *
 * Both names are tried: the settings service renames the document before it
 * imports any section, so on a host that already booted once only the
 * `.imported` copy is left, while a host migrated for the first time may still
 * be mid-import.
 * @param home - the harness home the retired document lives under.
 * @returns the section's own fields, or undefined when no usable section exists.
 */
async function readLegacyPrefs(home: string): Promise<Record<string, unknown> | undefined> {
  const declared = new Set(Object.keys(Config.dict ?? {}))
  for (const name of [`${LEGACY_SETTINGS_FILE}.imported`, LEGACY_SETTINGS_FILE]) {
    let text: string
    try {
      text = await readFile(join(home, name), 'utf8')
    } catch {
      continue
    }
    let document: unknown
    try {
      document = parseYaml(text)
    } catch {
      continue
    }
    if (document === null || typeof document !== 'object' || Array.isArray(document)) continue
    const section = (document as Record<string, unknown>)[SIDEBAR_PREFS_NS]
    if (section === null || typeof section !== 'object' || Array.isArray(section)) continue
    // Drop fields the current row schema no longer declares (the retired
    // terminal and browser keys, `defaultWidthPercent`, …). A form write
    // validates every key against the schema, so one unknown field would
    // reject the whole patch and lose exactly what this import exists to save.
    const filtered = Object.fromEntries(
      Object.entries(section as Record<string, unknown>).filter(([key]) => declared.has(key)),
    )
    if (Object.keys(filtered).length > 0) return filtered
  }
  return undefined
}

/**
 * Why a legacy preference import did or did not happen.
 *
 * Every one of these is a normal outcome on some deployment, but a silent
 * early return is exactly the failure shape this release is full of: an
 * operator upgrading a host cannot tell "there was nothing to migrate" from
 * "the import never ran". The caller therefore logs the outcome.
 */
type LegacyImportOutcome =
  /** The retired section was found and written into the row. */
  | 'imported'
  /** No `profileContext`, so the home (and the document) cannot be located. */
  | 'no-profile-home'
  /** The settings service exposes no form for this row. */
  | 'no-form'
  /** The row already carries user values; the import must never overwrite them. */
  | 'already-configured'
  /** Neither the live nor the migrated document carries a usable section. */
  | 'no-legacy-section'
  /** The write itself failed; the caller's catch reports it. */
  | 'rejected'

/**
 * One-time import of the Side card preferences a pre-0.1.7 release persisted.
 *
 * The 0.1.6 line stored them through the file-backed settings provider, in
 * `$DSH_HOME/settings.yaml` under a `dsh-better-sidebar` section. This release
 * deletes that provider; its migration renames the document to
 * `settings.yaml.imported` and re-imports each section into the entry of the
 * SAME id — and because a section key is the package name while the row id is
 * a mount choice, DSH warns and leaves this section behind. Without this
 * import every existing user would silently lose their preferences.
 *
 * The import runs only while the row's user layer is still empty, so it can
 * never overwrite a value set after the upgrade, and re-running it is a no-op.
 * @param ctx - host plugin context (profile home, logger).
 * @param settings - the settings forms service.
 * @param ns - this plugin row's entry id.
 * @returns which outcome the import reached.
 */
async function importLegacyPrefs(
  ctx: Context,
  settings: SidebarSettingsService,
  ns: string,
): Promise<LegacyImportOutcome> {
  const home = ctx.profileContext?.home
  if (home === undefined) return 'no-profile-home'
  const row = settings.describe().find(candidate => candidate.ns === ns)
  if (row === undefined) return 'no-form'
  const user = row.user
  if (user !== null && typeof user === 'object' && Object.keys(user).length > 0) return 'already-configured'
  const section = await readLegacyPrefs(home)
  if (section === undefined) return 'no-legacy-section'
  await settings.update(ns, section)
  return 'imported'
}

/**
 * Plugin body: mount the fenced routes and the sidebar_open push socket.
 * @param ctx - host plugin context (webServer, sessions, webRuntime).
 * @param config - deployment-provided limits; the Loader validates against
 * {@link Config} and fills defaults, direct callers get them from
 * {@link resolveSidebarConfig}.
 */
export function apply(ctx: Context, config?: SidebarConfig): void {
  const resolved = resolveSidebarConfig(config)
  // The web runtime's bind-derived trust list (boot-sampled LAN literals
  // plus --trusted-host authorities) — the authoritative source the /api
  // gateway fence derives its list from. Read per request from the live
  // service value; a replaced list takes effect without a plugin restart.
  const fence = (req: SidebarHttpRequest): boolean => isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)
  // The model-facing open-request registry: queues `sidebar_open` requests
  // per session and pushes them to connected sidebar views over the
  // `/sidebar/ws/agent-opens` socket.
  const agentOpenRegistry = new AgentOpenRegistry()

  // DSH 0.1.7 replaced the registrable settings namespace with a forms
  // service over the profile's own entries: a form is addressed by the plugin
  // ROW's Loader entry id, its schema is this module's exported `Config`, and
  // its value is the live fiber config. The client still reaches the
  // preferences through the plugin's own fenced routes below
  // ('settings.get'/'settings.update'), which now call `describe`/`update`.
  // Deployments without a settings service simply never fill the face and the
  // client falls back to the schema defaults.
  let settingsFace: SidebarSettingsFace | undefined
  // The model-facing `sidebar_open` tool is gated on the side-card setting
  // `agentOpenTools` (default off): nothing is injected until the user turns
  // the feature on; turning it off mid-session unregisters the tool.
  let openToolsDisposers: (() => void) | null = null
  ctx.inject(['settings'], (sctx) => {
    // The form is the plugin ROW, so the id is whatever mounted this package:
    // this bundle's patch uses `better-sidebar`, an aggregate bundle mounts
    // the same package under its own id. A row the loader cannot identify has
    // no form, so the face stays absent and the client keeps the defaults.
    const ns = ownEntryId(ctx)
    if (ns === undefined) {
      ctx.logger?.warn?.('dsh-better-sidebar: no loader row for this package; Side card preferences stay at defaults')
      return
    }
    // The plugin ships its own Side card settings section, so the native
    // auto-form is opted out — otherwise Settings would render the same ~30
    // preference fields twice. The policy does not affect reads or writes.
    ctx.effect(
      () => sctx.settings.configure({ auto: false }, ctx.fiber),
      'dsh-better-sidebar: settings page policy',
    )
    const viewOf = (): { value?: unknown; revision?: number } => {
      const descriptor = sctx.settings.describe({ redactSecrets: true }).find(candidate => candidate.ns === ns)
      return descriptor === undefined
        ? { value: undefined, revision: undefined }
        : { value: descriptor.value, revision: descriptor.revision }
    }
    // Mutual exclusion with the dsh-web-ui family right panel: the aionui
    // panel's provider choice (`aionui-panel.rightPanel`) is the authority.
    // While it resolves to 'aionui-panel', this sidebar must not mount. A form
    // is addressed by its owner's profile entry id, which for that plugin is
    // the string its pre-0.1.7 section already used; absent row (no aionui
    // installed) = not disabled.
    const externalDisable = (): boolean => {
      const descriptor = sctx.settings.describe({ redactSecrets: true })
        .find(candidate => candidate.ns === AIONUI_PANEL_ENTRY)
      const value = descriptor?.value as { rightPanel?: unknown } | undefined
      return value?.rightPanel === 'aionui-panel'
    }
    // The model-facing open tool is gated on `agentOpenTools`
    // (default off): nothing is injected until the user turns the feature
    // on, and turning it off mid-session unregisters the tool and drops the
    // queued (undelivered) open requests. Already-delivered opens keep their
    // tabs — the tools' only lever is the queue, not the rendered state.
    const prefsOf = (): SidebarPrefs => {
      const value = viewOf().value
      return value !== null && typeof value === 'object' ? value as SidebarPrefs : SIDEBAR_PREFS_DEFAULTS
    }
    const syncOpenToolsGate = (): void => {
      if (prefsOf().agentOpenTools === true) {
        if (openToolsDisposers === null) {
          openToolsDisposers = registerOpenTool(
            ctx,
            agentOpenRegistry,
            (sessionId) => sessionCwdOf(ctx, sessionId),
            prefsOf,
          )
        }
      } else if (openToolsDisposers !== null) {
        openToolsDisposers()
        openToolsDisposers = null
        agentOpenRegistry.drainAll()
      }
    }
    settingsFace = {
      // Two triggers cover what the 0.1.6 namespace watch used to: the
      // plugin's own writes flow through `update`, and the client re-reads
      // this face on every `settings/document-updated` push. (The host emits
      // that event on the settings service's own context, which is not an
      // ancestor of this plugin's fiber, so a listener here would never run.)
      get: () => { syncOpenToolsGate(); return viewOf() },
      externalDisable,
      update: async (patch, expectedRevision) => {
        await sctx.settings.update(ns, patch, expectedRevision)
        return viewOf()
      },
    }
    syncOpenToolsGate()
    // A pre-0.1.7 release persisted these preferences through the file-backed
    // settings provider, which this release deleted. Import that section once.
    //
    // The loader must settle first: `describe()` only lists an entry whose
    // fiber is ACTIVE, and this callback runs the moment the settings SERVICE
    // appears — while the loader is still mounting rows, so this plugin's own
    // row is not in the form list yet and the import would silently find
    // "no form" and do nothing. Upstream's own settings migration waits the
    // same way (`ctx.root.loader.await().then(...)`).
    void Promise.resolve(ctx.loader?.await?.()).then(
      () => importLegacyPrefs(ctx, sctx.settings, ns),
    ).then((outcome) => {
      if (outcome === 'no-profile-home' || outcome === 'no-form') {
        ctx.logger.warn('dsh-better-sidebar: legacy preference import could not run (%s)', outcome)
        return
      }
      ctx.logger.info('dsh-better-sidebar: legacy preference import: %s', outcome)
    }).catch((error: unknown) => {
      ctx.logger.warn('dsh-better-sidebar: legacy preference import was rejected')
      ctx.logger.warn(error)
    })
  })

  // ── JSON API ────────────────────────────────────────────────────────────
  // The live assistant stream buffer: DSH 0.1.5 publishes in-flight model
  // deltas as process-local `agent/assistant-stream` frames instead of the
  // durable `assistant/chunk` events 0.1.2 logged, so the side-chat
  // transcript and the inherited in-progress snapshot read them here. The
  // effect releases the listener on fiber disposal.
  const assistantLive = createAssistantLiveBuffer(ctx)
  ctx.effect(() => () => { assistantLive.dispose() }, 'dsh-better-sidebar: live assistant stream buffer')
  const api = buildApi(ctx, resolved, () => settingsFace, assistantLive)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/sidebar/api',
    handler: async (req, res) => {
      if (!fence(req)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith('/sidebar/api/') ? pathname.slice('/sidebar/api/'.length) : undefined
      if (method === undefined || method.includes('/')) {
        writeError(res, new SidebarError('not-found', 'unknown sidebar API method', 404))
        return
      }
      try {
        const payload = await readJsonBody(req)
        const handler = api[method]
        if (handler === undefined) {
          throw new SidebarError('not-found', `unknown sidebar API method "${method}"`, 404)
        }
        writeOk(res, await handler(payload))
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'dsh-better-sidebar: /sidebar/api routes')

  // ── Raw upload route ───────────────────────────────────────────────────
  // One request writes one file without JSON/base64 inflation. Folder uploads
  // send each file with a relativePath, preserving the selected directory
  // tree. Bytes stream to a temp sibling and are renamed into place, so a
  // failed or oversized upload never leaves a partial file (see
  // fs-operations.ts for the containment and shape rules).
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/sidebar/upload',
    handler: async (req, res) => {
      if (!fence(req)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const sessionId = url.searchParams.get('sessionId')
        const dir = url.searchParams.get('dir')
        const relativePath = url.searchParams.get('relativePath')
        if (sessionId === null || dir === null || relativePath === null || relativePath.trim() === '') {
          throw new SidebarError('bad-request', 'sessionId, dir, and relativePath are required')
        }
        const cwd = await sessionCwdOf(ctx, sessionId, url.searchParams.get('cwd') ?? undefined)
        const { path, size } = await writeWorkspaceUpload({
          cwd,
          dir,
          relativePath,
          chunks: req,
          limit: resolved.uploadLimit,
          fence: fenceEnabledOf(() => settingsFace),
        })
        writeOk(res, { path, size })
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'dsh-better-sidebar: /sidebar/upload route')

  // ── Lazy chunk route (client bundle splits) ─────────────────────────────
  // Serves the client half's split bundles (lib/client-<name>.js) so the
  // heavy preview/terminal libraries load on first use, not at page start
  // (see bundle-route.ts / src/client/chunk-loader.ts).
  ctx.effect(() => registerBundleRoute(ctx, fence), 'dsh-better-sidebar: /sidebar/bundle chunk route')

  // ── Media route (images for the editor) ─────────────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/sidebar/file',
    handler: async (req, res) => {
      if (!fence(req)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      if (req.method !== 'GET') {
        res.writeHead(405)
        res.end()
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const sessionId = url.searchParams.get('sessionId')
        const raw = url.searchParams.get('path')
        if (sessionId === null || raw === null) throw new SidebarError('bad-request', 'sessionId and path are required')
        const cwd = await sessionCwdOf(ctx, sessionId, url.searchParams.get('cwd') ?? undefined)
        let target = raw
        if (!isAbsolute(target)) {
          target = join(cwd, target)
        } else if (!isWithin(cwd, target)) {
          const candidate = join(cwd, target.replace(/^[\/\\]+/, ''))
          if (isWithin(cwd, candidate)) {
            target = candidate
          }
        }
        const path = await ensureWorkspacePath(cwd, target, fenceEnabledOf(() => settingsFace))
        const info = await stat(path)
        if (!info.isFile() || info.size > resolved.mediaLimit) {
          throw new SidebarError('fs-error', 'not a file or too large', 400)
        }
        const type = mediaTypeForPath(path)
        const body = await readFile(path)
        // Raw bytes either way (binary-safe); ?download=1 switches the
        // disposition so the browser saves the file instead of showing it.
        const headers: Record<string, string> = { 'content-type': type, 'cache-control': 'no-cache' }
        if (url.searchParams.get('download') === '1') {
          headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(basename(path))}`
        }
        res.writeHead(200, headers)
        res.end(body)
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'dsh-better-sidebar: /sidebar/file media route')

  // ── HTML preview route (sandboxed HTML + its relative assets) ───────────
  // Serves files under the session cwd for the built-in HTML previewer. The
  // URL is path-encoded (see html-route.ts) so the previewed page's relative
  // assets (./style.css, img/x.png) resolve back into this route with the
  // session scope intact — a query-encoded URL would drop the scope when the
  // browser resolves relatives. Every response carries the CSP `sandbox`
  // directive: inside the editor's iframe the sandbox ATTRIBUTE is the
  // boundary, this header is defense-in-depth so even a top-level load of
  // the URL (e.g. a popup opened by a previewed page) stays in an opaque
  // origin with no same-origin access to the GUI.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/sidebar/html',
    handler: async (req, res) => {
      if (!fence(req)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      if (req.method !== 'GET') {
        res.writeHead(405)
        res.end()
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const decoded = decodeHtmlUrl(url.pathname)
        if (!decoded.ok) {
          writeError(res, new SidebarError('bad-request', decoded.message, decoded.status))
          return
        }
        const { sessionId, path } = decoded.ref
        // The session's authoritative cwd (client cwd cannot ride in the URL
        // — the path encoding has no query; a detached first request falls
        // back to the process cwd and is normally refused by the workspace
        // real-path guard, with the same semantics as the media route's
        // fallback.
        const cwd = await sessionCwdOf(ctx, sessionId)
        let target = path
        if (!isWithin(cwd, target)) {
          const candidate = join(cwd, target.replace(/^[\/\\]+/, ''))
          if (isWithin(cwd, candidate)) {
            target = candidate
          }
        }
        const absolute = await ensureWorkspacePath(cwd, target, fenceEnabledOf(() => settingsFace))
        const info = await stat(absolute)
        if (!info.isFile() || info.size > resolved.mediaLimit) {
          throw new SidebarError('fs-error', 'not a file or too large', 400)
        }
        const type = mediaTypeForPath(absolute)
        const body = await readFile(absolute)
        res.writeHead(200, {
          'content-type': type === 'text/html' ? 'text/html; charset=utf-8' : type,
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          // The sandbox directive (no allow-same-origin → opaque origin) is
          // the previewer's security boundary even for top-level loads;
          // object-src 'none' blocks plugin embeds.
          'content-security-policy': "sandbox allow-scripts allow-popups allow-downloads allow-modals; object-src 'none'",
        })
        res.end(body)
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'dsh-better-sidebar: /sidebar/html preview route')

  // ── Agent opens push WebSocket ─────────────────────────────────────────
  // Pushes `sidebar_open` requests for one session to the sidebar view: the
  // host queues each request in the registry (consume-on-send), so a
  // connected view applies it immediately and a disconnected one gets the
  // replay when it attaches. The client mirrors each request into an
  // editor / folder-window / browser tab open.
  const agentOpenWss = new WebSocketServer({ noServer: true })
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: '/sidebar/ws/agent-opens',
    handler: (req, socket, head) => {
      if (!fence(req)) {
        socket.destroy()
        return
      }
      agentOpenWss.handleUpgrade(req as unknown as IncomingMessage, socket as unknown as Duplex, head as Buffer, (ws) => {
        void attachAgentOpen(agentOpenRegistry, ws, req)
      })
    },
  }), 'dsh-better-sidebar: agent-opens push WebSocket')

  // ── File-tree directory watch WebSocket ────────────────────────────────
  // The file tree lists a folder when it is expanded and would otherwise stay
  // stale for the rest of the session. One socket per session carries the
  // reader's expanded-folder set; the host watches exactly those directories
  // and pushes a debounced notice per change, so the tree re-lists in place.
  // Paths are resolved through the same workspace fence as `fs.tree`, so a
  // watch can never observe a directory the tree itself could not list.
  const fsWatchWss = new WebSocketServer({ noServer: true })
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: '/sidebar/ws/fs-watch',
    handler: (req, socket, head) => {
      if (!fence(req)) {
        socket.destroy()
        return
      }
      fsWatchWss.handleUpgrade(req as unknown as IncomingMessage, socket as unknown as Duplex, head as Buffer, (ws) => {
        void attachFsWatch(ctx, ws, req, () => fenceEnabledOf(() => settingsFace))
      })
    },
  }), 'dsh-better-sidebar: file-tree watch WebSocket')

  ctx.effect(() => () => {
    openToolsDisposers?.()
    agentOpenRegistry.dispose()
    agentOpenWss.close()
    fsWatchWss.close()
  }, 'dsh-better-sidebar: teardown')
}

/** One `watch` / `unwatch` frame from the file tree. */
interface FsWatchFrame {
  op?: unknown
  path?: unknown
}

/**
 * Serve one session's directory-watch socket until it closes.
 *
 * Frames are `{ op: 'watch' | 'unwatch', path }`, where `path` is relative to
 * the session's workspace exactly like `fs.tree`'s. A path that fails
 * resolution, or a rejection past the watcher cap, is answered with
 * `{ dir, ok: false }` so the client can stop asking rather than retry.
 * @param ctx - host plugin context (session cwd, workspace fence).
 * @param ws - the accepted socket.
 * @param req - the upgrade request carrying `?sessionId=`.
 * @param fenceEnabled - whether the workspace containment fence is on.
 */
async function attachFsWatch(
  ctx: Context,
  ws: WebSocket,
  req: SidebarHttpRequest,
  fenceEnabled: () => boolean,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const sessionId = url.searchParams.get('sessionId')
    if (sessionId === null) {
      ws.close(1008, 'sessionId is required')
      return
    }
    const watchers = createDirectoryWatchers(
      (event) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ dir: event.dir }))
      },
      (dir, error) => {
        ctx.logger.warn('dsh-better-sidebar: cannot watch %s', dir)
        ctx.logger.warn(error)
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ dir, ok: false }))
      },
    )
    ws.on('close', () => { watchers.close() })
    ws.on('error', () => { watchers.close() })
    ws.on('message', (data) => {
      void handleFsWatchFrame(ctx, ws, watchers, sessionId, data, fenceEnabled)
    })
  } catch (error) {
    ws.close(1011, error instanceof Error ? error.message : String(error))
  }
}

/**
 * Apply one watch frame.
 * @param ctx - host plugin context.
 * @param ws - the owning socket.
 * @param watchers - the socket's watcher set.
 * @param sessionId - the session the socket was opened for.
 * @param data - the raw frame text.
 * @param fenceEnabled - whether the workspace containment fence is on.
 */
async function handleFsWatchFrame(
  ctx: Context,
  ws: WebSocket,
  watchers: DirectoryWatchers,
  sessionId: string,
  data: unknown,
  fenceEnabled: () => boolean,
): Promise<void> {
  let frame: FsWatchFrame
  try {
    frame = JSON.parse(typeof data === 'string' ? data : String(data)) as FsWatchFrame
  } catch {
    return
  }
  const path = typeof frame.path === 'string' ? frame.path : undefined
  if (path === undefined || path === '') return
  try {
    const cwd = await sessionCwdOf(ctx, sessionId)
    const dir = await ensureWorkspacePath(cwd, path, fenceEnabled())
    if (frame.op === 'unwatch') {
      watchers.remove(dir)
      return
    }
    if (frame.op !== 'watch') return
    const ok = watchers.add(dir)
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ dir, ok }))
  } catch (error) {
    // The tree keeps working without live refresh; a refused path is reported
    // once so the client stops asking for it.
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ dir: path, ok: false, reason: error instanceof Error ? error.message : String(error) }))
    }
  }
}

/** Push queued `sidebar_open` requests for one session to a connected view. */
async function attachAgentOpen(
  registry: AgentOpenRegistry,
  ws: WebSocket,
  req: SidebarHttpRequest,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const sessionId = url.searchParams.get('sessionId')
    if (sessionId === null) {
      ws.close(1008, 'sessionId is required')
      return
    }
    const send = (request: AgentOpenRequest): void => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(request))
      }
    }
    // Attach replays the queued (undelivered) requests for this session; the
    // disposer detaches the view on socket close/error so later opens queue
    // instead of accumulating on a dead socket.
    const unsubscribe = registry.attach(sessionId, send)
    ws.on('close', () => { unsubscribe() })
    ws.on('error', () => { unsubscribe() })
  } catch (error) {
    ws.close(1011, error instanceof Error ? error.message : String(error))
  }
}
