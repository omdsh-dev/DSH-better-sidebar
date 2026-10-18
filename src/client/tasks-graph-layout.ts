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
 *  NARROW native right sidebar (~360px): a 190px card fits two per row plus
 *  the gutter, and the card's own rows stay readable at the fit's floor. */
export const GRAPH_NODE_W = 190

/**
 * The card's heights are the SUM OF THE ROWS THE CARD RENDERS, in the real
 * metrics of the page's type scale (the same numbers the rules in
 * tasks-graph.module.css are written with). They are derived rather than
 * hand-tuned because the card is a fixed-geometry box: its height is `auto`
 * with `min-height: box.h`, so an under-reserved card does not stay inside the
 * box the layout handed it — it RENDERS TALLER, and everything the layout
 * derives from `box.h` (the row pitch, the phase frames, the canvas extent)
 * then disagrees with the pixels on screen.
 *
 * The card is TWO SEGMENTS (tasks-card.tsx): a top segment carrying the kind
 * badge, the clamped name, the mono meta (and, for a team member, the shared
 * task line) and a bottom state bar carrying the state dot, the state word and
 * the merged process activity. Every node kind reserves the SAME base height —
 * a settled node shows its activity summary in that bar just like a running
 * one, so the two can never disagree with the layout.
 *
 * Measured on the rendered page before this structure existed: a running
 * teammate card carrying a two-line title, its meta, a live row and a task line
 * rendered 100px while the base reserve handed it 68 — `min-height` cannot hold
 * it down, so the card ate 32px of the 53px gutter to the next row and poked
 * out of its phase frame.
 */
const NODE_EDGE_H = 1
/** The card's own border only: the two segments carry their own padding. */
const NODE_CHROME_H = 2 * NODE_EDGE_H
/** `.cardTop`'s vertical padding (6px top / 5px bottom). */
const NODE_PAD_TOP = 6
const NODE_PAD_BOTTOM = 5
/** One badge row — `--dsw-font-xxxs-11` (11px/14px) plus its 2px lead. */
const NODE_BADGE_H = 14 + 2
/** One title line — `--dsw-font-xxs-strong-12` (12px/18px). */
const NODE_TITLE_LINE_H = 18
/** Title lines the card reserves: the clamp in tasks-graph.module.css. */
const NODE_TITLE_LINES = 2
/** The mono meta line — `--dsw-font-xxxs-11` (11px/14px) plus its 2px lead. */
const NODE_META_H = 14 + 2
/** The state bar — `.cardBar`'s fixed height (its top border sits inside it). */
const NODE_BAR_H = 22
/** One line of the card's text tail — `.cardText`'s 10px/1.3 box. */
const NODE_TEXT_LINE_H = 13
/** The text tail's lead above the first line (`margin-top` in `.cardText`). */
const NODE_TEXT_LEAD_H = 2
/** Lines the text tail may show at most. */
export const NODE_TEXT_MAX_LINES = 3
/** The most a card's text tail can add to its height. */
export const GRAPH_TEXT_MAX_H = NODE_TEXT_MAX_LINES * NODE_TEXT_LINE_H + NODE_TEXT_LEAD_H
/** The shared-task row: its 10px/1.3 line plus the 3px lead, sized for the
 *  `+N` chip's own 1px outline (the tallest shape the row can take). */
const NODE_TASK_H = 15 + 3

/**
 * An AGENT card: badges + TWO title lines + the state bar. Long agent names are
 * clamped to two lines instead of ellipsizing to a couple of characters (see
 * `.cardName` in tasks-graph.module.css), so the reserve covers that second
 * line. The mode word moved into the badge row, so an agent card carries no
 * mono meta line — reserving one left a visible 16px hole above the bar.
 */
export const GRAPH_AGENT_NODE_H = NODE_CHROME_H + NODE_PAD_TOP + NODE_BADGE_H
  + NODE_TITLE_LINES * NODE_TITLE_LINE_H + NODE_PAD_BOTTOM + NODE_BAR_H
