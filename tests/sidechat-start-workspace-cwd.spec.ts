/**
 * The thread's ATTACH cwd must be the parent session's HEADER cwd — the
 * workspace path the Host attaches sessions to — while the seeded
 * `working-directory/change` stamp keeps the parent's LIVE cwd (where the tools
 * actually run).
 *
 * Why this spec exists (field failure, Host source verified): the Host's
 * workspace attach guard (`packages/workspace/workspace/src/entity.ts:136`)
 * requires the child session's header cwd to EQUAL the workspace path. The
 * route set `meta.cwd` from `workingDirectory.get(parentSession)`, so a reader
 * who had `cd`-ed into another directory in the parent conversation got a child
 * whose header cwd was that directory — and the fork died with
 * `session/workspace-attach-failed: … its cwd resolves to '<other dir>'`.
 * The two cwds are different questions and need different answers:
 *
 *   header cwd  → which workspace owns this session (attach), the stable path
 *   live cwd    → where the tools should run now (the seed stamp)
 *
 * ============================ CONTRACT ============================
 * 1. `meta.cwd` comes from the PARENT SESSION HEADER (`parent.session.header.cwd`)
 *    ONLY. The live working directory must never win while a header cwd exists.
 * 2. The live cwd still drives the `working-directory/change` boundary stamp
 *    appended to the seed (the last such event before the descriptor), so the
 *    thread keeps running tools in the directory the reader is standing in.
 * 3. FALLBACKS. A parent with no header cwd (an old/partial session) uses the
 *    live cwd for BOTH; a composition without the `workingDirectory` service
 *    uses the header cwd for both. With neither, no `cwd` is invented.
 * ==================================================================
 *
 * Kept as its own file (like tests/sidechat-truncation-route.spec.ts): the
 * existing route spec keeps its own `sidechat.start` assertions.
 */
import { describe, expect, it, vi } from 'vitest'
import { buildSidechatApi } from '../src/sidechat-routes.ts'
import type { Context } from '../src/context-types.ts'

/** The workspace path the parent session was opened in (its header cwd). */
const WORKSPACE_CWD = '/data/user/nolanho/code/mint'
/** Where the reader had `cd`-ed inside that conversation (the live cwd). */
const LIVE_CWD = '/data/user/nolanho/docs/vault/artifacts/2026-11-02/dsv41-train-serve-consistency'

/** One fake live agent, narrowed to the faces `sidechat.start` reads. */
function agent(id: string, over: { events?: unknown[]; header?: Record<string, unknown> } = {}) {
  const inbox = { nextTurn: [] as unknown[], nextStep: [] as unknown[], clear: vi.fn(), remove: vi.fn(() => true) }
  return {
    id,
    status: 'idle' as const,
    options: { provider: 'test', model: 'model-x' },
    // DSH 0.2.2 moved the model seam onto the agent itself (`agent.model`): the
    // fake records the selections the plugin applies instead of a waterfall.
    model: { current: vi.fn(() => undefined), select: vi.fn() },
    ctx: { on: vi.fn(() => () => {}) },
    session: {
      id,
      header: { cwd: WORKSPACE_CWD, delegationDepth: 0, agentPreset: 'preset-a', ...over.header },
      inheritedEventCount: 0,
      snapshotEvents: () => over.events ?? [],
      append: vi.fn((type: string, data: unknown) => ({ type, seq: 0, time: 0, data })),
    },
    inject: vi.fn(),
    followup: vi.fn(),
    cancel: vi.fn(),
    inbox,
  }
}

type AgentLike = ReturnType<typeof agent>

