/**
 * Client half of #618: the media / download / HTML URL builders must spell a
 * file path the way their host routes can read it.
 *
 * A native file tab is seeded with a `dsh-resource://file/session/<sid>/<path>`
 * address, whose in-workspace path is RELATIVE to the session root. Two things
 * follow, both asserted here:
 *
 * - `/sidebar/html` cannot express a relative path at all (the encoder drops a
 *   leading `/` and the decoder rebuilds an absolute path, so `docs/index.html`
 *   came back as `/docs/index.html`), so the client must resolve against the
 *   session cwd — this half is load-bearing for the HTML previewer;
 * - `/sidebar/file` reads an absolute path unchanged, and the host now joins a
 *   relative one onto the session cwd (see `tests/media-relative-path.spec.ts`),
 *   which keeps the media URL correct while the session summary is still
 *   hydrating and the client has no cwd yet.
 */
import { describe, expect, it } from 'vitest'
import { downloadUrl, htmlUrl, mediaUrl } from '../src/client/api.ts'

/** The `path` query parameter of a builder result. */
function pathParam(url: string): string {
  return new URL(url, 'http://dsh.internal').searchParams.get('path') ?? ''
}

describe('session-scoped media URLs resolve a native (relative) seed', () => {
  it('joins a workspace-relative path onto the session cwd', () => {
    const url = mediaUrl({ sessionId: 's1', cwd: '/home/me' }, 'chart.png')
    expect(pathParam(url)).toBe('/home/me/chart.png')
    expect(new URL(url, 'http://dsh.internal').searchParams.get('cwd')).toBe('/home/me')
  })

  it('resolves a nested relative path and keeps the download flag', () => {
    const url = downloadUrl({ sessionId: 's1', cwd: '/home/me' }, 'docs/img/inline.png')
    expect(pathParam(url)).toBe('/home/me/docs/img/inline.png')
    expect(new URL(url, 'http://dsh.internal').searchParams.get('download')).toBe('1')
  })

  it('leaves an absolute path untouched (absolute or outside the workspace)', () => {
    expect(pathParam(mediaUrl({ sessionId: 's1', cwd: '/home/me' }, '/home/me/chart.png'))).toBe('/home/me/chart.png')
    expect(pathParam(mediaUrl({ sessionId: 's1', cwd: '/home/me' }, '/elsewhere/x.png'))).toBe('/elsewhere/x.png')
  })

  it('joins with the cwd own separator style (Windows sessions)', () => {
    expect(pathParam(mediaUrl({ sessionId: 's1', cwd: 'C:\\work' }, 'chart.png'))).toBe('C:\\work\\chart.png')
  })

  it('passes the seed through unchanged while the session cwd is unknown', () => {
    // The host joins it onto the session's authoritative cwd; the client only
    // knows the summary, which hydrates a moment later.
    const url = mediaUrl({ sessionId: 's1' }, 'chart.png')
    expect(pathParam(url)).toBe('chart.png')
    expect(new URL(url, 'http://dsh.internal').searchParams.get('cwd')).toBeNull()
  })

  it('builds an HTML route URL the host decodes back to the absolute path', () => {
    expect(htmlUrl({ sessionId: 's1', cwd: '/home/me' }, 'docs/index.html')).toBe('/sidebar/html/s1/home/me/docs/index.html')
    // The same file spelled absolutely produces the same route.
    expect(htmlUrl({ sessionId: 's1', cwd: '/home/me' }, '/home/me/docs/index.html')).toBe('/sidebar/html/s1/home/me/docs/index.html')
  })

  it('never lets a cwd-less relative seed masquerade as a root-absolute one', () => {
    // Documented limitation of the pre-hydration window: without a cwd the
    // HTML route cannot know the session root (its grammar is absolute-only),
    // so the preview must wait for the summary rather than fetch `/docs/...`.
    expect(htmlUrl({ sessionId: 's1' }, 'docs/index.html')).toBe('/sidebar/html/s1/docs/index.html')
  })
})
