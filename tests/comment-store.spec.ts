/**
 * The comments of a Browser tab, people to people (Tracy, 29/09/2026; TCH `tasks/todo-comment-people.md`
 * rules 1–4, 9, 12; contract `tasks/evidence/comment-people/contract.md` H2). The pure store: what each
 * action does, what the page is told to track, what the chat column is told, and what one send to
 * Tracy carries.
 */
import { describe, expect, it } from 'vitest'
import {
  COMMENT_ACT_KINDS,
  actIsFor,
  authorColor,
  authorColours,
  authorLabels,
  commentListDetail,
  commentSendDetailV3,
  emptyCommentStore,
  neverSentOf,
  openCount,
  pageCommentsOf,
  pageOpenCount,
  readCommentAct,
  readTrackReport,
  readTurnEvent,
  reduceComments,
  threadEntriesOf,
  threadMessagesOf,
  trackItemsOf,
  withPickItem,
  type Comment,
  type CommentAction,
  type CommentStore,
  type TrackItem,
} from '../src/client/comment-store.ts'
import type { PreviewPickTarget } from '../src/client/preview-protocol.generated.ts'

const HOME = 'http://northgate.tracy.test/'
const ABOUT = 'http://northgate.tracy.test/about'
const LEE = { accountId: 'a1', email: 'lee@example.com', name: 'Lee', initial: 'L' }
const MAI = { accountId: 'a2', email: 'mai@example.com', name: 'Mai', initial: 'M' }
const el = (selector: string, text = 'Welcome'): PreviewPickTarget => ({ text, tag: 'h1', image: null, domPath: selector, selector, rect: { x: 1, y: 2, width: 3, height: 4 }, marks: [], levels: [], level: 0 })

function run(actions: CommentAction[], start: CommentStore = emptyCommentStore('northgate')): CommentStore {
  let store = start
  for (const action of actions) {
    const step = reduceComments(store, action)
    expect(step.refused, JSON.stringify(action)).toBeNull()
    store = step.store
  }
  return store
}

/** A row as the server answered for it (author and rights set). */
function row(over: Partial<Comment> & { id: string; n: number }): Comment {
  return { url: HOME, element: el(`#${over.id}`), locate: null, text: `words ${over.id}`, status: 'open', createdAt: over.n, author: LEE, can: { edit: true, delete: true }, ...over }
}

describe('a comment is open or resolved, nothing else (rule 2)', () => {
  it('Add comment keeps it open; there is no cap of twelve any more', () => {
    const actions: CommentAction[] = Array.from({ length: 14 }, (_, i) => ({ type: 'add', id: `c${String(i)}`, url: HOME, element: el(`#e${String(i)}`), locate: null, text: `w${String(i)}`, now: i }))
    const store = run(actions)
    expect(store.items).toHaveLength(14)
    expect(new Set(store.items.map(c => c.status))).toEqual(new Set(['open']))
  })

  it('empty words are never a comment', () => {
    expect(reduceComments(emptyCommentStore('northgate'), { type: 'add', id: 'x', url: HOME, element: el('#x'), locate: null, text: '  ' }).refused).toBe('empty')
  })

  it('anyone may resolve a comment, another person\'s included (rule 3); it keeps who and when', () => {
    const start = { ...emptyCommentStore('northgate'), items: [row({ id: 'm1', n: 1, author: MAI, can: { edit: false, delete: false } })] }
    const store = run([{ type: 'resolve', id: 'm1', now: 50, by: LEE }], start)
    expect(store.items[0]).toMatchObject({ status: 'resolved', resolvedAt: 50, resolvedBy: LEE })
  })

  it('a reply opens a resolved thread again — there is no Reopen', () => {
    const start = { ...emptyCommentStore('northgate'), items: [row({ id: 'p', n: 1, status: 'resolved', resolvedAt: 9, resolvedBy: MAI })] }
    const store = run([{ type: 'reply', id: 'r', parentId: 'p', text: 'Still wrong', now: 20 }], start)
    expect(store.items.find(c => c.id === 'p')).toMatchObject({ status: 'open' })
    expect(store.items.find(c => c.id === 'p')).not.toHaveProperty('resolvedBy')
    expect(store.items.find(c => c.id === 'r')).toMatchObject({ replyTo: 'p', url: HOME, status: 'open' })
    expect(COMMENT_ACT_KINDS).not.toContain('reopen')
  })
})