/** A parent conversation with one completed turn, logged from an older cwd. */
function storedTurn(): unknown[] {
  return [
    { type: 'working-directory/change', seq: 0, time: 0, data: { cwd: '/older-execution' } },
    {
      type: 'user/message',
      seq: 1,
      time: 1_000,
      surfaceOp: 'append',
      data: { id: 'mp', role: 'user', content: [{ type: 'text', text: 'PARENT-QUESTION' }], source: { kind: 'user' } },
    },
    { type: 'turn/start', seq: 2, time: 2_000, data: { turn: 1 } },
    {
      type: 'assistant/message',
      seq: 3,
      time: 3_000,
      surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'PARENT-ANSWER' }] } },
    },
    { type: 'turn/end', seq: 4, time: 4_000, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/** The create options the route handed the agent registry. */
interface CreateOptions {
  meta?: { cwd?: string }
  seed?: ReadonlyArray<{ type: string; data?: { cwd?: unknown } }>
}

/** The services the start path reads, with `agents.create` captured. */
function servicesFor(parent: AgentLike, child: AgentLike) {
  const create = vi.fn(async (_options: unknown) => ({ agent: child, dispose: vi.fn(async () => {}) }))
  const get = vi.fn((id: unknown) => (id === child.id ? child : parent))
  return { agents: { get, create }, create }
}

/** A context serving the optional services the routes read via `ctx.get`. */
function ctxWith(table: Record<string, unknown>): Context {
  return { get: (key: string) => table[key] } as unknown as Context
}

/** The create options the route produced. */
function createdOptions(create: ReturnType<typeof servicesFor>['create']): CreateOptions {
  const options = create.mock.calls[0]?.[0]
  expect(options, 'the child agent was created').toBeDefined()
  return options as CreateOptions
}

/** The last `working-directory/change` event in the seed (the boundary stamp). */
function lastStamp(options: CreateOptions): string | undefined {
  const changes = (options.seed ?? []).filter(event => event.type === 'working-directory/change')
  const cwd = changes.at(-1)?.data?.cwd
  return typeof cwd === 'string' ? cwd : undefined
}

describe('the thread attaches at the workspace cwd, and runs tools at the live cwd', () => {
  it('takes meta.cwd from the parent HEADER while the seed stamp keeps the live cwd', async () => {
    const parent = agent('parent', { events: storedTurn() })
    const child = agent('child')
    const services = servicesFor(parent, child)
    const get = vi.fn((_session: unknown) => LIVE_CWD)
    const api = buildSidechatApi(ctxWith({ ...services, workingDirectory: { get } }))

    await api['sidechat.start']({ sessionId: 'parent', question: '' })

    const options = createdOptions(services.create)
    expect(
      options.meta?.cwd,
      'the attach cwd is the workspace path the parent session was opened in',
    ).toBe(WORKSPACE_CWD)
    expect(
      options.meta?.cwd,
      'never the live execution directory (that is what broke the workspace attach)',
    ).not.toBe(LIVE_CWD)
    expect(
      lastStamp(options),
      'the seed still stamps the live cwd, so tools run where the reader stands',
    ).toBe(LIVE_CWD)
  })

  it('falls back to the live cwd for an old parent with no header cwd', async () => {
    const parent = agent('parent', { events: storedTurn(), header: { cwd: undefined } })
    const child = agent('child')
    const services = servicesFor(parent, child)
    const api = buildSidechatApi(ctxWith({ ...services, workingDirectory: { get: () => LIVE_CWD } }))

    await api['sidechat.start']({ sessionId: 'parent', question: '' })

    const options = createdOptions(services.create)
    expect(options.meta?.cwd, 'without a header cwd the live cwd is all there is').toBe(LIVE_CWD)
    expect(lastStamp(options), 'and the stamp agrees with it').toBe(LIVE_CWD)
  })

  it('keeps both cwds identical when the reader never changed directory', async () => {
    const parent = agent('parent', { events: storedTurn() })
    const child = agent('child')
    const services = servicesFor(parent, child)
    const api = buildSidechatApi(ctxWith({ ...services, workingDirectory: { get: () => WORKSPACE_CWD } }))

    await api['sidechat.start']({ sessionId: 'parent', question: '' })

    const options = createdOptions(services.create)
    expect(options.meta?.cwd).toBe(WORKSPACE_CWD)
    expect(lastStamp(options)).toBe(WORKSPACE_CWD)
  })

  it('uses the header cwd for both when the composition has no working-directory service', async () => {
    const parent = agent('parent', { events: storedTurn() })
    const child = agent('child')
    const services = servicesFor(parent, child)
    const api = buildSidechatApi(ctxWith({ ...services }))

    await api['sidechat.start']({ sessionId: 'parent', question: '' })

    const options = createdOptions(services.create)
    expect(options.meta?.cwd, 'the workspace path is still the attach cwd').toBe(WORKSPACE_CWD)
    // No working-directory service means no live cwd to stamp: the route adds no
    // boundary event (unchanged behaviour), so only the attach cwd is pinned here.
  })

  it('invents no cwd when neither the header nor the service has one', async () => {
    const parent = agent('parent', { events: storedTurn(), header: { cwd: undefined } })
    const child = agent('child')
    const services = servicesFor(parent, child)
    const api = buildSidechatApi(ctxWith({ ...services, workingDirectory: { get: () => undefined } }))

    await api['sidechat.start']({ sessionId: 'parent', question: '' })

    expect(createdOptions(services.create).meta?.cwd, 'no cwd is invented').toBeUndefined()
  })
})
