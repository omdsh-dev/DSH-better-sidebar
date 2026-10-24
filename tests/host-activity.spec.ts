/**
 * `isSessionActivityIdle` — the predicate behind the opt-in auto-collapse
 * (`autoCollapseAfterIdle`). It answers "is the activity that popped the Tasks
 * page over?", so the cases that matter are exactly the ones that keep a column
 * on screen: a live host job or a running direct subagent. The
 * feed is plain data, so every case is a table row.
 */
import { describe, expect, it } from 'vitest'
import { isSessionActivityIdle } from '../src/client/host-activity.ts'
import type { SidebarJobStatus, SidebarJobView, SidebarSessionList } from '../src/context-types.ts'

const ROOT = 'root'

function list(overrides: Partial<SidebarSessionList> = {}): SidebarSessionList {
  return {
    byId: { [ROOT]: { id: ROOT, displayTitle: 'Root' } },
    ...overrides,
  }
}

function job(status: SidebarJobStatus): readonly SidebarJobView[] {
  return [{
    id: 'bash-1',
    kind: 'bash',
    label: 'sleep 30',
    status,
    startedAt: 1_000,
    ...(status === 'running' ? {} : { finishedAt: 2_000 }),
  }]
}

describe('isSessionActivityIdle', () => {
  it('is idle when nothing is reported at all', () => {
    expect(isSessionActivityIdle(list(), ROOT)).toBe(true)
  })

  it('is busy while a job is running', () => {
    expect(isSessionActivityIdle(list(), ROOT, job('running'))).toBe(false)
  })

  it('is busy while a job is stopping', () => {
    expect(isSessionActivityIdle(list(), ROOT, job('stopping'))).toBe(false)
  })

  it.each(['completed', 'killed', 'failed'] as const)('is idle once the job settled as %s', (status) => {
    expect(isSessionActivityIdle(list(), ROOT, job(status))).toBe(true)
  })

  it('is busy while a direct subagent is running', () => {
    const feed = list({
      byId: {
        [ROOT]: { id: ROOT, displayTitle: 'Root' },
        child: { id: 'child', displayTitle: 'Worker', origin: 'subagent', parentId: ROOT, running: true },
      },
    })
    expect(isSessionActivityIdle(feed, ROOT)).toBe(false)
  })

  it('is idle once that subagent stopped', () => {
    const feed = list({
      byId: {
        [ROOT]: { id: ROOT, displayTitle: 'Root' },
        child: { id: 'child', displayTitle: 'Worker', origin: 'subagent', parentId: ROOT, running: false },
      },
    })
    expect(isSessionActivityIdle(feed, ROOT)).toBe(true)
  })

  it('ignores a Side Chat thread: it rides the subagent origin but is not topology', () => {
    const feed = list({
      byId: {
        [ROOT]: { id: ROOT, displayTitle: 'Root' },
        thread: {
          id: 'thread',
          displayTitle: 'Side: how do I build this',
          origin: 'subagent',
          parentId: ROOT,
          running: true,
        },
      },
    })
    expect(isSessionActivityIdle(feed, ROOT)).toBe(true)
  })

  it('ignores another conversation\'s activity', () => {
    const feed = list({
      byId: {
        [ROOT]: { id: ROOT, displayTitle: 'Root' },
        child: { id: 'child', displayTitle: 'Worker', origin: 'subagent', parentId: 'other', running: true },
      },
    })
    expect(isSessionActivityIdle(feed, ROOT)).toBe(true)
  })
})
