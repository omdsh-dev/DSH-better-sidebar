/**
 * Pure-helper tests for the Tasks page's background-job presentation:
 * tree-membership, ordering, status mapping, and the auto-open trigger's
 * "is this really new work?" rule.
 */
import { describe, expect, it } from 'vitest'
import {
  detectNewJob,
  formatJobDuration,
  isJobLive,
  orderJobs,
  jobDotState,
  jobStatusLabel,
  treeSessionIds,
} from '../src/client/subagent-jobs.ts'
import type { SidebarSessionSummary, SidebarJobStatus, SidebarJobView } from '../src/context-types.ts'

/** The translator stub: renders duration templates like the real locale copy. */
const templates: Record<string, string> = {
  jobDurationSeconds: '{seconds}秒',
  jobDurationMinutes: '{minutes}分{seconds}秒',
  jobDurationHours: '{hours}小时{minutes}分',
}
const t = (key: string, params?: Record<string, string | number>): string => {
  let text = templates[key] ?? key
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

function summary(id: string, over: Partial<SidebarSessionSummary> = {}): SidebarSessionSummary {
  return { id, displayTitle: `title-${id}`, ...over }
}

function job(id: string, over: Partial<SidebarJobView> = {}): SidebarJobView {
  return { id, kind: 'bash', label: `cmd ${id}`, status: 'running', startedAt: 1_000, ...over }
}

describe('treeSessionIds', () => {
  it('includes the root and every subagent-origin session whose chain reaches it', () => {
    const byId = {
      root: summary('root'),
      child: summary('child', { origin: 'subagent', parentId: 'root' }),
      grand: summary('grand', { origin: 'subagent', parentId: 'child' }),
      orphan: summary('orphan', { origin: 'subagent', parentId: 'gone' }),
      other: summary('other', { origin: 'subagent', parentId: 'other-root' }),
    }
    const ids = treeSessionIds(byId, 'root')
    expect([...ids].sort()).toEqual(['child', 'grand', 'root'])
  })

  it('fails soft on parent cycles and yields nothing without a root', () => {
    const byId = {
      root: summary('root'),
      a: summary('a', { origin: 'subagent', parentId: 'b' }),
      b: summary('b', { origin: 'subagent', parentId: 'a' }),
    }
    expect(treeSessionIds(byId, 'root').size).toBe(1)
    expect(treeSessionIds(byId, undefined).size).toBe(0)
  })
})

describe('orderJobs', () => {
  it('puts live rows first in start order, then settled rows newest-first', () => {
    const row = (id: string, status: SidebarJobStatus, startedAt: number, finishedAt?: number) => ({
      ownerSessionId: 'root',
      ownerTitle: 'root',
      job: job(id, { status, startedAt, ...(finishedAt !== undefined ? { finishedAt } : {}) }),
    })
    const rows = [
      row('old-settled', 'completed', 1_000, 2_000),
      row('live-2', 'running', 4_000),
      row('new-settled', 'killed', 1_500, 1_800),
      row('live-1', 'stopping', 3_000),
    ]
    expect(orderJobs(rows).map(r => r.job.id)).toEqual(['live-1', 'live-2', 'old-settled', 'new-settled'])
  })
})

describe('status presentation helpers', () => {
  it('treats running and stopping as live', () => {
    expect(isJobLive(job('a', { status: 'running' }))).toBe(true)
    expect(isJobLive(job('b', { status: 'stopping' }))).toBe(true)
    expect(isJobLive(job('c', { status: 'completed' }))).toBe(false)
    expect(isJobLive(job('d', { status: 'killed' }))).toBe(false)
    expect(isJobLive(job('e', { status: 'failed' }))).toBe(false)
  })

  it('maps the five wire statuses to dot states and localized labels', () => {
    expect(jobDotState('running')).toBe('ongoing')
    expect(jobDotState('stopping')).toBe('warning')
    expect(jobDotState('completed')).toBe('done')
    expect(jobDotState('killed')).toBe('warning')
    expect(jobDotState('failed')).toBe('error')
    expect(jobStatusLabel('running', t)).toBe('jobStatusRunning')
    expect(jobStatusLabel('stopping', t)).toBe('jobStatusStopping')
    expect(jobStatusLabel('completed', t)).toBe('jobStatusCompleted')
    expect(jobStatusLabel('killed', t)).toBe('jobStatusKilled')
    expect(jobStatusLabel('failed', t)).toBe('jobStatusFailed')
  })

  it('formats durations in at most two adjacent units', () => {
    expect(formatJobDuration(0, t)).toBe('0秒')
    expect(formatJobDuration(45_000, t)).toBe('45秒')
    expect(formatJobDuration(90_000, t)).toBe('1分30秒')
    expect(formatJobDuration(3_661_000, t)).toBe('1小时1分')
    // Negative or fractional input clamps to zero seconds.
    expect(formatJobDuration(-5, t)).toBe('0秒')
  })
})

describe('detectNewJob', () => {
  /**
   * The baseline rule the auto-open trigger adds on top of this helper: the
   * FIRST frame a page observes only arms the baseline, so a conversation that
   * is already running jobs when the page loads never pops the Tasks page. The
   * helper itself is pure over two frames — plus the WATCH CLOCK (`since`),
   * which is what keeps that promise now that the roster is a push stream
   * whose empty frames are indistinguishable from "not delivered yet".
   */
  it('fires on EVERY job id the previous list lacked, and on nothing else', () => {
    // A new id appears (the first job, then another one alongside it).
    expect(detectNewJob([], [job('bash-1')])).toBe(true)
    expect(detectNewJob([job('bash-1')], [job('bash-1'), job('bash-2')])).toBe(true)
    // Settling only mutates status: same ids, no trigger.
    expect(detectNewJob(
      [job('bash-1')],
      [job('bash-1', { status: 'completed', finishedAt: 2_000 })],
    )).toBe(false)
    // Identical lists, and lists that only LOST a job (settled and dropped),
    // are not new work.
    expect(detectNewJob([job('bash-1')], [job('bash-1')])).toBe(false)
    expect(detectNewJob([job('bash-1'), job('bash-2')], [job('bash-2')])).toBe(false)
    // The first frame of a fresh page is compared against itself by the caller
    // (prev stays undefined until a frame lands) — the helper's quiet case.
    expect(detectNewJob([], [])).toBe(false)
  })

  it('ignores work that started before the watcher opened', () => {
    const watchStart = 10_000
    // The page mounts while a job already runs: its id is new to the id-set
    // diff, but its start time predates the watch.
    expect(detectNewJob([], [job('bash-1', { startedAt: 500 })], watchStart)).toBe(false)
    // Work the agent starts after the watcher opened still triggers.
    expect(detectNewJob([], [job('bash-1', { startedAt: 10_000 })], watchStart)).toBe(true)
    expect(detectNewJob([], [job('bash-1', { startedAt: 12_000 })], watchStart)).toBe(true)
    // An already-seen id never triggers, however new its stamp.
    expect(detectNewJob([job('bash-1')], [job('bash-1', { startedAt: 20_000 })], watchStart)).toBe(false)
    // Omitting the clock keeps the old id-set behaviour.
    expect(detectNewJob([], [job('bash-1', { startedAt: 0 })])).toBe(true)
  })
})
