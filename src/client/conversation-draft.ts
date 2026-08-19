/**
 * Append text to the current session's composer draft through the
 * conversation service — the shared path behind the explorer's @-reference
 * button and the viewer selection popup. The service is resolved lazily
 * through `ctx.get` (the inject-free read the app's own plugins use); a
 * missing service or scope degrades to a logged no-op, never a crash.
 */
import type { Context, SidebarConversation } from '../context-types.ts'

/**
 * Focus the active conversation's composer textarea with the caret at the
 * end. The composer commits the draft on its next render, so the caret is
 * placed once via rAF and once via a late fallback — whichever runs after
 * the textarea's value has caught up.
 */
function focusComposer(): void {
  try {
    const input = document.querySelector<HTMLTextAreaElement>('[data-composer-seat] textarea')
    if (input === null) return
    input.focus({ preventScroll: true })
    const placeCaret = (): void => {
      try {
        input.setSelectionRange(input.value.length, input.value.length)
      } catch {
        /* read-only surface */
      }
    }
    requestAnimationFrame(placeCaret)
    setTimeout(placeCaret, 80)
  } catch {
    /* composer unavailable */
  }
}

/**
 * Append `text` to the session's composer draft (space-separated, like the
 * @-mentions), then focus the composer so the user can continue typing or
 * submit right away. Returns false — and logs — when the conversation
 * service or the session scope is unavailable.
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
    focusComposer()
    return true
  } catch (error) {
    console.warn('[dsh-better-sidebar] draft insert failed:', error)
    return false
  }
}
