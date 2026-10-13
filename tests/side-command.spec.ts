import { describe, expect, it, vi } from 'vitest'
import { sideCommand, registerSideCommand } from '../src/client/side-command.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import type { Context } from '../src/context-types.ts'

describe('/side', () => {
  it('opens the captured session through the existing factory without submitting a prompt', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    vi.spyOn(service, 'getTab').mockReturnValue({ id: 'sidechat' } as NonNullable<ReturnType<typeof service.getTab>>)
    const open = vi.spyOn(service, 'openTab').mockImplementation(() => {})
    const command = sideCommand(service, store)
    expect(command.ui.kind).toBe('action')
    command.ui.run({ sessionId: 'composer-session' })
    expect(open).toHaveBeenCalledExactlyOnceWith({ type: 'sidechat' }, { sessionId: 'composer-session' })
    store.setSuspended(true)
    expect(command.available({ sessionId: 'composer-session' })).toBe(false)
    command.ui.run({ sessionId: 'composer-session' })
    expect(open).toHaveBeenCalledTimes(1)
    store.setSuspended(false)
    vi.spyOn(service, 'isTabEnabled').mockReturnValue(false)
    expect(command.available({ sessionId: 'composer-session' })).toBe(false)
    command.ui.run({ sessionId: 'composer-session' })
    expect(open).toHaveBeenCalledTimes(1)
  })
  it('does not offer an unregistered tab and releases registration with the host scope', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    expect(sideCommand(service, store).available({ sessionId: 'session' })).toBe(false)
    const off = vi.fn()
    const register = vi.fn(() => off)
    let cleanup: (() => void) | undefined
    const scope = { get: () => ({ register }), effect: (fn: () => () => void) => { cleanup = fn() } }
    const dispose = vi.fn(() => cleanup?.())
    const ctx = { inject: (_: string[], fn: (scope: unknown) => void) => { fn(scope); return { dispose } } } as unknown as Context
    const stop = registerSideCommand(ctx, service, store)
    expect(register.mock.calls[0]).toBeDefined()
    stop()
    expect(off).toHaveBeenCalledOnce()
  })
})
