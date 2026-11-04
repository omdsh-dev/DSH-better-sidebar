import type { EncodedImageAttachment, ImageAttachmentLimits, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/**
 * Raster formats the Side Chat composer offers and the transcript projects.
 * This is the host's `ImageMediaType` union; a deployment's own
 * `imageLimits.mediaTypes` stays authoritative for what it accepts.
 */
export const SIDECHAT_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/**
 * Side Chat's own ceilings, layered on top of the host attachment policy (the
 * effective limit is the smaller of the two). They give the UI one predictable
 * budget even when a deployment allows more.
 */
export const SIDECHAT_MAX_IMAGES_PER_MESSAGE = 8
export const SIDECHAT_MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const SIDECHAT_MAX_MESSAGE_IMAGE_BYTES = 20 * 1024 * 1024

export type SidechatImageUpload = EncodedImageAttachment
export type SidechatImageLimits = Pick<ImageAttachmentLimits, 'maxImageBytes' | 'maxImagesPerMessage' | 'maxMessageImageBytes' | 'mediaTypes'>
export interface SidechatImageOccurrence {
  blockIndex: number
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}
export interface SidechatMessageContent {
  text: string
  images?: SidechatImageOccurrence[]
}

export function projectSidechatContent(content: unknown, separator = '\n'): SidechatMessageContent {
  if (typeof content === 'string') return { text: content }
  const texts: string[] = []
  const images: SidechatImageOccurrence[] = []
  if (Array.isArray(content)) content.forEach((block: unknown, blockIndex) => {
    if (block === null || typeof block !== 'object') return
    const value = block as { type?: unknown; text?: unknown; attachment?: ImageAttachmentRef }
    if (value.type === 'text' && typeof value.text === 'string') texts.push(value.text)
    if (value.type === 'image' && value.attachment !== null && typeof value.attachment === 'object') {
      const { mediaType, bytes, width, height, name } = value.attachment
      if (typeof mediaType !== 'string' || !(SIDECHAT_IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)
        || ![bytes, width, height].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
        || (name !== undefined && typeof name !== 'string')) return
      images.push({ blockIndex, mediaType, bytes, width, height, ...(name === undefined ? {} : { name }) })
    }
  })
  return { text: texts.join(separator), ...(images.length === 0 ? {} : { images }) }
}
