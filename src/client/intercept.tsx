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
import { firstLeaf, revealPaths, togglePanel, type SidebarStore } from './state.ts'
import { t } from './locales.ts'
import { resolveSidebarPath, selectProducedFiles } from './produced-files.ts'
import { wrapOpenPath } from './openpath-intercept.ts'
import { api } from './api.ts'
import { buildCommitDiffTab, buildEditDiffTab, deriveEditDiffTarget } from './edit-diff.ts'
import { relativeTo } from './paths.ts'
import { applyChatPreview, CHAT_PREVIEW_TAB_ID } from './chat-preview.ts'
import css from './sidebar.module.css'

/**
 * Open a file in the sidebar's editor (used by the explorer and explicit
 * "open in editor" actions). Unlike {@link openSidebarFile}, this path never
 * opens a diff — it always routes to the editor tab.
 * @param ctx - client cordis context.
 * @param store - per-session sidebar store.
 * @param sessionId - owning session.
 * @param path - file path (relative to the session cwd or absolute).
 */
export function openSidebarEditorFile(ctx: Context, store: SidebarStore, sessionId: string, path: string): void {
  const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
  const absolute = resolveSidebarPath(summary?.cwd, path)
  const at = Math.max(absolute.lastIndexOf('/'), absolute.lastIndexOf('\\'))
  const title = at === -1 ? absolute : absolute.slice(at + 1)
  // Route through the sidebar service so the editor descriptor's dedupeKey
  // (per-path) applies; the id is path-derived so multiple editors coexist.
  ctx.get('betterSidebar')?.openTab({ type: 'editor', title, path: absolute, id: `editor:${absolute}` })
}

/**
 * Open a file triggered by the chat's edit-tool path links (via
 * `ctx.workspaces.openPath`). Chat opens always reuse a single preview tab
 * (`chat-preview`): switching files replaces its content in place instead of
 * creating a new tab. The preview bypasses the editor's per-path dedupe so
 * the seed never lands in an existing resident editor tab. When the
 * `editOpensDiff` pref is on (default) the preview opens as a git worktree
 * diff tab; otherwise it falls back to the editor. The diff probe reaches
 * the file's owning repository directly (`git.status-at`). The preview type
 * cannot be patched for diff (DiffTab reloads on diff reference), so a diff
 * replacement closes and recreates the tab. Panel visibility is ensured for
 * pane-hosted previews (expand + pin to the right panel); a floating preview
 * stays floating only for editor→editor replacements.
 * @param ctx - client cordis context.
 * @param store - per-session sidebar store.
 * @param sessionId - owning session.
 * @param path - file path (relative to the session cwd or absolute).
 */
export async function openSidebarFile(ctx: Context, store: SidebarStore, sessionId: string, path: string): Promise<void> {
  const prefs = store.getPrefs()
  const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
  const cwd = summary?.cwd
  const absolute = resolveSidebarPath(cwd, path)
  let previewTab: import('./state.ts').SidebarTab | null = null
  const canProbeDiff = prefs.editOpensDiff !== false && prefs.tabsEnabled['diff'] !== false
  if (canProbeDiff) {
    try {
      const scope = { sessionId, ...(cwd !== undefined ? { cwd } : {}) } as { sessionId: string; cwd?: string }
      const status = await api.gitStatusAt(scope, absolute)
      const target = deriveEditDiffTarget(absolute, status)
      if (target !== null) {
        const seed = buildEditDiffTab(target.relative, target.repoRoot, target.untracked)
        previewTab = { ...seed, id: CHAT_PREVIEW_TAB_ID, title: seed.title ?? target.relative.split('/').pop() ?? target.relative } as import('./state.ts').SidebarTab
      } else {
        try {
          const last = await api.gitLastCommitAt(scope, absolute)
          if (last.commit !== null) {
            const rel = relativeTo(last.commit.repoRoot, absolute)
            if (rel !== '.' && rel !== absolute) {
              const seed = buildCommitDiffTab({
                relative: rel,
                repoRoot: last.commit.repoRoot,
                hash: last.commit.hash,
                hashFull: last.commit.hashFull,
                subject: last.commit.subject,
              })
              previewTab = { ...seed, id: CHAT_PREVIEW_TAB_ID, title: seed.title ?? rel.split('/').pop() ?? rel } as import('./state.ts').SidebarTab
            }
          }
        } catch {
          // Last-commit probe failed (network, not a repo, fence): fall through to editor.
        }
      }
    } catch {
      // Probe failed (network, not a repo, host degraded): fall through to editor preview.
    }
  }
  if (previewTab === null) {
    const at = Math.max(absolute.lastIndexOf('/'), absolute.lastIndexOf('\\'))
    const title = at === -1 ? absolute : absolute.slice(at + 1)
    previewTab = { id: CHAT_PREVIEW_TAB_ID, type: 'editor', title, path: absolute }
  }
  // Bypass service.openTab's dedupe (editor dedupes by path) and manipulate
  // the store directly so the fixed preview id always reuses the same tab.
  applyChatPreview(store, previewTab)
  void ctx
}

