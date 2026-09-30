/**
 * Unit tests for the unified Tasks view model (buildTasksModel / tasksEdges):
 * catalog walking, workflow run attachment + member re-parenting, team
 * enrichment, and the per-parent settled-leaf fold.
 */
import { describe, expect, it } from 'vitest'
import {
  buildTasksModel,
  tasksEdges,
  type TasksAgentNode,
  type TasksModelInput,
  type TasksNode,
} from '../src/client/tasks-model.ts'
import type {
  SidebarSessionSummary,
  SidebarSubagentCatalogEntry,
} from '../src/context-types.ts'
import type { TeamMemberRow } from '../src/client/team-projection.ts'
import {
  foldPreviews, taskBlocked, taskDotState, taskStatusLabel, taskTone,
} from '../src/client/tasks-shared.tsx'
import type { SubagentCatalogView } from '../src/client/subagent-catalog.ts'
import type { SidebarChildLiveView } from '../src/context-types.ts'
import type { WorkflowRunView } from '../src/workflow-runs.ts'

/** A summary row. */
function summary(id: string, over: Partial<SidebarSessionSummary> = {}): SidebarSessionSummary {
  return { id, displayTitle: id, ...over }
}

/** One `subagentCatalog` projection row (DSH 0.1.7 shape). */
function child(id: string, over: Partial<SidebarSubagentCatalogEntry> = {}): SidebarSubagentCatalogEntry {
  return { id, createdAt: 0, mode: 'one-shot', ...over }
}

/** A loaded catalog view (what the projection folds into). */
function catalog(entries: SidebarSubagentCatalogEntry[]): SubagentCatalogView {
  return { entries, state: 'ready', error: null }
}

/** The live channel's fold: only the RUNNING children appear (DSH 0.1.7). */
/** The live map of a set of RUNNING sessions (the new live-view shape). */
function running(...ids: string[]): Record<string, SidebarChildLiveView> {
  return Object.fromEntries(ids.map(id => [id, { running: true, text: `${id} is working` }]))
}

/** A workflow run view. */
function run(over: Partial<WorkflowRunView> = {}): WorkflowRunView {
  return {
    runId: 'run-1', name: 'audit', originSessionId: 'root', status: 'running',
    phases: [], startedSeq: 1, startedAt: 0, ...over,
  }
}

/** A derived roster row (the shape ./team-projection.ts hands the model). */
function member(over: Partial<TeamMemberRow> = {}): TeamMemberRow {
  return { id: 'x', name: 'n', role: 'teammate', phase: 'active', status: 'running', diagnostics: [], ...over }
}

/** A base input; override per test. */
function input(over: Partial<TasksModelInput> = {}): TasksModelInput {
  return {
    byId: { root: summary('root', { displayTitle: 'Root', running: true }) },
    catalogs: {},
    rootId: 'root',
    currentSessionId: 'root',
    live: {},
    runs: [],
    teamMembers: [],
    folded: true,
    ...over,
  }
}

/** All agent nodes of a model. */
function agents(nodes: readonly TasksNode[]): TasksAgentNode[] {
  return nodes.filter((node): node is TasksAgentNode => node.kind === 'agent')
}

