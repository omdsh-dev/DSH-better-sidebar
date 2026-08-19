/**
 * Lazy chunk loader for the client bundle. The heavy preview/terminal
 * libraries (CodeMirror, xterm — the editor/terminal stacks, several MB)
 * live in separate build-time bundles (`lib/client-<name>.js`) fetched only
 * on first use of the feature that needs them, so startup downloads/parses
 * only the ~1MB core bundle. (The office stack — Univer / docx-preview /
 * pptx-renderer — is no longer bundled here: Office previews moved to the
 * recommended office plugin, see plugins-viewers.ts.)
 *
 * How a chunk script works (see tsdown.config.ts chunkBundle):
 *
 *   globalThis.__dshChunks__ = globalThis.__dshChunks__ || {};
 *   globalThis.__dshChunks__["terminal"] = (require) => { ...exports };
 *
 * The script registers its factory on a plugin-owned global registry (NOT
 * through window.__ModuleLoader__.load — the module loader's import() only
 * resolves seed words, shell-own modules, registered factories, and boot
 * graph rows; a chunk id is none of those, so resolution would be version-
 * dependent). Materialization is plugin-owned:
 *
 * 1. inject <script src="/sidebar/bundle/<name>.js"> (classic same-origin
 *    script; the official /plugins/<id>/client.js route cannot serve
 *    arbitrary file names, so the plugin's own host route serves the chunks),
 * 2. read the factory from the global registry,
 * 3. call it with a require that resolves the platform externals through
 *    `__DSH_MODULES__.import(spec)` — the seed-word branch, the one part of
 *    the module system that is stable across versions.
 *
 * Caching contract (three layers, each with a failure path):
 * - In-memory: one in-flight promise per chunk, memoized until
 *   {@link resetChunks}; a failed load removes its entry so the next call
 *   retries from scratch.
 * - Script execution: each re-execution overwrites the global registry slot
 *   (assignment, never registration) — no "duplicate factory registration"
 *   class of errors; a failed materialization clears the cache so the retry
 *   re-injects and re-executes.
 * - HTTP: the bundle route revalidates every request (`cache-control:
 *   no-cache` + ETag, 304 when unchanged), so page refreshes and HMR
 *   re-activations never re-download a multi-MB chunk that did not change.
 *
 * HMR: each plugin activation calls {@link resetChunks}, which drops the
 * in-memory cache (and any test registry), so a hot-reloaded core bundle
 * re-fetches and re-executes the current chunk scripts on the next lazy
 * open. Chunk-only source edits still need a manual page refresh (the HMR
 * poll watches only client.js).
 */
export type ChunkName = 'terminal' | 'editor' | 'mermaid'

/** The module exports a chunk factory provides (namespace-ish record). */
export type ChunkExports = Record<string, unknown>

/** A chunk factory: (require) => exports (the chunk's CJS closure shape). */
type ChunkFactory = (require: (spec: string) => unknown) => ChunkExports

/**
 * The platform externals a chunk bundle may require (mirror of
 * CLIENT_EXTERNALS in tsdown.config.ts — the chunk builds keep these
 * external and the loader resolves them here). A superset is safe: the
 * require only answers what the chunk actually asks for.
 */
export const CHUNK_EXTERNALS: readonly string[] = [
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
]

/** Chunk script endpoint served by the plugin host half (src/bundle-route.ts). */
const CHUNK_URL = (name: ChunkName): string => `/sidebar/bundle/${name}.js`

/** The client module system surface this loader needs (window.__DSH_MODULES__). */
interface ChunkModuleSystem {
  import(specifier: string): Promise<unknown>
}

/** Resolve the shell-installed module system (set before any plugin activates). */
function moduleSystem(): ChunkModuleSystem | undefined {
  return (globalThis as { __DSH_MODULES__?: ChunkModuleSystem }).__DSH_MODULES__
}

/** The plugin-owned chunk factory registry the chunk scripts populate. */
interface ChunkRegistry {
  [name: string]: ChunkFactory | undefined
}

function chunkRegistry(): ChunkRegistry {
  const g = globalThis as { __dshChunks__?: ChunkRegistry }
  return g.__dshChunks__ ??= {}
}

