/**
 * The layered top-down layout of the Tasks graph canvas: a tidy-tree pass
 * with a NARROW-PANEL rule — a parent's children wrap into bands of at most
 * {@link LayoutOptions.maxBandCols} columns, stacking extra rows below it.
 * Without wrapping a five-child level is ~770px wide and the whole graph
 * shrinks to ~40% inside the 360px native sidebar, which is unreadable; with
 * wrapping the canvas keeps a ~1:1 scale and the reader pans far less.
 *
 * Pure and dependency-free (the bundle-purity rule forbids a graph library in
 * the core bundle; <100-node trees need no virtualisation).
 */
import type { TasksNode } from './tasks-model.ts'
import { tasksEdges } from './tasks-model.ts'

/** Geometry constants of the canvas (px, pre-scale). The design target is the
 *  NARROW native right sidebar (~360px): a 176px card fits two per row plus
 *  the gutter. */
export const GRAPH_NODE_W = 176

/**
 * The card's heights are the SUM OF THE ROWS THE CARD RENDERS, in the real
 * metrics of the page's type scale (the same numbers the rules in
 * tasks-graph.module.css / tasks-canvas.module.css are written with). They are
 * derived rather than hand-tuned because the card is a fixed-geometry box: its
 * height is `auto` with `min-height: box.h`, so an under-reserved card does not
 * stay inside the box the layout handed it — it RENDERS TALLER, and everything
 * the layout derives from `box.h` (the row pitch, the phase frames, the canvas
 * extent) then disagrees with the pixels on screen.
 *
 * Measured on the rendered page: a running teammate card carrying a two-line
 * title, its meta, a live row and a task line renders 100px while the base
 * reserve handed it 68 — `min-height` cannot hold it down, so the card ate
 * 32px of the 53px gutter to the next row and poked out of its phase frame.
 */
const NODE_EDGE_H = 1
const NODE_PAD_Y = 6
/** Both edges' 1px outline plus the vertical padding (`.node` box-sizing). */
const NODE_CHROME_H = 2 * (NODE_PAD_Y + NODE_EDGE_H)
/** One title line — `--dsw-font-xxs-strong-12` (12px/18px). */
const NODE_TITLE_LINE_H = 18
/** Title lines the card reserves: the clamp in tasks-canvas.module.css. */
const NODE_TITLE_LINES = 2
/** The mono meta line — `--dsw-font-xxxs-11` (11px/14px) plus its 2px lead. */
const NODE_META_H = 14 + 2
/** One live row: LiveLine's 10px/1.3 tool row (or its meta-styled fallback)
 *  plus the 3px lead. */
const NODE_LIVE_H = 13 + 3
/** LiveLine's flattened text row — a 10px line whose box measures 14px, plus
 *  its 2px lead — which a tail carrying both a tool call and text renders
 *  UNDER the tool row. */
const NODE_LIVE_TAIL_H = 14 + 2
/** The shared-task row: its 10px/1.3 line plus the 3px lead, sized for the
 *  `+N` chip's own 1px outline (the tallest shape the row can take). */
const NODE_TASK_H = 15 + 3

/** TWO title lines plus the mono meta line: long agent names are clamped to
 *  two lines instead of ellipsizing to a couple of characters (see NODE_TITLE
 *  in TasksGraph.tsx), so the reserve covers that second line. */
export const GRAPH_NODE_H = NODE_CHROME_H + NODE_TITLE_LINES * NODE_TITLE_LINE_H + NODE_META_H
/** Extra height of a RUNNING agent node: the live row it always shows (a
 *  running node without activity yet renders LiveLine's "thinking" fallback). */
export const GRAPH_LIVE_H = NODE_LIVE_H
/** Extra height of a running node whose tail carries text as well as a tool. */
export const GRAPH_LIVE_TAIL_H = NODE_LIVE_TAIL_H
/** Extra height of an agent node carrying a shared-task line (team members). */
export const GRAPH_TASK_H = NODE_TASK_H

/**
 * The readability floor the fit honours: the canvas may shrink to this scale
 * before the layout starts wrapping (TasksGraph's fit and {@link bandColsFor}'s
 * column budget must agree, so the constant lives here, next to the geometry).
 */
