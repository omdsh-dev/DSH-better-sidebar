/**
 * Reveal-in-file-manager command mapping (pure, platform-injected) — the
 * cross-platform launcher behind the explorer's "Reveal in File Manager"
 * context-menu action. The platform is injected so every branch is asserted
 * on ANY host (macOS CI, Linux, Windows).
 */
import { describe, expect, it } from 'vitest'
import { revealCommandFor } from '../src/reveal.ts'

describe('reveal in file manager (platform mapping)', () => {
  it('darwin selects the path in Finder via `open -R`', () => {
    expect(revealCommandFor('/a/b/file.txt', false, 'darwin')).toEqual({
      cmd: 'open',
      args: ['-R', '/a/b/file.txt'],
    })
    // isDir is irrelevant for `open -R` (it selects both files and folders).
    expect(revealCommandFor('/a/b', true, 'darwin')).toEqual({ cmd: 'open', args: ['-R', '/a/b'] })
  })

  it('win32 selects the path in File Explorer via `explorer /select,`', () => {
    expect(revealCommandFor('C:\\a\\b\\file.txt', false, 'win32')).toEqual({
      cmd: 'explorer.exe',
      args: ['/select,C:\\a\\b\\file.txt'],
    })
    // Directories are selected too ("Reveal in File Explorer" on Windows).
    expect(revealCommandFor('C:\\a\\b', true, 'win32')).toEqual({
      cmd: 'explorer.exe',
      args: ['/select,C:\\a\\b'],
    })
  })

  it('linux opens the containing folder for a file (no portable select flag)', () => {
    expect(revealCommandFor('/a/b/file.txt', false, 'linux')).toEqual({
      cmd: 'xdg-open',
      args: ['/a/b'],
    })
  })

  it('linux opens the directory itself for a directory', () => {
    expect(revealCommandFor('/a/b', true, 'linux')).toEqual({
      cmd: 'xdg-open',
      args: ['/a/b'],
    })
  })
})
