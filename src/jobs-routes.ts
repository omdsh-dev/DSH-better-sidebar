/**
 * Background-job routes of the /sidebar JSON API ('jobs.output' /
 * 'jobs.kill'). The job LIST needs no route: it arrives through the
 * harness's `session/jobs` push mirror (`jobsBySession` in the sessions
 * list feed). The routes:
 *
 * - 'jobs.output' — REPLAYS the output the MODEL has read so far for one
 *   job. The source is the owner session's own event log: `tool/call` rows
 *   of `job_output` name the job via `arguments.job_id`, and the paired
 *   `tool/result` rows carry the finalized content the model received.
 *   Because the session store's in-memory log can lag the live append feed
 *   after a host restart (the store session stays frozen at its
 *   rehydration boundary), the plugin ALSO mirrors job_output events from
 *   the live `session/event` feed and merges both sources (deduped by seq).
 *   This touches NO DSH source: the model's `job_output` cursor is never
 *   consumed, and the pane stays empty until the agent reads the job.
 * - 'jobs.kill' — the registry's stock `kill` (a pristine DSH API), fenced
 *   by the owning session id (the 0.1.7 registry compares `SessionId`, the
 *   0.1.6 one compared a live Agent). Absent registry → 503, mirroring the
 *   settings routes' optional-service downgrade.
 */
import type { Context, SidebarJobView, SidebarSessionEvent } from './context-types.ts'
import { requireString, SidebarError } from './wire.ts'

interface SidebarJobsService {
  list(sessionId: string): SidebarJobView[]
  kill(id: string, sessionId: string, reason: string): 'requested' | 'already-finished'
}

/** The background-job routes of the sidebar API. */
export interface SidebarJobsRoutes {
  /**
   * The caller-visible jobs of one session, read straight from the registry.
   *
   * DSH 0.1.7 stopped mirroring background jobs into the client session list
   * (`jobsBySession` is gone with no replacement), so the Tasks page reads
   * them here instead. This is also the more authoritative source: the mirror
   * was last-wins over push frames, while the registry is the state itself.
   */
  list(payload: unknown): { jobs: SidebarJobView[] }
  /** The output the model has read so far for one job (event replay, capped). */
  output(payload: unknown): { text: string; truncated: boolean; read: boolean }
  /** Request cancellation of one job (live jobs flip to stopping). */
  kill(payload: unknown): { ok: true; outcome: 'requested' | 'already-finished' }
}

/** The 'tool/result' message envelope inside a session event's data. */
interface ToolResultMessageLike {
  source?: { kind?: unknown; callId?: unknown }
  content?: unknown
  /** The 0.1.7 first-class tool message lifts the error flag onto the message. */
  isError?: unknown
}

/** One 'tool-result' content block (the inner blocks carry the text). */
interface ToolResultBlockLike {
  type?: unknown
  content?: unknown
  isError?: unknown
}

/**
 * The result blocks and error flag of one tool/result message, read under BOTH
 * logged shapes: 0.1.6 wrapped the result in a single `type: 'tool-result'`
 * content block on a user-role message (the text nested inside it, `isError`
 * on the wrapper), 0.1.7's first-class tool-role message carries the blocks at
 * the message's own top level with `isError` lifted onto the message.
 * Historical logs keep the old shape forever, so both are read. Undefined when
 * the message carries no block array.
 */
function resultOf(message: ToolResultMessageLike): { blocks: readonly unknown[]; isError: boolean } | undefined {
  if (!Array.isArray(message.content)) return undefined
  for (const block of message.content) {
    if (block === null || typeof block !== 'object') continue
    const wrapper = block as ToolResultBlockLike
    if (wrapper.type !== 'tool-result') continue
    return {
      blocks: Array.isArray(wrapper.content) ? wrapper.content as readonly unknown[] : [],
      isError: wrapper.isError === true,
    }
  }
  return { blocks: message.content as readonly unknown[], isError: message.isError === true }
}

/**
 * Extract the plain text of a finalized tool result: its text blocks, joined
 * with newlines. Error results and non-text blocks contribute nothing.
 */
