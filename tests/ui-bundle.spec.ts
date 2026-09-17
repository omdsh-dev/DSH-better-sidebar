/**
 * Built-artifact gate for the Tailwind v4 + shadcn/ui migration.
 *
 * The Tasks page — the workflow graph, the tree, the task window, the team
 * board, the jobs drawer AND the vendored shadcn/radix component layer — lives
 * in the lazy `tasks` chunk (`lib/client-tasks.js`), so this gate checks BOTH
 * artifacts:
 *
 * - **core** (`lib/client.js`): must stay free of the UI layer. No Tailwind
 *   utilities, no radix, no tailwind-merge — those are the chunk's payload.
 *   It also must never carry preflight (its CSS is injected into the host page
 *   globally, with no shadow root) nor a palette literal.
 * - **chunk** (`lib/client-tasks.js`): carries the compiled Tailwind output
 *   (`--tw-*` plumbing plus the generated `.flex{}`), the bridged tokens and
 *   the radix components; preflight and oklch stay out of it for the same
 *   global-injection reason.
 *
 * Preflight is detected by its DECLARATION payload, not the selector spelling:
 * the minifier rewrites `::before` to `:before`, Tailwind's own `@property`
 * fallback shares the `*,:before,:after,::backdrop` selector list, and
 * `::file-selector-button` is emitted legitimately by the `file:` variant
 * (that false positive is why this check lives here rather than in a
 * substring match).
 *
 * `lib/` is a build output, not a test prerequisite, so every spec SKIPS
 * (loudly, via skipIf) when the artifact is absent instead of failing an
 * unbuilt checkout or building behind the suite's back.
 */
// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const CORE_BUNDLE = resolve(process.cwd(), 'lib/client.js')
const TASKS_CHUNK = resolve(process.cwd(), 'lib/client-tasks.js')

/** Tailwind's generated output: the utility class and its `--tw-*` plumbing. */
const TAILWIND_UTILITY = '.flex{'
const TAILWIND_CUSTOM_PROPERTY = '--tw-'

/** Preflight's universal reset, in the spellings Tailwind/minification emit. */
const PREFLIGHT_RESET_DECLARATIONS = /box-sizing:\s*border-box;\s*margin:\s*0/
const PREFLIGHT_SELECTORS = [/\*,::before,::after/, /\*, ::before, ::after/]
const PREFLIGHT_HTML_BLOCK = '-webkit-text-size-adjust'

/** The measured pre-migration core bundle (HEAD 12b4716, same toolchain). */
const PRE_MIGRATION_CORE_BYTES = 1_012_271
/** The migration's reviewed core allowance (chunk payload excluded). */
const CORE_BUDGET_BYTES = PRE_MIGRATION_CORE_BYTES + 250 * 1024
/** A bundle smaller than this lost the plugin entirely. */
const SANITY_FLOOR_BYTES = 500 * 1024

/** Every preflight signature, asserted absent from one artifact. */
function expectNoPreflight(source: string): void {
  for (const selector of PREFLIGHT_SELECTORS) expect(source).not.toMatch(selector)
  expect(source).not.toMatch(PREFLIGHT_RESET_DECLARATIONS)
  expect(source).not.toContain(PREFLIGHT_HTML_BLOCK)
}

describe('lib/client.js: the core bundle stays free of the UI layer', () => {
  const built = existsSync(CORE_BUNDLE)
  const bundle = built ? readFileSync(CORE_BUNDLE, 'utf8') : ''

  it.skipIf(!built)('carries no Tailwind utilities (they belong to the tasks chunk)', () => {
    expect(bundle).not.toContain(TAILWIND_CUSTOM_PROPERTY)
    expect(bundle).not.toContain(TAILWIND_UTILITY)
  })

  it.skipIf(!built)('carries neither radix nor tailwind-merge nor lucide', () => {
    expect(bundle).not.toContain('radix-ui')
    expect(bundle).not.toContain('tailwind-merge')
    expect(bundle).not.toContain('lucide-react')
  })

  it.skipIf(!built)('carries no preflight reset and no palette literal', () => {
    expectNoPreflight(bundle)
    // Tailwind's own palette is oklch-based; any hit is a leaked value.
    expect(bundle).not.toContain('oklch(')
  })

  it.skipIf(!built)('fits the reviewed core budget and reports its size', () => {
    const bytes = Buffer.byteLength(bundle)
    expect(bytes).toBeGreaterThan(SANITY_FLOOR_BYTES)
    expect(bytes).toBeLessThanOrEqual(CORE_BUDGET_BYTES)
    console.log(
      `[ui-bundle] lib/client.js = ${bytes} bytes (${(bytes / 1024).toFixed(1)} KiB);`
      + ` pre-migration ${PRE_MIGRATION_CORE_BYTES} bytes; delta ${bytes - PRE_MIGRATION_CORE_BYTES}`,
    )
  })
})

describe('lib/client-tasks.js: the lazy chunk carries the shadcn layer', () => {
  const built = existsSync(TASKS_CHUNK)
  const chunk = built ? readFileSync(TASKS_CHUNK, 'utf8') : ''

  it.skipIf(!built)('carries the compiled Tailwind output and the bridged tokens', () => {
    expect(chunk).toContain(TAILWIND_CUSTOM_PROPERTY)
    expect(chunk).toContain(TAILWIND_UTILITY)
    // The bridge is what keeps the skin contract: shadcn variables point at
    // DSH tokens, so no palette value is ever painted.
    expect(chunk).toContain('var(--dsw-alias-state-business-primary)')
  })

  it.skipIf(!built)('carries the radix component layer', () => {
    expect(chunk).toContain('radix-ui')
  })

  it.skipIf(!built)('carries no preflight reset and no palette literal', () => {
    // The chunk's stylesheet is injected globally too, so the same rule holds.
    expectNoPreflight(chunk)
    expect(chunk).not.toContain('oklch(')
    expect(chunk).not.toContain('lucide-react')
  })

  it.skipIf(!built)('assigns its global chunk registry slot', () => {
    // chunk-loader.ts materializes the factory from this slot.
    expect(chunk).toContain('__dshChunks__["tasks"]')
  })

  it.skipIf(!built)('reports its size for the gate', () => {
    const bytes = Buffer.byteLength(chunk)
    expect(bytes).toBeGreaterThan(SANITY_FLOOR_BYTES / 4)
    console.log(`[ui-bundle] lib/client-tasks.js = ${bytes} bytes (${(bytes / 1024).toFixed(1)} KiB)`)
  })
})
