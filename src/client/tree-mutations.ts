/**
 * Open-tab reconciliation after a file-tree mutation (rename/delete).
 *
 * The tree owns the rows; the TABS live in TWO spaces: the bottom workbench's
 * split tree (the sidebar state) and — where files actually open by default —
 * DSH's native right Sidebar, whose records the store cannot see (they are
 * reported by {@link SidebarSurface.pathTabs}, read through the service). Both
 * are walked here: skipping the native one left every right-column editor bound
 * to the OLD path, so its next save wrote a name the user had just renamed away
 * (recreating it) and a deleted file came back with no prompt.
 *
 * A rename must retarget every tab at the renamed path — files, and anything
 * under a renamed directory (the same subtree rule the delete path already
 * had) — so the editor content survives and later saves land on the new path;
 * a delete must close every tab at or under the removed path. Both ride the
 * SERVICE paths (`updateTab`/`closeTab`) rather than direct state reducers so
 * the registered lifecycle callbacks fire like any other tab mutation.
 *
 * The walk covers EVERY session the store has cached, not just the one on
 * screen: the bottom workbench is per session, and a background conversation's
 * file page has the same next-save hazard. Each row therefore names its own
 * session, and the writes go to that session (`updateTab`/`closeTab` take the
 * targeted channel for a session that is not on screen).
 */
import type { Context } from '../context-types.ts'
import type { NativePathTab } from './service.ts'
import { baseName, isWithinWorkspace, relativeTo, resolveSidebarPath } from './paths.ts'
import { confirmDiscardDraft } from './editor-dirty.ts'
import { allLeaves, type SidebarStore } from './state.ts'

/** One open tab that carries a file path, and the space it lives in. */
interface PathTab {
  /** The rename-marker key ({@link pathTabKey}). */
  key: string
  id: string
  /** The path in the tab's OWN spelling: what its editor holds, compares and
   *  marks against. */
  path: string
  /** The same path resolved against the session cwd. The tree hands this module
   *  ABSOLUTE paths while a tab opened from a chat link carries the address's
   *  workspace-relative spelling, so every comparison runs here. */
  absolute: string
  /** The session this tab's EDITOR reads and writes in — the `scope.sessionId`
   *  its host registers the unsaved draft under, so it is the one the close
   *  guard has to name. Absent only for a native tab whose address named no
   *  session (the guard then reads conservatively rather than missing the
   *  record and closing a live draft without asking). */
  scopeSessionId: string | undefined
  /** The tab's current title — the rename reconciliation retitles a page only
   *  when this is the file name the tree itself wrote there. */
  title: string
  /** The session the tab is WRITTEN through: the native record's seat, or the
   *  bottom-workbench row's own session — every row names its session now, so a
   *  background conversation's pages are patched in place instead of resolving
   *  against whatever session happens to be on screen. */
  sessionId: string
}

/**
 * The rename-marker key for one tab: the session its editor runs in, plus the
 * tab id.
 *
 * Native tab ids restart per session — `tab1` exists in every conversation —
 * so the id alone is not an identity. Keyed by the id alone, two seats' editors
 * shared one marker, and an editor whose own path did NOT move (its effect
 * clears the marker it finds) wiped the other seat's pending move; that other
 * editor then reloaded the renamed file and dropped the draft this whole
 * mechanism exists to protect. The session half is the one the editor reads in
 * its `scope.sessionId`, so the writers here and the reader in `EditorHost`
 * build the same key.
 */
export function pathTabKey(sessionId: string, tabId: string): string {
  return `${sessionId}\u0000${tabId}`
}

/** One announced move: the path a tab had, and the one it was re-pointed to. */
interface Retarget {
  from: string
  to: string
}

/**
 * Retargets a rename has announced — the editor's side of the move.
 *
 * A tab is re-pointed by patching its `path`, and the editor host reloads
 * whenever that path changes. Reloading a renamed file would swap the loaded
 * document for the very same bytes while dropping the draft that lives only in
 * the editor instance, so the retarget announces itself here instead: the
 * editor keeps its document and the next save simply lands on the new name.
 *
 * A list per key rather than one slot: two tabs can still share a key (two
 * seats showing the same session's file under the same id), and each of them
 * has to claim the move on its own.
 */
const retargetedPaths = new Map<string, Retarget[]>()

/** Announce that `key`'s file moved from `from` to `to`. */
function markRetargetedPath(key: string, from: string, to: string): void {
  const pending = retargetedPaths.get(key)
  if (pending === undefined) retargetedPaths.set(key, [{ from, to }])
  else pending.push({ from, to })
}

/** Whether this exact move is one `key` has not applied yet. Consumes it: a
 *  tab that never sees the move must not swallow a later, unrelated one. */
export function consumeRetargetedPath(key: string, from: string, to: string): boolean {
  const pending = retargetedPaths.get(key)
  if (pending === undefined) return false
  const at = pending.findIndex(entry => entry.from === from && entry.to === to)
  if (at === -1) return false
  pending.splice(at, 1)
  if (pending.length === 0) retargetedPaths.delete(key)
  return true
}

/** Forget a key's pending retargets. Called where the announcement can no
 *  longer be claimed — the editor unmounted (a fresh mount loads the record's
 *  current path anyway), loaded something else, or its tab is being closed —
 *  so the map cannot grow for the life of the page. */
export function clearRetargetedPath(key: string): void {
  retargetedPaths.delete(key)
}

/** Every open tab that carries a file path, from BOTH tab spaces — the bottom
 *  workbench of EVERY cached session, and the native records. */
