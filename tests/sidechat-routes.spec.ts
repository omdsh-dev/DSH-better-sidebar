/**
 * Host route tests for the Side Chat API ('sidechat.start' / 'sidechat.prompt'
 * / 'sidechat.cancel' / 'sidechat.dispose' / 'sidechat.info' /
 * 'sidechat.events'): the custom-seed thread creation (with the
 * in-progress-turn synthetic close and the dangling-tool-call snapshot
 * fallback), the boundary+question first prompt, follow-ups on live and cold
 * (resumed) agents, cancel, dispose, and the transcript reads (seed cut,
 * afterSeq deltas, tail cap, live/persisted sources).
 */
import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import { Session, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent'
import { buildSidechatApi } from '../src/sidechat-routes.ts'
import { SidebarError } from '../src/wire.ts'
import { buildSidechatInheritance, SIDE_BOUNDARY_PROMPT, SIDE_INJECTION_SOURCE_KIND, SIDE_NEW_THREAD_TITLE, sideLabel } from '../src/sidechat-core.ts'
import type { Context } from '../src/context-types.ts'

/** A fake live agent (inject/followup/cancel/inbox spied). */
function agent(id: string, over: {
  events?: unknown[]
  header?: Record<string, unknown>
  provider?: string
  model?: string
  reasoningEffort?: string
  inheritedEventCount?: number
  nextTurn?: unknown[]
  nextStep?: unknown[]
} = {}) {
  const inbox = {
    nextTurn: over.nextTurn ?? [] as unknown[],
    nextStep: over.nextStep ?? [] as unknown[],
    clear: vi.fn(),
    remove: vi.fn((_id: string) => true),
  }
  return {
    id,
    status: 'idle' as const,
    options: {
      provider: over.provider ?? 'test',
      model: over.model ?? 'model-x',
      ...(over.reasoningEffort !== undefined ? { reasoningEffort: over.reasoningEffort } : {}),
    },
    // The agent-scoped context `installModelSelection` binds its prompt /
    // request waterfalls to; the fake records the listeners' existence only.
    ctx: { on: vi.fn((_event: string, _listener: unknown) => () => {}) },
    session: {
      id,
      header: { cwd: '/p', delegationDepth: 0, agentPreset: 'preset-a', ...over.header },
      inheritedEventCount: over.inheritedEventCount ?? 0,
      snapshotEvents: () => over.events ?? [],
      append: vi.fn((_type: string, _data: unknown) => ({ type: _type, seq: 0, time: 0, data: _data })),
    },
    inject: vi.fn(),
    followup: vi.fn(),
    cancel: vi.fn(),
    inbox,
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
  /** The 0.1.5 persistence face: open(id, 'read') -> handle.read() -> close(). */
  const open = vi.fn(async (_id?: string): Promise<{
    header: { agentPreset?: string; cwd?: string }
    inheritedEventCount: number
    read: () => Promise<{ events: unknown[] }>
    close: () => Promise<void>
  }> => ({
    header: { agentPreset: 'preset-a' },
    inheritedEventCount: 0,
    read: async () => ({ events: [] }),
    close: async () => {},
  }))
  return {
    agents: { get, create, resume },
    agentPresets: { resolve, mount },
    sessionTitle: { rename },
    sessionPersistence: { open },
    create,
    resume,
    get,
    rename,
    mount,
    open,
  }
}

/** A context serving the optional services the routes read via ctx.get. */
function ctxWith(services: {
  agents?: unknown
  agentPresets?: unknown
  sessionTitle?: unknown
  sessionPersistence?: unknown
  llm?: unknown
  sessionController?: unknown
  workingDirectory?: unknown
}): Context {
  const table: Record<string, unknown> = {
    ...(services.workingDirectory === undefined ? {} : { workingDirectory: services.workingDirectory }),
    ...(services.agents === undefined ? {} : { agents: services.agents }),
    ...(services.agentPresets === undefined ? {} : { agentPresets: services.agentPresets }),
    ...(services.sessionTitle === undefined ? {} : { sessionTitle: services.sessionTitle }),
    ...(services.sessionPersistence === undefined ? {} : { sessionPersistence: services.sessionPersistence }),
    ...(services.llm === undefined ? {} : { llm: services.llm }),
    ...(services.sessionController === undefined ? {} : { sessionController: services.sessionController }),
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
  it('creates a sidechat in the current execution directory, not the original header cwd', async () => {
    const parent = agent('parent')
    const services = happyServices(parent, agent('child'))
    const get = vi.fn((session: unknown) => {
      expect(session).toBe(parent.session)
      return '/current-execution-directory'
    })
    const api = buildSidechatApi(ctxWith({ ...services, workingDirectory: { get } }))
    await api['sidechat.start']({ sessionId: 'parent', question: 'current project' })
    expect(services.create.mock.calls[0]![0]).toMatchObject({ meta: { cwd: '/current-execution-directory' } })
    expect(get).toHaveBeenCalledOnce()
  })

  it('stamps current cwd after a truncated seed so the real working-directory projection cannot restore an older cwd', async () => {
    const original = resolve('/original-project')
    const previous = resolve('/previous-execution')
    const current = resolve('/current-execution')
    const parent = agent('parent', {
      header: { cwd: original },
      events: [
        ev('working-directory/change', 0, { cwd: previous }),
        ev('turn/start', 1, { turn: 1 }),
        ev('step/start', 2, { turn: 1, step: 1 }),
        ev('working-directory/change', 3, { cwd: current }),
        ev('tool/call', 4, { turn: 1, step: 1, callId: 'pending', name: 'bash', arguments: '{}' }),
      ],
    })
    type DirectoryProjection = {
      init(header: { cwd?: string }): string | null
      apply(state: string | null, event: SessionEvent): string | null
    }
    let registered: DirectoryProjection | undefined
    // Capture the REAL alpha.5 unit contributed by the host service. These
    // context seams do not run system-prompt assembly, fs checks, or notices.
    const workingDirectory = new WorkingDirectoryService({
      reflect: { provide: () => {} },
      sessionProjections: {
        register: (definition: DirectoryProjection) => { registered = definition },
        stateOf: (session: { header: { cwd?: string }; snapshotEvents(): SessionEvent[] }) => {
          if (registered === undefined) throw new Error('working-directory unit not registered')
          return session.snapshotEvents().reduce((cwd, event) => registered!.apply(cwd, event), registered.init(session.header))
        },
      },
      systemPrompt: { context: () => {}, getContextOrder: () => 0 },
      on: () => {},
      effect: () => {},
    } as never, {})
    expect(workingDirectory.get(parent.session as never)).toBe(current)
    const services = happyServices(parent, agent('child'))
    await buildSidechatApi(ctxWith({ ...services, workingDirectory }))['sidechat.start']({ sessionId: 'parent' })
    const options = services.create.mock.calls[0]![0] as {
      sessionId: SessionId; meta: Partial<SessionHeader>; seed: readonly SessionEvent[]; inheritedEventCount: number
    }
    const projection = registered!
    // Control proves that merely changing meta.cwd is insufficient: the
    // dangling-call cut dropped current but retained previous in the seed.
    const unstamped = buildSidechatInheritance(parent.session.snapshotEvents() as never).seed
    expect(unstamped.map(event => event.type)).toEqual(['working-directory/change'])
    expect(unstamped.reduce((cwd, event) => projection.apply(cwd, event as SessionEvent), projection.init({ cwd: current }))).toBe(previous)
    const child = Session.create(options.sessionId, options.seed, {
      ...options.meta, id: options.sessionId, version: SESSION_FORMAT_VERSION, createdAt: Date.now(), isSeeded: true,
    }, SessionLogOffset(options.inheritedEventCount))
    expect(child.header.cwd).toBe(current)
    expect(options.seed.every((event, index) => event.seq === index)).toBe(true)
    expect(child.ownEvents()[0]?.type).toBe('session/end-seed')
    expect(workingDirectory.get(child)).toBe(current)
    expect(options.seed.at(-2)).toMatchObject({ type: 'working-directory/change', data: { cwd: current } })
  })

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
      inheritedEventCount: number
      agentOptions: { provider: string; model: string }
      setup: unknown
    }
    expect(options.sessionId).toBe(result.childId)
    expect(options.meta).toMatchObject({
      parentSession: 'parent',
      origin: 'subagent',
      isSeeded: true,
      delegationDepth: 1,
      agentPreset: 'preset-a',
      cwd: '/p',
    })
    // The fork-marker pair is load-bearing: without it the child's Inbox
    // replays the parent's seed inbox splices and inherits whatever input sat
    // unclaimed in the parent (see sidechat-seed-validation.spec.ts).
    expect(options.inheritedEventCount).toBe(options.seed.length)
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
      // The descriptor version is stamped by the host package's
      // snapshotSubagentDescriptor — follow it instead of pinning a literal
      // (bumped 2 → 3 in DSH 0.1.2-alpha.2).
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 'sidechat',
      label: sideLabel('explain the event flow'),
      agentProvider: 'test',
      agentModel: 'model-x',
    })
    // First contact is SPLIT: the boundary rides agent.inject (plugin-stamped
    // context, no wake), the question is the follow-up that wakes the driver.
    // The stamp is the plugin's producer-owned kind: session format v4
    // refuses the retired bare `kind: 'plugin'` at log read-back.
    expect(child.inject).toHaveBeenCalledTimes(1)
    const injection = child.inject.mock.calls[0]![0] as { content: Array<{ type: string; text: string }>; source: { kind: string } }
    expect(injection.source).toEqual({ kind: SIDE_INJECTION_SOURCE_KIND })
    expect(injection.source).toEqual({ kind: 'plugin:dsh-better-sidebar' })
    expect(injection.content[0]!.text.startsWith(SIDE_BOUNDARY_PROMPT)).toBe(true)
    expect(injection.content[0]!.text).not.toContain('explain the event flow')
    expect(child.followup).toHaveBeenCalledTimes(1)
    const message = child.followup.mock.calls[0]![0] as { content: Array<{ type: string; text: string }>; source: { kind: string } }
    expect(message.source).toEqual({ kind: 'user' })
    expect(message.content[0]!.text).toBe('explain the event flow')
    // The fork markers alone do not empty the RUNTIME inbox (the projection
    // folds the full log, seed prefix included — see
    // sidechat-seed-validation.spec.ts), so the route must durably clear the
    // child inbox right after create, BEFORE any message is sent: the first
    // side prompt would otherwise claim and send the parent's unclaimed
    // queued input ahead of the boundary + question.
    expect(child.inbox.clear).toHaveBeenCalledTimes(1)
    expect(child.inbox.clear.mock.invocationCallOrder[0])
      .toBeLessThan(child.inject.mock.invocationCallOrder[0]!)
    expect(child.inbox.clear.mock.invocationCallOrder[0])
      .toBeLessThan(child.followup.mock.invocationCallOrder[0]!)
    expect(services.rename).toHaveBeenCalledWith(child.session, sideLabel('explain the event flow'))
  })

  it('synthetically closes an in-progress parent turn inside the seed', async () => {
    const parent = agent('parent', {
      events: [
        ev('user/message', 0, { content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }),
        ev('turn/start', 1, { turn: 1 }),
        ev('step/start', 2, { turn: 1, step: 1 }),
      ],
    })
    const child = agent('child')
    const services = happyServices(parent, child)
    const api = buildSidechatApi(ctxWith(services))

    await api['sidechat.start']({ sessionId: 'parent', question: 'what now?' })

    const options = services.create.mock.calls[0]![0] as { seed: Array<{ type: string; data: Record<string, unknown> }> }
    expect(options.seed.map(event => event.type)).toEqual([
      'user/message', 'turn/start', 'step/start', 'step/end', 'turn/end',
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
    // The snapshot rides the injection, not the follow-up question.
    const injection = child.inject.mock.calls[0]![0] as { content: Array<{ text: string }> }
    expect(injection.content[0]!.text).toContain('`bash` (executing)')
    const message = child.followup.mock.calls[0]![0] as { content: Array<{ text: string }> }
    expect(message.content[0]!.text).toBe('what now?')
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

    // The empty thread carries the same fork-marker pair (isSeeded +
    // inheritedEventCount = seed length) as the prompted create.
    const options = services.create.mock.calls[0]![0] as {
      meta: Record<string, unknown>
      seed: readonly { type: string }[]
      inheritedEventCount: number
    }
    expect(options.meta.isSeeded).toBe(true)
    expect(options.inheritedEventCount).toBe(options.seed.length)

    // No prompt yet: the composer owns the first message; the placeholder
    // label is pinned and the in-progress snapshot is parked for it.
    expect(child.inject).not.toHaveBeenCalled()
    expect(child.followup).not.toHaveBeenCalled()
    // The empty thread clears its inherited inbox too: the phantom would sit
    // unclaimed until the composer's first prompt claims it.
    expect(child.inbox.clear).toHaveBeenCalledTimes(1)
    expect(services.rename).toHaveBeenCalledWith(child.session, SIDE_NEW_THREAD_TITLE)

    // The first prompt injects the boundary + the parked snapshot (split
    // from the question) and earns the thread its real label.
    services.agents.get = vi.fn((id: unknown) => (id === childId ? child : parent))
    await api['sidechat.prompt']({ childId, text: 'explain the event flow' })
    expect(child.inject).toHaveBeenCalledTimes(1)
    const injection = child.inject.mock.calls[0]![0] as { content: Array<{ text: string }>; source: { kind: string } }
    expect(injection.source.kind).toBe(SIDE_INJECTION_SOURCE_KIND)
    expect(injection.content[0]!.text.startsWith(SIDE_BOUNDARY_PROMPT)).toBe(true)
    expect(injection.content[0]!.text).toContain('`bash` (executing)')
    expect(child.followup).toHaveBeenCalledTimes(1)
    const message = child.followup.mock.calls[0]![0] as { content: Array<{ text: string }> }
    expect(message.content[0]!.text).toBe('explain the event flow')
    expect(services.rename).toHaveBeenCalledWith(child.session, sideLabel('explain the event flow'))
  })

  it('inherits the parent CURRENT model selection, not the stale options snapshot', async () => {
    const parent = agent('parent', {
      provider: 'ark-code',
      model: 'glm-5.3-flash', // the creation-time deployment default (agent.options)
      events: [
        ev('request/header', 0, { header: { config: { provider: 'ark-code', model: 'glm-5.3-flash' } } }),
        // A composer switch NEVER rewrites agent.options — it appends this
        // durable event and the session-local selection routes requests.
        // The child must inherit the model the parent's composer shows, not
        // the frozen creation default (issue #368: side threads silently
        // ran the deployment default after an explicit parent switch).
        ev('model/selection', 1, { provider: 'openrouter', model: 'ox-alpha', reasoningEffort: 'high' }),
      ],
    })
    const child = agent('child')
    const services = happyServices(parent, child)
    const api = buildSidechatApi(ctxWith(services))

    await api['sidechat.start']({ sessionId: 'parent', question: 'side question' })

    const options = services.create.mock.calls[0]![0] as {
      agentOptions: Record<string, unknown>
      seed: readonly { type: string; data: Record<string, unknown> }[]
    }
    expect(options.agentOptions).toEqual({ provider: 'openrouter', model: 'ox-alpha', reasoningEffort: 'high' })
    // The durable descriptor keeps the same route (honest catalog row).
    expect(options.seed.at(-1)?.data).toMatchObject({
      agentProvider: 'openrouter',
      agentModel: 'ox-alpha',
    })
  })

  it('inherits the parent last-used route from its request headers when no explicit switch is pending', async () => {
    const parent = agent('parent', {
      // agent.options still holds the creation default...
      provider: 'ark-code',
      model: 'glm-5.3-flash',
      events: [
        // ...but the session has been running on another route since.
        ev('request/header', 0, { header: { config: { provider: 'gemini', model: 'gemini-3.7-flash-high' } } }),
      ],
    })
    const child = agent('child')
    const services = happyServices(parent, child)
    const api = buildSidechatApi(ctxWith(services))

    await api['sidechat.start']({ sessionId: 'parent', question: 'side question' })

    const options = services.create.mock.calls[0]![0] as { agentOptions: Record<string, unknown> }
    expect(options.agentOptions).toEqual({ provider: 'gemini', model: 'gemini-3.7-flash-high' })
  })

  it('inherits reasoningEffort from request headers when not marked as adapter default', async () => {
    const parent = agent('parent', {
      provider: 'ark-code',
      model: 'glm-5.3-flash',
      events: [
        ev('request/header', 0, {
          header: {
            config: { provider: 'openrouter', model: 'ox-alpha', reasoningEffort: 'high' },
          },
        }),
      ],
    })
    const child = agent('child')
    const services = happyServices(parent, child)
    const api = buildSidechatApi(ctxWith(services))

    await api['sidechat.start']({ sessionId: 'parent', question: 'side question' })

    const options = services.create.mock.calls[0]![0] as { agentOptions: Record<string, unknown> }
    expect(options.agentOptions).toEqual({
      provider: 'openrouter',
      model: 'ox-alpha',
      reasoningEffort: 'high',
    })
  })

  it('drops adapter-default reasoningEffort from request headers', async () => {
    const parent = agent('parent', {
      provider: 'ark-code',
      model: 'glm-5.3-flash',
      events: [
        ev('request/header', 0, {
          header: {
            config: { provider: 'openrouter', model: 'ox-alpha', reasoningEffort: 'low' },
            adapterDefaults: { reasoningEffort: true },
          },
        }),
      ],
    })
    const child = agent('child')
    const services = happyServices(parent, child)
    const api = buildSidechatApi(ctxWith(services))

    await api['sidechat.start']({ sessionId: 'parent', question: 'side question' })

    const options = services.create.mock.calls[0]![0] as { agentOptions: Record<string, unknown> }
    expect(options.agentOptions).toEqual({
      provider: 'openrouter',
      model: 'ox-alpha',
    })
  })

  it('clears stale parent options reasoningEffort when parent switches to a model without effort', async () => {
    const parent = agent('parent', {
      provider: 'oai',
      model: 'o1',
      reasoningEffort: 'high',
      events: [
        ev('model/selection', 0, { provider: 'ark-code', model: 'glm-5.3-flash' }),
      ],
    })
    const child = agent('child')
    const services = happyServices(parent, child)
    const api = buildSidechatApi(ctxWith(services))

    await api['sidechat.start']({ sessionId: 'parent', question: 'side question' })

    const options = services.create.mock.calls[0]![0] as { agentOptions: Record<string, unknown> }
    expect(options.agentOptions).toEqual({
      provider: 'ark-code',
      model: 'glm-5.3-flash',
    })
    expect(options.agentOptions.reasoningEffort).toBeUndefined()
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
    expect(child.inject).not.toHaveBeenCalled()
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
    expect(services.open).toHaveBeenCalledWith('child', 'read')
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
    expect(services.open).toHaveBeenCalledWith('child', 'read')
  })

  it('degrades to a bare cold info when the session is gone', async () => {
    const services = happyServices(undefined, agent('child'))
    services.agents.get = vi.fn((_id: unknown) => undefined)
    services.open = vi.fn(async () => { throw new Error('unknown session') })
    services.sessionPersistence = { open: services.open }
    const api = buildSidechatApi(ctxWith(services))
    await expect(api['sidechat.info']({ childId: 'ghost' })).resolves.toEqual({ live: false })
  })
})

