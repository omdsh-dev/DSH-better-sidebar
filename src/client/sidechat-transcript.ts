/**
 * Side Chat transcript mapping (browser half): turns a thread child's own
 * events (`sidechat.events` — the plugin route, which reads the log without
 * activating the child and cuts the inherited seed host-side) into compact
 * display rows.
 *
 * A thread child's log starts with the ENTIRE inherited parent log as its
 * fork seed. The route already cuts everything up to the LAST
 * `session/end-seed` marker; the mapping re-applies the same cut so any
 * seed event that somehow crosses the wire still never renders, and maps
 * context injections (the "Side conversation boundary" prompt,
 * plugin-sourced context) onto a collapsible injection row, so the view
 * shows only the thread's own conversation.
 *
 * Live streaming: `assistant/message` events only land when a step
 * completes, but `assistant/chunk` events stream token-level text and
 * reasoning deltas. The mapping accumulates both per block and supersedes
 * them with the assembled message once it lands (settled rows).
 */
import type { DiffHunk, ReadBlockLine } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarHistoryEntry } from '../context-types.ts'
import { isContextInjectionMessage, SIDE_BOUNDARY_PROMPT } from '../sidechat-core.ts'

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

/** One compact transcript row rendered in the thread view. `seq` is the
 *  source event's log sequence — stable row identity for React keys across
 *  polls (streaming caches ride the key, so window slides must not re-key
 *  rows). */
export type SidechatTranscriptRow =
  | { kind: 'user'; seq: number; text: string }
  /** A context injection (the side boundary prompt + the parked in-progress
   *  snapshot, or any plugin-sourced context): rendered as one collapsible
   *  row, never as a user bubble. */
  | { kind: 'injection'; seq: number; text: string }
  /** `settled` distinguishes an assembled message from a still-streaming
   *  chunk accumulation (streaming rows are superseded by the settle). */
  | { kind: 'assistant'; seq: number; text: string; settled: boolean }
  | { kind: 'reasoning'; seq: number; text: string; settled: boolean }
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
  }
  /** One turn's tail metrics, emitted at `turn/end`: the turn's token usage
   *  (aggregated from `assistant/message.usage`) and wall duration (envelope
   *  time delta from `turn/start`), whichever are computable. */
  | { kind: 'turnSummary'; seq: number; inputTokens?: number; outputTokens?: number; durationMs?: number }

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

/** Extract the visible text of a content-block list (`text` blocks verbatim,
 *  joined by blank lines); empty reads `…` so rows never render blank. */
export function blockText(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') {
      parts.push(candidate.text)
    }
  }
  const text = parts.join('\n\n')
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
 * One-line summary of a tool call's raw arguments JSON for the collapsed
 * row: the first identifying string field when the JSON parses, else the
 * flattened raw text; empty when there is nothing worth showing.
 */
export function toolArgsSummary(args: string | undefined): string {
  if (args === undefined) return ''
  try {
    const parsed = JSON.parse(args) as Record<string, unknown> | null
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of ARGS_SUMMARY_KEYS) {
        const value = parsed[key]
        if (typeof value === 'string' && value.trim() !== '') return flatTruncate(value)
      }
    }
  } catch {
    // Raw text fallthrough.
  }
  return flatTruncate(args)
}

/** The plain text of a tool/result message (text blocks inside its
 *  `tool-result` content block). */
function resultTextOf(data: Record<string, unknown>): string {
  const message = data.message as { content?: unknown } | undefined
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { type?: unknown; content?: unknown }
    if (candidate.type !== 'tool-result') continue
    const inner = candidate.content
    if (!Array.isArray(inner)) continue
    for (const item of inner) {
      if (item === null || typeof item !== 'object') continue
      const textItem = item as { type?: unknown; text?: unknown }
      if (textItem.type === 'text' && typeof textItem.text === 'string') {
        parts.push(textItem.text)
      }
    }
  }
  return parts.join('\n')
}

/** Index of the last `session/end-seed` event (fork seed marker), or -1. */
function lastSeedEnd(events: readonly { type: string }[]): number {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index]?.type === 'session/end-seed') return index
  }
  return -1
}

/** Parse the tool's raw arguments JSON to an object, or undefined. */
function parseArgsObject(args: string | undefined): Record<string, unknown> | undefined {
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

/** The bash result's trailing exit markers (`[exit code: N]` /
 *  `[killed by signal: X]` — the model-facing text the tool appends), stripped
 *  the same way the host's parseExitStatus recovers the exit pill. */
const EXIT_SIGNAL_RE = /\n\[killed by signal: ([^\]\n]+)\]$/
const EXIT_CODE_RE = /\n\[exit code: (\d+)\]$/

/**
 * Result-time card refinement: `meta`-carrying structure wins (edit/write's
 * applied hunks, read's line window), bash's output gets its exit marker
 * stripped into the exit pill, and a failed result always falls back to the
 * generic row (the host's isError path renders generic output too).
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
  return previous
}

/**
 * Map a thread child's history rows onto compact transcript rows: the
 * inherited fork seed is cut at the last `session/end-seed`, context
 * injections map onto a collapsible injection row, `assistant/chunk`
 * deltas accumulate into streaming rows per (turn, step, block) and are
 * superseded by the assembled `assistant/message`, and tool invocations
 * render one expandable line each (arguments, paired result text, failure
 * marker; a still-executing call is marked until its result lands).
 * @param entries - history rows (event + host-computed view) in seq order.
 * @returns display rows in log order.
 */
