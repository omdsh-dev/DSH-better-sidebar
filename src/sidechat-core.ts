/**
 * Pure side-conversation ("Side Chat") logic shared by the host routes and
 * the client tab. Framework-free (no React, no Node) so both halves and the
 * node test environment can import it.
 *
 * A side thread is a child session the plugin creates ITSELF with a custom
 * seed — the parent's model-visible history up to the click moment. When the
 * parent has summarized (its last compaction checkpoint replaces the
 * shadowed span on the surface), the seed is REBASED onto that checkpoint:
 * surviving pre-cut surface nodes, the checkpoint, and the post-compaction
 * tail — proven equivalent to a full-log fork by folding both (compactionTail)
 * — instead of physically duplicating the whole log. Without a compaction,
 * or whenever the rebasing cannot be proven, the seed is the parent's FULL
 * event log verbatim. The log model forbids open-turn seeds, so an
 * in-flight parent turn is copied verbatim and CLOSED with synthetic
 * `step/end` + `turn/end{reason: 'interrupted'}` events: the child sees the
 * partial turn as honestly frozen ("cut off"), never as a completed answer.
 * The one case that cannot be closed honestly — a tool call still executing
 * (no `tool/result` yet; providers reject dangling assistant calls) — falls
 * back to cutting before the open turn and carrying the partial content as
 * a structured text snapshot inside the boundary prompt.
 */
import type { SidebarHistoryEntry, SidebarSessionSummary } from './context-types.ts'
import type { AssistantLiveChunk } from './assistant-live.ts'
import { foldSurface, isSurfaceEligibleType } from '@deepseek-ai/dsh-session/surface'

/** The durable thread-label prefix (also the row filter in the client list). */
export const SIDE_LABEL_PREFIX = 'Side: '

/** The pinned label of a freshly created thread that no prompt has reached
 *  yet (Codex-style immediate create: the tab opens an EMPTY thread, the
 *  first composer message carries the boundary and earns the real label).
 *  The client renders it localized; the prefix keeps the row filter honest. */
export const SIDE_NEW_THREAD_TITLE = 'Side: New thread'

/** Maximum code points kept in a durable thread label (matches subagent labels). */
export const LABEL_MAX_CHARS = 48

/** The boundary message's opening line — the transcript mapping drops user
 *  rows starting with it (same first line as dsh-sidechain's boundary, so
 *  the two plugins' threads render consistently in either UI). */
export const SIDE_BOUNDARY_PREFIX = 'Side conversation boundary'

/** The plugin's producer-owned source kind, stamped on the source of
 *  context-injection messages (boundary prompt + parked snapshot) so the
 *  transcript recognizes them structurally — not by text prefix. Session
 *  format v4 retired the bare `kind: 'plugin'` + `plugin` pair; a plugin is
 *  now identified by its own `plugin:<name>` kind, which is exactly what
 *  DSH's own v3→v4 migration derives for rows this plugin wrote earlier, so
 *  both generations read back under one shape. */
export const SIDE_INJECTION_SOURCE_KIND = 'plugin:dsh-better-sidebar'

/**
 * The boundary prompt delivered as the thread's first user message: the
 * inherited seed is reference context only, never active instruction.
 * Model-facing contract — change only with intent, tests pin the sentences.
 */
export const SIDE_BOUNDARY_PROMPT = `Side conversation boundary.

Everything before this boundary is inherited history from the parent session: its completed turns, its pending question, and — if the parent was mid-turn — its in-progress output frozen at the moment this side conversation started. It is reference context only. It is not your current task.

Do not continue, execute, or complete any instructions, plans, tool calls, approvals, edits, or requests from before this boundary. Only messages submitted after this boundary are active user instructions for this side conversation.

Mode: this is a continuable side conversation. Your answers stay in this side thread and are viewed in the side panel; they are never delivered into the parent session.`

/** One seed event (structural mirror of the durable SessionEvent). The
 *  envelope fields are preserved verbatim: surface-eligible events
 *  (user/message, assistant/message, tool/result) REQUIRE the `surfaceOp`
 *  marker (and may carry `sourceEventSeqs`) — the seed validator rejects
 *  them without it. */
export interface SeedEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
  /** Surface marker of message-producing events ('append' | replace op). */
  surfaceOp?: unknown
  /** Seq numbers of earlier events this event cites as sources. */
  sourceEventSeqs?: unknown
  /** Reader-skip marker of purely informational events. */
  ignorable?: true
}

/** The minimal structural face of a session-log event this module reads
 *  (loose enough to accept both the host's real SessionEvent and the
 *  client's SidebarSessionEvent mirror). */
export interface SidechatLogEvent {
  type: string
  seq: number
  time: number
  data: unknown
}

/**
 * One live assistant delta on the plugin's wire, mirroring DSH 0.1.5's
 * client-only `assistant/live-chunk` presentation row.
 *
 * DSH 0.1.5 no longer logs `assistant/chunk`: an in-flight attempt's deltas
 * are process-local frames (`agent/assistant-stream`, folded by
 * {@link ./assistant-live.ts}) and reach the transcript through the plugin's
 * own `sidechat.events` route as these rows. They are NOT durable — the
 * route returns the current attempt's rows on every poll and the client
 * replaces its live set each time; the durable `assistant/message` settles
 * them by `turn:step`.
 */
export interface SidechatLiveEvent {
  type: 'assistant/live-chunk'
  /** Ordering key among live rows only; durable seqs stay authoritative. */
  seq: number
  time: number
  data: {
    attemptId: string
    turn: number
    step: number
    /** Dense zero-based position within the attempt. */
    index: number
    /** The raw model stream chunk. */
    chunk: Record<string, unknown>
  }
}

/**
 * Project buffered live chunks into wire rows.
 * @param chunks - the session's active-attempt chunks, in index order.
 * @param tailSeq - the session's last durable seq (live rows order after it).
 * @returns the rows to append to the transcript feed.
 */
export function liveEventsOf(chunks: readonly AssistantLiveChunk[], tailSeq: number): SidechatLiveEvent[] {
  return chunks.map((delta, position) => ({
    type: 'assistant/live-chunk',
    seq: tailSeq + 1 + position,
    time: delta.time,
    data: {
      attemptId: delta.attemptId,
      turn: delta.turn,
      step: delta.step,
      index: delta.index,
      chunk: delta.chunk,
    },
  }))
}

/** The result of cutting a parent log into a side-thread inheritance. */
export interface SidechatInheritance {
  /** The child seed: contiguous from seq 0, ends outside any open turn. */
  seed: SeedEvent[]
  /**
   * Structured snapshot of the parent's in-progress turn when it could NOT
   * be included as events (a tool call was still executing); null when the
   * seed already carries the whole picture.
   */
  snapshot: string | null
}

/** The data record of one event (narrowed from the loose face). */
function dataOf(event: SidechatLogEvent): Record<string, unknown> {
  return event.data as Record<string, unknown>
}

/** Copy parent events verbatim (their live seq === array index contract).
 *  The FULL envelope is preserved — stripping `surfaceOp` would make the
 *  seed validator reject every surface-eligible message event. */
function copyEvents(events: readonly SidechatLogEvent[]): SeedEvent[] {
  return events.map(event => {
    const source = event as SidechatLogEvent & {
      surfaceOp?: unknown
      sourceEventSeqs?: unknown
      ignorable?: true
    }
    return {
      type: source.type,
      seq: source.seq,
      time: source.time,
      data: dataOf(source),
      ...(source.surfaceOp === undefined ? {} : { surfaceOp: source.surfaceOp }),
      ...(source.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: source.sourceEventSeqs }),
      ...(source.ignorable === undefined ? {} : { ignorable: source.ignorable }),
    }
  })
}

/** Index of the last `turn/start` or `turn/end`, or -1. */
function lastTurnBoundary(events: readonly SidechatLogEvent[]): number {
  for (let index = events.length - 1; index >= 0; index--) {
    const type = events[index]?.type
    if (type === 'turn/start' || type === 'turn/end') return index
  }
  return -1
}

/** Numeric field of an event's data (turn / step numbers). */
function numberAt(data: Record<string, unknown>, key: string): number {
  const value = data[key]
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0
}

/** The step number still open at the log tail inside the turn starting at
 *  `turnStart` (undefined when no step is open). */
