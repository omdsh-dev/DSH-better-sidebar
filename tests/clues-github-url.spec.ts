/**
 * S3 GitHub identity contract: URLs, locators, list scopes, cursors and the
 * save-before revision.
 *
 * These are the pure rules the rest of the source builds on (no `gh`, no
 * filesystem, no clock):
 * - only the canonical `github.com/{owner}/{repo}/(issues|pull)/{number}`
 *   shape is recognized; query strings and anchors are ignored, every other
 *   host, short link, prose-wrapped link and title guess is NOT a target;
 * - a locator is the closed JSON set `{host, owner, repo, kind, number}`
 *   (+ an optional readable, escaped title); identity lower-cases owner/repo
 *   and keeps issue and pull apart even for the same number;
 * - the portable form carries exactly that locator — never a token, account
 *   or install path;
 * - a list/search scope always names ONE `owner/repo` (plus a bounded state
 *   filter); an absent scope is an explicit request error, never a global
 *   sweep;
 * - cursors are opaque, bound to source/kind/repo/state/query, and a cursor
 *   from another range is refused instead of silently continued;
 * - the revision is `updatedAt` + content fingerprint: an opaque
 *   check-before-save baseline, NOT a GitHub ETag or atomic CAS token.
 */
import { describe, expect, it } from 'vitest'
import { ClueError } from '../src/clues/error.ts'
import {
  GITHUB_CONNECTION_ID,
  GITHUB_DEFAULT_PAGE_LIMIT,
  GITHUB_DEPENDENCY_ID,
  GITHUB_HOST,
  GITHUB_MAX_PAGE_LIMIT,
  GITHUB_PLUGIN_ID,
  GITHUB_SOURCE_IDS,
  GITHUB_TYPE_IDS,
  kindOfSourceId,
  kindOfTypeId,
  sourceIdOfKind,
  typeIdOfKind,
} from '../src/clues/sources/github/ids.ts'
import {
  githubLocatorKey,
  githubLocatorOf,
  githubResourceUrl,
  normalizeGithubLocator,
  parseGithubText,
  parseGithubUrl,
  portableGithubLocator,
  GITHUB_LOCATOR_KEYS,
} from '../src/clues/sources/github/url.ts'
import {
  decodeGithubCursor,
  encodeGithubCursor,
  githubScopeKey,
  pageLimitOf,
  parseGithubScope,
} from '../src/clues/sources/github/scope.ts'
import { githubRevisionOf } from '../src/clues/sources/github/revision.ts'
import type { Locator } from '../src/clues/types.ts'

/** Assert a clue error category without depending on its message text. */
function categoryOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof ClueError) return error.category
    throw error
  }
  throw new Error('expected a ClueError')
}

describe('built-in GitHub identities', () => {
  it('uses the fixed S1 source/type ids and one shared dependency/connection', () => {
    expect(GITHUB_HOST).toBe('github.com')
    expect(GITHUB_PLUGIN_ID).toBe('dsh-better-sidebar')
    expect(GITHUB_SOURCE_IDS).toEqual({
      issue: 'builtin.github.issues',
      pull: 'builtin.github.pulls',
    })
    expect(GITHUB_TYPE_IDS).toEqual({
      issue: 'builtin.github.issue',
      pull: 'builtin.github.pull',
    })
    expect(GITHUB_DEPENDENCY_ID).toBe('github.gh')
    expect(GITHUB_CONNECTION_ID).toBe('github.gh.auth')
    expect(sourceIdOfKind('issue')).toBe(GITHUB_SOURCE_IDS.issue)
    expect(sourceIdOfKind('pull')).toBe(GITHUB_SOURCE_IDS.pull)
    expect(typeIdOfKind('issue')).toBe(GITHUB_TYPE_IDS.issue)
    expect(typeIdOfKind('pull')).toBe(GITHUB_TYPE_IDS.pull)
    expect(kindOfSourceId(GITHUB_SOURCE_IDS.issue)).toBe('issue')
    expect(kindOfSourceId(GITHUB_SOURCE_IDS.pull)).toBe('pull')
    expect(kindOfSourceId('builtin.files')).toBeUndefined()
    expect(kindOfTypeId(GITHUB_TYPE_IDS.issue)).toBe('issue')
    expect(kindOfTypeId(GITHUB_TYPE_IDS.pull)).toBe('pull')
    expect(kindOfTypeId('builtin.files.markdown')).toBeUndefined()
  })
})

