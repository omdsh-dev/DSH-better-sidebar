/**
 * Insert a clue / pack reference into the composer draft (S9).
 *
 * The ONE way the clue Tab turns a resource into a stable reference. It uses
 * the host composer's PUBLIC structured-reference verb
 * (`SessionInput.insertReference`) with S5's codec names and S1's stable
 * token:
 *
 * - `source: 'better-sidebar:clues'`, `ref: <clueId>`, `clipboardText: [[dsh-clue:<id>]]`;
 * - `source: 'better-sidebar:packs'`, `ref: <packId>`, `clipboardText: [[dsh-cluepack:<id>]]`.
 *
 * The span is DETECT-projection coordinates, not the clipboard draft: every
 * chip occupies exactly one U+FFFC there. `InputState.occurrences` publishes
 * the bridge, so an append at the document end is folded through
 * `detectOffsetOfDraftEnd`. Passing the clipboard `draft.length` refuses the
 * second insert once a chip exists (the expanded chip text overshoots the
 * detect document).
 *
 * `appearance` is limited to `file` (the only chip slot every composer build
 * renders); the token — not the label — is what the model receives, so a later
 * rename of the resource cannot change an already-inserted reference.
 *
 * A clue chip requires the persisted stable id, so every candidate goes through
 * `clues.ensure` first: inserting is the durable use the S1 contract names.
 * Nothing here sends a message, reads a remote body or writes any other draft
 * field. Failures are reported and leave the draft untouched.
 */
import type { Context } from '../../context-types.ts'
import type { ClueTypeDescriptor } from '../../clues/types.ts'
import { CLUE_CODEC_SOURCE, PACK_CODEC_SOURCE } from '../../clues/types.ts'
import { escapeClueTitle, serializeClueToken } from '../../clues/context/tokens.ts'
import type { ClueSourceDescriptor } from '../../clues/types.ts'
import { t } from '../locales.ts'
import {
  insertDraftReference,
  insertReferenceOrText,
  type ComposerReference,
  type ComposerSpan,
} from '../conversation-draft.ts'

/** One chip insertion request. */
export interface ClueInsertRequest {
  readonly kind: 'clue' | 'pack'
  /** The stable S1 id (clue id or pack id). */
  readonly id: string
  /** Human title for the chip; the token always rides `clipboardText`. */
  readonly title?: string
}

/** The public reference payload one clue/pack chip carries. */
export type ClueChipReference = ComposerReference

/** Result of a detect-span addressed chip insert. */
export type ClueChipInsertOutcome = 'inserted' | 'stale' | 'failed'

/** The conversation/input machine slice this module touches. */
interface DraftContext {
  sessions?: {
    scope?(sessionId: string): unknown
  }
  get?(name: string): unknown
}

/** The composer input face (structural mirror of the public `SessionInput`). */
interface ComposerInput {
  state: {
    getSnapshot(): {
      readonly draft: string
      readonly draftRev?: number
      readonly phase?: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
      readonly occurrences?: readonly { readonly offset: number; readonly length: number }[]
      readonly claim?: { readonly token: string }
    }
  }
  insertReference(reference: ClueChipReference, span: ComposerSpan): boolean
  focus?(): void
}

/** Resolve the host composer input for one session, or undefined. */
function composerOf(ctx: Context, sessionId: string): ComposerInput | undefined {
  const context = ctx as unknown as DraftContext
  const scope = context.sessions?.scope?.(sessionId)
  if (scope === undefined) return undefined
  const conversation = context.get?.('conversation') as
    | { input?: { for(actx: unknown): ComposerInput } }
    | undefined
  if (conversation?.input === undefined || typeof conversation.input.for !== 'function') return undefined
  try {
    const input = conversation.input.for(scope)
    if (input === null || typeof input !== 'object' || typeof input.insertReference !== 'function') return undefined
    return input
  } catch {
    return undefined
  }
}

/** Hand the keyboard back to the composer after a successful insert. */
function focusComposer(input: ComposerInput): void {
  try {
    input.focus?.()
  } catch {
    // Focus is a convenience, never part of the insert's success contract.
  }
}

/**
 * Insert one reference chip at the document end (sidebar/Tab path).
 *
 * @param input - the resolved session composer.
 * @param reference - the chip payload (token always rides `clipboardText`).
 * @returns whether the host applied the chip edit.
 */
function insertAtEnd(ctx: Context, sessionId: string, input: ComposerInput, reference: ClueChipReference): boolean {
  const inserted = insertDraftReference(ctx, sessionId, reference)
  if (inserted) focusComposer(input)
  return inserted
}

/**
 * Insert one already-resolved reference chip at a PICK-TIME span (the `@`
 * menu's asynchronous ensure tail). The span is the host's own detect span,
 * so the draft revision CAS is the caller's guard against typing/submission
 * races: a changed draft, a frozen editor or a vanished session answers
 * `stale` and leaves the draft untouched.
 *
 * @param ctx - the client plugin context.
 * @param sessionId - the composer's session.
 * @param reference - the chip payload.
 * @param span - pick-time detect span (host `TokenSpan`).
 * @returns inserted, stale (draft/phase/session moved), or failed.
 */
