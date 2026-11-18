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

import { isAbsolutePath, relativeTo, resolveSidebarPath } from './paths.ts'

/** Max armed ranges held at once; the oldest is dropped (a stale arm only
 *  loses a decoration, never the navigation). */
const MAX_ARMED = 32

/**
 * The find-in-file seed a CONTENT-SEARCH hit carries: the query and switches
 * the result was found with. The text viewer paints every match in the file
 * from it (panel-independent) and seeds the query into CodeMirror's search
 * state for a later Ctrl/Cmd+F. It is navigation, not a mode — it rides beside
 * `line` and is spent with it.
 */
export interface EditorSearchSeed {
  /** The query exactly as the search box carried it. */
  query: string
  /** Match case (the host's default is case-insensitive). */
  caseSensitive?: boolean
  /** Whole-word matching. */
  wholeWord?: boolean
  /** The query is a JS regular expression. */
  regex?: boolean
}

/** One armed navigation: its identity plus the quoted span's end. */
export interface LineTarget {
  /** Bumped on every arm of the same `path#line`; a re-click gets a new one. */
  readonly nonce: number
  /** The 1-based last line of the quoted span (absent = a single-line landing). */
  readonly end?: number
  /** The content-search seed to apply on arrival (absent = an ordinary
   *  reference landing). */
  readonly search?: EditorSearchSeed
}

const armed = new Map<string, LineTarget>()
let nextNonce = 1

/**
 * Canonical identity of one file for the arm lookup.
 *
 * The two ends of the gesture spell the same Windows file differently: the
 * result row builds `D:\work/src/a.ts` (mixed separators — a backslash cwd plus
 * the search's `/`-separated relative path), while `openSidebarFile` folds the
 * settled path to the host's dialect and the native tab then carries what the
 * HOST resolved (`D:\work\src\a.ts`, and case may differ too). An exact-string
 * key lost the search seed on that mismatch, which read as "the line lands, but
 * nothing is highlighted".
 *
 * Windows spellings (a drive letter or a backslash UNC root) therefore fold
 * separators and case, matching the filesystem's own identity. A path in POSIX
 * form stays EXACT: there `\` is a legal file-name character and case is
 * significant.
 */
function pathKey(path: string): string {
  const windows = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') || /^\/\/[^/]/.test(path)
  return windows ? path.replace(/[\\/]+/g, '/').toLowerCase() : path
}

function keyOf(path: string, line: number): string {
  return `${pathKey(path)}#${line}`
}

/**
 * Every key one landing may be armed under.
 *
 * Beyond separator/case spelling, the two ends can disagree on ABSOLUTENESS:
 * the content search arms the absolute path its result row resolved, while the
 * native tab carries what the host stored from the resource address — often
 * the workspace-RELATIVE spelling (`fileAddressFor` deliberately sends one).
 * The line still landed (the host carries it separately), but the search seed
 * was lost with the exact key. With the session cwd both spellings are
 * derivable, so a lookup tries the path itself and its relative/absolute
 * alias.
 */
function candidateKeys(path: string, line: number, cwd: string | undefined): string[] {
  const keys = [keyOf(path, line)]
  if (cwd !== undefined && cwd !== '') {
    if (isAbsolutePath(path)) {
      const relative = relativeTo(cwd, path)
      // `relativeTo` answers the input unchanged for a path outside the root,
      // and '.' for the root itself: neither is another spelling of a FILE.
      if (relative !== path && relative !== '.' && !isAbsolutePath(relative)) {
        keys.push(keyOf(relative, line))
      }
    } else {
      keys.push(keyOf(resolveSidebarPath(cwd, path), line))
    }
  }
  return [...new Set(keys)]
}

/**
 * Arm the flash end (and a fresh navigation identity) for the next landing on
 * `path:line`.
 * @param path - the file's path; Windows spellings are compared after
 *   folding separators and case (the row and the host may spell one file two
 *   ways), POSIX paths exactly.
 * @param line - the 1-based landing line.
 * @param lineEnd - the 1-based last line of the range; `undefined` arms a
 *   single-line landing (a fresh jump without a flash range).
 * @param search - the content-search seed to hand the text viewer on arrival.
 *   Omitted for ordinary references; passing it again on the same key is a new
 *   navigation (new nonce) that re-seeds the find panel.
 * @returns the new navigation's nonce.
 */
export function armLineEnd(path: string, line: number, lineEnd: number | undefined, search?: EditorSearchSeed): number {
  const key = keyOf(path, line)
  const nonce = nextNonce++
  armed.delete(key)
  armed.set(key, search === undefined
    ? lineEnd === undefined ? { nonce } : { nonce, end: lineEnd }
    : lineEnd === undefined ? { nonce, search } : { nonce, end: lineEnd, search })
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
 * @param path - the file's path (relative or absolute).
 * @param line - the 1-based landing line.
 * @param cwd - the session workspace root, so the arm is also found when the
 *   other end spelled the same file relative/absolute.
 * @returns the pending arm, or `undefined` when this is not an armed open.
 */
export function peekLineTarget(path: string, line: number, cwd?: string): LineTarget | undefined {
  for (const key of candidateKeys(path, line, cwd)) {
    const target = armed.get(key)
    if (target !== undefined) return target
  }
  return undefined
}

/**
 * Spend the pending navigation for `path:line` once the editor has handed it
 * to its viewer (idempotent). Only the editor that actually applied the
 * navigation calls this, so a later ordinary open of the same line cannot
 * inherit a stale flash.
 * @param path - the file's path.
 * @param line - the 1-based landing line.
 * @param cwd - the session workspace root (same alias rule as peek).
 */
export function consumeLineTarget(path: string, line: number, cwd?: string): void {
  for (const key of candidateKeys(path, line, cwd)) armed.delete(key)
}