/** Script-load hook; tests replace it with a stub (the default needs a real DOM + network). */
export type ChunkScriptLoader = (src: string) => Promise<void>

const defaultScriptLoader: ChunkScriptLoader = (src) => new Promise((resolve, reject) => {
  const el = document.createElement('script')
  el.async = true
  el.src = src
  el.addEventListener('load', () => {
    el.remove()
    resolve()
  }, { once: true })
  el.addEventListener('error', () => {
    el.remove()
    reject(new Error(`[dsh-better-sidebar] chunk script ${src} failed to load`))
  }, { once: true })
  document.head.append(el)
})

let scriptLoader: ChunkScriptLoader = defaultScriptLoader

/** Test hook: replace the chunk-script loader (pass null to restore the default). */
export function setChunkScriptLoaderForTests(loader: ChunkScriptLoader | null): void {
  scriptLoader = loader ?? defaultScriptLoader
}

/** Test/dev hook: resolve a chunk without fetching a script (e.g. vitest). */
const testLoaders = new Map<ChunkName, () => Promise<ChunkExports>>()
export function registerChunkForTests(name: ChunkName, loader: () => Promise<ChunkExports>): void {
  testLoaders.set(name, loader)
}

/** Memoized externals require, resolved once per page from the seed table. */
let externalsRequire: ((spec: string) => unknown) | undefined

async function buildExternalsRequire(modules: ChunkModuleSystem): Promise<(spec: string) => unknown> {
  if (externalsRequire !== undefined) return externalsRequire
  // Per-spec tolerance: a spec the running DSH version cannot resolve (e.g.
  // the runtime/client exemption row) stays unresolved until a chunk
  // actually requires it — only then it is a loud error.
  const entries = await Promise.all(CHUNK_EXTERNALS.map(async (spec) => {
    try {
      return [spec, await modules.import(spec)] as const
    } catch {
      return [spec, undefined] as const
    }
  }))
  const table = new Map<string, unknown>(entries)
  externalsRequire = (spec: string): unknown => {
    if (!table.has(spec)) {
      // Single quotes: the bundle-consistency scan regexes for require("...")
      // lexical calls — a double-quoted literal here would trip it.
      throw new Error(`[dsh-better-sidebar] chunk require('${spec}') missed the module table`)
    }
    return table.get(spec)
  }
  return externalsRequire
}

/** In-flight/memoized chunk loads; a failure removes its entry so a retry re-fetches. */
const cache = new Map<ChunkName, Promise<ChunkExports>>()

/**
 * Load (once) and materialize a lazy chunk, returning its module exports.
 * Concurrent callers share one in-flight load; a failure clears the cache
 * entry so the next call retries (the script re-executes and overwrites its
 * global registry slot — assignments are idempotent).
 * @param name - the chunk to load.
 */
export function loadChunk(name: ChunkName): Promise<ChunkExports> {
  const cached = cache.get(name)
  if (cached !== undefined) return cached
  const task = (async (): Promise<ChunkExports> => {
    const test = testLoaders.get(name)
    if (test !== undefined) return test()
    const modules = moduleSystem()
    if (modules === undefined) {
      throw new Error(`[dsh-better-sidebar] chunk "${name}": client module system unavailable`)
    }
    await scriptLoader(CHUNK_URL(name))
    const factory = chunkRegistry()[name]
    if (typeof factory !== 'function') {
      throw new Error(`[dsh-better-sidebar] chunk "${name}" script did not register its factory`)
    }
    const require = await buildExternalsRequire(modules)
    return factory(require)
  })()
  cache.set(name, task)
  void task.catch(() => { cache.delete(name) })
  return task
}

/**
 * Drop all chunk state for a fresh plugin activation (HMR-safe): clear the
 * in-memory cache and any test-registry entries, so the next lazy open
 * re-fetches and re-executes the current chunk scripts (the registry slots
 * are overwritten by the re-execution — no cleanup needed).
 */
export function resetChunks(): void {
  cache.clear()
  testLoaders.clear()
  externalsRequire = undefined
}
