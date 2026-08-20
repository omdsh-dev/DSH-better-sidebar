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
import { SIDE_BOUNDARY_PROMPT, sideLabel } from '../src/sidechat-core.ts'
import type { Context } from '../src/context-types.ts'

/** A fake live agent (followup/cancel spied). */
function agent(id: string, over: { events?: unknown[]; header?: Record<string, unknown>; provider?: string; model?: string } = {}) {
  return {
    id,
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

function ev(type: string, seq: number, data: Record<string, unknown> = {}): { type: string; seq: number; time: number; data: Record<string, unknown> } {
  return { type, seq, time: seq * 1000, data }
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
      seed: readonly { type: string }[]
      agentOptions: { provider: string; model: string }
      setup: unknown
    }
    expect(options.sessionId).toBe(result.childId)
    expect(options.meta).toMatchObject({
      parentSession: 'parent',
      origin: 'subagent',
      seedLength: 6,
      delegationDepth: 1,
      agentPreset: 'preset-a',
      cwd: '/p',
    })
    expect(options.agentOptions).toEqual({ provider: 'test', model: 'model-x' })
    // The child carries the parent's completed turns as a verbatim seed.
    expect(options.seed.map(event => event.type)).toEqual([
      'user/message', 'turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end',
    ])
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
    ])
    expect(options.seed.at(-1)?.data).toEqual({ turn: 1, reason: { kind: 'interrupted' } })
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
    expect(options.seed.map(event => event.type)).toEqual(['user/message'])
    const message = child.followup.mock.calls[0]![0] as { content: Array<{ text: string }> }
    expect(message.content[0]!.text).toContain('`bash` (executing)')
  })

  it('rejects a blank question and a non-running parent', async () => {
    const parent = agent('parent', { events: [] })
    const child = agent('child')
    const services = happyServices(parent, child)
    const api = buildSidechatApi(ctxWith(services))
    await expect(api['sidechat.start']({ sessionId: 'parent', question: '   ' })).rejects.toThrow(SidebarError)
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
  it('delivers follow-ups to a live agent', async () => {
    const child = agent('child')
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
