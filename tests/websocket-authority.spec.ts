import { afterEach, describe, expect, it } from 'vitest'
import { websocketAuthority } from '../src/client/websocket-authority.ts'

const g = globalThis as { location?: { origin: string }; __DSH_TRANSPORT__?: unknown }

const pageLocation = { origin: 'http://127.0.0.1:3080' }
const carrierLocation = { origin: 'dsh-app://app' }

afterEach(() => {
  delete g.__DSH_TRANSPORT__
  g.location = pageLocation
})

describe('websocketAuthority', () => {
  it('falls back to the page origin when the host publishes no carrier authority', () => {
    g.location = pageLocation
    expect(websocketAuthority()).toBe('http://127.0.0.1:3080')
  })

  it('prefers the loopback authority the desktop carrier publishes', () => {
    // The carrier's own origin cannot upgrade a WebSocket; the Desktop Host
    // publishes the authority its embedded webServer owns instead.
    g.location = carrierLocation
    g.__DSH_TRANSPORT__ = { webOrigin: 'http://127.0.0.1:3199' }
    expect(websocketAuthority()).toBe('http://127.0.0.1:3199')
  })

  it('ignores a published authority that is empty or not a string', () => {
    g.location = carrierLocation
    g.__DSH_TRANSPORT__ = { webOrigin: '' }
    expect(websocketAuthority()).toBe('dsh-app://app')
    g.__DSH_TRANSPORT__ = { webOrigin: 42 }
    expect(websocketAuthority()).toBe('dsh-app://app')
    g.__DSH_TRANSPORT__ = {}
    expect(websocketAuthority()).toBe('dsh-app://app')
  })
})
