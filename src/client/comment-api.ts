/**
 * The comment doors — where a site's comments are kept, and where a send to Tracy is recorded
 * (Tracy, 29/09/2026; stage 6 contract `tasks/evidence/comment-people/contract.md` H1).
 *
 *   GET    /api/sites/:key/comments[?since=<ISO>]  → {comments, n_next, siteChangedAt}
 *   POST   /api/sites/:key/comments                → {comment, parent?}   body {url, element, locate, text, replyTo?}
 *                                                   (`parent`: a reply's parent as it now stands — a
 *                                                   resolved one is reopened by the reply itself)
 *   PATCH  /api/sites/:key/comments/:id            → {comment}   body {text?, attachments?}
 *   POST   /api/sites/:key/comments/attachments    → {attachment} multipart, one file in `file`
 *   GET    /api/sites/:key/comments/attachments/:id → the bytes (a row's `attachments[].url`)
 *   POST   /api/sites/:key/comments/:id/resolve    → {comment}
 *   DELETE /api/sites/:key/comments/:id            → {comment}   (soft: the row comes back with `deletedAt`)
 *   POST   /api/sites/:key/comments/clear          → {cleared}   body {url} — every open comment of that page, everyone's
 *                                                   body {threads} → {cleared, deleted, gone} — every named thread it
 *                                                   can take; one already gone is listed, never a refusal (INTH-1)
 *   POST   /api/sites/:key/requests                → {requests:[{id, n}]}
 *                                                   body {sessionId, requestId, items:[{url, element, text, commentId?}]}
 *
 * A comment is open or resolved (the server's `pending` is "open"; older rows with a stage-5
 * status read as open). `sentToTracy` on a row says a request points at it (it only counts "Send N");
 * `siteChangedAt` is the last successful write to the site (the Apply door's audit), which the
 * Refresh button of everyone else compares with the time its page loaded.
 *
 * A refusal is `{code, next}`; `next` is the sentence the tab shows the person. These are tracy-web's
 * Files kept with a comment (TCH `tasks/evidence/comment-people/attachments-contract.md` §C/§D) are
 * uploaded first, one per call, and named by id on the POST/PATCH (`attachments: [id…]`, in the order
 * shown; a PATCH replaces the whole list). Every row carries `attachments: [{id, name, size, type, url}]`;
 * the list names at its root whether the server keeps files at all (`attachments.enabled`).
 *
 * doors at the ROOT of the host, not dsh routes: root-absolute, never through `dshUrl()`, the session
 * cookie travelling with `credentials: 'same-origin'`. `fetch` is a parameter, so tests drive every branch.
 */
import { readPickTarget } from './comment-model.ts'
import { DEFAULT_MAX_CHARS } from './comment-errors.ts'
import { readAttachment, readAttachmentLimits, readAttachments, type AttachmentLimits, type CommentAttachment } from './comment-attachments.ts'
import { sendElementOf, type Comment, type CommentAuthor } from './comment-store.ts'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** One row of the doors. `status` is `pending` (open) or `resolved`; older rows may carry a stage-5 word. */
export interface ServerComment {
  id: string
  n: number
  url: string
  element: Record<string, unknown> | null
  locate: Record<string, unknown> | null
  text: string
  status: string
  replyTo: string | null
  createdAt: string | null
  updatedAt: string | null
  resolvedAt: string | null
  resolvedBy: CommentAuthor | null
  /** Set on a row a poll reports as gone (deleted or cleared). */
  deletedAt: string | null
  /**
   * Server round 5 (TH-4): a deleted FIRST message a live reply still stands under — a tombstone, kept
   * as its thread's top ("Comment deleted"). `false` on a deleted row = gone for good (its last reply
   * went). Absent on older servers: the tab then keeps a deleted row exactly while a reply stands under it.
   */
  deletedRoot?: boolean
  author: CommentAuthor | null
  can: { edit: boolean; delete: boolean }
  /** A `site_request` points at it. */
  sentToTracy?: boolean
  /** Its earlier sends, who and when, when the server lists them (H3); optional. */
  sends?: Array<{ author: CommentAuthor | null; at: string | null }>
  /** Its files (§D); always an array on the doors, `[]` on a deleted row. */
  attachments?: unknown[]
}

