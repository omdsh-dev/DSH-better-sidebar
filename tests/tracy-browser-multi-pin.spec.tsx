// @vitest-environment jsdom
/**
 * Many comments in `BrowserView` (Tracy, 28/09/2026, TCH contract H2; stage 5, 29/09): the site's
 * comments are kept by tracy-web's comment doors — every change goes there, never to the tab
 * record's `meta.comments` or the localStorage mirror — and a remount (a page reload) reads them
 * back and tells the page its set again. What stages 3–4 kept in `meta.comments`/the mirror is read
 * once and moved (`tests/comment-controller-server.spec.tsx` holds the rules; this is the wiring).
 * The flow itself is held by `tests/comment-controller-multi.spec.tsx`.
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
import { loadViewState, saveViewComments } from '../src/client/browser-mode.ts'
import { resetCommentModeMemo } from '../src/client/comment-controller.ts'
import { COMMENT_ACT_EVENT, COMMENT_LIST_EVENT, emptyCommentStore, reduceComments } from '../src/client/comment-store.ts'
import { SETTLE_MS } from '../src/client/refresh-progress.ts'
import { PREVIEW_CHANNEL, PREVIEW_VERSION, type PreviewPickTarget } from '../src/client/preview-protocol.generated.ts'
import { createSidebarStore } from '../src/client/state.ts'

const SITE = 'http://northgate.tracy.test:8080'
const PAGE = `${SITE}/`

const target = (selector: string, text: string): PreviewPickTarget => ({
  text, tag: 'h2', image: null, domPath: selector, selector, rect: { x: 10, y: 10, width: 100, height: 20 }, marks: [], levels: [], level: 0,
})

const updates: Array<{ id: string; patch: { meta?: Record<string, unknown> } }> = []
let root: Root | null = null
let host: HTMLDivElement

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
  if (root !== null) await act(async () => { root!.unmount() })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(createElement(BrowserView, props(meta))) })
  await flush()
}

function page(): { win: Window; posted: Array<[unknown, string]> } {
  const win = (host.querySelector('iframe') as HTMLIFrameElement).contentWindow as Window
  const posted: Array<[unknown, string]> = []
  win.postMessage = ((message: unknown, origin: string) => { posted.push([message, origin]) }) as Window['postMessage']
  return { win, posted }
}

async function fromPage(win: Window, data: Record<string, unknown>): Promise<void> {
  await act(async () => {
    const event = new MessageEvent('message', { data: { channel: PREVIEW_CHANNEL, v: PREVIEW_VERSION, ...data }, origin: SITE })
    Object.defineProperty(event, 'source', { value: win })
    window.dispatchEvent(event)
  })
  await flush()
}

const tracks = (posted: Array<[unknown, string]>): Array<Array<{ selector: string }>> =>
  posted.filter(([m]) => (m as { kind: string }).kind === 'pick-track').map(([m]) => (m as { items: Array<{ selector: string }> }).items)

async function typeAndAdd(text: string): Promise<void> {
  const area = host.querySelector('textarea') as HTMLTextAreaElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(area, text)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
  // "Add comment" is a click only (Brian 29/09 22:40: Enter is Send to Tracy).
  const add = [...host.querySelectorAll('[role="dialog"] button')].find(b => b.textContent === 'Add comment') as HTMLButtonElement
  await act(async () => { add.click() })
  await flush()
}

/** tracy-web's comment doors, in memory (null = the doors answer 404, as before stage 5). */
let serverRows: Array<Record<string, unknown>> | null
/** The list's `siteChangedAt` (stage 6): the last write to the site, as the Apply door's audit says. */
let siteChangedAt: string | null = null
const doorCalls: Array<{ method: string; url: string; body: unknown }> = []
function commentsDoor(url: string, init?: RequestInit): Response {
  const method = init?.method ?? 'GET'
  const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>
  doorCalls.push({ method, url, body })
  if (serverRows === null) return new Response('{}', { status: 404 })
  if (method === 'GET') return new Response(JSON.stringify({ comments: serverRows, n_next: serverRows.length + 1, siteChangedAt }), { status: 200 })
  if (method === 'POST') {
    const at = new Date(1_790_000_000_000 + serverRows.length).toISOString()
    const row = { id: `srv-${String(serverRows.length + 1)}`, n: serverRows.length + 1, status: 'pending', requestId: null, callId: null, question: null, replyTo: null, createdAt: at, updatedAt: at, sentAt: null, resolvedAt: null, resolvedBy: null, deletedAt: null, author: { accountId: 'a1', email: 'lee@example.com', name: 'Lee', initial: 'L' }, can: { resolve: true, edit: true }, locate: null, ...body }
    serverRows.push(row)
    return new Response(JSON.stringify({ comment: row }), { status: 201 })
  }
  return new Response('{}', { status: 404 })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  updates.length = 0
  doorCalls.length = 0
  serverRows = null
  siteChangedAt = null
  resetCommentModeMemo()
  localStorage.clear()
  const base = document.createElement('base')
  base.href = `${location.origin}/northgate/`
  document.head.append(base)
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (input.startsWith('/api/sites/northgate/comments')) return commentsDoor(input, init)
    if (input === '/api/config') return new Response(JSON.stringify({ siteDomain: 'tracy.test' }), { status: 200 })
    if (input === '/api/sites/northgate/preview-ticket') return new Response(JSON.stringify({ ticket: 'pv1.T', exp: 1 }), { status: 200 })
    if (input === '/api/sites/northgate/apply') return new Response(JSON.stringify({ status: 'none' }), { status: 200 })
    return new Response('{}', { status: 404 })
  }))
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US', platform: 'MacIntel', userAgent: 'x' }, configurable: true })
})

