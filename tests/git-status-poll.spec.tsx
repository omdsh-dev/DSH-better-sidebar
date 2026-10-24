/**
 * The shared git-status store's CADENCE contract.
 *
 * One fetch here is `git status --untracked-files=all` plus two `--numstat`
 * diffs, so an automatic poll is real work — and it used to run every 2.5 s for
 * as long as any consumer was on screen, notified on every tick whether or not
 * anything had changed. Five behaviours are pinned:
 *
 *  - OWNERSHIP: only a `poll: true` consumer starts the timer. A `poll: false`
 *    consumer (the editor's gutter) reads the shared answer and refreshes on
 *    its own events, so it can never keep git running in the background.
 *  - ORDER: a non-polling consumer that arrives FIRST must not stop a polling
 *    consumer that arrives later from starting the timer.
 *  - SILENCE: an idle poll that returns an equal status notifies nobody — the
 *    version counter is the `useSyncExternalStore` snapshot, and bumping it
 *    re-rendered every consumer (the file tree's rows included) once per
 *    cadence for nothing.
 *  - THE LADDER: the baseline is 30 s, a slow round trip drops the slot to
 *    60 s then 180 s, and a really slow one stops the automatic timer
 *    altogether; a fast answer climbs straight back to the baseline.
 *  - RETENTION: a slot whose last consumer went away is forgotten, and the
 *    registry is capped, so a long session cannot pin one snapshot per scope
 *    it ever visited (v0.25's `keepMounted` means every visited tab body keeps
 *    walking new scopes). A retained consumer, or a fetch in flight, is never
 *    evicted.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, useEffect, type ReactNode } from 'react'
import { act } from 'react-dom/test-utils'
import type { GitStatusResult, SessionScope } from '../src/client/api.ts'

const { gitStatus } = vi.hoisted(() => ({ gitStatus: vi.fn() }))

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return { ...actual, api: { ...actual.api, gitStatus } }
})

import { renderRoot, setupReactAct } from './test-utils.ts'
import { invalidateGitStatus, useGitStatus, type GitStatusView } from '../src/client/ui/git-status.ts'

setupReactAct()

const REPO: GitStatusResult = {
  isRepo: true,
  root: '/tmp',
  entries: [{ path: 'a.ts', xy: ' M' }],
}

/** The scope of one test; a fresh sessionId mints a fresh slot. */
const scopeFor = (id: string): SessionScope => ({ sessionId: id, cwd: '/tmp' })

/** Commits observed for the probe component (not renders — see Probe). */
interface Counter { value: number }

/** The view the probe most recently received, for the event-driven cases. */
let latest: GitStatusView | null = null

function Probe(props: { scope: SessionScope; poll?: boolean; visible?: boolean; commits: Counter }): ReactNode {
  const view = useGitStatus(props.scope, { poll: props.poll, visible: props.visible })
  // One per COMMIT: the store's only observable is the version counter behind
  // `useSyncExternalStore`, so a commit is exactly "the store notified".
  useEffect(() => { props.commits.value += 1 })
  latest = view
  return createElement('span')
}

