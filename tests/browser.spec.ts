/**
 * Browser address-bar policy tests: only http(s) URLs may be navigated,
 * loopback addresses and the GUI's own origin are refused outright. The
 * iframe sandbox (opaque origin) is the primary security boundary; this
 * policy is the address-bar gate on top of it.
 */
import { describe, expect, it } from 'vitest'
import { isLoopbackHostname, normalizeBrowserUrl } from '../src/client/browser.ts'

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

  it('refuses loopback hostnames in every spelling', () => {
    for (const input of [
      'http://localhost/', 'https://localhost:3080/', 'http://LOCALHOST/',
      'http://127.0.0.1/', 'http://127.255.255.255/',
      'http://[::1]/', 'http://0.0.0.0/',
    ]) {
      expect(normalizeBrowserUrl(input, SELF), input).toEqual({ kind: 'blocked', reason: 'loopback' })
    }
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
    expect(normalizeBrowserUrl('http://127.0.0.1:9999/', SELF)).toEqual({ kind: 'blocked', reason: 'loopback' })
  })

  it('reports invalid input', () => {
    expect(normalizeBrowserUrl('', SELF)).toEqual({ kind: 'invalid' })
    expect(normalizeBrowserUrl('   ', SELF)).toEqual({ kind: 'invalid' })
    expect(normalizeBrowserUrl('ht tp://x', SELF)).toEqual({ kind: 'invalid' })
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
