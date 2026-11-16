// @vitest-environment jsdom
/**
 * Selection tasks: where the captured selection/thread opens, and how a
 * selection instruction reaches a new thread's composer.
 *
 * The opener is responsive, but the captured session/thread is not: below the
 * 768px breakpoint it parks the thread for the real sidechat tab and asks the
 * sidebar to open that tab; at and above 768px it opens a floating,
 * non-dockable window whose content is the real selection sidechat component.
 * The window host keeps one instance per thread identity.
 *
 * A seeded draft is local state (the real `useSidechatDraft` hook restores
 * it): seeding must never send a sidechat prompt or perform an RPC. The
 * plugin's `sidechat.prompt` is a fetch-backed api.call, so a fetch spy covers
 * both paths.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { consumeSidechatSeed } from '../src/client/SideChatView.tsx'
import { t } from '../src/client/locales.ts'
import { openSelectionSidechat } from '../src/client/selection-sidechat.tsx'
import {
  clearSavedSidechatDrafts,
  seedSidechatDraft,
  useSidechatDraft,
} from '../src/client/sidechat-draft.ts'
import { createWindowHost } from '../src/client/windows/host.ts'
import type { WindowHandle, WindowOpenOptions } from '../src/client/windows/types.ts'
import type { Context } from '../src/context-types.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'

setupReactAct()

const WIDE_WIDTH = 1_440
const DEFAULT_WIDTH = 1_024

/** The opener reads `window.innerWidth` directly; jsdom lets us set it. */
function setWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
}

/** The one service face the opener reads, behind a minimal Context. */
function contextOf(service: unknown): Context {
  return {
    get: (name: string) => (name === 'betterSidebar' ? service : undefined),
  } as unknown as Context
}

/** A `windows.open` recorder whose handle is never used by the opener. */
function openRecorder() {
  return vi.fn((_options: WindowOpenOptions) => ({} as WindowHandle))
}

afterEach(() => {
  consumeSidechatSeed()
  clearSavedSidechatDrafts()
  vi.unstubAllGlobals()
  setWidth(DEFAULT_WIDTH)
})

describe('openSelectionSidechat', () => {
  it('parks the thread and opens the real sidechat tab below the breakpoint', () => {
    setWidth(767)
    const seeds: Array<string | undefined> = []
    // The real service's createTab consumes the parked id synchronously; the
    // fake makes that handoff observable.
    const openTab = vi.fn(() => { seeds.push(consumeSidechatSeed()) })
    const open = openRecorder()
    const ctx = contextOf({ openTab, windows: { open } })

    openSelectionSidechat(ctx, 'session-1', 'thread-1')

    expect(openTab).toHaveBeenCalledTimes(1)
    expect(openTab).toHaveBeenCalledWith({ type: 'sidechat' }, { sessionId: 'session-1' })
    expect(seeds).toEqual(['thread-1'])
    expect(open).not.toHaveBeenCalled()
    // Exactly one consumer per park: the next open mints a fresh thread.
    expect(consumeSidechatSeed()).toBeUndefined()
  })

  it.each([768, WIDE_WIDTH])('opens a floating, non-dockable window at %i px', width => {
    setWidth(width)
    const openTab = vi.fn()
    const open = openRecorder()
    const ctx = contextOf({ openTab, windows: { open } })

    openSelectionSidechat(ctx, 'session-1', 'thread-1')

    expect(openTab).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledTimes(1)
    const options = open.mock.calls[0]?.[0]
    if (options === undefined) throw new Error('windows.open was not called')
    expect(options).toMatchObject({
      id: 'selection-side:thread-1',
      sessionId: 'session-1',
      title: t('sideChat'),
      size: 'document',
      surface: 'floating',
      dockable: false,
      bodyLayout: 'fill',
    })
    expect(isValidElement(options.content)).toBe(true)
    const content = options.content as ReactElement<{
      ctx: Context
      sessionId: string
      threadId: string
      handle: () => WindowHandle
    }>
    expect(typeof content.type).toBe('function')
    expect(content.props.ctx).toBe(ctx)
    expect(content.props.sessionId).toBe('session-1')
    expect(content.props.threadId).toBe('thread-1')
    expect(typeof content.props.handle).toBe('function')
  })

  it('uses a distinct window identity and captured thread for each thread', () => {
    setWidth(WIDE_WIDTH)
    const open = openRecorder()
    const ctx = contextOf({ openTab: vi.fn(), windows: { open } })

    openSelectionSidechat(ctx, 'session-1', 'thread-a')
    openSelectionSidechat(ctx, 'session-1', 'thread-b')

    const first = open.mock.calls[0]?.[0]
    const second = open.mock.calls[1]?.[0]
    expect(first?.id).toBe('selection-side:thread-a')
    expect(second?.id).toBe('selection-side:thread-b')
    expect(first?.id).not.toBe(second?.id)
    expect(first?.sessionId).toBe('session-1')
    expect(second?.sessionId).toBe('session-1')
  })

  it('keeps one real host window when the same thread is opened twice', () => {
    setWidth(WIDE_WIDTH)
    const host = createWindowHost({ viewport: () => ({ width: WIDE_WIDTH, height: 900 }) })
    try {
      const open = vi.fn(host.open)
      const ctx = contextOf({ openTab: vi.fn(), windows: { open } })

      openSelectionSidechat(ctx, 'session-1', 'thread-1')
      openSelectionSidechat(ctx, 'session-1', 'thread-1')

      expect(open).toHaveBeenCalledTimes(2)
      const windows = host.getSnapshot().windows
      expect(windows).toHaveLength(1)
      expect(windows[0]).toMatchObject({
        id: 'selection-side:thread-1',
        sessionId: 'session-1',
        canDock: false,
      })
      // Identity wins: the second open focuses the live instance and keeps
      // its content instead of replacing it.
      expect(windows[0]?.content).toBe(open.mock.calls[0]?.[0]?.content)
      expect(open.mock.results[1]?.value).toBe(open.mock.results[0]?.value)
    } finally {
      host.dispose()
    }
  })
})

type DraftApi = ReturnType<typeof useSidechatDraft>

/** Mounts the real draft hook for one thread and exposes its live API. */
function DraftProbe(props: { threadId: string; sink: { api?: DraftApi } }): ReactNode {
  props.sink.api = useSidechatDraft(props.threadId)
  return null
}

describe('seedSidechatDraft', () => {
  it('fills the real hook without sending a sidechat prompt or issuing a fetch', () => {
    const fetchMock = vi.fn(() => { throw new Error('seeding must not perform an RPC') })
    vi.stubGlobal('fetch', fetchMock)
    const sink: { api?: DraftApi } = {}
    seedSidechatDraft('thread-seeded', 'Half-written selection instruction')

    const view = renderRoot(createElement(DraftProbe, { threadId: 'thread-seeded', sink }))
    try {
      expect(sink.api?.owner.text).toBe('Half-written selection instruction')
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      view.unmount()
    }
  })
})
