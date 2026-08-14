/**
 * Host half of the built-in GitHub tab: the GitHub REST client, the token
 * resolution chain, and the request-driven inbox cache. No autonomous
 * polling lives here — every client poll triggers a conditional GET
 * (`If-Modified-Since`; a 304 reuses the cached threads and costs no rate
 * limit), and mutations update the cache optimistically.
 *
 * The token never crosses to the browser: it resolves from the plugin
 * configuration, the local `gh` CLI login, or the `GITHUB_TOKEN` /
 * `GH_TOKEN` environment, in that order. The feature degrades to an
 * unconfigured guide when no source yields a token.
 * @module dsh-better-sidebar/github
 */

import { execFile } from 'node:child_process'

import type {
  GithubCheck,
  GithubMergeStatus,
  GithubStateResult,
  GithubThread,
} from './github-shared.ts'
import { SidebarError } from './wire.ts'

export type {
  GithubCheck,
  GithubMergeStatus,
  GithubStateResult,
  GithubThread,
} from './github-shared.ts'

/** Default GitHub REST base (override for GHES deployments). */
export const GITHUB_API_BASE_DEFAULT = 'https://api.github.com'
/** Hard floor for the effective poll interval: never poll faster than GitHub's documented default. */
export const GITHUB_POLL_FLOOR_MIN = 60
/** GitHub's own per_page cap for the notifications endpoint. */
export const GITHUB_PER_PAGE_MAX = 50

/** A successful token resolution stays cached this long (ms). */
const TOKEN_SUCCESS_TTL_MS = 5 * 60_000
/** A failed resolution (gh logged out, no env) is retried after this long (ms). */
const TOKEN_FAILURE_TTL_MS = 30_000
/** Hard cap of the gh auth-token probe (ms). */
const GH_PROBE_TIMEOUT_MS = 10_000

/** GitHub API version pinned by the client (REST notifications surface). */
const GITHUB_API_VERSION = '2022-11-28'
/** Cap of one review/comment body (chars) accepted by the action routes. */
export const GITHUB_BODY_MAX = 64 * 1024
/** Upper bound of inbox pages one poll walks (perPage × this = threads visible). */
export const GITHUB_MAX_PAGES = 5

/** Deploy-tunable GitHub knobs, fully defaulted by {@link resolveSidebarConfig}. */
export interface ResolvedGithubConfig {
  token?: string
  apiBase: string
  /** The human web origin thread links derive from (optional override). */
  webBase?: string
  pollFloorSeconds: number
  perPage: number
  allowMerge: boolean
}

/** A non-2xx GitHub API response. */
export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * The typed failure of the gh probe when the binary is NOT installed
 * (cached for the process lifetime — no repeated spawns). Exported because
 * it is part of the injectable probe contract ({@link GhTokenProbe}): tests
 * and alternative probes throw it to report a missing binary.
 */
export class GhMissingError extends Error {}

/** Raw shape of one GET /notifications row (the fields this module reads). */
interface RawNotification {
  id: string
  unread: boolean
  reason: string
  updated_at: string
  subject: { title: string; url: string | null; latest_comment_url: string | null; type: string | null }
  repository: { full_name: string }
}

/** The web-page path a subject type maps to ('PullRequest' → 'pull', …). */
const HTML_TYPE_SEGMENT: Record<string, string> = {
  PullRequest: 'pull',
  Issue: 'issue',
  Discussion: 'discussions',
  Commit: 'commit',
  Release: 'releases',
}

/**
 * The web origin the thread links derive from: the explicit deployment
 * override, or the api base minus a trailing /api/v3 (the public
 * api.github.com base maps to github.com). GHES deployments whose web UI
 * lives on a different origin/path set githubWebBase explicitly.
 */
function webOriginOf(apiBase: string, webBase: string | undefined): string {
  if (webBase !== undefined && webBase !== '') return webBase
  return apiBase
    .replace(/\/api\/v3$/, '')
    .replace('api.github.com', 'github.com')
}

/**
 * Derive the human web URL from a subject's REST URL. The inbox subject.url
 * is the API endpoint (api.github.com/repos/o/r/pulls/1) — opening it raw
 * serves JSON. The web URL is the same path on the web origin with the
 * type segment singularized ('/repos/o/r/pulls/1' → '/o/r/pull/1').
 * Falls back to the API URL when the path cannot be mapped.
 */