function openStepInTurn(events: readonly SidechatLogEvent[], turnStart: number): number | undefined {
  let open: number | undefined
  for (let index = turnStart + 1; index < events.length; index++) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'step/start') open = numberAt(dataOf(event), 'step')
    else if (event.type === 'step/end') open = undefined
  }
  return open
}

/**
 * Whether the open turn ending the log has a `tool/call` without its paired
 * `tool/result` in the CURRENT open step. Providers reject dangling
 * assistant calls, so such a turn cannot be honestly closed and the
 * inheritance must fall back to the snapshot.
 */
export function hasDanglingToolCall(events: readonly SidechatLogEvent[], turnStart: number): boolean {
  const pending = new Set<string>()
  for (let index = turnStart + 1; index < events.length; index++) {
    const event = events[index]
    if (event === undefined) continue
    const data = dataOf(event)
    if (event.type === 'step/end') {
      pending.clear()
      continue
    }
    if (event.type === 'tool/call') {
      const callId = data.callId
      if (typeof callId === 'string') pending.add(callId)
      continue
    }
    if (event.type === 'tool/result') {
      const source = data.message as { source?: { callId?: unknown } } | undefined
      const callId = source?.source?.callId
      if (typeof callId === 'string') pending.delete(callId)
    }
  }
  return pending.size > 0
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

/** The plain text of one tool/result message (its text blocks, under either
 *  of the two shapes {@link resultBlocks} reads). */
function toolResultText(data: Record<string, unknown>): string {
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

/** Cap applied to one tool-result's text inside a snapshot (prompt budget). */
const SNAPSHOT_RESULT_CAP = 2000
/** Cap applied to the whole snapshot (prompt budget). */
const SNAPSHOT_TOTAL_CAP = 8000

/**
 * Rebase the parent's log onto its last summarizing compaction: the
 * checkpoint `user/message` already REPLACES the shadowed span on the
 * model-visible surface, so a child needs only the surviving head skeleton
 * (with its turn/step scaffolding — the session relational invariants demand
 * it), the checkpoint itself, and the keep-window + post-compaction tail
 * VERBATIM — the forgotten span never has to be physically copied again,
 * while every kept event keeps its enclosing structure. The result is
 * verified with the real fold before it is used: the rebased sequence must
 * produce the SAME visible nodes as the parent, which keeps the child's
 * model context (and provider context-cache prefix) identical to a
 * full-log fork.
 *
 * Returns a seq-contiguous event array, or undefined to fall back to the
 * verbatim full copy — no compaction in the log, a reference the rebase
 * cannot resolve, or any fold the construction cannot prove equivalent.
 * Failures degrade to today's behavior, never to a wrong child.
 * @param events - the parent's log (live or persisted).
 * @returns the rebased log, or undefined when the full copy is required.
 */
function compactionTail(events: readonly SidechatLogEvent[]): SidechatLogEvent[] | undefined {
  const cut = lastCheckpointIndex(events)
  if (cut === undefined) return undefined
  const checkpoint = events[cut]
  if (checkpoint === undefined) return undefined
  let parentNodes: readonly number[]
  let checkpointShadowed: ReadonlySet<number> | undefined
  try {
    const fold = foldSurface(events as unknown as Parameters<typeof foldSurface>[0])
    parentNodes = fold.nodes
    // The checkpoint's declared [startSeq,endSeq] range is not its shadowed
    // set once a replacement sits inside it: use the surface entries the fold
    // recorded as actually removed.
    const replacement = fold.replacements.find(item => item.seq === checkpoint.seq)
    checkpointShadowed = replacement === undefined ? undefined : new Set<number>(replacement.shadowedSeqs)
  } catch {
    return undefined
  }
  const surfaceIndex = parentNodes.indexOf(checkpoint.seq)
  // The checkpoint must sit on the surface. The nodes before its slot are
  // the head; a post-cut node there is a later replacement of the protected
  // head slot (a model switch rewrites the system prompt), not a reordered
  // tail node — `headSlotOf` resolves the replacement chain or refuses.
  if (surfaceIndex === -1) return undefined
  const headSlots: HeadSlot[] = []
  let keepFirst: number | undefined
  let sawTailNode = false
  for (let index = 0; index < parentNodes.length; index++) {
    if (index === surfaceIndex) continue
    const seq = parentNodes[index] as number
    if (index < surfaceIndex) {
      const slot = headSlotOf(events, seq, cut, checkpointShadowed)
      if (slot === undefined) return undefined
      headSlots.push(slot)
      continue
    }
    if (seq >= cut) {
      sawTailNode = true
      continue
    }
    // Surface order is [head nodes][checkpoint][keep-window nodes][tail in
    // log order]; anything else cannot be reproduced and degrades to the
    // full copy.
    if (sawTailNode) return undefined
    if (keepFirst === undefined) keepFirst = seq
  }
  const headEvents = headSkeleton(events, headSlots)
  if (headEvents === undefined) return undefined
  const consumedSeqs = new Set<number>()
  for (const slot of headSlots) for (const seq of slot.consumed) consumedSeqs.add(seq)
  let keepStart = enclosingTurnStart(events, keepFirst)
  // The loop writes a turn's inbox INSERT before its turn/start and the
  // CLAIM right after it; starting the keep window at the turn/start would
  // keep the claim while dropping its insert, and the host's positional
  // inbox fold would reject the seed. Swallow the contiguous splices that
  // precede the skeleton root — they replay cleanly from an empty inbox.
  while (keepStart > 0 && events[keepStart - 1]?.type === 'agent/inbox/spliced') keepStart -= 1
  const groupId = dataOf(events[cut - 1]!).compactionId
  // The keep interval is a LOG range; the region may have ended mid-turn,
  // so the interval can re-carry surface nodes the checkpoint already
  // shadowed (they precede the surviving ones inside the same turn). Skip
  // exactly those, plus tool/calls whose result did not survive — an
  // orphaned call fails the relational invariants just like a bare one.
  const surviving = new Set(parentNodes as readonly number[])
  const survivingCallIds = new Set<string>()
  for (const seq of parentNodes as readonly number[]) {
    const node = events[seq]
    if (node === undefined || node.type !== 'tool/result') continue
    const callId = toolResultCallIdOf(node)
    if (callId !== undefined) survivingCallIds.add(callId)
  }
  // Surface nodes a KEPT replacement still targets are not skippable: the
  // replacement's fold transition (node appears, then is replaced) must
  // replay — skipping its target would degrade the replacement to an
  // append stranded after the step closed, which the relational rules
  // reject. (The pruner's tool/result rewrites are exactly this shape.)
  const replaceCovered = new Set<number>()
  for (const [from, to] of [[keepStart, cut], [cut + 1, events.length]] as const) {
    for (let index = from; index < to; index++) {
      const event = events[index]
      if (event === undefined || isCompactionGroupEvent(event, groupId)) continue
      if (consumedSeqs.has(event.seq)) continue
      const op = (event as { surfaceOp?: unknown }).surfaceOp
      if (op === null || typeof op !== 'object' || (op as { op?: unknown }).op !== 'replace') continue
      const start = (op as { startSeq?: unknown }).startSeq
      const end = (op as { endSeq?: unknown }).endSeq
      if (typeof start !== 'number' || typeof end !== 'number' || start > end) continue
      for (let seq = Math.max(0, start); seq <= Math.min(end, events.length - 1); seq++) replaceCovered.add(seq)
    }
  }
  // The set of parent seqs the seed will carry, decided BEFORE emission: a
  // grouped record whose citations cannot remap drops ATOMICALLY — its
  // compaction bracket (start/summary/end) or its command pair goes
  // together, never a lone partner that the host's invariant companions
  // reject. Real multi-compaction sessions hit this on every mid-keep group
  // (its summary cites nodes later groups re-shadowed), so record-level
  // dropping would strand brackets on every real parent.
  const emittedSeqs = new Set<number>()
  for (const event of headEvents) emittedSeqs.add(event.seq)
  emittedSeqs.add(checkpoint.seq)
  const keepSkip = (event: SidechatLogEvent): boolean =>
    (isSurfaceEligibleType(event.type) && !surviving.has(event.seq) && !replaceCovered.has(event.seq))
    || (event.type === 'tool/call' && !survivingCallIds.has(String(dataOf(event).callId)))
  for (const [from, to] of [[keepStart, cut], [cut + 1, events.length]] as const) {
    for (let index = from; index < to; index++) {
      const event = events[index]
      if (event === undefined) continue
      if (isCompactionGroupEvent(event, groupId)) continue
      if (consumedSeqs.has(event.seq)) continue
      if (index < cut && keepSkip(event)) continue
      emittedSeqs.add(event.seq)
    }
  }
  const droppedGroups = new Set<string>()
  const keptRunIds = new Set<string>()
  for (const seq of emittedSeqs) {
    const event = events[seq]
    if (event === undefined || event.type !== 'command/run') continue
    const id = dataOf(event).commandId
    if (typeof id === 'string') keptRunIds.add(id)
  }
  const droppedDones = new Set<number>()
  for (const seq of emittedSeqs) {
    const event = events[seq]
    if (event === undefined) continue
    const data = dataOf(event)
    if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
      const range = data.shadowedRange as { start?: unknown; end?: unknown } | undefined
      const cited = data.shadowedSeqs
      if (range === null || typeof range !== 'object' || !Array.isArray(cited)) continue
      const start = typeof range.start === 'number' ? emittedSeqs.has(range.start) : true
      const end = typeof range.end === 'number' ? emittedSeqs.has(range.end) : true
      const citedAll = cited.every(item => typeof item !== 'number' || emittedSeqs.has(item))
      if (!start || !end || !citedAll) {
        const id = data.compactionId
        if (typeof id === 'string') droppedGroups.add(id)
      }
    } else if (event.type === 'command/done') {
      const id = data.commandId
      const sourceSeq = data.sourceEventSeq
      // The host contract: sourceEventSeq cites an earlier NON-command
      // event, and the commands invariant rejects a stale or out-of-range
      // citation. A done whose run or whose cited source falls in the
      // dropped span drops ATOMICALLY with it.
      const runKept = typeof id === 'string' && keptRunIds.has(id)
      const sourceKept = typeof sourceSeq !== 'number' || emittedSeqs.has(sourceSeq)
      if (!runKept || !sourceKept) droppedDones.add(event.seq)
    }
  }
  // Turn renumbering: the host's turn counter must run 1, 2, 3… over the
  // seed, but the dropped span leaves a gap between the head skeleton's
  // turn and the keep window's first turn/start. Every kept event carrying
  // a turn number at or past that first kept turn shifts down by the gap;
  // head-side numbers (below it) stay untouched. `step` numbers restart per
  // turn, so verbatim scaffolding inside a kept turn stays correct.
  const headOwnsTurn1 = headEvents.some(event => event.type === 'turn/start')
  const expectedFirstKeptTurn = headOwnsTurn1 ? 2 : 1
  let firstKeptTurn: number | undefined
  // The first kept turn/start can sit in the keep interval OR — when every
  // pre-cut survivor is the protected head — only in the tail after the
  // consumed group; scan both ranges.
  for (const [from, to] of [[keepStart, cut], [cut + 1, events.length]] as const) {
    for (let index = from; index < to; index++) {
      const event = events[index]
      if (event === undefined || event.type !== 'turn/start') continue
      const turn = dataOf(event).turn
      if (typeof turn === 'number') firstKeptTurn = turn
      break
    }
    if (firstKeptTurn !== undefined) break
  }
  const turnOffset = firstKeptTurn === undefined ? 0 : Math.max(0, firstKeptTurn - expectedFirstKeptTurn)
  // Positional renumbering over the kept set; every emitted event passes the
  // same rebase: seq references remap when the map can serve them, and a
  // reference into the dropped span degrades honestly (replace → append,
  // dropped citations) — except `developer/message.headerSeq`, whose
  // referent cannot be degraded: that aborts the whole tail.
  const rebase = new Map<number, number>()
  const seed: SeedEvent[] = []
  let aborted = false
  const emit = (event: SidechatLogEvent | undefined): void => {
    if (aborted || event === undefined) return
    const rebased: RebasedEvent = rebaseEvent(event, seed.length, rebase, turnOffset, firstKeptTurn)
    if (rebased === DROPPED) return
    if (rebased === undefined) {
      aborted = true
      return
    }
    rebase.set(event.seq, seed.length)
    seed.push(rebased)
  }
  for (const event of headEvents) emit(event)
  emit(checkpoint)
  for (let index = keepStart; index < cut; index++) {
    const event = events[index]
    if (event === undefined || isCompactionGroupEvent(event, groupId)) continue
    if (consumedSeqs.has(event.seq)) continue
    if (keepSkip(event)) continue
    if (droppedGroups.has(String(dataOf(event).compactionId))) continue
    if (droppedDones.has(event.seq)) continue
    emit(event)
  }
  for (let index = cut + 1; index < events.length; index++) {
    const event = events[index]
    if (event === undefined || isCompactionGroupEvent(event, groupId)) continue
    if (consumedSeqs.has(event.seq)) continue
    if (droppedGroups.has(String(dataOf(event).compactionId))) continue
    if (droppedDones.has(event.seq)) continue
    emit(event)
  }
  if (aborted) return undefined
  // Prove equivalence before the caller relies on it: the rebased sequence
  // must fold without error and to the same visible nodes as the parent,
  // and its turn/step skeleton must satisfy the host's relational counter
  // rules (turn/start runs 1, 2, …; steps open and close inside their turn;
  // a trailing open turn is the caller's to close).
  try {
    const child = foldSurface(seed as unknown as Parameters<typeof foldSurface>[0])
    if (!sameVisibleSequence(events, parentNodes, child.nodes, seed)) return undefined
  } catch {
    return undefined
  }
  if (!turnSequenceValid(seed)) return undefined
  if (!inboxSplicesValid(seed)) return undefined
  if (!bracketsValid(seed)) return undefined
  return seed
}

/**
 * Relational pre-check mirroring the host's grouped-record rules: a
 * successful `compaction/end` requires a `compaction/summary` of the same
 * compactionId earlier in the log, and a `command/done` requires its
 * `command/run` (same commandId) before it. Dropping a summary or a run
 * with the forgotten span while keeping its partner would ship a seed the
 * host's invariant companions reject, so any unmatched partner falls back
 * to the full copy.
 */
function bracketsValid(seed: readonly SeedEvent[]): boolean {
  const summarized = new Set<string>()
  const ranCommands = new Set<string>()
  for (const event of seed) {
    const data = dataOf(event)
    if (event.type === 'compaction/summary') {
      const id = data.compactionId
      if (typeof id === 'string') summarized.add(id)
    } else if (event.type === 'compaction/end') {
      const id = data.compactionId
      if (data.error === undefined && (typeof id !== 'string' || !summarized.has(id))) return false
    } else if (event.type === 'command/run') {
      const id = data.commandId
      if (typeof id === 'string') ranCommands.add(id)
    } else if (event.type === 'command/done') {
      const id = data.commandId
      if (typeof id !== 'string' || !ranCommands.has(id)) return false
    }
  }
  return true
}

/**
 * Relational pre-check mirroring the host's durable-inbox fold: every kept
 * `agent/inbox/spliced` event replays POSITIONALLY over the pending inbox
 * (splice.start/removedCount must stay in range, message ids unique). A
 * seed whose splice history cannot replay from an empty inbox falls back
 * to the full copy.
 */
function inboxSplicesValid(seed: readonly SeedEvent[]): boolean {
  const nextTurn: Array<Record<string, unknown>> = []
  const nextStep: Array<Record<string, unknown>> = []
  for (const event of seed) {
    if (event.type !== 'agent/inbox/spliced') continue
    const data = dataOf(event)
    // Host strictness: only the two known targets, a numeric start and
    // removedCount, and an array of messages with string ids.
    if (data.target !== 'next-turn' && data.target !== 'next-step') return false
    const inbox = data.target === 'next-step' ? nextStep : nextTurn
    const rawStart = data.start
    // The host contract makes removedCount optional and defaults it to 0
    // (its own writer omits it for pure inserts — 54% of real splices).
    const removedCount = typeof data.removedCount === 'number' ? data.removedCount : 0
    const inserted = Array.isArray(data.inserted) ? data.inserted as Array<Record<string, unknown>> : undefined
    const start = typeof rawStart === 'number' ? rawStart : Number.NaN
    if (inserted === undefined
      || !Number.isSafeInteger(start) || start < 0 || start > inbox.length
      || !Number.isSafeInteger(removedCount) || removedCount < 0
      || start + removedCount > inbox.length) return false
    inbox.splice(start, removedCount, ...inserted)
    const ids = new Set<string>()
    for (const message of [...nextTurn, ...nextStep]) {
      const id = message.id
      if (typeof id !== 'string') return false
      if (ids.has(id)) return false
      ids.add(id)
    }
  }
  return true
}

/**
 * Relational pre-check mirroring the CORE of the session invariant's
 * counters and tool pairing: turn numbers run 1, 2, … with no nested open
 * turn; steps run 1, 2, … inside the open turn and close before their turn;
 * in-turn message and tool/call events name the open turn/step when they
 * carry numbers — except a NON-append tool/result, which the host exempts
 * from step naming (pruner replacements carry their original step); a
 * tool/result must consume a pending call of its step, and a step cannot
 * close with calls pending. A trailing open turn or step is legal — the
 * caller closes it. This is a core mirror, not the full host contract;
 * anything it cannot prove falls back to the full copy.
 */
function turnSequenceValid(seed: readonly SeedEvent[]): boolean {
  let nextTurn = 1
  let nextStep = 1
  let openTurn: number | undefined
  let openStep: number | undefined
  let pendingCalls = new Set<string>()
  for (const event of seed) {
    const data = dataOf(event)
    if (event.type === 'turn/start') {
      if (openTurn !== undefined || data.turn !== nextTurn) return false
      openTurn = nextTurn
      nextTurn += 1
      nextStep = 1
      openStep = undefined
      pendingCalls = new Set()
    } else if (event.type === 'turn/end') {
      if (openTurn === undefined || data.turn !== openTurn || openStep !== undefined) return false
      openTurn = undefined
    } else if (event.type === 'step/start') {
      if (openTurn === undefined || data.turn !== openTurn || openStep !== undefined) return false
      if (data.step !== nextStep) return false
      openStep = nextStep
      nextStep += 1
      pendingCalls = new Set()
    } else if (event.type === 'step/end') {
      if (openTurn === undefined || openStep === undefined || data.turn !== openTurn || data.step !== openStep) return false
      if (pendingCalls.size > 0) return false
      openStep = undefined
    } else if (event.type === 'tool/call') {
      if (typeof data.turn === 'number' && data.turn !== openTurn) return false
      if (typeof data.step === 'number' && data.step !== openStep) return false
      const callId = data.callId
      if (typeof callId === 'string' && callId !== '') pendingCalls.add(callId)
    } else if (event.type === 'tool/result') {
      const op = (event as { surfaceOp?: unknown }).surfaceOp
      if (op !== 'append') {
        // The host exempts a replacing tool/result from step naming and
        // pairing: it shadows the original call's slot, not a new one.
        if (openTurn === undefined) return false
        continue
      }
      if (typeof data.turn === 'number' && data.turn !== openTurn) return false
      if (typeof data.step === 'number' && data.step !== openStep) return false
      const callId = toolResultCallIdOf(event)
      if (callId !== undefined && !pendingCalls.delete(callId)) return false
    } else if (isSurfaceEligibleType(event.type)) {
      if (typeof data.turn === 'number' && data.turn !== openTurn) return false
      if (typeof data.step === 'number' && data.step !== openStep) return false
    }
  }
  return true
}

/** The callId a tool/result event's message cites, when it carries one. */
function toolResultCallIdOf(event: SidechatLogEvent): string | undefined {
  if (event.type !== 'tool/result') return undefined
  const message = dataOf(event).message as { source?: { callId?: unknown } } | undefined
  const callId = message?.source?.callId
  return typeof callId === 'string' && callId !== '' ? callId : undefined
}

/** Bound on a system-prompt replacement chain; real chains are 2-4 hops. */
const MAX_HEAD_REPLACEMENTS = 16

/**
 * One head slot before the checkpoint. The anchor is the pre-cut event the
 * checkpoint left outside its shadowed set; the effective event is what the
 * parent surface shows in that slot — the anchor itself, or the latest
 * replacement of it (a model switch rewrites the system prompt). The
 * replacement-chain events the head consumes must not be emitted again.
 */
interface HeadSlot {
  /** Seq of the anchor event that owns the slot. */
  anchor: number
  /** Event the child emits in the slot (the anchor or its latest replacement). */
  effective: SidechatLogEvent
  /** Replacement-chain events the head consumes (the effective included); keep/tail loops skip them. */
  consumed: readonly number[]
}

/** The span a replace surface marker targets, when it is a valid one. */
function surfaceReplaceSpan(event: SidechatLogEvent): { start: number; end: number } | undefined {
  const op = (event as { surfaceOp?: unknown }).surfaceOp
  if (op === null || typeof op !== 'object' || (op as { op?: unknown }).op !== 'replace') return undefined
  const start = (op as { startSeq?: unknown }).startSeq
  const end = (op as { endSeq?: unknown }).endSeq
  if (typeof start !== 'number' || typeof end !== 'number' || start > end) return undefined
  return { start, end }
}

/**
 * Resolve one surface node before the checkpoint to the head slot the child
 * must carry. A node at or after the cut can still sit ahead of the
 * checkpoint when a later event replaced the protected system head (a model
 * switch rewrites the system prompt): the surface keeps the LATEST
 * replacement in the head slot, so the child carries that replacement and
 * drops the chain it replaced — the switched model saw the same
 * post-compaction surface as the original one.
 *
 * The chain is representable only when every step is a single-node
 * replacement of the system head and the anchor predates the cut and is not
 * one of the entries the checkpoint removed. Membership uses the checkpoint's
 * recorded shadowed set, not its declared numeric range: a replacement inside
 * that range may still be a surviving keep-window entry. A range replace, a
 * removed target, a non-system node, a forward/cyclic chain, or a missing
 * anchor returns undefined and degrades to the verbatim full copy.
 * @param events - the parent's log.
 * @param seq - the surface node seq to resolve.
 * @param cut - the checkpoint's log index.
 * @param checkpointShadowed - the checkpoint's actual shadowed entries, when the fold recorded them.
 * @returns the resolved slot, or undefined when the shape is not representable.
 */
function headSlotOf(
  events: readonly SidechatLogEvent[],
  seq: number,
  cut: number,
  checkpointShadowed: ReadonlySet<number> | undefined,
): HeadSlot | undefined {
  const surface = events[seq]
  if (surface === undefined) return undefined
  if (seq < cut) return { anchor: seq, effective: surface, consumed: [] }
  // A post-cut node in the head slot needs the checkpoint's actual shadowed
  // set: membership, not the declared numerical range, decides whether a
  // replacement target was already removed by the checkpoint.
  if (checkpointShadowed === undefined || checkpointShadowed.size === 0) return undefined
  const consumed: number[] = []
  const seen = new Set<number>()
  let current: SidechatLogEvent | undefined = surface
  while (current !== undefined) {
    if (seen.has(current.seq) || seen.size > MAX_HEAD_REPLACEMENTS) return undefined
    seen.add(current.seq)
    if (current.type !== 'system/message') return undefined
    const replace = surfaceReplaceSpan(current)
    if (replace === undefined) {
      // The chain ends at the surviving anchor: it must predate the cut and
      // must not be one of the entries the checkpoint removed.
      if (current.seq >= cut || checkpointShadowed.has(current.seq)) return undefined
      return { anchor: current.seq, effective: surface, consumed }
    }
    if (replace.start !== replace.end || replace.start >= current.seq) return undefined
    if (checkpointShadowed.has(replace.start)) return undefined
    consumed.push(current.seq)
    current = events[replace.start]
  }
  return undefined
}

/**
 * The surviving head as a state-machine-complete event list: the head slots
 * (surface order; a slot is its pre-cut anchor, or the latest replacement of
 * it) wrapped in a turn/step skeleton NORMALIZED to turn 1 step 1 — the seed
 * is a fresh log, the host's turn/step counters must start there, and the
 * emitted node's original numbers are envelope metadata the rebase is free to
 * rewrite (the protected system head can be a mid-session rewrite living in a
 * later turn/step, including a replacement written after the checkpoint).
 * Closers are recovered from the log when the skeleton's own closers were
 * dropped with the span. A head wider than one step/turn (or numbers that
 * disagree) is not a shape this builder represents and falls back to the full
 * copy.
 * @param events - the parent's log.
 * @param slots - the resolved head slots before the checkpoint's surface slot.
 * @returns the head segment's events, or undefined when the shape is not
 *  representable.
 */
function headSkeleton(events: readonly SidechatLogEvent[], slots: readonly HeadSlot[]): SidechatLogEvent[] | undefined {
  if (slots.length === 0) return []
  const first = events[slots[0]!.anchor]
  const last = events[slots[slots.length - 1]!.anchor]
  if (first === undefined || last === undefined) return undefined
  let turnStart: SidechatLogEvent | undefined
  let stepStart: SidechatLogEvent | undefined
  for (let index = first.seq - 1; index >= 0; index--) {
    const event = events[index]
    if (event === undefined) break
    if (event.type === 'turn/end') break
    // The NEAREST step/start below the node is the one that encloses it.
    if (event.type === 'step/start' && stepStart === undefined) stepStart = event
    if (event.type === 'turn/start') {
      turnStart = event
      break
    }
  }
  // Rewrite envelope turn/step in place of the originals — only where the
  // event already carries numbers (a user/message never does, and its whole
  // data object IS the model-visible message, so injecting fields there
  // would change the child's context) — keeping the data losslessly
  // JSON-serializable (never writing explicit undefined).
  const normalized = (event: SidechatLogEvent, over: { turn?: number; step?: number }): SidechatLogEvent => {
    const data = { ...dataOf(event) }
    if (over.turn !== undefined && typeof data.turn === 'number') data.turn = over.turn
    if (over.step !== undefined && typeof data.step === 'number') data.step = over.step
    return { ...event, data } as SidechatLogEvent
  }
  const parts: SidechatLogEvent[] = []
  if (turnStart !== undefined) {
    const turn = dataOf(turnStart).turn
    if (typeof turn !== 'number') return undefined
    const step = stepStart !== undefined ? dataOf(stepStart).step : undefined
    if (stepStart !== undefined && typeof step !== 'number') return undefined
    // The ANCHORS must all sit in this ONE step/turn (by their ORIGINAL
    // numbers); a replacement slot carries the anchor's slot position, so it
    // is checked by the anchor's numbers, not the replacement's. A wider head
    // is not a shape this builder represents.
    for (const slot of slots) {
      const node = events[slot.anchor]
      if (node === undefined) return undefined
      const nodeData = dataOf(node)
      if (nodeData.turn !== turn && nodeData.turn !== undefined) return undefined
      if (stepStart !== undefined && nodeData.step !== step && nodeData.step !== undefined) return undefined
    }
    parts.push(normalized(turnStart, { turn: 1 }))
    if (stepStart !== undefined) parts.push(normalized(stepStart, { turn: 1, step: 1 }))
    for (const slot of slots) parts.push(normalized(slot.effective, { turn: 1, ...(stepStart !== undefined ? { step: 1 } : {}) }))
    // Close the skeleton when its closers are dropped with the span: the
    // first step/end / turn/end of this step/turn after the last anchor.
    let closedStep = false
    for (let index = last.seq + 1; index < events.length; index++) {
      const event = events[index]
      if (event === undefined) break
      if (!closedStep && event.type === 'step/end' && typeof step === 'number'
        && dataOf(event).step === step && dataOf(event).turn === turn) {
        parts.push(normalized(event, { turn: 1, step: 1 }))
        closedStep = true
        continue
      }
      if (event.type === 'turn/end' && dataOf(event).turn === turn) {
        parts.push(normalized(event, { turn: 1 }))
        break
      }
      if (event.type === 'turn/start') break
    }
    return closedStep || step === undefined ? parts : undefined
  }
  // No enclosing turn: out-of-turn events are legal as-is. A replacement slot
  // has no turn to normalize into, so it is not representable here.
  for (const slot of slots) {
    const node = events[slot.anchor]
    if (node === undefined || slot.effective !== node) return undefined
    parts.push(node)
  }
  return parts
}

/** Log index of the turn/start enclosing one seq, the seq itself when the
 *  node sits between turns (the keep window then starts verbatim at its own
 *  skeleton root), or the log length when there is no keep window at all. */
function enclosingTurnStart(events: readonly SidechatLogEvent[], seq: number | undefined): number {
  if (seq === undefined) return events.length
  for (let index = seq - 1; index >= 0; index--) {
    const event = events[index]
    if (event === undefined) return seq
    if (event.type === 'turn/start') return index
    if (event.type === 'turn/end') return seq
  }
  return seq
}

/** Whether one event belongs to the compaction group being consumed (its
 *  log-only start/summary/end records leave with the span they priced).
 *  Other groups' records stay — they meter history the child keeps. A
 *  summary without a `compactionId` is malformed; nothing is excluded for
 *  it and the equivalence check decides. */
function isCompactionGroupEvent(event: SidechatLogEvent, groupId: unknown): boolean {
  if (!event.type.startsWith('compaction/')) return false
  if (typeof groupId !== 'string') return false
  return dataOf(event).compactionId === groupId
}

/** Index of the checkpoint user/message of the last summarizing compaction:
 *  the event right after a `compaction/summary` — that adjacency is the
 *  shadow-price contract. An orphaned summary (its replacement never
 *  landed) is skipped in favor of the previous complete one. */
function lastCheckpointIndex(events: readonly SidechatLogEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index]?.type !== 'compaction/summary') continue
    if (events[index + 1]?.type === 'user/message') return index + 1
  }
  return undefined
}

