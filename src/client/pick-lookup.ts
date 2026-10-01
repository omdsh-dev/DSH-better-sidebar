/**
 * The one `content.locate` a pick asks, held for Send (Tracy, 28/09/2026).
 *
 * A pick asks once, in the background; Send waits for that answer at most `LOCATE_WAIT_MS`
 * (`comment-model.ts`) and hands it to the chat untouched. What this module holds on top of that:
 *
 *   - WHOSE ANSWER IT IS. An answer belongs to one pick (the controller's pick id), never to a CSS
 *     selector. `develop`'s controller kept answers by selector (read 28/09/2026): the `h1` picked on
 *     one page got the record of the `h1` picked on another, and the chat turn carried that record's
 *     ids to the agent.
 *   - ONE AT A TIME. A new pick aborts the lookup before it, so the tab never has two pick lookups
 *     in flight (Joomla's reader refuses overlapping reads on one site; the Apply door joins a warm
 *     and a pick into one build, and the tab asks no more than it needs).
 *   - AN INCOMPLETE ANSWER IS NOT KEPT. The door says `incomplete: true` when it answered from an
 *     index still being built (its time budget ran out), and the tab has none (null) when the door
 *     refused, failed or did not answer in time. Either is asked again when the person presses Send —
 *     by then the index is usually whole — and the first answer is only the fallback.
 *
 * No React, no fetch, no timers: the controller passes the call (`ask`) and the bounded wait.
 */

/** One `content.locate` call for a pick, abortable. */
export type LocateAsk = (signal: AbortSignal) => Promise<unknown>

/**
 * Whether a `content.locate` answer may be reused: an answer at all, from a whole index.
 * @param answer - what the lookup settled to (null = refused, failed or timed out).
 * @returns false for none, or for an `incomplete` answer.
 */
export function isFinalLocate(answer: unknown): boolean {
  return answer !== null && typeof answer === 'object' && (answer as { incomplete?: unknown }).incomplete !== true
}

export interface PickLookup {
  /** Ask for a new pick; the lookup held before it is aborted and forgotten. */
  start: (pickId: number, ask: LocateAsk) => void
  /**
   * The answer Send uses for this pick, through `wait` (the bounded wait): the held lookup when it is
   * this pick's and still coming or final; otherwise a new ask, falling back to what the held one had.
   */
  forSend: (pickId: number, ask: LocateAsk) => Promise<unknown>
  /** Abort and forget whatever is held (the pick closed, the view went). */
  drop: () => void
  /** The pick the held lookup belongs to, or null. */
  readonly heldFor: number | null
}

interface Held {
  pickId: number
  answer: Promise<unknown>
  /** What the answer settled to; null while it is still coming. */
  settled: { value: unknown } | null
  abort: AbortController
}

/**
 * @param wait - how Send waits for an answer (`waitForLocate`: at most `LOCATE_WAIT_MS`, else null).
 * @returns the holder for one Browser tab.
 */
export function createPickLookup(wait: (answer: Promise<unknown>) => Promise<unknown>): PickLookup {
  let held: Held | null = null
  const begin = (pickId: number, ask: LocateAsk): Held => {
    held?.abort.abort()
    const abort = new AbortController()
    const entry: Held = { pickId, answer: Promise.resolve(null), settled: null, abort }
    entry.answer = ask(abort.signal).then(
      (value) => {
        entry.settled = { value }
        return value
      },
      () => {
        entry.settled = { value: null }
        return null
      },
    )
    held = entry
    return entry
  }
  return {
    start(pickId, ask) {
      begin(pickId, ask)
    },
    forSend(pickId, ask) {
      const mine = held !== null && held.pickId === pickId ? held : null
      if (mine !== null && (mine.settled === null || isFinalLocate(mine.settled.value))) return wait(mine.answer)
      const fallback = mine?.settled?.value ?? null
      const again = begin(pickId, ask)
      return wait(again.answer).then(value => value ?? fallback)
    },
    drop() {
      held?.abort.abort()
      held = null
    },
    get heldFor() {
      return held?.pickId ?? null
    },
  }
}
