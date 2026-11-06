// @vitest-environment jsdom
/**
 * D7 (P0) — sending and stopping are TWO actions, not one ternary. Design
 * basis: `/tmp/bsb-parity/spec.md` §D7 and §3.4.
 *
 * Why this spec exists: the composer renders `running ? Stop : Send`, so while
 * a turn runs the send button simply disappears — the reader concludes they
 * cannot queue a follow-up. The keyboard path disagrees: `onKeyDown` →
 * `handleSend` never looks at `running` (only at `busy`), so Enter still sends
 * and the host accepts the message into the thread's inbox. The UI hides a
 * capability the keyboard still has, which is exactly the state that confuses
 * people. The host's own InputBar keeps both: the primary button turns into
 * Send once a draft exists, and an independent Stop stays beside it.
 *
 * ============================ CONTRACT ============================
 * 1. Running means the session list reports the bound thread running
 *    (`sessions.list.getSnapshot().byId[threadId].running === true`).
 * 2. While running, BOTH controls are mounted at the same time, inside the
 *    composer bar: the send action (`aria-label === t('sideChatSend')`) and the
 *    stop control (`aria-label === t('sideChatCancelTitle')`). They are two
 *    distinct elements — no swap, no ternary. Neither carries `hidden`,
 *    `aria-hidden` or `display: none`.
 * 3. Sending while running is QUEUE semantics: exactly one `sidechat.prompt`
 *    carrying the draft text, and no `sidechat.cancel`.
 * 4. Stopping is its own action: exactly one `sidechat.cancel`, and no prompt.
 * 5. Availability is decided per control: send is disabled for an empty draft
 *    (and while the view is busy), stop is available while the reader is not
 *    busy — the draft never decides whether the run can be stopped.
 * ==================================================================
 *
 * The spec drives the real `SideChatView` through the shared harness. The
 * harness's own session store is frozen at `running: false`, so this file
 * supplies its own store (a plain snapshot + notify pair) through
 * `extraProps.ctx` — the harness's fetch stub, locale, socket and
 * `promptCalls` recorder keep doing the work. Nothing outside `tests/` is
 * touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'
import { t } from '../src/client/locales.ts'
import type { Context, SidebarSessionList } from '../src/context-types.ts'

/** Every route the view asked for, in order (method names only). */
let routes: string[] = []

/** Count of a route name, e.g. 'sidechat.cancel'. */
const callsTo = (method: string): number => routes.filter(entry => entry === method).length

/** A session list whose bound thread can be flipped running ↔ idle. */
interface RunningStore {
  getSnapshot: () => SidebarSessionList
  subscribe: (listener: () => void) => () => void
  setRunning: (next: boolean) => void
}

function makeStore(running: boolean): RunningStore {
  const listeners = new Set<() => void>()
  let snapshot = {
    byId: {
      root: { id: 'root', cwd: '/p', displayTitle: '主会话', running: false },
      t1: { id: 't1', cwd: '/p', displayTitle: 'Side: 线程一', origin: 'subagent', parentId: 'root', running },
    },
    projectionsBySession: {
      root: {
        values: {
          subagentCatalog: [{ id: 't1', createdAt: 1_000, mode: 'continuable', label: 'Side: 线程一' }],
        },
        state: 'ready',
        error: null,
      },
    },
  }
  return {
    getSnapshot: () => snapshot as unknown as SidebarSessionList,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setRunning: (next: boolean) => {
      snapshot = {
        ...snapshot,
        byId: { ...snapshot.byId, t1: { ...snapshot.byId.t1, running: next } },
      }
      for (const listener of [...listeners]) listener()
    },
  }
}

/** Every button whose accessible name is exactly `label`. */
function buttonsLabelled(container: HTMLElement, label: string): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')].filter(
    button => button.getAttribute('aria-label') === label,
  )
}

/** The send action, or undefined when the view is hiding it. */
function sendButton(container: HTMLElement): HTMLButtonElement | undefined {
  return buttonsLabelled(container, t('sideChatSend'))[0]
}

/** The stop control, or undefined when the view is hiding it. */
function stopButton(container: HTMLElement): HTMLButtonElement | undefined {
  return buttonsLabelled(container, t('sideChatCancelTitle'))[0]
}

/** A control is visually offered when no hiding attribute is on it. */
function isOffered(button: HTMLButtonElement | undefined): boolean {
  if (button === undefined) return false
  if (button.hasAttribute('hidden')) return false
  if (button.getAttribute('aria-hidden') === 'true') return false
  return button.style.display !== 'none'
}

let harness: SidechatHarness
let store: RunningStore

