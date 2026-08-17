#!/usr/bin/env node
/**
 * Regenerates the vscode-icons-derived file/folder icon theme for the
 * sidebar explorer:
 *
 *   1. reads the vscode-icons extension checkout (default: the sibling
 *      `../vscode-icons` directory; override with `--vscode-icons <dir>`),
 *   2. evaluates its supportedExtensions.ts / supportedFolders.ts / languages.ts
 *      manifests (transpile+eval; no vscode-icons runtime dependency),
 *   3. emits `src/client/icons-manifest.generated.ts` — the icon-theme maps
 *      in the VSCode file-icon-theme shape (fileNames / fileExtensions /
 *      folderNames(+open) with light variants and the bundled defaults),
 *   4. copies every referenced SVG into `icons/` (dark + light variants,
 *      folder opened/closed pairs, and the bundled `default_*` icons).
 *
 * The generated file and icons/ are COMMITTED: the plugin build must be
 * self-contained (CI has no sibling vscode-icons checkout). Run this script
 * only when upstream vscode-icons assets/manifests change, then commit the
 * diff together with the regeneration.
 *
 * Matching semantics follow the VSCode icon-theme engine
 * (src/vs/workbench/services/themes/common/fileIconTheme.ts): exact filename
 * match first, then permissive (case-insensitive) filename match, then the
 * extension candidates walk — every dot-to-end suffix of the basename,
 * LONGEST candidate first — each tried exact then permissively; folders match
 * their basename only. Language IDs only matter when a language service is
 * present, so knownExtensions/knownFilenames ride along exactly like the
 * vscode-icons manifest builder folds them into the extension/filename maps
 * (and the sidebar has no language service — nothing else to do).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import ts from 'typescript'

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..')
const args = process.argv.slice(2)
const iconsArg = args.indexOf('--vscode-icons')
const VSCODE_ICONS_DIR = iconsArg !== -1 ? resolve(args[iconsArg + 1]) : resolve(REPO_ROOT, '..', 'vscode-icons')

if (!existsSync(join(VSCODE_ICONS_DIR, 'src', 'iconsManifest', 'supportedExtensions.ts'))) {
  console.error(`[gen-icons] vscode-icons checkout not found at ${VSCODE_ICONS_DIR}`)
  console.error('  pass --vscode-icons <dir> to point at the checkout')
  process.exit(1)
}

// ── minimal TS module loader (type-strip + eval, no bundler) ──────────────

const moduleCache = new Map()

/**
 * Type-strip + eval one manifest module. Every import in the three manifests
 * is either type-only (interfaces — erased by transpile) or one of the two
 * runtime values provided as globals (FileFormat enum, languages data), so
 * the import lines are simply dropped.
 */
