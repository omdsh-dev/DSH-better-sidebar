/**
 * Insert a clue / pack reference into the composer draft (S9).
 *
 * The ONE way the clue Tab turns a resource into a stable reference. It reuses
 * the host composer's own structured-chip event (`slash/input-insert-reference`)
 * exactly like the file tree's reference insert, with S5's codec names and
 * S1's stable token:
 *
 * - `source: 'better-sidebar:clues'`, `ref: <clueId>`, `clipboardText: [[dsh-clue:<id>]]`;
 * - `source: 'better-sidebar:packs'`, `ref: <packId>`, `clipboardText: [[dsh-cluepack:<id>]]`.
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

/** One chip insertion request. */
export interface ClueInsertRequest {
  readonly kind: 'clue' | 'pack'
  /** The stable S1 id (clue id or pack id). */
  readonly id: string
  /** Human title for the chip; the token always rides `clipboardText`. */
  readonly title?: string
}

/** The conversation/input machine slice this module touches. */
interface DraftContext {
  sessions?: {
    scope?(sessionId: string): {
      emit?(name: string, payload: unknown): void
    } | undefined
  }
  get?(name: string): unknown
}

/** The composer input face (structural mirror of `SidebarConversation`). */
interface ComposerInput {
  state: { getSnapshot(): { draft: string; draftRev?: number } }
}

/** Whether the host composer is reachable for this session. */
function composerOf(ctx: Context, sessionId: string): {
  readonly input: ComposerInput
  readonly emit: (name: string, payload: unknown) => void
} | undefined {
  const context = ctx as unknown as DraftContext
  const scope = context.sessions?.scope?.(sessionId)
  if (scope === undefined || typeof scope.emit !== 'function') return undefined
  const conversation = context.get?.('conversation') as
    | { input?: { for(actx: unknown): ComposerInput } }
    | undefined
  if (conversation?.input === undefined || typeof conversation.input.for !== 'function') return undefined
  try {
    return { input: conversation.input.for(scope), emit: (name, payload) => { scope.emit?.(name, payload) } }
  } catch {
    return undefined
  }
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
  const composer = composerOf(ctx, sessionId)
  if (composer === undefined) return false
  let token: string
  try {
    token = serializeClueToken(request.kind, request.id)
  } catch {
    return false
  }
  const before = composer.input.state.getSnapshot()
  if (before.draftRev === undefined) return false
  const label = request.title === undefined || request.title.trim() === ''
    ? token
    : escapeClueTitle(request.title)
  try {
    composer.emit('slash/input-insert-reference', {
      reference: {
        source: request.kind === 'clue' ? CLUE_CODEC_SOURCE : PACK_CODEC_SOURCE,
        ref: request.id,
        label,
        appearance: 'file',
        clipboardText: token,
      },
      span: {
        draftRev: before.draftRev,
        start: before.draft.length,
        end: before.draft.length,
      },
    })
  } catch {
    return false
  }
  return composer.input.state.getSnapshot().draftRev !== before.draftRev
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
