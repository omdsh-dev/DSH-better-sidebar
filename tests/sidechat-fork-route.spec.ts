/**
 * R2 (route half) — `sidechat.events` must TELL the client where this thread
 * forked off its parent, and what the parent conversation looked like there.
 * Design basis: `/tmp/bsb-parity/forkpoint-recon.md` §Q3 (the cut point, what
 * precedes it, the field shape).
 *
 * Why this spec exists: a side thread's log begins with the inherited parent
 * log as a fork seed, and the route CUTS everything up to the last
 * `session/end-seed { inherited: true }` marker before sending anything. That
 * cut is invisible: the transcript opens on the side question with no hint that
 * it continues a conversation — the reader cannot see which question they were
 * asking in the main pane when they branched off. The parent prefix never
 * crosses the wire, so the client cannot reconstruct it; the host route must
 * summarise it in one additive field.
 *
 * ============================ CONTRACT ============================
 * 1. On the FIRST pull (`afterSeq === undefined`) the result carries an
 *    ADDITIVE `fork` field:
 *      `{ cutSeq: number, user?: { seq, text, messageId? }, assistant?: { seq, text, messageId? } }`
 *    where `cutSeq` is the seq of the inherited `session/end-seed` marker the
 *    route cut at (the LAST one — the same marker `threadOwnLogEvents` cuts at,
 *    so a restored/forked-of-a-fork log reports the cut it actually shows).
 * 2. `user` is the LAST real user message BEFORE the cut — "real" meaning a
 *    `user/message` that is NOT a surface REPLACEMENT (`surfaceOp` other than
 *    `'append'`): a compaction checkpoint is logged as a `user/message` and must
 *    never be presented as the question the reader typed. `assistant` is the
 *    NEAREST PRECEDING `assistant/message` that actually carries a text block:
 *    a step that only called tools or only reasoned is SKIPPED — not treated as
 *    "there is no answer" — and the scan keeps walking back to the last one that
 *    said something. (The log records one assistant message per step, so the
 *    message right before the cut is routinely textless; stopping there is why
 *    a fork whose last parent message was an unanswered question showed no
 *    answer at all.) Text blocks only — reasoning never leaks into the banner.
 * 3. CARRIED VERBATIM — no length cap and no truncation. Both parts are the
 *    parent's own words and the reader asked for the words themselves: `user.text`
 *    and `assistant.text` arrive exactly as the log records them, however long,
 *    with no ellipsis and no boundary guessing (the block scrolls). An earlier
 *    revision capped them at 400 / 4000 and cut on a sentence boundary; that
 *    cap is gone.
 * 4. Independently optional: a message whose text blocks are empty (an
 *    image-only prompt) contributes nothing, so `user` is absent rather than
 *    `{ text: '' }`. With neither part present the field is still `{ cutSeq }`.
 *    `messageId` rides the part only when the log records a durable identity
 *    (`data.id` on the user message, `message.id` on the assistant message) —
 *    an older log leaves the field ABSENT, never `''`.
 * 5. Absent when it cannot be known: no inherited marker (an unseeded log) →
 *    NO `fork` field at all; and a DELTA pull (`afterSeq` given) never carries
 *    it (the client caches it from the first pull only).
 * 6. The field is additive: `events`, `live`, `pending` and `truncated` keep
 *    their shapes and values, and `events` is still the CUT tail (the parent
 *    prefix must not leak into the transcript through the new field's provider).
 * 7. A runtime CONTEXT injection is not the reader's question. Loaders append
 *    `user/message` events whose `data.source.kind` is their own kind
 *    (`time-context`, `tmux-context`, `plugin:…` — never `'user'`): a reminder
 *    the host wrote into the log, not something the reader typed. `user` only
 *    considers messages whose `source.kind` is ABSENT (old logs) or exactly
 *    `'user'`, falls back to the last such message, and stays absent when the
 *    prefix carries none.
 * ==================================================================
 *
 * Kept in its own file (rather than appended to tests/sidechat-routes.spec.ts)
 * so the existing route assertions stay untouched. The fakes below are the
 * minimal live-agent face the `sidechat.events` handler reads.
 */
import { describe, expect, it, vi } from 'vitest'
import { buildSidechatApi } from '../src/sidechat-routes.ts'
import type { Context } from '../src/context-types.ts'

/** One `{seq,text}` part of the fork field, plus the durable id when the log records one. */
interface ForkPart {
  seq: number
  text: string
  messageId?: string
}

