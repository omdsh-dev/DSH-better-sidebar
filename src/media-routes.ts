/**
 * The session media viewer's host half: enumerate a conversation's historical
 * media, serve the bytes of one item, and own the durable thumbnail slots.
 *
 * Three JSON routes under `/sidebar/api` plus one raw byte route:
 *
 *  - `media.list`         — fold the session log into the catalogue (see
 *                           `session-media.ts`) and report, per row, whether a
 *                           stored thumbnail exists and whether the ORIGINAL is
 *                           still reachable;
 *  - `media.thumb.save`   — store the PNG the browser rendered for one row;
 *  - `media.thumb.delete` — forget one stored thumbnail;
 *  - `GET /sidebar/media?id=…` — a stored thumbnail (`thumb=1`) or the ORIGINAL
 *                           bytes.
 *
 * The thumbnail is rendered CLIENT-side (canvas) and uploaded here. That is a
 * deliberate division: decoding a PNG needs no native dependency, a video frame
 * is reachable through the element the viewer already plays, and a document
 * falls back to a drawn card. Adding `sharp` / an ffmpeg binary to a sidebar
 * plugin would buy nothing a `<canvas>` cannot already do.
 *
 * The original-bytes path NEVER trusts the client's metadata: `readImage`
 * verifies the bytes against the reference's own media type, byte length and
 * dimensions, so the reference is re-derived from the session log by row id
 * here (a client-supplied one would fail verification anyway).
 *
 * Both halves are memoized (see `media-cache.ts`): the fold per session, the
 * per-row availability per identity. Without those two the page opening once
 * and the reader clicking one picture each paid a full log decode.
 */
