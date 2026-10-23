/**
 * Markdown-image vocabulary spec: the local destination → absolute target
 * resolution, the page-base media URL (browser AND desktop shell), and the
 * `pathImages` capability the preview surfaces hand the host renderer. The
 * desktop-shell case is the regression: an absolute http URL on the transport
 * origin is cross-site and the Connection fence answers 403, so only a
 * page-base `dsh-app://app/api/file` URL renders there (see markdown-images.ts).
 */
import { describe, expect, it } from 'vitest'
import {
  createMarkdownPathImages,
  desktopFileUrl,
  markdownImageTarget,
  markdownMediaUrl,
  resolveLocalMediaDest,
} from '../src/client/markdown-images.ts'
import type { SessionScope } from '../src/client/api.ts'

const ORIGIN = 'http://127.0.0.1:3080'
/** The desktop shell's page origin; the Host itself listens elsewhere. */
const APP = 'dsh-app://app/'
const scope: SessionScope = { sessionId: 'abc', cwd: '/repo' }

describe('markdownImageTarget', () => {
  it('resolves relative destinations against the opened file directory', () => {
    expect(markdownImageTarget('./img.png', '/repo/docs/readme.md')).toBe('/repo/docs/img.png')
    expect(markdownImageTarget('images/b.jpg', '/repo/docs/readme.md')).toBe('/repo/docs/images/b.jpg')
  })

  it('normalizes `.`/`..` segments', () => {
    expect(markdownImageTarget('./img.png', '/repo/docs/sub/readme.md')).toBe('/repo/docs/sub/img.png')
    expect(markdownImageTarget('../assets/b.png', '/repo/docs/sub/readme.md')).toBe('/repo/docs/assets/b.png')
  })

  it('passes absolute local paths through', () => {
    expect(markdownImageTarget('/repo/assets/b.png', '/repo/docs/readme.md')).toBe('/repo/assets/b.png')
    expect(markdownImageTarget('~/pics/a.png', '/repo/docs/readme.md')).toBe('~/pics/a.png')
  })

  it('handles windows absolute and UNC paths as local', () => {
    expect(markdownImageTarget('C:\\repo\\img.png', 'C:\\repo\\docs\\readme.md')).toBe('C:\\repo\\img.png')
    expect(markdownImageTarget('//server/share/a.png', '/repo/docs/readme.md')).toBeUndefined()
  })

  it('refuses everything the host renderer would not pass to the delegate', () => {
    expect(markdownImageTarget('', '/repo/readme.md')).toBeUndefined()
    expect(markdownImageTarget('#section', '/repo/readme.md')).toBeUndefined()
    expect(markdownImageTarget('https://example.com/x.png', '/repo/readme.md')).toBeUndefined()
    expect(markdownImageTarget('data:image/png;base64,AAA', '/repo/readme.md')).toBeUndefined()
    expect(markdownImageTarget('./img.png?v=1', '/repo/readme.md')).toBeUndefined()
  })
})

describe('markdownMediaUrl', () => {
  it('builds a same-origin media URL on the page base (browser)', () => {
    expect(markdownMediaUrl('/repo/docs/img.png', scope, ORIGIN)).toBe(
      'http://127.0.0.1:3080/sidebar/file?sessionId=abc&path=%2Frepo%2Fdocs%2Fimg.png&cwd=%2Frepo',
    )
  })

  it('keeps a reverse-proxy directory prefix', () => {
    expect(markdownMediaUrl('/repo/img.png', scope, 'https://host.example.test/proxy/3080/')).toBe(
      'https://host.example.test/proxy/3080/sidebar/file?sessionId=abc&path=%2Frepo%2Fimg.png&cwd=%2Frepo',
    )
  })

  it('stays on the desktop shell page origin instead of the transport origin', () => {
    // Regression: resolving against `__DSH_TRANSPORT__.streamBaseUrl`
    // (`http://127.0.0.1:<port>`) produced a cross-site request from this page
    // and the Connection fence answered 403, so every local image fell back to
    // its alt text.
    expect(markdownMediaUrl('/repo/docs/img.png', scope, APP)).toBe(
      'dsh-app://app/sidebar/file?sessionId=abc&path=%2Frepo%2Fdocs%2Fimg.png&cwd=%2Frepo',
    )
  })

  it('drops the cwd param when the scope has no cwd', () => {
    const url = markdownMediaUrl('/repo/img.png', { sessionId: 'abc' }, ORIGIN)
    expect(url).toBe('http://127.0.0.1:3080/sidebar/file?sessionId=abc&path=%2Frepo%2Fimg.png')
    expect(url).not.toContain('cwd=')
  })
})

describe('desktopFileUrl', () => {
  it('builds the host file URL on the dsh-app page origin', () => {
    expect(desktopFileUrl('/repo/a.png', APP)).toBe('dsh-app://app/api/file?path=%2Frepo%2Fa.png')
  })

  it('keeps a reverse-proxy prefix under an http(s) page base', () => {
    expect(desktopFileUrl('/repo/a.png', 'https://host.example.test/proxy/3080/')).toBe(
      'https://host.example.test/proxy/3080/api/file?path=%2Frepo%2Fa.png',
    )
  })
})

