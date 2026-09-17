#!/usr/bin/env node
/**
 * Compile the plugin's Tailwind entry (src/client/ui/theme.css) to a standalone
 * stylesheet.
 *
 * The production path is tsdown's css-inline plugin (tsdown.config.ts), which
 * inlines the compiled CSS into lib/client.js as a `<style data-plugin>` tag.
 * The local visual harness (/tmp/dsh-visual) instead renders the REAL task-page
 * components against a tokens stylesheet in a plain HTML page, so it needs the
 * same utilities as a file it can `<link>` — this script is that file, built
 * from the same pipeline (tsdown.config.ts exports `compileTailwind`) so the two
 * cannot drift.
 *
 * Usage: node scripts/ui-css.mjs [outFile]   (default /tmp/dsh-visual/tailwind.css)
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileTailwind } from '../tsdown.config.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ENTRY = resolve(ROOT, 'src/client/ui/theme.css')
const DEFAULT_OUT = '/tmp/dsh-visual/tailwind.css'

const outFile = resolve(process.argv[2] ?? DEFAULT_OUT)
// `from`/`base` stay anchored to the real entry file, so `@source` and
// `@import` resolve against src/client/ui regardless of the cwd we run from.
const source = await compileTailwind(await readFile(ENTRY, 'utf8'), ENTRY, { minify: false })

await mkdir(dirname(outFile), { recursive: true })
await writeFile(outFile, source)
process.stdout.write(`ui:css -> ${outFile} (${source.length} bytes)\n`)
