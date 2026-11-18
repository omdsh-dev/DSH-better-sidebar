/**
 * The session media catalogue: every image / video / audio / document one
 * conversation ever carried, folded out of its durable event log.
 *
 * Why this exists: DSH renders media only where the chat happens to show it
 * (a message bubble, one tool result), so there has never been a way to look
 * at "everything this conversation saw". The log does hold every reference —
 * a `{ type: 'image', attachment }` content block, or a `deliverables/presented`
 * file list — but nothing enumerates it. This module is that enumeration: a
 * pure fold over events, with no I/O, so both the live session store and a
 * cold persisted log feed it through the same code.
 *
 * Identity:
 *  - an attachment-backed item is keyed by its `attachmentId` (`sha256:<hex>`),
 *    the content address DSH's store already deduplicates on;
 *  - a delivered workspace file is keyed by its absolute `path`, because the
 *    same picture can be handed over repeatedly across turns.
 */
import type { SidebarSessionEvent } from './context-types.ts'

/** What one media row is, decided from its media type or its file extension. */
export type SessionMediaKind = 'image' | 'video' | 'audio' | 'document' | 'other'

/** Where the media entered the conversation. */
export type SessionMediaSource = 'user' | 'tool' | 'inbox' | 'presented'

/** One durable attachment reference as the log stores it (image form). */
export interface SessionMediaAttachmentRef {
  attachmentId: string
  mediaType?: string
  bytes?: number
  width?: number
  height?: number
  name?: string
}

/** One media row of a session. */
export interface SessionMediaItem {
  /** Stable identity: `attachmentId` for attachments, `path` for delivered files. */
  id: string
  kind: SessionMediaKind
  source: SessionMediaSource
  /** `image` / `file` for attachment rows; absent for delivered files. */
  block?: 'image' | 'file'
  /** MIME type when the log carried one (attachment rows only). */
  mediaType?: string
  /** Display name (attachment `name`, or the delivered file's basename). */
  name?: string
  /** Byte length when the log carried one. */
  bytes?: number
  width?: number
  height?: number
  /** Absolute workspace path of a delivered file. */
  path?: string
  /** `seq` of the event that introduced the media (first sighting). */
  seq: number
  /** Epoch ms of the introducing event. */
  time: number
  /** 1-based turn of the introducing event, when the event carried one. */
  turn?: number
}

/** Extension → kind. Deliberately small: only what a session plausibly carries. */const VIDEO_EXTS = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'mpeg', 'mpg'])
const AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif'])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg', 'ico', 'tif', 'tiff', 'heic', 'heif'])
const DOCUMENT_EXTS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'markdown', 'csv', 'json', 'html', 'htm', 'rtf',
])

/** Lowercase extension of a name or path, without its dot. */
function extOf(value: string): string {
  const match = /\.([A-Za-z0-9]+)$/u.exec(value)
  return match?.[1]?.toLowerCase() ?? ''
}

/**
 * Classify one media type (attachment rows) or one file extension (delivered
 * files).
 * @param mediaType - the MIME type the log carried, when it carried one.
 * @param nameOrPath - the display name or absolute path.
 * @returns the coarse kind the viewer groups by.
 */
export function mediaKindOf(mediaType: string | undefined, nameOrPath: string | undefined): SessionMediaKind {
  // An image block's media type is authoritative: DSH only admits raster types
  // there, so nothing else can be behind it.
  if (mediaType !== undefined && mediaType !== '') {
    if (mediaType.startsWith('image/')) return 'image'
    if (mediaType.startsWith('video/')) return 'video'
    if (mediaType.startsWith('audio/')) return 'audio'
    if (mediaType === 'application/pdf') return 'document'
  }
  const ext = extOf(nameOrPath ?? '')
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (DOCUMENT_EXTS.has(ext)) return 'document'
  return 'other'
}

/** Whether a delivered workspace file is media the viewer should list at all. */
export function isMediaCandidate(path: string): boolean {
  return mediaKindOf(undefined, path) !== 'other'
}

/** One row's accumulating state while the fold runs. */
interface Fold {
  item: SessionMediaItem
  /** Lowest `seq` seen for this identity — the introducing event. */
  firstSeq: number
}

/** The accumulator handed to {@link foldSessionMedia}. */
export class SessionMediaIndex {
  private readonly rows = new Map<string, Fold>()