describe('canonical GitHub URLs', () => {
  it('parses issue and pull URLs with owner/repo/kind/number', () => {
    expect(parseGithubUrl('https://github.com/cli/cli/issues/14609')).toEqual({
      host: 'github.com', owner: 'cli', repo: 'cli', kind: 'issue', number: 14609,
    })
    expect(parseGithubUrl('https://github.com/cli/cli/pull/14727')).toEqual({
      host: 'github.com', owner: 'cli', repo: 'cli', kind: 'pull', number: 14727,
    })
    // http, a trailing slash, an uppercase host and mixed-case names are the
    // same resource; normalization is the locator's job, not the URL's.
    expect(parseGithubUrl('http://GitHub.com/Cli/CLI/pull/9/')).toEqual({
      host: 'github.com', owner: 'Cli', repo: 'CLI', kind: 'pull', number: 9,
    })
  })

  it('ignores the query string and the anchor of a canonical URL', () => {
    expect(parseGithubUrl('https://github.com/o/r/issues/12?notification_referrer=1#issuecomment-2'))
      .toEqual({ host: 'github.com', owner: 'o', repo: 'r', kind: 'issue', number: 12 })
  })

  it('rejects every other shape instead of guessing a target', () => {
    for (const text of [
      'https://www.github.com/o/r/issues/1',
      'https://gist.github.com/o/r/issues/1',
      'https://gitlab.com/o/r/issues/1',
      'https://github.com/o/r',
      'https://github.com/o/r/issues',
      'https://github.com/o/r/issues/',
      'https://github.com/o/r/issues/abc',
      'https://github.com/o/r/issues/0',
      'https://github.com/o/r/issues/-1',
      'https://github.com/o/r/issues/007',
      'https://github.com/o/r/issues/1/files',
      'https://github.com/o/r/pull/1/commits',
      'https://github.com/o/r/blob/main/README.md',
      'github.com/o/r/issues/1',
      'git@github.com:o/r.git',
      'https://git.io/abcdef',
      'see https://github.com/o/r/issues/1 for details',
      'please fix the github.com issue',
    ]) {
      expect(parseGithubUrl(text), text).toBeUndefined()
    }
  })
})

describe('repository + number shorthand', () => {
  it('parses owner/repo#number as a kind-less resource', () => {
    expect(parseGithubText('cli/cli#14609')).toEqual({
      kind: 'shorthand',
      owner: 'cli',
      repo: 'cli',
      number: 14609,
    })
    expect(parseGithubText('  CLI/cli#9  ')).toEqual({
      kind: 'shorthand',
      owner: 'CLI',
      repo: 'cli',
      number: 9,
    })
  })

  it('reports the canonical URL form with its kind', () => {
    expect(parseGithubText('https://github.com/cli/cli/pull/14727')).toEqual({
      kind: 'url',
      resource: { host: 'github.com', owner: 'cli', repo: 'cli', kind: 'pull', number: 14727 },
    })
  })

  it('rejects malformed shorthand and prose-wrapped references', () => {
    for (const text of [
      'cli#1',
      'cli/cli#',
      'cli/cli#x',
      'cli/cli#0',
      'cli/cli#01',
      'cli/cli#1 extra',
      'issue cli/cli#1',
      'cli/cli',
      'cli/cli#-1',
    ]) {
      expect(parseGithubText(text), text).toBeUndefined()
    }
  })
})

