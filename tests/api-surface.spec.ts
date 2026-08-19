/**
 * Public API surface guard (v0.12.0+):
 * - The CLIENT-REACHABLE source graph stays free of Node.js types: the
 *   shipped `Context` (TabComponentProps / the cordis augmentation) must
 *   not leak `node:*` imports or the `Buffer` global into browser-only
 *   consumer builds. context-types.ts is the shared file — a regression
 *   here breaks external consumers with `skipLibCheck: false`.
 * - The version/features constants exist and are consistent (the detailed
 *   package.json lockstep assertion lives in service.spec.ts).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SIDEBAR_FEATURES, SIDEBAR_SERVICE_VERSION } from '../src/client/service.ts'

const ROOT = resolve(import.meta.dirname, '..')

/** The client-reachable source files (the declaration graph consumers pull). */
function clientGraphFiles(): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) {
        if (name !== 'chunks') walk(path)
      } else if (/\.(ts|tsx)$/.test(name)) {
        files.push(path)
      }
    }
  }
  walk(join(ROOT, 'src', 'client'))
  for (const extra of ['src/context-types.ts', 'src/html-route.ts', 'src/prefs-shared.ts']) {
    files.push(join(ROOT, extra))
  }
  return files
}

describe('public API surface (v0.12.0)', () => {
  it('the client-reachable graph imports no node:* modules', () => {
    const offenders = clientGraphFiles().filter(path => {
      const text = readFileSync(path, 'utf8')
      return /from\s+['"]node:/.test(text)
    })
    expect(offenders).toEqual([])
  })

  it('the client-reachable graph never references the Buffer global', () => {
    const offenders = clientGraphFiles().filter(path => {
      const text = readFileSync(path, 'utf8')
      return text.split('\n').some(line =>
        /\bBuffer\b/.test(line)
        && !/^\s*\*/.test(line)   // doc comments
        && !/^\s*\/\//.test(line) // line comments
        && !/\/\*/.test(line),    // block comment openers
      )
    })
    expect(offenders).toEqual([])
  })

  it('advertises the capability list and version (values come from service.ts)', () => {
    // Full releases are bare x.y.z; pre-releases (beta) carry -<tag>.<n>.
    expect(SIDEBAR_SERVICE_VERSION).toMatch(/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/)
    expect(SIDEBAR_FEATURES.length).toBeGreaterThanOrEqual(8)
    for (const feature of ['badge', 'tabLifecycle', 'updateTab', 'openFile', 'targetedOpen', 'stateSubscription', 'tabMeta', 'pluginSettings']) {
      expect(SIDEBAR_FEATURES).toContain(feature)
    }
  })
})
