/**
 * Unit tests for the workflow-run fold (`foldWorkflowRuns`): the pure
 * derivation that turns one session's `tool-workflow/*` events into the run
 * views the Tasks page renders (the same four event types the official
 * `dsh-client-ui-workflow-run` panel folds).
 */
import { describe, expect, it } from 'vitest'
import { foldWorkflowRuns, type WorkflowRunView } from '../src/workflow-runs.ts'
import type { SidebarSessionEvent } from '../src/context-types.ts'

/** One event row. */
function ev(seq: number, type: string, data: Record<string, unknown>, time = 0): SidebarSessionEvent {
  return { type, seq, time, data }
}

/** The full lifecycle of one run with two phases. */
function lifecycle(seq = 1): SidebarSessionEvent[] {
  return [
    ev(seq, 'tool-workflow/run-start', { runId: 'run-1', name: 'repo-audit' }, 1000),
    ev(seq + 1, 'tool-workflow/agent-start', { runId: 'run-1', seq: 1, label: '扫描 src', phase: '侦察', childId: 'child-a' }),
    ev(seq + 2, 'tool-workflow/agent-start', { runId: 'run-1', seq: 2, label: '扫描 tests', phase: '侦察', childId: 'child-b' }),
    ev(seq + 3, 'tool-workflow/agent-end', { runId: 'run-1', seq: 1, outcome: 'completed' }),
    ev(seq + 4, 'tool-workflow/agent-start', { runId: 'run-1', seq: 3, label: '生成报告', phase: '汇总', childId: 'child-c' }),
    ev(seq + 5, 'tool-workflow/agent-end', { runId: 'run-1', seq: 2, outcome: 'failed' }),
    ev(seq + 6, 'tool-workflow/run-end', { runId: 'run-1', stopReason: 'completed' }, 5000),
  ]
}

