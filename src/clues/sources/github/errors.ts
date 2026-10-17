/**
 * Map a failed gh run to S1's fixed error categories (S3).
 *
 * gh has no uniform success envelope: success is exit code 0 plus a parseable
 * business payload, and a failure is a non-zero exit, unparseable output or an
 * unexpected result. This module is the ONLY place that interprets provider
 * failures, and its output never contains raw stdout/stderr, headers, tokens
 * or account data — only a category and a fixed, user-renderable message.
 */
import { ClueError, type ClueErrorCategory } from '../../types.ts'
import type { CliResult } from '../../runtime/types.ts'

/** One GraphQL error entry (structured fields only). */
export interface GithubGraphqlError {
  readonly type?: string
  readonly message?: string
}

/** Detect an archived-repository failure (writes are rejected by GitHub). */
const ARCHIVED_PATTERN = /archiv/i
/** Primary/secondary rate limiting; checked before the generic 403 bucket. */
const RATE_LIMIT_PATTERN = /rate.?limit|abuse detection/i
/** Sign-in / expired-token failures. */
const AUTH_PATTERN = /(?:to get started with github cli|gh auth login|not logged in|bad credentials|authentication|unauthorized|http 401|401 unauthorized)/i
/** Not-found / invisible-resource failures. */
const NOT_FOUND_PATTERN = /(?:not found|http 404|could not resolve|does not exist)/i
/** Permission / policy failures. */
const FORBIDDEN_PATTERN = /(?:forbidden|http 403|not accessible|must have .* rights|insufficient scopes?)/i
/**
 * A CLI that is too old for a required flag/command. S2's version probe
 * normally rejects those before a call, but a misreporting/forked binary must
 * still surface as an incompatible dependency instead of a generic failure.
 */
const UNKNOWN_FLAG_PATTERN = /(?:unknown (?:flag|option|command)|invalid option|unrecognized (?:flag|option|arguments?))/i

/** Parse a JSON payload, returning undefined instead of throwing. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Whether a value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The structured GraphQL errors of one response, if any.
 * @param payload - a parsed gh response body.
 */
export function graphqlErrorsOf(payload: unknown): GithubGraphqlError[] {
  if (!isRecord(payload) || !Array.isArray(payload.errors)) return []
  const errors: GithubGraphqlError[] = []
  for (const entry of payload.errors) {
    if (!isRecord(entry)) continue
    errors.push({
      ...(typeof entry.type === 'string' ? { type: entry.type } : {}),
      ...(typeof entry.message === 'string' ? { message: entry.message } : {}),
    })
  }
  return errors
}

/** The REST-style HTTP status of a gh error body (`status` is a string). */
function httpStatusOf(payload: unknown): number | undefined {
  if (!isRecord(payload) || typeof payload.status !== 'string') return undefined
  const status = Number(payload.status)
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined
}

/** The fixed category/message of one provider failure. */
function failureOf(category: ClueErrorCategory, message: string): ClueError {
  return new ClueError(category, message)
}

/**
 * Classify one non-zero gh result.
 *
 * Text matching is used ONLY to choose a category; the stderr text itself is
 * never copied into the returned message or a log line.
 *
 * @param result - the captured process result.
 */
export function mapGithubCliFailure(result: CliResult): ClueError {
  if (result.stdoutTruncated) {
    return failureOf('failed', 'the GitHub CLI output exceeded the capture limit and was not parsed')
  }
  const payload = parseJson(result.stdout)
  const graphErrors = graphqlErrorsOf(payload)
  const status = httpStatusOf(payload)
  const errorTypes = new Set(graphErrors.map(entry => entry.type ?? ''))
  const text = [
    result.stderr,
    ...graphErrors.map(entry => entry.message ?? ''),
  ].join('\n')

  if (UNKNOWN_FLAG_PATTERN.test(text)) {
    return failureOf(
      'dependency-incompatible',
      'the installed GitHub CLI does not support a required option; update gh and retry',
    )
  }
  if (RATE_LIMIT_PATTERN.test(text) || errorTypes.has('RATE_LIMITED') || status === 429) {
    return failureOf('rate-limited', 'GitHub rate limit reached; wait a few minutes and retry')
  }
  if (
    ARCHIVED_PATTERN.test(text)
    || (isRecord(payload) && typeof payload.message === 'string' && ARCHIVED_PATTERN.test(payload.message))
  ) {
    return failureOf('permission-denied', 'the GitHub repository is archived and read-only')
  }
  if (
    result.exitCode === 4
    || AUTH_PATTERN.test(text)
    || errorTypes.has('UNAUTHORIZED')
    || status === 401
  ) {
    return failureOf('auth-required', 'GitHub requires sign-in; connect the GitHub account and retry')
  }
  if (NOT_FOUND_PATTERN.test(text) || errorTypes.has('NOT_FOUND') || status === 404) {
    return failureOf('not-found', 'the GitHub resource was not found or is not visible to this account')
  }
  if (FORBIDDEN_PATTERN.test(text) || errorTypes.has('FORBIDDEN') || status === 403) {
    return failureOf('permission-denied', 'the GitHub account has no permission for this action')
  }
  if (status !== undefined && status >= 500) {
    return failureOf('failed', 'the GitHub API is unavailable; retry later')
  }
  return failureOf('failed', 'the GitHub CLI request failed')
}
