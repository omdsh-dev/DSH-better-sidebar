/**
 * The one fixed local read route for clue references (post-tool revision).
 *
 * `POST /sidebar/agent/clues/read`
 *
 * Body: `{ workspaceId, reference, sessionId, offset?, snapshotOffset?,
 * commentsCursor?, parentId? }`, where `reference` is exactly one
 * `[[dsh-clue:…]]`, `[[dsh-cluepack:…]]` or `[[dsh-clue-snapshot:…]]` token.
 * Any other body key, a non-empty query string, or a non-JSON content type is
 * refused. `commentsCursor` and `parentId` are clue-only discussion follow-ups:
 * they dispatch to the comments reader and do NOT re-read the resource body.
 * The response is the existing JSON envelope (`{ok:true,value}` /
 * `{ok:false,error}`); the value is produced by `./tools.ts`.
 *
 * SECURITY — a narrowly approved, fixed-route authentication exception:
 * the normal `/sidebar/api` fence is NOT applied here. A request may execute
 * only when ALL of the following are true:
 * - the method is POST (no GET/OPTIONS/HEAD, no CORS, no preflight);
 * - the URL is origin-form (an absolute-form proxy request is refused);
 * - `req.socket.remoteAddress` is a loopback address (`127/8`, `::1`, or an
 *   IPv4-mapped form) — the real peer socket, never a header;
 * - `req.socket.localPort` equals the listener's actual OS-bound
 *   `ctx.webServer.port` (read dynamically, never hard-coded);
 * - `Host` is a literal loopback name (`localhost` / `127/8` / `::1`) with
 *   exactly that listening port;
 * - there is no `Origin`, no `sec-fetch-*` header, and no
 *   `Forwarded` / `X-Forwarded-*` header (all are browser/proxy signals);
 * - `Content-Type` is `application/json`.
 *
 * Anything else is refused before the body is read. The route is deliberately
 * not an authorization model for remote callers: any other local process that
 * knows the port can read these references too. It only removes the login
 * requirement for this one read-only endpoint; every other `/sidebar` route
 * keeps the ordinary fence and still answers 403 without authentication.
 *
 * The body is bounded by the existing default `readJsonBody` limit (1 MiB).
 * The request/response close events abort a pending source read.
 */
import type {
  SidebarHttpRequest,
  SidebarHttpResponse,
  SidebarWebRoute,
  SidebarWebServer,
} from '../context-types.ts'
import { ClueError } from './error.ts'
import type { CluesService } from './service.ts'
import {
  CLUE_AGENT_READ_ROUTE_PATH,
  isLoopbackAddress,
  parseReaderReference,
  readClueReference,
  requestedWorkspaceScope,
  type ClueReaderRegistry,
  type ClueReaderValue,
} from './tools.ts'
import { clueStatusOf, readJsonBody, SidebarError, writeJson, writeOk } from '../wire.ts'

export { CLUE_AGENT_READ_ROUTE_PATH, isLoopbackAddress }

/** The listener facts this route consumes (dynamic getters supply them). */
export interface ClueAgentReadWebServer {
  readonly port?: number
  getOrigin?(): string
}

/** Dependencies of {@link createClueAgentReadRoute}. */
export interface ClueAgentReadDeps {
  readonly clues: CluesService
  /**
   * Dynamic listener facts. Called per request so the route never captures a
   * stale port and never assumes a development default.
   */
  readonly getWebServer?: () => ClueAgentReadWebServer | undefined
  /** Dynamic workspace registry (the service may appear after this plugin). */
  readonly getWorkspaceRegistry?: () => ClueReaderRegistry | undefined
  readonly logger?: { warn?(message: string): void }
}

/** One safe rejection of the request gate. */
interface Rejection {
  readonly status: number
  readonly code: string
  readonly message: string
}

/** Build one safe rejection value. */
function rejection(status: number, code: string, message: string): Rejection {
  return { status, code, message }
}

