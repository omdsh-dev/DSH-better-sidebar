/**
 * The explorer's `@`-reference button: insert one file or folder reference
 * into the conversation draft of a session.
 *
 * Directories append the folder mention (`@dir/`) as plain text so DSH's
 * folder decoration and completion keep working; files insert a structured
 * chip like the native `@` picker, so the whole reference stays one link
 * instead of decorating only the leading folder. The session-scope context and
 * the conversation input service are resolved at click time; a missing service
 * or scope degrades to a logged no-op, never a crash.
 *
 * Shared by the plugin's own panel and the native right-Sidebar tab body, so
 * both surfaces behave identically.
 */
import type { Context } from '../context-types.ts'
import { appendToDraft, insertFileReference } from './conversation-draft.ts'
import { relativeTo } from './paths.ts'

/**
 * Reference one path in the session's conversation draft.
 * @param ctx - the client context.
 * @param sessionId - the session whose draft receives the reference.
 * @param cwd - that session's workspace root (for the relative spelling).
 * @param path - the absolute or workspace-relative path to reference.
 * @param isDir - whether the path is a directory (folder mention vs file chip).
 */
export function referenceInChat(
  ctx: Context,
  sessionId: string,
  cwd: string | undefined,
  path: string,
  isDir: boolean,
): void {
  const rel = relativeTo(cwd ?? '', path)
  if (isDir) {
    // The folder mention stays plain text so DSH's own decoration and
    // completion keep working; `appendToDraft` keeps it off the whole-draft
    // write while the draft holds a reference chip.
    appendToDraft(ctx, sessionId, `@${rel === '.' ? './' : `${rel}/`}`)
    return
  }
  if (!insertFileReference(ctx, sessionId, rel)) {
    appendToDraft(ctx, sessionId, `@${rel}`)
  }
}
