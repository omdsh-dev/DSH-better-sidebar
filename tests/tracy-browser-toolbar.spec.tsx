// @vitest-environment jsdom
/**
 * `BrowserView`'s address bar after option B2 (Brian, approved 29/09 ~16:00; TCH stories
 * `ToolbarCommentsSplit… · ToolbarCopyLinkCopied` in `browser-comment.mock.stories.tsx`): Go is gone in
 * every width (Enter in the address still navigates), the copy button takes Go's slot and says "Link
 * copied" in its own tooltip (no yellow row under the bar), the strip under the address bar is gone,
 * the Comments split button follows Edit and its left part asks the chat column to open the Comments
 * tab (`tracy:comments-open`), and below a 360 px frame the zoom chip is hidden. What the split button
 * itself draws is held by `comments-toolbar.spec.tsx`.
 *
 * Harness copied from `tracy-browser-compact.spec.tsx` (primitives stubbed: a second React on some
 * machines).
 */
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const icon = () => null
  const { createElement: h } = await import('react')
  return {
    Menu: (p: { anchor: unknown }) => p.anchor,
    Pill: (p: { 'aria-label'?: string; onClick?: () => void; children?: unknown }) => h('button', { type: 'button', 'aria-label': p['aria-label'], onClick: p.onClick }, p.children as string),
    IconChevronLeftOutlineRegular: icon,
    IconChevronRightOutlineRegular: icon,
    IconLinkOutlineRegular: icon,
    IconRefreshOutlineRegular: icon,
    IconWarningOutlineRegular: icon,
  }
})
vi.mock('../src/client/api.ts', () => ({
  api: { browserProbe: vi.fn(async () => ({ reachable: false })) },
  mediaUrl: () => '',
}))

import type { Context } from '../src/context-types.ts'
import { BrowserView, TRACY_BROWSER_KIND } from '../src/client/BrowserView.tsx'
import { resetCommentModeMemo } from '../src/client/comment-controller.ts'
import { PREVIEW_CHANNEL, PREVIEW_VERSION } from '../src/client/preview-protocol.generated.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { COMMENTS_OPEN_EVENT } from '../src/client/comment-store.ts'
import css from '../src/client/sidebar.module.css'

const SITE = 'http://northgate.tracy.test:8080'
const PAGE = `${SITE}/`

const updates: Array<{ id: string; patch: { meta?: Record<string, unknown> } }> = []
let root: Root | null = null
let host: HTMLDivElement
let frameWidth = 0
const observers: Array<() => void> = []

class FakeResizeObserver {
  private readonly callback: () => void
  constructor(callback: () => void) {
    this.callback = callback
    observers.push(() => { this.callback() })
  }

  observe(): void {}
  disconnect(): void {}
}

function props(meta: Record<string, unknown>) {
  const ctx = {
    get: (name: string) => (name === 'betterSidebar' ? { updateTab: (id: string, patch: { meta?: Record<string, unknown> }) => { updates.push({ id, patch }) } } : undefined),
  } as unknown as Context
  return {
    ctx,
    store: createSidebarStore(),
    scope: { sessionId: 's1', cwd: '/p' },
    tab: { id: 'native-7', type: TRACY_BROWSER_KIND, title: 'northgate', meta },
    visible: true,
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve() })
}

async function mount(meta: Record<string, unknown>): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(createElement(BrowserView, props(meta))) })
  await flush()
}

async function resize(width: number): Promise<void> {
  frameWidth = width
  await act(async () => { for (const fire of observers) fire() })
}

async function enterEdit(): Promise<void> {
  const win = (host.querySelector('iframe') as HTMLIFrameElement).contentWindow as Window
  win.postMessage = (() => {}) as Window['postMessage']
  await act(async () => {
    const event = new MessageEvent('message', { data: { channel: PREVIEW_CHANNEL, v: PREVIEW_VERSION, kind: 'ready', features: ['pick', 'track'], url: PAGE }, origin: SITE })
    Object.defineProperty(event, 'source', { value: win })
    window.dispatchEvent(event)
  })
  await flush()
}

const button = (label: string): HTMLButtonElement | null =>
  [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label) ?? null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  updates.length = 0
  observers.length = 0
  frameWidth = 0
  resetCommentModeMemo()
  localStorage.clear()
  const base = document.createElement('base')
  base.href = `${location.origin}/northgate/`
  document.head.append(base)
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input === '/api/config') return new Response(JSON.stringify({ siteDomain: 'tracy.test' }), { status: 200 })
    if (input === '/api/sites/northgate/preview-ticket') return new Response(JSON.stringify({ ticket: 'pv1.T', exp: 1 }), { status: 200 })
    if (input === '/api/sites/northgate/apply') return new Response(JSON.stringify({ status: 'none' }), { status: 200 })
    return new Response('{}', { status: 404 })
  }))
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US', platform: 'MacIntel', userAgent: 'x' }, configurable: true })
  // The window stays wide: only the frame may decide.
  Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains(css.commentOverlay!) ? frameWidth : 0
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains(css.commentOverlay!) ? 700 : 0
  })
})

afterEach(async () => {
  if (root !== null) await act(async () => { root!.unmount() })
  root = null
  document.body.replaceChildren()
  document.head.querySelectorAll('base').forEach(b => { b.remove() })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})


const SESSION_TAB = 'native-7'

