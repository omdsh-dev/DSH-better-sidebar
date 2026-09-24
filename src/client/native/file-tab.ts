/**
 * One file address → the tab target the editor renders.
 *
 * A session-scoped address may spell the file RELATIVE to that session's
 * workspace root (`dsh-resource://file/session/<id>/emote_verify/final/x.png`)
 * — that is how the chat opens the files a turn produced — or keep an absolute
 * path (`/outside/x.png`) inside the same scope. The host's routes only accept
 * absolute paths, so the relative spelling is resolved against the session's
 * cwd here, ONCE, before it becomes a tab (and before any viewer builds a media
 * URL or an fs read from it). Kept pure (the cwd comes in as a lookup) so the
 * relative/absolute/unknown-cwd cases are unit-testable.
 */
import { resolveSidebarPath } from '../paths.ts'
import { parseFileAddress } from '../resource-address.ts'

/** One file tab's target: the absolute path plus the session that scopes it. */
export interface FileTabTarget {
  /** The absolute path the host routes accept. */
  readonly path: string
  /** The session whose workspace root resolves the path (session scope only). */
  readonly sessionId?: string
}

/**
 * Resolve the tab target of one `dsh-resource://file/…` address.
 *
 * @param address - the resource address DSH dispatched the tab with.
 * @param cwdOf - the requested session's workspace root, when the client knows it.
 * @returns the target, or `undefined` when the address is not a file address.
 *          A relative path whose cwd is unknown is passed through unchanged:
 *          the pane then reports the host's own refusal instead of guessing.
 */
export function fileTabTarget(address: string, cwdOf: (sessionId: string) => string | undefined): FileTabTarget | undefined {
  const parsed = parseFileAddress(address)
  if (parsed === undefined) return undefined
  if (parsed.scope === 'absolute') return { path: parsed.path }
  return { path: resolveSidebarPath(cwdOf(parsed.sessionId), parsed.path), sessionId: parsed.sessionId }
}
