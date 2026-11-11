// @vitest-environment jsdom
/**
 * A side-chat DRAFT belongs to its thread and must survive leaving it — the
 * reader types half a question, clicks another conversation, comes back, and
 * the words (and the attached screenshots) are still there.
 *
 * Why this spec exists: the upstream owner hook (`useSidechatDraft(childId)`,
 * v0.30) creates a per-BINDING owner and RELEASES it on unmount — it revokes
 * every preview URL and drops the text. That is the right isolation — one
 * thread's draft can never appear under another thread's name — but it also
 * means switching away loses the draft the reader was mid-way through, which
 * the pre-merge per-tab draft map did preserve.
 *
 * ============================ CONTRACT ============================
 * 1. ROUND TRIP. Unmounting and re-mounting the same `childId` restores the
 *    draft: the text, and every image with its `id`, its `File` and its
 *    preview URL (the SAME url — nothing is re-minted, nothing revoked on the
 *    way out).
 * 2. ISOLATION. Two threads never see each other's draft: B starts empty while
 *    A holds one, and each keeps its own words across its own round trip.
 * 3. UNBOUND TABS DO NOT PERSIST (`childId === undefined`): a draft typed with
 *    no thread bound is gone after a remount.
 * 4. BOUNDED MEMORY. The cache holds at most EIGHT threads, least-recently-used
 *    evicted first; an evicted draft's preview URLs are REVOKED (leaking them
 *    is a page-level leak the reader can never get back), and re-mounting a
 *    thread never mints a second preview URL for the same image.
 * 5. SENT MEANS GONE. After `accept()` clears the composer, the persisted copy
 *    is gone too: a remount starts empty (no ghost draft resurrects and gets
 *    sent twice).
 * 6. UNCHANGED SEMANTICS: `remove(id)` still revokes exactly that one preview,
 *    and threads stay isolated (2).
 * ==================================================================
 *
 * The hook is exercised directly (a probe component, like
 * tests/use-sidechat-push.spec.ts) because the contract IS the hook: mount /
 * unmount is the whole subject, and driving it through the view would only add
 * fetch stubs between the test and the behaviour.
 *
 * The module keeps its cache across tests, so every test uses its OWN thread
 * ids and never relies on a clean slate.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useSidechatDraft } from '../src/client/sidechat-draft.ts'
import type { SidechatImageLimits } from '../src/sidechat-images.ts'
import { setupReactAct } from './test-utils.ts'

setupReactAct()

/** The thread cache size this contract pins. */
const CACHE_LIMIT = 8

/** Image limits a composition would report (jsdom never asks the host). */
const LIMITS = {
  maxImageBytes: 5_000_000,
  maxImagesPerMessage: 4,
  maxMessageImageBytes: 20_000_000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
} as unknown as SidechatImageLimits

/** What the hook hands a caller. */
type DraftApi = ReturnType<typeof useSidechatDraft>

/** A mounted probe: the hook's current API plus its unmount. */
interface Mounted {
  sink: { api?: DraftApi }
  unmount: () => void
}

/** Every preview URL the stub minted, in order. */
let minted: string[] = []
/** Every preview URL the hook released, in order. */
let revoked: string[] = []
let createUrl: Mock
let revokeUrl: Mock

beforeEach(() => {
  minted = []
  revoked = []
  createUrl = vi.fn(() => {
    const url = `blob:draft/${String(minted.length + 1)}`
    minted.push(url)
    return url
  })
  revokeUrl = vi.fn((url: string) => { revoked.push(url) })
  // jsdom implements neither; the hook is the only owner of these URLs.
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeUrl })
})

afterEach(() => {
  delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL
  delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL
})

/** Renders the hook for one childId and publishes its API to the test. */
function Probe(props: { childId: string | undefined; sink: { api?: DraftApi } }): ReactNode {
  props.sink.api = useSidechatDraft(props.childId)
  return null
}

/**
 * Mount the hook for one thread.
 * @param childId - the bound thread (undefined = an unbound tab).
 */
