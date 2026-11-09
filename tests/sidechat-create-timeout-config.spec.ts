/**
 * The side-chat CREATE BUDGET must be a deployment setting, not a constant —
 * the field failure is `thread creation failed: The operation was aborted due
 * to timeout`, a 15-second `AbortSignal.timeout(CREATE_TIMEOUT_MS)`
 * (`src/sidechat-routes.ts:155,763`) killing the creation of a thread whose
 * seed copies a large parent log.
 *
 * Why this spec exists: the timeout is a HARD-CODED 15 s. A parent conversation
 * big enough to make the seed expensive therefore fails deterministically, with
 * a message that reads like a provider fault, and the only fix a user has is to
 * shrink their history. The budget belongs to the deployment: the plugin
 * already exports its Loader `Config`, so the value can arrive there with a
 * default that survives a normal-sized parent.
 *
 * ============================ CONTRACT ============================
 * 1. CONFIG FIELD. `Config` (the plugin's Loader schema) gains
 *    `createTimeoutMs`:
 *      default 120000, integer, at least 5000, at most 600000 — a value
 *      outside that range, or a non-integer, is a CONFIG ERROR (the schema
 *      rejects it; it is never silently clamped).
 * 2. RESOLVED DEFAULTS. `resolveSidebarConfig({})` yields
 *    `createTimeoutMs: 120000`, and an explicit value is passed through
 *    unchanged (`{ createTimeoutMs: 42000 }` → 42000).
 * 3. THE ROUTE USES IT. `buildSidechatApi(ctx, live?, resolved?)` takes the
 *    RESOLVED config as an optional third argument and builds the creation
 *    cancellation from `resolved.createTimeoutMs` — never from the old 15 s
 *    constant. Omitting the argument keeps the resolved default (120000), so
 *    every existing caller keeps working with the new budget.
 * 4. FAILURES ARE UNCHANGED: an `agents.create` rejection is still wrapped as
 *    `thread creation failed: <message>` with status 500.
 * ==================================================================
 *
 * Kept as its own file (like tests/sidechat-truncation-route.spec.ts): the
 * existing route spec keeps its own `sidechat.start` assertions untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSidechatApi } from '../src/sidechat-routes.ts'
import { Config, resolveSidebarConfig } from '../src/config.ts'
import type { Context } from '../src/context-types.ts'

/** The budget this contract ships as the default. */
const DEFAULT_CREATE_TIMEOUT_MS = 120_000
/** The budget an earlier revision hard-coded; it must never be used again. */
const RETIRED_CREATE_TIMEOUT_MS = 15_000

/** The request body of the reader's gesture ("new side conversation"). */
const START = { sessionId: 'parent', question: '' } as const

/** One fake live agent, narrowed to the faces `sidechat.start` reads. */
function agent(id: string) {
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
      header: { cwd: '/p', delegationDepth: 0, agentPreset: 'preset-a' },
      inheritedEventCount: 0,
      snapshotEvents: (): unknown[] => [],
      append: vi.fn((type: string, data: unknown) => ({ type, seq: 0, time: 0, data })),
    },
    inject: vi.fn(),
    followup: vi.fn(),
    cancel: vi.fn(),
    inbox,
  }
}

type AgentLike = ReturnType<typeof agent>

/** The services the start path reads; the parent is live in every case here. */
function servicesFor(parent: AgentLike, child: AgentLike) {
  const create = vi.fn(async (_options: unknown) => ({ agent: child, dispose: vi.fn(async () => {}) }))
  const get = vi.fn((id: unknown) => (id === child.id ? child : parent))
  return { agents: { get, create }, create }
}

/** A context serving the optional services the routes read via `ctx.get`. */
function ctxWith(table: Record<string, unknown>): Context {
  return { get: (key: string) => table[key] } as unknown as Context
}

/** The resolved settings a spec hands the route factory. */
interface ResolvedLike {
  createTimeoutMs?: number
}

/** The route factory as this contract calls it: the RESOLVED config is its
 *  optional third argument (absent today, which is why the call is typed here
 *  rather than against the current signature). */