/** A realistic thread log: the inherited seed, the end-seed marker, the
 *  descriptor the seed appends, and the thread's own conversation. */
function threadLog(): Array<ReturnType<typeof ev>> {
  return [
    ev('user/message', 0, { content: [{ type: 'text', text: 'inherited parent question' }], source: { kind: 'user' } }),
    ev('turn/end', 1, { turn: 0, reason: { kind: 'completed' } }),
    ev('session/end-seed', 2),
    ev('subagent/descriptor', 3, { mode: 'continuable' }),
    ev('user/message', 4, { content: [{ type: 'text', text: 'Side conversation boundary.' }], source: { kind: SIDE_INJECTION_SOURCE_KIND } }),
    ev('user/message', 5, { content: [{ type: 'text', text: 'the side question' }], source: { kind: 'user' } }),
    ev('assistant/attempt', 6, { turn: 1, step: 1, stream: [] }),
    ev('assistant/attempt', 7, { turn: 1, step: 1, stream: [] }),
  ]
}

describe('sidechat.events', () => {
  it('returns the thread-own slice from the LIVE agent log (seed cut host-side)', async () => {
    const child = agent('child', { events: threadLog() })
    const services = happyServices(undefined, child)
    const api = buildSidechatApi(ctxWith(services))
    const result = await api['sidechat.events']({ childId: 'child' })
    expect(result.events.map(event => event.seq)).toEqual([3, 4, 5, 6, 7])
    expect(result.events[0]).toMatchObject({ type: 'subagent/descriptor', seq: 3 })
    expect(services.open).not.toHaveBeenCalled()
  })

  it('narrows to the afterSeq delta on polls (and never resurrects the seed)', async () => {
    const child = agent('child', { events: threadLog() })
    const services = happyServices(undefined, child)
    const api = buildSidechatApi(ctxWith(services))
    const delta = await api['sidechat.events']({ childId: 'child', afterSeq: 6 })
    expect(delta.events.map(event => event.seq)).toEqual([7])
    // An afterSeq below the boundary must still not return the inherited seed.
    const fromZero = await api['sidechat.events']({ childId: 'child', afterSeq: 0 })
    expect(fromZero.events.map(event => event.seq)).toEqual([3, 4, 5, 6, 7])
  })

  it('reads a COLD thread from persistence when no agent is live', async () => {
    const child = agent('child')
    const services = happyServices(undefined, child)
    services.agents.get = vi.fn((_id: unknown) => undefined)
    services.open.mockImplementation(async () => ({
      header: { agentPreset: 'preset-a' },
      inheritedEventCount: 0,
      read: async () => ({ events: threadLog() }),
      close: async () => {},
    }))
    const api = buildSidechatApi(ctxWith(services))
    const result = await api['sidechat.events']({ childId: 'child' })
    expect(result.events.map(event => event.seq)).toEqual([3, 4, 5, 6, 7])
    expect(services.open).toHaveBeenCalledWith('child', 'read')
  })

  /**
   * A cold thread is re-read on EVERY poll, and each read decodes the whole
   * persisted log and scans it back to `session/end-seed`. The memo keys on the
   * stored artifact's identity (the host's change token + physical size), so a
   * repeat poll costs one `stat` while a changed artifact re-reads — and the
   * handle is still opened and closed.
   */
  it('reads a cold thread once per stored-artifact identity', async () => {
    const child = agent('child')
    const services = happyServices(undefined, child)
    services.agents.get = vi.fn((_id: unknown) => undefined)
    const read = vi.fn(async () => ({ events: threadLog() }))
    const close = vi.fn(async () => {})
    services.open.mockImplementation(async () => ({
      header: { agentPreset: 'preset-a' },
      inheritedEventCount: 0,
      read,
      close,
    }))
    let revision = 'mtime-1:size-4096'
    const stat = vi.fn(async () => ({ revision, sizeBytes: 4_096 }))
    // `stat` is read structurally at runtime (the plugin's mirror of the host
    // service models the handle API only), so the fake attaches it here.
    const persistence = services.sessionPersistence as { stat?: unknown }
    persistence.stat = stat
    const api = buildSidechatApi(ctxWith(services))

    const first = await api['sidechat.events']({ childId: 'cold-memo' })
    expect(first.events.map(event => event.seq)).toEqual([3, 4, 5, 6, 7])
    const second = await api['sidechat.events']({ childId: 'cold-memo' })
    expect(second.events.map(event => event.seq)).toEqual([3, 4, 5, 6, 7])
    // Same identity: ONE handle, ONE read, and the handle was closed.
    expect(stat).toHaveBeenCalledTimes(2)
    expect(services.open).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)

    // A new mtime is a new identity: the memo must not serve the stale log.
    revision = 'mtime-2:size-8192'
    await api['sidechat.events']({ childId: 'cold-memo' })
    expect(services.open).toHaveBeenCalledTimes(2)
    expect(read).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledTimes(2)
  })

  /** The memo is bounded: a thread past the cap is re-read, not remembered. */
  it('bounds the cold-log memo', async () => {
    const services = happyServices(undefined, agent('child'))
    services.agents.get = vi.fn((_id: unknown) => undefined)
    const read = vi.fn(async () => ({ events: threadLog() }))
    services.open.mockImplementation(async () => ({
      header: { agentPreset: 'preset-a' },
      inheritedEventCount: 0,
      read,
      close: async () => {},
    }))
    const persistence = services.sessionPersistence as { stat?: unknown }
    persistence.stat = vi.fn(async (id: string) => ({ revision: `rev-${id}`, sizeBytes: 1 }))
    const api = buildSidechatApi(ctxWith(services))

    const cap = 16
    for (let index = 0; index <= cap; index += 1) {
      await api['sidechat.events']({ childId: `cold-lru-${index}` })
    }
    expect(services.open).toHaveBeenCalledTimes(cap + 1)

    // The newest thread still hits; the oldest was evicted and re-reads.
    await api['sidechat.events']({ childId: `cold-lru-${cap}` })
    expect(services.open).toHaveBeenCalledTimes(cap + 1)
    await api['sidechat.events']({ childId: 'cold-lru-0' })
    expect(services.open).toHaveBeenCalledTimes(cap + 2)
  })

  it('falls back to an uncached read when the host exposes no stat', async () => {
    const child = agent('child')
    const services = happyServices(undefined, child)
    services.agents.get = vi.fn((_id: unknown) => undefined)
    const read = vi.fn(async () => ({ events: threadLog() }))
    services.open.mockImplementation(async () => ({
      header: { agentPreset: 'preset-a' },
      inheritedEventCount: 0,
      read,
      close: async () => {},
    }))
    const api = buildSidechatApi(ctxWith(services))
    await api['sidechat.events']({ childId: 'cold-no-stat' })
    await api['sidechat.events']({ childId: 'cold-no-stat' })
    expect(services.open).toHaveBeenCalledTimes(2)
  })

  it('returns a marker-less legacy log whole', async () => {
    const child = agent('child', {
      events: [
        ev('user/message', 0, { content: [{ type: 'text', text: 'legacy' }], source: { kind: 'user' } }),
        ev('assistant/message', 1, { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'a' }] } }),
      ],
    })
    const services = happyServices(undefined, child)
    const api = buildSidechatApi(ctxWith(services))
    const result = await api['sidechat.events']({ childId: 'child' })
    expect(result.events.map(event => event.seq)).toEqual([0, 1])
  })

  it('caps a pathological response at its tail (8000 events)', async () => {
    const events = Array.from({ length: 8_003 }, (_, index) => ev('assistant/attempt', index, { turn: 1, step: 1, stream: [] }))
    const child = agent('child', { events })
    const services = happyServices(undefined, child)
    const api = buildSidechatApi(ctxWith(services))
    const result = await api['sidechat.events']({ childId: 'child' })
    expect(result.events).toHaveLength(8_000)
    expect(result.events[0]).toMatchObject({ seq: 3 })
    expect(result.events.at(-1)).toMatchObject({ seq: 8_002 })
  })

  it('rejects an invalid afterSeq and reports a missing thread as not-found', async () => {
    const child = agent('child', { events: threadLog() })
    const services = happyServices(undefined, child)
    const api = buildSidechatApi(ctxWith(services))
    await expect(api['sidechat.events']({ childId: 'child', afterSeq: -1 }))
      .rejects.toMatchObject({ code: 'bad-request' })
    await expect(api['sidechat.events']({ childId: 'child', afterSeq: 1.5 }))
      .rejects.toMatchObject({ code: 'bad-request' })

    services.agents.get = vi.fn((_id: unknown) => undefined)
    services.open.mockImplementation(async () => { throw new Error('no such session') })
    await expect(api['sidechat.events']({ childId: 'ghost' }))
      .rejects.toMatchObject({ code: 'not-found', status: 404 })
  })

  it('fails loudly when a cold thread has no persistence service to read', async () => {
    const services = happyServices(undefined, agent('child'))
    const api = buildSidechatApi(ctxWith({
      agents: { ...services.agents, get: vi.fn((_id: unknown) => undefined) },
    }))
    await expect(api['sidechat.events']({ childId: 'child' }))
      .rejects.toMatchObject({ code: 'sidechat-error', status: 503 })
  })
})

