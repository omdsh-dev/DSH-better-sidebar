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

/**
 * How many threads keep a saved draft. Bounded because a saved image holds its
 * object URL alive for as long as the page lives.
 */
const DRAFT_CACHE_LIMIT = 8

/** A thread's draft while nothing is bound to it: the words, and the images whose previews it keeps alive. */
interface SavedDraft { text: string; images: DraftImage[] }

/** Saved drafts by thread id, least recently used first (`Map` keeps insertion order). */
const savedDrafts = new Map<string, SavedDraft>()

/** Owners whose prompt is under way: their draft is dropped, never saved. */
const sendingOwners = new WeakSet<SidechatDraftOwner>()

/** Release the previews a dropped draft was the last owner of. */
function releaseDraftImages(images: readonly DraftImage[]): void {
  images.forEach(image => URL.revokeObjectURL(image.preview))
}

/**
 * Drop every saved draft and release the previews they kept alive. The app has
 * no reason to call this (a saved draft is bounded and cheap); it exists so a
 * test can start from a clean cache between cases.
 */
export function clearSavedSidechatDrafts(): void {
  for (const draft of savedDrafts.values()) releaseDraftImages(draft.images)
  savedDrafts.clear()
}

/**
 * Save the draft of a binding that is going away, then keep the cache bounded
 * (least recently saved first out). An empty draft is not saved: it would evict
 * a real one for a mere visit.
 */
function saveDraft(owner: SidechatDraftOwner): void {
  const childId = owner.childId
  if (childId === undefined) return
  savedDrafts.delete(childId)
  if (owner.text !== '' || owner.images.length > 0) savedDrafts.set(childId, { text: owner.text, images: [...owner.images] })
  for (const [id, draft] of savedDrafts) {
    if (savedDrafts.size <= DRAFT_CACHE_LIMIT) break
    savedDrafts.delete(id)
    releaseDraftImages(draft.images)
  }
}

/**
 * Give a freshly created owner the draft its thread left behind. The saved copy
 * is taken out of the cache: the live owner holds it until the binding goes.
 * @returns whether a draft came back (the caller has to redraw).
 */
function restoreDraft(owner: SidechatDraftOwner): boolean {
  if (owner.childId === undefined) return false
  const saved = savedDrafts.get(owner.childId)
  if (saved === undefined) return false
  savedDrafts.delete(owner.childId)
  owner.text = saved.text
  owner.images = [...saved.images]
  // Keep the next `add` above the restored ids, or `remove(id)` could drop two images at once.
  for (const image of saved.images) {
    if (image.id > owner.revision) owner.revision = image.id
  }
  return true
}

export function useSidechatDraft(childId: string | undefined) {
  const [, redraw] = useReducer((value: number) => value + 1, 0)
  const owner = useMemo<SidechatDraftOwner>(() => ({ childId, active: true, revision: 0, text: '', images: [] }), [childId])
  useLayoutEffect(() => {
    owner.active = true
    // A draft belongs to its THREAD, not to the binding: pick it back up so
    // half-written words and their screenshots survive leaving and returning.
    if (restoreDraft(owner)) redraw()
    return () => {
      owner.active = false
      // An unbound tab has nowhere to save to, and a draft whose prompt is
      // already under way must not come back (it could be sent twice), so both
      // release their previews instead of leaving them to a saved copy.
      if (owner.childId === undefined || sendingOwners.has(owner)) {
        releaseDraftImages(owner.images)
        owner.images = []
        return
      }
      saveDraft(owner)
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
      // The prompt is under way from here: a binding that goes away mid-flight
      // must not hand the same words back to be sent a second time. `accept`
      // (sent) and `abandon` (failed) both clear the mark.
      sendingOwners.add(owner)
      return { owner, revision: owner.revision, text: owner.text.trim(), images: [...owner.images] }
    },
    /** The prompt never started (the request failed): the draft is the reader's again. */
    abandon(attempt: SidechatSendAttempt) {
      if (attempt.owner === owner) sendingOwners.delete(owner)
    },
    accept(attempt: SidechatSendAttempt) {
      if (!owner.active || attempt.owner !== owner) return
      sendingOwners.delete(owner)
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
  // From here on the prompt is under way — the composer's draft for this thread
  // belongs to that send now, not to a future visit to the thread.
  sendingOwners.add(attempt.owner)
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