afterEach(async () => {
  if (root !== null) await act(async () => { root!.unmount() })
  root = null
  document.body.replaceChildren()
  document.head.querySelectorAll('base').forEach(b => { b.remove() })
  vi.unstubAllGlobals()
})

describe('comments are kept with the tab', () => {
  it('two pins go to the comment doors (never to meta.comments or the mirror), and a reload brings both back to the page', async () => {
    serverRows = []
    await mount({ url: PAGE, mode: 'edit' })
    const first = page()
    await fromPage(first.win, { kind: 'ready', features: ['pick', 'track'], url: PAGE })
    await fromPage(first.win, { kind: 'picked', target: target('main > h1', 'Welcome'), url: PAGE })
    await typeAndAdd('Say hello')
    await fromPage(first.win, { kind: 'picked', target: target('main > h2', 'Services'), url: PAGE })
    await typeAndAdd('Shorter')
    expect(doorCalls.filter(c => c.method === 'POST').map(c => (c.body as { text: string }).text)).toEqual(['Say hello', 'Shorter'])
    expect(updates.some(u => u.patch.meta !== undefined && 'comments' in u.patch.meta)).toBe(false)
    expect(loadViewState('s1', 'native-7')?.comments).toBeUndefined()
    expect(JSON.stringify(updates)).not.toContain('tracy_preview')

    // The page reloads: the view reads the list from the server again.
    await mount({})
    const second = page()
    await fromPage(second.win, { kind: 'ready', features: ['pick', 'track'], url: PAGE })
    expect(tracks(second.posted).at(-1)?.map(i => i.selector)).toEqual(['main > h1', 'main > h2'])
  })

  it('meta.comments kept by stage 4 is moved to an empty server once, then dropped from the record and the mirror', async () => {
    serverRows = []
    vi.spyOn(console, 'info').mockImplementation(() => {})
    let old = emptyCommentStore('northgate')
    old = reduceComments(old, { type: 'add', id: 'old', url: PAGE, element: target('main > h1', 'Welcome'), locate: null, text: 'kept words' }).store
    saveViewComments('s1', 'native-7', old)
    await mount({ url: PAGE, mode: 'edit', comments: old })
    expect(doorCalls.filter(c => c.method === 'POST').map(c => (c.body as { text: string }).text)).toEqual(['kept words'])
    const last = updates.filter(u => u.patch.meta !== undefined).at(-1)!.patch.meta!
    expect('comments' in last).toBe(false)
    expect(last.url).toBe(PAGE)
    expect(loadViewState('s1', 'native-7')?.comments).toBeUndefined()
  })

  it('doors that do not answer (404): an empty meta.comments beats a mirror that still has pins', async () => {
    let stale = emptyCommentStore('northgate')
    stale = reduceComments(stale, { type: 'add', id: 'old', url: PAGE, element: target('main > h1', 'Welcome'), locate: null, text: 'stale' }).store
    saveViewComments('s1', 'native-7', stale)
    await mount({ url: PAGE, mode: 'edit', comments: emptyCommentStore('northgate') })
    const { win, posted } = page()
    await fromPage(win, { kind: 'ready', features: ['pick', 'track'], url: PAGE })
    expect(tracks(posted).at(-1)).toEqual([])
  })

  it('another site\'s kept comments are not shown here', async () => {
    let other = emptyCommentStore('southgate')
    other = reduceComments(other, { type: 'add', id: 'x', url: PAGE, element: target('main > h1', 'Welcome'), locate: null, text: 'elsewhere' }).store
    await mount({ url: PAGE, mode: 'edit', comments: other })
    const { win, posted } = page()
    await fromPage(win, { kind: 'ready', features: ['pick', 'track'], url: PAGE })
    expect(tracks(posted).at(-1)).toEqual([])
  })
})