describe('Delete all (rule 12; Brian 23:20: resolved ones too): every comment on the page, everyone\'s, with their replies', () => {
  const start = (): CommentStore => ({ ...emptyCommentStore('northgate'), items: [
    row({ id: 'mine', n: 1 }),
    row({ id: 'hers', n: 2, author: MAI, can: { edit: false, delete: false } }),
    row({ id: 'done', n: 3, status: 'resolved', resolvedAt: 4 }),
    row({ id: 'elsewhere', n: 4, url: ABOUT }),
    row({ id: 'reply', n: 5, replyTo: 'done', author: MAI, can: { edit: false, delete: false } }),
  ] })

  it('removes every comment of that page, open and resolved, another person\'s too, with their replies; other pages stay', () => {
    const store = run([{ type: 'clear', url: HOME }], start())
    expect(store.items.map(c => c.id)).toEqual(['elsewhere'])
  })

  it('with ids (the view\'s Undo window), only those threads — a resolved one with its reply included', () => {
    expect(run([{ type: 'clear', url: HOME, ids: ['hers'] }], start()).items.map(c => c.id)).toEqual(['mine', 'done', 'elsewhere', 'reply'])
    expect(run([{ type: 'clear', url: HOME, ids: ['done'] }], start()).items.map(c => c.id)).toEqual(['mine', 'hers', 'elsewhere'])
  })

  it('with ids from All pages (UI fine-tune 30/09), the named threads on ANY page go, and nothing not named', () => {
    expect(run([{ type: 'clear', url: HOME, ids: ['mine', 'elsewhere'] }], start()).items.map(c => c.id)).toEqual(['hers', 'done', 'reply'])
  })
})

describe('what counts', () => {
  const items: Comment[] = [
    row({ id: 'a', n: 1 }),
    row({ id: 'b', n: 2, author: MAI, can: { edit: false, delete: false }, sentToTracy: true }),
    row({ id: 'r', n: 3, replyTo: 'a' }),
    row({ id: 'c', n: 4, url: ABOUT, element: null }),
    row({ id: 'z', n: 5, status: 'resolved', resolvedAt: 1 }),
  ]

  it('"Comments N" = every open thread on the SITE, all authors, every page; replies and resolved ones not (rule 9)', () => {
    expect(openCount(items)).toBe(3)
    expect(openCount([])).toBe(0)
  })

  it('"Comments N" since the UI fine-tune (U16) = open threads of the PAGE shown; a #hash or a trailing slash is the same page, /ru/ is not /', () => {
    const more = [...items, row({ id: 'ru', n: 9, url: 'http://northgate.tracy.test/ru/' })]
    expect(pageOpenCount(more, HOME)).toBe(pageCommentsOf({ ...emptyCommentStore('northgate'), items: more }, HOME).length)
    expect(pageOpenCount(more, 'http://northgate.tracy.test/#team')).toBe(pageOpenCount(more, HOME))
    expect(pageOpenCount(more, 'http://northgate.tracy.test/ru')).toBe(1)
    expect(pageOpenCount(more, ABOUT)).toBe(openCount(more.filter(c => c.url === ABOUT)))
    expect(pageOpenCount(more, null)).toBe(0)
  })

  it('"Send N" = open threads never sent to Tracy, anyone\'s, in number order (rule 1)', () => {
    expect(neverSentOf(items).map(c => c.id)).toEqual(['a', 'c'])
  })

  it('a page\'s pins: its open threads about an element (no reply, no whole-page comment, no resolved one)', () => {
    const store = { ...emptyCommentStore('northgate'), items }
    expect(pageCommentsOf(store, HOME).map(c => c.id)).toEqual(['a', 'b'])
  })
})