/** An inbox message as the durable log/splice shape carries it. */
function inboxMessage(id: string, text: string): { id: string; content: { type: string; text: string }[] } {
  return { id, content: [{ type: 'text', text }] }
}

describe('sidechat resume fences the inherited inbox by identity', () => {
  it('drops only the ghosts the inherited prefix folds to, never the user\'s own queue', async () => {
    // The seed prefix inserts a message the parent had ALREADY claimed (its
    // claim splice lives inside the open turn the seed truncates away), plus
    // a message this thread's user queued itself (inserted after the marker).
    const child = agent('child', {
      inheritedEventCount: 2,
      events: [
        ev('agent/inbox/spliced', 0, { target: 'next-turn', start: 0, inserted: [inboxMessage('ghost', 'parent task')] }),
        ev('session/end-seed', 1, { inherited: true }),
        ev('agent/inbox/spliced', 2, { target: 'next-turn', start: 0, inserted: [inboxMessage('mine', 'my own follow-up')] }),
      ],
      nextTurn: [inboxMessage('ghost', 'parent task'), inboxMessage('mine', 'my own follow-up')],
    })
    const services = happyServices(undefined, child)
    services.agents.get = vi.fn((_id: unknown) => undefined)
    const api = buildSidechatApi(ctxWith(services))
    await api['sidechat.prompt']({ childId: 'child', text: 'next' })

    expect(child.inbox.remove).toHaveBeenCalledTimes(1)
    expect(child.inbox.remove).toHaveBeenCalledWith('ghost')
    // The blanket clear would kill the user's legitimate queued input.
    expect(child.inbox.clear).not.toHaveBeenCalled()
    expect(child.followup).toHaveBeenCalledTimes(1)
  })

  it('never sweeps on the create path (nothing of the thread\'s own can be queued yet)', async () => {
    const parent = agent('parent', { events: [] })
    const child = agent('child', {
      inheritedEventCount: 2,
      events: [
        ev('agent/inbox/spliced', 0, { target: 'next-turn', start: 0, inserted: [inboxMessage('ghost', 'parent task')] }),
        ev('session/end-seed', 1, { inherited: true }),
      ],
      nextTurn: [inboxMessage('ghost', 'parent task')],
    })
    const services = happyServices(parent, child)
    services.agents.get = vi.fn((id: unknown) => (id === 'child' ? child : parent))
    const api = buildSidechatApi(ctxWith(services))
    await api['sidechat.start']({ sessionId: 'parent', question: 'q' })
    expect(child.inbox.clear).toHaveBeenCalledTimes(1)
    expect(child.inbox.remove).not.toHaveBeenCalled()
  })

  it('does not deliver a second boundary when the first is still unclaimed', async () => {
    const child = agent('child', {
      events: [],
      nextStep: [inboxMessage('b1', `${SIDE_BOUNDARY_PROMPT}\n\nsnapshot`)],
      nextTurn: [inboxMessage('q1', 'first question')],
    })
    const services = happyServices(undefined, child)
    const api = buildSidechatApi(ctxWith(services))
    await api['sidechat.prompt']({ childId: 'child', text: 'second question' })
    // Exactly one follow-up (the new question); no second boundary injection.
    expect(child.inject).not.toHaveBeenCalled()
    expect(child.followup).toHaveBeenCalledTimes(1)
    const message = child.followup.mock.calls[0]![0] as { content: { text: string }[] }
    expect(message.content[0]!.text).toBe('second question')
  })
})

