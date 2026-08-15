/**
 * /sidebar/html route vocabulary tests: the path-encoded URL scheme must
 * round-trip absolute paths (POSIX and Windows), survive special characters,
 * and refuse malformed input — and crucially, a relative asset reference
 * resolved against an encoded document URL stays inside the same route with
 * the session scope intact (the WHY of the path-encoding design).
 */
import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { decodeHtmlUrl, encodeHtmlUrl } from '../src/html-route.ts'

describe('encodeHtmlUrl', () => {
  it('encodes a POSIX absolute path into route segments', () => {
    expect(encodeHtmlUrl('sess-1', '/Users/me/proj/index.html'))
      .toBe('/sidebar/html/sess-1/Users/me/proj/index.html')
  })

  it('encodes a Windows absolute path (drive colon percent-encoded)', () => {
    expect(encodeHtmlUrl('sess-1', 'C:\\Users\\me\\a.html'))
      .toBe('/sidebar/html/sess-1/C%3A/Users/me/a.html')
  })

  it('percent-encodes special characters in segments', () => {
    expect(encodeHtmlUrl('s-1', '/a b/中文/100%.html'))
      .toBe('/sidebar/html/s-1/a%20b/%E4%B8%AD%E6%96%87/100%25.html')
  })

  it('ignores leading/trailing slashes (files only)', () => {
    expect(encodeHtmlUrl('s', '/a//b/x.html')).toBe('/sidebar/html/s/a/b/x.html')
  })
})

describe('decodeHtmlUrl', () => {
  it('decodes a POSIX round-trip', () => {
    const url = encodeHtmlUrl('sess-1', '/Users/me/proj/index.html')
    expect(decodeHtmlUrl(url)).toEqual({
      ok: true,
      ref: { sessionId: 'sess-1', path: '/Users/me/proj/index.html' },
    })
  })

  it('decodes a Windows round-trip (drive path WITHOUT a leading slash, so node resolve() keeps the drive)', () => {
    const url = encodeHtmlUrl('sess-1', 'C:\\Users\\me\\a.html')
    expect(decodeHtmlUrl(url)).toEqual({
      ok: true,
      ref: { sessionId: 'sess-1', path: 'C:/Users/me/a.html' },
    })
    // The host runs requireAbsolute() over the decoded path: with the old
    // '/C:/...' form node's resolve() produced 'C:\C:\Users\...' (drive
    // doubled) on Windows and the isWithin(cwd) fence rejected every drive
    // path. The slash-free form must resolve back to the original path.
    if (process.platform === 'win32') {
      expect(resolve('C:/Users/me/a.html')).toBe('C:\\Users\\me\\a.html')
    }
  })

  it('decodes a lowercase-drive Windows path without a leading slash', () => {
    expect(decodeHtmlUrl('/sidebar/html/s/d%3A/work/x.html')).toEqual({
      ok: true,
      ref: { sessionId: 's', path: 'd:/work/x.html' },
    })
  })

  it('decodes special characters round-trip', () => {
    const url = encodeHtmlUrl('s-1', '/a b/中文/100%.html')
    const result = decodeHtmlUrl(url)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.ref.path).toBe('/a b/中文/100%.html')
  })

  it('refuses a wrong prefix (404)', () => {
    expect(decodeHtmlUrl('/sidebar/api/fs.read')).toEqual({
      ok: false, status: 404, message: 'not an html route',
    })
  })

  it('refuses an empty or double-slash path (400)', () => {
    expect(decodeHtmlUrl('/sidebar/html/').ok).toBe(false)
    expect(decodeHtmlUrl('/sidebar/html//s/a.html').ok).toBe(false)
  })

  it('refuses malformed percent encoding (400)', () => {
    expect(decodeHtmlUrl('/sidebar/html/s/%E0%A4%A').ok).toBe(false)
  })

  it('refuses a missing sessionId or file path (400)', () => {
    expect(decodeHtmlUrl('/sidebar/html//a.html')).toEqual({
      ok: false, status: 400, message: 'sessionId and file path are required',
    })
    expect(decodeHtmlUrl('/sidebar/html/s/')).toEqual({
      ok: false, status: 400, message: 'sessionId and file path are required',
    })
  })

  it('keeps encoded traversal segments for the isWithin fence to bound', () => {
    // The decoder is not a security boundary by itself: an encoded `..`
    // decodes to `..` and the HOST refuses it via requireAbsolute +
    // isWithin(cwd) (the decoded path resolves outside the cwd).
    const result = decodeHtmlUrl('/sidebar/html/s/Users/me/../../etc/passwd')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.ref.path).toBe('/Users/me/../../etc/passwd')
  })
})

describe('relative asset resolution stays in-route', () => {
  it('a relative reference against an encoded document URL keeps the session scope', () => {
    // WHATWG URL resolution drops the QUERY of a path-relative reference,
    // which is why the route is path-encoded: resolving ./style.css against
    // the document URL must land back on the same route with the same
    // session prefix.
    const doc = encodeHtmlUrl('sess-1', '/Users/me/proj/index.html')
    const asset = new URL('./style.css', `http://h${doc}`).pathname
    expect(asset).toBe('/sidebar/html/sess-1/Users/me/proj/style.css')
    expect(decodeHtmlUrl(asset)).toEqual({
      ok: true,
      ref: { sessionId: 'sess-1', path: '/Users/me/proj/style.css' },
    })
  })

  it('deeper and parent-relative references resolve inside the route', () => {
    const doc = `http://h${encodeHtmlUrl('s', '/a/b/index.html')}`
    expect(new URL('img/x.png', doc).pathname).toBe('/sidebar/html/s/a/b/img/x.png')
    expect(new URL('../c.css', doc).pathname).toBe('/sidebar/html/s/a/c.css')
  })
})
