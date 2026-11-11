/**
 * Side Chat transcript mapping (browser half): turns a thread child's own
 * events (`sidechat.events` — the plugin route, which reads the log without
 * activating the child and cuts the inherited seed host-side) into compact
 * display rows.
 *
 * A thread child's log starts with the ENTIRE inherited parent log as its
 * fork seed. The route already cuts everything up to the last tagged
 * `session/end-seed { inherited: true }` marker; the mapping re-applies the
 * same cut (never a restore/replay lifecycle marker) so any
 * seed event that somehow crosses the wire still never renders, and maps
 * context injections (the "Side conversation boundary" prompt,
 * plugin-sourced context) onto a collapsible injection row, so the view
 * shows only the thread's own conversation.
 *
 * Live streaming: `assistant/message` events only land when a step
 * completes, but the host's `assistant/live-chunk` rows stream token-level
 * text and reasoning deltas (DSH 0.1.5 publishes them outside the session
 * log — see assistant-live.ts). The mapping accumulates both per block and
 * supersedes them with the assembled message once it lands (settled rows).
 *
 * Failures: a provider/agent error used to end a turn with nothing on screen.
 * The terminal `turn/end` reason and a failed attempt's embedded finish chunk
 * both map onto one visible `error` row per turn.
 *
 * Deliveries: a `present` call maps onto a compact deliverables card, and the
 * authoritative `deliverables/presented` event the tool appends attaches to
 * that card by `callId` — or stands alone when the call row is outside the
 * events route's head cap. One card per call; a FAILED call replaces its card
 * with the generic failed tool row. (The host's own `PresentRow` is a status
 * disclosure row over the call — its delivery cards come from the turn-tail
 * deliverables, not from the call itself.)
 */
