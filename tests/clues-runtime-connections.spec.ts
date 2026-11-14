/**
 * S2 connection runtime contract.
 *
 * Fake adapters only (no real account, browser or Keychain):
 * - configuration and authorization are INDEPENDENT; only an adapter
 *   observation can say `ready` (connect success/install never impersonates it);
 * - authorization starts only from an explicit connect, repeated clicks share the
 *   attempt, and the machine handle never crosses the projection while the human
 *   URL/QR stays opaque;
 * - device-code polling is explicit request/response with expiry; the runtime
 *   schedules NO timer and performs no background auth probe;
 * - cancel is explicit and re-projects cached state without a new auth probe;
 * - denied, expired and scope-insufficient stay distinct; credentials resolve per
 *   operation and never appear in a projection/error.
 */
import { describe, expect, it } from 'vitest'
import { ClueError } from '../src/clues/error.ts'
import { createConnectionsRuntime, type ConnectionsRuntime } from '../src/clues/runtime/connections.ts'
import type {
  ClueConnectionDefinition, ConnectionConnectInput, ConnectionConnectStart, ConnectionInspection,
  ConnectionPollResult, ConnectionStatusProjection } from '../src/clues/runtime/types.ts'

interface AdapterCalls {
  inspect: number; connect: number; poll: number; cancel: number; cancelInputs: Array<{ authorizationId: string; state?: unknown }>
}
type HarnessOptions = {
  inspect?: () => Promise<ConnectionInspection>; connect?: (input: ConnectionConnectInput) => Promise<ConnectionConnectStart>
  poll?: () => Promise<ConnectionPollResult>; cancel?: () => Promise<void>
  credentials?: (ref: string) => Promise<string | undefined>; now?: () => number
  configuration?: 'required' | 'not-required'
  capabilities?: readonly string[]; selectableCapabilities?: readonly string[]
}
function harness(options: HarnessOptions = {}): { runtime: ConnectionsRuntime; calls: AdapterCalls; definition: ClueConnectionDefinition } {
  const calls: AdapterCalls = { inspect: 0, connect: 0, poll: 0, cancel: 0, cancelInputs: [] }
  const definition: ClueConnectionDefinition = {
    connectionId: 'feishu.auth', name: 'Feishu', pluginId: 'feishu-plugin', configuration: options.configuration ?? 'required',
    credentialOwner: 'tool', capabilities: options.capabilities ?? ['docs.read', 'tasks.write'],
    ...(options.selectableCapabilities === undefined ? {} : { selectableCapabilities: options.selectableCapabilities }),
    async inspect(_input, context) {
      calls.inspect += 1
      await context.resolveCredential('feishu.app_secret')
      return options.inspect === undefined ? { configuration: 'ready', authorization: 'not-authorized' } : await options.inspect()
    },
    async connect(input) {
      calls.connect += 1
      if (options.connect === undefined) throw new Error('connect is not stubbed')
      return await options.connect(input)
    },
    async poll(input) {
      calls.poll += 1
      return options.poll === undefined ? { prompt: input.prompt } : await options.poll()
    },
    async cancel(input) {
      calls.cancel += 1
      calls.cancelInputs.push({ authorizationId: input.authorizationId, ...(input.state === undefined ? {} : { state: input.state }) })
      if (options.cancel !== undefined) await options.cancel()
    },
  }
  const runtime = createConnectionsRuntime({ ...(options.credentials === undefined ? {} : { resolveCredential: options.credentials }), ...(options.now === undefined ? {} : { now: options.now }) })
  runtime.register(definition)
  return { runtime, calls, definition }
}

async function statusOf(runtime: ConnectionsRuntime, id = 'feishu.auth'): Promise<ConnectionStatusProjection> {
  const [row] = await runtime.status(id); if (row === undefined) throw new Error('no projection')
  return row
}
const READY_PROMPT_EXPIRY = '2030-01-01T00:00:00.000Z'

