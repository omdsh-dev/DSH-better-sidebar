/**
 * GitHub tab tests: the pure classification / filter / grouping functions,
 * the host inbox service's request-driven cache (conditional GET, 304,
 * error handling, optimistic removal, merge gate), and the route group's
 * payload validation. The GitHub API surface is mocked at the fetch level;
 * the gh probe is injected, so no real credential or network is touched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  categorizeThread,
  countUnread,
  filterThreads,
  GITHUB_CATEGORY_PREF_KEYS,
  groupThreads,
  reviewVerdict,
  threadNumber,
} from '../src/client/github-inbox.ts'
import type { GithubThread } from '../src/github-shared.ts'
import {
  GhMissingError,
  GithubInboxService,
  type ResolvedGithubConfig,
} from '../src/github.ts'
import { buildGithubApi } from '../src/github-routes.ts'
import { SidebarError } from '../src/wire.ts'
import { SIDEBAR_PREFS_DEFAULTS, type SidebarPrefs } from '../src/prefs-shared.ts'

/** One raw notification row for the mocked inbox responses. */
interface RawThread {
  id: string
  unread: boolean
  reason: string
  updated_at: string
  subject: { title: string; url: string | null; latest_comment_url: string | null; type: string | null }
  repository: { full_name: string }
}

function rawThread(id: string, reason: string, type: string, repo = 'o/r', title = `${id} title`): RawThread {
  return {
    id,
    unread: true,
    reason,
    updated_at: `2024-01-0${id}T00:00:00Z`,
    subject: { title, url: `https://api.example.test/repos/${repo}/pulls/${id}`, latest_comment_url: null, type },
    repository: { full_name: repo },
  }
}

/** One client-visible thread (the mapped wire shape the pure functions consume). */
function mappedThread(id: string, reason: string, type: string, repo = 'o/r', title = `${id} title`): GithubThread {
  return {
    id,
    unread: true,
    reason,
    repo,
    title,
    url: `https://api.example.test/repos/${repo}/pulls/${id}`,
    htmlUrl: `https://api.example.test/${repo}/pull/${id}`,
    type,
    updatedAt: `2024-01-0${id}T00:00:00Z`,
  }
}

const LAST_MODIFIED = 'Mon, 01 Jan 2024 00:00:00 GMT'

/** A 200 inbox response carrying the given threads. */
function inboxResponse(threads: RawThread[]): Response {
  return new Response(JSON.stringify(threads), {
    status: 200,
    headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60' },
  })
}

/** A default-configured service whose gh probe must never run (config token short-circuits it). */
function makeService(config: Partial<ResolvedGithubConfig> = {}): GithubInboxService {
  return new GithubInboxService({
    token: 'tok',
    apiBase: 'https://api.example.test',
    pollFloorSeconds: 60,
    perPage: 50,
    allowMerge: false,
    ...config,
  }, async () => { throw new Error('gh probe should not run') })
}

