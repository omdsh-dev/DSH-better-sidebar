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
  SidebarSubagentCatalog,
  SidebarSubagentChildEntry,
  SidebarTeamMemberView,
} from '../src/context-types.ts'
import type { WorkflowRunView } from '../src/workflow-runs.ts'

/** A summary row. */
function summary(id: string, over: Partial<SidebarSessionSummary> = {}): SidebarSessionSummary {
  return { id, displayTitle: id, ...over }
}

/** A catalog child row. */
function child(id: string, over: Partial<SidebarSubagentChildEntry> = {}): SidebarSubagentChildEntry {
  return { kind: 'child', id, activity: 'running', hasChildren: false, mode: 'one-shot', ...over }
}

/** A ready catalog. */
function catalog(entries: SidebarSubagentCatalog['entries']): SidebarSubagentCatalog {
  return { entries, parentAvailable: true, state: 'ready', error: null }
}

/** A workflow run view. */
function run(over: Partial<WorkflowRunView> = {}): WorkflowRunView {
  return {
    runId: 'run-1', name: 'audit', originSessionId: 'root', status: 'running',
    phases: [], startedSeq: 1, startedAt: 0, ...over,
  }
}

/** A team member view. */
function member(over: Partial<SidebarTeamMemberView> = {}): SidebarTeamMemberView {
  return { id: 'x', name: 'n', role: 'teammate', status: 'running', diagnostics: [], ...over }
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
        root: catalog([child('a'), child('b', { activity: 'inactive' })]),
        a: catalog([child('a1')]),
      },
      byId: {
        root: summary('root', { displayTitle: 'Root', running: true }),
        a: summary('a'), b: summary('b'), a1: summary('a1'),
      },
      currentSessionId: 'a1',
      folded: false,
    }))
    expect(model.map(node => node.id)).toEqual(['root', 'a', 'a1', 'b'])
    expect(agents(model).find(node => node.id === 'a1')?.current).toBe(true)
    expect(agents(model).find(node => node.id === 'a1')?.childAddress).toEqual({
      parentSessionId: 'a', childSessionId: 'a1', mode: 'one-shot',
    })
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
      catalogs: { root: catalog([child('m1', { activity: 'inactive' })]) },
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

  it('enriches teammates and the lead from the team view', () => {
    const model = buildTasksModel(input({
      catalogs: { root: catalog([child('w', { label: 'writer' })]) },
      byId: { root: summary('root'), w: summary('w') },
      teamMembers: [
        member({ id: 'root', name: 'lead', role: 'lead' }),
        member({ id: 'w', name: 'writer', model: 'glm-5.3', status: 'idle' }),
      ],
    }))
    expect(agents(model).find(node => node.id === 'root')?.team?.role).toBe('lead')
    const w = agents(model).find(node => node.id === 'w')
    expect(w?.team).toMatchObject({ role: 'teammate', name: 'writer', model: 'glm-5.3' })
  })

  it('folds settled leaves per parent and keeps running/teammate/current rows', () => {
    const model = buildTasksModel(input({
      catalogs: {
        root: catalog([
          child('done-1', { activity: 'inactive' }),
          child('done-2', { activity: 'inactive' }),
          child('live', { activity: 'running' }),
          child('mate', { activity: 'inactive' }),
          child('parent', { activity: 'inactive', hasChildren: true }),
        ]),
        parent: catalog([child('grandchild')]),
      },
      byId: {
        root: summary('root'),
        'done-1': summary('done-1'), 'done-2': summary('done-2'),
        live: summary('live'), mate: summary('mate'),
        parent: summary('parent'), grandchild: summary('grandchild'),
      },
      teamMembers: [member({ id: 'mate', status: 'idle' })],
    }))
    expect(model.map(node => node.id)).toEqual([
      'root', 'live', 'mate', 'parent', 'grandchild', 'fold:root',
    ])
    const fold = model.find(node => node.kind === 'fold')
    expect(fold).toMatchObject({ parentId: 'root', count: 2, memberIds: ['done-1', 'done-2'] })
  })

  it('unfolds everything when folded is false', () => {
    const base = input({
      catalogs: { root: catalog([child('done-1', { activity: 'inactive' })]) },
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
        a: catalog([child('m1', { activity: 'inactive' })]),
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
