import { describe, expect, it } from 'vitest'
import { registerOpenPathInterception } from '../src/client/intercept.tsx'
import {
  isFolderRevealPath,
  wrapOpenWorkspacePath,
  type OpenPathInterceptDeps,
  type OpenWorkspacePathService,
} from '../src/client/openpath-intercept.ts'
import { createSidebarStore } from '../src/client/state.ts'
import type { Context } from '../src/context-types.ts'

/**
 * A fake of the gateway client's RemoteNamespaceService: the method is an
 * ACCESSOR property (getter returning the invocation closure), exactly like
 * `Object.defineProperty(service, method, { configurable: true, get })` in
 * the real implementation — the wrapper must shadow it with a data property
 * and restore the accessor on dispose.
 */
function fakeNamespaceService(opened: string[]): OpenWorkspacePathService {
  const target = {} as Record<string, unknown>
  Object.defineProperty(target, 'openWorkspacePath', {
    configurable: true,
    enumerable: true,
    get() {
      return async (request: { path: string }) => {
        opened.push(request.path)
        return { ok: true, value: { opened: true } } as const
      }
    },
  })
  return target as unknown as OpenWorkspacePathService
}

describe('open-path interception (wrapOpenWorkspacePath)', () => {
  const deps = (overrides: Partial<OpenPathInterceptDeps> = {}): OpenPathInterceptDeps & {
    sidebar: string[]
    revealed: string[]
  } => {
    const sidebar: string[] = []
    const revealed: string[] = []
    return {
      sidebar,
      revealed,
      takeoverEnabled: () => true,
      currentSessionId: () => 's1',
      openInSidebar: (path, sessionId) => { sidebar.push(`${sessionId}:${path}`) },
      revealInExplorer: (path, sessionId) => { revealed.push(`${sessionId}:${path}`) },
      ...overrides,
    }
  }

  it('routes an intercepted open into the sidebar and resolves with the remote success envelope', async () => {
    const opened: string[] = []
    const service = fakeNamespaceService(opened)
    const d = deps()
    const restore = wrapOpenWorkspacePath(service, d)
    // The caller (ChatView's openFile) branches on `result.ok` and reads
    // `result.error.message` on falsy — a bare business value would surface
    // as a bogus "cannot open" dialog.
    await expect(service.openWorkspacePath({ path: '/abs/a.ts' }))
      .resolves.toEqual({ ok: true, value: { opened: true } })
    expect(opened).toEqual([])
    expect(d.sidebar).toEqual(['s1:/abs/a.ts'])
    restore()
  })

  it('falls through to the original when the takeover is disabled', async () => {
    const opened: string[] = []
    const service = fakeNamespaceService(opened)
    const d = deps({ takeoverEnabled: () => false })
    const restore = wrapOpenWorkspacePath(service, d)
    await service.openWorkspacePath({ path: '/abs/a.ts' })
    expect(opened).toEqual(['/abs/a.ts'])
    expect(d.sidebar).toEqual([])
    restore()
  })

  it('falls through when no session is current (nothing to scope the editor load to)', async () => {
    const opened: string[] = []
    const service = fakeNamespaceService(opened)
    const d = deps({ currentSessionId: () => undefined })
    const restore = wrapOpenWorkspacePath(service, d)
    await service.openWorkspacePath({ path: '/abs/a.ts' })
    expect(opened).toEqual(['/abs/a.ts'])
    expect(d.sidebar).toEqual([])
    restore()
  })

  it('passes the current session into the sidebar opener', async () => {
    const opened: string[] = []
    const service = fakeNamespaceService(opened)
    let current = 's1'
    const d = deps({ currentSessionId: () => current })
    const restore = wrapOpenWorkspacePath(service, d)
    await service.openWorkspacePath({ path: '/abs/a.ts' })
    current = 's2'
    await service.openWorkspacePath({ path: '/abs/b.ts' })
    expect(d.sidebar).toEqual(['s1:/abs/a.ts', 's2:/abs/b.ts'])
    restore()
  })

  it('routes the folder-reveal gesture to the explorer, not the editor', async () => {
    const opened: string[] = []
    const service = fakeNamespaceService(opened)
    const d = deps()
    const restore = wrapOpenWorkspacePath(service, d)
    for (const path of ['.', './', '/w/.', 'C:\\w\\.']) {
      await service.openWorkspacePath({ path })
    }
    expect(opened).toEqual([])
    expect(d.sidebar).toEqual([])
    expect(d.revealed).toEqual(['s1:.', 's1:./', 's1:/w/.', 's1:C:\\w\\.'])
    restore()
  })

  it('restores the original accessor on dispose (HMR-safe)', async () => {
    const opened: string[] = []
    const service = fakeNamespaceService(opened)
    const before = Object.getOwnPropertyDescriptor(service, 'openWorkspacePath')
    expect(typeof before?.get).toBe('function')
    const d = deps()
    const restore = wrapOpenWorkspacePath(service, d)
    // While wrapped, the property is our data-property shadow.
    const during = Object.getOwnPropertyDescriptor(service, 'openWorkspacePath')
    expect(during?.get).toBeUndefined()
    expect(typeof during?.value).toBe('function')
    restore()
    const after = Object.getOwnPropertyDescriptor(service, 'openWorkspacePath')
    expect(typeof after?.get).toBe('function')
    await service.openWorkspacePath({ path: '/abs/a.ts' })
    expect(opened).toEqual(['/abs/a.ts'])
    expect(d.sidebar).toEqual([])
  })

  it('propagates a rejection from the original (no swallowing)', async () => {
    const target = {} as Record<string, unknown>
    Object.defineProperty(target, 'openWorkspacePath', {
      configurable: true,
      enumerable: true,
      get: () => async () => { throw new Error('host refused') },
    })
    const service = target as unknown as OpenWorkspacePathService
    const d = deps({ takeoverEnabled: () => false })
    const restore = wrapOpenWorkspacePath(service, d)
    await expect(service.openWorkspacePath({ path: '/abs/a.ts' })).rejects.toThrow('host refused')
    restore()
  })

  it('declines to wrap when the method is not installed (hand-rolled composition)', async () => {
    const service = {} as OpenWorkspacePathService
    const d = deps()
    const restore = wrapOpenWorkspacePath(service, d)
    expect(service.openWorkspacePath).toBeUndefined()
    expect(d.sidebar).toEqual([])
    restore()
  })
})