/**
 * The tallest card on the canvas: a workflow RUN keeps its mono meta line
 * (status · member tally), which no badge can express. {@link rowStrideFor}
 * narrows the row pitch back to {@link GRAPH_AGENT_NODE_H} for a model without
 * runs, so agent-only trees do not grow 16px of empty gutter per row.
 */
export const GRAPH_NODE_H = GRAPH_AGENT_NODE_H + NODE_META_H
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
/** The tallest row stride (the run card plus the vertical gutter). */
export const GRAPH_ROW_STRIDE = GRAPH_NODE_H + GRAPH_GAP_Y

/**
 * The row pitch one model actually needs: the tallest card it draws plus the
 * gutter. Card heights differ by kind and by content (a run keeps its meta line;
 * an agent may add a task row and up to {@link NODE_TEXT_MAX_LINES} lines of text
 * tail), so the pitch is measured from the model instead of hard-picked — a card
 * taller than the pitch would overlap the row below it and its phase frame.
 *
 * @param nodes - the model's node list.
 */
export function rowStrideFor(nodes: readonly TasksNode[]): number {
  let tallest = GRAPH_AGENT_NODE_H
  for (const node of nodes) tallest = Math.max(tallest, nodeHeight(node))
  return tallest + GRAPH_GAP_Y
}

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
 * The display height of one node: the base card, plus the text-tail lines a
 * running/settled child renders under its name, plus the shared-task row a team
 * member renders. The merged activity lives in the state bar every card draws,
 * so it costs no height.
 *
 * The tail's reservation is computed from the TEXT, not fixed at the maximum:
 * a card that reserved three lines to show one would wear a 26px hole above its
 * bar (the reader's own "空荡荡" report, in a different place), so the estimate
 * is deliberately conservative — it floors the wrapped line count, which means
 * a long tail is clamped one line short rather than overflowing the box.
 */
function nodeHeight(node: TasksNode): number {
  if (node.kind !== 'agent') return GRAPH_NODE_H
  const base = GRAPH_AGENT_NODE_H
  const lines = textTailLines(node.live?.text)
  const text = lines * NODE_TEXT_LINE_H + (lines === 0 ? 0 : NODE_TEXT_LEAD_H)
  return base + text + ((node.tasks?.length ?? 0) > 0 ? GRAPH_TASK_H : 0)
}

/**
 * How many lines a card's text tail takes, 0 when the node has none.
 *
 * An ESTIMATE by character width, because the layout runs before the browser
 * wraps anything: CJK reads at the font's full size and latin at a bit over
 * half of it, over the card's inner width. Floored on purpose (see
 * {@link nodeHeight}), and capped at {@link NODE_TEXT_MAX_LINES}.
 *
 * @param text - the child's newest assistant text (flattened by the caller).
 * @param cardWidth - the card's outer width (defaults to the graph's).
 */
export function textTailLines(text: string | undefined, cardWidth: number = GRAPH_NODE_W): number {
  if (text === undefined || text === '') return 0
  // `.cardTop`'s 8px left + 10px right padding, minus the tail's own lead.
  const usable = Math.max(40, cardWidth - 18)
  // 10px font: a CJK glyph is ~10px wide, latin ~5.5px (measured against the
  // page's own stack; the ×0.9 keeps the estimate from cutting a line short).
  let units = 0
  for (const char of text) {
    units += /[\u3000-\u9fff\uff00-\uffef]/.test(char) ? 10 : 5.5
  }
  const lines = Math.ceil((units * 0.9) / usable)
  return Math.max(1, Math.min(NODE_TEXT_MAX_LINES, lines))
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
  const stride = rowStrideFor(nodes)
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
      y: GRAPH_PAD + row * stride,
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
  const height = Math.max(GRAPH_PAD * 2 + GRAPH_AGENT_NODE_H, ...allBoxes.map(box => box.y + box.h + GRAPH_PAD))
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
