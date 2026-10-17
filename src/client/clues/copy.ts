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
import { ClueError } from '../../clues/error.ts'
import type { ClueErrorCategory } from '../../clues/types.ts'
import { t } from '../locales.ts'

/** Whether a rejected value is the shared clue error class. */
export function isClueError(error: unknown): error is ClueError {
  return error instanceof ClueError
}

/** The category of a rejected clue call, or `failed` for anything else. */
export function categoryOf(error: unknown): ClueErrorCategory {
  return isClueError(error) ? error.category : 'failed'
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
