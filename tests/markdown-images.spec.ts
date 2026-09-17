import { describe, expect, it } from 'vitest'
import { DEFAULT_IMAGE_DIR, imageDirOf, rewriteLocalImageUrls, rewriteObsidianImageEmbeds } from '../src/client/markdown-images.ts'
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

describe('rewriteObsidianImageEmbeds', () => {
  it('lowers an image embed into a media-route image against the default images dir', () => {
    const md = 'see ![[diagram.png]]'
    const out = rewriteObsidianImageEmbeds(md, scope, '/repo/readme.md', ORIGIN)
    expect(out).toContain(`![diagram.png](${ORIGIN}/sidebar/file?sessionId=abc&path=%2Frepo%2F${DEFAULT_IMAGE_DIR}%2Fdiagram.png&cwd=%2Frepo)`)
    expect(out).not.toContain('![[')
  })

  it('uses the pipe text as alt when it is not a size token', () => {
    const md = '![[diagram.png|My diagram]]'
    const out = rewriteObsidianImageEmbeds(md, scope, '/repo/readme.md', ORIGIN)
    expect(out).toContain(`![My diagram](${ORIGIN}/sidebar/file?sessionId=abc&path=%2Frepo%2F${DEFAULT_IMAGE_DIR}%2Fdiagram.png&cwd=%2Frepo)`)
  })

  it('drops Obsidian WxH sizing syntax (keeps the image name as alt)', () => {
    const md = '![[diagram.png|200x100]]'
    const out = rewriteObsidianImageEmbeds(md, scope, '/repo/readme.md', ORIGIN)
    expect(out).toContain(`![diagram.png](${ORIGIN}/sidebar/file?sessionId=abc&path=%2Frepo%2F${DEFAULT_IMAGE_DIR}%2Fdiagram.png&cwd=%2Frepo)`)
  })

  it('leaves note/non-image embeds as wiki-link text', () => {
    const md = 'see ![[meeting-notes]] and ![[report.pdf]]'
    const out = rewriteObsidianImageEmbeds(md, scope, '/repo/readme.md', ORIGIN)
    expect(out).toContain('![[meeting-notes]]')
    expect(out).toContain('![[report.pdf]]')
    expect(out).not.toContain('/sidebar/file')
  })

  it('leaves plain (non-embed) wiki links untouched', () => {
    const md = 'see [[some-note]] for details'
    const out = rewriteObsidianImageEmbeds(md, scope, '/repo/readme.md', ORIGIN)
    expect(out).toBe(md)
  })

  it('honors a relative configurable imageDir anchored at the session cwd', () => {
    const md = '![[logo.png]]'
    const out = rewriteObsidianImageEmbeds(md, scope, '/repo/readme.md', ORIGIN, 'assets')
    expect(out).toContain(`![logo.png](${ORIGIN}/sidebar/file?sessionId=abc&path=%2Frepo%2Fassets%2Flogo.png&cwd=%2Frepo)`)
  })

  it('honors an absolute imageDir verbatim', () => {
    const md = '![[logo.png]]'
    const out = rewriteObsidianImageEmbeds(md, scope, '/repo/readme.md', ORIGIN, '/abs/img')
    expect(out).toContain(`![logo.png](${ORIGIN}/sidebar/file?sessionId=abc&path=%2Fabs%2Fimg%2Flogo.png&cwd=%2Frepo)`)
  })

  it('falls back to the file directory when the scope has no cwd', () => {
    const md = '![[logo.png]]'
    const out = rewriteObsidianImageEmbeds(md, { sessionId: 'abc' }, '/repo/readme.md', ORIGIN)
    expect(out).toContain(`![logo.png](${ORIGIN}/sidebar/file?sessionId=abc&path=%2Frepo%2F${DEFAULT_IMAGE_DIR}%2Flogo.png)`)
    expect(out).not.toContain('cwd=')
  })
})

describe('imageDirOf', () => {
  it('returns the default for missing/empty values', () => {
    expect(imageDirOf(undefined)).toBe(DEFAULT_IMAGE_DIR)
    expect(imageDirOf('')).toBe(DEFAULT_IMAGE_DIR)
    expect(imageDirOf('   ')).toBe(DEFAULT_IMAGE_DIR)
  })

  it('trims and returns a configured value', () => {
    expect(imageDirOf(' assets ')).toBe('assets')
  })
})

describe('rewriteLocalImageUrls (Obsidian integration)', () => {
  it('rewrites Obsidian embeds inline and is idempotent on the rewritten output', () => {
    const md = 'intro ![[diagram.png]] end'
    const once = rewriteLocalImageUrls(md, scope, '/repo/readme.md', ORIGIN)
    expect(once).toContain(`![diagram.png](${ORIGIN}/sidebar/file?sessionId=abc&path=%2Frepo%2F${DEFAULT_IMAGE_DIR}%2Fdiagram.png&cwd=%2Frepo)`)
    // Re-running must not double-resolve the already-absolute media URL.
    const twice = rewriteLocalImageUrls(once, scope, '/repo/readme.md', ORIGIN)
    expect(twice).toBe(once)
  })

  it('does not rewrite embeds inside fenced code blocks or inline code spans', () => {
    const md = '```\n![[diagram.png]]\n```\n\nuse `![[diagram.png]]` inline'
    const out = rewriteLocalImageUrls(md, scope, '/repo/readme.md', ORIGIN)
    expect(out).toBe(md)
  })

  it('keeps non-image ![[ ... ]] embeds as wiki-link text', () => {
    const md = 'see ![[meeting-notes]]'
    const out = rewriteLocalImageUrls(md, scope, '/repo/readme.md', ORIGIN)
    expect(out).toContain('![[meeting-notes]]')
  })

  it('threads a configured imageDir through the full rewrite', () => {
    const out = rewriteLocalImageUrls('![[logo.png]]', scope, '/repo/readme.md', ORIGIN, 'assets')
    expect(out).toContain(`![logo.png](${ORIGIN}/sidebar/file?sessionId=abc&path=%2Frepo%2Fassets%2Flogo.png&cwd=%2Frepo)`)
  })
})
