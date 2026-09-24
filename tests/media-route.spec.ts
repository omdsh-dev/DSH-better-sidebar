/**
 * Media-route contract: the extension → content-type table (images, PDF,
 * video), the video extension set that unlocks `videoLimit` + byte-range
 * streaming, and the `Range` / `If-Range` resolution the `/sidebar/file`
 * handler feeds straight into its 200 / 206 / 416 decision.
 *
 * These live in a pure module (src/media-route.ts) precisely so the
 * byte-range edge cases — suffix ranges, clamping, unsatisfiable starts,
 * multi-range headers, malformed units — are pinned without booting a
 * server. The route itself is exercised end-to-end by the mount lane.
 */
import { describe, expect, it } from 'vitest'
import {
  contentRangeHeader,
  headerValue,
  ifRangeMatches,
  isVideoPath,
  mediaETag,
  mediaTypeForPath,
  parseRangeHeader,
  unsatisfiedContentRange,
} from '../src/media-route.ts'

describe('mediaTypeForPath', () => {
  it('carries the image / PDF types it always had', () => {
    expect(mediaTypeForPath('/work/shot.PNG')).toBe('image/png')
    expect(mediaTypeForPath('/work/shot.jpeg')).toBe('image/jpeg')
    expect(mediaTypeForPath('/work/report.pdf')).toBe('application/pdf')
  })

  it('serves the video containers the viewer claims', () => {
    expect(mediaTypeForPath('/work/clip.mp4')).toBe('video/mp4')
    expect(mediaTypeForPath('/work/clip.M4V')).toBe('video/mp4')
    expect(mediaTypeForPath('/work/clip.webm')).toBe('video/webm')
    expect(mediaTypeForPath('/work/clip.mov')).toBe('video/quicktime')
    expect(mediaTypeForPath('/work/clip.mkv')).toBe('video/x-matroska')
    expect(mediaTypeForPath('/work/clip.avi')).toBe('video/x-msvideo')
  })

  it('falls back to the binary-safe type for unknowns', () => {
    expect(mediaTypeForPath('/work/archive.bin')).toBe('application/octet-stream')
  })
})

describe('isVideoPath', () => {
  it('recognizes every container the built-in video viewer lists', () => {
    for (const path of ['a.mp4', 'a.webm', 'a.MKV', 'a.mov', 'a.3gp', 'a.m2ts']) {
      expect(isVideoPath(path), path).toBe(true)
    }
  })

  it('leaves images, PDFs and documents on the ordinary media cap', () => {
    for (const path of ['a.png', 'a.pdf', 'a.md', 'a.txt', 'a.mp3']) {
      expect(isVideoPath(path), path).toBe(false)
    }
  })
})

describe('headerValue', () => {
  it('unwraps the array Node folds duplicate headers into', () => {
    expect(headerValue('bytes=0-1')).toBe('bytes=0-1')
    expect(headerValue(['bytes=0-1', 'bytes=5-6'])).toBe('bytes=0-1')
    expect(headerValue(undefined)).toBeUndefined()
  })
})

