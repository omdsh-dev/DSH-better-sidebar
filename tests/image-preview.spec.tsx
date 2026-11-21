/**
 * Built-in image viewer component spec: decode → fit, wheel zoom, the two
 * measurement tools, multiple annotations, clear, grid threshold and the
 * failure states. jsdom has no layout, so the stage rect is stubbed and pointer
 * events are plain MouseEvents (the same pattern `editor-host.spec.tsx` uses).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ImagePreview } from '../src/client/builtins/image-preview.tsx'
import type { FileViewerProps } from '../src/client/service.ts'

// React 18's act() needs this flag; the sibling component suites predate it
// and run with the warning, but a new suite should be quiet.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../src/client/api.ts', () => ({
  downloadUrl: () => 'download://a.png',
}))

/** The stage's stubbed content box: jsdom reports zeros otherwise. */
const STAGE = { left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0 }

let mounted: Array<{ root: Root; container: HTMLElement }> = []

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => { root.unmount() })
    container.remove()
  }
  mounted = []
  vi.unstubAllGlobals()
})

/** Mount the viewer with a stage and return the elements the tests drive. */
function mount(overrides: Partial<FileViewerProps> = {}): {
  container: HTMLElement
  stage: HTMLElement
} {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  act(() => {
    root.render(createElement(ImagePreview, {
      ctx: {} as never,
      store: {} as never,
      scope: { sessionId: 's1', cwd: '/ws' },
      path: '/ws/a.png',
      title: 'a.png',
      viewerId: 'image',
      mediaUrl: 'http://host.test/sidebar/file?a.png',
      ...overrides,
    } as FileViewerProps))
  })
  const stage = container.querySelector('[data-tool]')
  if (!(stage instanceof HTMLElement)) throw new Error('stage not rendered')
  stage.getBoundingClientRect = () => ({ ...STAGE, toJSON: () => STAGE }) as DOMRect
  return { container, stage }
}

/** Pretend the bitmap decoded and report its natural size. */
async function decode(container: HTMLElement, width: number, height: number): Promise<HTMLImageElement> {
  const img = container.querySelector('img')
  if (!(img instanceof HTMLImageElement)) throw new Error('image not rendered')
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: width })
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: height })
  await act(async () => { img.dispatchEvent(new Event('load')) })
  return img
}

/** Dispatch one pointer event (jsdom has no PointerEvent constructor in use). */
function pointer(stage: HTMLElement, type: string, clientX: number, clientY: number, button = 0): void {
  stage.dispatchEvent(new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    button,
  }))
}

/** Dispatch a contextmenu event and report whether the default was prevented. */
function contextMenu(stage: HTMLElement): boolean {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  stage.dispatchEvent(event)
  return event.defaultPrevented
}

/** Click a toolbar button by its accessible name. */
function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = container.querySelector(`button[aria-label="${label}"]`)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`button "${label}" missing`)
  return found
}

/** The text of every on-image label of one kind (`result` / `point`). */
function labelTexts(container: HTMLElement, kind: 'result' | 'point'): string[] {
  return Array.from(container.querySelectorAll(`[data-image-label="${kind}"]`), el => el.textContent ?? '')
}

/** Select a tool, then drag one measurement on the stage. */
function dragMeasure(
  container: HTMLElement,
  stage: HTMLElement,
  label: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
): void {
  act(() => { button(container, label).click() })
  act(() => {
    pointer(stage, 'pointerdown', from.x, from.y)
    pointer(stage, 'pointermove', to.x, to.y)
    pointer(stage, 'pointerup', to.x, to.y)
  })
}

/** Stub animation frames so a test ticks them by hand. */
function stubFrames(): Array<(time: number) => void> {
  const frames: Array<(time: number) => void> = []
  vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  return frames
}

