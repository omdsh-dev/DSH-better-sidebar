/**
 * A failed comment save in plain words, and the character count near the limit (round 5, TCH stage 6
 * acceptance v3 TH-2; rule 20 in TCH `tasks/todo-comment-people.md`).
 *
 * A door's `next` sentence is written for whoever calls the door ("Fix the field named in `field` and
 * send the request again."), so the tab never shows it for a save: each refusal a person can act on
 * has its own copy key, and anything else reads "Could not save. Your words are kept. Try again." —
 * the box that failed stays open with its words and files (`comment-controller.ts`), so that promise
 * holds.
 *
 * Codes: `COMMENT_TOO_LONG` (`maxChars` beside it; an older server said `COMMENT_BAD_INPUT` with
 * `field: 'text'`), `COMMENT_RATE_LIMIT` or any 429 (server round 5; the stage-5 cap `COMMENT_LIMIT` is
 * gone), 401 / `NOT_SIGNED_IN`, `SEAT_NOT_AUTHORIZED` / `SEAT_REQUIRED`, `COMMENT_NOT_YOURS`,
 * `NETWORK` (no answer at all), `ATTACHMENT_*` (a file of the save).
 */
import type { CopyKey } from './locales.ts'

/** The longest text when the comment list names none (`limits.maxChars` absent: an older server); the server's own limit. */
export const DEFAULT_MAX_CHARS = 4000

/** From this share of the limit on, the box shows its count. */
export const COUNT_FROM = 0.9

/** A refusal as `comment-api.ts` hands it over (`DoorAnswer` not ok). */
export interface SaveRefusal {
  status: number
  code: string
  /** The server's limit named beside `COMMENT_TOO_LONG`. */
  maxChars?: number
  /** The field `COMMENT_BAD_INPUT` names. */
  field?: string
}

/** What a box says after a failed save: a copy key and its holes. */
export interface SaveError {
  key: CopyKey
  params?: Record<string, number>
}

/**
 * The words for one refusal.
 * @param refusal - the door's answer.
 * @param maxChars - the limit the list named (or {@link DEFAULT_MAX_CHARS}).
 */
export function saveErrorOf(refusal: SaveRefusal, maxChars: number): SaveError {
  const { status, code } = refusal
  if (code === 'COMMENT_TOO_LONG' || (code === 'COMMENT_BAD_INPUT' && refusal.field !== undefined && /(^|\.)text$/.test(refusal.field))) {
    const max = typeof refusal.maxChars === 'number' && refusal.maxChars > 0 ? refusal.maxChars : maxChars
    return { key: 'commentErrTooLong', params: { max } }
  }
  if (code === 'COMMENT_RATE_LIMIT' || status === 429) return { key: 'commentErrRateLimit' }
  if (code === 'NOT_SIGNED_IN' || status === 401) return { key: 'commentErrSignedOut' }
  if (code === 'SEAT_NOT_AUTHORIZED' || code === 'SEAT_REQUIRED') return { key: 'commentErrNoSeat' }
  if (code === 'COMMENT_NOT_YOURS') return { key: 'commentErrNotYours' }
  if (code === 'NETWORK' || status === 0) return { key: 'commentErrNetwork' }
  if (code.startsWith('ATTACHMENT_')) return { key: 'commentErrFile' }
  return { key: 'commentErrUnknown' }
}

/** The length the server checks: the trimmed words, in UTF-16 code units (what `maxlength` counts). */
export function textLength(text: string): number {
  return text.trim().length
}

/**
 * The box's count: hidden well under the limit, shown from {@link COUNT_FROM} of it, `over` past it
 * (the box's Add / Send / Save / Reply buttons are then disabled).
 */
export function charCount(text: string, max: number): { shown: boolean; over: boolean; length: number; max: number } {
  const length = textLength(text)
  return { shown: length >= max * COUNT_FROM, over: length > max, length, max }
}