describe('locator normalization and identity', () => {
  const raw: Locator = {
    host: 'GitHub.com',
    owner: 'Cli',
    repo: 'CLI',
    kind: 'issue',
    number: 12,
    token: 'gho_secret',
    path: '/tmp/private',
  }

  it('keeps only the closed credential-free field set', () => {
    const normalized = normalizeGithubLocator(raw)
    expect(normalized).toEqual({ host: 'github.com', owner: 'Cli', repo: 'CLI', kind: 'issue', number: 12 })
    expect(Object.keys(normalized).sort()).toEqual([...GITHUB_LOCATOR_KEYS].sort())
    expect(JSON.stringify(normalized)).not.toContain('gho_secret')
  })

  it('carries an optional escaped readable title without making it identity', () => {
    const withTitle = normalizeGithubLocator({ ...raw, title: 'a [bracketed] title' } as Locator)
    expect(withTitle.title).toBe('a ［bracketed］ title')
    expect(githubLocatorKey(withTitle)).toBe(githubLocatorKey(normalizeGithubLocator(raw)))
  })

  it('lower-cases owner/repo for identity but keeps issue and pull distinct', () => {
    const a = githubLocatorOf({ host: 'github.com', owner: 'CLI', repo: 'Cli', kind: 'issue', number: 1 })
    const b = githubLocatorOf({ host: 'github.com', owner: 'cli', repo: 'cli', kind: 'issue', number: 1 })
    const pull = githubLocatorOf({ host: 'github.com', owner: 'cli', repo: 'cli', kind: 'pull', number: 1 })
    expect(githubLocatorKey(a)).toBe(githubLocatorKey(b))
    expect(githubLocatorKey(a)).not.toBe(githubLocatorKey(pull))
    expect(githubLocatorKey(a)).not.toContain('token')
  })

  it('rejects malformed locators with the fixed invalid-request category', () => {
    for (const locator of [
      {},
      { host: 'gitlab.com', owner: 'o', repo: 'r', kind: 'issue', number: 1 },
      { host: 'github.com', owner: 'o', repo: 'r', kind: 'pr', number: 1 },
      { host: 'github.com', owner: 'o', repo: 'r', kind: 'issue', number: 0 },
      { host: 'github.com', owner: 'o', repo: 'r', kind: 'issue', number: 1.5 },
      { host: 'github.com', owner: '', repo: 'r', kind: 'issue', number: 1 },
      { host: 'github.com', owner: 'o', repo: '..', kind: 'issue', number: 1 },
      { host: 'github.com', owner: 'o/x', repo: 'r', kind: 'issue', number: 1 },
      { host: 'github.com', owner: 'o', repo: 'r', kind: 'issue', number: '1' },
    ]) {
      expect(categoryOf(() => normalizeGithubLocator(locator as Locator)), JSON.stringify(locator))
        .toBe('invalid-request')
    }
  })

  it('builds the canonical web URL', () => {
    expect(githubResourceUrl({ host: 'github.com', owner: 'cli', repo: 'cli', kind: 'pull', number: 9 }))
      .toBe('https://github.com/cli/cli/pull/9')
  })
})

describe('portable locator', () => {
  it('returns the normalized locator with no credential, account or path', () => {
    const locator = githubLocatorOf({ host: 'github.com', owner: 'cli', repo: 'cli', kind: 'issue', number: 3 })
    const portable = portableGithubLocator(locator)
    expect(portable).toEqual({ portable: true, locator })
    const text = JSON.stringify(portable)
    for (const forbidden of ['token', 'account', 'login', 'password', 'keyring', '/Users/', 'gho_']) {
      expect(text).not.toContain(forbidden)
    }
  })
})

describe('explicit single-repository scope', () => {
  it('accepts owner/repo, a repository URL and an optional bounded state', () => {
    expect(parseGithubScope('cli/cli')).toEqual({
      repo: { owner: 'cli', repo: 'cli' },
      state: 'open',
    })
    expect(parseGithubScope({ repo: 'https://github.com/cli/cli/', state: 'closed' })).toEqual({
      repo: { owner: 'cli', repo: 'cli' },
      state: 'closed',
    })
    expect(parseGithubScope({ repo: 'cli/cli', state: 'all' })).toEqual({
      repo: { owner: 'cli', repo: 'cli' },
      state: 'all',
    })
  })

  it('refuses a missing or non-repository scope instead of sweeping every repo', () => {
    expect(categoryOf(() => parseGithubScope(undefined))).toBe('invalid-request')
    expect(categoryOf(() => parseGithubScope({}))).toBe('invalid-request')
    expect(categoryOf(() => parseGithubScope('cli/cli/issues/1'))).toBe('invalid-request')
    expect(categoryOf(() => parseGithubScope('https://gitlab.com/cli/cli'))).toBe('invalid-request')
    expect(categoryOf(() => parseGithubScope('../etc/passwd'))).toBe('invalid-request')
    expect(categoryOf(() => parseGithubScope({ repo: 'cli/cli', state: 'merged' }))).toBe('invalid-request')
  })

  it('keys a scope stably and case-insensitively', () => {
    expect(githubScopeKey(parseGithubScope('CLI/CLI'))).toBe(githubScopeKey(parseGithubScope('cli/cli')))
    expect(githubScopeKey(parseGithubScope({ repo: 'cli/cli', state: 'closed' })))
      .not.toBe(githubScopeKey(parseGithubScope({ repo: 'cli/cli', state: 'open' })))
  })

  it('clamps the page size to the source bound and refuses invalid limits', () => {
    expect(pageLimitOf(undefined)).toBe(GITHUB_DEFAULT_PAGE_LIMIT)
    expect(pageLimitOf(7)).toBe(7)
    expect(pageLimitOf(GITHUB_MAX_PAGE_LIMIT + 400)).toBe(GITHUB_MAX_PAGE_LIMIT)
    for (const limit of [0, -1, 1.5]) {
      expect(categoryOf(() => pageLimitOf(limit)), String(limit)).toBe('invalid-request')
    }
  })
})