export const GRAPH_FIT_MIN_SCALE = 0.78
export const GRAPH_GAP_X = 28
export const GRAPH_GAP_Y = 53
export const GRAPH_PAD = 16
/** The row stride (one row of cards plus the vertical gutter). Every card
 *  shape must fit inside it — see {@link nodeHeight} for the tallest one. */
export const GRAPH_ROW_STRIDE = GRAPH_NODE_H + GRAPH_LIVE_H + GRAPH_GAP_Y

/** One laid-out node. */
export interface GraphBox {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/** The layout result: one box per node plus the canvas extent. */
export interface GraphLayout {
  boxes: ReadonlyMap<string, GraphBox>
  width: number
  height: number
}

/** Layout knobs. */
export interface LayoutOptions {
  /** Columns per sibling band before it wraps to the next row (default 4). */
  maxBandCols?: number
}

/**
 * The display height of one node: the base card plus one reserved row per
 * line the card will actually render, so the pixels and the box agree (see
 * the constants above for what a mismatch costs).
 *
 * - a RUNNING agent always reserves the live row: without activity yet it
 *   still renders the "thinking" line (LiveLine's fallback), and a tail that
 *   arrived with a tool call reserves its text row too;
 * - an agent owning shared tasks (a team member) reserves the task row —
 *   without it a two-line title, the meta and the task row render 16px below
 *   the reserved box.
 *
 * The tallest shape therefore is base + live + live-tail + task, which stays
 * inside {@link GRAPH_ROW_STRIDE} (rows can never overlap).
 */
function nodeHeight(node: TasksNode): number {
  if (node.kind !== 'agent') return GRAPH_NODE_H
  let height = GRAPH_NODE_H
  if (node.state === 'running') {
    height += GRAPH_LIVE_H
    if (node.live?.tool !== undefined && node.live.text !== undefined) height += GRAPH_LIVE_TAIL_H
  }
  if ((node.tasks?.length ?? 0) > 0) height += GRAPH_TASK_H
  return height
}

/**
 * Chunk one sibling band into rows of at most `cols` children. Counting (not
 * width-packing) keeps the graph SHAPE: a level stays a row of siblings, and
 * a nested subtree never forces its aunts into a ladder of one-child rows.
 * Wide subtrees are handled by the fit scale instead.
 */
function bands(children: readonly TasksNode[], cols: number): TasksNode[][] {
  if (children.length <= cols) return [children.slice()]
  const out: TasksNode[][] = []
  for (let index = 0; index < children.length; index += cols) {
    out.push(children.slice(index, index + cols))
  }
  return out
}

/**
 * Lay out the model top-down, wrapping wide sibling bands.
 * @param nodes - the model's pre-order node list (roots = parentless rows).
 * @param options - see {@link LayoutOptions}.
 */
export function layoutTasksGraph(nodes: readonly TasksNode[], options: LayoutOptions = {}): GraphLayout {
  const cols = Math.max(1, options.maxBandCols ?? 4)
  const ids = new Set(nodes.map(node => node.id))
  const roots = nodes.filter(node => node.parentId === undefined || !ids.has(node.parentId))
  const childrenOf = new Map<string, TasksNode[]>()
  for (const edge of tasksEdges(nodes)) {
    const child = nodes.find(node => node.id === edge.to)
    if (child === undefined) continue
    const list = childrenOf.get(edge.from)
    if (list === undefined) childrenOf.set(edge.from, [child])
    else list.push(child)
  }

  /** Post-order: the width of the subtree rooted at `node`. */
  const subtreeWidth = (node: TasksNode): number => {
    const children = childrenOf.get(node.id) ?? []
    if (children.length === 0) return GRAPH_NODE_W
    let widest = GRAPH_NODE_W
    for (const band of bands(children, cols)) {
      const width = band.reduce((sum, child) => sum + subtreeWidth(child), 0)
        + GRAPH_GAP_X * (band.length - 1)
      widest = Math.max(widest, width)
    }
    return widest
  }

  const boxes = new Map<string, GraphBox>()
  /**
   * Place `node` centered on `centerX` at row `row`; returns the LAST row its
   * subtree occupies. Wrapped bands advance to the row after the deepest row
   * of the previous band, so a sibling's children can never land on top of
   * the next band (the overlap a naive +1 counter produced).
   */
  const place = (node: TasksNode, centerX: number, row: number): number => {
    boxes.set(node.id, {
      id: node.id,
      x: Math.round(centerX - GRAPH_NODE_W / 2),
      y: GRAPH_PAD + row * GRAPH_ROW_STRIDE,
      w: GRAPH_NODE_W,
      h: nodeHeight(node),
    })
    const children = childrenOf.get(node.id) ?? []
    if (children.length === 0) return row
    let deepest = row
    let bandRow = row + 1
    for (const band of bands(children, cols)) {
      const bandWidth = band.reduce((sum, child) => sum + subtreeWidth(child), 0)
        + GRAPH_GAP_X * (band.length - 1)
      let cursor = centerX - bandWidth / 2
      let bandDeepest = bandRow
      for (const child of band) {
        const width = subtreeWidth(child)
        bandDeepest = Math.max(bandDeepest, place(child, cursor + width / 2, bandRow))
        cursor += width + GRAPH_GAP_X
      }
      deepest = Math.max(deepest, bandDeepest)
      bandRow = bandDeepest + 1
    }
    return deepest
  }

  // Single-root forest in practice (the topology root); the loop stays so a
  // defensive orphan still lands inside the canvas extent.
  let offset = GRAPH_PAD
  for (const root of roots) {
    const width = subtreeWidth(root)
    place(root, offset + width / 2, 0)
    offset += width + GRAPH_GAP_X
  }

  const allBoxes = [...boxes.values()]
  const width = Math.max(GRAPH_PAD * 2 + GRAPH_NODE_W, ...allBoxes.map(box => box.x + box.w + GRAPH_PAD))
  const height = Math.max(GRAPH_PAD * 2 + GRAPH_NODE_H, ...allBoxes.map(box => box.y + box.h + GRAPH_PAD))
  return { boxes, width, height }
}

/**
 * How many sibling columns fit the given container width at ~1:1 scale. The
 * canvas keeps its readability floor instead of shrinking: at 360px two cards
 * per row, at 720px four.
 */
export function bandColsFor(containerWidth: number, minScale = GRAPH_FIT_MIN_SCALE): number {
  // Columns are budgeted at the readability floor, not at 1:1: the fit may
  // scale the canvas DOWN to `minScale` and still be readable, so a narrow
  // panel keeps two columns (scaled ~0.86 at 360px) instead of degenerating
  // into a one-card-per-row ladder. `layoutTasksGraphForWidth` re-checks the
  // real width against the same budget, so a too-wide pick is still narrowed.
  const usable = (containerWidth <= 0 ? 360 : containerWidth) / minScale - GRAPH_PAD * 2
  const cols = Math.floor((usable + GRAPH_GAP_X) / (GRAPH_NODE_W + GRAPH_GAP_X))
  return Math.min(4, Math.max(1, cols))
}

/**
 * The layout for one container width: the WIDEST sibling arrangement whose
 * canvas still fits `containerWidth / minScale` — i.e. the least-tall layout
 * the reader can see without zooming below the readability floor. Wrapping
 * more than needed turns the graph into a ladder; wrapping too little forces
 * an unreadable scale, so the loop tries the widest first and narrows.
 *
 * @param nodes - the model's node list.
 * @param containerWidth - the canvas viewport width in px.
 * @param minScale - the readability floor the fit honours (default 0.78).
 */
export function layoutTasksGraphForWidth(
  nodes: readonly TasksNode[],
  containerWidth: number,
  minScale = 0.78,
): GraphLayout {
  const budget = containerWidth <= 0 ? Number.POSITIVE_INFINITY : (containerWidth - 24) / minScale
  const widest = bandColsFor(containerWidth <= 0 ? 360 : containerWidth)
  // Pass 1: the least-tall arrangement that FITS the readability budget at
  // two or more columns (below two the graph degenerates into a ladder).
  for (let cols = widest; cols >= 2; cols -= 1) {
    const layout = layoutTasksGraph(nodes, { maxBandCols: cols })
    if (layout.width <= budget) return layout
  }
  // Pass 2: nothing flat fits — accept a slight horizontal overflow (the
  // reader pans a little) rather than stacking every child vertically.
  const tolerant = budget * 1.2
  for (let cols = widest; cols >= 2; cols -= 1) {
    const layout = layoutTasksGraph(nodes, { maxBandCols: cols })
    if (layout.width <= tolerant) return layout
  }
  return layoutTasksGraph(nodes, { maxBandCols: 1 })
}