/** Let the store's in-flight fetch settle (inside act — it notifies React). */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** Advance the fake clock, letting the store's promises settle inside act. */
async function tick(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

let mounted: ReturnType<typeof renderRoot> | null = null
afterEach(() => {
  mounted?.unmount()
  mounted = null
  latest = null
  gitStatus.mockReset()
  vi.useRealTimers()
})

describe('the shared git status store cadence', () => {
  it('never starts a timer for a poll:false consumer', async () => {
    vi.useFakeTimers()
    gitStatus.mockResolvedValue(REPO)
    const commits: Counter = { value: 0 }
    mounted = renderRoot(createElement(Probe, { scope: scopeFor('poll-off'), poll: false, commits }))
    await tick(0)
    await flush()
    // The one reading a non-polling consumer is entitled to.
    expect(gitStatus).toHaveBeenCalledTimes(1)
    await tick(120_000)
    expect(gitStatus).toHaveBeenCalledTimes(1)
  })

  it('polls a poll:true consumer on the 30 s baseline', async () => {
    vi.useFakeTimers()
    gitStatus.mockResolvedValue(REPO)
    const commits: Counter = { value: 0 }
    mounted = renderRoot(createElement(Probe, { scope: scopeFor('poll-on'), commits }))
    await tick(0)
    await flush()
    expect(gitStatus).toHaveBeenCalledTimes(1)
    // Still inside the first interval: the old 2.5 s cadence would already
    // have fired ten times here.
    await tick(29_000)
    expect(gitStatus).toHaveBeenCalledTimes(1)
    await tick(2_000)
    expect(gitStatus).toHaveBeenCalledTimes(2)
  })

  it('starts the timer even when the non-polling consumer arrived first', async () => {
    vi.useFakeTimers()
    gitStatus.mockResolvedValue(REPO)
    const commits: Counter = { value: 0 }
    const scope = scopeFor('mixed-order')
    // Both mount in one commit; effects run in tree order, so the non-polling
    // consumer retains the slot first.
    const tree = (withPolling: boolean): ReactNode => createElement('div', null,
      createElement(Probe, { scope, poll: false, commits }),
      withPolling ? createElement(Probe, { scope, poll: true, commits }) : null,
    )
    mounted = renderRoot(tree(true))
    await tick(0)
    await flush()
    expect(gitStatus).toHaveBeenCalledTimes(1)

    // The polling consumer owns the timer...
    await tick(31_000)
    expect(gitStatus).toHaveBeenCalledTimes(2)

    // ...and when it leaves, the timer goes with it while the non-polling one
    // keeps its answer.
    mounted.rerender(tree(false))
    await flush()
    const afterLeave = gitStatus.mock.calls.length
    await tick(120_000)
    expect(gitStatus).toHaveBeenCalledTimes(afterLeave)
    expect(latest?.snapshot).not.toBeNull()
  })

  it('stays silent when an idle poll returns the same status', async () => {
    vi.useFakeTimers()
    gitStatus.mockResolvedValue(REPO)
    const commits: Counter = { value: 0 }
    mounted = renderRoot(createElement(Probe, { scope: scopeFor('idle-silent'), commits }))
    await tick(0)
    await flush()
    const settled = commits.value
    expect(settled).toBeGreaterThan(0)

    // One full cadence: the poll runs (a NEW object every time), the status is
    // equal, so no consumer may be told anything. Without the guard this bumps
    // the version and the probe commits again.
    await tick(30_000)
    await flush()
    expect(gitStatus).toHaveBeenCalledTimes(2)
    expect(commits.value).toBe(settled)

    // A real change still lands.
    gitStatus.mockResolvedValue({ ...REPO, entries: [{ path: 'a.ts', xy: ' M' }, { path: 'b.ts', xy: '??' }] })
    await tick(30_000)
    await flush()
    expect(commits.value).toBeGreaterThan(settled)
  })

  it('drops to 60 s when a round trip is slow, and climbs back when it is fast', async () => {
    vi.useFakeTimers()
    gitStatus.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => { resolve(REPO) }, 1_000)
    }))
    const commits: Counter = { value: 0 }
    mounted = renderRoot(createElement(Probe, { scope: scopeFor('ladder-down'), commits }))
    // The first answer takes 1 s of (fake) wall clock: tier 1, i.e. 2x.
    await tick(1_000)
    await flush()
    expect(gitStatus).toHaveBeenCalledTimes(1)

    // Past the OLD cadence and past the baseline, but inside 60 s: no tick.
    await tick(30_000)
    expect(gitStatus).toHaveBeenCalledTimes(1)
    // Past 60 s from the moment the slow answer landed: one tick.
    await tick(31_000)
    expect(gitStatus).toHaveBeenCalledTimes(2)

    // A fast answer now resets the ladder to the baseline.
    gitStatus.mockResolvedValue(REPO)
    // t=122s: the deferred 60 s tick lands and comes back instantly.
    await tick(60_000)
    await flush()
    const recovered = gitStatus.mock.calls.length
    expect(recovered).toBeGreaterThan(2)
    // Inside a 30 s window: nothing yet...
    await tick(20_000)
    expect(gitStatus).toHaveBeenCalledTimes(recovered)
    // ...but 40 s on, the baseline cadence must have fired (a 60 s one would
    // still be waiting, which is what makes this the ladder-down check).
    await tick(20_000)
    expect(gitStatus).toHaveBeenCalledTimes(recovered + 1)
  })

  it('stops the automatic timer after a very slow round trip, until an event refreshes', async () => {
    vi.useFakeTimers()
    gitStatus.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => { resolve(REPO) }, 6_000)
    }))
    const commits: Counter = { value: 0 }
    mounted = renderRoot(createElement(Probe, { scope: scopeFor('ladder-stop'), commits }))
    await tick(6_000)
    await flush()
    expect(gitStatus).toHaveBeenCalledTimes(1)

    // Tier 3: no timer at all, so ten minutes of idling cost nothing.
    await tick(600_000)
    expect(gitStatus).toHaveBeenCalledTimes(1)

    // An event-driven refresh still runs — and a fast answer restores polling.
    gitStatus.mockResolvedValue(REPO)
    await tick(1_000)
    await act(async () => { latest?.refresh() })
    await flush()
    expect(gitStatus).toHaveBeenCalledTimes(2)
    await tick(30_000)
    expect(gitStatus).toHaveBeenCalledTimes(3)
  })

  it('does not fetch at all for a hidden consumer, and starts when it shows', async () => {
    vi.useFakeTimers()
    gitStatus.mockResolvedValue(REPO)
    const commits: Counter = { value: 0 }
    const scope = scopeFor('visibility')
    mounted = renderRoot(createElement(Probe, { scope, visible: false, commits }))
    await tick(0)
    await flush()
    expect(gitStatus).toHaveBeenCalledTimes(0)
    await tick(120_000)
    expect(gitStatus).toHaveBeenCalledTimes(0)

    mounted.rerender(createElement(Probe, { scope, visible: true, commits }))
    await tick(0)
    await flush()
    expect(gitStatus).toHaveBeenCalledTimes(1)
  })
})

