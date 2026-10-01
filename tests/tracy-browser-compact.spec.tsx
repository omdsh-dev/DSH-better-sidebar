// @vitest-environment jsdom
/**
 * `BrowserView` in a narrow frame (compact, plan rule 6; Tracy, 28/09/2026): the address bar drops
 * Forward (Go is gone in every width since option B2; Enter navigates) and the mode bar shows its segments as icons — decided by the
 * FRAME's width (the comment layer's `clientWidth`), never the window's. What the layer itself draws
 * compact is held by `comment-layer-compact.spec.tsx`.
 *
 * `@deepseek-ai/dsh-client-ui-primitives` is stubbed for the same reason as in
 * `tests/tracy-browser-comment.spec.tsx` (a second React on some machines).
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

describe('the address bar follows the FRAME\'s width', () => {
  // Go is gone in every width since option B2 (29/09): `tracy-browser-toolbar.spec.tsx`.
  it('a 380 px frame in a 1400 px window: Forward steps aside; Back, Refresh, Open in browser stay', async () => {
    frameWidth = 380
    await mount({ url: PAGE })
    expect(window.innerWidth).toBe(1400)
    expect(button('Forward')).toBeNull()
    expect(button('Back')).not.toBeNull()
    expect(button('Refresh')).not.toBeNull()
    expect(button('Open in browser')).not.toBeNull()
  })

  it('a 900 px frame keeps Forward', async () => {
    frameWidth = 900
    await mount({ url: PAGE })
    expect(button('Forward')).not.toBeNull()
  })

  it('follows the frame across 600 px both ways (599 compact, 600 not)', async () => {
    frameWidth = 700
    await mount({ url: PAGE })
    expect(button('Forward')).not.toBeNull()
    await resize(599)
    expect(button('Forward')).toBeNull()
    await resize(600)
    expect(button('Forward')).not.toBeNull()
  })

  it('Enter in the address navigates', async () => {
    frameWidth = 320
    await mount({ url: PAGE })
    expect(button('Go')).toBeNull()
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
})

describe('the mode bar follows the frame too', () => {
  it('in a 380 px frame Edit is an icon (its name in aria-label and the tooltip); at 900 px it has its word', async () => {
    frameWidth = 380
    await mount({ url: PAGE })
    await enterEdit()
    const edit = button('Edit')!
    expect(edit.textContent).toBe('')
    expect(edit.getAttribute('title')).not.toBe('')
    await resize(900)
    expect(button('Edit')!.textContent).toBe('Edit')
  })
})
