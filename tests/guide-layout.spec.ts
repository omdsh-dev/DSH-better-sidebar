/**
 * Pure start-page layout: ordering, visibility, the two-column threshold, and
 * the overflow that becomes the "More" card.
 */
import { describe, expect, it } from 'vitest'
import {
  GUIDE_DEFAULT_ROWS,
  GUIDE_TWO_COLUMN_MIN_WIDTH,
  columnsForWidth,
  computeGuideLayout,
  normalizeGuideRows,
  orderGuideEntries,
} from '../src/client/native/guide-layout.ts'

const entries = ['a', 'b', 'c', 'd', 'e'].map(key => ({ key }))

describe('start-page layout', () => {
  it('switches to two columns exactly at the threshold', () => {
    expect(columnsForWidth(GUIDE_TWO_COLUMN_MIN_WIDTH - 1)).toBe(1)
    expect(columnsForWidth(GUIDE_TWO_COLUMN_MIN_WIDTH)).toBe(2)
    expect(columnsForWidth(1200)).toBe(2)
  })

  it('normalizes the row count to at least one and defaults to six', () => {
    expect(GUIDE_DEFAULT_ROWS).toBe(6)
    expect(normalizeGuideRows(0)).toBe(6)
    expect(normalizeGuideRows(-2)).toBe(6)
    expect(normalizeGuideRows(2.5)).toBe(6)
    expect(normalizeGuideRows(1)).toBe(1)
    expect(normalizeGuideRows(40)).toBe(40)
  })

  it('orders by the explicit list and appends unknown entries in registry order', () => {
    expect(orderGuideEntries(entries, ['d', 'b']).map(entry => entry.key))
      .toEqual(['d', 'b', 'a', 'c', 'e'])
    expect(orderGuideEntries(entries, ['zzz']).map(entry => entry.key))
      .toEqual(['a', 'b', 'c', 'd', 'e'])
    // Duplicate order keys keep the first occurrence.
    expect(orderGuideEntries(entries, ['c', 'c', 'a']).map(entry => entry.key))
      .toEqual(['c', 'a', 'b', 'd', 'e'])
  })

  it('removes hidden cards before the capacity check', () => {
    const layout = computeGuideLayout(entries, {
      order: [],
      hidden: { b: true, d: true },
      rows: 1,
      width: 600,
    })
    expect(layout.visible.map(entry => entry.key)).toEqual(['a'])
    expect(layout.overflow.map(entry => entry.key)).toEqual(['c', 'e'])
    expect(layout.showMore).toBe(true)
  })

  it('reserves one cell for More once the list exceeds the row budget', () => {
    const two = computeGuideLayout(entries, { order: [], hidden: {}, rows: 1, width: 600 })
    expect(two.columns).toBe(2)
    expect(two.capacity).toBe(2)
    expect(two.visible.map(entry => entry.key)).toEqual(['a'])
    expect(two.overflow.map(entry => entry.key)).toEqual(['b', 'c', 'd', 'e'])
    expect(two.showMore).toBe(true)

    const one = computeGuideLayout(entries, { order: [], hidden: {}, rows: 1, width: 400 })
    expect(one.columns).toBe(1)
    expect(one.capacity).toBe(1)
    // At the minimum capacity the page shows the More card alone.
    expect(one.visible).toEqual([])
    expect(one.overflow).toHaveLength(5)
    expect(one.showMore).toBe(true)
  })

  it('can reserve a persistent More cell even when every card fits', () => {
    const layout = computeGuideLayout(entries, {
      order: [],
      hidden: {},
      rows: 3,
      width: 600,
      reserveMore: true,
    })
    expect(layout.capacity).toBe(6)
    expect(layout.visible).toHaveLength(5)
    expect(layout.overflow).toEqual([])
    expect(layout.showMore).toBe(true)

    const exact = computeGuideLayout(entries.slice(0, 2), {
      order: [],
      hidden: {},
      rows: 1,
      width: 600,
      reserveMore: true,
    })
    expect(exact.visible.map(entry => entry.key)).toEqual(['a'])
    expect(exact.overflow.map(entry => entry.key)).toEqual(['b'])
    expect(exact.showMore).toBe(true)
  })

  it('shows everything when it fits, with no More card', () => {
    const layout = computeGuideLayout(entries, { order: [], hidden: {}, rows: 6, width: 600 })
    expect(layout.capacity).toBe(12)
    expect(layout.visible).toHaveLength(5)
    expect(layout.overflow).toEqual([])
    expect(layout.showMore).toBe(false)
  })

  it('has no More card when every card is hidden', () => {
    const layout = computeGuideLayout(entries, {
      order: [],
      hidden: { a: true, b: true, c: true, d: true, e: true },
      rows: 1,
      width: 400,
    })
    expect(layout.visible).toEqual([])
    expect(layout.overflow).toEqual([])
    expect(layout.showMore).toBe(false)
  })
})
