/**
 * Host theme-token guard: every `var(--dsw-...)` the plugin's stylesheets
 * reference WITHOUT a fallback must name a token the host theme defines (or one
 * the plugin declares itself).
 *
 * Why this spec exists: `--dsw-alias-hairline` was referenced by six
 * declarations and the host defines no such token, so `border: 1px solid
 * var(--dsw-alias-hairline)` was invalid at computed-value time — the borders
 * simply did not exist, with no error and nothing to notice in review. A CSS
 * custom property is resolved late: an unknown name kills the whole
 * declaration. That is exactly the class of defect static text review misses.
 *
 * A reference that CARRIES a fallback (`var(--dsw-font-mono, ui-monospace)`) is
 * fine and is not checked: the fallback keeps the declaration alive even though
 * the host never defines that name (a documented, deliberate case in this
 * repo). A reference nested inside another `var()`'s fallback is fine too — the
 * outer chain already answers for it.
 *
 * HOST_TOKENS is a snapshot of the host theme sheets
 * (`packages/client/ui-theme/src/styles/*.css` in the DSH checkout: every
 * `--dsw-*:` definition). Tests ship with this repo and cannot read the host
 * tree (CI has none), so ADDING a host token is a deliberate edit here — the
 * same policy `tests/sidechat-pill-typography.spec.tsx` documents.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Every token the host theme sheets define (snapshot, see the header). */
