/**
 * The terminal shell switcher (src/client/terminal-shells.tsx + the control it
 * renders inside TerminalView).
 *
 * Four contracts, in the order they can break:
 *
 * 1. CAPABILITY GATING: `launchShells` / `selectShell` are OPTIONAL members of
 *    the host's structural contract. A host that mounts the terminal service
 *    without them must keep a working terminal — the view then simply renders
 *    no switcher, and nothing is discovered.
 * 2. THE SWITCH ITSELF: picking a shell writes the preference FIRST and then
 *    closes the process and bumps the content identity. That order is
 *    load-bearing — the replacement occurrence reads the preference while being
 *    allocated, and closing first would otherwise leave it on the OLD shell.
 *    The bump is what makes the host allocate a NEW terminal instead of
 *    adopting the binding of the process we just closed.
 * 3. THE "+" HALF: it opens a SIBLING bottom tab (a fresh instance), which is
 *    the multi-terminal behaviour #774 introduced — it must not reuse the tab
 *    being looked at.
 * 4. THE TITLE: the tab follows the shell the HOST reports on the running
 *    process (`info.shell.name`), normalized for a chip, and only writes on a
 *    real difference so a remount does not churn the persisted layout.
 *
 * xterm is stubbed exactly as in terminal-tab.spec.tsx: jsdom cannot open a
 * real emulator and every assertion here is about the plumbing around it.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
// First import: browser globals before the primitive-carrying sidebar graph loads.
import './browser-globals.ts'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { t } from '../src/client/locales.ts'
import type { Context } from '../src/context-types.ts'
import type { SidebarTab } from '../src/client/state.ts'
import {
  bottomTerminalContentId, matchShellPath, shortShellName, terminalShellOf,
  type HostShellCatalog, type HostTerminalView, type HostTerminalViewState, type WebTerminalsFace,
} from '../src/client/terminal-client.ts'
import { TerminalBottomView } from '../src/client/TerminalView.tsx'
import { canSwitchShells } from '../src/client/terminal-shells.tsx'

setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so any copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const xterm = vi.hoisted(() => {
  class FakeTerminal {
    options: Record<string, unknown> = {}
    loadAddon(): void { /* stubbed */ }
    open(): void { /* stubbed */ }
    reset(): void { /* stubbed */ }
    resize(): void { /* stubbed */ }
    focus(): void { /* stubbed */ }
    attachCustomKeyEventHandler(): void { /* stubbed */ }
    dispose(): void { /* stubbed */ }
    onData(): { dispose: () => void } { return { dispose: () => { /* stubbed */ } } }
    write(_data: string, callback?: () => void): void { callback?.() }
  }
  class FakeFitAddon {
    proposeDimensions(): { cols: number; rows: number } | undefined { return { cols: 100, rows: 30 } }
  }
  return { FakeTerminal, FakeFitAddon }
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

/** One host terminal occurrence; only the members this spec drives are real. */
class FakeView implements HostTerminalView {
  readonly state: FakeStore<HostTerminalViewState>

  constructor(readonly id: string, shell: { path: string; name: string; args: readonly string[] } | undefined) {
    this.state = new FakeStore<HostTerminalViewState>({
      phase: 'connected',
      writable: true,
      environment: { cwd: '/w', maxInputBytes: 4096, maxCols: 120, maxRows: 40, scrollback: 1000 },
      info: {
        id, title: 'Terminal', cwd: '/w', cols: 80, rows: 24,
        state: 'running', exitCode: null,
        ...(shell === undefined ? {} : { shell }),
      },
    })
  }

  mount(): () => void { return () => { /* detached */ } }
  async refresh(): Promise<void> { /* stubbed */ }
  connect(): void { /* stubbed */ }
  acknowledge(): void { /* stubbed */ }
  write(): void { /* stubbed */ }
  resize(): void { /* stubbed */ }
  async close(): Promise<void> { /* stubbed */ }

  patch(next: Partial<HostTerminalViewState>): void {
    this.state.set({ ...this.state.getSnapshot(), ...next })
  }
}

/**
 * A service double recording the SWITCH ORDER, which is the contract under
 * test: `selectShell` before `close`, always.
 */
