/**
 * The commit-graph lane SVG for one history row — a React renderer over the
 * pure geometry from `git-graph.ts` (see that module for the lane model).
 *
 * The paths are the gitgraph-lines prototype's exact shapes: full-height
 * vertical lanes, merge arcs that curve INTO the dot (a lane ending here),
 * fork arcs that curve OUT of the dot (a lane starting here), and the dot
 * itself. Colors are `var(--gg-lane-N)` custom properties — defined in
 * sidebar.module.css, defaulting to DSH semantic tokens — so every skin
 * controls the palette without any hardcoded color in the markup.
 *
 * ## Height follows the row (no measurement, no feedback loop)
 *
 * History rows vary in height (tag chips wrap to a second line). The graph
 * must span the row's ACTUAL height, so:
 *
 * - the wrapper is `position: absolute; top: 0; bottom: 0` — it never takes
 *   part in the row's height, which is decided by the commit body alone
 *   (no ResizeObserver round-trip, no "row grows → svg grows" loop);
 * - the SVG fills the wrapper and uses `viewBox="0 0 W ROW_H"` +
 *   `preserveAspectRatio="none"`: the y axis stretches to the row's real
 *   height while the x axis keeps exact pixel positions (vertical lane
 *   lines stay perfectly vertical, arc corners round slightly — the same
 *   tradeoff VSCode Git Graph accepts for variable rows);
 * - the dot is a CSS element (top: 50%), so it stays a perfect circle and
 *   vertically centered regardless of the row height.
 */
import type { CSSProperties, ReactNode } from 'react'
import { colX, laneColor, pathForkOut, pathMergeIn, pathV, ROW_H, type GitGraphRow } from './git-graph.ts'
import css from './sidebar.module.css'

/** A stroke path in one lane color (non-scaling stroke: the y stretch of the
 *  viewBox must not thicken the strokes). */
function LanePath(props: { d: string; color: string }): ReactNode {
  return (
    <path
      d={props.d}
      fill="none"
      stroke={props.color}
      strokeWidth={2.2}
      strokeLinecap="round"
      vectorEffect="non-scaling-stroke"
    />
  )
}

export function GitGraphSvg(props: {
  row: GitGraphRow
  /** The previous row, for the "above" continuity of each lane. */
  prev?: GitGraphRow
  /** Total graph width in px (shared across rows of one page). */
  graphWidth: number
}): ReactNode {
  const { row, prev, graphWidth } = props
  const mid = ROW_H / 2
  const dotX = colX(row.dotCol)
  const mergeCols = new Set(row.merges.map(m => m.col))
  const forkCols = new Set(row.forks.map(f => f.col))
  const paths: ReactNode[] = []

  row.lanes.forEach((color, col) => {
    const x = colX(col)
    const above = prev !== undefined && prev.lanes.has(col)
    const below = row.below.has(col)
    const isMerge = mergeCols.has(col)
    const isFork = forkCols.has(col)
    if (col === row.dotCol) {
      if (above) paths.push(<LanePath key={`v:${col}`} d={pathV(x, 0, mid)} color={color} />)
      if (below) paths.push(<LanePath key={`v:${col}:b`} d={pathV(x, mid, ROW_H)} color={color} />)
    } else if (isMerge) {
      // The merge path already covers the vertical descent + the corner into
      // the dot (identical to the prototype's pathMergeIn).
      paths.push(<LanePath key={`m:${col}`} d={pathMergeIn(x, dotX, mid)} color={color} />)
    } else if (isFork) {
      // An existing lane the fork joins also had a vertical above the dot row.
      if (above) paths.push(<LanePath key={`v:${col}`} d={pathV(x, 0, mid)} color={color} />)
      paths.push(<LanePath key={`f:${col}`} d={pathForkOut(dotX, x, mid)} color={color} />)
    } else if (above && below) {
      paths.push(<LanePath key={`v:${col}`} d={pathV(x, 0, ROW_H)} color={color} />)
    } else if (above) {
      paths.push(<LanePath key={`v:${col}`} d={pathV(x, 0, mid)} color={color} />)
    } else if (below) {
      paths.push(<LanePath key={`v:${col}`} d={pathV(x, mid, ROW_H)} color={color} />)
    }
  })

  // The dot is a CSS circle so it never distorts under the viewBox y-stretch.
  const dotStyle: CSSProperties = {
    left: dotX - 5.2,
    background: laneColor(row.dotCol),
  }

  return (
    <div className={css.gitLogGraph} style={{ width: graphWidth }}>
      <svg
        viewBox={`0 0 ${graphWidth} ${ROW_H}`}
        preserveAspectRatio="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        {paths}
      </svg>
      <span className={css.gitLogDot} style={dotStyle} />
    </div>
  )
}