describe('sidechat.events pending queue', () => {
  it('projects the live inbox in claim order (next-step before next-turn)', async () => {
    const child = agent('child', {
      events: threadLog(),
      nextStep: [inboxMessage('s1', 'steering')],
      nextTurn: [inboxMessage('t1', 'queued turn')],
    })
    const services = happyServices(undefined, child)
    const api = buildSidechatApi(ctxWith(services))
    const result = await api['sidechat.events']({ childId: 'child' })
    expect(result.pending).toEqual([
      { id: 's1', target: 'next-step', text: 'steering' },
      { id: 't1', target: 'next-turn', text: 'queued turn' },
    ])
  })

  it('reports nothing pending for a cold thread', async () => {
    const child = agent('child', { events: threadLog(), nextTurn: [inboxMessage('t1', 'queued')] })
    const services = happyServices(undefined, child)
    services.agents.get = vi.fn((_id: unknown) => undefined)
    const api = buildSidechatApi(ctxWith(services))
    const result = await api['sidechat.events']({ childId: 'child' })
    expect(result.pending).toEqual([])
  })

  it('degrades to nothing pending when the inbox is not readable', async () => {
    const child = agent('child', { events: threadLog() })
    Object.defineProperty(child.inbox, 'nextTurn', {
      get: () => { throw new Error('no inbox projection') },
    })
    const services = happyServices(undefined, child)
    const api = buildSidechatApi(ctxWith(services))
    const result = await api['sidechat.events']({ childId: 'child' })
    expect(result.pending).toEqual([])
  })
})