describe('what the page is told to outline: never a status colour (rule 5)', () => {
  it('open comments are `pending` (or `saved` on a page older than runtime 7), the one being edited `active`', () => {
    const store = { ...emptyCommentStore('northgate'), items: [row({ id: 'a', n: 1 }), row({ id: 'b', n: 2, sentToTracy: true })] }
    expect(trackItemsOf(store, HOME, 'b').map(i => [i.id, i.state])).toEqual([['a', 'pending'], ['b', 'active']])
    expect(trackItemsOf(store, HOME, null, null, 'saved').map(i => i.state)).toEqual(['saved', 'saved'])
  })

  it('a comment already sent to Tracy is held by its selector alone: Tracy is expected to change its words (F4)', () => {
    // Stage 6 acceptance F4: the card was open while Tracy rewrote the heading it was about; after the
    // page reloaded the words no longer matched, the page reported the element `changed`, and the pin
    // went and the card fell to the frame's top. Runtime `locate` (`@tracy/cms-preview` pick.mjs) checks
    // the words of a `pending` item unless they are empty, when the selector (and its tag) holds it.
    const store = { ...emptyCommentStore('northgate'), items: [row({ id: 'a', n: 1 }), row({ id: 'b', n: 2, sentToTracy: true })] }
    expect(trackItemsOf(store, HOME, null).map(i => [i.id, i.text, i.state])).toEqual([['a', 'Welcome', 'pending'], ['b', '', 'pending']])
    expect(trackItemsOf(store, HOME, 'b').map(i => [i.id, i.text, i.state])).toEqual([['a', 'Welcome', 'pending'], ['b', '', 'active']])
  })

  it('a resolved comment being revealed is tracked for the reveal only', () => {
    const store = { ...emptyCommentStore('northgate'), items: [row({ id: 'z', n: 1, status: 'resolved', resolvedAt: 1 })] }
    expect(trackItemsOf(store, HOME, null)).toEqual([])
    expect(trackItemsOf(store, HOME, null, 'z').map(i => [i.id, i.state])).toEqual([['z', 'pending']])
  })
})

describe('tracy:comment-list (H2): people rows, no status word', () => {
  it('carries replyCount and sentToTracy; a resolved row its resolvedAt/resolvedBy; no status, no question, no answer', () => {
    const store = { ...emptyCommentStore('northgate'), items: [
      row({ id: 'a', n: 1, sentToTracy: true }),
      row({ id: 'r1', n: 2, replyTo: 'a', author: MAI }),
      row({ id: 'r2', n: 3, replyTo: 'a' }),
      row({ id: 'z', n: 4, status: 'resolved', resolvedAt: 7, resolvedBy: MAI }),
    ] }
    const detail = commentListDetail({ sessionId: 's1', tabId: 't1', siteKey: 'northgate', host: 'northgate.tracy.test', active: true, url: HOME, store })
    expect(detail.comments.map(c => [c.id, c.replyCount, c.sentToTracy])).toEqual([['a', 2, true], ['r1', 0, false], ['r2', 0, false], ['z', 0, false]])
    expect(detail.comments[3]).toMatchObject({ resolved: true, resolvedAt: 7, resolvedBy: MAI })
    expect(detail.comments[0]).toMatchObject({ resolved: false })
    expect(detail.comments[0]).not.toHaveProperty('resolvedAt')
    for (const c of detail.comments) for (const key of ['status', 'question', 'answer', 'settledBy', 'sentAt']) expect(c).not.toHaveProperty(key)
  })
})

