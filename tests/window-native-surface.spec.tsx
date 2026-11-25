/** Native window registration: no guide, original-session queue, retained body target and guarded chip close. */
// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { registerWindowSidebarSurface, windowSidebarAddress, WINDOW_SIDEBAR_KIND } from '../src/client/windows/native-surface.tsx'
import { createWindowHost } from '../src/client/windows/host.ts'
import type { Context } from '../src/context-types.ts'

it('registers a hidden resource type, queues a background session and protects native close', async () => {
  let mounted = 'other'
  const listeners = new Set<() => void>()
  let onClose: ((sessionId: string, tab: { id: string; contentId: string }) => void) | undefined
  const openResource = vi.fn()
  const closeIn = vi.fn()
  const release = vi.fn()
  const register = vi.fn((_definition: Record<string, unknown>) => release)
  const callbacks = new Set<string>()
  const sidebar = {
    mounted: { getSnapshot: () => mounted, subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) } },
    openResource, closeIn,
    tabsIn: () => [{ id: 'native1', contentId: windowSidebarAddress('original', 'one') }],
    registerCloseHandler: (_: string, handler: typeof onClose) => { onClose = handler; return release },
  }
  const ctx = {
    get: (name: string) => name === 'sidebarRightTabs' ? { register } : sidebar,
    inject: (_: string[], callback: (injected: unknown) => unknown) => {
      const cleanup = callback(ctx)
      return { dispose: typeof cleanup === 'function' ? cleanup : () => {} }
    },
    slots: {
      inject: (_: string, callback: () => unknown) => callback(),
      register: (definition: { name: string }, _component: unknown) => { callbacks.add(definition.name); return release },
    },
  } as unknown as Context
  const host = createWindowHost({ sessionId: () => 'original' })
  const dispose = registerWindowSidebarSurface(ctx, host)
  const handle = host.open({ id: 'one', title: 'One', content: 'draft', onBeforeClose: () => false })
  expect(handle.dock!()).toBe(true)
  expect(openResource).not.toHaveBeenCalled()
  mounted = 'original'
  for (const listener of listeners) listener()
  expect(openResource).toHaveBeenCalledWith(windowSidebarAddress('original', 'one'), { kind: WINDOW_SIDEBAR_KIND })
  expect(register.mock.calls[0]![0]).toMatchObject({ keepMounted: true, kind: WINDOW_SIDEBAR_KIND })
  expect(register.mock.calls[0]![0]).not.toHaveProperty('guide')
  expect(callbacks.has('sidebar.right.pane.tab')).toBe(true)
  onClose?.('original', { id: 'native1', contentId: windowSidebarAddress('original', 'one') })
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  expect(host.getSnapshot().windows).toHaveLength(1)
  expect(openResource).toHaveBeenCalledTimes(2)
  host.dispose()
  dispose()
  expect(listeners.size).toBe(0)
})

it('uses encoded resource identities rather than path/query interpretation', () => {
  expect(windowSidebarAddress('a/b', 'clue:x?#')).toBe('dsh-resource://better-sidebar-window/a%2Fb/clue%3Ax%3F%23')
})

it('rolls the type back when a body-slot registration fails', () => {
  const release = vi.fn()
  const ctx = {
    get: (name: string) => name === 'sidebarRightTabs' ? { register: () => release } : { registerCloseHandler: () => () => {} },
    inject: (_: string[], callback: (ctx: unknown) => unknown) => callback(ctx),
    slots: { inject: () => { throw new Error('inactive') } },
  } as unknown as Context
  const host = createWindowHost()
  expect(() => registerWindowSidebarSurface(ctx, host)).toThrow('inactive')
  expect(release).toHaveBeenCalledOnce()
  host.dispose()
})
