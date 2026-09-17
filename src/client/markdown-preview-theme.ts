/**
 * Markdown file-preview color theme. Persisted in
 * `pluginSettings['markdown'].previewTheme` and applied only on the
 * `.editorMd` container (`data-md-preview-theme`); Side Chat and Changes
 * reading mode stay on the host MarkdownText look.
 */

/** Preview theme ids the markdown viewer understands. */
export type MdPreviewTheme = 'vivid' | 'host'

/**
 * Default preview theme: richer heading / quote / table accents via
 * `--dsw-alias-*` remaps under `.editorMd` (see sidebar.module.css).
 */
export const DEFAULT_PREVIEW_THEME: MdPreviewTheme = 'vivid'

const THEMES = new Set<string>(['vivid', 'host'])

/**
 * Normalize the persisted `previewTheme` setting: a known id wins,
 * anything else (missing, empty, unknown) falls back to the default.
 */
export function previewThemeOf(value: unknown): MdPreviewTheme {
  return typeof value === 'string' && THEMES.has(value)
    ? value as MdPreviewTheme
    : DEFAULT_PREVIEW_THEME
}
