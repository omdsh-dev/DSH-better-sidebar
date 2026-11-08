/**
 * The anchored popover (AnchoredPopover.tsx): the card opens below its anchor
 * but never inside the shell's native window-control band (issue #805's
 * mechanism; the Tasks detail window is the same bug one component over).
 *
 * jsdom performs no layout, so the card measures 0 tall and its placement is
 * read back from the inline style the component writes.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { AnchoredPopover } from '../src/client/AnchoredPopover.tsx'
import {
  setViewportInsetSourceForTests,
  type WindowControlsOverlayLike,
} from '../src/client/viewport-inset.ts'

setupReactAct()

afterEach(() => {
  setViewportInsetSourceForTests(undefined)
  for (const el of document.querySelectorAll('body > div')) el.remove()
})

function overlayBand(height: number): WindowControlsOverlayLike {
  return {
    visible: true,
    getTitlebarAreaRect: () => ({ x: 0, y: 0, width: 1_000, height }),
    addEventListener: () => {},
    removeEventListener: () => {},
  }
}

/** A real button in the DOM, positioned so its bottom edge sits at `bottom`. */
function anchorAt(bottom: number): HTMLElement {
  const anchor = document.createElement('button')
  document.body.append(anchor)
  anchor.getBoundingClientRect = () => ({
    left: 100, top: bottom - 20, right: 200, bottom, width: 100, height: 20,
    x: 100, y: bottom - 20, toJSON: () => ({}),
  }) as DOMRect
  return anchor
}

function render(anchor: HTMLElement) {
  return renderRoot(createElement(AnchoredPopover, {
    anchor,
    onClose: () => {},
    children: createElement('div', null, 'node detail'),
  }))
}

/** The card's inline top (jsdom has no layout). */
function cardTop(): number {
  const card = document.querySelector('[role="dialog"]')
  if (card === null) throw new Error('no popover rendered')
  return Number.parseFloat((card as HTMLElement).style.top)
}

describe('AnchoredPopover and the native window-control band', () => {
  it('lifts the card below the band when the anchor sits inside it', () => {
    setViewportInsetSourceForTests(overlayBand(44))
    const { unmount } = render(anchorAt(20))
    // Without the band the card would open at 26, inside the native controls.
    expect(cardTop()).toBe(52)
    unmount()
  })

  it('keeps opening just below the anchor when there is no band', () => {
    const { unmount } = render(anchorAt(20))
    expect(cardTop()).toBe(26)
    unmount()
  })

  it('keeps the historical placement for an anchor at the very top', () => {
    // No band means no extra floor: 8 + rect.bottom, as before the band work.
    const { unmount } = render(anchorAt(0))
    expect(cardTop()).toBe(6)
    unmount()
  })
})