function pendingConnect(expiresAt = READY_PROMPT_EXPIRY): () => Promise<ConnectionConnectStart> {
  return async () => ({
    prompt: {
      verificationUrl: 'https://example.invalid/oauth?state=a%2Fb&scope=docs', userCode: 'ABCD-EFGH', expiresAt, pollAfterMs: 2_000,
      qr: { uri: 'https://example.invalid/oauth?state=a%2Fb&scope=docs' },
    },
    state: { deviceCode: 'MACHINE-ONLY-SECRET' },
  })
}
/** An adapter start that only settles when the runtime aborts it. */
function stalledConnect(counter: { count: number }, starts: Array<() => void>): (input: ConnectionConnectInput) => Promise<ConnectionConnectStart> {
  return async (input) => {
    counter.count += 1; starts.shift()?.()
    await new Promise<void>((_resolve, reject) => {
      const abort = (): void => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      if (input.signal?.aborted === true) abort(); else input.signal?.addEventListener('abort', abort, { once: true })
    })
    return { prompt: { verificationUrl: 'https://example.invalid/late', expiresAt: READY_PROMPT_EXPIRY } }
  }
}
const PROJECTION_CASES: ReadonlyArray<{ name: string; options: HarnessOptions; expected: Record<string, unknown> }> = [
  { name: 'a missing configuration', options: { inspect: async () => ({ configuration: 'missing', authorization: 'unknown' }) }, expected: { configuration: 'missing', authorization: 'unknown', action: 'configure' } },
  { name: 'a configured but unauthorized account', options: {}, expected: { configuration: 'ready', authorization: 'not-authorized', action: 'connect', capabilities: [] } },
  { name: 'a ready account', options: { inspect: async () => ({ configuration: 'ready', authorization: 'ready', account: 'me@example' }) }, expected: { authorization: 'ready', action: 'none', account: 'me@example', capabilities: ['docs.read', 'tasks.write'] } },
  { name: 'adapter-reported capabilities', options: { inspect: async () => ({ configuration: 'ready', authorization: 'ready', capabilities: ['docs.read'] }) }, expected: { capabilities: ['docs.read'] } },
  { name: 'a denied authorization', options: { inspect: async () => ({ configuration: 'ready', authorization: 'denied' }) }, expected: { authorization: 'denied', action: 'reconnect' } },
  { name: 'an insufficient scope', options: { inspect: async () => ({ configuration: 'ready', authorization: 'scope-insufficient' }) }, expected: { authorization: 'scope-insufficient', action: 'grant-scope' } },
  { name: 'a not-required configuration', options: { configuration: 'not-required', inspect: async () => ({ configuration: 'not-required', authorization: 'ready' }) }, expected: { configuration: 'not-required', authorization: 'ready' } },
  { name: 'selectable capabilities without a grant list', options: { selectableCapabilities: ['docs.read', 'tasks.write'], inspect: async () => ({ configuration: 'ready', authorization: 'ready' }) }, expected: { capabilities: [] } },
]

