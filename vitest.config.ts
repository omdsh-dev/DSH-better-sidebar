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
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
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
