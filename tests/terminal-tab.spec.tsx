/**
 * The bottom workbench's terminal tab (#774).
 *
 * Three contracts are pinned here, in the order they break:
 *
 * 1. CARRIER SURFACE: `terminal-bottom` is `bottomOnly`, so it is offered in
 *    the plugin's own + menu, never registered as a native right-Sidebar tab
 *    type, and an `openTab` that asked for the right column still lands in the
 *    bottom workbench. (DSH's own right Sidebar owns one `terminal` entry;
 *    a second capsule is the shadowing the mount lane pins as absent.)
 * 2. THE HOST CONTRACT: the view drives `ctx.webTerminals` structurally — the
 *    stable `(sessionId, key, contentId)` occurrence identity that makes a
 *    reload adopt the SAME host terminal, the mount/detach pair that leaves
 *    the process alive across DOM unmount, `write`/`resize` forwarding, and
 *    the frame protocol (`snapshot` → reset+resize+write, `output` → write,
 *    then `acknowledge` — an unacknowledged frame stops output for good).
 * 3. DEGRADATION: a deployment without the host service renders the
 *    explanation instead of throwing, and the + menu row is disabled.
 *
 * xterm itself is mocked: jsdom cannot open a real emulator (no canvas, no
 * ResizeObserver), and the assertions are about the plumbing AROUND it. The
 * real emulator is only exercised by the mount lane's browser run.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactElement } from 'react'
import { act } from 'react-dom/test-utils'
// First import: browser globals before the primitive-carrying sidebar graph loads.
import './browser-globals.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { t } from '../src/client/locales.ts'
import type { Context } from '../src/context-types.ts'
import type { SidebarTab } from '../src/client/state.ts'
import { allLeaves, createSidebarStore, openTabInBottomPane } from '../src/client/state.ts'
import { createBetterSidebarService, type TabDescriptor } from '../src/client/service.ts'
import { builtinTabs } from '../src/client/builtins/tabs.tsx'
import {
  bottomTerminalContentId, bottomTerminalKey, nextTerminalMeta, terminalRunOf,
  type HostTerminalView, type HostTerminalViewState, type WebTerminalsFace,
} from '../src/client/terminal-client.ts'
import { TerminalBottomView } from '../src/client/TerminalView.tsx'

setupReactAct()

/** One recorded xterm invocation set (the emulator is a recording stub). */
interface XtermCalls {
  open: HTMLElement[]
  dispose: number
  reset: number
  resize: Array<[number, number]>
  writes: string[]
  dataHandlers: Array<(data: string) => void>
  options: Record<string, unknown>
  disposed: boolean
}

/**
 * The xterm stubs, built inside `vi.hoisted` — `vi.mock` factories are hoisted
 * above the imports, so they cannot close over anything declared below them.
 */
const xterm = vi.hoisted(() => {
  const emulators: XtermCalls[] = []
  /** FitAddon.proposeDimensions() result; tests override it per case. */
  const fit: { proposed: { cols: number; rows: number } | undefined } = {
    proposed: { cols: 100, rows: 30 },
  }
  class FakeTerminal {
    readonly calls: XtermCalls = {
      open: [], dispose: 0, reset: 0, resize: [], writes: [],
      dataHandlers: [], options: {}, disposed: false,
    }

    options: Record<string, unknown> = {}

    constructor() {
      // One object: the component assigns `xterm.options.disableStdin`, and
      // the assertions read the very same record.
      this.options = this.calls.options
      emulators.push(this.calls)
    }

    loadAddon(): void { /* the fit addon is stubbed too */ }
    open(node: HTMLElement): void { this.calls.open.push(node) }
    reset(): void { this.calls.reset += 1 }
    resize(cols: number, rows: number): void { this.calls.resize.push([cols, rows]) }
    focus(): void { /* focus bookkeeping is not asserted */ }
    dispose(): void { this.calls.dispose += 1; this.calls.disposed = true }
    onData(handler: (data: string) => void): { dispose: () => void } {
      this.calls.dataHandlers.push(handler)
      return { dispose: () => { /* no listener bookkeeping needed */ } }
    }

    write(data: string, callback?: () => void): void {
      this.calls.writes.push(data)
      callback?.()
    }
  }
  class FakeFitAddon {
    proposeDimensions(): { cols: number; rows: number } | undefined { return fit.proposed }
  }
  return { emulators, fit, FakeTerminal, FakeFitAddon }
})

