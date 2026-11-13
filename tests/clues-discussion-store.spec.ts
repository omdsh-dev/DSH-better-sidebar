/**
 * UI19 discussion snapshots at the STORE seam.
 *
 * The store is the final validator for locally persisted snapshot content, so
 * this spec pins:
 * - `parseClueDiscussion` is the one strict validator shared with share
 *   import/export: it returns a normalized copy, drops unknown keys, and
 *   refuses malformed pages with `invalid-request`;
 * - a captured discussion page round-trips through `putSnapshot` /
 *   `readSnapshotContent` unchanged (after normalization);
 * - a malformed discussion on disk is loud corruption (`failed`), never
 *   silently read;
 * - a legacy snapshot WITHOUT `discussion` stays readable (absence means not
 *   captured, not an empty discussion).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ClueError,
  type ClueDiscussionPage,
  type ClueSnapshotMeta,
} from '../src/clues/types.ts'
import {
  CluesStore,
  MAX_DISCUSSION_PAGE_ITEMS,
  parseClueDiscussion,
  workspaceSnapshotDir,
} from '../src/clues/store.ts'
import { removeTree } from './temp-tree.ts'

const NOW = '2026-10-24T00:00:00.000Z'
const roots: string[] = []

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-clues-discussion-store-'))
  roots.push(path)
  return path
}

afterEach(() => {
  for (const path of roots.splice(0)) removeTree(path)
})

/** One complete, valid discussion page used by the round-trip cases. */
function discussionPage(): ClueDiscussionPage {
  return {
    status: 'ok',
    items: [
      {
        id: 'comment-1',
        kind: 'comment',
        format: 'text/markdown',
        body: 'A comment',
        author: { id: 'user-1', name: 'Ada', handle: 'ada', url: 'https://example.test/ada' },
        createdAt: NOW,
        updatedAt: NOW,
        url: 'https://example.test/comment/1',
        resolved: false,
        replyCount: 1,
        nextRepliesCursor: 'replies-1',
        anchor: {
          kind: 'text',
          quote: 'quoted',
          revision: 'rev-1',
          locator: { path: 'docs/a.md', line: 2 },
        },
      },
      {
        id: 'reply-1',
        kind: 'reply',
        format: 'text/plain',
        body: 'A reply',
        replyToId: 'comment-1',
      },
      {
        id: 'review-1',
        kind: 'review',
        format: 'text/markdown',
        body: 'Reviewed',
        reviewState: 'approved',
      },
    ],
    fetchedAt: NOW,
    nextCursor: 'page-2',
    total: 3,
    complete: false,
    coverage: 'document',
  }
}

/** The fixed failure category of one rejected value. */
function rejectionOf(value: unknown): ClueError {
  try {
    parseClueDiscussion(value)
  } catch (error) {
    return error as ClueError
  }
  throw new Error('expected parseClueDiscussion to reject the value')
}

function meta(snapshotId: string): ClueSnapshotMeta {
  return {
    snapshotId,
    workspaceId: 'ws-1',
    clueId: 'clue-1',
    format: 'text/markdown',
    fetchedAt: NOW,
    createdAt: NOW,
    integrity: 'verified',
  }
}

