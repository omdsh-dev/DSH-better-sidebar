/**
 * Desktop HTML preview inliner tests: resources inside the previewed file's
 * own folder become data URLs or inline blocks, external/data/file references
 * stay authored, failures leave the original, imports resolve relative to
 * their stylesheet, and the returned document is UTF-8 with the object-src
 * defense. Nothing outside that folder is ever fetched: not a `..` walk (plain
 * or encoded), not another session's route, not `/sidebar/file` or any other
 * same-origin endpoint, and an authored `<base>` does not widen the folder.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { bytesToBase64, inlineableUrl, inlineHtmlDocument, insidePreviewFolder, type InlineResource } from '../src/client/html-preview-inline.ts'

const DOC = 'dsh-app://app/sidebar/html/s1/p/docs/index.html'

/** One fetched text resource. */
function text(body: string, mediaType: string): InlineResource {
  return { bytes: new TextEncoder().encode(body), mediaType }
}

/** One fetched binary resource. */
function binary(bytes: number[], mediaType: string): InlineResource {
  return { bytes: Uint8Array.from(bytes), mediaType }
}

/** A fetch map that records every URL asked for. */
function fetcher(entries: Record<string, InlineResource>) {
  const calls: string[] = []
  const fetchResource = async (url: string): Promise<InlineResource | undefined> => {
    calls.push(url)
    await Promise.resolve()
    return entries[url]
  }
  return { calls, fetchResource }
}

describe('inlineableUrl', () => {
  it('accepts same-origin local paths and rejects external / non-inline schemes', () => {
    expect(inlineableUrl('img/a.png', DOC)?.href).toBe('dsh-app://app/sidebar/html/s1/p/docs/img/a.png')
    expect(inlineableUrl('../a.css', DOC)?.href).toBe('dsh-app://app/sidebar/html/s1/p/a.css')
    expect(inlineableUrl('https://example.com/x.png', DOC)).toBeUndefined()
    expect(inlineableUrl('data:image/png;base64,AAA', DOC)).toBeUndefined()
    expect(inlineableUrl('file:///etc/x.png', DOC)).toBeUndefined()
    expect(inlineableUrl('#anchor', DOC)).toBeUndefined()
  })
})

describe('insidePreviewFolder', () => {
  /** Resolve `reference` against DOC, then ask the folder question. */
  const inside = (reference: string, documentUrl = DOC): boolean =>
    insidePreviewFolder(new URL(reference, documentUrl).href, documentUrl)

  it('accepts the previewed file\'s folder and its subfolders', () => {
    expect(inside('img/a.png')).toBe(true)
    expect(inside('./style.css')).toBe(true)
    expect(inside('img/a.png?v=2#x')).toBe(true)
    expect(inside('图片/a b.png')).toBe(true)
    expect(inside('/sidebar/html/s1/p/docs/img/a.png')).toBe(true)
    expect(inside('img/a.png', 'dsh-app://app/sidebar/html/s1/C%3A/Users/me/site/index.html')).toBe(true)
    expect(inside('a.png', 'dsh-app://app/sidebar/html/s1//server/share/site/index.html')).toBe(true)
  })

  it('rejects a walk out of the folder, plain or encoded', () => {
    expect(inside('../a.css')).toBe(false)
    expect(inside('%2e%2e/a.css')).toBe(false)
    expect(inside('../../../../x')).toBe(false)
    expect(inside('sub%2F..%2F..%2Fx')).toBe(false)
    expect(inside('sub%2f..%2f..%2fx')).toBe(false)
    expect(inside('sub%5C..%5C..%5Cx')).toBe(false)
    expect(inside(`sub${String.fromCharCode(92)}..${String.fromCharCode(92)}x`)).toBe(false)
    expect(inside('../a.png', 'dsh-app://app/sidebar/html/s1//server/share/site/index.html')).toBe(false)
  })

  it('rejects other same-origin routes and other sessions', () => {
    expect(inside('/sidebar/file?sessionId=s1&path=%2Fp%2Fdocs%2Fa.png')).toBe(false)
    expect(inside('/sidebar/api/fs/read?path=%2Fp%2Fdocs%2Fa.png')).toBe(false)
    expect(inside('/sidebar/html/s2/p/docs/a.png')).toBe(false)
    expect(inside('/sidebar/html/s1/~/a.png')).toBe(false)
  })

  it('rejects the folder itself, empty segments, other origins and malformed input', () => {
    expect(inside('./')).toBe(false)
    expect(inside('img//a.png')).toBe(false)
    expect(insidePreviewFolder('https://example.com/sidebar/html/s1/p/docs/a.png', DOC)).toBe(false)
    expect(insidePreviewFolder('not a url', DOC)).toBe(false)
    expect(insidePreviewFolder(new URL('bad%E0.png', DOC).href, DOC)).toBe(false)
  })

  it('fails closed when the document is not an html route', () => {
    const file = 'dsh-app://app/sidebar/file?sessionId=s1&path=%2Fp%2Fdocs%2Findex.html'
    expect(insidePreviewFolder('dsh-app://app/sidebar/a.png', file)).toBe(false)
    expect(insidePreviewFolder('dsh-app://app/sidebar/html/a.png', 'dsh-app://app/sidebar/html/index.html')).toBe(false)
  })
})

