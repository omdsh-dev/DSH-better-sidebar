/**
 * Browser address-bar policy tests: only http(s) URLs may be navigated,
 * loopback addresses need explicit user trust. The GUI's own origin stays
 * available for debugging. The
 * iframe sandbox (opaque origin) is the primary security boundary; this
 * policy is the address-bar gate on top of it.
 */
import { describe, expect, it } from 'vitest'
import {
  addAllowedLoopbackUrl,
  isAllowedLoopbackUrl,
  isLoopbackHostname,
  loopbackAuthorityOf,
  normalizeBrowserUrl,
  parseLoopbackAllowlist,
} from '../src/client/browser.ts'

const SELF = 'http://127.0.0.1:3080'

describe('normalizeBrowserUrl', () => {
  it('normalizes a bare domain to https', () => {
    expect(normalizeBrowserUrl('example.com', SELF)).toEqual({ kind: 'ok', url: 'https://example.com/' })
  })

  it('normalizes a host with a port to https', () => {
    expect(normalizeBrowserUrl('example.com:8080/path', SELF)).toEqual({ kind: 'ok', url: 'https://example.com:8080/path' })
  })

  it('keeps an explicit http:// scheme', () => {
    expect(normalizeBrowserUrl('http://example.com/a?b=1', SELF)).toEqual({ kind: 'ok', url: 'http://example.com/a?b=1' })
  })

  it('accepts a non-loopback IP literal', () => {
    expect(normalizeBrowserUrl('https://8.8.8.8/dns', SELF)?.kind).toBe('ok')
  })

  it('refuses non-http(s) schemes', () => {
    expect(normalizeBrowserUrl('javascript:alert(1)', SELF)).toEqual({ kind: 'blocked', reason: 'scheme' })
    expect(normalizeBrowserUrl('data:text/html,<b>x</b>', SELF)).toEqual({ kind: 'blocked', reason: 'scheme' })
    expect(normalizeBrowserUrl('file:///etc/passwd', SELF)).toEqual({ kind: 'blocked', reason: 'scheme' })
    expect(normalizeBrowserUrl('about:blank', SELF)).toEqual({ kind: 'blocked', reason: 'scheme' })
  })

  it('returns the exact authority needed to trust each loopback URL', () => {
    for (const input of [
      'http://localhost/', 'https://localhost:3080/', 'http://LOCALHOST/',
      'http://127.0.0.1/', 'http://127.255.255.255/',
      'http://[::1]/', 'http://0.0.0.0/',
    ]) {
      const result = normalizeBrowserUrl(input, SELF)
      expect(result.kind, input).toBe('blocked')
      if (result.kind === 'blocked') expect(result.reason, input).toBe('loopback')
      if (result.kind === 'blocked' && result.reason === 'loopback') {
        expect(result.url, input).toMatch(/^https?:\/\//)
        expect(result.authority, input).toMatch(/:\d+$/)
      }
    }
  })

  it('treats bare loopback host and port as HTTP for local dev servers', () => {
    expect(normalizeBrowserUrl('localhost:5173/app', SELF)).toEqual({
      kind: 'blocked',
      reason: 'loopback',
      url: 'http://localhost:5173/app',
      authority: 'localhost:5173',
    })
  })

  it('allows only an explicitly trusted local authority', () => {
    expect(normalizeBrowserUrl('localhost:5173', SELF, 'localhost:5173')).toEqual({
      kind: 'ok',
      url: 'http://localhost:5173/',
    })
    expect(normalizeBrowserUrl('localhost:5174', SELF, 'localhost:5173')).toEqual({
      kind: 'blocked',
      reason: 'loopback',
      url: 'http://localhost:5174/',
      authority: 'localhost:5174',
    })
  })

  it('allows the GUI\'s own origin (the sandbox keeps it opaque like any site)', () => {
    // The user may browse the GUI itself in the sidebar; its host is
    // loopback, so the self check must win BEFORE the loopback gate.
    expect(normalizeBrowserUrl('http://127.0.0.1:3080/sidebar', SELF)).toEqual({
      kind: 'ok', url: 'http://127.0.0.1:3080/sidebar',
    })
    expect(normalizeBrowserUrl('http://127.0.0.1:3080/', SELF)).toEqual({
      kind: 'ok', url: 'http://127.0.0.1:3080/',
    })
    // A different port of the same loopback host is NOT the GUI origin and
    // stays blocked.
    expect(normalizeBrowserUrl('http://127.0.0.1:9999/', SELF)).toEqual({
      kind: 'blocked',
      reason: 'loopback',
      url: 'http://127.0.0.1:9999/',
      authority: '127.0.0.1:9999',
    })
  })

  it('reports invalid input', () => {
    expect(normalizeBrowserUrl('', SELF)).toEqual({ kind: 'invalid' })
    expect(normalizeBrowserUrl('   ', SELF)).toEqual({ kind: 'invalid' })
    expect(normalizeBrowserUrl('ht tp://x', SELF)).toEqual({ kind: 'invalid' })
  })
})

describe('loopback allowlist', () => {
  it('keeps bare hosts as all-port entries and host:port entries exact', () => {
    const matches = parseLoopbackAllowlist('localhost, 127.0.0.1:5173')
    expect(matches('localhost', '3000')).toBe(true)
    expect(matches('127.0.0.1', '5173')).toBe(true)
    expect(matches('127.0.0.1', '5174')).toBe(false)
  })

  it('matches bracketed IPv6 entries and explicit default ports', () => {
    expect(parseLoopbackAllowlist('[::1]:5173')('[::1]', '5173')).toBe(true)
    expect(parseLoopbackAllowlist('[::1]:5173')('[::1]', '5174')).toBe(false)
    expect(isAllowedLoopbackUrl('http://localhost/', 'localhost:80')).toBe(true)
    expect(isAllowedLoopbackUrl('https://localhost/', 'localhost:443')).toBe(true)
  })

  it('adds only the exact authority and does not duplicate an existing grant', () => {
    expect(loopbackAuthorityOf('http://[::1]:4173/')).toBe('[::1]:4173')
    expect(addAllowedLoopbackUrl('', 'http://localhost:5173/')).toBe('localhost:5173')
    expect(addAllowedLoopbackUrl('127.0.0.1:8080', 'http://localhost:5173/'))
      .toBe('127.0.0.1:8080, localhost:5173')
    expect(addAllowedLoopbackUrl('localhost', 'http://localhost:5173/')).toBe('localhost')
  })
})

describe('isLoopbackHostname', () => {
  it('flags localhost, IPv6 loopback, and the 127/8 block', () => {
    expect(isLoopbackHostname('localhost')).toBe(true)
    expect(isLoopbackHostname('::1')).toBe(true)
    expect(isLoopbackHostname('[::1]')).toBe(true)
    expect(isLoopbackHostname('127.0.0.1')).toBe(true)
    expect(isLoopbackHostname('127.8.9.10')).toBe(true)
    expect(isLoopbackHostname('0.0.0.0')).toBe(true)
    expect(isLoopbackHostname('example.com')).toBe(false)
    expect(isLoopbackHostname('128.0.0.1')).toBe(false)
    expect(isLoopbackHostname('192.168.1.1')).toBe(false)
  })
})
