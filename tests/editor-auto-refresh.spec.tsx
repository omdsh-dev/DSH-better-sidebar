/**
 * Editor preview auto-refresh (#855): a settled `write` / `edit` tool call of
 * the SAME session that names THIS file reloads the preview; nothing else does.
 *
 * The signal is the plugin's own `changes.ops` delta stream, so every test
 * drives `api.changesOps` (the host route is not part of this layer) and
 * counts `api.fsRead` — the number IS the "did the preview re-read" evidence.
 * Fake timers drive the shared 2.5s cadence: the tests can therefore also prove
 * the absence of an fsRead poller and that N editor tabs of one session share
 * ONE delta request.
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, useEffect, useState } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct } from './test-utils.ts'
import type { Context } from '../src/context-types.ts'
import type { SidebarSessionEvent } from '../src/context-types.ts'
import { EditorHost } from '../src/client/EditorHost.tsx'
import { createBetterSidebarService, type EditorToolbarControls, type EditorToolbarState, type FileViewerProps } from '../src/client/service.ts'
import { allLeaves, createSidebarStore, type SidebarTab } from '../src/client/state.ts'

setupReactAct()

const fsRead = vi.fn()
const changesOps = vi.fn()
vi.mock('../src/client/api.ts', () => ({
  api: {
    fsRead: (...args: unknown[]) => fsRead(...args),
    changesOps: (...args: unknown[]) => changesOps(...args),
    mediaUrl: () => '',
  },
}))

/** fsRead call count: the "did anything re-read the file" evidence. */
function reads(): number {
  return fsRead.mock.calls.length
}

/** How many reads ONE path saw (`api.fsRead(scope, path)`). */
function readsOf(path: string): number {
  return fsRead.mock.calls.filter(call => call[1] === path).length
}

/** One settled, successful `write` call pair (the op that must refresh). */
function writePair(seq: number, path: string, callId = `w${seq}`): SidebarSessionEvent[] {
  return [
    {
      type: 'tool/call',
      seq,
      time: seq,
      data: { name: 'write', callId, arguments: JSON.stringify({ file_path: path, content: 'model body' }) },
    },
    {
      type: 'tool/result',
      seq: seq + 1,
      time: seq + 1,
      data: { message: { role: 'tool', source: { kind: 'tool', callId }, content: [{ type: 'text', text: 'ok' }] } },
    },
  ]
}

/** One settled, successful `edit` call pair. */
function editPair(seq: number, path: string, callId = `e${seq}`): SidebarSessionEvent[] {
  return [
    {
      type: 'tool/call',
      seq,
      time: seq,
      data: { name: 'edit', callId, arguments: JSON.stringify({ file_path: path, old_string: 'a', new_string: 'b' }) },
    },
    {
      type: 'tool/result',
      seq: seq + 1,
      time: seq + 1,
      data: { message: { role: 'tool', source: { kind: 'tool', callId }, content: [{ type: 'text', text: 'ok' }] } },
    },
  ]
}

/** One settled, successful `read` call pair (a READ touches no bytes). */
function readPair(seq: number, path: string, callId = `r${seq}`): SidebarSessionEvent[] {
  return [
    {
      type: 'tool/call',
      seq,
      time: seq,
      data: { name: 'read', callId, arguments: JSON.stringify({ file_path: path }) },
    },
    {
      type: 'tool/result',
      seq: seq + 1,
      time: seq + 1,
      data: { message: { role: 'tool', source: { kind: 'tool', callId }, content: [{ type: 'text', text: 'ok' }] } },
    },
  ]
}

/** The delta one poll answers with, and the cursor it reports. */
function delta(events: SidebarSessionEvent[], lastSeq: number): { events: SidebarSessionEvent[]; lastSeq: number } {
  return { events, lastSeq }
}

/**
 * The mock viewer: a viewer-owned draft (the input) plus a hoisted toolbar, so
 * a reload is observable as a REMOUNT (the draft resets to the new content) and
 * a dirty state is observable exactly like the real text editor reports it.
 */
