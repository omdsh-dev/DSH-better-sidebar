/**
 * Desktop-shell detection tests: URL stamps (dsh-desktop-mode/platform)
 * from the official Electron shell, the preload marker
 * (__DSH_DESKTOP_FILE_PATH__), and the `dsh-desktop-titlebar-inset`
 * contract parameter. Geometry ADAPTATION is deliberately NOT here — the
 * strip resolution chain lives in titlebar-strip.ts (standard WCO first,
 * see wco.spec.ts), keeping this module a pure environment reporter.
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
  it('reports a plain browser page as non-desktop with no inset', () => {
    expect(parseDesktopEnv()).toEqual({ desktop: false, mode: null, platform: null, titlebarInset: 0 })
  })

  it('parses win32 advanced stamps (no overlay guess — geometry comes from WCO/preset)', () => {
    setSearch('?dsh-desktop-mode=advanced&dsh-desktop-platform=win32')
    const env = parseDesktopEnv()
    expect(env.desktop).toBe(true)
    expect(env.mode).toBe('advanced')
    expect(env.platform).toBe('win32')
    expect(env.titlebarInset).toBe(0)
  })

  it('parses darwin advanced stamps', () => {
    setSearch('?dsh-desktop-mode=advanced&dsh-desktop-platform=darwin')
    const env = parseDesktopEnv()
    expect(env.desktop).toBe(true)
    expect(env.platform).toBe('darwin')
    expect(env.titlebarInset).toBe(0)
  })

  it('parses compatibility mode as desktop with the native frame (no adaptation)', () => {
    setSearch('?dsh-desktop-mode=compatibility&dsh-desktop-platform=win32')
    const env = parseDesktopEnv()
    expect(env.desktop).toBe(true)
    expect(env.mode).toBe('compatibility')
    expect(env.titlebarInset).toBe(0)
  })

  it('detects the desktop preload marker even without URL stamps', () => {
    ;(window as unknown as Record<string, unknown>).__DSH_DESKTOP_FILE_PATH__ = { getPathForFile: () => '' }
    const env = parseDesktopEnv()
    expect(env.desktop).toBe(true)
    expect(env.mode).toBeNull()
    expect(env.titlebarInset).toBe(0)
  })

  it('ignores unknown mode values (exotic shells keep plain-browser semantics)', () => {
    setSearch('?dsh-desktop-mode=weird&dsh-desktop-platform=win32')
    expect(parseDesktopEnv().mode).toBeNull()
    expect(parseDesktopEnv().desktop).toBe(false)
  })

  it('reads the documented titlebar-inset contract parameter (clamped 0–120)', () => {
    setSearch('?dsh-desktop-mode=advanced&dsh-desktop-platform=win32&dsh-desktop-titlebar-inset=36')
    expect(parseDesktopEnv().titlebarInset).toBe(36)
    setSearch('?dsh-desktop-mode=advanced&dsh-desktop-titlebar-inset=200')
    resetDesktopEnvForTests()
    expect(parseDesktopEnv().titlebarInset).toBe(120)
    setSearch('?dsh-desktop-mode=advanced&dsh-desktop-titlebar-inset=-5')
    resetDesktopEnvForTests()
    expect(parseDesktopEnv().titlebarInset).toBe(0)
    setSearch('?dsh-desktop-mode=advanced&dsh-desktop-titlebar-inset=abc')
    resetDesktopEnvForTests()
    expect(parseDesktopEnv().titlebarInset).toBe(0)
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