  /**
   * Record one media occurrence. A later occurrence NEVER replaces the
   * introducing event's metadata: the first sighting is the one whose `seq`
   * the viewer deep-links to, and a repeated reference carries the same
   * content address anyway. It only fills fields the first sighting lacked
   * (a tool result may know the byte length the message did not).
   * @param item - the row as this event reported it.
   */
  add(item: SessionMediaItem): void {
    const existing = this.rows.get(item.id)
    if (existing === undefined) {
      this.rows.set(item.id, { item, firstSeq: item.seq })
      return
    }
    if (item.seq < existing.firstSeq) {
      // An EARLIER sighting (a surface replay can deliver events out of
      // order): its identity metadata wins, but keep anything it lacks.
      const merged: SessionMediaItem = { ...existing.item, ...item }
      existing.item = merged
      existing.firstSeq = item.seq
      return
    }
    const target = existing.item
    target.bytes ??= item.bytes
    target.width ??= item.width
    target.height ??= item.height
    target.mediaType ??= item.mediaType
    target.name ??= item.name
    target.path ??= item.path
  }

  /** Every row seen so far, newest first (the viewer's default order). */
  drain(): SessionMediaItem[] {
    return [...this.rows.values()]
      .map(row => row.item)
      .sort((left, right) => right.seq - left.seq)
  }
}

/** The message-ish event payloads this fold reads media out of. */
interface ContentCarrier {
  content?: unknown
}

/**
 * Walk one `content` array and record every image / file block.
 * @param index - the accumulator.
 * @param content - the block array (unknown: logs are untrusted JSON).
 * @param meta - the envelope the blocks belong to.
 */
function addBlocks(
  index: SessionMediaIndex,
  content: unknown,
  meta: { seq: number; time: number; turn?: number; source: SessionMediaSource },
): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const value = block as { type?: unknown; attachment?: unknown }
    if (value.type !== 'image' && value.type !== 'file') continue
    const ref = value.attachment as SessionMediaAttachmentRef | null | undefined
    if (ref === null || typeof ref !== 'object') continue
    if (typeof ref.attachmentId !== 'string' || ref.attachmentId === '') continue
    const name = typeof ref.name === 'string' && ref.name !== '' ? ref.name : undefined
    const mediaType = typeof ref.mediaType === 'string' && ref.mediaType !== '' ? ref.mediaType : undefined
    index.add({
      id: ref.attachmentId,
      kind: mediaKindOf(mediaType, name),
      source: meta.source,
      block: value.type,
      ...(mediaType === undefined ? {} : { mediaType }),
      ...(name === undefined ? {} : { name }),
      ...(typeof ref.bytes === 'number' && Number.isFinite(ref.bytes) ? { bytes: ref.bytes } : {}),
      ...(typeof ref.width === 'number' && Number.isFinite(ref.width) ? { width: ref.width } : {}),
      ...(typeof ref.height === 'number' && Number.isFinite(ref.height) ? { height: ref.height } : {}),
      seq: meta.seq,
      time: meta.time,
      ...(meta.turn === undefined ? {} : { turn: meta.turn }),
    })
  }
}

/** The `source.kind` strings that mean "the user put this here". */
const USER_SOURCE_KINDS = new Set(['user', 'inject', 'retry'])

/**
 * Classify one message event's origin.
 * @param kind - the event's `data.source.kind`, when it carried one.
 * @returns the coarse origin the viewer groups by.
 */
function sourceOfMessage(kind: unknown): SessionMediaSource {
  return typeof kind === 'string' && USER_SOURCE_KINDS.has(kind) ? 'user' : 'tool'
}

/**
 * Fold one session's events into its media catalogue.
 *
 * The events read, and why:
 *  - `user/message` — everything the user attached (images and verbatim files);
 *  - `tool/result` — everything a tool handed back (`read_image`, a screenshot,
 *    a rendered frame). The block shape is identical to the user's;
 *  - `agent/inbox/spliced` — the PTC / subagent replay of those same blocks.
 *    It duplicates what the other two already carry, which the content address
 *    makes harmless;
 *  - `deliverables/presented` — workspace files (`present`) that are NOT in the
 *    attachment store at all, so they need their own identity (`path`).
 *
 * `assistant/message` is read too: the block type is role-neutral in DSH's
 * message model, and an imported or forked log can legitimately hold one.
 * @param events - the session log, in `seq` order (order is not required).
 * @returns the catalogue, newest first.
 */
