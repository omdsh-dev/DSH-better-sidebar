/**
 * Theme-token glyphs for the two Feishu sources.
 *
 * Every visible shape paints with `currentColor`; the multi-color look comes
 * from the per-layer classes in `../source-icons.module.css`. That keeps the
 * glyph readable when a consumer paints the outer slot neutral, and it keeps
 * the two sources distinct: docs = blue filled sheet + green fold +
 * surface-colored text, tasks = amber frame/body + a surface halo under an ink
 * check.
 *
 * The host icon contract accepts a size-aware factory (`ClueDisplayIcon`), so
 * these stay plain functions, not component refs.
 */
import type { ReactNode } from 'react'
import styles from '../source-icons.module.css'

/** Props of one glyph. */
export interface FeishuGlyphProps {
  readonly size?: number
}

/** Document body: a rounded sheet with the top-right corner cut for the fold. */
const DOC_SHEET =
  'M3.2 3.1C3.2 2.2 3.9 1.5 4.8 1.5H9.7L12.8 4.6V12.9C12.8 13.8 12.1 14.5 11.2 14.5H4.8C3.9 14.5 3.2 13.8 3.2 12.9V3.1Z'

/** The turned-down corner that closes the sheet. */
const DOC_FOLD = 'M9.7 1.5L12.8 4.6H10.7C10.15 4.6 9.7 4.15 9.7 3.6V1.5Z'

/** The checkbox tick; drawn twice (surface halo, then ink). */
const TASK_CHECK = 'M5.2 8.2L7.1 10.1L10.9 6.2'

/** Docx glyph: blue sheet, light blue underlay, green fold, cut-out text lines. */
export function FeishuDocsGlyph({ size = 16 }: FeishuGlyphProps): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <g className={styles.docsBackdrop}>
        <path d={DOC_SHEET} transform="translate(0.5 0.5)" fill="currentColor" />
      </g>
      <g className={styles.docsSheet}>
        <path d={DOC_SHEET} fill="currentColor" />
      </g>
      <g className={styles.docsFold}>
        <path d={DOC_FOLD} fill="currentColor" />
      </g>
      <g className={styles.docsText}>
        <path d="M5.2 7.0H10.7" fill="none" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round" />
        <path d="M5.2 9.05H10.7" fill="none" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round" />
        <path d="M5.2 11.1H9.0" fill="none" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round" />
      </g>
    </svg>
  )
}

/** Task glyph: amber frame + body, surface halo, ink check. */
export function FeishuTasksGlyph({ size = 16 }: FeishuGlyphProps): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <g className={styles.tasksBackdrop}>
        <rect x="2.4" y="2.4" width="11.2" height="11.2" rx="2.8" fill="currentColor" />
      </g>
      <g className={styles.tasksBase}>
        <rect x="3.4" y="3.4" width="9.2" height="9.2" rx="2.1" fill="currentColor" />
      </g>
      <g className={styles.tasksCheckHalo}>
        <path
          d={TASK_CHECK}
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      <g className={styles.tasksCheck}>
        <path
          d={TASK_CHECK}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
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
