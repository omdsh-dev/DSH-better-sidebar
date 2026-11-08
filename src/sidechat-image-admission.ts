import type { AttachmentStore, PromptContentPart } from '@deepseek-ai/dsh-attachment'
import type { Context } from './context-types.ts'
import type { SidechatImageLimits } from './sidechat-images.ts'
import {
  SIDECHAT_MAX_IMAGE_BYTES,
  SIDECHAT_MAX_IMAGES_PER_MESSAGE,
  SIDECHAT_MAX_MESSAGE_IMAGE_BYTES,
} from './sidechat-images.ts'
import { SidebarError } from './wire.ts'

export const SIDECHAT_METADATA_BYTES = 1 << 20
export function sidechatAttachments(ctx: Context): AttachmentStore | undefined {
  const store = ctx.get('attachments') as AttachmentStore | undefined
  // `isAttachmentError` is part of the seam the routes route failures with
  // (see sidechatAdmissionError), so a partial service is treated as absent.
  return typeof store?.admitPromptContent === 'function'
    && typeof store.readImage === 'function'
    && typeof store.isAttachmentError === 'function'
    ? store
    : undefined
}

export function sidechatImageLimits(ctx: Context): SidechatImageLimits | undefined {
  const limits = sidechatAttachments(ctx)?.imageLimits
  if (limits === undefined) return undefined
  return {
    maxImagesPerMessage: Math.min(SIDECHAT_MAX_IMAGES_PER_MESSAGE, limits.maxImagesPerMessage),
    maxImageBytes: Math.min(SIDECHAT_MAX_IMAGE_BYTES, limits.maxImageBytes),
    maxMessageImageBytes: Math.min(SIDECHAT_MAX_MESSAGE_IMAGE_BYTES, limits.maxMessageImageBytes),
    // The host publishes the deployment's accepted formats; re-listing them
    // here was a third copy of the same whitelist.
    mediaTypes: limits.mediaTypes,
  }
}

export function sidechatPromptBodyLimit(ctx: Context): number {
  const limits = sidechatImageLimits(ctx)
  return SIDECHAT_METADATA_BYTES + (limits === undefined ? 0 : 4 * Math.ceil(limits.maxMessageImageBytes / 3) + 4 * limits.maxImagesPerMessage)
}

/**
 * Host attachment codes that mean the caller proposed an OVERSIZED image.
 * `isAttachmentError` covers caller-correctable admission failures AND
 * storage faults, so the wire mapping routes on the stable code: oversize is
 * 413 `too-large`, everything else (including ATTACHMENT_WRITE_FAILED and
 * friends) is a server-side 500 `sidechat-error`. Pixels and intrinsic
 * dimensions are the live cases the plugin cannot pre-check without decoding.
 */
const IMAGE_TOO_LARGE_CODES: ReadonlySet<string> = new Set([
  'TOO_MANY_IMAGES',
  'IMAGES_TOO_LARGE',
  'IMAGE_TOO_LARGE',
  'IMAGE_TOO_MANY_PIXELS',
  'IMAGE_DIMENSION_TOO_LARGE',
])

/**
 * Map one `admitPromptContent` rejection onto the sidebar wire error, keeping
 * the host's message: an oversized image is the caller's input problem (413),
 * a storage fault is not (500).
 */
export function sidechatAdmissionError(store: AttachmentStore, error: unknown): SidebarError {
  const message = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: unknown }).code
  if (store.isAttachmentError(error) && typeof code === 'string' && IMAGE_TOO_LARGE_CODES.has(code)) {
    return new SidebarError('too-large', message, 413)
  }
  return new SidebarError('sidechat-error', message, 500)
}

export function parseSidechatPrompt(payload: unknown, limits: SidechatImageLimits | undefined): { childId: string; text: string; content: PromptContentPart[]; hasImages: boolean } {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new SidebarError('bad-request', 'prompt must be an object')
  const value = payload as Record<string, unknown>
  if (Object.keys(value).some(key => !['childId', 'text', 'images'].includes(key))) throw new SidebarError('bad-request', 'Unknown prompt field')
  if (typeof value.childId !== 'string' || value.childId.trim() === '') throw new SidebarError('bad-request', 'childId is required')
  if (typeof value.text !== 'string') throw new SidebarError('bad-request', 'text is required')
  const text = value.text.trim()
  const uploads = value.images ?? []
  if (!Array.isArray(uploads)) throw new SidebarError('bad-request', 'images must be an array')
  if (uploads.length > 0 && limits === undefined) throw new SidebarError('unavailable', 'Image attachments are unavailable', 503)
  if (uploads.length > (limits?.maxImagesPerMessage ?? 0)) throw new SidebarError('too-large', 'Too many images', 413)
  const content: PromptContentPart[] = text === '' ? [] : [{ type: 'text', text }]
  const metadata: unknown[] = []
  let bytes = 0
  for (const raw of uploads) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new SidebarError('bad-request', 'Invalid image upload')
    const image = raw as Record<string, unknown>
    if (Object.keys(image).some(key => !['mediaType', 'data', 'name'].includes(key))
      || typeof image.mediaType !== 'string' || !limits!.mediaTypes.includes(image.mediaType as never)
      || typeof image.data !== 'string' || (image.name !== undefined && (typeof image.name !== 'string' || image.name.length > 256))) {
      throw new SidebarError('bad-request', 'Images must contain encoded bytes, a supported media type and an optional name')
    }
    const data = image.data
    const size = Math.floor(data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
    if (size > limits!.maxImageBytes || (bytes += size) > limits!.maxMessageImageBytes) throw new SidebarError('too-large', 'Image byte limit exceeded', 413)
    if (data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new SidebarError('bad-request', 'Invalid image base64')
    const name = image.name as string | undefined
    metadata.push({ ...image, data: '' })
    content.push({ type: 'image', mediaType: image.mediaType as import('@deepseek-ai/dsh-attachment').ImageMediaType, data, ...(name === undefined ? {} : { name }) })
  }
  if (Buffer.byteLength(JSON.stringify({ ...value, images: metadata })) > SIDECHAT_METADATA_BYTES) throw new SidebarError('too-large', 'Prompt metadata exceeds 1 MiB', 413)
  if (content.length === 0) throw new SidebarError('bad-request', 'text or images are required')
  return { childId: value.childId, text, content, hasImages: uploads.length > 0 }
}
