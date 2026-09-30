#!/usr/bin/env node
/**
 * Assemble the plugin-registry installable root (`registry/`) from the built
 * `lib/` output. Run after `pnpm build`:
 *
 *   pnpm build
 *   node scripts/package-registry.mjs
 *   dsh registry install ./registry
 *   dsh registry enable dsh-external/dsh-better-sidebar
 *
 * The registry install copies the whole source directory (`cp -r`), so
 * installing the repo root would drag in `node_modules/` (machine-local
 * `link:` devDependency symlinks) and `.git/`. This
 * staging directory carries exactly the files the manifest references plus
 * the docs — same layout as the dsh-subagent-tree `registry/` pattern. It is
 * gitignored and rebuilt from scratch on every run.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(import.meta.url), '..', '..')
const out = join(root, 'registry')

/** Files copied into registry/, preserving relative paths (lib/ stays lib/). */
const files = [
  'dsh.plugin.json',
  'lib/index.js',
  'lib/invariant.js',
  'lib/client-registry.js',
  'lib/client-registry.js.map',
  // Lazy chunks: the client fetches these from the host's /sidebar/bundle
  // route on first use (see src/client/chunk-loader.ts / src/bundle-route.ts).
  // EVERY `CHUNK_NAMES` entry belongs here — the route reads the file out of
  // the installed copy, so a chunk left out of this list 404s on the registry
  // channel (`locale` was). tests/manifest-consistency.spec.ts guards the list
  // against src/bundle-route.ts.
  'lib/client-editor.js',
  'lib/client-editor.js.map',
  'lib/client-mermaid.js',
  'lib/client-mermaid.js.map',
  'lib/client-locale.js',
  'lib/client-locale.js.map',
  'README.md',
  'LICENSE',
]

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
for (const file of files) {
  const source = join(root, file)
  if (!existsSync(source)) {
    console.error(`missing ${file} — run \`pnpm build\` first`)
    process.exit(1)
  }
  const target = join(out, file)
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target)
}
console.log(`registry/ assembled (${files.length} files)`)
console.log('next: dsh registry install ./registry && dsh registry enable dsh-external/dsh-better-sidebar')