import { rm, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type {
  Context,
  SidebarHttpResponse,
  SidebarImageAttachmentRef,
  SidebarSessionEvent,
} from './context-types.ts'
import { foldSessionMedia, isAttachmentItem, type MediaListRow, type MediaListValue, type SessionMediaItem } from './session-media.ts'
export type { MediaListRow, MediaListValue } from './session-media.ts'
import { readThumb, statThumb, thumbPathOf, thumbRootOf, writeThumb } from './media-store.ts'
import {
  PROBE_CONCURRENCY,
  createMediaCaches,
  mapWithConcurrency,
  type MediaCaches,
} from './media-cache.ts'
import { streamFileToResponse } from './file-stream.ts'
import { mediaTypeForPath } from './media-types.ts'
import { resolveTarget } from './path-security.ts'
import { requireString, SidebarError } from './wire.ts'

/** Newest events one fold reads; a pathological log is trimmed rather than refused. */
const MAX_EVENTS = 200_000

/** One cached catalogue: the folded rows plus the log length they came from. */
interface FoldedCatalogue {
  /** The live session's `seq` at fold time (absent for a detached session). */
  seq: number | undefined
  rows: readonly SessionMediaItem[]
}

/**
 * Read one session's whole event log: live when the host has the session
 * attached, persisted otherwise.
 * @param ctx - host plugin context.
 * @param sessionId - the session to read.
 * @returns the events, or none when the session cannot be read at all.
 */
async function sessionEvents(ctx: Context, sessionId: string): Promise<readonly SidebarSessionEvent[]> {
  const live = ctx.sessions.get(sessionId)
  if (live !== undefined) return live.snapshotEvents()
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return []
  let handle
  try {
    handle = await persistence.open(sessionId, 'read')
  } catch {
    return []
  }
  try {
    const { events } = await handle.read()
    return events
  } catch {
    return []
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * One session's folded catalogue, memoized per MOUNT.
 *
 * A LIVE session invalidates itself: the cache entry records the `seq` it was
 * folded at, and a session that appended since then re-folds (which is exactly
 * the moment a new picture can appear). A detached session has no live cursor,
 * so it rides the TTL alone.
 * @param ctx - host plugin context.
 * @param caches - this mount's cache pair.
 * @param sessionId - the session to fold.
 * @returns every media row, newest first.
 */
async function catalogueOf(ctx: Context, caches: MediaCaches, sessionId: string): Promise<readonly SessionMediaItem[]> {
  const seq = ctx.sessions.get(sessionId)?.seq
  const cached = caches.catalogue.get(sessionId) as FoldedCatalogue | undefined
  if (cached !== undefined && cached.seq === seq) return cached.rows
  const events = await sessionEvents(ctx, sessionId)
  const recent = events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events
  const rows = foldSessionMedia(recent)
  caches.catalogue.set(sessionId, { seq, rows })
  return rows
}

/**
 * Whether the original bytes of one row are still reachable, memoized per
 * identity.
 *
 * "The original is gone" is exactly the state the thumbnail exists for, so the
 * answer is shown per row — but it is a filesystem probe, and asking it again
 * for every render of a 500-row page is what this memo is for.
 * @param ctx - host plugin context.
 * @param caches - this mount's cache pair.
 * @param cwd - the session workspace (for a delivered file's path).
 * @param item - the catalogue row.
 * @returns true when the bytes can still be served.
 */
async function originalReachable(
  ctx: Context,
  caches: MediaCaches,
  cwd: string,
  item: SessionMediaItem,
): Promise<boolean> {
  const key = `${cwd}\u0000${item.id}`
  const cached = caches.reachable.get(key)
  if (cached !== undefined) return cached
  const answer = await probeOriginal(ctx, cwd, item)
  caches.reachable.set(key, answer)
  return answer
}

/**
 * One uncached availability probe.
 * @param ctx - host plugin context.
 * @param cwd - the session workspace.
 * @param item - the catalogue row.
 * @returns true when the bytes can still be served.
 */
async function probeOriginal(ctx: Context, cwd: string, item: SessionMediaItem): Promise<boolean> {
  if (isAttachmentItem(item)) {
    const store = ctx.get('attachments')
    if (store === undefined) return false
    try {
      const ref = refOfItem(item)
      if (store.imageHostPath !== undefined) {
        const path = store.imageHostPath(ref)
        if (path === undefined) return false
        return (await stat(path)).isFile()
      }
      await store.readImage(ref)
      return true
    } catch {
      return false
    }
  }
  if (item.path === undefined) return false
  try {
    const info = await stat(resolveTarget(cwd, item.path))
    return info.isFile()
  } catch {
    return false
  }
}

/**
 * The attachment reference of one catalogue row, rebuilt from what the log
 * carried.
 *
 * Every field is taken from the log because `readImage` verifies the bytes
 * against media type, byte length AND dimensions: a fabricated (or zeroed)
 * reference would be refused as `ATTACHMENT_CORRUPT` rather than read.
 * @param item - an attachment-backed catalogue row.
 * @returns the structural reference the attachment service takes.
 */
function refOfItem(item: SessionMediaItem): SidebarImageAttachmentRef {
  if (item.mediaType === undefined || item.bytes === undefined
    || item.width === undefined || item.height === undefined) {
    throw new SidebarError('not-found', 'the session log carries no complete reference for this item', 404)
  }
  return {
    attachmentId: item.id,
    mediaType: item.mediaType,
    bytes: item.bytes,
    width: item.width,
    height: item.height,
    ...(item.name === undefined ? {} : { name: item.name }),
  }
}

/**
 * Build the three JSON methods of the media viewer.
 * @param ctx - host plugin context.
 * @param cwdOf - the plugin's shared session-cwd resolver.
 * @returns the `/sidebar/api` methods this feature adds.
 */
export function buildMediaApi(
  ctx: Context,
  cwdOf: (payload: unknown) => Promise<{ sessionId: string; cwd: string }>,
  caches: MediaCaches = createMediaCaches(),
): {
  'media.list': (payload: unknown) => Promise<MediaListValue>
  'media.thumb.save': (payload: unknown) => Promise<{ bytes: number; created: boolean }>
  'media.thumb.delete': (payload: unknown) => Promise<{ removed: boolean }>
} {
  /** The plugin-owned store root, or a `unavailable` failure. */
  const rootOf = (): string => {
    const home = ctx.profileContext?.home
    if (home === undefined) throw new SidebarError('unavailable', 'the harness home is unknown', 503)
    return thumbRootOf(home)
  }
  return {
    'media.list': async (payload) => {
      const { sessionId, cwd } = await cwdOf(payload)
      const items = await catalogueOf(ctx, caches, sessionId)
      const home = ctx.profileContext?.home
      const root = home === undefined ? undefined : thumbRootOf(home)
      // Both probes are filesystem work, so they run as ONE bounded pool per
      // row rather than two serialized loops: a 500-row catalogue used to pay
      // 500 round trips twice over.
      const rows = await mapWithConcurrency(items, PROBE_CONCURRENCY, async (item): Promise<MediaListRow> => {
        const thumb = root === undefined ? false : (await statThumb(root, item.id)) !== undefined
        return { ...item, thumb, original: await originalReachable(ctx, caches, cwd, item) }
      })
      return { rows, attachments: ctx.get('attachments') !== undefined }
    },
    'media.thumb.save': async (payload) => {
      const root = rootOf()
      const id = requireString(payload, 'id')
      const data = (payload as { data?: unknown } | null)?.data
      if (typeof data !== 'string' || data === '') throw new SidebarError('bad-request', 'missing or invalid "data"')
      return writeThumb(root, id, Buffer.from(data, 'base64'))
    },
    'media.thumb.delete': async (payload) => {
      const root = rootOf()
      const id = requireString(payload, 'id')
      try {
        await rm(thumbPathOf(root, id))
        // The availability memo is about the ORIGINAL, not the thumbnail, so
        // it stays; the row turns "no thumbnail" on the next list by itself.
        return { removed: true }
      } catch {
        return { removed: false }
      }
    },
  }
}

/** One raw media request's parsed query. */
export interface MediaQuery {
  id: string
  /** Serve the stored thumbnail instead of the original. */
  thumb: boolean
  sessionId?: string
  cwd?: string
  /** Ask the browser to save the bytes instead of viewing them inline. */
  download?: boolean
}

/**
 * Serve one media row's thumbnail or original bytes.
 *
 * A stored thumbnail needs the identity alone; an original needs the session
 * (to resolve a delivered file's workspace-relative path, and to re-derive an
 * attachment's reference from the log).
 * @param ctx - host plugin context.
 * @param cwdOf - the plugin's shared session-cwd resolver.
 * @param query - the parsed request.
 * @param res - the response to write.
 * @param caches - the SAME cache pair `buildMediaApi` was given, so the list
 *   and the byte route share one fold instead of decoding the log twice.
 * @throws {SidebarError} not-found / unavailable when nothing can be served.
 */
export async function respondMedia(
  ctx: Context,
  cwdOf: (payload: unknown) => Promise<{ sessionId: string; cwd: string }>,
  query: MediaQuery,
  res: SidebarHttpResponse,
  caches: MediaCaches = createMediaCaches(),
): Promise<void> {
  if (query.thumb) {
    const home = ctx.profileContext?.home
    if (home === undefined) throw new SidebarError('unavailable', 'the harness home is unknown', 503)
    const bytes = await readThumb(thumbRootOf(home), query.id)
    if (bytes === undefined) throw new SidebarError('not-found', 'no thumbnail for this item', 404)
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': String(bytes.length),
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    })
    res.end(bytes)
    return
  }

  if (query.sessionId === undefined) {
    throw new SidebarError('bad-request', 'sessionId is required for the original bytes')
  }
  const { cwd } = await cwdOf({
    sessionId: query.sessionId,
    ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
  })

  // A delivered workspace file (`deliverables/presented`): streamed through the
  // same helper the media route uses, so Range keeps working and a camera clip
  // seeks instead of downloading itself first.
  if (!query.id.startsWith('sha256:')) {
    const path = resolveTarget(cwd, query.id)
    const info = await stat(path).catch(() => undefined)
    if (info === undefined || !info.isFile()) throw new SidebarError('not-found', 'the file is gone', 404)
    const name = basename(path)
    await streamFileToResponse(path, info.size, res, {
      'content-type': mediaTypeForPath(path),
      'cache-control': 'no-cache',
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-disposition': query.download === true
        ? `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
        : `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
    })
    return
  }

  const store = ctx.get('attachments')
  if (store === undefined) throw new SidebarError('unavailable', 'attachments are unavailable', 503)
  // Re-derive the reference from the LOG: `readImage` proves the bytes against
  // its media type, byte length and dimensions, so only the log's own values
  // can pass, and only for media this session actually carries. The catalogue
  // itself is memoized (see `catalogueOf`), so clicking through twenty pictures
  // decodes the log once, not twenty times.
  const items = await catalogueOf(ctx, caches, query.sessionId)
  const item = items.find(row => row.id === query.id)
  if (item === undefined) throw new SidebarError('not-found', 'this session carries no such media', 404)
  let stored
  try {
    stored = await store.readImage(refOfItem(item))
  } catch (error) {
    // The service refused (the object is gone, or the backend is not
    // image-backed): answer the plugin's own code so the client can show "the
    // original is gone, a thumbnail may remain" instead of a generic 500.
    // The memo learns it too, so the next list does not re-probe a dead object.
    caches.reachable.set(`${cwd}\u0000${item.id}`, false)
    throw new SidebarError('not-found', `the original is gone: ${error instanceof Error ? error.message : String(error)}`, 404)
  }
  res.writeHead(200, {
    'content-type': stored.ref.mediaType,
    'content-length': String(stored.data.byteLength),
    'cache-control': 'private, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
    // The stored object carries no file name of its own (it is a sha256), so
    // the log's display name is what a download is saved as.
    ...(query.download === true
      ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.name ?? `${item.id.slice('sha256:'.length, 'sha256:'.length + 12)}.png`)}` }
      : {}),
  })
  res.end(stored.data)
}
