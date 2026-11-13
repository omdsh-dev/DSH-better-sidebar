/**
 * Lexical path resolution for the sidebar's filesystem routes.
 *
 * ⚠️ **This module no longer enforces workspace containment.** It used to
 * canonicalize through `realpath` and reject anything outside the session
 * workspace; the user asked for that guard to be removed, so the sidebar fs
 * routes now reach any path the HOST USER can reach, bounded only by OS
 * permissions (and by the browser-trust fence on the routes themselves).
 *
 * What remains is the part every caller still needs: turn the client's
 * (possibly session-relative) target into one absolute, lexically-normalized
 * path. `resolveSessionPath` joins it under the session cwd, `resolve()`
 * collapses `.` / `..` segments, and {@link requireAbsolute} rejects
 * non-absolute input. No `realpath`, no containment guard, no 403.
 *
 * Kept as one module so the call sites read the same way they did with the
 * fence: the change is the SEMANTICS — "resolve" rather than "guard".
 */
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { requireAbsolute } from './fs-tree.ts'
import { resolveSessionPath } from './session-path.ts'

/**
 * The single resolution primitive: session-relative targets resolve under the
 * session cwd, absolute targets stay absolute, and the result is `resolve()`d
 * (lexical `..` collapse). Throws fs-error for a non-absolute result.
 */
export function resolveTarget(cwd: string, target: string): string {
  // #713: `~` names the user's home directory, not a session-relative path —
  // expand it before the join so it is not pasted after the cwd (ENOENT).
  const homeExpanded = target === '~' || target.startsWith('~/') || target.startsWith('~\\')
    ? join(homedir(), target.slice(1))
    : target
  // #646: the ecosystem passes session-relative targets (e.g. `openFile(scope,
  // 'pastes/x.txt')` keeps `pastes/x.txt` in the tab). Join them onto the
  // session cwd before the absolute check so every entry point (fs.read /
  // write / rename / remove / upload, media, html) shares ONE contract.
  const joined = isAbsolute(homeExpanded) ? homeExpanded : join(cwd, homeExpanded)
  return requireAbsolute(resolveSessionPath(cwd, joined))
}