describe('sidechat.dequeue', () => {
  it('removes one pending message by id', async () => {
    const child = agent('child', { events: threadLog() })
    const services = happyServices(undefined, child)
    const api = buildSidechatApi(ctxWith(services))
    await expect(api['sidechat.dequeue']({ childId: 'child', messageId: 'm1' }))
      .resolves.toEqual({ accepted: true, removed: 1 })
    expect(child.inbox.remove).toHaveBeenCalledWith('m1')
    expect(child.inbox.clear).not.toHaveBeenCalled()
  })

  it('clears the whole queue and reports how many rows it held', async () => {
    const child = agent('child', {
      events: threadLog(),
      nextStep: [inboxMessage('s1', 'steering')],
      nextTurn: [inboxMessage('t1', 'queued')],
    })
    const services = happyServices(undefined, child)
    const api = buildSidechatApi(ctxWith(services))
    await expect(api['sidechat.dequeue']({ childId: 'child' }))
      .resolves.toEqual({ accepted: true, removed: 2 })
    expect(child.inbox.clear).toHaveBeenCalledTimes(1)
  })

  it('reports nothing removed for a cold thread and rejects a blank id', async () => {
    const child = agent('child', { events: threadLog() })
    const services = happyServices(undefined, child)
    services.agents.get = vi.fn((_id: unknown) => undefined)
    const api = buildSidechatApi(ctxWith(services))
    await expect(api['sidechat.dequeue']({ childId: 'child', messageId: 'm1' }))
      .resolves.toEqual({ accepted: true, removed: 0 })
    await expect(api['sidechat.dequeue']({ childId: 'child', messageId: '' }))
      .rejects.toMatchObject({ code: 'bad-request' })
  })
})

