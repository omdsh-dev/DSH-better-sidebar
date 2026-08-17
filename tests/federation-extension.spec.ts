import { describe, expect, it } from 'vitest'
import { apply, BETTER_SIDEBAR_FEDERATION_NAMESPACE, BETTER_SIDEBAR_FEDERATION_VERSION } from '../src/index.ts'

type Registration = {
  manifest: { namespace: string; version: string; capabilities: readonly { name: string; risk: string; transport: string }[] }
  handlers: Record<string, (context: { callerNodeId: string; sessionId: string; signal: AbortSignal }, payload: unknown) => Promise<any>>
}
type Route = { kind: string; path: string; handler: (req: any, res: any) => Promise<void> }

function mount(options: { cwd?: string; withRouter?: boolean } = {}) {
  let registration: Registration | undefined
  let disposed = false
  let routedCall: unknown
  const routes: Route[] = []
  const ctx = {
    webRuntime: { trustedHosts: [] },
    webServer: { register: (route: Route) => { routes.push(route); return () => {} }, registerUpgrade: () => () => {} },
    sessions: { get: (id: string) => id === 'owner-local' && options.cwd !== undefined ? { header: { cwd: options.cwd } } : undefined },
    tools: { register: () => () => {} },
    effect: (fn: () => void | (() => void)) => { fn() },
    inject: (deps: string[], callback: (injected: any) => void | (() => void)) => {
      if (deps.includes('federatedExtensions')) {
        callback({
          ...ctx,
          federatedExtensions: {
            register(value: Registration) {
              registration = value
              return () => { disposed = true }
            },
          },
        })
      }
      if (deps.includes('federationExtensionRouter') && options.withRouter === true) {
        callback({
          ...ctx,
          federationExtensionRouter: {
            async invokeJson(call: unknown) { routedCall = call; return { ok: true, value: { remote: true } } },
          },
        })
      }
      return () => {}
    },
    get: (name: string) => {
      if (name === 'federatedExtensions') {
        return {
          register(value: Registration) {
            registration = value
            return () => { disposed = true }
          },
        }
      }
      if (name === 'federationExtensionRouter' && options.withRouter === true) {
        return { async invokeJson(call: unknown) { routedCall = call; return { ok: true, value: { remote: true } } } }
      }
      return undefined
    },
  }
  apply(ctx as never)
  if (registration === undefined) throw new Error('federation registration was not captured')
  return { registration, disposed: () => disposed, routedCall: () => routedCall, api: routes.find(route => route.path === '/sidebar/api')! }
}

describe('better-sidebar Federation extension', () => {
  it('registers an explicit read/write JSON plus bounded binary capability catalog', () => {
    const { registration } = mount({ cwd: process.cwd() })
    expect(registration.manifest.namespace).toBe(BETTER_SIDEBAR_FEDERATION_NAMESPACE)
    expect(registration.manifest.version).toBe(BETTER_SIDEBAR_FEDERATION_VERSION)
    expect(registration.manifest.capabilities.every(entry => entry.transport === 'json' || entry.transport === 'binary')).toBe(true)
    expect(registration.manifest.capabilities).toContainEqual({ name: 'file.read', scope: 'session', risk: 'read', transport: 'binary' })
    expect(registration.manifest.capabilities).toContainEqual({ name: 'html.read', scope: 'session', risk: 'read', transport: 'binary' })
    expect(registration.manifest.capabilities).toContainEqual({ name: 'fs.tree', scope: 'session', risk: 'read', transport: 'json' })
    expect(registration.manifest.capabilities).toContainEqual({ name: 'fs.write', scope: 'session', risk: 'write', transport: 'json' })
    expect(registration.manifest.capabilities.some(entry => entry.name === 'settings.update')).toBe(false)
    expect(registration.manifest.capabilities.some(entry => entry.name === 'browser.probe')).toBe(false)
    expect(registration.manifest.capabilities.some(entry => entry.name === 'agent-pty.close')).toBe(false)
  })

  it('uses the owner-local Session header and ignores forwarded cwd', async () => {
    const { registration } = mount({ cwd: process.cwd() })
    const result = await registration.handlers['session.cwd']!(
      { callerNodeId: 'ingress', sessionId: 'owner-local', signal: new AbortController().signal },
      { sessionId: 'attacker-global-id', cwd: '/tmp/attacker' },
    )
    expect(result).toMatchObject({ ok: true, value: { sessionId: 'owner-local', cwd: process.cwd() } })
  })

  it('routes node-scoped Session ids through the ingress router and strips cwd', async () => {
    const { routedCall, api } = mount({ cwd: process.cwd(), withRouter: true })
    const body = Buffer.from(JSON.stringify({
      sessionId: 'openclaw~s-1', cwd: '/tmp/attacker', path: '/owner/path',
    }))
    const req = {
      method: 'POST', url: '/sidebar/api/fs.tree', headers: { host: '127.0.0.1:3080' },
      [Symbol.asyncIterator]: async function* () { yield body },
    }
    let response = ''
    const res = { writeHead: () => {}, end: (chunk: unknown) => { response += String(chunk ?? '') } }
    await api.handler(req, res)
    expect(JSON.parse(response)).toEqual({ ok: true, value: { remote: true } })
    expect(routedCall()).toEqual({
      namespace: BETTER_SIDEBAR_FEDERATION_NAMESPACE,
      version: BETTER_SIDEBAR_FEDERATION_VERSION,
      capability: 'fs.tree',
      sessionId: 'openclaw~s-1',
      payload: { path: '/owner/path' },
    })
  })

  it('fails closed when the owner-local Session is absent instead of using process.cwd', async () => {
    const { registration } = mount()
    const result = await registration.handlers['session.cwd']!(
      { callerNodeId: 'ingress', sessionId: 'missing', signal: new AbortController().signal },
      { cwd: process.cwd() },
    )
    expect(result).toMatchObject({ ok: false, error: { code: 'not-found' } })
  })
})
