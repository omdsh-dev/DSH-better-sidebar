import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceTerminalManager } from '../src/workspace-terminal.ts'
import { connectWorkspaceTerminal } from '../src/workspace-terminal-socket.ts'
import { BetterSidebarWorkspaceRegistry, type BetterSidebarTerminalEvent, type BetterSidebarTerminalHandle, type BetterSidebarWorkspaceProvider } from '../src/workspace-provider.ts'

function handle() {
  const listeners = new Set<(event: BetterSidebarTerminalEvent) => void>()
  return {
    snapshot: () => ({ text: 'remote prompt', truncated: false, exited: false, exitCode: null }),
    subscribe: (fn: (event: BetterSidebarTerminalEvent) => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    write: vi.fn(async (_data: string) => {}), resize: vi.fn(async (_cols: number, _rows: number) => {}), close: vi.fn(async () => {}),
    emit: (event: BetterSidebarTerminalEvent) => { for (const fn of listeners) fn(event) },
  } satisfies BetterSidebarTerminalHandle & { emit(event: BetterSidebarTerminalEvent): void }
}
function provider(terminal = handle()): BetterSidebarWorkspaceProvider {
  return { id: 'remote', retainClaim: true, claim: () => true, tree: vi.fn(), readText: vi.fn(), writeText: vi.fn(),
    search: vi.fn(), readBytes: vi.fn(), git: { execute: vi.fn() }, terminal: { open: vi.fn(async () => terminal) } }
}
const scope = { cwd: '/anchor', fence: true }
const request = { sessionId: 's', tabId: 't', cols: 80, rows: 24 }

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN
  bufferedAmount = 0
  sent: string[] = []
  codes: number[] = []
  send(text: string) { this.sent.push(text) }
  close(code: number) { this.codes.push(code); this.readyState = WebSocket.CLOSED; this.emit('close') }
  input(text: string) { this.emit('message', Buffer.from(text)) }
}

afterEach(() => vi.useRealTimers())

