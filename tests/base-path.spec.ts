import { describe, expect, it } from 'vitest'
import { hostRouteUrl, hostWebSocketUrl } from '../src/client/host-route-url.ts'

describe('Host route URLs', () => {
  const baseUrl = 'https://example.test/dataops/dsh/'

  it('retains the injected document base for every sidebar transport', () => {
    expect(hostRouteUrl('/sidebar/api/fs.tree', baseUrl).href)
      .toBe('https://example.test/dataops/dsh/sidebar/api/fs.tree')
    expect(hostRouteUrl('/sidebar/file?sessionId=s', baseUrl).href)
      .toBe('https://example.test/dataops/dsh/sidebar/file?sessionId=s')
    expect(hostRouteUrl('/sidebar/bundle/editor.js', baseUrl).href)
      .toBe('https://example.test/dataops/dsh/sidebar/bundle/editor.js')
    expect(hostWebSocketUrl('/sidebar/ws/terminal', baseUrl).href)
      .toBe('wss://example.test/dataops/dsh/sidebar/ws/terminal')
  })
})
