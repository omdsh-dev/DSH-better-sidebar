import { describe, expect, it } from 'vitest'
import {
  collectBranchIds, countSubagentDescendants, detectNewDirectSubagent,
  directSubagentCount, rootAncestor,
} from '../src/client/subagent-detect.ts'
import type { SidebarSessionList, SidebarSubagentCatalog } from '../src/context-types.ts'

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
    return { current: parent, byId }
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

  it('collects every catalog branch of the topology, cycle-safe', () => {
    const child = (id: string, hasChildren: boolean): SidebarSubagentCatalog['entries'][number] => ({
      kind: 'child', id, activity: 'inactive', hasChildren, mode: 'one-shot',
    })
    const catalogs: Record<string, SidebarSubagentCatalog> = {
      root: { entries: [child('a', true), child('b', false)], parentAvailable: true, state: 'ready', error: null },
      a: { entries: [child('c', false)], parentAvailable: true, state: 'ready', error: null },
    }
    expect(collectBranchIds(catalogs, 'root')).toEqual(['a'])
    expect(collectBranchIds(catalogs, undefined)).toEqual([])
    // A cycle terminates (each branch id collected at most once, no hang).
    const cyclic: Record<string, SidebarSubagentCatalog> = {
      root: { entries: [child('a', true)], parentAvailable: true, state: 'ready', error: null },
      a: { entries: [child('root', true)], parentAvailable: true, state: 'ready', error: null },
    }
    expect(collectBranchIds(cyclic, 'root')).toEqual(['a', 'root'])
  })
})
