/**
 * A refresh posted to a page's preview agent must be answered (`applied`), or the frame is reloaded
 * the plain way: 27/09/2026, a document that lost the injected agent (picker cookie lapsed) swallowed
 * every later refresh and the Browser tab's preview froze.
 */
import { describe, expect, it } from 'vitest'
import { createRefreshWatch, type WatchTimers } from '../src/client/refresh-watch.ts'

function fakeTimers(): WatchTimers & { run: () => void; live: () => number } {
  const due = new Map<number, () => void>()
  let next = 1
  return {
    set: (run) => { due.set(next, run); return next++ },
    clear: (id) => { due.delete(id) },
    run: () => { for (const [id, fn] of [...due]) { due.delete(id); fn() } },
    live: () => due.size,
  }
}

describe('refresh watch', () => {
  it('reloads once when a posted refresh is never answered', () => {
    const timers = fakeTimers()
    let reloads = 0
    const watch = createRefreshWatch(() => { reloads += 1 }, 1500, timers)
    watch.posted()
    expect(watch.pending).toBe(true)
    timers.run()
    expect(reloads).toBe(1)
    expect(watch.pending).toBe(false)
  })

  it('does nothing when the page answers in time', () => {
    const timers = fakeTimers()
    let reloads = 0
    const watch = createRefreshWatch(() => { reloads += 1 }, 1500, timers)
    watch.posted()
    watch.answered()
    timers.run()
    expect(reloads).toBe(0)
    expect(timers.live()).toBe(0)
  })

  it('keeps one timer per frame: a second refresh restarts the wait instead of stacking it', () => {
    const timers = fakeTimers()
    let reloads = 0
    const watch = createRefreshWatch(() => { reloads += 1 }, 1500, timers)
    watch.posted()
    watch.posted()
    expect(timers.live()).toBe(1)
    timers.run()
    expect(reloads).toBe(1)
  })

  it('stops waiting when the view goes away', () => {
    const timers = fakeTimers()
    let reloads = 0
    const watch = createRefreshWatch(() => { reloads += 1 }, 1500, timers)
    watch.posted()
    watch.dispose()
    timers.run()
    expect(reloads).toBe(0)
  })
})
