/**
 * The selection-translation handler's own contract: boundary validation, the
 * default/override provider/model route, the direct one-message generation over
 * the selected text, the formatting-preserving result, and every failure shape
 * (malformed input, missing route, error/aborted/truncated finish, thrown
 * stream, caller abort, deadline, and empty output).
 *
 * The model is a small stream fake; no host, agent, session log, draft, or
 * filesystem is involved. The real module is exercised through the exported
 * `createSelectionTranslationHandler`, and the stream options are inspected
 * the way the host route would see them.
 */
import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  createSelectionTranslationHandler,
  type SelectionTranslationHandler,
  type SelectionTranslationRoute,
} from '../src/selection-translation.ts'
import { SidebarError } from '../src/wire.ts'

const ROUTE: SelectionTranslationRoute = { provider: 'test-provider', model: 'test-model' }

const DEFAULT_CHUNKS: readonly StreamChunk[] = [
  { type: 'text-delta', index: 0, text: '你好' },
  { type: 'text-delta', index: 0, text: '，世界' },
  { type: 'finish', reason: { kind: 'stop' } },
]

function streamOf(chunks: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  return (async function* () {
    for (const chunk of chunks) yield chunk
  })()
}

type ResolveModel = (
  sessionId: string,
) => SelectionTranslationRoute | undefined | Promise<SelectionTranslationRoute | undefined>

type StreamFactory = (options: GenerateOptions) => AsyncIterable<StreamChunk>

interface Harness {
  handle: SelectionTranslationHandler
  /** Every `llm.stream` argument, in call order. */
  calls: GenerateOptions[]
  /** Every session id the resolver saw. */
  sessionIds: string[]
}

function harness(
  resolveModel: ResolveModel = async () => ROUTE,
  stream: StreamFactory = () => streamOf(DEFAULT_CHUNKS),
): Harness {
  const calls: GenerateOptions[] = []
  const sessionIds: string[] = []
  const handle = createSelectionTranslationHandler({
    llm: {
      stream(options) {
        calls.push(options)
        return stream(options)
      },
    },
    resolveModel(sessionId) {
      sessionIds.push(sessionId)
      return resolveModel(sessionId)
    },
  })
  return { handle, calls, sessionIds }
}

/** The exact valid payload shape; `overrides` sets malformed or extra fields. */
function payload(overrides: Record<string, unknown> = {}): unknown {
  return {
    sessionId: 'session-1',
    text: 'Hello, world',
    language: 'zh-CN',
    ...overrides,
  }
}

/** The user half of one recorded request (the route sends exactly one message). */
function userTextOf(options: GenerateOptions | undefined): string {
  const message = options?.messages[0]
  if (message === undefined) return ''
  return message.content
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('')
}

/** A never-resolving model pull that rejects with the signal's reason. */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

