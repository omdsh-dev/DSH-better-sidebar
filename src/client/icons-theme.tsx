/**
 * The explorer icon theme: a port of the VSCode file-icon-theme engine to
 * the sidebar (the "vscode-icons rendering mode").
 *
 * Data: the generated `icons-manifest.generated.ts` (from the vscode-icons
 * extension set) holds the VSCode icon-theme maps — fileNames /
 * fileExtensions / folderNames(+open), each with a light variant, plus the
 * bundled default icons. Bytes are served by the plugin's /sidebar/icons
 * route; this module only RESOLVES an entry name to an icon file and renders
 * it, mirroring the VSCode matching semantics
 * (src/vs/workbench/services/themes/common/fileIconTheme.ts):
 *
 * - files: exact basename → permissive (case-insensitive) basename →
 *   extension candidates. A basename's extension candidates are every
 *   dot-to-end suffix (`archive.tar.gz` → `gz`, `tar.gz`), tried LONGEST
 *   first, each exact then permissive. The sidebar has no language service,
 *   so languageIds are skipped — the generated maps already fold the
 *   languages' knownExtensions/knownFilenames in, exactly like the
 *   vscode-icons manifest builder does.
 * - folders: exact folder basename → permissive, against the closed or open
 *   map depending on the row's expansion state; `src` a directory never
 *   takes the file `src` icon.
 * - light scheme: light maps point at `file_type_light_*` / light folder
 *   variants where the upstream set ships them, else fall back to the dark
 *   file — per entry, exactly like the upstream light theme section; the
 *   bundled default icons have no light variants, so they are shared.
 */
import { useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { ICON_THEME } from './icons-manifest.generated.ts'
import { isDarkScheme } from './theme.ts'
import css from './sidebar.module.css'

/** One icon-theme map: dark values + the optional lighter variant. */
interface ThemeMap {
  dark: Record<string, string>
  light?: Record<string, string>
}

/** The value for `key` under the active scheme (light falls back to the
 *  dark file per entry — the upstream light theme inherits dark per icon). */
function valueOf(map: ThemeMap, key: string, light: boolean): string | undefined {
  const dark = map.dark[key]
  if (!light || map.light === undefined) return dark
  return map.light[key] ?? dark
}

/**
 * Lowercase key index (lowerKey → first-declared original key). VSCode's
 * permissive match scans the manifest's keys in declaration order; the
 * generated maps are emitted sorted, so "first" here is deterministic too.
 */
function lowerKeyIndex(src: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(src)) {
    const lower = key.toLowerCase()
    if (!(lower in out)) out[lower] = key
  }
  return out
}

const fileNamesIndex = lowerKeyIndex(ICON_THEME.fileNames)
const fileExtensionsIndex = lowerKeyIndex(ICON_THEME.fileExtensions)
const folderNamesIndex = lowerKeyIndex(ICON_THEME.folderNames)
const folderNamesOpenIndex = lowerKeyIndex(ICON_THEME.folderNamesOpen)
const folderNamesLightIndex = lowerKeyIndex(ICON_THEME.folderNamesLight)
const folderNamesOpenLightIndex = lowerKeyIndex(ICON_THEME.folderNamesOpenLight)

/** Every dot-to-end suffix of a basename, shortest first (`a.tar.gz` →
 *  `['gz', 'tar.gz']`); the empty string is never a candidate (VSCode only
 *  matches truthy extensions). */
function extCandidates(basename: string): string[] {
  const out: string[] = []
  const lastSlash = Math.max(basename.lastIndexOf('/'), basename.lastIndexOf('\\'))
  let lastDot = basename.lastIndexOf('.')
  while (lastDot > lastSlash) {
    out.push(basename.slice(lastDot + 1))
    lastDot = basename.lastIndexOf('.', lastDot - 1)
  }
  return out
}

/**
 * Resolve a FILE's icon file basename (e.g. `file_type_typescript.svg`).
 * `name` is the file's basename (explorer rows are single segments).
 */
