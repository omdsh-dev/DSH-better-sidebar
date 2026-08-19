/**
 * openWhenSized tests: the deferred one-shot open guard for hosts that may
 * not have a real size yet (xterm crashes when opened in a zero-size
 * container — the WKWebView bottom-panel blank-terminal bug, issue #25).
 * The polling must open exactly once, only once the host reports a real
 * size, stop when the host leaves the document, and cancel cleanly.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { openWhenSized } from '../src/client/open-when-sized.ts'

/** A manually-stepped raf/caf pair so the polling is deterministic. */
function makeScheduler(): {
  raf: (cb: FrameRequestCallback) => number
  caf: (id: number) => void
  tick: () => void
  pending: () => number
} {
  let nextId = 0
  const frames = new Map<number, FrameRequestCallback>()
  return {
    raf: (cb) => { const id = ++nextId; frames.set(id, cb); return id },
    caf: (id) => { frames.delete(id) },
    tick: () => {
      const cbs = [...frames.values()]
      frames.clear()
      for (const cb of cbs) cb(0)
    },
    pending: () => frames.size,
  }
}

/** A host whose reported size can be changed between ticks. */
function makeHost(width: number, height: number): {
  el: HTMLElement
  setSize: (w: number, h: number) => void
} {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const setSize = (w: number, h: number): void => {
    Object.defineProperty(el, 'clientWidth', { value: w, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: h, configurable: true })
  }
  setSize(width, height)
  return { el, setSize }
}

describe('openWhenSized', () => {
  it('opens on the first tick when the host already has a size, then stops', () => {
    const { raf, caf, tick, pending } = makeScheduler()
    const host = makeHost(320, 200)
    let opened = 0
    const cancel = openWhenSized(host.el, () => { opened += 1 }, raf, caf)
    tick()
    expect(opened).toBe(1)
    expect(pending()).toBe(0)
    tick()
    expect(opened).toBe(1)
    cancel()
  })

  it('defers while the host is zero-sized and opens exactly once once sized', () => {
    const { raf, caf, tick, pending } = makeScheduler()
    const host = makeHost(0, 0)
    let opened = 0
    const cancel = openWhenSized(host.el, () => { opened += 1 }, raf, caf)
    tick()
    tick()
    tick()
    expect(opened).toBe(0)
    expect(pending()).toBe(1)
    host.setSize(320, 200)
    tick()
    expect(opened).toBe(1)
    expect(pending()).toBe(0)
    tick()
    expect(opened).toBe(1)
    cancel()
  })

  it('opens when only one dimension was missing', () => {
    const { raf, caf, tick } = makeScheduler()
    const host = makeHost(320, 0)
    let opened = 0
    const cancel = openWhenSized(host.el, () => { opened += 1 }, raf, caf)
    tick()
    expect(opened).toBe(0)
    host.setSize(320, 120)
    tick()
    expect(opened).toBe(1)
    cancel()
  })

  it('cancels a pending open and leaves no scheduled frames', () => {
    const { raf, caf, tick, pending } = makeScheduler()
    const host = makeHost(0, 0)
    let opened = 0
    const cancel = openWhenSized(host.el, () => { opened += 1 }, raf, caf)
    tick()
    cancel()
    expect(pending()).toBe(0)
    host.setSize(320, 200)
    tick()
    expect(opened).toBe(0)
    // Idempotent: cancelling again is a no-op.
    cancel()
  })

  it('stops polling when the host leaves the document', () => {
    const { raf, caf, tick, pending } = makeScheduler()
    const host = makeHost(0, 0)
    let opened = 0
    const cancel = openWhenSized(host.el, () => { opened += 1 }, raf, caf)
    tick()
    host.el.remove()
    tick()
    expect(opened).toBe(0)
    expect(pending()).toBe(0)
    // Even if the host somehow got a size after detaching, nothing opens.
    host.setSize(320, 200)
    tick()
    expect(opened).toBe(0)
    cancel()
  })

  it('does not swallow exceptions from open (the caller owns error handling)', () => {
    const { raf, caf, tick } = makeScheduler()
    const host = makeHost(320, 200)
    let calls = 0
    const cancel = openWhenSized(host.el, () => {
      calls += 1
      throw new Error('boom')
    }, raf, caf)
    expect(() => tick()).toThrow('boom')
    expect(calls).toBe(1)
    cancel()
  })
})