const HOST_TOKENS: readonly string[] = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-document-preview',
  '--dsw-alias-bg-document-selection',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-mask-1',
  '--dsw-alias-bg-mask-2',
  '--dsw-alias-bg-mask-3',
  '--dsw-alias-bg-mask-drop',
  '--dsw-alias-bg-mask-photo',
  '--dsw-alias-bg-module-platform',
  '--dsw-alias-bg-multi-select',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-bg-skeleton',
  '--dsw-alias-border-inverted',
  '--dsw-alias-border-inverted2',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l2-darkmode-thin',
  '--dsw-alias-border-l3',
  '--dsw-alias-border-l4',
  '--dsw-alias-brand-primary',
  '--dsw-alias-brand-primary-invert',
  '--dsw-alias-brand-primary-new-colorprimary-new-color',
  '--dsw-alias-brand-text',
  '--dsw-alias-button-contrast-fill',
  '--dsw-alias-button-elevated-fill',
  '--dsw-alias-button-floating-fill',
  '--dsw-alias-button-floating-hover',
  '--dsw-alias-button-ghost-active-border',
  '--dsw-alias-button-ghost-active-fill',
  '--dsw-alias-button-ghost-active-hover',
  '--dsw-alias-button-info-fill',
  '--dsw-alias-button-info-hover',
  '--dsw-alias-button-primary-dimmed',
  '--dsw-alias-button-primary-fill',
  '--dsw-alias-button-primary-hover',
  '--dsw-alias-button-tool-bar-fill',
  '--dsw-alias-button-tool-bar-fill-invisible',
  '--dsw-alias-button-tool-bar-hover',
  '--dsw-alias-code-diff-added',
  '--dsw-alias-code-diff-deleted',
  '--dsw-alias-file-diff-added-bg',
  '--dsw-alias-file-diff-added-gutter',
  '--dsw-alias-file-diff-added-marker',
  '--dsw-alias-file-diff-deleted-bg',
  '--dsw-alias-file-diff-deleted-gutter',
  '--dsw-alias-file-diff-deleted-marker',
  '--dsw-alias-interactive-bg-active',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-interactive-bg-hover-accent',
  '--dsw-alias-interactive-bg-hover-danger',
  '--dsw-alias-interactive-bg-hover-solid',
  '--dsw-alias-label-caption',
  '--dsw-alias-label-deep-diving',
  '--dsw-alias-label-deep-diving-shimmer',
  '--dsw-alias-label-dimmed',
  '--dsw-alias-label-document-preview',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-primary-bluish',
  '--dsw-alias-label-primary-dimmed',
  '--dsw-alias-label-primary-foreground',
  '--dsw-alias-label-primary-inverted',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-shimmer',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-link',
  '--dsw-alias-markdown-citation',
  '--dsw-alias-markdown-code-block',
  '--dsw-alias-markdown-code-block-banner',
  '--dsw-alias-markdown-code-segment-selected',
  '--dsw-alias-markdown-code-segment-unselected',
  '--dsw-alias-markdown-inline-code',
  '--dsw-alias-markdown-placeholder',
  '--dsw-alias-markdown-tag',
  '--dsw-alias-menu-group-header-fill',
  '--dsw-alias-menu-icon',
  '--dsw-alias-onboarding-accent',
  '--dsw-alias-onboarding-card-fill',
  '--dsw-alias-onboarding-checkbox-border',
  '--dsw-alias-onboarding-secondary-fill',
  '--dsw-alias-scrollbar-bg-l1',
  '--dsw-alias-scrollbar-bg-l2',
  '--dsw-alias-scrollbar-hover-l1',
  '--dsw-alias-scrollbar-hover-l2',
  '--dsw-alias-settings-card-fill',
  '--dsw-alias-settings-card-stroke',
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-business-tertiary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-error-secondary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-success-secondary',
  '--dsw-alias-state-success-tertiary',
  '--dsw-alias-state-warn-label',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-state-warn-secondary',
  '--dsw-alias-state-warn-tertiary',
  '--dsw-alias-switch-thumb',
  '--dsw-alias-toast-bg',
  '--dsw-alias-toast-label',
  '--dsw-alias-tooltip-bg',
  '--dsw-alias-tooltip-key-bg',
  '--dsw-alias-turn-trigger-bg',
  '--dsw-alias-turn-trigger-bg-hover',
  '--dsw-corner-shape',
  '--dsw-elevation-panel',
  '--dsw-elevation-prominent',
  '--dsw-elevation-soft',
  '--dsw-elevation-stroke',
  '--dsw-elevation-stroke-color',
  '--dsw-focus-ring-color',
  '--dsw-focus-ring-width',
  '--dsw-font-base-16',
  '--dsw-font-base-16-font-family',
  '--dsw-font-base-16-font-size',
  '--dsw-font-base-16-font-style',
  '--dsw-font-base-16-font-weight',
  '--dsw-font-base-16-line-height',
  '--dsw-font-base-strong-16',
  '--dsw-font-base-strong-16-font-family',
  '--dsw-font-base-strong-16-font-size',
  '--dsw-font-base-strong-16-font-style',
  '--dsw-font-base-strong-16-font-weight',
  '--dsw-font-base-strong-16-line-height',
  '--dsw-font-family',
  '--dsw-font-family-brand',
  '--dsw-font-l-20',
  '--dsw-font-l-20-font-family',
  '--dsw-font-l-20-font-size',
  '--dsw-font-l-20-font-style',
  '--dsw-font-l-20-font-weight',
  '--dsw-font-l-20-line-height',
  '--dsw-font-m-18',
  '--dsw-font-m-18-font-family',
  '--dsw-font-m-18-font-size',
  '--dsw-font-m-18-font-style',
  '--dsw-font-m-18-font-weight',
  '--dsw-font-m-18-line-height',
  '--dsw-font-markdown-base',
  '--dsw-font-markdown-base-font-family',
  '--dsw-font-markdown-base-font-size',
  '--dsw-font-markdown-base-font-style',
  '--dsw-font-markdown-base-font-weight',
  '--dsw-font-markdown-base-italic',
  '--dsw-font-markdown-base-italic-font-family',
  '--dsw-font-markdown-base-italic-font-size',
  '--dsw-font-markdown-base-italic-font-style',
  '--dsw-font-markdown-base-italic-font-weight',
  '--dsw-font-markdown-base-italic-line-height',
  '--dsw-font-markdown-base-line-height',
  '--dsw-font-markdown-base-strong',
  '--dsw-font-markdown-base-strong-font-family',
  '--dsw-font-markdown-base-strong-font-size',
  '--dsw-font-markdown-base-strong-font-style',
  '--dsw-font-markdown-base-strong-font-weight',
  '--dsw-font-markdown-base-strong-italic',
  '--dsw-font-markdown-base-strong-italic-font-family',
  '--dsw-font-markdown-base-strong-italic-font-size',
  '--dsw-font-markdown-base-strong-italic-font-style',
  '--dsw-font-markdown-base-strong-italic-font-weight',
  '--dsw-font-markdown-base-strong-italic-line-height',
  '--dsw-font-markdown-base-strong-line-height',
  '--dsw-font-markdown-code',
  '--dsw-font-markdown-code-block',
  '--dsw-font-markdown-code-block-font-family',
  '--dsw-font-markdown-code-block-font-size',
  '--dsw-font-markdown-code-block-font-style',
  '--dsw-font-markdown-code-block-font-weight',
  '--dsw-font-markdown-code-block-line-height',
  '--dsw-font-markdown-code-block-small',
  '--dsw-font-markdown-code-block-small-font-family',
  '--dsw-font-markdown-code-block-small-font-size',
  '--dsw-font-markdown-code-block-small-font-style',
  '--dsw-font-markdown-code-block-small-font-weight',
  '--dsw-font-markdown-code-block-small-line-height',
  '--dsw-font-markdown-code-font-family',
  '--dsw-font-markdown-code-font-size',
  '--dsw-font-markdown-code-font-style',
  '--dsw-font-markdown-code-font-weight',
  '--dsw-font-markdown-code-line-height',
  '--dsw-font-markdown-h1',
  '--dsw-font-markdown-h1-font-family',
  '--dsw-font-markdown-h1-font-size',
  '--dsw-font-markdown-h1-font-style',
  '--dsw-font-markdown-h1-font-weight',
  '--dsw-font-markdown-h1-line-height',
  '--dsw-font-markdown-h2',
  '--dsw-font-markdown-h2-font-family',
  '--dsw-font-markdown-h2-font-size',
  '--dsw-font-markdown-h2-font-style',
  '--dsw-font-markdown-h2-font-weight',
  '--dsw-font-markdown-h2-line-height',
  '--dsw-font-markdown-h3',
  '--dsw-font-markdown-h3-font-family',
  '--dsw-font-markdown-h3-font-size',
  '--dsw-font-markdown-h3-font-style',
  '--dsw-font-markdown-h3-font-weight',
  '--dsw-font-markdown-h3-line-height',
  '--dsw-font-markdown-h4',
  '--dsw-font-markdown-h4-font-family',
  '--dsw-font-markdown-h4-font-size',
  '--dsw-font-markdown-h4-font-style',
  '--dsw-font-markdown-h4-font-weight',
  '--dsw-font-markdown-h4-line-height',
  '--dsw-font-markdown-small',
  '--dsw-font-markdown-small-font-family',
  '--dsw-font-markdown-small-font-size',
  '--dsw-font-markdown-small-font-style',
  '--dsw-font-markdown-small-font-weight',
  '--dsw-font-markdown-small-italic',
  '--dsw-font-markdown-small-italic-font-family',
  '--dsw-font-markdown-small-italic-font-size',
  '--dsw-font-markdown-small-italic-font-style',
  '--dsw-font-markdown-small-italic-font-weight',
  '--dsw-font-markdown-small-italic-line-height',
  '--dsw-font-markdown-small-line-height',
  '--dsw-font-markdown-small-strong',
  '--dsw-font-markdown-small-strong-font-family',
  '--dsw-font-markdown-small-strong-font-size',
  '--dsw-font-markdown-small-strong-font-style',
  '--dsw-font-markdown-small-strong-font-weight',
  '--dsw-font-markdown-small-strong-italic',
  '--dsw-font-markdown-small-strong-italic-font-family',
  '--dsw-font-markdown-small-strong-italic-font-size',
  '--dsw-font-markdown-small-strong-italic-font-style',
  '--dsw-font-markdown-small-strong-italic-font-weight',
  '--dsw-font-markdown-small-strong-italic-line-height',
  '--dsw-font-markdown-small-strong-line-height',
  '--dsw-font-markdown-table',
  '--dsw-font-markdown-table-font-family',
  '--dsw-font-markdown-table-font-size',
  '--dsw-font-markdown-table-font-style',
  '--dsw-font-markdown-table-font-weight',
  '--dsw-font-markdown-table-head',
  '--dsw-font-markdown-table-head-font-family',
  '--dsw-font-markdown-table-head-font-size',
  '--dsw-font-markdown-table-head-font-style',
  '--dsw-font-markdown-table-head-font-weight',
  '--dsw-font-markdown-table-head-line-height',
  '--dsw-font-markdown-table-line-height',
  '--dsw-font-s-14',
  '--dsw-font-s-14-font-family',
  '--dsw-font-s-14-font-size',
  '--dsw-font-s-14-font-style',
  '--dsw-font-s-14-font-weight',
  '--dsw-font-s-14-line-height',
  '--dsw-font-s-strong-14',
  '--dsw-font-s-strong-14-font-family',
  '--dsw-font-s-strong-14-font-size',
  '--dsw-font-s-strong-14-font-style',
  '--dsw-font-s-strong-14-font-weight',
  '--dsw-font-s-strong-14-line-height',
  '--dsw-font-xl-24',
  '--dsw-font-xl-24-font-family',
  '--dsw-font-xl-24-font-size',
  '--dsw-font-xl-24-font-style',
  '--dsw-font-xl-24-font-weight',
  '--dsw-font-xl-24-line-height',
  '--dsw-font-xs-13',
  '--dsw-font-xs-13-font-family',
  '--dsw-font-xs-13-font-size',
  '--dsw-font-xs-13-font-style',
  '--dsw-font-xs-13-font-weight',
  '--dsw-font-xs-13-line-height',
  '--dsw-font-xs-strong-13',
  '--dsw-font-xs-strong-13-font-family',
  '--dsw-font-xs-strong-13-font-size',
  '--dsw-font-xs-strong-13-font-style',
  '--dsw-font-xs-strong-13-font-weight',
  '--dsw-font-xs-strong-13-line-height',
  '--dsw-font-xxs-12',
  '--dsw-font-xxs-12-font-family',
  '--dsw-font-xxs-12-font-size',
  '--dsw-font-xxs-12-font-style',
  '--dsw-font-xxs-12-font-weight',
  '--dsw-font-xxs-12-line-height',
  '--dsw-font-xxs-strong-12',
  '--dsw-font-xxs-strong-12-font-family',
  '--dsw-font-xxs-strong-12-font-size',
  '--dsw-font-xxs-strong-12-font-style',
  '--dsw-font-xxs-strong-12-font-weight',
  '--dsw-font-xxs-strong-12-line-height',
  '--dsw-font-xxxs-11',
  '--dsw-font-xxxs-11-font-family',
  '--dsw-font-xxxs-11-font-size',
  '--dsw-font-xxxs-11-font-style',
  '--dsw-font-xxxs-11-font-weight',
  '--dsw-font-xxxs-11-line-height',
  '--dsw-font-xxxs-strong-11',
  '--dsw-font-xxxs-strong-11-font-family',
  '--dsw-font-xxxs-strong-11-font-size',
  '--dsw-font-xxxs-strong-11-font-style',
  '--dsw-font-xxxs-strong-11-font-weight',
  '--dsw-font-xxxs-strong-11-line-height',
  '--dsw-gradient-onboarding-blue-stops',
  '--dsw-gradient-onboarding-cyan-stops',
  '--dsw-gradient-onboarding-violet-stops',
  '--dsw-linear-gradient-think',
  '--dsw-linear-think-select',
  '--dsw-mask-blur',
  '--dsw-menu-backdrop-filter',
  '--dsw-menu-surface-fill',
  '--dsw-radius-lg',
  '--dsw-radius-md',
  '--dsw-radius-panel',
  '--dsw-radius-sm',
  '--dsw-radius-xl',
  '--dsw-radius-xs',
  '--dsw-shadow-lv1',
  '--dsw-shadow-lv1-blur',
  '--dsw-shadow-lv2',
  '--dsw-shadow-lv3',
  '--dsw-specific-bubble',
  '--dsw-specific-bubble-highlight',
  '--dsw-specific-input-major',
  '--dsw-specific-login-input',
  '--dsw-specific-menu',
  '--dsw-specific-selector',
  '--dsw-specific-sidebar-fill',
  '--dsw-specific-sidebar-nav-item-active',
  '--dsw-specific-sidebar-nav-item-active-accent',
  '--dsw-specific-sidebar-nav-item-hover',
  '--dsw-specific-tip',
  '--dsw-static-amber-100',
  '--dsw-static-amber-400',
  '--dsw-static-amber-500',
  '--dsw-static-amber-600',
  '--dsw-static-amber-900',
  '--dsw-static-blue-100',
  '--dsw-static-blue-300',
  '--dsw-static-blue-400',
  '--dsw-static-blue-450',
  '--dsw-static-blue-50',
  '--dsw-static-blue-500',
  '--dsw-static-blue-50p',
  '--dsw-static-blue-600',
  '--dsw-static-blue-75',
  '--dsw-static-blue-800',
  '--dsw-static-blue-900',
  '--dsw-static-blue-950',
  '--dsw-static-deepseek-100',
  '--dsw-static-deepseek-200',
  '--dsw-static-deepseek-300',
  '--dsw-static-deepseek-400',
  '--dsw-static-deepseek-450',
  '--dsw-static-deepseek-50',
  '--dsw-static-deepseek-500',
  '--dsw-static-deepseek-600',
  '--dsw-static-deepseek-700-delete',
  '--dsw-static-deepseek-800',
  '--dsw-static-deepseek-900',
  '--dsw-static-green-100',
  '--dsw-static-green-400',
  '--dsw-static-green-500',
  '--dsw-static-green-500-a08',
  '--dsw-static-green-500-a12',
  '--dsw-static-green-900',
  '--dsw-static-neutral-00',
  '--dsw-static-neutral-100',
  '--dsw-static-neutral-1000',
  '--dsw-static-neutral-150',
  '--dsw-static-neutral-200',
  '--dsw-static-neutral-250',
  '--dsw-static-neutral-300',
  '--dsw-static-neutral-400',
  '--dsw-static-neutral-50',
  '--dsw-static-neutral-500',
  '--dsw-static-neutral-550',
  '--dsw-static-neutral-600',
  '--dsw-static-neutral-700',
  '--dsw-static-neutral-800',
  '--dsw-static-neutral-850',
  '--dsw-static-neutral-900',
  '--dsw-static-neutral-bluish-00',
  '--dsw-static-neutral-bluish-100',
  '--dsw-static-neutral-bluish-1000',
  '--dsw-static-neutral-bluish-150',
  '--dsw-static-neutral-bluish-200',
  '--dsw-static-neutral-bluish-300',
  '--dsw-static-neutral-bluish-400',
  '--dsw-static-neutral-bluish-50',
  '--dsw-static-neutral-bluish-500',
  '--dsw-static-neutral-bluish-60',
  '--dsw-static-neutral-bluish-600',
  '--dsw-static-neutral-bluish-700',
  '--dsw-static-neutral-bluish-75',
  '--dsw-static-neutral-bluish-750',
  '--dsw-static-neutral-bluish-800',
  '--dsw-static-neutral-bluish-850',
  '--dsw-static-neutral-bluish-875',
  '--dsw-static-neutral-bluish-900',
  '--dsw-static-neutral-bluish-950',
  '--dsw-static-red-100',
  '--dsw-static-red-400',
  '--dsw-static-red-400-a12',
  '--dsw-static-red-50',
  '--dsw-static-red-500',
  '--dsw-static-red-600',
  '--dsw-static-red-600-a08',
  '--dsw-static-red-900',
]

