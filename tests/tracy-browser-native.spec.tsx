// @vitest-environment jsdom
/**
 * The Browser tab as a browser (Tracy, 29/09/2026): what the frame may do (permissions, its own
 * origin's cookies and storage), the loading line, the bar following a page that reports where it
 * went, and no probe for a Tracy site. `tests/tracy-browser.spec.tsx` covers the tab's records,
 * reloads and the probe after a 403; this file covers only what that day added.
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    SidebarApiError: actual.SidebarApiError,
    isForbiddenError: actual.isForbiddenError,
    api: {
      browserProbe: vi.fn(async () => ({ reachable: false })),
    },
    mediaUrl: () => '',
  }
})

import type { Context } from '../src/context-types.ts'
import { api } from '../src/client/api.ts'
import {
  BROWSER_IFRAME_ALLOW,
  BROWSER_IFRAME_SANDBOX,
  BrowserView,
  iframeSandboxFor,
  TRACY_BROWSER_KIND,
} from '../src/client/BrowserView.tsx'
import { PREVIEW_CHANNEL, PREVIEW_VERSION } from '../src/client/preview-protocol.generated.ts'
import { createSidebarStore } from '../src/client/state.ts'

const GUI = 'http://localhost:3000'

/** `/api/config` names `tracy.test` as the site domain: `demo.tracy.test` is a Tracy site here. */
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (target === '/api/config') return new Response(JSON.stringify({ siteDomain: 'tracy.test' }), { status: 200 })
    return new Response('{}', { status: 404 })
  }))
})
afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

const updates: Array<{ id: string; patch: unknown }> = []
function props(url: string, meta: Record<string, unknown> = {}) {
  const ctx = {
    get: (name: string) => (name === 'betterSidebar'
      ? { updateTab: (id: string, patch: unknown) => { updates.push({ id, patch }) } }
      : undefined),
  } as unknown as Context
  return {
    ctx,
    store: createSidebarStore(),
    scope: { sessionId: 's1', cwd: '/p' },
    tab: { id: 'native-7', type: TRACY_BROWSER_KIND, title: new URL(url).hostname, meta: { ...meta, url } },
    visible: true,
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve() })
}

async function mount(url: string) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => { root.render(createElement(BrowserView, props(url))) })
  await flush()
  const frame = host.querySelector('iframe') as HTMLIFrameElement
  return { host, root, frame }
}

/** Give the frame a window of its own, so a message can carry it as `source`. */
function pageWindow(frame: HTMLIFrameElement): Window {
  const win = { postMessage: () => {} } as unknown as Window
  Object.defineProperty(frame, 'contentWindow', { configurable: true, value: win })
  return win
}

async function fromPage(win: Window, origin: string, data: Record<string, unknown>): Promise<void> {
  await act(async () => {
    const event = new MessageEvent('message', { data: { channel: PREVIEW_CHANNEL, v: PREVIEW_VERSION, ...data }, origin })
    Object.defineProperty(event, 'source', { value: win })
    window.dispatchEvent(event)
  })
  await flush()
}

function input(host: HTMLElement): HTMLInputElement {
  return host.querySelector('input') as HTMLInputElement
}

function progress(host: HTMLElement): HTMLElement {
  return host.querySelector('[data-loading]') as HTMLElement
}

