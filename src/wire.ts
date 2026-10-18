/**
 * Wire helpers for the /sidebar JSON API: bounded body reading, response
 * writing, and the shared error envelope. Every API method returns
 * `{ok: true, value}` on success and `{ok: false, error: {code, message}}`
 * (HTTP 4xx/5xx matching the code) on failure.
 */
import type { SidebarHttpRequest, SidebarHttpResponse } from './context-types.ts'
// Value import for the error-class branch in writeError. git.ts imports only
// node builtins, so this introduces no cycle; wire.ts is host-half only and is
// never reachable from the browser bundle.
import { GitCommandError } from './git.ts'

/** Machine-readable error codes of the sidebar API. */
export type SidebarErrorCode =
  | 'bad-request'
  | 'not-found'
  | 'forbidden'
  | 'method-error'
  | 'too-large'
  | 'unavailable'
  | 'fs-error'
  | 'fs-conflict'
  | 'git-error'
  | 'graph-stale'
  | 'graph-limit'
  | 'git-suggest-empty'
  | 'git-suggest-error'
  | 'job-error'
  | 'team-error'
  | 'team-conflict'
  | 'sidechat-error'
  | 'subagents-unavailable'
  | 'settings-rejected'
  | 'settings-conflict'
  | 'internal'

/** One API failure with its wire code and HTTP status. */
export class SidebarError extends Error {
  constructor(
    readonly code: SidebarErrorCode,
    message: string,
    readonly status = 400,
    /** Optional structured context carried alongside the code. */
    readonly meta?: Record<string, string>,
  ) {
    super(message)
  }
}

/** Body size bound of one JSON request (defense against unbounded reads). */
const MAX_BODY_BYTES = 1 << 20

/** Success envelope of one API method. */
export interface SidebarOk<T> { ok: true; value: T }

/** Failure envelope of one API method. */
export interface SidebarErr { ok: false; error: { code: SidebarErrorCode; message: string } }

/** Read and parse the JSON request body (bounded; malformed → bad-request). */
export async function readJsonBody(req: SidebarHttpRequest): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    // The structural request yields string | Uint8Array; Buffer.from accepts
    // both (and the real runtime chunks are node Buffers anyway).
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      throw new SidebarError('bad-request', 'request body too large')
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new SidebarError('bad-request', 'request body is not valid JSON')
  }
}

/**
 * Read a raw text request body (the editor save route).
 *
 * JSON framing was what capped a save at {@link MAX_BODY_BYTES}: the whole
 * document had to be string-escaped into one JSON payload, so a file the
 * editor could legitimately open could not be written back. The save route
 * therefore takes the document as the raw body.
 *
 * `limit` is a server-side sanity guard rather than a product limit — the UI
 * cannot produce more than the editable size — because the encoding transform
 * the caller runs afterwards needs the document as one string.
 *
 * @param req - the request face (async-iterable body).
 * @param limit - maximum accepted body size in bytes.
 * @returns the body decoded as UTF-8.
 * @throws {SidebarError} too-large beyond the limit, bad-request on invalid UTF-8.
 */
export async function readTextBody(req: SidebarHttpRequest, limit: number): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > limit) {
      throw new SidebarError('too-large', `request body exceeds the ${limit} byte limit`, 413)
    }
    chunks.push(buffer)
  }
  // `fatal` so a body that is not valid UTF-8 is refused instead of silently
  // becoming replacement characters in the saved file.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } catch {
    throw new SidebarError('bad-request', 'request body is not valid UTF-8')
  }
}

/** Write a JSON response with the given status. */export function writeJson(res: SidebarHttpResponse, status: number, body: unknown): void {
  // The response may already be committed by one of the raw byte routes (a
  // file stream that failed mid-flight): `writeHead` would then throw
  // ERR_HTTP_HEADERS_SENT, and the route's catch block would turn a merely
  // truncated download into a crashed request. There is nothing left to say to
  // the client once the status line is out — tear the socket down instead.
  if (res.headersSent === true) {
    res.destroy?.()
    return
  }
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/** Write the success envelope. */
export function writeOk(res: SidebarHttpResponse, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

/** Write the failure envelope for any thrown value (unknown → internal 500). */
export function writeError(res: SidebarHttpResponse, error: unknown): void {
  if (error instanceof SidebarError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  // A git failure is a state/input problem the user caused (unknown ref, path
  // outside the repository, not a repository), not a plugin fault. Reporting it
  // as 500 "internal" reads as a crash and hides the localized not-a-repository
  // copy the client already knows how to render; `not-repo` carries its own
  // code (409) so that path is reachable at all.
  if (error instanceof GitCommandError) {
    const notRepo = error.code === 'not-repo'
    writeJson(res, notRepo ? 409 : 400, {
      ok: false,
      error: { code: notRepo ? 'not-repo' : 'git-error', message: error.message },
    })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, 500, { ok: false, error: { code: 'internal', message } })
}

/** Narrow an unknown payload value to a string, else throw bad-request. */
export function requireString(payload: unknown, key: string): string {
  const record = payload as Record<string, unknown> | null
  const value = record?.[key]
  if (typeof value !== 'string' || value === '') {
    throw new SidebarError('bad-request', `missing or invalid "${key}"`)
  }
  return value
}
