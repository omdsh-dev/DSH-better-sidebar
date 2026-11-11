/**
 * `image` / `file` content blocks in the side transcript (D13).
 *
 * The main conversation shows the screenshot a reader attached, the image a
 * tool produced, and a chip for a document the model was given. The side
 * transcript kept only `text` blocks, so those turns claimed to be text-only.
 *
 * BYTES COME FROM THE HOST REMOTE, ADDRESSED TO THE THREAD:
 *   `ctx.get('remote').session.attachment({ sessionId, attachmentId })`
 * with `sessionId` = the thread whose own log references the attachment. The
 * host's `uiConversation.imageUrl` path is deliberately NOT used: it resolves
 * through `sessions.binding()`, which exists only for scopes the client
 * retained — a side thread is not one of them.
 *
 * One read per attachment id, shared by every block that names it, and the
 * object URL the read mints is revoked when the last thumbnail using it
 * unmounts. A read that declines (`{ ok: false }`, a carrier rejection, or no
 * remote namespace at all) renders the localized placeholder instead of a
 * broken image; a `file` block never reads bytes at all.
 */
import { useCallback, useSyncExternalStore } from 'react'
import { FileTypeIcon, fileSizeText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import type {
  SidechatAttachment,
  SidechatFileAttachment,
  SidechatImageAttachment,
} from './sidechat-transcript.ts'
import { t } from './locales.ts'
import css from './SideChatView.module.css'

/** What one attachment read is currently worth rendering. */
type AttachmentImageState =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'failed' }

/** One shared read: its state, the mounted thumbnails using it, and their
 *  re-render tickets. */
interface AttachmentImageEntry {
  state: AttachmentImageState
  /** Mounted thumbnails. The entry (and its object URL) dies with the last. */
  users: number
  listeners: Set<() => void>
}

/** The pending state. One module-level constant on purpose: `useSyncExternalStore`
 *  compares snapshots by identity, so a fresh object per read would loop. */
const LOADING: AttachmentImageState = { status: 'loading' }
/** The settled-failure state (same identity rule). */
const FAILED: AttachmentImageState = { status: 'failed' }

/**
 * The read cache, one entry per (thread, attachment id).
 *
 * Bounded by construction rather than by eviction: an entry exists only while
 * at least one thumbnail uses it (the subscription refcounts it) and is deleted
 * — with its object URL revoked — when the last one unmounts. The transcript
 * mounts a windowed tail, so the live set is the visible image rows.
 */
const entries = new Map<string, AttachmentImageEntry>()

/** The host Remote face this module needs (declared structurally: the plugin's
 *  context type does not carry it). */
interface RemoteAttachmentFace {
  session?: {
    attachment?: (request: { sessionId: string; attachmentId: string }) => Promise<unknown>
  }
}

/** The remote namespace, or undefined when the composition has none. */
function remoteOf(ctx: Context): RemoteAttachmentFace | undefined {
  try {
    return ctx.get('remote') as RemoteAttachmentFace | undefined
  } catch {
    return undefined
  }
}

/** One key per (thread, attachment id): the sharing and refcount unit. */
function entryKey(sessionId: string, attachmentId: string): string {
  return `${sessionId}\u0000${attachmentId}`
}

/** Decode the RPC's base64 payload into the Blob the thumbnail shows. */
function blobOf(base64: string, mediaType: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: mediaType })
}

/**
 * Read one attachment and publish its object URL to every thumbnail waiting on
 * it. Never throws: a failure becomes the placeholder state.
 */
function loadAttachment(
  ctx: Context,
  sessionId: string,
  attachmentId: string,
  mediaType: string,
  key: string,
  entry: AttachmentImageEntry,
): void {
  /** Publish one settled state — unless the entry was released meanwhile. */
  const settle = (state: AttachmentImageState): void => {
    if (entries.get(key) !== entry) {
      if (state.status === 'ready') URL.revokeObjectURL(state.url)
      return
    }
    entry.state = state
    for (const listener of entry.listeners) listener()
  }
  const read = remoteOf(ctx)?.session?.attachment
  if (typeof read !== 'function') {
    settle(FAILED)
    return
  }
  void (async (): Promise<void> => {
    try {
      const answer = await read({ sessionId, attachmentId }) as
        | { ok?: unknown; value?: { data?: unknown } }
        | undefined
      const data = answer?.ok === true ? answer.value?.data : undefined
      if (typeof data !== 'string' || data === '') {
        settle(FAILED)
        return
      }
      settle({ status: 'ready', url: URL.createObjectURL(blobOf(data, mediaType)) })
    } catch {
      // A carrier rejection is the same reader-visible fact as a declined read.
      settle(FAILED)
    }
  })()
}

