/**
 * Plugin detail documents (DSH 0.1.7+ plugin page).
 *
 * The Plugins page reads `<pkg>/locale/<language>.json` and follows its
 * `meta.detail` Markdown file; images in that Markdown resolve beside the
 * document through the plugin-manager detail-file route. Built-in plugins
 * introduce themselves with a small set of SVG previews the same way. A
 * broken reference is silent in the UI — the page just renders less — so the
 * wiring is pinned here: safe package-relative paths, a shipped detail
 * directory, and standalone SVG assets (no scripts, external refs, or
 * `foreignObject`, which an `<img>` never executes).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const LOCALE_DIR = 'locale'
/** Markdown image syntax; destinations are the only paths the page loads. */
const IMAGE = /!\[[^\]]*\]\(([^)\s]+)\)/g

interface LocaleMeta {
  meta?: { title?: unknown; description?: unknown; detail?: unknown }
}

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { files?: string[] }

/** Every locale document as `[filename, parsed]` pairs. */
function locales(): Array<[string, LocaleMeta]> {
  const dir = resolve(ROOT, LOCALE_DIR)
  return readdirSync(dir).filter(name => name.endsWith('.json')).sort()
    .map(name => [name, JSON.parse(readFileSync(join(dir, name), 'utf8')) as LocaleMeta])
}

/** The package-relative detail path one locale declares, when it declares one. */
function detailOf(name: string, document: LocaleMeta): string {
  const detail = document.meta?.detail
  expect(typeof detail, `${LOCALE_DIR}/${name} meta.detail`).toBe('string')
  return detail as string
}

/** Image destinations written by one detail document. */
function imagesOf(document: string): string[] {
  return [...readFileSync(resolve(ROOT, document), 'utf8').matchAll(IMAGE)].map(match => match[1]!)
}

describe('plugin detail documents', () => {
  it('ships the detail directory the locale documents live in', () => {
    expect(pkg.files, 'package.json#files').toContain('detail')
  })

  it('declares a safe Markdown detail file in every locale', () => {
    for (const [name, document] of locales()) {
      const detail = detailOf(name, document)
      expect(detail, `${name}: a package-relative path`).not.toMatch(/^(?:[a-z]+:|[\\/])/i)
      expect(detail, `${name}: inside detail/`).toMatch(/^detail\/[^/]+\.md$/u)
      expect(detail, `${name}: no traversal`).not.toContain('..')
      expect(existsSync(resolve(ROOT, detail)), `${detail} exists`).toBe(true)
    }
  })

  it('references at least one SVG beside each detail document', () => {
    for (const [name, document] of locales()) {
      const detail = detailOf(name, document)
      const images = imagesOf(detail)
      expect(images.length, `${detail} must carry a preview image`).toBeGreaterThan(0)
      for (const destination of images) {
        expect(destination, `${detail} image is relative`).not.toMatch(/^(?:[a-z]+:|\/)/i)
        expect(destination, `${detail} image is an SVG`).toMatch(/\.svg$/u)
        const image = posix.normalize(posix.join(posix.dirname(detail), destination))
        expect(image.startsWith('..'), `${destination} stays inside the detail directory`).toBe(false)
        expect(existsSync(resolve(ROOT, image)), `${image} exists`).toBe(true)
      }
    }
  })

  it('keeps every preview a standalone SVG an <img> can render', () => {
    const seen = new Set<string>()
    for (const [name, document] of locales()) {
      const detail = detailOf(name, document)
      for (const destination of imagesOf(detail)) {
        const image = posix.normalize(posix.join(posix.dirname(detail), destination))
        if (seen.has(image)) continue
        seen.add(image)
        const svg = readFileSync(resolve(ROOT, image), 'utf8')
        expect(svg, `${image} root element`).toMatch(/^<svg[\s>]/u)
        expect(svg, `${image} has a viewBox`).toMatch(/viewBox="[^"]+"/u)
        expect(svg, `${image} is self-describing`).toContain('role="img"')
        expect(svg, `${image} carries no script`).not.toMatch(/<script[\s>]/iu)
        expect(svg, `${image} carries no foreignObject`).not.toContain('foreignObject')
        expect(svg, `${image} loads nothing external`).not.toMatch(/(?:href|src)="https?:/iu)
        expect(svg, `${image} has no inline event handler`).not.toMatch(/\son[a-z]+=/iu)
      }
    }
    expect(seen.size, 'at least one preview image').toBeGreaterThan(0)
  })
})