vi.mock('@xterm/xterm', () => ({ Terminal: xterm.FakeTerminal }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: xterm.FakeFitAddon }))

/** A snapshot store with the host's `SnapshotStore` read/subscribe face. */
class FakeStore<T> {
  private listeners = new Set<() => void>()

  constructor(private value: T) {}

  getSnapshot = (): T => this.value

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(next: T): void {
    this.value = next
    for (const listener of [...this.listeners]) listener()
  }
}

/** One recorded host terminal model. */
class FakeView implements HostTerminalView {
  readonly state: FakeStore<HostTerminalViewState>
  mounted = 0
  detached = 0
  connected = 0
  refreshed = 0
  readonly writes: string[] = []
  readonly resizes: Array<[number, number]> = []
  readonly acks: number[] = []

  constructor(
    readonly id: string,
    readonly sessionId: string,
    readonly key: string,
    readonly contentId: string,
    info: { cols: number; rows: number },
  ) {
    this.state = new FakeStore<HostTerminalViewState>({
      phase: 'connected',
      writable: true,
      environment: { cwd: '/w', maxInputBytes: 4096, maxCols: 120, maxRows: 40, scrollback: 1000 },
      info: {
        id, title: 'Terminal', cwd: '/w', cols: info.cols, rows: info.rows,
        state: 'running', exitCode: null,
      },
    })
  }

  mount(): () => void {
    this.mounted += 1
    return () => { this.detached += 1 }
  }

  async refresh(): Promise<void> { this.refreshed += 1 }
  connect(): void { this.connected += 1 }
  acknowledge(revision: number): void { this.acks.push(revision) }
  write(data: string): void { this.writes.push(data) }
  resize(cols: number, rows: number): void { this.resizes.push([cols, rows]) }
  async close(): Promise<void> { /* the process ends */ }

  /** Publish a new state (the host's own patch path). */
  patch(next: Partial<HostTerminalViewState>): void {
    this.state.set({ ...this.state.getSnapshot(), ...next })
  }
}

/**
 * A structural double of the host's `ClientTerminals`, mirroring the ONE
 * behaviour this plugin depends on for restore: `view()` memoizes per
 * `(sessionId, key)` and resolves the terminal identity through the persisted
 * `(sessionId, contentId)` binding, so repeating a call after a remount
 * adopts the same host terminal instead of allocating a new one
 * (dsh-api-terminal-controller 0.2.0-rc.1 `lib/client.js` `view()`).
 */
class FakeTerminals implements WebTerminalsFace {
  readonly views = new Map<string, FakeView>()
  readonly bindings = new Map<string, string>()
  readonly viewCalls: Array<{ sessionId: string; key: string; contentId: string; terminalId?: string }> = []
  readonly closeCalls: Array<{ sessionId: string; key: string; contentId: string }> = []
  allocated = 0

  view(sessionId: string, key: string, contentId: string, terminalId?: string): HostTerminalView {
    this.viewCalls.push({ sessionId, key, contentId, ...(terminalId === undefined ? {} : { terminalId }) })
    const memo = `${sessionId}\u0000${key}`
    const existing = this.views.get(memo)
    if (existing !== undefined) return existing
    const binding = `${sessionId}\u0000${contentId}`
    const saved = terminalId ?? this.bindings.get(binding)
    const id = saved ?? `term-${++this.allocated}`
    this.bindings.set(binding, id)
    const view = new FakeView(id, sessionId, key, contentId, { cols: 80, rows: 24 })
    this.views.set(memo, view)
    return view
  }

  close(sessionId: string, key: string, contentId: string): void {
    this.closeCalls.push({ sessionId, key, contentId })
    this.views.delete(`${sessionId}\u0000${key}`)
    this.bindings.delete(`${sessionId}\u0000${contentId}`)
  }

  async recover(): Promise<never[]> { return [] }
}

/** A context exposing the given services by name (the plugin probes structurally). */
function ctxWith(services: Record<string, unknown>): Context {
  return { get: (name: string) => services[name] } as unknown as Context
}

/**
 * A context carrying the fakes the view probes: `webTerminals` (the host
 * service) and `betterSidebar` (the plugin's own service, whose `updateTab`
 * records the meta the "new terminal" action persists).
 */
