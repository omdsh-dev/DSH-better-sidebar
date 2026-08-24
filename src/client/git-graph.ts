/**
 * Lane layout for the source-control history graph. The input is the same
 * newest-first list used by the history rows; each row receives the edges
 * needed to render one slice of the branch graph.
 */
import type { GitLogEntry } from './api.ts'

export interface GitGraphEdge {
  /** Horizontal lane at the top of the row slice. */
  from: number
  /** Horizontal lane at the bottom of the row slice. */
  to: number
  /** Stable lane color index; edges joining a lane use that lane's color. */
  color: number
}

export interface GitGraphRow {
  /** The commit's lane at the middle of its row slice. */
  lane: number
  /** The commit's stable branch color. */
  color: number
  /** Number of lanes that exist after this row has been placed. */
  lanes: number
  edges: GitGraphEdge[]
}

interface GraphLane {
  hash: string
  color: number
}

/** Lay out commits into left-to-right lanes. Unknown parents get a lane so
 *  page boundaries do not make an otherwise continuous branch disappear. */
export function layoutGitGraph(entries: readonly GitLogEntry[]): GitGraphRow[] {
  const rows: GitGraphRow[] = []
  let active: GraphLane[] = []
  let nextColor = 0

  for (const entry of entries) {
    let lane = active.findIndex(item => item.hash === entry.hashFull)
    if (lane === -1) {
      active.push({ hash: entry.hashFull, color: nextColor++ })
      lane = active.length - 1
    }

    const nodeColor = active[lane]!.color
    const remaining = active.filter((_, index) => index !== lane)
    const targetOf = (hash: string): number => remaining.findIndex(item => item.hash === hash)
    const parentTargets: number[] = []

    entry.parents.forEach((parent, parentIndex) => {
      let target = targetOf(parent)
      if (target !== -1) {
        parentTargets.push(target)
        return
      }
      // The first parent continues the commit's branch in its original
      // position; side parents open new lanes to the right.
      const insertedLane: GraphLane = {
        hash: parent,
        color: parentIndex === 0 ? nodeColor : nextColor++,
      }
      if (parentIndex === 0) remaining.splice(Math.min(lane, remaining.length), 0, insertedLane)
      else remaining.push(insertedLane)
      parentTargets.push(remaining.length - 1)
    })

    const edges: GitGraphEdge[] = []
    active.forEach((item, index) => {
      if (index === lane) return
      const to = remaining.findIndex(candidate => candidate.hash === item.hash)
      if (to !== -1) edges.push({ from: index, to, color: item.color })
    })
    parentTargets.forEach((to, parentIndex) => {
      // A first-parent edge stays on the commit's branch; side branches keep
      // their own color while curving into an existing lane.
      edges.push({
        from: lane,
        to,
        color: parentIndex === 0 ? nodeColor : remaining[to]!.color,
      })
    })
    rows.push({ lane, color: nodeColor, lanes: remaining.length, edges })
    active = remaining
  }

  return rows
}
