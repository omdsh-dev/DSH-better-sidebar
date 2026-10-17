/**
 * Fixed, credential-free reasons used by the cluepack boundary.
 *
 * A source error message can contain a bearer token, a cookie, a private URL
 * or a sender-local absolute path. That message must never travel in a
 * manifest: the receiver sees `manifest.issues[].reason` and
 * `clues[].portable.reason`, so both are written from this catalogue instead
 * of from the raw error. The importer uses the same catalogue when it persists
 * an unresolved row, which keeps a later re-export safe too.
 */
import { isClueError, type ClueErrorCategory } from '../types.ts'

/** Fixed, context-neutral wording of one failing clue category. */
export const SAFE_FAILURE_REASONS: Record<ClueErrorCategory, string> = {
  'source-missing': 'the source is not available on this machine',
  'dependency-missing': 'a source dependency is missing on this machine',
  'dependency-incompatible': 'a source dependency is incompatible on this machine',
  'auth-required': 'the operation requires authorization',
  'permission-denied': 'the operation was denied access',
  'not-found': 'the resource was not found',
  unsupported: 'the content is not supported',
  'rate-limited': 'the operation was rate limited',
  conflict: 'the source reported a conflict',
  cancelled: 'the operation was cancelled',
  timeout: 'the operation timed out',
  'invalid-request': 'the request was rejected',
  failed: 'the operation failed',
}

/** Fixed reason for a stored unresolved row whose original reason is untrusted. */
export const SAFE_UNRESOLVED_REASON = 'the reference is unresolved on this machine'

/** Fixed reason when a source declines to issue a portable reference. */
export const SAFE_PORTABLE_REFUSED_REASON = 'the source did not provide a portable reference'

/** Fixed reason for a non-portable archived locator (also used as a hint). */
export const SAFE_NON_PORTABLE_REASON
  = 'the archived reference is not portable; the receiver must choose an explicit remapping'

/** Fixed reason for a sender-local absolute path kept as an explicit hint. */
export const SAFE_EXTERNAL_PATH_REASON
  = 'an absolute path outside a workspace has no portable reference; the receiver must choose an explicit remapping'

/** Fixed reason for a reference that needs a receiver-side workspace choice. */
export const SAFE_WORKSPACE_REMAP_REASON = 'the reference needs an explicit receiving-workspace remapping'

/** Fixed reason for an archived locator that only a receiver can turn into an address. */
export const SAFE_ARCHIVED_REMAP_REASON
  = 'the archived non-portable locator needs an explicit receiving-side remapping'

/** Fixed reason when an explicitly selected source connection is not exposed here. */
export const SAFE_CONNECTION_REASON = 'the selected connection is not available on this machine'

/** Fixed reason for a locator written for another OS path dialect. */
export const SAFE_CROSS_DIALECT_REASON
  = 'the reference uses another path dialect and cannot be opened on this host; choose a receiving-side file explicitly'

/** Fixed reason when the source named by a clue is not installed on this machine. */
export const SAFE_SOURCE_NOT_INSTALLED = 'the source is not installed on this machine'

/** Fixed reason when the installed source does not offer the archived type. */
export const SAFE_TYPE_NOT_OFFERED = 'the source does not offer the required type on this machine'

/** Fixed reason when neither the archive nor the row carries an address. */
export const SAFE_NO_PORTABLE_REFERENCE = 'the clue has no portable reference'

/** Fixed reason recorded when the receiver adopted an unresolved row explicitly. */
export const SAFE_ADOPTED_REASON = 'the receiver selected this address explicitly'

/**
 * Every reason this layer may persist or export.
 *
 * Anything else found on an unresolved row (for example a row written by an
 * older build, or a hand-seeded test fixture) is replaced with a fixed
 * fallback at the export boundary: an untrusted string is never copied into a
 * shared manifest just because some other code stored it.
 */
export const SAFE_REASON_TEXTS: ReadonlySet<string> = new Set([
  ...Object.values(SAFE_FAILURE_REASONS),
  SAFE_UNRESOLVED_REASON,
  SAFE_PORTABLE_REFUSED_REASON,
  SAFE_NON_PORTABLE_REASON,
  SAFE_EXTERNAL_PATH_REASON,
  SAFE_WORKSPACE_REMAP_REASON,
  SAFE_ARCHIVED_REMAP_REASON,
  SAFE_CONNECTION_REASON,
  SAFE_CROSS_DIALECT_REASON,
  SAFE_SOURCE_NOT_INSTALLED,
  SAFE_TYPE_NOT_OFFERED,
  SAFE_NO_PORTABLE_REFERENCE,
  SAFE_ADOPTED_REASON,
])

/** Whether a reason was produced by this catalogue and is safe to copy. */
export function isSafeReasonText(reason: string | undefined): reason is string {
  return reason !== undefined && SAFE_REASON_TEXTS.has(reason)
}

/** Return one known-safe stored reason, or the fixed fallback. */
export function safeStoredReason(reason: string | undefined, fallback: string): string {
  return isSafeReasonText(reason) ? reason : fallback
}

/**
 * The fixed category/message of one failure.
 *
 * Only the ClueError CATEGORY is trusted; its message is deliberately dropped
 * even when it looks benign, because a source or a filesystem wrapper may have
 * embedded a secret or a sender-local path in it.
 */
export function safeFailureOf(error: unknown): { category: ClueErrorCategory; reason: string } {
  if (isClueError(error)) {
    return { category: error.category, reason: SAFE_FAILURE_REASONS[error.category] }
  }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return { category: 'cancelled', reason: SAFE_FAILURE_REASONS.cancelled }
  }
  return { category: 'failed', reason: SAFE_FAILURE_REASONS.failed }
}
