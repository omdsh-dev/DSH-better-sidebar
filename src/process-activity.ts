/**
 * The plugin's port of the MAIN AGENT's merged "process" display: the compact
 * activity summary DSH's chat shows for a range of tool calls.
 *
 * The host computes that summary over materialized Chat nodes inside
 * `@deepseek-ai/dsh-client-ui-chat` (`conversation-nodes/process-activity.js`
 * → `activity()` / `liveToolDetail()` / `processActivity()`, rendered by
 * `ProcessGroupHeader`). None of it is exported — the client bundle's only
 * runtime exports are `apply`/`inject`/`isRunningTool`/`isSettledTool` — so a
 * surface that has only a SESSION EVENT LOG (a subagent's, which the chat view
 * never materializes) must reproduce the algorithm. This module is that
 * reproduction, kept framework-free so the host route and the node test
 * environment share one implementation.
 *
 * Faithful points, all deliberate:
 *
 * - the tool NAME → category map is copied verbatim (including the
 *   `terminal_` prefix rule and the `*_inspect` suffix rule);
 * - `counts` ranks by distinct-call count descending, ties broken by first
 *   appearance (the host relies on `Array.sort` stability + Map insertion
 *   order);
 * - the running tool is the LAST unsettled call, and a "preparing" call (one
 *   the model announced but never dispatched) counts and can be the running
 *   one, exactly like the host's `PreparingToolCall` branch;
 * - `runningDetail` walks the host's key list in order and truncates the same
 *   way;
 * - the range is cut where the host's process GROUPS are cut: at a
 *   `user/message` and at every assistant message that carries text
 *   (`TurnGroups.rebuild`'s `INDEPENDENT` set plus its `reply(node)` flush).
 *
 * Deliberate deviations, all forced by the input:
 *
 * - the host's `runningDetail` falls back to the last REASONING paragraph of a
 *   running assistant step; a durable log carries no partial step, so the
 *   fallback is omitted (the label then reads as the "thinking" default);
 * - the host reads `arguments` only for a dispatched call; a durable
 *   `assistant/message` already carries the announced block's `arguments`, but
 *   the preparing detail still follows the host (no detail at all) so both
 *   sides read the same;
 * - an unsettled call at the tail of a SETTLED session is reported as not
 *   running ({@link foldProcess}'s `live: false`), mirroring the host's
 *   `closed` groups (`summary = { counts, running: undefined, runningDetail: '' }`);
 * - when the NEWEST range holds no call at all (the child just replied), the
 *   fold reports the previous range instead — a card whose bar read "已完成分析"
 *   because the last thing that happened was a sentence would tell the reader
 *   nothing. The fallback range is never reported as running.
 *
 * This module deliberately does NOT build a per-STAGE list: the Tasks page
 * marks workflow phases with a badge + colour instead (see tasks-model.ts), so
 * only the current range's summary is derived here.
 */
import type { SidebarSessionEvent } from './context-types.ts'

/** The host's `ProcessActivity` union, verbatim. */
export type ProcessActivity =
  | 'read' | 'readImage' | 'search' | 'write' | 'edit' | 'commands' | 'code'
  | 'webSearch' | 'webFetch' | 'subagents' | 'plan' | 'questions' | 'tools'

/**
 * The host's `ProcessActivitySummary` shape: the ranked work of one range plus
 * the live task detail. `preparing` exists only while the selected live
 * activity has not reached its `tool/call` event.
 */
export interface ProcessActivitySummary {
  counts: { kind: ProcessActivity; count: number }[]
  running?: ProcessActivity
  runningDetail: string
  preparing?: true
}

/** One fold result: the newest range's summary plus the newest text line. */
export interface ProcessFold {
  /** What a node card's status bar shows. */
  current: ProcessActivitySummary
  /** The newest assembled assistant text in the window (the card's detail line). */
  text?: string
  /** Epoch ms of the newest event in the window. */
  lastEventTime?: number
}

/** How many events one fold may scan backwards (bounds the cost per child). */
export const PROCESS_WINDOW_EVENTS = 400
/** Detail cap, mirroring the host's `LIVE_TOOL_DETAIL_MAX_CHARS`. */
export const PROCESS_DETAIL_MAX_CHARS = 160
/** Cap of the detail text line sent to the client. */
export const PROCESS_TEXT_MAX_CHARS = 400

/**
 * The host's category map, verbatim (the arms are mutually exclusive, so the
 * order only mirrors the host's for review).
 * @param name - durable tool-call name.
 * @returns the category the main agent's process group counts it under.
 */
export function activityOf(name: string): ProcessActivity {
  if (name === 'read') return 'read'
  if (name === 'read_image') return 'readImage'
  if (name === 'grep' || name === 'glob' || name.endsWith('_inspect')) return 'search'
  if (name === 'write') return 'write'
  if (name === 'edit' || name === 'apply_patch') return 'edit'
  if (['bash', 'pwsh', 'exec_command', 'write_stdin'].includes(name) || name.startsWith('terminal_')) {
    return 'commands'
  }
  if (name === 'run_code') return 'code'
  if (name === 'web_search') return 'webSearch'
  if (name === 'web_fetch') return 'webFetch'
  if (name === 'subagent' || name.startsWith('subagent_')) return 'subagents'
  if (['todo_write', 'create_goal', 'update_goal', 'get_goal'].includes(name)) return 'plan'
  if (name === 'ask_user_question' || name === 'request_user_input') return 'questions'
  return 'tools'
}