function htmlUrlOf(apiUrl: string, repo: string, type: string, webOrigin: string): string {
  try {
    const parsed = new URL(apiUrl)
    const segment = HTML_TYPE_SEGMENT[type]
    if (segment === undefined) return apiUrl
    const match = /\/repos\/[^/]+\/[^/]+\/(?:pulls?|issues?|discussions|commits|releases)\/([^/]+)/.exec(parsed.pathname)
    if (match === null) return apiUrl
    const webPath = `/${repo}/${segment}/${match[1]}`
    return new URL(webPath, webOrigin).toString()
  } catch {
    return apiUrl
  }
}

/** The URL a Link header's rel="next" names, or null when there is none. */
function nextPageUrl(headers: Headers): string | null {
  const link = headers.get('link')
  if (link === null) return null
  for (const part of link.split(',')) {
    if (!part.includes('rel="next"')) continue
    const match = /<([^>]+)>/.exec(part)
    if (match !== null) return match[1] ?? null
  }
  return null
}

/** Fold one raw notification row into the client-visible thread shape. */
function mapThread(raw: RawNotification, webOrigin: string): GithubThread {
  const url = raw.subject.url ?? ''
  return {
    id: raw.id,
    unread: raw.unread,
    reason: raw.reason,
    repo: raw.repository.full_name,
    title: raw.subject.title,
    url,
    htmlUrl: htmlUrlOf(url, raw.repository.full_name, raw.subject.type ?? '', webOrigin),
    type: raw.subject.type ?? '',
    updatedAt: raw.updated_at,
    ...(raw.subject.latest_comment_url !== null && raw.subject.latest_comment_url !== undefined
      ? { latestCommentUrl: raw.subject.latest_comment_url }
      : {}),
  }
}

/** Run `gh auth token` and return the trimmed token, or a typed failure. */
function execGhToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', ['auth', 'token'], { timeout: GH_PROBE_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout) => {
      if (error !== null) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') reject(new GhMissingError())
        else reject(error)
        return
      }
      const token = stdout.trim()
      if (token === '') reject(new Error('gh auth token returned an empty value'))
      else resolve(token)
    })
  })
}

/** Probes the gh CLI login; injectable for tests. */
export type GhTokenProbe = () => Promise<string>

