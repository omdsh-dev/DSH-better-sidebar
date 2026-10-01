/**
 * A refresh posted to a page's preview agent, waiting for its `applied`.
 *
 * `ready` is a claim about ONE document; the next one may load without the agent. Measured
 * 27/09/2026 on the stand: a Tracy site whose only agent is the one the site proxy injects loses it
 * when the picker's 15-minute cookie lapses, and the Browser tab kept posting every later refresh
 * (the agent's turn end, the Refresh button) into a page that no longer listened — the preview froze.
 * The watch turns that silence into a plain reload.
 */

/** The timer pair a watch uses; `window`'s by default, a fake one in tests. */
export interface WatchTimers {
  set: (run: () => void, ms: number) => number
  clear: (id: number) => void
}

/** One watch per frame: `posted()` after each refresh posted, `answered()` on each `applied`. */
export interface RefreshWatch {
  posted: () => void
  answered: () => void
  dispose: () => void
  readonly pending: boolean
}

/**
 * @param onSilent - runs once when a posted refresh got no `applied` within `ms`.
 * @param ms - how long an answer may take.
 * @param timers - the timer pair; defaults to `window`'s.
 * @returns the watch.
 */
export function createRefreshWatch(onSilent: () => void, ms: number, timers?: WatchTimers): RefreshWatch {
  const clock: WatchTimers = timers ?? {
    set: (run, delay) => window.setTimeout(run, delay),
    clear: (id) => { window.clearTimeout(id) },
  }
  let id: number | undefined
  const stop = (): void => {
    if (id !== undefined) clock.clear(id)
    id = undefined
  }
  return {
    posted() {
      stop()
      id = clock.set(() => {
        id = undefined
        onSilent()
      }, ms)
    },
    answered: stop,
    dispose: stop,
    get pending() { return id !== undefined },
  }
}
