/**
 * dsh-better-sidebar host half: the /sidebar JSON API (explorer listing, file
 * read/write, git), the /sidebar/file media route (images), the /sidebar/html
 * preview route, the /sidebar/bundle lazy-chunk route (client code splits),
 * and the terminal WebSocket upgrade. Every route passes the same
 * browser-trust fence as the /api gateway — Host-header loopback or the
 * web runtime's `trustedHosts` (LAN IP literals sampled at boot plus
 * `--trusted-host` authorities), read per request from the live service
 * value so the fence tracks the same trust source the /api gateway derives
 * its list from.
 *
 * All operations are conversation-scoped: requests carry a sessionId, the
 * session's authoritative cwd comes from the session store, and terminal
 * processes are keyed by session.
 */
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { Context, SidebarHttpRequest } from './context-types.ts'
import {
  Config,
  PrefsSchema,
  resolveSidebarConfig,
  SIDEBAR_PREFS_NS,
  type ResolvedSidebarConfig,
  type SidebarConfig,
  type SidebarPrefs,
} from './config.ts'
import { isWithin, parentOf, requireAbsolute, listDirectory, rootLabel } from './fs-tree.ts'
import { writeWorkspaceUpload } from './fs-operations.ts'
import { searchFiles } from './fs-search.ts'
import { decodeHtmlUrl } from './html-route.ts'
import { extractFrameAncestors } from './browser-probe.ts'
import { isTrustedApiRequest, isLoopbackHostname } from './trust-fence.ts'
import { registerBundleRoute } from './bundle-route.ts'
import * as git from './git.ts'
import { SettingsConflictError, settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { defaultShell, ensureSpawnHelper, PtyManager, shellDisplayName } from './pty-manager.ts'
import { AgentPtyRegistry, clampDims, type AgentTerminalHandle } from './agent-pty.ts'
import {
  DSH_NODE_PTY_RANGE,
  depsStatus,
  loadNodePty,
  PTY_DEPS_MISSING,
} from './pty-deps.ts'
import { registerTools } from './tools.ts'
import { buildJobsApi, type SidebarJobsRoutes } from './jobs-routes.ts'
import { readJsonBody, requireString, SidebarError, writeError, writeJson, writeOk } from './wire.ts'

export { Config }
export type { SidebarConfig, ResolvedSidebarConfig }
// Re-export the Context augmentation (declare module 'cordis') so consumers
// `import type {} from 'dsh-better-sidebar'` and gain `ctx.betterSidebar`.
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
 * list-summary cwd is used; the process cwd is the last resort (blank
 * sessions have no cwd anywhere yet). Never throws for a missing cwd, so
 * explorer/git/terminal work from first paint instead of surfacing
 * "session ... has no working directory".
 */
function sessionCwdOf(ctx: Context, sessionId: string, clientCwd?: string): string {
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
  return process.cwd()
}

/**
 * Resolve a path that a git command reported — `git status`/`git diff`
 * print paths RELATIVE TO THE REPO TOP LEVEL, which may sit above the
 * session cwd (a session inside a subdirectory of a repository). Absolute
 * paths pass through; relative ones join the repo root (falling back to the
 * cwd when the root cannot be resolved, e.g. a bare directory).
 */
async function resolveGitPath(cwd: string, raw: string): Promise<string> {
  if (isAbsolute(raw)) return requireAbsolute(raw)
  const root = await git.repoRoot(cwd).catch(() => cwd)
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
    return { content: binary ? '' : slice.toString('utf8'), truncated, binary, size, head }
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

/** Build the API method table bound to the plugin context, pty manager, agent pty registry, resolved config, and effective terminal shell. */
/**
 * Resolve the settings-page terminal shell overrides (the terminal card's
 * gear rows). Empty fields mean "unset": keep the yaml `config.shell` /
 * `shellArgs` (or the platform auto-resolution). The settings page is the
 * runtime complement to the boot-time yaml — same contract, later binding:
 * the values here win for terminals opened afterwards.
 */
function shellOverridesOf(getSettings: () => SidebarSettingsFace | undefined): { shell?: string; shellArgs?: string[] } {
  const settings = getSettings()
  const value = settings?.get().value
  if (value === null || typeof value !== 'object') return {}
  const record = value as Record<string, unknown>
  const shell = typeof record.terminalShell === 'string' ? record.terminalShell.trim() : ''
  const args = typeof record.terminalShellArgs === 'string' ? record.terminalShellArgs.trim() : ''
  return {
    shell: shell === '' ? undefined : shell,
    shellArgs: args === '' ? undefined : args.split(/\s+/).filter(Boolean),
  }
}

function buildApi(
  ctx: Context,
  ptyManager: PtyManager | null,
  agentPtyRegistry: AgentPtyRegistry | null,
  resolved: ResolvedSidebarConfig,
  terminalShell: string,
  getSettings: () => SidebarSettingsFace | undefined,
): Record<string, ApiMethod> {
  const cwdOf = (payload: unknown): { sessionId: string; cwd: string } => {
    const sessionId = requireString(payload, 'sessionId')
    const record = payload as { cwd?: unknown } | null
    const clientCwd = typeof record?.cwd === 'string' && record.cwd !== '' ? record.cwd : undefined
    return { sessionId, cwd: sessionCwdOf(ctx, sessionId, clientCwd) }
  }
  // Background jobs: the LIST rides the harness's `session/jobs` push
  // mirror, so these routes only replay output the model has read (from the
  // session's own event log — no DSH source is touched, the model's
  // job_output cursor is never consumed) and kill (the registry's stock
  // API). A deployment without the jobs registry downgrades kill to a 503.
  const jobsApi: SidebarJobsRoutes = buildJobsApi(ctx, resolved.readLimit)
  return {
    'session.cwd': (payload) => {
      const { sessionId, cwd } = cwdOf(payload)
      return { sessionId, cwd, root: rootLabel(cwd), parent: parentOf(cwd) ?? null }
    },
    'fs.tree': async (payload) => {
      const { cwd } = cwdOf(payload)
      const record = payload as { path?: unknown }
      const target = record.path === undefined ? cwd : requireAbsolute(requireString(payload, 'path'))
      return listDirectory(target, resolved.listLimit)
    },
    'fs.search': async (payload) => {
      // The editor side panel's global name search: rooted at the session
      // cwd (not caller-targetable — the walk is unbounded by design and
      // must never escape the workspace), budgeted inside searchFiles.
      const { cwd } = cwdOf(payload)
      const query = requireString(payload, 'query')
      return searchFiles(cwd, query)
    },
    'fs.read': async (payload) => {
      const { cwd } = cwdOf(payload)
      // Relative paths are git-derived (status/diff report repo-root-relative
      // names; the untracked diff view reads the file through this route).
      const path = await resolveGitPath(cwd, requireString(payload, 'path'))
      const { content, truncated, binary, size, head } = await readText(path, resolved.readLimit)
      if (binary) return { kind: 'binary', size, truncated, head }
      return { kind: 'text', content, truncated }
    },
    'fs.write': async (payload) => {
      const { cwd } = cwdOf(payload)
      const path = requireAbsolute(requireString(payload, 'path'))
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
    'git.status': async (payload) => {
      const { cwd } = cwdOf(payload)
      return git.status(cwd)
    },
    'git.diff': async (payload) => {
      const { cwd } = cwdOf(payload)
      const record = payload as { path?: unknown; staged?: unknown }
      const path = record.path === undefined ? undefined : await resolveGitPath(cwd, requireString(payload, 'path'))
      return { diff: await git.diff(cwd, path, record.staged === true) }
    },
    'git.stage': async (payload) => {
      const { cwd } = cwdOf(payload)
      const record = payload as { path?: unknown }
      const path = record.path === undefined ? undefined : requireString(payload, 'path')
      await git.stage(cwd, path)
      return { ok: true }
    },
    'git.unstage': async (payload) => {
      const { cwd } = cwdOf(payload)
      const record = payload as { path?: unknown }
      const path = record.path === undefined ? undefined : requireString(payload, 'path')
      await git.unstage(cwd, path)
      return { ok: true }
    },
    'git.commit': async (payload) => {
      const { cwd } = cwdOf(payload)
      const message = requireString(payload, 'message')
      await git.commit(cwd, message)
      return { ok: true }
    },
    'git.branch': async (payload) => {
      const { cwd } = cwdOf(payload)
      return git.branches(cwd)
    },
    'git.checkout': async (payload) => {
      const { cwd } = cwdOf(payload)
      await git.checkout(cwd, requireString(payload, 'branch'))
      return { ok: true }
    },
    'git.log': async (payload) => {
      const { cwd } = cwdOf(payload)
      const record = payload as { count?: unknown; skip?: unknown }
      const count = typeof record.count === 'number' && Number.isInteger(record.count) && record.count > 0
        ? record.count
        : undefined
      const skip = typeof record.skip === 'number' && Number.isInteger(record.skip) && record.skip >= 0
        ? record.skip
        : undefined
      return git.log(cwd, count, skip)
    },
    'git.commit-diff': async (payload) => {
      const { cwd } = cwdOf(payload)
      return { diff: await git.commitDiff(cwd, requireString(payload, 'hash')) }
    },
    'git.discard': async (payload) => {
      const { cwd } = cwdOf(payload)
      await git.discard(cwd, await resolveGitPath(cwd, requireString(payload, 'path')))
      return { ok: true }
    },
    'git.revert': async (payload) => {
      const { cwd } = cwdOf(payload)
      await git.revert(cwd, requireString(payload, 'hash'))
      return { ok: true }
    },
    'git.cherry-pick': async (payload) => {
      const { cwd } = cwdOf(payload)
      await git.cherryPick(cwd, requireString(payload, 'hash'))
      return { ok: true }
    },
    'git.show': async (payload) => {
      const { cwd } = cwdOf(payload)
      const path = await resolveGitPath(cwd, requireString(payload, 'path'))
      const rev = requireString(payload, 'rev')
      return { content: await git.show(cwd, rev, path) }
    },
    // Release a terminal immediately. The WebSocket close frame already does
    // this while the socket is open; this route covers the tab-close that
    // happens while the socket is down (reconnect loop), so a closed tab can
    // never hold the per-session quota until the reconnect grace expires.
    'pty.close': (payload) => {
      const sessionId = requireString(payload, 'sessionId')
      const tab = requireString(payload, 'tab')
      // Degraded mode (node-pty unavailable): no live pty can exist, so a
      // no-op ok is the honest answer — never an error the client must show.
      ptyManager?.close(`${sessionId}:${tab}`)
      return { ok: true }
    },
    // Release an agent terminal by uuid. The WS close frame already does
    // this while the socket is open; this route covers the tab-close that
    // happens while the socket is down (reconnect loop) so a closed agent
    // tab never leaves a zombie pty behind. Idempotent.
    'agent-pty.close': (payload) => {
      const uuid = requireString(payload, 'uuid')
      agentPtyRegistry?.close(uuid)
      return { ok: true }
    },
    // Terminal dependency status (issue #140): after a WS close 1011 with
    // reason `pty-deps-missing` the client fetches the full repair details
    // here — the close reason itself is capped at 123 bytes, too small for
    // the pasteable command.
    'terminal.deps': () => depsStatus(),
    // Background jobs: read one job's output (a REPLAY of what the model
    // has read so far, from the owner session's event log — the model's
    // job_output cursor is never touched, so the human pane can never steal
    // the agent's bytes), and kill one job. The job LIST itself arrives
    // through the harness's session/jobs push mirror, so no list route
    // exists. Kill is fenced to the owning session by the jobs registry.
    'jobs.output': (payload) => jobsApi.output(payload),
    'jobs.kill': (payload) => jobsApi.kill(payload),
    // The effective terminal shell and its display name. The client uses
    // this to title terminal tabs with the shell name instead of a numbered
    // "Terminal N" label; the shell itself is configured through
    // `cordis.patch.yml` (`config.shell`) or resolved by the host default.
    'shell.get': () => ({ shell: terminalShell, name: shellDisplayName(terminalShell) }),
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
    // Probe a URL's RESPONSE HEADERS so the sidebar browser can explain an
    // iframe refusal: X-Frame-Options / CSP frame-ancestors are exactly the
    // signals the browser enforces when it refuses to embed a site. The
    // probe is display-only (headers back to the caller), restricted to
    // http(s) non-loopback URLs with a hard timeout, and gated by the same
    // trust fence as every other route — a cross-site page cannot reach it.
    'browser.probe': async (payload) => {
      const raw = requireString(payload, 'url')
      let parsed: URL
      try {
        parsed = new URL(raw)
      } catch {
        throw new SidebarError('bad-request', 'invalid url', 400)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new SidebarError('bad-request', 'only http/https urls can be probed', 400)
      }
      // Mirror the browser tab's address-bar policy: loopback stays unreachable
      // from the sidebar, so probing it would leak nothing the tab could use.
      if (isLoopbackHostname(parsed.hostname)) {
        throw new SidebarError('bad-request', 'local addresses are not probed', 400)
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      try {
        let response = await fetch(parsed, { method: 'HEAD', redirect: 'follow', signal: controller.signal })
        // Some servers answer HEAD with 405/501; retry once as GET (the
        // body is discarded — only the headers matter).
        if (response.status === 405 || response.status === 501) {
          response = await fetch(parsed, { method: 'GET', redirect: 'follow', signal: controller.signal })
        }
        const csp = response.headers.get('content-security-policy')
        const frameAncestors = extractFrameAncestors(csp)
        const xFrameOptions = response.headers.get('x-frame-options')
        return {
          reachable: true,
          url: response.url,
          status: response.status,
          ...(xFrameOptions !== null ? { xFrameOptions } : {}),
          ...(frameAncestors !== undefined ? { frameAncestors } : {}),
        }
      } catch {
        // DNS / TLS / connection / timeout: nothing to judge — the client
        // keeps the plain iframe.
        return { reachable: false }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/**
 * Plugin body: mount the fenced routes and the pty lifecycle.
 * @param ctx - host plugin context (webServer, sessions, webRuntime).
 * @param config - deployment-provided limits; the Loader validates against
 * {@link Config} and fills defaults, direct callers get them from
 * {@link resolveSidebarConfig}.
 */
export function apply(ctx: Context, config?: SidebarConfig): void {
  // pnpm strips the executable bit from node-pty's prebuilt spawn-helper;
  // restore it before any terminal can spawn (idempotent).
  ensureSpawnHelper()
  const resolved = resolveSidebarConfig(config)
  // One shell resolution feeds BOTH terminal surfaces: the UI tabs and the
  // model-facing terminal_* tools. They must stay in lockstep, otherwise a
  // configured shell fixes one surface and silently leaves the other on the
  // platform default.
  const terminalShell = defaultShell({ explicit: resolved.shell })
  // The web runtime's bind-derived trust list (boot-sampled LAN literals
  // plus --trusted-host authorities) — the authoritative source the /api
  // gateway fence derives its list from. Read per request from the live
  // service value; a replaced list takes effect without a plugin restart.
  const fence = (req: SidebarHttpRequest): boolean => isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)
  // node-pty is loaded lazily, never at module top level (issue #140): a
  // missing or broken install must degrade THIS plugin — terminal tab shows
  // a repair command, agent terminal tools stay unregistered — instead of
  // failing the plugin load and taking the whole `dsh web` server down.
  const nodePty = loadNodePty()
  if (nodePty === null) {
    const status = depsStatus()
    const detail = status.ok
      ? 'unknown cause'
      : `${status.cause}. Repair: ${status.command}`
    ctx.logger?.warn(`[dsh-better-sidebar] node-pty (${DSH_NODE_PTY_RANGE}) failed to load: ${detail}`)
  }
  const ptyManager = nodePty !== null
    ? new PtyManager(terminalShell, resolved.terminalsPerSession, resolved.shellArgs, nodePty)
    : null
  // The agent-owned terminal registry: parallel to the UI-tab ptyManager,
  // keyed by uuid (the model's opaque handle) instead of `${sessionId}:${tabId}`,
  // uncapped, and torn down with the plugin. The model creates terminals here
  // through the terminal_create tool; the sidebar view attaches through the
  // same /sidebar/ws/terminal upgrade with ?uuid=... instead of ?tab=...
  const agentPtyRegistry = nodePty !== null
    ? new AgentPtyRegistry(terminalShell, resolved.shellArgs, nodePty)
    : null

  // ── User-facing "Side card" preferences ──────────────────────────────────
  // Register the namespace with the settings provider so the Settings page
  // (client half) can render and persist the new-conversation defaults. The
  // DSH settings RPC domain (api-proxy) only serves allowlisted namespaces to
  // configuration clients, so the client reaches this namespace through the
  // plugin's own fenced routes below ('settings.get'/'settings.update'),
  // which call the seam in-process. Deployments without a settings service
  // simply never fill the face and the client falls back to the defaults.
  let settingsFace: SidebarSettingsFace | undefined
  // The model-facing terminal tools are gated on the side-card setting
  // `agentTerminalTools` (default off): nothing is injected until the user
  // turns the feature on, and turning it off mid-session unregisters the
  // tools and releases the agent terminals they created.
  let toolsDisposers: (() => void) | null = null
  const syncToolsGate = (scope: { get(): SidebarPrefs }): void => {
    if (scope.get().agentTerminalTools) {
      if (toolsDisposers === null) {
        // Degraded mode (node-pty unavailable): never register the terminal
        // tools — every one of them would fail at spawn time.
        if (agentPtyRegistry === null) return
        toolsDisposers = registerTools(ctx, agentPtyRegistry, (sessionId) => sessionCwdOf(ctx, sessionId), () => shellOverridesOf(() => settingsFace))
      }
    } else if (toolsDisposers !== null) {
      toolsDisposers()
      toolsDisposers = null
      // The feature is off: release every agent terminal the model created
      // while it was on (they are only reachable through the tools). The
      // registry change fires the push, so the sidebar reconciles them away.
      agentPtyRegistry?.disposeAll()
    }
  }
  ctx.inject(['settings'], (sctx) => {
    const ns: SettingsNamespace = settingsNamespace(SIDEBAR_PREFS_NS)
    // The structural settings mirror types `schema` as unknown, so the
    // generic is not inferred here; the real service resolves it from the
    // schemastery schema (PrefsSchema) — narrow the owner scope explicitly.
    const scope = sctx.settings.register(ns, PrefsSchema) as {
      get(): SidebarPrefs
      watch(callback: (next: SidebarPrefs, prev: SidebarPrefs) => void): () => void
    }
    const viewOf = (): { value?: unknown; revision?: number } => {
      const descriptor = sctx.settings.describe({ redactSecrets: true }).find(candidate => candidate.ns === ns)
      return descriptor === undefined
        ? { value: undefined, revision: undefined }
        : { value: descriptor.value, revision: descriptor.revision }
    }
    // Mutual exclusion with the dsh-web-ui family right panel: the aionui
    // panel's provider choice (`aionui-panel.rightPanel`) is the authority.
    // While it resolves to 'aionui-panel', this sidebar must not mount. The
    // namespace is read through the settings seam like any other registered
    // section; absent namespace (no aionui installed) = not disabled.
    const externalDisable = (): boolean => {
      const descriptor = sctx.settings.describe({ redactSecrets: true })
        .find(candidate => candidate.ns === 'aionui-panel')
      const value = descriptor?.value as { rightPanel?: unknown } | undefined
      return value?.rightPanel === 'aionui-panel'
    }
    settingsFace = {
      get: viewOf,
      externalDisable,
      update: async (patch, expectedRevision) => {
        await sctx.settings.update(ns, patch, expectedRevision)
        return viewOf()
      },
    }
    // Register (or unregister) the terminal tools from the current setting,
    // and keep them in sync with every settings commit.
    syncToolsGate(scope)
    scope.watch(() => { syncToolsGate(scope) })
  })

  // ── JSON API ────────────────────────────────────────────────────────────
  const api = buildApi(ctx, ptyManager, agentPtyRegistry, resolved, terminalShell, () => settingsFace)
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
        const cwd = sessionCwdOf(ctx, sessionId, url.searchParams.get('cwd') ?? undefined)
        const { path, size } = await writeWorkspaceUpload({
          cwd,
          dir,
          relativePath,
          chunks: req,
          limit: resolved.uploadLimit,
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
        const cwd = sessionCwdOf(ctx, sessionId, url.searchParams.get('cwd') ?? undefined)
        const path = requireAbsolute(raw)
        if (!isWithin(cwd, path)) {
          // Only files under the session cwd are served as media (the editor
          // opens images from the explorer; produced files go through read).
          // isWithin (not a raw startsWith) so case-mismatched Windows paths
          // and mixed separators cannot be misclassified.
          throw new SidebarError('fs-error', 'media path outside the session working directory', 403)
        }
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
        // back to the process cwd and is normally refused by isWithin, same
        // semantics as the media route's fallback).
        const cwd = sessionCwdOf(ctx, sessionId)
        const absolute = requireAbsolute(path)
        if (!isWithin(cwd, absolute)) {
          throw new SidebarError('fs-error', 'html path outside the session working directory', 403)
        }
        const info = await stat(absolute)
        if (!info.isFile() || info.size > resolved.mediaLimit) {
          throw new SidebarError('fs-error', 'not a file or too large', 400)
        }
        const type = mediaTypeForPath(absolute)
        const body = await readFile(absolute)
        res.writeHead(200, {
          'content-type': type,
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

  // ── Terminal WebSocket ──────────────────────────────────────────────────
  // One upgrade endpoint serves both UI-tab terminals (?tab=...) and
  // agent-owned terminals (?uuid=...). The two paths attach to different
  // registries but share the wire protocol: input frames are raw text,
  // resize frames are JSON `{type:'resize',cols,rows}`, and a close frame
  // `{type:'close'}` releases the underlying pty (immediate for agent
  // terminals, scheduled-0 for UI tabs which keep the same reconnect grace
  // contract the host has always had).
  const wss = new WebSocketServer({ noServer: true })
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: '/sidebar/ws/terminal',
    handler: (req, socket, head) => {
      if (!fence(req)) {
        socket.destroy()
        return
      }
      // The structural request/socket/head faces satisfy the shared fence;
      // the `ws` package wants the real Node types — cast at this boundary.
      wss.handleUpgrade(req as unknown as IncomingMessage, socket as unknown as Duplex, head as Buffer, (ws) => {
        void attachTerminal(ctx, ptyManager, agentPtyRegistry, ws, req, resolved, () => settingsFace)
      })
    },
  }), 'dsh-better-sidebar: terminal WebSocket')

  // ── Agent terminals push WebSocket ──────────────────────────────────────
  // Pushes the live list of agent terminals for one session to the sidebar
  // view: the client mirrors the list into tabs (id `agent:<uuid>`,
  // title from the agent's `terminal_create` call). The host fires on every
  // create / close / exit; the client reconciles by adding tabs for new
  // uuids and dropping tabs whose uuids disappeared (the user closing a tab
  // sends `{type:'close'}` on the terminal WS, which kills the pty, which
  // fires a change here, which converges the view).
  const agentListWss = new WebSocketServer({ noServer: true })
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: '/sidebar/ws/agent-terminals',
    handler: (req, socket, head) => {
      if (!fence(req)) {
        socket.destroy()
        return
      }
      agentListWss.handleUpgrade(req as unknown as IncomingMessage, socket as unknown as Duplex, head as Buffer, (ws) => {
        void attachAgentList(agentPtyRegistry, ws, req)
      })
    },
  }), 'dsh-better-sidebar: agent-terminals push WebSocket')

  ctx.effect(() => () => {
    toolsDisposers?.()
    ptyManager?.disposeAll()
    agentPtyRegistry?.disposeAll()
    wss.close()
    agentListWss.close()
  }, 'dsh-better-sidebar: teardown')
}

/** Push the live agent-terminal list for one session to a connected sidebar view. */
async function attachAgentList(
  registry: AgentPtyRegistry | null,
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
    const send = (): void => {
      if (ws.readyState === WebSocket.OPEN) {
        // Degraded mode (node-pty unavailable): no agent terminal can exist,
        // so the honest push is the empty list.
        ws.send(JSON.stringify(registry?.list(sessionId) ?? []))
      }
    }
    send()
    const unsubscribe = registry?.subscribe(send)
    ws.on('close', () => { unsubscribe?.() })
    ws.on('error', () => { unsubscribe?.() })
  } catch (error) {
    ws.close(1011, error instanceof Error ? error.message : String(error))
  }
}

/**
 * Wire one terminal socket to its pty: replay transcript, pump both ways.
 * Two attach modes share the wire protocol:
 * - `?uuid=...` attaches to an agent-owned terminal (created by the
 *   `terminal_create` tool). The close frame kills the pty immediately
 *   (the agent's terminal closes when the user closes the sidebar tab); a
 *   bare socket drop (refresh, tab switch) leaves the pty alive for the
 *   reconnect grace, exactly like UI-tab terminals.
 * - `?tab=...&sessionId=...` attaches to a UI-tab terminal (the user
 *   created it from the + menu). The close frame schedules a 0-ms close
 *   (the host's reconnect grace keeps the shell alive across a refresh).
 */
async function attachTerminal(
  ctx: Context,
  ptyManager: PtyManager | null,
  agentPtyRegistry: AgentPtyRegistry | null,
  ws: WebSocket,
  req: SidebarHttpRequest,
  resolved: ResolvedSidebarConfig,
  getSettings: () => SidebarSettingsFace | undefined,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const uuid = url.searchParams.get('uuid')
    if (uuid !== null) {
      // Degraded mode (node-pty unavailable): no agent terminal can exist,
      // so the lookup behaves exactly like a missing uuid.
      if (agentPtyRegistry === null) {
        ws.close(1011, `agent terminal "${uuid}" not found`)
        return
      }
      const handle = agentPtyRegistry.get(uuid)
      if (handle === undefined) {
        ws.close(1011, `agent terminal "${uuid}" not found`)
        return
      }
      pumpAgentTerminal(agentPtyRegistry, handle, ws)
      return
    }
    const sessionId = url.searchParams.get('sessionId')
    const tabId = url.searchParams.get('tab')
    if (sessionId === null || tabId === null) {
      ws.close(1008, 'either ?uuid or ?sessionId+?tab are required')
      return
    }
    if (ptyManager === null) {
      // Degraded mode (issue #140): node-pty unavailable. The close reason
      // is a SHORT marker — a WS close reason is capped at 123 bytes, so the
      // client fetches the full repair command from /sidebar/api/terminal.deps.
      ws.close(1011, PTY_DEPS_MISSING)
      return
    }
    const cwd = sessionCwdOf(ctx, sessionId, url.searchParams.get('cwd') ?? undefined)
    // Settings-page shell overrides win over the yaml/auto shell for
    // terminals opened from now on (existing pty handles keep their shell).
    const overrides = shellOverridesOf(getSettings)
    const handle = ptyManager.open(sessionId, tabId, cwd, 80, 24, overrides.shell, overrides.shellArgs)
    // Replay the transcript, then follow live output.
    if (handle.transcript !== '') ws.send(handle.transcript)
    const onData = (data: string): void => {
      if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 4 * 1024 * 1024) {
        ws.send(data)
      }
    }
    const onExit = ({ exitCode }: { exitCode: number; signal?: number }): void => {
      onData(`\r\n[process exited with code ${String(exitCode)}]\r\n`)
    }
    const dataSub = handle.pty.onData(onData)
    const exitSub = handle.pty.onExit(onExit)
    ws.on('message', (data) => {
      const text = data.toString('utf8')
      // Control frames are JSON with a known shape; anything else (including
      // JSON that is not a recognized control) is terminal input, verbatim.
      let control: { type?: unknown; cols?: unknown; rows?: unknown } | null = null
      try {
        const parsed: unknown = JSON.parse(text)
        if (parsed !== null && typeof parsed === 'object') {
          control = parsed as { type?: unknown; cols?: unknown; rows?: unknown }
        }
      } catch {
        // Not JSON: terminal input.
      }
      if (control !== null && control.type === 'close') {
        // The owning tab was closed: release the quota immediately.
        ptyManager.scheduleClose(handle.key, 0)
        return
      }
      if (handle.exited) return
      if (
        control !== null
        && control.type === 'resize'
        && typeof control.cols === 'number' && typeof control.rows === 'number'
      ) {
        const dims = clampDims(control.cols, control.rows)
        handle.pty.resize(dims.cols, dims.rows)
      } else {
        handle.pty.write(text)
      }
    })
    ws.on('close', () => {
      dataSub.dispose()
      exitSub.dispose()
      // A bare socket drop (refresh, tab switch) leaves the process alive
      // for a grace period so a quick reconnect keeps it; the reconnect's
      // open() cancels the pending close.
      ptyManager.scheduleClose(handle.key, resolved.reconnectGraceMs)
    })
  } catch (error) {
    ws.close(1011, error instanceof Error ? error.message : String(error))
  }
}

/**
 * Pump one agent terminal's pty to a connected view. The close frame kills
 * the pty immediately (the agent's terminal closes when the user closes the
 * sidebar tab); a bare socket drop leaves the pty alive — the agent owns
 * the lifetime, and only `terminal_close`, a `{type:'close'}` frame, or
 * plugin teardown kills it.
 */
function pumpAgentTerminal(
  registry: AgentPtyRegistry,
  handle: AgentTerminalHandle,
  ws: WebSocket,
): void {
  if (handle.transcript !== '') ws.send(handle.transcript)
  const onData = (data: string): void => {
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 4 * 1024 * 1024) {
      ws.send(data)
    }
  }
  const onExit = ({ exitCode }: { exitCode: number; signal?: number }): void => {
    onData(`\r\n[process exited with code ${String(exitCode)}]\r\n`)
  }
  const dataSub = handle.pty.onData(onData)
  const exitSub = handle.pty.onExit(onExit)
  ws.on('message', (data) => {
    if (handle.exited) return
    const text = data.toString('utf8')
    let control: { type?: unknown; cols?: unknown; rows?: unknown } | null = null
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object') {
        control = parsed as { type?: unknown; cols?: unknown; rows?: unknown }
      }
    } catch {
      // Not JSON: terminal input.
    }
    if (control !== null && control.type === 'close') {
      // The user closed the sidebar tab: kill the pty immediately. The
      // agent's next terminal_list / terminal_send will see it gone.
      registry.close(handle.uuid)
      return
    }
    if (
      control !== null
      && control.type === 'resize'
      && typeof control.cols === 'number' && typeof control.rows === 'number'
    ) {
      const dims = clampDims(control.cols, control.rows)
      handle.pty.resize(dims.cols, dims.rows)
    } else if (control === null) {
      // Raw text input (a JSON-looking string the pty would have received
      // verbatim is reachable in theory but is exotic for an agent terminal;
      // preserve the UI-tab semantics and forward as input).
      handle.pty.write(text)
    }
    // An unrecognized JSON control frame is dropped (the UI-tab path also
    // treats non-resize JSON controls as input, but for an agent terminal
    // there is no realistic input that is also valid JSON).
  })
  ws.on('close', () => {
    dataSub.dispose()
    exitSub.dispose()
    // A bare socket drop (refresh, tab switch) leaves the agent's pty alive.
    // The agent owns the lifetime: only `terminal_close`, a `{type:'close'}`
    // frame, or plugin teardown kills it. A reconnecting view reattaches the
    // same shell and gets the full transcript replayed.
  })
}
