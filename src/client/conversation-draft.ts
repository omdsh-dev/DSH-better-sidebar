/**
 * Insert text into the current session's composer draft through the
 * conversation service — the shared path behind the explorer's @-reference
 * button and the viewer selection popup. The service is resolved lazily
 * through `ctx.get` (the inject-free read the app's own plugins use); a
 * missing service or scope degrades to a logged no-op, never a crash.
 *
 * Structured references (file chips, selection chips, and any append onto a
 * draft that already carries chips) go through the host's span channels
 * instead of plain draft text: `setDraft` rebuilds the document from a string
 * and flattens every chip. A reference chip mints through
 * `SidebarSessionInput.insertReference` (what the native `@` picker
 * calls); plain-text insertion onto a chipped draft has no facade method and
 * emits `slash/input-insert-text` directly. Plain `setDraft` is the fallback
 * for chipless drafts only.
 *
 * Everything appends at the document end. The host composer is a Lexical
 * contenteditable and this face publishes no caret, so a mid-draft insert
 * would have to guess a position — see {@link appendOffset} for the one
 * coordinate it does derive.
 */
import type {
  Context,
  SidebarConversation,
  SidebarReferenceInsert,
  SidebarSessionInput,
  SidebarSessionOccurrence,
} from '../context-types.ts'
import { baseName, workspaceRelativePath } from './paths.ts'

/**
 * One structured reference to insert as a chip: the compact `label` the
 * composer shows, and the `text` the model receives on send. The two are
 * deliberately different — a selection reads as `docs/a.md:12-15` on screen
 * while the model still gets the whole fenced block.
 *
 * Named `Pending*` to keep clear of the host's own `DraftReference`, which is
 * the opposite thing: a chip ALREADY in the draft, carrying its offset and
 * length.
 */
export interface PendingReference {
  label: string
  text: string
  /**
   * What the draft string carries for this chip (the clipboard projection).
   * Defaults to `label`; a file reference spells its `@path` here instead.
   * This is the text other draft consumers (copy, plain projections) see, so
   * it stays short — the full payload rides in `text` and is only expanded
   * on send.
   */
  clipboardText?: string
  /**
   * Chip icon family. Omit for a reference whose `text` is not a path: the
   * host marks `'file'` chips openable, and a click would hand the raw text
   * (a fenced block, for a selection) to the file opener.
   */
  appearance?: 'file' | 'folder' | 'session'
}

/**
 * The separating space an append needs on its left — one space, but never
 * doubled against existing whitespace. Both the string append and the span
 * channel (which does no splice math of its own) obey this single rule. A
 * blank draft takes no separator: it is replaced outright.
 */
function leadFor(draft: string): string {
  if (draft.trim() === '') return ''
  return /\s$/.test(draft) ? '' : ' '
}

/** `draft` with `text` appended behind one separating space when needed. */
export function appendText(draft: string, text: string): string {
  return `${draft}${leadFor(draft)}${text}`
}

/**
 * Fold one clipboard-projection offset to its detect-projection twin.
 *
 * The host maintains two coordinate systems over the same document: the
 * clipboard projection (`InputState.draft`, `occurrences`) expands every chip
 * to its whole `clipboardText`, while the detect projection — the one every
 * insert/replace event's `span` must speak — collapses each chip to a single
 * placeholder character. Deriving a span from a draft offset without folding
 * therefore overshoots by `length - 1` per chip, and the host rejects the
 * out-of-range span (`applied = false`) — the second chip insert of a session
 * would silently fail.
 *
 * An offset inside a chip's expansion snaps to that chip's trailing edge: the
 * host only ever replaces whole chips, never splits one. An offset exactly at
 * a chip's START resolves to the position BEFORE the chip — the host's own
 * `detectOffsetOfClipboardOffset` reads that case as "inside" and returns the
 * trailing edge, which would move a caret one chip too far right.
 */
export function foldClipboardOffset(
  draft: string,
  occurrences: readonly SidebarSessionOccurrence[],
  offset: number,
): number {
  const target = Math.max(0, Math.min(offset, draft.length))
  let shrink = 0
  for (const occurrence of occurrences) {
    const end = occurrence.offset + occurrence.length
    if (target >= end) {
      // The whole chip sits at or before the offset: it contributes one
      // character instead of its expansion.
      shrink += occurrence.length - 1
      continue
    }
    if (target > occurrence.offset) {
      // Inside the chip's expansion — the host only replaces whole chips, so
      // snap to this chip's trailing edge.
      return occurrence.offset - shrink + 1
    }
    break
  }
  return target - shrink
}

