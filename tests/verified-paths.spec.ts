/**
 * The verified-path cache: a bounded workspace index scan seeds verified
 * entries; index misses fall back to a rare per-path probe (deduped in
 * flight, negative results TTL-cached); `check()` stays synchronous so the
 * MarkdownText resolver can gate mentions on it.
 */
import { describe, expect, it, vi } from 'vitest'
import { createPathVerifier, type PathVerifierDeps } from '../src/client/verified-paths.ts'

function setup(overrides: Partial<PathVerifierDeps> = {}) {
  const scope = () => ({ sessionId: 's1', cwd: '/w' })
  const fetchIndex = vi.fn(async () => ['/w/src/a.ts', '/w/src/b.ts'])
  const probe = vi.fn(async (_scope: unknown, absolute: string) => absolute === '/w/src/live.ts')
  const deps: PathVerifierDeps = {
    scope,
    resolveAbsolute: (path: string) => path.startsWith('/') ? path : `/w/${path}`,
    fetchIndex,
    probe,
    ...overrides,
  }
  return { verifier: createPathVerifier(deps), fetchIndex, probe, deps }
}

describe('createPathVerifier', () => {
  it('seeds verified paths from the workspace index scan on first check', async () => {
    const { verifier, fetchIndex } = setup()
    // First check triggers the scan; indexed paths resolve synchronously
    // once the scan has landed.
    expect(verifier.check('src/a.ts')).toBe(false)
    await Promise.resolve()
    expect(fetchIndex).toHaveBeenCalledTimes(1)
    expect(verifier.check('src/a.ts')).toBe(true)
  })

  it('scans the workspace once per cwd (warm is idempotent)', async () => {
    const { verifier, fetchIndex } = setup()
    verifier.warm()
    verifier.warm()
    await Promise.resolve()
    expect(fetchIndex).toHaveBeenCalledTimes(1)
  })

  it('falls back to a probe for index misses, caching the result', async () => {
    const { verifier, probe } = setup()
    expect(verifier.check('src/live.ts')).toBe(false)  // not indexed → probe fires
    await Promise.resolve()
    expect(probe).toHaveBeenCalledWith(expect.anything(), '/w/src/live.ts')
    expect(verifier.check('src/live.ts')).toBe(true)   // probe confirmed
  })

  it('negative probe results are cached with a TTL (no re-probe storm)', async () => {
    const { verifier, probe } = setup()
    expect(verifier.check('src/ghost.ts')).toBe(false)
    await Promise.resolve()
    expect(verifier.check('src/ghost.ts')).toBe(false)
    expect(probe).toHaveBeenCalledTimes(1)  // the second check did NOT re-probe
  })

  it('a missing file never verifies even after the probe answers', async () => {
    const { verifier } = setup()
    expect(verifier.check('src/ghost.ts')).toBe(false)
    await Promise.resolve()
    expect(verifier.check('src/ghost.ts')).toBe(false)
  })

  it('an index scan failure degrades to per-path probes (no crash)', async () => {
    const { verifier, probe } = setup({ fetchIndex: vi.fn(async () => { throw new Error('boom') }) })
    expect(verifier.check('src/live.ts')).toBe(false)
    await Promise.resolve()
    await Promise.resolve()
    expect(probe).toHaveBeenCalledWith(expect.anything(), '/w/src/live.ts')
  })

  it('clear resets all state (per-activation hygiene)', async () => {
    const { verifier } = setup()
    verifier.warm()
    await Promise.resolve()
    expect(verifier.check('src/a.ts')).toBe(true)
    verifier.clear()
    expect(verifier.check('src/a.ts')).toBe(false)  // re-scans on next check
  })

  it('has() reads membership without side effects', async () => {
    const { verifier, fetchIndex, probe } = setup()
    verifier.has('src/a.ts')
    expect(fetchIndex).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
  })
})
