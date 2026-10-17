/**
 * Canonical GitHub resource parsing and locator identity (S3).
 *
 * Only the documented URL shape `https://github.com/{owner}/{repo}/
 * (issues|pull)/{number}` is recognized. Everything else — another host, a
 * short link, a URL embedded in prose, a title guess — is NOT a target and
 * parses to `undefined`, so a source may answer "no candidate" instead of
 * inventing a repository.
 *
 * A locator is the CLOSED, credential-free set `{host, owner, repo, kind,
 * number}` plus an optional escaped readable title. Identity lower-cases
 * owner/repo (GitHub names are case-insensitive) and keeps issue and pull
 * apart even when they share a number.
 *
 * This module has no `node:*` import: the client half reads the same ids.
 */
import { ClueError, type CluePortableRef, type Locator } from '../../types.ts'
import { escapeClueTitle } from '../../context/tokens.ts'
import {
  GITHUB_HOST,
  isGithubKind,
  type GithubKind,
  type GithubLocator,
  type GithubRepoRef,
  type GithubResource,
} from './ids.ts'

/** The exact keys a normalized locator may carry. */
export const GITHUB_LOCATOR_KEYS = ['host', 'owner', 'repo', 'kind', 'number'] as const

/** GitHub account names: alphanumeric + hyphens, starting alphanumeric. */
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/

/** GitHub repository names: alphanumeric plus `.`, `_`, `-`. */
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/

/** Canonical issue/PR numbers are positive integers without leading zeros. */
const NUMBER_PATTERN = /^[1-9]\d*$/

/** GitHub's own number bound (the API treats numbers as int32). */
const MAX_NUMBER = 2_147_483_647

/** The parsed forms of one user-supplied reference text. */
export type GithubTextParse =
  | { readonly kind: 'url'; readonly resource: GithubResource }
  | { readonly kind: 'shorthand'; readonly owner: string; readonly repo: string; readonly number: number }

/** Whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Whether one owner segment is a valid GitHub account/org login. */
function isOwner(value: string): boolean {
  return OWNER_PATTERN.test(value)
}

/** Whether one repository segment is a usable name. */
function isRepoName(value: string): boolean {
  return REPO_PATTERN.test(value) && value !== '.' && value !== '..'
}

/** Parse one canonical positive resource number. */
function parseNumber(value: string): number | undefined {
  if (!NUMBER_PATTERN.test(value)) return undefined
  const number = Number(value)
  return Number.isSafeInteger(number) && number <= MAX_NUMBER ? number : undefined
}

/**
 * Parse a canonical `github.com/{owner}/{repo}/(issues|pull)/{number}` URL.
 *
 * Query strings and anchors are ignored (they name UI state, not another
 * resource). The whole input must be that URL: a link inside a sentence is
 * content, not a reference request.
 *
 * @param text - user-supplied text.
 * @returns the resource, or undefined when the text is not this exact shape.
 */
export function parseGithubUrl(text: string): GithubResource | undefined {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  if (!/^https?:\/\//i.test(trimmed)) return undefined
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  // Another host, an explicit non-default port, or an embedded user/password
  // is not a canonical GitHub URL (and credentials must never ride a locator).
  if (url.hostname !== GITHUB_HOST || url.port !== '') return undefined
  if (url.username !== '' || url.password !== '') return undefined
  const match = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/([^/]+)\/?$/.exec(url.pathname)
  if (match === null) return undefined
  const [, owner, repo, resource, rawNumber] = match
  if (owner === undefined || repo === undefined || resource === undefined || rawNumber === undefined) return undefined
  if (!isOwner(owner) || !isRepoName(repo)) return undefined
  const number = parseNumber(rawNumber)
  if (number === undefined) return undefined
  return { host: GITHUB_HOST, owner, repo, kind: resource === 'issues' ? 'issue' : 'pull', number }
}

/**
 * Parse the explicit `owner/repo#number` shorthand (kind-less: the caller's
 * source picks its own kind).
 *
 * @param text - user-supplied text.
 */
export function parseGithubShorthand(
  text: string,
): { readonly owner: string; readonly repo: string; readonly number: number } | undefined {
  if (typeof text !== 'string') return undefined
  const match = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})#([1-9]\d*)$/.exec(text.trim())
  if (match === null) return undefined
  const [, owner, repo, rawNumber] = match
  if (owner === undefined || repo === undefined || rawNumber === undefined) return undefined
  if (!isRepoName(repo)) return undefined
  const number = parseNumber(rawNumber)
  if (number === undefined) return undefined
  return { owner, repo, number }
}

/**
 * Parse a canonical resource URL or the `owner/repo#number` shorthand.
 * @param text - user-supplied text.
 */
export function parseGithubText(text: string): GithubTextParse | undefined {
  const resource = parseGithubUrl(text)
  if (resource !== undefined) return { kind: 'url', resource }
  const shorthand = parseGithubShorthand(text)
  if (shorthand !== undefined) return { kind: 'shorthand', ...shorthand }
  return undefined
}

/**
 * Parse one explicit repository range: `owner/repo` or a repository URL
 * (`https://github.com/owner/repo`). A resource URL is NOT a repository
 * scope; it names one issue/PR.
 *
 * @param text - user-supplied range text.
 */
