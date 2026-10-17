/**
 * Registry manifest consistency spec: guards the plugin-registry release form
 * (`dsh.plugin.json`) against the build output and package.json, so the repo
 * cannot drift into an uninstallable / uneable state:
 * - `id` passes the registry's strict two-segment validation (native form),
 * - `version` stays in sync with package.json,
 * - the manifest entry files exist in the build output,
 * - the registry client bundle registers exactly the manifest id (the
 *   browser-side `arrive()` contract), and the official client bundle keeps
 *   the package-name id (the client-modules compose contract) — the two
 *   bundles must never be swapped.
 *
 * Reads the built lib/ output, so run `pnpm build` first (the registry
 * install validates main/client.main existence the same way). A missing
 * lib/ (fresh clone before the first build) skips the whole suite instead
 * of crashing on ENOENT.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { CHUNK_NAMES } from '../src/bundle-route.ts'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** The build output is present (tsdown emits the whole lib/ in one run). */
const libBuilt = existsSync(resolve(ROOT, 'lib/client.js'))
/** The HOST bundle is present (its relative imports are staged-file requirements). */
const hostBuilt = existsSync(resolve(ROOT, 'lib/index.js'))

if (!libBuilt) {
  console.warn('[manifest-consistency] lib/ build output missing — run `pnpm build` first; skipping this suite')
}

/** The registry manifest face this spec touches (mirror of the registry's PluginManifest). */
interface PluginManifest {
  id: string
  version: string
  main: string
  description?: string
  engines?: { dsh?: string }
  contributes?: { tools?: string[]; skills?: string[] }
  client?: { main?: string; inject?: string[]; immediately?: boolean }
}

interface PackageJson {
  name: string
  version: string
}

const manifest = JSON.parse(readFileSync(resolve(ROOT, 'dsh.plugin.json'), 'utf8')) as PluginManifest
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as PackageJson

/**
 * The THIRD-PARTY registry channel's id rule (the community market validates
 * `dsh.plugin.json`'s id itself): exactly two lowercase slash-separated
 * segments.
 *
 * `dsh.plugin.json` is NOT a DSH contract — no DSH version reads it, and the
 * official channel is `package.json`'s `dsh.bundle.patch` + `dsh.client` +
 * `exports["./client"]` (asserted in tests/plugin-shape.spec.ts). This spec
 * guards the registry channel's own shape so publishing there cannot break
 * silently.
 */
const ID_PATTERN = /^(?!node_modules\/)(?:@[a-z0-9][a-z0-9-.]*\/[a-z0-9][a-z0-9-.]*|[a-z0-9][a-z0-9-.]*\/[a-z0-9][a-z0-9-.]*)$/

/** Literal require() specifiers the frozen browser module table can answer. */
const CLIENT_REQUIRE_ALLOWED = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
])

/** The registered `__ModuleLoader__.load({ id })` value of a built client bundle. */
function bundleId(file: string): string {
  const source = readFileSync(resolve(ROOT, file), 'utf8')
  const match = /load\(\{\s*id:\s*"([^"]+)"/.exec(source)
  if (match === null) throw new Error(`${file} registers no __ModuleLoader__.load id — run \`pnpm build\` first`)
  return match[1]!
}

/**
 * The lazy chunk bundles, DERIVED from the host route's registry (never
 * hand-mirrored: the hand-written list drifted once — `locale` was missing
 * from both this list and a later `package.json#files` cleanup, so a
 * published tarball could not serve it).
 */
const CHUNK_FILES = CHUNK_NAMES.map(name => `lib/client-${name}.js`)

/** Whether one `package.json#files` entry covers a built artifact path. */
function publishListCovers(entry: string, file: string): boolean {
  if (entry === file) return true
  if (!entry.includes('*')) return false
  // Only the `lib/client-*.js` shape is in play; a regex built from the entry
  // is enough (escape everything else).
  const pattern = new RegExp(`^${entry.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`)
  return pattern.test(file)
}

/** The global registry slot a built chunk script assigns (its factory key). */
function chunkSlot(file: string): string {
  const source = readFileSync(resolve(ROOT, file), 'utf8')
  const match = /globalThis\.__dshChunks__\["([a-z0-9-]+)"\]/.exec(source)
  if (match === null) throw new Error(`${file} assigns no globalThis.__dshChunks__ slot — run \`pnpm build\` first`)
  return match[1]!
}

/**
 * The staging list of `scripts/package-registry.mjs`, as repo-relative POSIX
 * paths. Read as source text because the script copies at module scope (it
 * cannot be imported without performing the staging).
 */