describe('what the frame may do', () => {
  it('every page but the GUI keeps its own origin (cookies, storage); the GUI never does; top navigation never', () => {
    expect(iframeSandboxFor('https://example.com/', '', GUI)).toContain('allow-same-origin')
    expect(iframeSandboxFor('https://shop.example/cart', '', GUI)).toContain('allow-same-origin')
    expect(iframeSandboxFor(`${GUI}/anything`, '', GUI)).toBe(BROWSER_IFRAME_SANDBOX)
    expect(iframeSandboxFor('not a url', '', GUI)).toBe(BROWSER_IFRAME_SANDBOX)
    expect(iframeSandboxFor(undefined, '', GUI)).toBeUndefined()
    expect(BROWSER_IFRAME_SANDBOX).not.toContain('allow-same-origin')
    for (const tokens of [iframeSandboxFor('https://example.com/', '', GUI)!, BROWSER_IFRAME_SANDBOX]) {
      expect(tokens).not.toContain('allow-top-navigation')
      expect(tokens).toContain('allow-scripts')
      expect(tokens).toContain('allow-forms')
    }
  })

  it('renders the frame with the permissions a Chrome tab has, and may go fullscreen', () => {
    const html = renderToString(createElement(BrowserView, props('https://example.com/')))
    const iframe = /<iframe[^>]*>/.exec(html)?.[0] ?? ''
    expect(iframe).toContain(`allow="${BROWSER_IFRAME_ALLOW}"`)
    expect(iframe).toContain('allowfullscreen')
    expect(iframe).toContain('allow-same-origin')
    expect(iframe).toContain('referrerPolicy="no-referrer"')
    for (const feature of ['fullscreen', 'clipboard-write', 'clipboard-read', 'autoplay', 'geolocation', 'camera', 'microphone']) {
      expect(BROWSER_IFRAME_ALLOW.split(';').map(f => f.trim())).toContain(feature)
    }
  })
})

