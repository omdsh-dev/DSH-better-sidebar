/**
 * The sidebar's ONE polling loop: every timed client fetch — subagent live
 * previews, side-chat transcript deltas, git status, session ops — funnels
 * here so the cancellation-safety rules are written once instead of four
 * times. The contract every poller gets:
 *
 * - While `enabled`, the task runs on the chosen cadence; the loop restarts
 *   (and the old one is torn down) whenever `enabled`, the task identity, or
 *   any option primitive changes — callers express "scope changed" through
 *   the task's `useCallback` deps, exactly like an effect's dep array.
 * - Each enabled run owns ONE AbortSignal for its whole lifetime; teardown
 *   (unmount, `enabled` flip, identity change) aborts it AND stops all
 *   scheduling. A task whose fetch settles late must check the signal
 *   before writing state: an aborted fetch is NOT guaranteed to reject
 *   (the transport may deliver the response anyway), so the signal is the
 *   only reliable staleness guard.
 * - A rejected task never breaks the loop — the scheduler swallows it and
 *   the next tick retries. Sites that surface errors (setError banners and
 *   friends) do so inside the task body; the scheduler always stays silent.
 */
import { useEffect } from 'react'

/** One poll tick. See the module doc for the signal contract. */
export type PollingTask = (signal: AbortSignal) => Promise<void>

export interface UsePollingOptions {
  /** Tick cadence in milliseconds. */
  intervalMs: number
  /**
   * Scheduling mode. `'fixed-interval'` (default) fires ticks on a plain
   * `setInterval` cadence — an in-flight task never delays the next tick,
   * overlapping tasks guard their own writes (abort controllers or
   * generation counters inside the task). `'self-scheduling'` arms the next
   * tick only after the previous task settles: at most ONE request in
   * flight, ever, so a slow host never sees request storms.
   */
  mode?: 'fixed-interval' | 'self-scheduling'
  /** Run one task immediately when the poller (re)starts, before the first
   * scheduled tick. */
  immediate?: boolean
}

export function usePolling(
  enabled: boolean,
  task: PollingTask,
  { intervalMs, mode = 'fixed-interval', immediate = false }: UsePollingOptions,
): void {
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    if (mode === 'self-scheduling') {
      let disposed = false
      let timer: number | undefined
      const tick = async (): Promise<void> => {
        if (disposed) return
        try {
          await task(controller.signal)
        } catch {
          // A failed poll keeps the last view; the next tick retries.
        }
        if (!disposed) timer = window.setTimeout(() => { void tick() }, intervalMs)
      }
      if (immediate) void tick()
      else timer = window.setTimeout(() => { void tick() }, intervalMs)
      return () => {
        disposed = true
        if (timer !== undefined) window.clearTimeout(timer)
        controller.abort()
      }
    }
    const run = (): void => {
      // A failed tick keeps the last view; the next tick retries.
      task(controller.signal).catch(() => {})
    }
    if (immediate) run()
    const timer = window.setInterval(run, intervalMs)
    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
    // Option primitives only: a churned options object must not restart the loop.
  }, [enabled, task, intervalMs, mode, immediate])
}