function MockViewer(props: {
  content?: string
  initialMode: 'preview' | 'edit'
  onToolbarState?: (state: EditorToolbarState) => void
  onToolbarControls?: (controls: EditorToolbarControls | null) => void
}) {
  const { content, initialMode, onToolbarState, onToolbarControls } = props
  const [mode, setMode] = useState<'preview' | 'edit'>(initialMode)
  const [draft, setDraft] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    onToolbarState?.({ modes: true, mode, dirty, editable: true, saveState: 'idle' })
  }, [mode, dirty, onToolbarState])
  useEffect(() => {
    onToolbarControls?.({
      setMode: (next) => { setMode(next) },
      save: () => { setDraft(null); setDirty(false) },
    })
    return () => { onToolbarControls?.(null) }
  }, [onToolbarControls])
  return createElement('div', null, [
    createElement('span', { key: 'mode', 'data-testid': 'mode' }, `mode-${mode}`),
    createElement('input', {
      key: 'draft',
      'data-testid': 'draft',
      value: draft ?? content ?? '',
      onChange: (event: { target: { value: string } }) => {
        setDraft(event.target.value)
        setDirty(true)
      },
    }),
  ])
}

interface Harness {
  ctx: Context
  store: ReturnType<typeof createSidebarStore>
  tabOf: (path: string) => SidebarTab
}

/** One sidebar service + store; tabs are opened per file path. */
function harness(sessionId: string): Harness {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  service.registerTab({ id: 'editor', title: 'Editor', dedupeKey: (tab) => tab.path, component: () => null })
  service.registerFileViewer({
    id: 'mock-text',
    exts: ['ts'],
    priority: 0,
    fetchStrategy: 'fsRead',
    component: (props: FileViewerProps) => createElement(MockViewer, {
      content: props.content,
      initialMode: 'preview',
      onToolbarState: props.onToolbarState,
      onToolbarControls: props.onToolbarControls,
    }),
  })
  store.setSession(sessionId)
  const ctx = {
    betterSidebar: service,
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: { [sessionId]: { cwd: '/tmp' } } }) } },
    get: (name: string) => name === 'betterSidebar' ? service : undefined,
  } as unknown as Context
  return {
    ctx,
    store,
    tabOf: (path: string): SidebarTab => {
      ctx.betterSidebar.openTab({ type: 'editor', title: path.split('/').pop()!, path, id: `editor:${path}` })
      return allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.path === path)!
    },
  }
}

/** The EditorHost element for one file of one session. */
function editorElement(ctx: Context, sessionId: string, tab: SidebarTab, visible: boolean): ReturnType<typeof createElement> {
  return createElement(EditorHost, {
    ctx,
    store: ctx.betterSidebar as never,
    scope: { sessionId, cwd: '/tmp' },
    tab,
    visible,
    expanded: [],
    revealed: [],
    onToggleDir: () => {},
    onReferenceFile: () => {},
  })
}

/** Mount one EditorHost for one file of one session. */
function mount(ctx: Context, sessionId: string, tab: SidebarTab, visible = true): ReturnType<typeof renderRoot> {
  return renderRoot(editorElement(ctx, sessionId, tab, visible))
}

/** Let the mount's initial fsRead and the stream's first (baseline) pull settle. */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

/** The mounted viewer's draft input (a remount resets it to the fresh content). */
function draftOf(container: HTMLElement): string {
  return container.querySelector<HTMLInputElement>('[data-testid="draft"]')!.value
}

/** Type into the viewer's draft (the user's unsaved edit). */
function type(container: HTMLElement, text: string): void {
  const input = container.querySelector<HTMLInputElement>('[data-testid="draft"]')!
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Advance the shared 2.5s cadence by `ticks` deltas and settle the answers. */
async function tick(ticks = 1): Promise<void> {
  for (let index = 0; index < ticks; index += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500) })
  }
  await settle()
}

let contentVersion = 0

beforeEach(() => {
  vi.useFakeTimers()
  contentVersion = 0
  fsRead.mockReset()
  // Every read answers a NEW body: a re-read is visible in the DOM, and a
  // non-re-read keeps the previous one.
  fsRead.mockImplementation(async () => ({ kind: 'text', content: `body-${++contentVersion}`, truncated: false }))
  changesOps.mockReset()
  changesOps.mockResolvedValue(delta([], 0))
})

