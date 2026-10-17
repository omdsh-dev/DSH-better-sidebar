/**
 * Explicit single-repository browse/search ranges and opaque cursors (S3).
 *
 * Every list/search call names exactly one `owner/repo` (plus an open/closed/
 * all filter). An absent scope is a request error, never a silent "search
 * everything": the source must not resolve the current project or sweep the
 * account's repositories.
 *
 * A cursor is an opaque base64url value bound to the source, kind, repository,
 * state and query that produced it. Changing any of them resets pagination —
 * the old cursor is refused instead of continuing into another range, which is
 * what keeps a late page from a previous query out of the new result.
 */
import { ClueError, type JsonValue } from '../../types.ts'
import {
  GITHUB_DEFAULT_PAGE_LIMIT,
  GITHUB_LIST_STATES,
  GITHUB_MAX_PAGE_LIMIT,
  type GithubKind,
  type GithubListScope,
  type GithubStateFilter,
} from './ids.ts'
import { parseGithubRepoRef } from './url.ts'

/** The range a cursor belongs to (also used to detect stale cursors). */
export interface GithubCursorRange {
  readonly sourceId: string
  readonly kind: GithubKind
  readonly repo: string
  readonly state: GithubStateFilter
  /** The search query, or '' for a plain browse page. */
  readonly query: string
}

/** The stored cursor payload version. */
const CURSOR_VERSION = 1

/** Whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Whether a value is one supported state filter. */
function isStateFilter(value: unknown): value is GithubStateFilter {
  return typeof value === 'string' && (GITHUB_LIST_STATES as readonly string[]).includes(value)
}

/**
 * Parse one explicit scope value.
 *
 * Accepted forms: `"owner/repo"`, a repository URL, or the object
 * `{ repo: "owner/repo" | repoUrl, state?: "open" | "closed" | "all" }`.
 *
 * @param scope - the raw `clues.list`/`clues.search` scope.
 * @throws {ClueError} `invalid-request` when no explicit repository is named.
 */
export function parseGithubScope(scope: JsonValue | undefined): GithubListScope {
  if (typeof scope === 'string') {
    const repo = parseGithubRepoRef(scope)
    if (repo === undefined) {
      throw new ClueError('invalid-request', 'a GitHub scope must be "owner/repo" or a repository URL')
    }
    return { repo, state: 'open' }
  }
  if (isRecord(scope)) {
    const rawRepo = scope.repo
    if (typeof rawRepo !== 'string') {
      throw new ClueError('invalid-request', 'a GitHub scope object needs a "repo" string (owner/repo)')
    }
    const repo = parseGithubRepoRef(rawRepo)
    if (repo === undefined) {
      throw new ClueError('invalid-request', 'a GitHub scope must name one repository (owner/repo or a repository URL)')
    }
    const rawState = scope.state === undefined ? 'open' : scope.state
    if (!isStateFilter(rawState)) {
      throw new ClueError('invalid-request', 'a GitHub scope state must be "open", "closed" or "all"')
    }
    return { repo, state: rawState }
  }
  throw new ClueError(
    'invalid-request',
    'a GitHub browse/search scope (owner/repo) is required; GitHub is never searched across repositories',
  )
}

/** Stable, case-insensitive key of one range (cursor binding + tests). */
export function githubScopeKey(scope: GithubListScope): string {
  return `${scope.repo.owner.toLowerCase()}/${scope.repo.repo.toLowerCase()}:${scope.state}`
}

/**
 * Bound one requested page size to the source ceiling.
 *
 * The caller's smaller value wins; a larger value is CLAMPED to
 * {@link GITHUB_MAX_PAGE_LIMIT} (the page still continues through
 * `nextCursor`), and a malformed value is a request error.
 *
 * @param limit - requested page size.
 */
export function pageLimitOf(limit: number | undefined): number {
  if (limit === undefined) return GITHUB_DEFAULT_PAGE_LIMIT
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ClueError('invalid-request', 'a GitHub page limit must be a positive integer')
  }
  return Math.min(limit, GITHUB_MAX_PAGE_LIMIT)
}

/**
 * Encode one opaque cursor. The provider cursor (itself opaque) is nested, so
 * the value carries no readable repository, query or title.
 *
 * @param input - the producing range plus the provider's `endCursor`.
 */
export function encodeGithubCursor(input: GithubCursorRange & { readonly after: string }): string {
  const payload = JSON.stringify({
    v: CURSOR_VERSION,
    s: input.sourceId,
    k: input.kind,
    r: input.repo.toLowerCase(),
    st: input.state,
    q: input.query,
    a: input.after,
  })
  return Buffer.from(payload, 'utf8').toString('base64url')
}

/**
 * Decode and validate one cursor against the range that is about to use it.
 *
 * @param cursor - the opaque `nextCursor` from the previous page.
 * @param expected - source/kind/repo/state/query of the CURRENT call.
 * @returns the provider cursor for the next page.
 * @throws {ClueError} `invalid-request` for a corrupt or stale cursor.
 */
export function decodeGithubCursor(cursor: string, expected: GithubCursorRange): string {
  if (typeof cursor !== 'string' || cursor.trim() === '') {
    throw new ClueError('invalid-request', 'a GitHub pagination cursor is empty or unreadable')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new ClueError('invalid-request', 'a GitHub pagination cursor is empty or unreadable')
  }
  if (
    !isRecord(parsed)
    || parsed.v !== CURSOR_VERSION
    || parsed.s !== expected.sourceId
    || parsed.k !== expected.kind
    || parsed.r !== expected.repo.toLowerCase()
    || parsed.st !== expected.state
    || parsed.q !== expected.query
    || typeof parsed.a !== 'string'
    || parsed.a === ''
  ) {
    throw new ClueError(
      'invalid-request',
      'the GitHub pagination cursor belongs to another repository, state or query; restart from the first page',
    )
  }
  return parsed.a
}