/**
 * What a door answered: the value, or its refusal (`status` 0 = no answer at all). A refusal may name
 * the `field` it is about and, for `COMMENT_TOO_LONG`, the server's `maxChars` (round 5, TH-2): the tab
 * turns them into plain words (`comment-errors.ts`), never shows `next` for a save.
 */
export type DoorAnswer<T> = { ok: true; value: T } | { ok: false; status: number; code: string; next: string | null; field?: string; maxChars?: number }

export interface CreateBody {
  url: string
  element: Record<string, unknown> | null
  locate: Record<string, unknown> | null
  text: string
  replyTo?: string
  /** Uploaded files' ids, in the order shown (§C); absent = none. */
  attachments?: string[]
}

/** A create's answer: the new row, and for a reply its parent as the same write left it. */
export interface Created {
  comment: ServerComment
  parent: ServerComment | null
}

/** One item of `POST /requests`. */
export interface RequestBodyItem {
  url: string
  element: Record<string, unknown> | null
  text: string
  commentId?: string
}

export interface RequestsBody {
  sessionId: string
  requestId: string
  items: RequestBodyItem[]
}

export interface CommentList {
  comments: ServerComment[]
  nNext: number
  /** The last successful write to the site (ISO), or null when the server names none. */
  siteChangedAt: string | null
  /** Whether the server keeps files, and its limits (§C); absent on the doors = it does not. */
  attachments: AttachmentLimits
  /** The longest text a comment, reply or send may have (`limits.maxChars`); {@link DEFAULT_MAX_CHARS} when absent. */
  maxChars: number
}

/** A PATCH: new words, a new file list (the whole list, §C), or both. */
export interface PatchBody {
  text?: string
  attachments?: string[]
}

export interface CommentApi {
  list: (since?: string) => Promise<DoorAnswer<CommentList>>
  create: (body: CreateBody) => Promise<DoorAnswer<Created>>
  patch: (id: string, body: PatchBody) => Promise<DoorAnswer<ServerComment>>
  resolve: (id: string) => Promise<DoorAnswer<ServerComment>>
  remove: (id: string) => Promise<DoorAnswer<ServerComment>>
  clear: (url: string) => Promise<DoorAnswer<string[]>>
  /** Delete all of exactly the threads the Comments tab shows (`/clear {threads}`, UI fine-tune 30/09). */
  clearThreads: (ids: readonly string[]) => Promise<DoorAnswer<string[]>>
  /** Record what goes to Tracy; the numbers come back in the items' order. */
  requests: (body: RequestsBody) => Promise<DoorAnswer<Array<{ id: string; n: number }>>>
  /** Keep one file for a comment not written yet (§C); its id goes on the POST/PATCH. */
  upload: (file: File) => Promise<DoorAnswer<CommentAttachment>>
  /** A kept file read back as a `File` (Send to Tracy from a stored comment, §B); null when it cannot be read. */
  fetchFile: (attachment: CommentAttachment) => Promise<File | null>
}