describe('github-inbox pure functions', () => {
  it('categorizes the five categories from reason + subject type', () => {
    expect(categorizeThread({ reason: 'review_requested', type: 'PullRequest' })).toBe('reviewRequested')
    expect(categorizeThread({ reason: 'ci_activity', type: 'PullRequest' })).toBe('ci')
    expect(categorizeThread({ reason: 'author', type: 'PullRequest' })).toBe('prActivity')
    expect(categorizeThread({ reason: 'author', type: 'Issue' })).toBe('comments')
    expect(categorizeThread({ reason: 'comment', type: 'Issue' })).toBe('comments')
    expect(categorizeThread({ reason: 'mention', type: 'PullRequest' })).toBe('comments')
    expect(categorizeThread({ reason: 'team_mention', type: 'Issue' })).toBe('comments')
    expect(categorizeThread({ reason: 'subscribed', type: 'Issue' })).toBe('other')
    expect(categorizeThread({ reason: 'assign', type: 'Issue' })).toBe('other')
    expect(categorizeThread({ reason: 'security_alert', type: 'Issue' })).toBe('other')
  })

  it('detects review verdicts from the subject title (display-level)', () => {
    expect(reviewVerdict('alice approved these changes')).toBe('approved')
    expect(reviewVerdict('bob requested changes on this pull request')).toBe('changesRequested')
    expect(reviewVerdict('merged pull request #1')).toBeUndefined()
    expect(reviewVerdict('carol commented on pull request')).toBeUndefined()
  })

  it('filters by the prefs checkboxes (CI hidden by default)', () => {
    const threads = [
      mappedThread('1', 'review_requested', 'PullRequest'),
      mappedThread('2', 'author', 'PullRequest'),
      mappedThread('3', 'ci_activity', 'PullRequest'),
      mappedThread('4', 'mention', 'Issue'),
    ]
    const visible = filterThreads(threads, SIDEBAR_PREFS_DEFAULTS)
    expect(visible.map(thread => thread.id)).toEqual(['1', '2', '4'])
    const withCi: SidebarPrefs = { ...SIDEBAR_PREFS_DEFAULTS, githubShowCi: true }
    expect(filterThreads(threads, withCi).map(thread => thread.id)).toEqual(['1', '2', '3', '4'])
    // Every category maps to a real prefs key (chips write through it).
    expect(GITHUB_CATEGORY_PREF_KEYS.ci).toBe('githubShowCi')
  })

  it('counts unread threads and caps nothing itself (the badge caps 99+)', () => {
    const threads = [
      mappedThread('1', 'review_requested', 'PullRequest'),
      { ...mappedThread('2', 'author', 'PullRequest'), unread: false },
      mappedThread('3', 'mention', 'Issue'),
    ]
    expect(countUnread(threads)).toBe(2)
  })

  it('extracts the PR/issue number from thread URLs', () => {
    expect(threadNumber('https://api.github.com/repos/o/r/pulls/123')).toBe(123)
    expect(threadNumber('https://api.github.com/repos/o/r/issues/77')).toBe(77)
    expect(threadNumber('https://api.github.com/repos/o/r/commits/abc')).toBeUndefined()
  })

  it('groups threads by repo, newest group first', () => {
    const threads = [
      mappedThread('2', 'review_requested', 'PullRequest', 'b/r'),
      mappedThread('1', 'review_requested', 'PullRequest', 'a/r'),
      mappedThread('3', 'mention', 'Issue', 'b/r'),
    ]
    const groups = groupThreads(threads)
    expect(groups.map(group => group.repo)).toEqual(['b/r', 'a/r'])
    expect(groups[0]?.threads.map(thread => thread.id)).toEqual(['2', '3'])
  })
})

