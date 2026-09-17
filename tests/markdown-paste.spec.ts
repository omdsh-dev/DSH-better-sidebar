import { describe, expect, it } from 'vitest'
import {
  clipboardImageOf,
  extensionForImageMime,
  obsidianImageEmbed,
  pastedImageFileName,
} from '../src/client/markdown-paste.ts'
import { resolveObsidianBaseDir } from '../src/client/markdown-images.ts'
import type { SessionScope } from '../src/client/api.ts'

describe('extensionForImageMime', () => {
  it('maps common clipboard MIME types', () => {
    expect(extensionForImageMime('image/png')).toBe('png')
    expect(extensionForImageMime('image/jpeg')).toBe('jpg')
    expect(extensionForImageMime('image/jpg')).toBe('jpg')
    expect(extensionForImageMime('image/gif')).toBe('gif')
    expect(extensionForImageMime('image/webp')).toBe('webp')
  })

  it('falls back to png for unknown image MIME types', () => {
    expect(extensionForImageMime('image/x-unknown')).toBe('png')
    expect(extensionForImageMime('')).toBe('png')
  })
})

describe('pastedImageFileName', () => {
  it('formats pasted-YYYYMMDD-HHMMSS.ext', () => {
    const now = new Date(2026, 8, 10, 16, 6, 30) // local Sep 10 2026
    expect(pastedImageFileName(now, 'png')).toBe('pasted-20260910-160630.png')
  })

  it('appends a collision suffix before the extension', () => {
    const now = new Date(2026, 8, 10, 16, 6, 30)
    expect(pastedImageFileName(now, 'jpg', 1)).toBe('pasted-20260910-160630-1.jpg')
    expect(pastedImageFileName(now, 'jpg', 0)).toBe('pasted-20260910-160630.jpg')
  })
})

describe('obsidianImageEmbed', () => {
  it('wraps the filename in ![[...]]', () => {
    expect(obsidianImageEmbed('pasted-20260910-160630.png')).toBe('![[pasted-20260910-160630.png]]')
  })
})

describe('clipboardImageOf', () => {
  it('returns undefined when clipboardData is missing or has no image', () => {
    expect(clipboardImageOf(null)).toBeUndefined()
    expect(clipboardImageOf(undefined)).toBeUndefined()
    const data = {
      items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
      files: [],
    } as unknown as DataTransfer
    expect(clipboardImageOf(data)).toBeUndefined()
  })

  it('prefers the first image/* item from clipboard items', () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    const file = new File([blob], 'clip.png', { type: 'image/png' })
    const data = {
      items: [
        { kind: 'string', type: 'text/plain', getAsFile: () => null },
        { kind: 'file', type: 'image/png', getAsFile: () => file },
      ],
      files: [],
    } as unknown as DataTransfer
    const now = new Date(2026, 0, 2, 3, 4, 5)
    const image = clipboardImageOf(data, now)
    expect(image).toEqual({ blob: file, fileName: 'pasted-20260102-030405.png' })
  })

  it('falls back to files when items has no image', () => {
    const file = new File([new Uint8Array([9])], 'drop.webp', { type: 'image/webp' })
    const data = {
      items: [],
      files: [file],
    } as unknown as DataTransfer
    const now = new Date(2026, 0, 2, 3, 4, 5)
    const image = clipboardImageOf(data, now, 2)
    expect(image?.fileName).toBe('pasted-20260102-030405-2.webp')
    expect(image?.blob).toBe(file)
  })
})

describe('resolveObsidianBaseDir', () => {
  const scope: SessionScope = { sessionId: 'abc', cwd: '/repo' }

  it('anchors a relative imageDir at the session cwd', () => {
    expect(resolveObsidianBaseDir('images', scope, '/repo/docs/readme.md')).toBe('/repo/images')
    expect(resolveObsidianBaseDir('assets', scope, '/repo/docs/readme.md')).toBe('/repo/assets')
  })

  it('uses an absolute imageDir verbatim', () => {
    expect(resolveObsidianBaseDir('/abs/img', scope, '/repo/readme.md')).toBe('/abs/img')
    expect(resolveObsidianBaseDir('/abs/img/', scope, '/repo/readme.md')).toBe('/abs/img')
  })

  it('falls back to the file directory when the scope has no cwd', () => {
    expect(resolveObsidianBaseDir('images', { sessionId: 'abc' }, '/repo/docs/readme.md'))
      .toBe('/repo/docs/images')
  })
})
