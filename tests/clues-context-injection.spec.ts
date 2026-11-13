/**
 * S5 automatic injection contract (`agent/pre-step`).
 *
 * Harness: a fake agent/session/workspace registry and a fake clue service —
 * no store, no host process. Pins the post-tool contract:
 * first own turn injects the metadata catalogue once with the local curl
 * instructions; resume/compact/later turns never re-inject the catalogue;
 * a claimed user message that explicitly carries a token gets one small read
 * hint (also with the curl command, never a tool name); empty bindings stay
 * silent; disabled sources are omitted from new lists but pack identity
 * survives; a fork/seed inherits the durable marker (workspace + binding
 * fingerprint) and only diverges on a changed workspace or list; workspace
 * identity comes from the session header cwd through
 * `workspaceRegistry.resolveByPath`, never from the process cwd.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import type { CluesService } from '../src/clues/service.ts'
import type { Clue, ClueBinding, CluePack } from '../src/clues/types.ts'
import {
  CLUE_CONTEXT_SOURCE_KIND,
  clueBindingsFingerprint,
  installClueInjection,
  readClueContextMarker,
  renderClueBindingContext,
  renderClueReadHint,
  type ClueContextEntry,
} from '../src/clues/context/injection.ts'
import { CLUE_AGENT_READ_ROUTE_PATH } from '../src/clues/agent-read.ts'
import { parseClueTokens } from '../src/clues/context/tokens.ts'
import { SIDEBAR_PREFS_DEFAULTS, type SidebarPrefs } from '../src/prefs-shared.ts'

const NOW = '2026-10-17T00:00:00.000Z'

afterEach(() => {
  vi.useRealTimers()
})

/** Deterministic clue fixtures. */
function clue(id: string, sourceId = 'test.source', title = `title ${id}`): Clue {
  return {
    id,
    sourceId,
    typeId: `${sourceId}.text`,
    locator: { id },
    title,
    workspaceId: 'ws-1',
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function binding(target: ClueBinding['target'], createdAt = NOW): ClueBinding {
  return { workspaceId: 'ws-1', target, createdAt }
}

function pack(id: string, members: readonly string[], name = `pack ${id}`): CluePack {
  return {
    id,
    name,
    workspaceId: 'ws-1',
    members,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

interface Fixture {
  clues?: readonly Clue[]
  packs?: readonly CluePack[]
  bindings?: readonly ClueBinding[]
}

/** One fake mount: captures the pre-step listener and answers the registry. */
function mount(fixture: Fixture = {}, options: {
  prefs?: Partial<SidebarPrefs>
  resolveByPath?: (path: string) => Promise<{ id?: string } | undefined>
  withEvents?: boolean
  /** Override the fake web server origin (to test the loopback restriction). */
  origin?: string
} = {}) {
  let listener:
    | ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>)
    | undefined
  const resolveByPath = vi.fn(options.resolveByPath ?? (async (path: string) => (
    path === '/ws' ? { id: 'ws-1' } : undefined
  )))
  const warnings: string[] = []
  const base = {
    get: (name: string) => {
      if (name === 'workspaceRegistry') return { resolveByPath }
      // The live host webserver facts the injected curl command uses.
      if (name === 'webServer') {
        return { port: 3080, getOrigin: () => options.origin ?? 'http://127.0.0.1:3080' }
      }
      return undefined
    },
    logger: { warn: (message: string) => { warnings.push(message) } },
  }
  const ctx = (options.withEvents === false
    ? base
    : {
        ...base,
        on: (event: string, fn: typeof listener) => {
          if (event !== 'agent/pre-step') throw new Error(`unexpected event ${event}`)
          listener = fn
          return () => { listener = undefined }
        },
      }) as unknown as Context
  const read = vi.fn(async () => {
    throw new Error('injection must never read a resource body')
  })
  const clues = {
    read,
    listBindings: async () => ({ bindings: fixture.bindings ?? [], revision: 0 }),
    listClues: async () => ({ clues: fixture.clues ?? [], revision: 0 }),
    listPacks: async () => ({ packs: fixture.packs ?? [], revision: 0 }),
  } as unknown as CluesService
  const prefs: SidebarPrefs = { ...SIDEBAR_PREFS_DEFAULTS, ...options.prefs }
  const dispose = installClueInjection(ctx, clues, { readPrefs: () => prefs })
  return {
    dispose,
    warnings,
    resolveByPath,
    read,
    run: async (payload: unknown, next: () => Promise<unknown>): Promise<unknown> => {
      if (listener === undefined) throw new Error('no pre-step listener installed')
      return listener(payload, next)
    },
    hasListener: () => listener !== undefined,
  }
}

/** One session event envelope. */
function turnStart(turn: number): { type: string; data: unknown } {
  return { type: 'turn/start', data: { turn } }
}

/** One entered model step (the "this turn really executed" marker). */
function stepStart(turn: number, step = 1): { type: string; data: unknown } {
  return { type: 'step/start', data: { turn, step } }
}

/** One session with a full log and an own-events slice. */
function session(
  events: readonly { type: string; data: unknown }[],
  options: {
    ownFrom?: number
    cwd?: string
    isSeeded?: boolean
    id?: string
    createdAt?: number
    origin?: 'subagent'
  } = {},
) {
  const ownFrom = options.ownFrom ?? 0
  return {
    id: options.id ?? 'session-1',
    header: {
      ...(options.cwd === undefined ? { cwd: '/ws' } : { cwd: options.cwd }),
      ...(options.isSeeded === true ? { isSeeded: true } : {}),
      ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    },
    snapshotEvents: () => events,
    ownEvents: () => events.slice(ownFrom),
  }
}

/** One pre-step payload with claimed user messages. */
function payload(
  sessionValue: ReturnType<typeof session>,
  turn = 1,
  step = 1,
  extraMessages: unknown[] = [],
  signal: AbortSignal = new AbortController().signal,
) {
  return {
    agent: { session: sessionValue },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }, ...extraMessages],
    turn,
    step,
    signal,
  }
}

/** One user-authored message (source kind is part of the trust boundary). */
function userMessage(text: string, id: string): { id: string; role: 'user'; source: { kind: 'user' }; content: Array<{ type: 'text'; text: string }> } {
  return { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

/** Replace the claimed messages of one payload. */
function withMessages(
  payloadValue: ReturnType<typeof payload>,
  messages: unknown[],
): ReturnType<typeof payload> & { messages: unknown[] } {
  return { ...payloadValue, messages }
}

/** The default waterfall continuation: enter with the claimed messages. */
function nextOf(payloadValue: { messages: readonly unknown[] }) {
  return async () => ({ kind: 'enter' as const, messages: [...payloadValue.messages] })
}

/** Extract the injected (source-carrying) message from a decision. */
function injectedOf(decision: unknown): { source?: unknown; content?: readonly { type: string; text?: string }[] } | undefined {
  const messages = (decision as { messages?: readonly unknown[] }).messages ?? []
  return messages.find(message => readClueContextMarker((message as { source?: unknown }).source) !== undefined) as
    | { source?: unknown; content?: readonly { type: string; text?: string }[] }
    | undefined
}

const FIXTURE: Fixture = {
  clues: [clue('clue-1'), clue('clue-2')],
  packs: [pack('pack-1', ['clue-1', 'clue-2'])],
  bindings: [binding({ kind: 'pack', packId: 'pack-1' }), binding({ kind: 'clue', clueId: 'clue-2' })],
}

describe('clueBindingsFingerprint', () => {
  it('is order-independent, workspace-sensitive and changes with the list', () => {
    const a = clueBindingsFingerprint('ws-1', ['[[dsh-clue:a]]', '[[dsh-clue:b]]'])
    expect(clueBindingsFingerprint('ws-1', ['[[dsh-clue:b]]', '[[dsh-clue:a]]'])).toBe(a)
    expect(clueBindingsFingerprint('ws-2', ['[[dsh-clue:a]]', '[[dsh-clue:b]]'])).not.toBe(a)
    expect(clueBindingsFingerprint('ws-1', ['[[dsh-clue:a]]'])).not.toBe(a)
  })
})

describe('renderClueBindingContext', () => {
  it('renders metadata plus the fixed local curl contract, never a tool name', () => {
    const entries: ClueContextEntry[] = [
      { kind: 'clue', token: '[[dsh-clue:a]]', title: 'A' },
      { kind: 'pack', token: '[[dsh-cluepack:p]]', title: 'P', members: [{ token: '[[dsh-clue:b]]', title: 'B' }] },
    ]
    const text = renderClueBindingContext(entries, {
      origin: 'http://127.0.0.1:3080',
      workspaceId: 'ws-1',
      sessionId: 'session-1',
    })
    expect(text).toContain('[[dsh-clue:a]]')
    expect(text).toContain('[[dsh-cluepack:p]]')
    expect(text).toContain('[[dsh-clue:b]]')
    // One fixed read command, with the live origin/workspace/session.
    expect(text).toContain('curl -sS -X POST')
    expect(text).toContain(`http://127.0.0.1:3080${CLUE_AGENT_READ_ROUTE_PATH}`)
    expect(text).toContain('Content-Type: application/json')
    expect(text).toContain('"workspaceId":"ws-1"')
    expect(text).toContain('"sessionId":"session-1"')
    expect(text).toContain('snapshotOffset')
    expect(text).toContain('snapshot-METADATA')
    // The removed model tools must not leak back into the prompt.
    expect(text).not.toContain('sidebar_clue_list')
    expect(text).not.toContain('sidebar_clue_read')
    expect(text).not.toContain('sidebar_clue')
    expect(text).toContain('LIVE read')
    expect(text).toContain('never')
    expect(renderClueBindingContext([])).toBe('')
  })

  it('renders the per-message reference hint without a catalogue or body', () => {
    const hint = renderClueReadHint(
      parseClueTokens('please read [[dsh-clue:a]] and [[dsh-cluepack:p]]'),
      { origin: 'http://127.0.0.1:3080', workspaceId: 'ws-1', sessionId: 'session-1' },
    )
    expect(hint).toContain('[[dsh-clue:a]]')
    expect(hint).toContain('[[dsh-cluepack:p]]')
    expect(hint).toContain('curl -sS -X POST')
    expect(hint).toContain(`http://127.0.0.1:3080${CLUE_AGENT_READ_ROUTE_PATH}`)
    expect(hint).not.toContain('sidebar_clue')
    expect(renderClueReadHint([])).toBe('')
  })

  it('bounds a hint token list and its token width', () => {
    const many = Array.from({ length: 25 }, (_, index) => `[[dsh-clue:c${index}]]`).join(' ')
    const hint = renderClueReadHint(parseClueTokens(many))
    expect(hint).toContain('5 further references omitted')
    expect(hint).toContain('[[dsh-clue:c0]]')
    expect(hint).not.toContain('[[dsh-clue:c24]]')
    const huge = `[[dsh-clue:${'x'.repeat(300)}]]`
    expect(renderClueReadHint(parseClueTokens(huge))).toBe('')
  })

  it('bounds rows and pack members without cutting a token', () => {
    const entries: ClueContextEntry[] = [
      { kind: 'clue', token: '[[dsh-clue:a]]', title: 'A' },
      { kind: 'clue', token: '[[dsh-clue:b]]', title: 'B' },
      {
        kind: 'pack',
        token: '[[dsh-cluepack:p]]',
        title: 'P',
        members: [
          { token: '[[dsh-clue:c]]', title: 'C' },
          { token: '[[dsh-clue:d]]', title: 'D' },
          { token: '[[dsh-clue:e]]', title: 'E' },
        ],
      },
    ]
    const text = renderClueBindingContext(entries, { maxBindings: 2, maxMembersPerPack: 1, maxContextChars: 10_000 })
    expect(text).toContain('[[dsh-clue:a]]')
    expect(text).toContain('[[dsh-clue:b]]')
    expect(text).not.toContain('[[dsh-cluepack:p]]')
    expect(text).toContain('1 more binding')
  })
})

describe('installClueInjection', () => {
  it('injects on the first own step: metadata + marker, before the claimed message', async () => {
    const harness = mount(FIXTURE)
    const events = [turnStart(1)]
    const sessionValue = session(events)
    const claimed = payload(sessionValue)
    const decision = await harness.run(claimed, nextOf(claimed))
    const injected = injectedOf(decision)
    expect(injected).toBeDefined()
    expect((injected!.source as { kind: string }).kind).toBe(CLUE_CONTEXT_SOURCE_KIND)
    expect((injected!.source as { kind: string }).kind).not.toBe('plugin')
    const marker = readClueContextMarker(injected!.source)
    expect(marker?.workspaceId).toBe('ws-1')
    expect(marker?.fingerprint).toMatch(/^[0-9a-f]{8}$/)
    expect(marker?.kind).toBe('bindings')
    const text = injected!.content?.map(block => block.text ?? '').join('') ?? ''
    expect(text).toContain('[[dsh-clue:clue-1]]')
    expect(text).toContain('[[dsh-clue:clue-2]]')
    // The prompt carries the runnable local route, not a model tool name.
    expect(text).toContain('curl -sS -X POST')
    expect(text).toContain(`http://127.0.0.1:3080${CLUE_AGENT_READ_ROUTE_PATH}`)
    expect(text).toContain('"sessionId":"session-1"')
    expect(text).not.toContain('sidebar_clue')
    // The claimed user message stays last; the context precedes it.
    expect((decision as { messages: readonly unknown[] }).messages.at(-1)).toBe(claimed.messages[0])
    // Bindings are only read through the service; no source read is performed.
    expect(harness.resolveByPath).toHaveBeenCalledWith('/ws')
    expect(harness.read).not.toHaveBeenCalled()
    harness.dispose()
  })

  it('never points the injected curl command at a non-loopback origin', async () => {
    const harness = mount(FIXTURE, { origin: 'http://10.0.0.5:3080' })
    const claimed = payload(session([turnStart(1)]))
    const decision = await harness.run(claimed, nextOf(claimed))
    const text = injectedOf(decision)!.content?.map(block => block.text ?? '').join('') ?? ''
    expect(text).toContain('http://127.0.0.1:3080/sidebar/agent/clues/read')
    expect(text).not.toContain('10.0.0.5')
    harness.dispose()
  })

  it('does not inject for an empty binding list', async () => {
    const harness = mount({})
    const sessionValue = session([turnStart(1)])
    const claimed = payload(sessionValue)
    const decision = await harness.run(claimed, nextOf(claimed))
    expect(injectedOf(decision)).toBeUndefined()
    expect((decision as { messages: readonly unknown[] }).messages).toHaveLength(1)
  })

  it('gives a first-turn explicit reference the curl hint when no binding catalogue exists', async () => {
    const harness = mount({})
    const claimed = withMessages(payload(session([turnStart(1)])), [
      userMessage('please read [[dsh-clue:clue-9]]', 'msg-ref-1'),
    ])
    const decision = await harness.run(claimed, nextOf(claimed))
    const injected = injectedOf(decision)
    expect(injected).toBeDefined()
    expect(readClueContextMarker(injected!.source)?.kind).toBe('reference')
    expect(readClueContextMarker(injected!.source)?.messages).toEqual(['msg-ref-1'])
    const text = injected!.content?.map(block => block.text ?? '').join('') ?? ''
    expect(text).toContain('[[dsh-clue:clue-9]]')
    expect(text).toContain('curl -sS -X POST')
    expect(text).toContain(`http://127.0.0.1:3080${CLUE_AGENT_READ_ROUTE_PATH}`)
    expect(text).toContain('"workspaceId":"ws-1"')
    expect(text).not.toContain('sidebar_clue')
    expect(harness.read).not.toHaveBeenCalled()
  })

  it('gives an explicit reference on a later turn one small hint and dedupes the retry', async () => {
    const harness = mount(FIXTURE)
    const events = [turnStart(1), stepStart(1), turnStart(2)]
    const sessionValue = session(events)
    const message = userMessage('what about [[dsh-clue:clue-9]]?', 'msg-ref-2')
    const claimed = withMessages(payload(sessionValue, 2), [message])
    const decision = await harness.run(claimed, nextOf(claimed))
    const injected = injectedOf(decision)
    expect(injected).toBeDefined()
    expect(readClueContextMarker(injected!.source)?.kind).toBe('reference')
    expect(readClueContextMarker(injected!.source)?.messages).toEqual(['msg-ref-2'])
    const text = injected!.content?.map(block => block.text ?? '').join('') ?? ''
    expect(text).toContain('[[dsh-clue:clue-9]]')
    expect(text).toContain('curl -sS -X POST')
    // The binding catalogue is a new-session message; a later explicit token
    // only gets the compact read hint.
    expect(text).not.toContain('Clue references bound to this workspace')
    expect(text).not.toContain('sidebar_clue')
    expect(harness.read).not.toHaveBeenCalled()

    // A retried pre-step before the message commits must not add a second copy.
    const retry = withMessages(payload(sessionValue, 2), [message])
    expect(injectedOf(await harness.run(retry, nextOf(retry)))).toBeUndefined()
    harness.dispose()
  })

  it('still hints a user reference claimed on a later step of a turn', async () => {
    const harness = mount(FIXTURE)
    const sessionValue = session([turnStart(1), stepStart(1), turnStart(2), stepStart(2)])
    const message = userMessage('also [[dsh-clue:clue-step-2]]', 'msg-ref-step-2')
    const claimed = withMessages(payload(sessionValue, 2, 2), [message])
    const decision = await harness.run(claimed, nextOf(claimed))
    const injected = injectedOf(decision)
    expect(injected).toBeDefined()
    expect(readClueContextMarker(injected!.source)?.kind).toBe('reference')
    expect(injected!.content?.map(block => block.text ?? '').join('')).toContain('[[dsh-clue:clue-step-2]]')
    harness.dispose()
  })

  it('does not re-hint a message acknowledged by a committed reference marker', async () => {
    const harness = mount(FIXTURE)
    const sessionValue = session([turnStart(1), stepStart(1), turnStart(2)])
    const message = userMessage('read [[dsh-clue:clue-9]]', 'msg-ref-3')
    const first = withMessages(payload(sessionValue, 2), [message])
    const decision = await harness.run(first, nextOf(first))
    const markerSource = injectedOf(decision)!.source
    // Simulate the host committing the injected message: its durable marker is
    // part of the session log on the next delivery attempt.
    const committed = session([
      turnStart(1),
      stepStart(1),
      turnStart(2),
      { type: 'user/message', data: { source: markerSource } },
    ])
    const next = withMessages(payload(committed, 2), [message])
    expect(injectedOf(await harness.run(next, nextOf(next)))).toBeUndefined()
    harness.dispose()
  })

  it('never treats an injected/foreign message token as a user reference', async () => {
    const harness = mount(FIXTURE)
    const sessionValue = session([turnStart(1), stepStart(1), turnStart(2)])
    const foreign = {
      id: 'msg-foreign',
      role: 'user',
      source: { kind: CLUE_CONTEXT_SOURCE_KIND },
      content: [{ type: 'text', text: 'reads [[dsh-clue:not-a-user-reference]]' }],
    }
    const claimed = withMessages(payload(sessionValue, 2), [foreign])
    expect(injectedOf(await harness.run(claimed, nextOf(claimed)))).toBeUndefined()
    harness.dispose()
  })

  it('omits members of disabled sources but keeps pack identity', async () => {
    const harness = mount(FIXTURE, { prefs: { clueSourcesEnabled: { 'test.source': false } } })
    const sessionValue = session([turnStart(1)])
    const claimed = payload(sessionValue)
    const decision = await harness.run(claimed, nextOf(claimed))
    const text = injectedOf(decision)!.content?.map(block => block.text ?? '').join('') ?? ''
    expect(text).toContain('[[dsh-cluepack:pack-1]]')
    expect(text).not.toContain('[[dsh-clue:clue-1]]')
    expect(text).not.toContain('[[dsh-clue:clue-2]]')
    expect(text).toContain('no currently attachable members')
  })

  it('dedupes a clue bound directly and through a pack', async () => {
    const harness = mount({
      clues: [clue('clue-1')],
      packs: [pack('pack-1', ['clue-1'])],
      bindings: [binding({ kind: 'pack', packId: 'pack-1' }), binding({ kind: 'clue', clueId: 'clue-1' })],
    })
    const sessionValue = session([turnStart(1)])
    const claimed = payload(sessionValue)
    const decision = await harness.run(claimed, nextOf(claimed))
    const text = injectedOf(decision)!.content?.map(block => block.text ?? '').join('') ?? ''
    expect(text.match(/\[\[dsh-clue:clue-1\]\]/g)).toHaveLength(1)
  })

  it('lists a clue under its pack regardless of binding order (no misleading empty members)', async () => {
    const fixture: Fixture = {
      clues: [clue('clue-1')],
      packs: [pack('pack-1', ['clue-1'])],
    }
    const packFirst = mount({
      ...fixture,
      bindings: [binding({ kind: 'pack', packId: 'pack-1' }), binding({ kind: 'clue', clueId: 'clue-1' })],
    })
    const clueFirst = mount({
      ...fixture,
      bindings: [binding({ kind: 'clue', clueId: 'clue-1' }), binding({ kind: 'pack', packId: 'pack-1' })],
    })
    const run = async (harness: ReturnType<typeof mount>): Promise<string> => {
      const claimed = payload(session([turnStart(1)]))
      const decision = await harness.run(claimed, nextOf(claimed))
      return injectedOf(decision)!.content?.map(block => block.text ?? '').join('') ?? ''
    }
    const first = await run(packFirst)
    const second = await run(clueFirst)
    expect(first).toBe(second)
    expect(first).toContain('[[dsh-cluepack:pack-1]]')
    expect(first).toContain('current members: [[dsh-clue:clue-1]]')
    expect(first).not.toContain('no currently attachable members')
    expect(first.match(/\[\[dsh-clue:clue-1\]\]/g)).toHaveLength(1)
    packFirst.dispose()
    clueFirst.dispose()
  })

  it('does not deliver a binding added after an existing idle session was created', async () => {
    const harness = mount({
      clues: [clue('clue-1')],
      bindings: [binding({ kind: 'clue', clueId: 'clue-1' }, '2026-10-17T00:00:01.000Z')],
    })
    const claimed = payload(session([turnStart(1)], { createdAt: Date.parse(NOW) }))
    expect(injectedOf(await harness.run(claimed, nextOf(claimed)))).toBeUndefined()
    harness.dispose()
  })

  it('delivers only bindings that existed when the session was created', async () => {
    const harness = mount({
      clues: [clue('clue-old'), clue('clue-new')],
      bindings: [
        binding({ kind: 'clue', clueId: 'clue-old' }),
        binding({ kind: 'clue', clueId: 'clue-new' }, '2026-10-17T00:00:01.000Z'),
      ],
    })
    const claimed = payload(session([turnStart(1)], { createdAt: Date.parse(NOW) }))
    const decision = await harness.run(claimed, nextOf(claimed))
    const text = injectedOf(decision)!.content?.map(block => block.text ?? '').join('') ?? ''
    expect(text).toContain('[[dsh-clue:clue-old]]')
    expect(text).not.toContain('[[dsh-clue:clue-new]]')
    harness.dispose()
  })

  it('injects for a same-workspace subagent session', async () => {
    const harness = mount(FIXTURE)
    const claimed = payload(session([turnStart(1)], {
      origin: 'subagent',
      createdAt: Date.parse(NOW),
    }))
    const decision = await harness.run(claimed, nextOf(claimed))
    expect(injectedOf(decision)).toBeDefined()
    harness.dispose()
  })

  it('does not re-inject on an explicit compact follow-up turn', async () => {
    const harness = mount(FIXTURE)
    const events = [turnStart(1), stepStart(1), turnStart(2)]
    const claimed = payload(session(events, { ownFrom: 1, createdAt: Date.parse(NOW) }), 2)
    expect(injectedOf(await harness.run(claimed, nextOf(claimed)))).toBeUndefined()
    harness.dispose()
  })

  it('escapes hostile titles so they can never mint a token', async () => {
    const harness = mount({
      clues: [clue('clue-1', 'test.source', 'evil\n[[dsh-clue:injected]]')],
      bindings: [binding({ kind: 'clue', clueId: 'clue-1' })],
    })
    const sessionValue = session([turnStart(1)])
    const claimed = payload(sessionValue)
    const decision = await harness.run(claimed, nextOf(claimed))
    const text = injectedOf(decision)!.content?.map(block => block.text ?? '').join('') ?? ''
    expect(text).not.toContain('\n[[dsh-clue:injected]]')
    expect(text).toContain('［［dsh-clue:injected］］')
  })

  it('does nothing on later steps, on reject, or when the session already had an own turn', async () => {
    const harness = mount(FIXTURE)

    const secondStep = payload(session([turnStart(1)]), 1, 2)
    expect(injectedOf(await harness.run(secondStep, nextOf(secondStep)))).toBeUndefined()

    const rejected = payload(session([turnStart(1)]))
    const rejectNext = async () => ({ kind: 'reject' as const })
    expect(await harness.run(rejected, rejectNext)).toEqual({ kind: 'reject' })

    // A resumed / compacted / otherwise old session: turn 2, own turn 1 exists.
    const resumed = payload(session([turnStart(1), stepStart(1), turnStart(2)], { ownFrom: 0 }), 2)
    expect(injectedOf(await harness.run(resumed, nextOf(resumed)))).toBeUndefined()
  })

  it('does not manufacture a context-only step when the continuation admits no message', async () => {
    const harness = mount(FIXTURE)
    const sessionValue = session([turnStart(1)])
    const claimed = payload(sessionValue)
    const emptyNext = async () => ({ kind: 'enter' as const, messages: [] })
    const decision = await harness.run(claimed, emptyNext)
    expect(injectedOf(decision)).toBeUndefined()
    expect((decision as { messages: readonly unknown[] }).messages).toHaveLength(0)
  })

  it('never injects twice in the same creation window (pre-commit re-entry)', async () => {
    const harness = mount(FIXTURE)
    const sessionValue = session([turnStart(1)])
    const first = payload(sessionValue)
    const firstDecision = await harness.run(first, nextOf(first))
    expect(injectedOf(firstDecision)).toBeDefined()
    // The log does not contain the message yet, but the second pass must not duplicate.
    const second = payload(sessionValue)
    const secondDecision = await harness.run(second, nextOf(second))
    expect(injectedOf(secondDecision)).toBeUndefined()
  })

  it('never injects twice when two pre-step passes race in one creation window', async () => {
    const harness = mount(FIXTURE)
    const sessionValue = session([turnStart(1)])
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const next = async () => {
      await gate
      return { kind: 'enter' as const, messages: [{ role: 'user', content: [] }] }
    }
    const first = harness.run(payload(sessionValue), next)
    const second = harness.run(payload(sessionValue), next)
    // Let both passes reach the waterfall, then release them together.
    await new Promise(resolve => setTimeout(resolve, 0))
    release()
    const [firstDecision, secondDecision] = await Promise.all([first, second])
    expect(injectedOf(firstDecision)).toBeDefined()
    expect(injectedOf(secondDecision)).toBeUndefined()
  })

  it('releases the re-entry guard when the host aborts after the waterfall', async () => {
    const harness = mount(FIXTURE)
    const sessionValue = session([turnStart(1)])
    const controller = new AbortController()
    const claimed = payload(sessionValue, 1, 1, [], controller.signal)
    const abortedNext = async () => {
      // The host calls signal.throwIfAborted() right after the waterfall
      // settles: the decision below is discarded and no message is committed.
      controller.abort()
      return { kind: 'enter' as const, messages: [...claimed.messages] }
    }
    const abortedDecision = await harness.run(claimed, abortedNext)
    // The aborted pass adds nothing (the host discards its decision)...
    expect(injectedOf(abortedDecision)).toBeUndefined()

    // ...and the guard must not survive the abort: a retry in the same
    // creation window still receives the context.
    const retry = payload(sessionValue)
    const retryDecision = await harness.run(retry, nextOf(retry))
    expect(injectedOf(retryDecision)).toBeDefined()
    harness.dispose()
  })

  it('does not inject when the listener is disposed while the waterfall is pending', async () => {
    const harness = mount(FIXTURE)
    const claimed = payload(session([turnStart(1)]))
    const decision = await harness.run(claimed, async () => {
      // Plugin unload/HMR happens mid-waterfall: the listener was removed and
      // the service/entries may already be torn down.
      harness.dispose()
      return { kind: 'enter' as const, messages: [...claimed.messages] }
    })
    expect(injectedOf(decision)).toBeUndefined()
    expect((decision as { messages: readonly unknown[] }).messages).toHaveLength(1)
  })

  it('does not inject when disposal happens during workspace resolution', async () => {
    const teardown: { dispose?: () => void } = {}
    const harness = mount(FIXTURE, {
      resolveByPath: async () => {
        teardown.dispose?.()
        return { id: 'ws-1' }
      },
    })
    teardown.dispose = harness.dispose
    const claimed = payload(session([turnStart(1)]))
    const decision = await harness.run(claimed, nextOf(claimed))
    expect(injectedOf(decision)).toBeUndefined()
    expect((decision as { messages: readonly unknown[] }).messages).toHaveLength(1)
  })

  it('expires a stale re-entry claim after the host discards a settled decision', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    const harness = mount(FIXTURE)
    const sessionValue = session([turnStart(1)])
    const controller = new AbortController()
    const claimed = payload(sessionValue, 1, 1, [], controller.signal)
    const decision = await harness.run(claimed, nextOf(claimed))
    expect(injectedOf(decision)).toBeDefined()

    // The host aborts AFTER our listener returned, so its decision is dropped
    // and no durable marker is ever committed. The in-process claim must not
    // suppress the same creation window forever.
    controller.abort()
    const retry = payload(sessionValue)
    expect(injectedOf(await harness.run(retry, nextOf(retry)))).toBeUndefined()

    vi.advanceTimersByTime(60_001)
    const retryAfterTtl = payload(sessionValue)
    expect(injectedOf(await harness.run(retryAfterTtl, nextOf(retryAfterTtl)))).toBeDefined()
    harness.dispose()
  })

  it('skips a pre-aborted pass without claiming the guard', async () => {
    const harness = mount(FIXTURE)
    const sessionValue = session([turnStart(1)])
    const controller = new AbortController()
    controller.abort()
    const aborted = payload(sessionValue, 1, 1, [], controller.signal)
    const decision = await harness.run(aborted, nextOf(aborted))
    expect(injectedOf(decision)).toBeUndefined()

    const retry = payload(sessionValue)
    expect(injectedOf(await harness.run(retry, nextOf(retry)))).toBeDefined()
    harness.dispose()
  })

  it('skips a fork whose inherited marker matches, and injects when workspace or list differs', async () => {
    const harness = mount(FIXTURE)
    const parent = session([turnStart(1)])
    const parentClaimed = payload(parent)
    const parentDecision = await harness.run(parentClaimed, nextOf(parentClaimed))
    const markerMessage = injectedOf(parentDecision)!
    // The child inherits the parent's marker in its frozen prefix; its own
    // first turn (`turn 2`) is appended after the cut.
    const inherited = [turnStart(1), stepStart(1), { type: 'user/message', data: { source: markerMessage.source } }, turnStart(2)]

    // Same workspace, same effective list: the inherited marker suppresses it.
    const forkSame = session(inherited, { ownFrom: 2, isSeeded: true })
    const sameClaimed = payload(forkSame, 2)
    expect(injectedOf(await harness.run(sameClaimed, nextOf(sameClaimed)))).toBeUndefined()

    // Different workspace: inject the current workspace's list.
    const otherWorkspace = mount(FIXTURE, { resolveByPath: async () => ({ id: 'ws-2' }) })
    const forkOther = session(inherited, { ownFrom: 2, isSeeded: true })
    const otherClaimed = payload(forkOther, 2)
    const otherDecision = await otherWorkspace.run(otherClaimed, nextOf(otherClaimed))
    expect(readClueContextMarker(injectedOf(otherDecision)!.source)?.workspaceId).toBe('ws-2')
    otherWorkspace.dispose()

    // Same workspace, changed list: inject the current list.
    const changed = mount({
      clues: [clue('clue-1')],
      packs: [pack('pack-1', ['clue-1'])],
      bindings: [binding({ kind: 'clue', clueId: 'clue-1' })],
    })
    const forkChanged = session(inherited, { ownFrom: 2, isSeeded: true })
    const changedClaimed = payload(forkChanged, 2)
    const changedDecision = await changed.run(changedClaimed, nextOf(changedClaimed))
    expect(readClueContextMarker(injectedOf(changedDecision)!.source)?.workspaceId).toBe('ws-1')
    changed.dispose()
    harness.dispose()
  })

  it('resolves the workspace from the session header cwd, never the process cwd', async () => {
    const harness = mount(FIXTURE, {
      resolveByPath: async (path: string) => (path === '/foreign' ? { id: 'ws-9' } : undefined),
    })
    const sessionValue = session([turnStart(1)], { cwd: '/foreign' })
    const claimed = payload(sessionValue)
    await harness.run(claimed, nextOf(claimed))
    expect(harness.resolveByPath).toHaveBeenCalledTimes(1)
    expect(harness.resolveByPath).toHaveBeenCalledWith('/foreign')
    expect(harness.resolveByPath).not.toHaveBeenCalledWith(process.cwd())
    harness.dispose()
  })

  it('skips (without throwing) when the workspace cannot be resolved', async () => {
    const harness = mount(FIXTURE, { resolveByPath: async () => undefined })
    const sessionValue = session([turnStart(1)])
    const claimed = payload(sessionValue)
    const decision = await harness.run(claimed, nextOf(claimed))
    expect(injectedOf(decision)).toBeUndefined()
    harness.dispose()
  })

  it('returns a disposer that removes the listener', () => {
    const harness = mount(FIXTURE)
    expect(harness.hasListener()).toBe(true)
    harness.dispose()
    expect(harness.hasListener()).toBe(false)
    harness.dispose()
  })

  it('degrades to a no-op when agent events are unavailable', () => {
    const harness = mount(FIXTURE, { withEvents: false })
    expect(() => harness.dispose()).not.toThrow()
    expect(harness.warnings.some(warning => warning.includes('agent events are unavailable'))).toBe(true)
  })
})
