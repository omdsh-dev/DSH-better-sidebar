/**
 * Durable dirty-buffer registry. Unsaved text lives in IndexedDB (with an
 * in-memory fallback for locked-down/test browsers), keyed by session + path.
 * Only dirty buffers are stored; a successful disk save removes the record.
 */
export type EditorViewMode = 'preview' | 'edit' | 'visual'

export interface EditorBufferRecord {
  key: string
  sessionId: string
  path: string
  text: string
  /** Version of the disk text this draft started from. */
  baseVersion: string | null
  mode: EditorViewMode
  updatedAt: number
}

const DB_NAME = 'dsh-better-sidebar'
const DB_VERSION = 1
const STORE = 'editor-buffers'
const memory = new Map<string, EditorBufferRecord>()
const queues = new Map<string, Promise<void>>()
let dbPromise: Promise<IDBDatabase | null> | undefined
/** Brief tombstones stop unmount cleanup from recreating moved/deleted drafts. */
const blockedPrefixes = new Map<string, number>()
const BLOCK_MS = 2_000

export function editorBufferKey(sessionId: string, path: string): string {
  return `${sessionId}\u0000${normalizedPath(path)}`
}

function blockWritesUnder(sessionId: string, path: string): void {
  blockedPrefixes.set(editorBufferKey(sessionId, path), Date.now() + BLOCK_MS)
}

function writesBlocked(sessionId: string, path: string): boolean {
  const now = Date.now()
  for (const [key, until] of blockedPrefixes) {
    if (until <= now) {
      blockedPrefixes.delete(key)
      continue
    }
    const split = key.indexOf('\u0000')
    if (key.slice(0, split) === sessionId && pathAtOrUnder(key.slice(split + 1), path)) return true
  }
  return false
}

export async function getEditorBuffer(sessionId: string, path: string): Promise<EditorBufferRecord | undefined> {
  await queues.get(editorBufferKey(sessionId, path))
  const key = editorBufferKey(sessionId, path)
  const db = await openDb()
  if (db === null) return clone(memory.get(key))
  return request<EditorBufferRecord | undefined>(db.transaction(STORE, 'readonly').objectStore(STORE).get(key))
}

/** Queue one write per document so slower earlier transactions cannot win. */
export function saveEditorBuffer(input: Omit<EditorBufferRecord, 'key' | 'updatedAt'>): Promise<void> {
  if (writesBlocked(input.sessionId, input.path)) return Promise.resolve()
  const key = editorBufferKey(input.sessionId, input.path)
  const record: EditorBufferRecord = { ...input, key, updatedAt: Date.now() }
  return enqueue(key, async () => {
    const db = await openDb()
    if (db === null) {
      memory.set(key, record)
      return
    }
    await transactionDone(db, 'readwrite', store => { store.put(record) })
  })
}

export function deleteEditorBuffer(sessionId: string, path: string): Promise<void> {
  const key = editorBufferKey(sessionId, path)
  return enqueue(key, async () => {
    const db = await openDb()
    if (db === null) {
      memory.delete(key)
      return
    }
    await transactionDone(db, 'readwrite', store => { store.delete(key) })
  })
}

export async function listEditorBuffersUnder(sessionId: string, path: string): Promise<EditorBufferRecord[]> {
  await Promise.all([...queues.values()])
  const records = await allRecords()
  return records.filter(record => record.sessionId === sessionId && pathAtOrUnder(path, record.path))
}

/** Remap a file buffer or every descendant buffer after rename/move. */
export async function moveEditorBuffers(sessionId: string, from: string, to: string): Promise<void> {
  blockWritesUnder(sessionId, from)
  const records = await listEditorBuffersUnder(sessionId, from)
  await Promise.all(records.map(async (record) => {
    const suffix = record.path.slice(from.length)
    await deleteEditorBuffer(sessionId, record.path)
    await saveEditorBuffer({
      sessionId,
      path: `${to}${suffix}`,
      text: record.text,
      baseVersion: record.baseVersion,
      mode: record.mode,
    })
  }))
}

export async function deleteEditorBuffersUnder(sessionId: string, path: string): Promise<void> {
  blockWritesUnder(sessionId, path)
  const records = await listEditorBuffersUnder(sessionId, path)
  await Promise.all(records.map(record => deleteEditorBuffer(sessionId, record.path)))
}

/** Test-only reset; production callers never need to clear all user drafts. */
export async function resetEditorBuffersForTests(): Promise<void> {
  await Promise.all([...queues.values()])
  queues.clear()
  memory.clear()
  blockedPrefixes.clear()
  const db = await openDb()
  if (db !== null) await transactionDone(db, 'readwrite', store => { store.clear() })
}

export function pathAtOrUnder(parent: string, candidate: string): boolean {
  const p = normalizedPath(parent).replace(/\/$/, '')
  const c = normalizedPath(candidate).replace(/\/$/, '')
  return c === p || c.startsWith(`${p}/`)
}

function normalizedPath(path: string): string {
  const normalized = path.replace(/[\\/]+/g, '/')
  // Drive-letter and UNC paths use case-insensitive Windows semantics even
  // though this code runs in a browser without process.platform.
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized
}

function enqueue(key: string, task: () => Promise<void>): Promise<void> {
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(task)
  queues.set(key, next)
  const clear = (): void => { if (queues.get(key) === next) queues.delete(key) }
  void next.then(clear, clear)
  return next
}

async function allRecords(): Promise<EditorBufferRecord[]> {
  const db = await openDb()
  if (db === null) return [...memory.values()].map(record => ({ ...record }))
  return request<EditorBufferRecord[]>(db.transaction(STORE, 'readonly').objectStore(STORE).getAll())
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise !== undefined) return dbPromise
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  dbPromise = new Promise((resolve) => {
    let requestOpen: IDBOpenDBRequest
    try {
      requestOpen = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      resolve(null)
      return
    }
    requestOpen.onupgradeneeded = () => {
      const db = requestOpen.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' })
    }
    requestOpen.onsuccess = () => { resolve(requestOpen.result) }
    requestOpen.onerror = () => { resolve(null) }
    requestOpen.onblocked = () => { resolve(null) }
  })
  return dbPromise
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => { resolve(req.result) }
    req.onerror = () => { reject(req.error ?? new Error('IndexedDB request failed')) }
  })
}

function transactionDone(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  mutate: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    tx.oncomplete = () => { resolve() }
    tx.onerror = () => { reject(tx.error ?? new Error('IndexedDB transaction failed')) }
    tx.onabort = () => { reject(tx.error ?? new Error('IndexedDB transaction aborted')) }
    mutate(tx.objectStore(STORE))
  })
}

function clone(record: EditorBufferRecord | undefined): EditorBufferRecord | undefined {
  return record === undefined ? undefined : { ...record }
}
