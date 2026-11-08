import { useLayoutEffect, useMemo, useReducer } from 'react'
import type { SidechatImageLimits, SidechatImageUpload } from '../sidechat-images.ts'
import { t } from './locales.ts'

export interface DraftImage { id: number; file: File; preview: string }
export interface SidechatDraftOwner {
  childId?: string
  active: boolean
  revision: number
  text: string
  images: DraftImage[]
}
export interface SidechatSendAttempt {
  owner: SidechatDraftOwner
  revision: number
  text: string
  images: readonly DraftImage[]
}

export function useSidechatDraft(childId: string | undefined) {
  const [, redraw] = useReducer((value: number) => value + 1, 0)
  const owner = useMemo<SidechatDraftOwner>(() => ({ childId, active: true, revision: 0, text: '', images: [] }), [childId])
  useLayoutEffect(() => {
    owner.active = true
    return () => {
      owner.active = false
      owner.images.forEach(image => URL.revokeObjectURL(image.preview))
      owner.images = []
    }
  }, [owner])
  const changed = (): void => { owner.revision++; redraw() }
  return {
    owner,
    setText(text: string) { owner.text = text; changed() },
    add(files: readonly File[], limits: SidechatImageLimits | undefined) {
      if (limits === undefined) throw new Error(t('sideChatImagesDisabled'))
      if (owner.images.length + files.length > limits.maxImagesPerMessage) throw new Error(t('sideChatImageLimit'))
      let bytes = owner.images.reduce((sum, image) => sum + image.file.size, 0)
      for (const file of files) {
        if (!limits.mediaTypes.includes(file.type as never)) throw new Error(t('sideChatImageFormat'))
        bytes += file.size
        if (file.size === 0 || file.size > limits.maxImageBytes || bytes > limits.maxMessageImageBytes) throw new Error(t('sideChatImageLimit'))
      }
      const added: DraftImage[] = []
      try {
        for (const file of files) added.push({ id: ++owner.revision, file, preview: URL.createObjectURL(file) })
      } catch (error) {
        added.forEach(image => URL.revokeObjectURL(image.preview))
        throw error
      }
      owner.images = [...owner.images, ...added]
      changed()
    },
    remove(id: number) {
      owner.images = owner.images.filter(image => {
        if (image.id !== id) return true
        URL.revokeObjectURL(image.preview)
        return false
      })
      changed()
    },
    capture(): SidechatSendAttempt {
      return { owner, revision: owner.revision, text: owner.text.trim(), images: [...owner.images] }
    },
    accept(attempt: SidechatSendAttempt) {
      if (!owner.active || attempt.owner !== owner) return
      const sent = new Set(attempt.images.map(image => image.id))
      owner.images = owner.images.filter(image => {
        if (!sent.has(image.id)) return true
        URL.revokeObjectURL(image.preview)
        return false
      })
      if (attempt.revision === owner.revision) owner.text = ''
      changed()
    },
  }
}

export async function encodeSidechatImages(attempt: SidechatSendAttempt): Promise<SidechatImageUpload[]> {
  const images: SidechatImageUpload[] = []
  for (const image of attempt.images) {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => { reject(new Error(t('sideChatImageReadError'))) }
      reader.onload = () => { resolve(String(reader.result).split(',')[1] ?? '') }
      reader.readAsDataURL(image.file)
    })
    if (!attempt.owner.active) throw new Error(t('sideChatImageOwnerChanged'))
    images.push({ mediaType: image.file.type as SidechatImageUpload['mediaType'], name: image.file.name, data })
  }
  return images
}
