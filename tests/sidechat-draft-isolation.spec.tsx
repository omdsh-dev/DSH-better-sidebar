// @vitest-environment jsdom
/**
 * D8 — a draft belongs to the THREAD it was typed in, not to the tab. Design
 * basis: `/tmp/bsb-parity/spec.md` §D8 / §3.9.
 *
 * Why this spec exists: the composer is one component-level `useState('')`, and
 * the binding-change effect resets the transcript cache, the info badge and the
 * reveal/follow state — but not the draft. So a half-written question follows
 * the reader into another thread: after an archive rebinds the tab (or any
 * re-delivery of `tab.meta.threadId`), the text of thread A sits in thread B's
 * composer, and one Enter sends it to the wrong conversation.
 *
 * ============================ CONTRACT ============================
 * The composer is a PER-THREAD draft owner (`useSidechatDraft(threadId)`,
 * upstream v0.30): the owner is created for the BOUND thread and released when
 * the binding moves, so the composer can never show one thread's text under
 * another thread's name.
 * 1. Re-binding the tab to another thread shows an EMPTY composer (the previous
 *    thread's text must not follow the binding).
 * 2. MERGED BEHAVIOUR (v0.30.x): the text does NOT survive a rebind back. The
 *    owner — text included — is released with the binding, so returning to a
 *    thread starts from an empty composer. This REPLACES the pre-merge
 *    per-tab draft map (`draftsRef` / `draftKeyOf`), which restored each
 *    thread's words verbatim; the upstream owner isolates per thread but does
 *    not persist across a switch. Asserted below so the difference is visible,
 *    not silent.
 * 3. A successful send clears the sending thread's composer, and the draft
 *    reaches exactly that thread.
 * 4. `openNewThread` (the "+" control) creates the thread through
 *    `sidechat.start` and announces it to the shell the way the view already
 *    does (`openTab` for the parked reopen); the new binding then starts with an
 *    EMPTY draft.
 *
 * The binding is what the SHELL re-delivers (`tab.meta.threadId`), so this spec
 * drives switching with a re-render of the same mounted view — no harness
 * change, no second tab. The harness still supplies the fetch/locale/socket
 * stubs; the context and the tab are this spec's own (the shared harness's
 * session list is frozen).
 * ==================================================================
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, type RenderedRoot } from './test-utils.ts'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'
import { SideChatView } from '../src/client/SideChatView.tsx'
import { t } from '../src/client/locales.ts'
import type { Context, SidebarSessionList } from '../src/context-types.ts'
import type { SidebarTab } from '../src/client/state.ts'

const SCOPE = { sessionId: 'root', cwd: '/p' }
const NEW_THREAD_ID = 'session-new'

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

/** The "+" (new thread) control. */
function newThreadButton(view: RenderedRoot): HTMLButtonElement {
  const button = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(candidate => candidate.getAttribute('aria-label') === t('sideChatNew'))
  expect(button, 'the new-thread control renders').toBeDefined()
  return button as HTMLButtonElement
}

describe('per-thread composer drafts (D8)', () => {
  it('does not carry a draft into another thread', async () => {
    const view = render('t1')
    try {
      await flush()
      typeDraft(view, 'question for thread one')
      await flush(2)
      expect(composerOf(view).value).toBe('question for thread one')

      await bind(view, 't2')
      expect(composerOf(view).value, 'thread two starts with its own (empty) draft').toBe('')
    } finally {
      view.unmount()
    }
  })

  it('releases the draft with the binding instead of restoring it on the way back', async () => {
    const view = render('t1')
    try {
      await flush()
      typeDraft(view, 'draft A')
      await flush(2)
      await bind(view, 't2')
      typeDraft(view, 'draft B')
      await flush(2)
      expect(composerOf(view).value, 'thread two holds its own words').toBe('draft B')

      // Merged behaviour: the owner (text included) is released with the
      // binding, so the earlier thread comes back empty — isolation without
      // persistence (see the header's contract 2).
      await bind(view, 't1')
      expect(composerOf(view).value, 'a rebind starts from an empty composer').toBe('')
    } finally {
      view.unmount()
    }
  })

  it('clears the sending thread and leaves the other thread’s composer empty on the way back', async () => {
    const view = render('t1')
    try {
      await flush()
      await bind(view, 't2')
      typeDraft(view, 'draft B')
      await flush(2)
      await bind(view, 't1')

      typeDraft(view, 'send me')
      await flush(2)
      await submit(view)

      expect(harness.promptCalls, 'the draft reaches thread one').toEqual([{ childId: 't1', text: 'send me' }])
      expect(composerOf(view).value, 'a sent draft leaves an empty composer').toBe('')

      await bind(view, 't2')
      expect(composerOf(view).value, 'the other thread never inherits it either').toBe('')
      await bind(view, 't1')
      expect(composerOf(view).value, 'the sent thread is still empty').toBe('')
    } finally {
      view.unmount()
    }
  })

  it('starts a newly created thread with an empty draft', async () => {
    const view = render('t1')
    try {
      await flush()
      typeDraft(view, 'draft A')
      await flush(2)

      act(() => { newThreadButton(view).click() })
      await flush(6)

      expect(
        harness.host.openTab,
        'the created thread is announced to the shell (the parked reopen)',
      ).toHaveBeenCalledWith({ type: 'sidechat' }, SCOPE)

      // The shell re-delivers the tab with the created thread id.
      await bind(view, NEW_THREAD_ID)
      expect(composerOf(view).value, 'a brand-new thread has no draft').toBe('')

      await bind(view, 't1')
      expect(composerOf(view).value, 'and nothing is carried back to the old thread').toBe('')
      await bind(view, 't2')
      expect(composerOf(view).value, 'nor to an untouched one').toBe('')
    } finally {
      view.unmount()
    }
  })
})