import type {
  DiffHunk,
  ReadBlockLine,
  SearchBlockProps,
  SearchFileGroup,
  WebBlockProps,
  WebSourceView,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { projectSidechatContent, type SidechatImageOccurrence } from '../sidechat-images.ts'
import type { SidebarHistoryEntry } from '../context-types.ts'
import { isContextInjectionMessage, SIDE_BOUNDARY_PROMPT, threadOwnLogEvents } from '../sidechat-core.ts'

/** {@link Omit} that distributes over a union, so a discriminated props union
 *  keeps its `kind` discriminant (the host's card models use the same trick). */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

/** The host `SearchBlock` props minus the render site's own fields. */
export type SidechatSearchCard = DistributiveOmit<SearchBlockProps, 'labels' | 'className'>

/** The host `WebBlock` props minus the render site's own fields. */
export type SidechatWebCard = DistributiveOmit<WebBlockProps, 'labels' | 'className'>

/**
 * Structured render payload for a tool row that maps onto one of the host's
 * ui-primitives Blocks (the same atoms the main conversation renders). Derived
 * defensively from raw `tool/call` arguments and `tool/result` `meta` — the
 * producing tool owns the meta shape, so every field is narrowed and any
 * malformed input silently falls back to the generic text row.
 */
export type SidechatToolCard =
  | {
    type: 'terminal'
    command: string
    cwd?: string
    output?: string
    exitCode?: number
    signal?: string
  }
  | { type: 'diff'; diffs: DiffHunk[] }
  | { type: 'read'; label: string; lines: ReadBlockLine[]; totalLines: number; lang?: string }
  /** grep / glob: the host SearchBlock, in its `matches` or `paths` shape. */
  | { type: 'search'; card: SidechatSearchCard }
  /** web_search / web_fetch: the host WebBlock, in its `search` or `fetch` shape. */
  | { type: 'web'; card: SidechatWebCard }

/** One file a `present` call delivered: its path (absolute from the
 *  `deliverables/presented` event, session-relative from the call arguments)
 *  plus the model's own description when it wrote one. */
export interface SidechatDeliverable {
  path: string
  description?: string
}

/** One compact transcript row rendered in the thread view. `seq` is the
 *  source event's log sequence. Text/reasoning also retain the original
 *  content-block index: one event can yield several rows, so seq alone is
 *  not a unique React key across polls. */
export type SidechatTranscriptRow =
  /** `messageId` is the durable message identity the log records on the event
   *  (`data.id`); the view uses it to dedupe a still-pending inbox row against
   *  the durable row the claim eventually writes. Older logs may lack it. */
  | {
    kind: 'user'
    seq: number
    text: string
    messageId?: string
    /** Upstream's projected image occurrences (side-chat images). */
    images?: SidechatImageOccurrence[]
    /** The message's `file` blocks, in content order (a bubble is one visual
     *  unit, so they ride the row instead of becoming siblings). */
    attachments?: readonly SidechatAttachment[]
  }
  /** A context injection (the side boundary prompt + the parked in-progress
   *  snapshot, or any plugin-sourced context): rendered as one collapsible
   *  row, never as a user bubble. */
  | { kind: 'injection'; seq: number; text: string }
  /** A provider/agent FAILURE, which used to end a turn silently: either a
   *  `turn/end` carrying `reason.kind === 'error'` or a failed
   *  `assistant/attempt` (its stream's terminal `finish` chunk). One row per
   *  turn — the attempt error and the turn/end that follows it are the same
   *  failure. */
  | { kind: 'error'; seq: number; text: string }
  /** `settled` distinguishes an assembled message from a still-streaming
   *  chunk accumulation. Original content-block indexes are never compacted;
   *  a live chunk that lacks a valid index keeps it undefined. */
  | { kind: 'assistant'; seq: number; text: string; settled: boolean; contentBlockIndex?: number }
  | {
    kind: 'reasoning'
    seq: number
    text: string
    settled: boolean
    contentBlockIndex?: number
    /** The turn this row belongs to, when the log records one (the view groups
     *  a Turn's work rows by it). */
    turn?: number
    /** True when that turn already ended (`turn/end` landed): its work rows are
     *  settled and may be folded shut. */
    turnEnded?: boolean
  }
  | {
    kind: 'tool'
    seq: number
    name: string
    failed: boolean
    /** Raw arguments JSON as the model produced it. */
    args?: string
    /** Plain text of the paired result. */
    resultText?: string
    /** True while the call's result has not landed yet. */
    executing?: boolean
    /** Structured render payload (host Block atoms); absent = generic row. */
    card?: SidechatToolCard
    /** `image` / `file` blocks of the paired result's content list. */
    resultAttachments?: readonly SidechatAttachment[]
    /** The turn this call belongs to, and whether that turn already ended (see
     *  `reasoning.turn`). */
    turn?: number
    turnEnded?: boolean
  }
  /** One `present` delivery (a compact deliverables card instead of a tool
   *  row). A `deliverables/presented` event with the same `callId` REPLACES
   *  the call's arguments copy — one card per call, never two, whichever
   *  event lands first. An event with no call row in the window (an
   *  event-only delivery) still gets its own. A FAILED present call delivered
   *  nothing and renders as the generic failed tool row instead. */
  | { kind: 'deliverables'; seq: number; callId?: string; files: readonly SidechatDeliverable[] }
  /** One turn's tail metrics, emitted at `turn/end`: the turn's token usage
   *  (aggregated from `assistant/message.usage`) and wall duration (envelope
   *  time delta from `turn/start`), whichever are computable. */
  | {
    kind: 'turnSummary'
    seq: number
    /** The turn these metrics belong to (the view's work-details control reads
     *  its duration from here). */
    turn?: number
    inputTokens?: number
    outputTokens?: number
    durationMs?: number
  }
  /** A turn that ended WITHOUT a normal completion, so the transcript says why
   *  it stops there instead of looking deliberately finished: the reader (or
   *  the agent) stopped it (`aborted`), or the output limit cut it
   *  (`max-tokens`). One row per turn — the attempt's terminal finish reason and
   *  the `turn/end` that repeats it are the same event. */
  | { kind: 'terminal'; seq: number; reason: 'aborted' | 'max-tokens' }
  /** One `image` / `file` content block of an ASSISTANT message, rendered in
   *  block order: the assistant branch explodes a message per content block, so
   *  an attachment needs its own row to keep that order. A USER message keeps
   *  its blocks on the message's own row (`user.attachments`) — the bubble is
   *  one visual unit. */
  | {
    kind: 'attachment'
    seq: number
    attachment: SidechatAttachment
    contentBlockIndex?: number
  }
  /** One compaction transaction, drawn at its landed CHECKPOINT (host parity:
   *  no checkpoint, no node). `text` is the summary body the row publishes
   *  behind its disclosure (`''` when the metering event is outside the
   *  window); the counts come from that same metering event, so they are null
   *  whenever it is. */
  | {
    kind: 'compaction'
    seq: number
    text: string
    summary: string | null
    shadowedItemCount: number | null
    shadowedTokenCount: number | null
  }
  /** One model-request retry CHAIN (`retryId`), folded like the host: every
   *  further attempt updates this row, which keeps the chain's first seq. */
  | {
    kind: 'retry'
    seq: number
    retry: number
    maxRetries?: number
    delayMs?: number
    provider?: string
    state: 'scheduled' | 'started'
    failureMessage?: string
  }

/**
 * One image content block the transcript must show. The bytes are NOT part of
 * the log — only the id is — so the read goes through the host Remote with the
 * THREAD's own session id (see `SidechatAttachments`); a `uiConversation`
 * image URL is never the source.
 */
export interface SidechatImageAttachment {
  /** Opaque host id — the only key a byte read may use. */
  attachmentId: string
  /** The image's media type (becomes the Blob's `type`). */
  mediaType: string
  /** The producer's file name, when it recorded one (the thumbnail's alt). */
  name?: string
}

/** One non-image file the model was given: a chip, never a byte read. */
export interface SidechatFileAttachment {
  name: string
  /** Byte count for the size chip (absent when the producer recorded none). */
  bytes?: number
}

/** What a landing checkpoint takes from its `compaction/summary` metering
 *  event: the summary body it replaced the range with, and that range's shadow
 *  price. Absent when the metering event is outside the event window. */
interface CompactionFacts {
  summary: string | null
  shadowedItemCount: number | null
  shadowedTokenCount: number | null
}

/** An `image` or `file` content block, narrowed to what the transcript renders. */
export type SidechatAttachment =
  | { kind: 'image'; image: SidechatImageAttachment }
  | { kind: 'file'; file: SidechatFileAttachment }

/** Compact token count the way the main conversation prints usage
 *  (517 / 12.2K / 1.2M — the host's own formatter is not exported). */
export function formatTokens(n: number): string {
  const scaled = (v: number): string => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/** Compact duration the way the main conversation prints run times
 *  (45.2s / 2m42s — sub-minute keeps one decimal). */
export function formatDurationMs(ms: number): string {
  const seconds = ms / 1_000
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

/** The plain text of a content list (`text` blocks verbatim, joined by blank
 *  lines), '' when it carries no text block at all. */
function joinedText(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') {
      parts.push(candidate.text)
    }
  }
  return parts.join('\n\n')
}

/** Extract the visible text of a content-block list (`text` blocks verbatim,
 *  joined by blank lines); empty reads `…` so rows never render blank. */
export function blockText(content: readonly unknown[]): string {
  const text = joinedText(content)
  return text === '' ? '…' : text
}

/** Cap for a tool row's one-line argument summary (display only). */
const ARGS_SUMMARY_MAX = 80

/** The most identifying argument keys, in priority order (bash's command,
 *  fs tools' paths, search's pattern, …). */
const ARGS_SUMMARY_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt'] as const

function flatTruncate(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > ARGS_SUMMARY_MAX ? `${flat.slice(0, ARGS_SUMMARY_MAX - 1)}…` : flat
}

/**
 * The short summary of one argument object that names no identifying key: the
 * FIRST string field, or the first array field's primitive entries joined —
 * whichever comes first in the object's own order. Undefined when the object
 * carries neither (all numbers/booleans/nested objects).
 */
function firstFieldSummary(parsed: Record<string, unknown>): string | undefined {
  for (const value of Object.values(parsed)) {
    if (typeof value === 'string' && value.trim() !== '') return flatTruncate(value)
    if (!Array.isArray(value)) continue
    const parts = value
      .filter((item): item is string | number | boolean =>
        typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')
      .map(item => String(item))
      .filter(item => item.trim() !== '')
    if (parts.length > 0) return flatTruncate(parts.join(', '))
  }
  return undefined
}

/**
 * One-line summary of a tool call's raw arguments JSON for the collapsed row:
 * the first identifying string field when the JSON parses, else (an object with
 * none of those keys) the first string/array field, else nothing at all.
 *
 * The raw JSON is NEVER the answer for a parsed object — a collapsed row that
 * reads `{"custom":"v"}` tells the reader nothing they can scan. Raw text still
 * serves the one case where it is all there is: arguments that are not an
 * object at all (unparsable, or a bare array/literal), and an object that HAS an
 * identifying key but left it blank (the key is the tool's own vocabulary, so
 * the arguments themselves are the honest summary). Empty when there is nothing
 * worth showing.
 */
export function toolArgsSummary(args: string | undefined): string {
  if (args === undefined) return ''
  try {
    const parsed = JSON.parse(args) as Record<string, unknown> | null
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      let identifying = false
      for (const key of ARGS_SUMMARY_KEYS) {
        if (!(key in parsed)) continue
        identifying = true
        const value = parsed[key]
        if (typeof value === 'string' && value.trim() !== '') return flatTruncate(value)
      }
      if (identifying) return flatTruncate(args)
      return firstFieldSummary(parsed) ?? ''
    }
  } catch {
    // Raw text fallthrough.
  }
  return flatTruncate(args)
}

/**
 * The result content blocks of one tool/result message under BOTH logged
 * shapes: 0.1.6 wrapped them in a single `type: 'tool-result'` content block
 * on a user-role message, 0.1.7's first-class tool-role message carries them
 * at the message's own top level. Historical logs keep the old shape forever,
 * so both are read. Undefined when the message carries no block array.
 */
function resultBlocks(content: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const wrapper = block as { type?: unknown; content?: unknown }
    if (wrapper.type === 'tool-result' && Array.isArray(wrapper.content)) {
      return wrapper.content as readonly unknown[]
    }
  }
  return content as readonly unknown[]
}

/** The plain text of a tool/result message (its text blocks, under either of
 *  the two shapes {@link resultBlocks} reads). */
function resultTextOf(data: Record<string, unknown>): string {
  const message = data.message as { content?: unknown } | undefined
  const blocks = resultBlocks(message?.content)
  if (blocks === undefined) return ''
  const parts: string[] = []
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') continue
    const textItem = item as { type?: unknown; text?: unknown }
    if (textItem.type === 'text' && typeof textItem.text === 'string') {
      parts.push(textItem.text)
    }
  }
  return parts.join('\n')
}