/** The stylesheets this guard covers. */
const STYLE_ROOT = 'src/client'

/** Every `.css` file under the style root, sorted for a stable failure list. */
function stylesheets(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...stylesheets(path))
    else if (entry.name.endsWith('.css')) found.push(path)
  }
  return found.sort()
}

/**
 * Strip block comments while preserving line structure, so reported line
 * numbers point at the real file (a comment may legitimately quote a token
 * pattern such as `var(--dsw-font-markdown-*)`).
 * @param text - the stylesheet source.
 * @returns the source with comment bodies blanked out.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '))
}

/** One `var()` reference found in a declaration value. */
interface VarReference {
  name: string
  /** The call carries its own fallback (`var(--x, ...)`). */
  guarded: boolean
  /** The call sits inside another `var()` fallback. */
  nested: boolean
}

/**
 * Every `var()` call in one line, outermost first.
 * @param value - one source line.
 * @returns the calls, with the two ways a call can be safe.
 */
function varCalls(value: string): VarReference[] {
  const calls: VarReference[] = []
  const walk = (segment: string, nested: boolean): void => {
    let index = 0
    while (true) {
      const start = segment.indexOf('var(', index)
      if (start === -1) return
      let depth = 1
      let cursor = start + 4
      let comma = -1
      while (cursor < segment.length && depth > 0) {
        const char = segment[cursor]
        if (char === '(') depth += 1
        else if (char === ')') depth -= 1
        else if (char === ',' && depth === 1 && comma === -1) comma = cursor
        cursor += 1
      }
      const inner = segment.slice(start + 4, cursor - 1)
      const first = comma === -1 ? inner : inner.slice(0, comma - (start + 4))
      calls.push({ name: first.trim(), guarded: comma !== -1, nested })
      if (comma !== -1) walk(inner.slice(comma - (start + 4) + 1), true)
      index = cursor
    }
  }
  walk(value, false)
  return calls
}