/** One `type` + model-visible-content token per visible node, mirroring the
 *  renderer's projection: a user/message IS its whole data object, every
 *  other surface event projects `data.message` (its envelope turn/step and
 *  headerSeq are rewritten by the rebase and never reach the model). */
function visibleToken(event: SidechatLogEvent | undefined): string {
  if (event === undefined) return 'missing'
  if (event.type === 'user/message') return `${event.type}:${JSON.stringify(dataOf(event))}`
  const message = dataOf(event).message
  return `${event.type}:${JSON.stringify(message ?? null)}`
}

/** Compare the parent's visible nodes with the rebased child's by content. */
function sameVisibleSequence(
  parent: readonly SidechatLogEvent[],
  parentNodes: readonly number[],
  childNodes: readonly number[],
  child: readonly SidechatLogEvent[],
): boolean {
  if (parentNodes.length !== childNodes.length) return false
  for (let index = 0; index < parentNodes.length; index++) {
    if (visibleToken(parent[parentNodes[index] as number]) !== visibleToken(child[childNodes[index] as number])) {
      return false
    }
  }
  return true
}

/**
 * Copy one kept event into the rebased sequence: envelope seq references
 * are remapped through the rebase map, `data.turn` numbers at or past the
 * first kept turn shift down by the gap the dropped span left (the host's
 * turn counter must stay contiguous), and a seq reference the map cannot
 * serve (it points into the dropped span) degrades the event honestly — a
 * replace whose shadowed nodes are gone becomes an append, dropped
 * citations vanish — except `developer/message.headerSeq`, whose referent
 * cannot be degraded: that aborts the whole tail.
 * @param event - the kept event to copy.
 * @param seq - the event's position in the rebased sequence.
 * @param rebase - old seq → rebased position over the kept set.
 * @param turnOffset - turns removed before the keep window (0 = no shift).
 * @param firstKeptTurn - the first kept turn number; smaller numbers are
 *  head-side and never shift.
 * @returns the rebased event, or undefined when the tail is not provable.
 */