describe('bytesToBase64', () => {
  it('encodes a byte array', () => {
    expect(bytesToBase64(Uint8Array.from([1, 2, 255]))).toBe('AQL/')
  })
})

describe('inlineHtmlDocument', () => {
  it('inlines local images, srcset, poster, stylesheets, CSS imports/url() and scripts', async () => {
    const entries: Record<string, InlineResource> = {
      'dsh-app://app/sidebar/html/s1/p/docs/style.css': text('@import "more.css"; .x{background:url("../img/bg.png")}', 'text/css'),
      'dsh-app://app/sidebar/html/s1/p/docs/more.css': text('@font-face{src:url(font.woff2)}', 'text/css'),
      'dsh-app://app/sidebar/html/s1/p/docs/font.woff2': binary([3, 4], 'font/woff2'),
      'dsh-app://app/sidebar/html/s1/p/img/bg.png': binary([5], 'image/png'),
      'dsh-app://app/sidebar/html/s1/p/docs/img/a.png': binary([7], 'image/png'),
      'dsh-app://app/sidebar/html/s1/p/docs/img/b.png': binary([8], 'image/png'),
      'dsh-app://app/sidebar/html/s1/p/docs/bg.png': binary([9], 'image/png'),
      'dsh-app://app/sidebar/html/s1/p/docs/inline.png': binary([10], 'image/png'),
      'dsh-app://app/sidebar/html/s1/p/docs/app.js': text('console.log("</script>")', 'text/javascript'),
    }
    const { calls, fetchResource } = fetcher(entries)
    const html = [
      '<!doctype html><html><head>',
      '<base href="./">',
      '<link rel="stylesheet" href="style.css" media="screen">',
      "<style>.inline{background:url('./inline.png')}</style>",
      '</head><body style="background:url(bg.png)">',
      '<img src="img/a.png" srcset="img/a.png 1x, img/b.png 2x">',
      '<video poster="img/a.png"></video>',
      '<script src="app.js"></script>',
      '<img src="https://example.com/x.png">',
      '<img src="data:image/png;base64,AAA">',
      '<img src="file:///etc/x.png">',
      '</body></html>',
    ].join('')
    const out = await inlineHtmlDocument(html, DOC, fetchResource)

    expect(out).toContain('data:image/png;base64,Bw==')
    expect(out).toContain('data:image/png;base64,CA==')
    expect(out).toContain('data:image/png;base64,CQ==')
    expect(out).toContain('data:image/png;base64,Cg==')
    expect(out).toContain('data:font/woff2;base64,AwQ=')
    expect(out).not.toContain('href="style.css"')
    expect(out).not.toContain('@import')
    expect(out).toContain('console.log')
    expect(out).toContain('<\\/script>')
    expect(out).not.toContain('src="app.js"')
    expect(out).toContain('https://example.com/x.png')
    expect(out).toContain('data:image/png;base64,AAA')
    expect(out).toContain('file:///etc/x.png')
    expect(out).toContain('<meta charset="utf-8">')
    expect(out).toContain('object-src')
    // The same image URL used by src, srcset and poster is fetched once.
    expect(calls.filter(url => url.endsWith('/img/a.png'))).toHaveLength(1)
    // style.css's ../img/bg.png lies outside the previewed folder (docs/):
    // never fetched, the authored url() stays.
    expect(calls).not.toContain('dsh-app://app/sidebar/html/s1/p/img/bg.png')
    expect(out).toContain('../img/bg.png')
  })

  it('never fetches a resource outside the previewed file\'s folder', async () => {
    const outside: Record<string, InlineResource> = {
      'dsh-app://app/sidebar/html/s1/p/up.png': binary([1], 'image/png'),
      'dsh-app://app/sidebar/html/s1/x.css': text('.x{color:red}', 'text/css'),
      'dsh-app://app/sidebar/html/s1/p/docs/sub%2F..%2F..%2Fx.js': text('leak()', 'text/javascript'),
      'dsh-app://app/sidebar/html/s1/p/y.css': text('.y{color:red}', 'text/css'),
      'dsh-app://app/sidebar/file?path=%2Fp%2Fz': binary([2], 'image/png'),
      'dsh-app://app/sidebar/file?sessionId=s1&path=%2Fp%2Fsecret': binary([3], 'image/png'),
      'dsh-app://app/sidebar/html/s2/p/docs/a.png': binary([4], 'image/png'),
    }
    const entries: Record<string, InlineResource> = {
      ...outside,
      'dsh-app://app/sidebar/html/s1/p/docs/img/ok.png': binary([7], 'image/png'),
      'dsh-app://app/sidebar/html/s1/p/docs/css/site.css': text('.a{background:url(../img/ok.png)} .b{background:url(../../up.png)}', 'text/css'),
    }
    const { calls, fetchResource } = fetcher(entries)
    const html = [
      '<!doctype html><html><head>',
      '<link rel="stylesheet" href="../../x.css">',
      '<link rel="stylesheet" href="css/site.css">',
      '<script src="sub%2F..%2F..%2Fx.js"></script>',
      '<style>@import "../y.css"; .c{background:url(/sidebar/file?path=%2Fp%2Fz)}</style>',
      '</head><body>',
      '<img src="../up.png">',
      '<img src="/sidebar/file?sessionId=s1&amp;path=%2Fp%2Fsecret">',
      '<img src="/sidebar/html/s2/p/docs/a.png">',
      '<img srcset="../up.png 1x, img/ok.png 2x">',
      '</body></html>',
    ].join('')
    const out = await inlineHtmlDocument(html, DOC, fetchResource)

    for (const url of Object.keys(outside)) expect(calls).not.toContain(url)
    expect(calls.every(url => url.startsWith('dsh-app://app/sidebar/html/s1/p/docs/'))).toBe(true)
    expect(out).not.toContain('leak()')
    expect(out).not.toContain('.x{color:red}')
    expect(out).not.toContain('.y{color:red}')
    expect(out).toContain('href="../../x.css"')
    expect(out).toContain('src="sub%2F..%2F..%2Fx.js"')
    expect(out).toContain('@import "../y.css"')
    expect(out).toContain('url(/sidebar/file?path=%2Fp%2Fz)')
    expect(out).toContain('src="../up.png"')
    expect(out).toContain('src="/sidebar/html/s2/p/docs/a.png"')
    expect(out).toContain('url(../../up.png)')
    for (const bytes of ['AQ==', 'Ag==', 'Aw==', 'BA==']) expect(out).not.toContain(`base64,${bytes}`)
    // In-folder resources still inline, including a subfolder stylesheet's
    // ../ that stays inside the folder.
    expect(out).toContain('url("data:image/png;base64,Bw==")')
    expect(out).toContain('data:image/png;base64,Bw== 2x')
  })

  it('does not let an authored <base> widen the folder', async () => {
    const { calls, fetchResource } = fetcher({
      'dsh-app://app/sidebar/html/s1/secret.png': binary([1], 'image/png'),
      'dsh-app://app/sidebar/file': binary([2], 'image/png'),
    })
    const out = await inlineHtmlDocument('<base href="../../"><img src="secret.png"><img src="/sidebar/file">', DOC, fetchResource)
    expect(calls).toEqual([])
    expect(out).toContain('src="secret.png"')
    expect(out).toContain('src="/sidebar/file"')
  })

  it('leaves a failed resource (and every non-local scheme) authored', async () => {
    const { fetchResource } = fetcher({})
    const html = '<!doctype html><img src="missing.png"><a href="./other.html">x</a>'
    const out = await inlineHtmlDocument(html, DOC, fetchResource)
    expect(out).toContain('src="missing.png"')
    expect(out).toContain('href="./other.html"')
  })

  it('resolves a stylesheet import cycle without recursing forever', async () => {
    const entries: Record<string, InlineResource> = {
      'dsh-app://app/sidebar/html/s1/p/docs/a.css': text('@import "b.css"; .a{color:red}', 'text/css'),
      'dsh-app://app/sidebar/html/s1/p/docs/b.css': text('@import "a.css"; .b{color:blue}', 'text/css'),
    }
    const { fetchResource } = fetcher(entries)
    const out = await inlineHtmlDocument('<link rel="stylesheet" href="a.css">', DOC, fetchResource)
    expect(out).toContain('.a{color:red}')
    expect(out).toContain('.b{color:blue}')
    expect(out).not.toContain('@import')
  })

  it('replaces an authored charset with utf-8 and keeps the CSP meta', async () => {
    const { fetchResource } = fetcher({})
    const out = await inlineHtmlDocument(
      '<!doctype html><html><head><meta charset="gbk"><meta http-equiv="Content-Type" content="text/html; charset=gbk"></head><body>ok</body></html>',
      DOC,
      fetchResource,
    )
    expect(out).not.toContain('charset="gbk"')
    expect(out).not.toContain('charset=gbk')
    expect(out).toContain('<meta charset="utf-8">')
    expect(out).toContain("object-src 'none'")
  })
})
