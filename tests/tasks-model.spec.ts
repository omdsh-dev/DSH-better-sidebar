/**
 * Unit tests for the unified Tasks view model (buildTasksModel / tasksEdges):
 * catalog walking, workflow run attachment + member re-parenting, team
 * enrichment, and per-parent settled subtree / idle folds.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { attachLocale } from '../src/client/locales.ts'
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

  it('folds settled leaves per parent and keeps running/idle/unknown branches', () => {
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
        // Its descendant catalog is unknown: keep the branch reachable. A fully
        // known settled branch now folds under the independent branch rule.
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

  it('expands ONE group per reader click, leaving the sibling aggregate folded', () => {
    // Two groups of one parent at once: finished work (`done-1` / `failed-1`)
    // and three waiting teammates. Opening the finished group must reveal those
    // two nodes and NOTHING else — the page used to clear every fold it had.
    const base = input({
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
    })
    expect(buildTasksModel({ ...base, expandedGroups: new Set(['fold:root']) })
      .map(node => node.id)).toEqual(['root', 'done-1', 'failed-1', 'fold:root:idle'])
    // …and the idle group's own opening leaves the finished one folded. Kept
    // children keep the catalog order; the aggregates trail whatever stays
    // folded (the model's one ordering rule).
    expect(buildTasksModel({ ...base, expandedGroups: new Set(['fold:root:idle']) })
      .map(node => node.id)).toEqual(['root', 'm1', 'm2', 'm3', 'fold:root'])
    // The group ids are the aggregate row ids the page hands back.
    expect(buildTasksModel(base).filter(node => node.kind === 'fold').map(node => node.id))
      .toEqual(['fold:root', 'fold:root:idle'])
  })

  it('lets a hand-folded member fold back INSIDE an open group', () => {
    // The card's own chevron is the newest explicit intent: with the group open
    // it must still fold that one node back (the reader's "cannot collapse it
    // again" report), and the aggregate then reappears holding it.
    const base = input({
      catalogs: { root: catalog([child('done-1'), child('done-2')]) },
      byId: { root: summary('root'), 'done-1': summary('done-1'), 'done-2': summary('done-2') },
      expandedGroups: new Set(['fold:root']),
    })
    expect(buildTasksModel(base).map(node => node.id)).toEqual(['root', 'done-1', 'done-2'])
    expect(buildTasksModel({ ...base, foldedIds: new Set(['done-1']) }).map(node => node.id))
      .toEqual(['root', 'done-2', 'fold:root'])
    expect(buildTasksModel({ ...base, foldedIds: new Set(['done-1']) })
      .find(node => node.kind === 'fold'))
      .toMatchObject({ id: 'fold:root', memberIds: ['done-1'] })
  })

  it('expands a RUN member group by its own aggregate id', () => {
    const audit = run({
      originSessionId: 'root',
      phases: [{
        title: '侦察',
        members: [
          { seq: 1, label: 'existing', phase: '侦察', childId: 'm1', outcome: 'completed' },
          { seq: 2, label: 'synthesized', phase: '侦察', childId: 'm2', outcome: 'completed' },
        ],
      }],
    })
    const base = input({
      catalogs: { root: catalog([child('m1')]), m1: catalog([]), m2: catalog([]) },
      byId: { root: summary('root'), m1: summary('m1') },
      runs: [audit],
    })
    // Folded by default: both settled members collapse under the run node.
    expect(buildTasksModel(base).map(node => node.id)).toEqual(['root', 'run:run-1', 'fold:run:run-1'])
    // Opening that aggregate reveals the run's own members, in phase order.
    expect(buildTasksModel({ ...base, expandedGroups: new Set(['fold:run:run-1']) })
      .map(node => node.id)).toEqual(['root', 'run:run-1', 'm1', 'm2'])
  })

  it('carries the topology ROOT\'s own live view (the card and the row read it)', () => {
    const live: Record<string, SidebarChildLiveView> = {
      root: {
        summary: {
          counts: [{ kind: 'commands', count: 1 }], running: 'commands', runningDetail: 'npm run build',
        },
      },
    }
    const node = agents(buildTasksModel(input({ live }))).find(candidate => candidate.id === 'root')
    expect(node?.live?.summary?.running).toBe('commands')
    // A root the live channel reported nothing for keeps the field absent — the
    // bar then falls back to the state word instead of inventing copy.
    expect(agents(buildTasksModel(input({ live: {} }))).find(candidate => candidate.id === 'root')?.live)
      .toBeUndefined()
  })
})

describe('buildTasksModel: settled branches', () => {
  const branch = (): TasksModelInput => input({
    catalogs: { root: catalog([child('a')]), a: catalog([child('b')]), b: catalog([]) },
  })

  it('builds and folds a deep chain without exhausting the call stack', () => {
    const catalogs: Record<string, SubagentCatalogView> = {}
    const size = 12000
    for (let index = 0; index < size; index += 1) {
      catalogs[index === 0 ? 'root' : `n${index}`] = catalog([child(`n${index + 1}`)])
    }
    catalogs[`n${size}`] = catalog([])
    const base = input({ catalogs })
    const opened = buildTasksModel({ ...base, folded: false })
    expect(opened).toHaveLength(12001)
    expect(opened.at(-1)).toMatchObject({ id: 'n12000', depth: 12000 })
    expect(buildTasksModel(base)).toMatchObject([
      { id: 'root' }, { id: 'fold:root', count: 12000 },
    ])
    expect(buildTasksModel({ ...base, expandedGroups: new Set(['fold:n11999']) }))
      .toHaveLength(12001)
  })

  it('aggregates all hidden agents and restores each level when groups expand', () => {
    const base = branch()
    expect(buildTasksModel(base)).toMatchObject([
      { id: 'root' }, { id: 'fold:root', count: 2, doneCount: 2, memberIds: ['a', 'b'] },
    ])
    expect(buildTasksModel({ ...base, expandedGroups: new Set(['fold:root']) }).map(node => node.id))
      .toEqual(['root', 'a', 'fold:a'])
    expect(buildTasksModel({ ...base, expandedGroups: new Set(['fold:root', 'fold:a']) }).map(node => node.id))
      .toEqual(['root', 'a', 'b'])
  })

  it('keeps an expanded descendant group visible after its running ancestor settles', () => {
    const base = branch()
    expect(buildTasksModel({ ...base, live: running('a') }).map(node => node.id))
      .toEqual(['root', 'a', 'fold:a'])
    const opened = { ...base, expandedGroups: new Set(['fold:a']) }
    expect(buildTasksModel({ ...opened, live: running('a') }).map(node => node.id))
      .toEqual(['root', 'a', 'b'])
    expect(buildTasksModel(opened).map(node => node.id)).toEqual(['root', 'a', 'b'])
  })

  it('keeps every settled ancestor of an expanded group visible', () => {
    const base = input({
      catalogs: {
        root: catalog([child('a'), child('sibling')]), a: catalog([child('b')]),
        b: catalog([child('c')]), c: catalog([]), sibling: catalog([]),
      },
      expandedGroups: new Set(['fold:b']),
    })
    expect(buildTasksModel(base).map(node => node.id))
      .toEqual(['root', 'a', 'b', 'c', 'fold:root'])
    expect(buildTasksModel(base).find(node => node.kind === 'fold'))
      .toMatchObject({ memberIds: ['sibling'] })
  })

  it('lets an explicitly revealed descendant fold back without losing its ancestor', () => {
    const base = { ...branch(), expandedGroups: new Set(['fold:a']), foldedIds: new Set(['b']) }
    expect(buildTasksModel(base).map(node => node.id)).toEqual(['root', 'a', 'fold:a'])
    expect(buildTasksModel(base).find(node => node.kind === 'fold'))
      .toMatchObject({ memberIds: ['b'] })
  })

  it.each([true, false])('lets a manual ancestor fold override a descendant expansion (auto %s)', (folded) => {
    const model = buildTasksModel({
      ...branch(), folded, expandedGroups: new Set(['fold:a']), foldedIds: new Set(['a']),
    })
    expect(model.map(node => node.id)).toEqual(['root', 'fold:root'])
    expect(model.at(-1)).toMatchObject({ memberIds: ['a', 'b'], count: 2 })
  })

  it.each(['running', 'current', 'unknown', 'error', 'idle', 'provisioning'])(
    'keeps a branch reachable with a %s descendant', (guard) => {
      const base = branch()
      if (guard === 'running') base.live = running('b')
      if (guard === 'current') base.currentSessionId = 'b'
      if (guard === 'unknown') base.catalogs = { ...base.catalogs, b: undefined }
      if (guard === 'error') base.catalogs = { ...base.catalogs, b: { entries: [], state: 'error', error: { message: 'unavailable' } } }
      if (guard === 'idle') base.teamMembers = [member({ id: 'b', status: 'idle' })]
      if (guard === 'provisioning') base.teamMembers = [member({ id: 'b', phase: 'provisioning', status: 'provisioning' })]
      expect(buildTasksModel(base).map(node => node.id)).toEqual(['root', 'a', 'b'])
    },
  )

  it('releases an automatic branch fold as soon as a descendant runs', () => {
    const base = branch()
    expect(buildTasksModel(base).map(node => node.id)).toEqual(['root', 'fold:root'])
    expect(buildTasksModel({ ...base, live: running('b') }).map(node => node.id)).toEqual(['root', 'a', 'b'])
  })

  it('controls settled leaves, settled branches and idle members independently', () => {
    const base = branch()
    expect(buildTasksModel({ ...base, autoFoldBranches: false }).map(node => node.id))
      .toEqual(['root', 'a', 'fold:a'])
    expect(buildTasksModel({ ...base, autoFoldSettled: false }).map(node => node.id))
      .toEqual(['root', 'fold:root'])
    expect(buildTasksModel({ ...base, folded: false }).map(node => node.id)).toEqual(['root', 'a', 'b'])
    const mates = ['m1', 'm2', 'm3']
    const idle = input({
      catalogs: { root: catalog(mates.map(id => child(id))), ...Object.fromEntries(mates.map(id => [id, catalog([])])) },
      teamMembers: mates.map(id => member({ id, status: 'idle' })),
      autoFoldSettled: false, autoFoldBranches: false,
    })
    expect(buildTasksModel(idle).map(node => node.id)).toEqual(['root', 'fold:root:idle'])
    expect(buildTasksModel({ ...idle, autoFoldIdle: false }).map(node => node.id)).toEqual(['root', ...mates])
  })

  it('keeps idle branches visible even when the roster reaches the idle threshold', () => {
    const mates = ['m1', 'm2', 'm3']
    const base = input({
      catalogs: {
        root: catalog(mates.map(id => child(id))), m1: catalog([child('b')]),
        m2: catalog([]), m3: catalog([]), b: catalog([]),
      },
      teamMembers: mates.map(id => member({ id, status: 'idle' })),
    })
    expect(buildTasksModel(base).map(node => node.id))
      .toEqual(['root', 'm1', 'fold:m1', 'fold:root:idle'])
  })

  it.each(['done', 'idle'] as const)(
    'keeps synthesized workflow sessions visible while their catalog is unknown (%s)', (state) => {
      const base = input({
        catalogs: { root: catalog([]) },
        runs: [run({ phases: [{ members: [{ seq: 1, label: 'm', childId: 'm', outcome: 'completed' }] }] })],
        teamMembers: state === 'idle' ? [member({ id: 'm', status: 'idle' })] : [],
      })
      const model = buildTasksModel(base)
      expect(model.map(node => node.id)).toEqual(['root', 'run:run-1', 'm'])
      expect(model.at(-1)).toMatchObject({
        synthesized: true, state, childAddress: { childSessionId: 'm' },
      })
      const aggregateId = state === 'idle' ? 'fold:run:run-1:idle' : 'fold:run:run-1'
      expect(buildTasksModel({ ...base, catalogs: { ...base.catalogs, m: catalog([]) } })
        .map(node => node.id)).toEqual(['root', 'run:run-1', aggregateId])
      expect(buildTasksModel({ ...base, folded: false, foldedIds: new Set(['m']) })
        .map(node => node.id)).toEqual(['root', 'run:run-1', aggregateId])
    },
  )

  it.each(['done', 'idle'] as const)('still aggregates a pure workflow placeholder without a session (%s)', (state) => {
    const base = input({
      catalogs: { root: catalog([]) },
      runs: [run({ phases: [{ members: [{ seq: 1, label: 'placeholder', childId: '', outcome: 'completed' }] }] })],
      teamMembers: state === 'idle' ? [member({ id: 'wfmember:run-1:1', status: 'idle' })] : [],
    })
    const model = buildTasksModel(base)
    expect(model.map(node => node.id)).toEqual([
      'root', 'run:run-1', state === 'idle' ? 'fold:run:run-1:idle' : 'fold:run:run-1',
    ])
    expect(model.at(-1)).toMatchObject({ count: 1, memberIds: ['wfmember:run-1:1'] })
    const opened = buildTasksModel({ ...base, folded: false })
    expect(opened.at(-1)).toMatchObject({ id: 'wfmember:run-1:1', synthesized: true, state })
    expect(agents(opened).at(-1)?.childAddress).toBeUndefined()
  })

  it('keeps settled ancestors of a workflow member with an unknown real session reachable', () => {
    const base = input({
      catalogs: { root: catalog([child('a')]), a: catalog([]) },
      runs: [run({ originSessionId: 'a', status: 'completed', phases: [{ members: [
        { seq: 1, label: 'm', childId: 'm', outcome: 'completed' },
      ] }] })],
    })
    expect(buildTasksModel(base).map(node => node.id)).toEqual(['root', 'a', 'run:run-1', 'm'])
    expect(buildTasksModel({ ...base, catalogs: { ...base.catalogs, m: catalog([]) } }).at(-1))
      .toMatchObject({ id: 'fold:root', count: 2, memberIds: ['a', 'm'] })
  })

  it('keeps ancestors reachable through an expanded workflow group', () => {
    const base = input({
      catalogs: { root: catalog([child('a')]), a: catalog([]), m: catalog([]) },
      runs: [run({ originSessionId: 'a', status: 'completed', phases: [{ members: [
        { seq: 1, label: 'm', childId: 'm', outcome: 'completed' },
      ] }] })],
      expandedGroups: new Set(['fold:run:run-1']),
    })
    expect(buildTasksModel(base).map(node => node.id)).toEqual(['root', 'a', 'run:run-1', 'm'])
    expect(buildTasksModel({ ...base, foldedIds: new Set(['a']) }).at(-1))
      .toMatchObject({ id: 'fold:root', count: 2, memberIds: ['a', 'm'] })
  })

  it('walks descendants of retained and synthesized workflow members', () => {
    const base = input({
      catalogs: { root: catalog([child('m')]), m: catalog([child('b')]), b: catalog([]) },
      runs: [run({ phases: [{ members: [{ seq: 1, label: 'm', childId: 'm', outcome: 'completed' }] }] })],
      live: running('b'),
    })
    expect(buildTasksModel(base).map(node => node.id)).toEqual(['root', 'run:run-1', 'm', 'b'])
    const synth = { ...base, catalogs: { ...base.catalogs, root: catalog([]) } }
    expect(buildTasksModel(synth).map(node => node.id)).toEqual(['root', 'run:run-1', 'm', 'b'])
  })

  it('preserves workflow member subtrees, guards and hidden agent tallies', () => {
    const base = input({
      catalogs: { root: catalog([child('m')]), m: catalog([child('b')]), b: catalog([]) },
      teamMembers: [member({ id: 'b', phase: 'failed', status: 'failed' })],
      runs: [run({ status: 'completed', phases: [{ members: [
        { seq: 1, label: 'm', childId: 'm', outcome: 'completed' },
        { seq: 2, label: 'duplicate', childId: 'm', outcome: 'completed' },
      ] }] })],
    })
    expect(buildTasksModel(base)).toMatchObject([
      { id: 'root' }, { id: 'run:run-1' },
      { id: 'fold:run:run-1', count: 2, doneCount: 1, errorCount: 1, memberIds: ['m', 'b'] },
    ])
    const opened = buildTasksModel({ ...base, folded: false })
    expect(opened.map(node => node.id)).toEqual(['root', 'run:run-1', 'm', 'b'])
    expect(agents(opened).find(node => node.id === 'b')).toMatchObject({ parentId: 'm', depth: 3 })
    expect(tasksEdges(opened).map(edge => [edge.from, edge.to])).toEqual([
      ['root', 'run:run-1'], ['run:run-1', 'm'], ['m', 'b'],
    ])
    expect(buildTasksModel({ ...base, currentSessionId: 'b' }).map(node => node.id))
      .toEqual(['root', 'run:run-1', 'm', 'b'])
    expect(buildTasksModel({ ...base, catalogs: { ...base.catalogs, b: undefined } }).map(node => node.id))
      .toEqual(['root', 'run:run-1', 'm', 'b'])
    expect(buildTasksModel({ ...base, live: running('b') }).map(node => node.id))
      .toEqual(['root', 'run:run-1', 'm', 'b'])
  })

  it('reports all hidden descendants so expansion can release their manual folds', () => {
    const base = branch()
    const manuallyFolded = new Set(['a', 'b'])
    const folded = buildTasksModel({ ...base, foldedIds: manuallyFolded, expandedGroups: new Set(['fold:root']) })
    const aggregate = folded.find(node => node.kind === 'fold')!
    expect(aggregate.memberIds).toEqual(['a', 'b'])
    for (const id of aggregate.memberIds) manuallyFolded.delete(id)
    expect(buildTasksModel({ ...base, foldedIds: manuallyFolded, expandedGroups: new Set(['fold:root', 'fold:a']) }).map(node => node.id))
      .toEqual(['root', 'a', 'b'])
  })

  it('requires associated workflows to settle and counts agents only', () => {
    const base = branch()
    base.catalogs = { ...base.catalogs, m: catalog([]) }
    base.runs = [run({ originSessionId: 'a', phases: [{ members: [{ seq: 1, label: 'm', childId: 'm', outcome: 'completed' }] }] })]
    expect(buildTasksModel(base).map(node => node.id)).toEqual(['root', 'a', 'fold:a', 'run:run-1', 'fold:run:run-1'])
    const settled = { ...base, runs: base.runs.map(item => ({ ...item, status: 'completed' as const })) }
    expect(buildTasksModel(settled)).toMatchObject([
      { id: 'root' }, { id: 'fold:root', count: 3, memberIds: ['a', 'b', 'm'] },
    ])
    expect(buildTasksModel({ ...settled, folded: false }).map(node => node.id))
      .toEqual(['root', 'a', 'b', 'run:run-1', 'm'])
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
  // These assertions use English, regardless of the runner's browser/OS locale.
  beforeEach(() => { attachLocale({ getSnapshot: () => ({ active: 'en' }) }) })
  afterEach(() => { attachLocale(undefined) })

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