describe('editor preview auto-refresh (#855)', () => {
  it('A: a settled write of the open file re-reads and re-renders it', async () => {
    const { ctx, tabOf } = harness('session-a')
    const view = mount(ctx, 'session-a', tabOf('/tmp/a.ts'))
    try {
      await settle()
      expect(reads()).toBe(1)
      expect(draftOf(view.container)).toBe('body-1')

      changesOps.mockResolvedValue(delta(writePair(11, '/tmp/a.ts'), 12))
      await tick()

      expect(reads()).toBe(2)
      expect(draftOf(view.container)).toBe('body-2')
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  it('A: a settled edit spelled relative to the session cwd hits the same file', async () => {
    const { ctx, tabOf } = harness('session-a-rel')
    const view = mount(ctx, 'session-a-rel', tabOf('/tmp/a.ts'))
    try {
      await settle()
      expect(reads()).toBe(1)

      changesOps.mockResolvedValue(delta(editPair(11, 'a.ts'), 12))
      await tick()

      expect(reads()).toBe(2)
      expect(draftOf(view.container)).toBe('body-2')
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  it('A: a file the model wrote BEFORE the tab opened is not re-read on open', async () => {
    const { ctx, tabOf } = harness('session-a-baseline')
    // The session's whole history already contains a write of the file the
    // user is about to open: the tab's own load is that content's fresh read.
    changesOps.mockResolvedValue(delta(writePair(1, '/tmp/a.ts'), 2))
    const view = mount(ctx, 'session-a-baseline', tabOf('/tmp/a.ts'))
    try {
      await settle()
      await tick(3)

      expect(reads()).toBe(1)
      expect(draftOf(view.container)).toBe('body-1')
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  it('A: a running or failed write refreshes nothing; its successful finish does', async () => {
    const { ctx, tabOf } = harness('session-a-settle')
    const view = mount(ctx, 'session-a-settle', tabOf('/tmp/a.ts'))
    try {
      await settle()
      expect(reads()).toBe(1)

      // A call with no result yet (the file is still being written) ...
      changesOps.mockResolvedValue(delta([writePair(11, '/tmp/a.ts', 'w11')[0]!], 11))
      await tick(1)
      expect(reads()).toBe(1)

      // ... and one whose result reported an error (nothing was written).
      changesOps.mockResolvedValue(delta([
        writePair(21, '/tmp/a.ts', 'w21')[0]!,
        {
          type: 'tool/result',
          seq: 22,
          time: 22,
          data: { message: { role: 'tool', source: { kind: 'tool', callId: 'w21' }, isError: true, content: [{ type: 'text', text: 'permission denied' }] } },
        },
      ], 22))
      await tick(1)
      expect(reads()).toBe(1)

      // The same call settling cleanly is the write that must refresh.
      changesOps.mockResolvedValue(delta([{
        type: 'tool/result',
        seq: 23,
        time: 23,
        data: { message: { role: 'tool', source: { kind: 'tool', callId: 'w21' }, content: [{ type: 'text', text: 'ok' }] } },
      }], 23))
      await tick(1)
      expect(reads()).toBe(2)
      expect(draftOf(view.container)).toBe('body-2')
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  it('B: a settled write of ANOTHER file re-reads nothing', async () => {
    const { ctx, tabOf } = harness('session-b')
    const view = mount(ctx, 'session-b', tabOf('/tmp/a.ts'))
    try {
      await settle()
      expect(reads()).toBe(1)

      changesOps.mockResolvedValue(delta(writePair(11, '/tmp/b.ts'), 12))
      await tick(3)

      expect(reads()).toBe(1)
      expect(draftOf(view.container)).toBe('body-1')
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  it('B: a settled READ of this very file refreshes nothing (a read changes no bytes)', async () => {
    const { ctx, tabOf } = harness('session-b-read')
    const view = mount(ctx, 'session-b-read', tabOf('/tmp/a.ts'))
    try {
      await settle()
      expect(reads()).toBe(1)

      // The model reads the file it is already showing: the most common tool
      // call of a session, and one that leaves the bytes exactly as they were.
      // Only a mutation that lets `kind === 'read'` through the stream's filter
      // can make this reload (see the CHANGELOG's mutation list).
      changesOps.mockResolvedValue(delta(readPair(11, '/tmp/a.ts'), 12))
      await tick(3)

      expect(reads()).toBe(1)
      expect(draftOf(view.container)).toBe('body-1')
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  it('C: a dirty draft is never overwritten by the model writing the file', async () => {
    const { ctx, tabOf } = harness('session-c')
    const view = mount(ctx, 'session-c', tabOf('/tmp/a.ts'))
    try {
      await settle()
      expect(reads()).toBe(1)
      type(view.container, 'my unsaved draft')
      expect(draftOf(view.container)).toBe('my unsaved draft')

      changesOps.mockResolvedValue(delta(writePair(11, '/tmp/a.ts'), 12))
      await tick(2)

      // The user's input survives: no reload, no remount, no fsRead.
      expect(draftOf(view.container)).toBe('my unsaved draft')
      expect(reads()).toBe(1)
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  it('D: another session writing this file does not refresh this session', async () => {
    const a = harness('session-d-a')
    const b = harness('session-d-b')
    const viewA = mount(a.ctx, 'session-d-a', a.tabOf('/tmp/a.ts'))
    const viewB = mount(b.ctx, 'session-d-b', b.tabOf('/tmp/b.ts'))
    try {
      await settle()
      expect(readsOf('/tmp/a.ts')).toBe(1)
      expect(readsOf('/tmp/b.ts')).toBe(1)
      const bodyOfA = draftOf(viewA.container)
      const bodyOfB = draftOf(viewB.container)

      // Each session's log names the OTHER session's open file: a stream that
      // were shared (or subscribed with the wrong session id) would refresh
      // both tabs here.
      changesOps.mockImplementation(async (scope: { sessionId: string }) => scope.sessionId === 'session-d-a'
        ? delta(writePair(11, '/tmp/b.ts'), 12)
        : delta(writePair(21, '/tmp/a.ts'), 22))
      await tick(2)

      expect(readsOf('/tmp/a.ts')).toBe(1)
      expect(readsOf('/tmp/b.ts')).toBe(1)
      expect(draftOf(viewA.container)).toBe(bodyOfA)
      expect(draftOf(viewB.container)).toBe(bodyOfB)

      // Positive control: the two editors ARE live and polling — session A's
      // own log now touching A's file refreshes exactly that tab.
      changesOps.mockImplementation(async (scope: { sessionId: string }) => scope.sessionId === 'session-d-a'
        ? delta(writePair(31, '/tmp/a.ts', 'w31'), 32)
        : delta([], 0))
      await tick(1)

      expect(readsOf('/tmp/a.ts')).toBe(2)
      expect(readsOf('/tmp/b.ts')).toBe(1)
    } finally {
      viewA.unmount()
      viewB.unmount()
      vi.useRealTimers()
    }
  })

  it('E: no delta ever polls fsRead (the refresh rides the event stream)', async () => {
    const { ctx, tabOf } = harness('session-e')
    const view = mount(ctx, 'session-e', tabOf('/tmp/a.ts'))
    try {
      await settle()
      expect(reads()).toBe(1)
      const pullsAfterMount = changesOps.mock.calls.length

      await tick(4)

      // The stream really did tick (so the timer is not simply dead)...
      expect(changesOps.mock.calls.length).toBeGreaterThan(pullsAfterMount)
      // ...and nothing on disk was probed for it.
      expect(reads()).toBe(1)
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  it('F: N editor tabs of one session share exactly ONE delta request per tick', async () => {
    const { ctx, tabOf } = harness('session-f')
    const views = [
      mount(ctx, 'session-f', tabOf('/tmp/a.ts')),
      mount(ctx, 'session-f', tabOf('/tmp/b.ts')),
      mount(ctx, 'session-f', tabOf('/tmp/c.ts')),
    ]
    try {
      await settle()
      expect(changesOps.mock.calls.length).toBe(1)

      await tick(2)

      expect(changesOps.mock.calls.length).toBe(3)
    } finally {
      for (const view of views) view.unmount()
      vi.useRealTimers()
    }
  })

  it('F: the delta poll stops when the last editor tab goes away', async () => {
    const { ctx, tabOf } = harness('session-f-stop')
    const view = mount(ctx, 'session-f-stop', tabOf('/tmp/a.ts'))
    await settle()
    const pulls = changesOps.mock.calls.length
    view.unmount()
    await tick(3)
    expect(changesOps.mock.calls.length).toBe(pulls)
    vi.useRealTimers()
  })

  it('H: a touch that lands while the tab is parked still refreshes it on return', async () => {
    const { ctx, tabOf } = harness('session-h')
    const tab = tabOf('/tmp/a.ts')
    const view = mount(ctx, 'session-h', tab)
    try {
      await settle()
      expect(reads()).toBe(1)
      const pullsWhileVisible = changesOps.mock.calls.length

      // The tab goes away (another tab of the same session, or its panel
      // closed): the shared poller stops...
      view.rerender(editorElement(ctx, 'session-h', tab, false))
      changesOps.mockResolvedValue(delta(writePair(11, '/tmp/a.ts'), 12))
      await tick(2)
      expect(changesOps.mock.calls.length).toBe(pullsWhileVisible)
      expect(reads()).toBe(1)

      // ...and coming back resumes the cursor: the missed write is folded then
      // (the stream record outlives its members), so the tab is not stale.
      view.rerender(editorElement(ctx, 'session-h', tab, true))
      await tick(1)
      expect(reads()).toBe(2)
      expect(draftOf(view.container)).toBe('body-2')
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  it('I: retargeting a tab onto a path touched a moment ago does not re-read it', async () => {
    const { ctx, tabOf } = harness('session-i')
    const tabA = tabOf('/tmp/a.ts')
    const tabB = tabOf('/tmp/b.ts')
    const view = mount(ctx, 'session-i', tabA)
    try {
      await settle()
      expect(readsOf('/tmp/a.ts')).toBe(1)

      // The model writes B while this tab shows A. The touch is PUBLISHED now
      // (revision 1) and matches nothing yet.
      changesOps.mockResolvedValue(delta(writePair(11, '/tmp/b.ts'), 12))
      await tick(1)
      expect(readsOf('/tmp/b.ts')).toBe(0)

      // The user retargets this very tab onto B (merged mode's in-place switch):
      // its own load reads the file ONCE, and that read is already the fresh
      // content of the write above...
      view.rerender(editorElement(ctx, 'session-i', tabB, true))
      await settle()
      expect(readsOf('/tmp/b.ts')).toBe(1)

      // ...so the touch published BEFORE the retarget must not reload it again
      // (opBaseline's per-path revision: without it this is a second read and a
      // remount that throws away scroll position for identical bytes).
      await tick(3)
      expect(readsOf('/tmp/b.ts')).toBe(1)
      expect(draftOf(view.container)).toBe('body-2')
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  it('G: an open edit session is left alone (its caret must not jump)', async () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'editor', title: 'Editor', dedupeKey: (tab) => tab.path, component: () => null })
    service.registerFileViewer({
      id: 'mock-text',
      exts: ['ts'],
      priority: 0,
      fetchStrategy: 'fsRead',
      component: (props: FileViewerProps) => createElement(MockViewer, {
        content: props.content,
        initialMode: 'edit',
        onToolbarState: props.onToolbarState,
        onToolbarControls: props.onToolbarControls,
      }),
    })
    const sessionId = 'session-g'
    store.setSession(sessionId)
    const ctx = {
      betterSidebar: service,
      sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: { [sessionId]: { cwd: '/tmp' } } }) } },
      get: (name: string) => name === 'betterSidebar' ? service : undefined,
    } as unknown as Context
    const view = mount(ctx, sessionId, (() => {
      ctx.betterSidebar.openTab({ type: 'editor', title: 'a.ts', path: '/tmp/a.ts', id: 'editor:/tmp/a.ts' })
      return allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)[0]!
    })())
    try {
      await settle()
      expect(reads()).toBe(1)
      expect(view.container.querySelector('[data-testid="mode"]')!.textContent).toBe('mode-edit')

      changesOps.mockResolvedValue(delta(writePair(11, '/tmp/a.ts'), 12))
      await tick(2)

      // No reload while the mode toggle says "edit"; the existing edit→preview
      // edge and the header's refresh button remain the entry points.
      expect(reads()).toBe(1)
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })
})
