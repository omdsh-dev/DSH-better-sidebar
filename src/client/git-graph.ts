/**
 * Git commit graph lane layout — the client half of the history graph.
 *
 * Ports the visual language of `docs/prototypes/gitgraph-lines` (lane
 * columns, merge arcs, fork arcs, dots, column recycling) from the
 * call-chain renderer to REAL git commits: input is the topo-ordered
 * `git log --topo-order` rows (newest first) that the host's
 * `git.log-graph` route already returns, each carrying its FULL parent
 * hashes. The layout is pure computation (no DOM), so it is unit-testable
 * in Node and renderable by any SVG consumer.
 *
 * ## Lane model
 *
 * A lane is a column that "carries" the full hash of a commit still waiting
 * to be displayed below (topo order guarantees a commit appears after all
 * its children). Per row (one commit):
 *
 * - **dot lane** — the column carrying this commit's hash, else the first
 *   free column (paging boundary / new branch). The commit's FIRST parent
 *   continues straight down the same lane; a root commit ends the lane.
 * - **merge arcs** — when several lanes carry the SAME hash (a diamond: two
 *   children forked to one common parent), the commit is displayed on the
 *   LEFTMOST of them and every other lane ends here with a vertical +
 *   rounded corner arc INTO the dot. A lane carrying one of this commit's
 *   parents but not the commit itself never merges here — the parent is
 *   displayed later (topo order), so its lane keeps a straight line down.
 * - **fork arcs** — every NON-first parent leaves the dot on a horizontal +
 *   rounded corner arc into a lane: an existing lane already carrying that
 *   hash (a later sibling of the same parent), the leftmost free column, or
 *   a brand-new column at the right edge. A column freed by a merge becomes
 *   reusable from the NEXT row on (never in the same row the merge arc used
 *   it — no V-shaped bounce).
 * - **straight lanes** — any other column keeps a full-height vertical line
 *   (its commit still waits below the fold).
 * - **column recycling** — a lane ends the moment its commit is displayed or
 *   merged, and its column is immediately reusable, so the graph never grows
 *   wider than the active branch count (same as git graph tools).
 *
 * Lane colors are a pure function of the column index (`var(--gg-lane-N)`
 * CSS custom properties defined in sidebar.module.css, defaulting to DSH
 * semantic tokens so every skin controls them), which keeps each column's
 * color stable across its whole life and across recycling.
 */
import type { GitGraphEntry } from './api.ts'

/** Geometry (aligned with the gitgraph-lines prototype: CELL_W/ROW_H/CURVE_R).
 *  ROW_H is the NOMINAL row height the path geometry is authored in: the SVG
 *  is rendered with `viewBox="0 0 W ROW_H"` + `preserveAspectRatio="none"`
 *  and CSS `top:0;bottom:0` fills the row's ACTUAL height (which varies when
 *  tag chips wrap), so the y axis stretches to match the row while the x
 *  axis keeps its exact pixel positions. */
export const CELL_W = 24
export const ROW_H = 40
export const CURVE_R = 12

/** Distinct lane hues: CSS custom property per column slot (0-based). */
export const LANE_VARS = ['--gg-lane-0', '--gg-lane-1', '--gg-lane-2', '--gg-lane-3', '--gg-lane-4', '--gg-lane-5'] as const

/** The lane color reference for one column (`var(--gg-lane-N)`, cycling). */
export function laneColor(col: number): string {
  return `var(${LANE_VARS[col % LANE_VARS.length]})`
}

/** Column index → the dot's x coordinate. */
export function colX(col: number): number {
  return col * CELL_W + CELL_W / 2
}

/** One merge arc: a lane's vertical descent + rounded corner into the dot. */
export function pathMergeIn(fromX: number, dotX: number, mid: number): string {
  if (fromX === dotX) return `M ${fromX} 0 L ${fromX} ${mid}`
  const sign = dotX > fromX ? 1 : -1
  const r = Math.min(CURVE_R, Math.abs(dotX - fromX), mid)
  return ['M', fromX, 0, 'L', fromX, mid - r, 'Q', fromX, mid, fromX + sign * r, mid, 'L', dotX, mid].join(' ')
}

/** One fork arc: from the dot horizontally out + rounded corner down to the
 *  nominal row bottom (ROW_H; stretched to the actual row height by the
 *  SVG's viewBox). */
export function pathForkOut(dotX: number, toX: number, mid: number): string {
  if (dotX === toX) return `M ${dotX} ${mid} L ${toX} ${ROW_H}`
  const sign = toX > dotX ? 1 : -1
  const r = Math.min(CURVE_R, Math.abs(toX - dotX), ROW_H - mid)
  return ['M', dotX, mid, 'L', toX - sign * r, mid, 'Q', toX, mid, toX, mid + r, 'L', toX, ROW_H].join(' ')
}

