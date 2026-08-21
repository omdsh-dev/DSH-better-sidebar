/**
 * Host route tests for the Side Chat API ('sidechat.start' / 'sidechat.prompt'
 * / 'sidechat.cancel' / 'sidechat.dispose'): the custom-seed thread creation
 * (with the in-progress-turn synthetic close and the dangling-tool-call
 * snapshot fallback), the boundary+question first prompt, follow-ups on live
 * and cold (resumed) agents, cancel, and dispose.
 */
import { describe, expect, it, vi } from 'vitest'
import { buildSidechatApi } from '../src/sidechat-routes.ts'
import { SidebarError } from '../src/wire.ts'
import { SIDE_BOUNDARY_PROMPT, SIDE_NEW_THREAD_TITLE, sideLabel } from '../src/sidechat-core.ts'
import type { Context } from '../src/context-types.ts'

/** A fake live agent (followup/cancel spied). */
function agent(id: string, over: { events?: unknown[]; header?: Record<string, unknown>; provider?: string; model?: string } = {}) {
  return {
    id,
    status: 'idle' as const,
    options: { provider: over.provider ?? 'test', model: over.model ?? 'model-x' },
    session: {
      id,
      header: { cwd: '/p', delegationDepth: 0, agentPreset: 'preset-a', ...over.header },
      events: over.events ?? [],
    },
    followup: vi.fn(),
    cancel: vi.fn(),
  }
}

type AgentLike = ReturnType<typeof agent>
type Handle = { agent: AgentLike; dispose: () => Promise<void> }

/** The standard services the happy paths need. */
function happyServices(parent: AgentLike | undefined, child: AgentLike) {
  const create = vi.fn(async (_options: unknown): Promise<Handle> => ({
    agent: child,
    dispose: vi.fn(async () => {}),
  }))
  const resume = vi.fn(async (_options: unknown): Promise<Handle> => ({
    agent: child,
    dispose: vi.fn(async () => {}),
  }))
  const get = vi.fn((id: unknown) => (id === child.id ? child : parent))
  const rename = vi.fn((_session: unknown, _title: string) => ({ title: 'x', eventSeq: 1 }))
  const resolve = vi.fn(async (_id?: string) => ({ id: 'preset-a' }))
  const mount = vi.fn(async () => {})
  const inspect = vi.fn(async () => ({ meta: { agentPreset: 'preset-a' }, events: [] }))
  return {
    agents: { get, create, resume },
    agentPresets: { resolve, mount },
    sessionTitle: { rename },
    sessionPersistence: { inspect },
    create,
    resume,
    get,
    rename,
    mount,
    inspect,
  }
}

/** A context serving the optional services the routes read via ctx.get. */
function ctxWith(services: {
  agents?: unknown
  agentPresets?: unknown
  sessionTitle?: unknown
  sessionPersistence?: unknown
}): Context {
  const table: Record<string, unknown> = {
    ...(services.agents === undefined ? {} : { agents: services.agents }),
    ...(services.agentPresets === undefined ? {} : { agentPresets: services.agentPresets }),
    ...(services.sessionTitle === undefined ? {} : { sessionTitle: services.sessionTitle }),
    ...(services.sessionPersistence === undefined ? {} : { sessionPersistence: services.sessionPersistence }),
  }
  return {
    get: (key: string) => table[key],
  } as unknown as Context
}

function ev(type: string, seq: number, data: Record<string, unknown> = {}): { type: string; seq: number; time: number; data: Record<string, unknown>; surfaceOp?: string } {
  const event = { type, seq, time: seq * 1000, data }
  if (type === 'user/message' || type === 'assistant/message' || type === 'tool/result') {
    return { ...event, surfaceOp: 'append' }
  }
  return event
}

