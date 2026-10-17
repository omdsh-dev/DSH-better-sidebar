/**
 * Stable identities and bounds of the built-in GitHub sources (S3).
 *
 * This module is deliberately node-free: the host adapter registers the
 * serializable descriptors with and the browser renderer reads the SAME
 * source/type ids from here, so the two halves cannot drift into two
 * spellings of one provider.
 *
 * The ids themselves are S1 vocabulary (`BUILTIN_SOURCE_IDS`); this module
 * only fixes the S3-owned mapping of resource kind to source/type, the shared
 * gh dependency / account connection ids, and the source's bounded page,
 * timeout and edit limits.
 */
import { BUILTIN_SOURCE_IDS } from '../../types.ts'

/** The only host S3 talks to. Enterprise hosts and short links are not guessed. */
export const GITHUB_HOST = 'github.com'

/** Attribution written into the host descriptors and runtime definitions. */
export const GITHUB_PLUGIN_ID = 'dsh-better-sidebar'

/** One GitHub resource kind: an issue or a pull request. */
export type GithubKind = 'issue' | 'pull'

/** The built-in source id per kind (S1 reserved ids). */
export const GITHUB_SOURCE_IDS: Readonly<Record<GithubKind, string>> = {
  issue: BUILTIN_SOURCE_IDS.githubIssues,
  pull: BUILTIN_SOURCE_IDS.githubPulls,
}

/** The built-in type id per kind. */
export const GITHUB_TYPE_IDS: Readonly<Record<GithubKind, string>> = {
  issue: 'builtin.github.issue',
  pull: 'builtin.github.pull',
}

/** The dependency id shared by both GitHub sources (one gh executable). */
export const GITHUB_DEPENDENCY_ID = 'github.gh'

/** The account connection shared by both GitHub sources (gh owns the token). */
export const GITHUB_CONNECTION_ID = 'github.gh.auth'

/** The fixed content format of both editable GitHub types. */
export const GITHUB_FORMAT = 'text/markdown'

/** A bounded browse/search page size when the caller names none. */
export const GITHUB_DEFAULT_PAGE_LIMIT = 30

/**
 * The source's own page-size ceiling. A caller asking for more is CLAMPED
 * (one page, never a repository history scan), not silently truncated.
 */
export const GITHUB_MAX_PAGE_LIMIT = 100

/** The state filters the source supports on both kinds. */
export const GITHUB_LIST_STATES = ['open', 'closed', 'all'] as const

/** One supported state filter. */
export type GithubStateFilter = (typeof GITHUB_LIST_STATES)[number]

/**
 * The largest body the edit carrier offers. A bigger body is still READABLE,
 * but `loadEdit` marks the document read-only instead of offering a save that
 * would drop the tail.
 */
export const GITHUB_MAX_EDITABLE_CHARS = 100_000

/** Search results GitHub exposes are capped at 1000 (documented API limit). */
export const GITHUB_SEARCH_RESULT_CAP = 1_000

/** Read budget: one GraphQL round trip for one resource. */
export const GITHUB_READ_TIMEOUT_MS = 30_000

/** Browse/search budget: a list page is small, so it gets the same bound. */
export const GITHUB_LIST_TIMEOUT_MS = 30_000

/** A write may be slower (server-side hooks); it still has a hard bound. */
export const GITHUB_WRITE_TIMEOUT_MS = 60_000

/** Read output bound: one issue/PR body plus its metadata. */
export const GITHUB_READ_MAX_OUTPUT_BYTES = 2 << 20

/** List/search output bound: titles only. */
export const GITHUB_LIST_MAX_OUTPUT_BYTES = 512 << 10

/** Explicit connect attempt lifetime; the login child is killed after this. */
export const GITHUB_AUTH_TIMEOUT_MS = 10 * 60 * 1000

/** Whether a value names a GitHub resource kind. */
export function isGithubKind(value: unknown): value is GithubKind {
  return value === 'issue' || value === 'pull'
}

/** The source id that owns one kind. */
export function sourceIdOfKind(kind: GithubKind): string {
  return GITHUB_SOURCE_IDS[kind]
}

/** The type id that owns one kind. */
export function typeIdOfKind(kind: GithubKind): string {
  return GITHUB_TYPE_IDS[kind]
}

/** The kind a source id addresses, if it is one of the two GitHub sources. */
export function kindOfSourceId(sourceId: string): GithubKind | undefined {
  if (sourceId === GITHUB_SOURCE_IDS.issue) return 'issue'
  if (sourceId === GITHUB_SOURCE_IDS.pull) return 'pull'
  return undefined
}

/** The kind a type id addresses, if it is one of the two GitHub types. */
export function kindOfTypeId(typeId: string): GithubKind | undefined {
  if (typeId === GITHUB_TYPE_IDS.issue) return 'issue'
  if (typeId === GITHUB_TYPE_IDS.pull) return 'pull'
  return undefined
}

/** One `owner/repo` pair, case preserved as the user typed it. */
export interface GithubRepoRef {
  readonly owner: string
  readonly repo: string
}

/** One canonical GitHub resource address (the identity half of a locator). */
export interface GithubResource extends GithubRepoRef {
  readonly host: typeof GITHUB_HOST
  readonly kind: GithubKind
  readonly number: number
}

/**
 * A normalized locator: the resource plus an optional readable title.
 * Identity never includes the title (`normalizeGithubLocator` keeps it only as
 * display metadata), and no field may carry a token, account or path.
 */
export interface GithubLocator extends GithubResource {
  readonly title?: string
}

/** One explicit single-repository browse/search range. */
export interface GithubListScope {
  readonly repo: GithubRepoRef
  readonly state: GithubStateFilter
}
