/**
 * The model-facing `sidebar_open` tool and its delivery registry.
 *
 * One tool lets the model actively open a local file, a local folder (as a
 * tree rooted there), or an HTTP(S) page in the CALLING session's sidebar.
 * Mirroring the agent-terminal tools, the tool binds to the calling agent's
 * session through `exec.agent.session.id` — the model never passes a
 * sessionId, and opens for non-active sessions are queued until that
 * session's sidebar view is next connected.
 *
 * Delivery is a host→browser push over the dedicated `/sidebar/ws/agent-opens`
 * endpoint (the same pattern as `/sidebar/ws/agent-terminals`): the registry
 * keeps a per-session queue; a push is consumed on send (`delivered: true`
 * means a sidebar view was attached at call time), otherwise the request
 * stays queued and is replayed when a view for that session attaches.
 *
 * Conventions (per plugin-development-guide.md §3):
 *   C1 — parameters schema-validated before `execute` runs.
 *   C4 — `execute` returns one canonical JSON value; `render` is a separate
 *        pure text projection.
 *   C6 — `exec.signal.throwIfAborted()` before any fs work.
 *   C10 — no UI/transport vocabulary in the canonical value.
 */
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Context } from './context-types.ts'
import type { SidebarPrefs } from './prefs-shared.ts'

/** What the model asked to open. */
export type AgentOpenKind = 'file' | 'folder' | 'url'

/** One pending/broadcast open request (the wire face over the push socket). */
export interface AgentOpenRequest {
  /** Opaque id (host-generated; the client ignores it beyond dedupe/debug). */
  id: string
  /** The session whose sidebar the open is targeted at. */
  sessionId: string
  kind: AgentOpenKind
  /** Absolute local path (file/folder) or http(s) URL. */
  target: string
  /** Tab title the client should use (basename / hostname / caller-supplied). */
  title: string
}

/** One subscribed sidebar view's sender. */
type Sender = (request: AgentOpenRequest) => void

/**
 * Per-session queue of open requests plus the connected sidebar views.
 *
 * Lifecycle: `enqueue` adds a request and — when at least one view for the
 * session is attached — pushes it immediately and removes it from the queue
 * (consume-on-send: a reconnect must never replay an open the client already
 * applied, and the browser tab type has no per-URL dedupe, so replaying
 * would mint duplicate tabs). With no attached view the request stays queued
 * and `attach` replays it on connect. `drainAll` drops every queued request
 * (the feature was turned off); `dispose` also drops every subscriber.
 */
export class AgentOpenRegistry {
  private pending = new Map<string, AgentOpenRequest[]>()
  private subscribers = new Map<string, Set<Sender>>()

  /** Queue one open and deliver it immediately when a view is attached.
   * @returns the request id and whether a connected view received it now. */
  enqueue(sessionId: string, kind: AgentOpenKind, target: string, title: string): { id: string; delivered: boolean } {
    const request: AgentOpenRequest = { id: randomUUID(), sessionId, kind, target, title }
    const list = this.pending.get(sessionId) ?? []
    list.push(request)
    this.pending.set(sessionId, list)
    const views = this.subscribers.get(sessionId)
    if (views !== undefined && views.size > 0) {
      for (const send of views) send(request)
      this.pending.delete(sessionId)
      return { id: request.id, delivered: true }
    }
    return { id: request.id, delivered: false }
  }

  /** Attach one sidebar view (replays queued requests; consume-on-send).
   * @returns the disposer detaching the view. */
  attach(sessionId: string, send: Sender): () => void {
    let views = this.subscribers.get(sessionId)
    if (views === undefined) {
      views = new Set()
      this.subscribers.set(sessionId, views)
    }
    views.add(send)
    const queued = this.pending.get(sessionId) ?? []
    if (queued.length > 0) {
      for (const request of queued) send(request)
      this.pending.delete(sessionId)
    }
    return () => {
      const current = this.subscribers.get(sessionId)
      current?.delete(send)
      if (current !== undefined && current.size === 0) this.subscribers.delete(sessionId)
    }
  }

  /** Drop every queued request (the feature was turned off mid-session). */
  drainAll(): void {
    this.pending.clear()
  }

  /** Drop the queue and every subscriber (plugin teardown). */
  dispose(): void {
    this.pending.clear()
    this.subscribers.clear()
  }
}

/** Extract the calling agent or throw the canonical "no agent" error. */
function requireAgent(agent: ToolRunContext['agent']): NonNullable<ToolRunContext['agent']> {
  if (agent === undefined) {
    throw new Error('sidebar_open requires an initiating agent')
  }
  return agent
}

/** Resolve the calling agent's session id (the queue scope + ownership key). */
function sessionIdOf(exec: ToolRunContext): string {
  return requireAgent(exec.agent).session.id
}

/** Pure text projection helper (the canonical value is already structured). */
function textRender<T>(fn: (value: T) => string): (_args: unknown, value: unknown) => ContentBlock[] {
  return (_args, value) => [{ type: 'text', text: fn(value as T) }]
}

