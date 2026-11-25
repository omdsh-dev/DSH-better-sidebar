/**
 * One bounded, activation-scoped read cache shared by clue views.
 *
 * Successes stay valid until a mutation invalidates their family or an explicit
 * refresh forces a new read: there is no read TTL, because silently expiring a
 * warm page would either hide remote staleness or churn a request the reader
 * did not ask for. Pending reads are still retained for a short grace window
 * after their last consumer leaves, so a quick source/tab switch reuses the live
 * CLI call instead of abandoning it (and never keeps an unbounded number of
 * abandoned processes alive).
 */
const GRACE_MS = 5_000
const CAPACITY = 128
/** Rough content budget for retained success values (~16 MiB). */
const MAX_CONTENT_BYTES = 16 * 1024 * 1024

interface Entry {
  readonly method: string
  readonly workspaceId: string | undefined
  readonly payload: unknown
  readonly controller: AbortController
  pending?: Promise<unknown>
  /** Only explicit refreshes set this; ordinary warm reads do not throttle fresh reads. */
  refreshedAt?: number
  value?: unknown
  /** Approximate retained size of `value`; pending entries count as zero. */
  bytes: number
  readonly users: Set<symbol>
  grace?: ReturnType<typeof setTimeout>
  /** Set by an auth identity boundary: pending consumers must reject now. */
  authRejected?: boolean
  rejectAuth?: (reason: unknown) => void
}

/** Insertion order is recency: the first entry is the LRU victim. */
const entries = new Map<string, Entry>()
let retainedBytes = 0

/** One business-data change other views can adopt without polling. */
export interface ClueDataChange {
  readonly kind: 'library' | 'auth' | 'resource'
  readonly workspaceId?: string
  readonly resource?: { readonly clueId?: string; readonly sourceId?: string; readonly typeId?: string; readonly locator?: unknown }
}

export type ClueDataChangeListener = (change: ClueDataChange) => void

const dataChangeListeners = new Set<ClueDataChangeListener>()

/** Observe library-content and auth-boundary changes. Returns the disposer. */
export function subscribeClueDataChanges(listener: ClueDataChangeListener): () => void {
  dataChangeListeners.add(listener)
  return () => { dataChangeListeners.delete(listener) }
}

/** Publish one change; a broken consumer never blocks the other views. */
export function notifyClueDataChange(change: ClueDataChange): void {
  for (const listener of [...dataChangeListeners]) {
    try { listener(change) } catch { /* one broken view must not stop the bus */ }
  }
}

/** Stable JSON: object keys sorted, undefined object members omitted. */
function canonical(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const parts: string[] = []
    for (const key of Object.keys(record).sort()) {
      const item = record[key]
      if (item === undefined) continue
      parts.push(`${JSON.stringify(key)}:${canonical(item)}`)
    }
    return `{${parts.join(',')}}`
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  return 'null'
}

/**
 * The one canonical cache key. `sessionId` is part of a resource read's
 * approval/route context, so it stays in the key for every method; builtin UI
 * reads simply share the same `undefined` session and stay hot.
 */
export function clueRequestKey(method: string, workspaceId: string | undefined, payload: unknown): string {
  return `${method}\u0000${workspaceId === undefined ? '' : JSON.stringify(workspaceId)}\u0000${canonical(payload)}`
}

/**
 * Approximate serialized content size. Reads can carry whole documents, so the
 * cache bounds bytes as well as entry count; JSON overhead is counted rather
 * than trusting a value to be small.
 */
function contentBytes(value: unknown): number {
  let text: string
  try {
    text = JSON.stringify(value) ?? ''
  } catch {
    return 0
  }
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).byteLength
  return text.length * 2
}

function clearGrace(entry: Entry): void {
  if (entry.grace === undefined) return
  clearTimeout(entry.grace)
  entry.grace = undefined
}

/** Detached active callers keep their answer; abandoned work no longer needs to survive. */
function discard(key: string, entry: Entry): void {
  if (entries.get(key) === entry) {
    entries.delete(key)
    retainedBytes -= entry.bytes
  }
  clearGrace(entry)
  if (entry.pending !== undefined && entry.users.size === 0) entry.controller.abort()
}

/** Trim LRU completed entries until both the entry and byte bounds hold. */
function trim(): void {
  while (entries.size > CAPACITY || retainedBytes > MAX_CONTENT_BYTES) {
    let victim: [string, Entry] | undefined
    for (const candidate of entries) {
      if (candidate[1].pending === undefined && candidate[1].users.size === 0) {
        victim = candidate
        break
      }
    }
    // Active readers and in-flight work are never evicted; the cache can
    // temporarily exceed its budget instead of dropping a request on screen.
    if (victim === undefined) return
    discard(victim[0], victim[1])
  }
}

/** The read family or exact entries one mutation may have made stale. */
export type ClueReadFilter =
  | string
  | readonly string[]
  | ((entry: { readonly method: string; readonly workspaceId: string | undefined; readonly payload: unknown }) => boolean)

function matchesRead(
  entry: Entry,
  workspaceId: string | undefined,
  filter: ClueReadFilter | undefined,
): boolean {
  if (workspaceId !== undefined && entry.workspaceId !== workspaceId) return false
  if (filter === undefined) return true
  if (typeof filter === 'string') return entry.method === filter
  if (typeof filter === 'function') return filter(entry)
  return filter.includes(entry.method)
}

/** Mutations invalidate reads; a family filter leaves unrelated queries warm. */
export function invalidateClueRequests(workspaceId?: string, filter?: ClueReadFilter): void {
  for (const [key, entry] of [...entries]) {
    if (matchesRead(entry, workspaceId, filter)) discard(key, entry)
  }
}