/**
 * The detect-projection offset that appends at the document end, or
 * `undefined` when it cannot be derived.
 *
 * `foldClipboardOffset` alone is not enough: a command chip (`/goal `, present
 * while `phase === 'claimed'`) collapses to one detect character but never
 * appears in `occurrences` — the host only collects reference chips. The chip
 * covers exactly `claim.token`, a prefix of the draft, so its own characters
 * fold away and one placeholder takes their place.
 */
function appendOffset(snapshot: ReturnType<SidebarSessionInput['state']['getSnapshot']>): number | undefined {
  const { draft, claim } = snapshot
  const occurrences = snapshot.occurrences ?? []
  const token = snapshot.phase === 'claimed' && claim !== undefined && draft.startsWith(claim.token)
    ? claim.token
    : ''
  if (token === '') return foldClipboardOffset(draft, occurrences, draft.length)
  // Fold the arguments behind the token, then add the command chip's one
  // detect character in front.
  const rest = draft.slice(token.length)
  const offsetInRest = occurrences
    .filter(occurrence => occurrence.offset >= token.length)
    .map(occurrence => ({ offset: occurrence.offset - token.length, length: occurrence.length }))
  return 1 + foldClipboardOffset(rest, offsetInRest, rest.length)
}

/**
 * Mint one reference chip through the host's own `insertReference` — the
 * same facade method the native `@` picker's event listener calls, so the
 * composer shows a compact chip while the model receives `reference.text`.
 * The host runs its own admission-phase and revision guards and reports
 * whether the edit applied.
 *
 * The chip's `clipboardText` is the compact `label`, not the full payload —
 * see {@link PendingReference.clipboardText}.
 *
 * Returns false when the host refused the insert (stale revision, a frozen
 * submission phase, or no chip channel at all) so the caller can fall back.
 */
export function insertDraftReference(
  ctx: Context,
  sessionId: string,
  reference: PendingReference,
): boolean {
  let before: number | undefined
  try {
    const actx = ctx.sessions.scope(sessionId)
    if (actx === undefined) return false
    const conversation = ctx.get('conversation') as SidebarConversation | undefined
    if (conversation === undefined) return false
    const input = conversation.input.for(actx)
    const snapshot = input.state.getSnapshot()
    if (input.insertReference === undefined || snapshot.draftRev === undefined) return false
    if (snapshot.phase === 'adjudicating' || snapshot.phase === 'submitting') return false
    before = snapshot.draftRev
    // Chips always append at the document end (there is no caret API and the
    // composer is a contenteditable, not a textarea — `probeComposerCaret`
    // never resolves one), so the span is the folded end position.
    const at = appendOffset(snapshot)
    if (at === undefined) return false
    // The host's insertReference adds a space AFTER the chip but never before
    // it (client.js:14758), so a chip appended to `hello` would read
    // `hello[chip]`. Reserve the separator first through the same span
    // channel — a stray trailing space is harmless if the chip then fails.
    let rev = snapshot.draftRev
    let start = at
    if (leadFor(snapshot.draft) !== '') {
      const actxEmit = actx as unknown as { emit(name: string, payload: unknown): void }
      actxEmit.emit('slash/input-insert-text', {
        text: ' ',
        span: { draftRev: rev, start: at, end: at },
      })
      const afterSpace = input.state.getSnapshot()
      if (afterSpace.draftRev === rev) return false
      rev = afterSpace.draftRev ?? rev
      start = at + 1
    }
    const chip: SidebarReferenceInsert = {
      source: 'reference',
      ref: reference.text,
      label: reference.label,
      // A selection chip's `ref` is a fenced block, not a path: leaving
      // `appearance` unset keeps the host from marking it openable (a click
      // would otherwise feed that block to the file opener).
      ...reference.appearance === undefined ? {} : { appearance: reference.appearance },
      clipboardText: reference.clipboardText ?? reference.label,
    }
    return input.insertReference(chip, { draftRev: rev, start, end: start })
  } catch (error) {
    // The host may have applied the edit and THEN thrown from its own update
    // listeners — reporting false would make the caller insert the same
    // reference a second time as plain text. A changed revision means the
    // chip is already in the document.
    console.warn('[dsh-better-sidebar] reference chip insert failed:', error)
    return revisionChanged(ctx, sessionId, before)
  }
}

