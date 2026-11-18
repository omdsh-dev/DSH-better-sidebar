/**
 * The bounded memos behind the session media routes.
 *
 * Two costs made a naive implementation unacceptable, and both are visible on
 * a real session rather than a fixture:
 *
 *  1. **Availability per row.** `media.list` answers "is the ORIGINAL still
 *     there?" for every row, which is one `stat` per row. A 500-image session
 *     therefore paid 500 serialized stats on every open, and the same
 *     question was asked again seconds later by the next render. The answer is
 *     memoized per identity for {@link REACHABLE_TTL_MS}: long enough to
 *     absorb the burst a page open produces, short enough that a user who
 *     deletes an object and presses refresh does not stare at a stale answer.
 *  2. **The fold.** Reading one item's bytes re-derived the WHOLE catalogue
 *     just to find that item's reference (`readImage` verifies the bytes
 *     against it, so the reference must be the log's own). On the largest
 *     session on this machine that fold decodes ~2.3 MB of compressed log —
 *     per image the reader clicks. The catalogue is cached per session and
 *     invalidated by the live session's own `seq`, so a conversation that is
 *     still running re-folds exactly when it grew.
 *
 * Why this module and not a closure inside the routes: the bounds are the
 * interesting part (the repo's steady-state rule requires every module-level
 * map to have one) and they are testable on their own.
 */

/** How long one folded catalogue answers repeat reads (ms). */
export const CATALOGUE_TTL_MS = 5_000

/** Bound on the per-session catalogue cache (open sessions, not files). */
export const CATALOGUE_CACHE_MAX = 8

/** Bound on the per-identity availability memo. */
export const REACHABLE_CACHE_MAX = 2_000

/** How long one availability answer stands (ms). */
export const REACHABLE_TTL_MS = 30_000

/** How many filesystem probes one list request may have in flight. */
export const PROBE_CONCURRENCY = 8

/** One cached value with the moment it was stored. */
interface Stamped<T> {
  at: number
  value: T
}

/**
 * A bounded map with a per-entry TTL.
 *
 * Eviction is insertion-ordered (the oldest write goes first), which is all a
 * cache of this size needs: both stores answer the same question for the same
 * key, so a hit refreshes nothing and a miss is a cheap recompute.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, Stamped<T>>()

  /**
   * @param max - most entries kept at once.
   * @param ttlMs - how long one entry stays fresh.
   * @param now - clock (injectable so a spec can age entries without sleeping).
   */
  constructor(
    readonly max: number,
    readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The fresh value for one key, or undefined when it is missing or expired.
   * @param key - the cache key.
   * @returns the stored value while it is younger than the TTL.
   */
  get(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (this.now() - entry.at >= this.ttlMs) {
      this.entries.delete(key)
      return undefined
    }
    return entry.value
  }

  /**
   * Store one value, evicting the oldest entries past the bound.
   * @param key - the cache key.
   * @param value - the value to memoize.
   */
  set(key: string, value: T): void {
    this.entries.delete(key)
    this.entries.set(key, { at: this.now(), value })
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
  }

  /** Drop every entry (a spec's reset, or a store-root change). */
  clear(): void {
    this.entries.clear()
  }

  /** How many entries are held right now. */
  get size(): number {
    return this.entries.size
  }
}

/**
 * Run one async mapper over a list with at most `limit` promises in flight.
 *
 * Used for the per-row filesystem probes: `Promise.all` over 500 rows opens
 * 500 descriptors at once, while a `for await` loop serializes them and pays
 * the round-trip latency 500 times. This is the middle ground both extremes
 * want.
 * @param items - the inputs, in order.
 * @param limit - most concurrent calls.
 * @param map - the async work for one input.
 * @returns the results in input order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await map(items[index] as T)
    }
  }
  const workers = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: workers }, worker))
  return results
}

/** The two memos one plugin mount owns. */
export interface MediaCaches {
  /** Folded catalogues, keyed by session id (invalidated by the live `seq`). */
  catalogue: TtlCache<unknown>
  /** Original-bytes availability, keyed by workspace + media identity. */
  reachable: TtlCache<boolean>
}

/**
 * Create one mount's cache pair.
 *
 * Owned by the MOUNT rather than the module on purpose: a module-level map
 * would be shared by every `apply()` in one process (two mounts in a test
 * process would answer each other's sessions), and the repo's steady-state
 * rule wants each of these to have a stated bound and a single owner.
 * @returns fresh, bounded caches.
 */
export function createMediaCaches(): MediaCaches {
  return {
    catalogue: new TtlCache<unknown>(CATALOGUE_CACHE_MAX, CATALOGUE_TTL_MS),
    reachable: new TtlCache<boolean>(REACHABLE_CACHE_MAX, REACHABLE_TTL_MS),
  }
}
