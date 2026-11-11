/**
 * The EXPLICIT root one session's explorer was pinned to (the root picker).
 *
 * The automatic root (`active-worktree.ts`) is an inference: it starts from the
 * host's committed working directory and then follows the newest linked
 * worktree the session's own tool calls mention. That inference can be wrong —
 * a nested repository's linked worktree hijacking the explorer (#952), or a
 * checkout that was removed while the host kept running (#960) — and it is
 * simply not what the reader wants sometimes. Before this module the only
 * escape was restarting the host with `DSH_SIDEBAR_WORKTREE_ROOT`, a
 * process-wide switch that also interrupted the conversation.
 *
 * A pin is therefore per session (the id is stable and never reused), explicit
 * (only a user action writes one), and revocable (clearing it returns the
 * session to the automatic root). It is deliberately NOT persisted: a host
 * restart returns every session to the automatic root, which keeps this out of
 * the settings/persistence surface.
 *
 * The map is bounded (LRU, the `fs-tree.ts` / `active-worktree.ts`
 * bounded-cache style) because the host never forgets a session and an
 * unbounded map would hold one entry per session ever opened.
 */
import { stat } from 'node:fs/promises'

/** Upper bound on pinned sessions; the least recently read pin is evicted first. */
export const PINNED_SESSIONS_MAX = 256

/** sessionId → the absolute checkout the explorer was pinned to. */
const pinnedRoots = new Map<string, string>()

/**
 * Insert or refresh one pin, evicting the least recently used entry past the
 * cap. Map iteration order is insertion order, so deleting before setting moves
 * the key to the young end — the same bounded-cache shape as
 * `active-worktree.ts`'s own `cachePut` (which is not exported).
 */
function putPinned(sessionId: string, root: string): void {
  pinnedRoots.delete(sessionId)
  pinnedRoots.set(sessionId, root)
  while (pinnedRoots.size > PINNED_SESSIONS_MAX) {
    const oldest = pinnedRoots.keys().next().value
    if (oldest === undefined) break
    pinnedRoots.delete(oldest)
  }
}

/** The pinned root of one session, or `undefined` when it has none. */
export function pinnedRootOf(sessionId: string): string | undefined {
  const root = pinnedRoots.get(sessionId)
  if (root === undefined) return undefined
  putPinned(sessionId, root)
  return root
}

/** Pin one session to an absolute checkout (the caller validated the path). */
export function pinSessionRoot(sessionId: string, root: string): void {
  putPinned(sessionId, root)
}

/** Drop one session's pin; it returns to the automatic root immediately. */
export function unpinSessionRoot(sessionId: string): void {
  pinnedRoots.delete(sessionId)
}

/**
 * The pinned root, but only while its directory is still there.
 *
 * A pinned checkout can be removed while the host keeps running (`git worktree
 * remove`, or a manual delete). Serving it then fails every route against a
 * directory that no longer exists and never recovers — the shape #960 reported
 * for the automatic root. One `stat` (no process spawn) drops the pin instead,
 * so the session falls back to the automatic root on the same call.
 */
export async function livePinnedRootOf(sessionId: string): Promise<string | undefined> {
  const root = pinnedRootOf(sessionId)
  if (root === undefined) return undefined
  try {
    if ((await stat(root)).isDirectory()) return root
  } catch {
    // Fall through: the checkout is gone, so the pin is stale.
  }
  unpinSessionRoot(sessionId)
  return undefined
}