/** The `sidechat.events` result, plus the field this contract adds. */
interface EventsResult {
  events: { seq: number; type: string }[]
  live: unknown[]
  pending: unknown[]
  truncated?: boolean
  fork?: { cutSeq: number; user?: ForkPart; assistant?: ForkPart }
}

/** The narrowest live agent the events handler reads. */
function agent(id: string, events: unknown[]) {
  const inbox = { nextTurn: [] as unknown[], nextStep: [] as unknown[], clear: vi.fn(), remove: vi.fn(() => true) }
  return {
    id,
    status: 'idle' as const,
    options: { provider: 'test', model: 'model-x' },
    ctx: { on: vi.fn(() => () => {}) },
    session: {
      id,
      header: { cwd: '/p', delegationDepth: 0 },
      inheritedEventCount: 0,
      snapshotEvents: () => events,
      append: vi.fn((type: string, data: unknown) => ({ type, seq: 0, time: 0, data })),
    },
    inject: vi.fn(),
    followup: vi.fn(),
    cancel: vi.fn(),
    inbox,
  }
}

/** A context serving only the agents service the handler needs. */
function ctxWithAgents(child: ReturnType<typeof agent>): Context {
  return {
    get: (key: string) => (key === 'agents' ? { get: (id: string) => (id === child.id ? child : undefined) } : undefined),
  } as unknown as Context
}

