import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/client/Sidebar.tsx', 'utf8')

describe('Sidebar layout-push integration', () => {
  it('does not bypass the shared bottom-height cap during width drags', () => {
    expect(source).not.toContain('Math.min(state.bottomHeight, window.innerHeight)')
    expect(source.match(/pushedBottomHeight\(/g)).toHaveLength(9)
  })

  it('caps panel geometry against the viewport visible above the keyboard', () => {
    expect(source).toContain('setVisualViewportHeight(Math.max(0, Math.round(vv.height)))')
    expect(source).toContain('visualViewportHeight ?? viewport.height')
    expect(source.match(/viewportHeight: layoutViewportHeight/g)).toHaveLength(4)
    expect(source).toContain('viewport.width, layoutViewportHeight, keyboardInset]')
  })

  it('adds the keyboard inset to the conversation push, not the panel height', () => {
    expect(source.match(/height \+ keyboardInset/g)).toHaveLength(2)
    expect(source).toContain('height: bottomPanelHeight')
    expect(source).not.toContain('height: bottomPanelHeight + keyboardInset')
  })

  it('reapplies the visible-height cap to every vertical drag result', () => {
    expect(source).not.toMatch(/const height = clampHeight\(/)
    expect(source).not.toMatch(/height = clampHeight\(/)
    expect(source.match(/pushedBottomHeight\(true, clampHeight\(/g)).toHaveLength(6)
  })
})