/**
 * The current state of one attachment's shared read, subscribing for the
 * component's lifetime (and starting the read on the first subscriber).
 * @param ctx - client context (the Host Remote is read off it).
 * @param sessionId - the THREAD whose log references the attachment.
 * @param image - the narrowed image block.
 * @returns the state the thumbnail renders.
 */
export function useAttachmentImage(
  ctx: Context,
  sessionId: string,
  image: SidechatImageAttachment,
): AttachmentImageState {
  const key = entryKey(sessionId, image.attachmentId)
  const { attachmentId, mediaType } = image
  const subscribe = useCallback((listener: () => void) => {
    let entry = entries.get(key)
    if (entry === undefined) {
      entry = { state: LOADING, users: 0, listeners: new Set() }
      entries.set(key, entry)
      loadAttachment(ctx, sessionId, attachmentId, mediaType, key, entry)
    }
    const acquired = entry
    acquired.users += 1
    acquired.listeners.add(listener)
    return () => {
      acquired.listeners.delete(listener)
      acquired.users -= 1
      if (acquired.users > 0) return
      if (entries.get(key) === acquired) entries.delete(key)
      if (acquired.state.status === 'ready') URL.revokeObjectURL(acquired.state.url)
    }
  }, [key, ctx, sessionId, attachmentId, mediaType])
  const getSnapshot = useCallback((): AttachmentImageState => entries.get(key)?.state ?? LOADING, [key])
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** One image block: its thumbnail, or the localized read-failure placeholder. */
function AttachmentThumbnail(props: {
  ctx: Context
  sessionId: string
  image: SidechatImageAttachment
}): React.ReactNode {
  const { ctx, sessionId, image } = props
  const state = useAttachmentImage(ctx, sessionId, image)
  if (state.status === 'failed') {
    return <span className={css.sidechatAttachmentFailed}>{t('sideChatAttachmentImageFailed')}</span>
  }
  if (state.status !== 'ready') return null
  return (
    <img
      className={css.sidechatAttachmentThumb}
      src={state.url}
      alt={image.name ?? t('sideChatAttachmentImage')}
    />
  )
}

/** One non-image file: the host's name + size chip, with no byte read. */
function FileChip({ file }: { file: SidechatFileAttachment }): React.ReactNode {
  const size = file.bytes === undefined ? '' : fileSizeText(file.bytes)
  return (
    <span className={css.sidechatAttachmentFile} title={file.name}>
      <FileTypeIcon path={file.name} size={16} />
      <span className={css.sidechatAttachmentName}>{file.name}</span>
      {size === '' ? null : <span className={css.sidechatAttachmentSize}>{size}</span>}
    </span>
  )
}

/**
 * Render one row's `image` / `file` blocks in content order.
 * @param props.ctx - client context (Host Remote byte source).
 * @param props.sessionId - the thread that owns the referencing log.
 * @param props.attachments - the narrowed blocks (see sidechat-transcript.ts).
 * @returns the attachment strip, or null when the row has none.
 */
export function SidechatAttachments(props: {
  ctx: Context
  sessionId: string
  attachments: readonly SidechatAttachment[]
}): React.ReactNode {
  const { ctx, sessionId, attachments } = props
  if (attachments.length === 0) return null
  return (
    <div className={css.sidechatAttachments}>
      {attachments.map((attachment, index) => attachment.kind === 'image'
        ? (
          <AttachmentThumbnail
            key={`image:${index}:${attachment.image.attachmentId}`}
            ctx={ctx}
            sessionId={sessionId}
            image={attachment.image}
          />
        )
        : <FileChip key={`file:${index}:${attachment.file.name}`} file={attachment.file} />)}
    </div>
  )
}
