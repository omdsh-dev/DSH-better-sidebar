/**
 * Opening one workspace file in the sidebar — after asking DSH's native tab
 * registry which type owns it.
 *
 * Extracted from the removed turn-tail interception (`intercept.tsx`): DSH
 * 0.1.6-alpha.2 turned `conversation.chat.turnTail` from a `chain` into an
 * additive `list`, so a plugin can no longer REPLACE the built-in
 * deliverables row — the plugin's own produced-files row became a duplicate
 * of a row the host already draws, and was deleted. The file-opening half is
 * the only part still used by the changes tab and the editor host.
 *
 * Naming this plugin's own `editor` type directly used to bypass the native
 * tab registry (#695): a type that explicitly claims a file kind (a `.drawio`
 * canvas registered with `extension` priority and a specific address glob,
 * say) wins the registry's ranking — priority band, matched-pattern length,
 * registration order — yet could never render from these entry points, while
 * the same file opened from the chat (`ctx.sidebarRight.openResource`) did
 * reach it. With the native surface installed, `betterSidebar.openTab({type:
 * 'editor', path})` already resolves through the host's registry (openTab's
 * native branch turns the path seed into a resource address), but that
 * address carries no cwd, and merged-mode opens never went through openTab at
 * all. The probe below closes both gaps: open through the native surface
 * whenever a type other than the editor claims the address, and keep the
 * editor path verbatim for every other file.
 */
import type { Context } from '../context-types.ts'
import { resolveSidebarPath } from './paths.ts'
import { fileAddressFor } from './resource-address.ts'

/** The kind this plugin's own file editor registers its tab type under. */
const EDITOR_KIND = 'editor'

/**
 * The native tab-registry slice this module probes: who would open an address
 * (`ctx.sidebarRightTabs`, `SidebarRightTabRegistry` in DSH's
 * ui-sidebar-right — mirrored structurally, only `candidates` is read).
 */
interface NativeTabRegistryProbe {
  /**
   * Types that would open `address`, best first (priority band → matched
   * pattern length → registration order).
   */
  candidates(address: string): readonly { readonly kind?: string }[]
}

/** The native controller slice used to hand an address to the type claiming it. */
interface NativeResourceOpener {
  openResource(address: string): void
}

/**
 * The tab type that would open `address` besides this plugin's own editor.
 *
 * Probing is the whole fix for #695: the registry's ranking — not this
 * plugin's hard-coded `editor` — decides who owns a file address, and the
 * plugin itself already relies on that ranking (its editor holds
 * `dsh-resource://file/**` at the `extension` band, which is why it beats the
 * built-in `text` preview at `fallback` in the first place). For a file no
 * other type claims, the editor IS the best candidate, so the answer is
 * undefined and every caller keeps its previous path verbatim.
 *
 * @param ctx - client context; `ctx.get` is used because the registry is
 * optional (a stripped-down host may not provide it).
 * @param address - the `dsh-resource://file/…` address of the file being opened.
 * @returns the claiming type's kind, or undefined when the editor ranks first
 * (or the probe cannot run — the probe is best-effort by contract).
 */
export function claimingNativeKind(ctx: Context, address: string): string | undefined {
  try {
    const tabs = ctx.get('sidebarRightTabs') as unknown as NativeTabRegistryProbe | undefined
    if (tabs === undefined || typeof tabs.candidates !== 'function') return undefined
    const best = tabs.candidates(address)[0]
    return best !== undefined && best.kind !== undefined && best.kind !== EDITOR_KIND ? best.kind : undefined
  } catch (error) {
    // Probing is best-effort: an incompatible registry keeps the editor path.
    console.error('[dsh-better-sidebar] tab-claim probe failed', error)
    return undefined
  }
}

/**
 * Open one file through the native surface when a type other than this
 * plugin's editor claims it.
 *
 * The address is built WITH the session cwd (the same spelling the host's
 * conversation file links produce), so a claimed file opened here dedupes
 * against the tab the chat path already opened for the same file.
 *
 * @param ctx - client context (`sidebarRightTabs` for the probe,
 * `sidebarRight` for the open).
 * @param sessionId - the session whose workspace the path resolves in.
 * @param cwd - that session's workspace root, when known.
 * @param path - absolute or session-relative file path.
 * @returns true when the claiming type was handed the file; false leaves the
 * caller on its editor path (unclaimed file, no registry, or no surface).
 */
export function openClaimedNativeFile(ctx: Context, sessionId: string, cwd: string | undefined, path: string): boolean {
  const address = fileAddressFor(sessionId, cwd, path)
  if (claimingNativeKind(ctx, address) === undefined) return false
  let opener: NativeResourceOpener | undefined
  try {
    opener = ctx.get('sidebarRight') as unknown as NativeResourceOpener | undefined
  } catch {
    // The controller is probed, not injected: a host that has not provided
    // `sidebarRight` yet (or ever) leaves the file to the editor path below,
    // which the plugin's own surface wrapper can still queue until the host
    // service appears.
    opener = undefined
  }
  if (opener === undefined || typeof opener.openResource !== 'function') return false
  // No `kind` option: the host's own `claim(address)` re-runs the same
  // ranking the probe just read, so the claiming type's tab body renders.
  opener.openResource(address)
  return true
}

/**
 * Open a file in the sidebar's editor — unless a native type claims it.
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
  // A type that explicitly claims this file owns it: hand the address to the
  // native surface so that type's registered tab body renders instead of this
  // plugin's editor (#695). Every other file falls through to the editor.
  if (openClaimedNativeFile(ctx, sessionId, summary?.cwd, absolute)) return
  const at = Math.max(absolute.lastIndexOf('/'), absolute.lastIndexOf('\\'))
  const title = at === -1 ? absolute : absolute.slice(at + 1)
  ctx.get('betterSidebar')?.openTab({ type: 'editor', title, path: absolute, id: `editor:${absolute}` })
}
