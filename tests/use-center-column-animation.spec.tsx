// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactElement } from 'react'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { useCenterColumn } from '../src/client/sidebar/use-center-column.ts'

setupReactAct()

interface FakeObserverInstance {
  callback: ResizeObserverCallback
  observeCalls: number
  disconnectCalls: number
  trigger: () => void
}

function buildCenterFixture(): {
  root: HTMLDivElement
  col: HTMLDivElement
  bottom: HTMLDivElement
  bottomRef: { current: HTMLDivElement | null }
  rectSpy: ReturnType<typeof vi.spyOn>
} {
  const root = document.createElement('div')
  root.id = 'root'
  const col = document.createElement('div')
  const wrapper = document.createElement('div')
  wrapper.style.display = 'contents'
  const slot = document.createElement('div')
  slot.dataset.slot = 'main.conversation'
  wrapper.append(slot)
  col.append(wrapper)
  root.append(col)
  document.body.append(root)

  const rectSpy = vi.spyOn(col, 'getBoundingClientRect').mockReturnValue({
    x: 80,
    y: 0,
    left: 80,
    right: 880,
    top: 0,
    bottom: 600,
    width: 800,
    height: 600,
    toJSON: () => ({}),
  } as DOMRect)

  const bottom = document.createElement('div')
  return { root, col, bottom, bottomRef: { current: bottom }, rectSpy }
}

function Probe(props: {
  bottomRef: { current: HTMLDivElement | null }
  bottomOpen: boolean
}): ReactElement {
  useCenterColumn(props.bottomRef, props.bottomOpen)
  return createElement('div')
}

describe('useCenterColumn animation and closed-panel guards', () => {
  const originalResizeObserver = globalThis.ResizeObserver

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (originalResizeObserver === undefined) {
      Reflect.deleteProperty(globalThis, 'ResizeObserver')
    } else {
      globalThis.ResizeObserver = originalResizeObserver
    }
    for (const root of document.body.querySelectorAll('div#root')) root.remove()
  })

  function installResizeObserverRecorder(): FakeObserverInstance[] {
    const instances: FakeObserverInstance[] = []
    class RecordingResizeObserver {
      private record: FakeObserverInstance
      constructor(callback: ResizeObserverCallback) {
        const record: FakeObserverInstance = {
          callback,
          observeCalls: 0,
          disconnectCalls: 0,
          trigger: () => {
            callback([], this as unknown as ResizeObserver)
          },
        }
        this.record = record
        instances.push(record)
      }
      observe(): void {
        this.record.observeCalls += 1
      }
      unobserve(): void {
        // noop
      }
      disconnect(): void {
        this.record.disconnectCalls += 1
      }
    }
    globalThis.ResizeObserver = RecordingResizeObserver as unknown as typeof ResizeObserver
    return instances
  }

  it('skips ResizeObserver measurements while bottomOpen is false and measures on open without recreating observers', () => {
    const instances = installResizeObserverRecorder()
    const { bottomRef, bottom, rectSpy } = buildCenterFixture()

    const view = renderRoot(createElement(Probe, { bottomRef, bottomOpen: false }))
    try {
      expect(instances).toHaveLength(1)
      const [observer] = instances
      if (observer === undefined) throw new Error('expected ResizeObserver instance')
      expect(observer.observeCalls).toBe(1)
      expect(rectSpy).not.toHaveBeenCalled()

      observer.trigger()
      observer.trigger()
      expect(rectSpy).not.toHaveBeenCalled()

      view.rerender(createElement(Probe, { bottomRef, bottomOpen: true }))
      expect(instances).toHaveLength(1)
      expect(observer.disconnectCalls).toBe(0)
      expect(rectSpy).toHaveBeenCalledTimes(1)
      expect(bottom.style.getPropertyValue('left')).toBe('80px')
    } finally {
      view.unmount()
    }
  })

  it('debounces ResizeObserver measurements for 300ms while an ancestor has [data-animating]', () => {
    vi.useFakeTimers()
    const instances = installResizeObserverRecorder()
    const { root, bottomRef, rectSpy } = buildCenterFixture()

    const view = renderRoot(createElement(Probe, { bottomRef, bottomOpen: true }))
    try {
      expect(rectSpy).toHaveBeenCalledTimes(1)
      const [observer] = instances
      if (observer === undefined) throw new Error('expected ResizeObserver instance')

      root.setAttribute('data-animating', '')
      observer.trigger()
      vi.advanceTimersByTime(100)
      observer.trigger()
      vi.advanceTimersByTime(299)
      expect(rectSpy).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(1)
      expect(rectSpy).toHaveBeenCalledTimes(2)

      root.removeAttribute('data-animating')
      observer.trigger()
      expect(rectSpy).toHaveBeenCalledTimes(3)
    } finally {
      view.unmount()
    }
  })
})