/** First header value, or undefined for an absent/array header. */
function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Whether a URL host literal is `localhost` or a loopback IP. */
function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || isLoopbackAddress(hostname)
}

/** One parsed `Host` header (`port` absent only for an invalid/no-port form). */
interface ParsedHost {
  readonly hostname: string
  readonly port?: number
}

/** Parse a Host port strictly (decimal digits only, valid range). */
function parsePortText(text: string): number | undefined {
  if (!/^\d{1,5}$/u.test(text)) return undefined
  const port = Number(text)
  return port >= 1 && port <= 65_535 ? port : undefined
}

/** Parse one `Host` header value; bracketed IPv6 must use `[::1]:port`. */
function parseHostHeader(value: string): ParsedHost | undefined {
  const text = value.trim().toLowerCase()
  if (text === '') return undefined
  if (text.startsWith('[')) {
    const close = text.indexOf(']')
    if (close < 0) return undefined
    const hostname = text.slice(1, close)
    const rest = text.slice(close + 1)
    if (!rest.startsWith(':')) return { hostname }
    const port = parsePortText(rest.slice(1))
    return port === undefined ? undefined : { hostname, port }
  }
  const firstColon = text.indexOf(':')
  if (firstColon < 0) return { hostname: text }
  // A second colon before the port means a raw IPv6 literal without brackets.
  if (text.indexOf(':', firstColon + 1) >= 0) return undefined
  const hostname = text.slice(0, firstColon)
  const port = parsePortText(text.slice(firstColon + 1))
  return port === undefined ? undefined : { hostname, port }
}

/** The actual listening port, when the host exposes a bound number. */
function listeningPortOf(webServer: ClueAgentReadWebServer | undefined): number | undefined {
  const port = webServer?.port
  return typeof port === 'number' && Number.isInteger(port) && port > 0 ? port : undefined
}

/**
 * Evaluate the loopback request gate. No body or service access happens here.
 * @param req - the request under test.
 * @param port - the listener's actual bound port (undefined before bind).
 * @param pathMatched - whether the URL's pathname is this fixed route.
 */
function gateRequest(
  req: SidebarHttpRequest,
  port: number | undefined,
  pathMatched: boolean,
): Rejection | undefined {
  if (req.method !== 'POST') {
    return rejection(405, 'method-error', 'method not allowed')
  }
  const rawUrl = req.url ?? '/'
  if (!rawUrl.startsWith('/') || rawUrl.startsWith('//') || rawUrl.includes('\\')) {
    // Origin-form only: absolute-form (`http://host/path`) and scheme-relative
    // (`//host/path`) are proxy/browser constructs, never a local curl target.
    return rejection(403, 'forbidden', 'forbidden')
  }
  // The reader protocol is the body alone; a query string is not part of it.
  if (rawUrl.includes('?') || rawUrl.includes('#')) {
    return rejection(403, 'forbidden', 'forbidden')
  }
  if (!pathMatched) return rejection(404, 'not-found', 'not found')
  if (port === undefined) {
    return rejection(503, 'unavailable', 'the local web server port is unavailable')
  }
  const host = headerValue(req.headers.host)
  if (host === undefined) return rejection(403, 'forbidden', 'forbidden')
  const parsedHost = parseHostHeader(host)
  if (
    parsedHost === undefined
    || !isLoopbackHostname(parsedHost.hostname)
    || parsedHost.port !== port
  ) {
    return rejection(403, 'forbidden', 'forbidden')
  }
  for (const key of Object.keys(req.headers)) {
    const lower = key.toLowerCase()
    if (lower === 'origin') return rejection(403, 'forbidden', 'forbidden')
    if (lower.startsWith('sec-fetch-')) return rejection(403, 'forbidden', 'forbidden')
    if (lower === 'forwarded' || lower.startsWith('x-forwarded-')) {
      return rejection(403, 'forbidden', 'forbidden')
    }
  }
  const remoteAddress = req.socket?.remoteAddress
  if (typeof remoteAddress !== 'string' || !isLoopbackAddress(remoteAddress)) {
    return rejection(403, 'forbidden', 'forbidden')
  }
  if (req.socket?.localPort !== port) {
    return rejection(403, 'forbidden', 'forbidden')
  }
  const contentType = headerValue(req.headers['content-type'])
  if (contentType === undefined || contentType.split(';', 1)[0]!.trim().toLowerCase() !== 'application/json') {
    return rejection(415, 'bad-request', 'Content-Type must be application/json')
  }
  return undefined
}

