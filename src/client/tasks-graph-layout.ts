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

/** Geometry constants of the canvas (px, pre-scale). Metrics follow the
 *  approved Variant-D mockup, whose design target is the NARROW native right
 *  sidebar (~360px): a 132px card fits two per row plus the gutter. */
export const GRAPH_NODE_W = 150
/** Two title lines plus the mono meta line: the card clamps long agent names
 *  to two lines instead of ellipsizing them to a couple of characters, so the
 *  reserved height covers that (see NODE_TITLE in TasksGraph.tsx). */
export const GRAPH_NODE_H = 60
/** Extra height of an agent node carrying a live line. */
export const GRAPH_LIVE_H = 14
export const GRAPH_GAP_X = 28
export const GRAPH_GAP_Y = 53
export const GRAPH_PAD = 16
/** The row stride (one row of cards plus the vertical gutter). */
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
 * The display height of one node. Every RUNNING agent reserves the live-line
 * row: a running node without activity yet still renders the "thinking" line
 * (LiveLine's fallback), so reserving only when data arrived would clip it.
 */
function nodeHeight(node: TasksNode): number {
  if (node.kind === 'agent' && node.state === 'running') return GRAPH_NODE_H + GRAPH_LIVE_H
  return GRAPH_NODE_H
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
export function bandColsFor(containerWidth: number): number {
  const usable = containerWidth - GRAPH_PAD * 2
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
