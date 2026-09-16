/**
 * Tests for the file-icon feature: the external registration API
 * (registerFileIcon — registry lifecycle, reserved folder exts, and the
 * authoritative fileIcon/folderIcon resolver chains) and the built-in glyphs,
 * which are DSH's own `FileTypeIcon` artwork rather than a plugin-owned
 * extension table (see src/client/file-icons.tsx).
 */
import { describe, it, expect, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import { FileTypeIcon } from '@deepseek-ai/dsh-client-ui-primitives'

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

/** A second marker with a DISTINCT element type, so `glyphOf` can tell the
 *  two registrations apart in priority/ordering assertions. */
const markerB = (): ReactNode => <b data-marker-b />

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

  it('register and dispose notify subscribers (mounted rows re-resolve, no reload)', () => {
    const service = createBetterSidebarService(createSidebarStore())
    let notified = 0
    const unsubscribe = service.subscribe(() => { notified += 1 })
    const dispose = service.registerFileIcon({ id: 'test:icons', exts: ['csv'], icon: marker })
    expect(notified).toBe(1)
    dispose()
    expect(notified).toBe(2)
    // A second dispose is a no-op — no spurious notification.
    dispose()
    expect(notified).toBe(2)
    unsubscribe()
    service.registerFileIcon({ id: 'test:other', exts: ['tsv'], icon: marker })
    expect(notified).toBe(2)
  })
})

describe('fileIcon resolver chain (specific → catch-all → the host artwork)', () => {
  it('a specific registration beats the builtin glyph', () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerFileIcon({ id: 'md', exts: ['md'], icon: marker })
    expect(glyphOf(service.fileIcon('/w/README.md', 14))).toBe('span')
  })

  it('a registered catch-all claims every row the plugin itself would draw', () => {
    // The plugin ships no extension table any more: the host's classifier
    // covers every path, so "the built-in set already claims this one" is no
    // longer a reason to keep a catch-all out. A catch-all therefore wins the
    // fallback position outright, and an unregistered tree keeps the host's
    // artwork (the next case).
    const service = createBetterSidebarService(createSidebarStore())
    service.registerFileIcon({ id: 'all', exts: [], icon: marker })
    expect(glyphOf(service.fileIcon('/w/README.md', 14))).toBe('span')
    expect(glyphOf(service.fileIcon('/w/logo.png', 14))).toBe('span')
    expect(glyphOf(service.fileIcon('/w/Makefile', 14))).toBe('span')
  })

  it('the best (priority desc) catch-all wins among several', () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerFileIcon({ id: 'all-a', exts: [], icon: marker })
    service.registerFileIcon({ id: 'all-b', exts: [], priority: 5, icon: markerB })
    // markerB ('b') is the higher-priority catch-all — not merely "some span".
    expect(glyphOf(service.fileIcon('/w/Makefile', 14))).toBe('b')
    const tie = createBetterSidebarService(createSidebarStore())
    tie.registerFileIcon({ id: 'first', exts: [], icon: marker })
    tie.registerFileIcon({ id: 'second', exts: [], icon: markerB })
    // Equal priority keeps registration order (the first-registered wins).
    expect(glyphOf(tie.fileIcon('/w/Makefile', 14))).toBe('span')
  })

  it('a factory returning undefined declines that link and the chain continues', () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerFileIcon({ id: 'md-decline', exts: ['md'], icon: () => undefined })
    // The specific registration declined → the built-in glyph claims it.
    expect(glyphOf(service.fileIcon('/w/README.md', 14))).toBe(FileTypeIcon)
    service.registerFileIcon({ id: 'all-decline', exts: [], priority: 10, icon: () => undefined })
    service.registerFileIcon({ id: 'all-take', exts: [], icon: marker })
    // The declining catch-all is skipped, the next one takes the row.
    expect(glyphOf(service.fileIcon('/w/Makefile', 14))).toBe('span')
  })

  it('with no registration at all the chain is the host’s artwork', () => {
    const service = createBetterSidebarService(createSidebarStore())
    expect(glyphOf(service.fileIcon('/w/pkg.json', 14))).toBe(FileTypeIcon)
    expect(glyphOf(service.fileIcon('/w/main.ts', 14))).toBe(FileTypeIcon)
    expect(glyphOf(service.fileIcon('/w/Makefile', 14))).toBe(FileTypeIcon)
  })

  it('a throwing factory is skipped at every level (console.error, next link wins)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const service = createBetterSidebarService(createSidebarStore())
      service.registerFileIcon({ id: 'boom-md', exts: ['md'], icon: () => { throw new Error('boom') } })
      // Specific throws → falls to the builtin glyph.
      expect(glyphOf(service.fileIcon('/w/README.md', 14))).toBe(FileTypeIcon)
      service.registerFileIcon({ id: 'boom-all', exts: [], priority: 10, icon: () => { throw new Error('boom') } })
      // Catch-all throws → falls to the host's file-type artwork.
      expect(glyphOf(service.fileIcon('/w/Makefile', 14))).toBe(FileTypeIcon)
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('reserved folder exts never claim a real file named x.folder', () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerFileIcon({ id: 'folders', exts: ['folder', 'folder-open'], icon: marker })
    expect(service.matchFileIcon('/w/x.folder')).toBeUndefined()
    // The real file falls through to the host's artwork, not the folder glyph.
    expect(glyphOf(service.fileIcon('/w/x.folder', 14))).toBe(FileTypeIcon)
  })
})

