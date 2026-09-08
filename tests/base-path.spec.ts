import { afterEach, describe, expect, it, vi } from 'vitest'
import { hostRouteUrl, hostWebSocketUrl } from '../src/client/host-route-url.ts'

/**
 * Every browser-to-host transport must resolve relative to the injected page
 * base. A leading slash would discard this prefix and make a reverse proxy
 * route `/sidebar/*` at the origin root instead.
 */
describe('host route URLs behind a reverse-proxy base path', () => {
  const baseUrl = 'https://example.test/dataops/proxy/3080/'

  it('keeps the page prefix for API, uploads, media, HTML, and lazy bundles', () => {
    expect(hostRouteUrl('/sidebar/api/fs.tree', baseUrl).href)
      .toBe('https://example.test/dataops/proxy/3080/sidebar/api/fs.tree')
    expect(hostRouteUrl('/sidebar/upload?sessionId=s', baseUrl).href)
      .toBe('https://example.test/dataops/proxy/3080/sidebar/upload?sessionId=s')
    expect(hostRouteUrl('/sidebar/file?sessionId=s&path=%2Fwork%2Fa.png', baseUrl).href)
      .toBe('https://example.test/dataops/proxy/3080/sidebar/file?sessionId=s&path=%2Fwork%2Fa.png')
    expect(hostRouteUrl('/sidebar/html/s/work/index.html', baseUrl).href)
      .toBe('https://example.test/dataops/proxy/3080/sidebar/html/s/work/index.html')
    expect(hostRouteUrl('/sidebar/bundle/editor.js', baseUrl).href)
      .toBe('https://example.test/dataops/proxy/3080/sidebar/bundle/editor.js')
  })

  it('converts every WebSocket transport after preserving the page prefix', () => {
    expect(hostWebSocketUrl('/sidebar/ws/terminal', baseUrl).href)
      .toBe('wss://example.test/dataops/proxy/3080/sidebar/ws/terminal')
    expect(hostWebSocketUrl('/sidebar/ws/agent-terminals', baseUrl).href)
      .toBe('wss://example.test/dataops/proxy/3080/sidebar/ws/agent-terminals')
    expect(hostWebSocketUrl('/sidebar/ws/agent-opens', baseUrl).href)
      .toBe('wss://example.test/dataops/proxy/3080/sidebar/ws/agent-opens')
  })

  it('treats a missing trailing slash and a launch-token query as a directory prefix', () => {
    const withoutSlash = 'https://example.test/dataops/proxy/3080'
    const withToken = 'https://example.test/dataops/proxy/3080/?token=abc'
    expect(hostRouteUrl('/sidebar/api/fs.tree', withoutSlash).href)
      .toBe('https://example.test/dataops/proxy/3080/sidebar/api/fs.tree')
    expect(hostRouteUrl('/sidebar/bundle/editor.js', withToken).href)
      .toBe('https://example.test/dataops/proxy/3080/sidebar/bundle/editor.js')
    expect(hostWebSocketUrl('/sidebar/ws/terminal', withToken).href)
      .toBe('wss://example.test/dataops/proxy/3080/sidebar/ws/terminal')
  })
})

describe('hostDocumentBase prefers the longer live location over a root <base>', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses location.href when document.baseURI is the origin root', async () => {
    vi.resetModules()
    vi.stubGlobal('document', { baseURI: 'http://127.0.0.1:4199/' })
    vi.stubGlobal('location', { href: 'http://127.0.0.1:4199/dataops/proxy/3080/' })
    const { hostDocumentBase, hostRouteUrl: resolveRoute, hostWebSocketUrl: resolveWs } = await import('../src/client/host-route-url.ts')
    expect(hostDocumentBase()).toBe('http://127.0.0.1:4199/dataops/proxy/3080/')
    expect(resolveRoute('/sidebar/api/fs.tree').href)
      .toBe('http://127.0.0.1:4199/dataops/proxy/3080/sidebar/api/fs.tree')
    expect(resolveWs('/sidebar/ws/terminal').href)
      .toBe('ws://127.0.0.1:4199/dataops/proxy/3080/sidebar/ws/terminal')
  })
})