function isRow(value: unknown): value is ServerComment {
  if (value === null || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return typeof r.id === 'string' && typeof r.n === 'number' && typeof r.url === 'string' && typeof r.text === 'string' && typeof r.status === 'string'
}

/**
 * The doors of one site.
 * @param input - the site workspace, and `fetch` for tests.
 */
/** The ids a clear answered with, or null for an answer of another shape. */
function clearedOf(answer: unknown): string[] | null {
  const cleared = answer !== null && typeof answer === 'object' ? (answer as { cleared?: unknown }).cleared : null
  return Array.isArray(cleared) ? cleared.filter((id): id is string => typeof id === 'string') : null
}

export function createCommentApi(input: { siteKey: string; fetchImpl?: FetchLike }): CommentApi {
  const site = `/api/sites/${encodeURIComponent(input.siteKey)}`
  const base = `${site}/comments`
  const call = async <T>(method: string, path: string, body: unknown, read: (answer: unknown) => T | null, keepalive = false): Promise<DoorAnswer<T>> => {
    const fetchImpl = input.fetchImpl ?? fetch
    let res: Response
    // A form goes as it is: the browser writes its multipart boundary into the content type.
    const form = body instanceof FormData
    try {
      res = await fetchImpl(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: body === undefined || form ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
        ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }),
        ...(keepalive ? { keepalive: true } : {}),
      })
    } catch {
      return { ok: false, status: 0, code: 'NETWORK', next: null }
    }
    const answer: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      const a = answer !== null && typeof answer === 'object' ? answer as { code?: unknown; next?: unknown; field?: unknown; maxChars?: unknown } : {}
      const refused: DoorAnswer<T> = { ok: false, status: res.status, code: typeof a.code === 'string' ? a.code : `HTTP_${String(res.status)}`, next: typeof a.next === 'string' ? a.next : null }
      if (typeof a.field === 'string') refused.field = a.field
      if (typeof a.maxChars === 'number' && Number.isInteger(a.maxChars) && a.maxChars > 0) refused.maxChars = a.maxChars
      return refused
    }
    const value = read(answer)
    return value === null ? { ok: false, status: res.status, code: 'BAD_ANSWER', next: null } : { ok: true, value }
  }
  const one = (answer: unknown): ServerComment | null => {
    const row = answer !== null && typeof answer === 'object' ? (answer as { comment?: unknown }).comment : null
    return isRow(row) ? row : null
  }
  const at = (id: string): string => `${base}/${encodeURIComponent(id)}`
  return {
    list: since => call('GET', since === undefined ? base : `${base}?${new URLSearchParams({ since }).toString()}`, undefined, (answer) => {
      const a = answer !== null && typeof answer === 'object' ? answer as { comments?: unknown; n_next?: unknown; siteChangedAt?: unknown; attachments?: unknown; limits?: unknown } : {}
      if (!Array.isArray(a.comments)) return null
      const max = a.limits !== null && typeof a.limits === 'object' ? (a.limits as { maxChars?: unknown }).maxChars : undefined
      return {
        comments: a.comments.filter(isRow),
        nNext: typeof a.n_next === 'number' && Number.isInteger(a.n_next) && a.n_next > 0 ? a.n_next : 1,
        siteChangedAt: typeof a.siteChangedAt === 'string' && Number.isFinite(Date.parse(a.siteChangedAt)) ? a.siteChangedAt : null,
        attachments: readAttachmentLimits(a.attachments),
        maxChars: typeof max === 'number' && Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_CHARS,
      }
    }),
    create: body => call('POST', base, body, (answer) => {
      const comment = one(answer)
      if (comment === null) return null
      const parent = answer !== null && typeof answer === 'object' ? (answer as { parent?: unknown }).parent : null
      return { comment, parent: isRow(parent) ? parent : null }
    }),
    patch: (id, body) => call('PATCH', at(id), body, one),
    resolve: id => call('POST', `${at(id)}/resolve`, undefined, one),
    // keepalive: a Delete not undone is sent as the page hides or unloads (Undo window, Brian 29/09 22:45).
    remove: id => call('DELETE', at(id), undefined, one, true),
    clear: url => call('POST', `${base}/clear`, { url }, clearedOf, true),
    // keepalive: the Comments view sends its Delete all as the page hides or unloads (Undo window).
    clearThreads: ids => call('POST', `${base}/clear`, { threads: [...ids] }, clearedOf, true),
    requests: body => call('POST', `${site}/requests`, body, (answer) => {
      const list = answer !== null && typeof answer === 'object' ? (answer as { requests?: unknown }).requests : null
      if (!Array.isArray(list) || list.length !== body.items.length) return null
      const out = list.flatMap((r: unknown) => {
        const row = r !== null && typeof r === 'object' ? r as { id?: unknown; n?: unknown } : {}
        return typeof row.id === 'string' && typeof row.n === 'number' && Number.isInteger(row.n) && row.n > 0 ? [{ id: row.id, n: row.n }] : []
      })
      return out.length === body.items.length ? out : null
    }),
    upload: (file) => {
      const form = new FormData()
      form.append('file', file, file.name)
      return call('POST', `${base}/attachments`, form, (answer) => {
        const a = answer !== null && typeof answer === 'object' ? (answer as { attachment?: unknown }).attachment : null
        return readAttachment(a)
      })
    },
    fetchFile: async (attachment) => {
      const fetchImpl = input.fetchImpl ?? fetch
      try {
        // Only this site's own door: a row naming any other address is not read.
        const url = attachment.url.startsWith(`${base}/attachments/`) ? attachment.url : `${base}/attachments/${encodeURIComponent(attachment.id)}`
        const res = await fetchImpl(url, { method: 'GET', credentials: 'same-origin', cache: 'no-store' })
        if (!res.ok) return null
        const blob = await res.blob()
        return new File([blob], attachment.name, { type: attachment.type })
      } catch {
        return null
      }
    },
  }
}

