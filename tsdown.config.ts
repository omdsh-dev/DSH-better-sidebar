/**
 * tsdown build for dsh-better-sidebar: the host-half lib (lib/index.js and
 * the lib/invariant.js companion, ESM node) plus the two browser client
 * bundles (lib/client.js and lib/client-registry.js, CJS closure factory) —
 * one per install channel:
 *
 * - `lib/client.js` serves the official profile channel, registering with
 *   the package-name id `dsh-better-sidebar` (the client-modules compose
 *   keys on the package name; keep it in sync with package.json `name`),
 * - `lib/client-registry.js` serves the plugin-registry channel
 *   (dsh.plugin.json), registering with the manifest id
 *   `dsh-external/dsh-better-sidebar` (the registry browser-side `arrive()`
 *   check requires bundle id === plugin id).
 *
 * Both bundles replicate the official DSH client-bundle preset
 * (packages/client/tsdown.client.ts) and are compiled from the same
 * src/client/index.tsx source — only the registered id and the output file
 * name differ, so they cannot drift:
 * - externals resolve through the loader module table at runtime (the
 *   PLATFORM_MODULES seed list from apps/web's platform.ts, plus the
 *   runtime/client exemption),
 * - everything else is inlined into the bundle (xterm, clsx, ...),
 * - the purity gate rejects any other @deepseek-ai value import: cross-plugin
 *   collaboration goes through cordis services, never value imports,
 * - CSS Modules compile to hashed class maps and inject <style data-plugin>
 *   tags at factory execution,
 * - each artifact registers itself via window.__ModuleLoader__.load({id,
 *   factory}) with the (require) => exports CJS closure shape.
 *
 * Lazy chunks (lib/client-<name>.js): the heavy preview/terminal libraries
 * (CodeMirror, xterm) build as two standalone chunk bundles
 * (src/client/chunks/<name>.tsx), shared by both channels. Each script
 * assigns its factory to the plugin-owned global registry
 * (globalThis.__dshChunks__) and is fetched by
 * the client on first use from the plugin's own /sidebar/bundle route —
 * chunks deliberately do NOT go through the module loader (see
 * src/client/chunk-loader.ts). `codeSplitting: false` keeps every chunk a
 * single script; the core client.js must never statically import a chunks/
 * entry.
 *
 * Types ship from lib/types (tsc -p tsconfig.build.json), not from tsdown.
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve as resolvePath, sep } from 'node:path'
import { builtinModules, createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

const require = createRequire(import.meta.url)

/** Node builtins must never survive into the browser module-loader factory. */
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map(id => `node:${id}`),
])

/** Module specifiers the web shell shares into the frozen module table (the official PLATFORM_MODULES list, plus the runtime/client exemption). */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]

/**
 * react-icons' exports map lists `require` BEFORE `import`, so the shared
 * conditionNames resolve the unshakeable CJS entry and the whole icon set
 * lands in the core bundle (~6.4 MB extra). Pin the two sets the client
 * uses to their ESM entries, which tree-shake down to the imported icons.
 */
const reactIconsRoot = dirname(dirname(require.resolve('react-icons/lib')))
const REACT_ICONS_ESM_ALIAS = {
  'react-icons/si': join(reactIconsRoot, 'si/index.mjs'),
  'react-icons/vsc': join(reactIconsRoot, 'vsc/index.mjs'),
}

/**
 * Wire/type layers a client bundle may inline (mirror of the official
 * INLINE_SAFE list): browser-safe contract surfaces with no runtime identity
 * to share. Everything else under @deepseek-ai/* is either a module-table
 * entry (external) or a leak the purity gate rejects.
 */
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|session|llm|tools|brand)(\/|$)/

/** Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline. */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

const REPOSITORY_ROOT = fileURLToPath(new URL('.', import.meta.url))

