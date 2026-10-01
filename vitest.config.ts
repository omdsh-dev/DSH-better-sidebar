/**
 * Vitest config: inline the npm-published `@deepseek-ai/*` packages whose
 * BUILT lib bundles css side-effect imports (e.g. `dsh-client-ui-primitives`
 * imports `katex/dist/katex.min.css` at the top of its `lib/index.js`).
 *
 * Installed from the npm registry (the default since v0.4.1) these packages
 * live under `node_modules/.pnpm` and are externalized by vitest — Node then
 * chokes on the `.css` import. Inlining routes them through Vite's transform,
 * which stubs css imports (the default `css: false`). The previous
 * `link:`-to-source-checkout install needed no such config: linked files sit
 * outside `node_modules` and are transformed by default.
 *
 * Tracy (TCH #526): inside the TCH tree, tests resolve
 * `@deepseek-ai/dsh-client-ui-primitives` to the workspace fork of dsh
 * (`vendor/tracy/deepseek-harness`, `0.1.7-rc.2-tracy.N`), the primitives the
 * host actually serves. The devDependency stays on npm `0.1.7-rc.2`: the dsh
 * image installs this package on its own with its own frozen lockfile, and the
 * fork is not on npmjs. The npm copy lacks the fork's Menu extension
 * (`selectable` rows) that BrowserTabTitle relies on. This alias is read by
 * vitest only; `pnpm build` (tsc + tsdown) never loads this file. Outside TCH
 * (no fork next to this package) resolution stays on the npm copy, and the
 * site-picker specs in `tests/tracy-browser.spec.tsx` that open `selectable`
 * rows fail there by design: they test the fork's Menu, which the npm copy
 * does not have, so they need a TCH checkout with the fork built.
 */
import { lstatSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives'

/** Entry file of the workspace fork, or undefined when there is no fork here. */
function forkedPrimitivesEntry(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  const pkgDir = resolve(here, '../deepseek-harness/packages/client/ui-primitives')
  // No fork next to this package (a standalone clone): keep the npm copy.
  if (!lstatSync(pkgDir, { throwIfNoEntry: false })) return undefined
  // From here on the fork is present, so anything broken fails loudly
  // instead of falling back to npm.
  const manifestPath = resolve(pkgDir, 'package.json')
  if (!statSync(manifestPath).isFile()) throw new Error(`${manifestPath} is not a regular file`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    name?: string
    exports?: { '.'?: { default?: string } }
  }
  if (manifest.name !== PRIMITIVES) {
    throw new Error(`${manifestPath}: expected name ${PRIMITIVES}, found ${String(manifest.name)}`)
  }
  const target = manifest.exports?.['.']?.default
  if (!target) throw new Error(`${manifestPath}: no exports["."].default entry`)
  const entry = resolve(pkgDir, target)
  const stat = statSync(entry, { throwIfNoEntry: false })
  if (!stat?.isFile() || stat.size === 0) {
    throw new Error(`${entry}: the dsh fork is not built (run \`pnpm dsh:build\` at the TCH root)`)
  }
  return entry
}

const primitivesEntry = forkedPrimitivesEntry()

export default defineConfig({
  resolve: {
    // Exact specifier only; the fork's own imports resolve from its location,
    // so React is deduped to keep a single copy across both trees.
    alias: primitivesEntry
      ? [{ find: new RegExp(`^${PRIMITIVES}$`), replacement: primitivesEntry }]
      : [],
    dedupe: ['react', 'react-dom'],
  },
  test: {
    // Bridge Node's `localStorage` accessor to jsdom's store (see the file).
    setupFiles: ['tests/setup.ts'],
    server: {
      deps: {
        inline: [/@deepseek-ai\/dsh-client-ui-primitives/],
      },
    },
    // A handful of suites drive REAL processes (git, powershell, node-pty),
    // and vitest's 5000 ms default is simply below what a loaded 2-core CI
    // runner needs for a single cold spawn: the 2026-09-09/10 window lost
    // cases in tests/agent-pty.spec.ts (a PowerShell + ConPTY pair per
    // terminal), tests/install-powershell.spec.ts (12.1 s for one
    // powershell.exe start) and tests/git.spec.ts (9.6 s to build a
    // pathological untracked set) — three different files, one cause. Raise
    // the default to cover them; the pty and PowerShell suites still declare
    // their own 30 s budgets, and a genuinely hung test still fails.
    testTimeout: 15_000,
    // The Playwright headless-render lane lives in tests/e2e (specs named
    // *.e2e.ts). Keep vitest from ever collecting it, both by naming (the
    // default include only matches *.test.* / *.spec.*) and by an explicit
    // exclude. NOTE: `exclude` REPLACES vitest's defaults, so the standard
    // node_modules/dist/etc. excludes must be restated here.
    exclude: [
      'tests/e2e/**',
      // Local dev worktrees (pnpm/DSH-style task branches) may carry stale
      // code against this checkout's node_modules — never collect them.
      '**/.worktrees/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
    ],
  },
})