/** Sentinel: the event is log-only metering whose referenced span did not
 *  survive the rebase — drop it instead of aborting the whole tail. */
const DROPPED: unique symbol = Symbol('dropped')

type RebasedEvent = SeedEvent | undefined | typeof DROPPED

function rebaseEvent(
  event: SidechatLogEvent,
  seq: number,
  rebase: Map<number, number>,
  turnOffset: number,
  firstKeptTurn: number | undefined,
): RebasedEvent {
  const source = event as SidechatLogEvent & { ignorable?: true }
  const seed: SeedEvent = { type: source.type, seq, time: source.time, data: dataOf(source) }
  if (source.ignorable === true) seed.ignorable = true
  const sourceData = dataOf(event)
  if (turnOffset > 0 && typeof sourceData.turn === 'number'
    && firstKeptTurn !== undefined && sourceData.turn >= firstKeptTurn) {
    seed.data = { ...seed.data, turn: sourceData.turn - turnOffset }
  }
  // A settled command cites an earlier non-command event by seq; remap it
  // alongside, and drop the done when the cited event did not survive — a
  // stale citation is something the host's commands invariant rejects.
  if (event.type === 'command/done' && typeof sourceData.sourceEventSeq === 'number') {
    const mapped = rebase.get(sourceData.sourceEventSeq)
    if (mapped === undefined) return DROPPED
    seed.data = { ...seed.data, sourceEventSeq: mapped }
  }
  // Compaction metering records cite the surface span they priced. When the
  // span survived the rebase, remap the citations; when it did not (the
  // record predates the consumed compaction and its span lies in the
  // dropped region), the record meters nothing that exists in the child —
  // drop it rather than shipping stale seq references.
  if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
    const range = sourceData.shadowedRange as { start?: unknown; end?: unknown } | undefined
    const cited = sourceData.shadowedSeqs
    if (range === null || typeof range !== 'object' || !Array.isArray(cited)) return seed
    const start = typeof range.start === 'number' ? rebase.get(range.start) : undefined
    const end = typeof range.end === 'number' ? rebase.get(range.end) : undefined
    const mapped = cited.map(item => typeof item === 'number' ? rebase.get(item) : undefined)
    if (start === undefined || end === undefined || mapped.includes(undefined)) return DROPPED
    seed.data = {
      ...seed.data,
      shadowedRange: { start, end },
      shadowedSeqs: mapped as number[],
    }
  }
  const headerSeq = sourceData.headerSeq
  if (event.type === 'developer/message' && typeof headerSeq === 'number') {
    const mapped = rebase.get(headerSeq)
    if (mapped === undefined) return undefined
    seed.data = { ...seed.data, headerSeq: mapped }
  }
  const op = (event as { surfaceOp?: unknown }).surfaceOp
  if (op === 'append') {
    seed.surfaceOp = 'append'
  } else if (op !== null && typeof op === 'object' && 'op' in op && (op as { op: unknown }).op === 'replace') {
    const replace = op as { startSeq?: unknown; endSeq?: unknown }
    const start = typeof replace.startSeq === 'number' ? rebase.get(replace.startSeq) : undefined
    const end = typeof replace.endSeq === 'number' ? rebase.get(replace.endSeq) : undefined
    // A range the rebase cannot resolve lost its shadowed nodes with the
    // dropped span; appending the replacement is exactly what remains
    // visible (the equivalence check still has to confirm it).
    seed.surfaceOp = start !== undefined && end !== undefined && start <= end
      ? { op: 'replace', startSeq: start, endSeq: end }
      : 'append'
  }
  const cited = (event as { sourceEventSeqs?: unknown }).sourceEventSeqs
  if (Array.isArray(cited)) {
    const mapped = cited.map(item => typeof item === 'number' ? rebase.get(item) : undefined)
    // Citations the rebase cannot serve referenced the dropped span; the
    // field is optional and only has to cover a live replace range.
    if (!mapped.includes(undefined)) seed.sourceEventSeqs = mapped as number[]
  }
  return seed
}

