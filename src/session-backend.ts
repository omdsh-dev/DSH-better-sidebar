/**
 * Session backend seam — the host-half counterpart of the client-half
 * `registerTab` / `registerFileViewer` extension points.
 *
 * The sidebar's host half resolves a session's files, Git state and terminals
 * against THIS process: `node:fs`, a spawned `git`, and a local `node-pty`.
 * That is wrong for any session whose working directory lives somewhere else —
 * an SSH-attached machine (issue #238), a container, a sandbox, or another
 * node in a multi-node deployment. Those deployments could previously only
 * fork the sidebar.
 *
 * A backend claims the session ids it owns and serves the session-scoped API
 * for them. Everything else keeps the original local path byte for byte: an
 * unclaimed session costs one predicate call.
 */
import { SidebarError } from './wire.ts'
import { requireAbsolute } from './fs-tree.ts'

/**
 * The socket face a backend takes over. Structural on purpose: the type lives
 * in the client-reachable declaration graph, which must stay Node-free
 * (scripts/check-consumer-types.sh), and a real `ws` WebSocket satisfies it.
 */
export interface SessionBackendSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: 'message', listener: (data: unknown) => void): unknown
  on(event: 'close', listener: () => void): unknown
  readonly readyState: number
}

/** One session-scoped JSON call result. */
export type SessionBackendResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } }

/** One session-scoped binary read result (media / HTML routes). */
export type SessionBackendBinaryResult =
  | { ok: true; status: number; headers: Readonly<Record<string, string>>; body: Uint8Array }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } }

/**
 * A backend serving the sidebar's session-scoped API for the sessions it
 * claims. Registered through {@link SidebarSessionBackendRegistry}; wrap the
 * registration in `ctx.effect` so disposal is HMR-safe.
 */
export interface SidebarSessionBackend {
  /** Stable identifier for diagnostics (logs, claim conflicts). */
  readonly id: string
  /**
   * Whether this backend owns the session. Called on every routed request, so
   * it must be a cheap pure predicate (id shape, prefix, own registry) — no
   * I/O. A throw is treated as "not claimed": one bad backend must not take
   * the whole sidebar down with it.
   */
  claimSession(sessionId: string): boolean
  /** Run one session-scoped JSON API method (names mirror `/sidebar/api/<method>`). */
  invoke(method: string, sessionId: string, payload: unknown, signal?: AbortSignal): Promise<SessionBackendResult>
  /** Run one session-scoped binary read (`file.read` / `html.read`). */
  invokeBinary(method: string, sessionId: string, payload: unknown, signal?: AbortSignal): Promise<SessionBackendBinaryResult>
  /**
   * Take over an upgraded terminal WebSocket. The sidebar stops reading and
   * writing the socket once it is handed over: closing it, surfacing errors
   * and honouring the reconnect grace are the backend's responsibility.
   * Backends that omit this serve files and Git but no terminals.
   */
  attachTerminal?(ws: SessionBackendSocket, sessionId: string, tab: string | null, options: { reconnectGraceMs: number }): void
}

/** The host service backends register through (`ctx.sidebarSessionBackends`). */
export interface SidebarSessionBackendRegistry {
  /** Register a backend; returns its disposer. */
  register(backend: SidebarSessionBackend): () => void
}

/**
 * Session-scoped methods a backend may serve. An allow list, not a deny list:
 * a newly added API method is NOT routable until it is named here.
 *
 * Deliberately absent: `settings.*` (global, not session-scoped),
 * `browser.probe` (probes the ingress's own network), `deps.status` (this
 * process's node-pty install), and the agent terminal routes (addressed by
 * agent UUID — they belong to the local agent runtime, not to a workspace).
 */
export const SESSION_SCOPED_READ_METHODS = [
  'session.cwd', 'fs.tree', 'fs.search', 'fs.read',
  'git.status', 'git.diff', 'git.branch', 'git.log', 'git.commit-diff', 'git.show',
  'jobs.output', 'terminal.read',
] as const