/** One plain `user/message` as the log records it. */
function userEvent(seq: number, text: string): unknown {
  return {
    type: 'user/message',
    seq,
    time: seq * 1_000,
    surfaceOp: 'append',
    data: { id: `mu-${String(seq)}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}

/** One `assistant/message` whose content carries text and (optionally) reasoning. */
function assistantEvent(seq: number, text: string, reasoning = ''): unknown {
  const content: unknown[] = []
  if (reasoning !== '') content.push({ type: 'reasoning', text: reasoning })
  if (text !== '') content.push({ type: 'text', text })
  return {
    type: 'assistant/message',
    seq,
    time: seq * 1_000,
    surfaceOp: 'append',
    data: { turn: 1, step: 1, message: { content } },
  }
}

/** One assistant STEP message that carries no text block at all: a tool call
 *  (the shape every step that ends in a tool logs). */
function toolOnlyAssistantEvent(seq: number): unknown {
  return {
    type: 'assistant/message',
    seq,
    time: seq * 1_000,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'tool-call', id: 'call-x', name: 'bash', arguments: '{}' }] },
    },
  }
}

/** One assistant STEP message that only reasoned (no text block). */
function reasoningOnlyAssistantEvent(seq: number): unknown {
  return {
    type: 'assistant/message',
    seq,
    time: seq * 1_000,
    surfaceOp: 'append',
    data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: 'PRIVATE-REASONING' }] } },
  }
}

/** The inherited seed marker the route cuts at. */
function seedMarker(seq: number): unknown {
  return { type: 'session/end-seed', seq, time: seq * 1_000, data: { inherited: true } }
}

/** The parent conversation: two question/answer pairs, then the cut. */
function parentLog(): unknown[] {
  return [
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    userEvent(1, 'PARENT-QUESTION-ONE'),
    assistantEvent(2, 'PARENT-ANSWER-ONE'),
    userEvent(3, 'PARENT-QUESTION-TWO'),
    assistantEvent(4, 'PARENT-ANSWER-TWO'),
  ]
}

/** The thread's own events after the cut. */
function ownLog(): unknown[] {
  return [
    userEvent(7, 'SIDE-QUESTION'),
    { type: 'turn/start', seq: 8, time: 8_000, data: { turn: 1 } },
  ]
}

/** The default thread log: parent prefix, cut marker at 6, own events after. */
function seededLog(): unknown[] {
  return [...parentLog(), seedMarker(6), ...ownLog()]
}

/**
 * Read the events route over one thread log.
 * @param events - the full decoded log (seed + own).
 * @param payload - extra request fields (`afterSeq` for a delta pull).
 */
async function eventsRoute(events: unknown[], payload: Record<string, unknown> = {}): Promise<EventsResult> {
  const child = agent('child', events)
  const api = buildSidechatApi(ctxWithAgents(child))
  const result = await api['sidechat.events']({ childId: 'child', ...payload })
  return result as unknown as EventsResult
}

describe('sidechat.events fork point (R2)', () => {
  it('reports the cut and the parent question/answer on the first pull', async () => {
    const result = await eventsRoute(seededLog())
    expect(result.fork, 'the first pull carries the fork point').toBeDefined()
    expect(result.fork?.cutSeq, 'the cut is the inherited seed marker').toBe(6)
    expect(result.fork?.user, 'the parent question is summarised').toMatchObject({
      seq: 3,
      text: 'PARENT-QUESTION-TWO',
    })
    expect(result.fork?.assistant, 'the parent answer tail is summarised').toMatchObject({
      seq: 4,
      text: 'PARENT-ANSWER-TWO',
    })
  })

  it('carries each part’s durable message id when the log records one, and omits an unrecorded one', async () => {
    const result = await eventsRoute(seededLog())
    expect(result.fork?.user?.messageId, 'the user part carries the log’s own id').toBe('mu-3')
    expect(result.fork?.assistant, 'a message with no recorded id omits the field').not.toHaveProperty('messageId')

    // The assistant identity lives on the message object, not on the event.
    const answered = {
      type: 'assistant/message',
      seq: 2,
      time: 2_000,
      surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { id: 'ma-2', content: [{ type: 'text', text: 'PARENT-ANSWER' }] } },
    }
    const identified = await eventsRoute([userEvent(1, 'PARENT-QUESTION'), answered, seedMarker(3), ...ownLog()])
    expect(identified.fork?.user?.messageId).toBe('mu-1')
    expect(identified.fork?.assistant?.messageId, 'the answer’s id comes from message.id').toBe('ma-2')
  })

  it('still returns the CUT tail as the transcript events', async () => {
    const result = await eventsRoute(seededLog())
    expect(
      result.events.map(event => event.seq),
      'the parent prefix never leaks into the transcript',
    ).toEqual([7, 8])
    expect(result.truncated, 'the existing fields keep their shapes').toBe(false)
    expect(Array.isArray(result.live)).toBe(true)
    expect(Array.isArray(result.pending)).toBe(true)
  })

  it('skips a compaction checkpoint instead of presenting it as the question', async () => {
    const checkpoint = {
      type: 'user/message',
      seq: 5,
      time: 5_000,
      // A replacement surface event: the compacted summary masquerading as a
      // user message (`compactSource`, host `command.ts:60-77`).
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 4 },
      data: {
        id: 'm-checkpoint',
        role: 'user',
        content: [{ type: 'text', text: 'COMPACTED SUMMARY OF THE OLD TURNS' }],
        source: { kind: 'compact-checkpoint', compactionId: 'cp1' },
      },
    }
    const result = await eventsRoute([...parentLog(), checkpoint, seedMarker(6), ...ownLog()])
    expect(result.fork?.cutSeq).toBe(6)
    expect(result.fork?.user?.seq, 'the real question, not the checkpoint').toBe(3)
    expect(result.fork?.user?.text).toBe('PARENT-QUESTION-TWO')
  })

  it('reads the LAST inherited marker, like the transcript cut does', async () => {
    // A restored / re-forked log can carry more than one inherited marker; the
    // cut that matters is the one whose tail is on screen.
    const result = await eventsRoute([
      userEvent(0, 'OLDEST-QUESTION'),
      seedMarker(1),
      userEvent(2, 'MIDDLE-QUESTION'),
      assistantEvent(3, 'MIDDLE-ANSWER'),
      seedMarker(4),
      userEvent(5, 'SIDE-QUESTION'),
    ])
    expect(result.fork?.cutSeq, 'the last inherited marker is the cut').toBe(4)
    expect(result.fork?.user?.text, 'the question before THAT cut').toBe('MIDDLE-QUESTION')
    expect(result.fork?.assistant?.text).toBe('MIDDLE-ANSWER')
  })

  it('carries a long answer verbatim, with no truncation mark', async () => {
    const longAnswer = `${'A long sentence about the work. '.repeat(200)}TAIL-OF-THE-ANSWER`
    const result = await eventsRoute([
      userEvent(1, 'PARENT-QUESTION'),
      assistantEvent(2, longAnswer),
      seedMarker(3),
      ...ownLog(),
    ])
    const answer = result.fork?.assistant?.text ?? ''
    expect(longAnswer.length, 'the fixture really is long').toBeGreaterThan(5_000)
    expect(
      answer,
      `the answer arrives exactly as the log holds it ` +
        `(${String(longAnswer.length)} in, ${String(answer.length)} out)`,
    ).toBe(longAnswer)
    expect(answer, 'and carries no truncation mark').not.toMatch(/…$|\.\.\.$/)
  })

  it('carries a long question verbatim too', async () => {
    const longQuestion = `${'question words here. '.repeat(60)}LAST-QUESTION-WORDS`
    const result = await eventsRoute([
      userEvent(1, longQuestion),
      assistantEvent(2, 'PARENT-ANSWER'),
      seedMarker(3),
      ...ownLog(),
    ])
    expect(longQuestion.length, 'the fixture really is long').toBeGreaterThan(400)
    expect(
      result.fork?.user?.text,
      `the question arrives exactly as the log holds it ` +
        `(${String(longQuestion.length)} in, ${String((result.fork?.user?.text ?? '').length)} out)`,
    ).toBe(longQuestion)
    expect(result.fork?.user?.text ?? '', 'and carries no truncation mark').not.toMatch(/…$|\.\.\.$/)
  })

  it('keeps the answer when the parent asked again and the last step has no text', async () => {
    const result = await eventsRoute([
      userEvent(1, 'PARENT-QUESTION-ONE'),
      assistantEvent(2, 'PARENT-ANSWER-ONE'),
      userEvent(3, 'PARENT-QUESTION-TWO'),
      toolOnlyAssistantEvent(4),
      seedMarker(5),
      ...ownLog(),
    ])
    expect(result.fork?.user, 'the unanswered question is the fork point').toMatchObject({
      seq: 3,
      text: 'PARENT-QUESTION-TWO',
    })
    expect(
      result.fork?.assistant,
      'the last answer that HAS text is carried, not dropped for a textless step',
    ).toMatchObject({ seq: 2, text: 'PARENT-ANSWER-ONE' })
  })

  it('skips a reasoning-only step for the answer tail', async () => {
    const result = await eventsRoute([
      userEvent(1, 'PARENT-QUESTION'),
      assistantEvent(2, 'PARENT-ANSWER'),
      reasoningOnlyAssistantEvent(3),
      seedMarker(4),
      ...ownLog(),
    ])
    expect(result.fork?.assistant, 'the reasoning-only step is skipped').toMatchObject({
      seq: 2,
      text: 'PARENT-ANSWER',
    })
    expect(result.fork?.assistant?.text ?? '', 'reasoning never leaks').not.toContain('PRIVATE-REASONING')
  })

  it('carries both parts when an earlier answer precedes the open question', async () => {
    const result = await eventsRoute([
      userEvent(1, 'PARENT-QUESTION-ONE'),
      assistantEvent(2, 'PARENT-ANSWER-ONE'),
      userEvent(3, 'PARENT-QUESTION-TWO'),
      seedMarker(4),
      ...ownLog(),
    ])
    expect(result.fork?.user, 'the question that was open at the fork').toMatchObject({
      seq: 3,
      text: 'PARENT-QUESTION-TWO',
    })
    expect(result.fork?.assistant, 'and the answer before it').toMatchObject({
      seq: 2,
      text: 'PARENT-ANSWER-ONE',
    })
  })

  it('omits the answer when no assistant message before the cut carries text', async () => {
    const result = await eventsRoute([
      userEvent(1, 'PARENT-QUESTION'),
      reasoningOnlyAssistantEvent(2),
      toolOnlyAssistantEvent(3),
      seedMarker(4),
      ...ownLog(),
    ])
    expect(result.fork?.user, 'the question is still carried').toMatchObject({
      seq: 1,
      text: 'PARENT-QUESTION',
    })
    expect(result.fork?.assistant, 'there is nothing to quote as the answer').toBeUndefined()
  })

  it('never leaks reasoning into the answer tail', async () => {
    const result = await eventsRoute([
      userEvent(1, 'PARENT-QUESTION'),
      assistantEvent(2, 'PARENT-ANSWER', 'PRIVATE-REASONING'),
      seedMarker(3),
      ...ownLog(),
    ])
    expect(result.fork?.assistant?.text).toBe('PARENT-ANSWER')
    expect(result.fork?.assistant?.text ?? '', 'reasoning is not banner material').not.toContain('PRIVATE-REASONING')
  })

  it('omits a part whose message carries no text', async () => {
    const imageOnly = {
      type: 'user/message',
      seq: 2,
      time: 2_000,
      surfaceOp: 'append',
      data: {
        id: 'm-image',
        role: 'user',
        content: [{ type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 4, width: 1, height: 1 } }],
        source: { kind: 'user' },
      },
    }
    const result = await eventsRoute([userEvent(1, 'PARENT-QUESTION'), imageOnly, seedMarker(3), ...ownLog()])
    expect(result.fork?.cutSeq).toBe(3)
    expect(result.fork?.user, 'an image-only prompt has no text to show').toBeUndefined()
  })

  it('still reports the cut when the parent prefix carries nothing usable', async () => {
    const result = await eventsRoute([seedMarker(0), ...ownLog()])
    expect(result.fork, 'an empty seed still says where the thread forked').toEqual({ cutSeq: 0 })
  })

  it('omits the field for an unseeded log', async () => {
    const unseeded = [
      { type: 'session/end-seed', seq: 0, time: 0, data: {} },
      userEvent(1, 'FIRST-QUESTION'),
    ]
    const result = await eventsRoute(unseeded)
    expect('fork' in result ? result.fork : undefined, 'no inherited marker, no fork point').toBeUndefined()
  })

  it('omits the field on a delta pull', async () => {
    const result = await eventsRoute(seededLog(), { afterSeq: 7 })
    expect(result.events.map(event => event.seq), 'the delta itself is unchanged').toEqual([8])
    expect('fork' in result ? result.fork : undefined, 'only the first pull carries it').toBeUndefined()
  })
})

/** A runtime CONTEXT injection: logged as a `user/message`, but its
 *  `data.source.kind` is the loader's own kind (host
 *  `context/time-context/src/index.ts:16,221`), so the reader never typed it. */
function contextEvent(seq: number, kind: string, text: string): unknown {
  return {
    type: 'user/message',
    seq,
    time: seq * 1_000,
    surfaceOp: 'append',
    data: {
      id: `mc-${String(seq)}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind, form: 'snapshot', sections: [{ name: kind, text }] },
    },
  }
}

