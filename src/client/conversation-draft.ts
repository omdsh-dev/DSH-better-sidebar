/**
 * Insert text into the current session's composer draft through the
 * conversation service — the shared path behind the explorer's @-reference
 * button and the viewer selection popup. The service is resolved lazily
 * through `ctx.get` (the inject-free read the app's own plugins use); a
 * missing service or scope degrades to a logged no-op, never a crash.
 *
 * **Inserts never go through `setDraft`.** `setDraft(text)` is DSH's
 * whole-draft replacement: its documented contract is "replace the whole
 * draft with plain text, **removing inline reference chips**"
 * (`SessionInput.setDraft` in `@deepseek-ai/dsh-client-ui-conversation` — it
 * clears the editor root and re-appends the string), so every chip already in
 * the draft degrades to its clipboard text (`@dir/file.ts`) and loses its
 * reference identity; DSH's plain-text scan then decorates only the folder
 * prefix and the mention reads as two pieces. That was this module's own bug:
 * one folder insert (or one file insert's fallback) flattened every earlier
 * `@` pick. Both kinds now ride DSH's scoped composer events, which mutate the
 * live document instead:
 *
 * - `slash/input-insert-reference` — one chip (`clipboardText` = the mention),
 *   the exact event the native `@` picker emits (see `insertFileReference`);
 * - `slash/input-insert-text` — plain text over a span, the event behind the
 *   host's own folder-drill action; a plain `@dir/` token's chip look is then
 *   DSH's scan-derived decoration, as designed.
 *
 * **Spans are detect coordinates.** A `TokenSpan` addresses DSH's detect
 * projection, where every chip is exactly one character (U+FFFC), while
 * `InputState.draft` is the clipboard projection (chips expanded to mention
 * text). Handing the host a clipboard offset where it expects a detect offset
 * is silently rejected (`selectSpan` refuses an end past the detect length),
 * which is how a draft holding a single chip made every later insert fail and
 * fall back to the destructive path. {@link clipboardToDetect} /
 * {@link detectLength} fold one projection into the other from
 * `InputState.occurrences`.
 *
 * Insert position (upstream issue #425): the draft store exposes no caret API,
 * so the composer's own DOM is still probed ({@link probeComposerCaret}). The
 * 0.1.7+ composer is a Lexical contenteditable rather than a `<textarea>`, so
 * that probe answers null there and the insert appends at the draft end — and
 * DSH puts the caret after whatever it inserted, so no DOM caret restoration
 * of our own is needed (or wanted).
 */
import type { Context, SidebarConversation, SidebarSessionInput } from '../context-types.ts'
import { baseName, workspaceRelativePath } from './paths.ts'

/** A resolved composer caret/selection in draft coordinates. */
export interface DraftCaret {
  start: number
  end: number
}

/**
 * One reference occurrence in the clipboard projection
 * (`InputState.occurrences`): where a chip's mention text sits in the draft
 * string. Occurrences arrive ordered and non-overlapping.
 */
export interface DraftOccurrence {
  readonly offset: number
  readonly length: number
}

/** One insertion resolved against the clipboard draft, before projection folding. */
interface PlannedInsert {
  /** Text handed to the host; a range insert replaces the span with exactly this. */
  text: string
  /** Clipboard-coordinate range the insert covers (collapsed for a plain caret). */
  start: number
  end: number
}

/**
 * The detect-projection length of a clipboard draft: every chip collapses to
 * one character, so each occurrence contributes `length - 1` fewer characters.
 * This is the offset space every `TokenSpan` is expressed in.
 */
export function detectLength(draft: string, occurrences: readonly DraftOccurrence[]): number {
  let length = draft.length
  for (const occurrence of occurrences) length -= occurrence.length - 1
  return length
}

/**
 * Fold one clipboard-projection offset into detect coordinates. An offset
 * strictly inside a chip's expansion cannot be addressed by the detect
 * projection at all (the chip is atomic there), so it snaps to the position
 * just before that chip — a plain caret never lands there, only a selection
 * spanning chip text could.
 */
export function clipboardToDetect(occurrences: readonly DraftOccurrence[], offset: number): number {
  let detect = offset
  for (const occurrence of occurrences) {
    if (offset <= occurrence.offset) break
    const end = occurrence.offset + occurrence.length
    if (offset < end) {
      detect -= offset - occurrence.offset
      break
    }
    detect -= occurrence.length - 1
  }
  return detect
}