describe('tracy:comment-act (H2)', () => {
  it('knows resolve · remove · reveal · clear · send · edit · reply · add · list — and refuses the stage-5 ones', () => {
    for (const kind of ['resolve', 'remove', 'reveal', 'clear', 'send', 'edit', 'reply', 'add', 'list']) expect(readCommentAct({ tabId: 't1', kind })).not.toBeNull()
    for (const kind of ['reopen', 'resolve-done']) expect(readCommentAct({ tabId: 't1', kind })).toBeNull()
  })

  it('send carries ticked ids, or the page box\'s words with page: true', () => {
    expect(readCommentAct({ tabId: 't1', kind: 'send', ids: ['a', 'b'] })).toEqual({ tabId: 't1', kind: 'send', ids: ['a', 'b'] })
    expect(readCommentAct({ tabId: 't1', kind: 'send', page: true, text: 'Warmer colours' })).toEqual({ tabId: 't1', kind: 'send', page: true, text: 'Warmer colours' })
    expect(readCommentAct({ tabId: 't1', kind: 'send', page: 'yes', text: 'x' })).toEqual({ tabId: 't1', kind: 'send', text: 'x' })
    const shown = { tabId: 't1', sessionId: 's1', shown: true }
    expect(actIsFor({ tabId: '', kind: 'list' }, shown)).toBe(true)
    expect(actIsFor({ tabId: 'other', kind: 'send' }, shown)).toBe(false)
  })

  it('round 6: tabId AND sessionId decide; an act without sessionId (older sender) goes to the tab of the conversation on screen only', () => {
    const shown = { tabId: 't1', sessionId: 's1', shown: true }
    const left = { tabId: 't1', sessionId: 's2', shown: false }
    expect(actIsFor({ tabId: 't1', kind: 'send' }, shown)).toBe(true)
    // dsh mints tab ids per conversation: the tab of the conversation left can hold the same id.
    expect(actIsFor({ tabId: 't1', kind: 'send' }, left)).toBe(false)
    expect(actIsFor({ tabId: '', kind: 'list' }, left)).toBe(false)
    expect(actIsFor({ tabId: 't1', kind: 'send', sessionId: 's2' }, shown)).toBe(false)
    expect(actIsFor({ tabId: 't1', kind: 'send', sessionId: 's1' }, shown)).toBe(true)
    // With `sessionId` (chat-input round 6) the pair decides: tabId AND sessionId, one tab only.
    expect(actIsFor({ tabId: 't1', kind: 'send', sessionId: 's2' }, left)).toBe(true)
    expect(actIsFor({ tabId: 't2', kind: 'send', sessionId: 's2' }, left)).toBe(false)
    expect(actIsFor({ tabId: '', kind: 'list', sessionId: 's1' }, shown)).toBe(true)
    expect(actIsFor({ tabId: '', kind: 'list', sessionId: 's1' }, left)).toBe(false)
    expect(actIsFor({ tabId: 't1', kind: 'send' }, { tabId: undefined, sessionId: 's1', shown: true })).toBe(false)
    expect(readCommentAct({ tabId: 't1', kind: 'send', sessionId: 's2', ids: ['a'] })).toEqual({ tabId: 't1', kind: 'send', sessionId: 's2', ids: ['a'] })
    expect(readCommentAct({ tabId: 't1', kind: 'send', sessionId: 7 })).toBeNull()
  })
})