describe('sidechat.models and sidechat.model', () => {
  it('passes the host catalog through and degrades when the service is absent', async () => {
    const services = happyServices(undefined, agent('child'))
    const catalog = {
      default: { provider: 'p1', model: 'm1' },
      groups: [{ id: 'p1', name: 'Provider 1', models: [{ id: 'm1', name: 'Model 1' }] }],
      failures: [{ id: 'p2', message: 'no key' }],
    }
    const api = buildSidechatApi(ctxWith({
      ...services,
      sessionController: { modelCatalog: vi.fn(async () => catalog) },
    }))
    await expect(api['sidechat.models']({})).resolves.toEqual({
      available: true,
      default: catalog.default,
      groups: catalog.groups,
      failures: catalog.failures,
    })

    const bare = buildSidechatApi(ctxWith(services))
    await expect(bare['sidechat.models']({})).resolves.toEqual({ available: false, groups: [], failures: [] })
  })

  it('reports an unreadable catalog as unavailable instead of failing', async () => {
    const services = happyServices(undefined, agent('child'))
    const api = buildSidechatApi(ctxWith({
      ...services,
      sessionController: { modelCatalog: vi.fn(async () => { throw new Error('boom') }) },
    }))
    const result = await api['sidechat.models']({})
    expect(result.available).toBe(false)
    expect(result.failures).toEqual([{ id: 'host', message: 'boom' }])
  })

  it('normalizes, logs and installs a selection for the live thread', async () => {
    const child = agent('child-model', { events: threadLog() })
    const services = happyServices(undefined, child)
    const resolveCallConfig = vi.fn(async () => ({ provider: 'p2', model: 'm2', reasoningEffort: 'high' }))
    const api = buildSidechatApi(ctxWith({ ...services, llm: { resolveCallConfig } }))
    await expect(api['sidechat.model']({ childId: 'child-model', provider: 'p2', model: 'm2', reasoningEffort: 'high' }))
      .resolves.toEqual({
        accepted: true,
        selection: { provider: 'p2', model: 'm2', reasoningEffort: 'high' },
      })
    expect(resolveCallConfig).toHaveBeenCalledTimes(1)
    expect(child.session.append).toHaveBeenCalledWith('model/selection', {
      provider: 'p2',
      model: 'm2',
      reasoningEffort: 'high',
    })
    // The selection seam is installed ONCE per agent: the second switch of the
    // same thread only mutates the ref.
    const listeners = child.ctx.on.mock.calls.length
    expect(listeners).toBeGreaterThan(0)
    await api['sidechat.model']({ childId: 'child-model', provider: 'p2', model: 'm2' })
    expect(child.session.append).toHaveBeenCalledTimes(2)
    expect(child.ctx.on.mock.calls.length).toBe(listeners)
  })

  it('rejects an unavailable model with a bad-request', async () => {
    const child = agent('child', { events: threadLog() })
    const services = happyServices(undefined, child)
    const api = buildSidechatApi(ctxWith({
      ...services,
      llm: { resolveCallConfig: vi.fn(async () => { throw new Error('provider "p9" is not registered') }) },
    }))
    await expect(api['sidechat.model']({ childId: 'child', provider: 'p9', model: 'm9' }))
      .rejects.toMatchObject({ code: 'bad-request', status: 400 })
    expect(child.session.append).not.toHaveBeenCalled()
  })

  it('cold-resumes the thread before installing a selection', async () => {
    const child = agent('child', { events: threadLog() })
    const services = happyServices(undefined, child)
    services.agents.get = vi.fn((_id: unknown) => undefined)
    const api = buildSidechatApi(ctxWith(services))
    await api['sidechat.model']({ childId: 'child', provider: 'p3', model: 'm3' })
    expect(services.resume).toHaveBeenCalledTimes(1)
    expect(child.session.append).toHaveBeenCalledWith('model/selection', { provider: 'p3', model: 'm3' })
  })
})