/** A `user/message` the reader typed, with the source marker omitted (old logs). */
function sourcelessUserEvent(seq: number, text: string): unknown {
  return {
    type: 'user/message',
    seq,
    time: seq * 1_000,
    surfaceOp: 'append',
    data: { id: `ms-${String(seq)}`, role: 'user', content: [{ type: 'text', text }] },
  }
}

/** The injected kinds the host writes around the reader's turns. */
const INJECTED_KINDS = ['time-context', 'tmux-context', 'plugin:dsh-better-sidebar'] as const

/** The reminder copy a `time-context` loader writes. */
const REMINDER = 'Time sampled while preparing the response.'

describe("sidechat.events fork point: the reader's question, not a runtime injection (R3)", () => {
  it('skips a runtime context injection that landed after the real question', async () => {
    for (const kind of INJECTED_KINDS) {
      const result = await eventsRoute([
        userEvent(1, 'PARENT-QUESTION-ONE'),
        assistantEvent(2, 'PARENT-ANSWER-ONE'),
        userEvent(3, 'PARENT-QUESTION-TWO'),
        contextEvent(4, kind, REMINDER),
        seedMarker(5),
        ...ownLog(),
      ])
      expect.soft(result.fork?.cutSeq, `${kind}: the cut is unchanged`).toBe(5)
      expect.soft(
        result.fork?.user,
        `${kind}: the banner quotes the reader's question, not the injection`,
      ).toMatchObject({ seq: 3, text: 'PARENT-QUESTION-TWO' })
      expect.soft(
        result.fork?.user?.text ?? '',
        `${kind}: no reminder text reaches the banner`,
      ).not.toContain('Time sampled')
    }
  })

  it('omits the question when only injections precede the cut', async () => {
    const result = await eventsRoute([
      contextEvent(1, 'time-context', REMINDER),
      contextEvent(2, 'tmux-context', 'tmux pane snapshot'),
      seedMarker(3),
      ...ownLog(),
    ])
    expect(result.fork?.cutSeq, 'the cut itself is still reported').toBe(3)
    expect(result.fork?.user, 'an injection is not something the reader typed').toBeUndefined()
  })

  it('keeps preferring a real question that follows an injection', async () => {
    const result = await eventsRoute([
      contextEvent(1, 'time-context', REMINDER),
      userEvent(2, 'PARENT-QUESTION'),
      assistantEvent(3, 'PARENT-ANSWER'),
      seedMarker(4),
      ...ownLog(),
    ])
    expect(result.fork?.user, 'the real question still wins').toMatchObject({
      seq: 2,
      text: 'PARENT-QUESTION',
    })
  })

  it('still treats a user message with no source marker as the reader\'s question', async () => {
    const result = await eventsRoute([
      sourcelessUserEvent(1, 'NO-SOURCE-QUESTION'),
      seedMarker(2),
      ...ownLog(),
    ])
    expect(
      result.fork?.user,
      'only a PRESENT non-user source kind marks an injection',
    ).toMatchObject({ seq: 1, text: 'NO-SOURCE-QUESTION' })
  })
})