describe('foldWorkflowRuns', () => {
  it('folds a full lifecycle into phases with outcomes', () => {
    const runs = foldWorkflowRuns(lifecycle(), 'origin')
    expect(runs).toHaveLength(1)
    const run = runs[0] as WorkflowRunView
    expect(run).toMatchObject({
      runId: 'run-1',
      name: 'repo-audit',
      originSessionId: 'origin',
      status: 'completed',
      stopReason: 'completed',
      startedSeq: 1,
      startedAt: 1000,
      finishedAt: 5000,
    })
    expect(run.phases.map(phase => phase.title)).toEqual(['侦察', '汇总'])
    const [scout, report] = run.phases
    expect(scout?.members.map(member => [member.seq, member.label, member.outcome])).toEqual([
      [1, '扫描 src', 'completed'],
      [2, '扫描 tests', 'failed'],
    ])
    expect(report?.members).toHaveLength(1)
    expect(report?.members[0]).toMatchObject({ seq: 3, label: '生成报告', childId: 'child-c' })
    expect(report?.members[0]?.outcome).toBeUndefined()
  })

  it('keeps a run without run-end running', () => {
    const runs = foldWorkflowRuns(lifecycle().slice(0, 3), 'origin')
    expect(runs[0]?.status).toBe('running')
    expect(runs[0]?.stopReason).toBeUndefined()
    expect(runs[0]?.finishedAt).toBeUndefined()
  })

  it('maps stopReason error to the failed display status', () => {
    const runs = foldWorkflowRuns([
      ev(1, 'tool-workflow/run-start', { runId: 'r', name: 'n' }),
      ev(2, 'tool-workflow/run-end', { runId: 'r', stopReason: 'error' }, 42),
    ], 'origin')
    expect(runs[0]).toMatchObject({ status: 'failed', stopReason: 'error', finishedAt: 42 })
  })

  it('groups unphased members into one untitled phase in first-seen order', () => {
    const runs = foldWorkflowRuns([
      ev(1, 'tool-workflow/run-start', { runId: 'r', name: 'n' }),
      ev(2, 'tool-workflow/agent-start', { runId: 'r', seq: 1, label: 'a', childId: 'c1' }),
      ev(3, 'tool-workflow/agent-start', { runId: 'r', seq: 2, label: 'b', phase: 'p', childId: 'c2' }),
      ev(4, 'tool-workflow/agent-start', { runId: 'r', seq: 3, label: 'c', childId: 'c3' }),
    ], 'origin')
    const run = runs[0] as WorkflowRunView
    expect(run.phases.map(phase => phase.title)).toEqual([undefined, 'p'])
    expect(run.phases[0]?.members.map(member => member.seq)).toEqual([1, 3])
  })

  it('skips orphan rows that reference an unknown run', () => {
    const runs = foldWorkflowRuns([
      ev(1, 'tool-workflow/agent-start', { runId: 'ghost', seq: 1, label: 'a', childId: 'c' }),
      ev(2, 'tool-workflow/agent-end', { runId: 'ghost', seq: 1, outcome: 'completed' }),
      ev(3, 'tool-workflow/run-end', { runId: 'ghost', stopReason: 'completed' }),
    ], 'origin')
    expect(runs).toEqual([])
  })

  it('ignores a duplicated run-start and non-run events', () => {
    const runs = foldWorkflowRuns([
      ev(1, 'tool-workflow/run-start', { runId: 'r', name: 'first' }),
      ev(2, 'assistant/message', { message: { content: [{ type: 'text', text: 'hi' }] } }),
      ev(3, 'tool-workflow/run-start', { runId: 'r', name: 'second' }),
    ], 'origin')
    expect(runs).toHaveLength(1)
    expect(runs[0]?.name).toBe('first')
  })

  it('keeps multiple runs in run-start order with their own member books', () => {
    const runs = foldWorkflowRuns([
      ev(1, 'tool-workflow/run-start', { runId: 'a', name: 'A' }),
      ev(2, 'tool-workflow/agent-start', { runId: 'a', seq: 1, label: 'a1', childId: 'ca' }),
      ev(3, 'tool-workflow/run-start', { runId: 'b', name: 'B' }),
      ev(4, 'tool-workflow/agent-start', { runId: 'b', seq: 1, label: 'b1', childId: 'cb' }),
      ev(5, 'tool-workflow/agent-end', { runId: 'a', seq: 1, outcome: 'completed' }),
    ], 'origin')
    expect(runs.map(run => run.runId)).toEqual(['a', 'b'])
    expect(runs[0]?.phases[0]?.members[0]).toMatchObject({ label: 'a1', outcome: 'completed' })
    expect(runs[1]?.phases[0]?.members[0]?.label).toBe('b1')
    expect(runs[1]?.phases[0]?.members[0]?.outcome).toBeUndefined()
  })

  it('validates agent-end outcomes and ignores malformed rows', () => {
    const runs = foldWorkflowRuns([
      ev(1, 'tool-workflow/run-start', { runId: 'r', name: 'n' }),
      ev(2, 'tool-workflow/agent-start', { runId: 'r', seq: 1, label: 'a', childId: 'c' }),
      ev(3, 'tool-workflow/agent-end', { runId: 'r', seq: 1, outcome: 'bogus' }),
      ev(4, 'tool-workflow/agent-end', { runId: 'r', seq: 'not-a-number', outcome: 'completed' }),
    ], 'origin')
    expect(runs[0]?.phases[0]?.members[0]?.outcome).toBeUndefined()
  })

  it('falls back to runId/#seq labels when name/label are empty', () => {
    const runs = foldWorkflowRuns([
      ev(1, 'tool-workflow/run-start', { runId: 'r', name: '' }),
      ev(2, 'tool-workflow/agent-start', { runId: 'r', seq: 7, label: '', childId: 'c' }),
    ], 'origin')
    expect(runs[0]?.name).toBe('r')
    expect(runs[0]?.phases[0]?.members[0]?.label).toBe('#7')
  })
})
