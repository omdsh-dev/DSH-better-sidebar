/**
 * Desktop-shell page detection. The inlining branch must be selected only for
 * the official `dsh-app:` page; ordinary http(s) deployments (including a
 * reverse-proxied one) keep the route-src HTML preview.
 */
import { describe, expect, it } from 'vitest'
import { isDesktopShell } from '../src/client/desktop-env.ts'

describe('isDesktopShell', () => {
  it('is true for the desktop shell page origin', () => {
    expect(isDesktopShell('dsh-app://app/')).toBe(true)
    expect(isDesktopShell('dsh-app://app/sidebar/html/s1/p/a.html')).toBe(true)
  })

  it('is false for web deployments, proxy prefixes and empty/invalid bases', () => {
    expect(isDesktopShell('http://127.0.0.1:3080/')).toBe(false)
    expect(isDesktopShell('https://host.example.test/proxy/3080/')).toBe(false)
    expect(isDesktopShell('')).toBe(false)
    expect(isDesktopShell('not a url')).toBe(false)
  })
})
