/**
 * Theme-token glyphs for the two Feishu sources.
 *
 * Both strokes use `currentColor` (no literal color anywhere): the source
 * icon inherits the surrounding themed text color, exactly like every other
 * plugin glyph. The host icon contract accepts a size-aware factory
 * (`ClueDisplayIcon`), so these are plain functions, not component refs.
 */
import type { ReactNode } from 'react'

/** Props of one glyph. */
export interface FeishuGlyphProps {
  readonly size?: number
}

/** Docx glyph: a document sheet with text lines. */
export function FeishuDocsGlyph({ size = 16 }: FeishuGlyphProps): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3.5 1.75h5.1l3.9 3.9v8.6H3.5z" />
      <path d="M8.6 1.75v3.9h3.9" />
      <path d="M5.6 8.2h4.8M5.6 10.7h4.8" />
    </svg>
  )
}

/** Task glyph: a check box with a checked mark. */
export function FeishuTasksGlyph({ size = 16 }: FeishuGlyphProps): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="2.4" />
      <path d="M5 8.1 7.1 10.2 11.1 6" />
    </svg>
  )
}

/** Size-aware factory accepted by `ClueSourceDisplayDescriptor.icon`. */
export function feishuDocsIcon(size: number): ReactNode {
  return <FeishuDocsGlyph size={size} />
}

/** Size-aware factory accepted by `ClueSourceDisplayDescriptor.icon`. */
export function feishuTasksIcon(size: number): ReactNode {
  return <FeishuTasksGlyph size={size} />
}
