/**
 * Host runtime-import guard: DSH Desktop serves profile plugins a prebuilt
 * module surface, and that surface does not necessarily carry every symbol the
 * published npm package exports. `@deepseek-ai/dsh-session` is the known case —
 * it exposes `SessionLogOffset` as a *type* (the branded-number declaration)
 * while the runtime stamp is absent, so a value import such as
 *
 *   import { SessionLogOffset } from '@deepseek-ai/dsh-session'
 *
 * fails ESM instantiation with "does not provide an export named
 * 'SessionLogOffset'" and takes the whole host half down with it (no fs, git,
 * terminal or jobs routes; the sidebar Files tab then only renders the
 * "nothing can view this" fallback). The branded number is compile-time only,
 * so host sources must import it with `import type` and cast at the use site.
 *
 * This spec pins that rule for every `@deepseek-ai/dsh-session` import under
 * `src/`. Tests may still value-import the symbol: the vitest tree installs the
 * full npm package, which does provide the runtime stamp.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SRC = resolve(ROOT, 'src')

/** The package whose plugin-facing surface is type-only for the listed symbols. */
const TYPE_ONLY_PACKAGE = '@deepseek-ai/dsh-session'

/** Every `.ts` / `.tsx` file under a directory, recursively. */
function collectSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...collectSources(full))
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full)
  }
  return out
}

/** Import statements that pull the package in without the `type` modifier. */
function valueImportsOf(source: string): string[] {
  const pattern = new RegExp(
    String.raw`^\s*import\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?['"]${TYPE_ONLY_PACKAGE.replace(/[/@.]/g, (c) => `\\${c}`)}['"]`,
    'gm',
  )
  return [...source.matchAll(pattern)].map((match) => match[0].trim())
}

describe('host runtime imports', () => {
  it(`never value-imports ${TYPE_ONLY_PACKAGE} from src/`, () => {
    const offenders: string[] = []
    for (const file of collectSources(SRC)) {
      for (const statement of valueImportsOf(readFileSync(file, 'utf8'))) {
        offenders.push(`${file.slice(ROOT.length + 1)}: ${statement}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('still imports the branded type it needs', () => {
    const source = readFileSync(resolve(SRC, 'sidechat-routes.ts'), 'utf8')
    expect(source).toContain(`import type { SessionEvent, SessionId, SessionLogOffset } from '${TYPE_ONLY_PACKAGE}'`)
    // The cast carries the brand; the runtime stamp is what the host surface lacks.
    expect(source).toContain('inheritedEventCount: seed.length as SessionLogOffset')
  })
})
