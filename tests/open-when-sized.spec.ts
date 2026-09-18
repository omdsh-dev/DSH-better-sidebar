/**
 * openWhenSized tests: the deferred one-shot open guard for hosts that may
 * not have a real size yet (xterm crashes when opened in a zero-size
 * container — the WKWebView bottom-panel blank-terminal bug, issue #25).
 * The guard must open exactly once, only once the host reports a real size,
 * stop when the host leaves the document, and cancel cleanly. While the host
 * stays mounted but hidden it must not re-read the host box every frame
 * (per-frame `clientWidth` reads force a synchronous layout whenever the
 * document is dirty, and the frame callback never stops; issue #6906).
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { openWhenSized, type OpenWhenSizedHooks } from '../src/client/open-when-sized.ts'

/** A manually-stepped frame scheduler plus fake observer/interval seams. */
function makeHooks(): {
  hooks: OpenWhenSizedHooks
  tick: () => void
  pending: () => number
  resize: () => void
  interval: () => void
  observing: () => boolean
  intervalActive: () => boolean
} {
  let nextFrameId = 0
  let nextIntervalId = 0
  const frames = new Map<number, FrameRequestCallback>()
  const intervals = new Map<number, () => void>()
  let observer: (() => void) | null = null
  return {
    hooks: {
      raf: (cb) => { const id = ++nextFrameId; frames.set(id, cb); return id },
      caf: (id) => { frames.delete(id) },
      observe: (_host, check) => { observer = check; return () => { observer = null } },
      setInterval: (cb) => {
        const id = ++nextIntervalId
        intervals.set(id, cb)
        return id as unknown as ReturnType<typeof setInterval>
      },
      clearInterval: (id) => { intervals.delete(id as unknown as number) },
    },
    tick: () => {
      const cbs = [...frames.values()]
      frames.clear()
      for (const cb of cbs) cb(0)
    },
    pending: () => frames.size,
    resize: () => { observer?.() },
    interval: () => { for (const cb of [...intervals.values()]) cb() },
    observing: () => observer !== null,
    intervalActive: () => intervals.size > 0,
  }
}

/** A host whose reported size can be changed between checks. */
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
  it('opens on the first frame when the host already has a size, then stops', () => {
    const s = makeHooks()
    const host = makeHost(320, 200)
    let opened = 0
    const cancel = openWhenSized(host.el, () => { opened += 1 }, s.hooks)
    s.tick()
    expect(opened).toBe(1)
    expect(s.pending()).toBe(0)
    expect(s.observing()).toBe(false)
    expect(s.intervalActive()).toBe(false)
    s.resize()
    expect(opened).toBe(1)
    cancel()
  })

  it('defers while the host is zero-sized and opens exactly once on a resize', () => {
    const s = makeHooks()
    const host = makeHost(0, 0)
    let opened = 0
    const cancel = openWhenSized(host.el, () => { opened += 1 }, s.hooks)
    s.tick()
    expect(opened).toBe(0)
    expect(s.observing()).toBe(true)
    host.setSize(320, 200)
    s.resize()
    expect(opened).toBe(1)
    expect(s.pending()).toBe(0)
    expect(s.observing()).toBe(false)
    expect(s.intervalActive()).toBe(false)
    s.resize()
    s.interval()
    expect(opened).toBe(1)
    cancel()
  })

  it('opens from the fallback interval when a size arrives without a resize entry', () => {
    const s = makeHooks()
    const host = makeHost(0, 0)
    let opened = 0
    const cancel = openWhenSized(host.el, () => { opened += 1 }, s.hooks)
    s.tick()
    expect(opened).toBe(0)
    host.setSize(320, 200)
    s.interval()
    expect(opened).toBe(1)
    expect(s.intervalActive()).toBe(false)
    cancel()
  })

  it('opens when only one dimension was missing', () => {
    const s = makeHooks()
    const host = makeHost(320, 0)
    let opened = 0
    const cancel = openWhenSized(host.el, () => { opened += 1 }, s.hooks)
    s.tick()
    expect(opened).toBe(0)
    host.setSize(320, 120)
    s.resize()
    expect(opened).toBe(1)
    cancel()
  })

  it('does no per-frame work while the host stays mounted but hidden', () => {
    const s = makeHooks()
    const host = makeHost(0, 0)
    let opened = 0
    const cancel = openWhenSized(host.el, () => { opened += 1 }, s.hooks)
    s.tick()
    // The guard reads the host box once, from the observer and the fallback
    // interval only; it must never schedule another frame.
    expect(s.pending()).toBe(0)
    s.tick()
    expect(s.pending()).toBe(0)
    expect(opened).toBe(0)
    expect(s.observing()).toBe(true)
    cancel()
  })

  it('stops when the host leaves the document', () => {
    const s = makeHooks()
    const host = makeHost(0, 0)
    let opened = 0
    const cancel = openWhenSized(host.el, () => { opened += 1 }, s.hooks)
    s.tick()
    host.el.remove()
    s.resize()
    expect(opened).toBe(0)
    expect(s.observing()).toBe(false)
    expect(s.intervalActive()).toBe(false)
    expect(s.pending()).toBe(0)
    // Even if the host somehow got a size after detaching, nothing opens.
    host.setSize(320, 200)
    s.resize()
    s.interval()
    expect(opened).toBe(0)
    cancel()
  })

  it('cancels a pending open, disposing the observer and clearing the interval', () => {
    const s = makeHooks()
    const host = makeHost(0, 0)
    let opened = 0
    const cancel = openWhenSized(host.el, () => { opened += 1 }, s.hooks)
    s.tick()
    cancel()
    expect(s.pending()).toBe(0)
    expect(s.observing()).toBe(false)
    expect(s.intervalActive()).toBe(false)
    host.setSize(320, 200)
    s.resize()
    s.interval()
    expect(opened).toBe(0)
    // Idempotent: cancelling again is a no-op.
    cancel()
  })

  it('does not swallow exceptions from open (the caller owns error handling)', () => {
    const s = makeHooks()
    const host = makeHost(320, 200)
    let calls = 0
    const cancel = openWhenSized(host.el, () => {
      calls += 1
      throw new Error('boom')
    }, s.hooks)
    expect(() => s.tick()).toThrow('boom')
    expect(calls).toBe(1)
    cancel()
  })
})
