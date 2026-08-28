/**
 * Insert text into the current session's composer draft through the
 * conversation service — the shared path behind the explorer's @-reference
 * button and the viewer selection popup. Prefers the caret position of the
 * live composer textarea (the native @-mention pick path: splice over a
 * draftRev-CAS'd span); every miss — no composer textarea in the DOM, a
 * shell without the verb (older DSH), or a stale draft revision — falls
 * back to the space-separated append. The service is resolved lazily
 * through `ctx.get` (the inject-free read the app's own plugins use); a
 * missing service or scope degrades to a logged no-op, never a crash.
 */
import type { Context, SidebarConversation, SidebarSessionInput } from '../context-types.ts'

/**
 * Splice `text` at the composer textarea's caret. Returns false — leaving
 * the append fallback to the caller — whenever the caret cannot be trusted.
 */
function insertAtCaret(
  input: SidebarSessionInput,
  snapshot: { draft: string; draftRev?: number },
  text: string,
): boolean {
  // The verb lives on the per-session shell, not the published SessionInput
  // contract — duck-typed so an older DSH degrades to the append path.
  if (typeof input.insertText !== 'function') return false
  if (snapshot.draftRev === undefined) return false
  // The caret exists only in the DOM: the composer textarea is the single
  // textarea carrying the input machine's data-phase attribute.
  const el = document.querySelector<HTMLTextAreaElement>('textarea[data-phase]')
  if (el === null) return false
  // The DOM draft must match the machine snapshot: a different session's
  // composer (or a mid-flight re-render) makes the DOM caret meaningless.
  if (el.value !== snapshot.draft) return false
  const draft = snapshot.draft
  const start = el.selectionStart ?? draft.length
  const end = el.selectionEnd ?? start
  if (start < 0 || end < start || end > draft.length) return false
  // Space-separation exactly where the neighbours would otherwise glue.
  const prefix = start > 0 && !/\s/u.test(draft[start - 1] ?? '') ? ' ' : ''
  const suffix = end < draft.length && !/\s/u.test(draft[end] ?? '') ? ' ' : ''
  const inserted = `${prefix}${text}${suffix}`
  if (!input.insertText(inserted, { start, end, draftRev: snapshot.draftRev })) return false
  // The controlled re-render resets the DOM caret; put it after the splice
  // (the same rAF shape the composer's own restoreCaret uses) and hand
  // focus back so typing continues where the reference landed.
  const caret = start + inserted.length
  requestAnimationFrame(() => {
    try {
      el.focus({ preventScroll: true })
      el.setSelectionRange(caret, caret)
    } catch {
      // A disposed textarea has nothing to restore.
    }
  })
  return true
}

/**
 * Insert `text` into the session's composer draft at the caret (the native
 * @-mention shape), appending at the end as the fallback. Returns false —
 * and logs — when the conversation service or the session scope is
 * unavailable.
 */
export function appendToDraft(ctx: Context, sessionId: string, text: string): boolean {
  try {
    const actx = ctx.sessions.scope(sessionId)
    if (actx === undefined) return false
    const conversation = ctx.get('conversation') as SidebarConversation | undefined
    if (conversation === undefined) return false
    const input = conversation.input.for(actx)
    if (insertAtCaret(input, input.state.getSnapshot(), text)) return true
    // Re-read before appending: a failed CAS means the snapshot we hold is
    // stale, and writing it back would swallow a concurrent draft edit
    // (an autocomplete splice racing this click).
    const draft = input.state.getSnapshot().draft
    input.setDraft(draft.trim() === '' ? text : `${draft} ${text}`)
    return true
  } catch (error) {
    console.warn('[dsh-better-sidebar] draft insert failed:', error)
    return false
  }
}
