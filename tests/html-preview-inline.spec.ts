/**
 * Desktop HTML preview inliner tests: same-origin resources become data URLs
 * or inline blocks, external/data/file references stay authored, failures
 * leave the original, imports resolve relative to their stylesheet, and the
 * returned document is UTF-8 with the object-src defense.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { bytesToBase64, inlineableUrl, inlineHtmlDocument, type InlineResource } from '../src/client/html-preview-inline.ts'

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
