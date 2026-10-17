/**
 * Scope-bound opaque cursors (S4).
 *
 * A cursor belongs to exactly ONE browsing range (folder, wiki space/parent,
 * task list or query). The token is opaque to the client, and decoding it
 * against a different scope signature fails as `invalid-request` instead of
 * silently mixing pages — the exact failure mode the approved spec forbids
 * ("range change resets the cursor; tokens of different ranges cannot mix").
 *
 * Encoding is URI-encoded JSON (no secrets, no node-only Buffer): a page token
 * from the provider plus a signature derived from the canonical scope JSON.
 */
import { ClueError } from '../../types.ts'
import type { JsonValue } from '../../types.ts'

/** A stable JSON text (object keys sorted) used only for cursor signatures. */
export function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(',')}}`
}

/** The opaque cursor prefix; versioned so a future shape can be distinguished. */
const CURSOR_PREFIX = 'feishu1.'

/** One decoded provider page token. */
export interface CursorPage {
  readonly pageToken: string
}

/** Encode one provider page token for one scope signature. */
export function encodeCursor(scopeSignature: string, pageToken: string): string {
  return `${CURSOR_PREFIX}${encodeURIComponent(JSON.stringify({ s: scopeSignature, t: pageToken }))}`
}

/**
 * Decode one cursor and verify it belongs to the given scope.
 * @throws {ClueError} `invalid-request` for a malformed or foreign cursor.
 */
export function decodeCursor(scopeSignature: string, cursor: string): CursorPage {
  if (typeof cursor !== 'string' || !cursor.startsWith(CURSOR_PREFIX)) {
    throw new ClueError('invalid-request', 'the page cursor is not a Feishu cursor')
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(decodeURIComponent(cursor.slice(CURSOR_PREFIX.length)))
  } catch {
    throw new ClueError('invalid-request', 'the page cursor is malformed')
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new ClueError('invalid-request', 'the page cursor is malformed')
  }
  const record = decoded as { s?: unknown; t?: unknown }
  if (record.s !== scopeSignature) {
    throw new ClueError('invalid-request', 'the page cursor belongs to a different Feishu range; reset the range and browse again')
  }
  if (typeof record.t !== 'string' || record.t === '') {
    throw new ClueError('invalid-request', 'the page cursor carries no provider page token')
  }
  return { pageToken: record.t }
}
