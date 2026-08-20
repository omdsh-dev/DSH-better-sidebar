import { chromium, type BrowserContext, type CDPSession, type Page } from 'playwright'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { URL } from 'node:url'

export type ElementRef = {
  ref: number
  tag: string
  type: string
  label: string
  href: string
}

export type SnapshotDiff = {
  urlChanged: boolean
  titleChanged: boolean
  textDelta: number
  added: Array<{ ref: number; tag: string; label: string; type: string }>
  removed: Array<{ tag: string; label: string; type: string }>
}

export interface AgentBrowserSnapshot {
  sessionId: string
  url: string
  title: string
  text: string
  textLength: number
  links: Array<{ t: string; h: string }>
  elements: ElementRef[]
  screenshot: string
  updatedAt: number
  changed: SnapshotDiff | null
}

interface PrevSnapshot {
  url: string
  title: string
  textLength: number
  elements: ElementRef[]
}

/**
 * Virtual key codes for non-printable keys. Chrome maps windowsVirtualKeyCode
 * (and nativeVirtualKeyCode on macOS) to editing commands — without them a
 * Backspace keyDown is inert and deletes nothing.
 * Table: { windows, mac } per DOM `key` name.
 */
const SPECIAL_KEY_CODES: Record<string, { win: number; mac: number }> = {
  Backspace: { win: 8, mac: 51 },
  Tab: { win: 9, mac: 48 },
  Enter: { win: 13, mac: 36 },
  Escape: { win: 27, mac: 53 },
  Delete: { win: 46, mac: 117 },
  ArrowLeft: { win: 37, mac: 123 },
  ArrowUp: { win: 38, mac: 126 },
  ArrowRight: { win: 39, mac: 124 },
  ArrowDown: { win: 40, mac: 125 },
  Home: { win: 36, mac: 115 },
  End: { win: 35, mac: 119 },
  PageUp: { win: 33, mac: 116 },
  PageDown: { win: 34, mac: 121 },
  F1: { win: 112, mac: 122 },
  F2: { win: 113, mac: 120 },
  F3: { win: 114, mac: 99 },
  F4: { win: 115, mac: 118 },
  F5: { win: 116, mac: 96 },
  F6: { win: 117, mac: 97 },
  F7: { win: 118, mac: 98 },
  F8: { win: 119, mac: 100 },
  F9: { win: 120, mac: 101 },
  F10: { win: 121, mac: 109 },
  F11: { win: 122, mac: 103 },
  F12: { win: 123, mac: 111 },
}

export type ControlOwner = 'agent' | 'human' | 'none'

export type MirrorFrame = {
  data: string
  seq: number
  timestamp: number
  viewportWidth: number
  viewportHeight: number
}