export function insertClueReferenceSpan(
  ctx: Context,
  sessionId: string,
  reference: ClueChipReference,
  span: ComposerSpan,
): ClueChipInsertOutcome {
  if (sessionId === '') return 'failed'
  try {
    // Navigation identity comes from the host's public mounted-session store.
    // A retained background composer may still exist with the same revision;
    // it must not receive an asynchronous pick after the reader navigated away.
    const sidebar = ctx.get('sidebarRight') as {
      mounted?: { getSnapshot(): string | undefined }
    } | undefined
    if (sidebar?.mounted !== undefined && sidebar.mounted.getSnapshot() !== sessionId) return 'stale'
  } catch {
    return 'failed'
  }
  const input = composerOf(ctx, sessionId)
  if (input === undefined) return 'failed'
  let phase: string | undefined
  try {
    const before = input.state.getSnapshot()
    if (before.draftRev === undefined) return 'failed'
    if (before.draftRev !== span.draftRev) return 'stale'
    phase = before.phase
  } catch {
    return 'failed'
  }
  if (phase !== undefined && phase !== 'plain' && phase !== 'claimed') return 'stale'
  try {
    if (!input.insertReference(reference, span)) return 'stale'
  } catch {
    return 'failed'
  }
  focusComposer(input)
  return 'inserted'
}

/**
 * Insert one stable reference as a composer chip.
 *
 * @param ctx - the client plugin context.
 * @param sessionId - the composer's session.
 * @param request - the stable id and its kind.
 * @returns whether the draft changed (false = nothing was inserted).
 */
export function insertClueReference(ctx: Context, sessionId: string, request: ClueInsertRequest): boolean {
  if (sessionId === '') return false
  const input = composerOf(ctx, sessionId)
  if (input === undefined) return false
  let token: string
  try {
    token = serializeClueToken(request.kind, request.id)
  } catch {
    return false
  }
  const label = request.title === undefined || request.title.trim() === ''
    ? token
    : escapeClueTitle(request.title)
  try {
    return insertAtEnd(ctx, sessionId, input, {
      source: request.kind === 'clue' ? CLUE_CODEC_SOURCE : PACK_CODEC_SOURCE,
      ref: request.id,
      label,
      appearance: 'file',
      clipboardText: token,
    })
  } catch {
    return false
  }
}

/** Insert a selected excerpt with its stable provenance in one model-facing payload. */
export function insertClueSelectionReference(ctx: Context, sessionId: string, request: {
  readonly clueId: string
  readonly selection: string
  readonly label?: string
}): boolean {
  if (sessionId === '' || request.selection.trim() === '') return false
  let token: string
  try { token = serializeClueToken('clue', request.clueId) } catch { return false }
  // The built-in reference codec sends this payload verbatim; the clue codec
  // sends only the source token and would discard the selected excerpt.
  return insertReferenceOrText(ctx, sessionId, {
    label: request.label ?? request.selection.trim().split('\n')[0]!.slice(0, 80),
    text: token + '\n\n' + request.selection,
    clipboardText: token,
  })
}

/**
 * Insert a whole pack's reference (no ensure: the pack id is already stable).
 * @returns whether the chip landed.
 */
export function insertPackReference(
  ctx: Context,
  sessionId: string,
  packId: string,
  packName: string,
): boolean {
  const inserted = insertClueReference(ctx, sessionId, { kind: 'pack', id: packId, title: packName })
  if (!inserted) notify(t('clueInsertFailed'))
  return inserted
}

/** A visible, localized notice sink (the wiring passes `notifyClue`). */
type NoticeSink = (message: string) => void

/** The module-level notice sink (set once by the client wiring). */
let noticeSink: NoticeSink | undefined

/** Install the plugin's visible notice sink (client wiring; HMR replaces it). */
export function setClueNoticeSink(sink: NoticeSink | undefined): void {
  noticeSink = sink
}

/** Show one notice through the wiring's sink, or the console as a last resort. */
function notify(message: string): void {
  if (noticeSink !== undefined) {
    noticeSink(message)
    return
  }
  console.warn(`[dsh-better-sidebar] ${message}`)
}

/** The display name of one source (client display override, then host name). */
export function sourceNameOf(
  sourceId: string,
  sources: readonly ClueSourceDescriptor[],
  displays: readonly { readonly sourceId: string; readonly name?: string }[],
): string {
  return displays.find(display => display.sourceId === sourceId)?.name
    ?? sources.find(source => source.sourceId === sourceId)?.name
    ?? sourceId
}

/** The first format one type declares (detail windows need a concrete format). */
export function formatOfType(
  typeId: string,
  types: readonly ClueTypeDescriptor[],
  fallback = 'text/plain',
): string {
  return types.find(type => type.typeId === typeId)?.formats[0] ?? fallback
}