function viewSetup(terminals: WebTerminalsFace | undefined) {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  const order: string[] = []
  const ctx = ctxWith({
    ...(terminals === undefined ? {} : { webTerminals: terminals }),
    betterSidebar: {
      updateTab: (tabId: string, patch: { meta?: unknown }) => {
        order.push(`${tabId}:${JSON.stringify(patch.meta)}`)
        store.reduce(state => ({
          ...state,
          bottomSplits: {
            kind: 'leaf', id: 'pane:1',
            tabs: state.bottomSplits.kind === 'leaf'
              ? state.bottomSplits.tabs.map(candidate => candidate.id === tabId ? { ...candidate, meta: patch.meta } : candidate)
              : [],
            active: tabId,
          },
        }))
      },
    },
  })
  return { ctx, service, store, order }
}

/** The bottom terminal tab as the workbench opens it (`single` → id = type). */
function bottomTab(meta?: unknown): SidebarTab {
  return { id: 'terminal-bottom', type: 'terminal-bottom', title: 'Terminal', ...(meta === undefined ? {} : { meta }) }
}

function render(ctx: Context, tab: SidebarTab, visible = true) {
  return renderRoot(createElement(TerminalBottomView, { ctx, scope: { sessionId: 's1', cwd: '/w' }, tab, visible }))
}

/** Flush the microtask queue the memoized `view()`/refresh path may schedule. */
async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  xterm.emulators.length = 0
  xterm.fit.proposed = { cols: 100, rows: 30 }
})

afterEach(() => {
  for (const element of document.querySelectorAll('body > div')) element.remove()
})

describe('terminal-bottom: carrier surface', () => {
  it('registers as a bottom-only, single-instance, service-gated built-in tab', () => {
    const tabs = builtinTabs(ctxWith({ webTerminals: new FakeTerminals() }))
    const terminal = tabs.find(tab => tab.id === 'terminal-bottom')
    expect(terminal).toBeDefined()
    expect(terminal?.bottomOnly).toBe(true)
    expect(terminal?.single).toBe(true)
    expect(terminal?.hidden).not.toBe(true)
    // No createTab: the id safety net keeps ONE bottom terminal per session.
    expect(terminal?.createTab).toBeUndefined()
  })

  it('the + menu row is disabled when the host provides no terminal service', () => {
    const descriptor = builtinTabs(ctxWith({})) as readonly TabDescriptor[]
    const terminal = descriptor.find(tab => tab.id === 'terminal-bottom')
    const state = createSidebarStore().getSnapshot().state!
    const scope = { sessionId: 's1' }
    expect(terminal?.available?.(ctxWith({}), scope, state)).toBe(false)
    expect(terminal?.available?.(ctxWith({ webTerminals: new FakeTerminals() }), scope, state)).toBe(true)
  })

  it('an open asking for the right column still lands in the bottom workbench', () => {
    // The native surface is installed: without `bottomOnly` this open would be
    // handed to the host's sidebar (and a second terminal capsule with it).
    const store = createSidebarStore()
    store.setSession('s1')
    const service = createBetterSidebarService(store)
    service.registerTab(builtinTabs(ctxWith({ webTerminals: new FakeTerminals() })).find(tab => tab.id === 'terminal-bottom')!)
    const native: string[] = []
    service.setSurface({
      openTab: (input) => { native.push(input.kind) },
      openResource: () => {},
      fileAddress: () => 'dsh-resource://file/s1/x',
      close: () => undefined,
      update: () => false,
      activate: () => false,
      has: () => false,
    })
    service.openTab({ type: 'terminal-bottom' }, { sessionId: 's1' })
    expect(native, 'a bottom-only type must never reach the native sidebar').toEqual([])
    const state = store.getSnapshot().state!
    expect(state.bottomOpen).toBe(true)
    const tabs = state.bottomSplits.kind === 'leaf' ? state.bottomSplits.tabs : []
    expect(tabs.map(tab => tab.id)).toEqual(['terminal-bottom'])
  })
})

