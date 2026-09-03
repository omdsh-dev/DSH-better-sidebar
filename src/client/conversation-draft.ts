/**
 * Insert text into the current session's composer draft through the
 * conversation service — the shared path behind the explorer's @-reference
 * button and the viewer selection popup. The service is resolved lazily
 * through `ctx.get` (the inject-free read the app's own plugins use); a
 * missing service or scope degrades to a logged no-op, never a crash.
 *
 * File references additionally use DSH's own structured insert event
 * (`slash/input-insert-reference`, see `insertFileReference`) instead of
 * plain draft text: the native `@file` picker emits this event, and the
 * conversation input machine mints one occurrence whose chip covers the
 * whole reference. Plain text `@folder/file.ts` only ever gets DSH's
 * folder-ref decoration (`@folder/`) — the file name stays undecorated — so
 * plain append is the fallback, not the primary path, for files.
 *
 * Insert position (fixes upstream issue #425): the draft store only exposes
 * the whole string (`getSnapshot().draft` + `setDraft(text)`) — there is no
 * caret API on the conversation service. The composer's `<textarea>` keeps
 * its last selection even while unfocused, so the live caret is probed from
 * the DOM (guarded by a value-sync check), and the text is spliced at that
 * position, replacing any live selection — with whitespace-aware joins, an
 * insert into the middle of a sentence keeps single-space separation like
 * the append path. An unknown/stale caret falls back to appending at the
 * end (the pre-fix behavior).
 *
 * The caret is also *restored* after the insert: committing a programmatic
 * draft change resets the controlled textarea's caret (observed landing at
 * the start of the value), which would make every later insert probe the
 * reset position and drift the stack (A|B + C + D ended up as |DACB). The
 * placement (`placeComposerCaretAfterInsert`) puts the caret right after the
 * inserted text once the value commit lands — the index accounts for the
 * separating space on the left, so stacked inserts stay at their running
 * position (A|B + C + D → ACD|B).
 */
import type { Context, SidebarConversation } from '../context-types.ts'

/** A resolved composer caret/selection in draft coordinates. */
export interface DraftCaret {
  start: number
  end: number
}

/**
 * The spliced draft plus the caret index (in that draft) right after the
 * inserted text — the left-side separating space shifts the caret by one,
 * which naive `start + text.length` misses (it would land before the tail).
 */
interface SpliceResult {
  draft: string
  caretAfter: number
}

/**
 * Splice `text` into `draft` at `caret` (replacing any live selection) with
 * whitespace-aware joins and report the caret position right after the
 * inserted text. `caret === null` (position unknown) appends at the end,
 * exactly like the original behavior.
 */
function spliceInsert(draft: string, text: string, caret: DraftCaret | null): SpliceResult {
  if (caret === null || draft === '') {
    const next = draft.trim() === '' ? text : `${draft} ${text}`
    return { draft: next, caretAfter: next.length }
  }
  const prefix = draft.slice(0, caret.start)
  const suffix = draft.slice(caret.end)
  if (prefix === '' && suffix === '') return { draft: text, caretAfter: text.length }
  // One separating space, but never doubled against adjacent whitespace
  // (or the string edges) — mirrors how typing in the middle of a sentence
  // behaves.
  const left = prefix === '' || /\s$/.test(prefix) ? '' : ' '
  const right = suffix === '' || /^\s/.test(suffix) ? '' : ' '
  return {
    draft: `${prefix}${left}${text}${right}${suffix}`,
    caretAfter: prefix.length + left.length + text.length,
  }
}

/**
 * The spliced draft string (see {@link spliceInsert}); pure string math —
 * unit-tested directly.
 */
export function insertAtCaret(draft: string, text: string, caret: DraftCaret | null): string {
  return spliceInsert(draft, text, caret).draft
}

/**
 * Locate the composer `<textarea>` in the conversation column: prefer the
 * `data-phase`-tagged textarea (the composer's marker), falling back to any
 * textarea in the column, then to a bare data-phase textarea (older host
 * layouts without the column attribute). Null in jsdom-less hosts.
 */
function findComposerTextarea(): HTMLTextAreaElement | null {
  if (typeof document === 'undefined') return null
  const column = document.querySelector('#root [data-slot="conversation"]')
  const find = (scope: ParentNode): HTMLTextAreaElement | null =>
    scope.querySelector('textarea[data-phase]') ?? scope.querySelector('textarea')
  return column !== null
    ? find(column)
    : document.querySelector<HTMLTextAreaElement>('textarea[data-phase]')
}

/**
 * Resolve the composer's live caret from its DOM `<textarea>`. The draft
 * store has no caret API, so the sidebar reads the composed input's selection
 * directly; the value-sync check (`el.value === draft`) discards stale or
 * wrong-composer reads — a caret must never be applied against a draft it
 * was not measured on.
 *
 * Returns null when the composer is missing, disabled/read-only, out of
 * sync with the store draft, or has no measurable selection (jsdom/odd
 * hosts report null selectionStart/End).
 */
