/**
 * Icon-export guard: DSH 0.1.7 renamed the whole `ui-primitives` icon family
 * from size-suffixed names (`IconCloseFill14`) to weight-suffixed ones
 * (`IconCloseFillRegular` / `…Medium`), deleting the old names outright.
 *
 * Missing exports do not fail at load time here — the client bundle is CJS
 * with `ui-primitives` external, so a missing named export reads as
 * `undefined` and React throws "Element type is invalid" at RENDER time. That
 * is a failure mode no other spec in this repository observes, so this one
 * pins the contract directly: every icon symbol the plugin imports from the
 * package must actually be exported by the installed version.
 *
 * `pnpm typecheck` catches the same thing from the type side; this stays as
 * the runtime-side witness, and as a guard for the symbols that reach the
 * bundle through a re-export rather than a direct import.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

/** The specifier whose named exports the plugin depends on. */
const PACKAGE = '@deepseek-ai/dsh-client-ui-primitives'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * Every TypeScript source under the given roots.
 *
 * Deliberately a plain readdir walk rather than a ripgrep call: this spec used
 * to shell out to `rg`, which exists on a developer machine but NOT on the CI
 * runners, so the whole file failed to COLLECT there (`spawnSync rg ENOENT`)
 * while passing locally. The scan is a few hundred small files.
 * @param roots - directories relative to the repository root.
 * @returns absolute file paths, sorted for a stable failure output.
 */
function sourceFiles(roots: readonly string[]): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry.name)) found.push(path)
    }
  }
  for (const root of roots) walk(resolve(ROOT, root))
  return found.sort()
}

/**
 * Every value symbol the repository imports from the primitives package.
 * Type-only imports are ignored: they are erased before the bundle is built
 * and therefore cannot become a missing runtime export.
 * @returns the imported symbol names, deduplicated.
 */
function importedSymbols(): string[] {
  const names = new Set<string>()
  for (const file of sourceFiles(['src', 'tests'])) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(
      new RegExp(`import\\s+(type\\s+)?\\{([^}]*)\\}\\s+from\\s+['"]${PACKAGE}['"]`, 'g'),
    )) {
      // `import type { … }` imports nothing at runtime.
      if (match[1] !== undefined) continue
      for (const raw of match[2]!.split(',')) {
        const name = raw.trim().replace(/^type\s+/, '')
        if (name === '' || name.startsWith('type ')) continue
        // A per-specifier `type` marker has no runtime counterpart either.
        if (/^type\s/.test(raw.trim())) continue
        names.add(name)
      }
    }
  }
  return [...names].sort()
}

describe('ui-primitives exports', () => {
  const imported = importedSymbols()
  const exported = new Set(Object.keys(primitives as Record<string, unknown>))

  it('finds the plugin\'s import surface at all', () => {
    // A guard on the guard: a regex that silently stopped matching would make
    // the assertion below vacuously true.
    expect(imported.length).toBeGreaterThan(20)
    expect(imported).toContain('FileTypeIcon')
    expect(imported).toContain('MarkdownText')
  })

  it('still exports every icon symbol the plugin imports', () => {
    const missing = imported.filter(name => name.startsWith('Icon') && !exported.has(name))
    expect(missing, `these symbols are imported but not exported by ${PACKAGE}: ${missing.join(', ')}`).toEqual([])
  })

  it('still exports every other value symbol the plugin imports', () => {
    const missing = imported.filter(name => !name.startsWith('Icon') && !exported.has(name))
    expect(missing, `these symbols are imported but not exported by ${PACKAGE}: ${missing.join(', ')}`).toEqual([])
  })

  it('ships no icon whose name still carries the retired size suffix', () => {
    // The rename was wholesale: a `…14` / `…16` name reappearing would mean
    // upstream re-introduced the old scheme and the migration above is stale.
    const sized = [...exported].filter(name => /^Icon[A-Za-z]+(10|12|14|16|20|24)$/.test(name))
    expect(sized).toEqual([])
  })
})
