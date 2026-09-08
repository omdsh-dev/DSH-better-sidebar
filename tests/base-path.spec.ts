import { describe, expect, it } from 'vitest'
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
})