describe('terminal-bottom: the host terminal contract', () => {
  it('mounts one view per (session, key, contentId) and detaches — never closes — on unmount', async () => {
    const terminals = new FakeTerminals()
    const { ctx } = viewSetup(terminals)
    const { unmount } = render(ctx, bottomTab())
    await flush()

    expect(terminals.viewCalls).toHaveLength(1)
    expect(terminals.viewCalls[0]).toEqual({
      sessionId: 's1',
      key: bottomTerminalKey(0),
      contentId: bottomTerminalContentId(0),
    })
    const view = terminals.views.get('s1\u0000' + bottomTerminalKey(0))!
    expect(view.mounted).toBe(1)
    expect(xterm.emulators).toHaveLength(1)
    expect(xterm.emulators[0]!.open).toHaveLength(1)

    unmount()
    expect(view.detached, 'the DOM lifetime detaches').toBe(1)
    // The host's contract: unmount leaves the process running, so the plugin
    // must NOT close it here (only the tab's onClose does).
    expect(terminals.closeCalls).toEqual([])
    expect(xterm.emulators[0]!.disposed, 'the emulator itself is released').toBe(true)
  })

  it('a remount adopts the SAME host terminal through the stable content identity', async () => {
    const terminals = new FakeTerminals()
    const { ctx } = viewSetup(terminals)

    const first = render(ctx, bottomTab())
    await flush()
    const allocated = terminals.allocated
    const view = terminals.views.get('s1\u0000' + bottomTerminalKey(0))!
    first.unmount()

    // A page reload looks exactly like this to the plugin: a fresh mount of
    // the same tab, with the host service's own state gone.
    terminals.views.clear()
    const second = render(ctx, bottomTab())
    await flush()

    expect(terminals.viewCalls.map(call => call.contentId)).toEqual([
      bottomTerminalContentId(0),
      bottomTerminalContentId(0),
    ])
    expect(terminals.allocated, 'no second terminal was allocated').toBe(allocated)
    expect(terminals.views.get('s1\u0000' + bottomTerminalKey(0))!.id).toBe(view.id)
    second.unmount()
  })

  it('forwards emulator input to the model and a fit to the model resize', async () => {
    const terminals = new FakeTerminals()
    const { ctx } = viewSetup(terminals)
    const { unmount } = render(ctx, bottomTab())
    await flush()
    const view = terminals.views.get('s1\u0000' + bottomTerminalKey(0))!

    // Keystrokes go through the MODEL (it serializes them and refuses them
    // while the view is not writable), never straight to the remote.
    act(() => { xterm.emulators[0]!.dataHandlers[0]!('echo hi\r') })
    expect(view.writes).toEqual(['echo hi\r'])

    // The first fit publishes the measured size inside the host's limits.
    expect(view.resizes).toEqual([[100, 30]])

    // A later, larger box is clamped to the host's per-terminal limits
    // (120x40) rather than asking for a size the host would refuse.
    xterm.fit.proposed = { cols: 400, rows: 200 }
    act(() => {
      view.patch({ environment: { cwd: '/w', maxInputBytes: 4096, maxCols: 120, maxRows: 40, scrollback: 1000 } })
    })
    expect(view.resizes).toEqual([[100, 30], [120, 40]])

    // Not writable: stdin is disabled and no further resize is published.
    act(() => { view.patch({ writable: false }) })
    expect(xterm.emulators[0]!.options.disableStdin).toBe(true)
    expect(view.resizes).toHaveLength(2)
    unmount()
  })

  it('replays a snapshot frame, appends output frames, and acknowledges each revision', async () => {
    const terminals = new FakeTerminals()
    const { ctx } = viewSetup(terminals)
    const { unmount } = render(ctx, bottomTab())
    await flush()
    const view = terminals.views.get('s1\u0000' + bottomTerminalKey(0))!

    act(() => {
      view.patch({
        render: {
          revision: 1,
          frame: {
            type: 'snapshot', sequence: 1, screen: 'restored screen',
            info: { id: view.id, title: 'Terminal', cwd: '/w', cols: 90, rows: 20, state: 'running', exitCode: null },
          },
        },
      })
    })
    expect(xterm.emulators[0]!.reset).toBe(1)
    expect(xterm.emulators[0]!.resize).toContainEqual([90, 20])
    expect(xterm.emulators[0]!.writes).toEqual(['restored screen'])
    expect(view.acks).toEqual([1])

    act(() => {
      view.patch({ render: { revision: 2, frame: { type: 'output', sequence: 2, data: 'more output' } } })
    })
    expect(xterm.emulators[0]!.reset, 'output frames are appended, never replayed').toBe(1)
    expect(xterm.emulators[0]!.writes).toEqual(['restored screen', 'more output'])
    expect(view.acks).toEqual([1, 2])

    // A repeated revision (a re-render with the same state) is not re-written.
    act(() => {
      view.patch({ render: { revision: 2, frame: { type: 'output', sequence: 2, data: 'more output' } } })
    })
    expect(xterm.emulators[0]!.writes).toHaveLength(2)
    unmount()
  })
})

