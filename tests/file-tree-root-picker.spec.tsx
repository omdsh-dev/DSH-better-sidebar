/**
 * The explorer's root picker (the client half).
 *
 * The root is inferred, and until this control existed the ONLY way to correct
 * it was restarting the host with `DSH_SIDEBAR_WORKTREE_ROOT` (#952: a nested
 * repository's worktree hijacking the explorer; #960: a checkout that was
 * removed). Three behaviours are pinned here, all through the real shared store
 * (`use-session-root.ts`) rather than a spy on it:
 *
 *  - the root row's label IS the trigger, and opening it asks the host for the
 *    session's root plus its checkout list (`session.root` + `git.worktrees`);
 *  - choosing a checkout writes it host-side and the tree RE-ROOTS on the same
 *    tick — the store adopts the host's answer, so the new root's level is
 *    listed without waiting for the 5 s poll;
 *  - "automatic" clears the pin, a refusal lands in the tree's own error strip,
 *    and a workspace that is not a repository says so instead of offering an
 *    empty list.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, useMemo, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import { useSessionRoot } from '../src/client/use-session-root.ts'
import css from '../src/client/sidebar.module.css'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so the copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const { fsTrees, gitStatus, sessionCwd, sessionRoot, gitWorktrees, pinSessionRoot } = vi.hoisted(() => ({
  fsTrees: vi.fn(),
  gitStatus: vi.fn(),
  sessionCwd: vi.fn(),
  sessionRoot: vi.fn(),
  gitWorktrees: vi.fn(),
  pinSessionRoot: vi.fn(),
}))

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      fsTrees, gitStatus, sessionCwd, sessionRoot, gitWorktrees, pinSessionRoot,
    },
  }
})

const ROOT = '/tmp/ws'
const LINKED = '/tmp/ws-linked'

interface Row {
  name: string
  path: string
  isDir: boolean
  hidden: boolean
  isSymlink: boolean
  broken: boolean
}

/** One directory row (the shape the host lists). */
function dir(path: string): Row {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return { name, path, isDir: true, hidden: name.startsWith('.'), isSymlink: false, broken: false }
}

/** Every root the tree has listed, in request order (one path per batch call). */
function listedRoots(): string[] {
  return fsTrees.mock.calls.map(call => (call[0] as { cwd: string }).cwd)
}

/** The smallest WebSocket the directory watcher talks to. */
class FakeSocket {
  static readonly OPEN = 1
  static readonly CONNECTING = 0
  readyState = FakeSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(readonly url: string) {}
  send(): void {}
  close(): void { this.readyState = 3 }
}

/**
 * The one feed `useSessionRoot` reads behind the host's answer: the session
 * list summary. ONE stable snapshot object, or `useSyncExternalStore` re-renders
 * forever.
 */
const sessionList = {
  subscribe: () => () => {},
  getSnapshot: () => ({ byId: { s1: { cwd: ROOT } } }),
}

/** The shell every surface uses: the store's root feeds the tree's `cwd`. */
function Shell(): ReactNode {
  const ctx = useMemo(() => ({ sessions: { list: sessionList } }) as never, [])
  const cwd = useSessionRoot(ctx, 's1')
  if (cwd === undefined) return null
  return createElement(FileTree, {
    sessionId: 's1',
    cwd,
    expanded: [],
    revealed: [],
    onToggle: () => {},
    onOpenFile: () => {},
    onReferenceFile: () => {},
    refreshTick: 0,
    onUploadRequest: () => {},
    busy: false,
  })
}

interface Harness {
  container: HTMLDivElement
  unmount: () => void
}

function mount(): Harness {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => { root.render(createElement(Shell)) })
  return { container, unmount: () => { act(() => { root.unmount() }); container.remove() } }
}

/**
 * Flush the batch promise chain, the shared store's own request AND the state
 * it settles into: a macrotask turn drains every microtask behind them (the
 * store answers on its own then-chain, which the pure `Promise.resolve()` loop
 * of the neighbouring file-tree specs never has to wait for).
 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => { setTimeout(resolve, 0) })
  })
}

/** The root row's own trigger (its label doubles as the control). */
function rootTrigger(container: HTMLElement): HTMLElement {
  const trigger = container.querySelector<HTMLElement>(`.${css.explorerRootName}`)
  if (trigger === null) throw new Error('no root picker trigger')
  return trigger
}

/** One open menu row by its rendered label. */
function menuitem(label: string): HTMLElement {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(element => (element.textContent ?? '') === label)
  if (item === undefined) {
    const seen = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(element => element.textContent)
    throw new Error(`menuitem "${label}" not found in ${JSON.stringify(seen)}`)
  }
  return item
}

/** Open the picker from the root row. */
async function openPicker(container: HTMLElement): Promise<void> {
  act(() => { rootTrigger(container).click() })
  await flush()
}

