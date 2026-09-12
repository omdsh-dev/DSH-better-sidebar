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
 * The viewer selection popup commits a chip the same way
 * ({@link insertSelectionReference}): the composer shows one compact
 * `<path>[:lines]` chip instead of a quoted block, while the chip's model
 * form stays the fenced payload, so nothing is lost on send.
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
 *
 * Chip inserts (`insertFileReference` / `insertSelectionReference`) get the
 * caret from the same probe, but as the span they replace: the host's insert
 * event is span-CAS'd and owns the caret afterwards, so no DOM restore is
 * scheduled for them.
 */
import type { Context, SidebarConversation, SidebarSessionInput } from '../context-types.ts'
import type { SelectionInsert } from './selection-payload.ts'

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
  /** Exactly what the splice put between the surrounding draft text. */
  inserted: string
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
    // A whitespace-only draft is dropped outright; anything else keeps its
    // text and takes one separating space (nothing on the right to double).
    if (draft.trim() === '') return { draft: text, inserted: text, caretAfter: text.length }
    const inserted = ` ${text}`
    return { draft: `${draft}${inserted}`, inserted, caretAfter: draft.length + inserted.length }
  }
  const prefix = draft.slice(0, caret.start)
  const suffix = draft.slice(caret.end)
  if (prefix === '' && suffix === '') return { draft: text, inserted: text, caretAfter: text.length }
  // One separating space, but never doubled against adjacent whitespace
  // (or the string edges) — mirrors how typing in the middle of a sentence
  // behaves.
  const left = prefix === '' || /\s$/.test(prefix) ? '' : ' '
  const right = suffix === '' || /^\s/.test(suffix) ? '' : ' '
  const inserted = `${left}${text}${right}`
  return {
    draft: `${prefix}${inserted}${suffix}`,
    inserted,
    // The caret lands right after the inserted text: past the left separating
    // space, but before the right one, so a following insert stacks adjacent
    // to the text instead of across the gap.
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
 * The chip's own draft text for one payload: the payload plus the join spaces
 * {@link spliceInsert} would add at that caret. Taking it straight from the
 * splice — instead of restating the whitespace rules — is what keeps the
 * resulting draft, and therefore the submitted prompt, identical to the
 * plain-text insert the selection popup committed before chips.
 */
export function chipTextAt(draft: string, payload: string, caret: DraftCaret | null): string {
  return spliceInsert(draft, payload, caret).inserted
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
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point of this guard
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined
  const mention = /\s/u.test(path) ? `@"${path}"` : `@${path}`
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const label = at === -1 ? path : path.slice(at + 1)
  return { mention, label }
}

/** One structured chip, as the composer's insert event spells it. */
interface ChipReference {
  /** Inline label the chip renders. */
  label: string
  /** Domain glyph family (the host's own icon set). */
  appearance: 'file' | 'folder' | 'session'
  /** The chip's own text where it sits in the draft (native copy reads it). */
  clipboardText: string
  /** Owner-scoped reference id: the model form the chip serializes to. */
  ref: string
}

/**
 * Resolve one session's composer input face through the two lazily fetched
 * services (the `inject`-free reads the app's own plugins use). Null when
 * either is unavailable — every caller degrades to a no-op.
 */
function composerInput(
  ctx: Context,
  sessionId: string,
): { actx: Context; input: SidebarSessionInput } | null {
  const actx = ctx.sessions.scope(sessionId)
  if (actx === undefined) return null
  const conversation = ctx.get('conversation') as SidebarConversation | undefined
  if (conversation === undefined) return null
  return { actx, input: conversation.input.for(actx) }
}

/**
 * Emit the composer's structured-reference insert for one chip and report
 * whether the machine applied it (the span CAS answer). `caret` is in draft
 * coordinates: the live caret/selection the chip replaces, or null to append
 * at the end (the placement the explorer's @ button has always used).
 */
function emitChip(
  actx: Context,
  input: SidebarSessionInput,
  chip: ChipReference,
  caret: DraftCaret | null,
): boolean {
  const before = input.state.getSnapshot()
  if (before.draftRev === undefined) return false
  const at = caret ?? { start: before.draft.length, end: before.draft.length }
  // The session-scope Context's typed `emit` is keyed to DSH's closed event
  // map; this internal composer event is deliberately string-loose at runtime.
  ;(actx as unknown as { emit(name: string, payload: unknown): void }).emit('slash/input-insert-reference', {
    reference: { source: 'reference', ...chip },
    span: { draftRev: before.draftRev, start: at.start, end: at.end },
  })
  const after = input.state.getSnapshot()
  return after.draftRev !== before.draftRev
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
    const target = composerInput(ctx, sessionId)
    if (target === null) return false
    const chip: ChipReference = {
      label: reference.label,
      appearance: 'file',
      clipboardText: reference.mention,
      ref: reference.mention,
    }
    return emitChip(target.actx, target.input, chip, null)
  } catch (error) {
    console.warn('[dsh-better-sidebar] file-reference insert failed:', error)
    return false
  }
}

/**
 * Insert one text selection as a structured chip labelled `<path>[:lines]`.
 * The chip is all the composer shows; its `ref` carries the fenced payload,
 * so the model still receives the selected text verbatim (the `reference`
 * source's serializer is the identity) and the draft keeps one line per
 * reference instead of a pasted quote.
 *
 * Placement follows upstream #425: the chip replaces the composer's live
 * caret/selection when the probe resolves one, and appends at the end
 * otherwise. Its own text carries the same whitespace-aware joins the
 * plain-text path adds, so the draft string — and the prompt built from it —
 * is what `buildSelectionInsert` produced before the chip.
 */
export function insertSelectionReference(
  ctx: Context,
  sessionId: string,
  insert: SelectionInsert,
): boolean {
  try {
    const target = composerInput(ctx, sessionId)
    if (target === null) return false
    const draft = target.input.state.getSnapshot().draft
    const caret = probeComposerCaret(draft)
    const text = chipTextAt(draft, insert.text, caret)
    const chip: ChipReference = {
      label: insert.label,
      appearance: 'file',
      clipboardText: text,
      ref: text,
    }
    return emitChip(target.actx, target.input, chip, caret)
  } catch (error) {
    console.warn('[dsh-better-sidebar] selection-reference insert failed:', error)
    return false
  }
}
