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
 * install validates main/client.main existence the same way).
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

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

/** The registry's strict id validation (manifest.ts / client-modules registerExternal): exactly two lowercase slash-separated segments. */
const ID_PATTERN = /^(?!node_modules\/)(?:@[a-z0-9][a-z0-9-.]*\/[a-z0-9][a-z0-9-.]*|[a-z0-9][a-z0-9-.]*\/[a-z0-9][a-z0-9-.]*)$/

/** Literal require() specifiers the frozen browser module table can answer. */
const CLIENT_REQUIRE_ALLOWED = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
])

/** The registered `__ModuleLoader__.load({ id })` value of a built client bundle. */
function bundleId(file: string): string {
  const source = readFileSync(resolve(ROOT, file), 'utf8')
  const match = /load\(\{\s*id:\s*"([^"]+)"/.exec(source)
  if (match === null) throw new Error(`${file} registers no __ModuleLoader__.load id — run \`pnpm build\` first`)
  return match[1]!
}

/** The lazy chunk bundle names (mirror of src/bundle-route.ts CHUNK_NAMES). */
const CHUNK_FILES = ['terminal', 'editor'].map(name => `lib/client-${name}.js`)

/** The global registry slot a built chunk script assigns (its factory key). */
function chunkSlot(file: string): string {
  const source = readFileSync(resolve(ROOT, file), 'utf8')
  const match = /globalThis\.__dshChunks__\["([a-z0-9-]+)"\]/.exec(source)
  if (match === null) throw new Error(`${file} assigns no globalThis.__dshChunks__ slot — run \`pnpm build\` first`)
  return match[1]!
}

describe('registry manifest consistency (dsh.plugin.json)', () => {
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