export type MirrorInputEvent =
  | { type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel'; x: number; y: number; button?: 'left' | 'right' | 'middle' | 'none'; clickCount?: number; deltaX?: number; deltaY?: number }
  | { type: 'keyDown' | 'keyUp'; key: string; code?: string; text?: string }
  | { type: 'imeSetComposition'; text: string; selectionStart?: number; selectionEnd?: number }
  | { type: 'insertText'; text: string }

export type MirrorMeta = {
  controlOwner: ControlOwner
  viewportWidth: number
  viewportHeight: number
}

interface MirrorState {
  cdp: CDPSession
  latestFrame: MirrorFrame | null
  frameSeq: number
  controlOwner: ControlOwner
  viewportWidth: number
  viewportHeight: number
  /** Push subscribers (the WebSocket bridge): frames fire as they arrive. */
  frameListeners: Set<(frame: MirrorFrame) => void>
  /** Meta subscribers: control ownership / viewport changes. */
  metaListeners: Set<(meta: MirrorMeta) => void>
}

interface BrowserState {
  context: BrowserContext
  page: Page
  updatedAt: number
  lastSnapshot: PrevSnapshot | null
}

const MAX_TEXT = 120_000
const MAX_ELEMENTS = 200
const MAX_EVAL = 20_000
const MAX_SCREENSHOT = 8 * 1024 * 1024
const PROFILE_ROOT = join(homedir(), '.dsh', 'agent-browser-profiles')

function profilePath(sessionId: string): string {
  const id = createHash('sha256').update(sessionId).digest('hex').slice(0, 32)
  return join(PROFILE_ROOT, id)
}

function stateError(message: string): Error {
  return new Error(`agent browser: ${message}`)
}

function assertPublicUrl(raw: string): void {
  let url: URL
  try { url = new URL(raw) } catch { throw stateError('invalid URL') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw stateError('only HTTP(S) URLs are allowed')
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0' || host.endsWith('.localhost')) {
    throw stateError('loopback URLs are blocked')
  }
  if (isIP(host) === 4 && (host.startsWith('127.') || host === '0.0.0.0')) {
    throw stateError('loopback URLs are blocked')
  }
}

function elementKey(el: ElementRef): string {
  return `${el.tag}|${el.type}|${el.label}|${el.href}`
}

function diffSnapshots(prev: PrevSnapshot, next: AgentBrowserSnapshot): SnapshotDiff {
  const prevKeys = new Set(prev.elements.map(elementKey))
  const nextKeys = new Set(next.elements.map(elementKey))
  const added = next.elements.filter(el => !prevKeys.has(elementKey(el)))
    .map(el => ({ ref: el.ref, tag: el.tag, label: el.label, type: el.type }))
  const removed = prev.elements.filter(el => !nextKeys.has(elementKey(el)))
    .map(el => ({ tag: el.tag, label: el.label, type: el.type }))
  return {
    urlChanged: prev.url !== next.url,
    titleChanged: prev.title !== next.title,
    textDelta: next.textLength - prev.textLength,
    added: added.slice(0, 10),
    removed: removed.slice(0, 10),
  }
}

export class AgentBrowserManager {
  private readonly states = new Map<string, BrowserState>()

  async open(sessionId: string, url: string): Promise<AgentBrowserSnapshot> {
    assertPublicUrl(url)
    let state = this.states.get(sessionId)
    // Detect dead state (e.g. host restarted but the old Chromium was killed)
    if (state !== undefined) {
      try {
        if (state.page.isClosed() || !state.context.browser()?.isConnected()) {
          this.states.delete(sessionId)
          await state.context.close().catch(() => {})
          state = undefined
        }
      } catch {
        this.states.delete(sessionId)
        state = undefined
      }
    }
    if (state === undefined) {
      await mkdir(PROFILE_ROOT, { recursive: true })
      // Use real Chrome when available — Google OAuth rejects Playwright's
      // bundled Chromium as "insecure". Fall back to bundled Chromium.
      const launchOpts: Parameters<typeof chromium.launchPersistentContext>[1] = {
        headless: false,
        viewport: { width: 1280, height: 900 },
        args: ['--disable-blink-features=AutomationControlled'],
      }
      let context: BrowserContext
      try {
        context = await chromium.launchPersistentContext(profilePath(sessionId), {
          ...launchOpts,
          channel: 'chrome',
        })
      } catch {
        context = await chromium.launchPersistentContext(profilePath(sessionId), launchOpts)
      }
      const page = context.pages()[0] ?? await context.newPage()
      // Remove the webdriver flag that triggers bot detection
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false })
      })
      state = { context, page, updatedAt: Date.now(), lastSnapshot: null }
      this.states.set(sessionId, state)
    }
    await state.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    state.lastSnapshot = null
    return this.snapshot(sessionId)
  }

  private requireState(sessionId: string): BrowserState {
    const state = this.states.get(sessionId)
    if (state === undefined) throw stateError(`no browser for session ${sessionId}; call browser_open first`)
    return state
  }

  /** Wait for the page to settle after an action. Never rejects. */
  private async settle(state: BrowserState, ms = 300): Promise<void> {
    await state.page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {})
    await state.page.waitForTimeout(ms)
  }

  async snapshot(sessionId: string): Promise<AgentBrowserSnapshot> {
    const state = this.requireState(sessionId)
    state.updatedAt = Date.now()
    let data: {
      title: string; url: string; text: string; textLength: number
      links: Array<{ t: string; h: string }>
      elements: ElementRef[]
    }
    try {
      data = await state.page.evaluate(({ maxEls, maxTxt }) => {
        const text = document.body ? document.body.innerText : ''
        const links = Array.from(document.querySelectorAll('a')).slice(0, 50).map(a => ({
          t: ((a as HTMLElement).innerText || a.title || a.getAttribute('aria-label') || '').trim().slice(0, 80),
          h: a.href,
        })).filter(l => l.h)
        const selectors = 'a,button,input,textarea,select,summary,[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="combobox"],[role="option"],[role="tab"]'
        const els: Array<{ el: Element; ref: number; tag: string; type: string; label: string; href: string }> = []
        const seen = new Set<Element>()
        for (const el of document.querySelectorAll(selectors)) {
          if (seen.has(el)) continue
          seen.add(el)
          const r = el.getBoundingClientRect()
          if (r.width === 0 && r.height === 0) continue
          const tag = el.tagName.toLowerCase()
          const inp = el as HTMLInputElement
          const label = ((el as HTMLElement).innerText || inp.value || el.getAttribute('aria-label') || el.getAttribute('title') || inp.name || inp.placeholder || '').trim().slice(0, 100)
          els.push({ el, ref: els.length + 1, tag, type: el.getAttribute('type') || '', label, href: (el as HTMLAnchorElement).href || '' })
          if (els.length >= maxEls) break
        }
        ;(window as unknown as Record<string, unknown>).__agentEls = els
        return {
          title: document.title,
          url: location.href,
          text: text.slice(0, maxTxt),
          textLength: text.length,
          links,
          elements: els.map(({ el: _el, ...d }) => d),
        }
      }, { maxEls: MAX_ELEMENTS, maxTxt: MAX_TEXT }) as typeof data
    } catch {
      data = { title: '', url: state.page.url(), text: '', textLength: 0, links: [], elements: [] }
    }
    const screenshot = (await state.page.screenshot({ type: 'png' })).toString('base64')
    if (Buffer.byteLength(screenshot, 'base64') > MAX_SCREENSHOT) throw stateError('screenshot exceeds size limit')
    const snap: AgentBrowserSnapshot = {
      sessionId,
      url: data.url,
      title: data.title,
      text: data.text,
      textLength: data.textLength,
      links: data.links,
      elements: data.elements,
      screenshot,
      updatedAt: state.updatedAt,
      changed: state.lastSnapshot !== null ? diffSnapshots(state.lastSnapshot, {
        sessionId, url: data.url, title: data.title, text: data.text, textLength: data.textLength,
        links: data.links, elements: data.elements, screenshot: '', updatedAt: state.updatedAt, changed: null,
      }) : null,
    }
    state.lastSnapshot = { url: data.url, title: data.title, textLength: data.textLength, elements: data.elements }
    return snap
  }

  async click(sessionId: string, target: number | string): Promise<AgentBrowserSnapshot> {
    const state = this.requireState(sessionId)
    if (typeof target === 'number') {
      const result = await state.page.evaluate((ref) => {
        const entry = (window as unknown as Record<string, Array<{ el: HTMLElement }> | undefined>).__agentEls?.[ref - 1]
        if (!entry) return { ok: false, error: `stale or unknown ref ${ref} — run browser_snapshot for the current numbered list` }
        const el = entry.el
        el.scrollIntoView({ block: 'center' })
        el.click()
        return { ok: true, ref, tag: el.tagName.toLowerCase(), text: ((el as HTMLElement).innerText || (el as HTMLInputElement).value || '').slice(0, 120) }
      }, target) as { ok: boolean; error?: string }
      if (!result.ok) throw stateError(result.error ?? 'click failed')
    } else {
      await state.page.locator(target).first().click({ timeout: 15_000 })
    }
    await this.settle(state)
    return this.snapshot(sessionId)
  }

  async type(sessionId: string, target: number | string, text: string, submit = false): Promise<AgentBrowserSnapshot> {
    const state = this.requireState(sessionId)
    if (typeof target === 'number') {
      const result = await state.page.evaluate(({ ref, value }) => {
        const entry = (window as unknown as Record<string, Array<{ el: HTMLElement }> | undefined>).__agentEls?.[ref - 1]
        if (!entry) return { ok: false, error: `stale or unknown ref ${ref} — run browser_snapshot for the current numbered list` }
        const el = entry.el as HTMLInputElement | HTMLTextAreaElement
        el.focus()
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return { ok: true }
      }, { ref: target, value: text }) as { ok: boolean; error?: string }
      if (!result.ok) throw stateError(result.error ?? 'type failed')
      if (submit) await state.page.keyboard.press('Enter')
    } else {
      const field = state.page.locator(target).first()
      await field.fill(text, { timeout: 15_000 })
      if (submit) await field.press('Enter')
    }
    await this.settle(state)
    return this.snapshot(sessionId)
  }

  async press(sessionId: string, key: string): Promise<AgentBrowserSnapshot> {
    const state = this.requireState(sessionId)
    await state.page.keyboard.press(key)
    await this.settle(state, 200)
    return this.snapshot(sessionId)
  }

  async back(sessionId: string): Promise<AgentBrowserSnapshot> {
    const state = this.requireState(sessionId)
    await state.page.goBack({ waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {})
    return this.snapshot(sessionId)
  }

  async reload(sessionId: string): Promise<AgentBrowserSnapshot> {
    const state = this.requireState(sessionId)
    await state.page.reload({ waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {})
    return this.snapshot(sessionId)
  }

  async wait(sessionId: string, ms: number): Promise<AgentBrowserSnapshot> {
    const state = this.requireState(sessionId)
    const clamped = Math.max(0, Math.min(30_000, Math.round(ms)))
    await state.page.waitForTimeout(clamped)
    return this.snapshot(sessionId)
  }

  async evalJs(sessionId: string, expression: string): Promise<{ ok: boolean; type: string; text: string }> {
    const state = this.requireState(sessionId)
    try {
      const value: unknown = await state.page.evaluate(expression)
      let text: string
      try { text = JSON.stringify(value) } catch { text = String(value) }
      if (text.length > MAX_EVAL) text = `${text.slice(0, MAX_EVAL)}…(truncated)`
      return { ok: true, type: typeof value, text }
    } catch (error) {
      return { ok: false, type: 'error', text: String(error instanceof Error ? error.message : error) }
    }
  }

  // ── Mirror: CDP screencast + input forwarding ──────────────────────────

  private readonly mirrors = new Map<string, MirrorState>()

  /**
   * Start the mirror. When displayWidth/Height are given (the sidebar canvas's
   * rendered CSS size), the page is re-laid-out at that size via device metrics
   * override so 1 browser CSS px ≈ 1 display px — text stays readable instead of
   * shrinking the full desktop layout into a narrow panel. deviceScaleFactor 2
   * keeps the screencast JPEG retina-sharp; coordinates stay in CSS px.
   */
  async startMirror(
    sessionId: string,
    display?: { width?: number; height?: number },
  ): Promise<{ viewportWidth: number; viewportHeight: number; controlOwner: ControlOwner }> {
    const state = this.requireState(sessionId)
    await this.stopMirror(sessionId)
    const cdp = await state.page.context().newCDPSession(state.page)
    await cdp.send('Page.enable').catch(() => {})

    const hasDisplay = typeof display?.width === 'number' && typeof display?.height === 'number'
      && display.width >= 320 && display.height >= 320
    const targetW = hasDisplay ? Math.round(Math.min(display.width as number, 1920)) : 0
    const targetH = hasDisplay ? Math.round(Math.min(display.height as number, 1920)) : 0
    const useOverride = hasDisplay
    const applyOverride = async () => {
      if (!useOverride) return
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: targetW,
        height: targetH,
        deviceScaleFactor: 2,
        mobile: false,
      }).catch(() => {})
    }
    await applyOverride()
    // Playwright may re-apply its own viewport emulation across navigations;
    // re-assert ours whenever the main frame navigates.
    if (useOverride) {
      cdp.on('Page.frameNavigated', (event: { frame?: { parentId?: string } }) => {
        if (event.frame?.parentId === undefined) void applyOverride()
      })
    }

    const metrics = await cdp.send('Page.getLayoutMetrics')
    const vp = (metrics.cssVisualViewport ?? metrics.cssLayoutViewport) as { clientWidth?: number; clientHeight?: number } | undefined
    const vw = Math.round(vp?.clientWidth ?? 1280)
    const vh = Math.round(vp?.clientHeight ?? 900)
    const mirror: MirrorState = {
      cdp,
      latestFrame: null,
      frameSeq: 0,
      controlOwner: 'agent',
      viewportWidth: vw,
      viewportHeight: vh,
      frameListeners: new Set(),
      metaListeners: new Set(),
    }
    cdp.on('Page.screencastFrame', (frame: { data: string; sessionId: number }) => {
      mirror.frameSeq++
      const next: MirrorFrame = {
        data: frame.data,
        seq: mirror.frameSeq,
        timestamp: Date.now(),
        viewportWidth: mirror.viewportWidth,
        viewportHeight: mirror.viewportHeight,
      }
      mirror.latestFrame = next
      // ACK immediately — never let frames queue up
      void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
      // Push to subscribers (WS bridge); a slow consumer drops frames rather
      // than queueing them — latest-frame-only end to end.
      for (const listener of mirror.frameListeners) {
        try { listener(next) } catch { /* listener must not break the pipeline */ }
      }
    })
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 70,
      // Frames arrive at 2x device pixels under the override; cap accordingly.
      maxWidth: vw * 2,
      maxHeight: vh * 2,
      everyNthFrame: 1,
    })
    this.mirrors.set(sessionId, mirror)
    return { viewportWidth: vw, viewportHeight: vh, controlOwner: mirror.controlOwner }
  }

  async stopMirror(sessionId: string): Promise<void> {
    const mirror = this.mirrors.get(sessionId)
    if (!mirror) return
    this.mirrors.delete(sessionId)
    try { await mirror.cdp.send('Page.stopScreencast') } catch { /* already stopped */ }
    try { await mirror.cdp.detach() } catch { /* already detached */ }
  }

  getMirrorFrame(sessionId: string): MirrorFrame | null {
    return this.mirrors.get(sessionId)?.latestFrame ?? null
  }

  getMirrorState(sessionId: string): MirrorMeta | null {
    const m = this.mirrors.get(sessionId)
    if (!m) return null
    return { controlOwner: m.controlOwner, viewportWidth: m.viewportWidth, viewportHeight: m.viewportHeight }
  }

  /** Subscribe to pushed frames; returns an unsubscribe function. */
  onMirrorFrame(sessionId: string, listener: (frame: MirrorFrame) => void): (() => void) | null {
    const mirror = this.mirrors.get(sessionId)
    if (!mirror) return null
    mirror.frameListeners.add(listener)
    return () => { mirror.frameListeners.delete(listener) }
  }

  /** Subscribe to meta changes (controlOwner / viewport); returns unsubscribe. */
  onMirrorMeta(sessionId: string, listener: (meta: MirrorMeta) => void): (() => void) | null {
    const mirror = this.mirrors.get(sessionId)
    if (!mirror) return null
    mirror.metaListeners.add(listener)
    return () => { mirror.metaListeners.delete(listener) }
  }

  private emitMirrorMeta(mirror: MirrorState): void {
    const meta: MirrorMeta = {
      controlOwner: mirror.controlOwner,
      viewportWidth: mirror.viewportWidth,
      viewportHeight: mirror.viewportHeight,
    }
    for (const listener of mirror.metaListeners) {
      try { listener(meta) } catch { /* listener must not break the pipeline */ }
    }
  }

  /**
   * Re-fit the mirrored page to a new display size (sidebar drag-resize):
   * re-applies the device metrics override without tearing down the CDP
   * session or resetting the frame sequence.
   */
  async refitMirror(sessionId: string, display: { width: number; height: number }): Promise<MirrorMeta> {
    const mirror = this.mirrors.get(sessionId)
    if (!mirror) throw stateError('mirror not started; call mirror.start first')
    const width = Math.round(Math.min(Math.max(display.width, 320), 1920))
    const height = Math.round(Math.min(Math.max(display.height, 320), 1920))
    await mirror.cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: false,
    })
    // The override triggers a reflow; getLayoutMetrics reflects it right away.
    const metrics = await mirror.cdp.send('Page.getLayoutMetrics')
    const vp = (metrics.cssVisualViewport ?? metrics.cssLayoutViewport) as { clientWidth?: number; clientHeight?: number } | undefined
    mirror.viewportWidth = Math.round(vp?.clientWidth ?? width)
    mirror.viewportHeight = Math.round(vp?.clientHeight ?? height)
    this.emitMirrorMeta(mirror)
    return { controlOwner: mirror.controlOwner, viewportWidth: mirror.viewportWidth, viewportHeight: mirror.viewportHeight }
  }

  async sendMirrorInput(sessionId: string, event: MirrorInputEvent): Promise<void> {
    const mirror = this.mirrors.get(sessionId)
    if (!mirror) throw stateError('mirror not started; call mirror.start first')
    if (event.type === 'insertText') {
      await mirror.cdp.send('Input.insertText', { text: event.text })
    } else if (event.type === 'imeSetComposition') {
      const caret = event.text.length
      await mirror.cdp.send('Input.imeSetComposition', {
        text: event.text,
        selectionStart: event.selectionStart ?? caret,
        selectionEnd: event.selectionEnd ?? caret,
      })
    } else if (event.type === 'keyDown' || event.type === 'keyUp') {
      const codes = SPECIAL_KEY_CODES[event.key]
      await mirror.cdp.send('Input.dispatchKeyEvent', {
        // rawKeyDown is the correct down-type for non-text keys (CDP docs:
        // keyDown implies text generation; rawKeyDown is the raw key press).
        type: event.type === 'keyDown' ? 'rawKeyDown' : 'keyUp',
        key: event.key,
        code: event.code ?? event.key,
        text: event.text,
        windowsVirtualKeyCode: codes?.win,
        nativeVirtualKeyCode: codes?.mac,
      })
    } else if (event.type === 'mousePressed' || event.type === 'mouseReleased' || event.type === 'mouseMoved' || event.type === 'mouseWheel') {
      await mirror.cdp.send('Input.dispatchMouseEvent', {
        type: event.type,
        x: event.x,
        y: event.y,
        button: event.button ?? 'none',
        clickCount: event.clickCount ?? 0,
        deltaX: event.deltaX ?? 0,
        deltaY: event.deltaY ?? 0,
      })
    }
  }

  setMirrorControl(sessionId: string, owner: ControlOwner): void {
    const mirror = this.mirrors.get(sessionId)
    if (!mirror) return
    mirror.controlOwner = owner
    this.emitMirrorMeta(mirror)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async close(sessionId: string): Promise<boolean> {
    await this.stopMirror(sessionId)
    const state = this.states.get(sessionId)
    if (state === undefined) return false
    this.states.delete(sessionId)
    await state.context.close()
    return true
  }

  async dispose(): Promise<void> {
    const sessions = [...this.states.keys()]
    await Promise.all(sessions.map(sessionId => this.close(sessionId)))
  }
}