/** The host's live-detail key priority, verbatim. */
const LIVE_TOOL_DETAIL_KEYS = [
  'title', 'description', 'objective', 'task', 'task_name', 'name', 'question',
  'questions', 'prompt', 'message', 'command', 'cmd', 'queries', 'query',
  'pattern', 'url', 'uri', 'file_path', 'path', 'target', 'action', 'status',
] as const

/** Grapheme segmenter when the runtime has one (the host relies on `Intl.Segmenter`). */
const SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : undefined

/** Split into user-perceived characters, falling back to code points. */
function graphemes(text: string): string[] {
  if (SEGMENTER === undefined) return Array.from(text)
  return Array.from(SEGMENTER.segment(text), part => part.segment)
}

/** Collapse whitespace and truncate on a grapheme boundary (the host's normalize). */
function normalizeDetail(value: unknown): string {
  const flat = (typeof value === 'string'
    ? value
    : Array.isArray(value) && value.every(item => typeof item === 'string')
      ? value.join(', ')
      : '').replace(/\s+/g, ' ').trim()
  const chars = graphemes(flat)
  if (chars.length <= PROCESS_DETAIL_MAX_CHARS) return flat
  return `${chars.slice(0, PROCESS_DETAIL_MAX_CHARS - 1).join('').trimEnd()}…`
}

/** The first `question` string of an `ask_user_question` argument list. */
function questionDetail(value: unknown): string {
  if (!Array.isArray(value)) return ''
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const detail = normalizeDetail((item as { question?: unknown }).question)
    if (detail !== '') return detail
  }
  return ''
}

/**
 * The host's `liveToolDetail`: parse the raw arguments and take the first
 * present key of {@link LIVE_TOOL_DETAIL_KEYS}, falling back to the tool name.
 * @param name - tool-call name.
 * @param argsRaw - the call's raw `arguments` JSON string.
 */
export function liveToolDetail(name: string, argsRaw: string): string {
  let args: unknown
  try {
    args = JSON.parse(argsRaw)
  } catch {
    return normalizeDetail(name)
  }
  if (args === null || typeof args !== 'object') return normalizeDetail(name)
  const record = args as Record<string, unknown>
  for (const key of LIVE_TOOL_DETAIL_KEYS) {
    if (!(key in record)) continue
    const value = record[key]
    const detail = key === 'questions' ? questionDetail(value) : normalizeDetail(value)
    if (detail !== '') return detail
  }
  return normalizeDetail(name)
}

/**
 * Extract the concatenated plain text of a content-block list (the durable
 * `ContentBlock[]` shape, structurally: blocks with `type: 'text'` carry
 * `text`; anything else — a tool call, an image, … — contributes nothing).
 * @param content - the raw `content` field of a message event.
 * @returns the joined text, or undefined when the message carries no text.
 */
