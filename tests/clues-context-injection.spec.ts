/**
 * S5 automatic injection contract (`agent/pre-step`).
 *
 * Harness: a fake agent/session/workspace registry and a fake clue service —
 * no store, no host process. Pins the post-tool contract: the first own step
 * injects the metadata catalogue once (with the local curl instructions), a
 * claimed user message carrying a token gets one small read hint, disabled
 * sources drop their members but keep pack identity, a fork inherits the
 * durable marker until workspace/list diverge, re-entry is claimed exactly once
 * per creation window (and released on abort, disposal or TTL), and workspace
 * identity comes from the session header cwd, never the process cwd.
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
const ROUTE = `http://127.0.0.1:3080${CLUE_AGENT_READ_ROUTE_PATH}`

afterEach(() => {
  vi.useRealTimers()
})

function clue(id: string, sourceId = 'test.source', title = `title ${id}`): Clue {
  return { id, sourceId, typeId: `${sourceId}.text`, locator: { id }, title, workspaceId: 'ws-1', createdAt: NOW, updatedAt: NOW }
}

function binding(target: ClueBinding['target'], createdAt = NOW): ClueBinding {
  return { workspaceId: 'ws-1', target, createdAt }
}

function pack(id: string, members: readonly string[]): CluePack {
  return { id, name: `pack ${id}`, workspaceId: 'ws-1', members, revision: 1, createdAt: NOW, updatedAt: NOW }
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
  origin?: string
} = {}) {
  let listener: ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  const resolveByPath = vi.fn(options.resolveByPath ?? (async (path: string) => (path === '/ws' ? { id: 'ws-1' } : undefined)))
  const warnings: string[] = []
  const base = {
    get: (name: string) => {
      if (name === 'workspaceRegistry') return { resolveByPath }
      if (name === 'webServer') return { port: 3080, getOrigin: () => options.origin ?? 'http://127.0.0.1:3080' }
      return undefined
    },
    logger: { warn: (message: string) => { warnings.push(message) } },
  }
  const ctx = (options.withEvents === false ? base : {
    ...base,
    on: (event: string, fn: typeof listener) => {
      if (event !== 'agent/pre-step') throw new Error(`unexpected event ${event}`)
      listener = fn
      return () => { listener = undefined }
    },
  }) as unknown as Context
  const read = vi.fn(async () => { throw new Error('injection must never read a resource body') })
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
    run: async (payloadValue: unknown, next: () => Promise<unknown>): Promise<unknown> => {
      if (listener === undefined) throw new Error('no pre-step listener installed')
      return listener(payloadValue, next)
    },
    hasListener: () => listener !== undefined,
  }
}

type TurnEvent = { type: string; data: unknown }
const turnStart = (turn: number): TurnEvent => ({ type: 'turn/start', data: { turn } })
const stepStart = (turn: number, step = 1): TurnEvent => ({ type: 'step/start', data: { turn, step } })

function session(events: readonly TurnEvent[], options: {
  ownFrom?: number
  cwd?: string
  isSeeded?: boolean
  createdAt?: number
  origin?: 'subagent'
} = {}) {
  const ownFrom = options.ownFrom ?? 0
  return {
    id: 'session-1',
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

type SessionValue = ReturnType<typeof session>
type Payload = {
  agent: { session: SessionValue }
  messages: unknown[]
  turn: number
  step: number
  signal: AbortSignal
}

function payload(
  sessionValue: SessionValue,
  turn = 1,
  step = 1,
  messages: unknown[] = [],
  signal: AbortSignal = new AbortController().signal,
): Payload {
  return {
    agent: { session: sessionValue },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }, ...messages],
    turn,
    step,
    signal,
  }
}

const userMessage = (text: string, id: string) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const withMessages = (payloadValue: Payload, messages: unknown[]): Payload => ({ ...payloadValue, messages })
const nextOf = (payloadValue: Payload) => async () => ({ kind: 'enter' as const, messages: [...payloadValue.messages] })

/** Extract the injected (source-carrying) message from a decision. */
function injectedOf(decision: unknown): { source?: unknown; content?: readonly { type: string; text?: string }[] } | undefined {
  const messages = (decision as { messages?: readonly unknown[] }).messages ?? []
  return messages.find(message => readClueContextMarker((message as { source?: unknown }).source) !== undefined) as
    | { source?: unknown; content?: readonly { type: string; text?: string }[] }
    | undefined
}

