import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileIcon, folderIcon, setActiveFileIconTheme, subscribeFileIconTheme, getFileIconThemeRevision, NONE_FILE_ICON_THEME, BUILTIN_FILE_ICON_THEME } from '../src/client/file-icons.tsx'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'
import { createElement } from 'react'

describe('file-icon theme system', () => {
  // Reset to no active theme after each test so tests don't interfere.
  afterEach(() => { setActiveFileIconTheme(undefined) })

  describe('SIDEBAR_PREFS_DEFAULTS', () => {
    it('defaults fileIconThemeId to "none"', () => {
      expect(SIDEBAR_PREFS_DEFAULTS.fileIconThemeId).toBe('none')
    })
  })

  describe('NONE_FILE_ICON_THEME (original look)', () => {
    it('has id "none"', () => {
      expect(NONE_FILE_ICON_THEME.id).toBe('none')
    })

    it('fileIcon resolver returns a non-undefined ReactNode', () => {
      const result = NONE_FILE_ICON_THEME.fileIcon?.('test.ts')
      expect(result).not.toBeUndefined()
    })

    it('folderIcon resolver returns a non-undefined ReactNode', () => {
      const result = NONE_FILE_ICON_THEME.folderIcon?.('src', true)
      expect(result).not.toBeUndefined()
    })
  })

  describe('BUILTIN_FILE_ICON_THEME (colored icons)', () => {
    it('has id "builtin"', () => {
      expect(BUILTIN_FILE_ICON_THEME.id).toBe('builtin')
    })

    it('fileIcon resolver returns undefined (falls through to mapping)', () => {
      const result = BUILTIN_FILE_ICON_THEME.fileIcon?.('test.ts')
      expect(result).toBeUndefined()
    })

    it('folderIcon resolver returns undefined (falls through to mapping)', () => {
      const result = BUILTIN_FILE_ICON_THEME.folderIcon?.('src', true)
      expect(result).toBeUndefined()
    })
  })

  describe('fileIcon (no active theme → built-in mapping)', () => {
    it('returns a ReactNode for .ts files', () => {
      const result = fileIcon('main.ts')
      expect(result).not.toBeNull()
    })

    it('returns a ReactNode for .tsx files', () => {
      const result = fileIcon('App.tsx')
      expect(result).not.toBeNull()
    })

    it('returns a ReactNode for unknown extensions (fallback to VscFile)', () => {
      const result = fileIcon('unknown.xyz')
      expect(result).not.toBeNull()
    })

    it('returns a ReactNode for special filenames', () => {
      const result = fileIcon('package.json')
      expect(result).not.toBeNull()
    })
  })

  describe('fileIcon (active theme = none → original look)', () => {
    beforeEach(() => { setActiveFileIconTheme(NONE_FILE_ICON_THEME) })

    it('returns a ReactNode (generic VscFile) for .ts files', () => {
      const result = fileIcon('main.ts')
      expect(result).not.toBeNull()
    })

    it('returns a ReactNode for unknown extensions', () => {
      const result = fileIcon('unknown.xyz')
      expect(result).not.toBeNull()
    })
  })

  describe('fileIcon (active theme = builtin → colored icons)', () => {
    beforeEach(() => { setActiveFileIconTheme(BUILTIN_FILE_ICON_THEME) })

    it('returns a ReactNode for .ts files', () => {
      const result = fileIcon('main.ts')
      expect(result).not.toBeNull()
    })

    it('returns a ReactNode for .tsx files', () => {
      const result = fileIcon('App.tsx')
      expect(result).not.toBeNull()
    })
  })

  describe('folderIcon', () => {
    it('returns a ReactNode for special folders (no active theme)', () => {
      const result = folderIcon('node_modules', true)
      expect(result).not.toBeNull()
    })

    it('returns a ReactNode for regular folders (no active theme)', () => {
      const result = folderIcon('random-folder', false)
      expect(result).not.toBeNull()
    })

    it('returns a ReactNode when none theme is active', () => {
      setActiveFileIconTheme(NONE_FILE_ICON_THEME)
      const result = folderIcon('node_modules', true)
      expect(result).not.toBeNull()
    })
  })

  describe('theme pub/sub', () => {
    it('subscribeFileIconTheme registers a listener', () => {
      let called = false
      const unsub = subscribeFileIconTheme(() => { called = true })
      expect(typeof unsub).toBe('function')
      // setActiveFileIconTheme should trigger the listener
      setActiveFileIconTheme(NONE_FILE_ICON_THEME)
      expect(called).toBe(true)
      unsub()
    })

    it('getFileIconThemeRevision increments on setActiveFileIconTheme', () => {
      const before = getFileIconThemeRevision()
      setActiveFileIconTheme(BUILTIN_FILE_ICON_THEME)
      const after = getFileIconThemeRevision()
      expect(after).toBeGreaterThan(before)
    })

    it('unsubscribe stops receiving notifications', () => {
      let called = false
      const unsub = subscribeFileIconTheme(() => { called = true })
      unsub()
      setActiveFileIconTheme(NONE_FILE_ICON_THEME)
      expect(called).toBe(false)
    })
  })
})
