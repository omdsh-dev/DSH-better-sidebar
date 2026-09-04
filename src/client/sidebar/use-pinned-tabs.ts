/**
 * Inline pinned terminals (extracted from Sidebar.tsx, behavior identical):
 * pinned tabs from OTHER sessions inject as VIRTUAL tabs into the first
 * leaf of the right panel's split tree, and the workbench actions are
 * wrapped so virtual ids route back to the HOME session. The shell only
 * consumes the augmented tree and the wrapped actions.
 */
import { useMemo, useState } from 'react'
import {
  agentUuidOf, closeFloatByTab, closeTab, isAgentTabId, leafWithTab, setTabPin,
  type SidebarSnapshot, type SidebarStore, type SplitNode,
} from '../state.ts'
import {
  collectPinnedTabs, createPinnedVirtualTab, getPinnedHomeScope, injectPinnedIntoTree,
  isPinnedVirtualId, parsePinnedVirtualId, type PinnedTabEntry,
} from '../pinned.ts'
import type { WorkbenchActions } from '../split-pane.tsx'
import { api } from '../api.ts'

export function usePinnedTabs(input: {
  store: SidebarStore
  sessionId: string | undefined
  cwd: string | undefined
  snapshot: SidebarSnapshot
  actions: WorkbenchActions
}): { augmentedTree: SplitNode | undefined; wrappedActions: WorkbenchActions } {
  const { store, sessionId, cwd, snapshot, actions } = input
  const state = snapshot.state

  /**
   * Inline pinned terminals (v0.17.0+): pinned tabs from OTHER sessions
   * inject as VIRTUAL tabs into the first leaf of the right panel's split
   * tree. The virtual tabs have unique ids (prefixed with the home session)
   * and carry the home scope in meta. Clicking a virtual tab sets
   * `activePinnedTabId` — the augmented tree overrides the leaf's `active`
   * so the pinned tab's content renders in-place (TerminalView connects to
   * the home session's PTY via WS, no session jump).
   *
   * Closing/unpinning a virtual tab targets the HOME session via reduceFor
   * (which doesn't notify — targeted opens must not re-render the active
   * session). The `pinnedRevision` state bump forces the pinnedEntries
   * useMemo to recompute after such an action.
   */
  const [activePinnedTabId, setActivePinnedTabId] = useState<string | null>(null)
  const [pinnedRevision, setPinnedRevision] = useState(0)

  /**
   * Cross-session pinned-tab collection. Recomputed on every store notify,
   * session-list change, and pinned action (the revision bump covers
   * reduceFor updates that don't notify). Only tabs from OTHER sessions —
   * the viewer's own pinned tabs are already on its tab strip.
   */
  const pinnedEntries: readonly PinnedTabEntry[] = useMemo(() => {
    if (sessionId === undefined) return []
    return collectPinnedTabs(store.getSessionStates(), { sessionId, cwd })
    // snapshot / pinnedRevision are deliberate cache-busters (see the comment
    // above): they recompute this memo for changes that carry no dep of their own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, sessionId, cwd, snapshot, pinnedRevision])

  /** Virtual SidebarTab objects for the pinned entries (stable references
   *  via useMemo so TabContent's memo comparator holds). */
  const pinnedVirtualTabs = useMemo(
    () => pinnedEntries.map(createPinnedVirtualTab),
    [pinnedEntries],
  )

  /** The right panel's split tree with pinned virtual tabs injected into the
   *  first leaf. When `activePinnedTabId` is set, that leaf's `active` is
   *  overridden so the pinned tab's content is visible. */
  const augmentedTree = useMemo(
    () => state === undefined ? undefined : injectPinnedIntoTree(state.splits, pinnedVirtualTabs, activePinnedTabId),
    [state, pinnedVirtualTabs, activePinnedTabId],
  )

  /**
   * Wrap the base actions to intercept pinned VIRTUAL tab ids (injected from
   * other sessions). Regular tab ids pass through unchanged. Virtual ids are
   * detected by the `pinned:` prefix and routed to the HOME session via
   * reduceFor (which doesn't notify — the revision bump is the local signal).
   */
  const wrappedActions = useMemo<WorkbenchActions>(() => {
    if (pinnedVirtualTabs.length === 0) return actions
    const closePinnedInHome = (virtualId: string): void => {
      const { homeSessionId, tabId: originalId } = parsePinnedVirtualId(virtualId)
      // The home cwd lives in the virtual tab's meta (snapshotted at pin
      // time) — pass it to ptyClose so the host resolves the PTY in the
      // correct workspace container (same scope the WS open used).
      const vtab = pinnedVirtualTabs.find(t => t.id === virtualId)
      const homeCwd = vtab !== undefined ? getPinnedHomeScope(vtab)?.cwd : undefined
      store.reduceFor(homeSessionId, s => {
        const leaf = leafWithTab(s.splits, originalId) ?? leafWithTab(s.bottomSplits, originalId)
        if (leaf !== undefined) return closeTab(s, leaf.id, originalId)
        if (s.floats.some(f => f.tab.id === originalId)) return closeFloatByTab(s, originalId)
        return s
      })
      if (isAgentTabId(originalId)) {
        void api.agentPtyClose(agentUuidOf(originalId)).catch(() => { /* already released */ })
      } else {
        void api.ptyClose({ sessionId: homeSessionId, ...(homeCwd !== undefined ? { cwd: homeCwd } : {}) }, originalId).catch(() => { /* already released */ })
      }
      if (activePinnedTabId === virtualId) setActivePinnedTabId(null)
      setPinnedRevision(v => v + 1)
    }
    return {
      ...actions,
      activateTab: (paneId, tabId) => {
        if (isPinnedVirtualId(tabId)) {
          setActivePinnedTabId(tabId)
        } else {
          setActivePinnedTabId(null)
          actions.activateTab(paneId, tabId)
        }
      },
      closeTab: (paneId, tabId) => {
        if (isPinnedVirtualId(tabId)) {
          closePinnedInHome(tabId)
        } else {
          actions.closeTab(paneId, tabId)
        }
      },
      moveTabBefore: (payload, toPane, beforeTabId) => {
        if (isPinnedVirtualId(payload.tabId)) return
        if (isPinnedVirtualId(beforeTabId)) {
          actions.moveTabToEdge(payload, toPane, 'center')
        } else {
          actions.moveTabBefore(payload, toPane, beforeTabId)
        }
      },
      moveTabToEdge: (payload, toPane, zone) => {
        if (isPinnedVirtualId(payload.tabId)) return
        actions.moveTabToEdge(payload, toPane, zone)
      },
      floatTab: (tabId) => {
        if (isPinnedVirtualId(tabId)) return
        actions.floatTab(tabId)
      },
      pinTab: (tabId, scope) => {
        if (isPinnedVirtualId(tabId)) {
          if (scope !== null) return
          const { homeSessionId, tabId: originalId } = parsePinnedVirtualId(tabId)
          store.reduceFor(homeSessionId, s => setTabPin(s, originalId, null))
          if (activePinnedTabId === tabId) setActivePinnedTabId(null)
          setPinnedRevision(v => v + 1)
        } else {
          actions.pinTab?.(tabId, scope)
        }
      },
    }
  }, [actions, pinnedVirtualTabs, activePinnedTabId, store])

  return { augmentedTree, wrappedActions }
}
