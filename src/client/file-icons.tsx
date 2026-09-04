/**
 * Built-in per-extension file glyphs for the file tree (feature: file icons).
 *
 * All glyphs are VSCodicons consumed as `currentColor` monochrome — the same
 * skin contract as every other icon this plugin draws (visual values ride the
 * `--dsw-alias-*` tokens, never hardcoded colors). External plugins that want
 * colorful icons register their own `FileIconDescriptor`s through
 * `ctx.betterSidebar.registerFileIcon` (they own their colors); this map is
 * only the fallback nobody claimed.
 */
import type { ReactNode } from 'react'
import {
  VscDatabase, VscFile, VscFileCode, VscFileMedia, VscFilePdf, VscFileZip,
  VscFolder, VscFolderOpened, VscJson, VscLock, VscMarkdown, VscSettings,
} from 'react-icons/vsc'
import { extOf } from './paths.ts'

/** One glyph shared by a group of extensions. */
type GlyphFactory = (size: number) => ReactNode

/** The generic file glyph — the fallback for every unclaimed extension. */
export function fallbackFileIcon(size: number): ReactNode {
  return <VscFile size={size} />
}

/** The built-in directory glyphs (what a folder row shows unregistered). */
export function builtinFolderIcon(open: boolean, size: number): ReactNode {
  return open ? <VscFolderOpened size={size} /> : <VscFolder size={size} />
}

/** One glyph shared by a group of extensions. */
type GlyphGroup = [readonly string[], GlyphFactory]

/**
 * Extension → glyph groups, first match wins. Extensions are lowercase
 * without the leading dot, matched case-insensitively by the caller's
 * normalization. The reserved folder values (`'folder'`/`'folder-open'`)
 * never appear here — directories resolve through `builtinFolderIcon`.
 */
const GROUPS: readonly GlyphGroup[] = [
  [['md', 'markdown', 'mdx'], (size) => <VscMarkdown size={size} />],
  [['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'tiff'], (size) => <VscFileMedia size={size} />],
  [['pdf'], (size) => <VscFilePdf size={size} />],
  [['json', 'jsonc', 'json5'], (size) => <VscJson size={size} />],
  [['html', 'htm', 'xhtml', 'xml', 'jsx', 'tsx'], (size) => <VscFileCode size={size} />],
  [['css', 'scss', 'sass', 'less', 'styl'], (size) => <VscFileCode size={size} />],
  [['js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'py', 'rs', 'go', 'java', 'kt', 'kts', 'swift', 'rb', 'php', 'c', 'h', 'cpp', 'hpp', 'cs', 'm', 'mm', 'scala', 'sh', 'bash', 'zsh', 'fish', 'lua', 'pl', 'r', 'jl', 'dart', 'ex', 'exs', 'erl', 'hs', 'clj', 'cljs', 'vb', 'fs'], (size) => <VscFileCode size={size} />],
  [['yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'editorconfig'], (size) => <VscSettings size={size} />],
  [['sql', 'db', 'sqlite', 'sqlite3'], (size) => <VscDatabase size={size} />],
  [['lock'], (size) => <VscLock size={size} />],
  [['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar'], (size) => <VscFileZip size={size} />],
]

const LOOKUP: ReadonlyMap<string, GlyphFactory> = new Map(
  GROUPS.flatMap(([exts, glyph]) => exts.map((ext) => [ext, glyph] as const)),
)

/**
 * The built-in glyph FACTORY claiming a path's extension, or undefined when
 * the extension is unclaimed (the caller decides the fallback — the generic
 * `VscFile` or a registered catch-all). Exposed as a separate function so
 * the service's resolver can distinguish "builtin claims it" from "builtin
 * is just its own fallback" without comparing ReactNodes by reference.
 */
export function builtinFileIconOf(path: string): GlyphFactory | undefined {
  return LOOKUP.get(extOf(path))
}

/**
 * The built-in glyph for a path: its extension's group glyph, or the generic
 * `VscFile` when nothing claims it. Pure and synchronous — callers run this
 * on every render, so it stays a Map lookup. The no-service fallback path
 * for surfaces without the registry (and the last-but-one link of the
 * service's `fileIcon` chain).
 */
export function builtinFileIcon(path: string, size: number): ReactNode {
  const glyph = LOOKUP.get(extOf(path))
  return glyph === undefined ? fallbackFileIcon(size) : glyph(size)
}