/**
 * Build the side-thread inheritance for one parent log: the full event log
 * up to the click moment, honestly closed when it ends inside an open turn.
 * When the parent has compacted, the log is first rebased onto its last
 * summarizing compaction (`compactionTail`) — same model-visible surface, a
 * fraction of the durable copy.
 * @param events - the parent's log (live or persisted).
 * @param live - the parent's in-flight stream chunks (DSH 0.1.5+ publishes
 *   them outside the log); used only by the snapshot fallback.
 */
export function buildSidechatInheritance(
  events: readonly SidechatLogEvent[],
  live: readonly AssistantLiveChunk[] = [],
): SidechatInheritance {
  if (events.length === 0) return { seed: [], snapshot: null }
  const trimmed = compactionTail(events)
  const log = trimmed ?? events
  const boundary = lastTurnBoundary(log)
  if (boundary < 0 || log[boundary]?.type === 'turn/end') {
    // Ends outside any turn (or has no turns at all): the whole log is a
    // valid, balanced seed — possibly ending with a pending user message.
    return { seed: copyEvents(log), snapshot: null }
  }
  // Ends inside the open turn starting at `boundary`.
  if (hasDanglingToolCall(log, boundary)) {
    // Cannot close honestly: cut before the open turn; the caller attaches
    // the structured snapshot to the boundary prompt instead.
    return {
      seed: copyEvents(log.slice(0, boundary)),
      snapshot: buildOpenTurnSnapshot(log, live),
    }
  }
  const seed = copyEvents(log)
  const last = log[log.length - 1]
  const turn = numberAt(dataOf(log[boundary]!), 'turn')
  const now = last?.time ?? 0
  const openStep = openStepInTurn(log, boundary)
  if (openStep !== undefined) {
    seed.push({ type: 'step/end', seq: seed.length, time: now, data: { turn, step: openStep } })
  }
  seed.push({
    type: 'turn/end',
    seq: seed.length,
    time: now,
    data: { turn, reason: { kind: 'interrupted' } },
  })
  return { seed, snapshot: null }
}

