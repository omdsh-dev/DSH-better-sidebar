/**
 * The image viewer's zoom/pan surface.
 *
 * jsdom has no layout engine, so the tests stub exactly the four numbers the
 * viewer reads off the DOM (`offsetWidth`/`offsetHeight` on the image and the
 * stage) and drive the rest through real events: a non-passive `wheel` on the
 * stage, pointer events for the drag, and the toolbar's buttons. That keeps
 * the assertions on observable behaviour — the inline transform, the readout,
 * and whether the wheel's default was prevented — rather than on internals.
 *
 * The pure maths (`zoomedTransform` / `clampPan` / `clampZoom`) is covered
 * directly as well, so a regression names the helper that broke, not just the
 * component.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ImageView, clampPan, clampZoom, zoomedTransform } from '../src/client/ImageView.tsx'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

interface Mounted {
  host: HTMLDivElement
  stage: HTMLDivElement
  img: HTMLImageElement
  readout: HTMLElement
  unmount: () => void
}

interface MountedView extends Mounted {
  zoom: () => number
  offsets: () => { x: number; y: number }
  transform: () => string
}

/**
 * Mount the viewer with a stubbed layout: the picture is `image` CSS pixels,
 * the stage is `stage` CSS pixels. Returns the nodes plus a `zoom` reader.
 */
function mount(image = { width: 400, height: 300 }, stage = { width: 400, height: 300 }): MountedView {
  const host = document.createElement('div')
  document.body.appendChild(host)
  let root: Root | undefined
  act(() => {
    root = createRoot(host)
    root.render(createElement(ImageView, { mediaUrl: '/sidebar/file?path=x.png', title: 'x.png' }))
  })
  const stageEl = host.querySelector('[role="group"]') as HTMLDivElement
  const img = host.querySelector('img') as HTMLImageElement
  const readout = host.querySelector('[data-image-zoom-readout]') as HTMLElement
  for (const [node, size] of [[img, image], [stageEl, stage]] as const) {
    Object.defineProperty(node, 'offsetWidth', { value: size.width, configurable: true })
    Object.defineProperty(node, 'offsetHeight', { value: size.height, configurable: true })
    // The wheel/double-click anchors are stage-relative, which the viewer
    // derives from the stage's rect origin (jsdom reports a zeroed rect).
    node.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: size.width, bottom: size.height,
      width: size.width, height: size.height, toJSON: () => ({}),
    }) as DOMRect
  }
  // The image is "loaded": apply() is what writes the first transform.
  act(() => { img.dispatchEvent(new Event('load')) })
  /** The numeric translate offsets, so float noise does not fail a strictly
   *  correct transform (1.1 * 400 - 200 / 2 = 120.00000000000003). */
  const offsets = (): { x: number; y: number } => {
    const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(img.style.transform)
    if (match === null) throw new Error(`no translate in ${img.style.transform}`)
    return { x: Number(match[1]), y: Number(match[2]) }
  }
  return {
    host,
    stage: stageEl,
    img,
    readout,
    zoom: () => Number(img.dataset.imageZoom ?? 'NaN'),
    offsets,
    transform: () => img.style.transform,
    unmount: () => {
      act(() => { root?.unmount() })
      host.remove()
    },
  }
}

/** One wheel notch: `deltaY < 0` zooms in, at `at` in stage coordinates. */
function wheel(stage: HTMLElement, deltaY: number, at?: { x: number; y: number }): boolean {
  const event = new WheelEvent('wheel', {
    deltaY,
    clientX: at?.x ?? 0,
    clientY: at?.y ?? 0,
    bubbles: true,
    cancelable: true,
  })
  act(() => { stage.dispatchEvent(event) })
  return event.defaultPrevented
}

function drag(stage: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }): void {
  act(() => {
    stage.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, button: 0, clientX: from.x, clientY: from.y, bubbles: true }))
    stage.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: to.x, clientY: to.y, bubbles: true }))
    stage.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: to.x, clientY: to.y, bubbles: true }))
  })
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('the pure zoom maths', () => {
  it('clamps zoom into [min, max] and rejects non-finite input', () => {
    // (value, min, max) — a non-finite value falls back to the floor, so a
    // broken rect or a divide-by-zero can never leave the picture invisible.
    expect(clampZoom(0.1, 1, 16)).toBe(1)
    expect(clampZoom(99, 1, 16)).toBe(16)
    expect(clampZoom(2.5, 1, 16)).toBe(2.5)
    expect(clampZoom(Number.NaN, 1, 16)).toBe(1)
    // Infinity is not finite either, so it takes the same floor: a degenerate
    // ratio leaves the picture at fit rather than at the ceiling.
    expect(clampZoom(Number.POSITIVE_INFINITY, 1, 16)).toBe(1)
  })

  it('keeps the anchored point stationary across a scale step', () => {
    // Anchor (150, 100) in a 200x200 stage whose centre is (100, 100): the
    // offset from the centre must shrink by exactly the scale ratio.
    const next = zoomedTransform({ zoom: 1, tx: 0, ty: 0 }, 2, { x: 150, y: 100 }, 200, 200)
    expect(next.zoom).toBe(2)
    expect(next.tx).toBe(-50)
    expect(next.ty).toBe(0)
    // The anchored point in content coordinates is unchanged: it sits at
    // centre + (anchor - centre - tx) / zoom before and after.
    const before = (150 - 100 - 0) / 1
    const after = (150 - 100 - next.tx) / next.zoom
    expect(after).toBe(before)
  })

  it('allows no panning while the picture fits, and bounds it by the overflow once it does not', () => {
    // 400x300 in a 400x300 stage: exactly fit, no slack in either axis.
    expect(clampPan(1, 40, -40, 400, 300, 400, 300)).toEqual({ tx: 0, ty: 0 })
    // 400x300 at zoom 2 = 800x600 in a 400x300 stage: 200px / 150px of slack.
    expect(clampPan(2, 999, -999, 400, 300, 400, 300)).toEqual({ tx: 200, ty: -150 })
    expect(clampPan(2, 50, -50, 400, 300, 400, 300)).toEqual({ tx: 50, ty: -50 })
    // One axis larger than the stage, the other smaller: only the larger pans.
    expect(clampPan(2, 999, 999, 400, 100, 400, 300)).toEqual({ tx: 200, ty: 0 })
  })
})

