/**
 * Desktop-shell detection tests: URL stamps (dsh-desktop-mode/platform)
 * from the official Electron shell, the preload marker
 * (__DSH_DESKTOP_FILE_PATH__), and the win32 advanced overlay adaptation.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import './browser-globals.ts'
import { parseDesktopEnv, resetDesktopEnvForTests } from '../src/client/desktop-env.ts'

function setSearch(search: string): void {
  ;(window.location as { search: string }).search = search
}

beforeEach(() => {
  resetDesktopEnvForTests()
  delete (window as unknown as Record<string, unknown>).__DSH_DESKTOP_FILE_PATH__
  setSearch('/')
})

describe('parseDesktopEnv', () => {
  it('reports a plain browser page as non-desktop', () => {
    expect(parseDesktopEnv()).toEqual({ desktop: false, mode: null, platform: null, win32OverlayTop: 0 })
  })

  it('parses win32 advanced stamps with the 32px window-control overlay', () => {
    setSearch('?dsh-desktop-mode=advanced&dsh-desktop-platform=win32')
    const env = parseDesktopEnv()
    expect(env.desktop).toBe(true)
    expect(env.mode).toBe('advanced')
    expect(env.platform).toBe('win32')
    expect(env.win32OverlayTop).toBe(32)
  })

  it('parses darwin advanced stamps without an overlay (traffic lights are top-left)', () => {
    setSearch('?dsh-desktop-mode=advanced&dsh-desktop-platform=darwin')
    const env = parseDesktopEnv()
    expect(env.desktop).toBe(true)
    expect(env.platform).toBe('darwin')
    expect(env.win32OverlayTop).toBe(0)
  })

  it('parses compatibility mode as desktop with the native frame (no adaptation)', () => {
    setSearch('?dsh-desktop-mode=compatibility&dsh-desktop-platform=win32')
    const env = parseDesktopEnv()
    expect(env.desktop).toBe(true)
    expect(env.mode).toBe('compatibility')
    expect(env.win32OverlayTop).toBe(0)
  })

  it('detects the desktop preload marker even without URL stamps', () => {
    ;(window as unknown as Record<string, unknown>).__DSH_DESKTOP_FILE_PATH__ = { getPathForFile: () => '' }
    const env = parseDesktopEnv()
    expect(env.desktop).toBe(true)
    expect(env.mode).toBeNull()
    expect(env.win32OverlayTop).toBe(0)
  })

  it('ignores unknown mode values (exotic shells keep plain-browser semantics)', () => {
    setSearch('?dsh-desktop-mode=weird&dsh-desktop-platform=win32')
    expect(parseDesktopEnv().mode).toBeNull()
    expect(parseDesktopEnv().desktop).toBe(false)
  })

  it('memoizes across calls until the test hook resets', () => {
    setSearch('?dsh-desktop-mode=advanced&dsh-desktop-platform=win32')
    const first = parseDesktopEnv()
    setSearch('/')
    expect(parseDesktopEnv()).toBe(first)
    resetDesktopEnvForTests()
    expect(parseDesktopEnv().desktop).toBe(false)
  })
})
