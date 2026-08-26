/**
 * TerminalBlockOverlay tests: the visual block layer must draw one divider
 * per CLI block, highlight the hovered block's span, raise the per-block
 * "add to conversation" pill at the hovered row, and commit the RIGHT block
 * through onAddBlock. Geometry is injected by mocking getBoundingClientRect
 * on the host/screen elements; rAF is queued and flushed deterministically.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TerminalBlockTracker, type TerminalBlockMarker } from '../src/client/terminal-blocks.ts'
import { TerminalBlockOverlay } from '../src/client/TerminalBlockOverlay.tsx'
import css from '../src/client/sidebar.module.css'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

/** The viewport: rows 10..29 of a 30-row buffer, cell height 18px. */
const ROWS = 20
const VIEWPORT_Y = 10
const BUFFER_LENGTH = 30
const CELL_HEIGHT = 18
const SCREEN_LEFT = 8
const SCREEN_TOP = 6
const HOST_WIDTH = 600
const HOST_HEIGHT = 400

const frames: FrameRequestCallback[] = []
function installStubs(): void {
  frames.length = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  })
}

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

/** A real-ish screen plus a rectangle mock on host + screen. */
async function mountOverlay(
  tracker: TerminalBlockTracker,
  onAddBlock = vi.fn(),
): Promise<{ host: HTMLElement; clickPill: () => void }> {
  const hostRef = createRef<HTMLDivElement>()
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const term = {
    rows: ROWS,
    onScroll: () => ({ dispose: vi.fn() }),
    onWriteParsed: () => ({ dispose: vi.fn() }),
    onResize: () => ({ dispose: vi.fn() }),
    hasSelection: () => false,
    buffer: {
      active: {
        type: 'normal' as const,
        viewportY: VIEWPORT_Y,
        length: BUFFER_LENGTH,
        getLine: () => undefined,
      },
    },
  }
  await act(async () => {
    root.render(createElement('div', { ref: hostRef as never }, createElement(TerminalBlockOverlay, {
      hostRef: hostRef as never,
      term: term as never,
      tracker,
      visible: true,
      onAddBlock,
    } as never)))
  })
  const host = hostRef.current!
  // The terminal's DOM the renderer would have produced.
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  host.append(screen)
  const rectOf = (left: number, top: number, width: number, height: number): DOMRect =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(rectOf(0, 0, HOST_WIDTH, HOST_HEIGHT))
  vi.spyOn(screen, 'getBoundingClientRect').mockReturnValue(rectOf(SCREEN_LEFT, SCREEN_TOP, HOST_WIDTH - SCREEN_LEFT, ROWS * CELL_HEIGHT))
  return {
    host,
    clickPill: () => {
      host.querySelector<HTMLElement>(`.${css.terminalBlockPill}`)?.click()
    },
  }
}

async function flushFrames(): Promise<void> {
  await act(async () => {
    while (frames.length > 0) {
      const callbacks = frames.splice(0)
      for (const frame of callbacks) frame(0)
    }
  })
}

/** Dispatch a mousemove at the vertical center of a buffer row. */
async function moveToRow(host: HTMLElement, row: number): Promise<void> {
  await act(async () => {
    host.dispatchEvent(new MouseEvent('mousemove', {
      clientY: SCREEN_TOP + (row - VIEWPORT_Y) * CELL_HEIGHT + CELL_HEIGHT / 2,
      bubbles: true,
    }))
  })
}

/** Two blocks: `ls` spans rows 12..18, `pwd` spans 18..30 (open tail). */
function twoBlockTracker(): { tracker: TerminalBlockTracker; markers: TerminalBlockMarker[] } {
  const markers: TerminalBlockMarker[] = []
  const tracker = new TerminalBlockTracker((block) => {
    const marker: TerminalBlockMarker = { line: block.startRow, isDisposed: false, dispose: vi.fn() }
    markers.push(marker)
    block.marker = marker
  })
  tracker.onData('ls\r', 13) // echo row 12
  tracker.onData('pwd\r', 19) // echo row 18
  return { tracker, markers }
}

describe('TerminalBlockOverlay', () => {
  it('draws one divider per visible block', async () => {
    installStubs()
    const { tracker } = twoBlockTracker()
    const { host } = await mountOverlay(tracker)
    await flushFrames()
    expect(host.querySelectorAll(`.${css.terminalBlockDivider}`)).toHaveLength(2)
  })

  it('highlights the hovered block and raises the pill; clicking commits THAT block', async () => {
    installStubs()
    const { tracker } = twoBlockTracker()
    const onAddBlock = vi.fn()
    const { host, clickPill } = await mountOverlay(tracker, onAddBlock)
    await flushFrames()

    // Row 15 belongs to the FIRST block (`ls` 12..18).
    await moveToRow(host, 15)
    await flushFrames()
    expect(host.querySelector(`.${css.terminalBlockHover}`)).not.toBeNull()
    expect(host.querySelector(`.${css.terminalBlockPill}`)).not.toBeNull()
    clickPill()
    expect(onAddBlock).toHaveBeenCalledTimes(1)
    expect(onAddBlock.mock.calls[0]![0].command).toBe('ls')

    // A row above both blocks (11 — the pre-block prompt region) shows
    // neither highlight nor pill.
    await moveToRow(host, 11)
    await flushFrames()
    expect(host.querySelector(`.${css.terminalBlockHover}`)).toBeNull()
    expect(host.querySelector(`.${css.terminalBlockPill}`)).toBeNull()

    // The second block's row commits the second block.
    await moveToRow(host, 20)
    await flushFrames()
    clickPill()
    expect(onAddBlock).toHaveBeenCalledTimes(2)
    expect(onAddBlock.mock.calls[1]![0].command).toBe('pwd')
  })

  it('mouseleave clears the hover state', async () => {
    installStubs()
    const { tracker } = twoBlockTracker()
    const { host } = await mountOverlay(tracker)
    await flushFrames()
    await moveToRow(host, 15)
    await flushFrames()
    expect(host.querySelector(`.${css.terminalBlockPill}`)).not.toBeNull()
    host.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))
    await flushFrames()
    expect(host.querySelector(`.${css.terminalBlockPill}`)).toBeNull()
  })

  it('renders nothing without a mounted host or while !visible', async () => {
    installStubs()
    const { tracker } = twoBlockTracker()
    const hostRef = createRef<HTMLDivElement>()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const term = {
      rows: ROWS,
      onScroll: () => ({ dispose: vi.fn() }),
      onWriteParsed: () => ({ dispose: vi.fn() }),
      onResize: () => ({ dispose: vi.fn() }),
      hasSelection: () => false,
      buffer: { active: { type: 'normal' as const, viewportY: VIEWPORT_Y, length: BUFFER_LENGTH, getLine: () => undefined } },
    }
    await act(async () => {
      root.render(createElement('div', { ref: hostRef as never }, createElement(TerminalBlockOverlay, {
        hostRef: hostRef as never,
        term: term as never,
        tracker,
        visible: false,
        onAddBlock: vi.fn(),
      } as never)))
    })
    expect(hostRef.current!.querySelector(`.${css.terminalBlockLayer}`)).toBeNull()
    await act(async () => { root.unmount() })
  })
})