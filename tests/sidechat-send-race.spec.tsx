// @vitest-environment jsdom
/**
 * A send's cleanup belongs to the thread that SENT it, not to whatever the tab
 * is bound to when the response lands.
 *
 * Why this spec exists: `handleSend` awaited `sidechat.prompt` and then cleared
 * the composer unconditionally (`setComposer('')`), while the view keeps ONE
 * composer whose contents are swapped per bound thread (see
 * `tests/sidechat-draft-isolation.spec.tsx`). A reader who switches threads
 * while a send is in flight — the request outlives the interaction; the host
 * only records the message when a turn claims it — therefore typed into an
 * empty composer that the finishing send then wiped: the draft was gone with no
 * error and no request.
 *
 * ============================ CONTRACT ============================
 * 1. A successful send still clears the SENDING thread's draft (coming back to
 *    it later shows an empty composer).
 * 2. The composer is cleared only while it still shows that thread. A binding
 *    switched mid-flight keeps the newly bound thread's draft verbatim.
 * 3. The send itself is unaffected: exactly one `sidechat.prompt` reaches the
 *    bound thread, and the sending thread's transcript is refreshed.
 *
 * The harness supplies fetch/locale/socket; `promptGate` holds the prompt route
 * open so the response lands AFTER the reader switched threads.
 * ==================================================================
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, type RenderedRoot } from './test-utils.ts'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'
import { SideChatView } from '../src/client/SideChatView.tsx'
import type { Context, SidebarSessionList } from '../src/context-types.ts'
import type { SidebarTab } from '../src/client/state.ts'

const SCOPE = { sessionId: 'root', cwd: '/p' }

/** One thread row the way the host session list reports it. */
function threadSummary(id: string, title: string) {
  return { id, cwd: '/p', displayTitle: title, origin: 'subagent', parentId: 'root', running: false }
}

/** A session list with the parent and two side threads. */
function makeStore(): { getSnapshot: () => SidebarSessionList, subscribe: (fn: () => void) => () => void } {
  const snapshot = {
    byId: {
      root: { id: 'root', cwd: '/p', displayTitle: '主会话', running: false },
      t1: threadSummary('t1', 'Side: 线程一'),
      t2: threadSummary('t2', 'Side: 线程二'),
    },
    projectionsBySession: {
      root: {
        values: {
          subagentCatalog: [
            { id: 't1', createdAt: 1_000, mode: 'continuable', label: 'Side: 线程一' },
            { id: 't2', createdAt: 2_000, mode: 'continuable', label: 'Side: 线程二' },
          ],
        },
        state: 'ready',
        error: null,
      },
    },
  }
  return {
    getSnapshot: () => snapshot as unknown as SidebarSessionList,
    subscribe: () => () => {},
  }
}

/** The tab the shell delivers for one thread. */
function tabFor(threadId: string): SidebarTab {
  return { id: 'tab1', type: 'sidechat', title: '线程', meta: { threadId } }
}

let harness: SidechatHarness
let ctx: Context

beforeEach(() => {
  harness = installSidechatHarness()
  harness.wire.events = [
    { type: 'session/end-seed', seq: 0, time: 0, data: {} },
    { type: 'user/message', seq: 1, time: 1_000, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
  ]
  ctx = {
    sessions: { list: makeStore() },
    get: (key: string) => (key === 'betterSidebar' ? harness.host : undefined),
  } as unknown as Context
})

afterEach(() => {
  harness.promptGate = null
  harness.cleanup()
})

/** Flush React work and the stub's resolved promises. */
async function flush(rounds = 4): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await act(async () => {})
}

/** Render the view bound to one thread. */
function render(threadId: string): RenderedRoot {
  return renderRoot(createElement(SideChatView, { ctx, scope: SCOPE, tab: tabFor(threadId), visible: true }))
}

/** The binding the shell re-delivers: same view, another thread. */
async function bind(view: RenderedRoot, threadId: string): Promise<void> {
  view.rerender(createElement(SideChatView, { ctx, scope: SCOPE, tab: tabFor(threadId), visible: true }))
  await flush()
}

/** The composer's textarea. */
function composerOf(view: RenderedRoot): HTMLTextAreaElement {
  const field = view.container.querySelector('textarea')
  if (field === null) throw new Error('the composer textarea is missing')
  return field
}

/** Type into the composer the way a user does (bypassing React's value tracker). */
function typeDraft(view: RenderedRoot, text: string): void {
  const field = composerOf(view)
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  act(() => {
    setter?.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Submit the current draft with the composer's own Enter gesture. */
async function submit(view: RenderedRoot): Promise<void> {
  const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })
  act(() => { composerOf(view).dispatchEvent(event) })
  await flush()
}

describe('a send that outlives its binding', () => {
  it('keeps the newly bound thread\'s draft when the send lands after the switch', async () => {
    const view = render('t1')
    try {
      await flush()
      typeDraft(view, 'send me')
      await flush(2)

      // The prompt is now IN FLIGHT: the route answers only when released.
      let release = (): void => {}
      harness.promptGate = new Promise<void>(resolve => { release = resolve })
      await submit(view)
      expect(harness.promptCalls, 'the draft reached thread one').toEqual([{ childId: 't1', text: 'send me' }])

      // The reader switches threads while the request is still open and starts
      // typing in the other thread.
      await bind(view, 't2')
      typeDraft(view, 'draft B')
      await flush(2)
      expect(composerOf(view).value).toBe('draft B')

      release()
      await flush(6)

      expect(
        composerOf(view).value,
        'the response lands on another thread and must not clear its draft',
      ).toBe('draft B')

      await bind(view, 't1')
      expect(composerOf(view).value, 'the sending thread\'s draft is still cleared').toBe('')
    } finally {
      view.unmount()
    }
  })

  it('clears the writer\'s own composer when the binding did not move', async () => {
    const view = render('t1')
    try {
      await flush()
      typeDraft(view, 'send me')
      await flush(2)
      await submit(view)
      expect(composerOf(view).value, 'the sent draft leaves an empty composer').toBe('')
      expect(harness.promptCalls).toEqual([{ childId: 't1', text: 'send me' }])
    } finally {
      view.unmount()
    }
  })
})
