/**
 * Open-tab reconciliation after a file-tree mutation (rename/delete).
 *
 * The tree owns the rows; the TABS live in the sidebar state (either split
 * tree, the bottom panel, or free windows). A rename must retarget every
 * tab whose `path` is the renamed file (the editor content survives and
 * later saves land on the new path); a delete must close every tab at or
 * under the removed path — files and anything inside a removed directory
 * (a stale tab's next save would fail against a missing path). Both ride
 * the SERVICE paths (`updateTab`/`closeTab`) rather than direct state
 * reducers so the registered lifecycle callbacks fire like any other tab
 * mutation.
 */
import type { Context } from '../context-types.ts'
import { baseName } from './FileTree.tsx'
import { allLeaves, type SidebarSnapshot, type SidebarStore, type SidebarTab } from './state.ts'
import { isWithinWorkspace } from './paths.ts'

/** Every open tab that carries a file path (either split tree, the bottom
 *  panel, and free windows — a floating tab is as open as a docked one). */
function pathTabsOf(snapshot: SidebarSnapshot): SidebarTab[] {
  const state = snapshot.state
  if (state === undefined) return []
  const tabs: SidebarTab[] = []
  for (const leaf of allLeaves(state.splits)) tabs.push(...leaf.tabs)
  for (const leaf of allLeaves(state.bottomSplits)) tabs.push(...leaf.tabs)
  for (const float of state.floats) tabs.push(float.tab)
  return tabs.filter(tab => tab.path !== undefined)
}

/** Retarget tabs after `oldPath` became `newPath` (title follows the new
 *  base name, matching how openFile titles editor tabs). */
export function retargetPathTabs(ctx: Context, store: SidebarStore, oldPath: string, newPath: string): void {
  const service = ctx.get('betterSidebar')
  if (service === undefined) return
  for (const tab of pathTabsOf(store.getSnapshot())) {
    if (tab.path === oldPath) service.updateTab(tab.id, { path: newPath, title: baseName(newPath) })
  }
}

/** Close tabs at or under the removed `target` (a directory takes its whole
 *  subtree of open files with it). */
export function closePathTabs(ctx: Context, store: SidebarStore, target: string): void {
  const service = ctx.get('betterSidebar')
  if (service === undefined) return
  for (const tab of pathTabsOf(store.getSnapshot())) {
    const path = tab.path
    if (path !== undefined && (path === target || isWithinWorkspace(target, path))) service.closeTab(tab.id)
  }
}
