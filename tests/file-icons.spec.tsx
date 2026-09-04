/**
 * Tests for the file-icon feature: the external registration API
 * (registerFileIcon — registry lifecycle, reserved folder exts, and the
 * authoritative fileIcon/folderIcon resolver chains) and the built-in
 * per-extension glyph map (extension normalization, group hits, and the
 * generic VscFile fallback).
 */
import { describe, it, expect, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import { VscFile, VscFileCode, VscFileMedia, VscFolder, VscFolderOpened, VscJson, VscMarkdown } from 'react-icons/vsc'

// Mock browser globals (SidebarStore.reduce → schedulePersist uses window.setTimeout)
const g = globalThis as Record<string, unknown>
if (g.window === undefined) {
  g.window = {
    clearTimeout: () => {},
    setTimeout: (_fn: () => void) => 0,
    innerWidth: 1024,
  }
}
if (g.localStorage === undefined) {
  g.localStorage = {
    getItem: () => null,
    setItem: () => {},
  }
}

import { createBetterSidebarService, SIDEBAR_FEATURES } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { builtinFileIcon, builtinFolderIcon, fallbackFileIcon } from '../src/client/file-icons.tsx'

/** The component type of a rendered icon element (identity of the glyph). */
const glyphOf = (node: ReactNode): unknown => (node as ReactElement).type

/** A marker component standing in for a plugin's registered icon. */
const marker = (): ReactNode => <span data-marker />

const markerB = (): ReactNode => <span data-marker-b />

describe('file icon registration API', () => {
  it('registerFileIcon adds to the registry and dispose removes it', () => {
    const service = createBetterSidebarService(createSidebarStore())
    expect(service.getFileIcons()).toHaveLength(0)
    const dispose = service.registerFileIcon({ id: 'test:icons', exts: ['csv'], icon: marker })
    expect(service.getFileIcons()).toHaveLength(1)
    expect(service.matchFileIcon('/w/a.csv')?.id).toBe('test:icons')
    dispose()
    expect(service.getFileIcons()).toHaveLength(0)
    expect(service.matchFileIcon('/w/a.csv')).toBeUndefined()
  })

  it('registerFileIcon throws on duplicate id', () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerFileIcon({ id: 'dup', exts: [], icon: marker })
    expect(() => service.registerFileIcon({ id: 'dup', exts: [], icon: marker })).toThrow()
  })

  it('matchFileIcon matches by extension (case-insensitive), specifics only', () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerFileIcon({ id: 'csv', exts: ['csv'], icon: marker })
    service.registerFileIcon({ id: 'all', exts: [], icon: marker })
    expect(service.matchFileIcon('/w/data.csv')?.id).toBe('csv')
    expect(service.matchFileIcon('/w/DATA.CSV')?.id).toBe('csv')
    // The catch-all never answers matchFileIcon (it lives in fileIcon's chain).
    expect(service.matchFileIcon('/w/a.tsv')).toBeUndefined()
  })

  it('higher priority wins on extension conflict; ties keep registration order', () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerFileIcon({ id: 'low', exts: ['csv'], icon: marker })
    service.registerFileIcon({ id: 'high', exts: ['csv'], priority: 10, icon: marker })
    service.registerFileIcon({ id: 'tie', exts: ['csv'], icon: marker })
    expect(service.matchFileIcon('/w/a.csv')?.id).toBe('high')
    const fresh = createBetterSidebarService(createSidebarStore())
    fresh.registerFileIcon({ id: 'first', exts: ['csv'], icon: marker })
    fresh.registerFileIcon({ id: 'second', exts: ['csv'], icon: marker })
    expect(fresh.matchFileIcon('/w/a.csv')?.id).toBe('first')
  })

  it('the feature is advertised in SIDEBAR_FEATURES', () => {
    expect(SIDEBAR_FEATURES.includes('fileIcons')).toBe(true)
  })
})