export function resolveFileIcon(name: string, light: boolean): string {
  const fileNames: ThemeMap = { dark: ICON_THEME.fileNames, light: ICON_THEME.fileNamesLight }
  const exact = valueOf(fileNames, name, light)
  if (exact !== undefined) return exact
  const key = fileNamesIndex[name.toLowerCase()]
  if (key !== undefined) {
    const permissive = valueOf(fileNames, key, light)
    if (permissive !== undefined) return permissive
  }
  const fileExtensions: ThemeMap = { dark: ICON_THEME.fileExtensions, light: ICON_THEME.fileExtensionsLight }
  const candidates = extCandidates(name)
  for (let index = candidates.length - 1; index >= 0; index--) {
    const ext = candidates[index]!
    const exactExt = valueOf(fileExtensions, ext, light)
    if (exactExt !== undefined) return exactExt
    const extKey = fileExtensionsIndex[ext.toLowerCase()]
    if (extKey !== undefined) {
      const permissiveExt = valueOf(fileExtensions, extKey, light)
      if (permissiveExt !== undefined) return permissiveExt
    }
  }
  return ICON_THEME.defaults.file
}

/**
 * Resolve a FOLDER's icon file basename for its current expansion state
 * (`open` selects the bumped-folder variant). `name` is the folder's
 * basename; only folderNames/folderNamesOpen match (never the file maps).
 */
export function resolveFolderIcon(name: string, open: boolean, light: boolean): string {
  const map: ThemeMap = open
    ? { dark: ICON_THEME.folderNamesOpen, light: ICON_THEME.folderNamesOpenLight }
    : { dark: ICON_THEME.folderNames, light: ICON_THEME.folderNamesLight }
  const exact = valueOf(map, name, light)
  if (exact !== undefined) return exact
  const index = open
    ? light ? folderNamesOpenLightIndex : folderNamesOpenIndex
    : light ? folderNamesLightIndex : folderNamesIndex
  const key = index[name.toLowerCase()]
  if (key !== undefined) {
    const permissive = valueOf(map, key, light)
    if (permissive !== undefined) return permissive
  }
  const defaults = ICON_THEME.defaults
  return open ? defaults.folderOpen : defaults.folder
}

/** The plugin route serving the icon set (same origin, relative URL). */
export function iconUrl(file: string): string {
  return `/sidebar/icons/${encodeURIComponent(file)}`
}

/**
 * The currently active color scheme (dark vs light), live: re-renders on
 * flips so the explorer switches to the light icon variants in place (the
 * app's theme presenter toggles body[data-ds-dark-theme] at runtime).
 *
 * One SHARED MutationObserver backs every subscriber: a deep explorer tree
 * mounts hundreds of icons, and a per-icon observer (plus per-icon state)
 * would be pure waste. This mirrors theme.ts's subscribeColorScheme
 * (body[data-ds-dark-theme]), but with a single observer fanning the flip
 * out to all listeners.
 */
type SchemeListener = () => void
const schemeListeners = new Set<SchemeListener>()
let schemeObserver: MutationObserver | undefined

function ensureSchemeObserver(): void {
  if (schemeObserver !== undefined || typeof document === 'undefined') return
  schemeObserver = new MutationObserver(() => {
    for (const listener of schemeListeners) listener()
  })
  schemeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
}

function subscribeScheme(listener: SchemeListener): () => void {
  schemeListeners.add(listener)
  ensureSchemeObserver()
  return () => { schemeListeners.delete(listener) }
}

export function useColorScheme(): 'dark' | 'light' {
  return useSyncExternalStore(subscribeScheme, () => (isDarkScheme() ? 'dark' : 'light'))
}

interface ExplorerIconProps {
  name: string
  className?: string
  /** Rendered size in px (the VSCode explorer/tab size; 16 × 2 = 32 fits
   *  the icons' viewBox crisply on 2× displays). */
  size?: number
}

/** One resolved file icon at the VSCode explorer size (16px, sharp 2×). */
export const ExplorerFileIcon = ({ name, className, size = 16 }: ExplorerIconProps) => {
  const scheme = useColorScheme()
  return (
    <img
      src={iconUrl(resolveFileIcon(name, scheme === 'light'))}
      alt=""
      draggable={false}
      decoding="async"
      loading="lazy"
      className={clsx(css.explorerIcon, className)}
      style={{ width: size, height: size }}
    />
  )
}

/** One resolved folder icon (open/closed variant by the row's state). */
export const ExplorerFolderIcon = ({ name, open, root = false, className, size = 16 }: ExplorerIconProps & { open: boolean; root?: boolean }) => {
  const scheme = useColorScheme()
  const file = root
    ? open ? ICON_THEME.defaults.rootFolderOpen : ICON_THEME.defaults.rootFolder
    : resolveFolderIcon(name, open, scheme === 'light')
  return (
    <img
      src={iconUrl(file)}
      alt=""
      draggable={false}
      decoding="async"
      loading="lazy"
      className={clsx(css.explorerIcon, className)}
      style={{ width: size, height: size }}
    />
  )
}