/** One assistant content block reduced to the text the snapshot shows. */
function messageTexts(message: unknown): { text: string; reasoning: string } {
  const content = (message as { content?: unknown } | undefined)?.content
  let text = ''
  let reasoning = ''
  if (!Array.isArray(content)) return { text, reasoning }
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (typeof candidate.text !== 'string' || candidate.text === '') continue
    if (candidate.type === 'text') text += candidate.text
    else if (candidate.type === 'reasoning') reasoning += candidate.text
  }
  return { text, reasoning }
}

/**
 * Expand one attempt's compact `AssistantStreamRecord[]` (the durable stream
 * DSH 0.1.5 embeds in `assistant/message.stream` and `assistant/attempt.stream`)
 * into the text/reasoning it carried. Tool-call records contribute no text.
 */
function streamTexts(stream: unknown): { text: string; reasoning: string } {
  let text = ''
  let reasoning = ''
  if (!Array.isArray(stream)) return { text, reasoning }
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    const entry = record as { type?: unknown; texts?: unknown; chunk?: unknown }
    if (entry.type === 'text-chunks' || entry.type === 'reasoning-chunks') {
      if (!Array.isArray(entry.texts)) continue
      const joined = entry.texts.filter((part): part is string => typeof part === 'string').join('')
      if (entry.type === 'text-chunks') text += joined
      else reasoning += joined
      continue
    }
    if (entry.type === 'chunk') {
      const chunk = entry.chunk as { type?: unknown; text?: unknown } | undefined
      if (chunk === null || typeof chunk !== 'object' || typeof chunk.text !== 'string') continue
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
    }
  }
  return { text, reasoning }
}

/** One live delta's contribution to the snapshot. */
function liveTexts(chunk: Record<string, unknown>): { text: string; reasoning: string } {
  if (typeof chunk.text !== 'string' || chunk.text === '') return { text: '', reasoning: '' }
  if (chunk.type === 'text-delta') return { text: chunk.text, reasoning: '' }
  if (chunk.type === 'reasoning-delta') return { text: '', reasoning: chunk.text }
  return { text: '', reasoning: '' }
}

/**
 * Structured text snapshot of the parent's OPEN turn (from its `turn/start`
 * to the log tail): the assistant/reasoning output so far and the tool
 * activity — executed tools with their result text, the still-executing one
 * marked. Returns null when there is no open turn or nothing to show.
 *
 * The in-flight step's text is NOT in the log on DSH 0.1.5 (the model stream
 * is process-local until it settles), so it comes from `live`; settled steps
 * read their durable `assistant/message` content, and a failed attempt reads
 * its embedded `assistant/attempt.stream`.
 * @param events - the parent's log.
 * @param live - the parent's in-flight stream chunks, in index order.
 */
