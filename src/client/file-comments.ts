/**
 * Per-session file review comments. Pending comments survive reloads until a
 * successful conversation.send; sent comments remain as a bounded local
 * history. This state is deliberately separate from SidebarState: comments
 * are review data, not workbench layout.
 */
import { buildSelectionInsert, headerOf, SELECTION_LIMIT, type SelectionLines } from './selection-payload.ts'

export interface FileComment {
  id: string
  path: string
  lines?: SelectionLines
  /** Empty when the selection exceeded SELECTION_LIMIT. */
  selectedText: string
  selectionOmitted: boolean
  body: string
  createdAt: number
  sentAt?: number
  batchId?: string
}

export interface NewFileComment {
  path: string
  lines?: SelectionLines
  selectedText: string
  body: string
}

interface PersistedComments {
  version: 1
  comments: readonly FileComment[]
}

interface StorageFace {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const STORAGE_PREFIX = 'dsh-sidebar:file-comments:v1'
const HISTORY_LIMIT = 200
const EMPTY_COMMENTS: readonly FileComment[] = []
let fallbackId = 0

function normalizeComments(comments: readonly FileComment[]): readonly FileComment[] {
  const pending = comments.filter(comment => comment.sentAt === undefined)
  const history = comments
    .filter(comment => comment.sentAt !== undefined)
    .sort((a, b) => (a.sentAt ?? 0) - (b.sentAt ?? 0))
    .slice(-HISTORY_LIMIT)
  return [...pending, ...history]
}

function defaultStorage(): StorageFace | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

function defaultId(): string {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    // A deterministic page-local fallback is enough for local review rows.
  }
  fallbackId += 1
  return `comment-${Date.now()}-${fallbackId}`
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function sanitizeComment(value: unknown): FileComment | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || row.id === '') return undefined
  if (typeof row.path !== 'string' || row.path === '') return undefined
  if (typeof row.selectedText !== 'string' || typeof row.body !== 'string' || row.body.trim() === '') return undefined
  if (typeof row.selectionOmitted !== 'boolean') return undefined
  if (typeof row.createdAt !== 'number' || !Number.isFinite(row.createdAt)) return undefined
  const start = positiveInteger((row.lines as Record<string, unknown> | undefined)?.start)
  const end = positiveInteger((row.lines as Record<string, unknown> | undefined)?.end)
  const lines = start !== undefined && end !== undefined && end >= start ? { start, end } : undefined
  const sentAt = typeof row.sentAt === 'number' && Number.isFinite(row.sentAt) ? row.sentAt : undefined
  return {
    id: row.id,
    path: row.path,
    lines,
    selectedText: row.selectedText.slice(0, SELECTION_LIMIT),
    selectionOmitted: row.selectionOmitted,
    body: row.body,
    createdAt: row.createdAt,
    sentAt,
    batchId: typeof row.batchId === 'string' ? row.batchId : undefined,
  }
}

/** A small session-addressed external store suitable for useSyncExternalStore. */
export class FileCommentStore {
  private readonly cache = new Map<string, readonly FileComment[]>()
  private readonly listeners = new Map<string, Set<() => void>>()

  constructor(
    private readonly storage: StorageFace | undefined = defaultStorage(),
    private readonly now: () => number = Date.now,
    private readonly makeId: () => string = defaultId,
  ) {}

  getSnapshot(sessionId: string): readonly FileComment[] {
    const cached = this.cache.get(sessionId)
    if (cached !== undefined) return cached
    const loaded = this.load(sessionId)
    this.cache.set(sessionId, loaded)
    return loaded
  }

  subscribe(sessionId: string, listener: () => void): () => void {
    const set = this.listeners.get(sessionId) ?? new Set<() => void>()
    set.add(listener)
    this.listeners.set(sessionId, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(sessionId)
    }
  }

  add(sessionId: string, input: NewFileComment): FileComment {
    const body = input.body.trim()
    if (body === '') throw new Error('comment body is empty')
    const selectionOmitted = input.selectedText.length > SELECTION_LIMIT
    const comment: FileComment = {
      id: this.makeId(),
      path: input.path,
      lines: input.lines,
      selectedText: selectionOmitted ? '' : input.selectedText,
      selectionOmitted,
      body,
      createdAt: this.now(),
    }
    this.commit(sessionId, [...this.getSnapshot(sessionId), comment])
    return comment
  }

  update(sessionId: string, id: string, body: string): boolean {
    const nextBody = body.trim()
    if (nextBody === '') return false
    let changed = false
    const next = this.getSnapshot(sessionId).map((comment) => {
      if (comment.id !== id || comment.sentAt !== undefined || comment.body === nextBody) return comment
      changed = true
      return { ...comment, body: nextBody }
    })
    if (changed) this.commit(sessionId, next)
    return changed
  }

  remove(sessionId: string, id: string): boolean {
    const current = this.getSnapshot(sessionId)
    const next = current.filter(comment => comment.id !== id || comment.sentAt !== undefined)
    if (next.length === current.length) return false
    this.commit(sessionId, next)
    return true
  }

  markSent(sessionId: string, ids: readonly string[], sentAt = this.now(), batchId = this.makeId()): void {
    const selected = new Set(ids)
    let changed = false
    const next = this.getSnapshot(sessionId).map((comment) => {
      if (!selected.has(comment.id) || comment.sentAt !== undefined) return comment
      changed = true
      return { ...comment, sentAt, batchId }
    })
    if (changed) this.commit(sessionId, next)
  }

  private load(sessionId: string): readonly FileComment[] {
    if (this.storage === undefined) return EMPTY_COMMENTS
    try {
      const raw = this.storage.getItem(`${STORAGE_PREFIX}:${sessionId}`)
      if (raw === null) return EMPTY_COMMENTS
      const parsed = JSON.parse(raw) as Partial<PersistedComments>
      if (parsed.version !== 1 || !Array.isArray(parsed.comments)) return EMPTY_COMMENTS
      const comments = parsed.comments.flatMap((item) => {
        const comment = sanitizeComment(item)
        return comment === undefined ? [] : [comment]
      })
      return normalizeComments(comments)
    } catch {
      return EMPTY_COMMENTS
    }
  }

  private commit(sessionId: string, comments: readonly FileComment[]): void {
    const next = normalizeComments(comments)
    this.cache.set(sessionId, next)
    if (this.storage !== undefined) {
      try {
        const payload: PersistedComments = { version: 1, comments: next }
        this.storage.setItem(`${STORAGE_PREFIX}:${sessionId}`, JSON.stringify(payload))
      } catch {
        // The in-memory queue remains usable when storage is unavailable/full.
      }
    }
    for (const listener of this.listeners.get(sessionId) ?? []) listener()
  }
}

/** Build the one queued Agent message represented by a file's pending rows. */
export function formatFileCommentsPrompt(comments: readonly FileComment[], cwd: string | undefined): string {
  if (comments.length === 0) return ''
  const rows = comments.map((comment, index) => {
    const reference = comment.selectionOmitted
      ? headerOf(comment.path, cwd, comment.lines)
      : buildSelectionInsert(comment.path, cwd, comment.lines, comment.selectedText)
    return `### Comment ${index + 1}\n${reference}\n\n${comment.body}`
  })
  return `Please review and address the following comments for the current file.\n\n${rows.join('\n\n')}`
}

export const fileCommentStore = new FileCommentStore()
