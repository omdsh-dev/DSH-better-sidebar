/**
 * Reverse-proxy base paths (issue #753).
 *
 * The plugin's client half talks to the Host at `/sidebar/*`. Every one of
 * those URLs used to be built with a LEADING SLASH — `fetch('/sidebar/api/…')`,
 * `new URL('/sidebar/ws/…', base)`, `` `${origin}/sidebar/file?…` `` — which
 * pins the request to the ORIGIN ROOT. Behind a reverse proxy that serves the
 * GUI at `https://host/dataops/proxy/3080/`, the browser therefore asks
 * `https://host/sidebar/…`: the JSON API 404s, lazy chunks never load, media
 * and HTML previews stay blank, and the WebSockets close with 1006.
 *
 * These cases pin the resolver's contract (relative path + page prefix), the
 * single base authority (`__DSH_TRANSPORT__` first — the desktop shell's
 * `dsh-app://` origin is unreachable, see desktop-env.ts), and the URLs the
 * REAL call sites produce under a prefix.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import './browser-globals.ts'
import { hostRouteUrl, hostWebSocketUrl } from '../src/client/host-route-url.ts'
import { archiveDownloadUrl, downloadUrl, htmlUrl, mediaUrl, type SessionScope } from '../src/client/api.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'

/** A code-server-style prefix: a directory path, behind https. */
const PROXY = 'https://host.example.test/dataops/proxy/3080/'
const scope: SessionScope = { sessionId: 's1', cwd: '/ws' }

/** Run `body` with the page served under `base` — the one input the resolver
 *  reads when the shell injected no transport. */
async function withPageBase(base: string, body: () => void | Promise<void>): Promise<void> {
  const document = globalThis.document as { baseURI?: string }
  const previous = document.baseURI
  Object.defineProperty(document, 'baseURI', { value: base, configurable: true, writable: true })
  try {
    await body()
  } finally {
    Object.defineProperty(document, 'baseURI', { value: previous, configurable: true, writable: true })
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__
})

describe('hostRouteUrl / hostWebSocketUrl', () => {
  it('keeps the page prefix for every HTTP route family', () => {
    expect(hostRouteUrl('sidebar/api/fs.tree', PROXY).href)
      .toBe('https://host.example.test/dataops/proxy/3080/sidebar/api/fs.tree')
    expect(hostRouteUrl('sidebar/upload?sessionId=s', PROXY).href)
      .toBe('https://host.example.test/dataops/proxy/3080/sidebar/upload?sessionId=s')
    expect(hostRouteUrl('sidebar/file?sessionId=s&path=%2Fws%2Fa.png', PROXY).href)
      .toBe('https://host.example.test/dataops/proxy/3080/sidebar/file?sessionId=s&path=%2Fws%2Fa.png')
    expect(hostRouteUrl('sidebar/html/s/ws/index.html', PROXY).href)
      .toBe('https://host.example.test/dataops/proxy/3080/sidebar/html/s/ws/index.html')
    expect(hostRouteUrl('sidebar/bundle/editor.js', PROXY).href)
      .toBe('https://host.example.test/dataops/proxy/3080/sidebar/bundle/editor.js')
    expect(hostRouteUrl('sidebar/archive?sessionId=s&id=a', PROXY).href)
      .toBe('https://host.example.test/dataops/proxy/3080/sidebar/archive?sessionId=s&id=a')
  })

  it('accepts the route with or without its leading slash and never keeps it', () => {
    // A leading slash is the bug itself: it replaces the whole prefix.
    expect(hostRouteUrl('/sidebar/api/fs.tree', PROXY).href)
      .toBe(hostRouteUrl('sidebar/api/fs.tree', PROXY).href)
    expect(hostRouteUrl('///sidebar/api/fs.tree', PROXY).pathname)
      .toBe('/dataops/proxy/3080/sidebar/api/fs.tree')
  })

  it('upgrades the WebSocket scheme and keeps the prefix', () => {
    expect(hostWebSocketUrl('sidebar/ws/fs-watch', PROXY).href)
      .toBe('wss://host.example.test/dataops/proxy/3080/sidebar/ws/fs-watch')
    expect(hostWebSocketUrl('sidebar/ws/agent-opens', 'http://127.0.0.1:4199/app/').href)
      .toBe('ws://127.0.0.1:4199/app/sidebar/ws/agent-opens')
  })

  it('treats a launch-token query and a missing trailing slash as a directory prefix', () => {
    expect(hostRouteUrl('sidebar/api/fs.tree', 'https://host.test/dataops/proxy/3080?token=abc').href)
      .toBe('https://host.test/dataops/proxy/3080/sidebar/api/fs.tree')
    expect(hostRouteUrl('sidebar/bundle/editor.js', 'https://host.test/dataops/proxy/3080#frag').href)
      .toBe('https://host.test/dataops/proxy/3080/sidebar/bundle/editor.js')
    // The launch URL's own token must never ride along into the route.
    expect(hostRouteUrl('sidebar/api/fs.tree', 'https://host.test/?token=abc').href)
      .toBe('https://host.test/sidebar/api/fs.tree')
  })

  it('splits the base per transport in the desktop shell: HTTP rides the page, WS the injected origin', async () => {
    // 2718725: the Electron shell serves the GUI from `dsh-app://app/`, whose
    // host is the literal string `app` — resolving a WebSocket against it never
    // connects, so sockets use the injected Host origin.
    vi.stubGlobal('__DSH_TRANSPORT__', { streamBaseUrl: 'http://127.0.0.1:4199/' })
    await withPageBase('dsh-app://app/', () => {
      // HTTP stays on the page: the shell's protocol handler forwards every
      // non-static dsh-app path to the Host same-origin, and the plugin's own
      // routes carry no CORS headers — a cross-origin POST to the injected
      // origin is rejected by the browser ("Failed to fetch").
      expect(hostRouteUrl('sidebar/api/fs.tree', undefined).href)
        .toBe('dsh-app://app/sidebar/api/fs.tree')
      expect(hostRouteUrl('sidebar/bundle/editor.js', undefined).href)
        .toBe('dsh-app://app/sidebar/bundle/editor.js')
    })
    expect(hostWebSocketUrl('sidebar/ws/fs-watch', undefined).href)
      .toBe('ws://127.0.0.1:4199/sidebar/ws/fs-watch')
  })

  it('falls back to the injected base for HTTP when the page has none (specs, SSR)', () => {
    vi.stubGlobal('__DSH_TRANSPORT__', { streamBaseUrl: 'http://127.0.0.1:4199/' })
    const document = globalThis.document as { baseURI?: string }
    const previous = document.baseURI
    Object.defineProperty(document, 'baseURI', { value: '', configurable: true, writable: true })
    try {
      expect(hostRouteUrl('sidebar/api/fs.tree', undefined).href)
        .toBe('http://127.0.0.1:4199/sidebar/api/fs.tree')
    } finally {
      Object.defineProperty(document, 'baseURI', { value: previous, configurable: true, writable: true })
    }
  })

  it('keeps the injected base for HTTP on an ordinary http(s) page (same origin)', () => {
    vi.stubGlobal('__DSH_TRANSPORT__', { streamBaseUrl: 'http://127.0.0.1:4199/' })
    expect(hostRouteUrl('sidebar/api/fs.tree', 'http://127.0.0.1:4199/').href)
      .toBe('http://127.0.0.1:4199/sidebar/api/fs.tree')
  })
})

