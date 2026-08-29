import { describe, expect, it } from 'vitest'
import { validateRenameName } from '../src/path-security.ts'
import { SidebarError } from '../src/wire.ts'

describe('validateRenameName', () => {
  it('accepts a plain single-segment name (including non-ASCII)', () => {
    expect(() => validateRenameName('b.ts')).not.toThrow()
    expect(() => validateRenameName('新建文件夹')).not.toThrow()
    expect(() => validateRenameName('my-file (2).txt')).not.toThrow()
  })

  it('rejects an empty name', () => {
    expect(() => validateRenameName('')).toThrow(SidebarError)
  })

  it('rejects dot and dot-dot names', () => {
    expect(() => validateRenameName('.')).toThrow(SidebarError)
    expect(() => validateRenameName('..')).toThrow(SidebarError)
  })

  it('rejects path separators on either platform', () => {
    expect(() => validateRenameName('a/b')).toThrow(/separators/)
    expect(() => validateRenameName('a\\b')).toThrow(/separators/)
  })
})