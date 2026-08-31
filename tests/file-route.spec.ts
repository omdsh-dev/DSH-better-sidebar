/**
 * /sidebar/file response-header contract (mediaHeadersFor): the inline vs
 * download split. Inline responses are also navigated TOP-LEVEL — the editor
 * header's "open in browser" button opens the media URL in a real new
 * browser tab for the image/pdf viewers — so they must carry the CSP sandbox
 * boundary (opaque origin) that keeps a workspace SVG (an image-viewer ext)
 * from executing scripts same-origin with the GUI. The attachment branch
 * forces a save and needs no sandbox.
 */
import { describe, expect, it } from 'vitest'
import { MEDIA_INLINE_CSP, mediaHeadersFor, mediaTypeForPath } from '../src/index.ts'

describe('mediaHeadersFor', () => {
  it('serves inline responses with the sandbox boundary and no disposition', () => {
    const headers = mediaHeadersFor('/work/dir/icon.svg', false)
    expect(headers['content-type']).toBe('image/svg+xml')
    expect(headers['cache-control']).toBe('no-cache')
    expect(headers['content-disposition']).toBeUndefined()
    expect(headers['content-security-policy']).toBe(MEDIA_INLINE_CSP)
    expect(headers['content-security-policy']).toContain('sandbox')
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['referrer-policy']).toBe('no-referrer')
  })

  it('applies the boundary to every inline type (images/pdf included)', () => {
    for (const path of ['/a/b.png', '/a/b.pdf', '/a/b.html', '/a/b.zzz']) {
      expect(mediaHeadersFor(path, false)['content-security-policy'], path).toBe(MEDIA_INLINE_CSP)
    }
  })

  it('forces attachment with a UTF-8 filename on the download branch (no CSP)', () => {
    const headers = mediaHeadersFor('/work/dir/第1页_修正.png', true)
    expect(headers['content-disposition'])
      .toBe(`attachment; filename*=UTF-8''${encodeURIComponent('第1页_修正.png')}`)
    expect(headers['content-security-policy']).toBeUndefined()
    expect(headers['x-content-type-options']).toBeUndefined()
    expect(headers['referrer-policy']).toBeUndefined()
  })

  it('keeps mediaTypeForPath mappings with an octet-stream fallback', () => {
    expect(mediaTypeForPath('/a/b.png')).toBe('image/png')
    expect(mediaTypeForPath('/a/b.pdf')).toBe('application/pdf')
    expect(mediaTypeForPath('/a/b.zzz')).toBe('application/octet-stream')
  })
})
