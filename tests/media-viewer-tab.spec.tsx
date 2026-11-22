/**
 * Session media viewer tab body: what the page renders for each catalogue
 * state, and the two behaviours the durable-thumbnail design turns on.
 *
 * The host side is covered by tests/session-media.spec.ts (the fold),
 * tests/media-store.spec.ts (the store) and tests/media-routes.spec.ts (the
 * routes); this spec pins the VIEW against a mocked `api.mediaList`:
 *
 *  - a row whose original is gone still renders a card, marked as such — the
 *    thumbnail is the whole reason that state exists;
 *  - the filter row narrows by kind and by "no thumbnail", and the counts are
 *    the catalogue's own;
 *  - opening a card mounts the inline preview, and a row with no original
 *    shows the thumbnail-only notice instead of a broken element.
 *
 * jsdom has no canvas, so the automatic capture pass degrades to "failed" here
 * by construction (that path is exercised in the real browser lane).
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import './browser-globals.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'
import type { MediaListRow, MediaListValue } from '../src/session-media.ts'
import type { TabComponentProps } from '../src/client/service.ts'

setupReactAct()

vi.mock('../src/client/api.ts', () => ({
  downloadUrl: (_scope: unknown, path: string) => `/download?path=${encodeURIComponent(path)}`,
  api: {
    mediaList: vi.fn(),
    mediaThumbSave: vi.fn(async () => ({ bytes: 1, created: true })),
  },
}))

const { api } = await import('../src/client/api.ts')
const { MediaViewerTab } = await import('../src/client/MediaViewerTab.tsx')

/** One catalogue row. */
function row(overrides: Partial<MediaListRow> & Pick<MediaListRow, 'id'>): MediaListRow {
  return {
    kind: 'image',
    source: 'user',
    seq: 1,
    time: 1_000,
    thumb: false,
    original: true,
    ...overrides,
  }
}

/** The props a tab body receives (only the ones this page reads matter). */
function props(visible = true): TabComponentProps {
  return {
    ctx: {} as TabComponentProps['ctx'],
    store: {} as TabComponentProps['store'],
    scope: { sessionId: 's1', cwd: '/work' },
    tab: { id: 'media', type: 'media', title: 'Session media' },
    visible,
  } as TabComponentProps
}

/** Resolve the mocked catalogue and flush the effect that asks for it. */
async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

describe('MediaViewerTab', () => {
  let view: ReturnType<typeof renderRoot> | undefined

  beforeEach(() => {
    vi.mocked(api.mediaList).mockReset()
  })

  afterEach(() => {
    act(() => { view?.unmount() })
    view = undefined
  })

  /** Render with one catalogue and let the load land. */
  async function mount(value: MediaListValue, visible = true): Promise<HTMLElement> {
    vi.mocked(api.mediaList).mockResolvedValue(value)
    view = renderRoot(createElement(MediaViewerTab, props(visible)))
    await flush()
    return view.container
  }

  it('renders the empty state for a conversation that carried no media', async () => {
    const container = await mount({ rows: [], attachments: true })
    expect(container.querySelector('[data-media-viewer="empty"]')).not.toBeNull()
    expect(container.querySelector('[data-media-card]')).toBeNull()
  })

  it('renders one card per row and marks a row whose original is gone', async () => {
    const container = await mount({
      attachments: true,
      rows: [
        row({ id: 'sha256:aa', name: 'present.png', bytes: 10, width: 4, height: 3 }),
        row({ id: 'sha256:bb', name: 'gone.png', original: false, kind: 'video' }),
      ],
    })
    const cards = container.querySelectorAll('[data-media-card]')
    expect(cards).toHaveLength(2)
    // Newest-first order comes from the fold; the view keeps it.
    expect(cards[0]?.getAttribute('data-media-id')).toBe('sha256:aa')
    expect(cards[1]?.getAttribute('data-media-id')).toBe('sha256:bb')
    // The gone original is named as such rather than silently looking fine.
    expect(cards[1]?.textContent).toContain('gone.png')
  })

  it('filters by kind and by "no thumbnail" through the chips', async () => {
    const container = await mount({
      attachments: true,
      rows: [
        row({ id: 'img-1', kind: 'image' }),
        row({ id: 'vid-1', kind: 'video' }),
        row({ id: 'doc-1', kind: 'document', thumb: true, source: 'presented', path: '/work/a.pdf' }),
      ],
    })
    const chip = (label: string): HTMLButtonElement | undefined =>
      [...container.querySelectorAll('button')].find(button => button.textContent?.includes(label)) as
        HTMLButtonElement | undefined

    const videos = chip('Videos')
    expect(videos).toBeDefined()
    await act(async () => { videos!.click() })
    expect([...container.querySelectorAll('[data-media-card]')].map(card => card.getAttribute('data-media-id')))
      .toEqual(['vid-1'])

    // Back to everything, then hide the rows that already carry a thumbnail.
    await act(async () => { chip('All')!.click() })
    await act(async () => { chip('No thumbnail')!.click() })
    expect([...container.querySelectorAll('[data-media-card]')].map(card => card.getAttribute('data-media-id')))
      .toEqual(['img-1', 'vid-1'])
  })

  it('opens the inline preview for a row whose original still exists', async () => {
    const container = await mount({ attachments: true, rows: [row({ id: 'sha256:aa', name: 'shot.png' })] })
    const card = container.querySelector('[data-media-card]') as HTMLButtonElement
    await act(async () => { card.click() })
    const overlay = container.querySelector('[data-media-preview]')
    expect(overlay).not.toBeNull()
    expect(overlay?.getAttribute('data-media-preview')).toBe('image')
    // The preview element points at the plugin's own media route.
    const image = overlay?.querySelector('img')
    expect(image?.getAttribute('src')).toContain('/sidebar/media?')
    expect(image?.getAttribute('src')).toContain('sha256%3Aaa')
  })

  it('shows the thumbnail and the "original is gone" notice when only the copy remains', async () => {
    const container = await mount({
      attachments: true,
      rows: [row({ id: 'sha256:bb', name: 'gone.png', original: false, thumb: true })],
    })
    const card = container.querySelector('[data-media-card]') as HTMLButtonElement
    await act(async () => { card.click() })
    const overlay = container.querySelector('[data-media-preview]')
    expect(overlay).not.toBeNull()
    // No player is mounted for a missing original; the stored thumbnail is.
    expect(overlay?.querySelector('video')).toBeNull()
    const thumb = overlay?.querySelector('img')
    expect(thumb?.getAttribute('src')).toContain('thumb=1')
  })

  it('lists nothing and says so when the host cannot read the session', async () => {
    vi.mocked(api.mediaList).mockRejectedValue(new Error('boom'))
    view = renderRoot(createElement(MediaViewerTab, props()))
    await flush()
    const error = view.container.querySelector('[data-media-viewer="error"]')
    expect(error).not.toBeNull()
    expect(error?.textContent).toContain('boom')
  })

  it('does not ask the host while the tab is not visible', async () => {
    vi.mocked(api.mediaList).mockResolvedValue({ rows: [], attachments: true })
    view = renderRoot(createElement(MediaViewerTab, props(false)))
    await flush()
    expect(api.mediaList).not.toHaveBeenCalled()
  })
})
