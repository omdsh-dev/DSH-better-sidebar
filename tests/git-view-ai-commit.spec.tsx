/**
 * The ✨ AI-commit button's enablement predicate (issue: an untracked-only
 * worktree left the button clickable while its click could only ever fail —
 * `git diff` never contains untracked files, so generation had nothing to
 * describe). Untracked entries are exactly the `??` status; any other XY
 * combination is a tracked change the generator can read.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { hasTrackedEntry } from '../src/client/GitView.tsx'
import type { GitStatusEntry } from '../src/client/api.ts'

let sequence = 0
const e = (xy: string): GitStatusEntry => ({ path: `f-${(sequence += 1)}`, xy })

describe('hasTrackedEntry', () => {
  it('untracked-only entries do not count as changes', () => {
    expect(hasTrackedEntry([e('??'), e('??')])).toBe(false)
  })

  it('any tracked change enables it (staged / unstaged / both letters)', () => {
    expect(hasTrackedEntry([e('??'), e('M ')])).toBe(true)
    expect(hasTrackedEntry([e(' M')])).toBe(true)
    expect(hasTrackedEntry([e('MM')])).toBe(true)
    expect(hasTrackedEntry([e('A ')])).toBe(true)
  })

  it('no entries means nothing to generate from', () => {
    expect(hasTrackedEntry([])).toBe(false)
  })
})