/** The visible text of the injected message (empty when nothing was injected). */
function injectedText(decision: unknown): string {
  return injectedOf(decision)?.content?.map(block => block.text ?? '').join('') ?? ''
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
  const target = { origin: 'http://127.0.0.1:3080', workspaceId: 'ws-1', sessionId: 'session-1' }

  it('renders metadata plus the fixed local curl contract, never a tool name', () => {
    const entries: ClueContextEntry[] = [
      { kind: 'clue', token: '[[dsh-clue:a]]', title: 'A' },
      { kind: 'pack', token: '[[dsh-cluepack:p]]', title: 'P', members: [{ token: '[[dsh-clue:b]]', title: 'B' }] },
    ]
    const text = renderClueBindingContext(entries, target)
    expect(text).toContain('[[dsh-clue:a]]')
    expect(text).toContain('[[dsh-cluepack:p]]')
    expect(text).toContain('[[dsh-clue:b]]')
    expect(text).toContain('curl -sS -X POST')
    expect(text).toContain(ROUTE)
    expect(text).toContain('Content-Type: application/json')
    expect(text).toContain('"workspaceId":"ws-1"')
    expect(text).toContain('"sessionId":"session-1"')
    expect(text).toContain('snapshotOffset')
    expect(text).toContain('snapshot-METADATA')
    expect(text).toContain('LIVE read')
    expect(text).toContain('never')
    // The removed model tools must not leak back into the prompt.
    expect(text).not.toContain('sidebar_clue')
    expect(renderClueBindingContext([])).toBe('')
  })

  it('renders the per-message reference hint without a catalogue or body', () => {
    const hint = renderClueReadHint(parseClueTokens('please read [[dsh-clue:a]] and [[dsh-cluepack:p]]'), target)
    expect(hint).toContain('[[dsh-clue:a]]')
    expect(hint).toContain('[[dsh-cluepack:p]]')
    expect(hint).toContain('curl -sS -X POST')
    expect(hint).toContain(ROUTE)
    expect(hint).not.toContain('sidebar_clue')
    expect(renderClueReadHint([])).toBe('')
  })

  it('bounds the hint token count/width and the catalogue rows/members', () => {
    const many = Array.from({ length: 25 }, (_unused, index) => `[[dsh-clue:c${index}]]`).join(' ')
    const hint = renderClueReadHint(parseClueTokens(many))
    expect(hint).toContain('5 further references omitted')
    expect(hint).toContain('[[dsh-clue:c0]]')
    expect(hint).not.toContain('[[dsh-clue:c24]]')
    expect(renderClueReadHint(parseClueTokens(`[[dsh-clue:${'x'.repeat(300)}]]`))).toBe('')

    const entries: ClueContextEntry[] = [
      { kind: 'clue', token: '[[dsh-clue:a]]', title: 'A' },
      { kind: 'clue', token: '[[dsh-clue:b]]', title: 'B' },
      { kind: 'pack', token: '[[dsh-cluepack:p]]', title: 'P', members: [
        { token: '[[dsh-clue:c]]', title: 'C' },
        { token: '[[dsh-clue:d]]', title: 'D' },
        { token: '[[dsh-clue:e]]', title: 'E' },
      ] },
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
    const claimed = payload(session([turnStart(1)]))
    const decision = await harness.run(claimed, nextOf(claimed))
    const injected = injectedOf(decision)
    expect(injected).toBeDefined()
    expect((injected!.source as { kind: string }).kind).toBe(CLUE_CONTEXT_SOURCE_KIND)
    expect((injected!.source as { kind: string }).kind).not.toBe('plugin')
    const marker = readClueContextMarker(injected!.source)
    expect(marker?.workspaceId).toBe('ws-1')
    expect(marker?.fingerprint).toMatch(/^[0-9a-f]{8}$/)
    expect(marker?.kind).toBe('bindings')
    const text = injectedText(decision)
    expect(text).toContain('[[dsh-clue:clue-1]]')
    expect(text).toContain('[[dsh-clue:clue-2]]')
    expect(text).toContain('curl -sS -X POST')
    expect(text).toContain(ROUTE)
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
    const text = injectedText(await harness.run(claimed, nextOf(claimed)))
    expect(text).toContain(ROUTE)
    expect(text).not.toContain('10.0.0.5')
    harness.dispose()
  })

  it('gives an explicit reference a compact curl hint (first turn, later turn, later step) but never the catalogue', async () => {
    const first = mount({})
    const firstPayload = withMessages(payload(session([turnStart(1)])), [userMessage('please read [[dsh-clue:clue-9]]', 'msg-ref-1')])
    const firstDecision = await first.run(firstPayload, nextOf(firstPayload))
    expect(readClueContextMarker(injectedOf(firstDecision)!.source)).toMatchObject({ kind: 'reference', messages: ['msg-ref-1'] })
    const firstText = injectedText(firstDecision)
    expect(firstText).toContain('[[dsh-clue:clue-9]]')
    expect(firstText).toContain('curl -sS -X POST')
    expect(firstText).toContain('"workspaceId":"ws-1"')
    expect(first.read).not.toHaveBeenCalled()
    first.dispose()

    const later = mount(FIXTURE)
    const message = userMessage('what about [[dsh-clue:clue-9]]?', 'msg-ref-2')
    const laterPayload = withMessages(payload(session([turnStart(1), stepStart(1), turnStart(2)], { createdAt: Date.parse(NOW) }), 2), [message])
    const laterDecision = await later.run(laterPayload, nextOf(laterPayload))
    expect(readClueContextMarker(injectedOf(laterDecision)!.source)).toMatchObject({ kind: 'reference', messages: ['msg-ref-2'] })
    const laterText = injectedText(laterDecision)
    expect(laterText).toContain('[[dsh-clue:clue-9]]')
    // The catalogue is a new-session message; a later explicit token gets the hint only.
    expect(laterText).not.toContain('Clue references bound to this workspace')
    expect(later.read).not.toHaveBeenCalled()
    // A retried pre-step before the message commits must not add a second copy.
    const retry = withMessages(payload(session([turnStart(1), stepStart(1), turnStart(2)], { createdAt: Date.parse(NOW) }), 2), [message])
    expect(injectedOf(await later.run(retry, nextOf(retry)))).toBeUndefined()
    later.dispose()

    const stepped = mount(FIXTURE)
    const stepPayload = withMessages(
      payload(session([turnStart(1), stepStart(1), turnStart(2), stepStart(2)], { createdAt: Date.parse(NOW) }), 2, 2),
      [userMessage('also [[dsh-clue:clue-step-2]]', 'msg-ref-step-2')],
    )
    expect(injectedText(await stepped.run(stepPayload, nextOf(stepPayload)))).toContain('[[dsh-clue:clue-step-2]]')
    stepped.dispose()
  })

  it('never re-hints a message whose marker the host already committed, nor a foreign message token', async () => {
    const harness = mount(FIXTURE)
    const message = userMessage('read [[dsh-clue:clue-9]]', 'msg-ref-3')
    const first = withMessages(payload(session([turnStart(1), stepStart(1), turnStart(2)]), 2), [message])
    const markerSource = injectedOf(await harness.run(first, nextOf(first)))!.source
    const committed = session([turnStart(1), stepStart(1), turnStart(2), { type: 'user/message', data: { source: markerSource } }])
    const next = withMessages(payload(committed, 2), [message])
    expect(injectedOf(await harness.run(next, nextOf(next)))).toBeUndefined()

    const foreign = withMessages(payload(session([turnStart(1), stepStart(1), turnStart(2)]), 2), [
      { id: 'msg-foreign', role: 'user', source: { kind: CLUE_CONTEXT_SOURCE_KIND }, content: [{ type: 'text', text: 'reads [[dsh-clue:not-a-user-reference]]' }] },
    ])
    expect(injectedOf(await harness.run(foreign, nextOf(foreign)))).toBeUndefined()
    harness.dispose()
  })

  it('omits members of disabled sources but keeps pack identity', async () => {
    const harness = mount(FIXTURE, { prefs: { clueSourcesEnabled: { 'test.source': false } } })
    const claimed = payload(session([turnStart(1)]))
    const text = injectedText(await harness.run(claimed, nextOf(claimed)))
    expect(text).toContain('[[dsh-cluepack:pack-1]]')
    expect(text).not.toContain('[[dsh-clue:clue-1]]')
    expect(text).not.toContain('[[dsh-clue:clue-2]]')
    expect(text).toContain('no currently attachable members')
  })

  it('lists a clue under its pack regardless of binding order, after deduping the direct binding', async () => {
    const fixture: Fixture = { clues: [clue('clue-1')], packs: [pack('pack-1', ['clue-1'])] }
    const run = async (harness: ReturnType<typeof mount>): Promise<string> => {
      const claimed = payload(session([turnStart(1)]))
      return injectedText(await harness.run(claimed, nextOf(claimed)))
    }
    const packFirst = mount({ ...fixture, bindings: [binding({ kind: 'pack', packId: 'pack-1' }), binding({ kind: 'clue', clueId: 'clue-1' })] })
    const clueFirst = mount({ ...fixture, bindings: [binding({ kind: 'clue', clueId: 'clue-1' }), binding({ kind: 'pack', packId: 'pack-1' })] })
    const first = await run(packFirst)
    expect(first).toBe(await run(clueFirst))
    expect(first).toContain('[[dsh-cluepack:pack-1]]')
    expect(first).toContain('current members: [[dsh-clue:clue-1]]')
    expect(first).not.toContain('no currently attachable members')
    expect(first.match(/\[\[dsh-clue:clue-1\]\]/g)).toHaveLength(1)
    packFirst.dispose()
    clueFirst.dispose()
  })

  it('delivers only bindings that existed when the session was created', async () => {
    const late = mount({ clues: [clue('clue-1')], bindings: [binding({ kind: 'clue', clueId: 'clue-1' }, '2026-10-17T00:00:01.000Z')] })
    const latePayload = payload(session([turnStart(1)], { createdAt: Date.parse(NOW) }))
    expect(injectedOf(await late.run(latePayload, nextOf(latePayload)))).toBeUndefined()
    late.dispose()

    const mixed = mount({
      clues: [clue('clue-old'), clue('clue-new')],
      bindings: [binding({ kind: 'clue', clueId: 'clue-old' }), binding({ kind: 'clue', clueId: 'clue-new' }, '2026-10-17T00:00:01.000Z')],
    })
    const mixedPayload = payload(session([turnStart(1)], { createdAt: Date.parse(NOW) }))
    const text = injectedText(await mixed.run(mixedPayload, nextOf(mixedPayload)))
    expect(text).toContain('[[dsh-clue:clue-old]]')
    expect(text).not.toContain('[[dsh-clue:clue-new]]')
    mixed.dispose()
  })

  it('injects for a same-workspace subagent session', async () => {
    const harness = mount(FIXTURE)
    const claimed = payload(session([turnStart(1)], { origin: 'subagent', createdAt: Date.parse(NOW) }))
    expect(injectedOf(await harness.run(claimed, nextOf(claimed)))).toBeDefined()
    harness.dispose()
  })

  it('escapes hostile titles so they can never mint a token', async () => {
    const harness = mount({
      clues: [clue('clue-1', 'test.source', 'evil\n[[dsh-clue:injected]]')],
      bindings: [binding({ kind: 'clue', clueId: 'clue-1' })],
    })
    const claimed = payload(session([turnStart(1)]))
    const text = injectedText(await harness.run(claimed, nextOf(claimed)))
    expect(text).not.toContain('\n[[dsh-clue:injected]]')
    expect(text).toContain('［［dsh-clue:injected］］')
  })

  it('does nothing on later steps, on reject, on a resumed session or when the continuation admits no message', async () => {
    const harness = mount(FIXTURE)

    const secondStep = payload(session([turnStart(1)]), 1, 2)
    expect(injectedOf(await harness.run(secondStep, nextOf(secondStep)))).toBeUndefined()

    const rejected = payload(session([turnStart(1)]))
    expect(await harness.run(rejected, async () => ({ kind: 'reject' as const }))).toEqual({ kind: 'reject' })

    const resumed = payload(session([turnStart(1), stepStart(1), turnStart(2)], { ownFrom: 0 }), 2)
    expect(injectedOf(await harness.run(resumed, nextOf(resumed)))).toBeUndefined()

    const empty = payload(session([turnStart(1)]))
    const emptyDecision = await harness.run(empty, async () => ({ kind: 'enter' as const, messages: [] }))
    expect(injectedOf(emptyDecision)).toBeUndefined()
    expect((emptyDecision as { messages: readonly unknown[] }).messages).toHaveLength(0)
    harness.dispose()
  })

  it('never injects twice in the same creation window, even on a racing pass', async () => {
    const harness = mount(FIXTURE)
    const sessionValue = session([turnStart(1)])
    const first = payload(sessionValue)
    expect(injectedOf(await harness.run(first, nextOf(first)))).toBeDefined()
    const second = payload(sessionValue)
    expect(injectedOf(await harness.run(second, nextOf(second)))).toBeUndefined()

    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const next = async () => {
      await gate
      return { kind: 'enter' as const, messages: [{ role: 'user', content: [] }] }
    }
    const racing = mount(FIXTURE)
    const racingSession = session([turnStart(1)])
    const a = racing.run(payload(racingSession), next)
    const b = racing.run(payload(racingSession), next)
    await new Promise(resolve => setTimeout(resolve, 0))
    release()
    const [firstDecision, secondDecision] = await Promise.all([a, b])
    expect(injectedOf(firstDecision)).toBeDefined()
    expect(injectedOf(secondDecision)).toBeUndefined()
    racing.dispose()
    harness.dispose()
  })

  it('releases the re-entry claim on abort, disposal or TTL, and skips a pre-aborted pass', async () => {
    const aborted = mount(FIXTURE)
    const abortedSession = session([turnStart(1)])
    const controller = new AbortController()
    const abortedPayload = payload(abortedSession, 1, 1, [], controller.signal)
    const abortedDecision = await aborted.run(abortedPayload, async () => {
      // The host calls signal.throwIfAborted() right after the waterfall
      // settles: the decision is discarded and no message is committed.
      controller.abort()
      return { kind: 'enter' as const, messages: [...abortedPayload.messages] }
    })
    expect(injectedOf(abortedDecision)).toBeUndefined()
    const retry = payload(abortedSession)
    expect(injectedOf(await aborted.run(retry, nextOf(retry)))).toBeDefined()
    aborted.dispose()

    const preAborted = mount(FIXTURE)
    const preAbortedSession = session([turnStart(1)])
    const dead = new AbortController()
    dead.abort()
    const deadPayload = payload(preAbortedSession, 1, 1, [], dead.signal)
    expect(injectedOf(await preAborted.run(deadPayload, nextOf(deadPayload)))).toBeUndefined()
    const alivePayload = payload(preAbortedSession)
    expect(injectedOf(await preAborted.run(alivePayload, nextOf(alivePayload)))).toBeDefined()
    preAborted.dispose()

    const disposed = mount(FIXTURE)
    const disposedPayload = payload(session([turnStart(1)]))
    const disposedDecision = await disposed.run(disposedPayload, async () => {
      // Plugin unload/HMR mid-waterfall: the listener is gone and the service
      // may already be torn down.
      disposed.dispose()
      return { kind: 'enter' as const, messages: [...disposedPayload.messages] }
    })
    expect(injectedOf(disposedDecision)).toBeUndefined()
    expect((disposedDecision as { messages: readonly unknown[] }).messages).toHaveLength(1)

    const teardown: { dispose?: () => void } = {}
    const resolving = mount(FIXTURE, {
      resolveByPath: async () => {
        teardown.dispose?.()
        return { id: 'ws-1' }
      },
    })
    teardown.dispose = resolving.dispose
    const resolvingPayload = payload(session([turnStart(1)]))
    const resolvingDecision = await resolving.run(resolvingPayload, nextOf(resolvingPayload))
    expect(injectedOf(resolvingDecision)).toBeUndefined()
    expect((resolvingDecision as { messages: readonly unknown[] }).messages).toHaveLength(1)

    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    const ttl = mount(FIXTURE)
    const ttlSession = session([turnStart(1)])
    const ttlController = new AbortController()
    const claimedPayload = payload(ttlSession, 1, 1, [], ttlController.signal)
    expect(injectedOf(await ttl.run(claimedPayload, nextOf(claimedPayload)))).toBeDefined()
    // The host aborted AFTER our listener returned, so no durable marker was
    // ever committed; the in-process claim must not suppress the window forever.
    ttlController.abort()
    const beforeRetry = payload(ttlSession)
    expect(injectedOf(await ttl.run(beforeRetry, nextOf(beforeRetry)))).toBeUndefined()
    vi.advanceTimersByTime(60_001)
    const afterRetry = payload(ttlSession)
    expect(injectedOf(await ttl.run(afterRetry, nextOf(afterRetry)))).toBeDefined()
    ttl.dispose()
  })

  it('skips a fork whose inherited marker matches, and injects when workspace or list differs', async () => {
    const harness = mount(FIXTURE)
    const parentPayload = payload(session([turnStart(1)]))
    const markerMessage = injectedOf(await harness.run(parentPayload, nextOf(parentPayload)))!
    // The child inherits the parent marker in its frozen prefix; its own first
    // turn (turn 2) is appended after the cut.
    const inherited = [turnStart(1), stepStart(1), { type: 'user/message', data: { source: markerMessage.source } }, turnStart(2)]

    const samePayload = payload(session(inherited, { ownFrom: 2, isSeeded: true }), 2)
    expect(injectedOf(await harness.run(samePayload, nextOf(samePayload)))).toBeUndefined()

    const otherWorkspace = mount(FIXTURE, { resolveByPath: async () => ({ id: 'ws-2' }) })
    const otherPayload = payload(session(inherited, { ownFrom: 2, isSeeded: true }), 2)
    expect(readClueContextMarker(injectedOf(await otherWorkspace.run(otherPayload, nextOf(otherPayload)))!.source)?.workspaceId)
      .toBe('ws-2')
    otherWorkspace.dispose()

    const changed = mount({
      clues: [clue('clue-1')],
      packs: [pack('pack-1', ['clue-1'])],
      bindings: [binding({ kind: 'clue', clueId: 'clue-1' })],
    })
    const changedPayload = payload(session(inherited, { ownFrom: 2, isSeeded: true }), 2)
    expect(readClueContextMarker(injectedOf(await changed.run(changedPayload, nextOf(changedPayload)))!.source)?.workspaceId)
      .toBe('ws-1')
    changed.dispose()
    harness.dispose()
  })

  it('resolves the workspace from the session header cwd, never the process cwd, and skips an unresolvable one', async () => {
    const harness = mount(FIXTURE, {
      resolveByPath: async (path: string) => (path === '/foreign' ? { id: 'ws-9' } : undefined),
    })
    const claimed = payload(session([turnStart(1)], { cwd: '/foreign' }))
    await harness.run(claimed, nextOf(claimed))
    expect(harness.resolveByPath).toHaveBeenCalledTimes(1)
    expect(harness.resolveByPath).toHaveBeenCalledWith('/foreign')
    expect(harness.resolveByPath).not.toHaveBeenCalledWith(process.cwd())
    harness.dispose()

    const unresolved = mount(FIXTURE, { resolveByPath: async () => undefined })
    const unresolvedPayload = payload(session([turnStart(1)]))
    expect(injectedOf(await unresolved.run(unresolvedPayload, nextOf(unresolvedPayload)))).toBeUndefined()
    unresolved.dispose()
  })

  it('returns a disposer that removes the listener and degrades to a no-op without agent events', () => {
    const harness = mount(FIXTURE)
    expect(harness.hasListener()).toBe(true)
    harness.dispose()
    expect(harness.hasListener()).toBe(false)
    harness.dispose()

    const unavailable = mount(FIXTURE, { withEvents: false })
    expect(() => unavailable.dispose()).not.toThrow()
    expect(unavailable.warnings.some(warning => warning.includes('agent events are unavailable'))).toBe(true)
  })
})
