/**
 * The one `content.locate` a pick asks, held for Send (`src/client/pick-lookup.ts`, 28/09/2026).
 *
 * `develop`'s controller kept locate answers by CSS selector and never let them go: the `h1` picked
 * on a second page got the record of the `h1` picked on the first (its ids went to the agent), and an
 * answer built from a half-read index (`incomplete: true`) was kept like a whole one. Here an answer
 * belongs to one pick, a new pick aborts the lookup before it, and an incomplete or missing answer is
 * asked again at Send.
 */
import { describe, expect, it } from 'vitest'
import { createPickLookup, isFinalLocate, type LocateAsk } from '../src/client/pick-lookup.ts'

const RESOLVED = { status: 'resolved', levels: [{ kind: 'record', id: '104', label: 'Menu item "Services"' }] }
const PARTIAL = { status: 'unknown', levels: [], incomplete: true }

/** An ask that answers `value`, counting its calls and keeping each call's signal. */
function asking(value: unknown): LocateAsk & { calls: number; signals: AbortSignal[] } {
  const ask = ((signal: AbortSignal) => {
    ask.calls += 1
    ask.signals.push(signal)
    return Promise.resolve(value)
  }) as LocateAsk & { calls: number; signals: AbortSignal[] }
  ask.calls = 0
  ask.signals = []
  return ask
}

/** An ask that never answers until aborted. */
function hanging(): LocateAsk & { signals: AbortSignal[] } {
  const ask = ((signal: AbortSignal) => {
    ask.signals.push(signal)
    return new Promise<unknown>((_resolve, reject) => { signal.addEventListener('abort', () => { reject(new Error('aborted')) }) })
  }) as LocateAsk & { signals: AbortSignal[] }
  ask.signals = []
  return ask
}

const settle = async (): Promise<void> => { for (let i = 0; i < 4; i += 1) await Promise.resolve() }

/** Send's wait, unbounded here: what matters is which answer it is handed. */
const passThrough = (answer: Promise<unknown>): Promise<unknown> => answer

describe('what counts as an answer to keep', () => {
  it('a whole answer is final; an incomplete one or none is not', () => {
    expect(isFinalLocate(RESOLVED)).toBe(true)
    expect(isFinalLocate({ status: 'unknown', levels: [] })).toBe(true)
    expect(isFinalLocate(PARTIAL)).toBe(false)
    expect(isFinalLocate(null)).toBe(false)
    expect(isFinalLocate('resolved')).toBe(false)
  })
})

describe('the pick lookup', () => {
  it('Send uses the pick\'s own answer, and asks nothing more, when it is final', async () => {
    const lookups = createPickLookup(passThrough)
    lookups.start(1, asking(RESOLVED))
    await settle()
    const again = asking(PARTIAL)
    expect(await lookups.forSend(1, again)).toEqual(RESOLVED)
    expect(again.calls).toBe(0)
  })

  it('Send waits for an answer still coming instead of asking a second time', async () => {
    const lookups = createPickLookup(passThrough)
    let answer: (value: unknown) => void = () => {}
    lookups.start(1, () => new Promise((resolve) => { answer = resolve }))
    const again = asking(PARTIAL)
    const sent = lookups.forSend(1, again)
    answer(RESOLVED)
    expect(await sent).toEqual(RESOLVED)
    expect(again.calls).toBe(0)
  })

  it('an incomplete answer is asked again at Send, and the fresh one is used', async () => {
    const lookups = createPickLookup(passThrough)
    lookups.start(1, asking(PARTIAL))
    await settle()
    const again = asking(RESOLVED)
    expect(await lookups.forSend(1, again)).toEqual(RESOLVED)
    expect(again.calls).toBe(1)
  })

  it('no answer (refused, failed or timed out) is asked again too', async () => {
    const lookups = createPickLookup(passThrough)
    lookups.start(1, asking(null))
    await settle()
    const again = asking(RESOLVED)
    expect(await lookups.forSend(1, again)).toEqual(RESOLVED)
    expect(again.calls).toBe(1)
  })

  it('when the second ask gives nothing in time, the incomplete answer is the fallback', async () => {
    const lookups = createPickLookup(() => Promise.resolve(null))
    lookups.start(1, asking(PARTIAL))
    await settle()
    expect(await lookups.forSend(1, asking(RESOLVED))).toEqual(PARTIAL)
  })

  it('another pick never gets this pick\'s answer: it is asked for itself', async () => {
    const lookups = createPickLookup(passThrough)
    lookups.start(1, asking(RESOLVED))
    await settle()
    const own = asking({ status: 'resolved', levels: [{ kind: 'record', id: '7', label: 'Page "About"' }] })
    const answer = await lookups.forSend(2, own)
    expect(own.calls).toBe(1)
    expect(answer).not.toEqual(RESOLVED)
  })

  it('a new pick aborts the lookup before it: one in flight at a time', () => {
    const lookups = createPickLookup(passThrough)
    const first = hanging()
    lookups.start(1, first)
    lookups.start(2, hanging())
    expect(first.signals[0]!.aborted).toBe(true)
    expect(lookups.heldFor).toBe(2)
  })

  it('drop aborts what is held and forgets it', async () => {
    const lookups = createPickLookup(passThrough)
    const ask = hanging()
    lookups.start(1, ask)
    lookups.drop()
    expect(ask.signals[0]!.aborted).toBe(true)
    expect(lookups.heldFor).toBeNull()
    const again = asking(RESOLVED)
    expect(await lookups.forSend(1, again)).toEqual(RESOLVED)
    expect(again.calls).toBe(1)
  })
})
