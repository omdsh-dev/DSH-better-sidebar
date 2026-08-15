/**
 * Markdown local-image rewriting: relative destinations become absolute
 * media URLs, scheme/root-relative/anchor destinations stay untouched, and
 * fenced code blocks + inline code spans are protected.
 */
import { describe, expect, it } from 'vitest'
import { resolveLocalPath, rewriteLocalImages } from '../src/client/md-image-rewrite.ts'

/** Resolver that marks the local dest (the caller would build a real URL). */
const markResolved = (dest: string): string => `https://media.test/f/${dest}`

describe('resolveLocalPath', () => {
  it('resolves relative destinations against the file directory', () => {
    expect(resolveLocalPath('/a/b/', './pic.png')).toBe('/a/b/pic.png')
    expect(resolveLocalPath('/a/b/', 'pic.png')).toBe('/a/b/pic.png')
    expect(resolveLocalPath('/a/b/', '../c/pic.png')).toBe('/a/c/pic.png')
    expect(resolveLocalPath('/a/b/', 'sub/dir/pic.png')).toBe('/a/b/sub/dir/pic.png')
  })

  it('normalizes dot segments and drops query/hash suffixes', () => {
    expect(resolveLocalPath('/a/b/', '././pic.png')).toBe('/a/b/pic.png')
    expect(resolveLocalPath('/a/b/', 'pic.png?v=1')).toBe('/a/b/pic.png')
    expect(resolveLocalPath('/a/b/', 'pic.png#frag')).toBe('/a/b/pic.png')
    expect(resolveLocalPath('/a/b/', '..')).toBe('/a')
  })

  it('decodes URL-encoded names', () => {
    expect(resolveLocalPath('/a/b/', 'my%20pic.png')).toBe('/a/b/my pic.png')
  })
})

describe('rewriteLocalImages', () => {
  it('rewrites a plain relative image', () => {
    expect(rewriteLocalImages('![alt](./pic.png)', markResolved))
      .toBe('![alt](https://media.test/f/./pic.png)')
  })

  it('leaves http/data/mailto and root-relative/anchor destinations alone', () => {
    const source = [
      '![a](https://x.test/i.png)',
      '![b](data:image/png;base64,xx)',
      '![c](/abs/i.png)',
      '![d](#anchor)',
      '![e](mailto:a@b.c)',
    ].join('\n')
    expect(rewriteLocalImages(source, markResolved)).toBe(source)
  })

  it('does not rewrite inside fenced code blocks (``` and ~~~)', () => {
    const source = '```md\n![x](./in-fence.png)\n```\n\n~~~\n![y](./in-tilde.png)\n~~~\n![z](./real.png)'
    const out = rewriteLocalImages(source, markResolved)
    expect(out).toContain('![x](./in-fence.png)')
    expect(out).toContain('![y](./in-tilde.png)')
    expect(out).toContain('![z](https://media.test/f/./real.png)')
  })

  it('does not rewrite inside inline code spans', () => {
    expect(rewriteLocalImages('see `![a](./x.png)` and ![b](./y.png)', markResolved))
      .toBe('see `![a](./x.png)` and ![b](https://media.test/f/./y.png)')
  })

  it('handles angle destinations and titles', () => {
    expect(rewriteLocalImages('![a](<./x.png> "title")', markResolved))
      .toBe('![a](https://media.test/f/./x.png)')
  })

  it('handles an empty source and image-free text', () => {
    expect(rewriteLocalImages('', markResolved)).toBe('')
    expect(rewriteLocalImages('# hi\n\ntext', markResolved)).toBe('# hi\n\ntext')
  })

  it('a null resolver leaves the destination untouched', () => {
    expect(rewriteLocalImages('![a](./x.png)', () => null)).toBe('![a](./x.png)')
  })
})
