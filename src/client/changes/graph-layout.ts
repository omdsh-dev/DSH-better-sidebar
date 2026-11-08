export interface GraphNode {
  readonly hashFull: string
  readonly parents: readonly string[]
}

/** Corner radius of a lane-change bend, clamped per edge by its real estate. */
const CORNER_RADIUS = 4

/**
 * Half of the rail stroke (`graph.module.css` paints `stroke-width: 1.5`).
 *
 * A join edge's crossing runs along the row's BOTTOM EDGE, and everything the
 * SVG paints outside its box is covered by the NEXT row's background (siblings
 * paint in order — `overflow: visible` alone cannot win that fight). Centring
 * the crossing half a stroke above the boundary keeps the whole line inside the
 * row while its lower edge still lands exactly ON the boundary, where the next
 * row's vertical picks it up — measured at 8× zoom, the crossing renders the
 * full 1.5px instead of the 0.75px half a stroke that spilled.
 */
const STROKE_INSET = 0.75

/**
 * The SVG path of one segment — a "rectangular" edge with ONE rounded elbow,
 * never a bare diagonal.
 *
 * WHERE the elbow sits is what keeps every line one colour. An edge that
 * OPENS a line (a merge's second parent) leaves the node horizontally and
 * rounds down into its own new lane. An edge that JOINS a line (a branch
 * ending at its fork) must instead run down its OWN lane and then turn into
 * the surviving lane along the row boundary: rounding into the target lane
 * and dropping there would paint a piece of the leaving branch's colour
 * straight onto the surviving line — the exact "there is still a green
 * stretch on the red main line" defect.
 *
 * A full-row crossing (neither end at a node; the current layout never emits
 * one) bends twice at mid-height. Coordinates stay in the row-fraction space
 * of {@link GraphSegment}; callers scale by the row height.
 */
export function edgePath(segment: Pick<GraphSegment, 'fromLane' | 'toLane' | 'fromY' | 'toY' | 'join'>, laneX: (lane: number) => number, rowHeight: number): string {
  const x1 = laneX(segment.fromLane)
  const x2 = laneX(segment.toLane)
  const y1 = segment.fromY * rowHeight
  const y2 = segment.toY * rowHeight
  if (x1 === x2 || y1 === y2) return `M ${x1} ${y1} L ${x2} ${y2}`
  const dx = Math.sign(x2 - x1)
  const dy = Math.sign(y2 - y1)
  const r = Math.min(CORNER_RADIUS, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2)
  if (segment.join || segment.toY === 0.5) {
    // The leaving line keeps its own lane all the way down, then crosses over
    // along the row boundary — no vertical inside the lane it joins, and (see
    // STROKE_INSET) no half-stroke for the next row's background to eat.
    const yb = y2 - STROKE_INSET
    // The elbow's radius is also bounded by the run left ABOVE the inset, so a
    // degenerate (very short) row can never curve past the node.
    const rj = Math.min(r, Math.abs(yb - y1) / 2)
    return `M ${x1} ${y1} L ${x1} ${yb - dy * rj} Q ${x1} ${yb} ${x1 + dx * rj} ${yb} L ${x2} ${yb}`
  }
  if (segment.fromY === 0.5) {
    return `M ${x1} ${y1} L ${x2 - dx * r} ${y1} Q ${x2} ${y1} ${x2} ${y1 + dy * r} L ${x2} ${y2}`
  }
  const ym = (y1 + y2) / 2
  return `M ${x1} ${y1} L ${x1} ${ym - dy * r} Q ${x1} ${ym} ${x1 + dx * r} ${ym} L ${x2 - dx * r} ${ym} Q ${x2} ${ym} ${x2} ${ym + dy * r} L ${x2} ${y2}`
}


/** Coordinates are lane indices horizontally and fractions of one row vertically. */
export interface GraphSegment {
  readonly fromLane: number
  readonly toLane: number
  readonly fromY: 0 | 0.5
  readonly toY: 0.5 | 1
  readonly colorIndex: number
  /** True when this edge joins a line another child already claimed (a branch
   *  line ENDING at its fork point). A join stub wears the ENDING line's
   *  colour — the node's own — while the surviving line keeps its colour; the
   *  reverse convention would paint the first stretch of every fork in the
   *  colour of the line it joins. An edge that OPENS a parent's new line wears
   *  that new line's colour instead. */
  readonly join: boolean
  /** The ancestor this line is travelling towards; not necessarily in this page. */
  readonly targetHash: string
}