function mountDraft(childId: string | undefined): Mounted {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const sink: { api?: DraftApi } = {}
  act(() => { root.render(createElement(Probe, { childId, sink })) })
  return {
    sink,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

/** The mounted hook's current API. */
function apiOf(mounted: Mounted): DraftApi {
  const api = mounted.sink.api
  expect(api, 'the hook rendered').toBeDefined()
  return api as DraftApi
}

/** One small PNG-shaped file (never read, only held). */
function pngFile(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
}

/** Type a draft into a freshly mounted probe. */
function typeDraft(mounted: Mounted, text: string): DraftApi {
  const api = apiOf(mounted)
  act(() => { api.setText(text) })
  return api
}

/** Attach one image to a freshly mounted probe. */
function attachImage(mounted: Mounted, name: string): DraftApi {
  const api = apiOf(mounted)
  act(() => { api.add([pngFile(name)], LIMITS) })
  return api
}

describe('a draft survives leaving the thread (R-draft)', () => {
  it('restores the text and the image after the binding comes back', () => {
    const first = mountDraft('roundtrip-thread')
    const typed = typeDraft(first, 'half-written question')
    const attached = attachImage(first, 'shot.png')
    const image = attached.owner.images[0]
    expect(image, 'the image is attached').toBeDefined()
    expect(typed.owner.text).toBe('half-written question')
    first.unmount()

    expect(
      revoked,
      'unmounting no longer throws the preview away — the draft still owns it',
    ).not.toContain(image?.preview)

    const second = mountDraft('roundtrip-thread')
    const back = apiOf(second)
    expect(back.owner.text, 'the text comes back').toBe('half-written question')
    expect(back.owner.images, 'and the image with it').toHaveLength(1)
    expect(back.owner.images[0], 'with the same id and preview').toMatchObject({
      id: image?.id,
      preview: image?.preview,
    })
    expect(back.owner.images[0]?.file, 'the same File object, not a copy').toBe(image?.file)
    second.unmount()
  })

  it('mints no second preview URL when the same thread is mounted again', () => {
    const first = mountDraft('stable-thread')
    const preview = attachImage(first, 'stable.png').owner.images[0]?.preview
    first.unmount()

    for (let round = 0; round < 3; round += 1) {
      const again = mountDraft('stable-thread')
      expect(apiOf(again).owner.images[0]?.preview, 'the preview is reused').toBe(preview)
      again.unmount()
    }
    expect(createUrl, 'no page-level accumulation of object URLs').toHaveBeenCalledTimes(1)
  })

  it('keeps two threads apart while remembering each one', () => {
    const a = mountDraft('isolated-a')
    typeDraft(a, 'A draft')
    a.unmount()

    const b = mountDraft('isolated-b')
    expect(apiOf(b).owner.text, 'B never inherits A').toBe('')
    typeDraft(b, 'B draft')
    b.unmount()

    const aAgain = mountDraft('isolated-a')
    expect(apiOf(aAgain).owner.text, 'A gets its own words back').toBe('A draft')
    aAgain.unmount()

    const bAgain = mountDraft('isolated-b')
    expect(apiOf(bAgain).owner.text, 'and B its own').toBe('B draft')
    bAgain.unmount()
  })

  it('does not persist a draft typed with no thread bound', () => {
    const unbound = mountDraft(undefined)
    typeDraft(unbound, 'who am I writing to')
    unbound.unmount()

    const again = mountDraft(undefined)
    expect(apiOf(again).owner.text, 'an unbound tab has nowhere to persist').toBe('')
    again.unmount()
  })

  it('evicts the least recently used draft past the cache bound and revokes its previews', () => {
    const previews = new Map<string, string>()
    for (let index = 1; index <= CACHE_LIMIT + 1; index += 1) {
      const thread = `lru-${String(index)}`
      const mounted = mountDraft(thread)
      const api = attachImage(mounted, `${thread}.png`)
      const preview = api.owner.images[0]?.preview ?? ''
      previews.set(thread, preview)
      mounted.unmount()
    }

    expect(
      revoked,
      'the evicted draft releases the previews it was holding',
    ).toContain(previews.get(`lru-1`))
    expect(
      revoked,
      'a draft still inside the cache is not released',
    ).not.toContain(previews.get(`lru-${String(CACHE_LIMIT + 1)}`))

    // The newest and the second-oldest survive...
    for (const thread of [`lru-${String(CACHE_LIMIT + 1)}`, 'lru-2']) {
      const survivor = mountDraft(thread)
      expect(apiOf(survivor).owner.images, `${thread} is still cached`).toHaveLength(1)
      survivor.unmount()
    }
    // ...and the evicted one is gone for good.
    const evicted = mountDraft('lru-1')
    expect(apiOf(evicted).owner.images, 'the evicted draft is empty').toHaveLength(0)
    expect(apiOf(evicted).owner.text).toBe('')
    evicted.unmount()
  })

  it('drops the persisted draft once the message is sent', () => {
    const mounted = mountDraft('sent-thread')
    const api = typeDraft(mounted, 'ready to send')
    const attempt = api.capture()
    act(() => { api.accept(attempt) })
    expect(apiOf(mounted).owner.text, 'the composer is cleared').toBe('')
    mounted.unmount()

    const again = mountDraft('sent-thread')
    expect(apiOf(again).owner.text, 'no ghost draft comes back').toBe('')
    again.unmount()
  })

  it('revokes exactly one preview when an image is removed', () => {
    const mounted = mountDraft('remove-thread')
    const api = apiOf(mounted)
    act(() => { api.add([pngFile('one.png'), pngFile('two.png')], LIMITS) })
    const [first, second] = apiOf(mounted).owner.images
    expect(first, 'two images attached').toBeDefined()
    expect(second).toBeDefined()

    act(() => { apiOf(mounted).remove(first?.id as number) })

    expect(revoked, 'the removed preview is released').toContain(first?.preview)
    expect(revoked, 'the kept one is not').not.toContain(second?.preview)
    expect(apiOf(mounted).owner.images, 'and only the other one is left').toHaveLength(1)
    mounted.unmount()
  })
})
