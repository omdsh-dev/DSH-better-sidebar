/**
 * The clue pack artwork and the two shared icon resolvers.
 *
 * Pins the presentation contract the browser, pack window and settings rows
 * share:
 * - `CluePackArtwork` is decorative, id-free, layered (warm back sheet +
 *   blue front sheet + surface marks) and scales to the 14/16/26px seats;
 * - `sourceIcon` uses the host folder artwork for built-in files, honours a
 *   registered factory's requested size, passes a registered node through
 *   unchanged, and still returns a non-empty fallback for an unknown source;
 * - `resourceIcon` lets the real local path win over the display title, uses
 *   the folder kind for directories, falls back to the title when a locator
 *   has no path, and lets a local display registration beat the host artwork;
 * - the pack stylesheet paints only `--dsw-alias-*`, never a literal.
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { FileTypeIcon } from '@deepseek-ai/dsh-client-ui-primitives'
import { BUILTIN_SOURCE_IDS } from '../src/clues/types.ts'
import { CluePackArtwork } from '../src/client/clues/artwork.tsx'
import { resourceIcon, sourceIcon } from '../src/client/clues/tab/browser-shared.tsx'
import artworkStyles from '../src/client/clues/artwork.module.css'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'

setupReactAct()

/** Typed view of the artwork class map (noUncheckedIndexedAccess-safe). */
const artworkCss = artworkStyles as Record<'packBack' | 'packFront' | 'packMark', string>

/** Read one element's props without leaking the host's colors into the spec. */
function asElement(node: ReactNode): ReactElement<Record<string, unknown>> {
  if (!isValidElement(node)) throw new Error('expected the resolver to return a React element')
  return node as ReactElement<Record<string, unknown>>
}

const ARTWORK_CSS = readFileSync(
  resolve(import.meta.dirname, '../src/client/clues/artwork.module.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '')

let mounted: RenderedRoot | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  document.body.innerHTML = ''
})

/** Render one pack artwork at `size` and return its wrapper. */
function renderArtwork(size: number): HTMLElement {
  mounted?.unmount()
  mounted = renderRoot(<CluePackArtwork size={size} />)
  const root = mounted.container.querySelector<HTMLElement>('[data-clue-artwork="pack"]')
  if (root === null) throw new Error('the pack artwork rendered no wrapper')
  return root
}