describe('Go is gone; the copy button takes its slot (option B2)', () => {
  it.each([900, 380])('a %i px frame: no Go; on a Tracy site page the copy button sits right after the address', async (width) => {
    frameWidth = width
    await mount({ url: PAGE })
    expect(button('Go')).toBeNull()
    const input = host.querySelector(`.${css.browserInput!}`)!
    expect(input.nextElementSibling!.querySelector('[aria-label="Copy link to this page in this mode"]')).not.toBeNull()
  })

  it('a page that is not a Tracy site: nothing in that slot, Open in browser follows the address', async () => {
    frameWidth = 900
    await mount({ url: 'https://example.com/' })
    const input = host.querySelector(`.${css.browserInput!}`)!
    expect(input.nextElementSibling!.getAttribute('aria-label')).toBe('Open in browser')
  })

  it('in a wide frame, Enter in the address still navigates', async () => {
    frameWidth = 900
    await mount({ url: PAGE })
    const input = host.querySelector(`.${css.browserInput!}`) as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, `${SITE}/about`)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await flush()
    expect(updates.some(u => u.patch.meta?.url === `${SITE}/about`)).toBe(true)
    expect((host.querySelector('iframe') as HTMLIFrameElement).title).toBe(`${SITE}/about`)
  })

  it('"Link copied" is the copy button\'s own tooltip, never a row under the bar', async () => {
    const exec = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true })
    frameWidth = 900
    await mount({ url: PAGE })
    await act(async () => { button('Copy link to this page in this mode')!.click() })
    await flush()
    expect(exec).toHaveBeenCalledWith('copy')
    expect(host.querySelector('[role="status"]')!.textContent).toBe('Link copied')
    expect(host.querySelector(`.${css.browserMessage!}`)).toBeNull()
  })

  it('a wrong address still says why in the row under the bar', async () => {
    frameWidth = 900
    await mount({ url: PAGE })
    const input = host.querySelector(`.${css.browserInput!}`) as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'javascript:alert(1)')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(host.querySelector(`.${css.browserMessage!}`)).not.toBeNull()
  })
})

describe('the strip under the address bar is gone (option B2)', () => {
  it('no strip in the tab, and none left to import', async () => {
    frameWidth = 900
    await mount({ url: PAGE })
    await enterEdit()
    expect(host.querySelector('[data-comment-strip]')).toBeNull()
    const layer = await import('../src/client/CommentLayer.tsx')
    expect('CommentStrip' in layer).toBe(false)
  })
})

describe('the Comments button in the tab (rule 9: one grey button, no menu)', () => {
  it('follows Edit once the page offers the picker, and a click asks for the Comments tab', async () => {
    frameWidth = 900
    await mount({ url: PAGE })
    expect(host.querySelector(`.${css.commentsButton!}`)).toBeNull()
    await enterEdit()
    const segments = host.querySelector(`.${css.modeSegments!}`)!
    expect(segments.nextElementSibling!.className).toBe(css.commentsButton)
    expect(host.querySelector('[aria-haspopup="menu"][aria-label="More comment actions"]')).toBeNull()
    const asked: unknown[] = []
    const listener = (event: Event) => { asked.push((event as CustomEvent).detail) }
    window.addEventListener(COMMENTS_OPEN_EVENT, listener)
    await act(async () => { button('Comments, 0')!.click() })
    window.removeEventListener(COMMENTS_OPEN_EVENT, listener)
    expect(asked).toEqual([{ sessionId: 's1', tabId: SESSION_TAB }])
  })
})

describe('opening the Comments tab brings the chat column on screen first', () => {
  async function mountWith(right: unknown): Promise<void> {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const base = props({ url: PAGE })
    const ctx = {
      get: (name: string) => (name === 'sidebarRight' ? right : (base.ctx as unknown as { get: (n: string) => unknown }).get(name)),
    } as unknown as Context
    await act(async () => { root!.render(createElement(BrowserView, { ...base, ctx })) })
    await flush()
    await enterEdit()
  }

  it('a right panel in fullscreen covers the chat: this pane leaves fullscreen, then the event goes', async () => {
    frameWidth = 900
    const order: string[] = []
    const target = { paneId: 'p1' }
    const right = {
      commandTarget: vi.fn((el: Element | null) => { order.push(`target:${el?.tagName ?? 'none'}`); return target }),
      toggleFullscreen: vi.fn((t: unknown) => { order.push(t === target ? 'toggle' : 'toggle:wrong') }),
    }
    const frameRoot = document.createElement('div')
    frameRoot.setAttribute('data-rightbar-fullscreen', 'true')
    document.body.append(frameRoot)
    await mountWith(right)
    const listener = () => { order.push('event') }
    window.addEventListener(COMMENTS_OPEN_EVENT, listener)
    await act(async () => { button('Comments, 0')!.click() })
    window.removeEventListener(COMMENTS_OPEN_EVENT, listener)
    expect(order).toEqual(['target:IFRAME', 'toggle', 'event'])
  })

  it('not in fullscreen: the panel is left alone', async () => {
    frameWidth = 900
    const right = { commandTarget: vi.fn(), toggleFullscreen: vi.fn() }
    await mountWith(right)
    await act(async () => { button('Comments, 0')!.click() })
    expect(right.commandTarget).not.toHaveBeenCalled()
    expect(right.toggleFullscreen).not.toHaveBeenCalled()
  })
})

describe('the zoom chip under 360 px of frame (Brian 29/09)', () => {
  it('is hidden in a 320 px frame, back at 380, whatever the window', async () => {
    frameWidth = 320
    await mount({ url: PAGE })
    await enterEdit()
    expect(button('Zoom')).toBeNull()
    expect(host.querySelector(`.${css.commentsButton!}`)).not.toBeNull()
    await resize(380)
    expect(button('Zoom')).not.toBeNull()
  })
})