/** Classify a raw target: http(s) URL or a local path (stat-driven). */
async function classifyTarget(raw: string, cwd: string): Promise<{ kind: AgentOpenKind; target: string; title: string }> {
  if (/^https?:\/\//i.test(raw)) {
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      throw new Error(`"${raw}" is not a valid URL`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('sidebar_open only accepts http:// and https:// URLs')
    }
    const title = parsed.hostname !== '' ? parsed.hostname : raw
    return { kind: 'url', target: raw, title }
  }
  // Any other scheme (`file:`, `javascript:`, `vscode:`, ...) is refused —
  // the model must use the plain URL form or a local path. A Windows drive
  // prefix (`C:\` / `C:/`) is a PATH, not a scheme, and must not be caught.
  if (!isWindowsDrivePrefix(raw) && /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    throw new Error('sidebar_open only accepts http:// and https:// URLs; use a local path for files')
  }
  const target = resolve(isAbsolute(raw) ? raw : join(cwd, raw))
  let info
  try {
    info = await stat(target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw new Error(`"${raw}" does not exist (resolved to "${target}")`)
    if (code === 'EACCES' || code === 'EPERM') throw new Error(`"${target}" is not readable`)
    throw new Error(`cannot open "${target}": ${error instanceof Error ? error.message : String(error)}`)
  }
  const title = basenameOf(target)
  return { kind: info.isDirectory() ? 'folder' : 'file', target, title: title === '' ? raw : title }
}

/** The last path segment (mirror of the client's FileTree baseName). */
function basenameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at === -1 ? trimmed : trimmed.slice(at + 1)
}

/** Whether a raw target starts with a Windows drive prefix (`C:\` / `C:/`). */
function isWindowsDrivePrefix(raw: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(raw)
}

/**
 * Register the `sidebar_open` tool against the host tool registry. The tool
 * is gated by the side-card setting `agentOpenTools` (the caller registers
 * and unregisters it); `readPrefs` supplies the live prefs so a disabled
 * target tab type (editor/browser) is reported to the model instead of
 * silently no-oping on the client. `resolveCwd` threads the calling
 * session's live cwd so relative paths resolve the same way the sidebar's
 * own routes do.
 * @param ctx - host plugin context (carries the tools service).
 * @param registry - the open-request registry (per-session queue + views).
 * @param resolveCwd - async cwd resolver for one session id. Resolves through
 *  the session header, the client-supplied cwd, and the persistence index
 *  before falling back to the host process cwd (production always provides
 *  persistence, so the fallback is reached only in tests / stripped-down hosts).
 * @param readPrefs - live resolved side card prefs (for tab enable gates).
 * @returns a disposer that unregisters the tool.
 */
export function registerOpenTool(
  ctx: Context,
  registry: AgentOpenRegistry,
  resolveCwd: (sessionId: string) => Promise<string>,
  readPrefs: () => SidebarPrefs,
): () => void {
  return ctx.tools.register(defineTool({
    name: 'sidebar_open',
    description:
      'Open a local file, a local folder, or an HTTP(S) page in the sidebar of the calling conversation. '
      + 'A file opens in the sidebar editor (per-path dedupe: an already-open file is focused); a folder opens a file window whose tree is rooted at that folder; '
      + 'a URL opens in the sidebar browser (sandboxed iframe). '
      + 'The panel auto-expands for content opens and the tab title defaults to the file/folder name or the URL hostname. '
      + 'The path may be absolute or relative to the session working directory. '
      + 'The open lands in the CALLING session\'s sidebar: while that session\'s sidebar view is not connected '
      + '(e.g. the session is not the active one), the open is queued and delivered when the session sidebar is next shown — '
      + 'the result reports `delivered` so you know whether it is visible right now. '
      + 'The side card setting "model opens files/folders/pages in the sidebar" must be on, and the target tab type must be enabled in that session\'s settings.',
    parameters: {
      target: {
        type: 'string',
        required: true,
        description: 'Absolute or session-cwd-relative local path, or an http:// / https:// URL.',
      },
      title: {
        type: 'string',
        description: 'Optional tab title (defaults to the file/folder name or the URL hostname).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, description: 'What was opened: file | folder | url.' },
          target: { type: 'string', required: true, description: 'The absolute path or URL the open was requested for.' },
          title: { type: 'string', required: true, description: 'The tab title used (provided title, basename, or hostname).' },
          delivered: {
            type: 'boolean',
            required: true,
            description: 'Whether the open was pushed to a connected sidebar at call time (false = queued until the session sidebar is next shown).',
          },
        },
      },
      render: textRender((v: { kind: AgentOpenKind; target: string; title: string; delivered: boolean }) =>
        v.delivered
          ? `Opened ${v.kind} "${v.title}" (${v.target}) in the sidebar.`
          : `Requested opening ${v.kind} "${v.title}" (${v.target}) in the sidebar — the session sidebar is not connected yet, so the open is queued and will appear when it is next shown.`,
      ),
    },
    execute: async (args: { target: string; title?: string }, exec: ToolRunContext) => {
      exec.signal.throwIfAborted()
      const sessionId = sessionIdOf(exec)
      const cwd = await resolveCwd(sessionId)
      const { kind, target, title: defaultTitle } = await classifyTarget(args.target, cwd)
      // A disabled target tab type would make the client no-op the open:
      // report the real cause to the model instead of a silent success.
      const prefs = readPrefs()
      const tab = kind === 'url' ? 'browser' : 'editor'
      if (prefs.tabsEnabled[tab] === false) {
        throw new Error(`the built-in ${tab} tab is disabled in the side card settings; ask the user to enable it (or disable this tool)`)
      }
      const title = args.title !== undefined && args.title.trim() !== '' ? args.title : defaultTitle
      const { delivered } = registry.enqueue(sessionId, kind, target, title)
      return { kind, target, title, delivered }
    },
  }))
}