describe('the real call sites resolve through the page prefix', () => {
  it('builds the media, download, HTML and archive URLs under the prefix', async () => {
    await withPageBase(PROXY, () => {
      expect(mediaUrl(scope, '/ws/img/a.png'))
        .toBe('https://host.example.test/dataops/proxy/3080/sidebar/file?sessionId=s1&path=%2Fws%2Fimg%2Fa.png&cwd=%2Fws')
      expect(downloadUrl(scope, '/ws/img/a.png'))
        .toBe('https://host.example.test/dataops/proxy/3080/sidebar/file?sessionId=s1&path=%2Fws%2Fimg%2Fa.png&cwd=%2Fws&download=1')
      expect(htmlUrl({ sessionId: 's1' }, '/ws/index.html'))
        .toBe('https://host.example.test/dataops/proxy/3080/sidebar/html/s1/ws/index.html')
      expect(archiveDownloadUrl({ sessionId: 's1' }, 'job-1'))
        .toBe('https://host.example.test/dataops/proxy/3080/sidebar/archive?sessionId=s1&id=job-1')
    })
  })

  it('posts the JSON API under the prefix', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) } as unknown as Response
    }))
    await withPageBase(PROXY, async () => {
      const { api } = await import('../src/client/api.ts')
      await api.settingsGet()
      await api.fsTree(scope, '/ws')
    })
    expect(urls).toEqual([
      'https://host.example.test/dataops/proxy/3080/sidebar/api/settings.get',
      'https://host.example.test/dataops/proxy/3080/sidebar/api/fs.tree',
    ])
  })

  it('exposes the same resolution to consumer plugins through the service', async () => {
    await withPageBase(PROXY, () => {
      const service = createBetterSidebarService(createSidebarStore())
      expect(service.features).toContain('hostRouteUrl')
      expect(service.hostRouteUrl('/sidebar/api/fs.read'))
        .toBe('https://host.example.test/dataops/proxy/3080/sidebar/api/fs.read')
    })
  })
})
