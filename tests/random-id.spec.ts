/**
 * `randomId` in an insecure context (plain http to a non-loopback host), where
 * `crypto.randomUUID` is undefined — the side-chat tab factory crashed there
 * (measured 26/09/2026 on http://dsh017.tracy.test:51790).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomId } from '../src/client/random-id.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('randomId', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('uses crypto.randomUUID when the context offers it', () => {
    expect(randomId()).toMatch(UUID)
  })

  it('makes a v4-shaped id from getRandomValues when randomUUID is missing', () => {
    const real = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) })
    const a = randomId()
    const b = randomId()
    expect(a).toMatch(UUID)
    expect(a).not.toBe(b)
  })

  it('still answers with no Web Crypto at all', () => {
    vi.stubGlobal('crypto', undefined)
    expect(randomId()).toMatch(/^[0-9a-z]+$/)
  })
})
