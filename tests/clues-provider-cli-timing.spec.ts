/** Source + real provider gate: slow shared dependency discovery must not bunch process starts. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runGithubCli } from '../src/clues/sources/github/gh.ts'
import { disposeClueProviderRequests } from '../src/clues/request-gate.ts'
import type { ClueRuntime, CliResult } from '../src/clues/runtime/types.ts'

afterEach(() => { disposeClueProviderRequests(); vi.useRealTimers() })
describe('provider execution after dependency preparation', () => {
  it('spaces actual execution closures even when concurrent dependency preparation resolves together', async () => {
    vi.useFakeTimers()
    let resolved!: () => void
    const discovered = new Promise<void>(resolve => { resolved = resolve })
    const starts: number[] = []
    const runtime = { prepareCli: async () => {
      await discovered
      return async () => {
        starts.push(Date.now())
        return { exitCode: 0, stdout: '{}', stderr: '', stdoutTruncated: false, stderrTruncated: false } as CliResult
      }
    }, runCli: () => { throw new Error('the unresolved invocation must not enter the gate') } } as unknown as ClueRuntime
    const first = runGithubCli(runtime, ['api', 'user'], { cwd: '/fixture', timeoutMs: 3000, maxOutputBytes: 1000 })
    const second = runGithubCli(runtime, ['api', 'user'], { cwd: '/fixture', timeoutMs: 3000, maxOutputBytes: 1000 })
    await vi.advanceTimersByTimeAsync(650)
    expect(starts).toEqual([])
    resolved()
    await vi.advanceTimersByTimeAsync(0)
    expect(starts).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(499)
    expect(starts).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(starts).toHaveLength(2)
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(500)
    await Promise.all([first, second])
  })
})
