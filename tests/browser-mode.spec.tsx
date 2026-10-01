// @vitest-environment jsdom
/**
 * The Browser tab's mode bar (Tracy, 27/09/2026 — Brian's third pass): Interactive | Edit and a
 * zoom value, both properties of the TAB.
 *
 * What these hold:
 *   - the mode survives a reload of the tab (remount from the record, and a page reload where only
 *     the localStorage mirror is left), and Edit re-arms picking on every fresh `ready` with `pick`
 *     — the defect Brian measured was Edit dropping after every reload;
 *   - changing the URL inside the tab keeps Edit (a new ticket is asked, picking comes back);
 *   - a deep link's `?mode=` sets the mode and never reaches the frame, the bar or the record;
 *   - "Open in browser" carries no `mode`;
 *   - zoom scales only the framed page (from its top centre, the approved drawing), is kept per
 *     tab, and the pin is placed with the page's box through the same transform; its control is
 *     a chip opening dsh's Menu of nine levels (Claude Design's), the current one checked, closed
 *     by a pick, an outside pointer or Esc — an Esc that does not also leave Edit;
 *   - Esc (in the tab or in the page) goes back to Interactive, and that is kept too;
 *   - the view tells the dsh page what it shows (`tracy:browser-view`), so the page's own address
 *     can follow it, and "Copy link" hands out the site door's link — no session in it.
 */
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async (importOriginal) => {
  const icon = () => null
  // The zoom chip and its list are dsh's real Pill and Menu; only the bar's icons are stubbed.
  const real = await importOriginal<typeof import('@deepseek-ai/dsh-client-ui-primitives')>()
  return {
    Menu: real.Menu,
    Pill: real.Pill,
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
import { BROWSER_VIEW_EVENT, centredScroll, scaleRect, siteDeepLink, takeModeParam, viewStateOf, withModeParam, type BrowserViewDetail } from '../src/client/browser-mode.ts'
import { PREVIEW_CHANNEL, PREVIEW_VERSION, type PreviewPickTarget } from '../src/client/preview-protocol.generated.ts'
import { createSidebarStore } from '../src/client/state.ts'

const SITE = 'http://northgate.tracy.test:8080'
const PAGE = `${SITE}/`
const TAB_ID = 'native-7'

const TARGET: PreviewPickTarget = {
  text: 'Services',
  tag: 'a',
  image: null,
  domPath: 'header > nav > li.item-104 > a',
  selector: 'li.item-104 > a',
  rect: { x: 300, y: 60, width: 60, height: 24 },
  marks: ['menu-item:104'],
  levels: [{ tag: 'a', mark: 'menu-item:104', text: 'Services', rect: { x: 300, y: 60, width: 60, height: 24 } }],
  level: 0,
}

let tickets = 0
/** The tab record as the sidebar holds it: every `updateTab` patch merged in. */
let record: { title: string; meta: Record<string, unknown> }
const updates: Array<{ id: string; patch: { title?: string; meta?: Record<string, unknown> } }> = []

function installFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input === '/api/config') return new Response(JSON.stringify({ siteDomain: 'tracy.test' }), { status: 200 })
    if (input === '/api/sites/northgate/preview-ticket') {
      tickets += 1
      return new Response(JSON.stringify({ ticket: `pv1.T${tickets}`, exp: 1 }), { status: 200 })
    }
    if (input === '/api/sites/northgate/apply') return new Response(JSON.stringify({ status: 'none', levels: [] }), { status: 200 })
    return new Response('{}', { status: 404 })
  }))
}

function props(meta: Record<string, unknown>) {
  const ctx = {
    get: (name: string) => (name === 'betterSidebar'
      ? {
          updateTab: (id: string, patch: { title?: string; meta?: Record<string, unknown> }) => {
            updates.push({ id, patch })
            record = { title: patch.title ?? record.title, meta: patch.meta ?? record.meta }
          },
        }
      : undefined),
  } as unknown as Context
  return {
    ctx,
    store: createSidebarStore(),
    scope: { sessionId: 's1', cwd: '/p' },
    tab: { id: TAB_ID, type: TRACY_BROWSER_KIND, title: 'northgate', meta },
    visible: true,
  }
}

let root: Root | null = null
let host: HTMLDivElement

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve() })
}