describe('another person\'s change: "New version ready", never an automatic reload (rule 5, replaces F15)', () => {
  it('a poll whose siteChangedAt is newer than the page load turns Refresh terracotta with the chip, and posts no refresh', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    serverRows = []
    await mount({ url: PAGE, mode: 'interactive' })
    const frame = host.querySelector('iframe')!
    const { win, posted } = page()
    await act(async () => { frame.dispatchEvent(new Event('load')) })
    await fromPage(win, { kind: 'ready', features: ['pick', 'track', 'reveal', 'text'], url: PAGE })
    const refresh = (): HTMLButtonElement => host.querySelector('[data-refresh]') as HTMLButtonElement
    expect(refresh().dataset.refresh).toBe('idle')
    siteChangedAt = new Date(Date.now() + 5_000).toISOString()
    await act(async () => { vi.advanceTimersByTime(15_000) })
    await flush()
    vi.useRealTimers()
    expect(refresh().dataset.refresh).toBe('ready')
    expect(refresh().getAttribute('aria-label')).toBe('Refresh: New version ready')
    expect(host.querySelector('[role="status"]')?.textContent).toBe('New version ready')
    expect(posted.filter(([m]) => (m as { kind: string }).kind === 'refresh')).toEqual([])
    expect(host.querySelector('iframe')).toBe(frame)
    // A click reloads (keeping the scroll: the page's agent reloads it) and the state goes.
    await act(async () => { refresh().click() })
    expect(posted.filter(([m]) => (m as { kind: string }).kind === 'refresh')).toHaveLength(1)
    expect(refresh().dataset.refresh).toBe('idle')
  })

  it('a change older than the page load says nothing', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    serverRows = []
    siteChangedAt = new Date(Date.now() - 60_000).toISOString()
    await mount({ url: PAGE, mode: 'interactive' })
    await act(async () => { host.querySelector('iframe')!.dispatchEvent(new Event('load')) })
    await act(async () => { vi.advanceTimersByTime(15_000) })
    await flush()
    vi.useRealTimers()
    expect((host.querySelector('[data-refresh]') as HTMLElement).dataset.refresh).toBe('idle')
  })
})

