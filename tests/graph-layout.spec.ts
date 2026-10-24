import { describe, expect, it } from 'vitest'
import { edgePath, layoutGraph, type GraphNode, type GraphLayoutRow } from '../src/client/changes/graph-layout'

const node = (hashFull: string, ...parents: string[]): GraphNode => ({ hashFull, parents })
const outgoing = (row: GraphLayoutRow) => row.segments.filter(segment => segment.fromY === 0.5)

/** Check the geometry itself, not only the lane assignment. */
function assertConnections(nodes: readonly GraphNode[]) {
  const rows = layoutGraph(nodes)
  let frontier = new Map<number, { hash: string; color: number }>()
  rows.forEach((row, index) => {
    const top = row.segments.filter(segment => segment.fromY === 0)
    expect(top.length).toBe(frontier.size)
    for (const segment of top) {
      expect(frontier.get(segment.fromLane)).toEqual({ hash: segment.targetHash, color: segment.colorIndex })
      expect(segment.toLane).toBe(segment.fromLane)
      if (segment.toY === 0.5) {
        expect(segment.targetHash).toBe(row.hashFull)
        expect(segment.toLane).toBe(row.lane)
      } else {
        expect(segment.targetHash).not.toBe(row.hashFull)
        expect(segment.fromLane).not.toBe(row.lane)
      }
    }
    expect(outgoing(row).map(segment => segment.targetHash)).toEqual([...new Set(nodes[index]!.parents)])
    frontier = new Map()
    for (const segment of row.segments) {
      expect(segment.fromLane).toBeLessThan(row.laneCount)
      expect(segment.toLane).toBeLessThan(row.laneCount)
      if (segment.fromY === 0.5) expect(segment.fromLane).toBe(row.lane)
      if (segment.toY !== 1) continue
      const target = { hash: segment.targetHash, color: segment.colorIndex }
      if (segment.join) {
        // A join stub only TOUCHES the already-claimed lane: the frontier
        // entry belongs to the surviving line (its own colour), while the
        // stub wears the colour of the line that ENDS here — the node's.
        expect(frontier.has(segment.toLane)).toBe(true)
        expect(frontier.get(segment.toLane)!.hash).toBe(segment.targetHash)
        expect(segment.colorIndex).toBe(row.colorIndex)
        continue
      }
      if (frontier.has(segment.toLane)) expect(frontier.get(segment.toLane)).toEqual(target)
      frontier.set(segment.toLane, target)
    }
  })
}

