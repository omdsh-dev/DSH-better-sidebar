/**
 * The host's OWN "subagent transcript in the right sidebar" affordance.
 *
 * DSH ships a native right-sidebar tab type for child transcripts
 * (`@deepseek-ai/dsh-client-ui-subagent`, kind `subagentchat`, registered at the
 * `builtin` band) and its subagent list already uses it: clicking a row opens
 * the transcript in the MAIN view, and the small chevron beside it opens the
 * same transcript in the sidebar. The Tasks page therefore hands the child over
 * instead of re-implementing a transcript pane — one click opens the native tab,
 * and the main column keeps whatever the reader was looking at.
 *
 * The address is `dsh-resource://subagentchat/session/<childId>?parent=&mode=`.
 * The host exports neither its builder nor its parser to third parties, so the
 * two lines below are a deliberate copy of the host's own formula; the parser
 * (`parseSubagentChatAddress`) is the contract that keeps them honest.
 *
 * Every failure path answers `false` so the caller can fall back to the
 * main-view jump it used before: a deployment without `ui-subagent` has no such
 * tab type at all, and the public write face THROWS when no session seat is
 * mounted (a global panel, a column that was never mounted).
 */
import type { Context, SidebarSubagentAddress } from '../context-types.ts'

/** The host's tab kind for an embedded child conversation. */
export const SUBAGENT_CHAT_KIND = 'subagentchat'

/** The host's `dsh-resource://` prefix for that tab type. */
export const SUBAGENT_CHAT_ADDRESS = 'dsh-resource://subagentchat/session/'

/** The tab registry, probed structurally (the service can arrive late). */
interface TabRegistryFace {
  get?(kind: string): unknown
}

/** The write face of the native right column, structurally probed. */
interface SidebarRightFace {
  openResource?(address: string, options?: { kind?: string; preferNewPane?: boolean }): void
}

/**
 * The host's own subagent-chat resource address for one child session.
 * @param address - the child's lineage (parent, child, mode).
 */
export function subagentChatAddress(address: SidebarSubagentAddress): string {
  const query = new URLSearchParams({ parent: address.parentSessionId, mode: address.mode })
  return `${SUBAGENT_CHAT_ADDRESS}${encodeURIComponent(address.childSessionId)}?${query}`
}

/** Whether the host can host a child transcript in its right column. */
export function hasTranscriptAside(ctx: Context): boolean {
  try {
    const tabs = ctx.get('sidebarRightTabs') as unknown as TabRegistryFace | undefined
    if (tabs?.get?.(SUBAGENT_CHAT_KIND) === undefined) return false
    return typeof (ctx.get('sidebarRight') as unknown as SidebarRightFace | undefined)?.openResource === 'function'
  } catch {
    return false
  }
}

/**
 * Open one child's transcript in the native right sidebar.
 *
 * @param ctx - the client context.
 * @param address - the child to open.
 * @returns whether the sidebar took it; `false` means the caller must fall back
 *   to the main-view jump (no such tab type, no right column, or the host threw
 *   because no session seat is mounted).
 */
export function openTranscriptAside(ctx: Context, address: SidebarSubagentAddress): boolean {
  if (!hasTranscriptAside(ctx)) return false
  try {
    const right = ctx.get('sidebarRight') as unknown as SidebarRightFace
    // `preferNewPane` mirrors the host's own subagent list: the transcript sits
    // beside whatever the reader already has open, and degrades to the target
    // pane when splitting is not allowed.
    right.openResource?.(subagentChatAddress(address), {
      kind: SUBAGENT_CHAT_KIND,
      preferNewPane: true,
    })
    return true
  } catch (error) {
    console.error('[dsh-better-sidebar] open the child transcript in the sidebar failed:', error)
    return false
  }
}