function stagedRegistryFiles(): Set<string> {
  const script = readFileSync(resolve(ROOT, 'scripts/package-registry.mjs'), 'utf8')
  const start = script.indexOf('const files = [')
  if (start < 0) throw new Error('scripts/package-registry.mjs declares no `const files = [` list')
  const block = script.slice(start, script.indexOf(']', start))
  // Entries are one quoted path per line. Matching line-anchored (instead of
  // every quote pair in the block) keeps apostrophes inside the explanatory
  // comments from being parsed as entries.
  return new Set([...block.matchAll(/^\s*'([^']+)',?\s*$/gm)].map(match => match[1]!))
}

/**
 * The staging-list half that does NOT need a build: the host bundle
 * externalizes the shared ClueError class onto `./clues.js`, so a staging list
 * without it produces an installed plugin that cannot even be imported. The
 * build-dependent test below derives the full requirement from lib/index.js;
 * this one keeps the guard active on a fresh clone (`pnpm test` before the
 * first build).
 */
describe('registry staging list (static)', () => {
  it('stages the externalized clue error module', () => {
    expect(stagedRegistryFiles().has('lib/clues.js')).toBe(true)
  })
})

describe.skipIf(!hostBuilt)('registry staging covers the host bundle imports', () => {
  it('stages every relative import of lib/index.js (the installed copy must load)', () => {
    const source = readFileSync(resolve(ROOT, 'lib/index.js'), 'utf8')
    // The host bundle is ESM: `import … from "./x.js"`, `export … from`, and
    // lazy `import("./x.js")` all become runtime module loads of the staged
    // file. A path left out of the registry list is ERR_MODULE_NOT_FOUND in
    // the installed plugin — exactly the bug this test was added for.
    const specs = [...source.matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)]
      .map(match => match[1]!)
    expect(specs, 'lib/index.js has no relative imports?').toContain('./clues.js')
    const staged = stagedRegistryFiles()
    for (const spec of new Set(specs)) {
      const target = relative(ROOT, resolve(ROOT, 'lib', spec)).replaceAll('\\', '/')
      expect(
        staged.has(target),
        `${target} (imported by lib/index.js as ${spec}) is not staged by scripts/package-registry.mjs`,
      ).toBe(true)
    }
  })
})

describe.skipIf(!libBuilt)('registry manifest consistency (dsh.plugin.json)', () => {
  it('id is a valid two-segment registry id (native form)', () => {
    expect(manifest.id).toMatch(ID_PATTERN)
  })

  it('version matches package.json', () => {
    expect(manifest.version).toBe(pkg.version)
  })

  it('main and client.main exist in the build output', () => {
    expect(existsSync(resolve(ROOT, manifest.main))).toBe(true)
    expect(manifest.client?.main).toBeDefined()
    expect(existsSync(resolve(ROOT, manifest.client!.main!))).toBe(true)
  })

  it('the registry bundle registers exactly the manifest id and the official bundle the package name (no swap)', () => {
    const registryId = bundleId(manifest.client!.main!)
    expect(registryId).toBe(manifest.id)
    expect(bundleId('lib/client.js')).toBe(pkg.name)
    expect(registryId).not.toBe(pkg.name)
  })

  it('the lazy chunk bundles exist and assign their global registry slots (served by /sidebar/bundle)', () => {
    for (const file of CHUNK_FILES) {
      expect(existsSync(resolve(ROOT, file)), file).toBe(true)
      expect(chunkSlot(file), file).toBe(file.slice('lib/client-'.length, -'.js'.length))
    }
  })

  it('every chunk is covered by package.json#files (a published tarball must serve it)', () => {
    const files = (pkg as { files?: string[] }).files ?? []
    for (const file of CHUNK_FILES) {
      expect(
        files.some(entry => publishListCovers(entry, file)),
        `${file} is not covered by package.json#files (${files.join(', ')})`,
      ).toBe(true)
    }
  })

  it('every chunk is staged by scripts/package-registry.mjs (the registry channel ships its own file list)', () => {
    // The community-registry channel installs the staged `registry/` tree
    // wholesale, and /sidebar/bundle reads the chunk from THAT copy — a chunk
    // missing from the staging list 404s there exactly like one missing from
    // package.json#files does on npm. The list is read as source text because
    // the script performs its copies at module scope (it cannot be imported).
    const script = readFileSync(resolve(ROOT, 'scripts/package-registry.mjs'), 'utf8')
    const start = script.indexOf('const files = [')
    expect(start, 'scripts/package-registry.mjs declares no `const files = [` list').toBeGreaterThan(-1)
    const staged = script.slice(start, script.indexOf(']', start))
    for (const file of CHUNK_FILES) {
      expect(staged.includes(`'${file}'`), `${file} is not staged by scripts/package-registry.mjs`).toBe(true)
    }
  })

  it('client bundles require only frozen module-table entries', () => {
    for (const file of ['lib/client.js', manifest.client!.main!, ...CHUNK_FILES]) {
      const source = readFileSync(resolve(ROOT, file), 'utf8')
      // Exclude method calls such as `freeModule.require("util")`; only the
      // loader factory's lexical require() is constrained by the module table.
      const required = [...source.matchAll(/(^|[^.$\w])require\("([^"]+)"\)/gm)].map(match => match[2]!)
      expect([...new Set(required)].filter(id => !CLIENT_REQUIRE_ALLOWED.has(id)), file).toEqual([])
    }
  })

  it('contributes declares no tools or skills (the host half registers none)', () => {
    expect(manifest.contributes?.tools).toEqual([])
    expect(manifest.contributes?.skills).toEqual([])
  })
})