/** The style-injection prologue shared by module css and plain css loads. */
function injectTag(pluginId: string, fileId: string, cssText: string): string {
  const tagId = `${pluginId}/${basename(fileId)}`
  return [
    `const css = ${JSON.stringify(cssText)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
    `  const tag = document.createElement('style');`,
    `  tag.dataset.plugin = ${JSON.stringify(pluginId)};`,
    `  tag.dataset.pluginCss = tagId;`,
    `  tag.textContent = css;`,
    `  document.head.appendChild(tag);`,
    `}`,
  ].join('\n')
}

/** Rebase a physical lib-relative source onto the repository-shaped URL tree. */
function browserSourcePath(source: string, sourcemapPath: string): string {
  if (!source.startsWith('.')) return source
  const physicalSource = resolvePath(dirname(sourcemapPath), source)
  const repositoryPath = relative(REPOSITORY_ROOT, physicalSource).split(sep).join('/')
  return `../../../${repositoryPath}`
}

/**
 * One client bundle build for a plugin id. The same src/client/index.tsx is
 * compiled twice with only the registered id and the output file name
 * differing: the official channel uses the package name (`dsh-better-sidebar`)
 * and the registry channel uses the manifest id
 * (`dsh-external/dsh-better-sidebar`).
 * @param pluginId - the `__ModuleLoader__.load({ id })` value and the
 *   data-plugin style-tag prefix of this bundle.
 * @param entryFile - the output file name under lib/.
 */
function clientBundle(pluginId: string, entryFile: string): UserConfig {
  return {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
      // No bundled chunk uses import.meta.resolve; keep the stub so a stray
      // reference cannot resolve to Node's loader (browser CJS has none).
      'import.meta.resolve': 'undefined',
    },
    // CJS output otherwise makes some transitive packages resolve their
    // Node entry even though this bundle runs in the browser. Keep browser
    // conditional exports authoritative for both source import() and
    // generated require() edges.
    inputOptions: {
      resolve: {
        conditionNames: ['browser', 'import', 'require', 'default'],
        alias: REACT_ICONS_ESM_ALIAS,
      },
    },
    // External wins for module-table entries; every other dependency inlines.
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    plugins: [purityGatePlugin(), makeCssPlugin(pluginId)],
    outputOptions: {
      entryFileNames: entryFile,
      sourcemapPathTransform: browserSourcePath,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {`,
      footer: `return module.exports; } });`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      // The CJS wrapper factory's `require` only resolves module-table entries
      // (react, cordis, ...); it cannot load relative chunk URLs in the browser.
      // Disable code splitting so every artifact is one script (the lazy chunk
      // files themselves are separate bundles — see chunkBundle below).
      codeSplitting: false,
    },
  }
}

/**
 * One lazy chunk bundle: a heavy feature slice of the client built as a
 * standalone single script (lib/client-<name>.js), fetched by the client on
 * first use through the plugin's /sidebar/bundle route. The core bundle must
 * never statically import the chunk entry.
 *
 * Chunks do NOT register with window.__ModuleLoader__: the module loader's
 * import() resolves seed words / shell-own modules / registered factories /
 * boot graph rows, and a chunk id is none of those — resolution would be
 * version-dependent. Instead each script assigns its CJS factory to the
 * plugin-owned global registry `globalThis.__dshChunks__[<name>]`, and the
 * loader (src/client/chunk-loader.ts) materializes it with a require built
 * from the module table's seed words.
 *
 * Chunk css tags use the constant plugin id `dsh-better-sidebar` (matching
 * the official channel; the registry channel re-injects an identical copy
 * of the shared module css — same content, no functional impact).
 * @param name - chunk name; entry src/client/chunks/<name>.tsx, output
 *   lib/client-<name>.js. Keep in sync with CHUNK_NAMES in src/bundle-route.ts.
 */
function chunkBundle(name: string): UserConfig {
  return {
    entry: { [name]: `src/client/chunks/${name}.tsx` },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
      'import.meta.resolve': 'undefined',
    },
    inputOptions: {
      resolve: {
        conditionNames: ['browser', 'import', 'require', 'default'],
      },
    },
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    plugins: [
      purityGatePlugin(),
      makeCssPlugin('dsh-better-sidebar'),
      ...(name === 'mermaid' ? [mermaidChunkAliases()] : []),
    ],
    outputOptions: {
      entryFileNames: `client-${name}.js`,
      sourcemapPathTransform: browserSourcePath,
      banner: `globalThis.__dshChunks__ = globalThis.__dshChunks__ || {}; globalThis.__dshChunks__[${JSON.stringify(name)}] = (require) => {`,
      footer: 'return module.exports; };',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      codeSplitting: false,
    },
  }
}

