/**
 * browser.probe helpers: the CSP frame-ancestors parser (host side) and the
 * embeddability verdict (client side). Together they turn the target's
 * response headers into the "refused to be embedded" explanation the
 * sidebar browser shows instead of the browser's cryptic blank frame.
 */
import { describe, expect, it } from 'vitest'
import { extractFrameAncestors } from '../src/browser-probe.ts'
import { embeddabilityOf } from '../src/client/browser.ts'

describe('extractFrameAncestors', () => {
  it('extracts a frame-ancestors source list from a CSP header', () => {
    expect(extractFrameAncestors("default-src 'self'; frame-ancestors 'none'"))
      .toEqual(["'none'"])
    expect(extractFrameAncestors("frame-ancestors 'self' https://example.com"))
      .toEqual(["'self'", 'https://example.com'])
    expect(extractFrameAncestors('frame-ancestors *')).toEqual(['*'])
  })

  it('is undefined when the directive is absent or empty', () => {
    expect(extractFrameAncestors(null)).toBeUndefined()
    expect(extractFrameAncestors("default-src 'self'")).toBeUndefined()
    expect(extractFrameAncestors('frame-ancestors')).toBeUndefined()
    expect(extractFrameAncestors('frame-ancestors ; default-src *')).toBeUndefined()
  })
})

describe('embeddabilityOf', () => {
  it('blocks X-Frame-Options DENY / SAMEORIGIN', () => {
    expect(embeddabilityOf({ reachable: true, status: 200, xFrameOptions: 'DENY' })).toBe('blocked')
    expect(embeddabilityOf({ reachable: true, status: 200, xFrameOptions: 'SAMEORIGIN' })).toBe('blocked')
    expect(embeddabilityOf({ reachable: true, status: 200, xFrameOptions: 'sameorigin' })).toBe('blocked')
  })

  it('blocks a frame-ancestors list that does not allow * ("self" means the SITE origin, never ours)', () => {
    expect(embeddabilityOf({ reachable: true, frameAncestors: ["'none'"] })).toBe('blocked')
    expect(embeddabilityOf({ reachable: true, frameAncestors: ["'self'"] })).toBe('blocked')
    expect(embeddabilityOf({ reachable: true, frameAncestors: ["'self'", 'https://x.dev'] })).toBe('blocked')
  })

  it('allows a wildcard frame-ancestors and absent anti-framing headers', () => {
    expect(embeddabilityOf({ reachable: true, status: 200, frameAncestors: ['*'] })).toBe('embeddable')
    expect(embeddabilityOf({ reachable: true, status: 200 })).toBe('embeddable')
    expect(embeddabilityOf({ reachable: true, status: 200, xFrameOptions: 'ALLOW-FROM https://x' })).toBe('embeddable')
  })

  it('is unknown when the target is unreachable (plain iframe stays)', () => {
    expect(embeddabilityOf({ reachable: false })).toBe('unknown')
  })
})
