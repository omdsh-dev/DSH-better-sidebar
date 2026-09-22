/**
 * `service.syncAgentTerminals` — the NATIVE half of agent-terminal placement
 * (v0.19.2): right-targeted push entries become native right-Sidebar tabs
 * keyed by the plugin's `agent:<uuid>` wire contract, opened once per push
 * and closed when their uuid leaves the list; bottom-targeted (and legacy
 * no-target) entries are the store reconcile's business and must be ignored
 * here. The native surface is faked (records appear synchronously so
 * `surface.has` reflects an open immediately); the real surface's pending /
 * synthetic-id resolution is covered by native-agent-tab.spec.ts.
 */
import { describe, expect, it } from 'vitest'
import { createBetterSidebarService, type SidebarSurface } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'

/** A fake native surface whose opens land synchronously in its records. */
function fakeSurface(): {
  surface: SidebarSurface & { entries(): ReadonlyArray<{ nativeId: string; tabId: string }> }
  opens: Array<{ sessionId: string; kind: string; params: { id?: string; title?: string }; revealIfOpened: boolean }>
  closes: string[]
} {
  const opens: Array<{ sessionId: string; kind: string; params: { id?: string; title?: string }; revealIfOpened: boolean }> = []
  const closes: string[] = []
  const records = new Map<string, string>() // nativeId → synthetic tabId
  let seq = 0
  const nativeIdOf = (tabId: string): string | undefined => {
    for (const [nativeId, id] of records) if (id === tabId) return nativeId
    return undefined
  }
  const surface = {
    openTab(input: { sessionId: string; kind: string; params: { id?: string; title?: string }; revealIfOpened: boolean }): void {
      opens.push(input)
      const nativeId = `native-${++seq}`
      records.set(nativeId, input.params.id ?? nativeId)
    },
    openResource(): void {},
    fileAddress: (_sessionId: string, _cwd: string | undefined, path: string): string => `dsh-resource://file${path}`,
    close(_sessionId: string, tabId: string): { type: string; title: string } | undefined {
      const nativeId = nativeIdOf(tabId)
      if (nativeId === undefined) return undefined
      records.delete(nativeId)
      closes.push(nativeId)
      return { type: 'terminal', title: 'terminal' }
    },
    update: (): boolean => false,
    activate: (tabId: string): boolean => nativeIdOf(tabId) !== undefined,
    has: (tabId: string): boolean => nativeIdOf(tabId) !== undefined,
    entries: (): Array<{ nativeId: string; tabId: string }> =>
      [...records].map(([nativeId, tabId]) => ({ nativeId, tabId })),
  } satisfies SidebarSurface & { entries(): ReadonlyArray<{ nativeId: string; tabId: string }> }
  return { surface, opens, closes }
}

/** A service with a terminal descriptor and an installed fake surface. */
function mount(options?: { quota?: boolean }): {
  service: ReturnType<typeof createBetterSidebarService>
  opens: Array<{ sessionId: string; kind: string; params: { id?: string; title?: string }; revealIfOpened: boolean }>
  closes: string[]
} {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  const { surface, opens, closes } = fakeSurface()
  service.setSurface(surface)
  service.registerTab({
    id: 'terminal',
    title: 'Terminal',
    component: () => null,
    // The UI-quota factory: agent seeds must bypass it entirely (it would
    // mint a `terminal:<uuid>` id and can refuse at capacity).
    createTab: options?.quota === true
      ? () => null
      : (state) => ({
        tab: { id: `terminal:${state.nextTerminal}`, type: 'terminal', title: 'Shell' },
        patch: { nextTerminal: state.nextTerminal + 1 },
      }),
  })
  return { service, opens, closes }
}

describe('service.syncAgentTerminals (v0.19.2 native placement)', () => {
  it('opens each right-targeted entry once as a native terminal tab keyed agent:<uuid>', () => {
    const { service, opens } = mount()
    service.syncAgentTerminals(
      [{ uuid: 'u-1', title: 'dev server', target: 'right' }, { uuid: 'u-2', title: 'watcher', target: 'right' }],
      { sessionId: 's1' },
    )
    expect(opens.map(o => o.params.id)).toEqual(['agent:u-1', 'agent:u-2'])
    expect(opens.every(o => o.kind === 'terminal' && o.sessionId === 's1')).toBe(true)
    expect(opens.map(o => o.params.title)).toEqual(['dev server', 'watcher'])
  })

  it('is idempotent: re-observing the same push does not open a second tab', () => {
    const { service, opens } = mount()
    const list = [{ uuid: 'u-1', title: 'dev server', target: 'right' as const }]
    service.syncAgentTerminals(list, { sessionId: 's1' })
    service.syncAgentTerminals(list, { sessionId: 's1' })
    service.syncAgentTerminals(list, { sessionId: 's1' })
    expect(opens).toHaveLength(1)
  })

  it('closes the native tab when its uuid leaves the push list', () => {
    const { service, closes } = mount()
    service.syncAgentTerminals([{ uuid: 'u-1', title: 'dev server', target: 'right' }], { sessionId: 's1' })
    expect(closes).toHaveLength(0)
    service.syncAgentTerminals([], { sessionId: 's1' })
    expect(closes).toHaveLength(1)
    // Gone for good: the next empty push closes nothing more.
    service.syncAgentTerminals([], { sessionId: 's1' })
    expect(closes).toHaveLength(1)
  })

  it('ignores bottom-targeted and legacy (no-target) entries entirely', () => {
    const { service, opens, closes } = mount()
    service.syncAgentTerminals(
      [{ uuid: 'u-1', title: 'bottom', target: 'bottom' }, { uuid: 'u-2', title: 'legacy' }],
      { sessionId: 's1' },
    )
    expect(opens).toHaveLength(0)
    expect(closes).toHaveLength(0)
  })

  it('opens an agent terminal even while the UI-terminal quota factory refuses', () => {
    // The terminal descriptor's createTab returns null (3 UI terminals open).
    // An agent seed must still land — it owns its id and is uncapped.
    const { service, opens } = mount({ quota: true })
    service.syncAgentTerminals([{ uuid: 'u-1', title: 'dev server', target: 'right' }], { sessionId: 's1' })
    expect(opens).toHaveLength(1)
    expect(opens[0]?.params.id).toBe('agent:u-1')
  })

  it('is a no-op without an installed native surface', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    const opens: unknown[] = []
    expect(() => service.syncAgentTerminals([{ uuid: 'u-1', title: 'x', target: 'right' }], { sessionId: 's1' })).not.toThrow()
    expect(opens).toHaveLength(0)
  })

  it('reopens a right tab the user closed while the agent keeps the pty alive', () => {
    const { service, opens, closes } = mount()
    const list = [{ uuid: 'u-1', title: 'dev server', target: 'right' as const }]
    service.syncAgentTerminals(list, { sessionId: 's1' })
    // Simulate the user closing the native tab: the record drops (its
    // unmount sends the WS close frame → the pty dies → the next push
    // drops the uuid too — but BETWEEN those events a push may still carry
    // it, and the tab then reopens: the agent owns the lifetime until the
    // host says otherwise).
    service.syncAgentTerminals([], { sessionId: 's1' }) // host dropped it
    expect(closes).toHaveLength(1)
    service.syncAgentTerminals(list, { sessionId: 's1' }) // uuid came back
    expect(opens).toHaveLength(2)
  })
})