// ── Rows in, bodies out ─────────────────────────────────────────────────────────────────────

const ms = (iso: string | null | undefined): number | undefined => {
  if (typeof iso !== 'string') return undefined
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : undefined
}

/**
 * One server row as a comment of the store, or null for a row the tab cannot use. `resolved` reads
 * as resolved, any other status (the server's `pending`, an older row's `sent`/`done`/…) as open. A
 * deleted row (`deletedAt`, words blanked by the server) reads as its placeholder, which the store
 * keeps only while a live reply stands under it.
 * @param row - a row of the doors.
 * @param now - the time a row with no creation time is dated to.
 */
export function commentFromServer(row: unknown, now: number = Date.now()): Comment | null {
  if (!isRow(row)) return null
  const removed = typeof row.deletedAt === 'string' && row.deletedAt !== ''
  // Deleted and no tombstone (its last reply went): nothing to keep.
  if (removed && row.deletedRoot === false) return null
  if (!Number.isInteger(row.n) || row.n < 1 || row.id === '' || row.url === '' || (!removed && row.text.trim() === '')) return null
  const resolved = row.status === 'resolved'
  const c: Comment = {
    id: row.id,
    n: row.n,
    url: row.url,
    element: row.element === null || row.element === undefined ? null : readPickTarget(row.element),
    locate: row.locate !== null && typeof row.locate === 'object' && !Array.isArray(row.locate) ? row.locate : null,
    text: row.text,
    status: resolved ? 'resolved' : 'open',
    createdAt: ms(row.createdAt) ?? now,
  }
  if (resolved) c.resolvedAt = ms(row.resolvedAt) ?? now
  if (typeof row.replyTo === 'string' && row.replyTo !== '') c.replyTo = row.replyTo
  if (row.author !== null && typeof row.author === 'object') c.author = row.author
  if (resolved && row.resolvedBy !== null && typeof row.resolvedBy === 'object') c.resolvedBy = row.resolvedBy
  if (row.can !== null && typeof row.can === 'object') {
    const can = row.can as { edit?: unknown; delete?: unknown }
    c.can = { edit: can.edit === true, delete: can.delete === true || (can.delete === undefined && can.edit === true) }
  }
  if (typeof row.updatedAt === 'string') c.updatedAt = row.updatedAt
  if (row.sentToTracy === true) c.sentToTracy = true
  const files = readAttachments(row.attachments)
  if (files.length > 0) c.attachments = files
  if (Array.isArray(row.sends)) {
    const sends = row.sends.flatMap((s) => {
      const at = ms(s?.at)
      return s !== null && typeof s === 'object' && s.author !== null && typeof s.author === 'object' && at !== undefined ? [{ author: s.author, at }] : []
    })
    if (sends.length > 0) c.sends = sends
  }
  if (removed) {
    const { attachments: _files, ...rest } = c
    return { ...rest, text: '', locate: null, removed: true, can: { edit: false, delete: false } }
  }
  return c
}

/**
 * The element as the doors keep it: what `tracy:comment-send` carries (`sendElementOf`), plus the
 * pick fields the page needs to track it again after a reload (`domPath`, `levels`, `level`, `inside`)
 * and what the page calls an element with no words (`name`, runtime 14 — round 8, acceptance v5
 * JS-v5-new-3: a canvas, an embedded video or an icon button lost its name on the way to the server,
 * and its chip in the Comments tab and the thread card came back empty). The server keeps the object
 * as sent (`apps/tracy-web/src/sites/comments.js`, `objectOrNull`).
 */
export function wireElementOf(c: Pick<Comment, 'url' | 'element' | 'locate'>): Record<string, unknown> | null {
  const element = sendElementOf(c)
  if (element === null || c.element === null) return null
  const { domPath, levels, level, inside, name } = c.element
  return {
    ...element,
    domPath,
    levels,
    level,
    ...(inside === undefined ? {} : { inside }),
    ...(name === undefined || name.trim() === '' ? {} : { name }),
  }
}

/** The body that creates a comment on the server (its number is the server's). */
export function createBodyOf(c: Comment, attachments: readonly string[] = []): CreateBody {
  const body: CreateBody = { url: c.url, element: wireElementOf(c), locate: c.locate, text: c.text.trim() }
  if (c.replyTo !== undefined) body.replyTo = c.replyTo
  if (attachments.length > 0) body.attachments = [...attachments]
  return body
}