/** Require a non-empty string body field. */
function requireBodyString(payload: unknown, key: string): string {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new SidebarError('bad-request', 'the clue read request body must be a JSON object')
  }
  const value = (payload as Record<string, unknown>)[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SidebarError('bad-request', `"${key}" must be a non-empty string`)
  }
  return value.trim()
}

/** The exact body keys of the reader protocol (strict whitelist). */
const READ_BODY_KEYS = new Set([
  'workspaceId',
  'reference',
  'sessionId',
  'offset',
  'snapshotOffset',
  'commentsCursor',
  'parentId',
])

/** Parse one optional non-negative safe-integer field. */
function optionalOffset(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SidebarError('bad-request', `"${key}" must be a non-negative integer`)
  }
  return value
}

/**
 * Parse one optional opaque string field (comments cursor / parent id).
 *
 * The value is returned VERBATIM: providers own their cursor spelling, so the
 * route must not trim or decode it. Empty/whitespace-only values are refused
 * before the service is called.
 */
function optionalBodyString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SidebarError('bad-request', `"${key}" must be a non-empty string`)
  }
  return value
}

/** Read the bounded JSON body and validate its fixed, whitelisted fields. */
async function parseReadBody(req: SidebarHttpRequest): Promise<{
  readonly workspaceId: string
  readonly reference: string
  readonly sessionId: string
  readonly offset?: number
  readonly snapshotOffset?: number
  readonly commentsCursor?: string
  readonly parentId?: string
}> {
  const payload = await readJsonBody(req)
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new SidebarError('bad-request', 'the clue read request body must be a JSON object')
  }
  const record = payload as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!READ_BODY_KEYS.has(key)) {
      throw new SidebarError('bad-request', `unknown request field "${key}"`)
    }
  }
  const workspaceId = requireBodyString(payload, 'workspaceId')
  const reference = requireBodyString(payload, 'reference')
  const sessionId = requireBodyString(payload, 'sessionId')
  const offset = optionalOffset(record, 'offset')
  const snapshotOffset = optionalOffset(record, 'snapshotOffset')
  const commentsCursor = optionalBodyString(record, 'commentsCursor')
  const parentId = optionalBodyString(record, 'parentId')
  return {
    workspaceId,
    reference,
    sessionId,
    ...(offset === undefined ? {} : { offset }),
    ...(snapshotOffset === undefined ? {} : { snapshotOffset }),
    ...(commentsCursor === undefined ? {} : { commentsCursor }),
    ...(parentId === undefined ? {} : { parentId }),
  }
}

/** Write one safe failure envelope (never an unknown error message). */
function writeRejection(res: SidebarHttpResponse, value: Rejection): void {
  writeJson(res, value.status, { ok: false, error: { code: value.code, message: value.message } })
}

/**
 * Create the fixed loopback clue read route.
 * @param deps - clue service plus dynamic listener/registry getters.
 */