export function transcriptRows(entries: readonly SidebarHistoryEntry[], prev?: readonly SidechatTranscriptRow[]): SidechatTranscriptRow[] {
  const events = entries.map(entry => entry.event)
  const seedEnd = lastSeedEnd(events)
  const rows: SidechatTranscriptRow[] = []
  /** (turn, step, index, kind) key → index of its accumulating stream row. */
  const streamRows = new Map<string, number>()
  /** tool callId → index of its tool row in `rows` (result pairing). */
  const callRows = new Map<string, number>()
  /** turn → envelope time of its `turn/start` (turn-tail duration basis). */
  const turnStarts = new Map<number, number>()
  /** turn → usage aggregate: output accumulates across steps, input takes the
   *  last request's prompt size (earlier steps' input is mostly the same
   *  context re-sent, so summing would double-count). */
  const turnUsage = new Map<number, { inputTokens: number; outputTokens: number }>()
  for (let index = 0; index < events.length; index++) {
    if (index <= seedEnd) continue
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
        const start = turnStarts.get(turn)
        turnStarts.delete(turn)
        const usage = turnUsage.get(turn)
        turnUsage.delete(turn)
        const durationMs = start !== undefined ? Math.max(0, event.time - start) : undefined
        if (usage === undefined && durationMs === undefined) break
        rows.push({
          kind: 'turnSummary',
          seq: event.seq,
          ...(usage !== undefined ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
        })
        break
      }
      case 'user/message': {
        const text = blockText(Array.isArray(data.content) ? data.content : [])
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
            if (body !== '') rows.push({ kind: 'user', seq: event.seq, text: body })
            break
          }
          rows.push({ kind: 'injection', seq: event.seq, text })
          break
        }
        rows.push({ kind: 'user', seq: event.seq, text })
        break
      }
      case 'assistant/chunk': {
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
          rows.push({ kind, seq: event.seq, text: chunk.text, settled: false })
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
        const settled: SidechatTranscriptRow[] = content.flatMap((block): SidechatTranscriptRow[] => {
          if (block === null || typeof block !== 'object') return []
          const candidate = block as { type?: unknown; text?: unknown }
          if (candidate.type === 'reasoning' && typeof candidate.text === 'string' && candidate.text !== '') {
            return [{ kind: 'reasoning', seq: event.seq, text: candidate.text, settled: true }]
          }
          if (candidate.type === 'text' && typeof candidate.text === 'string' && candidate.text !== '') {
            return [{ kind: 'assistant', seq: event.seq, text: candidate.text, settled: true }]
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
        const card = callCard(name, args)
        const rowIndex = rows.length
        if (typeof callId === 'string') callRows.set(callId, rowIndex)
        rows.push({ kind: 'tool', seq: event.seq, name, failed: false, args, executing: true, ...(card !== undefined ? { card } : {}) })
        break
      }
      case 'tool/result': {
        const source = data.message as { source?: { callId?: unknown } } | undefined
        const callId = typeof source?.source?.callId === 'string' ? source.source.callId : undefined
        const rowIndex = callId === undefined ? undefined : callRows.get(callId)
        const failed = data.error !== undefined
        const resultText = resultTextOf(data)
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
            }
          }
        } else if (failed || resultText !== '') {
          // Orphan result (no call row in the window): surface it so the row
          // stays informative and expandable.
          rows.push({
            kind: 'tool',
            seq: event.seq,
            name: callId === undefined ? 'tool' : `tool:${callId.slice(0, 8)}`,
            failed,
            resultText: resultText === '' ? undefined : resultText,
          })
        }
        break
      }
      default: {
        break
      }
    }
  }
  return reuseRows(rows, prev)
}

/** Whether two rows carry identical display content (identity fields plus
 *  every rendered field of their kind). */
function rowsEqual(a: SidechatTranscriptRow, b: SidechatTranscriptRow): boolean {
  if (a.kind !== b.kind || a.seq !== b.seq) return false
  switch (a.kind) {
    case 'user':
    case 'injection': {
      const other = b as typeof a
      return a.text === other.text
    }
    case 'assistant':
    case 'reasoning': {
      const other = b as typeof a
      return a.text === other.text && a.settled === other.settled
    }
    case 'tool': {
      // The card is NOT compared by value: its content is a pure function of
      // the call-time args and the tool/result landing, and every transition
      // (output/exit arriving) flips `executing`/`failed`/`resultText` —
      // compared here — so a card whose content changed never slips through
      // an equal compare, and an equal compare re-adopting the OLD card
      // object (identical content, stale reference) only helps React skip.
      const other = b as typeof a
      return a.name === other.name && a.failed === other.failed && a.args === other.args
        && a.resultText === other.resultText && a.executing === other.executing
    }
    case 'turnSummary': {
      const other = b as typeof a
      return a.inputTokens === other.inputTokens && a.outputTokens === other.outputTokens
        && a.durationMs === other.durationMs
    }
  }
}

/** Re-adopt the PREVIOUS poll's row objects wherever the content is
 *  unchanged (position-aligned, append-mostly): settled rows keep their
 *  object identity across the 2s polls, so React's reconciler and the
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
