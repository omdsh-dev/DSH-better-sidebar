// @vitest-environment jsdom
/**
 * D15 — a remote image in the transcript opens in the host's lightbox. Design
 * basis: `/tmp/bsb-parity/spec.md` §D15 and
 * `/root/dsh-web/app/packages/client/ui-primitives/src/markdown/render.tsx:632-663`.
 *
 * Why this spec exists: the main conversation renders images through
 * `MarkdownText`, whose `MarkdownImage` turns an `<img>` into a button and mounts
 * `ImageLightbox` — but only when the `MarkdownDelegateProvider` supplies
 * `fileImages` (`preview = fileImages`). The side chat's provider passes
 * `openFile` only, so its images are plain, unclickable `<img>` elements: the
 * same answer's screenshot enlarges in the main pane and does nothing here.
 *
 * ============================ CONTRACT ============================
 * The transcript's `MarkdownDelegateProvider` supplies
 *   `fileImages={{ resolve: () => undefined, labels }}`
 * where `labels` is the host's `ImageLightboxLabels & { open, loading, failed }`
 * resolved from the plugin dictionaries:
 *   `sideChatImageOpen` / `sideChatImageDialog` / `sideChatImageClose`
 *   (plus `sideChatImageLoading` / `sideChatImageFailed` for the failure copy).
 *
 * 1. A REMOTE http(s) image renders inside a `<button>` (the host's
 *    `imageButton`) whose accessible name starts with the localized
 *    `t('sideChatImageOpen')`; `<img src>` still points at the authored URL.
 * 2. Activating it mounts the host `ImageLightbox`: `role="dialog"`,
 *    `aria-modal="true"`, `aria-label === t('sideChatImageDialog')`, an `<img>`
 *    with the same source, and a close control named
 *    `t('sideChatImageClose')`.
 * 3. `Escape` closes it.
 * 4. `resolve: () => undefined` is deliberate: it keeps the lightbox without
 *    promising the renderer an inline preview URL, so an image LINK must NOT
 *    grow a hover preview card.
 * 5. Opening the lightbox issues NO request (it reuses the authored URL).
 * ==================================================================
 *
 * jsdom does not load images; the lightbox is a body portal, so it is queried on
 * `document.body`, not inside the view container.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'
import { t } from '../src/client/locales.ts'

/** The three label keys this contract names. */
const OPEN_KEY = 'sideChatImageOpen'
const DIALOG_KEY = 'sideChatImageDialog'
const CLOSE_KEY = 'sideChatImageClose'

/** The authored remote image. */
const IMAGE_URL = 'https://example.com/screenshot.png'

/** Every route the view asked for, in order. */
let routes: string[] = []

/** Translate a key this spec names but the build may not have yet. */
function copy(key: string, params?: Record<string, string | number>): string {
  return (t as unknown as (key: string, params?: Record<string, string | number>) => string)(key, params)
}

/** A turn whose answer embeds one remote image and one image LINK. */
function events(): unknown[] {
  return [
    { type: 'session/end-seed', seq: 0, time: 0, data: {} },
    { type: 'user/message', seq: 1, time: 1_000, data: { content: [{ type: 'text', text: 'show me' }], source: { kind: 'user' } } },
    { type: 'turn/start', seq: 2, time: 2_000, data: { turn: 1 } },
    {
      type: 'assistant/message',
      seq: 3,
      time: 3_000,
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [{
            type: 'text',
            text: `Here it is:\n\n![screenshot](${IMAGE_URL})\n\nAnd a link: [shot](src/shot.png).`,
          }],
        },
      },
    },
  ]
}

let harness: SidechatHarness

beforeEach(() => {
  routes = []
  harness = installSidechatHarness()
  harness.wire.events = events()
  const stubbed = globalThis.fetch
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    routes.push(String(input).split('/').pop() ?? '')
    return stubbed(input as string, init)
  })
})

afterEach(() => {
  harness.cleanup()
})

/** Mount the transcript and let the first pull settle. */
async function mountTranscript() {
  const rendered = harness.mount()
  await harness.flush(4)
  return rendered
}

