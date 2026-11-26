/**
 * GitHub source glyphs (S3).
 *
 * Inline SVGs in the app's outline/fill style. Every paint is `currentColor`;
 * the color arrives from `../source-icons.module.css`, never from a literal
 * and never from the consumer's inherited ink. Both glyphs therefore keep
 * their identity even when the tab strip or a settings row paints the outer
 * slot neutral.
 *
 * `issues` and `pull requests` use distinct silhouettes AND distinct color
 * families: issue = green ring / dot on a pale green underlay, pull request =
 * blue branch with green nodes. The issue glyph already has two paths (dot and
 * ring), so the layers need no redraw; the pull request is a compact
 * multi-path redraw that keeps the 16 viewBox and the existing `size` /
 * `className` API.
 */
import type { ReactNode } from 'react'
import styles from '../source-icons.module.css'

/** Props shared by the source glyphs (host icon convention: 16px default). */
export interface GithubIconProps {
  readonly size?: number
  readonly className?: string
}

/** The issue-opened glyph (green ring + solid dot on a light underlay). */
export function GithubIssueIcon({ size = 16, className }: GithubIconProps): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <g className={styles.issueBackdrop}>
        <circle cx="8" cy="8" r="6.7" fill="currentColor" />
      </g>
      <g className={styles.issueRing}>
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
        />
      </g>
      <g className={styles.issueDot}>
        <circle cx="8" cy="8" r="2.2" fill="currentColor" />
      </g>
    </svg>
  )
}

/** The git-pull-request glyph (blue branch + green nodes). */
export function GithubPullRequestIcon({ size = 16, className }: GithubIconProps): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <g className={styles.pullBranch}>
        <path
          d="M4 5.1V10.9"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <path
          d="M5.7 3.4H9.2C10.8 3.4 12 4.6 12 6.2V10.9"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      <g className={styles.pullNode}>
        <circle cx="4" cy="3.4" r="1.7" fill="currentColor" />
        <circle cx="4" cy="12.6" r="1.7" fill="currentColor" />
      </g>
      <g className={styles.pullNodeMerge}>
        <circle cx="12" cy="12.6" r="1.7" fill="currentColor" />
      </g>
    </svg>
  )
}
