/**
 * Icons the sidebar needs beyond the primitives set: a terminal glyph (the
 * icon library has none), a diff glyph, and the two panel-toggle glyphs for
 * the top-right cluster. Per-tab icons live on the tab descriptors
 * (`descriptor.icon`), not in a type-keyed switch — the icon mapping was
 * registry-ized with the tab types.
 */
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Right-panel toggle glyph (the "侧拉" button): a frame with a filled strip
 * along its RIGHT edge, in the app's outline style (1.5px stroke,
 * currentColor).
 */
export const IconPanelRightOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="2" width="13" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
    <rect x="10.5" y="3.25" width="2.75" height="9.5" rx="1" fill="currentColor" stroke="none" />
  </svg>
)

/**
 * Bottom-panel toggle glyph (the "底栏" button): a frame with a filled strip
 * along its BOTTOM edge, in the app's outline style.
 */
export const IconPanelBottomOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="2" width="13" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
    <rect x="3.25" y="10" width="9.5" height="2.75" rx="1" fill="currentColor" stroke="none" />
  </svg>
)

/**
 * Terminal glyph in the app's outline style (1.5px stroke, currentColor):
 * a rounded frame with a prompt chevron and underscore cursor.
 */
export const IconTerminalOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <path d="M4.5 6.25 6.75 8 4.5 9.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8.5 10.4h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)

/** Diff glyph in the app's outline style: a file frame with a plus and a minus row. */
export const IconDiffOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
    <path d="M4 5h3M5.5 3.5v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M9.5 12.5h2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)

/**
 * Stop glyph for the background-job kill button: a filled square in the
 * app's outline scale (16), the universal "halt this work" mark.
 */
export const IconStopOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />
  </svg>
)

/** Upload glyph in the app's outline style: an arrow rising into a tray
 *  (the file-manager "upload into the workspace" action). */
export const IconUploadOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M8 10V2.75M4.75 5.5 8 2.25 11.25 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M2.75 10.5v2.25A1.25 1.25 0 0 0 4 14h8a1.25 1.25 0 0 0 1.25-1.25V10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)

// ── File-viewer inventory glyphs (Side card settings page) ────────────────

/** Image viewer glyph: a picture frame with a sun and a mountain. */
export const IconImageOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="5.5" cy="6" r="1.2" stroke="currentColor" strokeWidth="1.5" />
    <path d="m3.5 12 3-3 2.25 2.25L11.5 8.5 13 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** PDF viewer glyph: a document frame with the "PDF" label. */
export const IconPdfOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3.5 1.5h6.5L13.5 5v9.5h-10z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M9.5 1.5V5h4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M5 13.5v-3h1.4c.75 0 1.1.32 1.1.85 0 .54-.35.85-1.1.85H5.3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8.3 13.5v-3h1.05c.8 0 1.35.5 1.35 1.5s-.55 1.5-1.35 1.5z" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M11.6 13.5v-3h1.3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
  </svg>
)

/** Markdown viewer glyph: the classic "M with a down arrow" badge. */
export const IconMarkdownOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <path d="M4 10.5V5.5l2 2.5 2-2.5v5M9.5 10.5v-5l2 2.5 2-2.5v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** HTML viewer glyph: a document frame with a "‹/›" tag pair. */
export const IconHtmlOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3.5 1.5h6.5L13.5 5v9.5h-10z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M9.5 1.5V5h4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M5.6 13.2 4.2 10l1.4-3.2M7.4 6.8 8.8 10l-1.4 3.2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** Browser tab glyph: a globe with meridians. */
export const IconGlobeOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
    <ellipse cx="8" cy="8" rx="2.8" ry="6.5" stroke="currentColor" strokeWidth="1.5" />
    <path d="M1.5 8h13M8 1.5c-2.4 1.8-2.4 11.2 0 13M8 1.5c2.4 1.8 2.4 11.2 0 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)
