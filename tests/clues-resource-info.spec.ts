/**
 * Public clue resource metadata contract (S1 extension).
 *
 * `ClueResourceInfo` is display-only metadata a source attaches to a
 * candidate/read/edit result and the service persists as a snapshot on the
 * stored clue. These cases pin:
 * - the bounded, safe shape the service accepts from untrusted sources and
 *   from the `clues.ensure` wire payload (unknown fields are dropped, never
 *   stored; malformed values fail as a typed `invalid-request`);
 * - time normalization: ISO instants pass through, while provider numbers are
 *   converted from BOTH documented units (epoch seconds and milliseconds)
 *   without guessing a missing time;
 * - absence is preserved: an unavailable field is never invented (no
 *   `new Date()` fallback, no empty author).
 */
import { describe, expect, it } from 'vitest'
import { ClueError } from '../src/clues/types.ts'
import {
  isoInstantOf,
  normalizeClueResourceInfo,
  normalizeClueSubtitle,
  optionalClueResourceInfo,
  sameClueResourceInfo,
} from '../src/clues/resource-info.ts'

function failureOf(run: () => unknown): ClueError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(ClueError)
    return error as ClueError
  }
  throw new Error('expected a ClueError')
}

describe('ClueResourceInfo validation', () => {
  it('accepts the full public shape and keeps only the contract fields', () => {
    const info = normalizeClueResourceInfo({
      state: 'draft',
      number: 14727,
      repository: 'cli/cli',
      author: { id: 'u1', name: 'Octo Cat', handle: 'octocat', url: 'https://github.com/octocat' },
      assignees: [{ handle: 'ada' }],
      followers: [{ id: 'u2' }],
      labels: ['bug', 'release'],
      createdAt: '2026-10-17T00:00:00Z',
      updatedAt: '2026-10-17T01:00:00.000Z',
      completedAt: '2026-10-17T02:00:00Z',
      start: { at: '2026-10-18T09:00:00Z', allDay: true },
      due: { at: '2026-10-19T09:00:00Z' },
      branches: {
        head: 'feat/x',
        base: 'trunk',
        headRepository: 'fork/cli',
        baseRepository: 'cli/cli',
      },
      counts: { comments: 3, commits: 12, changedFiles: 4, additions: 40, deletions: 2 },
      sizeBytes: 1234,
      path: 'docs/readme.md',
      // Unknown extension keys are not part of the persisted snapshot.
      internalToken: 'secret',
    })
    expect(info).toEqual({
      state: 'draft',
      number: 14727,
      repository: 'cli/cli',
      author: { id: 'u1', name: 'Octo Cat', handle: 'octocat', url: 'https://github.com/octocat' },
      assignees: [{ handle: 'ada' }],
      followers: [{ id: 'u2' }],
      labels: ['bug', 'release'],
      createdAt: '2026-10-17T00:00:00.000Z',
      updatedAt: '2026-10-17T01:00:00.000Z',
      completedAt: '2026-10-17T02:00:00.000Z',
      start: { at: '2026-10-18T09:00:00.000Z', allDay: true },
      due: { at: '2026-10-19T09:00:00.000Z' },
      branches: {
        head: 'feat/x',
        base: 'trunk',
        headRepository: 'fork/cli',
        baseRepository: 'cli/cli',
      },
      counts: { comments: 3, commits: 12, changedFiles: 4, additions: 40, deletions: 2 },
      sizeBytes: 1234,
      path: 'docs/readme.md',
    })
    expect(optionalClueResourceInfo(undefined)).toBeUndefined()
    expect(optionalClueResourceInfo(info)).toEqual(info)
  })

  it('preserves absence instead of inventing people, times or counts', () => {
    expect(normalizeClueResourceInfo({ state: 'active' })).toEqual({ state: 'active' })
    expect(normalizeClueResourceInfo({ labels: [] })).toEqual({ labels: [] })
    expect(normalizeClueResourceInfo({})).toEqual({})
  })

  it('rejects malformed values with a typed invalid-request', () => {
    const cases: unknown[] = [
      null,
      [],
      'info',
      { state: 'done' },
      { number: 0 },
      { number: 1.5 },
      { repository: '' },
      { author: {} },
      { author: { url: 'javascript:alert(1)' } },
      { author: { handle: 'x'.repeat(500) } },
      { assignees: {} },
      { labels: 'bug' },
      { labels: [''] },
      { labels: ['bug', 'bug'] },
      { createdAt: 'not-a-date' },
      { start: { at: 'not-a-date' } },
      { counts: { comments: -1 } },
      { counts: { changedFiles: 1.5 } },
      { sizeBytes: -1 },
      { path: 'bad\u0000path' },
    ]
    for (const value of cases) {
      const failure = failureOf(() => normalizeClueResourceInfo(value))
      expect(failure.category, JSON.stringify(value)).toBe('invalid-request')
    }
  })

  it('bounds repeated metadata so one source cannot persist an unbounded snapshot', () => {
    const people = Array.from({ length: 51 }, (_, index) => ({ handle: `u${index}` }))
    expect(failureOf(() => normalizeClueResourceInfo({ assignees: people })).category)
      .toBe('invalid-request')
    const labels = Array.from({ length: 101 }, (_, index) => `label-${index}`)
    expect(failureOf(() => normalizeClueResourceInfo({ labels })).category)
      .toBe('invalid-request')
  })

  it('treats two normalized snapshots as equal regardless of key order', () => {
    const a = normalizeClueResourceInfo({
      repository: 'cli/cli',
      number: 1,
      labels: ['bug'],
      counts: { comments: 2, additions: 3 },
    })
    const b = normalizeClueResourceInfo({
      counts: { additions: 3, comments: 2 },
      labels: ['bug'],
      number: 1,
      repository: 'cli/cli',
    })
    expect(sameClueResourceInfo(a, b)).toBe(true)
    expect(sameClueResourceInfo(a, normalizeClueResourceInfo({ number: 1 }))).toBe(false)
    expect(sameClueResourceInfo(undefined, undefined)).toBe(true)
    expect(sameClueResourceInfo(undefined, a)).toBe(false)
  })
})