export function parseGithubRepoRef(text: string): GithubRepoRef | undefined {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      return undefined
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (url.hostname !== GITHUB_HOST || url.port !== '') return undefined
    if (url.username !== '' || url.password !== '') return undefined
    const match = /^\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname)
    if (match === null) return undefined
    const owner = match[1]
    const repo = match[2]
    if (owner === undefined || repo === undefined || !isOwner(owner) || !isRepoName(repo)) return undefined
    return { owner, repo }
  }
  const match = /^([^/\s#?]+)\/([^/\s#?]+)$/.exec(trimmed)
  if (match === null) return undefined
  const owner = match[1]
  const repo = match[2]
  if (owner === undefined || repo === undefined || !isOwner(owner) || !isRepoName(repo)) return undefined
  return { owner, repo }
}

/**
 * Normalize one raw locator to the closed credential-free shape.
 * Unknown fields (a token, a cache path, an account) are DROPPED, not stored.
 *
 * @param locator - untrusted locator value.
 * @throws {ClueError} `invalid-request` when the locator is not a GitHub one.
 */
export function normalizeGithubLocator(locator: unknown): GithubLocator {
  if (!isRecord(locator)) {
    throw new ClueError('invalid-request', 'a GitHub locator must be a JSON object')
  }
  const host = locator.host
  if (typeof host !== 'string' || host.toLowerCase() !== GITHUB_HOST) {
    throw new ClueError('invalid-request', `a GitHub locator needs host "${GITHUB_HOST}"`)
  }
  const owner = locator.owner
  const repo = locator.repo
  if (typeof owner !== 'string' || !isOwner(owner)) {
    throw new ClueError('invalid-request', 'a GitHub locator needs a valid owner')
  }
  if (typeof repo !== 'string' || !isRepoName(repo)) {
    throw new ClueError('invalid-request', 'a GitHub locator needs a valid repository name')
  }
  const kind = locator.kind
  if (!isGithubKind(kind)) {
    throw new ClueError('invalid-request', 'a GitHub locator kind must be "issue" or "pull"')
  }
  const number = locator.number
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > MAX_NUMBER) {
    throw new ClueError('invalid-request', 'a GitHub locator needs a positive integer number')
  }
  const rawTitle = locator.title
  if (rawTitle !== undefined && typeof rawTitle !== 'string') {
    throw new ClueError('invalid-request', 'a GitHub locator title must be a string when present')
  }
  const title = rawTitle === undefined ? '' : escapeClueTitle(rawTitle)
  return {
    host: GITHUB_HOST,
    owner,
    repo,
    kind,
    number,
    ...(title === '' ? {} : { title }),
  }
}

/**
 * Build one normalized locator from a parsed resource (+ optional title).
 * @param resource - canonical resource.
 * @param title - optional readable title (escaped, never part of identity).
 */
export function githubLocatorOf(resource: GithubResource, title?: string): GithubLocator {
  const raw: Locator = {
    host: resource.host,
    owner: resource.owner,
    repo: resource.repo,
    kind: resource.kind,
    number: resource.number,
    ...(title === undefined ? {} : { title }),
  }
  return normalizeGithubLocator(raw)
}

/**
 * Stable equality key of one locator: lower-cased repository + kind + number.
 * A title, a URL query or a cache path never changes it.
 *
 * @param locator - a GitHub locator (normalized here).
 */
export function githubLocatorKey(locator: unknown): string {
  const normalized = normalizeGithubLocator(locator)
  return [
    GITHUB_HOST,
    normalized.owner.toLowerCase(),
    normalized.repo.toLowerCase(),
    normalized.kind,
    String(normalized.number),
  ].join('/')
}

/** The canonical web URL of one resource. */
export function githubResourceUrl(resource: GithubResource): string {
  const segment = resource.kind === 'issue' ? 'issues' : 'pull'
  return `https://${GITHUB_HOST}/${resource.owner}/${resource.repo}/${segment}/${resource.number}`
}

/**
 * The credential-free portable form: exactly the normalized locator.
 * @param locator - a GitHub locator.
 */
export function portableGithubLocator(locator: unknown): CluePortableRef {
  return { portable: true, locator: normalizeGithubLocator(locator) as unknown as Locator }
}

/**
 * Read the optional display title of one locator (never part of identity).
 * @param locator - untrusted locator value.
 */
export function githubLocatorTitle(locator: unknown): string | undefined {
  const normalized = normalizeGithubLocator(locator)
  const title = normalized.title
  return typeof title === 'string' && title !== '' ? title : undefined
}

/** The display title used before the resource body has been read. */
export function githubReferenceTitle(resource: GithubResource): string {
  return `${resource.owner}/${resource.repo}#${resource.number}`
}

/** The type id addressed by one parsed locator's kind. */
export function kindOfLocator(locator: unknown): GithubKind {
  return normalizeGithubLocator(locator).kind
}

/** Whether a value is shaped like a GitHub locator (auto-resolution probe). */
export function isGithubLocatorShape(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.host === 'string'
    && value.host.toLowerCase() === GITHUB_HOST
    && typeof value.owner === 'string'
    && typeof value.repo === 'string'
    && isGithubKind(value.kind)
    && typeof value.number === 'number'
}
