/**
 * Wire types shared by the GitHub tab's host half (src/github.ts) and
 * client half (src/client/api.ts). Node-free by contract: the client bundle
 * imports this module, and tests/api-surface.spec.ts guards the client
 * graph against node:* leakage.
 * @module dsh-better-sidebar/github-shared
 */

/** The client-visible wire shape of one inbox thread. */
export interface GithubThread {
  /** Thread id (opaque). */
  id: string
  unread: boolean
  /** GitHub's raw reason ('review_requested', 'ci_activity', …). */
  reason: string
  /** Repository full name ('owner/name'). */
  repo: string
  /** subject.title — carries the review verdict text for PR reviews. */
  title: string
  /** subject.url — the REST API URL (number parsing + detail source). */
  url: string
  /** The human web page (host-derived; open actions use this, not url). */
  htmlUrl: string
  /** subject.type ('PullRequest' | 'Issue' | …). */
  type: string
  /** ISO 8601 update time. */
  updatedAt: string
  /** subject.latest_comment_url when GitHub provides one. */
  latestCommentUrl?: string
}

/** The 'github.state' response: the inbox snapshot plus configuration state. */
export interface GithubStateResult {
  /** Whether a token resolved; false drives the client's setup guide. */
  configured: boolean
  /** Whether the gh CLI binary is present (guides the unconfigured hint). */
  ghAvailable?: boolean
  /** Last failure (auth / network / GitHub error); absent on success. */
  error?: { code: string; message: string }
  threads: GithubThread[]
  /** ISO 8601 time of the last successful cache fill. */
  fetchedAt?: string
  /** Effective poll interval in seconds (host-floored at 60). */
  pollIntervalSec: number
  /** Whether the deployment enabled the Merge action (githubAllowMerge). */
  allowMerge: boolean
}

/** Normalized check-run row for the merge panel. */
export interface GithubCheck {
  name: string
  status: string
  conclusion: string | null
}

/** The 'github.mergeStatus' response: mergeability plus head checks. */
export interface GithubMergeStatus {
  checks: GithubCheck[]
  mergeable: boolean | null
  state: string
}

/** One thread's expanded detail (the 'github.thread' response). */
export interface GithubThreadDetail {
  thread: GithubThread
  /** The latest comment's markdown body, when GitHub serves one. */
  commentBody?: string
}

/** The review events the GitHub tab offers (the reviews endpoint's verbs). */
export type GithubReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'

/** The merge methods the GitHub tab offers (the merge endpoint's verbs). */
export type GithubMergeMethod = 'merge' | 'squash' | 'rebase'