function loadTsModule(absPath, globals = {}) {
  const cached = moduleCache.get(absPath)
  if (cached !== undefined) return cached
  const source = readFileSync(absPath, 'utf8')
  const stripped = source.replace(/^import\s[^\n]*from\s*['"][^'"]+['"];?$/gm, '')
  const js = ts.transpileModule(stripped, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  const argNames = Object.keys(globals)
  const fn = new Function('module', 'exports', ...argNames, js)
  try {
    fn(module, module.exports, ...argNames.map(name => globals[name]))
  } catch (error) {
    throw new Error(`[gen-icons] failed to evaluate ${basename(absPath)}: ${error instanceof Error ? error.message : String(error)}`)
  }
  moduleCache.set(absPath, module.exports)
  return module.exports
}

/** FileFormat.svg === 0 (the only member the manifests use). */
const FileFormatValues = { svg: 0 }

const manifestDir = join(VSCODE_ICONS_DIR, 'src', 'iconsManifest')
// supportedExtensions.ts needs the languages data (import { languages } from
// './languages'), evaluated from the same checkout.
const languages = loadTsModule(join(manifestDir, 'languages.ts')).languages
const fileManifest = loadTsModule(join(manifestDir, 'supportedExtensions.ts'), { FileFormat: FileFormatValues, languages }).extensions
const folderManifest = loadTsModule(join(manifestDir, 'supportedFolders.ts'), { FileFormat: FileFormatValues }).extensions

// ── collect the active (non-disabled, default preset) icon set ────────────

/** The default VSCode-file-icon-theme preset: every non-disabled entry. */
function activeEntries(collection) {
  return collection.supported.filter(entry => entry.icon && !entry.disabled)
}

function parseManifest(files, folders) {
  const activeFiles = activeEntries(files)
  const activeFolders = activeEntries(folders)

  // Sort exactly like manifestBuilder (lodash sortBy, stable ascending by
  // icon name), so duplicate keys resolve deterministically (last wins for
  // exact keys, mirroring the flat-map reduce in manifestBuilder.buildFiles).
  const sortedFiles = [...activeFiles].sort((a, b) => (a.icon < b.icon ? -1 : a.icon > b.icon ? 1 : 0))
  const sortedFolders = [...activeFolders].sort((a, b) => (a.icon < b.icon ? -1 : a.icon > b.icon ? 1 : 0))

  const maps = {
    fileNames: {},
    fileExtensions: {},
    fileNamesLight: {},
    fileExtensionsLight: {},
    folderNames: {},
    folderNamesOpen: {},
  }

  for (const cur of sortedFiles) {
    const darkFile = `file_type_${cur.icon}.svg`
    const lightFile = cur.light ? `file_type_light_${cur.icon}.svg` : darkFile
    const populate = (key, isFilename) => {
      const noDot = isFilename ? key : key.startsWith('.') ? key.slice(1) : key
      if (isFilename) {
        maps.fileNames[noDot] = darkFile
        maps.fileNamesLight[noDot] = lightFile
      } else {
        maps.fileExtensions[noDot] = darkFile
        maps.fileExtensionsLight[noDot] = lightFile
      }
    }
    for (const lang of cur.languages ?? []) {
      for (const ext of lang.knownExtensions ?? []) {
        maps.fileExtensions[ext] = darkFile
        maps.fileExtensionsLight[ext] = lightFile
      }
      for (const name of lang.knownFilenames ?? []) {
        maps.fileNames[name] = darkFile
        maps.fileNamesLight[name] = lightFile
      }
    }
    for (const ext of cur.extensions ?? []) populate(ext, cur.filename === true)
    // filenamesGlob × extensionsGlob cross-product joined with dots, exactly
    // like the upstream Utils.combine ('test' × 'js' → 'test.js') — NOT a
    // plain concat (a bare 'js' would otherwise leak a false filename match).
    if (cur.filenamesGlob?.length && cur.extensionsGlob?.length) {
      for (const prefix of cur.filenamesGlob) {
        for (const suffix of cur.extensionsGlob) populate(`${prefix}.${suffix}`, cur.filename === true)
      }
    }
  }

  for (const cur of sortedFolders) {
    const darkFolder = `folder_type_${cur.icon}.svg`
    const darkFolderOpen = `folder_type_${cur.icon}_opened.svg`
    const lightFolder = cur.light ? `folder_type_light_${cur.icon}.svg` : darkFolder
    const lightFolderOpen = cur.light ? `folder_type_light_${cur.icon}_opened.svg` : darkFolderOpen
    for (const name of cur.extensions ?? []) {
      maps.folderNames[name] = darkFolder
      maps.folderNamesOpen[name] = darkFolderOpen
      if (cur.light) {
        maps.folderNamesLight ??= {}
        maps.folderNamesOpenLight ??= {}
        maps.folderNamesLight[name] = lightFolder
        maps.folderNamesOpenLight[name] = lightFolderOpen
      }
    }
  }

  return { maps, sortedFiles, sortedFolders }
}

const result = parseManifest(fileManifest, folderManifest)
const { maps, sortedFiles, sortedFolders } = result

// ── referenced SVG files ───────────────────────────────────────────────────

const referenced = new Set([
  'default_file.svg',
  'default_folder.svg',
  'default_folder_opened.svg',
  'default_root_folder.svg',
  'default_root_folder_opened.svg',
])
for (const cur of sortedFiles) {
  referenced.add(`file_type_${cur.icon}.svg`)
  if (cur.light) referenced.add(`file_type_light_${cur.icon}.svg`)
}
for (const cur of sortedFolders) {
  referenced.add(`folder_type_${cur.icon}.svg`)
  referenced.add(`folder_type_${cur.icon}_opened.svg`)
  if (cur.light) {
    referenced.add(`folder_type_light_${cur.icon}.svg`)
    referenced.add(`folder_type_light_${cur.icon}_opened.svg`)
  }
}

const sourceIconsDir = join(VSCODE_ICONS_DIR, 'icons')
const destIconsDir = join(REPO_ROOT, 'icons')
mkdirSync(destIconsDir, { recursive: true })
let copied = 0
let missing = []
for (const name of [...referenced].sort()) {
  const src = join(sourceIconsDir, name)
  if (!existsSync(src)) {
    missing.push(name)
    continue
  }
  copyFileSync(src, join(destIconsDir, name))
  copied++
}
if (missing.length > 0) {
  console.error(`[gen-icons] ${missing.length} referenced icon(s) missing upstream: ${missing.join(', ')}`)
  process.exit(1)
}

// ── emit the generated manifest module ─────────────────────────────────────

const defaults = {
  file: 'default_file.svg',
  folder: 'default_folder.svg',
  folderOpen: 'default_folder_opened.svg',
  rootFolder: 'default_root_folder.svg',
  rootFolderOpen: 'default_root_folder_opened.svg',
}

function json(obj) {
  // One entry per line keeps the file diff-friendly and the build output
  // stable across regenerations.
  const keys = Object.keys(obj).sort()
  const body = keys.map(key => `${JSON.stringify(key)}: ${JSON.stringify(obj[key])}`).join(',\n  ')
  return `{\n  ${body},\n}`
}

const generated = `/**
 * GENERATED FILE — do not edit by hand.
 * Regenerated by scripts/gen-icons.mjs from vscode-icons
 * (${basename(VSCODE_ICONS_DIR)}), the VSCode-Icons extension icon set (MIT).
 * Values are icon file basenames served by the /sidebar/icons route.
 */
export const ICON_THEME = {
  fileNames: ${json(maps.fileNames)},
  fileExtensions: ${json(maps.fileExtensions)},
  fileNamesLight: ${json(maps.fileNamesLight)},
  fileExtensionsLight: ${json(maps.fileExtensionsLight)},
  folderNames: ${json(maps.folderNames)},
  folderNamesOpen: ${json(maps.folderNamesOpen)},
  folderNamesLight: ${maps.folderNamesLight ? json(maps.folderNamesLight) : '{}'},
  folderNamesOpenLight: ${maps.folderNamesOpenLight ? json(maps.folderNamesOpenLight) : '{}'},
  defaults: ${json(defaults)},
} as const
`
writeFileSync(join(REPO_ROOT, 'src', 'client', 'icons-manifest.generated.ts'), generated, 'utf8')

// ── report ─────────────────────────────────────────────────────────────────

let totalBytes = 0
for (const name of referenced) {
  try { totalBytes += statSync(join(destIconsDir, name)).size } catch { /* counted below */ }
}
console.log(`[gen-icons] ok — ${copied} SVGs copied to icons/ (${(totalBytes / 1024).toFixed(0)} KB)`)
console.log(`[gen-icons] fileNames=${Object.keys(maps.fileNames).length} fileExtensions=${Object.keys(maps.fileExtensions).length} folderNames=${Object.keys(maps.folderNames).length}`)
console.log(`[gen-icons] light fileNames=${Object.keys(maps.fileNamesLight).length} light fileExtensions=${Object.keys(maps.fileExtensionsLight).length} light folderNames=${Object.keys(maps.folderNamesLight ?? {}).length}`)
console.log(`[gen-icons] manifest module: ${(generated.length / 1024).toFixed(0)} KB`)