beforeEach(() => {
  routes = []
  harness = installSidechatHarness()
  // Record every route the view calls (the harness records prompts; cancels and
  // the poll/fetch calls need the whole list).
  const harnessFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    routes.push(String(url).split('/').pop() ?? '')
    return harnessFetch(url, init)
  })
  harness.wire.events = [
    { type: 'session/end-seed', seq: 0, time: 0, data: {} },
    { type: 'user/message', seq: 1, time: 1_000, data: { content: [{ type: 'text', text: 'first question' }], source: { kind: 'user' } } },
    { type: 'turn/start', seq: 2, time: 2_000, data: { turn: 1 } },
    { type: 'assistant/message', seq: 3, time: 3_000, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'first answer' }] } } },
    // The turn is still open: there is no turn/end, the thread is mid-run.
  ]
  store = makeStore(true)
  harness.extraProps.ctx = {
    sessions: { list: store },
    get: (key: string) => (key === 'betterSidebar' ? harness.host : undefined),
  } as unknown as Context
})

afterEach(() => {
  harness.cleanup()
})

/** Mount the running thread and let the first pull settle. */
async function mountRunning() {
  const rendered = harness.mount()
  await harness.flush(4)
  return rendered
}

describe('SideChatView send while running (D7)', () => {
  it('offers the send action and the stop control at the same time while the thread runs', async () => {
    const rendered = await mountRunning()
    try {
      const send = sendButton(rendered.container)
      const stop = stopButton(rendered.container)

      expect(send, 'the send action stays mounted while the thread is running').toBeDefined()
      expect(stop, 'the stop control is mounted while the thread is running').toBeDefined()
      expect(send, 'sending and stopping are two different controls').not.toBe(stop)
      expect(isOffered(send), 'the send action is not hidden').toBe(true)
      expect(isOffered(stop), 'the stop control is not hidden').toBe(true)

      // Both live in the composer bar, side by side (the host's arrangement).
      const bar = rendered.container.querySelector('[class*="sidechatComposerBar"]')
      expect(bar, 'the composer bar renders').not.toBeNull()
      expect((bar as HTMLElement).contains(send as HTMLButtonElement), 'send sits in the composer bar').toBe(true)
      expect((bar as HTMLElement).contains(stop as HTMLButtonElement), 'stop sits in the composer bar').toBe(true)

      // Each carries its own accessible name (asserted by the lookups above),
      // and they never collapse into one label.
      expect(send?.getAttribute('aria-label')).not.toBe(stop?.getAttribute('aria-label'))
    } finally {
      rendered.unmount()
    }
  })

  it('queues the draft through sidechat.prompt while running and cancels nothing', async () => {
    const rendered = await mountRunning()
    try {
      harness.typeComposer('queued follow-up')
      await harness.flush(2)
      const send = sendButton(rendered.container)
      expect(send, 'the send action is available with a draft').toBeDefined()
      expect(send?.disabled, 'a non-empty draft enables send even while running').toBe(false)

      act(() => { (send as HTMLButtonElement).click() })
      await harness.flush(4)

      expect(harness.promptCalls, 'the draft reaches the inbox exactly once').toEqual([
        { childId: 't1', text: 'queued follow-up' },
      ])
      expect(callsTo('sidechat.cancel'), 'sending never stops the running turn').toBe(0)
      // Still running: the send action did not turn into a stop control.
      expect(stopButton(rendered.container), 'the stop control stays available').toBeDefined()
    } finally {
      rendered.unmount()
    }
  })

  it('stops the running turn through its own control, leaving the send action in place', async () => {
    const rendered = await mountRunning()
    try {
      harness.typeComposer('still queued')
      await harness.flush(2)
      const stop = stopButton(rendered.container)
      expect(stop, 'the stop control is available').toBeDefined()

      act(() => { (stop as HTMLButtonElement).click() })
      await harness.flush(4)

      expect(callsTo('sidechat.cancel'), 'stop asks the host to cancel exactly once').toBe(1)
      expect(harness.promptCalls, 'stopping must not send the draft').toEqual([])
      // The draft survives the stop, and so does the action that sends it: the
      // reader who stops a run still wants to say what comes next.
      const send = sendButton(rendered.container)
      expect(send, 'the send action survives a stop').toBeDefined()
      expect(send?.disabled, 'the surviving send action still carries the draft').toBe(false)
      expect(harness.composerValue(), 'stopping keeps the draft').toBe('still queued')
    } finally {
      rendered.unmount()
    }
  })

  it('keeps the two availability rules apart: an empty draft disables send, never stop', async () => {
    const rendered = await mountRunning()
    try {
      expect(harness.composerValue(), 'the draft starts empty').toBe('')
      const send = sendButton(rendered.container)
      const stop = stopButton(rendered.container)
      expect(send, 'the send action is mounted even with an empty draft').toBeDefined()
      expect(stop, 'the stop control is mounted').toBeDefined()
      expect(send?.disabled, 'an empty draft disables send').toBe(true)
      expect(stop?.disabled, 'the draft state never disables stop').toBe(false)
    } finally {
      rendered.unmount()
    }
  })
})