/** Every token the plugin's own sheets declare (`--dsw-x: ...`). */
function ownTokens(sheets: readonly string[]): Set<string> {
  const names = new Set<string>()
  for (const sheet of sheets) {
    for (const match of withoutComments(readFileSync(sheet, 'utf8')).matchAll(/(--dsw-[A-Za-z0-9_-]+)\s*:/g)) {
      if (match[1] !== undefined) names.add(match[1])
    }
  }
  return names
}

/**
 * Names the sheets reference WITHOUT a fallback while the host defines none.
 * These are PRE-EXISTING debts of the same class this guard exists for, kept
 * visible (and counted) instead of silently blessed.
 *
 * EMPTY, deliberately: the three debts this guard shipped with were retired to
 * the tokens the host theme actually defines —
 *   `--dsw-alias-danger`       → `--dsw-alias-state-error-primary`
 *   `--dsw-alias-bg-l2`        → `--dsw-alias-bg-layer-2`
 *   `--dsw-font-xs-regular-13` → `--dsw-font-xs-13`
 * — so every fallback-free reference now resolves to a host (or plugin) token.
 * The list may only SHRINK: the debt test fails when an entry stops being
 * referenced, and the three retired names are pinned by the last test so they
 * cannot come back unnoticed. A future entry here is a regression, not a
 * budget.
 */