describe('createMarkdownPathImages', () => {
  it('maps local destinations to the plugin media route on the browser page base', () => {
    const images = createMarkdownPathImages(scope, '/repo/docs/readme.md', ORIGIN)
    expect(images.resolve('./img.png')).toBe(
      'http://127.0.0.1:3080/sidebar/file?sessionId=abc&path=%2Frepo%2Fdocs%2Fimg.png&cwd=%2Frepo',
    )
    expect(images.resolve('../x.png')).toBe(
      'http://127.0.0.1:3080/sidebar/file?sessionId=abc&path=%2Frepo%2Fx.png&cwd=%2Frepo',
    )
  })

  it('maps local destinations to the authenticated host file route on the desktop page base', () => {
    // The renderer's image vocabulary accepts exactly one local-file shape from
    // the dsh-app:// page (`dsh-app://app/api/file?...`); the shell forwards it
    // to the Host with the launch cookie.
    const images = createMarkdownPathImages(scope, '/repo/docs/readme.md', APP)
    expect(images.resolve('./img.png')).toBe(
      'dsh-app://app/api/file?path=%2Frepo%2Fdocs%2Fimg.png',
    )
    expect(images.resolve('./img.png')).not.toContain('/sidebar/file')
  })

  it('makes a relative tab path absolute for the desktop host file route', () => {
    // An editor tab opened from a chat address can carry a workspace-RELATIVE
    // path (`openwrt-proxy-primer/PRINCIPLES.md`). The plugin media route
    // resolves that together with `cwd`, but the host `api/file` route answers
    // 400 "absolute path required" — so the desktop branch joins the session
    // workspace root first.
    const images = createMarkdownPathImages(scope, 'docs/readme.md', APP)
    expect(images.resolve('./img.png')).toBe(
      'dsh-app://app/api/file?path=%2Frepo%2Fdocs%2Fimg.png',
    )
    expect(images.resolve('images/b.png')).toBe(
      'dsh-app://app/api/file?path=%2Frepo%2Fdocs%2Fimages%2Fb.png',
    )
  })

  it('falls back without a workspace root when the tab path is relative (desktop)', () => {
    const images = createMarkdownPathImages({ sessionId: 'abc' }, 'docs/readme.md', APP)
    expect(images.resolve('./img.png')).toBeUndefined()
  })

  it('keeps the relative spelling with a cwd on the browser page base', () => {
    // The plugin media route resolves a relative target against `cwd`, so the
    // browser branch does not have to normalize it (the desktop host route
    // does — see the case above).
    const images = createMarkdownPathImages(scope, 'docs/readme.md', ORIGIN)
    expect(images.resolve('./img.png')).toBe(
      'http://127.0.0.1:3080/sidebar/file?sessionId=abc&path=docs%2Fimg.png&cwd=%2Frepo',
    )
  })

  it('decodes one authored percent-escape before resolving', () => {
    const images = createMarkdownPathImages(scope, '/repo/docs/readme.md', ORIGIN)
    expect(images.resolve('./my%20image.png')).toBe(
      'http://127.0.0.1:3080/sidebar/file?sessionId=abc&path=%2Frepo%2Fdocs%2Fmy+image.png&cwd=%2Frepo',
    )
    expect(images.resolve('./bad%E0%A4%A.png')).toBeUndefined()
  })

  it('answers undefined for destinations it cannot serve (alt-text fallback)', () => {
    const images = createMarkdownPathImages(scope, '/repo/docs/readme.md', ORIGIN)
    expect(images.resolve('https://example.com/x.png')).toBeUndefined()
    expect(images.resolve('')).toBeUndefined()
    expect(images.resolve('#anchor')).toBeUndefined()
  })
})

describe('resolveLocalMediaDest (raw HTML leaves)', () => {
  it('rewrites local sources on the page base', () => {
    expect(resolveLocalMediaDest('./shot.png', scope, '/repo/docs/readme.md', ORIGIN)).toBe(
      'http://127.0.0.1:3080/sidebar/file?sessionId=abc&path=%2Frepo%2Fdocs%2Fshot.png&cwd=%2Frepo',
    )
  })

  it('rewrites local sources on the desktop shell page origin', () => {
    // Raw HTML <img> is plain DOM, so the same-origin plugin media route works
    // (the markdown-syntax vocabulary above needs the host file route instead).
    expect(resolveLocalMediaDest('./shot.png', scope, '/repo/docs/readme.md', APP)).toBe(
      'dsh-app://app/sidebar/file?sessionId=abc&path=%2Frepo%2Fdocs%2Fshot.png&cwd=%2Frepo',
    )
  })

  it('decodes one percent-escape from the authored src', () => {
    expect(resolveLocalMediaDest('./my%20shot.png', scope, '/repo/docs/readme.md', ORIGIN)).toBe(
      'http://127.0.0.1:3080/sidebar/file?sessionId=abc&path=%2Frepo%2Fdocs%2Fmy+shot.png&cwd=%2Frepo',
    )
  })

  it('leaves remote, anchor and empty sources untouched', () => {
    expect(resolveLocalMediaDest('https://example.com/x.png', scope, '/repo/readme.md', ORIGIN))
      .toBe('https://example.com/x.png')
    expect(resolveLocalMediaDest('#anchor', scope, '/repo/readme.md', ORIGIN)).toBe('#anchor')
    expect(resolveLocalMediaDest('', scope, '/repo/readme.md', ORIGIN)).toBe('')
  })
})
