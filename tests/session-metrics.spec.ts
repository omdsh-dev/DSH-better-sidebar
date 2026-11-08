/**
 * Unit tests for the Tasks page's per-session metrics (token usage + turn
 * timing): the fold from the host's projection snapshot, the two totals the
 * popover prints, and the rule that a session with no measurements reports
 * nothing rather than a zero it cannot justify.
 */
import { describe, expect, it } from 'vitest'
import {
  elapsedMs, inputTokens, sessionMetrics, totalTokens,
} from '../src/client/session-metrics.ts'
import type { SidebarProjectionSnapshot } from '../src/context-types.ts'

/** One projection row carrying the metric keys under test. */
function snapshot(values: SidebarProjectionSnapshot['values'], state: 'idle' | 'ready' = 'ready'): SidebarProjectionSnapshot {
  return { values, state, error: null }
}

/** A usage row with the four disjoint buckets. */
const USAGE = {
  uncachedInputTokens: 1_000,
  outputTokens: 4_000,
  cacheReadTokens: 20_000,
  cacheWriteTokens: 500,
}

describe('sessionMetrics', () => {
  it('folds the two metric keys per session and skips sessions without any', () => {
    const metrics = sessionMetrics({
      a: snapshot({ tokenUsage: USAGE }),
      b: snapshot({ subagentTiming: { settledMs: 1_500 } }),
      c: snapshot({ subagentCatalog: [] }),
      d: snapshot({ tokenUsage: USAGE, subagentTiming: { settledMs: 0 } }),
    })
    expect(Object.keys(metrics).sort()).toEqual(['a', 'b', 'd'])
    expect(metrics.a?.usage?.outputTokens).toBe(4_000)
    expect(metrics.a?.timing).toBeUndefined()
    expect(metrics.b?.usage).toBeUndefined()
    expect(metrics.d?.timing?.settledMs).toBe(0)
  })

  it('answers an empty map for a host without the projection store', () => {
    expect(sessionMetrics(undefined)).toEqual({})
  })

  it('sums the four DISJOINT buckets as the session total', () => {
    expect(inputTokens(USAGE)).toBe(21_500)
    expect(totalTokens(USAGE)).toBe(25_500)
  })
})

describe('elapsedMs', () => {
  it('counts closed turns plus the open one, measured to the caller’s clock', () => {
    // `active.through` only advances when an event commits, so a running node's
    // elapsed time is measured against the render clock, not `through`.
    expect(elapsedMs({ settledMs: 1_000, active: { since: 10_000, through: 11_000 } }, 13_500))
      .toBe(4_500)
    expect(elapsedMs({ settledMs: 2_500 }, 99_999)).toBe(2_500)
  })

  it('reports nothing when the host published no timing, or none of it is work', () => {
    // 0 is the projection's init state, indistinguishable from "never worked".
    expect(elapsedMs(undefined, 1_000)).toBeUndefined()
    expect(elapsedMs({ settledMs: 0 }, 1_000)).toBeUndefined()
    // A clock that moved backwards must not print a negative duration.
    expect(elapsedMs({ settledMs: 5, active: { since: 10_000, through: 10_000 } }, 9_000)).toBe(5)
  })
})
