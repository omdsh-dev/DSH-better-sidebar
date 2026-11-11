/**
 * P1 static contract — the pill / status-line typography must sit on font
 * tokens the HOST actually defines. Design basis: `/tmp/bsb-parity/spec.md`
 * §D1/§D2 (the two floating pills) and `/root/dsh-web/app/packages/client/
 * ui-theme/src/styles/gradient-shadow-text.css:206-248` (the host's real token
 * set).
 *
 * Why this spec exists: the side chat's stylesheet carries `font:` shorthands
 * that name tokens the host never defines —
 * `--dsw-font-s-12` (the "reveal earlier" and "back to latest" pills) and
 * `--dsw-font-s-13` (the hero's primary button). A `font:` shorthand with an
 * UNDEFINED variable is invalid at computed-value time, so the whole shorthand
 * (size, line-height, family) is discarded and the element inherits the
 * surrounding body text: the pills render at transcript-body size instead of a
 * pill's small step. The host's own size steps are
 * `--dsw-font-xxxs-11 / xxs-12 / xs-13 / s-14 / m-18 / l-20 / xl-24 /
 * base-16` (plus their `-strong-` variants and the markdown set), and each has
 * `-font-size` / `-line-height` / `-font-family` / `-font-weight` /
 * `-font-style` component variables.
 *
 * ============================ CONTRACT ============================
 * 1. Every `font:` / `font-size:` declaration ANYWHERE in
 *    `src/client/SideChatView.module.css` may reference only variables that
 *    exist: the host's fixed font tokens (list below), the host's content-font
 *    axis introduced for the transcript chrome
 *    (`--dsh-content-font-size`, `--dsh-content-font-size-secondary`,
 *    `--dsh-content-font-delta`, `--dsh-content-font-delta-secondary`), and
 *    `--dsw-font-family`. No other `var(--…)` is allowed in a type
 *    declaration — an undefined variable silently voids the whole declaration.
 * 2. The two floating pills (`.sidechatRevealEarlier`, `.sidechatToLatest`) and
 *    the running status line (`.sidechatStatusText`) take their size from a
 *    host-DEFINED fixed font token (the shorthand or its `-font-size`
 *    component). The content axis is deliberately NOT accepted here: these are
 *    not transcript chrome (see tests/sidechat-typography-contract.spec.tsx,
 *    whose CHROME list excludes them), they are controls whose size is a fixed
 *    step.
 * 3. The undefined names `--dsw-font-s-12` and `--dsw-font-s-13` must not
 *    appear in the sheet at all.
 * ==================================================================
 *
 * The token list is a snapshot of the host theme file above, because tests ship
 * with this repo and must not read the host checkout (CI has no DSH source
 * tree). Adding a host token is a deliberate edit here.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SHEET = 'src/client/SideChatView.module.css'
const source = readFileSync(resolve(process.cwd(), SHEET), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * The fixed font shorthands the host theme defines, one entry per size step
 * (snapshot of ui-theme `gradient-shadow-text.css`). Component variables
 * (`-font-size`, `-line-height`, …) are derived from these below.
 */
const HOST_FONT_SHORTHANDS = [
  '--dsw-font-xxxs-11',
  '--dsw-font-xxxs-strong-11',
  '--dsw-font-xxs-12',
  '--dsw-font-xxs-strong-12',
  '--dsw-font-xs-13',
  '--dsw-font-xs-strong-13',
  '--dsw-font-s-14',
  '--dsw-font-s-strong-14',
  '--dsw-font-m-18',
  '--dsw-font-l-20',
  '--dsw-font-xl-24',
  '--dsw-font-base-16',
  '--dsw-font-base-strong-16',
  '--dsw-font-markdown-base',
  '--dsw-font-markdown-base-strong',
  '--dsw-font-markdown-base-italic',
  '--dsw-font-markdown-base-strong-italic',
  '--dsw-font-markdown-small',
  '--dsw-font-markdown-small-strong',
  '--dsw-font-markdown-small-italic',
  '--dsw-font-markdown-small-strong-italic',
  '--dsw-font-markdown-table',
  '--dsw-font-markdown-table-head',
  '--dsw-font-markdown-code',
  '--dsw-font-markdown-code-block',
  '--dsw-font-markdown-code-block-small',
  '--dsw-font-markdown-h1',
  '--dsw-font-markdown-h2',
  '--dsw-font-markdown-h3',
  '--dsw-font-markdown-h4',
]

/** The host's content-font axis (the transcript chrome's scale). */
const CONTENT_AXIS = [
  '--dsh-content-font-size',
  '--dsh-content-font-size-secondary',
  '--dsh-content-font-delta',
  '--dsh-content-font-delta-secondary',
]

/** Tokens that exist without being one of the size shorthands. */
const OTHER_DEFINED = ['--dsw-font-family']

/** Tokens the host does NOT define; a `font:` shorthand naming one is void. */
const UNDEFINED_TOKENS = ['--dsw-font-s-11', '--dsw-font-s-12', '--dsw-font-s-13', '--dsw-font-s-15', '--dsw-font-s-16']

const COMPONENT_SUFFIXES = ['-font-family', '-font-weight', '-font-size', '-line-height', '-font-style']

/** Whether a variable name is a host-defined fixed font token. */
function isHostFontToken(name: string): boolean {
  if (OTHER_DEFINED.includes(name)) return true
  return HOST_FONT_SHORTHANDS.some((base) => {
    if (name === base) return true
    if (!name.startsWith(base)) return false
    const suffix = name.slice(base.length)
    return COMPONENT_SUFFIXES.includes(suffix)
  })
}

