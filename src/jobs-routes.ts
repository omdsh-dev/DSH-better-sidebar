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
 * - 'jobs.kill' — the registry's stock `kill` (a pristine DSH API),
 *   fenced by the owning session via the live agent caller. Absent registry
 *   → 503, mirroring the settings routes' optional-service downgrade.
 */
import type { Context, SidebarSessionEvent } from './context-types.ts'
import { requireString, SidebarError } from './wire.ts'

/** The two background-job routes of the sidebar API. */
export interface SidebarJobsRoutes {
  /** The output the model has read so far for one job (event replay, capped). */
  output(payload: unknown): { text: string; truncated: boolean; read: boolean }
  /** Request cancellation of one job (live jobs flip to stopping). */
  kill(payload: unknown): { ok: true; outcome: 'requested' | 'already-finished' }
}

/** The 'tool/result' message envelope inside a session event's data. */
interface ToolResultMessageLike {
  source?: { kind?: unknown; callId?: unknown }
  content?: unknown
}

/** One 'tool-result' content block (the inner blocks carry the text). */
interface ToolResultBlockLike {
  type?: unknown
  content?: unknown
  isError?: unknown
}

/**
 * Extract the plain text of a finalized tool result: the text blocks inside
 * the 'tool-result' block, joined with newlines. Error results and
 * non-text blocks contribute nothing.
 */
function resultText(message: ToolResultMessageLike): string | undefined {
  if (!Array.isArray(message.content)) return undefined
  const parts: string[] = []
  for (const block of message.content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as ToolResultBlockLike
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
  return parts.length > 0 ? parts.join('\n') : undefined
}

/** Whether a tool/result is an error result (the inner block's isError flag). */
function resultIsError(message: ToolResultMessageLike): boolean {
  if (!Array.isArray(message.content)) return false
  return message.content.some((block) => {
    if (block === null || typeof block !== 'object') return false
    return (block as ToolResultBlockLike).type === 'tool-result'
      && (block as ToolResultBlockLike).isError === true
  })
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
 * Build the jobs routes bound to the plugin context. `output` merges the
 * owner session's own event log with the live job_output mirror; `kill`
 * reads the jobs/agents services lazily and degrades to a 503 when the
 * deployment lacks the registry.
 * @param ctx - host plugin context.
 * @param outputLimit - response cap for one output replay in bytes; longer
 *   texts are sliced and flagged `truncated` (mirrors the fs.read cap).
 */
export function buildJobsApi(ctx: Context, outputLimit: number): SidebarJobsRoutes {
  const jobs = ctx.get('jobs')
  const agents = ctx.get('agents')
  const mirror = createJobOutputMirror(ctx)
  /** The live caller whose session id the registry fence compares against. */
  const callerOf = (sessionId: string) => agents?.get(sessionId)
  /** Registry refusals become a 404 job-error; unknown and foreign ids are indistinguishable. */
  const registryError = (error: unknown): SidebarError =>
    new SidebarError('job-error', error instanceof Error ? error.message : String(error), 404)
  return {
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
      try {
        return { ok: true, outcome: jobs.kill(id, callerOf(sessionId), reason) }
      } catch (error) {
        throw registryError(error)
      }
    },
  }
}
