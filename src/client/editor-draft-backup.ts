/**
 * Durable backups of unsaved editor drafts.
 *
 * Why this exists: the two host-owned paths that can take an editor tab away
 * without asking are not interceptable with a confirmation.
 *
 * - The native right column's tab strip (its × / middle click / context menu /
 *   page.close) runs `ctx.sidebarRight.registerCloseHandler` before removing
 *   the record, but that hook is a synchronous CLEANUP callback
 *   ("Failure preserves the tab"), not a confirmation channel: vetoing means
 *   throwing, which the host logs as "Sidebar tab close failed:" and which
 *   escapes from `replaceTab` and the public `close()` callers. It may flush a
 *   draft, never ask.
 * - The Desktop shell quits on its own (Electron main intercepts `before-quit`
 *   and the page receives no cancellable quit event), so Cmd+Q cannot show a
 *   page-level prompt either.
 *
 * The remaining protection is to keep the draft somewhere that survives both:
 * a small localStorage entry keyed by `sessionId::path`, offered back when the
 * same file is opened again (TextEditor shows the restore prompt).
 *
 * Cost rules (steady-state):
 * - Writing is a single trailing throttle armed only by an edit and disarmed
 *   by the flush; idle tabs hold no timer and no polling is added.
 * - At most {@link DRAFT_BACKUP_LIMIT} drafts and {@link DRAFT_BACKUP_TOTAL_CHARS}
 *   characters live in storage; the oldest entry is evicted first (FIFO).
 * - A draft larger than {@link DRAFT_BACKUP_CHARS} is not stored at all (a
 *   single entry would evict the whole budget).
 * - An entry is deleted the moment its draft stops being unsaved (save, or a
 *   confirmed discard) and when the throttle is cleared.
 */

/** localStorage prefix; every key under it is one of our drafts. */
const STORAGE_PREFIX = 'dsh-better-sidebar:draft:'

/** How many drafts are kept (oldest evicted first). */
export const DRAFT_BACKUP_LIMIT = 8

/** Longest draft persisted, in characters; bigger drafts are skipped. */
export const DRAFT_BACKUP_CHARS = 200_000

/** Total characters across all kept drafts. */
export const DRAFT_BACKUP_TOTAL_CHARS = 600_000

/** Delay after an edit before the draft is written. */
export const DRAFT_BACKUP_THROTTLE_MS = 1000

/** How many live editor sources are remembered (open editor bodies). */
const SOURCE_LIMIT = 32

/** What one stored entry carries. */
interface StoredDraft {
  text: string
  /** Write time; the FIFO order for eviction. */
  savedAt: number
}

/**
 * One mounted editor's live text reader, keyed by `sessionId::path`.
 * Reading at flush time (rather than per keystroke) keeps the backup free of
 * the O(document) stringification the editor deliberately avoids on every key.
 */
const sources = new Map<string, () => string | null>()
/** Keys whose draft changed since the last write. */
const pending = new Set<string>()
let timer: ReturnType<typeof setTimeout> | null = null

/** The map/storage key of one draft: ids and paths only mean something in a session. */
function keyOf(sessionId: string, path: string): string {
  return `${sessionId}::${path}`
}

/** localStorage, when this runtime has it (specs, SSR). */
function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

/** One stored entry; malformed values are treated as absent. */
function readStored(key: string): StoredDraft | undefined {
  const store = storage()
  const raw = store?.getItem(STORAGE_PREFIX + key)
  if (raw === undefined || raw === null) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const { text, savedAt } = parsed as { text?: unknown; savedAt?: unknown }
    if (typeof text !== 'string' || typeof savedAt !== 'number') return undefined
    return { text, savedAt }
  } catch {
    return undefined
  }
}

/** Every stored key with its timestamp, oldest first. */
function storedDrafts(store: Storage): Array<{ key: string; savedAt: number; chars: number }> {
  const entries: Array<{ key: string; savedAt: number; chars: number }> = []
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index)
    if (key === null || !key.startsWith(STORAGE_PREFIX)) continue
    const bare = key.slice(STORAGE_PREFIX.length)
    const entry = readStored(bare)
    entries.push({ key, savedAt: entry?.savedAt ?? 0, chars: entry?.text.length ?? 0 })
  }
  return entries.sort((left, right) => left.savedAt - right.savedAt)
}

