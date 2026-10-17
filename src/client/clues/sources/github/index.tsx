/**
 * S3 client install surface: `registerGithubSourceClient(face)`.
 *
 * Registers, through S1's client extension face and nothing else:
 * - the display metadata (distinct issue / pull glyphs) of both built-in
 *   GitHub sources;
 * - the `text/markdown` format renderer whose GitHub branch is the title+body
 *   editor (S6 hosts it in the floating window; S9 wires load/save).
 *
 * The function returns one disposer and is idempotent-safe: if a later
 * registration fails (for example another plugin already owns
 * `text/markdown`), everything registered here is rolled back, so the caller
 * never sees half of the GitHub client installed.
 */
import { createElement } from 'react'
import type { ClueFormatRenderer } from '../../../../clues/types.ts'
import {
  GITHUB_FORMAT,
  GITHUB_SOURCE_IDS,
} from '../../../../clues/sources/github/ids.ts'
import type { BetterSidebarCluesClientFace } from '../../registry.ts'
import { githubMarkdownRenderer } from './editor.tsx'
import { GithubIssueIcon, GithubPullRequestIcon } from './icons.tsx'

export { githubMarkdownRenderer, isGithubSource } from './editor.tsx'
export { GithubIssueIcon, GithubMarkIcon, GithubPullRequestIcon } from './icons.tsx'

/**
 * Register the GitHub source presentation and the title+body editor.
 * @param face - `ctx.betterSidebar.clues`.
 * @returns a disposer removing exactly these registrations (idempotent).
 */
export function registerGithubSourceClient(face: BetterSidebarCluesClientFace): () => void {
  const disposers: Array<() => void> = []
  const disposeAll = (): void => {
    for (const dispose of disposers.splice(0).reverse()) dispose()
  }
  try {
    disposers.push(face.registerSourceDisplay({
      sourceId: GITHUB_SOURCE_IDS.issue,
      icon: size => createElement(GithubIssueIcon, { size }),
    }))
    disposers.push(face.registerSourceDisplay({
      sourceId: GITHUB_SOURCE_IDS.pull,
      icon: size => createElement(GithubPullRequestIcon, { size }),
    }))
    disposers.push(face.registerFormatRenderer(
      GITHUB_FORMAT,
      githubMarkdownRenderer as ClueFormatRenderer,
    ))
  } catch (error) {
    disposeAll()
    throw error
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    disposeAll()
  }
}