describe('the sender: Tracy\'s progress on Refresh (rule 5)', () => {
  const turn = async (name: string, over: Record<string, unknown> = {}): Promise<void> => {
    await act(async () => { window.dispatchEvent(new CustomEvent(name, { detail: { sessionId: 's1', requestId: 'q1', siteKey: 'northgate', ...over } })) })
    await flush()
  }
  const refresh = (): HTMLButtonElement => host.querySelector('[data-refresh]') as HTMLButtonElement
  const chip = (): string | null => host.querySelector('[role="status"]')?.textContent ?? null

  async function open(): Promise<{ win: Window; posted: Array<[unknown, string]> }> {
    serverRows = []
    await mount({ url: PAGE, mode: 'edit' })
    const p = page()
    await act(async () => { host.querySelector('iframe')!.dispatchEvent(new Event('load')) })
    await fromPage(p.win, { kind: 'ready', features: ['pick', 'track', 'reveal', 'text'], url: PAGE })
    return p
  }

  it('working: spins with "Tracy is working" for 3 s, then only spins; another session\'s turn says nothing', async () => {
    const { posted } = await open()
    await turn('tracy:tracy-working', { sessionId: 'other' })
    expect(refresh().dataset.refresh).toBe('idle')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await turn('tracy:tracy-working')
    expect(refresh().dataset.refresh).toBe('working')
    expect(chip()).toBe('Tracy is working')
    await act(async () => { vi.advanceTimersByTime(3_000) })
    vi.useRealTimers()
    expect(refresh().dataset.refresh).toBe('working-long')
    expect(chip()).toBeNull()
    expect(posted.filter(([m]) => (m as { kind: string }).kind === 'refresh')).toEqual([])
  })

  it('done after a site change: the page reloads itself (its agent, keeping the scroll), then "New version updated" for 3 s', async () => {
    const { win, posted } = await open()
    await turn('tracy:tracy-working')
    await turn('tracy:site-changed')
    await turn('tracy:turn-end')
    expect(posted.filter(([m]) => (m as { kind: string }).kind === 'refresh')).toEqual([[{ channel: PREVIEW_CHANNEL, v: PREVIEW_VERSION, kind: 'refresh', mode: 'full' }, '*']])
    // The page's agent reloads the document: a new load comes.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await act(async () => { host.querySelector('iframe')!.dispatchEvent(new Event('load')) })
    await flush()
    expect(refresh().dataset.refresh).toBe('updated')
    expect(chip()).toBe('New version updated')
    await act(async () => { vi.advanceTimersByTime(3_000) })
    vi.useRealTimers()
    expect(refresh().dataset.refresh).toBe('idle')
    void win
  })

  it('done while the person types in the popover: no reload, terracotta "New version ready" until clicked', async () => {
    const { win, posted } = await open()
    await fromPage(win, { kind: 'picked', target: target('main > h2', 'Our services'), url: PAGE })
    const area = host.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(area, 'half a thought')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await turn('tracy:tracy-working')
    await turn('tracy:site-changed')
    await turn('tracy:turn-end')
    expect(posted.filter(([m]) => (m as { kind: string }).kind === 'refresh')).toEqual([])
    expect(refresh().dataset.refresh).toBe('ready')
    expect(chip()).toBe('New version ready')
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('half a thought')
  })

  it('done while the person types: the site tabs\' reload of that turn (`reloadTab`) waits too, and "New version ready" stays until clicked (F1)', async () => {
    // Stage 6 acceptance R3/F1: "New version ready" showed, then the page reloaded under the open
    // popover anyway and the button went back to idle — `tracy-site-tabs` asks every Browser tab on
    // the site to reload when a turn changed it (`BetterSidebarService.reloadTab`, a nonce on the meta).
    serverRows = []
    const shown = props({ url: PAGE, mode: 'edit' })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root!.render(createElement(BrowserView, shown)) })
    await flush()
    const { win, posted } = page()
    await act(async () => { host.querySelector('iframe')!.dispatchEvent(new Event('load')) })
    await fromPage(win, { kind: 'ready', features: ['pick', 'track', 'reveal', 'text'], url: PAGE })
    await fromPage(win, { kind: 'picked', target: target('main > h2', 'Our services'), url: PAGE })
    const area = host.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(area, 'half a thought')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await turn('tracy:tracy-working')
    await turn('tracy:site-changed')
    await turn('tracy:turn-end')
    const asked = { ...shown, tab: { ...shown.tab, meta: { ...shown.tab.meta, reloadNonce: 'reload:1:1', reloadMode: 'full' } } }
    await act(async () => { root!.render(createElement(BrowserView, asked)) })
    await flush()
    expect(posted.filter(([m]) => (m as { kind: string }).kind === 'refresh')).toEqual([])
    expect(refresh().dataset.refresh).toBe('ready')
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('half a thought')
    // A click on Refresh is the person's own reload.
    await act(async () => { refresh().click() })
    expect(posted.filter(([m]) => (m as { kind: string }).kind === 'refresh')).toHaveLength(1)
  })

  /** Mount the tab the way `mount` does, but keep its props so a `reloadTab` nonce can be written onto its record. */
  async function openKept(visible = true): Promise<{ win: Window; posted: Array<[unknown, string]>; ask: (nonce: string, mode?: string) => Promise<void>; show: () => Promise<void> }> {
    serverRows = []
    let shown = { ...props({ url: PAGE, mode: 'edit' }), visible }
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root!.render(createElement(BrowserView, shown)) })
    await flush()
    const p = page()
    await act(async () => { host.querySelector('iframe')!.dispatchEvent(new Event('load')) })
    await fromPage(p.win, { kind: 'ready', features: ['pick', 'track', 'reveal', 'text'], url: PAGE })
    const ask = async (nonce: string, mode = 'full'): Promise<void> => {
      const asked = { ...shown, tab: { ...shown.tab, meta: { ...shown.tab.meta, reloadNonce: nonce, reloadMode: mode } } }
      shown = asked
      await act(async () => { root!.render(createElement(BrowserView, asked)) })
      await flush()
    }
    const show = async (): Promise<void> => {
      shown = { ...shown, visible: true }
      await act(async () => { root!.render(createElement(BrowserView, shown)) })
      await flush()
    }
    return { ...p, ask, show }
  }
  const refreshes = (posted: Array<[unknown, string]>): Array<[unknown, string]> => posted.filter(([m]) => (m as { kind: string }).kind === 'refresh')

  it('the page reloads ONCE per change: the site tabs\' `reloadTab` of the turn it already reloaded for adds no second load, and "New version updated" stays', async () => {
    const { posted, ask } = await openKept()
    await turn('tracy:tracy-working')
    await turn('tracy:site-changed')
    await turn('tracy:turn-end')
    expect(refreshes(posted)).toHaveLength(1)
    await act(async () => { host.querySelector('iframe')!.dispatchEvent(new Event('load')) })
    await flush()
    expect(refresh().dataset.refresh).toBe('updated')
    await ask('reload:1:1')
    expect(refreshes(posted)).toHaveLength(1)
    expect(refresh().dataset.refresh).toBe('updated')
    expect(chip()).toBe('New version updated')
  })

  it('a tab the turn\'s own events never reached (another tab of the site, a turn typed in the chat) reloads when the site tabs ask, in their mode', async () => {
    const { posted, ask } = await openKept()
    await ask('reload:1:1', 'style')
    expect(refreshes(posted)).toEqual([[{ channel: PREVIEW_CHANNEL, v: PREVIEW_VERSION, kind: 'refresh', mode: 'style' }, '*']])
    expect(refresh().dataset.refresh).toBe('idle')
  })

  it('an open comment box, even an empty one, holds the site tabs\' reload: "New version ready" until clicked, then the click reloads', async () => {
    const { win, posted, ask } = await openKept()
    await fromPage(win, { kind: 'picked', target: target('main > h2', 'Our services'), url: PAGE })
    expect(host.querySelector('textarea')).not.toBeNull()
    await ask('reload:1:1', 'style')
    expect(refreshes(posted)).toEqual([])
    expect(refresh().dataset.refresh).toBe('ready')
    expect(chip()).toBe('New version ready')
    expect(host.querySelector('textarea')).not.toBeNull()
    await act(async () => { refresh().click() })
    expect(refreshes(posted)).toHaveLength(1)
  })

  it('an open comment box, even an empty one, holds the sender\'s own turn end too', async () => {
    const { win, posted } = await open()
    await fromPage(win, { kind: 'picked', target: target('main > h2', 'Our services'), url: PAGE })
    await turn('tracy:tracy-working')
    await turn('tracy:site-changed')
    await turn('tracy:turn-end')
    expect(refreshes(posted)).toEqual([])
    expect(refresh().dataset.refresh).toBe('ready')
  })

  it('Tracy waiting on a question card: Refresh stops spinning; the answer spins it again (F3)', async () => {
    const { posted } = await open()
    await turn('tracy:tracy-working')
    await turn('tracy:site-changed')
    await turn('tracy:tracy-asking')
    expect(refresh().dataset.refresh).toBe('idle')
    expect(chip()).toBeNull()
    await turn('tracy:tracy-working')
    expect(refresh().dataset.refresh).toBe('working')
    await turn('tracy:turn-end')
    expect(posted.filter(([m]) => (m as { kind: string }).kind === 'refresh')).toHaveLength(1)
  })

  it('a turn that changed nothing ends quietly, no reload', async () => {
    const { posted } = await open()
    await turn('tracy:tracy-working')
    await turn('tracy:turn-end')
    // Round 6: it goes on spinning for SETTLE_MS (a queued turn may follow), then idle.
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, SETTLE_MS + 30) }) })
    expect(refresh().dataset.refresh).toBe('idle')
    expect(posted.filter(([m]) => (m as { kind: string }).kind === 'refresh')).toEqual([])
  })

  it('round 6 (S08): a queued turn starting right after the last one keeps Refresh spinning — never idle between', async () => {
    await open()
    await turn('tracy:tracy-working')
    await turn('tracy:turn-end')
    expect(refresh().dataset.refresh).not.toBe('idle')
    await turn('tracy:tracy-working', { requestId: 'q2' })
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, SETTLE_MS + 30) }) })
    expect(refresh().dataset.refresh).toMatch(/^working/)
  })

  it('round 6 (R13): a hidden tab does not reload when the site tabs ask — "New version ready", and it reloads once shown', async () => {
    const { posted, ask, show } = await openKept(false)
    await ask('reload:1:1', 'full')
    expect(refreshes(posted)).toEqual([])
    expect(refresh().dataset.refresh).toBe('ready')
    await show()
    expect(refreshes(posted)).toHaveLength(1)
  })

  it('round 6 (R13): its own conversation\'s changing turn ending while hidden does not reload it either', async () => {
    const { posted, show } = await openKept(false)
    await turn('tracy:tracy-working')
    await turn('tracy:site-changed')
    await turn('tracy:turn-end')
    expect(refreshes(posted)).toEqual([])
    expect(refresh().dataset.refresh).toBe('ready')
    await show()
    expect(refreshes(posted)).toHaveLength(1)
  })

  /** The chat's answer to `tracy:turn-state` for s1 while the test runs (undefined: nobody answers). */
  function chatSays(running: boolean | undefined): () => void {
    const l = (event: Event): void => {
      const detail = (event as CustomEvent).detail as { sessionId: string; running?: boolean }
      if (detail.sessionId === 's1' && running !== undefined) detail.running = running
    }
    window.addEventListener('tracy:turn-state', l)
    return () => { window.removeEventListener('tracy:turn-state', l) }
  }

  it('round 9 (V5S-3): spinning with no turn running in the conversation — pressing Refresh reloads ONCE and the spinner ends', async () => {
    const { posted } = await open()
    await turn('tracy:tracy-working')
    const stop = chatSays(false)
    try {
      await act(async () => { refresh().click() })
      await flush()
    } finally {
      stop()
    }
    expect(refresh().dataset.refresh).toBe('idle')
    expect(refreshes(posted)).toHaveLength(1)
  })

  it('round 9 (V5S-3): pressing Refresh while the chat says a turn runs keeps spinning', async () => {
    await open()
    await turn('tracy:tracy-working')
    const stop = chatSays(true)
    try {
      await act(async () => { refresh().click() })
      await flush()
    } finally {
      stop()
    }
    expect(refresh().dataset.refresh).toMatch(/^working/)
  })

  it('round 9 (V5S-3): a hidden tab whose turn end never came — shown again with no turn running, it reloads for the write and stops spinning', async () => {
    const { posted, show } = await openKept(false)
    await turn('tracy:tracy-working')
    await turn('tracy:site-changed')
    // The turn ends while the conversation is not followed: no turn-end reaches the tab.
    expect(refresh().dataset.refresh).toMatch(/^working/)
    const stop = chatSays(false)
    try {
      await show()
    } finally {
      stop()
    }
    expect(refreshes(posted)).toHaveLength(1)
    // The page's agent reloads the document: "New version updated", the spinner gone.
    await act(async () => { host.querySelector('iframe')!.dispatchEvent(new Event('load')) })
    await flush()
    expect(refresh().dataset.refresh).toBe('updated')
  })
})