describe('image viewer', () => {
  it('fits a decoded image, centers it and reports its size', async () => {
    const { container, stage } = mount()
    const img = await decode(container, 100, 50)
    // 100×50 at 100% in a 400×300 stage: centered at (150, 125). The bitmap
    // and the measurement geometry share this one scaled container.
    expect(img.parentElement?.style.transform).toBe('translate(150px, 125px) scale(1)')
    expect(img.style.imageRendering).toBe('pixelated')
    expect(container.textContent).toContain('100 × 50 px')
    expect(button(container, 'Actual pixels (100%)').textContent).toBe('100%')
    // The pointer over the top-left pixel updates the status bar.
    act(() => { pointer(stage, 'pointermove', 150, 125) })
    expect(container.textContent).toContain('0, 0')
  })

  it('zooms continuously around the cursor and never smooths the bitmap', async () => {
    const { container, stage } = mount()
    const img = await decode(container, 100, 50)
    // The geometry is in the bitmap's scaled container, so its stroke width is
    // compensated for the zoom: 3 / scale user units always render 3 px.
    const geometry = container.querySelector('[data-tool] svg')
    expect(geometry?.getAttribute('stroke-width')).toBe('3')
    act(() => {
      stage.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -300,
        clientX: 200,
        clientY: 150,
        bubbles: true,
        cancelable: true,
      }))
    })
    const transform = img.parentElement?.style.transform ?? ''
    const scale = Number(/scale\(([\d.]+)\)/u.exec(transform)?.[1])
    expect(scale).toBeGreaterThan(1)
    expect(Number(geometry?.getAttribute('stroke-width'))).toBeCloseTo(3 / scale, 5)
    act(() => { button(container, 'Fit to window').click() })
    expect(button(container, 'Actual pixels (100%)').textContent).toBe('100%')
    expect(img.style.imageRendering).toBe('pixelated')
  })

  it('draws a distance measurement as one red line with bare labels', async () => {
    const { container, stage } = mount()
    await decode(container, 5, 5)
    // A 5×5 image in a 400×300 stage sits at (197.5, 147.5).
    dragMeasure(container, stage, 'Two-axis distance',
      { x: 197.5, y: 147.5 }, { x: 197.5, y: 152.5 })
    expect(labelTexts(container, 'result')).toEqual(['5 px'])
    expect(labelTexts(container, 'point').sort()).toEqual(['(0,0)', '(0,4)'])
    // One line + two one-pixel calibration ticks; no dots, no halo.
    expect(container.querySelectorAll('[data-tool] svg line')).toHaveLength(3)
    expect(container.querySelectorAll('[data-tool] svg circle')).toHaveLength(0)
  })

  it('draws an area measurement with width and height beside their edges', async () => {
    const { container, stage } = mount()
    await decode(container, 5, 5)
    dragMeasure(container, stage, 'Measure area',
      { x: 197.5, y: 147.5 }, { x: 202.5, y: 152.5 })
    expect(labelTexts(container, 'result')).toEqual(['5 px', '5 px'])
    expect(labelTexts(container, 'point').sort()).toEqual(['(0,0)', '(4,4)'])
    // One outline with the faint wash the stylesheet paints inside it; no dots,
    // no halo. The wash cannot cover the pixel grid: the grid layer is a later
    // sibling of the scaled canvas (asserted in the grid test below).
    expect(container.querySelectorAll('[data-tool] svg rect')).toHaveLength(1)
    expect(container.querySelectorAll('[data-tool] svg circle')).toHaveLength(0)
  })

  it('names the covered pixel at both ends of a longer measurement', async () => {
    const { container, stage } = mount()
    await decode(container, 100, 100)
    // 100×100 at 100% sits at (150, 100); drag the full height.
    dragMeasure(container, stage, 'Two-axis distance',
      { x: 150, y: 100 }, { x: 150, y: 200 })
    expect(labelTexts(container, 'result')).toEqual(['100 px'])
    // Edge 0 → edge 100 covers rows 0–99.
    expect(labelTexts(container, 'point').sort()).toEqual(['(0,0)', '(0,99)'])
  })

  it('starts in distance mode so the first drag measures', async () => {
    const { container, stage } = mount()
    await decode(container, 5, 5)
    expect(stage.getAttribute('data-tool')).toBe('distance')
    expect(button(container, 'Pan').getAttribute('aria-pressed')).toBe('false')
    expect(button(container, 'Two-axis distance').getAttribute('aria-pressed')).toBe('true')
  })

  it('locks the single-axis tool to the dominant axis and measures that axis', async () => {
    const { container, stage } = mount()
    await decode(container, 5, 5)
    // Edge (0,0) → (3,2): |dx| wins, so the line is horizontal on row 0.
    dragMeasure(container, stage, 'Measure axis',
      { x: 197.5, y: 147.5 }, { x: 200.5, y: 149.5 })
    expect(labelTexts(container, 'result')).toEqual(['3 px'])
    expect(labelTexts(container, 'point').sort()).toEqual(['(0,0)', '(2,0)'])
    const horizontal = container.querySelector('[data-tool] svg line')
    expect(horizontal?.getAttribute('x2')).toBe('3')
    expect(horizontal?.getAttribute('y2')).toBe('0')

    // Edge (0,0) → (1,4): |dy| wins, so the line is vertical on column 0.
    act(() => { button(container, 'Clear measurements').click() })
    dragMeasure(container, stage, 'Measure axis',
      { x: 197.5, y: 147.5 }, { x: 198.5, y: 151.5 })
    expect(labelTexts(container, 'result')).toEqual(['4 px'])
    expect(labelTexts(container, 'point').sort()).toEqual(['(0,0)', '(0,3)'])
    const vertical = container.querySelector('[data-tool] svg line')
    expect(vertical?.getAttribute('x2')).toBe('0')
    expect(vertical?.getAttribute('y2')).toBe('4')
  })

  it('right-aligns the distance result so a long number grows away from the line', async () => {
    const { container, stage } = mount()
    await decode(container, 5, 5)
    // Vertical 5 px line at stage x=197.5: the value sits 24 px to its left,
    // with its right edge (the `px`) closest to the line.
    dragMeasure(container, stage, 'Two-axis distance',
      { x: 197.5, y: 147.5 }, { x: 197.5, y: 152.5 })
    const result = container.querySelector('[data-image-label="result"]') as HTMLElement
    expect(result.style.left).toBe('173.5px')
    expect(result.style.top).toBe('150px')
    expect(result.style.transform).toContain('-100% - 6px')

    // A horizontal line centers the whole `N px` above the line instead.
    act(() => { button(container, 'Clear measurements').click() })
    dragMeasure(container, stage, 'Two-axis distance',
      { x: 197.5, y: 147.5 }, { x: 202.5, y: 147.5 })
    const above = container.querySelector('[data-image-label="result"]') as HTMLElement
    expect(above.style.left).toBe('200px')
    expect(above.style.top).toBe('123.5px')
    expect(above.style.transform).toBe('translate(-50%, calc(-100% - 6px))')
  })

  it('opens the host image menu on a plain right click', async () => {
    const open = vi.fn()
    const { container, stage } = mount({
      ctx: { get: (id: string) => (id === 'contextMenus' ? { open } : undefined) } as never,
    })
    await decode(container, 5, 5)
    expect(contextMenu(stage)).toBe(true)
    expect(open).toHaveBeenCalledTimes(1)
    const [target, point] = open.mock.calls[0] as [{
      kind: string
      value: Record<string, unknown>
    }, { x: number; y: number }]
    expect(target.kind).toBe('image')
    expect(target.value).toMatchObject({
      sessionId: 's1',
      path: '/ws/a.png',
      url: 'http://host.test/sidebar/file?a.png',
      name: 'a.png',
      mediaType: 'image/png',
    })
    expect(point).toEqual({ x: 0, y: 0 })
  })

  it('places horizontal endpoint labels above the line, not on it', async () => {
    const { container, stage } = mount()
    await decode(container, 5, 5)
    dragMeasure(container, stage, 'Two-axis distance',
      { x: 197.5, y: 147.5 }, { x: 202.5, y: 147.5 })
    const points = Array.from(container.querySelectorAll('[data-image-label="point"]')) as HTMLElement[]
    const byText = new Map(points.map(el => [el.textContent, el]))
    const start = byText.get('(0,0)')!
    const end = byText.get('(4,0)')!
    // Upper-left / upper-right of the endpoints, so neither covers the line.
    expect(start.style.transform).toContain('-100% - 6px')
    expect(end.style.transform).toContain('6px')
    expect(start.style.left).toBe('197.5px')
    expect(start.style.top).toBe('147.5px')
    expect(end.style.left).toBe('202.5px')
    expect(end.style.top).toBe('147.5px')
  })

  it('pans on a right-button drag without measuring, and suppresses the menu', async () => {
    const open = vi.fn()
    const close = vi.fn()
    const { container, stage } = mount({
      ctx: { get: (id: string) => (id === 'contextMenus' ? { open, close } : undefined) } as never,
    })
    await decode(container, 100, 100)
    // Zoom past the stage so there is room to pan; the image is otherwise
    // clamped to the center and a drag could not move it.
    for (let step = 0; step < 8; step += 1) {
      act(() => { button(container, 'Zoom in').click() })
    }
    const transform = (): string => container.querySelector('img')?.parentElement?.style.transform ?? ''
    const before = transform()
    act(() => {
      pointer(stage, 'pointerdown', 100, 100, 2)
      pointer(stage, 'pointermove', 120, 130, 2)
      pointer(stage, 'pointerup', 120, 130, 2)
    })
    expect(labelTexts(container, 'result')).toHaveLength(0)
    expect(transform()).not.toBe(before)
    // The contextmenu that follows the drag is swallowed: no host menu opens.
    expect(contextMenu(stage)).toBe(true)
    expect(open).not.toHaveBeenCalled()
    // A menu left open by an earlier right click is dismissed by the drag.
    expect(close).toHaveBeenCalled()
  })

  it('lets a right click that never drags open the platform menu', async () => {
    const { container, stage } = mount()
    await decode(container, 100, 100)
    const before = container.querySelector('img')?.parentElement?.style.transform
    act(() => {
      pointer(stage, 'pointerdown', 200, 150, 2)
      // 2.2 px of travel is below the 4 px drag threshold.
      pointer(stage, 'pointermove', 202, 151, 2)
      pointer(stage, 'pointerup', 202, 151, 2)
    })
    expect(container.querySelector('img')?.parentElement?.style.transform).toBe(before)
    expect(contextMenu(stage)).toBe(false)
  })

  it('auto-scrolls while a measurement is dragged into an edge band', async () => {
    const frames = stubFrames()
    const { container, stage } = mount()
    const img = await decode(container, 800, 600)
    act(() => { button(container, 'Actual pixels (100%)').click() })
    const transform = (): string => img.parentElement?.style.transform ?? ''
    /** The pan offset, without the scale suffix. */
    const offsetX = (): number => Number(/translate\(([-\d.]+)px/.exec(transform())?.[1])
    expect(offsetX()).toBeCloseTo(-200, 6)

    act(() => {
      pointer(stage, 'pointerdown', 100, 100)
      pointer(stage, 'pointermove', 390, 100)
    })
    // Entering the right band queues exactly one frame.
    expect(frames.length).toBe(1)
    act(() => { frames.shift()?.(0) })
    expect(offsetX()).toBeCloseTo(-207, 6)
    // The draft and the status bar follow the scrolled view, not the pointer.
    expect(container.textContent).toContain('597, 250')
    // The loop keeps itself alive while the pointer stays in the band.
    expect(frames.length).toBe(1)
    act(() => { frames.shift()?.(0) })
    expect(offsetX()).toBeCloseTo(-214, 6)

    // Releasing stops the loop: the pending frame is cancelled and the view
    // no longer moves even if a stale callback runs late.
    act(() => { pointer(stage, 'pointerup', 390, 100) })
    expect(vi.mocked(cancelAnimationFrame)).toHaveBeenCalled()
    const afterRelease = transform()
    act(() => { frames.shift()?.(0) })
    expect(transform()).toBe(afterRelease)
    expect(container.textContent).toContain('304 px')
  })

  it('stops auto-scrolling at the overscroll boundary', async () => {
    const frames = stubFrames()
    const { container, stage } = mount()
    const img = await decode(container, 800, 600)
    act(() => { button(container, 'Actual pixels (100%)').click() })
    const transform = (): string => img.parentElement?.style.transform ?? ''
    const offsetX = (): number => Number(/translate\(([-\d.]+)px/.exec(transform())?.[1])
    act(() => {
      pointer(stage, 'pointerdown', 100, 100)
      pointer(stage, 'pointermove', 390, 100)
    })
    // The x overscroll limit is 400 - 800 - 25%×400 = -500.
    for (let frame = 0; frame < 100 && frames.length > 0; frame += 1) {
      act(() => { frames.shift()?.(0) })
    }
    expect(offsetX()).toBeCloseTo(-500, 6)
    // At the boundary no further frame is scheduled, so nothing spins.
    expect(frames.length).toBe(0)
  })

  it('refuses to start a measurement in the overscroll blank', async () => {
    const { container, stage } = mount()
    await decode(container, 800, 600)
    act(() => { button(container, 'Actual pixels (100%)').click() })
    // Push the picture to its bottom-right overscroll limit: image origin at
    // (100,75), leaving blank stage above and to its left.
    act(() => { button(container, 'Pan').click() })
    act(() => {
      pointer(stage, 'pointerdown', 200, 150)
      pointer(stage, 'pointermove', 600, 550)
      pointer(stage, 'pointerup', 600, 550)
    })
    const transform = container.querySelector('img')?.parentElement?.style.transform
    expect(transform).toBe('translate(100px, 75px) scale(1)')

    act(() => { button(container, 'Two-axis distance').click() })
    act(() => {
      pointer(stage, 'pointerdown', 50, 150)
      pointer(stage, 'pointermove', 200, 200)
      pointer(stage, 'pointerup', 200, 200)
    })
    expect(labelTexts(container, 'result')).toHaveLength(0)
    // A press back on the picture starts a measurement normally.
    act(() => {
      pointer(stage, 'pointerdown', 150, 150)
      pointer(stage, 'pointermove', 250, 250)
      pointer(stage, 'pointerup', 250, 250)
    })
    expect(labelTexts(container, 'result')).toHaveLength(1)
  })

  it('shows exactly one selected tool while a right-drag pans', async () => {
    const { container, stage } = mount()
    await decode(container, 100, 100)
    for (let step = 0; step < 8; step += 1) {
      act(() => { button(container, 'Zoom in').click() })
    }
    act(() => {
      pointer(stage, 'pointerdown', 100, 100, 2)
      pointer(stage, 'pointermove', 120, 130, 2)
    })
    // The temporary pan borrows the selection: the hand is the only pressed
    // tool, and the measurement tool reads unpressed.
    expect(button(container, 'Pan').getAttribute('aria-pressed')).toBe('true')
    expect(button(container, 'Two-axis distance').getAttribute('aria-pressed')).toBe('false')
    act(() => { pointer(stage, 'pointerup', 120, 130, 2) })
    expect(button(container, 'Pan').getAttribute('aria-pressed')).toBe('false')
    expect(button(container, 'Two-axis distance').getAttribute('aria-pressed')).toBe('true')
  })

  it('deletes only the measurement clicked with the erase tool', async () => {
    const { container, stage } = mount()
    await decode(container, 5, 5)
    // Two vertical 5 px lines, one on edge x=0 and one on edge x=3.
    dragMeasure(container, stage, 'Two-axis distance',
      { x: 197.5, y: 147.5 }, { x: 197.5, y: 152.5 })
    dragMeasure(container, stage, 'Two-axis distance',
      { x: 200.5, y: 147.5 }, { x: 200.5, y: 152.5 })
    expect(labelTexts(container, 'result')).toEqual(['5 px', '5 px'])

    act(() => { button(container, 'Delete measurement').click() })
    expect(button(container, 'Delete measurement').getAttribute('aria-pressed')).toBe('true')
    // Hovering the first line highlights it and marks the stage target.
    act(() => { pointer(stage, 'pointermove', 197.5, 150) })
    expect(stage.getAttribute('data-erase-hover')).toBe('true')
    expect(container.querySelector('[data-tool] svg g g')?.getAttribute('stroke-width')).toBe('6')

    act(() => {
      pointer(stage, 'pointerdown', 197.5, 150)
      pointer(stage, 'pointerup', 197.5, 150)
    })
    // Only the clicked line is gone; the one at edge x=3 survives.
    expect(labelTexts(container, 'result')).toEqual(['5 px'])
    expect(labelTexts(container, 'point').sort()).toEqual(['(3,0)', '(3,4)'])

    // Empty space is not a target: nothing else disappears.
    act(() => {
      pointer(stage, 'pointerdown', 250, 250)
      pointer(stage, 'pointerup', 250, 250)
    })
    expect(labelTexts(container, 'result')).toHaveLength(1)
  })

  it('keeps several measurements and clears them together', async () => {
    const { container, stage } = mount()
    await decode(container, 100, 100)
    dragMeasure(container, stage, 'Two-axis distance',
      { x: 150, y: 100 }, { x: 250, y: 100 })
    dragMeasure(container, stage, 'Two-axis distance',
      { x: 150, y: 120 }, { x: 200, y: 120 })
    expect(labelTexts(container, 'result')).toHaveLength(2)
    act(() => { button(container, 'Clear measurements').click() })
    expect(labelTexts(container, 'result')).toHaveLength(0)
  })

  it('shows the pixel grid from 600% up', async () => {
    const { container } = mount()
    await decode(container, 100, 100)
    expect(container.querySelector('[data-image-grid]')).toBeNull()
    // 1.25^10 ≈ 9.3×, past the 600% threshold. One act per click so each
    // render publishes the new scale to the next click's closure.
    for (let step = 0; step < 10; step += 1) {
      act(() => { button(container, 'Zoom in').click() })
    }
    const grid = container.querySelector('[data-image-grid]')
    expect(grid).not.toBeNull()
    // The grid layer must paint AFTER the scaled canvas that holds the area
    // tool's translucent wash, or the wash would tint the grid lines.
    const canvas = container.querySelector('[data-tool] svg')?.parentElement
    const stage = container.querySelector('[data-tool]')
    expect(canvas).not.toBeNull()
    expect(stage).not.toBeNull()
    expect(Array.from(stage!.children).indexOf(grid!)).toBeGreaterThan(
      Array.from(stage!.children).indexOf(canvas!),
    )
  })

  it('starts a fresh document when another file lands in the same tab', async () => {
    const { container, stage } = mount()
    await decode(container, 100, 100)
    dragMeasure(container, stage, 'Two-axis distance',
      { x: 150, y: 100 }, { x: 250, y: 100 })
    expect(labelTexts(container, 'result')).toHaveLength(1)
    act(() => {
      mounted[0]!.root.render(createElement(ImagePreview, {
        ctx: {} as never,
        store: {} as never,
        scope: { sessionId: 's1', cwd: '/ws' },
        path: '/ws/b.png',
        title: 'b.png',
        viewerId: 'image',
        mediaUrl: 'http://host.test/sidebar/file?b.png',
      } as FileViewerProps))
    })
    // The old bitmap's measurements must not survive onto the new image.
    expect(container.querySelectorAll('[data-image-label]')).toHaveLength(0)
    expect(container.querySelector('img')?.getAttribute('src')).toContain('b.png')
    expect(container.textContent).toContain('Loading')
  })

  it('shows the download escape hatch when the image cannot load', async () => {
    const { container } = mount({ mediaUrl: undefined })
    expect(container.textContent).toContain('Unable to load image')
    expect(container.textContent).toContain('Download')
    expect(container.querySelector('img')).toBeNull()
  })

  it('reports a decode failure after the element was mounted', async () => {
    const { container } = mount()
    const img = await decode(container, 10, 10)
    await act(async () => { img.dispatchEvent(new Event('error')) })
    expect(container.textContent).toContain('Unable to load image')
  })
})