export function foldSessionMedia(events: readonly SidebarSessionEvent[]): SessionMediaItem[] {
  const index = new SessionMediaIndex()
  for (const event of events) {
    const data = event.data as Record<string, unknown> | undefined
    if (data === undefined) continue
    const seq = event.seq
    const time = event.time
    switch (event.type) {
      case 'user/message': {
        const source = (data.source ?? {}) as { kind?: unknown }
        addBlocks(index, data.content, { seq, time, source: sourceOfMessage(source.kind) })
        break
      }
      case 'tool/result': {
        const message = (data.message ?? {}) as ContentCarrier & { turn?: unknown }
        addBlocks(index, message.content, {
          seq,
          time,
          source: 'tool',
          ...(typeof data.turn === 'number' ? { turn: data.turn } : {}),
        })
        break
      }
      case 'agent/inbox/spliced': {
        const inserted = data.inserted
        if (!Array.isArray(inserted)) break
        for (const message of inserted) {
          if (message === null || typeof message !== 'object') continue
          const carrier = message as ContentCarrier & { source?: { kind?: unknown } }
          addBlocks(index, carrier.content, {
            seq,
            time,
            source: sourceOfMessage(carrier.source?.kind),
          })
        }
        break
      }
      case 'assistant/message': {
        const message = (data.message ?? {}) as ContentCarrier & { turn?: unknown }
        addBlocks(index, message.content, {
          seq,
          time,
          source: 'tool',
          ...(typeof data.turn === 'number' ? { turn: data.turn } : {}),
        })
        break
      }
      case 'deliverables/presented': {
        const files = data.files
        if (!Array.isArray(files)) break
        for (const file of files) {
          if (file === null || typeof file !== 'object') continue
          const { path } = file as { path?: unknown }
          if (typeof path !== 'string' || path === '') continue
          if (!isMediaCandidate(path)) continue
          const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
          index.add({
            id: path,
            kind: mediaKindOf(undefined, path),
            source: 'presented',
            ...(name === '' ? {} : { name }),
            path,
            seq,
            time,
            ...(typeof data.turn === 'number' ? { turn: data.turn } : {}),
          })
        }
        break
      }
      default:
        break
    }
  }
  return index.drain()
}

/**
 * Whether a catalogue row is attachment-backed (as opposed to a delivered
 * workspace file). `path` rows are identity-by-path and never touch the
 * attachment store.
 * @param item - one catalogue row.
 * @returns true for a row read out of a `{ type: 'image' | 'file' }` block.
 */
export function isAttachmentItem(item: SessionMediaItem): boolean {
  return item.block !== undefined
}

/** The file extension a delivered row's thumbnail key should mirror. */
export function deliveredExtOf(item: SessionMediaItem): string {
  const ext = extOf(item.path ?? item.name ?? '')
  return ext === '' ? 'bin' : ext
}

/** The leaf name of one path, under either separator style. */
export function leafOf(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/**
 * One catalogue row as the WIRE carries it: the fold's own fields plus the two
 * facts the viewer is built around.
 *
 * Declared here (and not in `media-routes.ts`) on purpose: the client imports
 * this type, and this module is the one place in the graph with no Node import
 * — a `import type` from the host module would be erased anyway, but keeping
 * the shared vocabulary in a browser-safe module means a future `export` of a
 * value from there can never drag `node:fs` into the page bundle.
 */
export interface MediaListRow extends SessionMediaItem {
  /** Whether a plugin-owned thumbnail already exists for this row. */
  thumb: boolean
  /** Whether the ORIGINAL bytes are still reachable. */
  original: boolean
}

/** The `media.list` value. */
export interface MediaListValue {
  rows: MediaListRow[]
  /** Whether the host attachment store is mounted at all. */
  attachments: boolean
}

/** A row's display label: its name, else the path's leaf, else its id. */
export function mediaLabelOf(item: SessionMediaItem): string {
  if (item.name !== undefined && item.name !== '') return item.name
  if (item.path !== undefined) {
    const leaf = leafOf(item.path)
    if (leaf !== '') return leaf
  }
  return item.id
}
