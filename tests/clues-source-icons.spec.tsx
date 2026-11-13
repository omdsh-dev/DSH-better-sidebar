/**
 * The four built-in clue source glyphs and their token paint.
 *
 * Pins the contract the workbench relies on:
 * - every glyph is decorative (`aria-hidden`, `focusable="false"`) and a
 *   square at the requested/default size, including the size-aware factories;
 * - the GitHub `className` API still reaches the `<svg>` root;
 * - each glyph has several independently colored layers and every painted
 *   shape rides `currentColor`, so a consumer painting the outer slot neutral
 *   cannot replace the layers' own color;
 * - `source-icons.module.css` is flat token paint: only `--dsw-alias-*`
 *   declarations with fallbacks, no literal colors, no static/local tokens.
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import {
  GithubIssueIcon,
  GithubPullRequestIcon,
} from '../src/client/clues/sources/github/icons.tsx'
import {
  FeishuDocsGlyph,
  FeishuTasksGlyph,
  feishuDocsIcon,
  feishuTasksIcon,
} from '../src/client/clues/sources/feishu/icons.tsx'
import styles from '../src/client/clues/sources/source-icons.module.css'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'

setupReactAct()

/** The only tokens the source glyphs may use. */
const ALLOWED_TOKENS = new Set([
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-business-tertiary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-success-secondary',
  '--dsw-alias-state-success-tertiary',
  '--dsw-alias-state-warn-label',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-state-warn-secondary',
  '--dsw-alias-state-warn-tertiary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-bg-base',
])

/** Every class the stylesheet must define, one per painted layer. */
const CLASS_NAMES = [
  'issueBackdrop',
  'issueRing',
  'issueDot',
  'pullBranch',
  'pullNode',
  'pullNodeMerge',
  'docsBackdrop',
  'docsSheet',
  'docsFold',
  'docsText',
  'tasksBackdrop',
  'tasksBase',
  'tasksCheckHalo',
  'tasksCheck',
] as const

type ClassName = (typeof CLASS_NAMES)[number]

/** Typed view of the CSS module class map (noUncheckedIndexedAccess-safe). */
const css = styles as Record<ClassName, string>

interface GlyphCase {
  readonly name: string
  readonly node: ReactNode
  readonly classes: readonly string[]
}

const GLYPHS: readonly GlyphCase[] = [
  {
    name: 'github issue',
    node: <GithubIssueIcon />,
    classes: [css.issueBackdrop, css.issueRing, css.issueDot],
  },
  {
    name: 'github pull request',
    node: <GithubPullRequestIcon />,
    classes: [css.pullBranch, css.pullNode, css.pullNodeMerge],
  },
  {
    name: 'feishu docs',
    node: feishuDocsIcon(16),
    classes: [css.docsBackdrop, css.docsSheet, css.docsFold, css.docsText],
  },
  {
    name: 'feishu tasks',
    node: feishuTasksIcon(16),
    classes: [
      css.tasksBackdrop,
      css.tasksBase,
      css.tasksCheckHalo,
      css.tasksCheck,
    ],
  },
]

const CSS_TEXT = readFileSync(
  resolve(import.meta.dirname, '../src/client/clues/sources/source-icons.module.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '')

let mounted: RenderedRoot | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  document.body.innerHTML = ''
})

/** Render one icon into a fresh container and return its root `<svg>`. */
function render(node: ReactNode): SVGSVGElement {
  mounted?.unmount()
  mounted = renderRoot(<div>{node}</div>)
  const svg = mounted.container.querySelector('svg')
  if (svg === null) throw new Error('the icon rendered no svg')
  return svg
}