describe('name matching (names / folderNames — the icon-theme half)', () => {
  it('a names rule claims the exact basename, case-insensitively', () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerFileIcon({ id: 'npm', names: ['package.json'], icon: marker })
    expect(service.matchFileIcon('/w/package.json')?.id).toBe('npm')
    expect(service.matchFileIcon('/w/Package.JSON')?.id).toBe('npm')
    expect(service.matchFileIcon('/w/pkg.json')).toBeUndefined()
  })

  it('a name rule outranks an extension rule and the built-in glyph', () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerFileIcon({ id: 'by-ext', exts: ['json'], icon: markerB })
    service.registerFileIcon({ id: 'by-name', names: ['package.json'], icon: marker })
    expect(service.matchFileIcon('/w/package.json')?.id).toBe('by-name')
    expect(glyphOf(service.fileIcon('/w/package.json', 14))).toBe('span')
    // Other json files still take the extension rule.
    expect(glyphOf(service.fileIcon('/w/tsconfig.json', 14))).toBe('b')
  })

  it('a folderNames rule claims only the directories it names, and outranks the reserved exts', () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerFileIcon({ id: 'all-dirs', exts: ['folder', 'folder-open'], icon: markerB })
    service.registerFileIcon({ id: 'named', folderNames: ['node_modules'], icon: marker })
    expect(service.matchFolderIcon(false, 'node_modules')?.id).toBe('named')
    expect(service.matchFolderIcon(false, 'NODE_MODULES')?.id).toBe('named')
    // An unnamed directory still takes the reserved-ext registration.
    expect(service.matchFolderIcon(false, 'src')?.id).toBe('all-dirs')
    // A descriptor with folderNames only never claims unnamed directories.
    const solo = createBetterSidebarService(createSidebarStore())
    solo.registerFileIcon({ id: 'named', folderNames: ['src'], icon: marker })
    expect(solo.matchFolderIcon(false, 'lib')).toBeUndefined()
    expect(glyphOf(solo.folderIcon('/w/lib', false, 14))).toBe(FileTypeIcon)
  })

  it('the folder factory receives the open flag so one descriptor renders both states', () => {
    const service = createBetterSidebarService(createSidebarStore())
    const seen: (boolean | undefined)[] = []
    service.registerFileIcon({
      id: 'stateful',
      folderNames: ['src'],
      icon: (_path, _size, open) => {
        seen.push(open)
        return open === true ? marker() : markerB()
      },
    })
    expect(glyphOf(service.folderIcon('/w/src', false, 14))).toBe('b')
    expect(glyphOf(service.folderIcon('/w/src', true, 14))).toBe('span')
    expect(seen).toEqual([false, true])
  })
})

describe('folderIcon resolver (registered folder/folder-open → the host folder glyph)', () => {
  it('unregistered directories show the builtin glyphs', () => {
    const service = createBetterSidebarService(createSidebarStore())
    expect(glyphOf(service.folderIcon('/w/src', false, 14))).toBe(FileTypeIcon)
    expect(glyphOf(service.folderIcon('/w/src', true, 14))).toBe(FileTypeIcon)
    expect(glyphOf(builtinFolderIcon(false, 14))).toBe(FileTypeIcon)
    expect(glyphOf(builtinFolderIcon(true, 14))).toBe(FileTypeIcon)
  })

  it('folder / folder-open registrations replace the dir glyphs (priority desc)', () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerFileIcon({ id: 'closed', exts: ['folder'], icon: marker })
    expect(glyphOf(service.folderIcon('/w/src', false, 14))).toBe('span')
    // The OPEN row is a separate reserved ext — still the builtin here.
    expect(glyphOf(service.folderIcon('/w/src', true, 14))).toBe(FileTypeIcon)
    service.registerFileIcon({ id: 'open', exts: ['folder-open'], icon: markerB })
    expect(glyphOf(service.folderIcon('/w/src', true, 14))).toBe('b')
    service.registerFileIcon({ id: 'closed-hi', exts: ['folder'], priority: 3, icon: markerB })
    // The higher-priority registration ('b') takes the closed row.
    expect(glyphOf(service.folderIcon('/w/src', false, 14))).toBe('b')
  })

  it('a catch-all registration never claims a directory', () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerFileIcon({ id: 'all', exts: [], icon: marker })
    expect(glyphOf(service.folderIcon('/w/src', false, 14))).toBe(FileTypeIcon)
  })

  it('a throwing folder factory falls back to the builtin glyph', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const service = createBetterSidebarService(createSidebarStore())
      service.registerFileIcon({ id: 'boom', exts: ['folder'], icon: () => { throw new Error('boom') } })
      expect(glyphOf(service.folderIcon('/w/src', false, 14))).toBe(FileTypeIcon)
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('built-in glyphs are the host’s own artwork', () => {
  it('every path goes through the host FileTypeIcon (it classifies, the host draws)', () => {
    for (const path of ['/w/README.md', '/w/logo.png', '/w/main.ts', '/w/pkg.json', '/w/data.xyzunknown', '/w/Makefile']) {
      expect(glyphOf(builtinFileIcon(path, 14)), path).toBe(FileTypeIcon)
    }
    expect(glyphOf(fallbackFileIcon(14))).toBe(FileTypeIcon)
  })

  it('hands the row’s path and size to the host classifier', () => {
    const props = (builtinFileIcon('/w/main.ts', 14) as ReactElement).props as { path: string; size: number }
    expect(props.path).toBe('/w/main.ts')
    expect(props.size).toBe(14)
  })

  it('renders the host folder category for directories', () => {
    const props = (builtinFolderIcon(false, 14) as ReactElement).props as { kind: string; size: number }
    expect(props.kind).toBe('folder')
    expect(props.size).toBe(14)
    // Both expansion states resolve to the host's folder drawing.
    expect(glyphOf(builtinFolderIcon(true, 14))).toBe(FileTypeIcon)
  })
})
