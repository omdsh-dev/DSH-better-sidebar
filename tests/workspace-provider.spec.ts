import { describe, expect, it, vi } from 'vitest'
import {
  BetterSidebarWorkspaceRegistry,
  type BetterSidebarWorkspaceProvider,
} from '../src/workspace-provider.ts'
import { apply } from '../src/index.ts'
import type { SidebarWebRoute } from '../src/context-types.ts'

function provider(id: string, priority: number, claim: (cwd: string) => boolean): BetterSidebarWorkspaceProvider {
  return {
    id,
    priority,
    claim: ({ cwd }) => claim(cwd),
    tree: vi.fn(),
    readText: vi.fn(),
    writeText: vi.fn(),
    search: vi.fn(),
    readBytes: vi.fn(),
    git: { execute: vi.fn() },
  }
}

async function invoke(route: SidebarWebRoute, method: string, payload: unknown): Promise<any> {
  const chunks: Buffer[] = []
  const source = Buffer.from(JSON.stringify(payload))
  const req = {
    method: 'POST',
    url: `/sidebar/api/${method}`,
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator]() { yield source },
  }
  const res = {
    statusCode: 0,
    writeHead(status: number) { this.statusCode = status },
    end(chunk?: string | Uint8Array) { if (chunk !== undefined) chunks.push(Buffer.from(chunk)) },
  }
  await route.handler(req, res)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