let harness: Harness

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket)
  fsTrees.mockReset()
  fsTrees.mockImplementation(async (scope: { cwd: string }) => ({
    levels: [{ path: scope.cwd, entries: [dir(`${scope.cwd}/src`)], truncated: false }],
  }))
  gitStatus.mockReset()
  gitStatus.mockResolvedValue({ isRepo: true, entries: [] })
  sessionCwd.mockReset()
  sessionCwd.mockImplementation(async () => ({ sessionId: 's1', cwd: ROOT, root: 'ws', parent: null, pinned: false }))
  sessionRoot.mockReset()
  sessionRoot.mockImplementation(async () => ({ sessionId: 's1', base: ROOT, automatic: ROOT, root: ROOT, pinned: false }))
  gitWorktrees.mockReset()
  gitWorktrees.mockImplementation(async () => [
    { path: ROOT, branch: 'main', current: true, changes: 0 },
    { path: LINKED, branch: 'agent', current: false, changes: 3 },
  ])
  pinSessionRoot.mockReset()
  pinSessionRoot.mockResolvedValue({ sessionId: 's1', base: ROOT, automatic: ROOT, root: LINKED, pinned: true })
  harness = mount()
})

afterEach(() => {
  harness.unmount()
  vi.unstubAllGlobals()
})

describe('the explorer root picker', () => {
  it('lists the session\'s checkouts, marking the one in force', async () => {
    await flush()
    await openPicker(harness.container)
    expect(sessionRoot).toHaveBeenCalledWith({ sessionId: 's1', cwd: ROOT })
    expect(gitWorktrees).toHaveBeenCalledWith({ sessionId: 's1', cwd: ROOT })
    // The primary checkout and the linked one, with the linked checkout's
    // change count — the same figures the Git page shows.
    expect(menuitem('main · ws').textContent).toBe('main · ws')
    expect(menuitem('agent · ws-linked (3)').textContent).toBe('agent · ws-linked (3)')
    expect(menuitem('Automatic (follow the agent)').textContent).toBe('Automatic (follow the agent)')
  })

  it('pins the chosen checkout and re-roots the tree on the same tick', async () => {
    await flush()
    await openPicker(harness.container)
    act(() => { menuitem('agent · ws-linked (3)').click() })
    await flush()
    expect(pinSessionRoot).toHaveBeenCalledWith({ sessionId: 's1', cwd: ROOT }, LINKED)
    // The store adopted the host's answer, so the tree re-rooted: the root row
    // now names the pinned checkout and its own level was requested.
    expect(rootTrigger(harness.container).textContent).toBe('ws-linked')
    expect(listedRoots()).toContain(LINKED)
  })

  it('clears the pin through the automatic row', async () => {
    // Start PINNED, so clearing it is a real transition: mount after the mocks
    // describe that state (the store resolves its first answer on mount).
    sessionCwd.mockImplementation(async () => ({ sessionId: 's1', cwd: LINKED, root: 'ws-linked', parent: null, pinned: true }))
    sessionRoot.mockImplementation(async () => ({ sessionId: 's1', base: ROOT, automatic: ROOT, root: LINKED, pinned: true }))
    pinSessionRoot.mockResolvedValue({ sessionId: 's1', base: ROOT, automatic: ROOT, root: ROOT, pinned: false })
    harness.unmount()
    harness = mount()
    await flush()
    expect(rootTrigger(harness.container).textContent).toBe('ws-linked')
    await openPicker(harness.container)
    act(() => { menuitem('Automatic (follow the agent)').click() })
    await flush()
    expect(pinSessionRoot).toHaveBeenCalledWith({ sessionId: 's1', cwd: LINKED }, null)
    // Clearing hands the session back to the automatic answer on the same tick.
    expect(rootTrigger(harness.container).textContent).toBe('ws')
  })

  it('reports a refused pin in the tree\'s own error strip', async () => {
    pinSessionRoot.mockRejectedValue(new Error('unknown linked worktree: /tmp/outside'))
    await flush()
    await openPicker(harness.container)
    act(() => { menuitem('agent · ws-linked (3)').click() })
    await flush()
    const strip = harness.container.querySelector(`.${css.explorerActionError}`)
    expect(strip?.textContent).toContain('unknown linked worktree')
    // A refusal leaves the tree where it was.
    expect(rootTrigger(harness.container).textContent).toBe('ws')
  })

  it('says so when the workspace is not a repository, instead of listing nothing', async () => {
    gitWorktrees.mockRejectedValue(new Error('fatal: not a git repository'))
    await flush()
    await openPicker(harness.container)
    // The "not a repository" line is a menu HEADING, not a row: assert the copy
    // in the open card rather than through the menuitem walk.
    const card = [...document.querySelectorAll<HTMLElement>('[role="menu"]')].at(-1)
    expect(card?.textContent).toContain('This directory is not a git repository')
    // The automatic entry is still selectable — a session outside a repository
    // has no pin to make, but the menu must not be a dead end.
    expect(menuitem('Automatic (follow the agent)').textContent).toBe('Automatic (follow the agent)')
  })
})
