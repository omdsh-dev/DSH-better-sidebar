// @vitest-environment jsdom
/**
 * D2 — local Markdown images inside Side Chat prose (spec:
 * docs/plans/2026-10-22-sidechat-render-parity/spec.md, contract C1 /
 * deliverable D2).
 *
 * The host `MarkdownText` only renders an image whose destination is an
 * absolute http(s) URL (a relative/local path falls back to its alt text).
 * Every Side Chat prose row must therefore rewrite its local image
 * destinations onto the plugin's own session-scoped media route
 * (`/sidebar/file?sessionId=…&path=…&cwd=…`) BEFORE the host parses the
 * markdown — relative paths resolved against the session cwd, absolute local
 * paths kept, code regions untouched, remote URLs unchanged.
 *
 * Rendered through the REAL SideChatView so the whole row pipeline (range
 * mapping → markdown surface rewrite → host renderer) is the subject.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'

/** The user prose: relative image, absolute local image, a fenced example
 *  that must stay literal, and a remote image that must stay remote. */
const USER_MD = [
  'Here are the pictures.',
  '',
  '![cat](./cat.png)',
  '',
  '![dog](/p/dog.png)',
  '',
  '![spaced](<./cat image.png>)',
  '',
  '```md',
  '![fenced](./fenced.png)',
  '```',
  '',
  '![remote](https://example.com/remote.png)',
].join('\n')

/** The assistant prose: a bare relative destination (no `./` prefix). */
const ASSISTANT_MD = '![chart](chart.png)'

const SESSION_CWD = '/p'
/** The panel's session and the thread it renders are both live sessions; the
 *  media route may be scoped to either one and both resolve this workspace. */
const SESSION_IDS = ['root', 't1']

/** Parse one img's src as a URL against the jsdom page base. */
function srcUrl(img: HTMLImageElement): URL {
  return new URL(img.getAttribute('src') ?? '', document.baseURI)
}

/** The media-route image for one absolute local path, if the DOM has it. */
function localImage(container: HTMLElement, path: string): HTMLImageElement | undefined {
  return [...container.querySelectorAll('img')].find((img) => {
    const url = srcUrl(img)
    return url.pathname.endsWith('/sidebar/file') && url.searchParams.get('path') === path
  })
}

describe('SideChatView local markdown images (C1)', () => {
  let harness: SidechatHarness

  beforeEach(() => {
    harness = installSidechatHarness({
      events: [
        { type: 'session/end-seed', seq: 0, time: 0, data: {} },
        { type: 'user/message', seq: 1, time: 1_000, data: { content: [{ type: 'text', text: USER_MD }], source: { kind: 'user' } } },
        { type: 'turn/start', seq: 2, time: 2_000, data: { turn: 1 } },
        {
          type: 'assistant/message',
          seq: 3,
          time: 3_000,
          data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: ASSISTANT_MD }] } },
        },
        { type: 'turn/end', seq: 4, time: 4_000, data: { turn: 1, reason: 'completed' } },
      ],
    })
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('renders relative and absolute local image destinations as /sidebar/file URLs', async () => {
    const view = harness.mount()
    await harness.flush()

    const relative = localImage(view.container, `${SESSION_CWD}/cat.png`)
    expect(relative, '![cat](./cat.png) must render as an img, not alt text').toBeDefined()
    const relativeSrc = relative!.getAttribute('src') ?? ''
    // The host renderer only accepts absolute http(s) destinations, so an
    // <img> here proves the rewrite produced exactly that.
    expect(relativeSrc).toMatch(/^https?:\/\//)
    const relativeUrl = srcUrl(relative!)
    expect(relativeUrl.searchParams.get('cwd')).toBe(SESSION_CWD)
    expect(SESSION_IDS, 'the media route stays session-scoped').toContain(relativeUrl.searchParams.get('sessionId'))
    // The same alt text must survive as the image's alt.
    expect(relative!.getAttribute('alt')).toBe('cat')

    const absolute = localImage(view.container, `${SESSION_CWD}/dog.png`)
    expect(absolute, '![dog](/p/dog.png) must render as an img').toBeDefined()
    expect(srcUrl(absolute!).searchParams.get('path')).toBe(`${SESSION_CWD}/dog.png`)

    // The assistant's bare relative destination resolves against the same cwd.
    const bare = localImage(view.container, `${SESSION_CWD}/chart.png`)
    expect(bare, '![chart](chart.png) must render as an img').toBeDefined()

    // A CommonMark angle destination carries a space in its path through the
    // whole pipeline (rewrite → host parse → media route query).
    const spaced = localImage(view.container, `${SESSION_CWD}/cat image.png`)
    expect(spaced, '![spaced](<./cat image.png>) must render as an img').toBeDefined()

    view.unmount()
  })

  it('leaves code regions and remote destinations alone', async () => {
    const view = harness.mount()
    await harness.flush()

    // Fenced code is rendered as its literal text — a rewrite inside the mask
    // would have replaced this example with a /sidebar/file URL.
    expect(view.container.textContent ?? '').toContain('![fenced](./fenced.png)')
    expect(
      [...view.container.querySelectorAll('img')].some(img => (img.getAttribute('src') ?? '').includes('fenced.png')),
      'a fenced example must never become an image',
    ).toBe(false)

    const remote = [...view.container.querySelectorAll('img')]
      .find(img => img.getAttribute('src') === 'https://example.com/remote.png')
    expect(remote, 'a remote image keeps rendering unchanged').toBeDefined()

    view.unmount()
  })
})