describe('buildTasksModel', () => {
  it('walks the catalogs in pre-order and marks the current session', () => {
    const model = buildTasksModel(input({
      catalogs: {
        root: catalog([child('a'), child('b')]),
        a: catalog([child('a1')]),
      },
      byId: {
        root: summary('root', { displayTitle: 'Root', running: true }),
        a: summary('a'), b: summary('b'), a1: summary('a1'),
      },
      currentSessionId: 'a1',
      live: running('a', 'a1'),
      folded: false,
    }))
    expect(model.map(node => node.id)).toEqual(['root', 'a', 'a1', 'b'])
    expect(agents(model).find(node => node.id === 'a1')?.current).toBe(true)
    expect(agents(model).find(node => node.id === 'a1')?.childAddress).toEqual({
      parentSessionId: 'a', childSessionId: 'a1', mode: 'one-shot',
    })
    // Activity comes from the live channel, and `b` (absent there) is settled.
    expect(agents(model).find(node => node.id === 'a')?.state).toBe('running')
    expect(agents(model).find(node => node.id === 'b')?.state).toBe('done')
  })

  it('excludes Side Chat threads from the model', () => {
    const model = buildTasksModel(input({
      catalogs: { root: catalog([child('a'), child('side', { label: 'Side: 闲聊' })]) },
      byId: { root: summary('root'), a: summary('a'), side: summary('side') },
    }))
    expect(model.map(node => node.id)).toEqual(['root', 'a'])
  })

  it('re-parents run members under the run node and synthesizes missing ones', () => {
    const audit = run({
      originSessionId: 'root',
      phases: [{
        title: '侦察',
        members: [
          { seq: 1, label: 'existing', phase: '侦察', childId: 'm1', outcome: 'completed' },
          { seq: 2, label: 'synthesized', phase: '侦察', childId: 'm2' },
        ],
      }],
    })
    const model = buildTasksModel(input({
      catalogs: { root: catalog([child('m1')]) },
      byId: { root: summary('root'), m1: summary('m1', { displayTitle: 'M1' }) },
      runs: [audit],
      folded: false,
    }))
    expect(model.map(node => node.id)).toEqual(['root', 'run:run-1', 'm1', 'm2'])
    const synthesized = agents(model).find(node => node.id === 'm2')
    expect(synthesized).toMatchObject({ parentId: 'run:run-1', label: 'synthesized', synthesized: true, state: 'running' })
    const existing = agents(model).find(node => node.id === 'm1')
    expect(existing?.parentId).toBe('run:run-1')
  })

  it('enriches teammates and the lead from the roster projection', () => {
    const model = buildTasksModel(input({
      catalogs: { root: catalog([child('w', { label: 'writer' })]) },
      byId: { root: summary('root'), w: summary('w') },
      teamMembers: [
        member({ id: 'root', name: 'lead', role: 'lead' }),
        member({ id: 'w', name: 'writer', phase: 'active', status: 'idle' }),
      ],
    }))
    expect(agents(model).find(node => node.id === 'root')?.team?.role).toBe('lead')
    const w = agents(model).find(node => node.id === 'w')
    expect(w?.team).toMatchObject({ role: 'teammate', name: 'writer', phase: 'active', status: 'idle' })
  })

  it('gives a provisioning teammate the running node state', () => {
    const model = buildTasksModel(input({
      catalogs: { root: catalog([child('w')]) },
      byId: { root: summary('root'), w: summary('w') },
      teamMembers: [member({ id: 'w', phase: 'provisioning', status: 'provisioning' })],
    }))
    expect(agents(model).find(node => node.id === 'w')?.state).toBe('running')
  })

  it('folds a settled team member when the READER folds it by hand', () => {
    // The card's chevron is drawn whenever a node is settled, and a teammate
    // can settle as 出错 (a failed roster row). Auto-fold keeps team members
    // out of the aggregate — a roster row is a real, resumable worker, not a
    // settled subagent to sweep away — but a manual fold is the reader's
    // explicit request for THAT node and must not be silently dropped.
    const model = buildTasksModel(input({
      catalogs: { root: catalog([child('mate'), child('sub')]), sub: catalog([]) },
      byId: { root: summary('root'), mate: summary('mate'), sub: summary('sub') },
      teamMembers: [member({ id: 'mate', phase: 'failed', status: 'failed' })],
      folded: false,
      foldedIds: new Set(['mate', 'sub']),
    }))
    expect(model.map(node => node.id)).toEqual(['root', 'fold:root'])
    expect(model.find(node => node.kind === 'fold')).toMatchObject({
      count: 2, memberIds: ['mate', 'sub'],
    })
  })

  it('leaves a failed teammate alone under the AUTO rule (only a manual fold takes it)', () => {
    const model = buildTasksModel(input({
      catalogs: { root: catalog([child('mate'), child('sub')]), sub: catalog([]) },
      byId: { root: summary('root'), mate: summary('mate'), sub: summary('sub') },
      teamMembers: [member({ id: 'mate', phase: 'failed', status: 'failed' })],
      folded: true,
    }))
    expect(model.map(node => node.id)).toEqual(['root', 'mate', 'fold:root'])
  })

  it('never folds a RUNNING team member, even when the reader clicks its chevron', () => {
    const model = buildTasksModel(input({
      catalogs: { root: catalog([child('mate')]) },
      byId: { root: summary('root'), mate: summary('mate') },
      teamMembers: [member({ id: 'mate', phase: 'active', status: 'running' })],
      folded: false,
      foldedIds: new Set(['mate']),
    }))
    expect(model.map(node => node.id)).toEqual(['root', 'mate'])
  })

  it('folds settled leaves per parent and keeps running/teammate/current rows', () => {
    const model = buildTasksModel(input({
      catalogs: {
        root: catalog([
          child('done-1'), child('done-2'), child('live'), child('mate'), child('parent'),
        ]),
        // A KNOWN LEAF is a child whose OWN catalog loaded empty (0.1.7 rows
        // carry no `hasChildren`): only those two are fold candidates.
        'done-1': catalog([]),
        'done-2': catalog([]),
        'live': catalog([]),
        'mate': catalog([]),
        // `parent` has a child of its own, so it keeps its whole branch.
        parent: catalog([child('grandchild')]),
      },
      byId: {
        root: summary('root'),
        'done-1': summary('done-1'), 'done-2': summary('done-2'),
        live: summary('live'), mate: summary('mate'),
        parent: summary('parent'), grandchild: summary('grandchild'),
      },
      live: running('live'),
      teamMembers: [member({ id: 'mate', status: 'idle' })],
    }))
    expect(model.map(node => node.id)).toEqual([
      'root', 'live', 'mate', 'parent', 'grandchild', 'fold:root',
    ])
    const fold = model.find(node => node.kind === 'fold')
    expect(fold).toMatchObject({
      foldKind: 'done', parentId: 'root', count: 2, memberIds: ['done-1', 'done-2'],
    })
  })

  it('sweeps idle team members once a parent has FOLD_IDLE_MIN of them', () => {
    // Three idle teammates = a roster the reader scans, not a working set:
    // they fold into their OWN row, which says they are waiting.
    const mates = ['m1', 'm2', 'm3']
    const model = buildTasksModel(input({
      catalogs: {
        root: catalog(mates.map(id => child(id))),
        ...Object.fromEntries(mates.map(id => [id, catalog([])])),
      },
      byId: Object.fromEntries([['root', summary('root')], ...mates.map(id => [id, summary(id)])]),
      teamMembers: mates.map(id => member({ id, name: id, status: 'idle' })),
    }))
    expect(model.map(node => node.id)).toEqual(['root', 'fold:root:idle'])
    expect(model.find(node => node.kind === 'fold')).toMatchObject({
      foldKind: 'idle', count: 3, doneCount: 0, idleCount: 3, errorCount: 0,
      memberIds: ['m1', 'm2', 'm3'],
    })
  })

  it('names two members and counts the rest on the aggregate card', () => {
    const mates = ['m1', 'm2', 'm3', 'm4', 'm5']
    const model = buildTasksModel(input({
      catalogs: {
        root: catalog(mates.map(id => child(id))),
        ...Object.fromEntries(mates.map(id => [id, catalog([])])),
      },
      byId: Object.fromEntries([['root', summary('root')], ...mates.map(id => [id, summary(id)])]),
      teamMembers: mates.map(id => member({ id, name: id, status: 'idle' })),
    }))
    const fold = model.find(node => node.kind === 'fold')
    expect(fold?.previews).toEqual(['m1', 'm2'])
    expect(foldPreviews(fold?.previews ?? [], fold?.count ?? 0)).toBe('m1 / m2 +3')
  })

  it('keeps two idle team members visible (below the threshold)', () => {
    const mates = ['m1', 'm2']
    const model = buildTasksModel(input({
      catalogs: {
        root: catalog(mates.map(id => child(id))),
        ...Object.fromEntries(mates.map(id => [id, catalog([])])),
      },
      byId: Object.fromEntries([['root', summary('root')], ...mates.map(id => [id, summary(id)])]),
      teamMembers: mates.map(id => member({ id, name: id, status: 'idle' })),
    }))
    expect(model.map(node => node.id)).toEqual(['root', 'm1', 'm2'])
  })

  it('never sweeps a RUNNING member even when the idle head count is met', () => {
    const model = buildTasksModel(input({
      catalogs: {
        root: catalog(['m1', 'm2', 'm3', 'busy'].map(id => child(id))),
        ...Object.fromEntries(['m1', 'm2', 'm3', 'busy'].map(id => [id, catalog([])])),
      },
      byId: Object.fromEntries(
        [['root', summary('root')], ...['m1', 'm2', 'm3', 'busy'].map(id => [id, summary(id)])],
      ),
      live: running('busy'),
      teamMembers: [
        ...['m1', 'm2', 'm3'].map(id => member({ id, name: id, status: 'idle' })),
        member({ id: 'busy', name: 'busy', status: 'running' }),
      ],
    }))
    expect(model.map(node => node.id)).toEqual(['root', 'busy', 'fold:root:idle'])
    expect(model.find(node => node.kind === 'fold')).toMatchObject({
      foldKind: 'idle', idleCount: 3, doneCount: 0,
    })
  })

  it('keeps the finished and the waiting members in SEPARATE rows', () => {
    const model = buildTasksModel(input({
      catalogs: {
        root: catalog([child('m1'), child('m2'), child('m3'), child('done-1'), child('failed-1')]),
        ...Object.fromEntries(
          ['m1', 'm2', 'm3', 'done-1', 'failed-1'].map(id => [id, catalog([])]),
        ),
      },
      byId: Object.fromEntries(
        [['root', summary('root')], ...['m1', 'm2', 'm3', 'done-1', 'failed-1'].map(id => [id, summary(id)])],
      ),
      teamMembers: [
        ...['m1', 'm2', 'm3'].map(id => member({ id, name: id, status: 'idle' })),
        member({ id: 'failed-1', name: 'failed-1', phase: 'failed', status: 'failed' }),
      ],
    }))
    const folders = model.filter(node => node.kind === 'fold')
    expect(folders.map(node => node.id)).toEqual(['fold:root', 'fold:root:idle'])
    // finished work + the failure, with the failure called out beside the ✓
    expect(folders[0]).toMatchObject({
      foldKind: 'done', count: 2, doneCount: 1, idleCount: 0, errorCount: 1,
      memberIds: ['done-1', 'failed-1'],
    })
    // …and the waiting members in their own row, which claims no completion
    expect(folders[1]).toMatchObject({
      foldKind: 'idle', count: 3, doneCount: 0, idleCount: 3, errorCount: 0,
      memberIds: ['m1', 'm2', 'm3'],
    })
  })

  it('folds a single idle member into the IDLE row from its own chevron', () => {
    const model = buildTasksModel(input({
      catalogs: { root: catalog([child('mate')]) },
      byId: { root: summary('root'), mate: summary('mate') },
      teamMembers: [member({ id: 'mate', name: 'mate', status: 'idle' })],
      folded: false,
      foldedIds: new Set(['mate']),
    }))
    expect(model.map(node => node.id)).toEqual(['root', 'fold:root:idle'])
    expect(model.find(node => node.kind === 'fold')).toMatchObject({
      foldKind: 'idle', count: 1, idleCount: 1,
    })
  })

  it('keeps a child whose own catalog is unknown (never folds on missing data)', () => {
    const model = buildTasksModel(input({
      catalogs: { root: catalog([child('opaque')]) },
      byId: { root: summary('root'), opaque: summary('opaque') },
    }))
    expect(model.map(node => node.id)).toEqual(['root', 'opaque'])
  })

  it('unfolds everything when folded is false', () => {
    const base = input({
      catalogs: { root: catalog([child('done-1')]) },
      byId: { root: summary('root'), 'done-1': summary('done-1') },
      folded: false,
    })
    expect(buildTasksModel(base).map(node => node.id)).toEqual(['root', 'done-1'])
  })
})