describe('terminal-bottom: degradation and recovery', () => {
  it('renders the explanation — and allocates nothing — without the host service', async () => {
    const { ctx } = viewSetup(undefined)
    const { container, unmount } = render(ctx, bottomTab())
    await flush()
    const section = container.querySelector('[data-dsh-bottom-terminal]')
    expect(section?.getAttribute('data-terminal-state')).toBe('unavailable')
    expect(section?.textContent).toBeTruthy()
    expect(xterm.emulators).toHaveLength(0)
    unmount()
  })

  it('offers a new terminal when the bound process is gone, minting a fresh content identity', async () => {
    const terminals = new FakeTerminals()
    const { ctx, order } = viewSetup(terminals)
    const { container, rerender, unmount } = render(ctx, bottomTab())
    await flush()
    const first = terminals.views.get('s1\u0000' + bottomTerminalKey(0))!

    act(() => { first.patch({ phase: 'failed', writable: false, issue: 'missingTerminal' }) })
    const action = container.querySelector('button')
    expect(action, 'the missing-terminal panel offers a new terminal').not.toBeNull()
    // The raw host issue id never reaches the reader.
    expect(container.textContent).not.toContain('missingTerminal')

    act(() => { action!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // The plugin persists the content-identity generation on the tab.
    expect(order).toEqual(['terminal-bottom:{"terminalRun":1}'])

    // The workbench re-renders the tab from its own store, meta included. The
    // view must then ask the host for a NEW content identity: reusing the dead
    // binding would wedge the tab on `missingTerminal` for the page's life.
    rerender(createElement(TerminalBottomView, {
      ctx, scope: { sessionId: 's1', cwd: '/w' }, tab: bottomTab({ terminalRun: 1 }), visible: true,
    }))
    await flush()
    expect(terminals.viewCalls.map(call => call.contentId)).toEqual([
      bottomTerminalContentId(0),
      bottomTerminalContentId(1),
    ])
    expect(terminals.allocated, 'the replacement is a genuinely new terminal').toBe(2)
    unmount()
  })

  it('an ended terminal owns the only status line, and offers the new-terminal action', async () => {
    const terminals = new FakeTerminals()
    const { ctx } = viewSetup(terminals)
    const { container, unmount } = render(ctx, bottomTab())
    await flush()
    const view = terminals.views.get('s1\u0000' + bottomTerminalKey(0))!
    act(() => {
      view.patch({
        info: { id: view.id, title: 'Terminal', cwd: '/w', cols: 80, rows: 24, state: 'exited', exitCode: 0 },
        // The phase is what makes this case DISCRIMINATING. A patch that only
        // flipped `info.state` to `exited` would leave the pending-phase status
        // line undefined either way (`statusOf` has no line for `connected`),
        // so the assertion below ("the exited sentence appears once") held with
        // and without the gate in `TerminalBottomView`. `disconnected` HAS a
        // line of its own, and the gate is exactly what must stand it — with
        // its Retry button — down: a process that is gone cannot be reconnected
        // to, and the reader would get the same terminal described twice.
        phase: 'disconnected',
        writable: false,
      })
    })
    // The ended panel carries its own line, exactly once…
    const line = t('exited')
    expect(container.textContent!.split(line).length - 1).toBe(1)
    // …it is the ONLY status line on screen (the suppressed one was a
    // `role="status"` div as well)…
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1)
    // …and the only action is the new terminal: the suppressed line's Retry
    // button would come FIRST in DOM order.
    expect([...container.querySelectorAll('button')].map(button => button.textContent))
      .toEqual([t('terminalNew')])
    expect(container.textContent).not.toContain(t('disconnected'))
    unmount()
  })

  it('a disconnected view reconnects through the model instead of reloading the page', async () => {
    const terminals = new FakeTerminals()
    const { ctx } = viewSetup(terminals)
    const { container, unmount } = render(ctx, bottomTab())
    await flush()
    const view = terminals.views.get('s1\u0000' + bottomTerminalKey(0))!
    act(() => { view.patch({ phase: 'disconnected', writable: false }) })
    const action = container.querySelector('button')!
    act(() => { action.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(view.connected).toBe(1)
    expect(view.refreshed).toBe(0)
    unmount()
  })

  it('the new-terminal action rides the REAL updateTab route (native record first, own layout second)', async () => {
    // Every other case here stubs `betterSidebar.updateTab`, which is only the
    // call the view MAKES: the write itself travels
    // `service.updateTab` → `surface.update` → `store.reduce(patchTab)`, and
    // that route was uncovered. It matters most for this type: a `bottomOnly`
    // tab never has a native record, so the store reduce is the only path its
    // "new terminal" can take — with a stub, a broken route would still look
    // green here and fail only in the browser.
    const terminals = new FakeTerminals()
    const store = createSidebarStore()
    store.setSession('s1')
    const service = createBetterSidebarService(store)
    const ctx = ctxWith({ webTerminals: terminals, betterSidebar: service })
    // The workbench's own state: the tab IS open. `patchTab` is a documented
    // no-op for a missing id, so a case that skipped this would assert nothing.
    store.reduce(state => openTabInBottomPane(state, bottomTab()))
    const tabInStore = (): SidebarTab | undefined => allLeaves(store.getSnapshot().state!.bottomSplits)
      .flatMap(leaf => leaf.tabs).find(tab => tab.id === 'terminal-bottom')
    expect(tabInStore()?.meta).toBeUndefined()

    const { container, unmount } = render(ctx, bottomTab())
    await flush()
    const view = terminals.views.get('s1\u0000' + bottomTerminalKey(0))!
    act(() => { view.patch({ phase: 'failed', writable: false, issue: 'missingTerminal' }) })
    const action = container.querySelector('button')!

    // ── the native half: an id the native surface owns is patched THERE ────
    const nativePatches: Array<{ tabId: string; patch: unknown; sessionId: string | undefined }> = []
    service.setSurface({
      openTab: () => {},
      openResource: () => {},
      fileAddress: () => 'dsh-resource://file/s1/x',
      close: () => undefined,
      update: (tabId, patch, sessionId) => {
        nativePatches.push({ tabId, patch, sessionId })
        return true
      },
      activate: () => false,
      has: () => false,
    })
    act(() => { action.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(nativePatches).toEqual([
      { tabId: 'terminal-bottom', patch: { meta: { terminalRun: 1 } }, sessionId: 's1' },
    ])
    expect(tabInStore()?.meta, 'a native record owns the patch — the store stays out of it').toBeUndefined()

    // ── the own-layout half: no native record, so the bottom tree takes it ──
    service.setSurface(undefined)
    act(() => { action.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(tabInStore()?.meta).toEqual({ terminalRun: 1 })
    unmount()
  })
})

describe('terminal-bottom: identity helpers', () => {
  it('keeps run 0 stable and namespaces every later run', () => {
    expect(bottomTerminalContentId(0)).toBe('dsh-better-sidebar:terminal-bottom')
    expect(bottomTerminalKey(0)).toBe(bottomTerminalContentId(0))
    expect(bottomTerminalContentId(1)).toBe(bottomTerminalKey(1))
    expect(bottomTerminalContentId(1)).toContain('#1')
    // Distinct per run — the whole point of the generation.
    expect(bottomTerminalContentId(1)).not.toBe(bottomTerminalContentId(0))
  })

  it('reads a generation only from a well-formed meta, defaulting to 0', () => {
    expect(terminalRunOf(bottomTab())).toBe(0)
    expect(terminalRunOf(bottomTab({ terminalRun: 3 }))).toBe(3)
    expect(terminalRunOf(bottomTab({ terminalRun: -1 }))).toBe(0)
    expect(terminalRunOf(bottomTab({ terminalRun: 1.5 }))).toBe(0)
    expect(terminalRunOf(bottomTab({ terminalRun: 'two' }))).toBe(0)
    expect(terminalRunOf(bottomTab(null))).toBe(0)
    expect(terminalRunOf(bottomTab([1, 2]))).toBe(0)
    expect(nextTerminalMeta(bottomTab({ terminalRun: 3 }))).toEqual({ terminalRun: 4 })
  })
})

describe('terminal-bottom: the descriptor close hook', () => {
  it('closing the tab ends the host terminal (no leaked shell)', () => {
    const terminals = new FakeTerminals()
    const ctx = ctxWith({ webTerminals: terminals })
    const descriptor = builtinTabs(ctx).find(tab => tab.id === 'terminal-bottom')
    const scope = { sessionId: 's1' }
    const icon = descriptor?.icon
    expect(icon).toBeDefined()
    expect((typeof icon === 'function' ? icon(14) : icon) as ReactElement).toBeTruthy()

    descriptor?.onClose?.(bottomTab({ terminalRun: 2 }), scope)
    expect(terminals.closeCalls).toEqual([
      { sessionId: 's1', key: bottomTerminalKey(2), contentId: bottomTerminalContentId(2) },
    ])
  })
})