describe('layoutGraph', () => {
  it('handles an empty graph and an isolated root without phantom edges', () => {
    expect(layoutGraph([])).toEqual([])
    expect(layoutGraph([node('root')])).toEqual([
      { hashFull: 'root', lane: 0, colorIndex: 0, laneCount: 1, segments: [] },
    ])
  })

  it('keeps a linear history straight with a stable color and bounded endpoints', () => {
    const nodes = [node('a', 'b'), node('b', 'c'), node('c')]
    const rows = layoutGraph(nodes)
    expect(rows.map(row => [row.lane, row.colorIndex, row.laneCount])).toEqual([[0, 0, 1], [0, 0, 1], [0, 0, 1]])
    expect(rows.map(row => row.segments.map(s => [s.fromY, s.toY]))).toEqual([
      [[0.5, 1]], [[0, 0.5], [0.5, 1]], [[0, 0.5]],
    ])
    assertConnections(nodes)
  })

  it('splits a merge into two parents and rejoins only their shared ancestor', () => {
    const nodes = [node('merge', 'left', 'right'), node('left', 'base'), node('right', 'base'), node('base')]
    const rows = layoutGraph(nodes)
    expect(rows.map(row => row.lane)).toEqual([0, 0, 1, 0])
    expect(outgoing(rows[0]!).map(s => [s.toLane, s.colorIndex])).toEqual([[0, 0], [1, 1]])
    expect(outgoing(rows[2]!)).toEqual([
      // The right line ends by JOINING the claimed base line: the stub wears
      // right's own colour (1), not the surviving line's (0).
      { fromLane: 1, toLane: 0, fromY: 0.5, toY: 1, colorIndex: 1, join: true, targetHash: 'base' },
    ])
    assertConnections(nodes)
  })

  it('handles octopus merges, duplicate parent entries, and occupied first-parent lanes', () => {
    const nodes = [node('m', 'a', 'b', 'c', 'd', 'b'), node('a', 'base'), node('b', 'base', 'extra'), node('c', 'base'), node('d', 'extra'), node('extra', 'base'), node('base')]
    const rows = layoutGraph(nodes)
    expect(outgoing(rows[0]!).map(s => s.toLane)).toEqual([0, 1, 2, 3])
    // b's first parent joins a claimed lane (b's own colour); its second parent
    // opens a NEW line and may not reuse b's own lane, so it lands past the
    // live lanes — the row grows one lane wider rather than bleeding colour.
    expect(outgoing(rows[2]!).map(s => [s.toLane, s.colorIndex, s.join])).toEqual([[0, 1, true], [4, 4, false]])
    expect(rows[2]!.laneCount).toBe(5)
    expect(rows[0]!.laneCount).toBe(4)
    assertConnections(nodes)
  })

  it('does not connect disconnected tips to passing lanes or reuse their colors', () => {
    const nodes = [node('a', 'base'), node('unrelated', 'other'), node('other'), node('base'), node('root')]
    const rows = layoutGraph(nodes)
    expect(rows.map(row => row.lane)).toEqual([0, 1, 1, 0, 0])
    expect(rows.map(row => row.colorIndex)).toEqual([0, 1, 1, 0, 2])
    expect(rows[4]!.segments).toEqual([])
    assertConnections(nodes)
  })

  it('preserves every row at every pagination boundary, including dangling parents', () => {
    const nodes = [node('m', 'a', 'b', 'missing'), node('a', 'base'), node('tip', 'c'), node('b', 'base'), node('c', 'base'), node('base'), node('unrelated')]
    const full = layoutGraph(nodes)
    for (let count = 0; count <= nodes.length; count++) {
      expect(layoutGraph(nodes.slice(0, count))).toEqual(full.slice(0, count))
    }
    expect(full.at(-1)?.segments).toContainEqual({ fromLane: 2, toLane: 2, fromY: 0, toY: 1, colorIndex: 2, join: false, targetHash: 'missing' })
    assertConnections(nodes)
  })

  it('paints a fork-join stub in the ENDING branch’s colour, not the surviving line’s', () => {
    // M1 comes before F1, so M1's line claims the shared fork C; F1's branch
    // ends by joining it. The stub must wear F1's colour all the way in —
    // painting it in the surviving line's colour is exactly the flaw this
    // test exists to pin (the "fork starts in the wrong colour" report).
    const rows = layoutGraph([node('M2', 'M1'), node('M1', 'C'), node('F1', 'C'), node('C')])
    const stub = outgoing(rows[2]!)[0]!
    expect(stub.join).toBe(true)
    expect(stub.colorIndex).toBe(rows[2]!.colorIndex)
    expect(stub.toLane).toBe(rows[3]!.lane)
    expect(stub.toLane).toBe(rows[0]!.lane)
    expect(rows[3]!.colorIndex).toBe(rows[0]!.colorIndex)
  })

  it('never starts a new branch line in the node’s OWN lane (the bleed that paints green on red)', () => {
    // x claims p1 first, so m's first parent is an already-claimed line (a
    // join) while m's own lane is consumed and merely LOOKS free. m's SECOND
    // parent must not be handed that lane: its straight drop would be drawn in
    // the new colour right on top of m's own line.
    const nodes = [node('x', 'p1'), node('m', 'p1', 'p2'), node('p1'), node('p2')]
    const rows = layoutGraph(nodes)
    const mRow = rows[1]!
    const edges = outgoing(mRow)
    // First parent: joins p1's claimed lane, wearing m's own colour.
    expect(edges[0]).toMatchObject({ toLane: rows[2]!.lane, join: true, colorIndex: mRow.colorIndex })
    // Second parent: opens a NEW line, on a lane that is not m's.
    expect(edges[1]!.join).toBe(false)
    expect(edges[1]!.colorIndex).toBe(rows[3]!.colorIndex)
    expect(edges[1]!.toLane).not.toBe(mRow.lane)
    // The clash itself: no two same-lane strokes of different colours.
    const laneColors = new Map<number, number>()
    const verticals = (segment: (typeof mRow.segments)[number]): number[] =>
      segment.fromLane === segment.toLane || segment.fromY === 0 || segment.join
        ? [segment.fromLane] : [segment.toLane]
    for (const segment of mRow.segments) {
      for (const lane of verticals(segment)) {
        const previous = laneColors.get(lane)
        expect(previous === undefined || previous === segment.colorIndex,
          `lane ${lane}: ${previous} then ${segment.colorIndex}`).toBe(true)
        laneColors.set(lane, segment.colorIndex)
      }
    }
    assertConnections(nodes)
  })

  it('paints a merge’s second-parent edge in the NEW line’s colour', () => {
    // M opens a fresh line for its second parent B: the edge belongs to that
    // line and wears its colour from the dot on, matching the reference
    // picture where the whole merge curve carries the merged branch's colour.
    const rows = layoutGraph([node('M', 'A', 'B'), node('A'), node('B')])
    const edges = outgoing(rows[0]!)
    expect(edges.map(edge => [edge.toLane, edge.colorIndex, edge.join])).toEqual([
      [rows[0]!.lane, rows[0]!.colorIndex, false],
      [rows[2]!.lane, rows[2]!.colorIndex, false],
    ])
    expect(rows[2]!.colorIndex).not.toBe(rows[0]!.colorIndex)
  })

  it('does not mutate frozen inputs and has no state shared between calls', () => {
    const nodes = Object.freeze([
      Object.freeze({ hashFull: 'a', parents: Object.freeze(['b', 'c']) }),
      Object.freeze({ hashFull: 'b', parents: Object.freeze([]) }),
    ])
    const first = layoutGraph(nodes)
    layoutGraph([node('unrelated')])
    expect(layoutGraph(nodes)).toEqual(first)
  })

  it('maintains edge continuity for deterministic generated topological DAGs', () => {
    for (let seed = 1; seed <= 12; seed++) {
      let state = seed
      const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0)
      const nodes = Array.from({ length: 40 }, (_, i) => {
        const parents = Array.from({ length: next() % 5 }, () => String(i + 1 + next() % (44 - i)))
        return node(String(i), ...parents)
      })
      assertConnections(nodes)
      expect(layoutGraph(nodes.slice(0, 20))).toEqual(layoutGraph(nodes).slice(0, 20))
    }
  })
})