describe('tasksEdges', () => {
  it('classifies team/workflow/agent edges', () => {
    const audit = run({
      originSessionId: 'root',
      phases: [{ members: [{ seq: 1, label: 'm', childId: 'm1' }] }],
    })
    const model = buildTasksModel(input({
      catalogs: { root: catalog([child('w'), child('m1')]) },
      byId: { root: summary('root'), w: summary('w'), m1: summary('m1') },
      runs: [audit],
      teamMembers: [member({ id: 'w' })],
      folded: false,
    }))
    const edges = tasksEdges(model)
    const kindOf = (to: string) => edges.find(edge => edge.to === to)?.kind
    expect(kindOf('w')).toBe('team')
    expect(kindOf('run:run-1')).toBe('workflow')
    expect(kindOf('m1')).toBe('workflow')
  })
})

describe('buildTasksModel: duplicate workflow members', () => {
  it('never synthesizes a second node for a member another parent already lists', () => {
    // `m1` is a real child of `a`, but a run started by `root` names it as a
    // member — the node must stay single (React keys / edge map depend on it)
    // and the run simply does not duplicate it on the canvas.
    const audit = run({
      originSessionId: 'root',
      phases: [{ title: '侦察', members: [{ seq: 1, label: 'm1', childId: 'm1', outcome: 'completed' }] }],
    })
    const model = buildTasksModel(input({
      catalogs: {
        root: catalog([child('a')]),
        a: catalog([child('m1')]),
      },
      byId: { root: summary('root'), a: summary('a'), m1: summary('m1') },
      runs: [audit],
      folded: false,
    }))
    const ids = model.map(node => node.id)
    expect(ids.filter(id => id === 'm1')).toHaveLength(1)
    expect(new Set(ids).size).toBe(ids.length)
    // The real node keeps its catalog parent.
    expect(model.find(node => node.id === 'm1')?.parentId).toBe('a')
  })

  it('still synthesizes a member no catalog knows', () => {
    const audit = run({
      originSessionId: 'root',
      phases: [{ title: '侦察', members: [{ seq: 1, label: 'ghost member', childId: 'ghost' }] }],
    })
    const model = buildTasksModel(input({
      catalogs: { root: catalog([]) },
      byId: { root: summary('root') },
      runs: [audit],
      folded: false,
    }))
    const ghost = model.find(node => node.id === 'ghost')
    expect(ghost).toMatchObject({ parentId: 'run:run-1', synthesized: true })
  })
})