/**
 * Whether the session's draft revision moved past `revision` — the only
 * trustworthy success signal after an exception swallowed the host's answer.
 * A missing service or snapshot counts as "no evidence of success".
 */
function revisionChanged(ctx: Context, sessionId: string, revision?: number): boolean {
  try {
    const actx = ctx.sessions.scope(sessionId)
    if (actx === undefined) return false
    const conversation = ctx.get('conversation') as SidebarConversation | undefined
    const input = conversation?.input.for(actx)
    const now = input?.state.getSnapshot().draftRev
    if (now === undefined || revision === undefined) return false
    return now !== revision
  } catch {
    return false
  }
}

/**
 * Append `text` to the session's composer draft. Returns false — and logs —
 * when the conversation service or the session scope is unavailable.
 *
 * The host composer is a Lexical contenteditable with no caret API on this
 * face, so this appends at the end; a mid-draft insert would need the caret
 * the host does not publish here.
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
    const snapshot = input.state.getSnapshot()
    const draft = snapshot.draft
    const occurrences = snapshot.occurrences ?? []
    // A command chip (`/goal`) is not a reference occurrence, but `setDraft`
    // flattens it just the same — and flattening it also drops the claim, so
    // the host re-reads the draft as plain text and cancels the command. Both
    // chip kinds take the span path.
    const hasChips = occurrences.length > 0 || snapshot.phase === 'claimed'
    if (hasChips) {
      // `setDraft` rebuilds the document from a plain string, which flattens
      // every existing chip into its text — so on a draft that already
      // carries chips, insert through the span event instead. The host's
      // `SessionInput` has no plain-text facade method (`insertText` lives on
      // the InputBar-private `InputActions`), so this event is the only
      // channel that preserves chips.
      const at = appendOffset(snapshot)
      if (snapshot.draftRev === undefined || at === undefined) {
        // No revision means no span channel either — the only remaining write
        // path (`setDraft`) would flatten every chip, so refuse instead.
        console.warn('[dsh-better-sidebar] draft insert skipped: chip draft without a revision')
        return false
      }
      // The session-scope Context's typed `emit` is keyed to DSH's closed
      // event map; this internal composer event is string-loose at runtime.
      const actxEmit = actx as unknown as { emit(name: string, payload: unknown): void }
      actxEmit.emit('slash/input-insert-text', {
        text: `${leadFor(draft)}${text}`,
        span: { draftRev: snapshot.draftRev, start: at, end: at },
      })
      return input.state.getSnapshot().draftRev !== snapshot.draftRev
    }
    input.setDraft(appendText(draft, text))
    return true
  } catch (error) {
    console.warn('[dsh-better-sidebar] draft insert failed:', error)
    return false
  }
}

/**
 * Insert one reference as a chip, degrading to its plain-text form when the
 * host has no chip channel or refuses the insert. This is the ONE place the
 * fallback policy lives: the explorer's `@` button and the viewer selection
 * popup both come through here.
 */
export function insertReferenceOrText(
  ctx: Context,
  sessionId: string,
  reference: PendingReference,
): boolean {
  return insertDraftReference(ctx, sessionId, reference) || appendToDraft(ctx, sessionId, reference.text)
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
    if (isDir) {
      const mention = directoryMention(relative)
      if (mention === undefined) {
        console.warn('[dsh-better-sidebar] reference insert skipped: path cannot be represented as a mention')
        return false
      }
      // The host adds space after a file chip, but not before it. Complete
      // directory inserts need their own separator for the next @ click.
      return appendToDraft(ctx, sessionId, `${mention} `)
    }
    const file = mentionFor(relative, 'file')
    if (file === undefined) {
      console.warn('[dsh-better-sidebar] reference insert skipped: path cannot be represented as a mention')
      return false
    }
    return insertReferenceOrText(ctx, sessionId, {
      label: file.label,
      text: file.mention,
      clipboardText: file.mention,
      appearance: 'file',
    })
  } catch (error) {
    console.warn('[dsh-better-sidebar] workspace-reference insert failed:', error)
    return false
  }
}
