/**
 * The base a session-scoped file ADDRESS is read with when the session has
 * LEFT its stored root.
 *
 * The address contract uses the session's immutable header cwd, which is the
 * right answer for a session that stays inside its workspace — and the reason
 * #947/#950 are fixed. It is the wrong answer for a bridge session: an
 * IM / group conversation is opened in a neutral directory (`~/.dsh/im`) and
 * then moves into the project the chat is about, so the header cwd stays the
 * neutral root for the session's whole life while every relative path a
 * model, a tool result or a `cd`-scoped command prints is relative to the
 * LIVE directory. Resolving such an address against the stored root put it
 * under `~/.dsh/im` and the preview died with
 *
 *   cannot read "/home/u/.dsh/im/build/review.md": ENOENT …
 *
 * The rule this spec pins: the base follows the live `workingDirectory`
 * projection exactly while the live directory is OUTSIDE the stored root; a
 * live directory equal to, or nested under, the stored root keeps the stored
 * base, so the worktree family (#947/#950) is unaffected.
 */
import { describe, expect, it } from 'vitest'
import { addressBaseOf, resolveAddressPath } from '../src/client/address-base.ts'
import type { Context, SidebarProjectionSnapshot, SidebarSessionSummary } from '../src/context-types.ts'

interface Row extends Partial<SidebarSessionSummary> {
  cwd?: string
}

/**
 * A client context with one session row (`byId.s1`), optionally carrying the
 * list row's projection values and/or the per-connection projection store.
 * @param row - the session row (stored header cwd and list projection values).
 * @param store - `projectionsBySession.s1.values`, when the host only
 *   publishes projections through the store.
 */
function ctxOf(row: Row, store?: SidebarProjectionSnapshot['values']): Context {
  const snapshot = {
    byId: { s1: { id: 's1', displayTitle: 's1', ...row } },
    ...(store === undefined
      ? {}
      : { projectionsBySession: { s1: { values: store, state: 'idle', error: null } } }),
  }
  return { sessions: { list: { getSnapshot: () => snapshot } } } as unknown as Context
}

describe('address base (a session that left its stored root)', () => {
  it('follows the live working directory of a bridge session (the ENOENT case)', () => {
    // The reported shape: an IM session rooted at the bridge's neutral
    // directory, whose agent works in the project it was asked about.
    const ctx = ctxOf({
      cwd: '/home/u/.dsh/im',
      projectionValues: { workingDirectory: '/home/u/work/project' },
    })
    const base = addressBaseOf(ctx, 's1')
    expect(base).toBe('/home/u/work/project')
    // The whole address-boundary pipeline: base + the address's relative path.
    expect(resolveAddressPath(base, 'build/hertdevmcp/T9-lifecycle-review.md'))
      .toBe('/home/u/work/project/build/hertdevmcp/T9-lifecycle-review.md')
  })

  it('keeps the stored base while the live directory is the root or inside it (#947/#950)', () => {
    expect(addressBaseOf(ctxOf({
      cwd: '/repo',
      projectionValues: { workingDirectory: '/repo' },
    }), 's1')).toBe('/repo')
    // A linked worktree nested in the workspace: the address's stored-base
    // rule must not move (that is the #950 family).
    expect(addressBaseOf(ctxOf({
      cwd: '/repo',
      projectionValues: { workingDirectory: '/repo/frontend/.worktrees/wt' },
    }), 's1')).toBe('/repo')
    // Windows spelling: the containment test folds case there, and only there.
    expect(addressBaseOf(ctxOf({
      cwd: 'C:\\repo',
      projectionValues: { workingDirectory: 'c:\\repo\\frontend' },
    }), 's1')).toBe('C:\\repo')
  })

  it('does not treat a sibling directory with the root as a prefix as inside it', () => {
    // `/repo2` is NOT under `/repo` — the separator test is not a raw
    // `startsWith`, which would silently classify it as contained.
    expect(addressBaseOf(ctxOf({
      cwd: '/repo',
      projectionValues: { workingDirectory: '/repo2/work' },
    }), 's1')).toBe('/repo2/work')
  })

  it('falls back to the stored cwd without a usable live value', () => {
    expect(addressBaseOf(ctxOf({ cwd: '/repo' }), 's1')).toBe('/repo')
    expect(addressBaseOf(ctxOf({ cwd: '/repo', projectionValues: { workingDirectory: null } }), 's1'))
      .toBe('/repo')
    expect(addressBaseOf(ctxOf({ cwd: '/repo', projectionValues: { workingDirectory: '' } }), 's1'))
      .toBe('/repo')
  })

  it('reads the projection store when the list row carries no values', () => {
    const ctx = ctxOf({ cwd: '/home/u/.dsh/im' }, { workingDirectory: '/home/u/work/project' })
    expect(addressBaseOf(ctx, 's1')).toBe('/home/u/work/project')
  })

  it('keeps answering undefined for a session it does not know', () => {
    expect(addressBaseOf(ctxOf({ cwd: '/repo' }), 'other')).toBeUndefined()
    expect(addressBaseOf({} as never, 's1')).toBeUndefined()
    expect(addressBaseOf(ctxOf({ cwd: '/repo' }), undefined)).toBeUndefined()
  })
})