describe('shared task status rule (taskBlocked / taskStatusLabel / taskTone)', () => {
  const facts = (status: 'pending' | 'in_progress' | 'completed', ready: boolean) => ({ status, ready })

  it('calls a queued task with an open blocker blocked', () => {
    expect(taskBlocked(facts('pending', false))).toBe(true)
    expect(taskStatusLabel(facts('pending', false))).toBe('Blocked')
    expect(taskTone(facts('pending', false))).toBe('warning')
  })

  it('never calls a CLAIMED task blocked, even though the service reports ready:false', () => {
    // The board's `ready` flag means "a pending task clear to claim": it is
    // false for every non-pending task, which is exactly how a task being
    // actively worked on got labelled 阻塞 on the real board.
    expect(taskBlocked(facts('in_progress', false))).toBe(false)
    expect(taskStatusLabel(facts('in_progress', false))).toBe('In progress')
    expect(taskTone(facts('in_progress', false))).toBe('info')
  })

  it('never calls a finished task blocked', () => {
    expect(taskBlocked(facts('completed', false))).toBe(false)
    expect(taskStatusLabel(facts('completed', false))).toBe('Completed')
    expect(taskTone(facts('completed', false))).toBe('success')
  })

  it('reads a claimable queued task as pending, not blocked', () => {
    expect(taskStatusLabel(facts('pending', true))).toBe('Pending')
    expect(taskTone(facts('pending', true))).toBe('info')
    expect(taskDotState(facts('pending', true))).toBe('ongoing')
  })
})
