/**
 * Interception of the chat's produced-files row: the turn-tail chain entry
 * that replaces ui-deliverables' row when the closing turn produced files.
 * The takeover looks identical (same chip row); the chips open the file in
 * the sidebar instead of the host OS. Priority -1 runs before the default-0
 * deliverables entry; when nothing was produced the selector returns null
 * and the original row renders unchanged.
 *
 * Also home to the chat file-open interception (wrapOpenPath) and the
 * `chatFileMentions` mention interception (path / `path:line` links in
 * settled chat text — see chat-mentions.ts).
 */
import { IconCodeOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import type { SidebarStore } from './state.ts'
import { t } from './locales.ts'
import { api } from './api.ts'
import { resolveSidebarPath, selectProducedFiles } from './produced-files.ts'
import { wrapOpenPath } from './openpath-intercept.ts'
import { wrapChatFileMentions, type ChatFileMentionsService } from './chat-mentions.ts'
import { createPathVerifier } from './verified-paths.ts'
import { parsePathLine, type LineRange } from './path-line.ts'
import css from './sidebar.module.css'

/**
 * Open a file in the sidebar's editor (used by the intercepted row, the
 * explorer, and the open-path / mention interceptions). An optional line
 * range rides the editor tab's `meta` so the code viewer jumps to it; a
 * dedupe FOCUS (the file is already open) pushes the jump through
 * `updateTab` — otherwise the existing tab's meta would stay stale. Passing
 * `null` line clears a stale jump on a plain reopen.
 */
export function openSidebarFile(
  ctx: Context,
  store: SidebarStore,
  sessionId: string,
  path: string,
  line?: LineRange | null,
): void {
  const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
  const absolute = resolveSidebarPath(summary?.cwd, path)
  const at = Math.max(absolute.lastIndexOf('/'), absolute.lastIndexOf('\\'))
  const title = at === -1 ? absolute : absolute.slice(at + 1)
  // Route through the sidebar service so the editor descriptor's dedupeKey
  // (per-path) applies; the id is path-derived so multiple editors coexist.
  const id = `editor:${absolute}`
  const jumpMeta = line !== undefined && line !== null ? { line: { start: line.start, end: line.end } } : undefined
  const exists = store.tabOpen(sessionId, id)
  ctx.betterSidebar?.openTab({
    type: 'editor',
    title,
    path: absolute,
    id,
    ...(jumpMeta !== undefined ? { meta: jumpMeta } : {}),
  })
  if (exists) {
    // The tab was focused, not created — its meta was NOT updated by the
    // open: push the jump (or clear a stale one) explicitly.
    ctx.betterSidebar?.updateTab(id, jumpMeta !== undefined ? { meta: jumpMeta } : { meta: null })
  }
}

/** The intercepted produced-files row (visual twin of the deliverables chips). */
export function SidebarProducedFiles(props: {
  matched: readonly string[]
  openInSidebar: (path: string) => void
}) {
  const { matched, openInSidebar } = props
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
    }),
  }, SidebarProducedFiles))
}

/**
 * Register the chat file-open interception: wraps `ctx.workspaces.openPath`
 * — the single funnel every chat-side file open goes through (tool-row path
 * links, the produced-files row, prose mentions) — so opens land in the
 * sidebar editor instead of the Host OS. Gated by BOTH the `interceptOpenPath`
 * pref and the editor tab's enable switch; declined opens fall through to
 * the original method. Returns the disposer restoring the original (HMR-safe).
 *
 * The path may carry a line suffix appended by the path:line mention
 * interception (`/cwd/src/foo.ts:42`); it is split off BEFORE the editor
 * open, so the editor never reads a file literally named `foo.ts:42` and the
 * jump lands on the right tab meta.
 */
export function registerOpenPathInterception(ctx: Context, store: SidebarStore): () => void {
  return wrapOpenPath(ctx.workspaces, {
    takeoverEnabled: () => !store.getSuspended()
      && store.getPrefs().interceptOpenPath !== false
      && store.getPrefs().tabsEnabled['editor'] !== false,
    currentSessionId: () => ctx.sessions.list.getSnapshot().current,
    openInSidebar: (path, sessionId) => {
      const line = parsePathLine(path)
      if (line !== null) openSidebarFile(ctx, store, sessionId, line.path, { start: line.start, end: line.end })
      else openSidebarFile(ctx, store, sessionId, path)
    },
  })
}

/** Whether the chat path/path:line mention links are enabled: the side-card
 *  toggle (default ON) AND the editor tab must both be on — mentions that
 *  cannot open must not render as links. */