/**
 * Narrow one `image` / `file` content block. A block without the fields the
 * transcript can actually render is SKIPPED (no row, no placeholder, no byte
 * read): an image needs an `attachmentId` (the read key) and a `mediaType` (the
 * Blob's type); a file needs its `name` (the chip's whole text).
 * @param block - one content block from a message or a tool result.
 * @returns the narrowed attachment, or undefined for anything else.
 */
function attachmentOf(block: unknown): SidechatAttachment | undefined {
  if (block === null || typeof block !== 'object') return undefined
  const { type, attachment } = block as { type?: unknown; attachment?: unknown }
  if (attachment === null || typeof attachment !== 'object') return undefined
  const ref = attachment as Record<string, unknown>
  if (type === 'image') {
    const { attachmentId, mediaType, name } = ref
    if (typeof attachmentId !== 'string' || attachmentId === '') return undefined
    if (typeof mediaType !== 'string' || mediaType === '') return undefined
    return {
      kind: 'image',
      image: {
        attachmentId,
        mediaType,
        ...(typeof name === 'string' && name !== '' ? { name } : {}),
      },
    }
  }
  if (type !== 'file') return undefined
  const { name, bytes } = ref
  if (typeof name !== 'string' || name === '') return undefined
  return {
    kind: 'file',
    file: {
      name,
      ...(typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0 ? { bytes } : {}),
    },
  }
}

/** Every renderable attachment of one content list, in block order. */
function attachmentsOf(content: readonly unknown[]): SidechatAttachment[] {
  const attachments: SidechatAttachment[] = []
  for (const block of content) {
    const attachment = attachmentOf(block)
    if (attachment !== undefined) attachments.push(attachment)
  }
  return attachments
}

/** Whether two narrowed attachment lists render the same thing (the row-reuse
 *  compare; the row objects keep their identity across polls when they do). */
function attachmentsEqual(a: readonly SidechatAttachment[] | undefined, b: readonly SidechatAttachment[] | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined || a.length !== b.length) return false
  return a.every((attachment, index) => {
    const peer = b[index]
    if (peer === undefined || peer.kind !== attachment.kind) return false
    if (attachment.kind === 'image') {
      const left = attachment.image
      const right = (peer as typeof attachment).image
      return left.attachmentId === right.attachmentId && left.mediaType === right.mediaType && left.name === right.name
    }
    const left = attachment.file
    const right = (peer as typeof attachment).file
    return left.name === right.name && left.bytes === right.bytes
  })
}

/** The provider failure message of one `llm/retry` (`{ kind, message? }`), or
 *  undefined when the producer recorded none — the row then carries no meta. */
function retryFailureMessage(failure: unknown): string | undefined {
  if (failure === null || typeof failure !== 'object') return undefined
  const message = (failure as { message?: unknown }).message
  return typeof message === 'string' && message !== '' ? message : undefined
}

/**
 * Whether one `tool/result` reports a FAILED invocation.
 *
 * The host channel is the tool-role message's own `isError` (`llm`'s
 * `ToolResultMessage`, and the flag its own produced-path scan reads); 0.1.6
 * logs carry the same flag on the wrapping `tool-result` block instead, which
 * this module reads everywhere else. A plugin-era `data.error` stays as the last
 * fallback so an older fixture or a foreign producer is still read as failed —
 * a tool that throws a BARE error (no `error.info`) sets `isError` and nothing
 * else, which is exactly the case the fallback alone missed.
 * @param data - one `tool/result` event's data record.
 * @returns true when the result is a failure.
 */
function resultFailed(data: Record<string, unknown>): boolean {
  const message = data.message as { isError?: unknown; content?: unknown } | undefined
  if (message?.isError === true) return true
  if (Array.isArray(message?.content)) {
    for (const block of message.content) {
      if (block === null || typeof block !== 'object') continue
      const wrapper = block as { type?: unknown; isError?: unknown }
      if (wrapper.type === 'tool-result' && wrapper.isError === true) return true
    }
  }
  return data.error !== undefined
}

/** The `image` / `file` blocks of a tool/result message's content list (under
 *  either logged shape — {@link resultBlocks}). */
function resultAttachmentsOf(data: Record<string, unknown>): SidechatAttachment[] {
  const message = data.message as { content?: unknown } | undefined
  const blocks = resultBlocks(message?.content)
  return blocks === undefined ? [] : attachmentsOf(blocks)
}

/** Parse the tool's raw arguments JSON to an object, or undefined (malformed
 *  JSON, a non-object, or an absent argument string). Shared with the file-
 *  mention vocabulary, which reads the same arguments. */
export function parseArgsObject(args: string | undefined): Record<string, unknown> | undefined {
  if (args === undefined) return undefined
  try {
    const parsed = JSON.parse(args) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * Narrow one delivered-file entry (`{ path, description? }`). The path is
 * kept verbatim: the card resolves it against the session cwd on click and
 * through the media route on render, so both the call-arguments spelling
 * (cwd-relative) and the event spelling (absolute) work unchanged. A
 * malformed entry declines the whole list: the call-arguments path then falls
 * back to the generic tool row, while the event path renders no card (an
 * event carries no call row of its own to fall back to).
 */
function deliverableOf(value: unknown): SidechatDeliverable | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { path, description } = value as { path?: unknown; description?: unknown }
  if (typeof path !== 'string' || path.trim() === '') return undefined
  if (description !== undefined && typeof description !== 'string') return undefined
  return { path, ...(description !== undefined && description !== '' ? { description } : {}) }
}

/** The `files` array of a `present` argument object or a
 *  `deliverables/presented` event, or undefined when the value is not one. */
function deliverableFiles(value: unknown): SidechatDeliverable[] | undefined {
  if (!Array.isArray(value)) return undefined
  const files: SidechatDeliverable[] = []
  for (const entry of value) {
    const file = deliverableOf(entry)
    if (file === undefined) return undefined
    files.push(file)
  }
  return files
}

/** The delivered files of a `present` tool call, or undefined when its
 *  arguments name none (the call then renders as the generic tool row). */
function presentCallFiles(args: string | undefined): SidechatDeliverable[] | undefined {
  const files = deliverableFiles(parseArgsObject(args)?.files)
  return files !== undefined && files.length > 0 ? files : undefined
}

/**
 * Call-time card from the raw `tool/call` arguments — the same literal cards
 * the host's own presenters derive before any result exists: bash shows the
 * command line (foreground only), edit/write show the literal replacement.
 * `read` has no call-time window (its structure only exists in the result).
 */
function callCard(name: string, args: string | undefined): SidechatToolCard | undefined {
  const parsed = parseArgsObject(args)
  if (parsed === undefined) return undefined
  if (name === 'bash') {
    const command = typeof parsed.command === 'string' && parsed.command !== '' ? parsed.command : undefined
    if (command === undefined || parsed.run_in_background === true) return undefined
    const cwd = typeof parsed.workdir === 'string' && parsed.workdir !== '' ? parsed.workdir : undefined
    return { type: 'terminal', command, ...(cwd !== undefined ? { cwd } : {}) }
  }
  if (name === 'edit' || name === 'write') {
    const path = typeof parsed.file_path === 'string' && parsed.file_path !== '' ? parsed.file_path : undefined
    if (path === undefined) return undefined
    if (name === 'edit') {
      const oldText = typeof parsed.old_string === 'string' ? parsed.old_string : ''
      const newText = typeof parsed.new_string === 'string' ? parsed.new_string : ''
      return { type: 'diff', diffs: [{ path, oldText: oldText === '' ? null : oldText, newText }] }
    }
    const newText = typeof parsed.content === 'string' ? parsed.content : ''
    return { type: 'diff', diffs: [{ path, oldText: null, newText }] }
  }
  return undefined
}

/** The `tool/result` `meta` as an object, or undefined (opaque tool payload). */
function metaObject(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const meta = data.meta
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  return meta as Record<string, unknown>
}

/** Narrow edit/write's contextual-diff meta (`{ diffs: FileDiff[] }`) to
 *  DiffHunk[], declining on any malformed entry. */
function diffCardFromMeta(meta: Record<string, unknown>): SidechatToolCard | undefined {
  const diffs = meta.diffs
  if (!Array.isArray(diffs) || diffs.length === 0) return undefined
  const hunks: DiffHunk[] = []
  for (const item of diffs) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
    const { path, oldText, newText } = item as Record<string, unknown>
    if (typeof path !== 'string' || typeof newText !== 'string') return undefined
    if (oldText !== null && typeof oldText !== 'string') return undefined
    hunks.push({ path, oldText, newText })
  }
  return { type: 'diff', diffs: hunks }
}

