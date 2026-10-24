/**
 * The explorer's `@`-reference button: insert one file or folder reference
 * into the conversation draft of a session.
 *
 * The token is projected against the host-confirmed workspace root — the
 * session's `WorkspaceView.path`, matched by exact session membership — never
 * the session cwd: DSH's `@` grammar is workspace-root relative (#479), and a
 * cwd-relative guess silently names a different file whenever the two differ.
 * A missing service or membership, an unready snapshot, a path outside the
 * workspace and an unrepresentable path all degrade to a logged no-op, never
 * an absolute mention. `insertWorkspaceReference` owns that policy; this
 * module stays the single entry both surfaces share.
 *
 * Directories append the folder mention as plain text so DSH's folder
 * decoration and completion keep working — spelled through the same
 * constructor as file references (`@"my dir/"`, `@docs/`; an unquoted
 * `@my dir/` is not a folder token to the host, see `mentionFor`); files
 * insert a structured chip like the native `@` picker, so the whole
 * reference stays one link instead of decorating only the leading folder.
 * The session-scope context and the conversation input service are resolved
 * at click time; a missing service or scope degrades to a logged no-op,
 * never a crash.
 *
 * Shared by the plugin's own panel and the native right-Sidebar tab body, so
 * both surfaces behave identically.
 */
import type { Context } from '../context-types.ts'
import { insertWorkspaceReference } from './conversation-draft.ts'

/**
 * Reference one path in the session's conversation draft.
 * @param ctx - the client context.
 * @param sessionId - the session whose draft receives the reference.
 * @param path - the absolute entry path the explorer row carries.
 * @param isDir - whether the path is a directory (folder mention vs file chip).
 */
export function referenceInChat(
  ctx: Context,
  sessionId: string,
  path: string,
  isDir: boolean,
): void {
  insertWorkspaceReference(ctx, sessionId, path, isDir)
}
