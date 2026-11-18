/**
 * The bounded memos behind the session media routes.
 *
 * Why these are tested at all: the steady-state rule says every module-level
 * map must have a stated bound, and a cache whose bound is only asserted in
 * prose rots into an unbounded one. Each case pins an invariant that has a
 * real failure mode:
 *
 *  - the TTL is what makes "delete the object, press refresh" show the new
 *    answer, so an entry that never expires is a broken refresh button;
 *  - the bound is what keeps a long-lived page from growing forever;
 *  - the concurrency cap is what keeps a 500-row catalogue from opening 500
 *    descriptors at once (and from serializing into 500 round trips).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  CATALOGUE_CACHE_MAX,
  CATALOGUE_TTL_MS,
  PROBE_CONCURRENCY,
  REACHABLE_CACHE_MAX,
  REACHABLE_TTL_MS,
  TtlCache,
  createMediaCaches,
  mapWithConcurrency,
} from '../src/media-cache.ts'

describe('TtlCache', () => {
  it('answers a fresh entry and forgets it once the TTL passes', () => {
    let now = 1_000
    const cache = new TtlCache<string>(10, 100, () => now)
    cache.set('a', 'first')
    expect(cache.get('a')).toBe('first')
    now += 99
    expect(cache.get('a')).toBe('first')
    now += 1
    // Expired AT the TTL, not after it: the reader's refresh must see the
    // new answer at the first moment the TTL promises.
    expect(cache.get('a')).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it('evicts the oldest write past its bound, never the newest', () => {
    const cache = new TtlCache<number>(3, 60_000)
    for (const key of ['a', 'b', 'c']) cache.set(key, 1)
    expect(cache.size).toBe(3)
    cache.set('d', 4)
    expect(cache.size).toBe(3)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('d')).toBe(4)
  })

  it('treats a rewrite as the newest entry', () => {
    const cache = new TtlCache<number>(2, 60_000)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('a', 3)
    cache.set('c', 4)
    expect(cache.get('a')).toBe(3)
    expect(cache.get('b')).toBeUndefined()
  })

  it('drops everything on clear (the mount teardown)', () => {
    const cache = new TtlCache<number>(10, 60_000)
    cache.set('a', 1)
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.get('a')).toBeUndefined()
  })

  it('ages an entry out on read, not only on the next write', () => {
    // A page that stops writing must not keep answering a stale "the original
    // is still there" — the expiry is checked by the reader.
    let now = 0
    const cache = new TtlCache<boolean>(10, 50, () => now)
    cache.set('gone', true)
    now = 500
    expect(cache.get('gone')).toBeUndefined()
    expect(cache.size).toBe(0)
  })
})

describe('mapWithConcurrency', () => {
  it('returns results in input order whatever the completion order is', async () => {
    const delays = [30, 5, 20, 1, 10]
    const results = await mapWithConcurrency(delays, 2, async (delay) => {
      await new Promise(resolve => setTimeout(resolve, delay))
      return delay
    })
    expect(results).toEqual(delays)
  })

  it('never exceeds the limit in flight', async () => {
    let inFlight = 0
    let peak = 0
    const items = Array.from({ length: 40 }, (_, index) => index)
    await mapWithConcurrency(items, 4, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await Promise.resolve()
      inFlight -= 1
      return 0
    })
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
  })

  it('runs every item exactly once', async () => {
    const seen: number[] = []
    const items = Array.from({ length: 25 }, (_, index) => index)
    await mapWithConcurrency(items, 6, async (index) => {
      seen.push(index)
      return index
    })
    expect(seen.sort((left, right) => left - right)).toEqual(items)
  })

  it('handles an empty list without spawning a worker', async () => {
    const map = vi.fn(async () => 1)
    expect(await mapWithConcurrency([], 4, map)).toEqual([])
    expect(map).not.toHaveBeenCalled()
  })

  it('still respects a limit larger than the list', async () => {
    const results = await mapWithConcurrency([1, 2], 50, async value => value * 2)
    expect(results).toEqual([2, 4])
  })
})

describe('createMediaCaches', () => {
  it('hands out two independent bounded caches', () => {
    const caches = createMediaCaches()
    expect(caches.catalogue.max).toBe(CATALOGUE_CACHE_MAX)
    expect(caches.catalogue.ttlMs).toBe(CATALOGUE_TTL_MS)
    expect(caches.reachable.max).toBe(REACHABLE_CACHE_MAX)
    expect(caches.reachable.ttlMs).toBe(REACHABLE_TTL_MS)
    // A fresh pair starts empty, so two mounts never share an answer.
    const other = createMediaCaches()
    caches.reachable.set('k', true)
    expect(other.reachable.get('k')).toBeUndefined()
  })

  it('keeps the probe pool small enough to be worth calling bounded', () => {
    // The point of the cap is that a big catalogue does not open one
    // descriptor per row; anything close to that defeats it.
    expect(PROBE_CONCURRENCY).toBeGreaterThan(1)
    expect(PROBE_CONCURRENCY).toBeLessThanOrEqual(16)
  })
})