describe('a link to a comment (rule 6)', () => {
  it('⋮ Copy link is the site link in Edit on the comment\'s page, plus &comment=<id>', async () => {
    const { commentDeepLink } = await import('../src/client/BrowserView.tsx')
    expect(commentDeepLink('http://tracy.test', 'northgate', { id: 'srv-7', url: `${SITE}/about?lang=ru` })).toBe('http://tracy.test/northgate/?open=browser&page=/about?lang=ru&mode=edit&comment=srv-7')
  })

  it('opened: the tab goes to the comment (Edit, its thread card) and the parameter leaves the dsh page\'s address', async () => {
    const at = new Date(1_790_000_000_000).toISOString()
    serverRows = [{ id: 'srv-1', n: 1, url: PAGE, element: target('main > h1', 'Welcome'), locate: null, text: 'Linked words', status: 'pending', replyTo: null, createdAt: at, updatedAt: at, resolvedAt: null, resolvedBy: null, deletedAt: null, author: { accountId: 'a2', email: 'mai@example.com', name: 'Mai', initial: 'M' }, can: { edit: false, delete: false } }]
    history.replaceState(null, '', '/northgate/?keep=1&comment=srv-1')
    await mount({ url: PAGE, mode: 'interactive' })
    expect(location.search).toBe('?keep=1')
    const { win } = page()
    await fromPage(win, { kind: 'ready', features: ['pick', 'track', 'reveal', 'text'], url: PAGE })
    expect(host.querySelector('[data-thread="srv-1"]')?.textContent).toContain('Linked words')
    expect((host.querySelector('button[aria-label="Edit"]') as HTMLElement).getAttribute('aria-pressed')).toBe('true')
    history.replaceState(null, '', '/')
  })
})