describe('createSelectionTranslationHandler', () => {
  it('translates through one direct LLM call on the resolved session route', async () => {
    const h = harness()
    const result = await h.handle(payload({ language: '  zh-CN  ' }))

    expect(result).toEqual({
      text: '你好，世界',
      provider: 'test-provider',
      model: 'test-model',
      language: 'zh-CN',
    })
    expect(h.sessionIds).toEqual(['session-1'])
    expect(h.calls).toHaveLength(1)

    const call = h.calls[0]
    expect(call).toBeDefined()
    if (call === undefined) throw new Error('no LLM call was recorded')
    expect(call.provider).toBe(ROUTE.provider)
    expect(call.model).toBe(ROUTE.model)
    expect(call.messages).toHaveLength(1)
    expect(call.messages[0]?.role).toBe('user')
    expect(userTextOf(call)).toBe('Hello, world')
    expect(call.messages[0]?.source).toEqual({ kind: 'plugin:dsh-better-sidebar' })
    // No session identity, agent state, tools, or draft reaches the model.
    expect(call.sessionId).toBeUndefined()
    expect(call.tools).toBeUndefined()
    expect(call.system).toContain('zh-CN')
    expect(call.system).toMatch(/already in zh-CN/i)
    expect(call.system).toMatch(/return it unchanged/i)
    expect(call.signal).toBeInstanceOf(AbortSignal)
  })

  it('accepts a synchronous resolver as well as an async one', async () => {
    const h = harness(() => ({ provider: 'sync-provider', model: 'sync-model' }))
    const result = await h.handle(payload())

    expect(result.provider).toBe('sync-provider')
    expect(result.model).toBe('sync-model')
    expect(h.sessionIds).toEqual(['session-1'])
  })

  it('prefers the payload route and never consults the session resolver', async () => {
    const h = harness(async () => {
      throw new Error('the resolver must not run for a pinned route')
    })
    const result = await h.handle(payload({
      model: { provider: ' openrouter ', model: ' vendor/model ' },
    }))

    expect(result.provider).toBe('openrouter')
    expect(result.model).toBe('vendor/model')
    expect(h.sessionIds).toEqual([])
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.provider).toBe('openrouter')
    expect(h.calls[0]?.model).toBe('vendor/model')
  })

  it('returns the streamed output verbatim, including fenced blocks and padding', async () => {
    const fenced = '  ```ts\nconst x = 1\n```  \n'
    const h = harness(async () => ROUTE, () => streamOf([
      { type: 'text-delta', index: 0, text: fenced },
      { type: 'finish', reason: { kind: 'stop' } },
    ]))
    const result = await h.handle(payload({ text: fenced, language: 'en' }))

    expect(result.text).toBe(fenced)
    expect(userTextOf(h.calls[0])).toBe(fenced)
  })

  it('treats source==target as an ordinary generation whose prompt preserves identity', async () => {
    const h = harness(async () => ROUTE, () => streamOf([
      { type: 'text-delta', index: 0, text: 'Same text' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]))
    const result = await h.handle(payload({ text: 'Same text', language: 'en' }))

    expect(result.text).toBe('Same text')
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.system).toMatch(/already in en/i)
    expect(h.calls[0]?.system).toMatch(/return it unchanged/i)
  })

  it('accepts the documented inclusive bounds', async () => {
    const h = harness()
    const longText = 'x'.repeat(32_768)
    const longLanguage = 'l'.repeat(100)
    const longProvider = 'p'.repeat(200)
    const longModel = 'm'.repeat(200)
    const result = await h.handle(payload({
      text: longText,
      language: longLanguage,
      model: { provider: longProvider, model: longModel },
    }))

    expect(result.language).toBe(longLanguage)
    expect(result.provider).toBe(longProvider)
    expect(result.model).toBe(longModel)
    expect(h.sessionIds).toEqual([])
  })

  it('rejects malformed payloads before resolving a route or calling the model', async () => {
    const invalid: readonly [string, unknown][] = [
      ['non-object payload', null],
      ['array payload', []],
      ['missing sessionId', payload({ sessionId: undefined })],
      ['empty sessionId', payload({ sessionId: '' })],
      ['non-string sessionId', payload({ sessionId: 42 })],
      ['missing text', payload({ text: undefined })],
      ['empty text', payload({ text: '' })],
      ['whitespace text', payload({ text: ' \n\t ' })],
      ['text over 32768 characters', payload({ text: 'x'.repeat(32_769) })],
      ['missing language', payload({ language: undefined })],
      ['empty language', payload({ language: '' })],
      ['whitespace language', payload({ language: '  ' })],
      ['language over 100 characters', payload({ language: 'x'.repeat(101) })],
      ['non-object model', payload({ model: 'test-provider/test-model' })],
      ['null model', payload({ model: null })],
      ['array model', payload({ model: [] })],
      ['empty model provider', payload({ model: { provider: '', model: 'm' } })],
      ['empty model id', payload({ model: { provider: 'p', model: ' ' } })],
      ['model provider over 200 characters', payload({ model: { provider: 'x'.repeat(201), model: 'm' } })],
      ['model id over 200 characters', payload({ model: { provider: 'p', model: 'x'.repeat(201) } })],
    ]

    for (const [, value] of invalid) {
      const h = harness()
      const error: unknown = await h.handle(value).catch((reason: unknown) => reason)
      expect(error).toBeInstanceOf(SidebarError)
      expect(error).toMatchObject({ code: 'selection-error', status: 400 })
      expect(h.sessionIds).toHaveLength(0)
      expect(h.calls).toHaveLength(0)
    }
  })

  it('reports an unavailable session route without calling the model', async () => {
    const resolvers: readonly ResolveModel[] = [
      async () => undefined,
      async () => {
        throw new Error('the session is unavailable')
      },
    ]

    for (const resolveModel of resolvers) {
      const h = harness(resolveModel)
      const error: unknown = await h.handle(payload()).catch((reason: unknown) => reason)
      expect(error).toBeInstanceOf(SidebarError)
      expect(error).toMatchObject({ code: 'selection-error', status: 503 })
      expect(h.calls).toHaveLength(0)
    }
  })

  it('never reports a partial answer as success for a non-stop finish', async () => {
    const partial: StreamChunk = { type: 'text-delta', index: 0, text: 'partial answer' }
    const cases: readonly { chunks: readonly StreamChunk[]; message: RegExp }[] = [
      {
        chunks: [
          partial,
          {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { message: 'provider exploded', code: 'E_PROVIDER' },
            },
          },
        ],
        message: /provider exploded/,
      },
      {
        chunks: [
          partial,
          {
            type: 'finish',
            reason: {
              kind: 'aborted',
              failure: { message: 'upstream abort', code: 'E_ABORTED' },
            },
          },
        ],
        message: /aborted/i,
      },
      {
        chunks: [partial, { type: 'finish', reason: { kind: 'max-tokens' } }],
        message: /truncat|output limit/i,
      },
      {
        chunks: [partial, { type: 'finish', reason: { kind: 'tool-calls' } }],
        message: /did not finish cleanly/i,
      },
    ]

    for (const { chunks, message } of cases) {
      const h = harness(async () => ROUTE, () => streamOf(chunks))
      const error: unknown = await h.handle(payload()).catch((reason: unknown) => reason)
      expect(error).toBeInstanceOf(SidebarError)
      expect(error).toMatchObject({ code: 'selection-error', status: 502 })
      expect((error as Error).message).toMatch(message)
    }
  })

  it('rejects empty and whitespace-only output', async () => {
    const cases: readonly (readonly StreamChunk[])[] = [
      [{ type: 'finish', reason: { kind: 'stop' } }],
      [
        { type: 'text-delta', index: 0, text: ' \n\t ' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
      [
        { type: 'reasoning-delta', index: 0, text: 'thinking, not a translation' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    ]

    for (const chunks of cases) {
      const h = harness(async () => ROUTE, () => streamOf(chunks))
      await expect(h.handle(payload())).rejects.toMatchObject({
        code: 'selection-error',
        status: 502,
        message: expect.stringMatching(/empty translation/i),
      })
    }
  })

  it('maps a thrown stream failure to selection-error', async () => {
    const h = harness(async () => ROUTE, () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('socket closed')),
      }),
    }))

    const error: unknown = await h.handle(payload()).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(SidebarError)
    expect(error).toMatchObject({ code: 'selection-error', status: 502 })
    expect((error as Error).message).toMatch(/model call failed/i)
  })

  it('passes a merged signal and rejects the partial answer when the caller aborts', async () => {
    let observed: AbortSignal | undefined
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    const h = harness(async () => ROUTE, (options) => {
      const signal = options.signal
      if (signal === undefined) throw new Error('the handler did not pass an abort signal')
      observed = signal
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: 'partial answer' } satisfies StreamChunk
        started()
        await rejectOnAbort(signal)
      })()
    })

    const controller = new AbortController()
    const pending = h.handle(payload(), controller.signal)
    await startedPromise

    expect(observed).toBeInstanceOf(AbortSignal)
    expect(observed).not.toBe(controller.signal)
    const expectation = expect(pending).rejects.toMatchObject({
      code: 'selection-error',
      status: 499,
    })
    controller.abort()
    await expectation
  })

  it('rejects an already-cancelled request before resolving or calling the model', async () => {
    const h = harness()
    const controller = new AbortController()
    controller.abort()

    await expect(h.handle(payload(), controller.signal)).rejects.toMatchObject({
      code: 'selection-error',
      status: 499,
    })
    expect(h.sessionIds).toHaveLength(0)
    expect(h.calls).toHaveLength(0)
  })

  it('times out a stalled generation and never returns its partial answer', async () => {
    const timeoutController = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal)
    try {
      let observed: AbortSignal | undefined
      let started!: () => void
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve
      })
      const h = harness(async () => ROUTE, (options) => {
        const signal = options.signal
        if (signal === undefined) throw new Error('the handler did not pass an abort signal')
        observed = signal
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: 'partial answer' } satisfies StreamChunk
          started()
          await rejectOnAbort(signal)
        })()
      })

      const pending = h.handle(payload())
      await startedPromise
      expect(timeout).toHaveBeenCalledWith(90_000)
      const expectation = expect(pending).rejects.toMatchObject({
        code: 'selection-error',
        status: 504,
      })
      timeoutController.abort(new DOMException('selection translation timed out', 'TimeoutError'))
      await expectation
      expect(observed?.aborted).toBe(true)
    } finally {
      timeout.mockRestore()
    }
  })
})
