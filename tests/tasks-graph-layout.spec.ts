/**
 * Unit tests for the layered graph layout: parent centering, depth rows, the
 * sibling-band WRAP that keeps a narrow sidebar readable (and the row
 * reservation that stops a wrapped band from landing on a sibling's
 * children), the PER-SHAPE card height (the mode chip's badge row and the
 * shared-task row a card renders are reserved, so a card never renders outside
 * its box), and the width-aware solver.
 */
import { describe, expect, it } from 'vitest'
import {
  GRAPH_AGENT_NODE_H,
  GRAPH_GAP_Y,
  GRAPH_NODE_H,
  GRAPH_NODE_W,
  GRAPH_PAD,
  GRAPH_ROW_STRIDE,
  GRAPH_TASK_H,
  GRAPH_TEXT_MAX_H,
  bandColsFor,
  layoutTasksGraph,
  layoutTasksGraphForWidth,
  rowStrideFor,
  textTailLines,
} from '../src/client/tasks-graph-layout.ts'
import type { TasksAgentNode, TasksNode, TasksNodeTask } from '../src/client/tasks-model.ts'

/** One shared task as the card's task line shows it. */
function task(id: string): TasksNodeTask {
  return { id, subject: id, status: 'in_progress', ready: true }
}

/** An agent node. `live` gives it a text-only tail; `extra` shapes the card
 *  further (a settled state, a tool call, owned shared tasks). */
function agent(
  id: string,
  parentId?: string,
  live = false,
  extra: Partial<TasksAgentNode> = {},
): TasksAgentNode {
  return {
    kind: 'agent', id, ...(parentId === undefined ? {} : { parentId }),
    depth: parentId === undefined ? 0 : 1,
    label: id, state: 'running', activity: 'running', current: false,
    ...(live ? { live: { running: true, text: 'x' } } : {}),
    ...extra,
  }
}

/** One running node's live view: a merged activity row (the bar's text). */
const ACTIVITY = {
  running: true,
  summary: { counts: [{ kind: 'read' as const, count: 1 }], running: 'read' as const, runningDetail: 'x' },
}

/**
 * The row index of one laid-out node. The pitch is per MODEL now (a run card
 * keeps its meta line, an agent card does not), so the helper asks the layout's
 * own rule rather than the tallest constant.
 */
function layoutRow(
  layout: ReturnType<typeof layoutTasksGraph>,
  id: string,
  nodes: readonly TasksNode[],
): number {
  const box = layout.boxes.get(id)
  if (box === undefined) throw new Error(`no box for ${id}`)
  return (box.y - GRAPH_PAD) / rowStrideFor(nodes)
}