export function probeComposerCaret(draft: string): DraftCaret | null {
  const el = findComposerTextarea()
  if (el === null || el.disabled || el.readOnly) return null
  if (el.value !== draft) return null
  let start = el.selectionStart
  let end = el.selectionEnd
  if (typeof start !== 'number' || typeof end !== 'number') return null
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  start = Math.max(0, Math.min(start, draft.length))
  end = Math.max(start, Math.min(end, draft.length))
  return { start, end }
}

/**
 * Restore the composer caret to `caretIndex` after a programmatic
 * `setDraft` commit. A controlled textarea update resets the caret (React
 * commits the value asynchronously and the browser moves the caret to the
 * start/end), so the placement is scheduled and retried across at most two
 * animation frames (setTimeout fallback for jsdom), and only applied when
 * the textarea still matches `expectedDraft` — a newer edit or a different
 * composer wins the race untouched. The caret is clamped into the value
 * bounds, mirroring how browsers clamp type-in positions.
 */
export function placeComposerCaretAfterInsert(expectedDraft: string, caretIndex: number): void {
  let remaining = 2
  let scheduled = false
  const schedule = (fn: () => void): void => {
    if (scheduled) return
    scheduled = true
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn)
    else setTimeout(fn, 0)
  }
  const place = (): void => {
    scheduled = false
    if (remaining <= 0) return
    remaining -= 1
    const el = findComposerTextarea()
    if (el === null || el.disabled || el.readOnly) return
    if (el.value !== expectedDraft) {
      // The commit has not landed yet (or a competing edit won) — one more
      // frame before giving up.
      schedule(place)
      return
    }
    const clamped = Math.max(0, Math.min(caretIndex, el.value.length))
    el.setSelectionRange(clamped, clamped)
  }
  schedule(place)
}

/**
 * Insert `text` into the session's composer draft at the composer's live
 * caret (see {@link probeComposerCaret}), falling back to appending at the
 * end when the caret cannot be resolved. Returns false — and logs — when the
 * conversation service or the session scope is unavailable.
 */
export function appendToDraft(ctx: Context, sessionId: string, text: string): boolean {
  try {
    const actx = ctx.sessions.scope(sessionId)
    if (actx === undefined) {
      console.warn('[dsh-better-sidebar] draft insert skipped: no session scope', sessionId)
      return false
    }
    const conversation = ctx.get('conversation') as SidebarConversation | undefined
    if (conversation === undefined) {
      console.warn('[dsh-better-sidebar] draft insert skipped: conversation service unavailable')
      return false
    }
    const input = conversation.input.for(actx)
    const draft = input.state.getSnapshot().draft
    const caret = probeComposerCaret(draft)
    const { draft: next, caretAfter } = spliceInsert(draft, text, caret)
    input.setDraft(next)
    // Put the caret right after the inserted text once the value commit
    // lands — see the module doc for why this keeps stacked inserts at the
    // running position.
    placeComposerCaretAfterInsert(next, caretAfter)
    return true
  } catch (error) {
    console.warn('[dsh-better-sidebar] draft insert failed:', error)
    return false
  }
}

/**
 * The DSH `@file` spelling for one relative path, mirroring the host grammar
 * (`formatFileMention` in `@deepseek-ai/dsh-file-reference`): plain when
 * there is no whitespace, quoted when there is, and `undefined` when the
 * path contains a control character or an embedded quote the editor grammar
 * cannot represent.
 */
export function fileMention(relativePath: string): { mention: string; label: string } | undefined {
  const path = relativePath.replace(/[\\/]+$/, '')
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined
  const mention = /\s/u.test(path) ? `@"${path}"` : `@${path}`
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const label = at === -1 ? path : path.slice(at + 1)
  return { mention, label }
}

/**
 * Insert one FILE reference as a structured chip (like DSH's own `@` picker).
 * The chip displays `@<basename>` but serializes to `@<relative path>` on
 * send, so the reference stays a single link from trigger to basename.
 *
 * Directories are NOT handled here: DSH's folder grammar wants the trailing
 * slash as plain text (`@dir/`) so completion can descend, which
 * `appendToDraft` already covers.
 */
export function insertFileReference(ctx: Context, sessionId: string, relativePath: string): boolean {
  const reference = fileMention(relativePath)
  if (reference === undefined) return false
  try {
    const actx = ctx.sessions.scope(sessionId)
    if (actx === undefined) return false
    const conversation = ctx.get('conversation') as SidebarConversation | undefined
    if (conversation === undefined) return false
    const input = conversation.input.for(actx)
    const before = input.state.getSnapshot()
    if (before.draftRev === undefined) return false
    // The session-scope Context's typed `emit` is keyed to DSH's closed event
    // map; this internal composer event is deliberately string-loose at runtime.
    ;(actx as unknown as { emit(name: string, payload: unknown): void }).emit('slash/input-insert-reference', {
      reference: {
        source: 'reference',
        ref: reference.mention,
        label: reference.label,
        appearance: 'file',
        clipboardText: reference.mention,
      },
      span: {
        draftRev: before.draftRev,
        start: before.draft.length,
        end: before.draft.length,
      },
    })
    const after = input.state.getSnapshot()
    return after.draftRev !== before.draftRev
  } catch (error) {
    console.warn('[dsh-better-sidebar] file-reference insert failed:', error)
    return false
  }
}
