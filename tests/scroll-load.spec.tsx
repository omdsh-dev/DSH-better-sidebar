/**
 * useScrollLoad — end-sentinel pagination for a scroll box.
 *
 * Contract pinned here:
 * - no observer, no scroll listener and no request while `enabled` is false;
 * - the sentinel observer is rooted at the scroll element with a 100px margin;
 * - a scroll event is the fallback path (and works when IntersectionObserver
 *   is unavailable);
 * - `loading` suppresses callbacks until the owner clears it, but the hook
 *   keeps no latch of its own: after the clear it is free to fire again;
 * - `hasMore: false` (the owner's error/exhausted signal) stops everything;
 * - `version` recreates the observer so a new page re-arms the sentinel;
 * - disabling and unmounting disconnect the observer and remove the listener.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createElement, useRef } from 'react'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'
import { useScrollLoad } from '../src/client/ui/use-scroll-load.ts'

setupReactAct()

/** What the hook harness receives; the spy is the owner's load request. */
interface HarnessProps {
  enabled: boolean
  hasMore: boolean
  loading: boolean
  version?: string | number
  onLoad(): void
}

/** Mount the hook on a real scroll box + sentinel pair. */
function Harness(props: HarnessProps): ReturnType<typeof createElement> {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useScrollLoad({
    scrollRef,
    sentinelRef,
    enabled: props.enabled,
    hasMore: props.hasMore,
    loading: props.loading,
    onLoad: props.onLoad,
    ...(props.version === undefined ? {} : { version: props.version }),
  })
  return createElement(
    'div',
    { ref: scrollRef, 'data-scroll': 'true' },
    createElement('div', { style: { height: '1000px' } }),
    createElement('div', { ref: sentinelRef, 'data-sentinel': 'true' }),
  )
}

interface FakeObserver {
  callback: IntersectionObserverCallback
  options?: IntersectionObserverInit
  targets: Element[]
  disconnected: boolean
}

/** jsdom ships no IntersectionObserver; install a controllable stand-in. */
function installObserver(): { observers: FakeObserver[]; restore(): void } {
  const original = (globalThis as Record<string, unknown>).IntersectionObserver
  const observers: FakeObserver[] = []
  class FakeIntersectionObserver implements FakeObserver {
    readonly targets: Element[] = []
    disconnected = false
    constructor(
      public callback: IntersectionObserverCallback,
      public options?: IntersectionObserverInit,
    ) {
      observers.push(this)
    }
    observe(target: Element): void { this.targets.push(target) }
    unobserve(): void {}
    disconnect(): void { this.disconnected = true }
    takeRecords(): IntersectionObserverEntry[] { return [] }
  }
  ;(globalThis as Record<string, unknown>).IntersectionObserver = FakeIntersectionObserver
  return {
    observers,
    restore: () => {
      if (original === undefined) delete (globalThis as Record<string, unknown>).IntersectionObserver
      else (globalThis as Record<string, unknown>).IntersectionObserver = original
    },
  }
}

/** Deliver one intersection callback the way the browser would. */
function intersect(observer: FakeObserver): void {
  act(() => {
    observer.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      observer as unknown as IntersectionObserver,
    )
  })
}

function scrollBox(view: RenderedRoot): HTMLElement {
  return view.container.querySelector<HTMLElement>('[data-scroll]')!
}