/** Session-scoped methods that mutate owner-side state. */
export const SESSION_SCOPED_WRITE_METHODS = [
  'fs.write', 'git.stage', 'git.unstage', 'git.commit', 'git.checkout',
  'git.discard', 'git.revert', 'git.cherry-pick', 'pty.close', 'jobs.kill',
  'terminal.open', 'terminal.input', 'terminal.resize', 'terminal.terminate', 'terminal.detach',
] as const

/** Session-scoped methods answering with raw bytes. */
export const SESSION_SCOPED_BINARY_METHODS = ['file.read', 'html.read'] as const

const ROUTABLE_JSON_METHODS: ReadonlySet<string> = new Set<string>([
  ...SESSION_SCOPED_READ_METHODS,
  ...SESSION_SCOPED_WRITE_METHODS,
])

/** Whether a JSON API method may be served by a session backend. */
export function isRoutableSessionMethod(method: string): boolean {
  return ROUTABLE_JSON_METHODS.has(method)
}

/** The registry implementation the sidebar provides. */
export class SessionBackendRegistry implements SidebarSessionBackendRegistry {
  readonly #backends: SidebarSessionBackend[] = []

  register(backend: SidebarSessionBackend): () => void {
    this.#backends.push(backend)
    return () => {
      const index = this.#backends.indexOf(backend)
      if (index >= 0) this.#backends.splice(index, 1)
    }
  }

  /**
   * The backend owning this session, or undefined for the local path.
   * First claim wins (registration order), mirroring the client half's
   * `urlTarget` semantics.
   */
  claim(sessionId: string | undefined | null): SidebarSessionBackend | undefined {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    for (const backend of this.#backends) {
      try {
        if (backend.claimSession(sessionId)) return backend
      } catch {
        // A throwing predicate does not claim; the local path still serves.
      }
    }
    return undefined
  }

  /** Registered backend count (diagnostics and tests). */
  get size(): number {
    return this.#backends.length
  }
}

/**
 * Strip the fields the route layer owns before handing a payload to a backend.
 *
 * `sessionId` is decided by routing, and a caller-supplied `cwd` must never
 * reach an owner: for the local UI a client cwd is a legitimate hydration hint,
 * but across a transport it would turn a routing mistake into filesystem
 * access on an unrelated directory.
 */
export function forwardablePayload(payload: unknown): Record<string, unknown> {
  const source = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  const forwarded: Record<string, unknown> = { ...source }
  delete forwarded.sessionId
  delete forwarded.cwd
  return forwarded
}

/** Turn a backend error into the sidebar's own error shape. */
export function sessionBackendError(error: { code: string; message: string }): SidebarError {
  const missing = error.code === 'session-not-found' || error.code === 'not-found'
  return new SidebarError(missing ? 'not-found' : 'internal', error.message, missing ? 404 : 502)
}

/** How a session's cwd is resolved. */
export type CwdMode = 'local-fallbacks' | 'owner-strict'

/** The session lookup an owner-strict API is bound to. */
export type OwnerSessionGet = (sessionId: string) => { header: { cwd?: string } } | undefined

/**
 * Resolve a session cwd strictly from its own header.
 *
 * The local UI path falls back to a client-supplied cwd and ultimately to the
 * process cwd, which is reasonable for a same-machine browser during the first
 * frame. A remote caller gets none of that: an unknown session is a 404, never
 * an unrelated directory.
 */
export function ownerSessionCwdOf(getSession: OwnerSessionGet, sessionId: string): string {
  const cwd = getSession(sessionId)?.header.cwd
  if (cwd === undefined || cwd === '') {
    throw new SidebarError('not-found', `session "${sessionId}" has no owner-local working directory`, 404)
  }
  try {
    return requireAbsolute(cwd)
  } catch {
    throw new SidebarError('fs-error', `session "${sessionId}" has an invalid working directory`, 400)
  }
}
