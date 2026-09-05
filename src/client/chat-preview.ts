/**
 * Chat preview tab (VSCode preview semantics): a single reusable tab for
 * file opens triggered from the chat. The chat's edit/write links always
 * reuse one tab id (`chat-preview`); switching files replaces its content
 * in place. FileTree / editor menu opens keep per-file tabs.
 * @module dsh-better-sidebar/client/chat-preview
 */
import {
  activateTab,
  allLeaves,
  closeFloatByTab,
  closeTab,
  firstLeaf,
  floatWithTab,
  openTabInActivePane,
  patchTab,
  raiseFloat,
  togglePanel,
  type SidebarStore,
  type SidebarTab,
  type SidebarState,
} from './state.ts'

/** Fixed id of the single chat preview tab. */
export const CHAT_PREVIEW_TAB_ID = 'chat-preview'

/**
 * Locate the preview tab across both panel trees and floating windows.
 * @param state - per-session sidebar state.
 * @returns location descriptor, or null when no preview tab exists.
 */
export function locatePreviewTab(
  state: SidebarState,
): { where: 'pane'; paneId: string; tab: SidebarTab } | { where: 'float'; floatId: string; tab: SidebarTab } | null {
  for (const leaf of allLeaves(state.splits).concat(allLeaves(state.bottomSplits))) {
    const tab = leaf.tabs.find(candidate => candidate.id === CHAT_PREVIEW_TAB_ID)
    if (tab !== undefined) return { where: 'pane', paneId: leaf.id, tab }
  }
  const floated = floatWithTab(state, CHAT_PREVIEW_TAB_ID)
  if (floated !== undefined) return { where: 'float', floatId: floated.id, tab: floated.tab }
  return null
}

/**
 * Whether a preview tab is currently open in any pane or float.
 * @param state - per-session sidebar state.
 * @returns true when the preview tab exists.
 */
export function hasPreviewTab(state: SidebarState): boolean {
  return locatePreviewTab(state) !== null
}

/**
 * Apply a preview tab to the store, reusing the single fixed id.
 *
 * Contract: the chat's file opens always land in one tab. Switching files
 * replaces its content in place without creating a second tab. The editor
 * path update uses `patchTab` so the tab keeps its id and meta while the
 * EditorHost reloads on path change; diff tabs are recreated because patch
 * cannot change the diff reference. A floating preview stays floating only
 * for editor→editor replacements; every other transition closes the float
 * and recreates the tab in the right panel.
 *
 * Panel visibility: when the preview lives in a pane (or does not yet
 * exist), the right panel is expanded if collapsed and `activePane` is
 * pinned to the right tree's first leaf so the preview lands in sight.
 * A floating preview is already in sight and needs no panel change
 * (editor→editor raises the float, otherwise the float is closed).
 *
 * @param store - per-session sidebar store.
 * @param tab - preview tab to show. Must carry id `chat-preview`; type is
 * `editor` (with path/title) or `diff` (with diff/title). The caller
 * constructs it from the probed git status.
 */
export function applyChatPreview(store: SidebarStore, tab: SidebarTab): void {
  const snapshot = store.getSnapshot()
  const state = snapshot.state
  if (state === undefined) return
  const located = locatePreviewTab(state)

  // No existing preview: ensure panel visible, pin to right, then land.
  if (located === null) {
    store.reduce(s => (s.panelOpen ? s : togglePanel(s)))
    store.reduce(s => ({ ...s, activePane: firstLeaf(s.splits).id }))
    store.reduce(s => openTabInActivePane(s, tab))
    return
  }

  // Preview is floating.
  if (located.where === 'float') {
    // Editor → editor keeps the float: patch in place and raise.
    if (located.tab.type === 'editor' && tab.type === 'editor') {
      store.reduce(s => patchTab(s, CHAT_PREVIEW_TAB_ID, { title: tab.title, path: tab.path, meta: tab.meta }))
      store.reduce(s => {
        const floated = floatWithTab(s, CHAT_PREVIEW_TAB_ID)
        return floated !== undefined ? raiseFloat(s, floated.id) : s
      })
      return
    }
    // Every other transition (diff involved or type swap): close the float
    // and recreate in the right panel.
    store.reduce(s => closeFloatByTab(s, CHAT_PREVIEW_TAB_ID))
    store.reduce(s => (s.panelOpen ? s : togglePanel(s)))
    store.reduce(s => ({ ...s, activePane: firstLeaf(s.splits).id }))
    store.reduce(s => openTabInActivePane(s, tab))
    return
  }

  // Preview is docked in a pane.
  const paneId = located.paneId
  // Same type editor: patch in place and focus.
  if (located.tab.type === 'editor' && tab.type === 'editor') {
    store.reduce(s => patchTab(s, CHAT_PREVIEW_TAB_ID, { title: tab.title, path: tab.path, meta: tab.meta }))
    store.reduce(s => activateTab(s, paneId, CHAT_PREVIEW_TAB_ID))
    // Ensure visible: expand + pin to right (only when not floating).
    store.reduce(s => (s.panelOpen ? s : togglePanel(s)))
    store.reduce(s => ({ ...s, activePane: firstLeaf(s.splits).id }))
    return
  }
  // Diff → diff, or any type swap: close and recreate (diff cannot be patched).
  store.reduce(s => closeTab(s, paneId, CHAT_PREVIEW_TAB_ID))
  store.reduce(s => (s.panelOpen ? s : togglePanel(s)))
  store.reduce(s => ({ ...s, activePane: firstLeaf(s.splits).id }))
  store.reduce(s => openTabInActivePane(s, tab))
}