describe('GithubInboxService', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches the inbox once, then serves the freshness window from cache', async () => {
    const fetchMock = vi.fn().mockResolvedValue(inboxResponse([rawThread('1', 'review_requested', 'PullRequest')]))
    vi.stubGlobal('fetch', fetchMock)
    const service = makeService()
    const first = await service.state(false)
    expect(first.configured).toBe(true)
    expect(first.threads).toHaveLength(1)
    expect(first.threads[0]).toMatchObject({ id: '1', repo: 'o/r', type: 'PullRequest', url: 'https://api.example.test/repos/o/r/pulls/1' })
    expect(first.pollIntervalSec).toBe(60)
    expect(first.allowMerge).toBe(false)
    const second = await service.state(false)
    expect(second.threads[0]?.id).toBe('1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('orders fetched threads newest-first regardless of the API order', async () => {
    const older = rawThread('1', 'review_requested', 'PullRequest')
    const newer = { ...rawThread('2', 'mention', 'Issue'), updated_at: '2024-02-01T00:00:00Z' }
    const fetchMock = vi.fn().mockResolvedValue(inboxResponse([older, newer]))
    vi.stubGlobal('fetch', fetchMock)
    const service = makeService()
    const state = await service.state(false)
    expect(state.threads.map(thread => thread.id)).toEqual(['2', '1'])
  })

  it('reuses the cache on a 304, adopts a raised X-Poll-Interval, and sends If-Modified-Since on forced refetches', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(inboxResponse([rawThread('1', 'review_requested', 'PullRequest')]))
      .mockResolvedValueOnce(new Response(null, { status: 304, headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '120' } }))
    vi.stubGlobal('fetch', fetchMock)
    const service = makeService()
    await service.state(false)
    const state = await service.state(true)
    expect(state.threads).toHaveLength(1)
    expect(state.pollIntervalSec).toBe(120)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const secondCall = fetchMock.mock.calls[1] as unknown[]
    expect((secondCall[1] as { headers: Record<string, string> }).headers['if-modified-since']).toBe(LAST_MODIFIED)
  })

  it('walks inbox pages via the Link header and merges them newest-first', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([rawThread('1', 'review_requested', 'PullRequest')]), {
        status: 200,
        headers: { 'last-modified': LAST_MODIFIED, 'x-poll-interval': '60', link: '<https://api.example.test/notifications?page=2>; rel="next"' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([rawThread('2', 'mention', 'Issue')]), {
        status: 200,
        headers: { 'x-poll-interval': '60' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    const service = makeService()
    const state = await service.state(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(state.threads.map(thread => thread.id)).toEqual(['2', '1'])
  })

  it('derives the human web URL for a GHES subpath deployment from the explicit web base', async () => {
    const fetchMock = vi.fn().mockResolvedValue(inboxResponse([rawThread('1', 'review_requested', 'PullRequest')]))
    vi.stubGlobal('fetch', fetchMock)
    const service = makeService({ apiBase: 'https://ghe.example/enterprise/api/v3', webBase: 'https://ghe.example' })
    const state = await service.state(false)
    expect(state.threads[0]?.htmlUrl).toBe('https://ghe.example/o/r/pull/1')
  })

  it('derives the human web URL from the REST subject URL (github.com origin)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(inboxResponse([rawThread('1', 'review_requested', 'PullRequest')]))
    vi.stubGlobal('fetch', fetchMock)
    const service = makeService({ apiBase: 'https://api.github.com' })
    const state = await service.state(false)
    expect(state.threads[0]?.htmlUrl).toBe('https://github.com/o/r/pull/1')
    expect(state.threads[0]?.url).toBe('https://api.example.test/repos/o/r/pulls/1')
  })

  it('keeps the last snapshot and reports github-auth on 401', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(inboxResponse([rawThread('1', 'review_requested', 'PullRequest')]))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const service = makeService()
    await service.state(false)
    const state = await service.state(true)
    expect(state.error?.code).toBe('github-auth')
    expect(state.threads).toHaveLength(1)
  })

  it('markRead drops the thread from the cached inbox optimistically', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(inboxResponse([rawThread('1', 'review_requested', 'PullRequest'), rawThread('2', 'mention', 'Issue')]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const service = makeService()
    await service.state(false)
    await service.markRead('1')
    const state = await service.state(false)
    expect(state.threads.map(thread => thread.id)).toEqual(['2'])
  })

  it('gates merge behind githubAllowMerge before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const gated = makeService({ allowMerge: false })
    await expect(gated.merge('o/r', 1, 'squash')).rejects.toMatchObject({ code: 'github-forbidden' })
    expect(fetchMock).not.toHaveBeenCalled()
    const open = makeService({ allowMerge: true })
    fetchMock.mockResolvedValueOnce(inboxResponse([rawThread('1', 'review_requested', 'PullRequest')]))
    const openState = await open.state(false)
    expect(openState.allowMerge).toBe(true)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ merged: true }), { status: 200 }))
    await open.merge('o/r', 1, 'squash')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/repos/o/r/pulls/1/merge',
      expect.objectContaining({ method: 'PUT' }),
    )
  })

  it('reports unconfigured with ghAvailable=false when the binary is missing', async () => {
    vi.stubEnv('GITHUB_TOKEN', '')
    vi.stubEnv('GH_TOKEN', '')
    const service = new GithubInboxService({
      apiBase: 'https://api.example.test',
      pollFloorSeconds: 60,
      perPage: 50,
      allowMerge: false,
    }, async () => { throw new GhMissingError() })
    const state = await service.state(false)
    expect(state.configured).toBe(false)
    expect(state.ghAvailable).toBe(false)
    expect(state.threads).toEqual([])
  })

  it('reports unconfigured with ghAvailable=true when gh is installed but logged out', async () => {
    vi.stubEnv('GITHUB_TOKEN', '')
    vi.stubEnv('GH_TOKEN', '')
    const service = new GithubInboxService({
      apiBase: 'https://api.example.test',
      pollFloorSeconds: 60,
      perPage: 50,
      allowMerge: false,
    }, async () => { throw new Error('not logged into any hosts') })
    const state = await service.state(false)
    expect(state.configured).toBe(false)
    expect(state.ghAvailable).toBe(true)
  })
})