describe('fileIcon resolver chain (specific → builtin → catch-all → VscFile)', () => {
  it('a specific registration beats the builtin glyph', () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerFileIcon({ id: 'md', exts: ['md'], icon: marker })
    expect(glyphOf(service.fileIcon('/w/README.md', 14))).toBe('span')
  })

  it('the builtin glyph beats a registered catch-all (the default only claims unclaimed extensions)', () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerFileIcon({ id: 'all', exts: [], icon: marker })
    expect(glyphOf(service.fileIcon('/w/README.md', 14))).toBe(VscMarkdown)
    expect(glyphOf(service.fileIcon('/w/logo.png', 14))).toBe(VscFileMedia)
    // An extension the builtin map does not cover reaches the catch-all.
    expect(glyphOf(service.fileIcon('/w/Makefile', 14))).toBe('span')
  })

  it('the best (priority desc) catch-all wins among several', () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerFileIcon({ id: 'all-a', exts: [], icon: marker })
    service.registerFileIcon({ id: 'all-b', exts: [], priority: 5, icon: markerB })
    expect(glyphOf(service.fileIcon('/w/Makefile', 14))).toBe('span')
  })

  it('with no registration at all the chain is the built-in one', () => {
    const service = createBetterSidebarService(createSidebarStore())
    expect(glyphOf(service.fileIcon('/w/pkg.json', 14))).toBe(VscJson)
    expect(glyphOf(service.fileIcon('/w/main.ts', 14))).toBe(VscFileCode)
    expect(glyphOf(service.fileIcon('/w/Makefile', 14))).toBe(VscFile)
  })

  it('a throwing factory is skipped at every level (console.error, next link wins)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const service = createBetterSidebarService(createSidebarStore())
      service.registerFileIcon({ id: 'boom-md', exts: ['md'], icon: () => { throw new Error('boom') } })
      // Specific throws → falls to the builtin glyph.
      expect(glyphOf(service.fileIcon('/w/README.md', 14))).toBe(VscMarkdown)
      service.registerFileIcon({ id: 'boom-all', exts: [], priority: 10, icon: () => { throw new Error('boom') } })
      // Catch-all throws → falls to the stock VscFile.
      expect(glyphOf(service.fileIcon('/w/Makefile', 14))).toBe(VscFile)
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('reserved folder exts never claim a real file named x.folder', () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerFileIcon({ id: 'folders', exts: ['folder', 'folder-open'], icon: marker })
    expect(service.matchFileIcon('/w/x.folder')).toBeUndefined()
    // The real file falls through to the stock default, not the folder icon.
    expect(glyphOf(service.fileIcon('/w/x.folder', 14))).toBe(VscFile)
  })
})

describe('folderIcon resolver (registered folder/folder-open → builtin glyphs)', () => {
  it('unregistered directories show the builtin glyphs', () => {
    const service = createBetterSidebarService(createSidebarStore())
    expect(glyphOf(service.folderIcon('/w/src', false, 14))).toBe(VscFolder)
    expect(glyphOf(service.folderIcon('/w/src', true, 14))).toBe(VscFolderOpened)
    expect(glyphOf(builtinFolderIcon(false, 14))).toBe(VscFolder)
    expect(glyphOf(builtinFolderIcon(true, 14))).toBe(VscFolderOpened)
  })

  it('folder / folder-open registrations replace the dir glyphs (priority desc)', () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerFileIcon({ id: 'closed', exts: ['folder'], icon: marker })
    expect(glyphOf(service.folderIcon('/w/src', false, 14))).toBe('span')
    // The OPEN row is a separate reserved ext — still the builtin here.
    expect(glyphOf(service.folderIcon('/w/src', true, 14))).toBe(VscFolderOpened)
    service.registerFileIcon({ id: 'open', exts: ['folder-open'], icon: markerB })
    expect(glyphOf(service.folderIcon('/w/src', true, 14))).toBe('span')
    service.registerFileIcon({ id: 'closed-hi', exts: ['folder'], priority: 3, icon: markerB })
    expect(glyphOf(service.folderIcon('/w/src', false, 14))).toBe('span')
  })

  it('a catch-all registration never claims a directory', () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerFileIcon({ id: 'all', exts: [], icon: marker })
    expect(glyphOf(service.folderIcon('/w/src', false, 14))).toBe(VscFolder)
  })

  it('a throwing folder factory falls back to the builtin glyph', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const service = createBetterSidebarService(createSidebarStore())
      service.registerFileIcon({ id: 'boom', exts: ['folder'], icon: () => { throw new Error('boom') } })
      expect(glyphOf(service.folderIcon('/w/src', false, 14))).toBe(VscFolder)
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('built-in glyph map (builtinFileIcon)', () => {
  it('maps representative extensions to their group glyph', () => {
    expect(glyphOf(builtinFileIcon('/w/README.md', 14))).toBe(VscMarkdown)
    expect(glyphOf(builtinFileIcon('/w/logo.png', 14))).toBe(VscFileMedia)
    expect(glyphOf(builtinFileIcon('/w/logo.SVG', 14))).toBe(VscFileMedia)
    expect(glyphOf(builtinFileIcon('/w/pkg.json', 14))).toBe(VscJson)
    expect(glyphOf(builtinFileIcon('/w/main.ts', 14))).toBe(VscFileCode)
    expect(glyphOf(builtinFileIcon('/w/main.py', 14))).toBe(VscFileCode)
  })

  it('falls back to the generic VscFile for unknown extensions and paths without one', () => {
    expect(glyphOf(builtinFileIcon('/w/data.xyzunknown', 14))).toBe(VscFile)
    expect(glyphOf(builtinFileIcon('/w/Makefile', 14))).toBe(VscFile)
    expect(glyphOf(fallbackFileIcon(14))).toBe(VscFile)
  })
})
