import type { EncodedImageAttachment, ImageAttachmentLimits, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

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
      if (typeof mediaType !== 'string' || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)
        || ![bytes, width, height].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
        || (name !== undefined && typeof name !== 'string')) return
      images.push({ blockIndex, mediaType, bytes, width, height, ...(name === undefined ? {} : { name }) })
    }
  })
  return { text: texts.join(separator), ...(images.length === 0 ? {} : { images }) }
}