/** The failing operation's kind — decides the error code the client shows. */
function stateErrorOf(error: unknown): { code: string; message: string } {
  if (error instanceof GithubApiError) {
    if (error.status === 401 || error.status === 403) return { code: 'github-auth', message: error.message }
    return { code: 'github-error', message: error.message }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { code: 'github-network', message }
}

/** Map a thrown GitHub failure onto the sidebar wire error vocabulary. */
export function githubErrorToSidebar(error: unknown): SidebarError {
  if (error instanceof SidebarError) return error
  if (error instanceof GithubApiError) {
    if (error.status === 401 || error.status === 403) return new SidebarError('github-auth', error.message, 403)
    if (error.status === 404) return new SidebarError('github-not-found', error.message, 404)
    if (error.status === 422) return new SidebarError('github-rejected', error.message, 400)
    return new SidebarError('github-error', error.message, 502)
  }
  const message = error instanceof Error ? error.message : String(error)
  return new SidebarError('github-error', message, 502)
}

/** GitHub REST client bound to one token. */
export class GithubClient {
  private readonly webOrigin: string

  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly perPage: number,
    webBase?: string,
  ) {
    this.webOrigin = webOriginOf(base, webBase)
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      accept: 'application/vnd.github+json',
      'x-github-api-version': GITHUB_API_VERSION,
      'user-agent': 'dsh-better-sidebar',
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
      ...extra,
    }
  }

  /**
   * One authed GET. A relative path is joined onto the API base; an
   * absolute http(s) URL (the thread's latest_comment_url) is used as-is,
   * which keeps GHES deployments with an `/api/v3` base path from
   * double-prefixing the comment endpoint.
   */
  private async get(path: string, headers?: Record<string, string>): Promise<{ status: number; headers: Headers; body: unknown }> {
    let target = `${this.base}${path}`
    if (/^https?:\/\//.test(path)) {
      // Absolute URLs (the thread's latest_comment_url) carry the bearer
      // token — only same-origin as the API base may receive it.
      if (new URL(path).origin !== new URL(this.base).origin) {
        throw new GithubApiError(403, 'refusing cross-origin GitHub GET')
      }
      target = path
    }
    const response = await fetch(target, { headers: this.headers(headers) })
    const text = await response.text().catch(() => '')
    let body: unknown = undefined
    if (text !== '') {
      try { body = JSON.parse(text) } catch { /* non-JSON success body (204/205) */ }
    }
    if (!response.ok) {
      const record = body as { message?: unknown } | null
      throw new GithubApiError(response.status, typeof record?.message === 'string' && record.message !== '' ? record.message : `GitHub API ${response.status}`)
    }
    return { status: response.status, headers: response.headers, body }
  }

  /** One authed mutation (PATCH/POST/PUT/DELETE); returns the parsed body. */
  private async send(method: string, path: string, json?: unknown): Promise<unknown> {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: this.headers(),
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    })
    const text = await response.text().catch(() => '')
    let body: unknown = undefined
    if (text !== '') {
      try { body = JSON.parse(text) } catch { /* non-JSON success body */ }
    }
    if (!response.ok) {
      const record = body as { message?: unknown } | null
      throw new GithubApiError(response.status, typeof record?.message === 'string' && record.message !== '' ? record.message : `GitHub API ${response.status}`)
    }
    return body
  }

  /**
   * List unread inbox threads, walking up to {@link GITHUB_MAX_PAGES}
   * pages via the Link header. The FIRST page is conditional on
   * `lastModified` (a 304 returns `notModified` with no body cost, and the
   * cached full list stays valid); the follow-up pages are only fetched
   * when the first page changed, so an unchanged inbox costs one
   * conditional request per poll regardless of inbox size.
   * @returns the folded threads (empty on 304) plus the cache headers.
   */
  async fetchInbox(lastModified?: string): Promise<{ notModified: boolean; threads: GithubThread[]; lastModified?: string; pollIntervalSec: number }> {
    const headers: Record<string, string> = {}
    if (lastModified !== undefined) headers['if-modified-since'] = lastModified
    const first = await fetch(`${this.base}/notifications?per_page=${this.perPage}&all=false`, { headers: this.headers(headers) })
    const pollIntervalSec = this.pollIntervalOf(first.headers)
    const responseLastModified = first.headers.get('last-modified') ?? lastModified
    if (first.status === 304) {
      return { notModified: true, threads: [], lastModified: responseLastModified, pollIntervalSec }
    }
    /** Parse one inbox page response into the accumulator (throws on non-2xx). */
    const adoptPage = async (response: Response): Promise<void> => {
      const text = await response.text().catch(() => '')
      if (!response.ok) {
        let message = `GitHub API ${response.status}`
        try {
          const parsed = JSON.parse(text) as { message?: unknown }
          if (typeof parsed.message === 'string' && parsed.message !== '') message = parsed.message
        } catch { /* keep the generic message */ }
        throw new GithubApiError(response.status, message)
      }
      let pageRaw: RawNotification[] = []
      try { pageRaw = JSON.parse(text) as RawNotification[] } catch { /* empty body — treat as empty page */ }
      raw.push(...pageRaw)
    }
    const raw: RawNotification[] = []
    await adoptPage(first)
    let next = nextPageUrl(first.headers)
    let pages = 1
    while (next !== null && pages < GITHUB_MAX_PAGES) {
      const response = await fetch(next, { headers: this.headers() })
      await adoptPage(response)
      next = nextPageUrl(response.headers)
      pages += 1
    }
    // Newest first — the view's repo grouping and the list order both rely
    // on it (the API's own order is not a documented contract).
    raw.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    return { notModified: false, threads: raw.map(item => mapThread(item, this.webOrigin)), lastModified: responseLastModified, pollIntervalSec }
  }

  /** Poll interval from a response's X-Poll-Interval (GitHub's documented cadence). */
  private pollIntervalOf(headers: Headers): number {
    const value = Number(headers.get('x-poll-interval'))
    return Number.isFinite(value) && value > 0 ? Math.round(value) : GITHUB_POLL_FLOOR_MIN
  }

  /** One thread's detail plus its latest comment body (both fail soft). */
  async fetchThreadDetail(id: string): Promise<{ thread: GithubThread; commentBody?: string }> {
    const threadRes = await this.get(`/notifications/threads/${id}`)
    const thread = mapThread(threadRes.body as RawNotification, this.webOrigin)
    const url = thread.latestCommentUrl
    if (url === undefined) return { thread }
    try {
      const commentRes = await this.get(url)
      const comment = commentRes.body as { body?: unknown } | null
      if (typeof comment?.body === 'string') return { thread, commentBody: comment.body }
    } catch { /* the comment may be gone — the thread alone still renders */ }
    return { thread }
  }

  /** Mark one thread read (PATCH, 204). */
  async markThreadRead(id: string): Promise<void> {
    await this.send('PATCH', `/notifications/threads/${id}`)
  }

  /** Mark one thread done — GitHub's archive (DELETE, 204). */
  async markThreadDone(id: string): Promise<void> {
    await this.send('DELETE', `/notifications/threads/${id}`)
  }

  /** Mark every unread thread read (PUT, 205). */
  async markAllRead(): Promise<void> {
    await this.send('PUT', '/notifications', {})
  }

  /** Submit one PR review event (APPROVE / REQUEST_CHANGES / COMMENT). */
  async submitReview(repo: string, pr: number, event: string, body?: string): Promise<void> {
    await this.send('POST', `/repos/${repo}/pulls/${pr}/reviews`, {
      event,
      ...(body !== undefined && body !== '' ? { body } : {}),
    })
  }

  /** Post a general comment on an issue or PR (the shared comments endpoint). */
  async addComment(repo: string, issue: number, body: string): Promise<void> {
    await this.send('POST', `/repos/${repo}/issues/${issue}/comments`, { body })
  }

  /** Mergeability of one PR plus its head-sha check runs, normalized. */
  async fetchMergeStatus(repo: string, pr: number): Promise<GithubMergeStatus> {
    const pullRes = await this.get(`/repos/${repo}/pulls/${pr}`)
    const pull = pullRes.body as { head?: { sha?: unknown } | null; state?: unknown; mergeable?: unknown } | null
    const sha = typeof pull?.head?.sha === 'string' ? pull.head.sha : undefined
    const checks: GithubCheck[] = []
    if (sha !== undefined) {
      try {
        const runsRes = await this.get(`/repos/${repo}/commits/${sha}/check-runs`)
        const runs = runsRes.body as { check_runs?: { name?: unknown; status?: unknown; conclusion?: unknown }[] } | null
        for (const run of runs?.check_runs ?? []) {
          checks.push({
            name: typeof run.name === 'string' ? run.name : 'check',
            status: typeof run.status === 'string' ? run.status : 'unknown',
            conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
          })
        }
      } catch { /* checks are advisory — mergeability still answers */ }
    }
    return {
      checks,
      mergeable: typeof pull?.mergeable === 'boolean' ? pull.mergeable : null,
      state: typeof pull?.state === 'string' ? pull.state : 'unknown',
    }
  }

  /** Merge one PR with the chosen method (merge / squash / rebase). */
  async merge(repo: string, pr: number, method: string): Promise<void> {
    await this.send('PUT', `/repos/${repo}/pulls/${pr}/merge`, { merge_method: method })
  }
}

