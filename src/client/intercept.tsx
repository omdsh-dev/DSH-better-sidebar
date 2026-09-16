/**
 * Interception of the chat's produced-files row: the turn-tail chain entry
 * that replaces ui-deliverables' row when the closing turn produced files.
 * The takeover looks identical (same chip row); the chips open the file in
 * the sidebar instead of the host OS. Priority -1 runs before the default-0
 * deliverables entry; when nothing was produced the selector returns null
 * and the original row renders unchanged.
 */
import { IconCodeOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import { revealPaths, type SidebarStore } from './state.ts'
import { t } from './locales.ts'
import { resolveSidebarPath, selectProducedFiles } from './produced-files.ts'
import { fileAddressFor } from './resource-address.ts'
import css from './sidebar.module.css'

/** The id this plugin's own file editor registers its tab type under (`EDITOR_KIND`). */
const EDITOR_KIND = 'editor'

/** The native tab-registry slice this module probes: who would open an address. */
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
 * Whether a tab type other than this plugin's own editor claims `address`.
 *
 * This module names its `editor` type directly, which bypasses the native tab
 * registry: a type that explicitly claims a file kind (a `.drawio` canvas
 * registered with `extension` priority and a specific address glob, say) could
 * never open its own tab from the explorer or the produced-files row, even
 * though it wins the registry's ranking. Probing first fixes that without
 * changing any other file: for a file no other type claims, this plugin's
 * `editor` IS the best candidate, so the caller keeps its previous path
 * verbatim.
 *
 * @param ctx - client context; `ctx.get` is used because the registry is optional.
 * @param address - the `dsh-resource://file/…` address of the file being opened.
 * @returns true when another registered type owns the address.
 */
function claimedByAnotherType(ctx: Context, address: string): boolean {
  try {
    const tabs = ctx.get('sidebarRightTabs') as unknown as NativeTabRegistryProbe | undefined
    if (tabs === undefined || typeof tabs.candidates !== 'function') return false
    const best = tabs.candidates(address)[0]
    return best !== undefined && best.kind !== undefined && best.kind !== EDITOR_KIND
  } catch (error) {
    // Probing is best-effort: an incompatible registry keeps the old path.
    console.error('[dsh-better-sidebar] tab-claim probe failed', error)
    return false
  }
}

/** Open a file in the sidebar's editor (used by the intercepted row and the explorer). */
export function openSidebarFile(ctx: Context, store: SidebarStore, sessionId: string, path: string): void {
  const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
  const absolute = resolveSidebarPath(summary?.cwd, path)
  const at = Math.max(absolute.lastIndexOf('/'), absolute.lastIndexOf('\\'))
  const title = at === -1 ? absolute : absolute.slice(at + 1)
  // A type that explicitly claims this file owns it: open through the native
  // surface so that type's registered tab body renders instead of this plugin's
  // editor.
  const address = fileAddressFor(sessionId, summary?.cwd, path)
  if (claimedByAnotherType(ctx, address)) {
    const opener = ctx.get('sidebarRight') as unknown as NativeResourceOpener | undefined
    if (opener?.openResource !== undefined) {
      opener.openResource(address)
      return
    }
  }
  // Route through the sidebar service so the editor descriptor's dedupeKey
  // (per-path) applies; the id is path-derived so multiple editors coexist.
  ctx.get('betterSidebar')?.openTab({ type: 'editor', title, path: absolute, id: `editor:${absolute}` })
}

/**
 * Reveal the produced files in the sidebar explorer: expand their parent
 * directories, highlight the rows, and focus the explorer tab. Unknown
 * files fall back to revealing the workspace root itself.
 */
export function revealInExplorer(
  ctx: Context,
  store: SidebarStore,
  sessionId: string,
  files: readonly string[],
): void {
  const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
  const cwd = summary?.cwd
  // Deliverables report paths as-is (often relative to the session cwd), but
  // the explorer tree and revealPaths work on absolute paths — resolve every
  // target so the ancestors expand and the row actually matches.
  const targets = files.length > 0
    ? files.map(path => resolveSidebarPath(cwd, path))
    : cwd === undefined ? [] : [cwd]
  store.reduce(state => revealPaths(state, cwd, targets))
  // Focus the single-instance editor home tab (the files window) where the
  // reveal highlight renders. Read via ctx.get like every other internal
  // consumer (#357): the provider is not on this fiber chain, so a direct
  // ctx.betterSidebar read can throw before optional chaining applies.
  ctx.get('betterSidebar')?.openTab({ type: 'editor', title: t('files') })
}

/** The intercepted produced-files row (visual twin of the deliverables chips). */
export function SidebarProducedFiles(props: {
  matched: readonly string[]
  openInSidebar: (path: string) => void
  /** Reveal the produced files in the explorer ("Show in folder" twin). */
  onShowInFolder: (files: readonly string[]) => void
}) {
  const { matched, openInSidebar, onShowInFolder } = props
  const shown = matched.slice(0, 6)
  const hidden = matched.length - shown.length
  return (
    <div className={css.producedRow}>
      <span className={css.producedLabel}>{t('produced')}</span>
      {shown.map(path => {
        const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
        const name = at === -1 ? path : path.slice(at + 1)
        return (
          <button
            key={path}
            type="button"
            className={css.producedChip}
            title={path}
            onClick={() => { openInSidebar(path) }}
          >
            <IconCodeOutline16 size={12} />
            <span>{name}</span>
          </button>
        )
      })}
      {hidden > 0 && <span className={css.producedMore}>+{hidden}</span>}
      {hidden > 0 && (
        <button
          type="button"
          className={css.producedMore}
          style={{ cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}
          onClick={() => { onShowInFolder(matched) }}
        >
          {t('showInFolder')}
        </button>
      )}
    </div>
  )
}

/**
 * Register the turn-tail interception (returns the disposer).
 *
 * The slot is a CHILD slot the host's ui-conversation declares in its
 * `conversation.chat.node` children table (kind: chain, scope: session).
 * Registering it directly races the declaration — the ui-slots core's
 * load-time validation throws "not declared (a parent entry's children
 * table must declare it)" when the parent entry is not on the ledger yet.
 * slots.inject waits for the declaration: the callback runs synchronously
 * when the slot is already declared, otherwise it runs inside the declaring
 * register() call once the declaration commits; declaration collapse
 * disposes the entry and a later declaration re-registers it. This mirrors
 * @deepseek-ai/dsh-client-ui-deliverables' registration of the same slot.
 */
export function registerTurnTailInterception(ctx: Context, store: SidebarStore): () => void {
  return ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    // Decline the takeover while the editor tab type is disabled in the side
    // card settings: the produced-files row falls back to the default
    // deliverables behavior instead of offering chips that cannot open. Also
    // while the sidebar is externally disabled (aionui-panel chosen).
    select: (owner) => {
      if (store.getSuspended()) return null
      if (store.getPrefs().tabsEnabled['editor'] === false) return null
      return selectProducedFiles(owner)
    },
    priority: -1,
    registrant: 'dsh-better-sidebar',
    inject: (sessionId: string) => ({
      openInSidebar: (path: string) => { openSidebarFile(ctx, store, sessionId, path) },
      onShowInFolder: (files: readonly string[]) => { revealInExplorer(ctx, store, sessionId, files) },
    }),
  }, SidebarProducedFiles))
}
