/**
 * D3 (P0) — the transcript's TEXT CHROME must follow the host's content-font
 * axis instead of sitting on fixed 12/14px tokens. Design basis:
 * `/tmp/bsb-parity/spec.md` §D3 and §3.3.
 *
 * Why this static spec exists: `SideChatView.module.css` sets every chrome
 * line — tool/thinking rows, the usage tail, the present card, the hint and
 * error rows, the queue meta — to `font: var(--dsw-font-xxs-12)` (a fixed
 * 12px/18px pair), and its bubbles to `var(--dsw-font-s-14)` (14px/22px). The
 * body of an answer is a host `MarkdownText`, which DOES follow the reader's
 * content-size setting (`--dsh-content-font-size`). So raising the setting
 * scales the prose and leaves every surrounding row at 12px: hierarchy and
 * rhythm drift apart, and the panel reads worse the larger the reader makes
 * the text. The host's own solution (`ui-chat/chat/MessageItem.module.css`) is
 * one axis for both:
 *
 *   chrome : font-size: var(--dsh-content-font-size-secondary, 13px);
 *            line-height: calc(18px + var(--dsh-content-font-delta-secondary, 0px));
 *   body   : font-size: var(--dsh-content-font-size, 14px);
 *            line-height: calc(22px + var(--dsh-content-font-delta, 0px));
 *
 * ============================ CONTRACT ============================
 * The stylesheet `src/client/SideChatView.module.css` must satisfy, for the
 * rules named below:
 *
 * 1. CHROME size comes from `--dsh-content-font-size-secondary` (with any
 *    fallback), CHROME line-height from `--dsh-content-font-delta-secondary`
 *    (in a calc) or a unitless multiple. BODY size comes from
 *    `--dsh-content-font-size` (or the host alias
 *    `--dsw-font-markdown-base-font-size`), BODY line-height from
 *    `--dsh-content-font-delta` (in a calc) or unitless.
 * 2. No rule in either list may keep a fixed-size font token
 *    (`--dsw-font-xxs-12` / `-s-12` / `-s-13` / `-s-14`) or a bare px size.
 * 3. Nothing unrelated moves: each rule keeps the colour / spacing / geometry
 *    declarations it has today (the table below is the snapshot), no NEW color
 *    literal may appear anywhere in the sheet, and the `--dsh-content-font-*`
 *    variables may ONLY appear in `font` / `font-size` / `line-height`
 *    declarations — never in a colour, border or spacing value.
 *    ONE paint value moved on purpose, and it is recorded here rather than
 *    slipped in: the composer error banner and the failed-attempt row paint
 *    through the host's REAL state token `--dsw-alias-state-error-primary`.
 *    The upstream spelling they used (`--dsw-alias-danger`) is not defined by
 *    the host theme, so every declaration using it was invalid at
 *    computed-value time — the error copy and border painted NOTHING.
 * 4. `.sidechatRowCode` (and every other monospace rule in the sheet) keeps a
 *    monospace family in the form the host itself uses: the token FIRST and an
 *    explicit fallback stack after it — `font-family: var(--dsw-font-mono,
 *    ui-monospace, SFMono-Regular, Menlo, monospace)`. The host theme never
 *    defines `--dsw-font-mono`, so a bare `var(--dsw-font-mono)` is invalid at
 *    computed-value time and drops the whole declaration (the row then renders
 *    in the body face, not monospace). Token-first matters too: a stack whose
 *    FIRST family is a concrete one never lets a skin's token win.
 * 5. COLOUR. No colour literal may be added anywhere in the sheet (the only
 *    allowed ones are the snapshot below), and every PAINT declaration — colour,
 *    background, border, outline, shadow, fill/stroke — either resolves through
 *    `var(...)` or is one of the inert keywords (`transparent`, `none`,
 *    `inherit`, `currentcolor`, …). That closes the hole a literal-snapshot
 *    alone leaves open: a named colour (`white`) or a modern function
 *    (`oklch(…)`) is not matched by a hex/rgb/hsl pattern but is still a paint
 *    of the plugin's own.
 *
 * CHROME (secondary axis)
 *   .sidechatRowLine          tool / thinking / injection summary line
 *   .sidechatRowProse         reasoning + context-injection body
 *   .sidechatRowCode          raw tool args / result text
 *   .sidechatTurnSummary      turn-tail usage · duration
 *   .sidechatDeliverablesHead present-card title
 *   .sidechatDeliverable      one delivered file row
 *   .sidechatHint             composer hint line ("no turn yet", "queued")
 *   .sidechatError            composer error banner
 *   .sidechatErrorRow         failed-attempt transcript row
 *   .sidechatPendingMeta      queued / sending meta line
 * BODY (primary axis)
 *   .sidechatUser             user bubble
 *   .sidechatAssistant        assistant narration
 *   .sidechatPending          pending / local-echo bubble
 *
 * Deliberately OUT of scope (do not touch, and this file does not ask for it):
 * the hero screen, the composer input, the model capsule, the reveal /
 * back-to-latest pills, the primary button and the running status line — those
 * are not transcript chrome, and their sizing is a separate decision.
 * ==================================================================
 *
 * The spec is static: it reads the stylesheet text, runs no DOM and no layout
 * (jsdom computes no `var()`), exactly like tests/theme.spec.ts does for the
 * skin contract.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SHEET = 'src/client/SideChatView.module.css'

/** Comments removed once: every scan below is about declarations. */
const source = readFileSync(resolve(process.cwd(), SHEET), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** The host's content-font axis (see /root/dsh-web/app packages/client/ui-theme). */
const CONTENT_SIZE = '--dsh-content-font-size'
const CONTENT_SIZE_SECONDARY = '--dsh-content-font-size-secondary'
const CONTENT_DELTA = '--dsh-content-font-delta'
const CONTENT_DELTA_SECONDARY = '--dsh-content-font-delta-secondary'
/** The host's own body-size alias (resolves to --dsh-content-font-size). */
const MARKDOWN_BASE_SIZE = '--dsw-font-markdown-base-font-size'
/** The fixed-size tokens this contract retires (12/18, 13/20, 14/22 pairs). */
const FIXED_SIZE_TOKENS = ['--dsw-font-xxs-12', '--dsw-font-s-12', '--dsw-font-s-13', '--dsw-font-s-14']

const CHROME = [
  '.sidechatRowLine',
  '.sidechatRowProse',
  '.sidechatRowCode',
  '.sidechatTurnSummary',
  '.sidechatDeliverablesHead',
  '.sidechatDeliverable',
  '.sidechatHint',
  '.sidechatError',
  '.sidechatErrorRow',
  '.sidechatPendingMeta',
]

const BODY = ['.sidechatUser', '.sidechatAssistant', '.sidechatPending']

/**
 * Declarations that must NOT move: colour, spacing and the bubble geometry.
 * Only font sizing is in scope, so everything here is a scope-creep guard, and
 * the values are today's (pre-change) ones on purpose.
 */
const UNCHANGED: Record<string, Record<string, string>> = {
  '.sidechatRowLine': { gap: '6px', padding: '1px 0', color: 'var(--dsw-alias-label-tertiary)' },
  '.sidechatRowProse': { 'max-height': '240px', color: 'var(--dsw-alias-label-tertiary)' },
  '.sidechatRowCode': { padding: '4px 0', 'max-height': '220px', color: 'var(--dsw-alias-label-secondary)' },
  '.sidechatTurnSummary': {
    'max-width': '88%',
    padding: '0 2px',
    color: 'var(--dsw-alias-label-tertiary)',
    'font-variant-numeric': 'tabular-nums',
  },
  '.sidechatDeliverablesHead': { color: 'var(--dsw-alias-label-tertiary)' },
  '.sidechatDeliverable': {
    gap: '6px',
    padding: '3px 4px',
    border: 'none',
    'border-radius': '6px',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
  },
  '.sidechatHint': { padding: '4px 12px', color: 'var(--dsw-alias-label-tertiary)' },
  '.sidechatError': { padding: '4px 12px', color: 'var(--dsw-alias-state-error-primary)' },
  '.sidechatErrorRow': {
    padding: '6px 10px',
    border: '1px solid var(--dsw-alias-state-error-primary)',
    'border-radius': '8px',
    color: 'var(--dsw-alias-state-error-primary)',
  },
  '.sidechatPendingMeta': { gap: '6px', color: 'var(--dsw-alias-label-tertiary)' },
  '.sidechatUser': {
    'align-self': 'flex-end',
    'max-width': '88%',
    padding: '8px 14px',
    'border-radius': '18px',
    background: 'var(--dsw-specific-bubble, var(--dsw-alias-bg-base))',
    color: 'var(--dsw-alias-label-primary)',
  },
  '.sidechatAssistant': { 'align-self': 'stretch', color: 'var(--dsw-alias-label-primary)' },
  '.sidechatPending': {
    'align-self': 'flex-end',
    'max-width': '88%',
    gap: '2px',
    padding: '8px 10px 6px 14px',
    'border-radius': '18px',
    background: 'var(--dsw-specific-bubble, var(--dsw-alias-bg-base))',
    color: 'var(--dsw-alias-label-primary)',
  },
}

/**
 * The colour literals this sheet is allowed to contain — EFFECTIVE WHITELIST:
 * exactly two `#fff` tokens, both as the last resort fallback of the two
 * `--dsw-alias-accent-ink` chains (`.sidechatPrimaryBtn`, `.sidechatSendBtn`).
 *
 * The list is a SNAPSHOT, so it only ever shrinks: when a literal stops existing
 * (the floating pill's `rgb(0 0 0 / 12%)` shadow fallback became a host shadow
 * token), its entry is removed, and re-introducing that exact literal then
 * fails. Keeping a stale entry would silently legalise it again.
 */
const EXISTING_COLOR_LITERALS = ['#fff', '#fff']

/**
 * Paint properties: a value here is visible ink, so it must be a token (or an
 * inert keyword). This is what catches the literal shapes the snapshot regex
 * cannot see — `white`, `oklch(…)`, `color(display-p3 …)`.
 */
const PAINT_PROPERTIES = [
  'color',
  'background',
  'background-color',
  'background-image',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline',
  'outline-color',
  'box-shadow',
  'text-decoration-color',
  'caret-color',
  'fill',
  'stroke',
  'scrollbar-color',
]

/** Values that paint nothing of their own. */
const INERT_PAINT = /^(?:none|normal|inherit|initial|unset|revert|transparent|currentcolor|auto|0)$/i

/**
 * The monospace family shape this contract requires: the token first, then a
 * NON-EMPTY fallback stack. `var(--dsw-font-mono, )` is as broken as a bare
 * `var(--dsw-font-mono)` — an empty fallback is guaranteed-invalid, so the whole
 * declaration is dropped and the row renders in the inherited face.
 */
const MONO_STACK = /^var\(\s*--dsw-font-mono\s*,\s*[a-z"']/i

interface CssRule {
  /** The full prelude, whitespace-folded (comma groups kept). */
  selector: string
  declarations: Map<string, string>
}

/** A declaration map of one block body. */
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
        // Nested rules (@media) recurse; @keyframes bodies are not style rules.
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

/** The single rule for one selector (a comma group counts if it names it). */
function ruleOf(selector: string): CssRule {
  const matches = rules.filter(rule => rule.selector.split(',').map(part => part.trim()).includes(selector))
  expect(matches.length, `${SHEET}: exactly one rule for ${selector}`).toBe(1)
  return matches[0] as CssRule
}

/** The first whitespace-separated token of a shorthand (parens respected). */
function firstToken(value: string): string {
  let depth = 0
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (/\s/.test(char as string) && depth === 0) return value.slice(0, index)
  }
  return value
}

/** The size / line-height a rule declares, longhand or shorthand. */
function typeOf(rule: CssRule): { size: string; lineHeight: string | undefined } | undefined {
  const size = rule.declarations.get('font-size')
  const shorthand = rule.declarations.get('font')
  const longhandHeight = rule.declarations.get('line-height')
  let shorthandSize: string | undefined
  let shorthandHeight: string | undefined
  if (shorthand !== undefined) {
    // `font: <size>/<line-height> <family>` — split on the FIRST slash.
    let depth = 0
    let slash = -1
    for (let index = 0; index < shorthand.length; index += 1) {
      const char = shorthand[index]
      if (char === '(') depth += 1
      else if (char === ')') depth -= 1
      else if (char === '/' && depth === 0) { slash = index; break }
    }
    if (slash === -1) {
      shorthandSize = firstToken(shorthand)
    } else {
      shorthandSize = firstToken(shorthand.slice(0, slash).trim().split(/\s+(?![^(]*\))/).at(-1) ?? '')
      shorthandHeight = firstToken(shorthand.slice(slash + 1).trim())
    }
  }
  const resolvedSize = size ?? shorthandSize
  if (resolvedSize === undefined) return undefined
  return { size: resolvedSize, lineHeight: longhandHeight ?? shorthandHeight }
}

/** Whether a size expression comes from one content-font variable. */
function usesContentSize(size: string, variable: string): boolean {
  return new RegExp(`var\\(\\s*${variable}(?![\\w-])`).test(size)
}

/** Whether a line-height follows the content-font delta (or is a multiple). */
function usesContentDelta(lineHeight: string | undefined, delta: string): boolean {
  if (lineHeight === undefined) return true
  // A unitless multiple scales with the font size by itself.
  if (/^\d*\.?\d+$/.test(lineHeight)) return true
  return new RegExp(`var\\(\\s*${delta}(?![\\w-])`).test(lineHeight)
}

describe('side chat typography: chrome follows the host content-font axis (D3)', () => {
  it('sets every chrome size from --dsh-content-font-size-secondary (and the matching delta)', () => {
    expect(CHROME.length).toBeGreaterThan(5)
    for (const selector of CHROME) {
      const type = typeOf(ruleOf(selector))
      expect(type, `${selector} declares a font size`).toBeDefined()
      expect(
        usesContentSize((type as { size: string }).size, CONTENT_SIZE_SECONDARY),
        `${selector}: font size must come from var(${CONTENT_SIZE_SECONDARY}), got "${(type as { size: string }).size}"`,
      ).toBe(true)
      expect(
        usesContentDelta((type as { lineHeight: string | undefined }).lineHeight, CONTENT_DELTA_SECONDARY),
        `${selector}: line-height must follow var(${CONTENT_DELTA_SECONDARY}) or be unitless, got "${String((type as { lineHeight: string | undefined }).lineHeight)}"`,
      ).toBe(true)
    }
  })

  it('sets every bubble / narration size from --dsh-content-font-size (and the matching delta)', () => {
    for (const selector of BODY) {
      const type = typeOf(ruleOf(selector))
      expect(type, `${selector} declares a font size`).toBeDefined()
      const size = (type as { size: string }).size
      const fromAxis = usesContentSize(size, CONTENT_SIZE) || usesContentSize(size, MARKDOWN_BASE_SIZE)
      expect(
        fromAxis,
        `${selector}: font size must come from var(${CONTENT_SIZE}) (or ${MARKDOWN_BASE_SIZE}), got "${size}"`,
      ).toBe(true)
      expect(
        usesContentDelta((type as { lineHeight: string | undefined }).lineHeight, CONTENT_DELTA),
        `${selector}: line-height must follow var(${CONTENT_DELTA}) or be unitless, got "${String((type as { lineHeight: string | undefined }).lineHeight)}"`,
      ).toBe(true)
    }
  })

  it('retires the fixed 12/13/14px font tokens from every transcript text rule', () => {
    for (const selector of [...CHROME, ...BODY]) {
      const rule = ruleOf(selector)
      for (const [property, value] of rule.declarations) {
        for (const token of FIXED_SIZE_TOKENS) {
          expect(
            value.includes(token),
            `${selector}: ${property}: ${value} still uses the fixed-size ${token}`,
          ).toBe(false)
        }
        // A bare px size in a type position is the same defect in another spelling.
        if (property === 'font-size' || property === 'font') {
          expect(
            /(?:^|[\s/])\d+(?:\.\d+)?px(?![\w-])/.test(value.replace(/var\([^)]*\)/g, '')),
            `${selector}: ${property}: ${value} hardcodes a px font size`,
          ).toBe(false)
        }
      }
    }
  })

  it('paints nothing that is not a token or an inert keyword', () => {
    let scanned = 0
    for (const rule of rules) {
      for (const property of PAINT_PROPERTIES) {
        const value = rule.declarations.get(property)
        if (value === undefined) continue
        if (INERT_PAINT.test(value)) continue
        scanned += 1
        expect(
          value.includes('var('),
          `${rule.selector}: ${property}: ${value} paints from a literal instead of a token`,
        ).toBe(true)
      }
    }
    // Guard the scan: the sheet really does paint.
    expect(scanned, 'no tokenised paint declaration found').toBeGreaterThan(10)
  })

  it('keeps every colour, spacing and bubble-geometry declaration where it was', () => {
    for (const [selector, guards] of Object.entries(UNCHANGED)) {
      const rule = ruleOf(selector)
      for (const [property, expected] of Object.entries(guards)) {
        expect(
          rule.declarations.get(property),
          `${selector} must keep ${property}: ${expected} (only font sizing is in scope)`,
        ).toBe(expected)
      }
    }
  })

  it('adds no colour literal and no new use of the content-font axis outside type declarations', () => {
    // 1. The color-literal snapshot is unchanged (a new literal paints a colour
    //    of the plugin's own, which the skin contract forbids).
    const literals = [...source.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/g)].map(match => match[0])
    expect(literals.sort()).toEqual([...EXISTING_COLOR_LITERALS].sort())

    // 2. The content-font axis is a type contract, never a colour or spacing one.
    const typeProperties = new Set(['font', 'font-size', 'line-height'])
    let axisUses = 0
    for (const rule of rules) {
      for (const [property, value] of rule.declarations) {
        if (!value.includes('--dsh-content-font-')) continue
        axisUses += 1
        expect(
          typeProperties.has(property),
          `${rule.selector}: ${property}: ${value} routes a non-type value through the content-font axis`,
        ).toBe(true)
      }
    }
    // Guard the scan itself: the axis is actually used by the transcript rules.
    expect(axisUses, 'no content-font variable is used at all').toBeGreaterThan(CHROME.length + BODY.length - 1)
  })

  it('keeps the raw tool text monospace, with the token first and a real fallback', () => {
    const family = ruleOf('.sidechatRowCode').declarations.get('font-family') ?? ''
    expect(
      family,
      '.sidechatRowCode must be `var(--dsw-font-mono, <fallback stack>)`: the token first, a fallback list after it',
    ).toMatch(MONO_STACK)
    // A single concrete family (no token) also satisfies "monospace", but it drops
    // the skin's own choice — the assertion above is deliberately stricter. The
    // fallback may name a concrete stack OR the host's own code-font token
    // (`--ds-font-family-code`, which is the host's monospace stack and the one
    // it uses instead of a bare `monospace` keyword).
    expect(family, 'the fallback names a real monospace source').toMatch(/ui-monospace|SFMono|Menlo|var\(--ds-font-family-code\)/)
    // The host deliberately avoids a bare `monospace` tail (Windows CJK falls
    // back to SimSun there), so this stack must not reintroduce one.
    expect(family, 'the fallback must not end on a bare monospace keyword').not.toMatch(/,\s*monospace\s*;?\s*$/)
  })

  it('never leaves a monospace family on a bare, undefined token', () => {
    // The host defines no `--dsw-font-mono`: a bare var() there is invalid at
    // computed-value time, and a fallback-first stack makes the token useless.
    let monospaceDeclarations = 0
    for (const rule of rules) {
      for (const property of ['font-family', 'font']) {
        const value = rule.declarations.get(property)
        if (value === undefined || !value.includes('--dsw-font-mono')) continue
        monospaceDeclarations += 1
        if (property === 'font-family') {
          expect(
            value,
            `${rule.selector}: font-family: ${value} — the token must be the FIRST family and carry a fallback`,
          ).toMatch(MONO_STACK)
        } else {
          // In a `font` shorthand the family is LAST, so "token first" is not the
          // rule there — but the token still needs its non-empty fallback stack.
          expect(
            value,
            `${rule.selector}: font: ${value} — a var(--dsw-font-mono) without a fallback stack is invalid at computed-value time`,
          ).toMatch(/var\(\s*--dsw-font-mono\s*,\s*[a-z"']/i)
        }
      }
    }
    // Guard the scan: the sheet really does declare a monospace face.
    expect(monospaceDeclarations, 'no monospace declaration found').toBeGreaterThan(0)
  })
})