describe('one send to Tracy (tracy:comment-send v3)', () => {
  const items: Comment[] = [
    row({ id: 'p', n: 1, author: MAI, text: 'We have 14 subsidiaries now.', createdAt: 100 }),
    row({ id: 'r', n: 2, replyTo: 'p', author: LEE, text: 'The About page says 13 as well.', createdAt: 200 }),
  ]

  it('a thread in time order; from a thread card the whole thread, from a comment its replies', () => {
    expect(threadMessagesOf(items, 'r').map(c => c.id)).toEqual(['p', 'r'])
    expect(threadEntriesOf(items, 'p', true)).toEqual([
      { author: { name: 'Mai', email: 'mai@example.com' }, at: 100, text: 'We have 14 subsidiaries now.' },
      { author: { name: 'Lee', email: 'lee@example.com' }, at: 200, text: 'The About page says 13 as well.' },
    ])
    expect(threadEntriesOf(items, 'p', false).map(e => e.author.name)).toEqual(['Lee'])
  })

  it('earlier sends of the thread, when the server lists them, are {author, at, sent: true} lines in time order', () => {
    const sent = [{ ...items[0]!, sends: [{ author: LEE, at: 150 }] }, items[1]!]
    expect(threadEntriesOf(sent, 'p', true)).toEqual([
      { author: { name: 'Mai', email: 'mai@example.com' }, at: 100, text: 'We have 14 subsidiaries now.' },
      { author: { name: 'Lee', email: 'lee@example.com' }, at: 150, sent: true },
      { author: { name: 'Lee', email: 'lee@example.com' }, at: 200, text: 'The About page says 13 as well.' },
    ])
  })

  it('ONE message, each item numbered by the server, the comment it came from named; fresh words name none', () => {
    const detail = commentSendDetailV3({
      sessionId: 's1',
      requestId: 'q1',
      siteKey: 'northgate',
      numbers: [41, 42],
      items: [
        { url: HOME, element: null, wireElement: null, locate: null, text: ' Make it orange ' },
        { url: HOME, element: null, wireElement: null, locate: null, text: 'Update it on both pages, please.', commentId: 'p', author: MAI, thread: threadEntriesOf(items, 'p', true) },
      ],
    })
    expect(detail).toMatchObject({ v: 3, sessionId: 's1', requestId: 'q1', siteKey: 'northgate' })
    expect(detail.items[0]).toEqual({ n: 41, url: HOME, element: null, locate: null, text: 'Make it orange' })
    expect(detail.items[1]).toMatchObject({ n: 42, commentId: 'p', author: MAI, text: 'Update it on both pages, please.' })
    expect(detail.items[1]!.thread).toHaveLength(2)
  })

  it('an item from a comment carries the comment\'s time (`at`, ms) so the chat chip can say it; fresh words carry none', () => {
    const detail = commentSendDetailV3({
      sessionId: 's1',
      requestId: 'q1',
      siteKey: 'northgate',
      numbers: [41, 42],
      items: [
        { url: HOME, element: null, wireElement: null, locate: null, text: 'Make it orange' },
        { url: HOME, element: null, wireElement: null, locate: null, text: 'Both pages.', commentId: 'p', author: MAI, at: 1_790_000_100_000 },
      ],
    })
    expect(detail.items[0]).not.toHaveProperty('at')
    expect(detail.items[1]).toMatchObject({ commentId: 'p', at: 1_790_000_100_000 })
  })
})

describe('the chat\'s turn events (H2)', () => {
  it('reads sessionId, requestId and siteKey; refuses a detail without a session', () => {
    expect(readTurnEvent({ sessionId: 's1', requestId: 'q1', siteKey: 'northgate' })).toEqual({ sessionId: 's1', requestId: 'q1', siteKey: 'northgate' })
    expect(readTurnEvent({ requestId: 'q1' })).toBeNull()
    expect(readTurnEvent(null)).toBeNull()
  })
})

describe('withPickItem: a pick the page no longer draws itself, tracked as the active outline (round 4, L06)', () => {
  const item = (id: string): TrackItem => ({ id, selector: `#${id}`, text: id, state: 'pending' })
  it('adds the pick first as `pick:<id>`, active, with its selector and words', () => {
    expect(withPickItem([item('a')], { id: 7, selector: 'main > h1', text: 'Welcome' })).toEqual([
      { id: 'pick:7', selector: 'main > h1', text: 'Welcome', state: 'active' },
      item('a'),
    ])
  })
  it('no pick: the set unchanged', () => {
    expect(withPickItem([item('a')], null)).toEqual([item('a')])
  })
  it('never more than the page takes: the newest comments give way, the pick stays', () => {
    const full = Array.from({ length: 12 }, (_, i) => item(`c${String(i)}`))
    const out = withPickItem(full, { id: 1, selector: 'p', text: '' }, 12)
    expect(out).toHaveLength(12)
    expect(out[0]!.id).toBe('pick:1')
  })
  it('a pick the page would refuse (a selector over the limit) is left out rather than spoil the set', () => {
    expect(withPickItem([item('a')], { id: 1, selector: 'x'.repeat(600), text: '' })).toEqual([item('a')])
  })
})