describe('time normalization', () => {
  it('converts epoch milliseconds and seconds to ISO without guessing a unit', () => {
    // Both spellings name the same instant (2023-11-14T22:13:20.000Z).
    expect(isoInstantOf('1700000000', 's')).toBe('2023-11-14T22:13:20.000Z')
    expect(isoInstantOf('1700000000000', 'ms')).toBe('2023-11-14T22:13:20.000Z')
    expect(isoInstantOf(1700000000, 'auto')).toBe('2023-11-14T22:13:20.000Z')
    expect(isoInstantOf(1700000000000, 'auto')).toBe('2023-11-14T22:13:20.000Z')
    expect(isoInstantOf('2026-10-17T00:00:00Z')).toBe('2026-10-17T00:00:00.000Z')
    expect(isoInstantOf(undefined)).toBeUndefined()
    expect(isoInstantOf('')).toBeUndefined()
    expect(isoInstantOf('not-a-date')).toBeUndefined()
    expect(isoInstantOf(Number.NaN)).toBeUndefined()
    expect(isoInstantOf(undefined, 's')).toBeUndefined()
  })

  it('does not turn an absent time into "now"', () => {
    expect(normalizeClueResourceInfo({ createdAt: undefined })).toEqual({})
    expect(isoInstantOf(null)).toBeUndefined()
  })
})

describe('subtitle normalization', () => {
  it('keeps a bounded display string and treats absence as absence', () => {
    expect(normalizeClueSubtitle(undefined)).toBeUndefined()
    expect(normalizeClueSubtitle('  Pull request  ')).toBe('Pull request')
    expect(failureOf(() => normalizeClueSubtitle(7)).category).toBe('invalid-request')
    expect(failureOf(() => normalizeClueSubtitle('x'.repeat(501))).category).toBe('invalid-request')
    expect(failureOf(() => normalizeClueSubtitle('bad\u0000subtitle')).category).toBe('invalid-request')
  })
})


describe('change-request facts', () => {
  it('keeps review, mergeability and checks through the whitelist', () => {
    const info = normalizeClueResourceInfo({
      state: 'open', number: 1147, repository: 'omdsh-dev/DSH-better-sidebar',
      review: 'approved', mergeable: 'conflicting', checks: 'failure',
    })
    expect(info.review).toBe('approved')
    expect(info.mergeable).toBe('conflicting')
    expect(info.checks).toBe('failure')
  })

  it('rejects unknown values instead of silently dropping them', () => {
    expect(failureOf(() => normalizeClueResourceInfo({ review: 'lgtm' })).category).toBe('invalid-request')
    expect(failureOf(() => normalizeClueResourceInfo({ mergeable: 'dirty' })).category).toBe('invalid-request')
    expect(failureOf(() => normalizeClueResourceInfo({ checks: 'green' })).category).toBe('invalid-request')
  })

  it('omits the facts when the provider did not report them', () => {
    const info = normalizeClueResourceInfo({ state: 'open', number: 1 })
    expect('review' in info).toBe(false)
    expect('mergeable' in info).toBe(false)
    expect('checks' in info).toBe(false)
  })
})
