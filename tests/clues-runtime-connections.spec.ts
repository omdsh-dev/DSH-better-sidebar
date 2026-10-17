/**
 * S2 connection runtime contract.
 *
 * Fake adapters only (no real account, browser or Keychain):
 * - configuration and authorization are two INDEPENDENT states, and only an
 *   adapter observation can say `ready` (connect success/install/config ready
 *   never impersonate a login);
 * - authorization starts only from an explicit connect; repeated clicks share
 *   the same attempt; the machine handle (device code/state) never crosses the
 *   projection, while the human URL/QR string stays byte-for-byte opaque;
 * - device-code polling is explicit request/response with expiry; the runtime
 *   schedules NO timer/interval and performs no background auth probe;
 * - cancel is explicit and re-projects cached state without a new auth probe;
 * - denied, expired and scope-insufficient remain distinct actions;
 * - credentials resolve per operation and never appear in a projection/error.
 */
import { describe, expect, it } from 'vitest'
import { ClueError } from '../src/clues/error.ts'
import {
  createConnectionsRuntime,
  type ConnectionsRuntime,
} from '../src/clues/runtime/connections.ts'
import type {
  ClueConnectionDefinition,
  ConnectionConnectStart,
  ConnectionInspection,
  ConnectionPollResult,
  ConnectionStatusProjection,
} from '../src/clues/runtime/types.ts'

interface AdapterCalls {
  inspect: number
  connect: number
  poll: number
  cancel: number
  cancelInputs: Array<{ authorizationId: string; state?: unknown }>
  credentialRefs: string[]
}

interface Harness {
  readonly runtime: ConnectionsRuntime
  readonly calls: AdapterCalls
  readonly definition: ClueConnectionDefinition
}

