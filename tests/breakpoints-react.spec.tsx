// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useViewportSize } from '../src/client/breakpoints.ts'

describe('useViewportSize', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('publishes height-only resizes without requiring a breakpoint change', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })

    const observed: string[] = []
    function Probe(): null {
      const size = useViewportSize()
      observed.push(`${size.width}x${size.height}`)
      return null
    }

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(<Probe />) })

    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 })
    window.dispatchEvent(new Event('resize'))
    await act(async () => { frames.shift()?.(0) })

    expect(observed.at(-1)).toBe('1280x600')
    await act(async () => { root.unmount() })
  })
})