/** A rolldown plugin as tsdown's config accepts it (contextual `this` for load/resolveId). */
type BuildPlugin = NonNullable<UserConfig['plugins']>

/**
 * Mermaid-chunk-only alias: pin uuid's BROWSER entry. The mermaid core
 * (mindmap definition) imports the bare `uuid` specifier, which rolldown
 * resolves to uuid's node entry — its dist-node modules import
 * `node:crypto` and trip the client purity gate. The browser entry
 * (uuid/dist/index.js, Web Crypto based) carries no Node builtins, so alias
 * the specifier there instead of special-casing the gate. Resolved relative
 * to mermaid's own dependency tree (pnpm/npm layout agnostic).
 */
function mermaidChunkAliases(): BuildPlugin {
  const uuidBrowserEntry = resolvePath(
    dirname(require.resolve('uuid/package.json', { paths: [dirname(require.resolve('mermaid/package.json'))] })),
    'dist/index.js',
  )
  return {
    name: 'dsh-mermaid-uuid-browser-alias',
    resolveId(source: string) {
      if (source === 'uuid') return uuidBrowserEntry
      return null
    },
  }
}

/** The shared client-bundle purity gate (see the clientBundle doc). */
function purityGatePlugin(): BuildPlugin {
  return {
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (NODE_BUILTINS.has(source)) {
        throw new Error(
          `client bundle purity: Node builtin "${source}" cannot run in the browser module table — `
          + 'select the dependency browser export or add an explicit browser implementation',
        )
      }
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.includes(source)) return null // platform module: external wins
      if (INLINE_SAFE.test(source)) return null // wire/type layer: inline is the point
      throw new Error(
        `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS) and not an inline-safe wire layer — `
        + 'cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports are erased and never reach this gate)',
      )
    },
  }
}

/** The shared CSS-inline virtual-module plugin (one <style data-plugin> per file). */
function makeCssPlugin(pluginId: string): BuildPlugin {
  return {
    name: 'dsh-css-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.css')) return null
      // Relative/absolute paths resolve against the importer; bare
      // specifiers (e.g. '@xterm/xterm/css/xterm.css') resolve from the package.
      let abs: string
      if (source.startsWith('.') || source.startsWith('/') || /^[A-Za-z]:[\\/]/.test(source)) {
        abs = importer === undefined ? source : resolvePath(dirname(importer), source)
      } else {
        abs = require.resolve(source)
      }
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      // CSS Modules (x.module.css) become hashed class maps; plain css
      // (xterm's stylesheet) is inlined verbatim.
      if (fileId.endsWith('.module.css')) {
        const { code, exports: cssExports } = transform({
          filename: fileId,
          code: source,
          cssModules: { pattern: `[hash]_[local]` },
          minify: true,
        })
        const classMap: Record<string, string> = {}
        for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
        return [
          injectTag(pluginId, fileId, code.toString()),
          `export default ${JSON.stringify(classMap)};`,
        ].join('\n')
      }
      return [
        injectTag(pluginId, fileId, source.toString('utf8')),
        'export default "";',
      ].join('\n')
    },
  }
}

/** The lazy chunk names (keep in sync with src/bundle-route.ts CHUNK_NAMES). */
const CHUNKS = ['terminal', 'editor', 'mermaid']

export default [
  {
    entry: { index: 'src/index.ts', invariant: 'src/invariant.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    // clean stays off: the build script removes lib/ wholesale before tsc, so
    // a tsdown clean here would wipe the lib/types declarations tsc just
    // emitted (and `watch` must never touch them).
    clean: false,
  },
  // Official profile channel: bundle id = package name (package.json `name`).
  clientBundle('dsh-better-sidebar', 'client.js'),
  // Plugin-registry channel: bundle id = manifest id (dsh.plugin.json `id`).
  clientBundle('dsh-external/dsh-better-sidebar', 'client-registry.js'),
  // Lazy chunks: shared by both channels, fetched on first use through the
  // plugin's /sidebar/bundle route (see src/client/chunk-loader.ts).
  ...CHUNKS.map(chunkBundle),
] satisfies UserConfig[]
