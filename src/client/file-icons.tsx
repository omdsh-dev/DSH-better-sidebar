/**
 * Built-in file and folder glyphs for the file tree (feature: file icons).
 *
 * The built-in set is DSH's OWN file-type artwork: `FileTypeIcon` from
 * `@deepseek-ai/dsh-client-ui-primitives` classifies a path and renders the
 * same glyphs the host's own explorer shows — the 48 full-color code and
 * configuration categories, plus the category-colored sheet glyphs for
 * markdown, images, PDFs, office documents, video, folders and the generic
 * fallback. Colored artwork is content, not chrome, and the host draws it
 * with its own palette, so this module carries no color literals and stays
 * inside the skin contract (the guide's §12).
 *
 * Nothing here needs a lazy chunk: the artwork belongs to a platform module
 * the client already holds in its frozen module table, so the core bundle
 * gains a function call rather than 500-odd icon rules.
 *
 * External plugins that want their own glyphs (per extension, per exact file
 * name, per directory name) register `FileIconDescriptor`s through
 * `ctx.betterSidebar.registerFileIcon`; their registrations win over these.
 */
import type { ReactNode } from 'react'
import { FileTypeIcon } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * A file row: the host's own classifier and artwork for any path. Unknown
 * extensions land on the generic document glyph, exactly like the host's
 * explorer.
 * @param path - the row's path (any separator; the classifier reads the basename).
 * @param size - the square edge in px.
 * @returns the host's file-type glyph.
 */
export function builtinFileIcon(path: string, size: number): ReactNode {
  return <FileTypeIcon path={path} size={size} />
}

/**
 * A directory row: the host's folder glyph.
 *
 * The host ships ONE folder drawing (`kind: 'folder'` resolves to its
 * monochrome `IconFolderClose16`, which rides `currentColor` and therefore
 * still follows the skin), and the classifier never returns a folder kind of
 * its own. The expansion state is already legible from the tree's own chevron
 * and row affordances, so this deliberately does not invent a second folder
 * drawing.
 * @param _open - whether the row is expanded (accepted for API compatibility).
 * @param size - the square edge in px.
 * @returns the host's folder glyph.
 */
export function builtinFolderIcon(_open: boolean, size: number): ReactNode {
  return <FileTypeIcon kind="folder" size={size} />
}

/**
 * The last-resort glyph: the host's generic document, for the resolver's leaf
 * when no registration and no built-in match applies (and for surfaces that
 * render a file row without a service).
 * @param size - the square edge in px.
 * @returns the host's generic file glyph.
 */
export function fallbackFileIcon(size: number): ReactNode {
  return <FileTypeIcon kind="other" size={size} />
}