async function mount(meta: Record<string, unknown>): Promise<void> {
  record = { title: 'northgate', meta }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(createElement(BrowserView, props(meta))) })
  await flush()
}

/** Render the view again with the record as it now stands (a navigation the sidebar made). */
async function rerender(meta: Record<string, unknown>): Promise<void> {
  record = { ...record, meta }
  await act(async () => { root!.render(createElement(BrowserView, props(meta))) })
  await flush()
}

/** Throw the view away and mount it again from the record: what a reload of the tab does. */
async function reloadTab(meta: Record<string, unknown> = record.meta): Promise<void> {
  await act(async () => { root!.unmount() })
  host.remove()
  resetCommentModeMemo()
  await mount(meta)
}

function frame(): HTMLIFrameElement {
  return host.querySelector('iframe') as HTMLIFrameElement
}

function pageWindow(): { win: Window; posted: Array<[unknown, string]> } {
  const win = frame().contentWindow as Window
  const posted: Array<[unknown, string]> = []
  win.postMessage = ((message: unknown, origin: string) => { posted.push([message, origin]) }) as Window['postMessage']
  return { win, posted }
}

async function fromPage(win: Window | null, data: Record<string, unknown>, origin = SITE): Promise<void> {
  await act(async () => {
    const event = new MessageEvent('message', { data: { channel: PREVIEW_CHANNEL, v: PREVIEW_VERSION, ...data }, origin })
    Object.defineProperty(event, 'source', { value: win })
    window.dispatchEvent(event)
  })
  await flush()
}

function button(label: string): HTMLButtonElement | null {
  return [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label) ?? null
}

function editButton(): HTMLButtonElement | null {
  return button('Edit')
}

function interactiveButton(): HTMLButtonElement | null {
  return button('Interactive')
}

function starts(posted: Array<[unknown, string]>): number {
  return posted.filter(([m]) => (m as { kind: string }).kind === 'pick-start').length
}

async function enterEdit(): Promise<{ win: Window; posted: Array<[unknown, string]> }> {
  const page = pageWindow()
  await fromPage(page.win, { kind: 'ready', features: ['pick'] })
  await act(async () => { editButton()!.click() })
  return page
}

/** The zoom chip: dsh's Pill, named "Zoom", showing the value. */
function zoomChip(): HTMLButtonElement {
  return button('Zoom') as HTMLButtonElement
}

/** The zoom list, portaled into the body by dsh's Menu; null while closed. */
function zoomMenu(): HTMLElement | null {
  return document.body.querySelector('[role="menu"]')
}

function zoomRows(): HTMLButtonElement[] {
  return [...(zoomMenu()?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
}

async function openZoom(): Promise<void> {
  await act(async () => { zoomChip().click() })
}

async function selectZoom(value: string): Promise<void> {
  await openZoom()
  const row = zoomRows().find(item => item.textContent === `${value}%`)
  if (row === undefined) throw new Error(`zoom row ${value}% not found`)
  await act(async () => { row.click() })
  await flush()
}

let clock = 1_000_000
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  tickets = 0
  updates.length = 0
  resetCommentModeMemo()
  localStorage.clear()
  const base = document.createElement('base')
  base.href = `${location.origin}/northgate/`
  document.head.append(base)
  installFetch()
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en-US', platform: 'MacIntel', userAgent: 'x' },
    configurable: true,
  })
  // Every `ready` in these tests belongs to a new document: far apart from the last frame load.
  vi.spyOn(Date, 'now').mockImplementation(() => (clock += 10_000))
})