describe('round 5: a deleted first message with live replies stays a thread (acceptance v3 TH-4)', () => {
  const tomb = row({ id: 'x', n: 1, text: '', removed: true, author: LEE, can: { edit: false, delete: false } })
  const reply = row({ id: 'r', n: 2, replyTo: 'x', author: MAI, can: { edit: false, delete: false } })
  const store = { ...emptyCommentStore('northgate'), items: [tomb, reply] }

  it('counts on the toolbar, has a pin, is tracked on the page, and is listed with its replies', () => {
    expect(openCount(store.items)).toBe(1)
    expect(pageCommentsOf(store, HOME).map(c => c.id)).toEqual(['x'])
    expect(trackItemsOf(store, HOME, null).map(i => i.id)).toEqual(['x'])
    const detail = commentListDetail({ sessionId: 's1', tabId: 't1', siteKey: 'northgate', host: null, active: true, url: HOME, store })
    expect(detail.comments.map(c => [c.id, c.removed === true, c.replyCount])).toEqual([['x', true, 1], ['r', false, 0]])
  })

  it('anyone may still reply under it and resolve it (the server allows both on a tombstone)', () => {
    const replied = run([{ type: 'reply', id: 'r2', parentId: 'x', text: 'Still wanted', now: 9 }], store)
    expect(replied.items.find(c => c.id === 'r2')?.replyTo).toBe('x')
    const resolved = run([{ type: 'resolve', id: 'x', now: 10 }], store)
    expect(resolved.items.find(c => c.id === 'x')?.status).toBe('resolved')
    expect(openCount(resolved.items)).toBe(0)
  })

  it('Delete all takes the tombstone thread with its replies', () => {
    expect(run([{ type: 'clear', url: HOME }], store).items).toEqual([])
  })

  it('without a live reply there is no tombstone', () => {
    const lone = { ...emptyCommentStore('northgate'), items: [tomb] }
    expect(openCount(lone.items)).toBe(0)
    expect(run([{ type: 'remove', id: 'r' }], store).items).toEqual([])
  })
})