/**
 * The GitHub tab's host service: token resolution with caching, the
 * request-driven inbox cache (conditional GETs), and the mutation surface
 * with optimistic cache updates. One instance per host half.
 */
export class GithubInboxService {
  private tokenCache?: { token?: string; at: number }
  private ghMissing = false
  private cache?: { threads: GithubThread[]; lastModified?: string; fetchedAt: number; pollIntervalSec: number }

  constructor(
    private readonly config: ResolvedGithubConfig,
    private readonly probeGh: GhTokenProbe = execGhToken,
  ) {}

  private ghAvailable(): boolean {
    return !this.ghMissing
  }

  /** Resolve a token through config → gh CLI → environment (with caching). */
  private async resolveToken(): Promise<{ token?: string; ghAvailable: boolean }> {
    if (this.config.token !== undefined && this.config.token !== '') {
      return { token: this.config.token, ghAvailable: this.ghAvailable() }
    }
    const now = Date.now()
    const cached = this.tokenCache
    if (cached !== undefined && now - cached.at < (cached.token !== undefined ? TOKEN_SUCCESS_TTL_MS : TOKEN_FAILURE_TTL_MS)) {
      return { token: cached.token, ghAvailable: this.ghAvailable() }
    }
    let ghToken: string | undefined
    if (!this.ghMissing) {
      try {
        ghToken = await this.probeGh()
      } catch (error) {
        // A missing binary is permanent for this process (no repeated
        // spawns); a logged-out / timed-out gh stays on the short retry.
        if (error instanceof GhMissingError) this.ghMissing = true
        ghToken = undefined
      }
    }
    const env = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
    const token = ghToken !== undefined ? ghToken : (env !== undefined && env !== '' ? env : undefined)
    this.tokenCache = { token, at: now }
    return { token, ghAvailable: this.ghAvailable() }
  }

  private snapshot(): GithubStateResult {
    return {
      configured: true,
      ghAvailable: this.ghAvailable(),
      allowMerge: this.config.allowMerge,
      threads: this.cache?.threads ?? [],
      fetchedAt: this.cache !== undefined ? new Date(this.cache.fetchedAt).toISOString() : undefined,
      pollIntervalSec: Math.max(this.config.pollFloorSeconds, this.cache?.pollIntervalSec ?? this.config.pollFloorSeconds),
    }
  }

