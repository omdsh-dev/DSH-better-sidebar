/** Discussion stays bounded and safe across source, HTTP and snapshot boundaries. */
import { describe, expect, it } from 'vitest'
import { normalizeClueComment, normalizeClueDiscussion } from '../src/clues/discussion.ts'
const comment = { id: 'one', body: 'text', kind: 'comment', format: 'text/plain' }
const page = { status: 'ok', items: [comment], fetchedAt: '2026-10-24T00:00:00Z', complete: true, coverage: 'document' }
describe('public discussion validation', () => {
  it('copies only known fields and normalizes display instants', () => {
    expect(normalizeClueDiscussion({ ...page, privateToken: 'not copied' })).toEqual({ ...page, fetchedAt: '2026-10-24T00:00:00.000Z' })
    expect(normalizeClueComment({ ...comment, createdAt: '2026-10-24T08:00:00+08:00' }).createdAt).toBe('2026-10-24T00:00:00.000Z')
  })
  it('never calls remaining pages, remaining replies, or unavailable discussions complete', () => {
    expect(normalizeClueDiscussion({ ...page, nextCursor: 'more' }).complete).toBe(false)
    expect(normalizeClueDiscussion({ ...page, items: [{ ...comment, nextRepliesCursor: 'replies' }] }).complete).toBe(false)
    expect(normalizeClueDiscussion({ ...page, status: 'unavailable' }).complete).toBe(false)
  })
  it('rejects duplicate identities, invalid dates and page overflow', () => {
    for (const invalid of [{ ...page, items: [comment, comment] }, { ...page, fetchedAt: 'no date' }, { ...page, items: Array.from({ length: 5_001 }, (_, i) => ({ ...comment, id: String(i) })) }]) {
      expect(() => normalizeClueDiscussion(invalid)).toThrowError(expect.objectContaining({ category: 'invalid-request' }))
    }
  })
  it('refuses executable, credentialed and malformed comment links', () => {
    for (const url of ['javascript:alert(1)', 'https://secret:password@example.com/a', 'bad url']) {
      expect(() => normalizeClueComment({ ...comment, url })).toThrowError(expect.objectContaining({ category: 'invalid-request' }))
    }
  })
  it('keeps the optional future inline anchor without accepting unknown anchor fields', () => {
    expect(normalizeClueComment({ ...comment, anchor: { kind: 'code', quote: 'line', revision: 'r1', locator: { path: 'a.ts', line: 1 }, unsupported: 'ignored' } }).anchor)
      .toEqual({ kind: 'code', quote: 'line', revision: 'r1', locator: { path: 'a.ts', line: 1 } })
  })
})