describe('round 5: two people with the same name (acceptance v3 TH-6)', () => {
  const SAM_A = { accountId: 'a3', email: 'e2e3-thread-a@example.test', name: 'Sam Tester', initial: 'S' }
  const SAM_B = { accountId: 'a4', email: 'e2e3-thread-b@example.test', name: 'sam  tester', initial: 'S' }

  it('a name shared by two accounts reads "Name (email before @)"; a unique name stays as it is', () => {
    const items = [row({ id: 'a', n: 1, author: SAM_A }), row({ id: 'b', n: 2, author: SAM_B }), row({ id: 'c', n: 3, author: MAI }), row({ id: 'd', n: 4, status: 'resolved', resolvedAt: 1, resolvedBy: SAM_B, author: LEE })]
    const label = authorLabels(items)
    expect(label(SAM_A)).toBe('Sam Tester (e2e3-thread-a)')
    expect(label(SAM_B)).toBe('sam  tester (e2e3-thread-b)')
    expect(label(MAI)).toBe('Mai')
    expect(label(LEE)).toBe('Lee')
    expect(label(undefined)).toBe('')
  })

  it('the same account twice is one person, not a clash', () => {
    const label = authorLabels([row({ id: 'a', n: 1, author: SAM_A }), row({ id: 'b', n: 2, author: { ...SAM_A } })])
    expect(label(SAM_A)).toBe('Sam Tester')
  })

  it('a bubble\'s colour follows the ACCOUNT, so two Sams differ and one person keeps a colour when renamed', () => {
    expect(authorColor(SAM_A)).toBe(authorColor({ ...SAM_A, name: 'Samuel' }))
    const colours = new Set(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map(accountId => authorColor({ accountId, email: 'x@y', initial: 'X' })))
    expect(colours.size).toBeGreaterThan(1)
    expect(authorColor(SAM_A)).not.toBe(authorColor(SAM_B))
    // No account (a comment not answered by the server yet): its name, as before.
    expect(authorColor(undefined)).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('the list tells the Comments tab each author\'s colour, so its avatar matches the page\'s bubble', () => {
    const store = { ...emptyCommentStore('northgate'), items: [row({ id: 'a', n: 1, author: SAM_A })] }
    const detail = commentListDetail({ sessionId: 's1', tabId: 't1', siteKey: 'northgate', host: null, active: true, url: HOME, store })
    expect(detail.comments[0]!.author).toEqual({ ...SAM_A, color: authorColor(SAM_A) })
  })
})

describe('UI fine-tune round 2 (e2e L1, U3): two people of one name never share a colour', () => {
  // Two accounts whose hashes land on the same colour (FNV-1a mod 8: both #db2777).
  const SAM_A = { accountId: 'acct-5', email: 'pick-a@example.test', name: 'Sam Tester', initial: 'S' }
  const SAM_B = { accountId: 'acct-16', email: 'pick-b@example.test', name: 'Sam  tester', initial: 'S' }
  const OTHER = { accountId: 'acct-23', email: 'other@example.test', name: 'Other', initial: 'O' }

  it('the hashes do collide (the case the rule is for)', () => {
    expect(authorColor(SAM_A)).toBe(authorColor(SAM_B))
  })

  it('the later namesake takes the next free colour; the first keeps its own; stable for the same comments', () => {
    const items = [row({ id: 'a', n: 1, author: SAM_A }), row({ id: 'b', n: 2, author: SAM_B }), row({ id: 'c', n: 3, author: OTHER })]
    const colour = authorColours(items)
    expect(colour(SAM_A)).toBe(authorColor(SAM_A))
    expect(colour(SAM_B)).not.toBe(colour(SAM_A))
    // A different name keeps its colour, even the same one.
    expect(colour(OTHER)).toBe(authorColor(OTHER))
    // The order of the list does not matter: number order does.
    expect(authorColours(items.slice().reverse())(SAM_B)).toBe(colour(SAM_B))
  })

  it('one person twice is not a clash, and a person with no namesake keeps the plain hash', () => {
    const colour = authorColours([row({ id: 'a', n: 1, author: SAM_A }), row({ id: 'b', n: 2, author: { ...SAM_A } })])
    expect(colour(SAM_A)).toBe(authorColor(SAM_A))
    expect(colour(undefined)).toBe(authorColor(undefined))
  })

  it('the list gives the Comments tab the same resolved colours as the pins', () => {
    const store = { ...emptyCommentStore('northgate'), items: [row({ id: 'a', n: 1, author: SAM_A }), row({ id: 'b', n: 2, author: SAM_B })] }
    const detail = commentListDetail({ sessionId: 's1', tabId: 't1', siteKey: 'northgate', host: null, active: true, url: HOME, store })
    const colour = authorColours(store.items)
    expect(detail.comments.map(c => c.author?.color)).toEqual([colour(SAM_A), colour(SAM_B)])
    expect(detail.comments[0]!.author?.color).not.toBe(detail.comments[1]!.author?.color)
  })
})

describe('round 5: the Comments view\'s Delete all window (acceptance v3 TH-7)', () => {
  it('hide and show name the comments the view took off for its Undo window', () => {
    expect(COMMENT_ACT_KINDS).toEqual(expect.arrayContaining(['hide', 'show']))
    expect(readCommentAct({ tabId: 't1', kind: 'hide', ids: ['a', 'b'] })).toEqual({ tabId: 't1', kind: 'hide', ids: ['a', 'b'] })
    expect(readCommentAct({ tabId: 't1', kind: 'show', ids: ['a'] })).toEqual({ tabId: 't1', kind: 'show', ids: ['a'] })
  })
})

describe('round 5: a comment whose words Tracy changed is held by its selector (acceptance v3 TH-11)', () => {
  it('ids in `loose` go out with empty words, as a comment sent to Tracy does', () => {
    const store = { ...emptyCommentStore('northgate'), items: [row({ id: 'a', n: 1 }), row({ id: 'b', n: 2 })] }
    expect(trackItemsOf(store, HOME, null, null, 'pending', new Set(['b'])).map(i => [i.id, i.text])).toEqual([['a', 'Welcome'], ['b', '']])
  })
})

describe('readTrackReport keeps why a block must not be drawn over (runtime 14 `clip`, acceptance v3 B04/B13)', () => {
  const rect = { x: 1, y: 2, width: 3, height: 4 }
  const report = (extra: Record<string, unknown>): unknown => ({ channel: 'tracy-preview', v: 1, kind: 'pick-rect', id: 'c1', rect, ...extra })
  it('clipped and covered ride on the rect; anything else is dropped, and a plain box has none', () => {
    expect(readTrackReport(report({ hidden: 'clipped' }))).toEqual({ kind: 'rect', id: 'c1', rect: { ...rect, hidden: 'clipped' } })
    expect(readTrackReport(report({ hidden: 'covered' }))).toEqual({ kind: 'rect', id: 'c1', rect: { ...rect, hidden: 'covered' } })
    expect(readTrackReport(report({ hidden: 'gone' }))).toEqual({ kind: 'rect', id: 'c1', rect })
    expect(readTrackReport(report({}))).toEqual({ kind: 'rect', id: 'c1', rect })
  })
})

describe('round 10: which comments get the page\'s pins (acceptance v5 PICK-new-13)', () => {
  // Thirteen newer comments on one page — eleven of them on elements the page could no longer find —
  // took all twelve slots, and the oldest comment lost its pin although its heading was in the middle
  // of the frame. Now: a page naming `pins60` takes 60; a comment the page reported missing never takes
  // a slot from one it can find; the rest go by last activity, newest first.
  const many = (n: number, url = HOME): Comment[] => Array.from({ length: n }, (_, i) => row({ id: `c${String(i + 1)}`, n: i + 1, url }))

  it('60 per set on a page that names pins60; 12 on an older page, the most recently active kept', () => {
    const store = { ...emptyCommentStore('northgate'), items: many(70) }
    expect(trackItemsOf(store, HOME, null)).toHaveLength(60)
    const old = trackItemsOf(store, HOME, null, null, 'pending', undefined, { cap: 12 })
    expect(old.map(i => i.id)).toEqual(Array.from({ length: 12 }, (_, i) => `c${String(59 + i)}`))
  })

  it('a comment the page reported missing gives its slot to one the page can find', () => {
    const items = many(14)
    const store = { ...emptyCommentStore('northgate'), items }
    const unfound = new Set(items.slice(1).map(c => c.id).slice(0, 11))
    const out = trackItemsOf(store, HOME, null, null, 'pending', undefined, { cap: 12, unfound })
    expect(out.map(i => i.id)).toContain('c1')
    expect(out).toHaveLength(12)
    // With room for all, the missing ones stay tracked (a lazy block may appear), after the found ones.
    expect(trackItemsOf(store, HOME, null, null, 'pending', undefined, { unfound })).toHaveLength(14)
  })

  it('last activity, not the number: a reply brings an old thread back into the set', () => {
    const items = [...many(13), row({ id: 'r', n: 99, replyTo: 'c1', createdAt: 1000 })]
    const store = { ...emptyCommentStore('northgate'), items }
    const out = trackItemsOf(store, HOME, null, null, 'pending', undefined, { cap: 12 })
    expect(out.map(i => i.id)).toContain('c1')
    expect(out.map(i => i.id)).not.toContain('c2')
  })

  it('only the current page\'s comments are tracked', () => {
    const store = { ...emptyCommentStore('northgate'), items: [...many(3), ...many(3, ABOUT).map(c => ({ ...c, id: `a${c.id}`, n: c.n + 10 }))] }
    expect(trackItemsOf(store, HOME, null).map(i => i.id)).toEqual(['c1', 'c2', 'c3'])
  })

  it('withPickItem keeps to the cap it is given', () => {
    const full = Array.from({ length: 60 }, (_, i): TrackItem => ({ id: `c${String(i)}`, selector: `#c${String(i)}`, text: 'x', state: 'pending' }))
    expect(withPickItem(full, { id: 1, selector: 'p', text: '' })).toHaveLength(60)
    expect(withPickItem(full, { id: 1, selector: 'p', text: '' }, 12)).toHaveLength(12)
  })
})