describe('ImageView', () => {
  it('starts at fit and zooms in around the cursor on wheel-up, preventing the default', () => {
    const view = mount()
    expect(view.zoom()).toBe(1)
    expect(view.readout.textContent).toBe('100%')
    expect(view.transform()).toContain('scale(1)')

    const prevented = wheel(view.stage, -100, { x: 250, y: 150 })
    expect(prevented, 'the pane must not scroll while the wheel zooms the picture').toBe(true)
    expect(view.zoom()).toBeCloseTo(1.1, 5)
    expect(view.readout.textContent).toBe('110%')
    // Anchor (250,150) in a 400x300 stage: centre (200,150), so the anchor sits
    // 50px right of centre and must stay there across the 1.1 step.
    expect(view.offsets().x).toBeCloseTo(-5, 6)
    expect(view.offsets().y).toBeCloseTo(0, 6)
    expect(view.transform()).toContain('scale(1.1)')
    view.unmount()
  })

  it('never zooms below fit, and stops at the ceiling', () => {
    const view = mount()
    for (let i = 0; i < 12; i += 1) wheel(view.stage, 120, { x: 200, y: 150 })
    expect(view.zoom(), 'zoom-out floor is the fit scale').toBe(1)
    expect(view.readout.textContent).toBe('100%')

    for (let i = 0; i < 80; i += 1) wheel(view.stage, -120, { x: 200, y: 150 })
    expect(view.zoom()).toBe(16)
    expect(view.readout.textContent).toBe('1600%')
    view.unmount()
  })

  it('pans with a pointer drag, clamped so the picture cannot leave the stage', () => {
    const view = mount()
    wheel(view.stage, -100, { x: 100, y: 100 })
    expect(view.stage.dataset.imageDragging, 'no drag in flight').toBeUndefined()

    drag(view.stage, { x: 200, y: 150 }, { x: 10_000, y: 10_000 })
    // The fit box is 400x300 and the zoom is 1.1, so the visible slack is
    // (400*1.1 - 400)/2 = 20 horizontally and (300*1.1 - 300)/2 = 15
    // vertically. A picture cannot be dragged past its own edge — the old
    // bound (its 400x300 layout box in a 200x200 stage) let it.
    expect(view.offsets().x).toBeCloseTo(20, 6)
    expect(view.offsets().y).toBeCloseTo(15, 6)
    expect(view.stage.dataset.imageDragging, 'the drag marker is cleared on pointerup').toBeUndefined()

    // Zooming all the way out lands on fit, where the picture exactly fills its
    // box: there is no slack left in either axis.
    for (let i = 0; i < 12; i += 1) wheel(view.stage, 120, { x: 200, y: 150 })
    expect(view.zoom()).toBe(1)
    drag(view.stage, { x: 200, y: 150 }, { x: 900, y: 900 })
    expect(view.offsets()).toEqual({ x: 0, y: 0 })
    expect(view.transform()).toContain('scale(1)')
    view.unmount()
  })

  it('toggles fit ↔ 2× on a double click', () => {
    const view = mount()
    act(() => {
      view.stage.dispatchEvent(new MouseEvent('dblclick', { clientX: 200, clientY: 150, bubbles: true }))
    })
    expect(view.zoom()).toBe(2)
    act(() => {
      view.stage.dispatchEvent(new MouseEvent('dblclick', { clientX: 200, clientY: 150, bubbles: true }))
    })
    expect(view.zoom()).toBe(1)
    expect(view.offsets()).toEqual({ x: 0, y: 0 })
    expect(view.transform()).toContain('scale(1)')
    view.unmount()
  })

  it('answers the toolbar buttons and the keyboard', () => {
    const view = mount()
    const buttons = Array.from(view.host.querySelectorAll('button'))
    expect(buttons, 'zoom out, zoom in, reset').toHaveLength(3)
    const [zoomOut, zoomIn, reset] = buttons as [HTMLButtonElement, HTMLButtonElement, HTMLButtonElement]
    act(() => { zoomIn.click() })
    expect(view.readout.textContent).toBe('110%')
    act(() => { zoomIn.click() })
    expect(view.readout.textContent).toBe('121%')
    act(() => { zoomOut.click() })
    expect(view.readout.textContent).toBe('110%')

    act(() => { view.stage.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true })) })
    expect(view.readout.textContent).toBe('100%')
    act(() => { view.stage.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true })) })
    expect(view.zoom()).toBeCloseTo(1.2, 5)
    act(() => { view.stage.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true })) })
    expect(view.zoom()).toBeCloseTo(1, 5)
    act(() => { reset.click() })
    expect(view.offsets()).toEqual({ x: 0, y: 0 })
    expect(view.transform()).toContain('scale(1)')
    view.unmount()
  })

  it('renders the picture inside the stage, with the pane able to shrink', () => {
    const view = mount()
    expect(view.img.getAttribute('src')).toBe('/sidebar/file?path=x.png')
    expect(view.img.getAttribute('alt')).toBe('x.png')
    expect(view.img.draggable).toBe(false)
    expect(view.img.parentElement).toBe(view.stage)
    view.unmount()
  })
})