describe('sidechat.info reports the effective route', () => {
  it('reads the live agent\'s logged selection, not its frozen options', async () => {
    const child = agent('child', {
      provider: 'stale',
      model: 'stale-model',
      events: [
        ev('request/header', 0, { header: { config: { provider: 'live', model: 'live-model', reasoningEffort: 'high' } } }),
      ],
    })
    const services = happyServices(undefined, child)
    const api = buildSidechatApi(ctxWith(services))
    await expect(api['sidechat.info']({ childId: 'child' })).resolves.toEqual({
      live: true,
      status: 'idle',
      provider: 'live',
      model: 'live-model',
      reasoningEffort: 'high',
      preset: 'preset-a',
    })
  })

  it('falls back to the frozen options when the log records no selection', async () => {
    const child = agent('child', { events: threadLog() })
    const services = happyServices(undefined, child)
    const api = buildSidechatApi(ctxWith(services))
    const info = await api['sidechat.info']({ childId: 'child' })
    expect(info).toMatchObject({ live: true, provider: 'test', model: 'model-x' })
  })

  it('reads a cold thread\'s selection from its persisted log', async () => {
    const services = happyServices(undefined, agent('child'))
    services.agents.get = vi.fn((_id: unknown) => undefined)
    services.open.mockImplementation(async () => ({
      header: { agentPreset: 'preset-a' },
      inheritedEventCount: 0,
      read: async () => ({
        events: [ev('model/selection', 0, { provider: 'cold', model: 'cold-model' })],
      }),
      close: async () => {},
    }))
    const api = buildSidechatApi(ctxWith(services))
    await expect(api['sidechat.info']({ childId: 'child' })).resolves.toEqual({
      live: false,
      preset: 'preset-a',
      provider: 'cold',
      model: 'cold-model',
    })
  })
})