/** Narrow read's line-window meta (`{ path, offset, lines, totalLines, lang? }`)
 *  to a read card, enforcing the same semantic contract the host does: 1-based
 *  strictly increasing line numbers that never exceed `totalLines`. */
function readCardFromMeta(meta: Record<string, unknown>): SidechatToolCard | undefined {
  const { path, offset, lines, totalLines, lang } = meta
  if (typeof path !== 'string' || typeof offset !== 'number' || typeof totalLines !== 'number') return undefined
  if (!Number.isInteger(offset) || offset < 1) return undefined
  if (!Number.isInteger(totalLines) || totalLines < 0) return undefined
  if (!Array.isArray(lines)) return undefined
  const narrowed: ReadBlockLine[] = []
  let previous = offset - 1
  for (const line of lines) {
    if (line === null || typeof line !== 'object' || Array.isArray(line)) return undefined
    const candidate = line as { number?: unknown; text?: unknown }
    if (typeof candidate.number !== 'number' || !Number.isInteger(candidate.number)) return undefined
    if (candidate.number <= previous || candidate.number > totalLines) return undefined
    if (typeof candidate.text !== 'string') return undefined
    narrowed.push({ number: candidate.number, text: candidate.text })
    previous = candidate.number
  }
  if (lang !== undefined && typeof lang !== 'string') return undefined
  return { type: 'read', label: path, lines: narrowed, totalLines, ...(lang !== undefined ? { lang } : {}) }
}

/** The grouped matches of grep's meta (`files: [{ path, matches: [{ lineNumber, line }] }]`),
 *  or undefined when any entry is malformed — the host's own `searchFiles`
 *  narrowing (1-based integer line numbers, string paths/lines). */
function searchFiles(value: unknown): SearchFileGroup[] | undefined {
  if (!Array.isArray(value)) return undefined
  const files: SearchFileGroup[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined
    const { path, matches } = entry as Record<string, unknown>
    if (typeof path !== 'string' || !Array.isArray(matches)) return undefined
    const narrowed: SearchFileGroup['matches'] = []
    for (const match of matches) {
      if (match === null || typeof match !== 'object' || Array.isArray(match)) return undefined
      const { lineNumber, line } = match as Record<string, unknown>
      if (typeof lineNumber !== 'number' || !Number.isInteger(lineNumber) || lineNumber < 1) return undefined
      if (typeof line !== 'string') return undefined
      narrowed.push({ lineNumber, line })
    }
    files.push({ path, matches: narrowed })
  }
  return files
}

/** The cited sources of web_search's meta (`[{ url, title?, snippet?, publishedAt? }]`),
 *  or undefined when any entry is malformed (a URL is required; the three
 *  optional fields must be strings when present). */
function webSources(value: unknown): WebSourceView[] | undefined {
  if (!Array.isArray(value)) return undefined
  const sources: WebSourceView[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined
    const { url, title, snippet, publishedAt } = entry as Record<string, unknown>
    if (typeof url !== 'string') return undefined
    if (title !== undefined && typeof title !== 'string') return undefined
    if (snippet !== undefined && typeof snippet !== 'string') return undefined
    if (publishedAt !== undefined && typeof publishedAt !== 'string') return undefined
    sources.push({
      url,
      ...(title === undefined ? {} : { title }),
      ...(snippet === undefined ? {} : { snippet }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    })
  }
  return sources
}

/**
 * grep / glob's structured result, narrowed from `tool/result` `meta` alone —
 * never by parsing the result text, and never from the call's arguments (the
 * plugin only draws what the tool itself published). The narrowing is the
 * host's: an exact `shape`, a boolean `truncated`, a non-negative integer
 * `total`, and the shape's own arrays. Anything less keeps the generic row.
 */
function searchCardFromMeta(name: string, meta: Record<string, unknown>): SidechatToolCard | undefined {
  const { truncated, total, shape } = meta
  if (typeof truncated !== 'boolean') return undefined
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) return undefined
  if (name === 'grep') {
    if (shape !== 'matches') return undefined
    const files = searchFiles(meta.files)
    return files === undefined ? undefined : { type: 'search', card: { kind: 'matches', files, truncated, total } }
  }
  if (name !== 'glob' || shape !== 'paths' || !Array.isArray(meta.paths)) return undefined
  if (!meta.paths.every((path): path is string => typeof path === 'string')) return undefined
  return { type: 'search', card: { kind: 'paths', paths: [...meta.paths], truncated, total } }
}

/**
 * web_search / web_fetch's structured result, narrowed from `tool/result`
 * `meta` alone (see {@link searchCardFromMeta} for the same rules).
 */
function webCardFromMeta(name: string, meta: Record<string, unknown>): SidechatToolCard | undefined {
  const { truncated } = meta
  if (typeof truncated !== 'boolean') return undefined
  if (name === 'web_search') {
    const sources = webSources(meta.sources)
    if (sources === undefined) return undefined
    if (meta.answer !== undefined && typeof meta.answer !== 'string') return undefined
    const answer = typeof meta.answer === 'string' ? meta.answer : undefined
    return { type: 'web', card: { kind: 'search', sources, truncated, ...(answer === undefined ? {} : { answer }) } }
  }
  if (name !== 'web_fetch' || typeof meta.url !== 'string') return undefined
  const { statusCode } = meta
  if (typeof statusCode !== 'number' || !Number.isInteger(statusCode)) return undefined
  return { type: 'web', card: { kind: 'fetch', url: meta.url, statusCode, truncated } }
}

/** The bash result's trailing exit markers (`[exit code: N]` /
 *  `[killed by signal: X]` — the model-facing text the tool appends), stripped
 *  the same way the host's parseExitStatus recovers the exit pill. */
const EXIT_SIGNAL_RE = /\n\[killed by signal: ([^\]\n]+)\]$/
const EXIT_CODE_RE = /\n\[exit code: (\d+)\]$/

/**
 * Result-time card refinement: `meta`-carrying structure wins (edit/write's
 * applied hunks, read's line window, grep/glob's search card and web_search /
 * web_fetch's web card), bash's output gets its exit marker stripped into the
 * exit pill, and a failed result always falls back to the generic row (the
 * host's isError path renders generic output too).
 */