describe('the shared git status store retention', () => {
  /**
   * The probe drives a scope that is HIDDEN first: a consumer that mounts while
   * invisible mints its slot without ever retaining (and therefore never
   * releases) it — the one path only the registry cap can bound.
   */
  it('forgets a released slot instead of remembering every scope it ever saw', async () => {
    vi.useFakeTimers()
    gitStatus.mockResolvedValue(REPO)
    // The file tree, the changes page and the editor's gutter mint one slot per
    // scope (session + cwd + repo + worktree), and a kept-mounted tab keeps
    // walking new scopes for the whole page. Forty of them, one session.
    for (let index = 0; index < 40; index++) {
      const probe = renderRoot(createElement(Probe, {
        scope: { sessionId: 'prune', cwd: `/tmp/p${index}` },
        commits: { value: 0 },
      }))
      await tick(0)
      await flush()
      probe.unmount()
    }
    expect(gitStatus).toHaveBeenCalledTimes(40)

    // Every consumer released, so the session has no live slot left. That is
    // the observable probe: `invalidateGitStatus` re-reads the slots it still
    // knows, so a store that remembered the released keys answers with forty
    // further fetches (one per remembered scope) instead of none.
    await act(async () => { invalidateGitStatus('prune') })
    await flush()
    expect(gitStatus).toHaveBeenCalledTimes(40)
  })

  it('re-fetches after the last consumer went away (the snapshot went with the slot)', async () => {
    vi.useFakeTimers()
    gitStatus.mockResolvedValue(REPO)
    const scope = scopeFor('rejoin')
    const commits: Counter = { value: 0 }
    mounted = renderRoot(createElement(Probe, { scope, commits }))
    await tick(0)
    await flush()
    expect(gitStatus).toHaveBeenCalledTimes(1)
    expect(latest?.snapshot).not.toBeNull()

    // Parked: the slot is released (and forgotten), so its snapshot is gone.
    mounted.rerender(createElement(Probe, { scope, visible: false, commits }))
    await flush()
    expect(latest?.snapshot).toBeNull()

    // Coming back must read the truth again, not serve the parked answer.
    mounted.rerender(createElement(Probe, { scope, commits }))
    await tick(0)
    await flush()
    expect(gitStatus).toHaveBeenCalledTimes(2)
    expect(latest?.snapshot).not.toBeNull()
  })

  it('caps the registry for keys no consumer ever releases', async () => {
    vi.useFakeTimers()
    gitStatus.mockResolvedValue(REPO)
    // 260 distinct hidden scopes of ONE session: each render mints a slot, none
    // of them is retained (so nothing releases them) and none fetches.
    for (let index = 0; index < 260; index++) {
      renderRoot(createElement(Probe, {
        scope: { sessionId: 'cap', cwd: `/tmp/c${index}` },
        visible: false,
        commits: { value: 0 },
      })).unmount()
    }
    expect(gitStatus).not.toHaveBeenCalled()

    // The cap keeps at most 256 keys (the constant in ui/git-status.ts): the
    // session-wide invalidate can therefore re-read at most that many. Without
    // the cap this is 260 — one remembered slot per scope ever mounted.
    await act(async () => { invalidateGitStatus('cap') })
    await flush()
    expect(gitStatus.mock.calls.length).toBeGreaterThan(0)
    expect(gitStatus.mock.calls.length).toBeLessThanOrEqual(256)
  })
})