describe('parseClueDiscussion', () => {
  it('returns a normalized copy and drops unknown extension keys', () => {
    const page = discussionPage()
    const parsed = parseClueDiscussion({
      ...page,
      unknownPageKey: 'ignored',
      items: page.items.map(item => ({ ...item, unknownItemKey: 'ignored' })),
    })
    expect(parsed).toEqual(page)
    expect(parsed).not.toBe(page)
    expect(parsed).not.toHaveProperty('unknownPageKey')
    expect(parsed.items[0]).not.toHaveProperty('unknownItemKey')
  })

  it('normalizes an omitted review body to an empty string', () => {
    const page = parseClueDiscussion({
      status: 'ok',
      items: [{
        id: 'review-2',
        kind: 'review',
        format: 'text/plain',
        reviewState: 'commented',
      }],
      fetchedAt: NOW,
      complete: true,
      coverage: 'document',
    })
    expect(page.items[0]).toEqual({
      id: 'review-2',
      kind: 'review',
      format: 'text/plain',
      body: '',
      reviewState: 'commented',
    })
  })

  it('accepts unavailable and not-captured pages with their error/empty payload', () => {
    expect(parseClueDiscussion({
      status: 'unavailable',
      items: [],
      fetchedAt: NOW,
      complete: false,
      coverage: 'document',
      error: { category: 'permission-denied', message: 'no access' },
    })).toMatchObject({ status: 'unavailable', items: [] })
    expect(parseClueDiscussion({
      status: 'not-captured',
      items: [],
      fetchedAt: NOW,
      complete: false,
      coverage: 'document',
    })).toMatchObject({ status: 'not-captured', items: [] })
  })

  it('refuses malformed pages, comments, anchors and errors', () => {
    const page = discussionPage()
    const item = page.items[0]!
    const malformed: Array<[string, unknown]> = [
      ['not an object', null],
      ['array', []],
      ['unknown status', { ...page, status: 'okay' }],
      ['missing fetchedAt', { ...page, fetchedAt: undefined }],
      ['non-string fetchedAt', { ...page, fetchedAt: 1 }],
      ['non-boolean complete', { ...page, complete: 'yes' }],
      ['unsupported coverage', { ...page, coverage: 'inline' }],
      ['items not an array', { ...page, items: 'comments' }],
      ['too many items', {
        ...page,
        items: Array.from({ length: MAX_DISCUSSION_PAGE_ITEMS + 1 }, (_, index) => ({
          id: `c-${index}`,
          kind: 'comment',
          format: 'text/plain',
          body: 'x',
        })),
      }],
      ['negative total', { ...page, total: -1 }],
      ['fractional total', { ...page, total: 1.5 }],
      ['empty nextCursor', { ...page, nextCursor: '' }],
      ['error not an object', { ...page, error: 'denied' }],
      ['error category outside the fixed vocabulary', {
        ...page,
        error: { category: 'secret-token', message: 'x' },
      }],
      ['missing error message', {
        ...page,
        error: { category: 'failed' },
      }],
      ['item without id', { ...page, items: [{ ...item, id: '' }] }],
      ['item with unknown kind', { ...page, items: [{ ...item, kind: 'note' }] }],
      ['item with unknown format', { ...page, items: [{ ...item, format: 'text/html' }] }],
      ['comment without body', { ...page, items: [{ id: 'c', kind: 'comment', format: 'text/plain' }] }],
      ['reply without body', { ...page, items: [{ id: 'r', kind: 'reply', format: 'text/plain' }] }],
      ['non-string body', { ...page, items: [{ ...item, body: 1 }] }],
      ['bad author', { ...page, items: [{ ...item, author: 'Ada' }] }],
      ['bad replyCount', { ...page, items: [{ ...item, replyCount: -1 }] }],
      ['bad resolved', { ...page, items: [{ ...item, resolved: 'no' }] }],
      ['bad anchor', { ...page, items: [{ ...item, anchor: { kind: 'dom' } }] }],
      ['bad anchor locator', { ...page, items: [{ ...item, anchor: { kind: 'text', locator: 'a.md' } }] }],
      ['empty nextRepliesCursor', { ...page, items: [{ ...item, nextRepliesCursor: '' }] }],
    ]
    for (const [label, value] of malformed) {
      expect(rejectionOf(value).category, label).toBe('invalid-request')
    }
  })

  it('requires fetchedAt in the strict ISO-8601 form', () => {
    const page = discussionPage()
    for (const fetchedAt of [
      'today',
      '',
      '   ',
      '2026-10-24',
      '2026-10-24T00:00:00',
      '2026-10-24 00:00:00Z',
      '2026-02-30T00:00:00.000Z',
      '2026-13-01T00:00:00.000Z',
      '2026-01-01T24:00:00.000Z',
      '2026-01-01T00:00:60.000Z',
      '2026-01-01T00:00:00+14:30',
    ]) {
      expect(rejectionOf({ ...page, fetchedAt }).category, fetchedAt).toBe('invalid-request')
    }
    expect(parseClueDiscussion({ ...page, fetchedAt: '2026-10-24T08:00:00+08:00' }).fetchedAt)
      .toBe('2026-10-24T08:00:00+08:00')
  })

  it('rejects a complete page that still has outstanding work', () => {
    const page = { ...discussionPage(), complete: true, nextCursor: undefined, items: [] }
    const contradictory: Array<[string, unknown]> = [
      ['unavailable status', { ...page, status: 'unavailable' }],
      ['not-captured status', { ...page, status: 'not-captured' }],
      ['error', { ...page, error: { category: 'failed', message: 'outstanding' } }],
      ['nextCursor', { ...page, nextCursor: 'page-2' }],
      ['reply page', {
        ...page,
        items: [{ id: 'c1', kind: 'comment', format: 'text/plain', body: 'x', nextRepliesCursor: 'r1' }],
      }],
    ]
    for (const [label, value] of contradictory) {
      expect(rejectionOf(value).category, label).toBe('invalid-request')
    }
    // The same fields are honest when the page admits it is incomplete.
    expect(parseClueDiscussion({ ...page, complete: false, nextCursor: 'page-2' }))
      .toMatchObject({ complete: false, nextCursor: 'page-2' })
  })

  it('rejects duplicate ids and whitespace-only ids/cursors without rewriting them', () => {
    const page = { ...discussionPage(), complete: false, nextCursor: undefined, items: [] }
    const item = { id: 'c1', kind: 'comment' as const, format: 'text/plain' as const, body: 'x' }
    expect(rejectionOf({ ...page, items: [item, { ...item }] }).category).toBe('invalid-request')
    expect(rejectionOf({ ...page, items: [{ ...item, id: '   ' }] }).category).toBe('invalid-request')
    expect(rejectionOf({ ...page, nextCursor: '   ' }).category).toBe('invalid-request')
    expect(rejectionOf({ ...page, items: [{ ...item, nextRepliesCursor: '   ' }] }).category)
      .toBe('invalid-request')

    const parsed = parseClueDiscussion({
      ...page,
      nextCursor: ' page-2 ',
      items: [{ ...item, id: ' c1 ', nextRepliesCursor: ' replies ' }],
    })
    expect(parsed.nextCursor).toBe(' page-2 ')
    expect(parsed.items[0]!.id).toBe(' c1 ')
    expect(parsed.items[0]!.nextRepliesCursor).toBe(' replies ')
  })

  it('clones anchor locators as bounded JSON and refuses unsafe values', () => {
    const page = { ...discussionPage(), complete: false, nextCursor: undefined, items: [] }
    const locator = { path: 'a.md', nested: { line: 1, tags: ['x'] } }
    const parsed = parseClueDiscussion({
      ...page,
      items: [{
        id: 'c1',
        kind: 'comment',
        format: 'text/plain',
        body: 'x',
        anchor: { kind: 'code', locator },
      }],
    })
    const cloned = parsed.items[0]!.anchor!.locator as {
      path: string
      nested: { line: number; tags: string[] }
    }
    expect(cloned).toEqual(locator)
    expect(cloned).not.toBe(locator)
    expect(cloned.nested).not.toBe(locator.nested)
    expect(cloned.nested.tags).not.toBe(locator.nested.tags)

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const deepRoot: Record<string, unknown> = {}
    let deep = deepRoot
    for (let index = 0; index < 65; index += 1) {
      const next: Record<string, unknown> = {}
      deep.next = next
      deep = next
    }
    const unsafe: Array<[string, unknown]> = [
      ['cycle', cyclic],
      ['deep', deepRoot],
      ['NaN', { value: Number.NaN }],
      ['Infinity', { value: Number.POSITIVE_INFINITY }],
      ['BigInt', { value: 1n }],
      ['function', { value: () => undefined }],
      ['undefined', { value: undefined }],
      ['Date', { value: new Date(NOW) }],
    ]
    for (const [label, value] of unsafe) {
      expect(rejectionOf({
        ...page,
        items: [{
          id: 'c1',
          kind: 'comment',
          format: 'text/plain',
          body: 'x',
          anchor: { kind: 'text', locator: value },
        }],
      }).category, label).toBe('invalid-request')
    }
  })
})