describe('sidechat.start', () => {
  it('creates a seeded subagent-origin child and admits the boundary + question', async () => {
    const parent = agent('parent', {
      events: [
        ev('user/message', 0, { content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }),
        ev('turn/start', 1, { turn: 1 }),
        ev('step/start', 2, { turn: 1, step: 1 }),
        ev('assistant/message', 3, { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'a' }] } }),
        ev('step/end', 4, { turn: 1, step: 1 }),
        ev('turn/end', 5, { turn: 1, reason: { kind: 'completed' } }),
      ],
    })
    const child = agent('child')
    const services = happyServices(parent, child)
    const api = buildSidechatApi(ctxWith(services))

    const result = await api['sidechat.start']({ sessionId: 'parent', question: 'explain the event flow' })

    expect(result.childId).toMatch(/^session-/)
    expect(services.create).toHaveBeenCalledTimes(1)
    const options = services.create.mock.calls[0]![0] as {
      sessionId: string
      meta: Record<string, unknown>
      seed: readonly { type: string; data: Record<string, unknown> }[]
      agentOptions: { provider: string; model: string }
      setup: unknown
    }
    expect(options.sessionId).toBe(result.childId)
    expect(options.meta).toMatchObject({
      parentSession: 'parent',
      origin: 'subagent',
      seedLength: 7,
      delegationDepth: 1,
      agentPreset: 'preset-a',
      cwd: '/p',
    })
    expect(options.agentOptions).toEqual({ provider: 'test', model: 'model-x' })
    // The child carries the parent's completed turns as a verbatim seed,
    // closed by the durable subagent descriptor (honest catalog citizenship:
    // without it the host's subagents.list renders the cold thread as a
    // 'corrupt' diagnostic row).
    expect(options.seed.map(event => event.type)).toEqual([
      'user/message', 'turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end',
      'subagent/descriptor',
    ])
    expect(options.seed.at(-1)?.data).toMatchObject({
      version: 2,
      mode: 'continuable',
      provider: 'sidechat',
      label: sideLabel('explain the event flow'),
      agentProvider: 'test',
      agentModel: 'model-x',
    })
    expect(child.followup).toHaveBeenCalledTimes(1)
    const message = child.followup.mock.calls[0]![0] as { content: Array<{ type: string; text: string }>; source: { kind: string } }
    expect(message.source).toEqual({ kind: 'user' })
    const promptText = message.content[0]!.text
    expect(promptText.startsWith(SIDE_BOUNDARY_PROMPT)).toBe(true)
    expect(promptText).toContain('explain the event flow')
    expect(services.rename).toHaveBeenCalledWith(child.session, sideLabel('explain the event flow'))
  })

  it('synthetically closes an in-progress parent turn inside the seed', async () => {
    const parent = agent('parent', {
      events: [
        ev('user/message', 0, { content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }),
        ev('turn/start', 1, { turn: 1 }),
        ev('step/start', 2, { turn: 1, step: 1 }),
        ev('assistant/chunk', 3, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'streaming' } }),
      ],
    })
    const child = agent('child')
    const services = happyServices(parent, child)
    const api = buildSidechatApi(ctxWith(services))

    await api['sidechat.start']({ sessionId: 'parent', question: 'what now?' })

    const options = services.create.mock.calls[0]![0] as { seed: Array<{ type: string; data: Record<string, unknown> }> }
    expect(options.seed.map(event => event.type)).toEqual([
      'user/message', 'turn/start', 'step/start', 'assistant/chunk', 'step/end', 'turn/end',
      'subagent/descriptor',
    ])
    expect(options.seed.at(-2)?.data).toEqual({ turn: 1, reason: { kind: 'interrupted' } })
  })

  it('falls back to the snapshot when a tool call is still executing', async () => {
    const parent = agent('parent', {
      events: [
        ev('user/message', 0, { content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }),
        ev('turn/start', 1, { turn: 1 }),
        ev('step/start', 2, { turn: 1, step: 1 }),
        ev('tool/call', 3, { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"cmd":"sleep"}' }),
      ],
    })
    const child = agent('child')
    const services = happyServices(parent, child)
    const api = buildSidechatApi(ctxWith(services))

    await api['sidechat.start']({ sessionId: 'parent', question: 'what now?' })

    const options = services.create.mock.calls[0]![0] as { seed: Array<{ type: string }> }
    // Cut BEFORE the open turn: only the pending user message is inherited.
    expect(options.seed.map(event => event.type)).toEqual(['user/message', 'subagent/descriptor'])
    const message = child.followup.mock.calls[0]![0] as { content: Array<{ text: string }> }
    expect(message.content[0]!.text).toContain('`bash` (executing)')
  })

  it('creates an EMPTY thread on a blank question (Codex-style immediate create)', async () => {
    const parent = agent('parent', {
      events: [
        ev('user/message', 0, { content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }),
        ev('turn/start', 1, { turn: 1 }),
        ev('step/start', 2, { turn: 1, step: 1 }),
        ev('tool/call', 3, { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"cmd":"sleep"}' }),
      ],
    })
    const child = agent('child')
    const services = happyServices(parent, child)
    const api = buildSidechatApi(ctxWith(services))

    const { childId } = await api['sidechat.start']({ sessionId: 'parent', question: '   ' })

    // No prompt yet: the composer owns the first message; the placeholder
    // label is pinned and the in-progress snapshot is parked for it.
    expect(child.followup).not.toHaveBeenCalled()
    expect(services.rename).toHaveBeenCalledWith(child.session, SIDE_NEW_THREAD_TITLE)

    // The first prompt carries the boundary + the parked snapshot and earns
    // the thread its real label.
    services.agents.get = vi.fn((id: unknown) => (id === childId ? child : parent))
    await api['sidechat.prompt']({ childId, text: 'explain the event flow' })
    expect(child.followup).toHaveBeenCalledTimes(1)
    const message = child.followup.mock.calls[0]![0] as { content: Array<{ text: string }> }
    expect(message.content[0]!.text.startsWith(SIDE_BOUNDARY_PROMPT)).toBe(true)
    expect(message.content[0]!.text).toContain('`bash` (executing)')
    expect(message.content[0]!.text).toContain('explain the event flow')
    expect(services.rename).toHaveBeenCalledWith(child.session, sideLabel('explain the event flow'))
  })

  it('rejects a non-running parent', async () => {
    const parent = agent('parent', { events: [] })
    const child = agent('child')
    const services = happyServices(parent, child)
    const idle = ctxWith({
      ...services,
      agents: { ...services.agents, get: vi.fn((_id: unknown) => undefined) },
    })
    const idleApi = buildSidechatApi(idle)
    await expect(idleApi['sidechat.start']({ sessionId: 'parent', question: 'q' })).rejects.toThrow(/not running/)
  })

  it('degrades when the agents service is absent', async () => {
    const api = buildSidechatApi(ctxWith({}))
    await expect(api['sidechat.start']({ sessionId: 'parent', question: 'q' })).rejects.toThrow(SidebarError)
  })
})