function resultText(message: ToolResultMessageLike): string | undefined {
  const blocks = resultOf(message)?.blocks
  if (blocks === undefined) return undefined
  const parts: string[] = []
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') continue
    const textItem = item as { type?: unknown; text?: unknown }
    if (textItem.type === 'text' && typeof textItem.text === 'string') {
      parts.push(textItem.text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

/** Whether a tool/result is an error result (0.1.7's message-level flag, else
 *  the 0.1.6 wrapper block's flag). */
function resultIsError(message: ToolResultMessageLike): boolean {
  return resultOf(message)?.isError === true
}

/** Whether a job_output result carries no new output — the controller's
 *  model-facing "(no new output)" body, noise for the human pane. */
function isNoNewOutput(text: string): boolean {
  return text.startsWith('(no new output)')
}

/** One compact job_output trace (a tool/call or its paired tool/result). */
interface JobOutputTrace {
  seq: number
  kind: 'call' | 'result'
  /** The tool call identity pairing the two rows. */
  callId: string
  /** tool/call: the job id parsed from the model arguments. */
  jobId?: string
  /** tool/result: the finalized text the model received. */
  text?: string
  /** tool/result: whether the result was an error (read counts, text skipped). */
  isError?: boolean
}

/** Extract the job_output trace of one raw session event (undefined = unrelated). */
function traceOf(event: SidebarSessionEvent): JobOutputTrace | undefined {
  if (event.type === 'tool/call') {
    const data = event.data as { name?: unknown; callId?: unknown; arguments?: unknown }
    if (data.name !== 'job_output' || typeof data.callId !== 'string') return undefined
    let jobId: string | undefined
    try {
      const args = JSON.parse(typeof data.arguments === 'string' ? data.arguments : '') as { job_id?: unknown }
      if (typeof args.job_id === 'string') jobId = args.job_id
    } catch {
      // Malformed model arguments: not a job_output pair.
    }
    if (jobId === undefined) return undefined
    return { seq: event.seq, kind: 'call', callId: data.callId, jobId }
  }
  if (event.type === 'tool/result') {
    const message = (event.data as { message?: unknown }).message as ToolResultMessageLike | undefined
    if (message === undefined) return undefined
    const callId = message.source?.callId
    if (typeof callId !== 'string') return undefined
    return {
      seq: event.seq,
      kind: 'result',
      callId,
      text: resultText(message),
      isError: resultIsError(message),
    }
  }
  return undefined
}

/** Per-session cap of mirrored live traces (a bounded, lossy ring). */
const MIRROR_MAX_ENTRIES = 200

/**
 * The live job_output mirror: subscribes to the session append feed and
 * caches the job_output traces the session store's own log can lag behind
 * (after a host restart the store session stays frozen at its rehydration
 * boundary, so `session.events` misses everything appended since — the very
 * reads the pane exists to show). Zero DSH writes: the api-proxy pushes the
 * same feed to browsers.
 */
function createJobOutputMirror(ctx: Context): { entries(sessionId: string): readonly JobOutputTrace[] } {
  const perSession = new Map<string, JobOutputTrace[]>()
  // tool/call identities per session, so unrelated tool/result rows are
  // never cached (only job_output results pair with a cached call).
  const callIds = new Map<string, Set<string>>()
  if (typeof ctx.on !== 'function') {
    // Test doubles without the event API degrade to seed-only replay.
    return { entries: () => [] }
  }
  const dispose = ctx.on('session/event', (session, event) => {
    const sessionId = (session as { id?: unknown } | null)?.id
    if (typeof sessionId !== 'string') return
    if (event.type === 'tool/call') {
      const trace = traceOf(event)
      if (trace?.kind !== 'call') return
      let ids = callIds.get(sessionId)
      if (ids === undefined) callIds.set(sessionId, ids = new Set())
      ids.add(trace.callId)
      push(sessionId, trace)
    } else if (event.type === 'tool/result') {
      const trace = traceOf(event)
      if (trace?.kind !== 'result') return
      if (!callIds.get(sessionId)?.has(trace.callId)) return
      push(sessionId, trace)
    }
  })
  ctx.effect(() => dispose, 'dsh-better-sidebar: job-output event mirror')

  const push = (sessionId: string, trace: JobOutputTrace): void => {
    let list = perSession.get(sessionId)
    if (list === undefined) perSession.set(sessionId, list = [])
    list.push(trace)
    if (list.length > MIRROR_MAX_ENTRIES) {
      const removed = list.splice(0, list.length - MIRROR_MAX_ENTRIES)
      const ids = callIds.get(sessionId)
      if (ids !== undefined) {
        for (const entry of removed) {
          if (entry.kind === 'call') ids.delete(entry.callId)
        }
        if (ids.size === 0) callIds.delete(sessionId)
      }
    }
  }

  return { entries: (sessionId) => perSession.get(sessionId) ?? [] }
}

/**
 * Tracy: the jobs `sessionId` itself owns, from the registry's caller view (which adds every
 * unowned job). What makes the jobs routes session-scoped, so the gate can hold them to the seat's
 * session grant like the Files tab's routes.
 */
function ownJobs(jobs: SidebarJobsService, sessionId: string): SidebarJobView[] {
  return jobs.list(sessionId).filter(job => job.owner === sessionId)
}

/**
 * Build the jobs routes bound to the plugin context. `list` reads the
 * registry's own projection, `output` merges the owner session's event log
 * with the live job_output mirror, and `kill` cancels through the registry.
 * Every route that needs the registry degrades to a 503 when the deployment
 * lacks it.
 * @param ctx - host plugin context.
 * @param outputLimit - response cap for one output replay in bytes; longer
 *   texts are sliced and flagged `truncated` (mirrors the fs.read cap).
 */
export function buildJobsApi(ctx: Context, outputLimit: number): SidebarJobsRoutes {
  const jobs = ctx.get('jobs') as unknown as SidebarJobsService | undefined
  const mirror = createJobOutputMirror(ctx)
  /** Registry refusals become a 404 job-error; unknown and foreign ids are indistinguishable. */
  const registryError = (error: unknown): SidebarError =>
    new SidebarError('job-error', error instanceof Error ? error.message : String(error), 404)
  /** The registry, or the 503 every registry-backed route returns without it. */
  const requireJobs = (): SidebarJobsService => {
    if (jobs === undefined) {
      throw new SidebarError('job-error', 'the background-job registry is not mounted in this deployment', 503)
    }
    return jobs
  }
  return {
    list(payload) {
      const sessionId = requireString(payload, 'sessionId')
      try {
        // Tracy: the named session's OWN jobs only. The registry also answers every unowned job to
        // any caller; kept, a job one customer's work left unowned would list for every seat on
        // the host, and the gate in front of dsh could only close the whole route (TCH #515).
        return { jobs: ownJobs(requireJobs(), sessionId) }
      } catch (error) {
        if (error instanceof SidebarError) throw error
        throw registryError(error)
      }
    },
    output(payload) {
      const sessionId = requireString(payload, 'sessionId')
      const id = requireString(payload, 'id')
      // Merge the store's event log (durable seed + whatever it received)
      // with the live mirror, deduped by seq — a trace never double-counts.
      const bySeq = new Map<number, JobOutputTrace>()
      for (const event of ctx.sessions.get(sessionId)?.snapshotEvents() ?? []) {
        const trace = traceOf(event)
        if (trace !== undefined) bySeq.set(trace.seq, trace)
      }
      for (const trace of mirror.entries(sessionId)) bySeq.set(trace.seq, trace)
      // Pair calls with results in seq order: the model's reads, oldest first.
      const jobOf = new Map<string, string>()
      const parts: string[] = []
      let read = false
      for (const trace of [...bySeq.values()].sort((left, right) => left.seq - right.seq)) {
        if (trace.kind === 'call') {
          if (trace.jobId !== undefined) jobOf.set(trace.callId, trace.jobId)
        } else if (jobOf.get(trace.callId) === id) {
          read = true
          if (trace.isError !== true && trace.text !== undefined && !isNoNewOutput(trace.text)) {
            parts.push(trace.text)
          }
        }
      }
      const text = parts.join('\n')
      return {
        text: text.length > outputLimit ? text.slice(0, outputLimit) : text,
        truncated: text.length > outputLimit,
        read,
      }
    },
    kill(payload) {
      if (jobs === undefined) {
        throw new SidebarError('job-error', 'the background-job registry is not mounted in this deployment', 503)
      }
      const sessionId = requireString(payload, 'sessionId')
      const id = requireString(payload, 'id')
      const record = payload as { reason?: unknown } | null
      const reason = typeof record?.reason === 'string' && record.reason !== ''
        ? record.reason
        : 'user requested via sidebar'
      // Tracy: the same fence as `list` — the registry lets any caller kill an unowned job, so a job
      // the named session does not own is answered exactly like an unknown one.
      if (!ownJobs(jobs, sessionId).some(job => job.id === id)) {
        throw registryError(new Error(`unknown job "${id}"`))
      }
      try {
        // The 0.1.7 registry fences by SessionId, not by live Agent.
        return { ok: true, outcome: jobs.kill(id, sessionId, reason) }
      } catch (error) {
        throw registryError(error)
      }
    },
  }
}