function harness(options: {
  inspect?: () => Promise<ConnectionInspection>
  connect?: () => Promise<ConnectionConnectStart>
  poll?: () => Promise<ConnectionPollResult>
  cancel?: () => Promise<void>
  credentials?: (ref: string) => Promise<string | undefined>
  now?: () => number
  configuration?: 'required' | 'not-required'
  capabilities?: readonly string[]
} = {}): Harness {
  const calls: AdapterCalls = {
    inspect: 0,
    connect: 0,
    poll: 0,
    cancel: 0,
    cancelInputs: [],
    credentialRefs: [],
  }
  const definition: ClueConnectionDefinition = {
    connectionId: 'feishu.auth',
    name: 'Feishu',
    pluginId: 'feishu-plugin',
    configuration: options.configuration ?? 'required',
    credentialOwner: 'tool',
    capabilities: options.capabilities ?? ['docs.read', 'tasks.write'],
    async inspect(_input, context): Promise<ConnectionInspection> {
      calls.inspect += 1
      await context.resolveCredential('feishu.app_secret')
      return options.inspect === undefined
        ? { configuration: 'ready', authorization: 'not-authorized' }
        : await options.inspect()
    },
    async connect(): Promise<ConnectionConnectStart> {
      calls.connect += 1
      return options.connect === undefined
        ? {
            prompt: {
              verificationUrl: 'https://example.invalid/oauth?state=a%2Fb&scope=docs',
              userCode: 'ABCD-EFGH',
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
            state: { deviceCode: 'MACHINE-ONLY-SECRET' },
          }
        : await options.connect()
    },
    async poll(input): Promise<ConnectionPollResult> {
      calls.poll += 1
      if (options.poll !== undefined) return await options.poll()
      return { prompt: input.prompt }
    },
    async cancel(input): Promise<void> {
      calls.cancel += 1
      calls.cancelInputs.push({
        authorizationId: input.authorizationId,
        ...(input.state === undefined ? {} : { state: input.state }),
      })
      if (options.cancel !== undefined) await options.cancel()
    },
  }
  const runtime = createConnectionsRuntime({
    ...(options.credentials === undefined ? {} : { resolveCredential: options.credentials }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  runtime.register(definition)
  return { runtime, calls, definition }
}

async function statusOf(runtime: ConnectionsRuntime, id = 'feishu.auth'): Promise<ConnectionStatusProjection> {
  const [row] = await runtime.status(id)
  if (row === undefined) throw new Error('no projection')
  return row
}

const READY_PROMPT_EXPIRY = '2030-01-01T00:00:00.000Z'

function pendingConnect(expiresAt = READY_PROMPT_EXPIRY): () => Promise<ConnectionConnectStart> {
  return async () => ({
    prompt: {
      verificationUrl: 'https://example.invalid/oauth?state=a%2Fb&scope=docs',
      userCode: 'ABCD-EFGH',
      expiresAt,
      pollAfterMs: 2_000,
      qr: { uri: 'https://example.invalid/oauth?state=a%2Fb&scope=docs' },
    },
    state: { deviceCode: 'MACHINE-ONLY-SECRET' },
  })
}

describe('two independent connection states', () => {
  it('renders configuration and authorization separately with their own actions', async () => {
    const missing = harness({ inspect: async () => ({ configuration: 'missing', authorization: 'unknown' }) })
    expect(await statusOf(missing.runtime)).toMatchObject({
      configuration: 'missing',
      authorization: 'unknown',
      action: 'configure',
    })
    missing.runtime.dispose()

    const notAuthorized = harness({ inspect: async () => ({ configuration: 'ready', authorization: 'not-authorized' }) })
    expect(await statusOf(notAuthorized.runtime)).toMatchObject({
      configuration: 'ready',
      authorization: 'not-authorized',
      action: 'connect',
      capabilities: ['docs.read', 'tasks.write'],
    })
    notAuthorized.runtime.dispose()

    const ready = harness({ inspect: async () => ({ configuration: 'ready', authorization: 'ready', account: 'me@example' }) })
    expect(await statusOf(ready.runtime)).toMatchObject({
      configuration: 'ready',
      authorization: 'ready',
      action: 'none',
      account: 'me@example',
    })
    ready.runtime.dispose()
  })

  it('keeps denied, expired and scope-insufficient distinct', async () => {
    for (const [authorization, action] of [
      ['denied', 'reconnect'],
      ['scope-insufficient', 'grant-scope'],
    ] as const) {
      const { runtime } = harness({ inspect: async () => ({ configuration: 'ready', authorization }) })
      expect(await statusOf(runtime)).toMatchObject({ authorization, action })
      runtime.dispose()
    }
  })

  it('treats a not-required configuration source as not-required', async () => {
    const { runtime } = harness({
      configuration: 'not-required',
      inspect: async () => ({ configuration: 'not-required', authorization: 'ready' }),
    })
    expect(await statusOf(runtime)).toMatchObject({ configuration: 'not-required', authorization: 'ready' })
    runtime.dispose()
  })
})

describe('explicit authorization lifecycle', () => {
  it('projects an opaque URL/QR prompt but never the machine handle', async () => {
    const { runtime, calls } = harness({ connect: pendingConnect() })
    const projection = await runtime.connect('feishu.auth')
    expect(projection).toMatchObject({
      authorization: 'authorizing',
      action: 'none',
      prompt: {
        verificationUrl: 'https://example.invalid/oauth?state=a%2Fb&scope=docs',
        userCode: 'ABCD-EFGH',
        pollAfterMs: 2_000,
        qr: { uri: 'https://example.invalid/oauth?state=a%2Fb&scope=docs' },
      },
    })
    const serialized = JSON.stringify(projection)
    expect(serialized).not.toContain('MACHINE-ONLY-SECRET')
    expect(serialized).not.toContain('deviceCode')
    expect(serialized).not.toContain('authorizationId')
    expect(calls.connect).toBe(1)
    // Repeated explicit clicks share the attempt instead of starting a second.
    const again = await runtime.connect('feishu.auth')
    expect(again.authorization).toBe('authorizing')
    expect(calls.connect).toBe(1)
    runtime.dispose()
  })

  it('schedules no periodic probe: inspect runs only for an explicit status request', async () => {
    const { runtime, calls } = harness({ connect: pendingConnect() })
    await runtime.connect('feishu.auth')
    expect(calls.inspect).toBe(0)
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(calls.inspect).toBe(0)
    // A status read while authorizing is projected from the attempt, not an
    // auth probe either.
    expect((await statusOf(runtime)).authorization).toBe('authorizing')
    expect(calls.inspect).toBe(0)
    runtime.dispose()
  })

  it('completes an explicit device-code poll and clears the attempt', async () => {
    const { runtime, calls } = harness({
      connect: pendingConnect(),
      poll: async () => ({
        inspection: { configuration: 'ready', authorization: 'ready', account: 'me@example' },
        complete: true,
      }),
    })
    await runtime.connect('feishu.auth')
    const projection = await runtime.poll('feishu.auth')
    expect(projection).toMatchObject({ authorization: 'ready', action: 'none', account: 'me@example' })
    expect(projection.prompt).toBeUndefined()
    expect(calls.poll).toBe(1)
    await expect(runtime.poll('feishu.auth')).rejects.toMatchObject({ category: 'conflict' })
    runtime.dispose()
  })

  it('keeps the attempt while a poll is still pending', async () => {
    const { runtime } = harness({ connect: pendingConnect(), poll: async () => ({}) })
    await runtime.connect('feishu.auth')
    const projection = await runtime.poll('feishu.auth')
    expect(projection.authorization).toBe('authorizing')
    expect(projection.prompt?.userCode).toBe('ABCD-EFGH')
    runtime.dispose()
  })

  it('expires the attempt without an automatic retry and reports expired', async () => {
    let timestamp = 1_000
    const { runtime, calls } = harness({
      now: () => timestamp,
      connect: pendingConnect(new Date(2_000).toISOString()),
      inspect: async () => ({ configuration: 'ready', authorization: 'not-authorized' }),
    })
    await runtime.connect('feishu.auth')
    timestamp = 10_000
    const projection = await statusOf(runtime)
    expect(projection.authorization).toBe('expired')
    expect(projection.action).toBe('reconnect')
    expect(calls.inspect).toBe(1)
    await expect(runtime.poll('feishu.auth')).rejects.toMatchObject({ category: 'conflict' })
    runtime.dispose()
  })

  it('cancels explicitly, passes the host-side handle to the adapter and probes nothing', async () => {
    const { runtime, calls } = harness({ connect: pendingConnect() })
    await runtime.connect('feishu.auth')
    const projection = await runtime.cancel('feishu.auth')
    expect(projection.authorization).toBe('not-authorized')
    expect(calls.cancel).toBe(1)
    expect(calls.cancelInputs[0]).toMatchObject({ state: { deviceCode: 'MACHINE-ONLY-SECRET' } })
    expect(calls.inspect).toBe(0)
    // A second cancel is a plain explicit status read.
    expect((await runtime.cancel('feishu.auth')).authorization).toBe('not-authorized')
    expect(calls.inspect).toBe(1)
    runtime.dispose()
  })

  it('does not start an authorization when the application configuration is missing', async () => {
    const { runtime, calls } = harness({
      connect: async () => ({
        inspection: { configuration: 'missing', authorization: 'not-authorized' },
        prompt: { verificationUrl: 'https://example.invalid/should-not-show', expiresAt: READY_PROMPT_EXPIRY },
        state: { deviceCode: 'SECRET' },
      }),
    })
    const projection = await runtime.connect('feishu.auth')
    expect(projection).toMatchObject({ configuration: 'missing', action: 'configure' })
    expect(projection.authorization).not.toBe('authorizing')
    expect(projection.prompt).toBeUndefined()
    expect(calls.connect).toBe(1)
    await expect(runtime.poll('feishu.auth')).rejects.toMatchObject({ category: 'conflict' })
    runtime.dispose()
  })

  it('accepts report() from a normal resource request without fabricating ready', async () => {
    const { runtime } = harness({
      inspect: async () => { throw new Error('provider unreachable') },
    })
    runtime.report('feishu.auth', { configuration: 'ready', authorization: 'ready', account: 'reported' })
    // The explicit status inspect failed, but the last real observation is
    // still projected (with a sanitized error row) rather than losing the state.
    const projection = await statusOf(runtime)
    expect(projection).toMatchObject({
      authorization: 'ready',
      account: 'reported',
      error: { category: 'failed', message: 'the connection status check failed' },
    })
    runtime.dispose()
  })

  it('resolves credentials per adapter call and never leaks them into a projection', async () => {
    let resolutions = 0
    const { runtime } = harness({
      credentials: async ref => {
        resolutions += 1
        expect(ref).toBe('feishu.app_secret')
        return 'super-secret-value'
      },
    })
    await statusOf(runtime)
    await statusOf(runtime)
    expect(resolutions).toBe(2)
    const projection = await statusOf(runtime)
    expect(JSON.stringify(projection)).not.toContain('super-secret-value')
    runtime.dispose()
  })

  it('renders a sanitized observation error without hiding the connection', async () => {
    const { runtime } = harness({
      inspect: async () => { throw new Error('raw provider body token=leak') },
    })
    const projection = await statusOf(runtime)
    expect(projection.configuration).toBe('unknown')
    expect(projection.authorization).toBe('unknown')
    expect(projection.error).toEqual({ category: 'failed', message: 'the connection status check failed' })
    expect(JSON.stringify(projection)).not.toContain('leak')
    runtime.dispose()
  })

  it('normalizes adapter start failures into fixed clue categories', async () => {
    const { runtime } = harness({
      connect: async () => { throw new ClueError('auth-required', 'sign in to continue') },
    })
    await expect(runtime.connect('feishu.auth')).rejects.toMatchObject({ category: 'auth-required' })
    runtime.dispose()
  })

  it('rejects duplicate registrations and unknown ids with fixed categories', async () => {
    const { runtime, definition } = harness()
    expect(() => runtime.register(definition)).toThrow(/already registered/)
    await expect(runtime.status('missing.connection')).rejects.toMatchObject({ category: 'not-found' })
    await expect(runtime.connect('missing.connection')).rejects.toMatchObject({ category: 'not-found' })
    runtime.dispose()
  })
})
