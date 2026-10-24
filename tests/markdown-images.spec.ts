import { describe, expect, it } from 'vitest'
import { rewriteLocalImageUrls, rewriteProseLocalImageUrls } from '../src/client/markdown-images.ts'
import { rewriteLocalMarkdownLinks } from '../src/client/markdown-navigation.ts'
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

  it('does not rewrite image-looking text inside fenced code blocks', () => {
    const md = '```\n![alt](./img.png)\n```\n![real](./real.png)'
    const out = rewriteLocalImageUrls(md, scope, '/repo/readme.md', ORIGIN)
    // The fenced example must be preserved verbatim; only the real image is rewritten.
    expect(out).toContain('```\n![alt](./img.png)\n```')
    expect(out).toContain('/sidebar/file?')
  })

  it('does not rewrite image-looking text inside inline code spans', () => {
    const md = 'Use `![alt](./img.png)` syntax.\n![real](./real.png)'
    const out = rewriteLocalImageUrls(md, scope, '/repo/readme.md', ORIGIN)
    expect(out).toContain('`![alt](./img.png)`')
    expect(out).toContain('/sidebar/file?')
  })

  it('leaves every code-region form alone, tilde fences included', () => {
    // The image pass had the SAME `~~~` blind spot as the link pass, and it
    // predates this feature: on the 58d7f71 baseline
    // `rewriteLocalImageUrls('~~~\n![i](./p.png)\n~~~')` already produced a
    // `/sidebar/file` URL. Both passes now share one fence mask
    // (`markdown-code.ts`).
    const forms = [
      '```\n![i](./p.png)\n```',
      '````\n```\n![i](./p.png)\n```\n````',
      '~~~\n![i](./p.png)\n~~~',
      '~~~\nuse `![i](./p.png)` here\n~~~',
    ]
    for (const form of forms) {
      const out = rewriteLocalImageUrls(form, scope, '/repo/readme.md', ORIGIN)
      expect(out, form).toBe(form)
      expect(out, form).not.toContain('/sidebar/file')
    }
    // A longer closing fence closes, and a real image after it is rewritten.
    const after = rewriteLocalImageUrls('~~~\n![i](./p.png)\n~~~~\n\n![real](./real.png)', scope, '/repo/readme.md', ORIGIN)
    expect(after).toContain('~~~\n![i](./p.png)\n~~~~')
    expect(after).toMatch(/\[real\]\(.*\/sidebar\/file/)
    // An unclosed fence runs to the end of the document.
    expect(rewriteLocalImageUrls('~~~\n![i](./p.png)', scope, '/repo/readme.md', ORIGIN))
      .toBe('~~~\n![i](./p.png)')
    // A reference definition inside the fence is not harvested either.
    const ref = rewriteLocalImageUrls('~~~\n![i][r]\n\n[r]: ./p.png\n~~~', scope, '/repo/readme.md', ORIGIN)
    expect(ref).toBe('~~~\n![i][r]\n\n[r]: ./p.png\n~~~')
  })

  it('does not rewrite a reference definition used only by a plain link', () => {
    // The `[manual][docs]` link references `[docs]: ./docs.md`, but that
    // definition must NOT be redirected to /sidebar/file because it is not
    // referenced by any image. Only image-referenced definitions are rewritten.
    const md = '[manual][docs]\n\n![pic][pic-def]\n\n[docs]: ./docs.md\n[pic-def]: ./pic.png'
    const out = rewriteLocalImageUrls(md, scope, '/repo/readme.md', ORIGIN)
    expect(out).toContain('[docs]: ./docs.md')
    expect(out).not.toMatch(/\[docs\]:.*\/sidebar\/file/)
    // The image-referenced definition IS rewritten.
    expect(out).toMatch(/\[pic-def\]:.*\/sidebar\/file/)
  })
})

