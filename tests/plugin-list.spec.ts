/**
 * Built-in plugin catalog data-integrity tests (both files: the TAB
 * catalog in plugins-tabs.ts and the FILE-PREVIEWER catalog in
 * plugins-viewers.ts). Every entry must be installable as data — a unique
 * id (npm package name), a GitHub URL, a non-empty localized description
 * (string or () => string), and an install script that mentions the dsh
 * plugin CLI. The catalogs are the discovery surface of the two "add
 * plugin" modals; a malformed entry would break the install flow, so the
 * shape is pinned here.
 */
import { describe, expect, it } from 'vitest'
import { builtinTabPlugins } from '../src/client/plugins-tabs.ts'
import { builtinViewerPlugins } from '../src/client/plugins-viewers.ts'
import type { PluginEntry } from '../src/client/plugins-shared.ts'

/** Resolve an i18n-friendly string-or-function value (mirror of textOf). */
function textOf(value: string | (() => string)): string {
  return typeof value === 'function' ? value() : value
}

const catalogs: Array<[string, readonly PluginEntry[]]> = [
  ['tab catalog', builtinTabPlugins],
  ['viewer catalog', builtinViewerPlugins],
]

describe('builtin plugin catalogs', () => {
  it('the viewer catalog has the office plugin, the tab catalog has the sentinel plugin', () => {
    const ids = (list: readonly PluginEntry[]): string[] => list.map(p => p.id)
    expect(ids(builtinViewerPlugins)).toContain('@huanlin/dsh-plugin-better-sidebar-plugin-office')
    expect(ids(builtinTabPlugins)).toContain('@dsh-external/dsh-sentinel')
    expect(ids(builtinTabPlugins)).not.toContain('@huanlin/dsh-plugin-better-sidebar-plugin-office')
  })

  for (const [name, list] of catalogs) {
    describe(name, () => {
      it('every entry has a unique id (the npm package name)', () => {
        const ids = list.map(p => p.id)
        expect(new Set(ids).size).toBe(ids.length)
        for (const id of ids) {
          expect(id.length).toBeGreaterThan(0)
          expect(id).not.toContain(' ')
        }
      })

      it('every entry has a name, a GitHub URL, and an install script', () => {
        for (const entry of list) {
          expect(entry.name.length).toBeGreaterThan(0)
          expect(entry.url.startsWith('https://github.com/')).toBe(true)
          expect(entry.install.length).toBeGreaterThan(0)
          expect(entry.install).toContain('dsh plugin')
        }
      })

      it('every description resolves to a non-empty localized string', () => {
        for (const entry of list) {
          expect(textOf(entry.description).length).toBeGreaterThan(0)
        }
      })

      it('every install script starts at the DSH home (cd ~/.dsh) as the modal promises', () => {
        for (const entry of list) {
          expect(entry.install.startsWith('cd ~/.dsh')).toBe(true)
        }
      })
    })
  }
})