describe('parseRangeHeader', () => {
  const SIZE = 1000

  it('serves the whole resource without a header', () => {
    expect(parseRangeHeader(undefined, SIZE)).toEqual({ kind: 'full' })
  })

  it('honours a closed range', () => {
    expect(parseRangeHeader('bytes=0-99', SIZE)).toEqual({ kind: 'partial', range: { start: 0, end: 99 } })
    expect(parseRangeHeader('bytes=500-999', SIZE)).toEqual({ kind: 'partial', range: { start: 500, end: 999 } })
  })

  it('clamps an end past the last byte', () => {
    expect(parseRangeHeader('bytes=900-5000', SIZE)).toEqual({ kind: 'partial', range: { start: 900, end: 999 } })
  })

  it('treats an open end as "to the last byte"', () => {
    expect(parseRangeHeader('bytes=250-', SIZE)).toEqual({ kind: 'partial', range: { start: 250, end: 999 } })
  })

  it('resolves a suffix range against the size', () => {
    expect(parseRangeHeader('bytes=-100', SIZE)).toEqual({ kind: 'partial', range: { start: 900, end: 999 } })
    // A suffix larger than the file is the whole file, not an error.
    expect(parseRangeHeader('bytes=-4000', SIZE)).toEqual({ kind: 'partial', range: { start: 0, end: 999 } })
  })

  it('is case-insensitive about the unit', () => {
    expect(parseRangeHeader('Bytes=0-9', SIZE)).toEqual({ kind: 'partial', range: { start: 0, end: 9 } })
  })

  it('rejects a start at or past the end with 416 semantics', () => {
    expect(parseRangeHeader('bytes=1000-', SIZE)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRangeHeader('bytes=1000-2000', SIZE)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRangeHeader('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable' })
  })

  it('ignores a header that is not a byte range (full response, per RFC)', () => {
    expect(parseRangeHeader('items=0-3', SIZE)).toEqual({ kind: 'full' })
    expect(parseRangeHeader('bytes=abc', SIZE)).toEqual({ kind: 'full' })
    expect(parseRangeHeader('bytes=', SIZE)).toEqual({ kind: 'full' })
    // last-byte-pos < first-byte-pos is an invalid spec → the header is ignored.
    expect(parseRangeHeader('bytes=5-2', SIZE)).toEqual({ kind: 'full' })
  })

  it('serves the first satisfiable range of a multi-range header', () => {
    expect(parseRangeHeader('bytes=0-9,20-29', SIZE)).toEqual({ kind: 'partial', range: { start: 0, end: 9 } })
    expect(parseRangeHeader('bytes=2000-3000,10-19', SIZE)).toEqual({ kind: 'partial', range: { start: 10, end: 19 } })
  })

  it('is unsatisfiable when every well-formed spec misses the resource', () => {
    expect(parseRangeHeader('bytes=2000-3000,4000-5000', SIZE)).toEqual({ kind: 'unsatisfiable' })
  })

  it('cannot satisfy any range of an empty resource', () => {
    expect(parseRangeHeader('bytes=0-0', 0)).toEqual({ kind: 'unsatisfiable' })
  })
})

describe('range response headers', () => {
  it('formats Content-Range for 206 and 416', () => {
    expect(contentRangeHeader({ start: 200, end: 399 }, 1000)).toBe('bytes 200-399/1000')
    expect(unsatisfiedContentRange(1000)).toBe('bytes */1000')
  })

  it('derives a stable entity tag from size + mtime', () => {
    expect(mediaETag(1000, 1_700_000_000_123)).toBe('"1000-1700000000123"')
    expect(mediaETag(1000, 1_700_000_000_123)).toBe(mediaETag(1000, 1_700_000_000_123.9))
    expect(mediaETag(1001, 1_700_000_000_123)).not.toBe(mediaETag(1000, 1_700_000_000_123))
  })
})

describe('ifRangeMatches', () => {
  const ETAG = '"1000-1700000000123"'
  const LAST_MODIFIED = 'Tue, 14 Nov 2023 22:13:20 GMT'

  it('passes when the guard is absent or empty', () => {
    expect(ifRangeMatches(undefined, ETAG, LAST_MODIFIED)).toBe(true)
    expect(ifRangeMatches('   ', ETAG, LAST_MODIFIED)).toBe(true)
  })

  it('compares an entity tag verbatim', () => {
    expect(ifRangeMatches(ETAG, ETAG, LAST_MODIFIED)).toBe(true)
    expect(ifRangeMatches('"999-1"', ETAG, LAST_MODIFIED)).toBe(false)
  })

  it('compares a date guard against the advertised Last-Modified', () => {
    expect(ifRangeMatches(LAST_MODIFIED, ETAG, LAST_MODIFIED)).toBe(true)
    expect(ifRangeMatches('Tue, 14 Nov 2023 22:13:21 GMT', ETAG, LAST_MODIFIED)).toBe(false)
  })
})