describe('workspace terminal ownership', () => {
  it('shares one spawn across sockets and an old disconnect cannot close the current view', async () => {
    vi.useFakeTimers()
    const terminal = handle(); const owner = provider(terminal); const manager = new WorkspaceTerminalManager(2, 20)
    const first = manager.attach(owner, scope, request)
    const second = manager.attach(owner, scope, request)
    await Promise.all([first.ready, second.ready])
    expect(owner.terminal!.open).toHaveBeenCalledTimes(1)
    first.release(true)
    await vi.advanceTimersByTimeAsync(25)
    expect(terminal.close).not.toHaveBeenCalled()
    second.release()
    await vi.advanceTimersByTimeAsync(25)
    expect(terminal.close).toHaveBeenCalledTimes(1)
    await manager.dispose()
  })

  it('ordinary spawn failure is not a cleanup resource and cannot poison disposal', async () => {
    const owner = provider(); const manager = new WorkspaceTerminalManager(1, 20)
    vi.mocked(owner.terminal!.open).mockRejectedValue(new Error('SSH authentication failed'))
    const entry = manager.attach(owner, scope, request)
    await expect(entry.ready).rejects.toThrow('authentication failed')
    entry.release()
    await expect(manager.dispose()).resolves.toBeUndefined()
  })

  it('parks on session switch and explicit close still releases the remote process', async () => {
    vi.useFakeTimers()
    const terminal = handle(); const owner = provider(terminal); const manager = new WorkspaceTerminalManager(2, 20)
    const first = manager.attach(owner, scope, request); await first.ready; first.release(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(terminal.close).not.toHaveBeenCalled()
    const next = manager.attach(owner, scope, request); await next.ready
    expect(owner.terminal!.open).toHaveBeenCalledTimes(1)
    await next.close()
    expect(terminal.close).toHaveBeenCalledTimes(1)
    await manager.dispose()
  })

  it('reserves quota during asynchronous spawn and releases late handles after tab close', async () => {
    const terminal = handle(); const owner = provider(terminal); const manager = new WorkspaceTerminalManager(1, 20)
    let resolve!: (value: BetterSidebarTerminalHandle) => void
    vi.mocked(owner.terminal!.open).mockImplementation(() => new Promise(done => { resolve = done }))
    const first = manager.attach(owner, scope, request)
    await Promise.resolve()
    expect(() => manager.attach(owner, scope, { ...request, tabId: 'second' })).toThrow('limit')
    const closing = first.close()
    resolve(terminal)
    await closing
    await expect(first.ready).rejects.toThrow('closed while opening')
    expect(terminal.close).toHaveBeenCalledTimes(1)
    await manager.dispose()
  })

  it('uses tuple keys and fences replacements by provider and cwd', async () => {
    const first = handle(); const next = handle(); const owner = provider(first); const manager = new WorkspaceTerminalManager(3, 20)
    const a = manager.attach(owner, scope, { ...request, sessionId: 'a:b', tabId: 'c' }); await a.ready
    const b = manager.attach(owner, scope, { ...request, sessionId: 'a', tabId: 'b:c' }); await b.ready
    expect(owner.terminal!.open).toHaveBeenCalledTimes(2)
    const replacement = provider(next)
    const c = manager.attach(replacement, { ...scope, cwd: '/other' }, { ...request, sessionId: 'a:b', tabId: 'c' }); await c.ready
    a.release()
    expect(next.close).not.toHaveBeenCalled()
    await manager.dispose()
  })

  it('retries failed cleanup on disposal', async () => {
    const terminal = handle(); const manager = new WorkspaceTerminalManager(1, 20)
    terminal.close.mockRejectedValueOnce(new Error('release failed'))
    const entry = manager.attach(provider(terminal), scope, request); await entry.ready
    await expect(entry.close()).rejects.toThrow('release failed')
    await manager.dispose()
    expect(terminal.close).toHaveBeenCalledTimes(2)
  })

  it('never routes retained remote workspaces locally after provider unload or claim failure', () => {
    const local = provider(); local.id = 'local'
    const registry = new BetterSidebarWorkspaceRegistry(local)
    const remote = provider(); remote.claim = ({ cwd }) => cwd === '/anchor'
    const unregister = registry.register(remote)
    expect(registry.resolve(scope)).toBe(remote)
    unregister()
    expect(() => registry.resolve(scope)).toThrow('unavailable')
    expect(registry.resolve({ cwd: '/local' })).toBe(local)
    remote.claim = () => { throw new Error('bridge revoked') }
    registry.register(remote)
    expect(() => registry.resolve(scope)).toThrow('bridge revoked')
  })
})

describe('asynchronous terminal WebSocket', () => {
  it('buffers input and resize until the remote PTY is ready, then streams output', async () => {
    const terminal = handle(); const owner = provider(terminal); const manager = new WorkspaceTerminalManager(2, 20); const ws = new Socket()
    let resolve!: (value: { provider: BetterSidebarWorkspaceProvider; scope: typeof scope; sessionId: string; tabId: string }) => void
    const opening = connectWorkspaceTerminal(ws as unknown as WebSocket, manager, () => new Promise(done => { resolve = done }))
    ws.input('pwd\r'); ws.input('{"type":"resize","cols":120,"rows":40}')
    resolve({ provider: owner, scope, ...request }); await opening
    await vi.waitFor(() => expect(terminal.resize).toHaveBeenCalledWith(120, 40))
    expect(terminal.write).toHaveBeenCalledWith('pwd\r')
    terminal.emit({ type: 'data', data: '/remote/workspace' })
    expect(ws.sent).toEqual(['remote prompt', '/remote/workspace'])
    ws.input('{"type":"close"}')
    await vi.waitFor(() => expect(terminal.close).toHaveBeenCalledTimes(1))
    await manager.dispose()
  })

  it('does not spawn after a connection closes while its workspace is resolving', async () => {
    const owner = provider(); const manager = new WorkspaceTerminalManager(1, 20); const ws = new Socket()
    let resolve!: (value: { provider: BetterSidebarWorkspaceProvider; scope: typeof scope; sessionId: string; tabId: string }) => void
    const opening = connectWorkspaceTerminal(ws as unknown as WebSocket, manager, () => new Promise(done => { resolve = done }))
    ws.input('{ "type": "close" }')
    resolve({ provider: owner, scope, ...request }); await opening
    expect(owner.terminal!.open).not.toHaveBeenCalled()
    await manager.dispose()
  })

  it('bounds startup input and surfaces output backpressure instead of silently dropping it', async () => {
    const manager = new WorkspaceTerminalManager(1, 20); const ws = new Socket()
    let resolve!: (value: { provider: BetterSidebarWorkspaceProvider; scope: typeof scope; sessionId: string; tabId: string }) => void
    const opening = connectWorkspaceTerminal(ws as unknown as WebSocket, manager, () => new Promise(done => { resolve = done }))
    ws.input('x'.repeat(1024 * 1024 + 1))
    resolve({ provider: provider(), scope, ...request }); await opening
    expect(ws.codes).toContain(1009)
    const terminal = handle(); const slow = new Socket()
    await connectWorkspaceTerminal(slow as unknown as WebSocket, manager, async () => ({ provider: provider(terminal), scope, ...request }))
    slow.bufferedAmount = 5 * 1024 * 1024
    terminal.emit({ type: 'data', data: 'overflow' })
    expect(slow.codes).toContain(1013)
    await manager.dispose()
  })
})
