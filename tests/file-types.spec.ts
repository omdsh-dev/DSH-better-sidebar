import { describe, expect, it } from 'vitest'
import { isImageExt } from '../src/client/image-types.ts'
import { extOf, languageKeyForExt } from '../src/client/lang.ts'
import { isPdfExt } from '../src/client/pdf-types.ts'

describe('editor language mapping', () => {
  it('derives extensions from paths', () => {
    expect(extOf('/a/b/main.tsx')).toBe('tsx')
    expect(extOf('README.MD')).toBe('md')
    expect(extOf('/a/b/.gitignore')).toBe('gitignore')
    expect(extOf('noext')).toBe('')
  })

  it('maps common extensions to languages and falls back to plain text', () => {
    expect(languageKeyForExt('tsx')).toBe('tsx')
    expect(languageKeyForExt('js')).toBe('js')
    expect(languageKeyForExt('py')).toBe('python')
    expect(languageKeyForExt('yaml')).toBe('yaml')
    expect(languageKeyForExt('sh')).toBe('shell')
    expect(languageKeyForExt('md')).toBe('md')
    expect(languageKeyForExt('cs')).toBe('csharp')
    expect(languageKeyForExt('kt')).toBe('kotlin')
    expect(languageKeyForExt('swift')).toBe('swift')
    expect(languageKeyForExt('txt')).toBeNull()
    expect(languageKeyForExt('log')).toBeNull()
    expect(languageKeyForExt('')).toBeNull()
  })
})

describe('pdf preview kind', () => {
  it('routes only .pdf to the browser-native preview', () => {
    expect(isPdfExt('.pdf')).toBe(true)
    expect(isPdfExt('.PDF')).toBe(false)
    expect(isPdfExt('.docx')).toBe(false)
    expect(isPdfExt('')).toBe(false)
  })
})

describe('image preview kind', () => {
  it('routes supported image extensions before binary probing', () => {
    expect(isImageExt('.png')).toBe(true)
    expect(isImageExt('.jpg')).toBe(true)
    expect(isImageExt('.svg')).toBe(true)
    expect(isImageExt('.avif')).toBe(true)
    expect(isImageExt('.pdf')).toBe(false)
    expect(isImageExt('')).toBe(false)
  })
})