/**
 * The produced files the turn-tail selector last matched for the visible
 * session. The "Show in folder" gesture carries no file path of its own
 * (`'.'`), so the reveal highlights exactly these rows when available.
 */
let lastProduced: readonly string[] = []

/**
 * Reveal the produced files in the sidebar explorer: expand their parent
 * directories, highlight the rows, and focus the explorer tab (expanding the
 * hosting panel when it is collapsed). Unknown files fall back to revealing
 * the workspace root itself.
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
  // A type-only open never auto-expands the panel (only content opens do,
  // see service.openTab) — so a reveal opens the panel itself when it is
  // collapsed, exactly like the subagent auto-open flows, or the highlight
  // would be set on an invisible panel.
  store.reduce(s => (s.panelOpen ? s : togglePanel(s)))
  // Pin the landing to the right panel: the files window must appear where
  // the panel just expanded, not in a bottom-panel pane the user last
  // touched.
  store.reduce(s => ({ ...s, activePane: firstLeaf(s.splits).id }))
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
      const matched = selectProducedFiles(owner)
      if (matched !== null) lastProduced = matched
      return matched
    },
    priority: -1,
    registrant: 'dsh-better-sidebar',
    inject: (sessionId: string) => ({
      openInSidebar: (path: string) => { void openSidebarFile(ctx, store, sessionId, path) },
      onShowInFolder: (files: readonly string[]) => { revealInExplorer(ctx, store, sessionId, files) },
    }),
  }, SidebarProducedFiles))
}

/**
 * Register the chat file-open interception: wraps `ctx.workspaces.openPath`
 * — the single funnel every chat-side file open goes through (tool-row path
 * links, the produced-files row, prose mentions) — so opens land in the
 * sidebar editor instead of the Host OS. The folder-reveal gesture ("Show in
 * folder" passes `'.'`) is the one exception: it is routed to the explorer.
 * Gated by BOTH the `interceptOpenPath` pref and the editor tab's enable
 * switch; declined opens fall through to the original method. Returns the
 * disposer restoring the original (HMR-safe).
 */
export function registerOpenPathInterception(ctx: Context, store: SidebarStore): () => void {
  return wrapOpenPath(ctx.workspaces, {
    takeoverEnabled: () => !store.getSuspended()
      && store.getPrefs().interceptOpenPath !== false
      && store.getPrefs().tabsEnabled['editor'] !== false,
    currentSessionId: () => ctx.sessions.list.getSnapshot().current,
    openInSidebar: (path, sessionId) => { void openSidebarFile(ctx, store, sessionId, path) },
    revealInExplorer: (_path, sessionId) => { revealInExplorer(ctx, store, sessionId, lastProduced) },
  })
}
