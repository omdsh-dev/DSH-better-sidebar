/**
 * Pure start-page layout math: ordering, visibility, the two-column threshold,
 * and the overflow that collapses into the "More" card.
 */

/** The wide layout starts at two columns from this pane width on. */
export const GUIDE_TWO_COLUMN_MIN_WIDTH = 520

/** Rows a document without a stored value gets. */
export const GUIDE_DEFAULT_ROWS = 6

/** One card the layout reasons about. */
export interface GuideLayoutEntry {
  readonly key: string
}

/** Inputs of computeGuideLayout. */
export interface GuideLayoutOptions {
  /** Explicit start-page order, by card key. */
  readonly order: readonly string[]
  /** Visibility overrides; an absent key is visible. */
  readonly hidden: Readonly<Record<string, boolean>>
  /** Maximum rows; normalized to at least one. */
  readonly rows: number
  /** Pane width in CSS pixels. */
  readonly width: number
}

/** The settled layout one guide render uses. */
export interface GuideLayout<T extends GuideLayoutEntry> {
  readonly columns: number
  readonly rows: number
  readonly capacity: number
  readonly visible: readonly T[]
  readonly overflow: readonly T[]
  readonly showMore: boolean
}

/** One or two columns for a pane width. */
export function columnsForWidth(width: number): number {
  return width >= GUIDE_TWO_COLUMN_MIN_WIDTH ? 2 : 1
}

/** Normalize a stored row count; anything below one falls back to the default. */
export function normalizeGuideRows(rows: number): number {
  return Number.isSafeInteger(rows) && rows >= 1 ? rows : GUIDE_DEFAULT_ROWS
}

/**
 * Sort entries by the stored order. Keys absent from the order follow in their
 * registration order; keys in the order that no longer exist do not matter.
 */
export function orderGuideEntries<T extends GuideLayoutEntry>(
  entries: readonly T[],
  order: readonly string[],
): T[] {
  const rank = new Map<string, number>()
  for (const [index, key] of order.entries()) if (!rank.has(key)) rank.set(key, index)
  return entries
    .map((entry, index) => ({ entry, index, rank: rank.get(entry.key) }))
    .sort((left, right) => {
      if (left.rank !== undefined && right.rank !== undefined) {
        return left.rank - right.rank || left.index - right.index
      }
      if (left.rank !== undefined) return -1
      if (right.rank !== undefined) return 1
      return left.index - right.index
    })
    .map(item => item.entry)
}

/**
 * Resolve the cards one start page draws.
 *
 * Hidden cards are removed before the capacity check, so hiding a card never
 * creates an artificial overflow. Once the remaining list exceeds the row
 * budget, ONE slot goes to the "More" card: visible cards are
 * "capacity - 1", and the rest live in its menu. At the minimum capacity of
 * one, the page therefore shows the More card alone.
 */
export function computeGuideLayout<T extends GuideLayoutEntry>(
  entries: readonly T[],
  options: GuideLayoutOptions,
): GuideLayout<T> {
  const rows = normalizeGuideRows(options.rows)
  const columns = columnsForWidth(options.width)
  const ordered = orderGuideEntries(entries, options.order)
  const shown = ordered.filter(entry => options.hidden[entry.key] !== true)
  const capacity = rows * columns
  if (shown.length <= capacity) {
    return { columns, rows, capacity, visible: shown, overflow: [], showMore: false }
  }
  const visibleCount = Math.max(0, capacity - 1)
  return {
    columns,
    rows,
    capacity,
    visible: shown.slice(0, visibleCount),
    overflow: shown.slice(visibleCount),
    showMore: true,
  }
}