describe('snapshot discussion storage', () => {
  it('round-trips a captured discussion page through content and metadata', async () => {
    const store = new CluesStore({ root: root() })
    const page = discussionPage()
    await store.putSnapshot('ws-1', meta('snap-discussion'), {
      format: 'text/markdown',
      data: { text: 'body' },
      text: 'body',
      discussion: page,
    })
    expect((await store.readSnapshotContent('ws-1', 'snap-discussion')).discussion).toEqual(page)
    expect((await store.readSnapshot('ws-1', 'snap-discussion')).content.discussion).toEqual(page)
  })

  it('keeps a legacy snapshot without discussion readable and leaves it absent', async () => {
    const store = new CluesStore({ root: root() })
    await store.putSnapshot('ws-1', meta('snap-legacy'), {
      format: 'text/plain',
      data: { text: 'legacy' },
      text: 'legacy',
    })
    const content = await store.readSnapshotContent('ws-1', 'snap-legacy')
    expect(content).toMatchObject({ format: 'text/plain', text: 'legacy' })
    expect(content.discussion).toBeUndefined()
  })

  it('reports a malformed persisted discussion as loud corruption', async () => {
    const dir = root()
    const store = new CluesStore({ root: dir })
    const snapshotDir = workspaceSnapshotDir(dir, 'ws-1')
    mkdirSync(snapshotDir, { recursive: true })
    writeFileSync(join(snapshotDir, 'bad.content.json'), JSON.stringify({
      format: 'text/markdown',
      data: { text: 'body' },
      discussion: {
        status: 'ok',
        items: 'not-an-array',
        fetchedAt: NOW,
        complete: true,
        coverage: 'document',
      },
    }), 'utf8')
    await expect(store.readSnapshotContent('ws-1', 'bad')).rejects.toMatchObject({
      category: 'failed',
      message: expect.stringContaining('corrupt'),
    })
  })
})