describe('clue source glyphs', () => {
  it('renders all four glyphs decorative, square and at the requested size', () => {
    const cases: readonly { name: string; node: ReactNode; size: number }[] = [
      { name: 'github issue', node: <GithubIssueIcon />, size: 16 },
      { name: 'github pull request', node: <GithubPullRequestIcon size={14} />, size: 14 },
      { name: 'feishu docs', node: feishuDocsIcon(16), size: 16 },
      { name: 'feishu tasks', node: feishuTasksIcon(14), size: 14 },
    ]
    for (const { name, node, size } of cases) {
      const svg = render(node)
      expect(svg.getAttribute('aria-hidden'), name).toBe('true')
      expect(svg.getAttribute('focusable'), name).toBe('false')
      expect(svg.getAttribute('viewBox'), name).toBe('0 0 16 16')
      expect(svg.getAttribute('width'), name).toBe(String(size))
      expect(svg.getAttribute('height'), name).toBe(String(size))
    }
  })

  it('honours a non-default size through both the component and the factory', () => {
    expect(render(<GithubIssueIcon size={22} />).getAttribute('width')).toBe('22')
    expect(render(<GithubPullRequestIcon size={11} />).getAttribute('height')).toBe('11')
    expect(render(feishuDocsIcon(20)).getAttribute('width')).toBe('20')
    expect(render(feishuTasksIcon(18)).getAttribute('height')).toBe('18')
    expect(render(<FeishuDocsGlyph size={19} />).getAttribute('width')).toBe('19')
    expect(render(<FeishuTasksGlyph size={13} />).getAttribute('width')).toBe('13')
  })

  it('keeps the GitHub className API on the svg root', () => {
    const issue = render(<GithubIssueIcon size={14} className="consumer-layout" />)
    expect(issue.classList.contains('consumer-layout')).toBe(true)
    const pull = render(<GithubPullRequestIcon size={14} className="consumer-layout-pull" />)
    expect(pull.classList.contains('consumer-layout-pull')).toBe(true)
  })

  it('mounts every color layer as a distinct class and paints it with currentColor', () => {
    for (const glyph of GLYPHS) {
      const svg = render(glyph.node)
      for (const className of glyph.classes) {
        expect(svg.querySelector(`.${className}`), `${glyph.name}: ${className}`).not.toBeNull()
      }

      const layers = [...svg.querySelectorAll<SVGGElement>('g[class]')]
      expect(layers.length, glyph.name).toBeGreaterThanOrEqual(3)
      expect(
        new Set(layers.map(layer => layer.getAttribute('class'))).size,
        `${glyph.name}: every layer needs its own class`,
      ).toBe(layers.length)

      for (const layer of layers) {
        const shapes = [...layer.querySelectorAll<SVGElement>('circle, path, rect')]
        expect(shapes.length, glyph.name).toBeGreaterThan(0)
        for (const shape of shapes) {
          // All paint goes through currentColor; no literal, no hardcoded fill.
          expect(
            shape.getAttribute('fill') === 'currentColor' ||
              shape.getAttribute('stroke') === 'currentColor',
            `${glyph.name}: a shape is not painted with currentColor`,
          ).toBe(true)
          for (const attribute of ['fill', 'stroke'] as const) {
            const value = shape.getAttribute(attribute)
            if (value !== null) expect(['currentColor', 'none']).toContain(value)
          }
        }
      }
    }
  })

  it('keeps its own token layers under a consumer that paints the outer wrapper gray', () => {
    const svg = render(
      <span style={{ color: 'rgb(128, 128, 128)' }}>
        <GithubIssueIcon />
      </span>,
    )
    const wrapper = svg.parentElement as HTMLElement
    expect(wrapper.style.color).toBe('rgb(128, 128, 128)')
    for (const className of [css.issueBackdrop, css.issueRing, css.issueDot]) {
      expect(svg.querySelector(`.${className}`)).not.toBeNull()
    }
    // The root does not carry an inline color or a color attribute: the layers
    // are the color carriers, so the wrapper's neutral ink cannot flatten them.
    expect(svg.getAttribute('color')).toBeNull()
    expect(svg.getAttribute('style')).toBeNull()
  })
})

describe('clue source icon stylesheet', () => {
  it('keeps the icon modules free of color literals', () => {
    for (const file of ['github/icons.tsx', 'feishu/icons.tsx']) {
      const source = readFileSync(
        resolve(import.meta.dirname, `../src/client/clues/sources/${file}`),
        'utf8',
      )
      expect(source, file).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i)
    }
  })

  it('defines one class per painted layer', () => {
    for (const className of CLASS_NAMES) {
      expect(CSS_TEXT, className).toContain(`.${className} {`)
    }
  })

  it('uses only allowed alias tokens, each with a fallback', () => {
    expect(CSS_TEXT).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i)
    expect(CSS_TEXT).not.toMatch(/--dsw-static-|--dsh-|--dsl-/)
    expect(CSS_TEXT).not.toMatch(/var\(\s*--ds-/)

    const declarations = [...CSS_TEXT.matchAll(/color:\s*([^;]+);/g)].map(match => match[1]!.trim())
    expect(declarations.length).toBeGreaterThanOrEqual(CLASS_NAMES.length)
    for (const value of declarations) {
      expect(value).toMatch(/^var\(--dsw-alias-[a-z0-9-]+,\s*/)
      const tokens = [...value.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map(match => match[1]!)
      expect(tokens.length).toBeGreaterThan(0)
      for (const token of tokens) {
        expect(ALLOWED_TOKENS.has(token), `${token} is not an allowed source-icon token`).toBe(true)
      }
      expect(value, `${value} has no fallback`).toContain(',')
    }
  })
})