describe('edgePath', () => {
  // The lens's real geometry: lane x = 10 + lane * 12, row height 28.
  const laneX = (lane: number): number => 10 + lane * 12
  const H = 28
  /** A segment fixture: `join` defaults to false (an OPENING edge). */
  const seg = (fromLane: number, toLane: number, fromY: 0 | 0.5, toY: 0.5 | 1, join = false) =>
    ({ fromLane, toLane, fromY, toY, join })
  /** Every x a path draws a VERTICAL run at (an `L`/`Q` whose two endpoints
   *  share an x, plus the vertical stub a curve starts from). */
  const verticalXs = (d: string): number[] => {
    const tokens = d.match(/[MLQ]|-?\d+(\.\d+)?/g) ?? []
    const xs: number[] = []
    let i = 0
    let cx = 0
    let cy = 0
    while (i < tokens.length) {
      const cmd = tokens[i]!
      if (cmd === 'M' || cmd === 'L') {
        const x = Number(tokens[i + 1])
        const y = Number(tokens[i + 2])
        if (cmd === 'L' && x === cx) xs.push(x)
        cx = x; cy = y; i += 3
      } else if (cmd === 'Q') {
        const qx = Number(tokens[i + 1])
        const qy = Number(tokens[i + 2])
        const x = Number(tokens[i + 3])
        const y = Number(tokens[i + 4])
        if (qx === cx && cy === qy) xs.push(cx)
        cx = x; cy = y; i += 5
      } else { i += 1 }
    }
    return xs
  }

  it('draws a same-lane run as one straight vertical', () => {
    expect(edgePath(seg(1, 1, 0, 1), laneX, H)).toBe('M 22 0 L 22 28')
    expect(edgePath(seg(0, 0, 0, 0.5), laneX, H)).toBe('M 10 0 L 10 14')
  })

  it('rounds an OPENING lane change with the elbow at the node', () => {
    // A merge's second parent: the new line leaves the node, turns once, and
    // drops down its OWN lane.
    const d = edgePath(seg(0, 1, 0.5, 1, false), laneX, H)
    expect(d).toBe('M 10 14 L 18 14 Q 22 14 22 18 L 22 28')
    expect(d.match(/Q/g)).toHaveLength(1)
    expect(verticalXs(d)).toEqual([22])
  })

  it('mirrors the opening elbow for a right-to-left lane change', () => {
    expect(edgePath(seg(2, 0, 0.5, 1, false), laneX, H)).toBe('M 34 14 L 14 14 Q 10 14 10 18 L 10 28')
  })

  it('runs a JOIN edge down its OWN lane and crosses over at the row boundary', () => {
    // The fork's ending branch: green down lane 1, then a left turn along the
    // bottom edge. It must NOT drop vertically inside lane 0 — that put a
    // green stretch on the red main line (the reported defect).
    // The crossing rides half a stroke (0.75px) above the boundary so the next
    // row's background cannot eat its lower half; its LOWER EDGE still lands
    // exactly on the boundary (27.25 + 1.5/2 = 28).
    const d = edgePath(seg(1, 0, 0.5, 1, true), laneX, H)
    expect(d).toBe('M 22 14 L 22 23.25 Q 22 27.25 18 27.25 L 10 27.25')
    expect(verticalXs(d)).toEqual([22])
    expect(verticalXs(d)).not.toContain(10)
  })

  it('never draws a vertical inside the lane a join edge joins, at any radius/spacing', () => {
    for (const from of [0, 1, 2, 3]) {
      for (const to of [0, 1, 2, 3]) {
        if (from === to) continue
        const d = edgePath(seg(from, to, 0.5, 1, true), laneX, H)
        expect(verticalXs(d), `join ${from}->${to}: ${d}`).not.toContain(laneX(to))
      }
    }
  })

  it('clamps the corner radius so a tight turn never overshoots', () => {
    // One lane over (12px) is fine at r=4; a hypothetical half-height row
    // clamps to half the vertical run instead.
    expect(edgePath(seg(0, 1, 0.5, 1, false), laneX, 8)).toBe('M 10 4 L 20 4 Q 22 4 22 6 L 22 8')
    // A join's radius is bounded by the run left above the inset too, so the
    // elbow can never curve back past the node on a degenerate short row.
    expect(edgePath(seg(1, 0, 0.5, 1, true), laneX, 8)).toBe('M 22 4 L 22 5.625 Q 22 7.25 20.375 7.25 L 10 7.25')
  })

  it('bends a full-row crossing twice at mid-height (defensive shape)', () => {
    const d = edgePath(seg(0, 2, 0, 1, false), laneX, H)
    expect(d).toBe('M 10 0 L 10 10 Q 10 14 14 14 L 30 14 Q 34 14 34 18 L 34 28')
    expect(d.match(/Q/g)).toHaveLength(2)
  })
})