const KNOWN_UNRESOLVED: Readonly<Record<string, string>> = {}

/** One reference that cannot resolve. */
interface Unresolved {
  file: string
  line: number
  name: string
}

describe('host theme tokens (stylesheets)', () => {
  const sheets = stylesheets(resolve(process.cwd(), STYLE_ROOT))
  const host = new Set(HOST_TOKENS)
  const own = ownTokens(sheets)

  /** Every `--dsw-*` reference in the plugin's sheets, in file order. */
  const references: Array<{ file: string; line: number; reference: VarReference }> = []
  for (const sheet of sheets) {
    // Repo-relative in failure output: the absolute tmp path is noise.
    const file = sheet.startsWith(process.cwd()) ? sheet.slice(process.cwd().length + 1) : sheet
    const lines = withoutComments(readFileSync(sheet, 'utf8')).split('\n')
    lines.forEach((line, index) => {
      for (const reference of varCalls(line)) {
        references.push({ file, line: index + 1, reference })
      }
    })
  }

  it('scans the plugin\'s stylesheets at all', () => {
    // A guard on the guard: a scan that silently stopped matching would make the
    // assertion below vacuously true.
    expect(sheets.length).toBeGreaterThan(10)
    expect(references.length).toBeGreaterThan(100)
    expect(references.some(entry => entry.reference.name === '--dsw-alias-bg-base')).toBe(true)
    expect(own.size, 'the sheets declare their own tokens').toBeGreaterThan(0)
  })

  /** Every fallback-free reference whose name resolves nowhere. */
  const unresolvedRefs = (): Unresolved[] => {
    const unresolved: Unresolved[] = []
    for (const { file, line, reference } of references) {
      if (reference.guarded || reference.nested) continue
      if (!/^--dsw-[A-Za-z0-9_-]+$/.test(reference.name)) continue
      if (host.has(reference.name) || own.has(reference.name)) continue
      unresolved.push({ file, line, name: reference.name })
    }
    return unresolved
  }

  it('resolves every fallback-free variable to a host or plugin token', () => {
    const unexpected = unresolvedRefs().filter(entry => KNOWN_UNRESOLVED[entry.name] === undefined)
    expect(
      unexpected,
      'these declarations die at computed-value time: the host defines no such token',
    ).toEqual([])
  })

  it('keeps the known debts honest', () => {
    // Every listed name is still referenced (a fixed name must leave the list)...
    const names = new Set(unresolvedRefs().map(entry => entry.name))
    for (const name of Object.keys(KNOWN_UNRESOLVED)) {
      expect(names, `stale entry: nothing references ${name} any more`).toContain(name)
    }
    // ...and each entry names the host token that should replace it.
    for (const [name, replacement] of Object.entries(KNOWN_UNRESOLVED)) {
      expect(host, `${name} should be replaced by a real host token`).toContain(replacement)
    }
  })

  it('never reintroduces a name the host does not define', () => {
    // The concrete regressions this guard was written for; the rule above covers
    // them generically, these pins keep the reasons from being lost. The three
    // retired spellings are the upstream tokens replaced by the host's real
    // ones (see the debt comment above): referencing one makes its declaration
    // invalid at computed-value time, so it silently paints nothing.
    const names = references.map(entry => entry.reference.name)
    for (const retired of [
      '--dsw-alias-hairline',
      '--dsw-alias-danger',
      '--dsw-alias-bg-l2',
      '--dsw-font-xs-regular-13',
    ]) {
      expect(names, `${retired} is not a token the host theme defines`).not.toContain(retired)
    }
  })
})