/** A straight vertical line segment. */
export function pathV(x: number, y1: number, y2: number): string {
  return ['M', x, y1, 'L', x, y2].join(' ')
}

/** One laid-out history row (one commit) with its lane snapshot and edges. */
export interface GitGraphRow {
  entry: GitGraphEntry
  /** Full hash — unique per commit (also the React key). */
  rowKey: string
  /** Column of the commit dot. */
  dotCol: number
  /** Every column drawn in this row → its lane color reference. */
  lanes: Map<number, string>
  /** Columns whose lane continues BELOW this row (straight). */
  below: Set<number>
  /** Merge arcs: lane column → dot (the lane ends here). */
  merges: { col: number; color: string }[]
  /** Fork arcs: dot → lane column (the lane starts / is fed here). */
  forks: { col: number; color: string }[]
}

export interface GitGraphLayout {
  rows: GitGraphRow[]
  /** Total graph width in px ((maxCol + 1) * CELL_W + right padding). */
  graphWidth: number
}

/**
 * Lay out topo-ordered commits (newest first) into a lane graph. See the
 * module doc for the lane rules; the algorithm is a standard git-graph
 * lane assignment (matching GitKraken / VSCode Git Graph shapes).
 */
export function computeGraphRows(entries: readonly GitGraphEntry[]): GitGraphLayout {
  const lanes: (string | null)[] = []
  const rows: GitGraphRow[] = []
  let maxCol = 0

  for (const entry of entries) {
    const hash = entry.hashFull
    const parents = entry.parents

    // ① dot lane: the column already promising this hash (leftmost wins in a
    //    diamond), else the first free column, else a brand-new column.
    let dotCol = lanes.indexOf(hash)
    if (dotCol === -1) {
      dotCol = lanes.indexOf(null)
      if (dotCol === -1) {
        lanes.push(null)
        dotCol = lanes.length - 1
      }
    }

    // ② merge arcs: columns (≠ dot) carrying THIS commit's hash — a diamond
    //    join where several children forked to one common parent; the commit
    //    is displayed on the leftmost of them and the rest end here, arcing
    //    into the dot. Free them right away so the fork targets below can
    //    recycle the columns. (A lane carrying one of this commit's parents
    //    is NOT a merge — the parent is displayed later, its lane continues.)
    const merges: { col: number; color: string }[] = []
    const mergeCols = new Set<number>()
    for (let i = 0; i < lanes.length; i += 1) {
      if (i === dotCol || lanes[i] === null) continue
      if (lanes[i] === hash) {
        merges.push({ col: i, color: laneColor(i) })
        mergeCols.add(i)
      }
    }
    for (const c of mergeCols) lanes[c] = null

    // ③ fork targets for the non-first parents: an existing lane already
    //    carrying the hash (a later sibling of the same parent), the leftmost
    //    free column, or a brand-new column at the right edge. Columns freed
    //    by a merge in THIS row stay unused until the next row, so a merge
    //    arc and a fork never share one column (no V-shaped bounce).
    const forks: { col: number; color: string }[] = []
    for (const p of parents.slice(1)) {
      let col = lanes.findIndex((h, i) => i !== dotCol && !mergeCols.has(i) && h === p)
      if (col === -1) {
        col = lanes.findIndex((h, i) => i !== dotCol && !mergeCols.has(i) && h === null)
      }
      if (col === -1) {
        lanes.push(null)
        col = lanes.length - 1
      }
      forks.push({ col, color: laneColor(col) })
      lanes[col] = p
    }

    // ④ the dot lane continues with the first parent (a root commit ends it).
    lanes[dotCol] = parents[0] ?? null

    // ⑤ snapshot: drawn columns, continuing-below set, geometry.
    const rowLanes = new Map<number, string>()
    for (let i = 0; i < lanes.length; i += 1) {
      if (lanes[i] !== null) rowLanes.set(i, laneColor(i))
    }
    rowLanes.set(dotCol, laneColor(dotCol))
    for (const m of merges) rowLanes.set(m.col, m.color)
    for (const f of forks) rowLanes.set(f.col, f.color)
    const below = new Set<number>()
    for (let i = 0; i < lanes.length; i += 1) {
      if (lanes[i] !== null) below.add(i)
    }
    for (const c of rowLanes.keys()) {
      if (c > maxCol) maxCol = c
    }

    rows.push({ entry, rowKey: hash, dotCol, lanes: rowLanes, below, merges, forks })
  }

  return { rows, graphWidth: (maxCol + 1) * CELL_W + 6 }
}
