/**
 * Adds a produced-files row to the chat's turn-tail list: a chip per file
 * the closing turn wrote or edited, opening in the sidebar instead of the
 * host OS. ui-deliverables' own turn-tail entry covers change announcements
 * and explicitly presented files under a different id, so this is an
 * additional row, not a takeover — `order: -1` only positions it ahead of
 * that entry when both render for the same turn.
 */
import { IconCodeOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import { revealPaths, type SidebarStore } from './state.ts'
import { t } from './locales.ts'
import { resolveSidebarPath, selectProducedFiles } from './produced-files.ts'
import css from './sidebar.module.css'

/** Registration-time seats plus the runtime owner currency the component reads its match from. */
type ProducedFilesTailProps = Record<string, unknown> & {
  openInSidebar: (path: string) => void
  onShowInFolder: (files: readonly string[]) => void
}

/** Open a file in the sidebar's editor (used by the intercepted row and the explorer). */
export function openSidebarFile(ctx: Context, store: SidebarStore, sessionId: string, path: string): void {
  const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
  const absolute = resolveSidebarPath(summary?.cwd, path)
  const at = Math.max(absolute.lastIndexOf('/'), absolute.lastIndexOf('\\'))
  const title = at === -1 ? absolute : absolute.slice(at + 1)
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
 * Register the turn-tail row (returns the disposer).
 *
 * The slot is a CHILD slot the host's ui-conversation declares in its
 * `conversation.chat.node` children table (kind: list, scope: session).
 * Registering it directly races the declaration — the ui-slots core's
 * load-time validation throws "not declared (a parent entry's children
 * table must declare it)" when the parent entry is not on the ledger yet.
 * slots.inject waits for the declaration: the callback runs synchronously
 * when the slot is already declared, otherwise it runs inside the declaring
 * register() call once the declaration commits; declaration collapse
 * disposes the entry and a later declaration re-registers it. This mirrors
 * @deepseek-ai/dsh-client-ui-deliverables' registration of the same slot.
 *
 * List entries carry no `select`: the ui-slots core mounts every registered
 * id unconditionally, so the "should this row render" decision (produced
 * files present, editor tab enabled, sidebar not suspended) moves into the
 * component itself, which returns null to render nothing.
 */
export function registerTurnTailInterception(ctx: Context, store: SidebarStore): () => void {
  function ProducedFilesTail(props: ProducedFilesTailProps) {
    // Decline while the editor tab type is disabled in the side card
    // settings (chips that cannot open must not be offered), or while the
    // sidebar is externally disabled (aionui-panel chosen) or suspended.
    if (store.getSuspended()) return null
    if (store.getPrefs().tabsEnabled['editor'] === false) return null
    const matched = selectProducedFiles(props)
    if (matched === null) return null
    return <SidebarProducedFiles matched={matched} openInSidebar={props.openInSidebar} onShowInFolder={props.onShowInFolder} />
  }
  return ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    id: 'dsh-better-sidebar:produced-files',
    order: -1,
    registrant: 'dsh-better-sidebar',
    inject: (sessionId: string) => ({
      openInSidebar: (path: string) => { openSidebarFile(ctx, store, sessionId, path) },
      onShowInFolder: (files: readonly string[]) => { revealInExplorer(ctx, store, sessionId, files) },
    }),
  }, ProducedFilesTail))
}
