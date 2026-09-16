/**
 * Layout-push size contract: the conversation column (output + composer)
 * must keep at least CONVERSATION_MIN of the viewport after the bottom
 * workbench claims its height. A stale persisted bottomHeight (or a cap at
 * 100vh) used to crush the composer off-screen. The right column belongs to
 * DSH's native Sidebar, so this shell pushes no width at all.
 */
import { describe, expect, it } from 'vitest'
import { BOTTOM_MIN, CONVERSATION_MIN } from '../src/client/state.ts'
import { bottomPushHeight } from '../src/client/layout-push.ts'

describe('bottomPushHeight', () => {
  it('pushes nothing while the workbench is collapsed', () => {
    expect(bottomPushHeight({ open: false, height: 400, viewportHeight: 800 })).toBe(0)
  })

  it('caps an oversize workbench so the conversation keeps CONVERSATION_MIN', () => {
    const viewportHeight = 800
    const height = bottomPushHeight({ open: true, height: 10_000, viewportHeight })
    expect(height).toBe(viewportHeight - CONVERSATION_MIN)
    expect(height).toBeGreaterThanOrEqual(BOTTOM_MIN)
    expect(viewportHeight - height).toBeGreaterThanOrEqual(CONVERSATION_MIN)
  })

  it('passes an in-range open height through', () => {
    expect(bottomPushHeight({ open: true, height: 220, viewportHeight: 800 })).toBe(220)
  })

  it('never pushes beyond a viewport smaller than the normal minima', () => {
    expect(bottomPushHeight({ open: true, height: 220, viewportHeight: 200 })).toBe(0)
  })

  it('turns non-finite geometry into a safe zero push', () => {
    expect(bottomPushHeight({ open: true, height: Number.POSITIVE_INFINITY, viewportHeight: Number.NaN })).toBe(0)
    expect(bottomPushHeight({ open: true, height: Number.NaN, viewportHeight: 800 })).toBe(0)
  })
})