export interface GraphLayoutRow {
  readonly hashFull: string
  readonly lane: number
  readonly colorIndex: number
  /** Width needed by this row, including passing lines (not the whole graph). */
  readonly laneCount: number
  readonly segments: readonly GraphSegment[]
}

interface Reservation {
  hash: string
  lane: number
  colorIndex: number
}

/**
 * Lay out a unique, child-before-parent commit prefix, without looking ahead.
 * Render segments before the node, whose center is (lane, 0.5). Scale x by the
 * lane spacing (plus padding), y by row height. A crossing is not a junction;
 * only an endpoint at a commit center represents a connection to that commit.
 *
 * Recompute on the entire concatenated prefix when fetching another page: every
 * previously returned row, including its width and dangling edges, is unchanged.
 * Missing parents deliberately remain reserved through the bottom edge. Do not
 * truncate them based on whether a parent is currently loaded.
 *
 * First-parent continuations inherit their lane/color when possible. Other new
 * branches and disconnected tips get monotonically allocated color indices;
 * callers may reduce these modulo a theme palette. Vacant lanes are reused but
 * live lanes never shift, avoiding accidental connections and pagination jitter.
 *
 * Cost is O(sum of frontier widths + edges), with O(frontier width) working
 * space, excluding output. Width includes vacant slots between live lanes.
 */
export function layoutGraph(nodes: readonly GraphNode[]): GraphLayoutRow[] {
  const lanes: (Reservation | undefined)[] = []
  const targets = new Map<string, Reservation>()
  const rows: GraphLayoutRow[] = []
  let nextColor = 0

  for (const node of nodes) {
    // One forward scan per row, even for an octopus with many new parents.
    let freeCursor = 0
    /** The next free lane, never the lane this row's node sits on: the node's
     *  consumed lane LOOKS free, but the row still draws strokes there (the
     *  node's own outgoing edges and its dot), so handing it to a new line
     *  would paint that line's colour over the node's line — the reported
     *  "there is still a green stretch on the red main line". `-1` means no
     *  exclusion (the node has not picked its lane yet). */
    const freeLane = (exclude: number) => {
      while (lanes[freeCursor] !== undefined || freeCursor === exclude) freeCursor++
      return freeCursor++
    }
    const incoming = targets.get(node.hashFull)
    const lane = incoming?.lane ?? freeLane(-1)
    const colorIndex = incoming?.colorIndex ?? nextColor++
    const segments: GraphSegment[] = []
    let laneCount = Math.max(lanes.length, lane + 1)

    for (const reservation of lanes) {
      if (!reservation) continue
      segments.push({
        fromLane: reservation.lane,
        toLane: reservation.lane,
        fromY: 0,
        toY: reservation === incoming ? 0.5 : 1,
        colorIndex: reservation.colorIndex,
        join: false,
        targetHash: reservation.hash,
      })
    }
    if (incoming) {
      targets.delete(node.hashFull)
      lanes[lane] = undefined
    }

    const parents = new Set(node.parents)
    let firstParent = true
    for (const hash of parents) {
      let reservation = targets.get(hash)
      const opening = reservation === undefined
      if (!reservation) {
        // The consumed node's lane is available even if freeCursor passed it.
        const parentLane = firstParent ? lane : freeLane(lane)
        reservation = {
          hash,
          lane: parentLane,
          colorIndex: firstParent ? colorIndex : nextColor++,
        }
        lanes[parentLane] = reservation
        targets.set(hash, reservation)
      }
      segments.push({
        fromLane: lane,
        toLane: reservation.lane,
        fromY: 0.5,
        toY: 1,
        // An edge OPENING the parent's new line wears that line's colour; an
        // edge JOINING an already-claimed parent is the tail of THIS node's
        // line and wears the node's own colour all the way into the fork.
        colorIndex: opening ? reservation.colorIndex : colorIndex,
        join: !opening,
        targetHash: hash,
      })
      laneCount = Math.max(laneCount, reservation.lane + 1)
      firstParent = false
    }

    rows.push({ hashFull: node.hashFull, lane, colorIndex, laneCount, segments })
    while (lanes.length && lanes[lanes.length - 1] === undefined) lanes.pop()
  }
  return rows
}