describe('isFolderRevealPath', () => {
  it('recognizes the dot gestures on both separator styles', () => {
    expect(isFolderRevealPath('.')).toBe(true)
    expect(isFolderRevealPath('./')).toBe(true)
    expect(isFolderRevealPath('/w/.')).toBe(true)
    expect(isFolderRevealPath('/w/./')).toBe(true)
    expect(isFolderRevealPath('C:\\w\\.')).toBe(true)
    expect(isFolderRevealPath('/w/a.ts')).toBe(false)
    expect(isFolderRevealPath('/w/.hidden')).toBe(false)
  })
})

describe('open-path interception wiring', () => {
  /**
   * A client-context fake whose `inject` mimics cordis: the callback runs
   * once the dependency appears (here: when `mount()` is called) and its
   * effects dispose with the fiber.
   */
  function fakeCtx(opened: Array<Record<string, unknown>>, remoteSession: OpenWorkspacePathService) {
    let effectDisposer: (() => void) | undefined
    let injectCallback: ((fctx: unknown) => void) | undefined
    const fctx = {
      get: (name: string) => (name === 'remote.session' ? remoteSession : undefined),
      effect: (fn: () => () => void) => { effectDisposer = fn() },
    }
    const ctx = {
      sessions: {
        list: { getSnapshot: () => ({ current: 's1', byId: { s1: { cwd: '/w' } } }) },
      },
      get: (name: string) => name === 'betterSidebar'
        ? { openTab: (seed: unknown) => { opened.push(seed as Record<string, unknown>) } }
        : undefined,
      inject: (_deps: string[], callback: (fctx: unknown) => void) => {
        injectCallback = callback
        return {
          dispose: async () => { effectDisposer?.() },
        }
      },
      /** Test helper: simulate the namespace service appearing. */
      mount: () => { injectCallback?.(fctx) },
    }
    return ctx
  }

  it('registers through ctx.inject and routes chat opens into the editor tab', async () => {
    const opened: Array<Record<string, unknown>> = []
    const hostOpened: string[] = []
    const remoteSession = fakeNamespaceService(hostOpened)
    const ctx = fakeCtx(opened, remoteSession)
    const store = createSidebarStore()
    const restore = registerOpenPathInterception(ctx as unknown as Context, store)

    // Before the namespace mounts, nothing is wrapped.
    expect(Object.getOwnPropertyDescriptor(remoteSession, 'openWorkspacePath')?.get).toBeDefined()
    ctx.mount()

    // Default prefs: the takeover routes the open into the sidebar editor
    // with the session-scoped absolute path (chat already resolved it).
    await remoteSession.openWorkspacePath({ path: '/w/src/a.ts' })
    expect(opened).toEqual([{
      type: 'editor',
      title: 'a.ts',
      path: '/w/src/a.ts',
      id: 'editor:/w/src/a.ts',
    }])
    expect(hostOpened).toEqual([])

    // The interceptOpenPath pref off → the original funnel runs untouched.
    store.setPrefs({ ...store.getPrefs(), interceptOpenPath: false })
    await remoteSession.openWorkspacePath({ path: '/w/src/b.ts' })
    expect(hostOpened).toEqual(['/w/src/b.ts'])
    expect(opened).toHaveLength(1)

    // The editor tab disabled → falls through too (an editor that cannot
    // open must not swallow opens).
    store.setPrefs({ ...store.getPrefs(), interceptOpenPath: true, tabsEnabled: { editor: false } })
    await remoteSession.openWorkspacePath({ path: '/w/src/c.ts' })
    expect(hostOpened).toEqual(['/w/src/b.ts', '/w/src/c.ts'])

    // Disposal restores the accessor (HMR-safe).
    restore()
    const descriptor = Object.getOwnPropertyDescriptor(remoteSession, 'openWorkspacePath')
    expect(typeof descriptor?.get).toBe('function')
  })

  it('re-applies the shadow when the namespace service is remounted', async () => {
    const opened: Array<Record<string, unknown>> = []
    const hostOpened: string[] = []
    // A ctx whose inject can fire multiple times (service recreate).
    let effectDisposer: (() => void) | undefined
    let injectCallback: ((fctx: unknown) => void) | undefined
    let current = fakeNamespaceService(hostOpened)
    const ctx = {
      sessions: { list: { getSnapshot: () => ({ current: 's1', byId: { s1: { cwd: '/w' } } }) } },
      get: (name: string) => name === 'betterSidebar'
        ? { openTab: (seed: unknown) => { opened.push(seed as Record<string, unknown>) } }
        : undefined,
      inject: (_deps: string[], callback: (fctx: unknown) => void) => {
        injectCallback = callback
        return { dispose: async () => { effectDisposer?.() } }
      },
      remount: () => {
        effectDisposer?.()
        current = fakeNamespaceService(hostOpened)
        injectCallback?.({
          get: (name: string) => (name === 'remote.session' ? current : undefined),
          effect: (fn: () => () => void) => { effectDisposer = fn() },
        })
      },
    }
    const store = createSidebarStore()
    registerOpenPathInterception(ctx as unknown as Context, store)
    ctx.remount()
    await current.openWorkspacePath({ path: '/w/src/a.ts' })
    expect(opened).toHaveLength(1)
    // A remount (dispose + fresh service) must not leak the old shadow and
    // must wrap the fresh instance.
    ctx.remount()
    await current.openWorkspacePath({ path: '/w/src/b.ts' })
    expect(opened).toHaveLength(2)
    expect(hostOpened).toEqual([])
  })
})