class FakeTerminals implements WebTerminalsFace {
  /** Every call, in order, as `name(args)` — the assertion reads this directly. */
  readonly log: string[] = []
  readonly views = new Map<string, FakeView>()
  readonly shells: readonly { path: string; name: string; args: readonly string[] }[]
  selected: string | undefined
  /** Whether this double offers the two OPTIONAL shell members at all. */
  readonly withShells: boolean
  private allocated = 0

  constructor(options: { withShells?: boolean } = {}) {
    this.withShells = options.withShells ?? true
    this.shells = [
      { path: '/bin/bash', name: 'bash', args: [] },
      { path: 'C:\\Windows\\System32\\cmd.exe', name: 'cmd.exe', args: [] },
    ]
    if (this.withShells) {
      this.launchShells = async (): Promise<HostShellCatalog> => {
        this.log.push('launchShells')
        return { shells: this.shells, selectedShell: this.selected }
      }
      this.selectShell = (path: string): void => {
        this.log.push(`selectShell(${path})`)
        this.selected = path
      }
    }
  }

  launchShells?: (sessionId: string, signal?: AbortSignal) => Promise<HostShellCatalog>
  selectShell?: (path: string) => void

  view(sessionId: string, key: string, contentId: string, _terminalId?: string, shellPath?: string): HostTerminalView {
    this.log.push(shellPath === undefined ? `view(${contentId})` : `view(${contentId}, ${shellPath})`)
    const memo = `${sessionId}\u0000${key}`
    const existing = this.views.get(memo)
    if (existing !== undefined) return existing
    // An explicit `shellPath` wins; otherwise the replacement is allocated from
    // the remembered shell — exactly what the host does.
    const shell = this.shells.find(candidate => candidate.path === (shellPath ?? this.selected))
    const view = new FakeView(`term-${++this.allocated}`, shell)
    this.views.set(memo, view)
    return view
  }

  close(sessionId: string, key: string, contentId: string): void {
    this.log.push(`close(${contentId})`)
    this.views.delete(`${sessionId}\u0000${key}`)
  }

  async recover(): Promise<never[]> { return [] }
}

/** A context carrying only what the view probes. */
function ctxWith(services: Record<string, unknown>): Context {
  return { get: (name: string) => services[name] } as unknown as Context
}

/**
 * The view's collaborators: the host service plus a recording
 * `betterSidebar` whose `updateTab`/`openTab` are the only writes it may make.
 *
 * `defaultShell` seeds the descriptor's settings blob, which is how the default
 * shell reaches the view: it rides the sidebar snapshot's `prefs`, so the fake
 * has to answer `getSnapshot`/`subscribeState`.
 */
function viewSetup(terminals: WebTerminalsFace, options: { defaultShell?: string } = {}) {
  const updates: Array<{ tabId: string; patch: { title?: string; meta?: unknown } }> = []
  const opens: Array<{ type: string; target?: string }> = []
  const prefs = {
    ...SIDEBAR_PREFS_DEFAULTS,
    pluginSettings:
      options.defaultShell === undefined
        ? {}
        : { 'terminal-bottom': { defaultShell: options.defaultShell } },
  }
  const ctx = ctxWith({
    webTerminals: terminals,
    betterSidebar: {
      updateTab: (tabId: string, patch: { title?: string; meta?: unknown }) => {
        updates.push({ tabId, patch })
      },
      openTab: (seed: { type: string; target?: string }) => { opens.push(seed) },
      getSnapshot: () => ({ sessionId: 's1', state: {}, prefs }),
      subscribeState: () => () => {},
    },
  })
  return { ctx, updates, opens, prefs }
}

/** The instanced tab the workbench mints (see builtins/tabs.tsx `createTab`). */
function bottomTab(meta?: unknown): SidebarTab {
  return {
    id: 'terminal-bottom:a1', type: 'terminal-bottom', title: 'Terminal',
    ...(meta === undefined ? {} : { meta }),
  }
}

function render(ctx: Context, tab: SidebarTab) {
  return renderRoot(createElement(TerminalBottomView, { ctx, scope: { sessionId: 's1', cwd: '/w' }, tab, visible: true }))
}

/** Flush the microtask queue the memoized `view()`/discovery path schedules. */
async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

/** The switcher's two buttons, in DOM order (the "+" first, the menu trigger second). */
function switcherButtons(container: HTMLElement): HTMLButtonElement[] {
  const layer = container.querySelector('[data-dsh-bottom-terminal-switcher]')
  return layer === null ? [] : [...layer.querySelectorAll('button')]
}

