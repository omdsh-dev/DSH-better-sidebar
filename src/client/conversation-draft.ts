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
 *
 * Two coordinate systems (see {@link foldClipboardOffset}). `draft` is the
 * *clipboard* projection, where a chip occupies its whole `clipboardText`; the
 * host's insert/replace spans live in the *editor* projection, where a chip
 * occupies one placeholder character. The two coincide only while the draft
 * holds no chip, so a span built from raw `draft` offsets is accepted for the
 * first insert and refused for every one after it — every emitted span folds
 * first.
 *
 * No draft write may destroy a chip: `setDraft` rebuilds the editor from
 * plain paragraphs, so {@link appendToDraft} splices through the host's text
 * event instead as soon as the draft holds one ({@link insertPlainText}).
 */
import type {
  Context,
  SidebarConversation,
  SidebarSessionInput,
  SidebarSessionOccurrence,
} from '../context-types.ts'
import type { SelectionInsert } from './selection-payload.ts'

/** A resolved composer caret/selection in draft coordinates. */
export interface DraftCaret {
  start: number
  end: number
}

/**
 * One reference chip's footprint in the draft (the host's `Occurrence`).
 * `length` is the whole `clipboardText`, which is what makes the two
 * projections diverge.
 */
export type DraftOccurrence = SidebarSessionOccurrence

/** The subset of the host's input snapshot the insert paths read. */
type DraftSnapshot = ReturnType<SidebarSessionInput['state']['getSnapshot']>

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
    // text and takes one separating space.
    if (draft.trim() === '') return { draft: text, inserted: text, caretAfter: text.length }
    // The draft's own tail is a neighbor like any other: a chip insert leaves
    // the host's separating space there, and adding a second one would widen
    // the gap to two. (The resolved-caret branch below has always been
    // whitespace-aware; this one was not.)
    const left = /\s$/.test(draft) ? '' : ' '
    const inserted = `${left}${text}`
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
 * Fold a draft (clipboard-projection) offset onto the editor projection the
 * host's insert/replace spans are expressed in. The two projections differ in
 * exactly one place: a chip contributes its whole `clipboardText` to the
 * draft but a single placeholder character to the editor, so every chip ahead
 * of the offset collapses `length - 1` characters, and an offset landing
 * strictly *inside* a chip's expansion snaps to that chip's trailing edge —
 * the host can only address a chip as a whole, never split it.
 *
 * The host folds the same way internally (`detectOffsetOfClipboardOffset` in
 * `dsh-client-ui-conversation`), but keeps it off the plugin-facing surface;
 * the published `InputState.occurrences` is the sanctioned input. One
 * deliberate difference: the host's loop reads a chip that *starts* at the
 * offset as "inside" and answers its trailing edge, while this one treats the
 * start as a boundary and answers the position *before* the chip — the true
 * document position, and one its own caret resolver can address.
 *
 * `occurrences` is sorted by offset (host guarantee) and absent on hosts
 * without the chip channel, where the fold is the identity.
 */
