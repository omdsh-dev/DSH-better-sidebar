/**
 * The one-shot landing RANGE that rides beside a line navigation.
 *
 * A file open carries a single 1-based line through the host's own navigation
 * parameter (`#826`), so the viewer can land the reader. The quote chip needs
 * two more facts: where the quoted span ENDS, and whether the click is a NEW
 * navigation when it names the SAME line again. The host's parameter map
 * declares only `line` for a file resource, and its tab adapter deliberately
 * drops a navigation whose `line` did not move — so a second click on the same
 * chip would otherwise be indistinguishable from the previous landing, and an
 * arm left behind by it could flash a later ordinary open. Rather than smuggle
 * undeclared keys through host-owned params (nothing validates them at run
 * time, so it would work right up until upstream tightened the shape), both
 * facts ride this module-level side channel:
 *
 * - the END line, armed by the code opening the file;
 * - a NONCE bumped on every arm, so the editor's "already landed here" journal
 *   treats a re-click as a new navigation instead of the same `path#line`.
 *
 * The key is `${path}#${line}` — deliberately the SAME key the editor's own
 * landed-once journal uses. The arm is spent by the editor that hands the
 * navigation to its viewer, so re-renders never replay it and a later ordinary
 * open of the same line finds nothing. Core bundle only (no CodeMirror import):
 * the flash itself lives in `quote-flash.ts`, which is bundled with the editor
 * chunk.
 */

/** Max armed ranges held at once; the oldest is dropped (a stale arm only
 *  loses a decoration, never the navigation). */
const MAX_ARMED = 32

/** One armed navigation: its identity plus the quoted span's end. */
export interface LineTarget {
  /** Bumped on every arm of the same `path#line`; a re-click gets a new one. */
  readonly nonce: number
  /** The 1-based last line of the quoted span (absent = a single-line landing). */
  readonly end?: number
}

const armed = new Map<string, LineTarget>()
let nextNonce = 1

function keyOf(path: string, line: number): string {
  return `${path}#${line}`
}

/**
 * Arm the flash end (and a fresh navigation identity) for the next landing on
 * `path:line`.
 * @param path - the file's path (the same spelling the open carries).
 * @param line - the 1-based landing line.
 * @param lineEnd - the 1-based last line of the range; `undefined` arms a
 *   single-line landing (a fresh jump without a flash range).
 * @returns the new navigation's nonce.
 */
export function armLineEnd(path: string, line: number, lineEnd: number | undefined): number {
  const key = keyOf(path, line)
  const nonce = nextNonce++
  armed.delete(key)
  armed.set(key, lineEnd === undefined ? { nonce } : { nonce, end: lineEnd })
  while (armed.size > MAX_ARMED) {
    const oldest = armed.keys().next()
    if (oldest.done === true) break
    armed.delete(oldest.value)
  }
  return nonce
}

/**
 * Read the pending navigation for `path:line` WITHOUT spending it. Render-safe
 * (a pure map read): React may render twice, and a discarded render must not
 * eat the arm the committed one still needs.
 * @param path - the file's path.
 * @param line - the 1-based landing line.
 * @returns the pending arm, or `undefined` when this is not an armed open.
 */
export function peekLineTarget(path: string, line: number): LineTarget | undefined {
  return armed.get(keyOf(path, line))
}

/**
 * Spend the pending navigation for `path:line` once the editor has handed it
 * to its viewer (idempotent). Only the editor that actually applied the
 * navigation calls this, so a later ordinary open of the same line cannot
 * inherit a stale flash.
 * @param path - the file's path.
 * @param line - the 1-based landing line.
 */
export function consumeLineTarget(path: string, line: number): void {
  armed.delete(keyOf(path, line))
}