describe('CluePackArtwork', () => {
  it('renders decorative, id-free layered artwork at 14/16/26', () => {
    for (const size of [14, 16, 26]) {
      const root = renderArtwork(size)
      const svg = root.querySelector('svg')
      expect(svg, `size ${size}`).not.toBeNull()
      expect(root.getAttribute('aria-hidden'), `size ${size}`).toBe('true')
      expect(svg!.getAttribute('aria-hidden'), `size ${size}`).toBe('true')
      expect(svg!.getAttribute('focusable'), `size ${size}`).toBe('false')
      expect(svg!.getAttribute('width'), `size ${size}`).toBe(String(size))
      expect(svg!.getAttribute('height'), `size ${size}`).toBe(String(size))

      // The native plugin artwork uses per-instance ids for gradients; this
      // artwork is flat layers, so it must not need any document id at all.
      expect(root.querySelectorAll('[id]'), `size ${size}`).toHaveLength(0)
      expect(root.querySelector('linearGradient, radialGradient, [opacity], [fill-opacity]')).toBeNull()

      const back = root.querySelector(`.${artworkCss.packBack}`)
      const front = root.querySelector(`.${artworkCss.packFront}`)
      const marks = root.querySelectorAll(`.${artworkCss.packMark}`)
      expect(back, `size ${size}: warm back sheet`).not.toBeNull()
      expect(front, `size ${size}: blue front sheet`).not.toBeNull()
      expect(back).not.toBe(front)
      expect(marks.length, `size ${size}: surface marks`).toBeGreaterThan(0)
      // Both sheet shapes are painted through the class, not an inline color.
      expect(back!.getAttribute('fill')).toBe('currentColor')
      expect(front!.getAttribute('fill')).toBe('currentColor')
    }
  })

  it('paints the pack stylesheet only from alias tokens', () => {
    expect(ARTWORK_CSS).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i)
    expect(ARTWORK_CSS).not.toMatch(/--dsw-static-|--dsh-|--dsl-/)
    expect(ARTWORK_CSS).toMatch(/\.packBack\s*\{[^}]*--dsw-alias-state-warn-primary/)
    expect(ARTWORK_CSS).toMatch(/\.packFront\s*\{[^}]*--dsw-alias-state-business-primary/)
    expect(ARTWORK_CSS).toMatch(/\.packMark\s*\{[^}]*--dsw-alias-bg-base/)

    const declarations = [...ARTWORK_CSS.matchAll(/color:\s*([^;]+);/g)].map(match => match[1]!.trim())
    expect(declarations.length).toBeGreaterThanOrEqual(3)
    for (const value of declarations) {
      expect(value).toMatch(/^var\(--dsw-alias-[a-z0-9-]+/)
      const tokens = [...value.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map(match => match[1]!)
      expect(tokens.length).toBeGreaterThan(0)
      for (const token of tokens) expect(token).toMatch(/^--dsw-alias-[a-z0-9-]+$/)
    }
    for (const className of ['packBack', 'packFront', 'packMark']) {
      expect(ARTWORK_CSS).toContain(`.${className}`)
    }
  })
})

describe('sourceIcon', () => {
  it('uses the host folder artwork for the built-in files source', () => {
    const element = asElement(sourceIcon(BUILTIN_SOURCE_IDS.files, [], 14))
    expect(element.type).toBe(FileTypeIcon)
    expect(element.props.kind).toBe('folder')
    expect(element.props.size).toBe(14)
  })

  it('calls a registered factory with the requested size and passes a node through unchanged', () => {
    const sizes: number[] = []
    const factory = (size: number): ReactNode => {
      sizes.push(size)
      return <span data-source-factory={size} />
    }
    const factoryElement = asElement(
      sourceIcon('builtin.github.issues', [{ sourceId: 'builtin.github.issues', icon: factory }], 18),
    )
    expect(sizes).toEqual([18])
    expect(factoryElement.props['data-source-factory']).toBe(18)

    const node = <span data-source-node="direct" />
    expect(sourceIcon('plugin.source', [{ sourceId: 'plugin.source', icon: node }], 12)).toBe(node)
  })

  it('returns a non-empty size-aware fallback for an unknown source', () => {
    const element = asElement(sourceIcon('plugin.unknown', [], 20))
    expect(element.type).not.toBe(FileTypeIcon)
    expect(element.props.size).toBe(20)
  })
})

describe('resourceIcon', () => {
  it('prefers the locator path over the title for real local extensions', () => {
    for (const path of ['/w/notes.md', '/w/spec.pdf', '/w/main.ts']) {
      const element = asElement(resourceIcon({
        sourceId: BUILTIN_SOURCE_IDS.files,
        typeId: 'builtin.files.text',
        locator: { path },
        title: 'display title that must not win',
      }, [], 16))
      expect(element.type, path).toBe(FileTypeIcon)
      expect(element.props.path, path).toBe(path)
      expect(element.props.size, path).toBe(16)
    }
  })

  it('uses the folder kind for directories and keeps the title when the locator has no path', () => {
    const directory = asElement(resourceIcon({
      sourceId: BUILTIN_SOURCE_IDS.files,
      typeId: 'builtin.files.directory',
      locator: { path: '/w/packs' },
      title: 'packs',
    }, [], 15))
    expect(directory.type).toBe(FileTypeIcon)
    expect(directory.props.kind).toBe('folder')
    expect(directory.props.size).toBe(15)
    expect(directory.props.path).toBeUndefined()

    const fallback = asElement(resourceIcon({
      sourceId: BUILTIN_SOURCE_IDS.files,
      typeId: 'builtin.files.markdown',
      locator: {},
      title: 'README.md',
    }, [], 16))
    expect(fallback.type).toBe(FileTypeIcon)
    expect(fallback.props.path).toBe('README.md')
  })

  it('lets a local display registration win over the host file artwork', () => {
    const candidate = {
      sourceId: BUILTIN_SOURCE_IDS.files,
      typeId: 'builtin.files.markdown',
      locator: { path: '/w/notes.md' },
      title: 'notes',
    }

    const node = <span data-local-display="node" />
    expect(resourceIcon(candidate, [{ sourceId: BUILTIN_SOURCE_IDS.files, icon: node }], 12)).toBe(node)

    const sizes: number[] = []
    const factory = (size: number): ReactNode => {
      sizes.push(size)
      return <span data-local-display={size} />
    }
    const element = asElement(resourceIcon(
      candidate,
      [{ sourceId: BUILTIN_SOURCE_IDS.files, icon: factory }],
      14,
    ))
    expect(sizes).toEqual([14])
    expect(element.props['data-local-display']).toBe(14)
  })
})