function pathTabsOf(store: SidebarStore, native: readonly NativePathTab[]): PathTab[] {
  const tabs: PathTab[] = []
  // Every session the store has cached, not just the one on screen: a
  // conversation the reader is not looking at can hold file pages of its own
  // (a `target: 'bottom'` open, a layout persisted back when files landed in
  // the workbench), and a rename/delete has to reach them too — the first save
  // after switching back would otherwise recreate the renamed-away file, which
  // is the very data problem this module exists to prevent. Each row therefore
  // carries its OWN session: it is both the identity half of the rename marker
  // and the channel its write goes through.
  for (const [sessionId, state] of store.getSessionStates()) {
    for (const leaf of allLeaves(state.bottomSplits)) {
      for (const tab of leaf.tabs) {
        // A bottom-workbench row carries an absolute path already, and it is the
        // same string the tree hands this module — one spelling, both fields.
        if (tab.path === undefined) continue
        tabs.push({
          key: pathTabKey(sessionId, tab.id),
          id: tab.id,
          path: tab.path,
          title: tab.title,
          absolute: tab.path,
          scopeSessionId: sessionId,
          sessionId,
        })
      }
    }
  }
  for (const tab of native) {
    tabs.push({
      key: pathTabKey(tab.scopeSessionId, tab.id),
      id: tab.id,
      path: tab.path,
      title: tab.title,
      // A chat link opens its tab with the ADDRESS's path, and `fileAddressFor`
      // spells that workspace-relative whenever it knows the cwd. Comparing it
      // raw against the tree's absolute paths skipped exactly those tabs, so the
      // comparison runs on the resolved form while the tab keeps its spelling.
      absolute: resolveSidebarPath(tab.cwd, tab.path),
      // The SEAT session (below) keys the record; THIS one is the namespace the
      // editor behind it runs in, and a file address may name a session other
      // than the column it is drawn in.
      scopeSessionId: tab.scopeSessionId,
      sessionId: tab.sessionId,
    })
  }
  return tabs
}

/**
 * Where `path` moves to when `oldPath` (a file OR a directory) became
 * `newPath`, or undefined when the tab is unaffected. A renamed directory
 * takes its subtree along, so `dir/a.ts` follows `dir` → `renamed` — the same
 * containment rule the delete path uses.
 */
function movedPath(path: string, oldPath: string, newPath: string): string | undefined {
  if (!isWithinWorkspace(oldPath, path)) return undefined
  // `relativeTo` owns the base→tail projection (separator and letter-case
  // policy), and its `.` doubles as the equality test: a raw string compare
  // missed `E:/a` vs `E:\a` and then spliced a stray `/.` onto the new name.
  const tail = relativeTo(oldPath, path)
  return tail === '.' ? newPath : `${newPath}/${tail}`
}

/** Retarget tabs after `oldPath` became `newPath`.
 *
 *  Files and anything under a renamed DIRECTORY are retargeted — the same
 *  subtree rule the delete path uses — in EVERY session the store has cached.
 *  The move is announced through {@link markRetargetedPath} so the editor keeps
 *  its document (and an unsaved draft) instead of reloading the new name.
 *
 *  The TITLE follows only when it was DERIVED from the file name — an editor
 *  page opened the way the plugin opens one is titled with the basename, so a
 *  rename has to carry it along; a title its author chose is not the tree's to
 *  rewrite. The host's agent-opens push is the live case: the model asks for a
 *  file with a title of its own (`use-host-feeds` → `openFile(scope, path,
 *  title)`), and a consumer plugin may label a page itself. A directory rename
 *  never retitles a descendant anyway (their basenames do not change), so this
 *  is the same rule seen from the file side. */
export function retargetPathTabs(ctx: Context, store: SidebarStore, oldPath: string, newPath: string): void {
  const service = ctx.get('betterSidebar')
  if (service === undefined) return
  for (const tab of pathTabsOf(store, service.nativePathTabs())) {
    const moved = movedPath(tab.absolute, oldPath, newPath)
    if (moved === undefined) continue
    // The announcement has to match what the editor will see: it compares the
    // path it holds (the tab's own spelling) with the one written here.
    markRetargetedPath(tab.key, tab.path, moved)
    service.updateTab(tab.id, {
      path: moved,
      // Only a DERIVED title follows the new name: `baseName(tab.path)` is the
      // spelling the opener would have written, so a title that differs is one
      // somebody chose.
      ...(tab.title === baseName(tab.path) ? { title: baseName(moved) } : {}),
    }, tab.sessionId)
  }
}

/** Close tabs at or under the removed `target` (a directory takes its whole
 *  subtree of open files with it). A tab holding an unsaved draft asks first
 *  (the same guard + copy as the sidebar's tab close); declining keeps the
 *  tab — which is the user's call for the bottom workbench, and stays a
 *  conflict-gated save on the native side, never a silent re-create.
 *
 *  The question is asked in the tab's OWN session: the draft registry is keyed
 *  by `sessionId::tabId`, so a bare id read would look up a same-numbered tab in
 *  some other session (or nothing at all) and close a live draft unprompted.
 *  Every session the store has cached is walked (a background conversation's
 *  page would otherwise come back with its next save). */
export function closePathTabs(ctx: Context, store: SidebarStore, target: string, unsavedMessage: string): void {
  const service = ctx.get('betterSidebar')
  if (service === undefined) return
  for (const tab of pathTabsOf(store, service.nativePathTabs())) {
    // `isWithinWorkspace` is true for the target itself too, so one test covers
    // both "this exact file" and "anything under this directory".
    if (!isWithinWorkspace(target, tab.absolute)) continue
    if (!confirmDiscardDraft(tab.id, unsavedMessage, tab.scopeSessionId)) continue
    // The tab is going away: a move announced for it can never be claimed.
    clearRetargetedPath(tab.key)
    service.closeTab(tab.id, { sessionId: tab.sessionId })
  }
}
