/** Provider requests share one bounded queue and rate-limit cooldown; no retry of writes. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClueProviderGate } from '../src/clues/request-gate.ts'
import { ClueError } from '../src/clues/error.ts'
afterEach(() => vi.useRealTimers())
describe('provider request gate', () => {
  it('spaces starts and never exceeds two in-flight calls for a shared connection', async () => {
    vi.useFakeTimers()
    const gate = createClueProviderGate()
    const starts: number[] = []
    const releases: (() => void)[] = []
    const run = () => { starts.push(Date.now()); return new Promise<void>(resolve => releases.push(resolve)) }
    const a = gate.run('feishu', run), b = gate.run('feishu', run), c = gate.run('feishu', run)
    await vi.advanceTimersByTimeAsync(499)
    expect(starts).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(501)
    expect(starts).toHaveLength(2)
    releases[0]!()
    await vi.advanceTimersByTimeAsync(0)
    expect(starts).toHaveLength(3)
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(500)
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(500)
    releases[1]!(); releases[2]!()
    await Promise.all([a, b, c]); gate.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('removes cancelled queued work before it reaches the provider', async () => {
    vi.useFakeTimers()
    const gate = createClueProviderGate()
    await gate.run('github', async () => 1)
    const controller = new AbortController()
    const run = vi.fn(async () => 2)
    const pending = gate.run('github', run, controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ category: 'cancelled' })
    controller.abort(); await rejected
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).not.toHaveBeenCalled(); gate.dispose()
  })
  it('cools down the connection without automatically retrying any write', async () => {
    vi.useFakeTimers()
    const gate = createClueProviderGate()
    const write = vi.fn(async () => { throw new ClueError('rate-limited', 'limit') })
    await expect(gate.run('feishu', write)).rejects.toMatchObject({ category: 'rate-limited' })
    await expect(gate.run('feishu', write)).rejects.toMatchObject({ category: 'rate-limited' })
    expect(write).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await gate.run('feishu', async () => 'ok')).toBe('ok'); gate.dispose()
  })
  it('bounds queued requests and connection cardinality', async () => {
    const gate = createClueProviderGate({ maxQueue: 1, maxConnections: 1, concurrency: 1 })
    let release!: () => void
    const first = gate.run('one', () => new Promise<void>(resolve => { release = resolve }))
    await Promise.resolve()
    const queued = gate.run('one', async () => 2)
    const rejection = expect(queued).rejects.toMatchObject({ category: 'cancelled' })
    await expect(gate.run('one', async () => 3)).rejects.toMatchObject({ category: 'rate-limited' })
    await expect(gate.run('two', async () => 4)).rejects.toMatchObject({ category: 'rate-limited' })
    gate.dispose(); await rejection; release(); await first
  })
})
