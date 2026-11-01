/**
 * The workspace root a session-scoped file ADDRESS is built and read with.
 *
 * DSH's address contract fixes that base to the session's STORED header cwd:
 * the host chat builds every file link with
 * `fileAddressFor(sessionId, ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd, path)`
 * (DSH `ui-chat`), and the host's own file resolver reads the relative path
 * back against `sessions.get(sessionId).header.cwd` (DSH `api-workspace-files`)
 * — the same value, so the host round-trips perfectly.
 *
 * The plugin does not: since #802 its filesystem routes follow the ACTIVE git
 * worktree, so an address's relative path re-resolved by a worktree-rooted
 * reader lands somewhere else entirely — doubled when the worktree sits inside
 * the stored cwd (`<repo>/frontend/.worktrees/wt/a.md` arrives as
 * `frontend/.worktrees/wt/a.md` and becomes
 * `<wt>/frontend/.worktrees/wt/a.md`, ENOENT — #947), or silently on the
 * same-named file of another checkout (#950).
 *
 * The rule that removes the whole family: an address's base is THIS value,
 * never the active worktree root, and an address's path is resolved to an
 * absolute one at the boundary where the address is read, so no
 * worktree-rooted code downstream ever sees a relative path it could re-base.
 * Live relative paths the user or the plugin intends (file tree, typed
 * paths, links inside a document) keep using the active root, which is what
 * `useSessionRoot` is for.
 *
 * The ONE case the stored cwd cannot answer is a session that LEFT that root.
 * Group / IM bridges open the conversation in a neutral directory
 * (`~/.dsh/im`) and then move into the project the chat is about: the header
 * cwd stays the neutral root for the session's whole life, while every
 * relative path a model, a tool result or a `cd`-scoped command prints is
 * relative to the LIVE directory. Resolving such an address against the
 * stored root puts it under `~/.dsh/im` and the preview dies with ENOENT. So
 * the base follows the live `workingDirectory` projection exactly while the
 * session is OUTSIDE its stored root — and keeps the stored root otherwise,
 * so a worktree nested in the workspace still resolves on the stored base
 * (#947/#950).
 *
 * @param ctx - client context carrying the session list.
 * @param sessionId - the session the address belongs to; `undefined` answers
 *   `undefined` so callers can fall back to their own cwd.
 * @returns the address base — the live working directory when the session has
 *   left its stored root, else the stored header cwd — or `undefined` when it
 *   is unknown (a stripped-down host or a bare test context).
 */
import type { Context } from '../context-types.ts'
import { resolveSidebarPath } from './paths.ts'

/**
 * The session's LIVE working directory (where a `cd` left it), or undefined
 * when the host publishes no such projection.
 *
 * Two host shapes are read, because both have existed: the list row's
 * `projectionValues` (DSH 0.2.x) and the per-connection
 * `projectionsBySession` store. Only a non-empty string counts — the
 * projection is `null` before the first `working-directory/change`.
 *
 * @param ctx - client context carrying the session list.
 * @param sessionId - the session whose projection is read.
 * @returns the live directory, or undefined when the host cannot answer.
 */
function liveWorkingDirectoryOf(ctx: Context, sessionId: string): string | undefined {
  try {
    const snapshot = ctx.sessions?.list?.getSnapshot?.()
    const live = snapshot?.byId?.[sessionId]?.projectionValues?.workingDirectory
      ?? snapshot?.projectionsBySession?.[sessionId]?.values?.workingDirectory
    return typeof live === 'string' && live !== '' ? live : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether `path` is `root` itself or sits under it, in either separator style.
 *
 * The prefix test folds case only for a Windows-spelled root: a POSIX host's
 * `/Repo` and `/repo` are different directories, while a Windows host's
 * `C:\Repo` and `c:\repo` are the same one (the same reason `paths.ts`
 * compares prefixes case-insensitively on that side).
 *
 * @param path - the candidate path.
 * @param root - the root to test against; `undefined` never contains anything.
 * @returns true when `path` lies at or under `root`.
 */
function isUnderRoot(path: string, root: string | undefined): boolean {
  if (root === undefined || root === '') return false
  const strip = (value: string): string => value.replace(/[\\/]+$/, '')
  const base = strip(root)
  if (base === '') return false
  const fold = (value: string): string => (base.includes('\\') ? value.toLowerCase() : value)
  const target = fold(strip(path))
  const foldedBase = fold(base)
  if (target === foldedBase) return true
  return target.startsWith(`${foldedBase}/`) || target.startsWith(`${foldedBase}\\`)
}

export function addressBaseOf(ctx: Context, sessionId: string | undefined): string | undefined {
  if (sessionId === undefined) return undefined
  let stored: string | undefined
  try {
    stored = ctx.sessions?.list?.getSnapshot?.()?.byId?.[sessionId]?.cwd
  } catch {
    // A context without the session list (or with a broken one) keeps the
    // caller's own cwd; the address is no worse than before this helper.
    stored = undefined
  }
  const live = liveWorkingDirectoryOf(ctx, sessionId)
  return live !== undefined && !isUnderRoot(live, stored) ? live : stored
}

/**
 * Resolve an address's path against its base, spelled the way the base is.
 *
 * The address grammar is `/`-separated on every platform, so joining one onto
 * a Windows base with `resolveSidebarPath` alone leaves a MIXED spelling:
 * `C:\repo` + `src/a.ts` → `C:\repo\src/a.ts`, while the file tree, the git
 * panel and every `join`-based producer spell the same file
 * `C:\repo\src\a.ts`. Two spellings of one file is two tab identities (the
 * editor's `dedupeKey`/id is path-derived) and two answers to "is it the same
 * path", so the address boundary folds the separators to the base's style.
 * POSIX keeps the path verbatim: there `\` is a legal file-name character, not
 * a separator (the same reason `resolveSidebarPath` never folds on POSIX).
 *
 * A UNC prefix is NOT a separator run to fold: `\\server\share` is one path
 * root, and folding its two leading separators into one turns an absolute
 * network path into a drive-root-relative one. On Windows the host then runs
 * `path.resolve()` on it, anchoring `\wsl.localhost\...` on the host process
 * drive (`C:\wsl.localhost\...`, ENOENT) — every file opened from a
 * `\\wsl.localhost\<distro>\...` workspace failed that way. Keep exactly the
 * two leading separators and fold only the rest.
 *
 * @param base - the workspace root whose separator style decides the answer.
 * @param path - an address path (relative to `base`) or an absolute path.
 * @returns the resolved path in `base`'s separator style.
 */
export function resolveAddressPath(base: string | undefined, path: string): string {
  const resolved = resolveSidebarPath(base, path)
  if (base === undefined || !base.includes('\\')) return resolved
  const folded = resolved.replace(/[/\\]+/g, '\\')
  return /^[\\/]{2}/.test(resolved) ? `\\\\${folded.replace(/^\\+/, '')}` : folded
}
