/**
 * Unit tests for the layered graph layout: parent centering, depth rows, the
 * sibling-band WRAP that keeps a narrow sidebar readable (and the row
 * reservation that stops a wrapped band from landing on a sibling's
 * children), the PER-SHAPE card height (the live rows and the shared-task row
 * a card renders are reserved, so a card never renders outside its box), and
 * the width-aware solver.
 */
import { describe, expect, it } from 'vitest'
import {
  GRAPH_NODE_H,
  GRAPH_NODE_W,
  GRAPH_PAD,
  GRAPH_ROW_STRIDE,
  GRAPH_TASK_H,
  bandColsFor,
  layoutTasksGraph,
  layoutTasksGraphForWidth,
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

/** The row index of one laid-out node. */
function layoutRow(layout: ReturnType<typeof layoutTasksGraph>, id: string): number {
  const box = layout.boxes.get(id)
  if (box === undefined) throw new Error(`no box for ${id}`)
  return (box.y - GRAPH_PAD) / GRAPH_ROW_STRIDE
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
    // running node and a settled one reserve exactly the same base height.
    expect(layout.boxes.get('root')?.h).toBe(GRAPH_NODE_H)
    expect(layout.boxes.get('busy')?.h).toBe(GRAPH_NODE_H)
    expect(layout.boxes.get('owner')?.h).toBe(GRAPH_NODE_H + GRAPH_TASK_H)
  })

  it('keeps every card shape inside one row stride', () => {
    // The stride is the row pitch: a card taller than it would overlap the
    // next row (and its phase frame).
    const tallest = GRAPH_NODE_H + GRAPH_TASK_H
    expect(GRAPH_ROW_STRIDE).toBeGreaterThanOrEqual(tallest)
    const nodes: TasksNode[] = [
      agent('root'),
      agent('busiest', 'root', false, { live: { ...ACTIVITY, text: 'y' }, tasks: [task('t1')] }),
    ]
    const layout = layoutTasksGraph(nodes)
    expect(layout.boxes.get('busiest')?.h).toBe(tallest)
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
    expect([layoutRow(layout, 'c0'), layoutRow(layout, 'c1')]).toEqual([1, 1])
    expect([layoutRow(layout, 'c2'), layoutRow(layout, 'c3')]).toEqual([2, 2])
    expect(layoutRow(layout, 'c4')).toBe(3)
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
    expect(layoutRow(layout, 'c')).toBeGreaterThan(layoutRow(layout, 'a1'))
    expect(layoutRow(layout, 'd')).toBe(layoutRow(layout, 'c'))
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
    expect(['c0', 'c1', 'c2', 'c3'].map(id => layoutRow(wide, id))).toEqual([1, 1, 1, 1])
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
    expect(layoutRow(narrow, 'c1')).toBe(layoutRow(narrow, 'c0'))
  })
})