export function buildOpenTurnSnapshot(
  events: readonly SidechatLogEvent[],
  live: readonly AssistantLiveChunk[] = [],
): string | null {
  const boundary = lastTurnBoundary(events)
  if (boundary < 0 || events[boundary]?.type !== 'turn/start') return null
  const openTurn = numberAt(dataOf(events[boundary]!), 'turn')
  let text = ''
  let reasoning = ''
  const tools: string[] = []
  const pendingCalls = new Map<string, { name: string; args: string }>()
  for (let index = boundary + 1; index < events.length; index++) {
    const event = events[index]
    if (event === undefined) continue
    const data = dataOf(event)
    if (event.type === 'step/end') {
      pendingCalls.clear()
      continue
    }
    if (event.type === 'assistant/message') {
      const settled = messageTexts(data.message)
      text += settled.text
      reasoning += settled.reasoning
      continue
    }
    if (event.type === 'assistant/attempt') {
      const attempt = streamTexts(data.stream)
      text += attempt.text
      reasoning += attempt.reasoning
      continue
    }
    if (event.type === 'tool/call') {
      const callId = data.callId
      if (typeof callId === 'string') {
        pendingCalls.set(callId, {
          name: typeof data.name === 'string' ? data.name : 'tool',
          args: typeof data.arguments === 'string' ? data.arguments : '',
        })
      }
      continue
    }
    if (event.type === 'tool/result') {
      const source = data.message as { source?: { callId?: unknown } } | undefined
      const callId = typeof source?.source?.callId === 'string' ? source.source.callId : undefined
      const name = callId !== undefined ? pendingCalls.get(callId)?.name : undefined
      const args = callId !== undefined ? pendingCalls.get(callId)?.args : undefined
      if (callId !== undefined) pendingCalls.delete(callId)
      const result = toolResultText(data).slice(0, SNAPSHOT_RESULT_CAP)
      const failed = data.error !== undefined
      const line = [
        `- \`${name ?? 'tool'}\`${failed ? ' (failed)' : ''}`
          + (args !== undefined && args !== '' ? ` — arguments: \`${args}\`` : ''),
        ...(result === '' ? [] : [`  Result: ${result}`]),
      ].join('\n')
      tools.push(line)
    }
  }
  for (const [, call] of pendingCalls) {
    const line = `- \`${call.name}\` (executing) — arguments: \`${call.args}\``
    tools.push(line)
  }
  // The in-flight step: its deltas never reached the log.
  for (const delta of live) {
    if (delta.turn !== openTurn) continue
    const contribution = liveTexts(delta.chunk)
    text += contribution.text
    reasoning += contribution.reasoning
  }
  const sections: string[] = []
  if (text.trim() !== '') sections.push(`Assistant output so far:\n\n${text}`)
  if (reasoning.trim() !== '') sections.push(`Reasoning so far:\n\n${reasoning}`)
  if (tools.length > 0) sections.push(`Tool activity:\n${tools.join('\n')}`)
  if (sections.length === 0) return null
  const body = sections.join('\n\n')
  return body.length > SNAPSHOT_TOTAL_CAP
    ? `Parent session in-progress turn (reference only):\n\n${body.slice(0, SNAPSHOT_TOTAL_CAP)}…`
    : `Parent session in-progress turn (reference only):\n\n${body}`
}

/** One side-thread row in the client's thread list. */
export interface SideThreadRow {
  id: string
  /** The durable thread title ('Side: …'). */
  title: string
  /** Whether the thread's agent is currently running. */
  running: boolean
}

/**
 * Derive the side threads of one parent session from the client session list:
 * durable `origin: 'subagent'` children of the parent whose pinned title
 * carries the thread label prefix (our creation path pins it via
 * sessionTitle.rename; dsh-sidechain threads share the convention, so they
 * are visible here too).
 */
export function sideThreadRows(
  byId: Readonly<Record<string, SidebarSessionSummary>>,
  sessionId: string,
): SideThreadRow[] {
  const rows: SideThreadRow[] = []
  for (const summary of Object.values(byId)) {
    if (summary.origin !== 'subagent' || summary.parentId !== sessionId) continue
    if (!summary.displayTitle.startsWith(SIDE_LABEL_PREFIX)) continue
    rows.push({ id: summary.id, title: summary.displayTitle, running: summary.running === true })
  }
  return rows
}

/** Truncate + prefix a question into a durable thread label. */
export function sideLabel(question: string): string {
  const flat = question.replace(/\s+/g, ' ').trim()
  const max = Math.max(1, LABEL_MAX_CHARS - SIDE_LABEL_PREFIX.length)
  const body = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
  return `${SIDE_LABEL_PREFIX}${body}`
}

/**
 * Whether the thread log already carries the side boundary message — i.e.
 * the first prompt was delivered. Tolerant to the content shape (block
 * array or bare string) and to inherited seed messages (only an OWN
 * boundary message starts with the prefix; seed messages came from the
 * parent's log, which never contains one).
 */
export function boundaryDelivered(events: readonly SidechatLogEvent[]): boolean {
  for (const event of events) {
    if (event.type !== 'user/message') continue
    if (messageLeadText(dataOf(event)).startsWith(SIDE_BOUNDARY_PREFIX)) return true
  }
  return false
}

/** The leading text of a user/message's content (block array or bare string). */
function messageLeadText(data: Record<string, unknown>): string {
  const content = data.content
  const first = Array.isArray(content) ? content[0] : content
  return typeof first === 'string'
    ? first
    : (typeof first === 'object' && first !== null && 'text' in first
      ? String((first as { text: unknown }).text)
      : '')
}

/**
 * Whether a logged user/message is a CONTEXT INJECTION (the boundary prompt
 * plus the parked in-progress snapshot) rather than a real user message.
 * New threads deliver the injection via `agent.inject` stamped with a
 * non-'user' source kind; threads created before that split carry
 * boundary+question in ONE 'user' message, recognized by the boundary
 * prefix. Both render as one collapsible injection row — never as a user
 * bubble.
 */
export function isContextInjectionMessage(data: Record<string, unknown>): boolean {
  const source = data.source as { kind?: unknown } | null | undefined
  if (source?.kind !== undefined && source.kind !== 'user') return true
  return messageLeadText(data).startsWith(SIDE_BOUNDARY_PREFIX)
}

/** The info the thread header shows (live runtime state + agent identity). */
export interface SidechatThreadInfo {
  /** A live agent drives the thread right now (false = cold/persisted). */
  live: boolean
  /** Live lifecycle state; absent on cold threads. */
  status?: 'idle' | 'running'
  /** Provider route the thread actually requests with (see
   *  {@link parentModelSelection} — NOT the frozen creation-time default). */
  provider?: string
  /** Model id the thread actually requests with. */
  model?: string
  /** Reasoning effort of the effective selection, when the log records one. */
  reasoningEffort?: string
  /** The recorded agent preset (live header, or persisted on cold reads). */
  preset?: string
}

/**
 * One UNCLAIMED inbox message of a live side thread — the queue the next step
 * or turn will claim. The transcript renders these as pending user bubbles
 * (with a spinner and a dequeue affordance) instead of leaving accepted input
 * invisible until a claim logs it as a durable `user/message`.
 */
export interface SidechatPendingInput {
  /** Durable message identity — the `sidechat.dequeue` key. */
  id: string
  /** Which boundary will claim it; `next-step` entries are claimed first. */
  target: 'next-turn' | 'next-step'
  /** Flattened text of the message content ('' when it carries no text). */
  text: string
}

/** One routable model in the host model catalog (a structural slice of the
 *  session controller's own `modelCatalog` rows). */
export interface SidechatModelInfo {
  id: string
  name?: string
  description?: string
  /** Provider-declared reasoning efforts, when the model has any. */
  reasoning?: {
    efforts: readonly { id: string; name?: string; description?: string }[]
    defaultEffort?: string
  }
}

/** One provider group of the host model catalog. */
export interface SidechatModelGroup {
  id: string
  name?: string
  models: readonly SidechatModelInfo[]
}

/**
 * The host model catalog as the side-chat model picker consumes it. Sourced
 * from the host's own `sessionController.modelCatalog()` (the exact catalog
 * the main composer lists), degraded to `available: false` when that service
 * is absent — the picker then offers only "inherit the parent".
 */
export interface SidechatModelCatalog {
  /** Whether a host catalog was readable at all. */
  available: boolean
  /** The deployment default selection, when readable. */
  default?: SidechatModelSelection
  /** Provider groups with at least one routable model. */
  groups: readonly SidechatModelGroup[]
  /** Providers whose catalog read failed (kept so the picker can say so). */
  failures: readonly { id: string; name?: string; message: string }[]
}

/** Flatten one pending message's content into the text the bubble shows. */
function pendingText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const item = block as { type?: unknown; text?: unknown }
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
  }
  return parts.join('\n')
}

