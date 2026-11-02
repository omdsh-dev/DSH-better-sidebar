import type { AttachmentStore, PromptContentPart } from '@deepseek-ai/dsh-attachment'
import type { Context } from './context-types.ts'
import type { SidechatImageLimits } from './sidechat-images.ts'
import { SidebarError } from './wire.ts'

export const SIDECHAT_METADATA_BYTES = 1 << 20
export function sidechatAttachments(ctx: Context): AttachmentStore | undefined {
  const store = ctx.get('attachments') as AttachmentStore | undefined
  return typeof store?.admitPromptContent === 'function' && typeof store.readImage === 'function' ? store : undefined
}

export function sidechatImageLimits(ctx: Context): SidechatImageLimits | undefined {
  const limits = sidechatAttachments(ctx)?.imageLimits
  if (limits === undefined) return undefined
  return {
    maxImagesPerMessage: Math.min(8, limits.maxImagesPerMessage),
    maxImageBytes: Math.min(10 * 1024 * 1024, limits.maxImageBytes),
    maxMessageImageBytes: Math.min(20 * 1024 * 1024, limits.maxMessageImageBytes),
    mediaTypes: limits.mediaTypes.filter(type => ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)),
  }
}

export function sidechatPromptBodyLimit(ctx: Context): number {
  const limits = sidechatImageLimits(ctx)
  return SIDECHAT_METADATA_BYTES + (limits === undefined ? 0 : 4 * Math.ceil(limits.maxMessageImageBytes / 3) + 4 * limits.maxImagesPerMessage)
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
