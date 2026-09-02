import { describe, expect, it } from 'vitest'
import { registerOpenPathInterception } from '../src/client/intercept.tsx'
import {
  wrapOpenWorkspacePath,
  type OpenPathInterceptDeps,
  type OpenWorkspacePathService,
} from '../src/client/openpath-intercept.ts'
import { createSidebarStore } from '../src/client/state.ts'
import type { Context } from '../src/context-types.ts'

describe('open-path interception', () => {
  /** A minimal fake of the remote session.openWorkspacePath service method. */
  const service = (): OpenWorkspacePathService & { calls: string[]; opened: string[] } => {
    const fake = {
      calls: [] as string[],
      opened: [] as string[],
      async openWorkspacePath(request: { path: string }) {
        this.calls.push(request.path)
        this.opened.push(request.path)
        return { ok: true, value: { opened: true } as const }
      },
    }
    return fake
  }

  const deps = (overrides: Partial<OpenPathInterceptDeps> = {}): OpenPathInterceptDeps & {
    sidebar: string[]
  } => {
    const sidebar: string[] = []
    return {
      sidebar,
      takeoverEnabled: () => true,
      currentSessionId: () => 's1',
      openInSidebar: (path, sessionId) => { sidebar.push(`${sessionId}:${path}`) },
      revealInExplorer: () => {},
      ...overrides,
    }
  }

  it('routes an intercepted open into the sidebar and resolves ok without the original call', async () => {
    const session = service()
    const d = deps()
    const restore = wrapOpenWorkspacePath(session, d)
    await expect(session.openWorkspacePath({ path: '/abs/a.ts' }))
      .resolves.toEqual({ ok: true, value: { opened: true } })
    expect(session.calls).toEqual([])
    expect(d.sidebar).toEqual(['s1:/abs/a.ts'])
    restore()
  })

  it('falls through to the original when the takeover is disabled', async () => {
    const session = service()
    const d = deps({ takeoverEnabled: () => false })
    const restore = wrapOpenWorkspacePath(session, d)
    await session.openWorkspacePath({ path: '/abs/a.ts' })
    expect(session.opened).toEqual(['/abs/a.ts'])
    expect(d.sidebar).toEqual([])
    restore()
  })

  it('falls through when no session is current (nothing to scope the editor load to)', async () => {
    const session = service()
    const d = deps({ currentSessionId: () => undefined })
    const restore = wrapOpenWorkspacePath(session, d)
    await session.openWorkspacePath({ path: '/abs/a.ts' })
    expect(session.opened).toEqual(['/abs/a.ts'])
    expect(d.sidebar).toEqual([])
    restore()
  })

  it('passes the current session into the sidebar opener', async () => {
    const session = service()
    let current = 's1'
    const d = deps({ currentSessionId: () => current })
    const restore = wrapOpenWorkspacePath(session, d)
    await session.openWorkspacePath({ path: '/abs/a.ts' })
    current = 's2'
    await session.openWorkspacePath({ path: '/abs/b.ts' })
    expect(d.sidebar).toEqual(['s1:/abs/a.ts', 's2:/abs/b.ts'])
    restore()
  })

  it('restores the original method on dispose (HMR-safe)', async () => {
    const session = service()
    const d = deps()
    const original = session.openWorkspacePath
    const restore = wrapOpenWorkspacePath(session, d)
    expect(session.openWorkspacePath).not.toBe(original)
    restore()
    expect(session.openWorkspacePath).toBe(original)
    await session.openWorkspacePath({ path: '/abs/a.ts' })
    expect(session.opened).toEqual(['/abs/a.ts'])
  })

  it('treats a rejected promise like the original would (no swallowing)', async () => {
    const failing: OpenWorkspacePathService = {
      async openWorkspacePath() { throw new Error('host refused') },
    }
    const d = deps({ takeoverEnabled: () => false })
    const restore = wrapOpenWorkspacePath(failing, d)
    await expect(failing.openWorkspacePath({ path: '/abs/a.ts' })).rejects.toThrow('host refused')
    restore()
  })
})

describe('open-path interception wiring', () => {
  it('registerOpenPathInterception routes chat opens into the editor tab and restores on dispose', async () => {
    // A realistic client-context fake: the sessions list feed (current + cwd),
    // the Remote session funnel, and the sidebar service the editor goes through.
    const opened: Array<Record<string, unknown>> = []
    const calls: string[] = []
    const remote = {
      session: {
        async openWorkspacePath(request: { path: string }) {
          calls.push(request.path)
          return { ok: true, value: { opened: true } as const }
        },
      },
    }
    const ctx = {
      sessions: {
        list: { getSnapshot: () => ({ current: 's1', byId: { s1: { cwd: '/w' } } }) },
      },
      remote,
      betterSidebar: { openTab: (seed: unknown) => { opened.push(seed as Record<string, unknown>) } },
      get: (name: string) => name === 'betterSidebar'
        ? { openTab: (seed: unknown) => { opened.push(seed as Record<string, unknown>) } }
        : undefined,
    } as unknown as Context
    const store = createSidebarStore()
    const original = ctx.remote.session.openWorkspacePath
    const restore = registerOpenPathInterception(ctx, store)

    // Default prefs: the takeover routes the open into the sidebar editor
    // with the session-scoped absolute path (chat already resolved it) and
    // the Remote call never reaches the host.
    await ctx.remote.session.openWorkspacePath({ path: '/w/src/a.ts' })
    expect(opened).toEqual([{
      type: 'editor',
      title: 'a.ts',
      path: '/w/src/a.ts',
      id: 'editor:/w/src/a.ts',
    }])
    expect(calls).toEqual([])

    // The interceptOpenPath pref off → the original funnel runs untouched.
    store.setPrefs({ ...store.getPrefs(), interceptOpenPath: false })
    await ctx.remote.session.openWorkspacePath({ path: '/w/src/b.ts' })
    expect(calls).toEqual(['/w/src/b.ts'])
    expect(opened).toHaveLength(1)

    // The editor tab disabled → falls through too (an editor that cannot
    // open must not swallow opens).
    store.setPrefs({ ...store.getPrefs(), interceptOpenPath: true, tabsEnabled: { editor: false } })
    await ctx.remote.session.openWorkspacePath({ path: '/w/src/c.ts' })
    expect(calls).toEqual(['/w/src/b.ts', '/w/src/c.ts'])

    // Disposal restores the raw original method (HMR-safe).
    restore()
    expect(ctx.remote.session.openWorkspacePath).toBe(original)
  })

  it('mounts with a no-op disposer when the Remote session face is absent', async () => {
    const ctx = {
      sessions: {
        list: { getSnapshot: () => ({ current: 's1', byId: { s1: { cwd: '/w' } } }) },
      },
      get: () => undefined,
    } as unknown as Context
    const store = createSidebarStore()
    const restore = registerOpenPathInterception(ctx, store)
    expect(typeof restore).toBe('function')
    restore()
  })
})