describe('sidechat.prompt', () => {
  it('delivers follow-ups to a live agent (boundary already delivered)', async () => {
    const child = agent('child', {
      events: [
        ev('user/message', 0, {
          content: [{ type: 'text', text: `${SIDE_BOUNDARY_PROMPT}\n\nfirst question` }],
          source: { kind: 'user' },
        }),
      ],
    })
    const services = happyServices(undefined, child)
    const api = buildSidechatApi(ctxWith(services))
    const result = await api['sidechat.prompt']({ childId: 'child', text: 'tell me more' })
    expect(result).toEqual({ accepted: true })
    expect(child.followup).toHaveBeenCalledTimes(1)
    const message = child.followup.mock.calls[0]![0] as { content: Array<{ text: string }> }
    expect(message.content[0]!.text).toBe('tell me more')
  })

  it('cold-resumes the thread when the agent is gone', async () => {
    const child = agent('child')
    const services = happyServices(undefined, child)
    services.agents.get = vi.fn((_id: unknown) => undefined)
    const api = buildSidechatApi(ctxWith(services))
    await api['sidechat.prompt']({ childId: 'child', text: 'after restart' })
    expect(services.resume).toHaveBeenCalledTimes(1)
    const resumeOptions = services.resume.mock.calls[0]![0] as { resumeSessionId: string; setup: unknown }
    expect(resumeOptions.resumeSessionId).toBe('child')
    expect(typeof resumeOptions.setup).toBe('function')
    expect(services.inspect).toHaveBeenCalledWith('child')
    expect(child.followup).toHaveBeenCalledTimes(1)
  })

  it('rejects blank text', async () => {
    const child = agent('child')
    const services = happyServices(undefined, child)
    const api = buildSidechatApi(ctxWith(services))
    await expect(api['sidechat.prompt']({ childId: 'child', text: '' })).rejects.toThrow(SidebarError)
  })
})

describe('sidechat.cancel and sidechat.dispose', () => {
  it('cancels the running turn with the user authority', async () => {
    const child = agent('child')
    const services = happyServices(undefined, child)
    const api = buildSidechatApi(ctxWith(services))
    await api['sidechat.cancel']({ childId: 'child' })
    expect(child.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
  })

  it('disposes the created thread agent', async () => {
    const parent = agent('parent', { events: [] })
    const dispose = vi.fn(async () => {})
    const create = vi.fn(async (_options: unknown): Promise<Handle> => ({
      agent: agent('child'),
      dispose,
    }))
    const services = happyServices(parent, agent('child'))
    services.agents.create = create
    const api = buildSidechatApi(ctxWith(services))
    const { childId } = await api['sidechat.start']({ sessionId: 'parent', question: 'q' })
    await api['sidechat.dispose']({ childId })
    expect(dispose).toHaveBeenCalledTimes(1)
    // A second dispose is a harmless no-op.
    await api['sidechat.dispose']({ childId })
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})

describe('sidechat.info', () => {
  it('reports the live agent state and identity', async () => {
    const child = agent('child')
    const services = happyServices(undefined, child)
    const api = buildSidechatApi(ctxWith(services))
    const info = await api['sidechat.info']({ childId: 'child' })
    expect(info).toEqual({
      live: true,
      status: 'idle',
      provider: 'test',
      model: 'model-x',
      preset: 'preset-a',
    })
  })

  it('reports the persisted preset of a cold thread', async () => {
    const child = agent('child')
    const services = happyServices(undefined, child)
    services.agents.get = vi.fn((_id: unknown) => undefined)
    const api = buildSidechatApi(ctxWith(services))
    const info = await api['sidechat.info']({ childId: 'child' })
    expect(info).toEqual({ live: false, preset: 'preset-a' })
    expect(services.inspect).toHaveBeenCalledWith('child')
  })

  it('degrades to a bare cold info when the session is gone', async () => {
    const services = happyServices(undefined, agent('child'))
    services.agents.get = vi.fn((_id: unknown) => undefined)
    services.inspect = vi.fn(async () => { throw new Error('unknown session') })
    services.sessionPersistence = { inspect: services.inspect }
    const api = buildSidechatApi(ctxWith(services))
    await expect(api['sidechat.info']({ childId: 'ghost' })).resolves.toEqual({ live: false })
  })
})
