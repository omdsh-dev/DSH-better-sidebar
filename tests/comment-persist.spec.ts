// @vitest-environment jsdom
/**
 * Where a Browser tab's comments are kept (Tracy, 28/09/2026, TCH contract H2): `meta.comments` of
 * the tab record is the source; the localStorage mirror under the tab's id is the fallback for a
 * page reload, which drops `meta`. These hold the precedence and the mirror's failure modes; the
 * view-level cases (reload, another page, Interactive and back) are in
 * `tests/tracy-browser-multi-pin.spec.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commentStoreOf, loadViewState, saveViewAddress, saveViewComments, saveViewState } from '../src/client/browser-mode.ts'
import { emptyCommentStore, reduceComments, type CommentStore } from '../src/client/comment-store.ts'
import type { PreviewPickTarget } from '../src/client/preview-protocol.generated.ts'

const HOME = 'http://northgate.tracy.test:8080/'
const target: PreviewPickTarget = { text: 'Services', tag: 'a', image: null, domPath: 'a', selector: 'a', rect: { x: 1, y: 2, width: 3, height: 4 }, marks: [], levels: [], level: 0 }

function twoPins(): CommentStore {
  let s = emptyCommentStore('northgate')
  for (const id of ['a', 'b']) s = reduceComments(s, { type: 'add', id, url: HOME, element: { ...target, selector: `#${id}` }, locate: null, text: `words ${id}`, now: 5 }).store
  return s
}

beforeEach(() => { localStorage.clear() })
afterEach(() => { vi.restoreAllMocks() })

describe('commentStoreOf', () => {
  it('reads the record first', () => {
    const s = commentStoreOf({ comments: twoPins() }, null, 'northgate')
    expect(s.items.map(c => c.id)).toEqual(['a', 'b'])
  })

  it('falls back to the mirror when the record has no comments (a page reload dropped meta)', () => {
    saveViewComments('s1', 'tab', twoPins())
    const s = commentStoreOf({ url: HOME }, loadViewState('s1', 'tab'), 'northgate')
    expect(s.items.map(c => c.id)).toEqual(['a', 'b'])
  })

  it('an empty list in the record beats an older mirror that still has pins', () => {
    saveViewComments('s1', 'tab', twoPins())
    const s = commentStoreOf({ comments: emptyCommentStore('northgate') }, loadViewState('s1', 'tab'), 'northgate')
    expect(s.items).toEqual([])
  })

  it('another site\'s store in the record gives an empty store, not the mirror', () => {
    saveViewComments('s1', 'tab', twoPins())
    const s = commentStoreOf({ comments: { ...twoPins(), siteKey: 'southgate' } }, loadViewState('s1', 'tab'), 'northgate')
    expect(s).toEqual(emptyCommentStore('northgate'))
  })

  it('drops malformed comments with ONE warning line', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = { ...twoPins(), items: [...twoPins().items, { id: 3 }, { id: 'z', n: 'x' }] }
    const s = commentStoreOf({ comments: raw }, null, 'northgate')
    expect(s.items.map(c => c.id)).toEqual(['a', 'b'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('2 kept comment(s)')
  })

  it('nothing kept anywhere: an empty store for this site', () => {
    expect(commentStoreOf(undefined, null, 'northgate')).toEqual(emptyCommentStore('northgate'))
  })
})

describe('the mirror', () => {
  it('keeps comments beside the mode, zoom and address, each write keeping the others', () => {
    saveViewState('s1', 'tab', { mode: 'edit', zoom: 125 })
    saveViewAddress('s1', 'tab', HOME)
    saveViewComments('s1', 'tab', twoPins())
    const kept = loadViewState('s1', 'tab')
    expect(kept).toMatchObject({ mode: 'edit', zoom: 125, url: HOME })
    expect((kept?.comments as CommentStore).items).toHaveLength(2)
    saveViewState('s1', 'tab', { mode: 'interactive', zoom: 100 })
    expect((loadViewState('s1', 'tab')?.comments as CommentStore).items).toHaveLength(2)
  })

  it('a draft a stage-3/4 mirror still holds is never read back (stage 6 has no drafts)', () => {
    const s = twoPins()
    saveViewComments('s1', 'tab', { ...s, items: [...s.items, { ...s.items[0]!, id: 'd', n: 3, status: 'draft' as never }] })
    expect(commentStoreOf({}, loadViewState('s1', 'tab'), 'northgate').items.map(c => c.id)).toEqual(['a', 'b'])
  })

  it('a full storage (quota) does not throw', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })
    expect(() => { saveViewComments('s1', 'tab', twoPins()) }).not.toThrow()
  })
})

describe('persistence v2 (stage 4, H2)', () => {
  it('a v1 store (stage 3) is read and upgraded: target becomes element, v becomes 2, every old status reads open', () => {
    const v1 = { v: 1, siteKey: 'northgate', next: 3, items: [
      { id: 'a', n: 1, url: HOME, target, locate: null, text: 'first', status: 'saved' },
      { id: 'b', n: 2, url: HOME, target, locate: null, text: 'second', status: 'done', requestId: 'r1', sentAt: 1_000, doneAt: 2_000 },
    ] }
    const s = commentStoreOf({ comments: v1 }, null, 'northgate')
    expect(s.v).toBe(2)
    expect(s.items.map(c => [c.id, c.status, c.element?.selector])).toEqual([['a', 'open', 'a'], ['b', 'open', 'a']])
    expect(s.items[1]).not.toHaveProperty('requestId')
    expect(s.items[1]).not.toHaveProperty('target')
  })

  it('an upgraded comment with no createdAt takes its sentAt, else now', () => {
    vi.spyOn(Date, 'now').mockReturnValue(9_999)
    const v1 = { v: 1, siteKey: 'northgate', next: 3, items: [
      { id: 'a', n: 1, url: HOME, target, locate: null, text: 'first', status: 'saved' },
      { id: 'b', n: 2, url: HOME, target, locate: null, text: 'second', status: 'sent', requestId: 'r1', sentAt: 1_000 },
    ] }
    const s = commentStoreOf({ comments: v1 }, null, 'northgate')
    expect(s.items.map(c => c.createdAt)).toEqual([9_999, 1_000])
  })

  it('a v1 store claiming a resolved comment drops that comment (v1 had none)', () => {
    const v1 = { v: 1, siteKey: 'northgate', next: 2, items: [{ id: 'a', n: 1, url: HOME, target, locate: null, text: 'x', status: 'resolved' }] }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(commentStoreOf({ comments: v1 }, null, 'northgate').items).toEqual([])
  })

  it('the mirror writes v2, and a general comment (element null) survives the round trip', () => {
    let s = twoPins()
    s = reduceComments(s, { type: 'addGeneral', id: 'g', url: HOME, text: 'Make the whole page warmer', now: 6 }).store
    saveViewComments('s1', 'tab-1', s)
    const mirrored = loadViewState('s1', 'tab-1')?.comments as { v: number }
    expect(mirrored.v).toBe(2)
    const back = commentStoreOf({}, loadViewState('s1', 'tab-1'), 'northgate')
    expect(back.items.map(c => [c.id, c.element === null])).toEqual([['a', false], ['b', false], ['g', true]])
  })

  it('a resolved comment keeps its resolvedAt; a stage-4 question does not come back', () => {
    const kept = { v: 2, siteKey: 'northgate', next: 2, items: [{ id: 'a', n: 1, url: HOME, element: target, locate: null, text: 'x', status: 'resolved', createdAt: 5, resolvedAt: 12, resolvedFrom: 'asked', question: 'Which heading?' }] }
    const back = commentStoreOf({ comments: kept }, null, 'northgate')
    expect(back.items[0]).toMatchObject({ status: 'resolved', resolvedAt: 12 })
    expect(back.items[0]).not.toHaveProperty('question')
  })

  it('a v1 element null is not a general comment: that comment is dropped', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const v1 = { v: 1, siteKey: 'northgate', next: 2, items: [{ id: 'a', n: 1, url: HOME, target: null, locate: null, text: 'x', status: 'saved' }] }
    expect(commentStoreOf({ comments: v1 }, null, 'northgate').items).toEqual([])
  })
})
