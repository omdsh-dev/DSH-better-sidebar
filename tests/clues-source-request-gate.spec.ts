/** Public transport seam: exactly one provider admission per real CLI request. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
const admission = vi.hoisted(() => ({ run: vi.fn(async (_key: string, run: () => Promise<unknown>, _signal?: AbortSignal) => await run()) }))
vi.mock('../src/clues/request-gate.ts', () => ({ runClueProviderRequest: admission.run }))
const runClueProviderRequest = admission.run
import { runGithubCli } from '../src/clues/sources/github/gh.ts'
import { runLark } from '../src/clues/sources/feishu/lark.ts'
import { runFeishuCommand } from '../src/clues/sources/feishu/auth.ts'
import { FakeLarkRuntime, okResult, cliResult, failResult } from './clues-feishu-fixture.ts'
import { GITHUB_CONNECTION_ID } from '../src/clues/sources/github/ids.ts'
import { FEISHU_CONNECTION_ID } from '../src/clues/sources/feishu/format.ts'
import type { CliRunRequest, ClueRuntime } from '../src/clues/runtime/types.ts'
beforeEach(() => { runClueProviderRequest.mockClear() })
describe('CLI provider request admission', () => {
  it.each(['github', 'feishu'] as const)('finishes %s request preparation before exactly one provider admission and runs only the prepared closure', async provider => {
    let release!: () => void
    const ready = new Promise<void>(resolve => { release = resolve })
    const executed: CliRunRequest[] = []
    const direct = vi.fn(async () => cliResult())
    const prepare = vi.fn(async (request: CliRunRequest) => {
      await ready
      return async () => { executed.push(request); return provider === 'github' ? cliResult() : okResult({}) }
    })
    const runtime = { prepareCli: prepare, runCli: direct } as unknown as ClueRuntime
    const signal = new AbortController().signal
    const promise = provider === 'github'
      ? runGithubCli(runtime, ['api', 'graphql'], { cwd: '/tmp', timeoutMs: 1234, maxOutputBytes: 5678, stdin: 'body', signal })
      : runLark({ runtime, args: ['drive', 'files', 'list'], cwd: '/tmp', timeoutMs: 1234, maxOutputBytes: 5678, stdin: 'body', signal })
    void promise.catch(() => undefined)
    await Promise.resolve()
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(runClueProviderRequest).not.toHaveBeenCalled()
    expect(direct).not.toHaveBeenCalled()
    release()
    await promise
    expect(runClueProviderRequest).toHaveBeenCalledTimes(1)
    expect(executed).toHaveLength(1)
    expect(executed[0]).toMatchObject({ cwd: '/tmp', timeoutMs: 1234, maxOutputBytes: 5678, stdin: 'body', signal })
    expect(direct).not.toHaveBeenCalled()
  })

  it.each(['github', 'feishu'] as const)('keeps actual %s gate execution starts 500ms apart after a shared slow preparation', async provider => {
    const { createClueProviderGate } = await vi.importActual<typeof import('../src/clues/request-gate.ts')>('../src/clues/request-gate.ts')
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const gate = createClueProviderGate()
    runClueProviderRequest.mockImplementation((key, run, signal) => gate.run(key, run, signal))
    let release!: () => void
    const ready = new Promise<void>(resolve => { release = resolve })
    const starts: number[] = []
    const runtime = {
      prepareCli: async () => { await ready; return async () => { starts.push(Date.now()); return provider === 'github' ? cliResult() : okResult({}) } },
      runCli: async () => { throw new Error('source must execute its prepared closure') },
    } as unknown as ClueRuntime
    const run = () => provider === 'github'
      ? runGithubCli(runtime, ['api', 'graphql'], { cwd: '/tmp', timeoutMs: 1000, maxOutputBytes: 1000 })
      : runLark({ runtime, args: ['drive', 'files', 'list'], cwd: '/tmp' })
    const pending = Promise.all([run(), run()])
    void pending.catch(() => undefined)
    try {
      await vi.advanceTimersByTimeAsync(900)
      expect(starts).toEqual([])
      expect(runClueProviderRequest).not.toHaveBeenCalled()
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(starts).toEqual([900])
      await vi.advanceTimersByTimeAsync(499)
      expect(starts).toEqual([900])
      await vi.advanceTimersByTimeAsync(1)
      await pending
      expect(starts).toEqual([900, 1400])
      expect(runClueProviderRequest).toHaveBeenCalledTimes(2)
    } finally {
      release()
      gate.dispose()
      await Promise.allSettled([pending])
      runClueProviderRequest.mockImplementation(async (_key, execute) => await execute())
      vi.useRealTimers()
    }
  })

  it('admits GitHub transport once with the shared connection key and abort signal', async () => {
    const runtime = new FakeLarkRuntime().enqueue(cliResult())
    const signal = new AbortController().signal
    await runGithubCli(runtime.asRuntime(), ['auth', 'status'], { cwd: '/tmp', timeoutMs: 1000, maxOutputBytes: 1000, signal })
    expect(runClueProviderRequest).toHaveBeenCalledTimes(1)
    expect(runClueProviderRequest.mock.calls[0]?.[0]).toBe(GITHUB_CONNECTION_ID)
    expect(runClueProviderRequest.mock.calls[0]?.[2]).toBe(signal)
    expect(runtime.requests).toHaveLength(1)
  })
  it('admits resource and optional contact commands exactly once each on the same Feishu key', async () => {
    const runtime = new FakeLarkRuntime().enqueue(okResult({}), okResult({}))
    await runFeishuCommand(runtime.asRuntime(), { args: ['drive', 'files', 'list'], cwd: '/tmp' })
    await runLark({ runtime: runtime.asRuntime(), args: ['contact', 'users', 'batch'], cwd: '/tmp' })
    expect(runClueProviderRequest.mock.calls.map(call => call[0])).toEqual([FEISHU_CONNECTION_ID, FEISHU_CONNECTION_ID])
    expect(runtime.requests).toHaveLength(2)
  })
  it('surfaces classified rate limits inside the gate callback for scheduler cooldown', async () => {
    const runtime = new FakeLarkRuntime().enqueue(failResult({ type: 'rate_limit', subtype: 'too_many_requests' }))
    await expect(runLark({ runtime: runtime.asRuntime(), args: ['drive', 'files', 'list'], cwd: '/tmp' })).rejects.toMatchObject({ category: 'rate-limited' })
    expect(runClueProviderRequest).toHaveBeenCalledTimes(1)
    expect(runClueProviderRequest.mock.results[0]?.type).toBe('return')
    await expect(runClueProviderRequest.mock.results[0]?.value).rejects.toMatchObject({ category: 'rate-limited' })
  })
})