/**
 * Auth identity boundary: abort AND immediately reject every attached pending
 * reader, even when the underlying fetcher ignores its abort signal. Ordinary
 * mutations keep the detach/grace behaviour above; only an auth switch makes
 * the old identity's in-flight answer unusable.
 */
export function invalidateClueRequestsForAuth(filter?: ClueReadFilter): void {
  for (const [key, entry] of [...entries]) {
    if (!matchesRead(entry, undefined, filter)) continue
    entry.authRejected = true
    entry.rejectAuth?.(cancelled())
    entry.controller.abort()
    discard(key, entry)
  }
}

/** Invalidate one exact retained read (the explicit refresh of one query). */
export function invalidateClueRequest(method: string, workspaceId: string | undefined, payload: unknown): void {
  const key = clueRequestKey(method, workspaceId, payload)
  const entry = entries.get(key)
  // A refresh of this exact resource must not detach the request it just started.
  if (entry !== undefined && entry.pending === undefined && (entry.refreshedAt === undefined || Date.now() - entry.refreshedAt >= 1000)) discard(key, entry)
}

/**
 * Synchronously read a COMPLETED cached answer without starting a request.
 * Pending work is not an answer: the caller should attach to the live request
 * instead of waiting on a second copy. A peek counts as a use for LRU order.
 */
export function peekClueRequest<T>(method: string, workspaceId: string | undefined, payload: unknown): T | undefined {
  const key = clueRequestKey(method, workspaceId, payload)
  const entry = entries.get(key)
  if (entry === undefined || entry.pending !== undefined) return undefined
  entries.delete(key)
  entries.set(key, entry)
  // A peek is also a use: keep the byte/entry budget honest even on a surface
  // that only reads warm data. The touched entry is the MRU, so it is only
  // dropped when every other retained entry is active.
  trim()
  if (entries.get(key) !== entry) return undefined
  return entry.value as T
}

function cancelled(): DOMException { return new DOMException('The clue request was cancelled', 'AbortError') }

/**
 * Share reads across views. A successful answer is retained until invalidated;
 * an abandoned in-flight read is retained for a short switch-back window.
 */
export function cachedClueRequest<T>(
  method: string,
  workspaceId: string | undefined,
  payload: unknown,
  load: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  options?: { force?: boolean; coalesceRefresh?: boolean },
): Promise<T> {
  if (signal?.aborted) return Promise.reject(cancelled())
  if (method === 'clues.search') {
    const next = payload as { sourceId?: unknown; query?: unknown } | null | undefined
    if (typeof next?.sourceId === 'string' && typeof next.query === 'string') {
      for (const [oldKey, old] of [...entries]) {
        if (old.method !== method || old.workspaceId !== workspaceId
          || old.pending === undefined || old.users.size > 0) continue
        const previous = old.payload as { sourceId?: unknown; query?: unknown } | null | undefined
        if (previous?.sourceId === next.sourceId && previous.query !== next.query) discard(oldKey, old)
      }
    }
  }
  trim()
  const key = clueRequestKey(method, workspaceId, payload)
  let entry = entries.get(key)
  if (entry !== undefined && options?.force === true && (options.coalesceRefresh !== true
    || (entry.pending === undefined && (entry.refreshedAt === undefined || Date.now() - entry.refreshedAt >= 1000)))) {
    discard(key, entry)
    entry = undefined
  }
  if (entry !== undefined) {
    clearGrace(entry)
    // Touch for LRU. In-flight entries are never evicted.
    entries.delete(key)
    entries.set(key, entry)
    if (entry.pending === undefined) return Promise.resolve(entry.value as T)
  } else {
    entry = {
      method,
      workspaceId,
      payload,
      controller: new AbortController(),
      bytes: 0,
      users: new Set(),
    }
    const created = entry
    entries.set(key, created)
    const authAbort = new Promise<never>((_, reject) => { created.rejectAuth = reject })
    const loaded = Promise.resolve().then(() => load(created.controller.signal)).then(value => {
      clearGrace(created)
      if (created.authRejected) throw cancelled()
      created.value = value
      if (options?.force === true) created.refreshedAt = Date.now()
      const bytes = contentBytes(value)
      created.pending = undefined
      if (entries.get(key) === created) {
        created.bytes = bytes
        retainedBytes += bytes
        // A single answer larger than the whole budget is served to its
        // consumers but never retained.
        if (bytes > MAX_CONTENT_BYTES) discard(key, created)
        else trim()
      }
      return value
    }, error => {
      clearGrace(created)
      if (entries.get(key) === created) entries.delete(key)
      created.pending = undefined
      throw error
    })
    // Auth rejection wins immediately; a late fetch settlement is inert.
    created.pending = Promise.race([loaded, authAbort])
  }
  const current = entry
  const pending = current.pending!
  const user = Symbol()
  current.users.add(user)
  return new Promise<T>((resolve, reject) => {
    let finished = false
    const cleanup = (): void => {
      current.users.delete(user)
      signal?.removeEventListener('abort', abort)
    }
    const abort = (): void => {
      if (finished) return
      finished = true
      cleanup()
      if (current.users.size === 0 && current.pending !== undefined) {
        if (entries.get(key) !== current) current.controller.abort()
        else current.grace = setTimeout(() => { discard(key, current) }, GRACE_MS)
      }
      reject(cancelled())
    }
    signal?.addEventListener('abort', abort, { once: true })
    void pending.then(value => {
      if (finished) return
      finished = true
      cleanup()
      resolve(value as T)
    }, error => {
      if (finished) return
      finished = true
      cleanup()
      reject(error)
    })
    if (signal?.aborted) abort()
  })
}