describe('the loading line', () => {
  it('runs from the first src until the frame loads, and again on a reload', async () => {
    const { host, root, frame } = await mount('https://example.com/')
    expect(progress(host).dataset.loading).toBe('true')
    await act(async () => { frame.dispatchEvent(new Event('load')) })
    expect(progress(host).dataset.loading).toBe('false')
    await act(async () => { root.render(createElement(BrowserView, props('https://example.com/', { reloadNonce: 'reload:1:1' }))) })
    expect(progress(host).dataset.loading).toBe('true')
    await act(async () => { frame.dispatchEvent(new Event('load')) })
    expect(progress(host).dataset.loading).toBe('false')
    await act(async () => { root.unmount() })
  })

  it('runs while the page\'s agent is asked to refresh, until it answers', async () => {
    const { host, root, frame } = await mount('https://example.com/')
    const win = pageWindow(frame)
    await fromPage(win, 'https://example.com', { kind: 'ready', features: [] })
    await act(async () => { frame.dispatchEvent(new Event('load')) })
    expect(progress(host).dataset.loading).toBe('false')
    const reload = [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Refresh') as HTMLButtonElement
    await act(async () => { reload.click() })
    expect(progress(host).dataset.loading).toBe('true')
    // The agent reloads the page after any answer but a style swap: the line runs until that load.
    await fromPage(win, 'https://example.com', { kind: 'applied', mode: 'reload' })
    expect(progress(host).dataset.loading).toBe('true')
    await act(async () => { frame.dispatchEvent(new Event('load')) })
    expect(progress(host).dataset.loading).toBe('false')
    // A style swap in place is the whole answer.
    await act(async () => { reload.click() })
    expect(progress(host).dataset.loading).toBe('true')
    await fromPage(win, 'https://example.com', { kind: 'applied', mode: 'style' })
    expect(progress(host).dataset.loading).toBe('false')
    await act(async () => { root.unmount() })
  })
})

describe('the bar follows the page (runtime 4+, `ready.url`)', () => {
  beforeEach(() => { updates.length = 0 })

  it('a page reporting another address on its own origin moves the bar, the record and the history — not the frame', async () => {
    const { host, root, frame } = await mount('https://example.com/')
    const win = pageWindow(frame)
    const srcBefore = frame.getAttribute('src')
    const back = (): HTMLButtonElement => [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Back') as HTMLButtonElement
    // The first document landed elsewhere: a redirect (`/` → `/ru/`). The entry is replaced, as a
    // browser does, so Back does not lead to a page that only forwards.
    await fromPage(win, 'https://example.com', { kind: 'ready', features: ['pick'], url: 'https://example.com/ru/' })
    expect(input(host).value).toBe('https://example.com/ru/')
    expect(back().disabled).toBe(true)
    // A later document is a page the person went to: a new entry.
    await fromPage(win, 'https://example.com', { kind: 'ready', features: ['pick'], url: 'https://example.com/about?lang=vi#team' })
    expect(input(host).value).toBe('https://example.com/about?lang=vi#team')
    expect(frame.getAttribute('src')).toBe(srcBefore)
    expect(host.querySelector('iframe')).toBe(frame)
    const recorded = updates.map(u => (u.patch as { meta?: { url?: string } }).meta?.url)
    expect(recorded).toContain('https://example.com/ru/')
    expect(recorded).toContain('https://example.com/about?lang=vi#team')
    expect(back().disabled).toBe(false)
    // Back is the redirected page, and the frame is sent there; forward is the page reported.
    await act(async () => { back().click() })
    expect(input(host).value).toBe('https://example.com/ru/')
    const src = new URL((host.querySelector('iframe') as HTMLIFrameElement).src)
    src.searchParams.delete('tracy_reload')
    expect(src.href).toBe('https://example.com/ru/')
    const forward = [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Forward') as HTMLButtonElement
    expect(forward.disabled).toBe(false)
    await act(async () => { root.unmount() })
  })

  it('a reload after the page moved goes to the page shown: first its agent, then the frame itself', async () => {
    vi.useFakeTimers()
    try {
      const { host, root, frame } = await mount('https://example.com/')
      const win = pageWindow(frame)
      const posted: unknown[] = []
      win.postMessage = ((message: unknown) => { posted.push(message) }) as Window['postMessage']
      await fromPage(win, 'https://example.com', { kind: 'ready', features: ['pick'], url: 'https://example.com/about' })
      const reload = [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Refresh') as HTMLButtonElement
      await act(async () => { reload.click() })
      // The page carries the preview agent, so it is asked first — and it is the page shown that answers.
      expect(posted).toHaveLength(1)
      expect(posted[0]).toMatchObject({ channel: PREVIEW_CHANNEL, v: PREVIEW_VERSION, kind: 'refresh' })
      expect(frame.getAttribute('src')).toBe('https://example.com/')
      // The agent stays silent: the frame is reloaded — at the page shown, never at the address it was navigated to.
      await act(async () => { vi.advanceTimersByTime(2_000) })
      const src = new URL(frame.src)
      expect(src.searchParams.get('tracy_reload')).not.toBeNull()
      src.searchParams.delete('tracy_reload')
      expect(src.href).toBe('https://example.com/about')
      expect(input(host).value).toBe('https://example.com/about')
      await act(async () => { root.unmount() })
    } finally {
      vi.useRealTimers()
    }
  })

  it('an address on another origin, an opaque sender, or the page it was navigated to move nothing', async () => {
    const { host, root, frame } = await mount('https://example.com/')
    const win = pageWindow(frame)
    await fromPage(win, 'https://example.com', { kind: 'ready', features: ['pick'], url: 'https://evil.example/phish' })
    await fromPage(win, 'null', { kind: 'ready', features: ['pick'], url: 'https://example.com/opaque' })
    await fromPage(win, 'https://example.com', { kind: 'ready', features: ['pick'], url: 'https://example.com/#top' })
    await fromPage(win, 'https://example.com', { kind: 'ready', features: [] })
    expect(input(host).value).toBe('https://example.com/')
    const back = [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Back') as HTMLButtonElement
    expect(back.disabled).toBe(true)
    expect(updates.map(u => (u.patch as { meta?: { url?: string } }).meta?.url)).not.toContain('https://evil.example/phish')
    await act(async () => { root.unmount() })
  })
})

describe('no probe for a Tracy site', () => {
  const probe = vi.mocked(api.browserProbe)
  beforeEach(() => { probe.mockClear() })

  it('a page on the deployment site domain is not probed; any other page still is', async () => {
    const tracy = await mount('https://demo.tracy.test/')
    expect(probe).not.toHaveBeenCalled()
    expect(tracy.frame.getAttribute('sandbox')).toBeNull()
    await act(async () => { tracy.root.unmount() })
    const other = await mount('https://example.com/')
    expect(probe).toHaveBeenCalledTimes(1)
    expect(other.frame.getAttribute('sandbox')).toContain('allow-same-origin')
    await act(async () => { other.root.unmount() })
  })
})
