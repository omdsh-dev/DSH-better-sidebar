/**
 * search-engines: the native-engine probe and runner behind fs.search.
 * The probe is process-cached (verified binaries only); a runtime failure
 * disables one engine without disturbing the others. `normalizeEnginePaths`
 * re-bases raw stdout lines onto the walk contract (root-relative,
 * '/'-separated, no './' prefix). Child processes are exercised entirely
 * through injected hooks — CI machines have no fd/rg, and the probe/runner
 * contracts are what the dispatch depends on.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { sep } from 'node:path'
import {
  escapeGlob,
  normalizeEnginePaths,
  probeEngines,
  resetEngines,
  runEngine,
  setEngineHooks,
  usableEngines,
} from '../src/search-engines.ts'
import type { EngineProbe } from '../src/search-engines.ts'

const fdProbe: EngineProbe = { engine: 'fd', binary: '/fake/fd' }
const rgProbe: EngineProbe = { engine: 'rg', binary: '/fake/rg' }

describe('normalizeEnginePaths', () => {
  it('keeps root-relative /-separated lines as-is (fd contract)', () => {
    expect(normalizeEnginePaths(['src/util.ts', 'README.md'])).toEqual([
      'src/util.ts',
      'README.md',
    ])
  })

  it('strips a leading ./ from engine output', () => {
    expect(normalizeEnginePaths(['./src/a.ts', './b.ts'])).toEqual([
      'src/a.ts',
      'b.ts',
    ])
  })

  it('drops empty lines and the bare root', () => {
    expect(normalizeEnginePaths(['', '.', 'src/x.ts'])).toEqual(['src/x.ts'])
  })
})

describe('escapeGlob', () => {
  it('escapes glob metacharacters for rg -g literal matching', () => {
    expect(escapeGlob('a*b?c[d]')).toBe('a\\*b\\?c\\[d\\]')
  })
})

describe('probe cache and broken-disable', () => {
  afterEach(() => {
    resetEngines()
  })

  it('caches the probe result across calls', async () => {
    let calls = 0
    setEngineHooks({ prober: async () => { calls += 1; return [fdProbe] } })
    expect(await probeEngines()).toBe(await probeEngines())
    expect(calls).toBe(1)
  })

  it('usableEngines hides engines broken at runtime', async () => {
    setEngineHooks({ prober: async () => [fdProbe, rgProbe] })
    await runEngine(fdProbe, '/w', 'x', 10, undefined).catch(() => {
      /* the failing runner below */
    })
    setEngineHooks({
      runner: async () => { throw new Error('boom') },
    })
    await runEngine(fdProbe, '/w', 'x', 10, undefined).catch(() => {
      /* expected failure */
    })
    const usable = await usableEngines()
    expect(usable.map(probe => probe.engine)).toEqual(['rg'])
  })

  it('an aborted run does not disable the engine', async () => {
    setEngineHooks({ prober: async () => [fdProbe] })
    setEngineHooks({
      runner: async () => { throw new Error('search aborted') },
    })
    const controller = new AbortController()
    controller.abort()
    await runEngine(fdProbe, '/w', 'x', 10, controller.signal).catch(() => {
      /* expected failure */
    })
    expect((await usableEngines()).map(probe => probe.engine)).toEqual(['fd'])
  })
})