  /**
   * The inbox snapshot. Fetches (conditionally) only when the cache is
   * staler than the effective poll interval; `force` bypasses freshness
   * for the refresh button. Failures keep the last threads and surface the
   * error code — the inbox view keeps rendering stale data with a warning.
   */
  async state(force: boolean): Promise<GithubStateResult> {
    const resolved = await this.resolveToken()
    if (resolved.token === undefined) {
      return { configured: false, ghAvailable: resolved.ghAvailable, allowMerge: this.config.allowMerge, threads: [], pollIntervalSec: this.config.pollFloorSeconds }
    }
    const client = new GithubClient(this.config.apiBase, resolved.token, this.config.perPage, this.config.webBase)
    const freshMs = Math.max(this.config.pollFloorSeconds, this.cache?.pollIntervalSec ?? this.config.pollFloorSeconds) * 1000
    const now = Date.now()
    if (!force && this.cache !== undefined && now - this.cache.fetchedAt < freshMs) return this.snapshot()
    try {
      const inbox = await client.fetchInbox(this.cache?.lastModified)
      if (inbox.notModified && this.cache !== undefined) {
        // A 304 still carries a fresh X-Poll-Interval — adopt it so the
        // cache window tracks GitHub's current guidance under load.
        this.cache = { ...this.cache, fetchedAt: now, pollIntervalSec: Math.max(this.config.pollFloorSeconds, inbox.pollIntervalSec) }
        return this.snapshot()
      }
      this.cache = {
        threads: inbox.threads,
        lastModified: inbox.lastModified,
        fetchedAt: now,
        pollIntervalSec: Math.max(this.config.pollFloorSeconds, inbox.pollIntervalSec),
      }
      return this.snapshot()
    } catch (error) {
      return {
        configured: true,
        ghAvailable: this.ghAvailable(),
        allowMerge: this.config.allowMerge,
        error: stateErrorOf(error),
        threads: this.cache?.threads ?? [],
        fetchedAt: this.cache !== undefined ? new Date(this.cache.fetchedAt).toISOString() : undefined,
        pollIntervalSec: this.config.pollFloorSeconds,
      }
    }
  }

  /** One thread's detail plus its latest comment body. */
  async thread(id: string): Promise<{ thread: GithubThread; commentBody?: string }> {
    return (await this.requireClient()).fetchThreadDetail(id)
  }

  /** Mark one thread read and drop it from the cached inbox (it is no longer unread). */
  async markRead(id: string): Promise<void> {
    await (await this.requireClient()).markThreadRead(id)
    this.removeCached(id)
  }

  /** Mark one thread done (archived) and drop it from the cached inbox. */
  async markDone(id: string): Promise<void> {
    await (await this.requireClient()).markThreadDone(id)
    this.removeCached(id)
  }

  /** Mark every thread read and clear the cached inbox. */
  async markAllRead(): Promise<void> {
    await (await this.requireClient()).markAllRead()
    this.cache = this.cache === undefined ? undefined : { ...this.cache, threads: [], fetchedAt: Date.now() }
  }

  /** Submit one PR review event. */
  async review(repo: string, pr: number, event: string, body?: string): Promise<void> {
    await (await this.requireClient()).submitReview(repo, pr, event, body)
  }

  /** Post a general comment on an issue or PR. */
  async comment(repo: string, issue: number, body: string): Promise<void> {
    await (await this.requireClient()).addComment(repo, issue, body)
  }

  /** Mergeability plus head checks for the merge panel. */
  async mergeStatus(repo: string, pr: number): Promise<GithubMergeStatus> {
    return (await this.requireClient()).fetchMergeStatus(repo, pr)
  }

  /** Merge one PR (gated by the deployment's `githubAllowMerge`). */
  async merge(repo: string, pr: number, method: string): Promise<void> {
    if (!this.config.allowMerge) {
      throw new SidebarError('github-forbidden', 'merge is disabled by configuration (githubAllowMerge)', 403)
    }
    await (await this.requireClient()).merge(repo, pr, method)
  }

  private async requireClient(): Promise<GithubClient> {
    const resolved = await this.resolveToken()
    if (resolved.token === undefined) {
      throw new SidebarError('github-unavailable', 'GitHub is not configured (no token resolved)', 503)
    }
    return new GithubClient(this.config.apiBase, resolved.token, this.config.perPage, this.config.webBase)
  }

  private removeCached(id: string): void {
    if (this.cache === undefined) return
    this.cache = { ...this.cache, threads: this.cache.threads.filter(thread => thread.id !== id) }
  }
}