/** Evict the oldest entries until both budgets hold. */
function evict(store: Storage): void {
  const entries = storedDrafts(store)
  let chars = entries.reduce((sum, entry) => sum + entry.chars, 0)
  while (entries.length > 0 && (entries.length > DRAFT_BACKUP_LIMIT || chars > DRAFT_BACKUP_TOTAL_CHARS)) {
    const oldest = entries.shift()
    if (oldest === undefined) break
    store.removeItem(oldest.key)
    chars -= oldest.chars
  }
}

/** Persist one draft, dropping older ones when storage is full. */
function writeDraft(key: string, text: string): void {
  const store = storage()
  if (store === undefined) return
  if (text.length === 0 || text.length > DRAFT_BACKUP_CHARS) return
  const previous = readStored(key)
  // An unchanged draft keeps its original timestamp (and therefore its place
  // in the FIFO order), so a restore that is re-persisted does not look new.
  if (previous?.text === text) return
  const payload = JSON.stringify({ text, savedAt: Date.now() } satisfies StoredDraft)
  try {
    store.setItem(STORAGE_PREFIX + key, payload)
  } catch {
    // Quota exceeded: make room by dropping every older draft, then retry once.
    const older = storedDrafts(store).filter(entry => entry.key !== STORAGE_PREFIX + key)
    for (const entry of older) store.removeItem(entry.key)
    try {
      store.setItem(STORAGE_PREFIX + key, payload)
    } catch {
      return
    }
  }
  evict(store)
}

/** Write every pending draft now (the close / unload flush). */
export function flushDraftBackups(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  const keys = [...pending]
  pending.clear()
  for (const key of keys) {
    const text = sources.get(key)?.()
    if (text !== null && text !== undefined) writeDraft(key, text)
  }
}

/**
 * Remember one mounted editor's live text and return its disposer.
 *
 * The reader runs at flush time and must answer `null` once its editor is
 * gone, so a flush after an unmount can never write a destroyed view's text.
 * @param sessionId - the session owning the tab.
 * @param path - the file the draft belongs to.
 * @param read - the live document's text, or null.
 * @returns the disposer (idempotent; a newer source for the same file wins).
 */
export function registerDraftSource(sessionId: string, path: string, read: () => string | null): () => void {
  const key = keyOf(sessionId, path)
  sources.set(key, read)
  if (sources.size > SOURCE_LIMIT) {
    const oldest = sources.keys().next().value
    if (oldest !== undefined && oldest !== key) sources.delete(oldest)
  }
  return () => {
    if (sources.get(key) === read) sources.delete(key)
  }
}

/**
 * Mark one draft as changed; a single shared throttle writes the pending set
 * once {@link DRAFT_BACKUP_THROTTLE_MS} has passed since the first change.
 * @param sessionId - the session owning the tab.
 * @param path - the file the draft belongs to.
 */
export function scheduleDraftBackup(sessionId: string, path: string): void {
  const key = keyOf(sessionId, path)
  if (!sources.has(key)) return
  pending.add(key)
  if (timer !== null) return
  timer = setTimeout(() => {
    timer = null
    flushDraftBackups()
  }, DRAFT_BACKUP_THROTTLE_MS)
}

/**
 * The pending draft of one file, if its content differs from the bytes on
 * disk; otherwise the stale entry is dropped.
 * @param sessionId - the session owning the tab.
 * @param path - the file the draft belongs to.
 * @param content - the bytes just loaded from disk.
 * @returns the stored text, or null.
 */
export function readDraftBackup(sessionId: string, path: string, content: string): string | null {
  const entry = readStored(keyOf(sessionId, path))
  if (entry === undefined) return null
  if (entry.text === content) {
    clearDraftBackup(sessionId, path)
    return null
  }
  return entry.text
}

/** Drop one file's backup (saved, discarded, or restored). Idempotent. */
export function clearDraftBackup(sessionId: string, path: string): void {
  const key = keyOf(sessionId, path)
  pending.delete(key)
  storage()?.removeItem(STORAGE_PREFIX + key)
}
