/** Source setup is actionable in place, shared with settings, and stops when hidden. */
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactElement } from 'react'
import { act } from 'react-dom/test-utils'
import { SourceReadiness } from '../src/client/clues/sources/readiness.tsx'
import { publishClueStatuses, publishClueTask } from '../src/client/clues/settings/runtime-state.ts'
import { clueRuntimeApi, type ClueRuntimeApi } from '../src/client/clues/runtime-api.ts'
import { invalidateClueRequests } from '../src/client/clues/request-cache.ts'
import type { ConnectionStatusProjection, DependencyStatus } from '../src/clues/runtime/types.ts'
import type { ClueSourceDescriptor } from '../src/clues/types.ts'
import type { WindowOpenOptions } from '../src/client/windows/types.ts'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'

setupReactAct()
beforeAll(() => { Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true }) })
beforeEach(() => { invalidateClueRequests() })
const views: RenderedRoot[] = []
afterEach(() => {
  for (const view of views.splice(0)) view.unmount()
  invalidateClueRequests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const source: ClueSourceDescriptor = {
  sourceId: 'test.docs', name: 'Test Docs', pluginId: 'test', order: 0, types: [], transport: 'cli',
  dependencyIds: ['test.cli'], connectionId: 'test.account',
  capabilities: { resolve: true, list: true, search: true, read: true, edit: true, portable: true },
}
const dependency: DependencyStatus = {
  dependencyId: 'test.cli', name: 'Test CLI', command: 'test', state: 'missing',
  platform: 'darwin', arch: 'arm64', supported: true, installable: true,
  minimumVersion: '1.0.0', recommendedVersion: '1.0.0',
}
const connection: ConnectionStatusProjection = {
  connectionId: 'test.account', name: 'Test Account', pluginId: 'test', configuration: 'ready',
  authorization: 'ready', credentialOwner: 'tool', capabilities: [], action: 'none',
}
function fixture(runtimeOverride?: ClueRuntimeApi) {
  const runtime = runtimeOverride ?? {
    dependenciesInspect: vi.fn(async () => [dependency]),
    connectionsStatus: vi.fn(async () => [connection]),
    dependenciesStart: vi.fn(),
    connectionsConnect: vi.fn(),
  } as unknown as ClueRuntimeApi
  const opened: WindowOpenOptions[] = []
  const windows = { open: (options: WindowOpenOptions) => {
    opened.push(options)
    return { id: options.id, update: vi.fn(), focus: vi.fn(), close: async () => {}, navigation: {} as never }
  } }
  const onReady = vi.fn()
  const node = (visible = true, descriptor = source) => createElement(SourceReadiness, {
    source: descriptor, windows, visible, runtime, onReady,
  })
  const mount = (visible = true, descriptor = source) => {
    const view = renderRoot(node(visible, descriptor)); views.push(view); return view
  }
  return { runtime, opened, onReady, node, mount }
}
async function flush() { await act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve() }) }
function button(view: RenderedRoot, text: string): HTMLButtonElement {
  const result = [...view.container.querySelectorAll('button')].find(node => node.textContent === text)
  if (result === undefined) throw new Error(`Missing button: ${text}`)
  return result
}