beforeEach(() => {
  // Nothing to reset beyond the per-case doubles; each case builds its own.
})

afterEach(() => {
  for (const element of document.querySelectorAll('body > div')) element.remove()
})

describe('terminal shell switcher: capability gating', () => {
  it('is offered only when the host exposes BOTH optional shell members', () => {
    expect(canSwitchShells(undefined)).toBe(false)
    // A service with the mandatory members but nothing else: still unusable
    // for switching, and that must not be an error.
    expect(canSwitchShells({} as WebTerminalsFace)).toBe(false)
    const full = new FakeTerminals()
    expect(canSwitchShells(full)).toBe(true)
    const partial = { launchShells: async () => ({ shells: [], selectedShell: undefined }) } as unknown as WebTerminalsFace
    expect(canSwitchShells(partial), 'a write without discovery is half a control').toBe(false)
    const writeOnly = { selectShell: () => {} } as unknown as WebTerminalsFace
    expect(canSwitchShells(writeOnly), 'discovery without a write cannot switch').toBe(false)
  })

  it('renders no switcher and discovers nothing on a host without shell discovery', async () => {
    const terminals = new FakeTerminals({ withShells: false })
    const { ctx } = viewSetup(terminals)
    const { container, unmount } = render(ctx, bottomTab())
    await flush()

    expect(switcherButtons(container)).toEqual([])
    expect(terminals.log.filter(entry => entry === 'launchShells')).toEqual([])
    // The terminal itself still works: the point of the optional members.
    expect(terminals.log.some(entry => entry.startsWith('view('))).toBe(true)
    unmount()
  })
})