describe('rewriteLocalImageUrls: CommonMark angle destinations and titles (N7)', () => {
  const MEDIA = (path: string): string => `${ORIGIN}/sidebar/file?sessionId=abc&path=${encodeURIComponent(path)}&cwd=%2Frepo`

  it('rewrites an angle-delimited destination, including its space', () => {
    const out = rewriteLocalImageUrls('![a](<./cat image.png>)', scope, '/repo/readme.md', ORIGIN)
    // The delimiters are preserved; the URL-encoded path carries the space.
    expect(out).toBe(`![a](<${ORIGIN}/sidebar/file?sessionId=abc&path=%2Frepo%2Fcat+image.png&cwd=%2Frepo>)`)
  })

  it('preserves an optional double-quoted title while rewriting the destination', () => {
    const out = rewriteLocalImageUrls('![a](./x.png "the title")', scope, '/repo/readme.md', ORIGIN)
    expect(out).toBe(`![a](${MEDIA('/repo/x.png')} "the title")`)
  })

  it('preserves a multi-line double-quoted title', () => {
    const md = '![a](./x.png "line one\nline two")'
    const out = rewriteLocalImageUrls(md, scope, '/repo/readme.md', ORIGIN)
    expect(out).toBe(`![a](${MEDIA('/repo/x.png')} "line one\nline two")`)
  })

  it('preserves a single-quoted title (it would otherwise not be rewritten at all)', () => {
    const out = rewriteLocalImageUrls("![a](./x.png 'the title')", scope, '/repo/readme.md', ORIGIN)
    expect(out).toBe(`![a](${MEDIA('/repo/x.png')} 'the title')`)
  })

  it('combines an angle destination with a title', () => {
    const out = rewriteLocalImageUrls('![a](<./cat image.png> "the title")', scope, '/repo/readme.md', ORIGIN)
    expect(out).toBe(`![a](<${ORIGIN}/sidebar/file?sessionId=abc&path=%2Frepo%2Fcat+image.png&cwd=%2Frepo> "the title")`)
  })

  it('leaves a remote angle destination and its title untouched', () => {
    const md = '![a](<https://example.com/x y.png> "remote")'
    expect(rewriteLocalImageUrls(md, scope, '/repo/readme.md', ORIGIN)).toBe(md)
  })

  it('rewrites a reference definition with an angle destination, keeping its delimiters and title', () => {
    const md = '![logo][logo]\n\n[logo]: <./logo mark.svg> "the logo"'
    const out = rewriteLocalImageUrls(md, scope, '/repo/readme.md', ORIGIN)
    expect(out).toContain(`[logo]: <${ORIGIN}/sidebar/file?sessionId=abc&path=%2Frepo%2Flogo+mark.svg&cwd=%2Frepo> "the logo"`)
  })
})

describe('rewriteProseLocalImageUrls', () => {
  const proseScope: SessionScope = { sessionId: 'abc', cwd: '/repo' }
  const FILE_URL = (path: string, cwd = '/repo'): string =>
    `${ORIGIN}/sidebar/file?sessionId=abc&path=${encodeURIComponent(path)}&cwd=${encodeURIComponent(cwd)}`

  it('resolves a relative destination against the prose cwd (the row is not a file)', () => {
    const out = rewriteProseLocalImageUrls('![a](./cat.png)', proseScope, '/repo', ORIGIN)
    expect(out).toBe(`![a](${FILE_URL('/repo/cat.png')})`)
  })

  it('leaves relative destinations untouched when the cwd is unknown', () => {
    const md = '![a](./cat.png)\n![b](cat.png)'
    expect(rewriteProseLocalImageUrls(md, { sessionId: 'abc' }, undefined, ORIGIN)).toBe(md)
  })

  it('still serves an absolute local image when the cwd is unknown (no cwd param)', () => {
    const out = rewriteProseLocalImageUrls('![a](/abs/cat.png)', { sessionId: 'abc' }, undefined, ORIGIN)
    expect(out).toBe(`![a](${ORIGIN}/sidebar/file?sessionId=abc&path=%2Fabs%2Fcat.png)`)
  })

  it('tolerates a trailing separator on the cwd', () => {
    const out = rewriteProseLocalImageUrls('![a](./cat.png)', proseScope, '/repo/', ORIGIN)
    expect(out).toBe(`![a](${FILE_URL('/repo/cat.png')})`)
    // Repeated separators collapse the same way.
    const repeated = rewriteProseLocalImageUrls('![a](./cat.png)', proseScope, '/repo///', ORIGIN)
    expect(repeated).toBe(`![a](${FILE_URL('/repo/cat.png')})`)
  })

  it('resolves a relative destination against a Windows cwd', () => {
    const out = rewriteProseLocalImageUrls('![a](./cat.png)', { sessionId: 'abc', cwd: 'C:\\repo' }, 'C:\\repo\\', ORIGIN)
    // A Windows root keeps its drive and backslash spelling after normalization.
    expect(decodeURIComponent(out.replace(/\+/g, ' '))).toContain('C:\\repo\\cat.png')
  })

  it('rewrites a prose reference-style image against the cwd', () => {
    const md = '![logo][logo]\n\n[logo]: ./logo.svg'
    const out = rewriteProseLocalImageUrls(md, proseScope, '/repo', ORIGIN)
    expect(out).toContain(`[logo]: ${FILE_URL('/repo/logo.svg')}`)
    expect(out).toContain('![logo][logo]')
  })

  it('composes with the local-link rewrite: image first, then the link inside its label', () => {
    const md = '[![badge](./badge.svg)](./doc.md#intro)\n\n![cat](./cat.png)'
    const out = rewriteLocalMarkdownLinks(
      rewriteProseLocalImageUrls(md, proseScope, '/repo', ORIGIN),
      undefined,
      '/repo',
    )
    // The image destination became a media URL and the enclosing `.md` link is
    // still claimed (its heading fragment survives as %23).
    expect(out).toContain(`[![badge](${FILE_URL('/repo/badge.svg')})](./doc.md%23intro)`)
    expect(out).toContain(`![cat](${FILE_URL('/repo/cat.png')})`)
  })
})
