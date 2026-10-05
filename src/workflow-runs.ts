/**
 * Pure derivation of the workflow-run views shown on the Tasks page: fold one
 * session's event log into the `tool-workflow/*` runs that originated there.
 *
 * The recorder inside DSH's `dsh-tool-workflow` appends exactly four event
 * types to the CALLING agent's session (top-level runs only — nested runs
 * inside workflow agents are never recorded):
 *
 * - `tool-workflow/run-start`   `{ runId, name }`
 * - `tool-workflow/agent-start` `{ runId, seq, label, phase?, childId }`
 * - `tool-workflow/agent-end`   `{ runId, seq, outcome }`
 * - `tool-workflow/run-end`     `{ runId, stopReason }`
 *
 * (Evidence: `dsh-tool-workflow/lib/index.js:37-88`; the official
 * `dsh-client-ui-workflow-run` panel folds the identical four types in the
 * browser.) This module mirrors that fold framework-free so it is
 * unit-testable in the node environment; the host route merges the durable
 * log with the live mirror and the client receives ready-made views.
 */
import type { SidebarSessionEvent } from './context-types.ts'

/** Outcome of one workflow member agent (the domain's closed union). */
export type WorkflowAgentOutcome = 'completed' | 'failed' | 'cancelled'

/** Settled reason of one run (`error` maps to the `failed` display status). */
export type WorkflowStopReason = 'completed' | 'cancelled' | 'error'

/** One member agent of a workflow run (`agent-start` + optional `agent-end`). */
export interface WorkflowRunMemberView {
  /** Worker-side `agent()` call sequence number (pairs start/end). */
  seq: number
  /** Model-supplied member label. */
  label: string
  /** Phase grouping title supplied at start (absent = unphased). */
  phase?: string
  /** The member's child session id — the jump target of the row. */
  childId: string
  /** Set once `agent-end` lands; absent while the member runs. */
  outcome?: WorkflowAgentOutcome
}

/** Members of one phase, in first-seen order (title undefined = unphased). */
export interface WorkflowRunPhaseView {
  title?: string
  members: WorkflowRunMemberView[]
}

/** Display status of one run (the official panel's vocabulary). */
export type WorkflowRunStatus = 'running' | 'completed' | 'cancelled' | 'failed'

/** One folded workflow run as the Tasks page renders it. */
export interface WorkflowRunView {
  runId: string
  name: string
  /** The session the run was started from (the events' home session). */
  originSessionId: string
  status: WorkflowRunStatus
  /** Settled reason once `run-end` landed (`error` ⇔ status `failed`). */
  stopReason?: WorkflowStopReason
  /** Phase-grouped members, phases in first-seen order. */
  phases: WorkflowRunPhaseView[]
  /** Seq of the run-start event (stable ordering across runs). */
  startedSeq: number
  /** Epoch ms of the run-start event (durations and sorting). */
  startedAt: number
  /** Epoch ms of the run-end event; absent while running. */
  finishedAt?: number
}

/** The four recorded event types (prefix match keeps the scan cheap). */
const EVENT_PREFIX = 'tool-workflow/'

/** The mutable fold state of one run (member rows indexed by seq). */
interface RunFold {
  view: WorkflowRunView
  memberBySeq: Map<number, WorkflowRunMemberView>
}

/**
 * Fold one session's event log into its workflow runs, oldest first. Rows
 * referencing an unknown run (a log window that starts mid-run, or a corrupt
 * tail) are skipped — the official panel asserts a leading run-start instead,
 * but the route merges two sources where ordering is guaranteed anyway.
 * @param events - the session's append-only event log (oldest → newest).
 * @param originSessionId - the session the log belongs to.
 * @returns the session's runs in run-start order.
 */
export function foldWorkflowRuns(
  events: readonly SidebarSessionEvent[],
  originSessionId: string,
): WorkflowRunView[] {
  const runs: RunFold[] = []
  const byRunId = new Map<string, RunFold>()
  for (const event of events) {
    if (!event.type.startsWith(EVENT_PREFIX)) continue
    const data = event.data
    switch (event.type) {
      case 'tool-workflow/run-start': {
        const runId = typeof data.runId === 'string' ? data.runId : undefined
        if (runId === undefined || byRunId.has(runId)) break
        const fold: RunFold = {
          view: {
            runId,
            name: typeof data.name === 'string' && data.name !== '' ? data.name : runId,
            originSessionId,
            status: 'running',
            phases: [],
            startedSeq: event.seq,
            startedAt: event.time,
          },
          memberBySeq: new Map(),
        }
        byRunId.set(runId, fold)
        runs.push(fold)
        break
      }
      case 'tool-workflow/agent-start': {
        const fold = runOf(data, byRunId)
        const seq = seqOf(data)
        if (fold === undefined || seq === undefined || fold.memberBySeq.has(seq)) break
        const member: WorkflowRunMemberView = {
          seq,
          label: typeof data.label === 'string' && data.label !== '' ? data.label : `#${seq}`,
          ...(typeof data.phase === 'string' ? { phase: data.phase } : {}),
          childId: typeof data.childId === 'string' ? data.childId : '',
        }
        fold.memberBySeq.set(seq, member)
        // Phase groups in first-seen order; unphased members share one group.
        let phase = fold.view.phases.find(candidate => candidate.title === member.phase)
        if (phase === undefined) {
          phase = member.phase === undefined ? { members: [] } : { title: member.phase, members: [] }
          fold.view.phases.push(phase)
        }
        phase.members.push(member)
        break
      }
      case 'tool-workflow/agent-end': {
        const fold = runOf(data, byRunId)
        const seq = seqOf(data)
        const member = fold?.memberBySeq.get(seq ?? -1)
        if (member === undefined) break
        const outcome = data.outcome
        if (outcome === 'completed' || outcome === 'failed' || outcome === 'cancelled') {
          member.outcome = outcome
        }
        break
      }
      case 'tool-workflow/run-end': {
        const fold = runOf(data, byRunId)
        if (fold === undefined) break
        const stopReason = data.stopReason
        if (stopReason === 'completed' || stopReason === 'cancelled' || stopReason === 'error') {
          fold.view.stopReason = stopReason
          fold.view.status = stopReason === 'error' ? 'failed' : stopReason
        } else {
          fold.view.status = 'failed'
        }
        fold.view.finishedAt = event.time
        break
      }
      default:
        break
    }
  }
  return runs.map(fold => fold.view)
}

/** The run a workflow event belongs to (undefined = unknown/orphan row). */
function runOf(
  data: Record<string, unknown>,
  byRunId: ReadonlyMap<string, RunFold>,
): RunFold | undefined {
  const runId = data.runId
  return typeof runId === 'string' ? byRunId.get(runId) : undefined
}

/** The member sequence number of one agent-start/agent-end row. */
function seqOf(data: Record<string, unknown>): number | undefined {
  const seq = data.seq
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined
}
