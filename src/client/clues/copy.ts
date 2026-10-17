/**
 * Shared clue error copy (S9 glue).
 *
 * S1/S2/S3/S4 already sanitize their failures: the wire carries a stable
 * category plus a message that never contains stdout/stderr, tokens or paths.
 * The UI still owes the reader an ACTIONABLE distinction — "authorize the
 * source" is not "install the CLI", and neither is "no results". This module
 * maps the categories that have a concrete next step to localized copy and
 * leaves the rest to the caller's fallback.
 */
import { CLUE_ERROR_CATEGORIES, ClueError } from '../../clues/error.ts'
import type { ClueErrorCategory } from '../../clues/types.ts'
import { t } from '../locales.ts'

/** Whether a rejected value is the shared clue error class. */
export function isClueError(error: unknown): error is ClueError {
  return error instanceof ClueError
}

/**
 * The category of a rejected clue call, or `failed` for anything else.
 *
 * The client normally receives a {@link ClueError} only in tests: over the
 * wire the host writes the SAME category as the envelope's `code` (see
 * `writeError`), which the typed transport surfaces as `SidebarApiError`.
 * Reading only `instanceof ClueError` therefore classified every real
 * conflict/auth/dependency failure as a generic failure and hid the
 * actionable copy. Accept both shapes.
 */
export function categoryOf(error: unknown): ClueErrorCategory {
  if (isClueError(error)) return error.category
  const code = (error as { readonly code?: unknown } | null | undefined)?.code
  if (typeof code === 'string' && (CLUE_ERROR_CATEGORIES as readonly string[]).includes(code)) {
    return code as ClueErrorCategory
  }
  return 'failed'
}

/**
 * Localized next-step copy for the categories that have one.
 * @param category - the stable S1 category.
 * @returns the copy, or undefined to use the caller's fallback.
 */
export function clueErrorHint(category: string): string | undefined {
  switch (category) {
    case 'auth-required':
      return t('clueStateNotAuthorized')
    case 'permission-denied':
      return t('clueConnectionScope')
    case 'dependency-missing':
    case 'dependency-incompatible':
      return t('clueStateMissing')
    case 'source-missing':
      return t('clueSourcesUnavailable')
    default:
      return undefined
  }
}

/**
 * One user-visible line for a rejected clue call.
 * @param error - the rejected value.
 * @param fallback - localized copy for a failure with no specific hint.
 */
export function clueErrorMessage(error: unknown, fallback: string): string {
  const hint = clueErrorHint(categoryOf(error))
  return hint === undefined ? fallback : `${t('error')}: ${hint}`
}