describe('terminal shell switcher: the control', () => {
  it('discovers shells lazily, only while the menu is open', async () => {
    const terminals = new FakeTerminals()
    const { ctx } = viewSetup(terminals)
    const { container, unmount } = render(ctx, bottomTab())
    await flush()

    const [plus, trigger] = switcherButtons(container)
    expect(plus).toBeDefined()
    expect(trigger).toBeDefined()
    // Rendering the terminal must not pay for a shell probe.
    expect(terminals.log).not.toContain('launchShells')

    await act(async () => { trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    expect(terminals.log).toContain('launchShells')
    unmount()
  })

  it('writes the preference BEFORE closing, and mints a new content identity', async () => {
    const terminals = new FakeTerminals()
    const { ctx, updates } = viewSetup(terminals)
    const { container, unmount } = render(ctx, bottomTab({ terminalInstance: 'a1' }))
    await flush()

    const [, trigger] = switcherButtons(container)
    await act(async () => { trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()

    // The menu portals into the body; its rows are the discovered shells.
    const row = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')]
      .find(candidate => candidate.textContent?.includes(shortShellName('cmd.exe')))
    expect(row, 'the discovered shells are offered as menu rows').toBeDefined()
    await act(async () => { row!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()

    const preference = terminals.log.findIndex(entry => entry.startsWith('selectShell('))
    const close = terminals.log.findIndex(entry => entry.startsWith('close('))
    expect(preference, 'selectShell was called').toBeGreaterThanOrEqual(0)
    expect(close, 'close was called').toBeGreaterThanOrEqual(0)
    // THE ORDER IS THE CONTRACT: a close that ran first would free the slot
    // before the preference landed, and the replacement would start the old
    // shell.
    expect(preference).toBeLessThan(close)
    // The process is closed on the identity currently in use…
    expect(terminals.log[close]).toBe(`close(${bottomTerminalContentId(0, 'a1')})`)
    // …and the tab is asked for the NEXT one (the instance survives the bump).
    expect(updates).toEqual([
      {
        tabId: 'terminal-bottom:a1',
        patch: {
          // The pin rides the same meta write: the replacement occurrence must
          // start the shell that was picked, not the descriptor's default.
          meta: { terminalInstance: 'a1', terminalShell: 'C:\\Windows\\System32\\cmd.exe', terminalRun: 1 },
        },
      },
    ])
    unmount()
  })

  it('the replacement occurrence starts the selected shell', async () => {
    const terminals = new FakeTerminals()
    const { ctx, updates } = viewSetup(terminals)
    const first = render(ctx, bottomTab({ terminalInstance: 'a1' }))
    await flush()
    expect(terminals.views.get('s1\u0000' + bottomTerminalContentId(0, 'a1'))!.state.getSnapshot().info?.shell).toBeUndefined()

    const [, trigger] = switcherButtons(first.container)
    await act(async () => { trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    const row = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')]
      .find(candidate => candidate.textContent?.includes('bash'))
    await act(async () => { row!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()

    // The workbench re-renders the tab from the store with the bumped meta —
    // this is what the switch has to survive.
    const meta = updates.at(-1)!.patch.meta
    first.unmount()
    const second = render(ctx, bottomTab(meta))
    await flush()

    const replacement = terminals.views.get('s1\u0000' + bottomTerminalContentId(1, 'a1'))
    expect(replacement, 'a NEW occurrence was allocated').toBeDefined()
    expect(replacement!.state.getSnapshot().info?.shell?.name).toBe('bash')
    second.unmount()
  })

  it('retries a failed discovery instead of selecting its error row', async () => {
    const terminals = new FakeTerminals()
    let attempts = 0
    terminals.launchShells = async (): Promise<HostShellCatalog> => {
      attempts += 1
      if (attempts === 1) throw new Error('probe failed')
      return { shells: terminals.shells, selectedShell: undefined }
    }
    const { ctx, updates } = viewSetup(terminals)
    const { container, unmount } = render(ctx, bottomTab())
    await flush()

    const [, trigger] = switcherButtons(container)
    await act(async () => { trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    const retry = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')]
      .find(candidate => candidate.textContent?.includes(t('retry')))
    expect(retry, 'a failed probe offers a retry row').toBeDefined()
    await act(async () => { retry!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()

    // The retry re-ran discovery — it did NOT switch the shell to an error id.
    expect(attempts).toBe(2)
    expect(updates).toEqual([])
    expect(terminals.log.some(entry => entry.startsWith('selectShell('))).toBe(false)
    unmount()
  })

  it('the "+" half opens a SIBLING bottom tab instead of rebuilding this one', async () => {
    const terminals = new FakeTerminals()
    const { ctx, opens, updates } = viewSetup(terminals)
    const { container, unmount } = render(ctx, bottomTab())
    await flush()

    const [plus] = switcherButtons(container)
    await act(async () => { plus!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()

    expect(opens).toEqual([{ type: 'terminal-bottom', target: 'bottom' }])
    // A new tab means the descriptor mints it — nothing about THIS tab changed.
    expect(updates).toEqual([])
    unmount()
  })
})

describe('terminal shell switcher: the tab title', () => {
  it('follows the shell the host reports, normalized for a chip', async () => {
    const terminals = new FakeTerminals()
    const { ctx, updates } = viewSetup(terminals)
    const { unmount } = render(ctx, bottomTab())
    await flush()

    const view = terminals.views.get('s1\u0000' + bottomTerminalContentId(0))!
    await act(async () => {
      view.patch({
        info: {
          id: view.id, title: 'Terminal', cwd: '/w', cols: 80, rows: 24,
          state: 'running', exitCode: null,
          shell: { path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', name: 'powershell.exe', args: [] },
        },
      })
    })
    await flush()

    // `powershell.exe` reads as `pwsh` on a chip; the title carries the name.
    expect(shortShellName('powershell.exe')).toBe('pwsh')
    expect(shortShellName('cmd.exe')).toBe('cmd')
    expect(updates.map(update => update.patch.title)).toEqual([t('terminalTitleWithShell', { name: 'pwsh' })])
    unmount()
  })

  it('does not rewrite the title when the shell has not changed', async () => {
    const terminals = new FakeTerminals()
    const { ctx, updates } = viewSetup(terminals)
    const shell = { path: '/bin/bash', name: 'bash', args: [] }
    const title = t('terminalTitleWithShell', { name: 'bash' })
    const { unmount } = render(ctx, { ...bottomTab(), title })
    await flush()

    const view = terminals.views.get('s1\u0000' + bottomTerminalContentId(0))!
    await act(async () => {
      view.patch({
        info: { id: view.id, title: 'Terminal', cwd: '/w', cols: 80, rows: 24, state: 'running', exitCode: null, shell },
      })
    })
    await flush()
    // Already correct: a remount must not churn the persisted layout.
    expect(updates).toEqual([])
    unmount()
  })

  it('leaves the title alone when the host does not disclose a shell', async () => {
    const terminals = new FakeTerminals()
    const { ctx, updates } = viewSetup(terminals)
    const { unmount } = render(ctx, bottomTab())
    await flush()
    expect(updates).toEqual([])
    unmount()
  })
})

describe('terminal shell switcher: the descriptor default shell', () => {
  it('starts an unpinned tab on the default shell, resolved to its PATH', async () => {
    const terminals = new FakeTerminals()
    const { ctx } = viewSetup(terminals, { defaultShell: 'cmd' })
    const { unmount } = render(ctx, bottomTab())
    await flush()

    // The default is stored as a NAME so it survives a re-install, but the host
    // starts only a path from its own discovery result — the view has to resolve
    // one into the other before it allocates anything.
    expect(terminals.log.filter(entry => entry === 'launchShells')).toHaveLength(1)
    const view = terminals.views.get('s1\u0000' + bottomTerminalContentId(0))!
    expect(view.state.getSnapshot().info?.shell?.name).toBe('cmd.exe')
    unmount()
  })

  it('matches the default by SHORT name, so "powershell" and "pwsh" agree', async () => {
    // `shortShellName` maps both spellings onto `pwsh`, and the host reports
    // `powershell.exe`; a name stored under either spelling has to find it.
    const catalog: HostShellCatalog = {
      shells: [{ path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', name: 'powershell.exe', args: [] }],
      selectedShell: undefined,
    }
    expect(matchShellPath(catalog, 'powershell')).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(matchShellPath(catalog, 'pwsh')).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(matchShellPath(catalog, 'PowerShell')).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(matchShellPath(catalog, 'zsh')).toBeUndefined()
    expect(matchShellPath(undefined, 'pwsh')).toBeUndefined()
  })

  it('lets a pinned tab ignore the descriptor default', async () => {
    const terminals = new FakeTerminals()
    const { ctx } = viewSetup(terminals, { defaultShell: 'cmd' })
    // A tab the switcher rebuilt carries its own pin; that pick must survive a
    // later change of the default rather than be overwritten by it.
    const pinned = bottomTab({ terminalInstance: 'a1', terminalShell: '/bin/bash' })
    expect(terminalShellOf(pinned)).toBe('/bin/bash')
    const { unmount } = render(ctx, pinned)
    await flush()

    expect(terminals.log, 'a pin answers the question, so nothing is discovered').not.toContain('launchShells')
    const view = terminals.views.get('s1\u0000' + bottomTerminalContentId(0, 'a1'))!
    expect(view.state.getSnapshot().info?.shell?.name).toBe('bash')
    unmount()
  })

  it('spends no discovery round trip when no default is configured', async () => {
    // The common case: the host's own remembered shell decides, exactly as it
    // did before this setting existed.
    const terminals = new FakeTerminals()
    const { ctx } = viewSetup(terminals)
    const { unmount } = render(ctx, bottomTab())
    await flush()
    expect(terminals.log).not.toContain('launchShells')
    expect(terminals.views.get('s1\u0000' + bottomTerminalContentId(0))).toBeDefined()
    unmount()
  })

  it('falls back to the host choice when the default names nothing discoverable', async () => {
    const terminals = new FakeTerminals()
    const { ctx } = viewSetup(terminals, { defaultShell: 'nu' })
    const { unmount } = render(ctx, bottomTab())
    await flush()

    // The candidate was removed (or was never installed): the terminal must
    // still open, on whatever the host would have picked on its own.
    const view = terminals.views.get('s1\u0000' + bottomTerminalContentId(0))!
    expect(view, 'the terminal is allocated anyway').toBeDefined()
    expect(view.state.getSnapshot().info?.shell).toBeUndefined()
    unmount()
  })

  it('falls back when discovery itself fails', async () => {
    const terminals = new FakeTerminals()
    terminals.launchShells = async (): Promise<HostShellCatalog> => {
      terminals.log.push('launchShells')
      throw new Error('probe failed')
    }
    const { ctx } = viewSetup(terminals, { defaultShell: 'bash' })
    const { unmount } = render(ctx, bottomTab())
    await flush()

    // A failed probe is not worth an error panel: there is still a shell to run.
    expect(terminals.views.get('s1\u0000' + bottomTerminalContentId(0))).toBeDefined()
    expect(terminals.log.filter(entry => entry === 'launchShells')).toHaveLength(1)
    unmount()
  })
})