export function foldClipboardOffset(
  offset: number,
  occurrences: readonly DraftOccurrence[] | undefined,
): number {
  let shift = 0
  if (occurrences !== undefined) {
    for (const occurrence of occurrences) {
      const end = occurrence.offset + occurrence.length
      if (offset > end) {
        shift += occurrence.length - 1
        continue
      }
      if (offset > occurrence.offset) {
        // Strictly inside the chip's expansion, or exactly at its trailing
        // edge: snap to that edge (the host addresses a chip as a whole).
        return Math.max(0, end - shift - (occurrence.length - 1))
      }
      break
    }
  }
  return Math.max(0, offset - shift)
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
 *
 * The write path depends on what the draft already holds: a chipless draft
 * takes the whole-string `setDraft`, while a draft holding chips is spliced
 * through the host's text event ({@link insertPlainText}) — `setDraft`
 * rebuilds the editor from plain text and would destroy every chip in it.
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
    const before = input.state.getSnapshot()
    // Mirrors the host's own admission rule for reference inserts (`plain |
    // claimed` only): a frozen composer takes no draft write on either path —
    // its text event carries no such guard, and a phase this build has never
    // heard of is not writable either.
    const phase = before.phase
    if (phase !== undefined && phase !== 'plain' && phase !== 'claimed') {
      console.warn('[dsh-better-sidebar] draft insert skipped: composer is', phase)
      return false
    }
    const caret = probeComposerCaret(before.draft)
    const { draft: next, inserted, caretAfter } = spliceInsert(before.draft, text, caret)
    if (before.occurrences !== undefined && before.occurrences.length > 0) {
      // A chip-bearing draft never goes through `setDraft`: it clears the
      // document and rebuilds plain paragraphs, taking every chip with it.
      // The text event splices the very same characters instead.
      return insertPlainText(actx, input, before, caret, inserted)
    }
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
 * Private-use placeholders the host renders as reference chips: a literal one
 * inside a *text* node forges a chip position. `setDraft` strips them; the
 * text event does not, so the splice does it here.
 */
const REFERENCE_PLACEHOLDER_RE = /[\uE100-\uE11D\uFFFC]/gu

/** The one character a reference chip occupies in the editor projection. */
export const CHIP_PLACEHOLDER = '\uFFFC'

/**
 * Matches {@link CHIP_PLACEHOLDER}. A literal one inside a chip's own
 * `clipboardText` would sit in a text node and forge a chip position, throwing
 * off every span folded against `occurrences` afterwards. The chip's `ref`
 * never enters the editor, so the model still receives the payload verbatim.
 */
const CHIP_PLACEHOLDER_RE = /\uFFFC/gu

/**
 * Splice `text` into a chip-bearing draft through the host's plain-text event
 * rather than `setDraft`. `text` is what {@link spliceInsert} put between the
 * surrounding draft text, so the resulting draft string is the exact one
 * `setDraft` would have written — the chips just survive it.
 *
 * Unlike `setDraft`, the host's text event does not sanitize the reference
 * placeholders, so the splice does.
 */
function insertPlainText(
  actx: Context,
  input: SidebarSessionInput,
  before: DraftSnapshot,
  caret: DraftCaret | null,
  text: string,
): boolean {
  return bailComposerEdit(actx, input, before, caret, 'slash/input-insert-text', {
    text: text.replace(REFERENCE_PLACEHOLDER_RE, ''),
  })
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
 * The scoped event dispatcher, as this module reaches it: the Context's typed
 * `bail` is keyed to DSH's closed event map, while these internal composer
 * events are deliberately string-loose at runtime.
 *
 * `subject` is the session-scope Context, passed back as the dispatch subject:
 * cordis applies a scope's listener filter only when the first argument is an
 * object, and without it the event reaches *every* mounted session's input
 * shell — whose revision counters all start at 0, so the span CAS alone would
 * not keep one session's insert out of another's composer.
 */
interface ComposerDispatch {
  bail(subject: Context, name: string, payload: unknown): unknown
}

/**
 * Dispatch one composer edit and report whether the machine applied it.
 * `caret` is in *draft* coordinates — the live caret/selection the edit
 * replaces, or null to append at the end — and is folded onto the editor
 * projection the host's span CAS lives in (see {@link foldClipboardOffset}).
 *
 * `before` is the snapshot the caller measured that caret against: one read
 * per gesture keeps the span's coordinates and its `draftRev` on the same
 * revision. `input` is only read again for the after-snapshot.
 */
function bailComposerEdit(
  actx: Context,
  input: SidebarSessionInput,
  before: DraftSnapshot,
  caret: DraftCaret | null,
  event: string,
  body: Record<string, unknown>,
): boolean {
  if (before.draftRev === undefined) return false
  const at = caret ?? { start: before.draft.length, end: before.draft.length }
  const answer = (actx as unknown as ComposerDispatch).bail(actx, event, {
    ...body,
    span: {
      draftRev: before.draftRev,
      start: foldClipboardOffset(at.start, before.occurrences),
      end: foldClipboardOffset(at.end, before.occurrences),
    },
  })
  const after = input.state.getSnapshot()
  // Either signal alone proves the edit landed; accepting both leaves no room
  // for a false "refused".
  return answer === true || after.draftRev !== before.draftRev
}

/**
 * Emit the composer's structured-reference insert for one chip (the machine
 * mints one chip node covering `chip.clipboardText`, followed by its own
 * separating space).
 */
function emitChip(
  actx: Context,
  input: SidebarSessionInput,
  chip: ChipReference,
  caret: DraftCaret | null,
  before: DraftSnapshot,
): boolean {
  return bailComposerEdit(actx, input, before, caret, 'slash/input-insert-reference', {
    reference: { source: 'reference', ...chip },
  })
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
    const before = target.input.state.getSnapshot()
    const chip: ChipReference = {
      label: reference.label,
      appearance: 'file',
      clipboardText: reference.mention,
      ref: reference.mention,
    }
    return emitChip(target.actx, target.input, chip, null, before)
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
    const before = target.input.state.getSnapshot()
    const caret = probeComposerCaret(before.draft)
    const text = chipTextAt(before.draft, insert.text, caret)
    const chip: ChipReference = {
      label: insert.label,
      appearance: 'file',
      // The editor-facing text must never carry a literal chip placeholder;
      // the model form keeps the payload exactly as selected.
      clipboardText: text.replace(CHIP_PLACEHOLDER_RE, ''),
      ref: text,
    }
    return emitChip(target.actx, target.input, chip, caret, before)
  } catch (error) {
    console.warn('[dsh-better-sidebar] selection-reference insert failed:', error)
    return false
  }
}
