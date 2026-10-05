import { describe, expect, it } from 'vitest'
import {
  countSubagentDescendants, detectNewDirectSubagent,
  directSubagentCount, rootAncestor,
} from '../src/client/subagent-detect.ts'
import { isKnownLeaf, subagentCatalogs } from '../src/client/subagent-catalog.ts'
import type { SidebarSessionList, SidebarSubagentCatalogEntry } from '../src/context-types.ts'

describe('subagent detection over the sessions list feed', () => {
  /** A list snapshot carrying the given direct subagent children of `parent`. */
  const list = (
    parent: string,
    childIds: string[],
    running: string[] = [],
  ): SidebarSessionList => {
    const byId: SidebarSessionList['byId'] = { [parent]: { id: parent, displayTitle: 'Parent' } }
    for (const id of childIds) {
      byId[id] = {
        id,
        displayTitle: `Child ${id}`,
        origin: 'subagent',
        parentId: parent,
        running: running.includes(id),
      }
    }
    return { byId }
  }

  it('counts only the direct subagent children of the given session', () => {
    const snapshot = list('p1', ['c1', 'c2'])
    snapshot.byId['other'] = { id: 'other', displayTitle: 'Other', origin: 'subagent', parentId: 'p2' }
    expect(directSubagentCount(snapshot.byId, 'p1')).toBe(2)
    expect(directSubagentCount(snapshot.byId, 'p2')).toBe(1)
    expect(directSubagentCount(snapshot.byId, 'p1-nobody')).toBe(0)
  })

  it('fires only on the 0 → N transition of the current session', () => {
    const empty = list('p1', [])
    const one = list('p1', ['c1'])
    const two = list('p1', ['c1', 'c2'])
    expect(detectNewDirectSubagent(empty, empty, 'p1')).toBe(false)
    expect(detectNewDirectSubagent(empty, one, 'p1')).toBe(true)
    // Already-present children never re-trigger (session switch, reload).
    expect(detectNewDirectSubagent(one, two, 'p1')).toBe(false)
    expect(detectNewDirectSubagent(two, one, 'p1')).toBe(false)
    // A child arriving under ANOTHER session does not trigger this one.
    expect(detectNewDirectSubagent(empty, list('p2', ['x']), 'p1')).toBe(false)
  })

  it('indexes descendants through uninterrupted subagent lineage', () => {
    // p1 → c1 (subagent) → g1 (subagent child of c1).
    const byId: SidebarSessionList['byId'] = {
      p1: { id: 'p1', displayTitle: 'P1' },
      c1: { id: 'c1', displayTitle: 'C1', origin: 'subagent', parentId: 'p1', running: true },
      g1: { id: 'g1', displayTitle: 'G1', origin: 'subagent', parentId: 'c1' },
    }
    expect(countSubagentDescendants(byId, 'p1')).toEqual({ count: 2, runningCount: 1 })
    expect(countSubagentDescendants(byId, 'c1')).toEqual({ count: 1, runningCount: 0 })
    expect(countSubagentDescendants(byId, 'g1')).toEqual({ count: 0, runningCount: 0 })
    // An ordinary fork between the parent and the subagent cuts that lineage:
    // c2 is c1's sibling in origin but its parent `fork` is not a subagent,
    // so it never reaches p1 (only c1 and g1 count under p1).
    const forked: SidebarSessionList['byId'] = {
      ...byId,
      fork: { id: 'fork', displayTitle: 'Fork', parentId: 'p1' },
      c2: { id: 'c2', displayTitle: 'C2', origin: 'subagent', parentId: 'fork' },
    }
    expect(countSubagentDescendants(forked, 'p1')).toEqual({ count: 2, runningCount: 1 })
    expect(countSubagentDescendants(forked, 'fork')).toEqual({ count: 1, runningCount: 0 })
    // Cycles terminate (fail soft, never hang); both rows in a 2-cycle reach
    // the queried node once each.
    const cyclic: SidebarSessionList['byId'] = {
      a: { id: 'a', displayTitle: 'A', origin: 'subagent', parentId: 'b' },
      b: { id: 'b', displayTitle: 'B', origin: 'subagent', parentId: 'a' },
    }
    expect(countSubagentDescendants(cyclic, 'a')).toEqual({ count: 2, runningCount: 0 })
  })

  it('excludes Side Chat threads (subagent origin, "Side: " label) from counts', () => {
    // Side threads ride the subagent origin for list hiding + the RPC fence
    // but they are tab-strip conversations, never topology: they must not
    // fire the auto-open trigger nor inflate the Subagent page totals.
    const byId: SidebarSessionList['byId'] = {
      p1: { id: 'p1', displayTitle: 'P1' },
      c1: { id: 'c1', displayTitle: 'C1', origin: 'subagent', parentId: 'p1' },
      s1: { id: 's1', displayTitle: 'Side: refactor plan', origin: 'subagent', parentId: 'p1', running: true },
    }
    expect(directSubagentCount(byId, 'p1')).toBe(1)
    expect(countSubagentDescendants(byId, 'p1')).toEqual({ count: 1, runningCount: 0 })
    // A side thread appearing under an empty session never trips 0 → N.
    const before: SidebarSessionList = { byId: { p2: { id: 'p2', displayTitle: 'P2' } } }
    const after: SidebarSessionList = {
      byId: {
        p2: { id: 'p2', displayTitle: 'P2' },
        s2: { id: 's2', displayTitle: 'Side: New thread', origin: 'subagent', parentId: 'p2' },
      },
    }
    expect(detectNewDirectSubagent(before, after, 'p2')).toBe(false)
  })

  it('documents the title-frame race the Sidebar auto-open debounce absorbs', () => {
    // The host delivers a new child's origin and title in SEPARATE frames:
    // a Side Chat thread's FIRST visible frame still shows a fallback title
    // (the cwd basename — no 'Side: ' prefix), so an immediate 0→N check
    // misreads it as a genuine subagent. Sidebar.tsx therefore debounces
    // AUTO_OPEN_DEBOUNCE_MS and re-evaluates the ORIGINAL baseline against
    // the live snapshot; once the title frame has landed the same baseline
    // yields no trigger. These two assertions pin exactly that dependency.
    const baseline: SidebarSessionList = { byId: { p2: { id: 'p2', displayTitle: 'P2' } } }
    const firstFrame: SidebarSessionList = {
      byId: {
        p2: { id: 'p2', displayTitle: 'P2' },
        s2: { id: 's2', displayTitle: 'DSH-better-sidebar', origin: 'subagent', parentId: 'p2' },
      },
    }
    expect(detectNewDirectSubagent(baseline, firstFrame, 'p2')).toBe(true) // the race
    const settled: SidebarSessionList = {
      byId: {
        p2: { id: 'p2', displayTitle: 'P2' },
        s2: { id: 's2', displayTitle: 'Side: New thread', origin: 'subagent', parentId: 'p2' },
      },
    }
    expect(detectNewDirectSubagent(baseline, settled, 'p2')).toBe(false) // after the debounce
  })

  it('resolves the main-agent root of the current session tree', () => {
    const byId: SidebarSessionList['byId'] = {
      main: { id: 'main', displayTitle: 'Main' },
      child: { id: 'child', displayTitle: 'Child', origin: 'subagent', parentId: 'main' },
      grand: { id: 'grand', displayTitle: 'Grand', origin: 'subagent', parentId: 'child' },
    }
    // An ordinary session is its own root; a deep subagent walks up to the main agent.
    expect(rootAncestor(byId, 'main')).toBe('main')
    expect(rootAncestor(byId, 'child')).toBe('main')
    expect(rootAncestor(byId, 'grand')).toBe('main')
    // A broken chain (parent not in the mirror) degrades to the session itself.
    expect(rootAncestor(byId, 'orphan')).toBe('orphan')
    // A hydrating session row degrades to the session itself.
    expect(rootAncestor(byId, 'not-listed')).toBe('not-listed')
    expect(rootAncestor(byId, undefined)).toBeUndefined()
  })

  it('derives branch disclosure from the child\'s own projection catalog', () => {
    // DSH 0.1.7's catalog row is `{id, createdAt, mode, label?}` — the 0.1.6
    // `hasChildren` boolean is gone, so the topology infers it from the
    // child's OWN `subagentCatalog` projection: a child whose catalog loaded
    // EMPTY is a known leaf, and everything else keeps its level open.
    const row = (id: string, over: Partial<SidebarSubagentCatalogEntry> = {}): SidebarSubagentCatalogEntry => ({
      id, createdAt: 1_000, mode: 'one-shot', ...over,
    })
    const catalogs = subagentCatalogs({
      root: {
        values: { subagentCatalog: [row('branch'), row('leaf')] },
        state: 'ready',
        error: null,
      },
      // The branch has a child of its own; the leaf's catalog loaded empty.
      branch: {
        values: { subagentCatalog: [row('grand', { mode: 'continuable', label: 'Grand' })] },
        state: 'ready',
        error: null,
      },
      leaf: { values: { subagentCatalog: [] }, state: 'ready', error: null },
    })
    expect(catalogs.root?.entries.map(entry => entry.id)).toEqual(['branch', 'leaf'])
    expect(catalogs.root?.state).toBe('ready')
    expect(isKnownLeaf(catalogs, 'leaf')).toBe(true)
    expect(isKnownLeaf(catalogs, 'branch')).toBe(false)
    // A catalog that has not landed (absent from the snapshot, idle without a
    // value, still loading, or failed) is NOT a known leaf: the level stays
    // reserved instead of flapping shut.
    expect(isKnownLeaf(catalogs, 'not-in-snapshot')).toBe(false)
    const pending = subagentCatalogs({
      idle: { values: {}, state: 'idle', error: null },
      loading: { values: {}, state: 'loading', error: null },
      failed: { values: {}, state: 'error', error: { code: 'boom', message: 'boom' } },
      cached: { values: { subagentCatalog: [row('a')] }, state: 'idle', error: null },
    })
    expect(pending.idle).toMatchObject({ state: 'loading', entries: [] })
    expect(isKnownLeaf(pending, 'idle')).toBe(false)
    expect(isKnownLeaf(pending, 'loading')).toBe(false)
    // A failed catalog keeps the level open (there may be children) and
    // carries the failure the retry row renders.
    expect(pending.failed).toMatchObject({ state: 'error', error: { message: 'boom' } })
    expect(isKnownLeaf(pending, 'failed')).toBe(false)
    // An idle row WITH a value is the persisted checkpoint's catalog.
    expect(pending.cached).toMatchObject({ state: 'ready', entries: [expect.objectContaining({ id: 'a' })] })
    // A host with no projection store at all leaves every catalog empty.
    expect(subagentCatalogs(undefined)).toEqual({})
  })
})
