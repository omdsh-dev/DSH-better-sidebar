/**
 * Opening one workspace file in the sidebar's editor tab.
 *
 * Extracted from the removed turn-tail interception (`intercept.tsx`): DSH
 * 0.1.6-alpha.2 turned `conversation.chat.turnTail` from a `chain` into an
 * additive `list`, so a plugin can no longer REPLACE the built-in
 * deliverables row — the plugin's own produced-files row became a duplicate
 * of a row the host already draws, and was deleted. The file-opening half is
 * the only part still used by the changes tab and the editor host.
 */
import type { Context } from '../context-types.ts'
import { resolveSidebarPath } from './paths.ts'

/**
 * Open a file in the sidebar's editor.
 *
 * Routes through the sidebar service so the editor descriptor's dedupeKey
 * (per-path) applies; the id is path-derived so multiple editors coexist.
 * @param ctx - client context carrying `betterSidebar`.
 * @param sessionId - the session whose cwd resolves a relative path.
 * @param path - absolute or session-relative file path.
 * @returns nothing.
 */
export function openSidebarFile(ctx: Context, sessionId: string, path: string): void {
  const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
  const absolute = resolveSidebarPath(summary?.cwd, path)
  const at = Math.max(absolute.lastIndexOf('/'), absolute.lastIndexOf('\\'))
  const title = at === -1 ? absolute : absolute.slice(at + 1)
  ctx.get('betterSidebar')?.openTab({ type: 'editor', title, path: absolute, id: `editor:${absolute}` })
}
