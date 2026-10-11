/**
 * Open-page reconciliation after a file-tree mutation (rename/delete).
 *
 * The tree owns the rows; the PAGES that display a file live in TWO carriers —
 * the bottom workbench's split trees (in the plugin store, per session) and the
 * native right Sidebar's tab records (in the native adapter). With the native
 * surface installed the editor lands on the right Sidebar by default, so a walk
 * over the bottom workbench alone missed the common case entirely (#915): after
 * a rename the page kept pointing at the old path, and its next save recreated
 * the renamed-away file.
 *
 * Both carriers therefore come from ONE place — the service's `pathTabs()`,
 * which also hands back the session each id belongs to (native ids restart per
 * session, so an id alone is ambiguous) — and both are acted on through the
 * SERVICE (`updateTab` / `closeTab`, with that session) rather than through
 * direct state reducers, so the registered lifecycle callbacks fire exactly as
 * they do for any other tab mutation.
 */
import type { Context } from '../context-types.ts'
import { baseName } from './FileTree.tsx'
import { confirmDiscardDraft } from './editor-dirty.ts'
import { isWithinWorkspace } from './paths.ts'

/**
 * How far `path` sits under `base`:
 * - `''` — it IS that file/directory (the renamed or deleted thing itself);
 * - `'sub/dir/file.ts'` — it is inside that directory;
 * - `undefined` — unrelated.
 *
 * Separators and case are compared the way the workspace fence compares them
 * ({@link isWithinWorkspace}: `\` and `/` are one separator, case-insensitive),
 * and the returned remainder is the normalized tail.
 */
function restUnder(path: string, base: string): string | undefined {
  if (!isWithinWorkspace(base, path)) return undefined
  const norm = (value: string): string => value.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  const b = norm(base)
  const p = norm(path)
  return p.length === b.length ? '' : p.slice(b.length + 1)
}

/**
 * Retarget every page showing the renamed file — or, when the renamed row is a
 * DIRECTORY, every page inside it (a rename moves the whole subtree, so a page
 * at `dir/a.ts` now lives at `newdir/a.ts`; keeping the old prefix made it read
 * a path that no longer exists, and its next save recreated the old directory).
 *
 * The title follows **only when it was derived from the file name**: an editor
 * page is titled with the basename (`openFile` titles it that way), while an
 * authored title (a side chat's thread name, a caller's own label) is not ours
 * to rewrite — and nothing derives from a directory's name, so descendants keep
 * their titles untouched.
 *
 * (The transient landing line a reference carried — #826 — is NOT this module's
 * business: `updateTab` drops it on any path change once #916 lands.)
 */
export function retargetPathTabs(ctx: Context, oldPath: string, newPath: string): void {
  const service = ctx.get('betterSidebar')
  if (service === undefined) return
  for (const tab of service.pathTabs()) {
    const rest = restUnder(tab.path, oldPath)
    if (rest === undefined) continue
    service.updateTab(
      tab.id,
      {
        path: rest === '' ? newPath : `${newPath}/${rest}`,
        // Only a DERIVED title follows the new name. A directory's rename keeps
        // every descendant's basename anyway, and an authored title is not ours.
        ...(rest === '' && tab.title === baseName(tab.path) ? { title: baseName(newPath) } : {}),
      },
      tab.sessionId,
    )
  }
}

/**
 * Close every page at or under the removed `target` — the file itself and
 * anything inside a removed directory (a stale page's next save would fail
 * against a missing path, or recreate it). A page holding an unsaved draft asks
 * first (the same guard + copy as the sidebar's tab close); declining keeps it —
 * its next save recreates the file, which is the user's call.
 *
 * The close names the page's OWN session: without it a record of a background
 * session would be looked up in the active one and silently survive.
 */
export function closePathTabs(ctx: Context, target: string, unsavedMessage: string): void {
  const service = ctx.get('betterSidebar')
  if (service === undefined) return
  for (const tab of service.pathTabs()) {
    if (restUnder(tab.path, target) === undefined) continue
    if (!confirmDiscardDraft(tab.id, unsavedMessage)) continue
    service.closeTab(tab.id, { sessionId: tab.sessionId })
  }
}
