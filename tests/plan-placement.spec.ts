/**
 * Plan popup placement: both floating surfaces clamp to the plan document's
 * box intersected with the viewport, so a selection near the pane's top can
 * never push the note box (or the "add annotation" button) over the host's
 * title bar or out of the sidebar.
 */
import { describe, expect, it } from 'vitest'
import {
  floatingActionPlacement,
  noteBoxPlacement,
  type PlanPopupAnchor,
} from '../src/client/plan-placement.ts'

const VIEWPORT = { width: 1200, height: 900 }
const SURFACE = { left: 600, top: 90, right: 1180, bottom: 860 }

function anchor(top: number, bottom: number, left = 800, surface = SURFACE): PlanPopupAnchor {
  return { left, top, bottom, surface }
}

describe('noteBoxPlacement', () => {
  it('opens below a selection that leaves room', () => {
    expect(noteBoxPlacement(anchor(200, 220), VIEWPORT)).toEqual({
      left: 640,
      top: 228,
      width: 320,
      maxHeight: 770,
    })
  })

  it('flips above a selection near the bottom when the box fits there', () => {
    expect(noteBoxPlacement(anchor(700, 780), VIEWPORT)).toMatchObject({ top: 292 })
  })

  it('stays near the selection instead of pinning to the window top when neither side fits', () => {
    // A tall selection: below and above both overflow, so the old code
    // clamped to top=12 and covered the title bar. The box now stays at the
    // selection's top, inside the document.
    expect(noteBoxPlacement(anchor(100, 850), VIEWPORT)).toMatchObject({ top: 100 })
  })

  it('never leaves the document horizontally', () => {
    expect(noteBoxPlacement(anchor(200, 220, 1170), VIEWPORT).left).toBe(860)
    expect(noteBoxPlacement(anchor(200, 220, 610), VIEWPORT).left).toBe(600)
  })

  it('never grows wider than a narrow pane', () => {
    const narrow = { left: 0, top: 0, right: 300, bottom: 700 }
    const placement = noteBoxPlacement(anchor(200, 220, 150, narrow), VIEWPORT)
    expect(placement.width).toBe(288)
    expect(placement.left).toBe(12)
    expect(placement.maxHeight).toBe(688)
  })

  it('falls back to the viewport when the document box is empty', () => {
    const empty = { left: 0, top: 0, right: 0, bottom: 0 }
    expect(noteBoxPlacement(anchor(200, 220, 800, empty), VIEWPORT)).toMatchObject({
      left: 640,
      top: 228,
      width: 320,
      maxHeight: 876,
    })
  })
})

describe('floatingActionPlacement', () => {
  it('sits above the selection when there is room', () => {
    expect(floatingActionPlacement(anchor(200, 220), VIEWPORT)).toEqual({
      left: 800,
      top: 192,
      above: true,
    })
  })

  it('flips below the selection at the pane top instead of over the title bar', () => {
    expect(floatingActionPlacement(anchor(95, 115), VIEWPORT)).toEqual({
      left: 800,
      top: 123,
      above: false,
    })
  })

  it('clamps a tall selection to the document bottom', () => {
    expect(floatingActionPlacement(anchor(100, 850), VIEWPORT)).toMatchObject({
      top: 830,
      above: false,
    })
  })

  it('keeps the button inside the document horizontally', () => {
    expect(floatingActionPlacement(anchor(200, 220, 610), VIEWPORT).left).toBe(680)
    expect(floatingActionPlacement(anchor(200, 220, 1170), VIEWPORT).left).toBe(1100)
  })
})