function chatPathLinksEnabled(store: SidebarStore): boolean {
  const prefs = store.getPrefs()
  return prefs.pluginSettings['editor']?.chatPathLinks !== false
    && prefs.tabsEnabled['editor'] !== false
}

/**
 * Register the chat mention interception: wraps the DSH `chatFileMentions`
 * service (ui-deliverables) so inline-code spans in settled chat text that
 * name a file path — with or without a `:line` / `:start-end` suffix —
 * resolve as clickable mentions that open the sidebar editor at the line.
 * Produced-path resolution keeps precedence; the side-card toggle gates the
 * extra resolution only (produced mentions keep working when it is off).
 *
 * Only paths VERIFIED to exist render as links: mention resolution is
 * synchronous (MarkdownText), so a client-side verified-path cache
 * (verified-paths.ts) answers membership while an async `fs.read` probe
 * confirms unknown paths in the background — an illustrative or typo'd
 * path stays plain code and never becomes a link.
 *
 * The service may not be provided yet when this plugin activates (both are
 * client bundles), and ui-deliverables HMR re-provides a fresh object — a
 * cheap poll re-wraps in both cases. Returns the disposer (HMR-safe).
 *
 * `probe` is injectable for tests (defaults to an `fs.read` existence
 * probe through the sidebar API).
 */
export function registerChatMentionInterception(
  ctx: Context,
  store: SidebarStore,
  probe?: (scope: { sessionId: string; cwd?: string }, absolute: string) => Promise<boolean>,
): () => void {
  let restore: (() => void) | null = null
  let wrapped: ChatFileMentionsService | null = null
  let disposed = false

  // The current session scope (the visible conversation — where mentions
  // render and click), used for both path resolution and the fs probes.
  const scopeOf = (): { sessionId: string; cwd?: string } | undefined => {
    const snapshot = ctx.sessions.list.getSnapshot()
    const sessionId = snapshot.current
    if (sessionId === undefined) return undefined
    const summary = snapshot.byId[sessionId]
    return summary === undefined ? { sessionId } : { sessionId, cwd: summary.cwd }
  }

  // Existence cache: a bounded recursive workspace scan (`fs.index`) seeds
  // verified paths whenever a session (workspace) becomes active; paths the
  // scan missed fall back to a rare per-path fs.read probe. `check()` stays
  // synchronous for the renderer.
  const verifier = createPathVerifier({
    scope: scopeOf,
    resolveAbsolute: (path) => resolveSidebarPath(scopeOf()?.cwd, path),
    fetchIndex: async (scope) => (await api.fsIndex(scope)).paths,
    probe: probe ?? (async (scope, absolute) => {
      try {
        await api.fsRead(scope, absolute)
        return true
      } catch {
        return false
      }
    }),
  })
  // Scan the workspace as soon as it opens (a session switch changes cwd),
  // so the cache is warm before the first message renders.
  const warm = (): void => { verifier.warm() }
  warm()
  const offSessions = ctx.sessions.list.subscribe(warm)

  const tryWrap = (): void => {
    if (disposed) return
    const service = ctx.get('chatFileMentions') as ChatFileMentionsService | undefined
    if (service === undefined || service === wrapped) return
    restore?.()
    restore = wrapChatFileMentions(service, (owner) => ({
      enabled: () => chatPathLinksEnabled(store),
      verified: (path) => verifier.check(path),
      // Route the open through the chat file-open funnel: the owner's
      // openFile resolves against the session cwd and calls
      // workspaces.openPath — which registerOpenPathInterception reroutes
      // into the sidebar (splitting the line suffix back off).
      openPath: (path) => {
        const openFile = (owner as { openFile?: (p: string) => void } | null)?.openFile
        if (typeof openFile === 'function') {
          openFile(path)
          return
        }
        // Defensive fallback (no owner.openFile — an unexpected renderer):
        // open the sidebar directly, splitting any line suffix ourselves.
        const sessionId = ctx.sessions.list.getSnapshot().current
        if (sessionId === undefined) return
        const line = parsePathLine(path)
        if (line !== null) openSidebarFile(ctx, store, sessionId, line.path, { start: line.start, end: line.end })
        else openSidebarFile(ctx, store, sessionId, path)
      },
      label: (value, line) => line !== undefined
        ? t('chatMentionOpen', {
          name: `${line.path}:${line.start}${line.end > line.start ? `-${line.end}` : ''}`,
        })
        : t('chatMentionOpen', { name: value }),
    }))
    wrapped = service
  }

  tryWrap()
  const timer = window.setInterval(tryWrap, 400)
  return () => {
    disposed = true
    window.clearInterval(timer)
    offSessions()
    verifier.clear()
    restore?.()
    restore = null
    wrapped = null
  }
}