describe('in-place source readiness', () => {
  it('does not probe local sources without setup needs or native-hidden sources', async () => {
    const fx = fixture()
    fx.mount(true, { ...source, dependencyIds: [], connectionId: undefined })
    fx.mount(false)
    await flush()
    expect(fx.runtime.dependenciesInspect).not.toHaveBeenCalled()
    expect(fx.runtime.connectionsStatus).not.toHaveBeenCalled()
  })

  it('names the missing dependency and opens that source directly with install intent', async () => {
    const fx = fixture(); const view = fx.mount(); await flush()
    expect(view.container.querySelector('[data-clue-readiness="missing"]')).not.toBeNull()
    act(() => { button(view, 'One-click install').click() })
    expect(fx.opened).toHaveLength(1)
    expect(fx.opened[0]).toMatchObject({ id: 'clue-source:test.docs', bodyLayout: 'fill' })
    expect((fx.opened[0]!.content as ReactElement<{ initialAction: string }>).props.initialAction).toBe('install')
    expect(fx.runtime.dependenciesStart).not.toHaveBeenCalled()
    expect(fx.runtime.connectionsConnect).not.toHaveBeenCalled()
  })

  it('inserts no checking row while the first probe is in flight', async () => {
    const fx = fixture()
    vi.mocked(fx.runtime.dependenciesInspect).mockImplementation(() => new Promise(() => {}))
    vi.mocked(fx.runtime.connectionsStatus).mockImplementation(() => new Promise(() => {}))
    const view = fx.mount()
    await flush()
    // A probe is invisible until it has a real next step; showing a spinner
    // row here would move the search box that sits right below it.
    expect(view.container.textContent).toBe('')
    expect(view.container.querySelector('[data-clue-checking]')).toBeNull()
    act(() => { publishClueStatuses(fx.runtime, [dependency], [connection]) })
    expect(view.container.querySelector('[data-clue-readiness="missing"]')).not.toBeNull()
    expect(view.container.textContent).toContain('Test CLI')
  })

  it('offers configuration after a completed observation whose authorization is still unknown', async () => {
    const fx = fixture()
    vi.mocked(fx.runtime.dependenciesInspect).mockResolvedValue([{ ...dependency, state: 'ready' }])
    vi.mocked(fx.runtime.connectionsStatus).mockResolvedValue([{ ...connection, authorization: 'unknown' }])
    const view = fx.mount(); await flush()
    expect(view.container.querySelector('[data-clue-readiness="unchecked"]')).not.toBeNull()
    expect(button(view, 'Configure')).toBeDefined()
    expect(view.container.textContent).not.toContain('Loading')
  })

  it('offers authorization instead of installing again when only account access is missing', async () => {
    const fx = fixture()
    vi.mocked(fx.runtime.dependenciesInspect).mockResolvedValue([{ ...dependency, state: 'ready' }])
    vi.mocked(fx.runtime.connectionsStatus).mockResolvedValue([{ ...connection, authorization: 'not-authorized' }])
    const view = fx.mount(); await flush()
    act(() => { button(view, 'Authorize').click() })
    expect((fx.opened[0]!.content as ReactElement<{ initialAction?: string }>).props.initialAction).toBeUndefined()
    expect(fx.runtime.connectionsConnect).not.toHaveBeenCalled()
  })

  it('adopts newer setup observations and refreshes once without a stale probe restoring the failure', async () => {
    const fx = fixture()
    let finish!: (value: readonly DependencyStatus[]) => void
    vi.mocked(fx.runtime.dependenciesInspect).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const view = fx.mount(); await flush()
    act(() => { publishClueStatuses(fx.runtime, [dependency], [connection]) })
    expect(view.container.querySelector('[data-clue-readiness="missing"]')).not.toBeNull()
    act(() => { publishClueStatuses(fx.runtime, [{ ...dependency, state: 'ready' }], [connection]) })
    await flush()
    expect(fx.onReady).toHaveBeenCalledTimes(1)
    expect(view.container.textContent).toBe('')
    await act(async () => { finish([dependency]) })
    expect(fx.onReady).toHaveBeenCalledTimes(1)
    expect(view.container.textContent).toBe('')
  })

  it('does not claim a missing install after a probe failure, and retry can recover', async () => {
    const fx = fixture()
    vi.mocked(fx.runtime.dependenciesInspect).mockRejectedValueOnce(new Error('offline'))
    const view = fx.mount(); await flush()
    expect(view.container.querySelector('[data-clue-readiness="request-failed"]')).not.toBeNull()
    expect(view.container.querySelector('[data-clue-readiness="missing"]')).toBeNull()
    act(() => { button(view, 'Retry').click() }); await flush()
    expect(view.container.querySelector('[data-clue-readiness="missing"]')).not.toBeNull()
    expect(fx.runtime.dependenciesInspect).toHaveBeenLastCalledWith({ dependencyId: 'test.cli', refresh: true }, expect.any(AbortSignal))
    expect(fx.runtime.connectionsStatus).toHaveBeenLastCalledWith('test.account', expect.any(AbortSignal), true)
  })

  it('keeps the actionable missing-tool state when authorization cannot be checked yet', async () => {
    const fx = fixture()
    vi.mocked(fx.runtime.connectionsStatus).mockRejectedValue(new Error('tool unavailable'))
    const view = fx.mount(); await flush()
    expect(view.container.querySelector('[data-clue-readiness="missing"]')).not.toBeNull()
    expect(view.container.textContent).toContain('Test CLI')
    expect(button(view, 'One-click install')).toBeDefined()
  })

  it('keeps a running installation visible until a fresh terminal recheck completes', async () => {
    const fx = fixture()
    let finish!: (value: readonly DependencyStatus[]) => void
    vi.mocked(fx.runtime.dependenciesInspect).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValue([{ ...dependency, state: 'ready' }])
    const view = fx.mount(); await flush()
    const task = {
      taskId: 'install-1', dependencyId: dependency.dependencyId, planId: 'plan-1', version: '1.0.0',
      platform: 'darwin', arch: 'arm64', targetDir: '/managed/test', startedAt: '2026-10-20T00:00:00Z',
    }
    act(() => { publishClueTask(fx.runtime, { ...task, state: 'running' }) })
    await act(async () => { finish([{ ...dependency, state: 'ready' }]) })
    expect(view.container.querySelector('[data-clue-readiness="installing"]')).not.toBeNull()
    expect(fx.onReady).not.toHaveBeenCalled()
    act(() => { publishClueTask(fx.runtime, { ...task, state: 'succeeded' }) }); await flush()
    expect(view.container.textContent).toBe('')
    expect(fx.onReady).toHaveBeenCalledTimes(1)
    expect(fx.runtime.dependenciesInspect).toHaveBeenCalledTimes(2)
    expect(fx.runtime.dependenciesInspect).toHaveBeenLastCalledWith({ dependencyId: 'test.cli', refresh: true }, expect.any(AbortSignal))
    expect(fx.runtime.connectionsStatus).toHaveBeenLastCalledWith('test.account', expect.any(AbortSignal), true)
  })

  it('reuses shared runtime observations when configuration opens and closes without a change', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({ ok: true, value: url.includes('dependencies.inspect')
        ? { dependencies: [dependency] } : { connections: [connection] } }),
    } as Response))
    vi.stubGlobal('fetch', fetch)
    const fx = fixture(clueRuntimeApi); const view = fx.mount(); await flush()
    for (let index = 0; index < 3; index++) {
      act(() => { button(view, 'One-click install').click() })
      act(() => { fx.opened[index]!.onClose?.() }); await flush()
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    }
    expect(fetch.mock.calls.filter(([url]) => url.includes('dependencies.inspect'))).toHaveLength(1)
    expect(fetch.mock.calls.filter(([url]) => url.includes('connections.status'))).toHaveLength(1)
    expect(view.container.querySelector('[data-clue-readiness="missing"]')).not.toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reads fresh state on config close after a real CLI path action invalidates the cache', async () => {
    let ready = false
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('dependencies.setPath')) ready = true
      const status = { ...dependency, state: ready ? 'ready' : 'missing' }
      const value = url.includes('dependencies.inspect') ? { dependencies: [status] }
        : url.includes('dependencies.setPath') ? { dependency: status } : { connections: [connection] }
      return { ok: true, json: async () => ({ ok: true, value }) } as Response
    })
    vi.stubGlobal('fetch', fetch)
    const fx = fixture(clueRuntimeApi); const view = fx.mount(); await flush()
    act(() => { button(view, 'One-click install').click() })
    await act(async () => { await clueRuntimeApi.dependenciesSetPath('test.cli', '/usr/bin/test') })
    act(() => { fx.opened[0]!.onClose?.() }); await flush()
    expect(fetch.mock.calls.filter(([url]) => url.includes('dependencies.inspect'))).toHaveLength(2)
    // A dependency path change only evicts the dependency probe; the account
    // status read is not silently invalidated with it.
    expect(fetch.mock.calls.filter(([url]) => url.includes('connections.status'))).toHaveLength(1)
    expect(view.container.textContent).toBe('')
    expect(fx.onReady).toHaveBeenCalledTimes(1)
  })

  it('reuses the real runtime wire read when the source returns after 4.9 seconds', async () => {
    vi.useFakeTimers()
    let finish!: (response: Response) => void
    let inspectSignal: AbortSignal | undefined
    const fetch = vi.fn((url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes('dependencies.inspect')) {
        inspectSignal = init?.signal ?? undefined
        return new Promise(resolve => { finish = resolve })
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: { connections: [connection] } }) } as Response)
    })
    vi.stubGlobal('fetch', fetch)
    const fx = fixture(clueRuntimeApi)
    const view = fx.mount(); await flush()
    view.rerender(fx.node(false)); await flush()
    expect(inspectSignal?.aborted).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(4900) })
    view.rerender(fx.node(true)); await flush()
    expect(fetch.mock.calls.filter(([url]) => url.includes('dependencies.inspect'))).toHaveLength(1)
    expect(fetch.mock.calls.filter(([url]) => url.includes('connections.status'))).toHaveLength(1)
    await act(async () => {
      finish({ ok: true, json: async () => ({ ok: true, value: { dependencies: [{ ...dependency, state: 'ready' }] } }) } as Response)
    })
    await flush()
    expect(view.container.textContent).toBe('')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts a pending inspection when its native tab becomes hidden', async () => {
    const fx = fixture()
    let signal: AbortSignal | undefined
    vi.mocked(fx.runtime.dependenciesInspect).mockImplementation((_input, next) => {
      signal = next; return new Promise(() => {})
    })
    const view = fx.mount(); await flush()
    expect(signal?.aborted).toBe(false)
    view.rerender(fx.node(false))
    expect(signal?.aborted).toBe(true)
  })
})
