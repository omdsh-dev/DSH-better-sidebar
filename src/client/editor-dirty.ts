/**
 * Unsaved-edit registry: which editor tabs currently hold a draft that
 * differs from disk. The editor host registers its tab's dirty state here
 * (the toolbar report already carries it), so the flows that would silently
 * drop the draft can ask first:
 *
 * - the sidebar's tab close (the X button, the middle click, the tab context
 *   menu, and the tree's close-on-rename/delete path all land there),
 * - the browser unload (refresh / close tab / navigate away) through a
 *   `beforeunload` guard.
 *
 * Module-level and keyed by tab id — the same "one instance per client plugin
 * activation" lifetime the store has, since the module only loads with the
 * client bundle. An entry is written while a tab is dirty and deleted the
 * moment it goes clean (save) or its host unmounts (tab closed, session
 * switched), so a stale entry can never keep a guard armed.
 */

/** One registered draft: the owning session (the guard's scope) and the file. */
interface DirtyEntry {
  sessionId: string
  path: string
}

const dirtyTabs = new Map<string, DirtyEntry>()
const listeners = new Set<() => void>()
/** Monotonic change counter: a stable `useSyncExternalStore` snapshot. */
let revision = 0

/** Notify every subscriber (the `beforeunload` guard). */
function notify(): void {
  revision += 1
  for (const listener of [...listeners]) listener()
}

/**
 * Publish one tab's dirty state: `true` registers the draft (session + path
 * ride along for scoped queries), `false` / `undefined` clears it.
 */
export function setEditorDirty(tabId: string, dirty: boolean, sessionId: string, path: string): void {
  const had = dirtyTabs.has(tabId)
  if (!dirty) {
    if (had) {
      dirtyTabs.delete(tabId)
      notify()
    }
    return
  }
  const previous = dirtyTabs.get(tabId)
  if (previous !== undefined && previous.sessionId === sessionId && previous.path === path) return
  dirtyTabs.set(tabId, { sessionId, path })
  notify()
}

/** Drop a tab's entry (its editor host unmounted). Idempotent. */
export function clearEditorDirty(tabId: string): void {
  if (dirtyTabs.delete(tabId)) notify()
}

/** Whether one tab holds an unsaved draft. */
export function isEditorDirty(tabId: string): boolean {
  return dirtyTabs.has(tabId)
}

/** How many tabs of one session hold unsaved drafts. */
export function dirtyCountForSession(sessionId: string): number {
  let count = 0
  for (const entry of dirtyTabs.values()) {
    if (entry.sessionId === sessionId) count += 1
  }
  return count
}

/** How many tabs hold unsaved drafts across every session (the unload guard). */
export function dirtyCount(): number {
  return dirtyTabs.size
}

/** Subscribe to dirty-set changes; returns the disposer. */
export function subscribeEditorDirty(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The change counter (a stable `useSyncExternalStore` snapshot). */
export function editorDirtyRevision(): number {
  return revision
}

/**
 * Ask before dropping `tabId`'s unsaved draft. Returns true when the caller
 * may proceed (the tab is clean, the user confirmed, or no `confirm` is
 * available — the same fallback the refresh guard uses). On confirm the
 * entry is cleared immediately, so a follow-up close in the same tick does
 * not double-prompt; the editor host's own cleanup would do it one commit
 * later anyway.
 *
 * Shared by the sidebar's tab close and the file tree's close-on-delete so
 * both paths warn exactly once, with the same copy.
 */
export function confirmDiscardDraft(tabId: string, message: string): boolean {
  if (!dirtyTabs.has(tabId)) return true
  const confirmed = typeof window.confirm === 'function' ? window.confirm(message) : true
  if (confirmed) clearEditorDirty(tabId)
  return confirmed
}
