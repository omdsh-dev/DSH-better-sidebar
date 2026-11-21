/**
 * Icons the sidebar needs beyond the primitives set: the bottom-workbench
 * toggle and the settings-page / file-viewer glyphs. Per-tab icons live on
 * the tab descriptors (`descriptor.icon`), not in a type-keyed switch — the
 * icon mapping was registry-ized with the tab types.
 */
import { IconPanelLeftOutlineRegular, type IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/** Bottom toggle: reuse the native panel glyph, rotated toward the bottom. */
export const IconPanelBottomOutline16 = ({ size = 16, className }: IconProps) => (
  <span className={className} style={{ display: 'inline-flex', width: size, height: size, transform: 'rotate(-90deg)' }}>
    <IconPanelLeftOutlineRegular size={size} />
  </span>
)

/**
 * Settings-navigation glyph for the "Side card" section. The shell asks for a
 * square edge and tints the SVG with `currentColor`, so this stays a plain
 * two-tone outline mark: the side panel plus the two rails it docks against.
 */
export const IconSideCardNav = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M2 7v10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M6 5v14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <rect x="10" y="3" width="12" height="18" rx="2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
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

/** Image viewer glyph: a photo frame with a horizon and a sun. */
export const IconImageOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="5.5" cy="6" r="1.25" stroke="currentColor" strokeWidth="1.25" />
    <path d="m2.5 12 3.4-3.4 2.1 2.1 1.8-1.8 3.7 3.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** Zoom-out glyph: the minus half of the zoom pair (the plus comes from the
 *  primitives set, which has no minus). */
export const IconMinusOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)

/** The measurement mark itself: one segment, a perpendicular boundary rule
 *  near each end, and a dot on each end. Both distance icons render THIS
 *  drawing — the single-axis one only rotates it — so the pair can never drift
 *  apart in stroke weight, tick length or dot size. */
const MeasureSegmentGlyph = (
  <>
    <path d="M4.2 11.8 11.8 4.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="m3 7.6 5.4 5.4M7.6 3l5.4 5.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <circle cx="4.2" cy="11.8" r="1.2" fill="currentColor" />
    <circle cx="11.8" cy="4.2" r="1.2" fill="currentColor" />
  </>
)

/** Single-axis distance glyph: the very same drawing as the two-axis icon,
 *  rotated 45° around the canvas center so the segment stands upright. It is
 *  taller than its sibling by design (the reader asked for the same mark, not a
 *  redrawn one), which is why it sits a little higher than the other icons. */
export const IconMeasureAxisOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <g transform="rotate(-45 8 8)">{MeasureSegmentGlyph}</g>
  </svg>
)

/** Delete-one-measurement glyph: an eraser on a baseline. */
export const IconEraseOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="2.8" y="5.4" width="10.4" height="5.2" rx="1.4" transform="rotate(-45 8 8)" stroke="currentColor" strokeWidth="1.5" />
    <path d="M6.2 6.2 9.8 9.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    <path d="M2.5 14.2h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)

/** Distance-measurement glyph: the two-axis distance mark (a diagonal segment
 *  between two end ticks). */
export const IconMeasureLineOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    {MeasureSegmentGlyph}
  </svg>
)

/** Area-measurement glyph: a dashed pixel rectangle with corner dots. */
export const IconMeasureAreaOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="2.5" y="3.5" width="11" height="9" rx="1" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 1.6" />
    <circle cx="2.5" cy="3.5" r="1.1" fill="currentColor" />
    <circle cx="13.5" cy="12.5" r="1.1" fill="currentColor" />
  </svg>
)

/** Fit-to-window glyph: a frame with an L bracket in the bottom-left and the
 *  opposite bracket in the top-right — "make the picture match this box". */
export const IconFitWindowOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
    <path d="M4.4 12.2V9.6h2.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M11.6 3.8v2.6H9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** Pan glyph: an open hand (the primitives set has no hand). The 24-unit
 *  viewBox keeps the finger outlines readable at the 14px toolbar size. */
export const IconHandOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M18 11V6a2 2 0 0 0-4 0v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M14 10V4a2 2 0 0 0-4 0v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M10 10.5V6a2 2 0 0 0-4 0v8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="m7 15-1.76-1.76a2 2 0 0 0-2.83 2.82l3.6 3.6A8 8 0 0 0 11.6 22h1.4a8 8 0 0 0 8-8V7a2 2 0 0 0-4 0v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** History glyph (thread switcher): a clock with a counterclockwise arrow,
 *  in the app's outline style — the "past conversations" mark. */
export const IconHistoryOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M2.4 6.8A5.6 5.6 0 1 1 2.4 9.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M2.2 3.4v3.4h3.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8 5.4V8l1.9 1.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** Save glyph (save-as-new-session): the classic floppy disk, in the app's
 *  outline style. */
export const IconSaveOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M4.2 14.5h7.6a1.2 1.2 0 0 0 1.2-1.2V4.9L10.6 2.5H4.2A1.2 1.2 0 0 0 3 3.7v9.6a1.2 1.2 0 0 0 1.2 1.2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M10 2.5v2.6H5.6V2.5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M5.4 14.5v-4.2h5.2v4.2" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
  </svg>
)

/**
 * Visual Studio Code brand mark for the file-tree "open with" menu. The
 * path is the Simple Icons `visualstudiocode` glyph (CC0 1.0,
 * simple-icons@11.0.0 — later releases dropped it over Microsoft's brand
 * policy, so it is inlined here rather than pulled from react-icons),
 * rendered monochrome via currentColor to follow the active skin.
 */
export const IconVscode16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z" />
  </svg>
)