describe('BetterSidebarWorkspaceRegistry', () => {
  it('selects the highest-priority claiming provider and falls back locally', () => {
    const local = provider('local', Number.NEGATIVE_INFINITY, () => true)
    const registry = new BetterSidebarWorkspaceRegistry(local)
    const lower = provider('lower', 10, cwd => cwd === '/workspace')
    const higher = provider('higher', 20, cwd => cwd === '/workspace')

    registry.register(lower)
    registry.register(higher)

    expect(registry.resolve({ cwd: '/workspace' })).toBe(higher)
    expect(registry.resolve({ cwd: '/other' })).toBe(local)
  })

  it('uses identity-safe disposers so HMR replacement cannot unregister the new provider', () => {
    const local = provider('local', Number.NEGATIVE_INFINITY, () => true)
    const registry = new BetterSidebarWorkspaceRegistry(local)
    const oldProvider = provider('external', 10, () => true)
    const newProvider = provider('external', 10, () => true)

    const disposeOld = registry.register(oldProvider)
    const disposeNew = registry.register(newProvider)
    disposeOld()

    expect(registry.resolve({ cwd: '/workspace' })).toBe(newProvider)
    disposeNew()
    expect(registry.resolve({ cwd: '/workspace' })).toBe(local)
  })

  it('ignores a throwing claim and continues selecting', () => {
    const local = provider('local', Number.NEGATIVE_INFINITY, () => true)
    const registry = new BetterSidebarWorkspaceRegistry(local)
    registry.register(provider('broken', 100, () => { throw new Error('bad claim') }))
    const healthy = provider('healthy', 10, () => true)
    registry.register(healthy)

    expect(registry.resolve({ cwd: '/workspace' })).toBe(healthy)
  })

  it('publishes the v1 host service and delegates file API and content routes', async () => {
    const routes: SidebarWebRoute[] = []
    let service: BetterSidebarWorkspaceRegistry | undefined
    const external = provider('external', 10, cwd => cwd === '/virtual')
    vi.mocked(external.tree).mockResolvedValue({ path: '/virtual', entries: [], truncated: false })
    vi.mocked(external.readText).mockResolvedValue({ content: 'remote', truncated: false, binary: false, size: 6 })
    vi.mocked(external.writeText).mockResolvedValue(undefined)
    vi.mocked(external.search).mockResolvedValue({ matches: ['src/file.ts'], truncated: false })
    vi.mocked(external.readBytes).mockResolvedValue({ bytes: Buffer.from('<h1>remote</h1>'), path: '/virtual/page.html', size: 15 })
    vi.mocked(external.git.execute).mockImplementation(async request => request.operation === 'status'
      ? { isRepo: true, branch: 'main', entries: [] }
      : { ok: true })
    const ctx = {
      webRuntime: { trustedHosts: [] },
      webServer: {
        register: (route: SidebarWebRoute) => { routes.push(route); return () => {} },
        registerUpgrade: () => () => {},
      },
      sessions: { get: () => ({ header: { cwd: '/virtual' } }) },
      tools: { register: () => () => {} },
      logger: { warn: () => {} },
      effect: (fn: () => void | (() => void)) => { fn() },
      inject: () => () => {},
      get: () => undefined,
      provide: (_name: string, value: BetterSidebarWorkspaceRegistry) => { service = value; return () => {} },
    }

    apply(ctx as never)
    expect(service?.version).toBe(1)
    service?.register(external)
    const route = routes.find(candidate => candidate.path === '/sidebar/api')!

    expect(await invoke(route, 'fs.tree', { sessionId: 's' })).toEqual({ ok: true, value: { path: '/virtual', entries: [], truncated: false } })
    expect(await invoke(route, 'fs.read', { sessionId: 's', path: '/virtual/a.txt' })).toEqual({ ok: true, value: { kind: 'text', content: 'remote', truncated: false } })
    expect(await invoke(route, 'fs.write', { sessionId: 's', path: '/virtual/a.txt', content: 'next' })).toEqual({ ok: true, value: { ok: true } })
    expect(await invoke(route, 'fs.search', { sessionId: 's', query: 'file' })).toEqual({ ok: true, value: { matches: ['src/file.ts'], truncated: false } })
    const gitCalls: Array<[string, Record<string, unknown>]> = [
      ['git.worktrees', {}], ['git.status', {}], ['git.diff', { path: 'a.ts', staged: true }],
      ['git.stage', { path: 'a.ts' }], ['git.unstage', { path: 'a.ts' }], ['git.commit', { message: 'done' }],
      ['git.branch', {}], ['git.checkout', { branch: 'next' }], ['git.log', { count: 10, skip: 2 }],
      ['git.commit-diff', { hash: 'abc' }], ['git.discard', { path: 'a.ts' }], ['git.revert', { hash: 'abc' }],
      ['git.cherry-pick', { hash: 'abc' }], ['git.show', { rev: 'HEAD', path: 'a.ts' }],
    ]
    for (const [method, body] of gitCalls) await invoke(route, method, { sessionId: 's', worktree: '/virtual/linked', ...body })
    expect(vi.mocked(external.git.execute).mock.calls.map(([request]) => request.operation)).toEqual(gitCalls.map(([method]) => method.slice(4)))
    expect(external.git.execute).toHaveBeenCalledWith(expect.objectContaining({ operation: 'status', cwd: '/virtual', worktree: '/virtual/linked' }))

    expect(external.tree).toHaveBeenCalled()
    expect(external.readText).toHaveBeenCalled()
    expect(external.writeText).toHaveBeenCalled()
    expect(external.search).toHaveBeenCalled()

    const invokeGet = async (path: string): Promise<{ status: number; headers: Record<string, string>; body: string }> => {
      const candidate = routes.find(route => path.startsWith(route.path) && route.kind === 'prefix')!
      const chunks: Buffer[] = []
      const response = { status: 0, headers: {} as Record<string, string> }
      await candidate.handler({ method: 'GET', url: path, headers: { host: '127.0.0.1:3080' } } as never, {
        statusCode: 0,
        writeHead(status: number, headers?: Record<string, string>) { response.status = status; response.headers = headers ?? {} },
        end(chunk?: string | Uint8Array) { if (chunk !== undefined) chunks.push(Buffer.from(chunk)) },
      })
      return { ...response, body: Buffer.concat(chunks).toString('utf8') }
    }
    const media = await invokeGet('/sidebar/file?sessionId=s&path=%2Fvirtual%2Fpage.html&download=1')
    expect(media.status).toBe(200)
    expect(media.headers['content-disposition']).toContain('page.html')
    const html = await invokeGet('/sidebar/html/s/virtual/page.html')
    expect(html.status).toBe(200)
    expect(html.headers['content-security-policy']).toContain('sandbox')
    expect(html.body).toBe('<h1>remote</h1>')
    expect(external.readBytes).toHaveBeenCalledTimes(2)
  })
})
