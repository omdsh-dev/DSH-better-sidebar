/**
 * GitHub source glyphs (S3).
 *
 * Inline SVGs in the app's outline/fill style: `currentColor` only, no
 * hardcoded colors, no new icon dependency. `issues` and `pull requests` get
 * distinct glyphs so the two built-in sources stay visually separate.
 */
import type { ReactNode } from 'react'

/** Props shared by the source glyphs (host icon convention: 16px default). */
export interface GithubIconProps {
  readonly size?: number
  readonly className?: string
}

/** The issue-opened glyph (circle + dot). */
export function GithubIssueIcon({ size = 16, className }: GithubIconProps): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 16 16"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
      <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z" />
    </svg>
  )
}

/** The git-pull-request glyph. */
export function GithubPullRequestIcon({ size = 16, className }: GithubIconProps): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 16 16"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </svg>
  )
}
