/**
 * The explorer's context-menu "add to conversation": append one row's
 * absolute path to the conversation draft of the session that owns the tree.
 *
 * Plain text, never a reference chip. DSH's `@` grammar is workspace-root
 * relative (#479), so an absolute path cannot mint a chip the host would
 * resolve — and since v0.23.0 the tree also shows paths outside the
 * workspace, where no workspace-relative spelling exists at all. The absolute
 * path is exactly what an agent tool can read back, and plain text keeps it
 * editable in the composer.
 *
 * The append itself rides the same shared channel as the `@` button and the
 * viewer selection popup (`appendToDraft`): `setDraft` on a chipless draft,
 * the host's span event on a draft that already carries chips. A missing
 * conversation service or session scope degrades to a logged no-op.
 */
import type { Context } from '../context-types.ts'
import { appendToDraft } from './conversation-draft.ts'

/**
 * Append one absolute path to a session's composer draft.
 * @param ctx - the client context.
 * @param sessionId - the session whose draft receives the path.
 * @param path - the row's absolute path (file or directory).
 * @returns whether the host accepted the insert.
 */
export function appendPathToConversation(ctx: Context, sessionId: string, path: string): boolean {
  return appendToDraft(ctx, sessionId, path)
}