describe('layout: card heights', () => {
  it('reserves the state bar for every node kind, and the task row only for team members', () => {
    const nodes: TasksNode[] = [
      agent('root'),
      agent('busy', 'root', false, { live: ACTIVITY }),
      agent('owner', 'root', false, { tasks: [task('t1')] }),
    ]
    const layout = layoutTasksGraph(nodes)
    // The merged activity lives in the bar, which every card renders: a
    // running node and a settled one reserve exactly the same base height. The
    // base is the AGENT card (badges + two title lines + the bar): the mode
    // word moved into the badge row, so no card reserves a mono meta line —
    // only a workflow RUN does (see the stride case below).
    expect(layout.boxes.get('root')?.h).toBe(GRAPH_AGENT_NODE_H)
    expect(layout.boxes.get('busy')?.h).toBe(GRAPH_AGENT_NODE_H)
    expect(layout.boxes.get('owner')?.h).toBe(GRAPH_AGENT_NODE_H + GRAPH_TASK_H)
  })

  it('reserves the text tail from the TEXT, never the maximum', () => {
    // A card that reserved three lines to show one would wear a hole above its
    // bar — the reader's own "空荡荡" report, in a new place.
    expect(textTailLines(undefined)).toBe(0)
    expect(textTailLines('')).toBe(0)
    expect(textTailLines('y')).toBe(1)
    // 17 CJK glyphs fill one 172px line; the estimate caps at three.
    expect(textTailLines('一'.repeat(17))).toBe(1)
    expect(textTailLines('一'.repeat(30))).toBe(2)
    expect(textTailLines('一'.repeat(400))).toBe(3)
    expect(textTailLines('a'.repeat(200))).toBe(3)
  })

  it('keeps every card shape inside one row stride', () => {
    // The stride is the row pitch: a card taller than it would overlap the
    // next row (and its phase frame).
    const tallest = GRAPH_AGENT_NODE_H + GRAPH_TASK_H + GRAPH_TEXT_MAX_H
    expect(GRAPH_ROW_STRIDE).toBeGreaterThanOrEqual(tallest)
    const nodes: TasksNode[] = [
      agent('root'),
      agent('busiest', 'root', false, { live: { ...ACTIVITY, text: 'y' }, tasks: [task('t1')] }),
      // The tallest card the layout can be asked for: a task row AND a tail
      // that needs every line it may show.
      agent('widest', 'root', false, { live: { ...ACTIVITY, text: '一'.repeat(400) }, tasks: [task('t1')] }),
    ]
    const layout = layoutTasksGraph(nodes)
    expect(layout.boxes.get('busiest')?.h).toBe(GRAPH_AGENT_NODE_H + GRAPH_TASK_H + 13 + 2)
    expect(layout.boxes.get('widest')?.h).toBe(tallest)
    // …and the pitch really covers it.
    expect(rowStrideFor(nodes)).toBeGreaterThanOrEqual(tallest + GRAPH_GAP_Y - GRAPH_GAP_Y)
    // An agent-only model pitches its rows at the agent card; a model with a
    // workflow run (the only card that keeps a meta line) pitches at the
    // taller run card, so no card ever pokes into the row below.
    const withRun: TasksNode[] = [
      ...nodes,
      {
        kind: 'workflow', id: 'run:r', parentId: 'root', depth: 1,
        run: {
          runId: 'r', name: 'audit', originSessionId: 'root', status: 'running',
          phases: [], startedSeq: 1, startedAt: 0,
        },
      },
    ]
    // Plain agent cards pitch at the base height; the model above carries a
    // task row and a full tail, and the pitch follows THAT card.
    expect(rowStrideFor([agent('root')])).toBe(GRAPH_AGENT_NODE_H + GRAPH_GAP_Y)
    expect(rowStrideFor(nodes)).toBe(tallest + GRAPH_GAP_Y)
    expect(rowStrideFor(withRun)).toBeGreaterThanOrEqual(GRAPH_NODE_H + GRAPH_GAP_Y)
    // …and the run card itself is the card that needs the meta line.
    expect(layoutTasksGraph(withRun).boxes.get('run:r')?.h).toBe(GRAPH_NODE_H)
  })

  it('gives every node a box even with a defensive orphan', () => {
    const nodes: TasksNode[] = [agent('root'), agent('ghost', 'missing')]
    const layout = layoutTasksGraph(nodes)
    expect(layout.boxes.get('root')).toBeDefined()
    expect(layout.boxes.get('ghost')).toBeDefined()
  })

  it('wraps a wide sibling band into rows of maxBandCols', () => {
    const nodes: TasksNode[] = [agent('root')]
    for (let index = 0; index < 5; index += 1) nodes.push(agent(`c${index}`, 'root'))
    const layout = layoutTasksGraph(nodes, { maxBandCols: 2 })
    // Three wrapped rows of 2/2/1, never five on one line.
    expect([layoutRow(layout, 'c0', nodes), layoutRow(layout, 'c1', nodes)]).toEqual([1, 1])
    expect([layoutRow(layout, 'c2', nodes), layoutRow(layout, 'c3', nodes)]).toEqual([2, 2])
    expect(layoutRow(layout, 'c4', nodes)).toBe(3)
    // The canvas stays as narrow as one wrapped band.
    expect(layout.width).toBeLessThanOrEqual(2 * GRAPH_NODE_W + 28 + 2 * GRAPH_PAD)
  })

  it('never lets a wrapped band land on a sibling subtree row', () => {
    // root → [a (with a child), b, c, d] wrapped at 2 columns: the second
    // band must start BELOW a's child, not on the same row as it.
    const nodes: TasksNode[] = [
      agent('root'), agent('a', 'root'), agent('b', 'root'),
      agent('c', 'root'), agent('d', 'root'), agent('a1', 'a'),
    ]
    const layout = layoutTasksGraph(nodes, { maxBandCols: 2 })
    expect(layoutRow(layout, 'c', nodes)).toBeGreaterThan(layoutRow(layout, 'a1', nodes))
    expect(layoutRow(layout, 'd', nodes)).toBe(layoutRow(layout, 'c', nodes))
  })
})

describe('bandColsFor / layoutTasksGraphForWidth', () => {
  it('derives the column count from the container width', () => {
    // The budget is measured at the READABILITY FLOOR, not at 1:1: the fit may
    // scale the canvas down to 0.78 and stay readable, so a 360px panel keeps
    // two 176px cards per row (scaled ~0.86) instead of collapsing into a
    // one-card-per-row ladder. 720px fits four at the floor (the cap), and a
    // panel too narrow for even two columns falls back to one.
    expect(bandColsFor(360)).toBe(2)
    expect(bandColsFor(720)).toBe(4)
    expect(bandColsFor(120)).toBe(1)
  })

  it('prefers a flat band when the container is wide', () => {
    const nodes: TasksNode[] = [agent('root')]
    for (let index = 0; index < 4; index += 1) nodes.push(agent(`c${index}`, 'root'))
    const wide = layoutTasksGraphForWidth(nodes, 720)
    // Four 176px cards fit one band inside the floor budget at 720px, so the
    // whole sibling set stays on one row.
    expect(['c0', 'c1', 'c2', 'c3'].map(id => layoutRow(wide, id, nodes))).toEqual([1, 1, 1, 1])
    expect(wide.width).toBeLessThanOrEqual(720 / 0.78)
  })

  it('wraps instead of overflowing wildly when the container is narrow', () => {
    const nodes: TasksNode[] = [agent('root')]
    for (let index = 0; index < 6; index += 1) nodes.push(agent(`c${index}`, 'root'))
    // 360px (the narrowest native-sidebar panel) is where the anti-ladder
    // rule matters most: two cards per band, scaled to fit.
    const narrow = layoutTasksGraphForWidth(nodes, 360)
    // Never wider than the tolerant budget (a small pan is allowed, a 3x
    // overflow is not), and never a one-child-per-row ladder.
    expect(narrow.width).toBeLessThanOrEqual(((360 - 24) / 0.78) * 1.2)
    expect(layoutRow(narrow, 'c1', nodes)).toBe(layoutRow(narrow, 'c0', nodes))
  })
})