/**
 * Whether a variable CARRIES a size: the shorthand itself or its `-font-size`
 * component. `-font-family` / `-font-weight` / `-font-style` / `-line-height`
 * are host tokens too, but naming one of them never sets the size the pills
 * need, so they do not satisfy contract point 2.
 */
function isSizeToken(name: string): boolean {
  return HOST_FONT_SHORTHANDS.some(base => name === base || name === `${base}-font-size`)
}

/** Whether a variable name is acceptable inside a `font:`/`font-size:` value. */
function isDefinedTypeToken(name: string): boolean {
  return isHostFontToken(name) || CONTENT_AXIS.includes(name)
}

interface CssRule {
  selector: string
  declarations: Map<string, string>
}

function declarationMap(body: string): Map<string, string> {
  const declarations = new Map<string, string>()
  for (const chunk of body.split(';')) {
    const at = chunk.indexOf(':')
    if (at === -1) continue
    const property = chunk.slice(0, at).trim()
    const value = chunk.slice(at + 1).trim().replace(/\s+/g, ' ')
    if (property !== '') declarations.set(property, value)
  }
  return declarations
}

/** Every style rule in the sheet, including the ones nested in `@media`. */
function parseRules(css: string): CssRule[] {
  const rules: CssRule[] = []
  let cursor = 0
  let preludeStart = 0
  while (cursor < css.length) {
    const char = css[cursor]
    if (char === '{') {
      const prelude = css.slice(preludeStart, cursor).trim().replace(/\s+/g, ' ')
      let depth = 1
      let end = cursor + 1
      while (end < css.length && depth > 0) {
        if (css[end] === '{') depth += 1
        else if (css[end] === '}') depth -= 1
        end += 1
      }
      const body = css.slice(cursor + 1, end - 1)
      if (prelude.startsWith('@')) {
        if (/^@(?:media|supports|layer|container)\b/.test(prelude)) rules.push(...parseRules(body))
      } else {
        rules.push({ selector: prelude, declarations: declarationMap(body) })
      }
      cursor = end
      preludeStart = end
      continue
    }
    if (char === ';' && css.slice(preludeStart, cursor).trim().startsWith('@')) preludeStart = cursor + 1
    cursor += 1
  }
  return rules
}

const rules = parseRules(source)

/**
 * Every rule that names this selector — a media-query override re-mentions it
 * (e.g. `.sidechatStatusText` inside `prefers-reduced-motion`), and only one of
 * them declares the type.
 */
function rulesFor(selector: string): CssRule[] {
  const matches = rules.filter(rule => rule.selector.split(',').map(part => part.trim()).includes(selector))
  expect(matches.length, `${SHEET}: at least one rule for ${selector}`).toBeGreaterThan(0)
  return matches
}

/** Every variable a declaration value names, including `var()` fallbacks. */
function variablesIn(value: string): string[] {
  return [...value.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map(match => match[1] as string)
}

/** The declared type value of a rule (`font:` or `font-size:`). */
function typeValueOf(rule: CssRule): string | undefined {
  return rule.declarations.get('font-size') ?? rule.declarations.get('font')
}

describe('pill and status-line typography sits on real host tokens', () => {
  it('the host tokens this contract relies on are the defined ones, not the invented ones', () => {
    // Guard the data itself: the size steps the pills must use are defined …
    for (const token of ['--dsw-font-xxs-12', '--dsw-font-xs-13', '--dsw-font-s-14']) {
      expect(isHostFontToken(token), `${token} is a host-defined step`).toBe(true)
    }
    // … and the two names the sheet currently invents are not.
    for (const token of UNDEFINED_TOKENS) {
      expect(isHostFontToken(token), `${token} must not be treated as a host token`).toBe(false)
    }
  })

  it('sizes the reveal pill, the back-to-latest pill and the status line from a defined step', () => {
    const targets = ['.sidechatRevealEarlier', '.sidechatToLatest', '.sidechatStatusText']
    for (const selector of targets) {
      const value = rulesFor(selector).map(typeValueOf).find(declared => declared !== undefined)
      expect(value, `${selector} declares a font size`).toBeDefined()
      const used = variablesIn(value as string)
      expect(used.length, `${selector}: the size must come from a token, got "${String(value)}"`).toBeGreaterThan(0)
      // Every reference must exist, and at least one must actually carry a size.
      for (const name of used) {
        expect(
          isHostFontToken(name),
          `${selector}: "${String(value)}" uses ${name}, which the host does not define (a \`font:\` shorthand with an undefined variable is discarded wholesale)`,
        ).toBe(true)
      }
      expect(
        used.some(isSizeToken),
        `${selector}: "${String(value)}" names no size-bearing host token (expected a size step or its -font-size)`,
      ).toBe(true)
    }
  })

  it('never names an undefined font token anywhere a size is declared', () => {
    const typeDeclarations = ['font', 'font-size']
    let scanned = 0
    for (const rule of rules) {
      for (const property of typeDeclarations) {
        const value = rule.declarations.get(property)
        if (value === undefined) continue
        scanned += 1
        for (const name of variablesIn(value)) {
          expect(
            isDefinedTypeToken(name),
            `${rule.selector}: ${property}: ${value} → ${name} is not a token the host defines`,
          ).toBe(true)
        }
      }
    }
    // Guard the scan: the sheet really does declare type on many rules.
    expect(scanned, 'the sheet declares font sizing').toBeGreaterThan(10)
  })

  it('carries none of the invented size step names at all', () => {
    for (const token of ['--dsw-font-s-12', '--dsw-font-s-13']) {
      expect(source.includes(token), `${SHEET} must not reference ${token}`).toBe(false)
    }
  })
})