export function createClueAgentReadRoute(deps: ClueAgentReadDeps): SidebarWebRoute {
  const handler = async (req: SidebarHttpRequest, res: SidebarHttpResponse): Promise<void> => {
    const pathMatched = ((): boolean => {
      try {
        return new URL(req.url ?? '/', 'http://dsh.internal').pathname === CLUE_AGENT_READ_ROUTE_PATH
      } catch {
        return false
      }
    })()
    const webServer = deps.getWebServer?.()
    const port = listeningPortOf(webServer)
    const refused = gateRequest(req, port, pathMatched)
    if (refused !== undefined) {
      writeRejection(res, refused)
      return
    }

    // Bind cancellation to the peer connection BEFORE any asynchronous work:
    // a client that disappears must abort the source read, not leave it
    // running against a dead response.
    const controller = new AbortController()
    const onClose = (): void => { controller.abort() }
    try {
      req.once?.('aborted', onClose)
      res.once?.('close', onClose)
    } catch {
      // A structural fake without event support simply cannot be aborted.
    }
    try {
      const body = await parseReadBody(req)
      const token = parseReaderReference(body.reference)
      const registry = deps.getWorkspaceRegistry?.()
      if (registry === undefined) {
        writeRejection(res, rejection(503, 'unavailable', 'the host workspace registry is unavailable'))
        return
      }
      if (requestedWorkspaceScope(registry, body.workspaceId) === undefined) {
        writeRejection(res, rejection(403, 'forbidden', 'the requested workspace is not registered'))
        return
      }
      const value = await readClueReference(
        {
          workspaceId: body.workspaceId,
          token,
          ...(body.offset === undefined ? {} : { offset: body.offset }),
          ...(body.snapshotOffset === undefined ? {} : { snapshotOffset: body.snapshotOffset }),
          ...(body.commentsCursor === undefined ? {} : { commentsCursor: body.commentsCursor }),
          ...(body.parentId === undefined ? {} : { parentId: body.parentId }),
        },
        {
          clues: deps.clues,
          registry,
          sessionId: body.sessionId,
          signal: controller.signal,
        },
      )
      if (controller.signal.aborted) return
      writeOk(res, value)
    } catch (error) {
      if (controller.signal.aborted) return
      if (error instanceof SidebarError) {
        writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
        return
      }
      if (error instanceof ClueError) {
        writeJson(res, clueStatusOf(error.category), {
          ok: false,
          error: { code: error.category, message: error.message },
        })
        return
      }
      // Unknown transport/store failure: log a fixed sentence, never the raw
      // error text (it can carry stdout, credentials or host paths).
      deps.logger?.warn?.('dsh-better-sidebar: the local clue read failed')
      writeJson(res, 500, { ok: false, error: { code: 'internal', message: 'the clue read failed' } })
      return
    } finally {
      try {
        req.off?.('aborted', onClose)
        res.off?.('close', onClose)
      } catch {
        // Best-effort cleanup on a structural fake.
      }
    }
  }
  return { kind: 'exact', path: CLUE_AGENT_READ_ROUTE_PATH, auth: 'anonymous', handler }
}

/**
 * Install the fixed route on the host web server.
 *
 * @param ctx - host context (webServer + dynamic service lookup).
 * @param clues - the live clue service.
 * @returns the route disposer (Cordis effect owns it in the host entry).
 */
export function installClueAgentRead(
  ctx: { readonly webServer: SidebarWebServer; get?(name: string): unknown },
  clues: CluesService,
): () => void {
  const lookup = (name: string): unknown => {
    try {
      return ctx.get?.(name)
    } catch {
      return undefined
    }
  }
  const webServer = (): ClueAgentReadWebServer | undefined => {
    const value = lookup('webServer')
    return value === null || typeof value !== 'object' ? ctx.webServer : value as ClueAgentReadWebServer
  }
  const registry = (): ClueReaderRegistry | undefined => {
    const value = lookup('workspaceRegistry')
    return value === null || typeof value !== 'object' ? undefined : value as ClueReaderRegistry
  }
  return ctx.webServer.register(createClueAgentReadRoute({
    clues,
    getWebServer: webServer,
    getWorkspaceRegistry: registry,
    logger: (ctx as { logger?: { warn?(message: string): void } }).logger,
  }))
}

/** Re-export the canonical value type for the route's test seam. */
export type { ClueReaderValue }