function resultCard(
  name: string,
  previous: SidechatToolCard | undefined,
  data: Record<string, unknown>,
  resultText: string,
): SidechatToolCard | undefined {
  if (name === 'bash') {
    if (previous === undefined || previous.type !== 'terminal' || resultText === '') return previous
    const signal = EXIT_SIGNAL_RE.exec(resultText)
    if (signal?.[1] !== undefined) {
      return { ...previous, output: resultText.slice(0, signal.index), exitCode: undefined, signal: signal[1] }
    }
    const exit = EXIT_CODE_RE.exec(resultText)
    if (exit?.[1] !== undefined) {
      return { ...previous, output: resultText.slice(0, exit.index), exitCode: Number(exit[1]), signal: undefined }
    }
    return { ...previous, output: resultText, exitCode: 0, signal: undefined }
  }
  const meta = metaObject(data)
  if (meta === undefined) return previous
  if (name === 'edit' || name === 'write') return diffCardFromMeta(meta) ?? previous
  if (name === 'read') return readCardFromMeta(meta)
  if (name === 'grep' || name === 'glob') return searchCardFromMeta(name, meta) ?? previous
  if (name === 'web_search' || name === 'web_fetch') return webCardFromMeta(name, meta) ?? previous
  return previous
}

/**
 * The human-readable text of one FAILURE reason, or undefined when the reason
 * is not an error. `turn/end` records the failure as `reason.error.message`
 * (the agent loop's own shape); an attempt's terminal `finish` chunk carries
 * the adapter-failure shape `reason.failure.message` (dsh-llm's
 * `adapterFailureChunk`). Neither present falls back to a plain string
 * rendering of the reason, so the row is never blank.
 */
function failureText(reason: unknown): string | undefined {
  if (reason === null || typeof reason !== 'object' || Array.isArray(reason)) return undefined
  const record = reason as Record<string, unknown>
  if (record.kind !== 'error') return undefined
  for (const candidate of [record.error, record.failure]) {
    if (candidate === null || typeof candidate !== 'object') continue
    const message = (candidate as { message?: unknown }).message
    if (typeof message === 'string' && message !== '') return message
  }
  return String(reason)
}

/**
 * The failure that an `assistant/attempt` carries in its durable stream: the
 * terminal `finish` chunk's `reason`. The record walk mirrors sidechat-core's
 * `streamTexts` (the same compact `AssistantStreamRecord[]` shape), only
 * reading the finish reason instead of the text chunks. Undefined when the
 * attempt ended any other way (`stop`, `max-tokens`, `aborted`, …).
 */
function attemptFailure(stream: unknown): string | undefined {
  if (!Array.isArray(stream)) return undefined
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    const entry = record as { type?: unknown; chunk?: unknown }
    if (entry.type !== 'chunk') continue
    const chunk = entry.chunk as { type?: unknown; reason?: unknown } | undefined
    if (chunk === null || typeof chunk !== 'object' || chunk.type !== 'finish') continue
    const text = failureText(chunk.reason)
    if (text !== undefined) return text
  }
  return undefined
}

/**
 * The TERMINAL state of a turn, or undefined when the reason is a normal finish
 * or a provider error (which gets its own row): `aborted` and `interrupted`
 * both mean "stopped before it finished", while `max-tokens` means the model hit
 * the output limit and the answer is cut off.
 */
function terminalReason(reason: unknown): 'aborted' | 'max-tokens' | undefined {
  if (reason === null || typeof reason !== 'object' || Array.isArray(reason)) return undefined
  const kind = (reason as { kind?: unknown }).kind
  if (kind === 'aborted' || kind === 'interrupted') return 'aborted'
  if (kind === 'max-tokens') return 'max-tokens'
  return undefined
}

/**
 * The terminal state an `assistant/attempt` carries in its durable stream: the
 * terminal `finish` chunk's reason (the same record walk as {@link attemptFailure},
 * read for the stop/limit kinds instead of errors). Undefined for every other
 * ending.
 */
function attemptTerminal(stream: unknown): 'aborted' | 'max-tokens' | undefined {
  if (!Array.isArray(stream)) return undefined
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    const entry = record as { type?: unknown; chunk?: unknown }
    if (entry.type !== 'chunk') continue
    const chunk = entry.chunk as { type?: unknown; reason?: unknown } | undefined
    if (chunk === null || typeof chunk !== 'object' || chunk.type !== 'finish') continue
    const terminal = terminalReason(chunk.reason)
    if (terminal !== undefined) return terminal
  }
  return undefined
}

/**
 * Map a thread child's history rows onto compact transcript rows: the
 * inherited fork seed is cut at the last `session/end-seed`, context
 * injections map onto a collapsible injection row, `assistant/live-chunk`
 * deltas accumulate into streaming rows per (turn, step, block) and are
 * superseded by the assembled `assistant/message`, and tool invocations
 * render one expandable line each (arguments, paired result text, failure
 * marker; a still-executing call is marked until its result lands). A failed
 * turn renders exactly one `error` row — the attempt's stream error and the
 * `turn/end` reason are the same failure.
 * @param entries - history rows (event + host-computed view) in seq order,
 *   the live deltas of the in-flight attempt appended after the durable tail.
 * @returns display rows in log order.
 */
