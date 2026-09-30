/**
 * Plugin presentation-metadata guard for DSH 0.1.7+.
 *
 * 0.1.7 added `readPluginMeta` (packages/boot/app-boot/src/package-meta.ts):
 * the Plugins page and `plugin_manager` list read `package.json#icon` plus
 * `<pkg>/locale/<lang>.json` to label and illustrate a plugin. DSH's own gate
 * (`scripts/verify-package-meta.ts`) is explicit that this is all-or-nothing —
 * a declared icon whose locale resources do not resolve is itself an error —
 * and the whole feature fails SILENTLY: a metadata problem only ever degrades
 * to a plain text row, so nothing tells you the icon stopped shipping.
 *
 * These assertions pin the wiring at both ends: the manifest, and the tarball
 * npm would actually publish (an icon listed in `files` but absent on disk, or
 * present on disk but not listed, both look fine in the source tree).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
  name: string
  version: string
  icon?: string
  files?: string[]
  exports?: Record<string, unknown>
}

/** The icon and locale directory names this feature is built on. */
const ICON = 'icon.svg'
const LOCALE_DIR = 'locale'

/** Every locale document, as `[filename, parsed]` pairs. */
function locales(): Array<[string, { meta?: { title?: unknown; description?: unknown } }]> {
  const dir = resolve(ROOT, LOCALE_DIR)
  return readdirSync(dir).filter(name => name.endsWith('.json')).sort()
    .map(name => [name, JSON.parse(readFileSync(join(dir, name), 'utf8')) as { meta?: { title?: unknown; description?: unknown } }])
}

/** `package.json#icon`, resolved against the manifest directory. */
const iconPath = (): string => resolve(ROOT, pkg.icon!.replace(/^\.\//u, ''))

describe('DSH plugin presentation metadata', () => {
  it('declares a relative icon that exists inside the package', () => {
    expect(pkg.icon, 'package.json#icon').toBeDefined()
    // readPluginMeta rejects an absolute path or a `scheme:` outright.
    expect(pkg.icon!.startsWith('./'), 'icon must be a relative path').toBe(true)
    expect(pkg.icon!.includes('..'), 'icon must stay inside the package').toBe(false)
    expect(pkg.icon!, 'only the raster/vector types DSH accepts').toMatch(/\.(svg|png|jpe?g|webp)$/u)
    expect(existsSync(iconPath()), `${pkg.icon} must exist`).toBe(true)
  })

  it('publishes the icon and every locale document through files', () => {
    expect(pkg.files, 'package.json#files').toBeDefined()
    // `files` is npm's allow-list: an entry missing here never reaches the
    // tarball, and DSH's gate rejects a declared-but-unpublished icon.
    expect(pkg.files!).toContain(ICON)
    expect(pkg.files!).toContain(`${LOCALE_DIR}/*.json`)
  })

  it('exposes the locale documents and the manifest through exports', () => {
    // `${name}/locale/<file>` is how readPluginMeta resolves a translation,
    // and `${name}/package.json` is how it reads the icon declaration.
    expect(pkg.exports?.['./locale/*.json'], 'exports["./locale/*.json"]').toBe('./locale/*.json')
    expect(pkg.exports?.['./package.json'], 'exports["./package.json"]').toBe('./package.json')
  })

  it('ships an English baseline and complete translations beside it', () => {
    const documents = locales()
    const baseline = documents.find(([name]) => name === 'en.json')
    // English is the discovery baseline: without it readPluginMeta cannot find
    // the directory at all, so every other locale would go unread too.
    expect(baseline, `${LOCALE_DIR}/en.json must exist`).toBeDefined()

    const shapeOf = (value: { meta?: { title?: unknown; description?: unknown } }): string[] =>
      Object.keys(value.meta ?? {}).sort()

    for (const [name, document] of documents) {
      expect(shapeOf(document), `${name} must mirror en.json`).toEqual(shapeOf(baseline![1]))
      expect(typeof document.meta?.title, `${name} meta.title`).toBe('string')
      expect(document.meta!.title, `${name} meta.title must not be empty`).not.toBe('')
      expect(typeof document.meta?.description, `${name} meta.description`).toBe('string')
      expect(document.meta!.description, `${name} meta.description must not be empty`).not.toBe('')
    }
  })

  it('keeps the icon in the built-in house style', () => {
    const svg = readFileSync(iconPath(), 'utf8')
    // Every icon DSH ships for this feature is a 36x36, fill-only geometric
    // mark (see packages/experimental/*/icon.svg and the artwork in
    // ui-primitives/src/plugin-artwork.tsx). Pinning the frame keeps a later
    // redraw from silently changing how the mark scales in the list.
    expect(svg).toMatch(/viewBox="0 0 36 36"/u)
    expect(svg).toMatch(/width="36"/u)
    expect(svg).toMatch(/height="36"/u)
    expect(svg, 'the root must not paint a background').toMatch(/fill="none"/u)
    // No glyph outlines and no text: the built-ins are pure filled shapes, and
    // a <text> node would also render in whatever font the browser picks.
    expect(svg, 'no stroked outlines in the built-in style').not.toMatch(/stroke=/u)
    expect(svg, 'no <text> in an icon').not.toMatch(/<text[\s>]/u)
    // The built-ins "carry their own brand colors and gradients instead of
    // riding currentColor" (their file header), and each is genuinely
    // multi-hue — a flat single-colour redraw reads as a plain block beside
    // them at the 30px row size.
    expect(svg, 'the mark must be colourised, not flat').toMatch(/<linearGradient/u)
    expect((svg.match(/<linearGradient/gu) ?? []).length, 'at least two gradients = two hues').toBeGreaterThanOrEqual(2)
    expect(svg, 'no currentColor: plugin artwork owns its palette').not.toMatch(/currentColor/u)
    // A CSS-only paint (conic-gradient via foreignObject, as the search
    // artwork uses) renders inline but stays EMPTY inside the `<img>` this
    // feature delivers the icon through.
    expect(svg, 'no foreignObject: the icon ships as an <img>').not.toMatch(/foreignObject/u)
  })

  it('actually packs the icon and locales into the tarball', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-meta-pack-'))
    try {
      execFileSync('pnpm', ['pack', '--pack-destination', dir], { cwd: ROOT, stdio: 'pipe', shell: process.platform === 'win32' })
      const contents = execFileSync('tar', ['-tzf', `${pkg.name}-${pkg.version}.tgz`], { cwd: dir, encoding: 'utf8' })
      const files = contents.split('\n')
      expect(files, `${ICON} must be published`).toContain(`package/${ICON}`)
      for (const [name] of locales()) {
        expect(files, `${LOCALE_DIR}/${name} must be published`).toContain(`package/${LOCALE_DIR}/${name}`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
