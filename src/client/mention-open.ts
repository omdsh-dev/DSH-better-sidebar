/**
 * Tracy: the client wiring of the prose file-mention widening
 * (mention-intercept.ts + mention-scope.ts).
 *
 * Upstream 0.21.1 deleted `intercept.tsx`, which used to host this wiring next
 * to the turn-tail row and the open-path shadow. Both of those are gone for
 * good (the host's list-kind turn tail and the native right Sidebar's
 * `dsh-resource://file/**` claim replace them); the mention widening is not
 * replaced by anything upstream, so it lives here on its own.
 */
import type { Context } from '../context-types.ts'
import { api } from './api.ts'
import { t } from './locales.ts'
import { mainSessionId } from './main-session.ts'
import { wrapChatFileMentions, type ChatFileMentionsService } from './mention-intercept.ts'
import { MENTION_SCOPE_KEY, type MentionScopeValue } from './mention-scope.ts'
import { isAbsolutePath } from './paths.ts'
import { openSidebarFile } from './sidebar-file.ts'
import type { SidebarStore } from './state.ts'

/**
 * Directory listings warmed for prose mention resolution, keyed by absolute
 * directory. `undefined` in the map means "in flight" — a second warm for the
 * same directory is dropped rather than queued.
 *
 * Module-level and never evicted: a chat scrolls back through turns whose
 * directories were warmed long ago, and the entry sets are small (names only).
 * Cleared on disposal so an HMR reload does not serve a stale tree.
 */
const listings = new Map<string, ReadonlySet<string> | undefined>()

/**
 * Called once, coalesced, after a batch of listings lands. The client half
 * wires this to a conversation rebuild: `resolve()` is synchronous and a
 * settled turn never re-renders on its own, so a listing that arrives after
 * the turn's only render would otherwise be dead weight.
 */
let onListingsSettled: (() => void) | undefined
let settleScheduled = false

/** Coalesce the wake-up: one rebuild per microtask batch, not per listing. */
function scheduleSettleNotice(): void {
  if (settleScheduled || onListingsSettled === undefined) return
  settleScheduled = true
  queueMicrotask(() => {
    settleScheduled = false
    onListingsSettled?.()
  })
}

/**
 * Fetch one directory's entry names into {@link listings}. Only ABSOLUTE
 * directories are warmed: a relative path would resolve against whichever
 * session happens to be current when the event arrives, which is not
 * necessarily the session that produced it.
 */
function warmListing(ctx: Context, directory: string): void {
  if (!isAbsolutePath(directory) || listings.has(directory)) return
  const snapshot = ctx.sessions.list.getSnapshot()
  const sessionId = mainSessionId(snapshot)
  if (sessionId === undefined) return
  listings.set(directory, undefined)
  void api.fsTree({ sessionId, cwd: snapshot.byId[sessionId]?.cwd }, directory)
    .then(
      (result) => {
        listings.set(directory, new Set(result.entries.map(entry => entry.name)))
        if (result.entries.length > 0) scheduleSettleNotice()
      },
      // A path that is a file, or outside the session root, simply has no
      // listing. Keep the miss recorded so it is not retried on every event.
      () => { listings.set(directory, new Set()) },
    )
}

/**
 * Register the prose file-mention widening: wraps the `chatFileMentions`
 * service so a filename in a closed turn's prose opens in the sidebar even
 * when the turn produced no files — the case DSH's own vocabulary declines.
 * The turn's scope comes from the accumulator in mention-scope.ts, read off
 * `owner.turn.data`.
 * @param ctx - the client cordis context.
 * @param store - the sidebar store backing the takeover gates.
 * @param service - the runtime's `chatFileMentions` service.
 * @param onListingsReady - wakes a settled conversation once listings land.
 * @returns the disposer restoring the original method.
 */
export function registerMentionInterception(
  ctx: Context,
  store: SidebarStore,
  service: ChatFileMentionsService,
  onListingsReady?: () => void,
): () => void {
  onListingsSettled = onListingsReady
  const restore = wrapChatFileMentions(service, {
    enabled: () => !store.getSuspended()
      && store.getPrefs().tabsEnabled['editor'] !== false,
    paths: (owner) => {
      const record = owner as { turn?: { data?: { get?: (key: string) => unknown } } } | null
      if (record === null || typeof record !== 'object') return []
      const value = record.turn?.data?.get?.(MENTION_SCOPE_KEY) as MentionScopeValue | undefined
      return Array.isArray(value?.paths) ? value.paths : []
    },
    listing: (directory) => listings.get(directory),
    open: (path) => {
      const sessionId = mainSessionId(ctx.sessions.list.getSnapshot())
      if (sessionId !== undefined) openSidebarFile(ctx, sessionId, path)
    },
    // Reuses the existing "open beside" copy rather than adding a key: the
    // dictionary parity spec holds every shipped language to zh's key set.
    label: () => t('openFileSide'),
  })
  return () => {
    restore()
    listings.clear()
    onListingsSettled = undefined
  }
}

/** Warm the listing for one path a tool call named (the accumulator's hook). */
export function warmMentionPath(ctx: Context, path: string): void {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (at > 0) warmListing(ctx, path.slice(0, at))
  warmListing(ctx, path)
}
