/**
 * The layout-push contract is split between the shell (DOM writes) and
 * layout-push.ts (the cap): these source assertions pin the seams a
 * refactor silently breaks — every push must ride the shared cap, the
 * keyboard inset must extend the PUSH (never the panel's own height), and
 * the cap must be measured against the visual viewport.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/client/Sidebar.tsx', 'utf8')

describe('Sidebar layout-push integration', () => {
  it('routes every push through the shared bottom-height cap', () => {
    expect(source.match(/bottomPushHeight\(\{/g)).toHaveLength(2)
    expect(source).not.toContain('Math.min(state.bottomHeight, window.innerHeight)')
  })

  it('caps the geometry against the visible height above the keyboard', () => {
    expect(source).toContain('setVisualViewportHeight(Math.max(0, Math.round(vv.height)))')
    expect(source).toContain('visualViewportHeight ?? viewport.height')
    expect(source.match(/viewportHeight: layoutViewportHeight/g)).toHaveLength(2)
  })

  it('adds the keyboard inset to the conversation push, not the panel height', () => {
    expect(source.match(/height \+ keyboardInset/g)).toHaveLength(2)
    expect(source).toContain('height: bottomPanelHeight')
    expect(source).not.toContain('height: bottomPanelHeight + keyboardInset')
  })

  it('reapplies the height clamp to every vertical drag result', () => {
    // Both live pointer paths (move + up) clamp before writing or committing.
    expect(source.match(/clampHeight\(startHeight \+ \(startY - event\.clientY\)\)/g)).toHaveLength(2)
    // The interrupted-drag paths (pointercancel / lost capture) clamp too.
    expect(source.match(/clampHeight\(bottomDrag\.current\.startHeight/g)).toHaveLength(1)
    expect(source.match(/clampHeight\(lastDragHeight\.current/g)).toHaveLength(1)
  })
})