/** The wire error code a sync route call throws (undefined when it does not). */
function codeOf(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return (error as SidebarError).code
  }
}

describe('github routes', () => {
  it('rejects malformed payloads loudly (bad event / repo / number / method / body / id)', async () => {
    const routes = buildGithubApi(makeService())
    expect(codeOf(() => routes.review({ repo: 'o/r', pr: 1, event: 'BOOM' }))).toBe('bad-request')
    expect(codeOf(() => routes.review({ repo: 'norepo', pr: 1, event: 'APPROVE' }))).toBe('bad-request')
    expect(codeOf(() => routes.review({ repo: 'a//b', pr: 1, event: 'APPROVE' }))).toBe('bad-request')
    expect(codeOf(() => routes.review({ repo: 'a/b?x=1', pr: 1, event: 'APPROVE' }))).toBe('bad-request')
    expect(codeOf(() => routes.markRead({ id: '../etc' }))).toBe('bad-request')
    expect(codeOf(() => routes.markRead({ id: 'abc' }))).toBe('bad-request')
    // A valid id passes validation and surfaces the (unstubbed) fetch
    // failure as the github-error wire code on the async path.
    await expect(routes.markRead({ id: '123456789' })).rejects.toMatchObject({ code: 'github-error' })
    expect(codeOf(() => routes.review({ repo: 'o/r', pr: 0, event: 'APPROVE' }))).toBe('bad-request')
    expect(codeOf(() => routes.merge({ repo: 'o/r', pr: 1, method: 'fast-forward' }))).toBe('bad-request')
    expect(codeOf(() => routes.comment({ repo: 'o/r', issue: 1, body: '' }))).toBe('bad-request')
    expect(codeOf(() => routes.comment({ repo: 'o/r', issue: 1, body: 'x'.repeat(64 * 1024 + 1) }))).toBe('bad-request')
  })

  it('actions surface github-unavailable while no token resolves', async () => {
    vi.stubEnv('GITHUB_TOKEN', '')
    vi.stubEnv('GH_TOKEN', '')
    const service = new GithubInboxService({
      apiBase: 'https://api.example.test',
      pollFloorSeconds: 60,
      perPage: 50,
      allowMerge: true,
    }, async () => { throw new GhMissingError() })
    const routes = buildGithubApi(service)
    await expect(routes.markRead({ id: '1' })).rejects.toMatchObject({ code: 'github-unavailable' })
    await expect(routes.merge({ repo: 'o/r', pr: 1, method: 'squash' })).rejects.toMatchObject({ code: 'github-unavailable' })
  })

  it('maps a GitHub 422 rejection onto the github-rejected wire code', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'Branch protection rule requires a review' }), { status: 422 }))
    vi.stubGlobal('fetch', fetchMock)
    const routes = buildGithubApi(makeService({ allowMerge: true }))
    await expect(routes.merge({ repo: 'o/r', pr: 1, method: 'squash' })).rejects.toMatchObject({ code: 'github-rejected', message: 'Branch protection rule requires a review' })
  })
})