afterEach(async () => {
  if (root !== null) await act(async () => { root!.unmount() })
  root = null
  document.body.replaceChildren()
  document.head.querySelectorAll('base').forEach(b => { b.remove() })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('the rules', () => {
  it('takes only Tracy\'s mode values off an address, and leaves every other address byte for byte', () => {
    expect(takeModeParam(`${PAGE}?mode=edit`)).toEqual({ url: PAGE, mode: 'edit' })
    expect(takeModeParam(`${SITE}/news?x=1&mode=interactive#top`)).toEqual({ url: `${SITE}/news?x=1#top`, mode: 'interactive' })
    expect(takeModeParam(`${SITE}/shop?mode=grid`)).toEqual({ url: `${SITE}/shop?mode=grid`, mode: null })
    expect(takeModeParam(`${SITE}/a?b=%20c`)).toEqual({ url: `${SITE}/a?b=%20c`, mode: null })
    expect(withModeParam(`${SITE}/news?x=1`, 'edit')).toBe(`${SITE}/news?x=1&mode=edit`)
    expect(withModeParam(`${PAGE}?mode=interactive`, 'edit')).toBe(`${PAGE}?mode=edit`)
  })

  it('reads the record first, the mirror second, and ignores values the bar does not offer', () => {
    expect(viewStateOf({ mode: 'edit', zoom: 75 }, { mode: 'interactive', zoom: 150 })).toEqual({ mode: 'edit', zoom: 75 })
    expect(viewStateOf({}, { mode: 'edit', zoom: 150 })).toEqual({ mode: 'edit', zoom: 150 })
    expect(viewStateOf({ mode: 'comment', zoom: 33 }, null)).toEqual({ mode: 'interactive', zoom: 100 })
    // From the top centre of a 1000 px stage: x' = x·f + W·(1 − f)/2.
    expect(scaleRect({ x: 300, y: 60, width: 60, height: 24 }, 50, 1000)).toEqual({ x: 400, y: 30, width: 30, height: 12 })
    expect(scaleRect({ x: 300, y: 60, width: 60, height: 24 }, 100, 1000)).toEqual({ x: 300, y: 60, width: 60, height: 24 })
  })

  it('maps a box above 100 % from the scrolled canvas: x\' = x·f − scrollLeft, y\' = y·f − scrollTop', () => {
    const rect = { x: 300, y: 60, width: 60, height: 24 }
    // Scrolled to the centre of a 1000 px stage at 150 % (scrollLeft = 1000 × 0.5 / 2 = 250): the
    // same place the old top-centre transform put it, x·f + W·(1 − f)/2 = 450 − 250.
    expect(scaleRect(rect, 150, 1000, { left: 250, top: 0 })).toEqual({ x: 200, y: 90, width: 90, height: 36 })
    expect(scaleRect(rect, 150, 1000, { left: 500, top: 40 })).toEqual({ x: -50, y: 50, width: 90, height: 36 })
    // No offset given = the canvas' top-left corner.
    expect(scaleRect(rect, 150, 1000)).toEqual({ x: 450, y: 90, width: 90, height: 36 })
    // At and below 100 % nothing scrolls, so an offset (always 0 there) changes nothing but itself.
    expect(scaleRect(rect, 50, 1000, { left: 0, top: 0 })).toEqual({ x: 400, y: 30, width: 30, height: 12 })
    expect(centredScroll(1500, 1000)).toBe(250)
    expect(centredScroll(1000, 1000)).toBe(0)
    expect(centredScroll(0, 0)).toBe(0)
  })
})

describe('the mode is the tab\'s', () => {
  it('Edit survives a reload of the tab, and picking is re-armed without a press', async () => {
    await mount({ url: PAGE })
    expect(interactiveButton()).toBeNull()
    await enterEdit()
    expect(editButton()!.getAttribute('aria-pressed')).toBe('true')
    expect(record.meta).toMatchObject({ url: PAGE, mode: 'edit' })

    await reloadTab()
    // Before the page has said anything, the bar already shows the kept mode.
    expect(editButton()!.getAttribute('aria-pressed')).toBe('true')
    expect(interactiveButton()!.getAttribute('aria-pressed')).toBe('false')
    const { win, posted } = pageWindow()
    await fromPage(win, { kind: 'ready', features: ['pick'] })
    expect(posted).toEqual([[{ channel: PREVIEW_CHANNEL, v: PREVIEW_VERSION, kind: 'pick-start' }, SITE]])
    expect(host.textContent).toContain('Click anything on the page to edit')
  })

  it('a page reload that keeps only the tab id restores Edit from the localStorage mirror', async () => {
    await mount({ url: PAGE })
    await enterEdit()
    await reloadTab({ url: PAGE })
    expect(editButton()!.getAttribute('aria-pressed')).toBe('true')
  })

  it('re-arms picking on every fresh ready with pick while in Edit', async () => {
    await mount({ url: PAGE })
    const { win, posted } = await enterEdit()
    expect(starts(posted)).toBe(1)
    // The page reloads by itself (a form, a link inside the frame): a new document announces.
    await act(async () => { frame().dispatchEvent(new Event('load')) })
    await fromPage(win, { kind: 'ready', features: ['pick'] })
    expect(starts(posted)).toBe(2)
    await act(async () => { frame().dispatchEvent(new Event('load')) })
    await fromPage(win, { kind: 'ready', features: ['pick'] })
    expect(starts(posted)).toBe(3)
  })

  it('changing the URL inside the tab keeps Edit: a new ticket, then picking again', async () => {
    await mount({ url: PAGE })
    await enterEdit()
    await rerender({ ...record.meta, url: `${SITE}/news` })
    expect(tickets).toBe(2)
    expect(frame().getAttribute('src')).toBe(`${SITE}/news?tracy_preview=pv1.T2`)
    expect(editButton()!.getAttribute('aria-pressed')).toBe('true')
    const { win, posted } = pageWindow()
    await fromPage(win, { kind: 'ready', features: ['pick'] })
    expect(starts(posted)).toBe(1)
  })

  it('Esc goes back to Interactive, sends pick-stop, and that is kept too', async () => {
    await mount({ url: PAGE })
    const { posted } = await enterEdit()
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(interactiveButton()!.getAttribute('aria-pressed')).toBe('true')
    expect(posted.at(-1)?.[0]).toMatchObject({ kind: 'pick-stop' })
    expect(record.meta.mode).toBe('interactive')
    await reloadTab()
    const page = pageWindow()
    await fromPage(page.win, { kind: 'ready', features: ['pick'] })
    expect(starts(page.posted)).toBe(0)
  })

  it('Esc inside the page (pick-cancel) goes back to Interactive', async () => {
    await mount({ url: PAGE })
    const { win } = await enterEdit()
    await fromPage(win, { kind: 'pick-cancel' })
    expect(interactiveButton()!.getAttribute('aria-pressed')).toBe('true')
    expect(record.meta.mode).toBe('interactive')
  })

  it('closing the popover stays in Edit and points again', async () => {
    await mount({ url: PAGE })
    const { win, posted } = await enterEdit()
    await fromPage(win, { kind: 'picked', target: TARGET })
    await act(async () => { button('Close')!.click() })
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(editButton()!.getAttribute('aria-pressed')).toBe('true')
    expect(starts(posted)).toBe(2)
  })
})

describe('the address survives a page reload (the Sidebar keeps no meta)', () => {
  /** Type an address into the bar and press Enter: a navigation the view itself makes. */
  async function typeAddress(value: string): Promise<void> {
    const input = host.querySelector('input') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await flush()
  }

  it('a tab that went to /services/ shows /services/ again when the record comes back without meta.url', async () => {
    await mount({ url: PAGE })
    await typeAddress(`${SITE}/services/`)
    await reloadTab({})
    expect((host.querySelector('input') as HTMLInputElement).value).toBe(`${SITE}/services/`)
    expect(frame().getAttribute('src')).toContain(`${SITE}/services/`)
    // Written back into the record, so the site plugins' "already open" guards see it.
    expect(record.meta.url).toBe(`${SITE}/services/`)
  })

  it('a record that carries an address wins over a stale mirror', async () => {
    await mount({ url: PAGE })
    await typeAddress(`${SITE}/services/`)
    await reloadTab({ url: `${SITE}/about/` })
    expect((host.querySelector('input') as HTMLInputElement).value).toBe(`${SITE}/about/`)
    expect(frame().getAttribute('src')).toContain(`${SITE}/about/`)
    expect(record.meta.url).toBe(`${SITE}/about/`)
  })

  it('a fresh tab id has no mirror: the tab stays empty', async () => {
    await mount({})
    expect((host.querySelector('input') as HTMLInputElement).value).toBe('')
    expect(host.querySelector('iframe')).toBeNull()
    expect(record.meta.url).toBeUndefined()
  })
})

describe('a deep link', () => {
  it('?mode=edit on the recorded address sets Edit and never reaches the frame, the bar or the record', async () => {
    await mount({ url: `${PAGE}?mode=edit` })
    expect(frame().getAttribute('src')).toBe(`${PAGE}?tracy_preview=pv1.T1`)
    expect((host.querySelector('input') as HTMLInputElement).value).toBe(PAGE)
    expect(record.meta).toMatchObject({ url: PAGE, mode: 'edit' })
    expect(JSON.stringify(updates)).not.toContain('mode=')
    expect(tickets).toBe(1)
    expect(editButton()!.getAttribute('aria-pressed')).toBe('true')
  })

  it('typed in the bar: the site keeps its own parameters, Tracy\'s is taken off', async () => {
    await mount({ url: PAGE })
    const input = host.querySelector('input') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, `${SITE}/news?page=2&mode=edit`)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await flush()
    expect(frame().getAttribute('src')).toBe(`${SITE}/news?page=2&tracy_preview=pv1.T2`)
    expect(input.value).toBe(`${SITE}/news?page=2`)
    expect(record.meta).toMatchObject({ url: `${SITE}/news?page=2`, mode: 'edit' })
  })

  it('an open from elsewhere (the record rewritten) with ?mode=interactive leaves Edit', async () => {
    await mount({ url: PAGE, mode: 'edit' })
    await rerender({ ...record.meta, url: `${SITE}/about?mode=interactive` })
    expect(record.meta).toMatchObject({ url: `${SITE}/about`, mode: 'interactive' })
    expect(frame().getAttribute('src')).toBe(`${SITE}/about?tracy_preview=pv1.T2`)
    const { win, posted } = pageWindow()
    await fromPage(win, { kind: 'ready', features: ['pick'] })
    expect(interactiveButton()!.getAttribute('aria-pressed')).toBe('true')
    expect(starts(posted)).toBe(0)
  })

  it('"Open in browser" carries no mode: a visitor\'s own browser has no side card', async () => {
    const open = vi.fn()
    vi.stubGlobal('open', open)
    await mount({ url: `${PAGE}?mode=edit` })
    await act(async () => { button('Open in browser')!.click() })
    expect(open).toHaveBeenCalledWith(PAGE, '_blank', 'noopener')
  })
})

describe('zoom', () => {
  it('scales only the framed page, from its top centre, is kept per tab, and places the popover with the same transform', async () => {
    await mount({ url: PAGE })
    expect(frame().style.transform).toBe('')
    await selectZoom('75')
    expect(frame().style.transform).toBe('scale(0.75)')
    expect(frame().style.transformOrigin).toBe('50% 0')
    expect(frame().style.width).toBe('100%')
    expect(record.meta.zoom).toBe(75)

    await reloadTab()
    expect(zoomChip().textContent).toBe('75%')
    expect(frame().style.transform).toBe('scale(0.75)')

    const { win } = await enterEdit()
    await fromPage(win, { kind: 'picked', target: TARGET })
    // A new pick has no pin (stage 6), only the popover under the outline. jsdom lays nothing out, so
    // the layer places against its nominal 1024 px stage: x' = 300 × 0.75 + 1024 × 0.125 = 353, so
    // left = x' − 6 = 347; top = 60 × 0.75 + 24 × 0.75 + 6 + 10 = 79.
    expect(host.querySelector('[data-comment-pin]')).toBeNull()
    const popover = host.querySelector('[role="dialog"]') as HTMLElement
    expect(popover.style.left).toBe('347px')
    expect(popover.style.top).toBe('79px')
    // The popover, the hint and the bar are the parent's: never scaled.
    expect(popover.style.transform).toBe('')
  })

  it('is a chip showing the value that opens a menu of Claude Design\'s nine levels, the current one checked', async () => {
    await mount({ url: PAGE })
    const chip = zoomChip()
    expect(chip.textContent).toBe('100%')
    expect(chip.getAttribute('aria-haspopup')).toBe('menu')
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(zoomMenu()).toBeNull()

    await openZoom()
    expect(zoomChip().getAttribute('aria-expanded')).toBe('true')
    expect(zoomRows().map(row => row.textContent)).toEqual(['50%', '75%', '90%', '100%', '110%', '125%', '150%', '175%', '200%'])
    const checked = zoomRows().filter(row => row.querySelector('svg') !== null)
    expect(checked.map(row => row.textContent)).toEqual(['100%'])
  })

  it('closes on a pick, keeps the pick on the tab, and checks it next time', async () => {
    await mount({ url: PAGE })
    await selectZoom('110')
    expect(zoomMenu()).toBeNull()
    expect(zoomChip().getAttribute('aria-expanded')).toBe('false')
    expect(zoomChip().textContent).toBe('110%')
    expect(frame().style.transform).toBe('scale(1.1)')
    expect(record.meta.zoom).toBe(110)

    await reloadTab()
    expect(zoomChip().textContent).toBe('110%')
    await openZoom()
    expect(zoomRows().filter(row => row.querySelector('svg') !== null).map(row => row.textContent)).toEqual(['110%'])
  })

  it('closes on Esc without changing the zoom, and that Esc does not leave Edit', async () => {
    await mount({ url: PAGE })
    await enterEdit()
    expect(editButton()!.getAttribute('aria-pressed')).toBe('true')
    await openZoom()
    expect(zoomMenu()).not.toBeNull()
    await act(async () => {
      zoomChip().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(zoomMenu()).toBeNull()
    expect(zoomChip().textContent).toBe('100%')
    expect(editButton()!.getAttribute('aria-pressed')).toBe('true')
  })

  describe('above 100 % the stage scrolls to the clipped edges (decision 6)', () => {
    const STAGE = { width: 1000, height: 600 }
    /** jsdom lays nothing out: give the scroll box the sizes a real layout would at 150 %. */
    function layOut(zoom: number): void {
      const f = zoom / 100
      const sized = (el: Element, stage: number, scaled: number): number => (el.hasAttribute('data-browser-scroll') ? (f > 1 ? scaled : stage) : 0)
      vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) { return this.hasAttribute('data-browser-scroll') ? STAGE.width : 0 })
      vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) { return this.hasAttribute('data-browser-scroll') ? STAGE.height : 0 })
      vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) { return sized(this, STAGE.width, STAGE.width * f) })
      vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) { return sized(this, STAGE.height, STAGE.height * f) })
    }
    function scroller(): HTMLElement {
      return host.querySelector('[data-browser-scroll]') as HTMLElement
    }
    function canvas(): HTMLElement {
      return host.querySelector('[data-browser-canvas]') as HTMLElement
    }

    it('at 150 % the scroll box holds a canvas of stage × 1.5 with the frame scaled into it, scrolled to the centre', async () => {
      layOut(150)
      await mount({ url: PAGE })
      await selectZoom('150')
      expect(scroller().style.overflow).toBe('auto')
      expect(canvas().style.width).toBe('150%')
      expect(canvas().style.height).toBe('150%')
      // The frame keeps the stage's size (1/f of the canvas) and is scaled from the canvas' corner,
      // so the transformed frame fills the canvas exactly and the canvas is what scrolls.
      expect(frame().style.transform).toBe('scale(1.5)')
      expect(frame().style.transformOrigin).toBe('0 0')
      expect(parseFloat(frame().style.width)).toBeCloseTo(100 / 1.5, 3)
      expect(parseFloat(frame().style.height)).toBeCloseTo(100 / 1.5, 3)
      expect(scroller().scrollWidth).toBeGreaterThan(scroller().clientWidth)
      // Centred: the first view is today's top-centre look.
      expect(scroller().scrollLeft).toBe(250)
      expect(scroller().scrollTop).toBe(0)
    })

    it('places the popover with the scroll offset, and moves it when the person scrolls', async () => {
      layOut(150)
      await mount({ url: PAGE, zoom: 150 })
      expect(scroller().scrollLeft).toBe(250)
      const { win } = await enterEdit()
      await fromPage(win, { kind: 'picked', target: TARGET })
      const popover = (): HTMLElement => host.querySelector('[role="dialog"]') as HTMLElement
      // x' = 300 × 1.5 − 250 = 200, left = 200 − 6 = 194; top = 60 × 1.5 + 24 × 1.5 + 6 + 10 = 142.
      expect(popover().style.left).toBe('194px')
      expect(popover().style.top).toBe('142px')
      await act(async () => {
        scroller().scrollLeft = 300
        scroller().scrollTop = 40
        scroller().dispatchEvent(new Event('scroll'))
      })
      // x' = 450 − 300 = 150 → 144; y' = 90 − 40 = 50 → 50 + 36 + 16 = 102.
      expect(popover().style.left).toBe('144px')
      expect(popover().style.top).toBe('102px')
      // The layer is not inside the scroll box: the hint and the popover stay over the visible stage.
      expect(scroller().contains(host.querySelector('[role="dialog"]'))).toBe(false)
    })

    it('at 100 % nothing scrolls and the frame is untouched; going back from 150 % keeps the same frame', async () => {
      layOut(100)
      await mount({ url: PAGE })
      expect(scroller().style.overflow).toBe('hidden')
      expect(canvas().style.width).toBe('')
      expect(frame().style.transform).toBe('')
      expect(scroller().scrollLeft).toBe(0)
      const before = frame()
      await selectZoom('150')
      await selectZoom('100')
      // One frame through every zoom: crossing 100 % must not reload the page.
      expect(frame()).toBe(before)
      expect(scroller().style.overflow).toBe('hidden')
      expect(scroller().scrollLeft).toBe(0)
    })
  })

  it('closes on a pointer outside it', async () => {
    await mount({ url: PAGE })
    await openZoom()
    await act(async () => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
    expect(zoomMenu()).toBeNull()
    expect(record.meta.zoom ?? 100).toBe(100)
  })
})