const buildApi = buildSidechatApi as unknown as (
  ctx: Context,
  live?: unknown,
  resolved?: ResolvedLike,
) => ReturnType<typeof buildSidechatApi>

/** Every timeout the routes asked `AbortSignal.timeout` for, in order. */
let budgets: number[] = []

beforeEach(() => {
  budgets = []
  // Mocked so no real 42 s / 120 s timer is left behind; the ARGUMENT is the
  // contract, and it is recorded before the signal is handed back.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds?: number) => {
    budgets.push(typeof milliseconds === 'number' ? milliseconds : -1)
    return new AbortController().signal
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Start one thread through `api` and report the budget it used. */
async function startWith(api: ReturnType<typeof buildSidechatApi>): Promise<void> {
  await api['sidechat.start']({ ...START })
}

describe('the create budget is configurable (config half)', () => {
  it('resolves the 120 s default when the deployment says nothing', () => {
    const resolved = resolveSidebarConfig({}) as ResolvedLike
    expect(resolved.createTimeoutMs, 'the default budget is 120 seconds').toBe(DEFAULT_CREATE_TIMEOUT_MS)
  })

  it('passes an explicit value through unchanged', () => {
    const resolved = resolveSidebarConfig({ createTimeoutMs: 42_000 } as never) as ResolvedLike
    expect(resolved.createTimeoutMs, 'an explicit budget is honoured').toBe(42_000)
  })

  it('fills the default in the Loader schema and accepts the range bounds', () => {
    const filled = Config({} as never) as ResolvedLike
    expect(filled.createTimeoutMs, 'Config fills the same default').toBe(DEFAULT_CREATE_TIMEOUT_MS)
    for (const boundary of [5_000, 600_000]) {
      const accepted = Config({ createTimeoutMs: boundary } as never) as ResolvedLike
      expect(accepted.createTimeoutMs, `${String(boundary)} is inside the range`).toBe(boundary)
    }
  })

  it('rejects an out-of-range or non-integer budget instead of clamping it', () => {
    for (const rejected of [4_999, 600_001, 7.5]) {
      expect(
        () => Config({ createTimeoutMs: rejected } as never),
        `${String(rejected)} is not a usable create budget`,
      ).toThrow()
    }
  })
})

describe('the route builds its cancellation from the configured budget', () => {
  it('uses the configured value, never the retired 15 s constant', async () => {
    const parent = agent('parent')
    const child = agent('child')
    const services = servicesFor(parent, child)
    const api = buildApi(
      ctxWith({ ...services }),
      undefined,
      resolveSidebarConfig({ createTimeoutMs: 42_000 } as never) as unknown as ResolvedLike,
    )

    await startWith(api)

    expect(budgets, 'the creation signal carries the configured budget').toEqual([42_000])
    expect(budgets, 'the hard-coded 15 s budget is gone').not.toContain(RETIRED_CREATE_TIMEOUT_MS)
  })

  it('falls back to the resolved default when no config is handed in', async () => {
    const parent = agent('parent')
    const child = agent('child')
    const services = servicesFor(parent, child)
    const api = buildApi(ctxWith({ ...services }))

    await startWith(api)

    expect(budgets, 'a caller that passes no config keeps the 120 s default').toEqual([
      DEFAULT_CREATE_TIMEOUT_MS,
    ])
    expect(budgets, 'and never the retired 15 s budget').not.toContain(RETIRED_CREATE_TIMEOUT_MS)
  })
})

describe('a failed creation still reports itself honestly', () => {
  it('wraps an agents.create rejection as "thread creation failed" with 500', async () => {
    const parent = agent('parent')
    const child = agent('child')
    const services = servicesFor(parent, child)
    services.agents.create.mockImplementation(async () => {
      throw new Error('boom')
    })
    const api = buildSidechatApi(ctxWith({ ...services }))

    await expect(api['sidechat.start']({ ...START })).rejects.toMatchObject({
      status: 500,
      message: 'thread creation failed: boom',
    })
  })
})