export function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') {
      parts.push(candidate.text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

/** One announced or dispatched call inside the current range. */
interface CallRecord {
  callId: string
  name: string
  args: string
  seq: number
  /** A paired `tool/result` was observed in the scanned window. */
  settled: boolean
  /** Announced by the model but never dispatched (the host's `PreparingToolCall`). */
  preparing: boolean
}

/** A tool-call content block under BOTH durable vocabularies (0.1.7 `tool-call`; older logs `tool_use`). */
function announcedCalls(content: unknown): { callId: string; name: string; args: string }[] {
  if (!Array.isArray(content)) return []
  const found: { callId: string; name: string; args: string }[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { type?: unknown; id?: unknown; callId?: unknown; name?: unknown; arguments?: unknown }
    if (candidate.type !== 'tool-call' && candidate.type !== 'tool_use') continue
    const rawId = candidate.id ?? candidate.callId
    if (typeof rawId !== 'string' || typeof candidate.name !== 'string') continue
    found.push({
      callId: rawId,
      name: candidate.name,
      args: typeof candidate.arguments === 'string' ? candidate.arguments : '',
    })
  }
  return found
}

/** The callId of one `tool/result` event under both logged shapes. */
function resultCallId(data: Record<string, unknown>): string | undefined {
  const message = data.message as { source?: { callId?: unknown }; toolCallId?: unknown } | undefined
  for (const candidate of [data.callId, message?.source?.callId, message?.toolCallId, data.toolCallId]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
}

/** Rank one range's calls into the host's summary shape. */
function summarize(calls: readonly CallRecord[], live: boolean): ProcessActivitySummary {
  const counts = new Map<ProcessActivity, number>()
  let running: ProcessActivity | undefined
  let preparing: true | undefined
  let runningDetail = ''
  let runningSeq = -Infinity
  // The host counts in FORWARD member order, so a count tie ranks by first
  // appearance; this fold collects backwards and must restore that order.
  const ordered = calls.slice().sort((left, right) => left.seq - right.seq)
  for (const call of ordered) {
    const kind = activityOf(call.name)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
    if (call.settled || !live) continue
    // The host selects on `>=` in event order: the newest unsettled call wins.
    if (call.seq < runningSeq) continue
    runningSeq = call.seq
    running = kind
    preparing = call.preparing ? true : undefined
    runningDetail = call.preparing ? (kind === 'tools' ? call.name : '') : liveToolDetail(call.name, call.args)
  }
  const ranked = [...counts].map(([kind, count]) => ({ kind, count }))
  ranked.sort((left, right) => right.count - left.count)
  return {
    counts: ranked,
    ...(running === undefined ? {} : { running }),
    runningDetail,
    ...(preparing === true ? { preparing: true as const } : {}),
  }
}

/** Cap one detail line without cutting a surrogate pair in half. */
function truncateText(text: string): string {
  const chars = graphemes(text)
  if (chars.length <= PROCESS_TEXT_MAX_CHARS) return text
  return `${chars.slice(0, PROCESS_TEXT_MAX_CHARS - 1).join('').trimEnd()}…`
}

/** The calls of the range currently being collected. */
interface Range {
  calls: CallRecord[]
  ids: Set<string>
}

/** Start an empty range. */
function openRange(): Range {
  return { calls: [], ids: new Set() }
}

/** Append one call to a range (deduped by callId). */
function addCall(range: Range, call: CallRecord): void {
  if (range.ids.has(call.callId)) return
  range.calls.push(call)
  range.ids.add(call.callId)
}

/**
 * Fold a session event log into the host's merged activity view: the newest
 * range's summary and the newest text line. Scans BACKWARD from the end and
 * stops at the range it reports, so a long history costs only its recent tail.
 *
 * @param events - the session's append-only event log (oldest → newest).
 * @param options - `live` (whether the session is executing; a settled one
 *   reports no running tool, like the host's closed groups) and `maxEvents`.
 * @returns the current summary plus the optional detail fields.
 */
export function foldProcess(
  events: readonly SidebarSessionEvent[],
  options: { live: boolean; maxEvents?: number },
): ProcessFold {
  const live = options.live
  const maxEvents = Math.max(1, options.maxEvents ?? PROCESS_WINDOW_EVENTS)

  let range = openRange()
  /** The newest NON-EMPTY range (the fallback when the newest one is empty). */
  let answer: CallRecord[] | undefined
  /** Whether {@link answer} is the newest range (only then can it be running). */
  let answerLive = false
  const settled = new Set<string>()
  let latestText: string | undefined
  let lastEventTime: number | undefined
  let crossed = 0

  for (let index = events.length - 1, scanned = 0; index >= 0; index -= 1) {
    if (scanned >= maxEvents) break
    const event = events[index]
    if (event === undefined) continue
    scanned += 1
    lastEventTime ??= event.time
    const { type, data } = event

    if (type === 'tool/result') {
      const callId = resultCallId(data)
      if (callId !== undefined) settled.add(callId)
      continue
    }

    if (type === 'tool/call') {
      const callId = typeof data.callId === 'string' && data.callId !== '' ? data.callId : `anon-${event.seq}`
      addCall(range, {
        callId,
        name: typeof data.name === 'string' ? data.name : 'tool',
        args: typeof data.arguments === 'string' ? data.arguments : '',
        seq: event.seq,
        settled: settled.has(callId),
        preparing: false,
      })
      continue
    }

    if (type !== 'assistant/message' && type !== 'user/message') continue
    const message = type === 'assistant/message'
      ? (data.message as { content?: unknown } | undefined)
      : undefined
    if (message !== undefined) {
      // Announced calls belong to the range that FOLLOWS their assistant
      // message — the range being collected right now.
      for (const announced of announcedCalls(message.content)) {
        const isSettled = settled.has(announced.callId)
        addCall(range, {
          callId: announced.callId,
          name: announced.name,
          args: announced.args,
          seq: event.seq,
          settled: isSettled,
          preparing: !isSettled,
        })
      }
    }
    const text = message === undefined ? undefined : contentText(message.content)
    if (text !== undefined) latestText ??= text
    // A text-bearing assistant message and a user message both END the range
    // to their left (the host's flush points).
    if (type !== 'user/message' && text === undefined) continue
    if (range.calls.length > 0) {
      // The range just closed is the newest one that did anything.
      answer = range.calls
      answerLive = crossed === 0
      break
    }
    // Nothing happened in this range: step past it into the previous one, once.
    crossed += 1
    if (crossed > 1) break
    range = openRange()
  }

  // `answer` is set when a boundary closed a range that did something; the
  // range still in hand covers two ends of the log: the whole log (no boundary
  // at all — that range IS the newest) and the one the scan ran out of events
  // in (a fallback range, so it is never live).
  const calls = answer ?? range.calls
  const newest = answer === undefined ? crossed === 0 : answerLive
  return {
    current: summarize(calls, live && newest),
    ...(latestText === undefined ? {} : { text: truncateText(latestText) }),
    ...(lastEventTime === undefined ? {} : { lastEventTime }),
  }
}