/** The identity one inbox message carries (`MessageId`, a branded string). */
export function pendingInputId(message: unknown): string | undefined {
  const id = (message as { id?: unknown } | undefined)?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * Project one agent's inbox into wire rows, in CLAIM order: every `next-step`
 * entry first, then the queued turns (the host's `Inbox.claim` drains exactly
 * that way). Messages without an identity are skipped — they could not be
 * dequeued, so showing them as pending would offer a dead button.
 */
export function pendingInputs(
  nextStep: readonly unknown[],
  nextTurn: readonly unknown[],
): SidechatPendingInput[] {
  const rows: SidechatPendingInput[] = []
  const add = (message: unknown, target: SidechatPendingInput['target']): void => {
    const id = pendingInputId(message)
    if (id === undefined) return
    rows.push({ id, target, text: pendingText(message) })
  }
  for (const message of nextStep) add(message, 'next-step')
  for (const message of nextTurn) add(message, 'next-turn')
  return rows
}

/**
 * Fold a log's `agent/inbox/spliced` events into the message ids STILL pending
 * after it — the durable record of the inbox (the host's own
 * `inboxProjectionDefinition` semantics: apply every splice in order).
 *
 * This is the reading the ghost sweep needs: a seeded thread's inherited
 * prefix can leave messages "pending" that the parent had already claimed
 * (the claim splice sits inside the parent's open turn, which the seed
 * truncation cuts away), and those must never be delivered as the child's
 * own input.
 * @param events - the log (or any prefix of it), contiguous from seq 0.
 * @param limit - exclusive upper bound of event count to fold (the inherited
 *   prefix length, or the whole log).
 * @returns the ids of messages still pending after the folded events.
 */
export function pendingIdsInLog(events: readonly SidechatLogEvent[], limit?: number): string[] {
  const nextTurn: unknown[] = []
  const nextStep: unknown[] = []
  const end = limit === undefined ? events.length : Math.min(limit, events.length)
  for (let index = 0; index < end; index++) {
    const event = events[index]
    if (event === undefined || event.type !== 'agent/inbox/spliced') continue
    const data = dataOf(event)
    const target = data.target === 'next-step' ? nextStep : data.target === 'next-turn' ? nextTurn : undefined
    if (target === undefined) continue
    const start = typeof data.start === 'number' && Number.isSafeInteger(data.start) ? data.start : 0
    const removed = typeof data.removedCount === 'number' && Number.isSafeInteger(data.removedCount) ? data.removedCount : 0
    const inserted = Array.isArray(data.inserted) ? data.inserted : []
    target.splice(Math.max(0, Math.min(start, target.length)), Math.max(0, removed), ...inserted)
  }
  const ids: string[] = []
  for (const message of [...nextStep, ...nextTurn]) {
    const id = pendingInputId(message)
    if (id !== undefined) ids.push(id)
  }
  return ids
}

/**
 * The message ids a seeded thread INHERITED as still-pending but never
 * actually owned: fold only the inherited prefix (`[0, inheritedEventCount)`),
 * which is exactly the region the parent's own claim splices may have been
 * cut out of. The caller removes precisely these from the live inbox, so a
 * user's genuinely queued side-thread input is never touched.
 * @param events - the thread's log.
 * @param inheritedEventCount - the thread's inherited prefix length.
 * @returns the ghost message ids present in the prefix fold.
 */
export function inheritedPendingIds(
  events: readonly SidechatLogEvent[],
  inheritedEventCount: number,
): string[] {
  return pendingIdsInLog(events, Math.max(0, Math.trunc(inheritedEventCount)))
}

/**
 * The thread's effective model selection: `pending ?? lastUsed` of its own
 * `model/selection` / `request/header` fold (see {@link parentModelSelection},
 * which this is the same projection as). Used by the routes to report what the
 * thread will actually request with.
 */
export function effectiveModelSelection(
  events: readonly SidechatLogEvent[],
): SidechatModelSelection | undefined {
  return parentModelSelection(events)
}

/** The events a thread produced itself: everything after the LAST
 *  `session/end-seed` marker (the fork-seed boundary). A log with no marker
 *  (a thread created before seeding existed) is returned whole. */
export function threadOwnLogEvents(events: readonly SidechatLogEvent[]): SidechatLogEvent[] {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index]?.type === 'session/end-seed') return events.slice(index + 1)
  }
  return [...events]
}

/** {@link threadOwnLogEvents} over history rows (the client cache shape). */
export function threadOwnEvents(entries: readonly SidebarHistoryEntry[]): SidechatLogEvent[] {
  return threadOwnLogEvents(entries.map(entry => entry.event))
}

/**
 * Whether the thread has at least one completed turn — the save-as-new-
 * session precondition (`session.fork` refuses to fork before the first
 * `turn/end`).
 */
export function threadHasCompletedTurn(entries: readonly SidebarHistoryEntry[]): boolean {
  return threadOwnEvents(entries).some(event => event.type === 'turn/end')
}

/** Whether the thread ends with a user message that no completed turn
 *  answered yet — such a pending follow-up is NOT carried into the saved
 *  session (the fork cut is the last `turn/end`). */
export function threadTrailingPending(entries: readonly SidebarHistoryEntry[]): boolean {
  const own = threadOwnEvents(entries)
  let lastUser = -1
  let lastTurnEnd = -1
  own.forEach((event, index) => {
    if (event.type === 'user/message') lastUser = index
    if (event.type === 'turn/end') lastTurnEnd = index
  })
  return lastUser > lastTurnEnd
}

/**
 * The agent preset a session actually runs: newest `agent-preset/selected`
 * event wins, else the creation header (mirror of the dsh-agent-presets
 * resolveSessionPreset helper — replicated here to avoid a host dependency
 * on that package).
 */
export function resolvePresetId(
  header: { agentPreset?: string },
  events: readonly SidechatLogEvent[],
): string | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'agent-preset/selected') continue
    const preset = dataOf(event).agentPreset
    if (typeof preset === 'string') return preset
  }
  return header.agentPreset
}

/** One model route as the durable log records it (the shape of a
 *  `model/selection` event payload and of the core `modelSelection`
 *  projection rows). */
export interface SidechatModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/**
 * The model selection a session CURRENTLY runs, projected from its durable
 * log (mirror of the core `modelSelection` projection — replicated here
 * like resolvePresetId to avoid a host dependency). An explicit
 * `model/selection` event stays PENDING until a same-route `request/header`
 * consumes it; the value the composer's model selector shows is
 * `pending ?? lastUsed`.
 *
 * This is NOT what `agent.options.provider/model` holds: those freeze the
 * creation-time deployment default and are never rewritten by a UI model
 * switch — DSH 0.1.5 routes requests through the session-local selection
 * and its `agent/request` waterfall instead. Anyone inheriting "the
 * parent's current model" must read this projection; inheriting
 * `parent.options` verbatim silently ships the stale creation default
 * (issue #368).
 *
 * A `request/header` contributes provider/model/effort, EXCEPT when its
 * effort is marked as an adapter default (`adapterDefaults.reasoningEffort`)
 * which the core selection getter deliberately does not adopt as a sticky pick.
 */
export function parentModelSelection(
  events: readonly SidechatLogEvent[],
): SidechatModelSelection | undefined {
  let pending: SidechatModelSelection | undefined
  let lastUsed: SidechatModelSelection | undefined
  for (const event of events) {
    if (event.type === 'model/selection') {
      const selection = looseSelection(dataOf(event))
      if (selection !== undefined) pending = selection
      continue
    }
    if (event.type !== 'request/header') continue
    const header = (dataOf(event).header as {
      config?: unknown
      adapterDefaults?: { reasoningEffort?: boolean }
    } | undefined)
    const config = header?.config
    if (config === null || typeof config !== 'object') continue
    const selection = looseSelection(config as Record<string, unknown>)
    if (selection === undefined) continue
    const isDefaultEffort = header?.adapterDefaults?.reasoningEffort === true
    lastUsed = {
      provider: selection.provider,
      model: selection.model,
      ...(!isDefaultEffort && selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}),
    }
    if (sameSelection(pending, lastUsed)) pending = undefined
  }
  return pending ?? lastUsed
}

function sameSelection(
  left: SidechatModelSelection | undefined,
  right: SidechatModelSelection | undefined,
): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  return left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

/** Narrow one loose record into a model selection (non-empty strings only). */
function looseSelection(data: Record<string, unknown>): SidechatModelSelection | undefined {
  const { provider, model, reasoningEffort } = data
  if (typeof provider !== 'string' || provider === '') return undefined
  if (typeof model !== 'string' || model === '') return undefined
  return {
    provider,
    model,
    ...(typeof reasoningEffort === 'string' && reasoningEffort !== '' ? { reasoningEffort } : {}),
  }
}