describe('opaque pagination cursor', () => {
  const range = {
    sourceId: GITHUB_SOURCE_IDS.issue,
    kind: 'issue' as const,
    repo: 'cli/cli',
    state: 'open' as const,
    query: '',
  }

  it('round-trips the provider cursor and stays opaque', () => {
    const cursor = encodeGithubCursor({ ...range, after: 'Y3Vyc29yOnYyOpK0' })
    expect(cursor).not.toContain('cli/cli')
    expect(cursor).not.toContain('Y3Vyc29yOnYyOpK0')
    expect(decodeGithubCursor(cursor, range)).toBe('Y3Vyc29yOnYyOpK0')
  })

  it('refuses a cursor from another range or query', () => {
    const cursor = encodeGithubCursor({ ...range, after: 'next' })
    expect(categoryOf(() => decodeGithubCursor(cursor, { ...range, repo: 'o/r' }))).toBe('invalid-request')
    expect(categoryOf(() => decodeGithubCursor(cursor, { ...range, state: 'closed' }))).toBe('invalid-request')
    expect(categoryOf(() => decodeGithubCursor(cursor, { ...range, query: 'bug' }))).toBe('invalid-request')
    expect(categoryOf(() => decodeGithubCursor(cursor, { ...range, kind: 'pull' }))).toBe('invalid-request')
  })

  it('refuses a corrupt cursor', () => {
    expect(categoryOf(() => decodeGithubCursor('not-a-cursor', range))).toBe('invalid-request')
    expect(categoryOf(() => decodeGithubCursor('', range))).toBe('invalid-request')
    expect(categoryOf(() => decodeGithubCursor(Buffer.from('{"v":9}').toString('base64url'), range)))
      .toBe('invalid-request')
  })
})

describe('check-before-save revision', () => {
  const base = {
    updatedAt: '2026-10-17T00:00:00Z',
    title: 'title',
    body: 'body',
    state: 'OPEN',
  }

  it('is stable for identical content and changes when anything changes', () => {
    expect(githubRevisionOf(base)).toBe(githubRevisionOf({ ...base }))
    expect(githubRevisionOf({ ...base, updatedAt: '2026-10-17T00:00:01Z' }))
      .not.toBe(githubRevisionOf(base))
    expect(githubRevisionOf({ ...base, title: 'other' })).not.toBe(githubRevisionOf(base))
    expect(githubRevisionOf({ ...base, body: 'other' })).not.toBe(githubRevisionOf(base))
    expect(githubRevisionOf({ ...base, state: 'CLOSED' })).not.toBe(githubRevisionOf(base))
    expect(githubRevisionOf({ ...base, isDraft: true })).not.toBe(githubRevisionOf(base))
    expect(githubRevisionOf({ ...base, merged: true })).not.toBe(githubRevisionOf(base))
  })

  it('starts with an opaque source prefix and never looks like an ETag claim', () => {
    const revision = githubRevisionOf(base)
    expect(revision.startsWith('ghsb1-')).toBe(true)
    expect(revision).not.toContain('ETag')
  })
})