function fireScroll(view: RenderedRoot): void {
  act(() => { scrollBox(view).dispatchEvent(new Event('scroll')) })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useScrollLoad', () => {
  it('observes only while enabled and uses the box root with a 100px margin', () => {
    const io = installObserver()
    const onLoad = vi.fn()
    const view = renderRoot(createElement(Harness, { enabled: false, hasMore: true, loading: false, onLoad }))
    try {
      expect(io.observers).toHaveLength(0)
      fireScroll(view)
      expect(onLoad).not.toHaveBeenCalled()

      view.rerender(createElement(Harness, { enabled: true, hasMore: true, loading: false, onLoad }))
      expect(io.observers).toHaveLength(1)
      const observer = io.observers[0]!
      expect(observer.targets).toEqual([view.container.querySelector('[data-sentinel]')])
      expect(observer.options?.root).toBe(scrollBox(view))
      expect(observer.options?.rootMargin).toBe('100px')

      intersect(observer)
      expect(onLoad).toHaveBeenCalledTimes(1)
    } finally {
      view.unmount()
      io.restore()
    }
  })

  it('disconnects on disable and on unmount', () => {
    const io = installObserver()
    const onLoad = vi.fn()
    const view = renderRoot(createElement(Harness, { enabled: true, hasMore: true, loading: false, onLoad }))
    try {
      const first = io.observers[0]!
      view.rerender(createElement(Harness, { enabled: false, hasMore: true, loading: false, onLoad }))
      expect(first.disconnected).toBe(true)
      intersect(first)
      fireScroll(view)
      expect(onLoad).not.toHaveBeenCalled()

      view.rerender(createElement(Harness, { enabled: true, hasMore: true, loading: false, onLoad }))
      expect(io.observers).toHaveLength(2)
      const second = io.observers[1]!
      const detachedBox = scrollBox(view)
      view.unmount()
      expect(second.disconnected).toBe(true)
      act(() => { detachedBox.dispatchEvent(new Event('scroll')) })
      expect(onLoad).not.toHaveBeenCalled()
    } finally {
      io.restore()
    }
  })

  it('suppresses callbacks while loading and re-arms once it clears', () => {
    const io = installObserver()
    const onLoad = vi.fn()
    const view = renderRoot(createElement(Harness, { enabled: true, hasMore: true, loading: true, onLoad }))
    try {
      const whileLoading = io.observers[0]!
      intersect(whileLoading)
      fireScroll(view)
      expect(onLoad).not.toHaveBeenCalled()

      view.rerender(createElement(Harness, { enabled: true, hasMore: true, loading: false, onLoad }))
      expect(whileLoading.disconnected).toBe(true)
      expect(io.observers).toHaveLength(2)
      const rearmed = io.observers[1]!
      intersect(rearmed)
      expect(onLoad).toHaveBeenCalledTimes(1)
      // No permanent latch: the owner is the only authority on duplicate
      // requests, so a second observation is allowed to ask again.
      intersect(rearmed)
      expect(onLoad).toHaveBeenCalledTimes(2)
    } finally {
      view.unmount()
      io.restore()
    }
  })

  it('fires from the scroll fallback and stops when hasMore is false', () => {
    // No IntersectionObserver at all: the scroll listener is the only path.
    const original = (globalThis as Record<string, unknown>).IntersectionObserver
    delete (globalThis as Record<string, unknown>).IntersectionObserver
    const onLoad = vi.fn()
    const view = renderRoot(createElement(Harness, { enabled: true, hasMore: true, loading: false, onLoad }))
    try {
      expect(onLoad).not.toHaveBeenCalled()
      fireScroll(view)
      expect(onLoad).toHaveBeenCalledTimes(1)

      // The owner's exhausted/error signal removes the listener entirely.
      view.rerender(createElement(Harness, { enabled: true, hasMore: false, loading: false, onLoad }))
      fireScroll(view)
      expect(onLoad).toHaveBeenCalledTimes(1)

      view.rerender(createElement(Harness, { enabled: true, hasMore: true, loading: false, onLoad }))
      fireScroll(view)
      expect(onLoad).toHaveBeenCalledTimes(2)
    } finally {
      view.unmount()
      if (original === undefined) delete (globalThis as Record<string, unknown>).IntersectionObserver
      else (globalThis as Record<string, unknown>).IntersectionObserver = original
    }
  })

  it('recreates the observer when version changes', () => {
    const io = installObserver()
    const onLoad = vi.fn()
    const view = renderRoot(createElement(Harness, { enabled: true, hasMore: true, loading: false, version: 0, onLoad }))
    try {
      const first = io.observers[0]!
      view.rerender(createElement(Harness, { enabled: true, hasMore: true, loading: false, version: 1, onLoad }))
      expect(first.disconnected).toBe(true)
      expect(io.observers).toHaveLength(2)
      const second = io.observers[1]!
      expect(second.targets).toEqual([view.container.querySelector('[data-sentinel]')])
      intersect(second)
      expect(onLoad).toHaveBeenCalledTimes(1)
    } finally {
      view.unmount()
      io.restore()
    }
  })

  it('fills a short list only once the box has a layout', () => {
    // jsdom reports clientHeight 0 for every box; give this one a rendered
    // height so the short-list fill path can run, then restore the prototype.
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 100,
    })
    const io = installObserver()
    const onLoad = vi.fn()
    const view = renderRoot(createElement(Harness, { enabled: true, hasMore: true, loading: false, onLoad }))
    try {
      // The sentinel sits within the 100px preload band, so mount itself fills.
      expect(onLoad).toHaveBeenCalledTimes(1)
    } finally {
      view.unmount()
      io.restore()
      if (original === undefined) delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
      else Object.defineProperty(HTMLElement.prototype, 'clientHeight', original)
    }
  })
})