export function transcriptRows(entries: readonly SidebarHistoryEntry[], prev?: readonly SidechatTranscriptRow[]): SidechatTranscriptRow[] {
  const events = threadOwnLogEvents(entries.map(entry => entry.event))
  const rows: SidechatTranscriptRow[] = []
  /** (turn, step, index, kind) key → index of its accumulating stream row. */
  const streamRows = new Map<string, number>()
  /** tool callId → index of its tool row in `rows` (result pairing). */
  const callRows = new Map<string, number>()
  /** present callId → its deliverables card: the card row's index plus the
   *  call's raw arguments (a FAILED result needs them to rebuild the generic
   *  tool row). A `deliverables/presented` event attaches to this card
   *  instead of appending a second one, in either arrival order. */
  const presentCalls = new Map<string, { rowIndex: number; args: string | undefined }>()
  /** turn → envelope time of its `turn/start` (turn-tail duration basis). */
  const turnStarts = new Map<number, number>()
  /** Turns that already rendered a failure row (an attempt error and the
   *  `turn/end` that follows it are the SAME failure — one row per turn). */
  const errorTurns = new Set<number>()
  /** Turns that already rendered a terminal row (same dedupe rule: the attempt's
   *  stop/limit finish reason and the `turn/end` that repeats it are one turn). */
  const terminalTurns = new Set<number>()
  /** turn → usage aggregate: output accumulates across steps, input takes the
   *  last request's prompt size (earlier steps' input is mostly the same
   *  context re-sent, so summing would double-count). */
  const turnUsage = new Map<number, { inputTokens: number; outputTokens: number }>()
  /** compactionId → the metering facts of its summary event. The checkpoint
   *  that shadows the range carries only ids: the summary text and the shadow
   *  price live in the `compaction/summary` logged immediately before it. */
  const compactionFacts = new Map<string, CompactionFacts>()
  /** The most recent metering facts (a checkpoint without a compactionId still
   *  pairs with the event directly before it — the documented adjacency). */
  let lastCompaction: CompactionFacts | undefined
  /** retryId → index of its retry row (a chain folds into one row). */
  const retryRows = new Map<string, number>()
  /**
   * Turns whose `turn/end` is in this log. Read UP FRONT (not while rows are
   * being built) so a work row can carry its turn's settledness at creation:
   * annotating afterwards would replace row objects on every pull and defeat
   * the identity pass below.
   */
  const endedTurns = new Set<number>()
  for (const event of events) {
    if (event.type !== 'turn/end') continue
    const turn = (event.data as Record<string, unknown>).turn
    if (typeof turn === 'number' && Number.isInteger(turn)) endedTurns.add(turn)
  }
  /** The turn annotations of one row, from its event's `data.turn`. */
  const turnFields = (turn: unknown): { turn?: number; turnEnded?: boolean } => {
    if (typeof turn !== 'number' || !Number.isInteger(turn)) return {}
    return { turn, ...(endedTurns.has(turn) ? { turnEnded: true } : {}) }
  }
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (event === undefined) continue
    const data = event.data as Record<string, unknown>
    switch (event.type) {
      case 'turn/start': {
        const turn = data.turn
        if (typeof turn === 'number' && Number.isInteger(turn)) turnStarts.set(turn, event.time)
        break
      }
      case 'turn/end': {
        const turn = data.turn
        if (typeof turn !== 'number' || !Number.isInteger(turn)) break
        const failure = failureText(data.reason)
        if (failure !== undefined && !errorTurns.has(turn)) {
          errorTurns.add(turn)
          rows.push({ kind: 'error', seq: event.seq, text: failure })
        }
        // A stop or an output-limit cut is not an error, but it must not look
        // like a deliberate finish either: one terminal row per turn.
        const terminal = terminalReason(data.reason)
        if (terminal !== undefined && !terminalTurns.has(turn)) {
          terminalTurns.add(turn)
          rows.push({ kind: 'terminal', seq: event.seq, reason: terminal })
        }
        const start = turnStarts.get(turn)
        turnStarts.delete(turn)
        const usage = turnUsage.get(turn)
        turnUsage.delete(turn)
        const durationMs = start !== undefined ? Math.max(0, event.time - start) : undefined
        if (usage === undefined && durationMs === undefined) break
        rows.push({
          kind: 'turnSummary',
          seq: event.seq,
          turn,
          ...(usage !== undefined ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
        })
        break
      }
      case 'assistant/attempt': {
        // A failed attempt settles durably WITHOUT a message: the visible
        // error row is the finish chunk's reason (the turn/end that follows
        // repeats the same failure and must not render it twice).
        const turn = data.turn
        if (typeof turn !== 'number' || !Number.isInteger(turn)) break
        if (!errorTurns.has(turn)) {
          const failure = attemptFailure(data.stream)
          if (failure !== undefined) {
            errorTurns.add(turn)
            rows.push({ kind: 'error', seq: event.seq, text: failure })
          }
        }
        // A stopped / output-limit attempt settles the same way, with the same
        // "one row per turn" rule (the turn/end that follows repeats it).
        if (!terminalTurns.has(turn)) {
          const terminal = attemptTerminal(data.stream)
          if (terminal !== undefined) {
            terminalTurns.add(turn)
            rows.push({ kind: 'terminal', seq: event.seq, reason: terminal })
          }
        }
        break
      }
      case 'user/message': {
        const content = Array.isArray(data.content) ? data.content : []
        const attachments = attachmentsOf(content)
        const projected = projectSidechatContent(data.content, '\n\n')
        // An attachment-only message is not a "…" row: the thumbnail IS its
        // content (the placeholder exists for a message with nothing to show).
        const hasVisual = attachments.length > 0 || projected.images !== undefined
        const text = projected.text === '' ? (hasVisual ? '' : '…') : projected.text
        // The durable identity the pending-row dedupe keys on (absent on logs
        // written before the field existed, and on the loose fixtures).
        const messageId = typeof data.id === 'string' && data.id !== '' ? data.id : undefined
        // A REPLACEMENT message is not a message: the host draws it as the node
        // that shadowed a surface range. This must come BEFORE the injection
        // predicate — a checkpoint's `source.kind` is not 'user', so the
        // injection branch would swallow the whole compacted summary into a
        // "context injected" row and hide the fact that history was compacted.
        const surfaceOp = (event as { surfaceOp?: unknown }).surfaceOp
        if (surfaceOp !== undefined && surfaceOp !== 'append') {
          const source = data.source as { kind?: unknown; compactionId?: unknown } | undefined
          if (source?.kind === 'compact-checkpoint') {
            const id = typeof source.compactionId === 'string' ? source.compactionId : undefined
            const facts = (id === undefined ? undefined : compactionFacts.get(id)) ?? lastCompaction
            const summary = facts?.summary ?? null
            rows.push({
              kind: 'compaction',
              seq: event.seq,
              text: summary ?? '',
              summary,
              shadowedItemCount: facts?.shadowedItemCount ?? null,
              shadowedTokenCount: facts?.shadowedTokenCount ?? null,
            })
          }
          break
        }
        // Context injections (the boundary prompt + snapshot, plugin-sourced
        // context) collapse into an injection row; genuine user messages —
        // including the FIRST one, which the host now delivers as its own
        // event — render as user rows.
        if (isContextInjectionMessage(data)) {
          const source = data.source as { kind?: unknown } | undefined
          // Threads logged BEFORE the host split carry boundary(+snapshot)+
          // question in ONE 'user' message. The boundary prompt is a known
          // constant, so the message splits THERE: the injection row keeps
          // the prompt, the remainder (snapshot + question if any — pure
          // question in the common case) renders as the user's real message.
          if (source?.kind === 'user' && text.startsWith(`${SIDE_BOUNDARY_PROMPT}\n\n`)) {
            rows.push({ kind: 'injection', seq: event.seq, text: SIDE_BOUNDARY_PROMPT })
            const body = text.slice(SIDE_BOUNDARY_PROMPT.length + 2)
            if (body !== '' || attachments.length > 0) {
              rows.push({
                kind: 'user',
                seq: event.seq,
                text: body,
                ...(messageId !== undefined ? { messageId } : {}),
                ...(attachments.length > 0 ? { attachments } : {}),
              })
            }
            break
          }
          rows.push({ kind: 'injection', seq: event.seq, text })
          break
        }
        rows.push({
          kind: 'user',
          seq: event.seq,
          ...projected,
          text,
          ...(messageId !== undefined ? { messageId } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        })
        break
      }
      case 'compaction/summary': {
        // The metering event: it prices the replacement logged right after it.
        const id = typeof data.compactionId === 'string' ? data.compactionId : undefined
        const summary = joinedText(Array.isArray(data.summary) ? data.summary : [])
        const shadowed = data.shadowedSeqs
        const tokens = data.shadowedTokenCount
        const facts: CompactionFacts = {
          summary: summary === '' ? null : summary,
          shadowedItemCount: Array.isArray(shadowed) ? shadowed.length : null,
          shadowedTokenCount: typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : null,
        }
        if (id !== undefined) compactionFacts.set(id, facts)
        lastCompaction = facts
        break
      }
      case 'llm/retry': {
        // One row per retryId (the producer's chain identity), so a chain of
        // attempts reads as "retried N times" instead of N silent gaps.
        const retryId = data.retryId
        if (typeof retryId !== 'string' || retryId === '') break
        const retry = data.retry
        if (typeof retry !== 'number' || !Number.isInteger(retry) || retry < 1) break
        const maxRetries = data.maxRetries
        const delayMs = data.delayMs
        const provider = data.provider
        const failureMessage = retryFailureMessage(data.failure)
        const index = retryRows.get(retryId)
        const existing = index === undefined ? undefined : rows[index]
        const update = {
          retry,
          state: 'scheduled' as const,
          ...(typeof maxRetries === 'number' && Number.isInteger(maxRetries) ? { maxRetries } : {}),
          ...(typeof delayMs === 'number' && Number.isFinite(delayMs) ? { delayMs } : {}),
          ...(typeof provider === 'string' && provider !== '' ? { provider } : {}),
          ...(failureMessage === undefined ? {} : { failureMessage }),
        }
        if (existing !== undefined && existing.kind === 'retry') {
          // A further attempt REPLACES the row's facts but keeps the chain's
          // first seq (the reader sees one row where the chain began).
          rows[index as number] = { ...existing, ...update }
          break
        }
        retryRows.set(retryId, rows.length)
        rows.push({ kind: 'retry', seq: event.seq, ...update })
        break
      }
      case 'llm/retry-started': {
        // The wait ended: the SAME row flips to `started`, no second row.
        const retryId = data.retryId
        if (typeof retryId !== 'string' || retryId === '') break
        const index = retryRows.get(retryId)
        const row = index === undefined ? undefined : rows[index]
        if (row !== undefined && row.kind === 'retry') rows[index as number] = { ...row, state: 'started' }
        break
      }
      case 'assistant/live-chunk': {
        const chunk = data.chunk as { type?: unknown; text?: unknown } | undefined
        if (chunk === null || typeof chunk !== 'object') break
        const kind = chunk.type === 'text-delta' ? 'assistant' : chunk.type === 'reasoning-delta' ? 'reasoning' : null
        if (kind === null || typeof chunk.text !== 'string' || chunk.text === '') break
        const turn = data.turn
        const step = data.step
        const blockIndex = (chunk as { index?: unknown }).index
        const key = `${String(turn)}:${String(step)}:${String(blockIndex)}:${kind}`
        const existing = streamRows.get(key)
        if (existing !== undefined) {
          const row = rows[existing]
          if (row !== undefined && row.kind === kind && !row.settled) {
            rows[existing] = { ...row, text: row.text + chunk.text }
          }
        } else {
          streamRows.set(key, rows.length)
          rows.push({ kind, seq: event.seq, text: chunk.text, settled: false,
            ...(typeof blockIndex === 'number' && Number.isSafeInteger(blockIndex) && blockIndex >= 0
              ? { contentBlockIndex: blockIndex } : {}),
            ...(kind === 'reasoning' ? turnFields(data.turn) : {}),
          })
        }
        break
      }
      case 'assistant/message': {
        // Turn-tail usage: each assembled message carries its step's token
        // accounting (absent when the adapter reported none).
        const usageTurn = data.turn
        if (typeof usageTurn === 'number' && Number.isInteger(usageTurn)) {
          const usage = data.usage as { inputTokens?: unknown; outputTokens?: unknown } | undefined
          const input = typeof usage?.inputTokens === 'number' ? usage.inputTokens : undefined
          const output = typeof usage?.outputTokens === 'number' ? usage.outputTokens : undefined
          if (input !== undefined && output !== undefined) {
            const aggregate = turnUsage.get(usageTurn)
            if (aggregate === undefined) turnUsage.set(usageTurn, { inputTokens: input, outputTokens: output })
            else turnUsage.set(usageTurn, { inputTokens: input, outputTokens: aggregate.outputTokens + output })
          }
        }
        const prefix = `${String(data.turn)}:${String(data.step)}:`
        const streamed = [...streamRows.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([, rowIndex]) => rowIndex)
        for (const key of [...streamRows.keys()]) {
          if (key.startsWith(prefix)) streamRows.delete(key)
        }
        const content = Array.isArray((data.message as { content?: unknown } | undefined)?.content)
          ? (data.message as { content: readonly unknown[] }).content
          : []
        const settled: SidechatTranscriptRow[] = content.flatMap((block, contentBlockIndex): SidechatTranscriptRow[] => {
          if (block === null || typeof block !== 'object') return []
          const candidate = block as { type?: unknown; text?: unknown }
          if (candidate.type === 'reasoning' && typeof candidate.text === 'string' && candidate.text !== '') {
            return [{
              kind: 'reasoning',
              seq: event.seq,
              text: candidate.text,
              settled: true,
              contentBlockIndex,
              ...turnFields(data.turn),
            }]
          }
          if (candidate.type === 'text' && typeof candidate.text === 'string' && candidate.text !== '') {
            return [{ kind: 'assistant', seq: event.seq, text: candidate.text, settled: true, contentBlockIndex }]
          }
          const attachment = attachmentOf(block)
          if (attachment !== undefined) {
            return [{ kind: 'attachment', seq: event.seq, attachment, contentBlockIndex }]
          }
          return []
        })
        if (streamed.length === 0) rows.push(...settled)
        else rows.splice(Math.min(...streamed), streamed.length, ...settled)
        break
      }
      case 'tool/call': {
        const callId = data.callId
        const name = typeof data.name === 'string' ? data.name : 'tool'
        const args = typeof data.arguments === 'string' ? data.arguments : undefined
        // A present call renders as its deliverables card, not a tool row.
        // Its arguments are the pre-event copy a later deliverables/presented
        // event refines; when the event already drew the card, keep that card
        // and record the arguments only for a possible failed result.
        if (name === 'present') {
          // Event-first: the deliverables event already drew this call's card
          // (the event reached the window before the call). The event is
          // authoritative, so keep its files and only record the arguments a
          // failed result needs.
          if (typeof callId === 'string') {
            const existing = presentCalls.get(callId)
            if (existing !== undefined) {
              presentCalls.set(callId, { ...existing, args })
              break
            }
          }
          const files = presentCallFiles(args)
          if (files !== undefined) {
            if (typeof callId === 'string') presentCalls.set(callId, { rowIndex: rows.length, args })
            rows.push({ kind: 'deliverables', seq: event.seq, ...(typeof callId === 'string' ? { callId } : {}), files })
            break
          }
        }
        const card = callCard(name, args)
        const rowIndex = rows.length
        if (typeof callId === 'string') callRows.set(callId, rowIndex)
        rows.push({
          kind: 'tool',
          seq: event.seq,
          name,
          failed: false,
          args,
          executing: true,
          ...(card !== undefined ? { card } : {}),
          ...turnFields(data.turn),
        })
        break
      }
      case 'tool/result': {
        const source = data.message as { source?: { callId?: unknown } } | undefined
        const callId = typeof source?.source?.callId === 'string' ? source.source.callId : undefined
        const resultText = resultTextOf(data)
        // A present call's result is not a row: its deliverables card already
        // shows what was delivered (and the event supersedes that copy). A
        // FAILED present delivered nothing, so its card is replaced by the
        // generic failed tool row the call rendered before the card existed,
        // and the call stops being associated with a card.
        const present = callId === undefined ? undefined : presentCalls.get(callId)
        if (callId !== undefined && present !== undefined) {
          if (resultFailed(data)) {
            presentCalls.delete(callId)
            const card = rows[present.rowIndex]
            if (card !== undefined && card.kind === 'deliverables') {
              rows[present.rowIndex] = {
                kind: 'tool',
                seq: card.seq,
                name: 'present',
                failed: true,
                ...(present.args !== undefined ? { args: present.args } : {}),
                ...(resultText !== '' ? { resultText } : {}),
                executing: false,
              }
            }
          }
          break
        }
        const rowIndex = callId === undefined ? undefined : callRows.get(callId)
        const failed = resultFailed(data)
        // A result's own image/file blocks belong to the row whose call
        // produced them (they render inside its disclosed body).
        const resultAttachments = resultAttachmentsOf(data)
        if (rowIndex !== undefined) {
          const row = rows[rowIndex]
          if (row !== undefined && row.kind === 'tool') {
            // Failed results render the generic row (the host's isError path
            // skips its structured cards too); otherwise the result's own
            // structure — meta hunks/windows, bash's exit marker — refines or
            // replaces the call-time literal card.
            const card = failed ? undefined : resultCard(row.name, row.card, data, resultText)
            rows[rowIndex] = {
              ...row,
              failed: row.failed || failed,
              resultText: resultText === '' ? row.resultText : resultText,
              executing: false,
              ...(card !== undefined ? { card } : { card: undefined }),
              ...(resultAttachments.length > 0 ? { resultAttachments } : {}),
            }
          }
        } else if (failed || resultText !== '' || resultAttachments.length > 0) {
          // Orphan result (no call row in the window): surface it so the row
          // stays informative and expandable.
          rows.push({
            kind: 'tool',
            seq: event.seq,
            name: callId === undefined ? 'tool' : `tool:${callId.slice(0, 8)}`,
            failed,
            resultText: resultText === '' ? undefined : resultText,
            ...(resultAttachments.length > 0 ? { resultAttachments } : {}),
          })
        }
        break
      }
      case 'deliverables/presented': {
        // The authoritative delivery record (`files[].path` absolute, plus the
        // model's descriptions). It attaches to its call's card by callId —
        // one card per call — and stands on its own when the call row is not
        // in the window (the events route caps the window's head, so this
        // event can be served without its earlier call).
        const files = deliverableFiles(data.files)
        if (files === undefined || files.length === 0) break
        const callId = typeof data.callId === 'string' ? data.callId : undefined
        const existing = callId === undefined ? undefined : presentCalls.get(callId)
        const card = existing === undefined ? undefined : rows[existing.rowIndex]
        if (existing !== undefined && card !== undefined && card.kind === 'deliverables') {
          rows[existing.rowIndex] = { ...card, files }
          break
        }
        if (callId !== undefined) presentCalls.set(callId, { rowIndex: rows.length, args: undefined })
        rows.push({ kind: 'deliverables', seq: event.seq, ...(callId !== undefined ? { callId } : {}), files })
        break
      }
      default: {
        break
      }
    }
  }
  return reuseRows(rows, prev)
}

/** A single assistant event can have multiple text/reasoning blocks. Keep the
 * original block index (including skipped blocks), not a filtered row index. */
export function sidechatRowKey(row: SidechatTranscriptRow): string {
  // Per-content-block rows share their event's seq, so the block index is what
  // keeps their keys unique (one message may carry several blocks).
  return row.kind === 'assistant' || row.kind === 'reasoning' || row.kind === 'attachment'
    ? `${row.kind}:${row.seq}:${row.contentBlockIndex ?? 'unknown'}`
    : `${row.kind}:${row.seq}`
}

/** The turn annotation of one row (absent for the kinds that carry none). */
function turnAnnotationOf(row: SidechatTranscriptRow): { turn?: number; turnEnded?: boolean } {
  return row.kind === 'reasoning' || row.kind === 'tool' ? row : {}
}

/** Whether two rows carry identical display content (identity fields plus
 *  every rendered field of their kind). */
function rowsEqual(a: SidechatTranscriptRow, b: SidechatTranscriptRow): boolean {
  if (a.kind !== b.kind || a.seq !== b.seq) return false
  switch (a.kind) {
    case 'user': {
      const other = b as typeof a
      return a.text === other.text && a.messageId === other.messageId
        && JSON.stringify(a.images) === JSON.stringify(other.images)
        && attachmentsEqual(a.attachments, other.attachments)
    }
    case 'injection':
    case 'error': {
      const other = b as typeof a
      return a.text === other.text
    }
    case 'assistant':
    case 'reasoning': {
      const other = b as typeof a
      // The turn annotation is compared too: `turnEnded` flips when the turn
      // ends, and a row re-adopted with the old flag would never fold.
      const left = turnAnnotationOf(a)
      const right = turnAnnotationOf(b)
      return a.text === other.text && a.settled === other.settled
        && a.contentBlockIndex === other.contentBlockIndex
        && left.turn === right.turn && left.turnEnded === right.turnEnded
    }
    case 'tool': {
      // The card is NOT compared by value: its content is a pure function of
      // the call-time args and the tool/result landing, and every transition
      // (output/exit arriving) flips `executing`/`failed`/`resultText` —
      // compared here — so a card whose content changed never slips through
      // an equal compare, and an equal compare re-adopting the OLD card
      // object (identical content, stale reference) only helps React skip.
      const other = b as typeof a
      const left = turnAnnotationOf(a)
      const right = turnAnnotationOf(b)
      return a.name === other.name && a.failed === other.failed && a.args === other.args
        && a.resultText === other.resultText && a.executing === other.executing
        && attachmentsEqual(a.resultAttachments, other.resultAttachments)
        && left.turn === right.turn && left.turnEnded === right.turnEnded
    }
    case 'deliverables': {
      const other = b as typeof a
      if (a.callId !== other.callId || a.files.length !== other.files.length) return false
      return a.files.every((file, index) => {
        const peer = other.files[index]
        return peer !== undefined && file.path === peer.path && file.description === peer.description
      })
    }
    case 'turnSummary': {
      const other = b as typeof a
      return a.turn === other.turn
        && a.inputTokens === other.inputTokens && a.outputTokens === other.outputTokens
        && a.durationMs === other.durationMs
    }
    case 'terminal': {
      const other = b as typeof a
      return a.reason === other.reason
    }
    case 'compaction': {
      const other = b as typeof a
      return a.text === other.text && a.summary === other.summary
        && a.shadowedItemCount === other.shadowedItemCount
        && a.shadowedTokenCount === other.shadowedTokenCount
    }
    case 'retry': {
      const other = b as typeof a
      return a.retry === other.retry && a.state === other.state
        && a.maxRetries === other.maxRetries && a.delayMs === other.delayMs
        && a.provider === other.provider && a.failureMessage === other.failureMessage
    }
    case 'attachment': {
      const other = b as typeof a
      return a.contentBlockIndex === other.contentBlockIndex
        && attachmentsEqual([a.attachment], [other.attachment])
    }
  }
}

/** Re-adopt the PREVIOUS poll's row objects wherever the content is
 *  unchanged (position-aligned, append-mostly): settled rows keep their
 *  object identity across the transcript pulls, so React's reconciler and the
 *  markdown/DOMPurify caches downstream skip them instead of re-rendering
 *  the whole transcript every poll. Comparing the strings is far cheaper
 *  than what a fresh reference costs the row below. Rows past the first
 *  mismatch (an inserted/superseded streaming row) rebuild as usual — that
 *  is exactly the changed tail. */
function reuseRows(rows: SidechatTranscriptRow[], prev: readonly SidechatTranscriptRow[] | undefined): SidechatTranscriptRow[] {
  if (prev === undefined) return rows
  const shared = Math.min(rows.length, prev.length)
  for (let index = 0; index < shared; index++) {
    const before = prev[index]
    const after = rows[index]
    if (before === undefined || after === undefined) continue
    if (rowsEqual(before, after)) rows[index] = before
  }
  return rows
}
