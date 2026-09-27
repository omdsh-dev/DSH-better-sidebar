// @vitest-environment jsdom
/**
 * External-link interception tests: the pure decision (which http(s) external
 * links a click may hand over), the click shape (plain left clicks only —
 * modified clicks always bypass), the takeover gate (only a URL an enabled
 * tab type CLAIMS through `urlTarget` is taken over at all), the open step
 * (the claimed type, or a real-browser `window.open` fallback when that type
 * is gone), and the registered click capture that puts them together.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isPlainLeftClick,
  isTargetAvailable,
  openInterceptedLink,
  registerLinkInterception,
  shouldInterceptLink,
  shouldTakeOverLink,
} from '../src/client/link-intercept.ts'

const SELF = 'http://127.0.0.1:3080'

describe('shouldInterceptLink', () => {
  it('takes over http(s) external links', () => {
    expect(shouldInterceptLink('https://example.com/page?a=1', SELF)).toBe('https://example.com/page?a=1')
    expect(shouldInterceptLink('http://example.com/', SELF)).toBe('http://example.com/')
  })

  it('ignores non-http(s) links (mailto:, javascript:, file:)', () => {
    expect(shouldInterceptLink('mailto:a@b.c', SELF)).toBeNull()
    expect(shouldInterceptLink('javascript:void(0)', SELF)).toBeNull()
    expect(shouldInterceptLink('file:///tmp/x.html', SELF)).toBeNull()
  })

  it('ignores unparsable hrefs', () => {
    expect(shouldInterceptLink('not a url', SELF)).toBeNull()
  })

  it('never takes over same-origin (GUI-internal) links', () => {
    expect(shouldInterceptLink('http://127.0.0.1:3080/settings', SELF)).toBeNull()
    expect(shouldInterceptLink('http://127.0.0.1:3080/chat/session-x', SELF)).toBeNull()
    // A different port of the same host is external.
    expect(shouldInterceptLink('http://127.0.0.1:9999/', SELF)).toBe('http://127.0.0.1:9999/')
  })

  it("takes over LAN hosts (the browser's own blocklist, not the link policy)", () => {
    // The link takeover only ever hands a link to a tab type that claims it;
    // whatever that target does with a loopback/LAN address is its own policy.
    expect(shouldInterceptLink('http://192.168.1.1/', SELF)).toBe('http://192.168.1.1/')
  })
})

describe('isPlainLeftClick', () => {
  const plain = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }

  it('accepts a plain left click', () => {
    expect(isPlainLeftClick(plain)).toBe(true)
  })

  it('bypasses modified clicks (Ctrl/Cmd/Shift/Alt) and non-left buttons', () => {
    expect(isPlainLeftClick({ ...plain, metaKey: true })).toBe(false)
    expect(isPlainLeftClick({ ...plain, ctrlKey: true })).toBe(false)
    expect(isPlainLeftClick({ ...plain, shiftKey: true })).toBe(false)
    expect(isPlainLeftClick({ ...plain, altKey: true })).toBe(false)
    expect(isPlainLeftClick({ ...plain, button: 1 })).toBe(false)
    expect(isPlainLeftClick({ ...plain, button: 2 })).toBe(false)
  })
})

describe('shouldTakeOverLink', () => {
  const url = new URL('http://example.com/page')

  it('takes over only a URL some tab type claims', () => {
    expect(shouldTakeOverLink(url, { suspended: false, resolveTarget: () => 'my-plugin:page' })).toBe(true)
    expect(shouldTakeOverLink(url, { suspended: false, resolveTarget: () => undefined })).toBe(false)
  })

  it('never consults a claim while the sidebar is suspended', () => {
    let claims = 0
    expect(shouldTakeOverLink(url, {
      suspended: true,
      resolveTarget: () => { claims++; return 'my-plugin:page' },
    })).toBe(false)
    // The suspension short-circuits: no claim is looked up at all.
    expect(claims).toBe(0)
  })
})

describe('isTargetAvailable', () => {
  it('accepts a registered type whose switch is absent or on', () => {
    expect(isTargetAvailable('my-plugin:page', [{ id: 'my-plugin:page' }], {})).toBe(true)
    expect(isTargetAvailable('my-plugin:page', [{ id: 'my-plugin:page' }], { 'my-plugin:page': true })).toBe(true)
  })

  it('rejects an unregistered type and a switched-off one', () => {
    expect(isTargetAvailable('my-plugin:page', [], {})).toBe(false)
    expect(isTargetAvailable('my-plugin:page', [{ id: 'other:page' }], {})).toBe(false)
    expect(isTargetAvailable('my-plugin:page', [{ id: 'my-plugin:page' }], { 'my-plugin:page': false })).toBe(false)
  })
})

describe('openInterceptedLink', () => {
  let openSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
  })
  afterEach(() => {
    openSpy.mockRestore()
  })

  it('opens the claimed type through the sidebar service, with the host as title', () => {
    const opened: Array<{ type: string; url: string; title?: string }> = []
    const path = openInterceptedLink('https://docs.example.com/a?b=1', {
      resolveTarget: () => 'my-plugin:page',
      isAvailable: () => true,
      sidebar: { openTab: seed => { opened.push(seed) } },
    })
    expect(path).toBe('sidebar')
    expect(opened).toEqual([{ type: 'my-plugin:page', url: 'https://docs.example.com/a?b=1', title: 'docs.example.com' }])
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('falls back to a real browser tab when the claimed type is gone', () => {
    const opened: unknown[] = []
    const path = openInterceptedLink('https://docs.example.com/a', {
      resolveTarget: () => 'my-plugin:page',
      isAvailable: () => false,
      sidebar: { openTab: seed => { opened.push(seed) } },
    })
    expect(path).toBe('window')
    expect(opened).toEqual([])
    expect(openSpy).toHaveBeenCalledWith('https://docs.example.com/a', '_blank', 'noopener,noreferrer')
  })

  it('falls back to a real browser tab when the plugin service is detached', () => {
    const path = openInterceptedLink('https://docs.example.com/a', {
      resolveTarget: () => 'my-plugin:page',
      isAvailable: () => true,
      sidebar: undefined,
    })
    expect(path).toBe('window')
    expect(openSpy).toHaveBeenCalledTimes(1)
  })

  it('falls back to a real browser tab when nothing claims the URL', () => {
    const opened: unknown[] = []
    const path = openInterceptedLink('https://unclaimed.example.com/a', {
      resolveTarget: () => undefined,
      isAvailable: () => true,
      sidebar: { openTab: seed => { opened.push(seed) } },
    })
    expect(path).toBe('window')
    expect(opened).toEqual([])
    expect(openSpy).toHaveBeenCalledWith('https://unclaimed.example.com/a', '_blank', 'noopener,noreferrer')
  })
})

describe('registerLinkInterception', () => {
  let openSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
  })
  afterEach(() => {
    openSpy.mockRestore()
  })

  /** Dispatch one click on an anchor with the given absolute href; the
   *  returned event carries `defaultPrevented` for the caller to assert. */
  const clickAnchor = (href: string, init: MouseEventInit = {}): MouseEvent => {
    const anchor = document.createElement('a')
    anchor.href = href
    document.body.appendChild(anchor)
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      ...init,
    })
    anchor.dispatchEvent(event)
    anchor.remove()
    return event
  }

  /** The index.tsx wiring (shouldTakeOverLink → openInterceptedLink) over a
   *  stub tab registry / tab service, so the capture registration, the gate
   *  and the open step are all exercised as shipped. */
  const mount = (stub: {
    tabs: readonly { id: string }[]
    tabsEnabled?: Record<string, boolean>
    claims?: (url: URL) => string | undefined
    suspended?: boolean
    detached?: boolean
  }): { opened: Array<{ type: string; url: string; title?: string }>; dispose: () => void } => {
    const opened: Array<{ type: string; url: string; title?: string }> = []
    const tabsEnabled = stub.tabsEnabled ?? {}
    const resolveTarget = stub.claims ?? (() => undefined)
    const dispose = registerLinkInterception({
      takeoverEnabled: url => shouldTakeOverLink(url, { suspended: stub.suspended ?? false, resolveTarget }),
      openInSidebar: (url) => {
        openInterceptedLink(url, {
          resolveTarget,
          isAvailable: type => isTargetAvailable(type, stub.tabs, tabsEnabled),
          sidebar: stub.detached === true ? undefined : { openTab: seed => { opened.push(seed) } },
        })
      },
      selfOrigin: SELF,
    })
    return { opened, dispose }
  }

  it('passes the parsed URL to takeoverEnabled and only takes over when it returns true', () => {
    const seen: string[] = []
    const opened: string[] = []
    const dispose = registerLinkInterception({
      takeoverEnabled: (url) => {
        seen.push(url.protocol)
        return url.protocol === 'http:'
      },
      openInSidebar: (url) => { opened.push(url) },
      selfOrigin: SELF,
    })
    // https → the gate refuses (nothing claims it in this stub).
    clickAnchor('https://example.com/page')
    // http → the gate passes, the click is taken over with the absolute href.
    clickAnchor('http://example.com/page')
    expect(seen).toEqual(['https:', 'http:'])
    expect(opened).toEqual(['http://example.com/page'])
    dispose()
  })

  it('leaves an UNCLAIMED http link to the host: no preventDefault, no open, no window', () => {
    const { opened, dispose } = mount({
      tabs: [{ id: 'my-plugin:page' }],
      claims: url => (url.hostname === 'claimed.example.com' ? 'my-plugin:page' : undefined),
    })
    const event = clickAnchor('http://unclaimed.example.com/readme')
    expect(event.defaultPrevented).toBe(false)
    expect(opened).toEqual([])
    expect(openSpy).not.toHaveBeenCalled()
    dispose()
  })

  it('takes over a CLAIMED link whose type is switched off, falling back to window.open', () => {
    const { opened, dispose } = mount({
      tabs: [{ id: 'my-plugin:page' }],
      tabsEnabled: { 'my-plugin:page': false },
      claims: () => 'my-plugin:page',
    })
    const event = clickAnchor('http://claimed.example.com/page')
    // Taken over (so the anchor's own default cannot double-open)…
    expect(event.defaultPrevented).toBe(true)
    // …but the sidebar cannot serve it any more: a real browser tab does.
    expect(opened).toEqual([])
    expect(openSpy).toHaveBeenCalledTimes(1)
    expect(openSpy).toHaveBeenCalledWith('http://claimed.example.com/page', '_blank', 'noopener,noreferrer')
    dispose()
  })

  it('takes over a CLAIMED link whose type was unregistered, falling back to window.open', () => {
    const { opened, dispose } = mount({ tabs: [], claims: () => 'my-plugin:page' })
    const event = clickAnchor('http://claimed.example.com/page')
    expect(event.defaultPrevented).toBe(true)
    expect(opened).toEqual([])
    expect(openSpy).toHaveBeenCalledWith('http://claimed.example.com/page', '_blank', 'noopener,noreferrer')
    dispose()
  })

  it('opens a CLAIMED link with a live target through the sidebar service', () => {
    const { opened, dispose } = mount({ tabs: [{ id: 'my-plugin:page' }], claims: () => 'my-plugin:page' })
    const event = clickAnchor('http://claimed.example.com/page?x=1')
    expect(event.defaultPrevented).toBe(true)
    expect(opened).toEqual([{ type: 'my-plugin:page', url: 'http://claimed.example.com/page?x=1', title: 'claimed.example.com' }])
    expect(openSpy).not.toHaveBeenCalled()
    dispose()
  })

  it('never consults the gate for same-origin or non-http(s) links', () => {
    let gateCalls = 0
    const dispose = registerLinkInterception({
      takeoverEnabled: () => { gateCalls++; return true },
      openInSidebar: () => { throw new Error('must not open') },
      selfOrigin: SELF,
    })
    expect(clickAnchor(`${SELF}/settings`).defaultPrevented).toBe(false)
    expect(clickAnchor('mailto:a@b.c').defaultPrevented).toBe(false)
    expect(gateCalls).toBe(0)
    dispose()
  })

  it('bypasses the takeover on modified clicks even when the gate passes', () => {
    let gateCalls = 0
    const dispose = registerLinkInterception({
      takeoverEnabled: () => { gateCalls++; return true },
      openInSidebar: () => { throw new Error('must not open') },
      selfOrigin: SELF,
    })
    expect(clickAnchor('http://example.com/', { ctrlKey: true }).defaultPrevented).toBe(false)
    expect(clickAnchor('http://example.com/', { metaKey: true }).defaultPrevented).toBe(false)
    expect(clickAnchor('http://example.com/', { button: 1 }).defaultPrevented).toBe(false)
    expect(clickAnchor('http://example.com/', { shiftKey: true }).defaultPrevented).toBe(false)
    expect(clickAnchor('http://example.com/', { altKey: true }).defaultPrevented).toBe(false)
    expect(gateCalls).toBe(0)
    dispose()
  })
})
