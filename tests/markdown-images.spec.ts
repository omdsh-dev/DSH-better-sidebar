import { describe, expect, it } from 'vitest'
import { rewriteLocalImageUrls } from '../src/client/markdown-images.ts'
import type { SessionScope } from '../src/client/api.ts'

const ORIGIN = 'http://127.0.0.1:3080'
const scope: SessionScope = { sessionId: 'abc', cwd: '/repo' }

describe('rewriteLocalImageUrls', () => {
  it('resolves relative destinations against the opened file directory', () => {
    const md = '![a](./img.png)\n![b](images/b.jpg)'
    const out = rewriteLocalImageUrls(md, scope, '/repo/docs/readme.md', ORIGIN)
    expect(out).toContain(`![a](${ORIGIN}/sidebar/file?sessionId=abc&path=%2Frepo%2Fdocs%2Fimg.png&cwd=%2Frepo)`)
    expect(out).toContain(`![b](${ORIGIN}/sidebar/file?sessionId=abc&path=%2Frepo%2Fdocs%2Fimages%2Fb.jpg&cwd=%2Frepo)`)
  })

  it('expects the rewritten destination to be an absolute http URL MarkdownText accepts', () => {
    const out = rewriteLocalImageUrls('![a](./img.png)', scope, '/repo/readme.md', ORIGIN)
    const url = out.match(/\]\((http[^)]+)\)/)?.[1]
    expect(url).toBeDefined()
    expect(new URL(url as string).protocol).toBe('http:')
  })

  it('passes absolute local paths through unchanged', () => {
    const md = '![a](/repo/assets/b.png)'
    const out = rewriteLocalImageUrls(md, scope, '/repo/docs/readme.md', ORIGIN)
    expect(out).toContain(`![a](${ORIGIN}/sidebar/file?sessionId=abc&path=%2Frepo%2Fassets%2Fb.png&cwd=%2Frepo)`)
  })

  it('keeps remote http(s)/data/mailto destinations untouched', () => {
    const md = '![a](https://example.com/x.jpg)\n![b](http://e.com/y.png)\n![c](data:image/png;base64,AAA)'
    const out = rewriteLocalImageUrls(md, scope, '/repo/readme.md', ORIGIN)
    expect(out).toContain('![a](https://example.com/x.jpg)')
    expect(out).toContain('![b](http://e.com/y.png)')
    expect(out).toContain('![c](data:image/png;base64,AAA)')
  })

  it('leaves in-page anchors untouched', () => {
    const md = '![a](#section)\n\n[link](#top)'
    const out = rewriteLocalImageUrls(md, scope, '/repo/readme.md', ORIGIN)
    expect(out).toContain('![a](#section)')
  })

  it('rewrites reference-style image definitions', () => {
    const md = '![logo][logo]\n\n[logo]: ./logo.svg'
    const out = rewriteLocalImageUrls(md, scope, '/repo/readme.md', ORIGIN)
    expect(out).toContain(`[logo]: ${ORIGIN}/sidebar/file?sessionId=abc&path=%2Frepo%2Flogo.svg&cwd=%2Frepo`)
    // The inline reference itself is left for MarkdownText to combine.
    expect(out).toContain('![logo][logo]')
  })

  it('normalizes `.`/`..` segments in relative destinations', () => {
    const md = '![a](./img.png)\n![b](../assets/b.png)'
    const out = rewriteLocalImageUrls(md, scope, '/repo/docs/sub/readme.md', ORIGIN)
    expect(out).toContain(`![a](${ORIGIN}/sidebar/file?sessionId=abc&path=%2Frepo%2Fdocs%2Fsub%2Fimg.png&cwd=%2Frepo)`)
    expect(out).toContain(`![b](${ORIGIN}/sidebar/file?sessionId=abc&path=%2Frepo%2Fdocs%2Fassets%2Fb.png&cwd=%2Frepo)`)
    expect(out).not.toContain('/.')
  })

  it('drops the cwd param when the scope has no cwd', () => {
    const out = rewriteLocalImageUrls('![a](./img.png)', { sessionId: 'abc' }, '/repo/readme.md', ORIGIN)
    expect(out).toContain(`sessionId=abc&path=%2Frepo%2Fimg.png`)
    expect(out).not.toContain('cwd=')
  })

  it('handles windows absolute paths as local (not remote)', () => {
    const md = '![a](C:\\repo\\img.png)'
    const out = rewriteLocalImageUrls(md, scope, 'C:\\repo\\docs\\readme.md', ORIGIN)
    // A Windows drive path is absolute (not a remote scheme) → rewritten.
    const url = out.match(/\]\(([^)]+)\)/)?.[1] as string
    expect(url).toContain('/sidebar/file?')
    expect(decodeURIComponent(url)).toContain('C:\\repo\\img.png')
  })
})
