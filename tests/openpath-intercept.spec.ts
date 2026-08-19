import { describe, expect, it, vi } from 'vitest'
import { registerOpenPathInterception } from '../src/client/intercept.tsx'
import { openPathWithSystem, wrapOpenPath, type OpenPathInterceptDeps, type OpenPathService } from '../src/client/openpath-intercept.ts'
import { createSidebarStore } from '../src/client/state.ts'
import type { Context } from '../src/context-types.ts'

/** A minimal fake of the workspaces.openPath service method. */
const service = (): OpenPathService & { calls: string[]; opened: string[] } => {
  const fake = {
    calls: [] as string[],
    opened: [] as string[],
    async openPath(path: string): Promise<void> {
      this.calls.push(path)
      this.opened.push(path)
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
    ...overrides,
  }
}

describe('open-path interception', () => {

  it('routes an intercepted open into the sidebar and resolves without the original call', async () => {
    const ws = service()
    const d = deps()
    const restore = wrapOpenPath(ws, d)
    await expect(ws.openPath('/abs/a.ts')).resolves.toBeUndefined()
    expect(ws.calls).toEqual([])
    expect(d.sidebar).toEqual(['s1:/abs/a.ts'])
    restore()
  })

  it('falls through to the original when the takeover is disabled', async () => {
    const ws = service()
    const d = deps({ takeoverEnabled: () => false })
    const restore = wrapOpenPath(ws, d)
    await ws.openPath('/abs/a.ts')
    expect(ws.opened).toEqual(['/abs/a.ts'])
    expect(d.sidebar).toEqual([])
    restore()
  })

  it('falls through when no session is current (nothing to scope the editor load to)', async () => {
    const ws = service()
    const d = deps({ currentSessionId: () => undefined })
    const restore = wrapOpenPath(ws, d)
    await ws.openPath('/abs/a.ts')
    expect(ws.opened).toEqual(['/abs/a.ts'])
    expect(d.sidebar).toEqual([])
    restore()
  })

  it('passes the current session into the sidebar opener', async () => {
    const ws = service()
    let current = 's1'
    const d = deps({ currentSessionId: () => current })
    const restore = wrapOpenPath(ws, d)
    await ws.openPath('/abs/a.ts')
    current = 's2'
    await ws.openPath('/abs/b.ts')
    expect(d.sidebar).toEqual(['s1:/abs/a.ts', 's2:/abs/b.ts'])
    restore()
  })

  it('restores the original method on dispose (HMR-safe)', async () => {
    const ws = service()
    const d = deps()
    const original = ws.openPath
    const restore = wrapOpenPath(ws, d)
    expect(ws.openPath).not.toBe(original)
    restore()
    expect(ws.openPath).toBe(original)
    await ws.openPath('/abs/a.ts')
    expect(ws.opened).toEqual(['/abs/a.ts'])
  })

  it('treats a rejected promise like the original would (no swallowing)', async () => {
    const failing: OpenPathService = {
      async openPath() { throw new Error('host refused') },
    }
    const d = deps({ takeoverEnabled: () => false })
    const restore = wrapOpenPath(failing, d)
    await expect(failing.openPath('/abs/a.ts')).rejects.toThrow('host refused')
    restore()
  })
})

describe('open with the default app (system open bypass)', () => {
  it('reaches the RAW host openPath while the takeover is active', async () => {
    const opened: string[] = []
    const ws: OpenPathService = { async openPath(path) { opened.push(path) } }
    const d = deps()
    const restore = wrapOpenPath(ws, d)
    try {
      openPathWithSystem('/abs/a.ts')
      await Promise.resolve()
      await Promise.resolve()
      expect(opened).toEqual(['/abs/a.ts'])
      expect(d.sidebar).toEqual([])
    } finally {
      restore()
    }
  })

  it('does not disturb the wrapped funnel afterwards', async () => {
    const ws = service()
    const d = deps()
    const restore = wrapOpenPath(ws, d)
    try {
      openPathWithSystem('/abs/a.ts')
      await ws.openPath('/abs/b.ts')
      await Promise.resolve()
      expect(ws.opened).toEqual(['/abs/a.ts'])
      expect(d.sidebar).toEqual(['s1:/abs/b.ts'])
    } finally {
      restore()
    }
  })

  it('falls back to the provided opener once the wrap is disposed', async () => {
    const ws = service()
    const d = deps()
    const restore = wrapOpenPath(ws, d)
    restore()
    const calls: string[] = []
    openPathWithSystem('/abs/a.ts', async (path) => { calls.push(path) })
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual(['/abs/a.ts'])
  })

  it('logs a warning and never throws when no opener is available', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(() => openPathWithSystem('/abs/a.ts')).not.toThrow()
      expect(warn).toHaveBeenCalledWith(
        '[dsh-better-sidebar] cannot open with the default app: no host openPath available',
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('swallows a host failure with a warning instead of throwing', async () => {
    const ws: OpenPathService = { async openPath() { throw new Error('host refused') } }
    const d = deps({ takeoverEnabled: () => false })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const restore = wrapOpenPath(ws, d)
    try {
      expect(() => openPathWithSystem('/abs/a.ts')).not.toThrow()
      await Promise.resolve()
      await Promise.resolve()
      expect(warn).toHaveBeenCalled()
    } finally {
      restore()
      warn.mockRestore()
    }
  })
})

describe('open-path interception wiring', () => {
  it('registerOpenPathInterception routes chat opens into the editor tab and restores on dispose', async () => {
    // A realistic client-context fake: the sessions list feed (current + cwd),
    // the workspaces funnel, and the sidebar service the editor goes through.
    const opened: Array<Record<string, unknown>> = []
    const funnel = { openPath: async (): Promise<void> => {} }
    const ctx = {
      sessions: {
        list: { getSnapshot: () => ({ current: 's1', byId: { s1: { cwd: '/w' } } }) },
      },
      workspaces: funnel,
      betterSidebar: { openTab: (seed: unknown) => { opened.push(seed as Record<string, unknown>) } },
    } as unknown as Context
    const store = createSidebarStore()
    const original = ctx.workspaces.openPath
    const restore = registerOpenPathInterception(ctx, store)

    // Default prefs: the takeover routes the open into the sidebar editor
    // with the session-scoped absolute path (chat already resolved it).
    await ctx.workspaces.openPath('/w/src/a.ts')
    expect(opened).toEqual([{
      type: 'editor',
      title: 'a.ts',
      path: '/w/src/a.ts',
      id: 'editor:/w/src/a.ts',
    }])

    // The interceptOpenPath pref off → the original funnel runs untouched.
    store.setPrefs({ ...store.getPrefs(), interceptOpenPath: false })
    const calls: string[] = []
    ctx.workspaces.openPath = async (path: string) => { calls.push(path) }
    await ctx.workspaces.openPath('/w/src/b.ts')
    expect(calls).toEqual(['/w/src/b.ts'])
    expect(opened).toHaveLength(1)

    // The editor tab disabled → falls through too (an editor that cannot
    // open must not swallow opens).
    store.setPrefs({ ...store.getPrefs(), interceptOpenPath: true, tabsEnabled: { editor: false } })
    await ctx.workspaces.openPath('/w/src/c.ts')
    expect(calls).toEqual(['/w/src/b.ts', '/w/src/c.ts'])

    // Disposal restores the raw original method (HMR-safe).
    restore()
    expect(ctx.workspaces.openPath).toBe(original)
  })
})