describe('two independent connection states', () => {
  it.each(PROJECTION_CASES)('projects $name independently', async ({ options, expected }) => {
    const { runtime } = harness(options)
    expect(await statusOf(runtime)).toMatchObject(expected)
    runtime.dispose()
  })
})
describe('explicit authorization lifecycle', () => {
  it('projects an opaque URL/QR prompt, never machine handles, and drops adapter extras', async () => {
    const { runtime, calls } = harness({ connect: pendingConnect() })
    const projection = await runtime.connect('feishu.auth')
    expect(projection).toMatchObject({
      authorization: 'authorizing', action: 'none',
      prompt: {
        verificationUrl: 'https://example.invalid/oauth?state=a%2Fb&scope=docs', userCode: 'ABCD-EFGH', pollAfterMs: 2_000,
        qr: { uri: 'https://example.invalid/oauth?state=a%2Fb&scope=docs' },
      },
    })
    const serialized = JSON.stringify(projection)
    for (const hidden of ['MACHINE-ONLY-SECRET', 'deviceCode', 'authorizationId']) expect(serialized).not.toContain(hidden)
    expect((await runtime.connect('feishu.auth')).authorization).toBe('authorizing')
    expect(calls.connect).toBe(1)
    runtime.dispose()

    const hostile = { prompt: {
      verificationUrl: 'https://example.invalid/oauth', userCode: 'ABCD-EFGH', expiresAt: READY_PROMPT_EXPIRY, instructions: 'open the URL',
      qr: { uri: 'https://example.invalid/oauth', token: 'QR-MACHINE-SECRET' }, deviceCode: 'PROMPT-MACHINE-SECRET', token: 'TOKEN-SECRET',
    }, state: { deviceCode: 'HANDLE-SECRET' } } as unknown as ConnectionConnectStart
    const hostileRuntime = harness({ connect: async () => hostile }).runtime
    const filtered = await hostileRuntime.connect('feishu.auth')
    expect(filtered.prompt).toEqual({
      verificationUrl: 'https://example.invalid/oauth', userCode: 'ABCD-EFGH', expiresAt: READY_PROMPT_EXPIRY, instructions: 'open the URL', qr: { uri: 'https://example.invalid/oauth' },
    })
    for (const secret of ['PROMPT-MACHINE-SECRET', 'QR-MACHINE-SECRET', 'TOKEN-SECRET', 'HANDLE-SECRET']) expect(JSON.stringify(filtered)).not.toContain(secret)
    hostileRuntime.dispose()
  })

  it('schedules no timer and polls explicitly from authorizing to completion', async () => {
    let pollCount = 0
    const { runtime, calls } = harness({
      connect: pendingConnect(),
      inspect: async () => ({ configuration: 'ready', authorization: 'ready', account: 'me@example' }),
      poll: async () => { pollCount += 1; return pollCount === 1 ? {} : { inspection: { configuration: 'ready', authorization: 'ready', account: 'me@example' }, complete: true } },
    })
    await runtime.connect('feishu.auth')
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(calls.inspect).toBe(0)
    expect((await statusOf(runtime)).authorization).toBe('authorizing')
    expect(await runtime.poll('feishu.auth')).toMatchObject({ authorization: 'authorizing', prompt: { userCode: 'ABCD-EFGH' } })
    const completed = await runtime.poll('feishu.auth')
    expect(completed).toMatchObject({ authorization: 'ready', action: 'none', account: 'me@example' })
    expect(completed.prompt).toBeUndefined()
    expect(calls.poll).toBe(2)
    // The attempt is gone: a later poll checks persistent authorization instead.
    await expect(runtime.poll('feishu.auth')).resolves.toMatchObject({ authorization: 'ready', account: 'me@example' })
    expect(calls.inspect).toBe(1)
    runtime.dispose()
  })

  it('expires an attempt without an automatic retry and re-projects not-authorized', async () => {
    const early = harness({ now: () => 10_000, connect: pendingConnect(new Date(5_000).toISOString()), inspect: async () => ({ configuration: 'ready', authorization: 'not-authorized' }) })
    const earlyProjection = await early.runtime.connect('feishu.auth')
    expect(earlyProjection).toMatchObject({ authorization: 'expired', action: 'reconnect' })
    expect(earlyProjection.prompt).toBeUndefined()
    await expect(early.runtime.poll('feishu.auth')).resolves.toMatchObject({ authorization: 'not-authorized' })
    expect((await statusOf(early.runtime)).authorization).toBe('not-authorized')
    expect(early.calls.connect).toBe(1)
    early.runtime.dispose()
    let timestamp = 1_000
    const late = harness({ now: () => timestamp, connect: pendingConnect(new Date(2_000).toISOString()), inspect: async () => ({ configuration: 'ready', authorization: 'not-authorized' }) })
    await late.runtime.connect('feishu.auth')
    timestamp = 10_000
    expect(await statusOf(late.runtime)).toMatchObject({ authorization: 'expired', action: 'reconnect' })
    expect(late.calls.inspect).toBe(1)
    await expect(late.runtime.poll('feishu.auth')).resolves.toMatchObject({ authorization: 'not-authorized' })
    late.runtime.dispose()
  })

  it('cancels explicitly with the host handle and keeps lastCheckedAt at the observation time', async () => {
    const early = harness({ connect: pendingConnect() })
    expect((await early.runtime.connect('feishu.auth')).lastCheckedAt).toBeUndefined()
    expect((await statusOf(early.runtime)).lastCheckedAt).toBeUndefined()
    early.runtime.dispose()
    let timestamp = 1_000
    const { runtime, calls } = harness({ now: () => timestamp, connect: pendingConnect(), inspect: async () => ({ configuration: 'ready', authorization: 'not-authorized' }) })
    expect((await statusOf(runtime)).lastCheckedAt).toBe(new Date(1_000).toISOString())
    timestamp = 2_000
    expect((await runtime.connect('feishu.auth')).lastCheckedAt).toBe(new Date(1_000).toISOString())
    timestamp = 4_000
    const cancelled = await runtime.cancel('feishu.auth')
    expect(cancelled).toMatchObject({ authorization: 'not-authorized', lastCheckedAt: new Date(1_000).toISOString() })
    expect(calls.cancelInputs[0]).toMatchObject({ state: { deviceCode: 'MACHINE-ONLY-SECRET' } })
    expect(calls.inspect).toBe(1)
    // A second cancel is a plain explicit status read, not another adapter cancel.
    timestamp = 5_000
    expect((await runtime.cancel('feishu.auth')).lastCheckedAt).toBe(new Date(5_000).toISOString())
    expect(calls.cancel).toBe(1)
    expect(calls.inspect).toBe(2)
    runtime.dispose()
  })

  it('does not start without configuration and normalizes start/registration failures', async () => {
    const missing = harness({
      connect: async () => ({
        inspection: { configuration: 'missing', authorization: 'not-authorized' },
        prompt: { verificationUrl: 'https://example.invalid/should-not-show', expiresAt: READY_PROMPT_EXPIRY }, state: { deviceCode: 'SECRET' },
      }),
    })
    const projection = await missing.runtime.connect('feishu.auth')
    expect(projection).toMatchObject({ configuration: 'missing', action: 'configure' })
    expect(projection.authorization).not.toBe('authorizing')
    expect(projection.prompt).toBeUndefined()
    await expect(missing.runtime.poll('feishu.auth')).resolves.toMatchObject({ authorization: 'not-authorized' })
    expect(missing.calls.connect).toBe(1)
    missing.runtime.dispose()
    const failing = harness({ connect: async () => { throw new ClueError('auth-required', 'sign in to continue') } })
    await expect(failing.runtime.connect('feishu.auth')).rejects.toMatchObject({ category: 'auth-required' })
    failing.runtime.dispose()
    const { runtime, definition } = harness()
    expect(() => runtime.register(definition)).toThrow(/already registered/)
    await expect(runtime.status('missing.connection')).rejects.toMatchObject({ category: 'not-found' })
    await expect(runtime.connect('missing.connection')).rejects.toMatchObject({ category: 'not-found' })
    runtime.dispose()
  })

  it('sanitizes observation errors and resolves credentials per call without leaking them', async () => {
    let resolutions = 0
    const raw = harness({
      credentials: async ref => { resolutions += 1; expect(ref).toBe('feishu.app_secret'); return 'super-secret-value' },
      inspect: async () => { throw new Error('raw provider body token=leak') },
    })
    const sanitized = await statusOf(raw.runtime)
    await statusOf(raw.runtime)
    expect(resolutions).toBe(2)
    expect(sanitized).toMatchObject({ configuration: 'unknown', authorization: 'unknown', error: { category: 'failed', message: 'the connection status check failed' } })
    for (const hidden of ['leak', 'super-secret-value']) expect(JSON.stringify(sanitized)).not.toContain(hidden)
    raw.runtime.dispose()
    const reported = harness({ inspect: async () => { throw new Error('provider unreachable') } })
    reported.runtime.report('feishu.auth', { configuration: 'ready', authorization: 'ready', account: 'reported' })
    expect(await statusOf(reported.runtime)).toMatchObject({ authorization: 'ready', account: 'reported', error: { category: 'failed', message: 'the connection status check failed' } })
    reported.runtime.dispose()
  })
})
describe('concurrent connect/poll/cancel lifecycle', () => {
  it('runs one adapter flow for concurrent connects and cancels or supersedes an in-flight start', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let adapterCalls = 0
    const single = harness({
      connect: async () => {
        adapterCalls += 1
        await gate
        return { prompt: { verificationUrl: 'https://example.invalid/single-flight', userCode: 'ABCD-EFGH', expiresAt: READY_PROMPT_EXPIRY }, state: { deviceCode: 'ONE-FLOW' } }
      },
    })
    const first = single.runtime.connect('feishu.auth')
    const second = single.runtime.connect('feishu.auth')
    release()
    const [a, b] = await Promise.all([first, second])
    expect(adapterCalls).toBe(1)
    expect(a.authorization).toBe('authorizing')
    expect(b.prompt?.userCode).toBe('ABCD-EFGH')
    single.runtime.dispose()

    const counter = { count: 0 }
    const starts: Array<() => void> = []
    const cancelledRun = harness({ connect: stalledConnect(counter, starts), inspect: async () => ({ configuration: 'ready', authorization: 'not-authorized' }) })
    const started = new Promise<void>((resolve) => { starts.push(resolve) })
    const pending = cancelledRun.runtime.connect('feishu.auth')
    await started
    expect((await statusOf(cancelledRun.runtime)).authorization).toBe('authorizing')
    const cancelled = await cancelledRun.runtime.cancel('feishu.auth')
    expect(cancelled).toMatchObject({ authorization: 'not-authorized' })
    expect(cancelled.prompt).toBeUndefined()
    await expect(pending).rejects.toMatchObject({ category: 'cancelled' })
    const restartedSignal = new Promise<void>((resolve) => { starts.push(resolve) })
    const restarted = cancelledRun.runtime.connect('feishu.auth')
    await restartedSignal
    expect(counter.count).toBe(2)
    await cancelledRun.runtime.cancel('feishu.auth')
    await expect(restarted).rejects.toMatchObject({ category: 'cancelled' })
    cancelledRun.runtime.dispose()

    const reportStarts: Array<() => void> = []
    const reportRun = harness({ connect: stalledConnect({ count: 0 }, reportStarts) })
    const reportStarted = new Promise<void>((resolve) => { reportStarts.push(resolve) })
    const reportPending = reportRun.runtime.connect('feishu.auth')
    await reportStarted
    reportRun.runtime.report('feishu.auth', { configuration: 'ready', authorization: 'ready', account: 'reported' })
    await expect(reportPending).rejects.toMatchObject({ category: 'cancelled' })
    const reconnect = reportRun.runtime.connect('feishu.auth')
    await new Promise(resolve => setTimeout(resolve, 1))
    await reportRun.runtime.cancel('feishu.auth')
    await expect(reconnect).rejects.toMatchObject({ category: 'cancelled' })
    reportRun.runtime.dispose()
  })

  it('ignores stale polls after cancellation or completion and a slow cancel of a newer attempt', async () => {
    let releaseCancelled!: () => void
    const cancelledGate = new Promise<void>((resolve) => { releaseCancelled = resolve })
    const cancelled = harness({ connect: pendingConnect(), poll: async () => { await cancelledGate; return { inspection: { configuration: 'ready', authorization: 'ready', account: 'stale' }, complete: true } } })
    await cancelled.runtime.connect('feishu.auth')
    const polling = cancelled.runtime.poll('feishu.auth')
    await new Promise(resolve => setTimeout(resolve, 1))
    await cancelled.runtime.cancel('feishu.auth')
    releaseCancelled()
    const stale = await polling
    expect(stale).toMatchObject({ authorization: 'not-authorized' })
    expect(stale.account).toBeUndefined()
    expect(stale.prompt).toBeUndefined()
    cancelled.runtime.dispose()

    let releaseSlow!: () => void
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve })
    let pollCalls = 0
    const completed = harness({
      connect: pendingConnect(),
      poll: async () => {
        pollCalls += 1
        if (pollCalls === 1) return { inspection: { configuration: 'ready', authorization: 'ready', account: 'first' }, complete: true }
        await slowGate
        return { inspection: { configuration: 'ready', authorization: 'not-authorized', account: 'stale' } }
      },
    })
    await completed.runtime.connect('feishu.auth')
    const first = completed.runtime.poll('feishu.auth')
    const second = completed.runtime.poll('feishu.auth')
    await expect(first).resolves.toMatchObject({ authorization: 'ready', account: 'first' })
    releaseSlow()
    await expect(second).resolves.toMatchObject({ authorization: 'ready', account: 'first' })
    expect(pollCalls).toBe(2)
    completed.runtime.dispose()

    let releaseCancel!: () => void
    const cancelGate = new Promise<void>((resolve) => { releaseCancel = resolve })
    const { runtime, calls } = harness({ connect: pendingConnect(), cancel: async () => { await cancelGate } })
    await runtime.connect('feishu.auth')
    const cancelling = runtime.cancel('feishu.auth')
    await new Promise(resolve => setTimeout(resolve, 1))
    runtime.report('feishu.auth', { configuration: 'ready', authorization: 'ready', account: 'reported' })
    const reconnect = runtime.connect('feishu.auth')
    await new Promise(resolve => setTimeout(resolve, 1))
    releaseCancel()
    expect(await cancelling).toMatchObject({ authorization: 'authorizing', prompt: { userCode: 'ABCD-EFGH' } })
    await expect(reconnect).resolves.toMatchObject({ authorization: 'authorizing' })
    expect(calls.connect).toBe(2)
    runtime.dispose()
  })
})
describe('partial connection observations', () => {
  it('merges partial observations and retains last-known account and grants', async () => {
    const observations: ConnectionInspection[] = [
      { configuration: 'ready', authorization: 'ready', account: 'account', capabilities: ['docs.read', 'tasks.write'] },
      { configuration: 'ready', authorization: 'unknown', detail: 'A resource request needs review.' },
      { configuration: 'ready', authorization: 'ready' },
      { configuration: 'ready', authorization: 'ready', capabilities: [] },
    ]
    const h = harness({ capabilities: ['docs.read', 'tasks.write'], selectableCapabilities: ['docs.read', 'tasks.write'], inspect: async () => observations.shift()! })
    await statusOf(h.runtime)
    expect(await statusOf(h.runtime)).toMatchObject({
      authorization: 'unknown', account: 'account', capabilities: [], grantedCapabilities: ['docs.read', 'tasks.write'],
      detail: 'A resource request needs review.',
    })
    expect(await statusOf(h.runtime)).toMatchObject({ authorization: 'ready', account: 'account', capabilities: ['docs.read', 'tasks.write'] })
    expect(await statusOf(h.runtime)).toMatchObject({ capabilities: [], grantedCapabilities: [] })
    h.runtime.dispose()
    const reported = harness({
      capabilities: ['docs.read', 'tasks.write'], selectableCapabilities: ['docs.read', 'tasks.write'],
      inspect: async () => ({ configuration: 'ready', authorization: 'ready', account: 'account', capabilities: ['docs.read'] }),
    })
    await statusOf(reported.runtime)
    reported.runtime.report('feishu.auth', { configuration: 'ready', authorization: 'unknown', detail: 'A resource request needs review.' })
    expect(await statusOf(reported.runtime)).toMatchObject({ authorization: 'ready', account: 'account', capabilities: ['docs.read'] })
    reported.runtime.dispose()
  })
})
describe('explicit permission selections', () => {
  it('projects choices before authorization, dedupes grants and rejects invalid selections', async () => {
    const seen: ConnectionConnectInput[] = []
    const h = harness({
      selectableCapabilities: ['docs.read', 'tasks.write'],
      connect: async input => { seen.push(input); return { inspection: { configuration: 'ready', authorization: 'ready', capabilities: ['docs.read'] } } },
    })
    expect(await statusOf(h.runtime)).toMatchObject({ capabilities: [], selectableCapabilities: ['docs.read', 'tasks.write'] })
    const after = await h.runtime.connect('feishu.auth', { capabilities: ['docs.read', 'docs.read'] })
    expect(seen[0]?.capabilities).toEqual(['docs.read'])
    expect(after.capabilities).toEqual(['docs.read'])
    h.runtime.dispose()
    const invalid = harness({ selectableCapabilities: ['docs.read'] })
    for (const capabilities of [[], ['unknown'], Array(17).fill('docs.read')]) {
      await expect(invalid.runtime.connect('feishu.auth', { capabilities })).rejects.toMatchObject({ category: 'invalid-request' })
    }
    expect(invalid.calls.connect).toBe(0)
    invalid.runtime.dispose()
    const fixed = harness()
    await expect(fixed.runtime.connect('feishu.auth', { capabilities: ['docs.read'] })).rejects.toMatchObject({ category: 'invalid-request' })
    expect(fixed.calls.connect).toBe(0)
    fixed.runtime.dispose()
  })
})