/**
 * Resolve where `text` lands and what exactly the host receives, with the
 * whitespace-aware joins of {@link insertAtCaret}: one separating space per
 * side, never doubled against neighbouring whitespace or the string edges.
 * `caret === null` (position unknown) appends at the end, and a
 * whitespace-only draft is replaced rather than indented — both the pre-fix
 * behavior.
 */
function planInsert(draft: string, text: string, caret: DraftCaret | null): PlannedInsert {
  if (caret === null) {
    return draft.trim() === ''
      ? { text, start: 0, end: draft.length }
      : { text: `${/\s$/.test(draft) ? '' : ' '}${text}`, start: draft.length, end: draft.length }
  }
  const prefix = draft.slice(0, caret.start)
  const suffix = draft.slice(caret.end)
  if (prefix === '' && suffix === '') return { text, start: caret.start, end: caret.end }
  const left = prefix === '' || /\s$/.test(prefix) ? '' : ' '
  const right = suffix === '' || /^\s/.test(suffix) || /\s$/.test(text) ? '' : ' '
  return { text: `${left}${text}${right}`, start: caret.start, end: caret.end }
}

/**
 * The spliced draft string (see {@link planInsert}); pure string math —
 * unit-tested directly.
 */
export function insertAtCaret(draft: string, text: string, caret: DraftCaret | null): string {
  const plan = planInsert(draft, text, caret)
  return `${draft.slice(0, plan.start)}${plan.text}${draft.slice(plan.end)}`
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
 * Emit one scoped composer event on the session scope. The session-scope
 * Context's typed `emit` is keyed to DSH's closed event map; these internal
 * composer events are deliberately string-loose at runtime.
 */
function emitComposerEvent(actx: object, name: string, payload: unknown): void {
  ;(actx as { emit(name: string, payload: unknown): void }).emit(name, payload)
}

/** The snapshot fields an insert needs: the draft, its revision, and the chips' ranges. */
function readDraftState(input: SidebarSessionInput): {
  draft: string
  draftRev: number
  occurrences: readonly DraftOccurrence[]
} | undefined {
  const state = input.state.getSnapshot()
  if (state.draftRev === undefined) return undefined
  return { draft: state.draft, draftRev: state.draftRev, occurrences: state.occurrences ?? [] }
}

/**
 * Insert `text` into the session's composer draft as plain text — the host's
 * own folder-drill path (`slash/input-insert-text`), at the composer's live
 * caret when one can be resolved and at the end otherwise. Returns false — and
 * logs — when the conversation service or the session scope is unavailable, or
 * when the draft carries no revision to address; an event no listener handled
 * also reports false and leaves the draft untouched (forcing the text in by
 * rewriting the whole draft is what used to destroy chips).
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
    const before = readDraftState(input)
    if (before === undefined) {
      console.warn('[dsh-better-sidebar] draft insert skipped: composer revision unavailable')
      return false
    }
    const plan = planInsert(before.draft, text, probeComposerCaret(before.draft))
    emitComposerEvent(actx, 'slash/input-insert-text', {
      text: plan.text,
      span: {
        draftRev: before.draftRev,
        start: clipboardToDetect(before.occurrences, plan.start),
        end: clipboardToDetect(before.occurrences, plan.end),
      },
    })
    if (input.state.getSnapshot().draftRev === before.draftRev) {
      console.warn('[dsh-better-sidebar] draft insert skipped: the composer did not apply the insert event')
      return false
    }
    return true
  } catch (error) {
    console.warn('[dsh-better-sidebar] draft insert failed:', error)
    return false
  }
}

/**
 * The DSH `@` spelling for one relative path, mirroring the host grammar
 * (`formatFileMention` in `@deepseek-ai/dsh-file-reference`): plain when
 * there is no whitespace, quoted when there is, and `undefined` when the
 * path contains a control character or an embedded quote the editor grammar
 * cannot represent.
 *
 * Files and folders share this one constructor so the quoting rule cannot
 * drift between them. A folder spells the trailing slash *inside* the quotes
 * (`@"my dir/"`, `@docs/`): the host's folder token matcher
 * (`FOLDER_REF_RE` in `dsh-client-ui-conversation`) only accepts a quoted
 * directory once the quote closes, and the message bubble's tokenizer
 * (`@"[^"\n]+"` in `dsh-client-ui-primitives`) only classifies a closed
 * quoted token as a folder — unquoted `@my dir/` decorates as a file chip
 * covering just `my`. The host's own picker emits the *open* form
 * (`@"my dir/`) while the user is still descending through completion; a
 * programmatic reference is a finished mention, so it closes the quote.
 */
export function mentionFor(
  relativePath: string,
  kind: 'file' | 'folder',
): { mention: string; label: string } | undefined {
  const path = relativePath.replace(/[\\/]+$/, '')
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point of this guard
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined
  const target = kind === 'folder' ? `${path}/` : path
  const mention = /\s/u.test(target) ? `@"${target}"` : `@${target}`
  return { mention, label: baseName(path) }
}

/**
 * A complete directory token (`@docs/`, `@"my dir/"`): the explorer inserts a
 * finished mention, so the trailing slash sits inside the closing quote.
 * Separators normalize to '/' first (the fs-tree spelling); the spelling
 * itself is {@link mentionFor}'s single job, folder kind — this helper adds no
 * quoting rule of its own.
 */
export function directoryMention(relativePath: string): string | undefined {
  return mentionFor(relativePath.replace(/\\/g, '/'), 'folder')?.mention
}

/**
 * Insert an explorer entry using WorkspaceView.path, selected by exact
 * session membership (the same lookup as the native conversation shell).
 * Read the public workspace snapshot at click time so reconnects and session
 * changes cannot leave a captured root stale. Missing/unready membership or
 * an unrepresentable path is a logged no-op; never guess from session cwd.
 */
export function insertWorkspaceReference(ctx: Context, sessionId: string, path: string, isDir: boolean): boolean {
  try {
    const snapshot = ctx.get('workspaces')?.list.getSnapshot()
    const root = snapshot?.phase === 'ready' && snapshot.state === 'idle'
      ? snapshot.items.find(workspace => workspace.sessionIds.includes(sessionId))?.path
      : undefined
    const relative = workspaceRelativePath(root, path)
    if (relative === undefined) {
      console.warn('[dsh-better-sidebar] reference insert skipped: workspace root unavailable or path outside workspace')
      return false
    }
    const mention = isDir ? directoryMention(relative) : mentionFor(relative, 'file')?.mention
    if (mention === undefined) {
      console.warn('[dsh-better-sidebar] reference insert skipped: path cannot be represented as a mention')
      return false
    }
    if (!isDir && insertFileReference(ctx, sessionId, relative)) return true
    // Plain text is the fallback, not the primary path, for files (the chip
    // serializes to the whole path; a plain `@dir/file.ts` only decorates its
    // folder prefix). The host adds space after a file chip, but not before
    // it, so complete directory inserts need their own separator for the next
    // @ click. Either way this is a span insert — an existing chip survives it.
    return appendToDraft(ctx, sessionId, isDir ? `${mention} ` : mention)
  } catch (error) {
    console.warn('[dsh-better-sidebar] workspace-reference insert failed:', error)
    return false
  }
}

/**
 * Insert one FILE reference as a structured chip (like DSH's own `@` picker).
 * The chip displays `@<basename>` but serializes to `@<relative path>` on
 * send, so the reference stays a single link from trigger to basename.
 *
 * The chip lands at the composer's resolved caret end, or at the draft end
 * when no caret is resolvable — the host adds the separating space *after* a
 * chip and, like its own picker, none before it, so a programmatic chip sits
 * flush against whatever preceded it.
 *
 * Directories keep the sidebar's plain-text completion behavior (`@dir/`)
 * through `insertWorkspaceReference`. The picker also supports folder chips on
 * explicit selection; its drill action still inserts plain text.
 */
export function insertFileReference(ctx: Context, sessionId: string, relativePath: string): boolean {
  const reference = mentionFor(relativePath, 'file')
  if (reference === undefined) return false
  try {
    const actx = ctx.sessions.scope(sessionId)
    if (actx === undefined) return false
    const conversation = ctx.get('conversation') as SidebarConversation | undefined
    if (conversation === undefined) return false
    const input = conversation.input.for(actx)
    const before = readDraftState(input)
    if (before === undefined) return false
    const caret = probeComposerCaret(before.draft)
    const at = clipboardToDetect(before.occurrences, caret === null ? before.draft.length : caret.end)
    emitComposerEvent(actx, 'slash/input-insert-reference', {
      reference: {
        source: 'reference',
        ref: reference.mention,
        label: reference.label,
        appearance: 'file',
        clipboardText: reference.mention,
      },
      span: {
        draftRev: before.draftRev,
        start: at,
        end: at,
      },
    })
    if (input.state.getSnapshot().draftRev === before.draftRev) {
      console.warn('[dsh-better-sidebar] file-reference insert skipped: the composer did not apply the insert event')
      return false
    }
    return true
  } catch (error) {
    console.warn('[dsh-better-sidebar] file-reference insert failed:', error)
    return false
  }
}
