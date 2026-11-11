/**
 * `sidechat.start` against a COLD parent session — the failed path a reader hits
 * when they open a stored conversation from the sidebar (it has history, but no
 * turn has run since the process started) and press "new side conversation".
 *
 * Why this spec exists: the route resolves the parent with
 * `liveThreadAgent(ctx, sessionId)` (`src/sidechat-routes.ts:270-273`) — the
 * LIVE agent registry only — and turns "not in the registry" into
 * `409 parent session "…" is not running` (`:619-622`). A cold conversation is
 * not "not running" in the sense that matters: the Host can resume it, and the
 * Host exposes exactly that ability as `ctx.sessionController.resolveAgent(id)`
 * → `{ agent } | { error }`. So a whole class of legitimate parents is refused
 * with a message that blames the user's session.
 *
 * ============================ CONTRACT ============================
 * 1. COLD PARENT IS STILL A PARENT. When no live agent is registered for the
 *    session but `ctx.get('sessionController').resolveAgent(sessionId)` exists
 *    and resolves to `{ agent }`, `sidechat.start` uses that agent and creates
 *    the thread normally — NOT a 409. The child is still bound to the parent
 *    (`meta.parentSession` = the parent id) and the child agent is created.
 * 2. STILL FAILS HONESTLY. No `sessionController`, a `resolveAgent` that
 *    throws, or one that reports a Session-domain failure (`{ error }`) all keep
 *    the EXISTING failure: `SidebarError` status 409 with
 *    `parent session "<id>" is not running`. A resume failure is never treated
 *    as an agent (that would crash the handler instead of answering).
 * 3. LIVE PARENT IS UNTOUCHED. A parent that IS in the live registry never
 *    reaches `resolveAgent`: no pointless resume/reopen, no extra work on the
 *    path that works today.
 * 4. PORT SHAPE. The Host service is read as a STRUCTURAL probe
 *    (`ctx.get('sessionController')`, optional `resolveAgent`), never by
 *    importing Host types; the spec injects stubs and asserts the call counts.
 * ==================================================================
 *
 * Kept as its own file (rather than appended to tests/sidechat-routes.spec.ts,
 * which keeps its own `sidechat.start` assertions): the same reason
 * tests/sidechat-truncation-route.spec.ts is its own file. The fakes below are
 * the minimal agent face this route reads.
 */
import { describe, expect, it, vi } from 'vitest'
import { buildSidechatApi } from '../src/sidechat-routes.ts'
import { SidebarError } from '../src/wire.ts'
import type { Context } from '../src/context-types.ts'

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
      header: { cwd: '/p', delegationDepth: 0, agentPreset: 'preset-a', ...over.header },
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

/** A parent conversation with one completed turn (a real stored session). */
function storedTurn(): unknown[] {
  return [
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

/**
 * The services the start path reads. `parentLive` decides whether the parent is
 * in the LIVE registry: undefined means a cold stored session.
 * @param child - the agent `agents.create` hands back.
 * @param parentLive - the parent agent when it is live, else undefined.
 */
function servicesFor(child: AgentLike, parentLive: AgentLike | undefined) {
  const create = vi.fn(async (_options: unknown) => ({ agent: child, dispose: vi.fn(async () => {}) }))
  const get = vi.fn((id: unknown) => (id === child.id ? child : parentLive))
  return { agents: { get, create }, create }
}

/** A context serving the optional services the routes read via `ctx.get`. */
function ctxWith(table: Record<string, unknown>): Context {
  return { get: (key: string) => table[key] } as unknown as Context
}

/** The request body of the reader's gesture ("new side conversation"). */
const START = { sessionId: 'parent', question: '' } as const

describe('sidechat.start from a cold parent session', () => {
  it('starts the thread through the host session controller instead of a 409', async () => {
    const parent = agent('parent', { events: storedTurn() })
    const child = agent('child')
    const services = servicesFor(child, undefined)
    const resolveAgent = vi.fn(async (_sessionId: string) => ({ agent: parent }))
    const api = buildSidechatApi(ctxWith({ ...services, sessionController: { resolveAgent } }))

    const result = await api['sidechat.start']({ ...START })

    expect(result.childId, 'a thread id comes back').toBeTruthy()
    expect(resolveAgent, 'the cold parent is resumed through the host').toHaveBeenCalledExactlyOnceWith('parent')
    expect(services.create, 'the child agent is still created').toHaveBeenCalledOnce()
    const options = services.create.mock.calls[0]?.[0] as { meta?: { parentSession?: string } }
    expect(options.meta?.parentSession, 'the child is bound to its parent').toBe('parent')
  })

  it('never resumes a parent that is already live', async () => {
    const parent = agent('parent', { events: storedTurn() })
    const child = agent('child')
    const services = servicesFor(child, parent)
    const resolveAgent = vi.fn(async (_sessionId: string) => ({ agent: parent }))
    const api = buildSidechatApi(ctxWith({ ...services, sessionController: { resolveAgent } }))

    await api['sidechat.start']({ ...START })

    expect(resolveAgent, 'the live path does no extra work').not.toHaveBeenCalled()
    expect(services.create, 'and still creates the thread').toHaveBeenCalledOnce()
  })

  it('still reports "not running" when the host has no session controller', async () => {
    const child = agent('child')
    const services = servicesFor(child, undefined)
    const api = buildSidechatApi(ctxWith({ ...services }))

    await expect(api['sidechat.start']({ ...START })).rejects.toMatchObject({
      status: 409,
      message: 'parent session "parent" is not running',
    })
    await expect(api['sidechat.start']({ ...START })).rejects.toThrow(SidebarError)
  })

  it('still reports "not running" when the resume throws', async () => {
    const child = agent('child')
    const services = servicesFor(child, undefined)
    const resolveAgent = vi.fn(async (_sessionId: string): Promise<{ agent: AgentLike }> => {
      throw new Error('resume blew up')
    })
    const api = buildSidechatApi(ctxWith({ ...services, sessionController: { resolveAgent } }))

    await expect(api['sidechat.start']({ ...START })).rejects.toMatchObject({
      status: 409,
      message: 'parent session "parent" is not running',
    })
    expect(services.create, 'no thread is created from a failed resume').not.toHaveBeenCalled()
  })

  it('still reports "not running" when the resume reports a session-domain failure', async () => {
    const child = agent('child')
    const services = servicesFor(child, undefined)
    // The host folds carrier/resume failures into the RESULT, not a throw.
    const resolveAgent = vi.fn(async (_sessionId: string) => ({
      error: { code: 'session/not-found' as const, message: 'the session is gone' },
    }))
    const api = buildSidechatApi(ctxWith({ ...services, sessionController: { resolveAgent } }))

    await expect(api['sidechat.start']({ ...START })).rejects.toMatchObject({
      status: 409,
      message: 'parent session "parent" is not running',
    })
    expect(services.create, 'an error is never mistaken for an agent').not.toHaveBeenCalled()
  })
})