/** The image the answer embeds. */
function remoteImage(container: HTMLElement): HTMLImageElement {
  const image = [...container.querySelectorAll<HTMLImageElement>('img')]
    .find(candidate => candidate.getAttribute('src') === IMAGE_URL)
  expect(image, 'the remote image renders').toBeDefined()
  return image as HTMLImageElement
}

/** The lightbox dialog, wherever the portal put it. */
function dialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="dialog"]')
}

describe('remote image lightbox (D15)', () => {
  it('wraps the remote image in the host preview control', async () => {
    const rendered = await mountTranscript()
    try {
      const open = copy(OPEN_KEY)
      expect(open, `the ${OPEN_KEY} key must exist in the locale dictionary`).not.toBe(OPEN_KEY)

      const image = remoteImage(rendered.container)
      expect(image.getAttribute('src'), 'the authored URL is untouched').toBe(IMAGE_URL)

      const button = image.closest('button')
      expect(button, 'the image sits inside the host preview button').not.toBeNull()
      expect(
        button?.getAttribute('aria-label') ?? '',
        'the control carries the localized open label',
      ).toContain(open)
      expect(button?.getAttribute('title'), 'and the same copy as its tooltip').toBe(open)
    } finally {
      rendered.unmount()
    }
  })

  it('opens the host lightbox and closes it on Escape', async () => {
    const rendered = await mountTranscript()
    try {
      const dialogLabel = copy(DIALOG_KEY)
      const closeLabel = copy(CLOSE_KEY)
      expect(dialogLabel, `the ${DIALOG_KEY} key must exist in the locale dictionary`).not.toBe(DIALOG_KEY)
      expect(closeLabel, `the ${CLOSE_KEY} key must exist in the locale dictionary`).not.toBe(CLOSE_KEY)

      expect(dialog(), 'no lightbox before the image is activated').toBeNull()
      const button = remoteImage(rendered.container).closest('button')
      expect(button, 'the preview control exists').not.toBeNull()
      act(() => { (button as HTMLButtonElement).click() })
      await harness.flush(2)

      const lightbox = dialog()
      expect(lightbox, 'activating the image opens the lightbox').not.toBeNull()
      expect(lightbox?.getAttribute('aria-modal'), 'it is a modal dialog').toBe('true')
      expect(lightbox?.getAttribute('aria-label'), 'the dialog is localized').toBe(dialogLabel)
      expect(
        lightbox?.querySelector('img')?.getAttribute('src'),
        'the lightbox shows the same source',
      ).toBe(IMAGE_URL)
      expect(
        [...(lightbox?.querySelectorAll('button') ?? [])].some(node => node.getAttribute('aria-label') === closeLabel),
        'the lightbox has a localized close control',
      ).toBe(true)

      // Escape dismisses it (the lightbox listens on window, capture phase).
      act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
      await harness.flush(2)
      expect(dialog(), 'Escape closes the lightbox').toBeNull()
    } finally {
      rendered.unmount()
    }
  })

  it('does not grow a hover preview on an image link while resolve declines', async () => {
    const rendered = await mountTranscript()
    try {
      const link = [...rendered.container.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.title.includes('src/shot.png'))
      expect(link, 'the image link renders as the host link control').toBeDefined()

      const imagesBefore = document.body.querySelectorAll('img').length
      // Hovering is what would mount the preview card; resolve() declines, so
      // the renderer never wraps the link in one.
      act(() => {
        ;(link as HTMLButtonElement).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
        ;(link as HTMLButtonElement).dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
      })
      await harness.flush(2)
      expect(
        document.body.querySelectorAll('img').length,
        'hovering an image link whose resolve() declines adds no preview image',
      ).toBe(imagesBefore)
      expect(dialog(), 'and no lightbox is opened by hovering').toBeNull()
    } finally {
      rendered.unmount()
    }
  })

  it('opens the lightbox without asking the wire for anything', async () => {
    const rendered = await mountTranscript()
    try {
      const before = [...routes]
      const button = remoteImage(rendered.container).closest('button')
      expect(button, 'the preview control exists').not.toBeNull()
      act(() => { (button as HTMLButtonElement).click() })
      await harness.flush(2)
      act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
      await harness.flush(2)
      expect(routes, 'the lightbox reuses the authored URL').toEqual(before)
    } finally {
      rendered.unmount()
    }
  })
})