describe('the page\'s real address (Brian, 27/09 evening)', () => {
  function listen(): BrowserViewDetail[] {
    const seen: BrowserViewDetail[] = []
    const on = (event: Event): void => { seen.push((event as CustomEvent<BrowserViewDetail>).detail) }
    window.addEventListener(BROWSER_VIEW_EVENT, on)
    return seen
  }

  it('announces what it shows on mount, on every change of page or mode, and url: null when it goes', async () => {
    const seen = listen()
    await mount({ url: `${SITE}/services` })
    expect(seen.at(-1)).toEqual({ tabId: TAB_ID, sessionId: 's1', siteKey: 'northgate', url: `${SITE}/services`, mode: 'interactive' })
    await enterEdit()
    expect(seen.at(-1)).toMatchObject({ url: `${SITE}/services`, mode: 'edit' })
    await rerender({ ...record.meta, url: `${SITE}/about` })
    expect(seen.at(-1)).toMatchObject({ url: `${SITE}/about`, mode: 'edit' })
    // Never the ticket, never Tracy's `?mode=`.
    expect(JSON.stringify(seen)).not.toContain('tracy_preview')
    expect(JSON.stringify(seen)).not.toContain('mode=')
    await act(async () => { root!.unmount() })
    root = null
    expect(seen.at(-1)).toEqual({ tabId: TAB_ID, sessionId: 's1', siteKey: 'northgate', url: null, mode: 'edit' })
  })

  it('withdraws the Browser URL while another native tab is visible', async () => {
    const seen = listen()
    await mount({ url: PAGE })
    await act(async () => { root!.render(createElement(BrowserView, { ...props(record.meta), visible: false })) })
    await flush()
    expect(seen.at(-1)?.url).toBeNull()
    await act(async () => { root!.render(createElement(BrowserView, { ...props(record.meta), visible: true })) })
    await flush()
    expect(seen.at(-1)?.url).toBe(PAGE)
  })

  it('"Copy link" copies the site door with the page and the mode, never the session', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(globalThis, 'navigator', {
      value: { language: 'en-US', platform: 'MacIntel', userAgent: 'x', clipboard: { writeText } },
      configurable: true,
    })
    await mount({ url: `${SITE}/services?x=1`, mode: 'edit' })
    await act(async () => { button('Copy link to this page in this mode')!.click() })
    await flush()
    expect(writeText).toHaveBeenCalledWith(`${location.origin}/northgate/?open=browser&page=/services?x=1&mode=edit`)
    expect(writeText.mock.calls[0]?.[0]).not.toContain('s1')
    expect(host.textContent).toContain('Link copied')
  })

  it('falls back to execCommand when the Clipboard API is missing (a plain-http stand)', async () => {
    const exec = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true })
    await mount({ url: `${SITE}/` })
    await act(async () => { button('Copy link to this page in this mode')!.click() })
    await flush()
    expect(exec).toHaveBeenCalledWith('copy')
    expect(host.textContent).toContain('Link copied')
  })

  it('offers no "Copy link" on a page that is not a Tracy site', async () => {
    await mount({ url: 'https://example.com/' })
    expect(button('Copy link to this page in this mode')).toBeNull()
  })

  it('siteDeepLink drops the ticket and Tracy\'s mode, and keeps the site\'s own query', () => {
    expect(siteDeepLink('http://tracy.test:8080', 'capiwl1643.tracy.test', `${SITE}/news?p=2&tracy_preview=pv1.x&mode=edit`, 'interactive'))
      .toBe('http://tracy.test:8080/capiwl1643.tracy.test/?open=browser&page=/news?p=2&mode=interactive')
    expect(siteDeepLink('http://tracy.test:8080', 'a.b', 'not a url', 'edit')).toBeNull()
  })
})
