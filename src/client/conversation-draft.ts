/**
 * Append text to the current session's composer draft through the
 * conversation service — the shared path behind the explorer's @-reference
 * button and the viewer selection popup. The service is resolved lazily
 * through `ctx.get` (the inject-free read the app's own plugins use); a
 * missing service or scope degrades to a logged no-op, never a crash.
 */
import type { Context, SidebarConversation } from '../context-types.ts'

/**
 * Append `text` to the session's composer draft (space-separated, like the
 * @-mentions). Returns false — and logs — when the conversation service or
 * the session scope is unavailable.
 */
export function appendToDraft(ctx: Context, sessionId: string, text: string): boolean {
  try {
    const actx = ctx.sessions.scope(sessionId)
    if (actx === undefined) return false
    const conversation = ctx.get('conversation') as SidebarConversation | undefined
    if (conversation === undefined) return false
    const input = conversation.input.for(actx)
    const draft = input.state.getSnapshot().draft
    input.setDraft(draft.trim() === '' ? text : `${draft} ${text}`)
    return true
  } catch (error) {
    console.warn('[dsh-better-sidebar] draft insert failed:', error)
    return false
  }
}

/**
 * Send one prompt directly to a session through the conversation service.
 * The service is resolved from the session scope because conversation.send
 * is scope-addressed; unlike draft insertion, the target is not an explicit
 * method argument on the service itself.
 */
export async function sendToConversation(ctx: Context, sessionId: string, text: string): Promise<void> {
  const actx = ctx.sessions.scope(sessionId)
  if (actx === undefined) throw new Error(`conversation session is unavailable: ${sessionId}`)
  const conversation = actx.get('conversation') as SidebarConversation | undefined
  if (conversation === undefined) throw new Error('conversation service is unavailable')
  await conversation.send(text)
}