describe('round 6: a tab kept behind another conversation stays silent (acceptance v4 SEND-v4-new-1)', () => {
  function withMain(main: { current: string }) {
    const listeners = new Set<() => void>()
    const base = props({ url: PAGE })
    const ctx = Object.assign(Object.create(null) as object, base.ctx, {
      get: (base.ctx as unknown as { get: (n: string) => unknown }).get,
      sessions: { list: { getSnapshot: () => ({ current: main.current, byId: {} }), subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } } } },
    }) as unknown as Context
    return { props: { ...base, ctx }, switchTo: async (id: string) => { main.current = id; await act(async () => { for (const fn of listeners) fn() }); await flush() } }
  }

  it('answers the Comments view only while its conversation is in the main view', async () => {
    serverRows = []
    const main = { current: 's2' }
    const { props: p, switchTo } = withMain(main)
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root!.render(createElement(BrowserView, p)) })
    await flush()
    const seen: Array<{ sessionId: string; active: boolean }> = []
    const l = (event: Event): void => { seen.push((event as CustomEvent).detail as { sessionId: string; active: boolean }) }
    window.addEventListener(COMMENT_LIST_EVENT, l)
    try {
      const ask = async (): Promise<void> => {
        await act(async () => { window.dispatchEvent(new CustomEvent(COMMENT_ACT_EVENT, { detail: { tabId: '', kind: 'list' } })) })
        await flush()
      }
      await ask()
      expect(seen).toEqual([])
      await switchTo('s1')
      seen.length = 0
      await ask()
      expect(seen.map(d => d.sessionId)).toEqual(['s1'])
    } finally { window.removeEventListener(COMMENT_LIST_EVENT, l) }
  })
})
