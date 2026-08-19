/**
 * Chunk loader tests: the lazy chunk machinery (src/client/chunk-loader.ts).
 * Pins the caching contract that makes the lazy mechanism correct:
 * - one in-flight promise per chunk (concurrent opens share it),
 * - a failed load clears the cache so the next call retries (the script
 *   re-executes and overwrites its global registry slot — assignments are
 *   idempotent, no duplicate-registration class of errors),
 * - externals resolve through the module system's seed branch (the stable,
 *   version-independent part), once per page,
 * - resetChunks drops the cache and the externals memo (HMR).
 * The production path runs against a fake `window.__DSH_MODULES__` and a
 * stub script loader that simulates the executed chunk script by assigning
 * the plugin-owned global factory registry.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import './browser-globals.ts'
import {
  CHUNK_EXTERNALS,
  loadChunk,
  registerChunkForTests,
  revalidateChunksOnReactivate,
  resetChunks,
  setChunkModuleSystem,
  setChunkScriptLoaderForTests,
} from '../src/client/chunk-loader.ts'
import type { ChunkExports } from '../src/client/chunk-loader.ts'

interface FakeModuleSystem {
  import: (specifier: string) => Promise<unknown>
}

function installModuleSystem(): FakeModuleSystem {
  const fake: FakeModuleSystem = {
    import: vi.fn(async (specifier: string) => ({ seed: specifier })),
  }
  ;(globalThis as Record<string, unknown>).__DSH_MODULES__ = fake
  return fake
}

function removeModuleSystem(): void {
  delete (globalThis as Record<string, unknown>).__DSH_MODULES__
}

/** The global registry the chunk scripts populate (mirror of chunk-loader). */
function registry(): Record<string, unknown> {
  return (globalThis as { __dshChunks__?: Record<string, unknown> }).__dshChunks__ ?? {}
}

/** Simulate a chunk script executing: it assigns its factory to the registry. */
function simulateScript(name: string, factory: (require: (spec: string) => unknown) => ChunkExports): void {
  const g = globalThis as { __dshChunks__?: Record<string, unknown> }
  g.__dshChunks__ = g.__dshChunks__ ?? {}
  g.__dshChunks__[name] = factory
}

beforeEach(() => {
  removeModuleSystem()
  setChunkModuleSystem(undefined)
  delete (globalThis as Record<string, unknown>).__dshChunks__
  resetChunks()
  setChunkScriptLoaderForTests(null)
})

describe('test-registry path (vitest / jsdom-less environments)', () => {
  it('returns the registered chunk exports, loading once even for concurrent callers', async () => {
    let calls = 0
    registerChunkForTests('editor', async () => {
      calls += 1
      return { TextEditor: 'text-editor' }
    })
    const [a, b, c] = await Promise.all([loadChunk('editor'), loadChunk('editor'), loadChunk('editor')])
    expect(a).toEqual({ TextEditor: 'text-editor' })
    expect(b).toBe(a)
    expect(c).toBe(a)
    expect(calls).toBe(1)
    // Memoized after resolution too.
    expect(await loadChunk('editor')).toBe(a)
    expect(calls).toBe(1)
  })

  it('a failed load clears the cache so the next call retries', async () => {
    let calls = 0
    registerChunkForTests('terminal', async () => {
      calls += 1
      if (calls === 1) throw new Error('boom')
      return { TerminalView: 'terminal-view' }
    })
    await expect(loadChunk('terminal')).rejects.toThrow('boom')
    await expect(loadChunk('terminal')).resolves.toEqual({ TerminalView: 'terminal-view' })
    expect(calls).toBe(2)
  })
})

describe('production path (script injection + global registry + externals require)', () => {
  it('resolves externals through an injected ctx.modules system (rc.8 — no page global)', async () => {
    const modules = installModuleSystem()
    // rc.8 drops window.__DSH_MODULES__; the client half injects ctx.modules.
    removeModuleSystem()
    setChunkModuleSystem(modules)
    const loaded: string[] = []
    setChunkScriptLoaderForTests(async (src) => {
      loaded.push(src)
      simulateScript('editor', (require) => ({ TextEditor: `view:${String(require('react'))}` }))
    })
    const exports = await loadChunk('editor')
    expect(loaded).toEqual(['/sidebar/bundle/editor.js'])
    expect(exports).toEqual({ TextEditor: 'view:[object Object]' })
    expect(modules.import).toHaveBeenCalledTimes(CHUNK_EXTERNALS.length)
    // The injection also lands on a plugin-owned global so chunk-bundle
    // copies of this loader (which inline their own module instance and
    // never run apply()) can resolve externals too — rc.8 has no shell
    // page global anymore.
    expect((globalThis as Record<string, unknown>).__dshSidebarModuleSystem__).toBe(modules)
    // The injection survives resetChunks (shell state, not chunk state).
    resetChunks()
    setChunkScriptLoaderForTests(async () => {
      simulateScript('editor', () => ({ TextEditor: 'editor-view' }))
    })
    await loadChunk('editor')
    expect(modules.import).toHaveBeenCalledTimes(CHUNK_EXTERNALS.length * 2)
  })

  it('injects the chunk script, then materializes the factory with externals from the module table', async () => {
    const modules = installModuleSystem()
    const loaded: string[] = []
    setChunkScriptLoaderForTests(async (src) => {
      loaded.push(src)
      simulateScript('editor', (require) => ({ TextEditor: `view:${String(require('react'))}` }))
    })
    const exports = await loadChunk('editor')
    expect(loaded).toEqual(['/sidebar/bundle/editor.js'])
    expect(exports).toEqual({ TextEditor: 'view:[object Object]' })
    // Externals resolved through the module system's seed branch, once.
    expect(modules.import).toHaveBeenCalledTimes(CHUNK_EXTERNALS.length)
    // Memoized: no second script injection, no second externals resolution.
    await loadChunk('editor')
    expect(loaded).toHaveLength(1)
    expect(modules.import).toHaveBeenCalledTimes(CHUNK_EXTERNALS.length)
  })

  it('resolves the externals table once across chunks', async () => {
    const modules = installModuleSystem()
    const seen: string[] = []
    setChunkScriptLoaderForTests(async (src) => {
      seen.push(src)
      simulateScript(src.endsWith('editor.js') ? 'editor' : 'terminal', () => ({}))
    })
    await loadChunk('terminal')
    await loadChunk('editor')
    expect(seen).toEqual(['/sidebar/bundle/terminal.js', '/sidebar/bundle/editor.js'])
    expect(modules.import).toHaveBeenCalledTimes(CHUNK_EXTERNALS.length)
  })

  it('a chunk requiring an unresolvable externals spec fails loudly', async () => {
    installModuleSystem()
    setChunkScriptLoaderForTests(async () => {
      simulateScript('editor', (require) => { require('not-in-the-table'); return {} })
    })
    await expect(loadChunk('editor')).rejects.toThrow('missed the module table')
  })

  it('a script load failure rejects without materializing', async () => {
    const modules = installModuleSystem()
    setChunkScriptLoaderForTests(async () => { throw new Error('script 404') })
    await expect(loadChunk('terminal')).rejects.toThrow('script 404')
    expect(modules.import).not.toHaveBeenCalled()
    // Cache cleared: the retry re-attempts the script load.
    setChunkScriptLoaderForTests(async () => { simulateScript('terminal', () => ({ TerminalView: 'ok' })) })
    await expect(loadChunk('terminal')).resolves.toEqual({ TerminalView: 'ok' })
  })

  it('a script that ran but registered no factory fails with a clear error', async () => {
    installModuleSystem()
    setChunkScriptLoaderForTests(async () => { /* executes but assigns nothing */ })
    await expect(loadChunk('editor')).rejects.toThrow('did not register its factory')
  })

  it('a materialization failure clears the cache; the retry re-executes cleanly (idempotent slot assignment)', async () => {
    const modules = installModuleSystem()
    let calls = 0
    setChunkScriptLoaderForTests(async () => {
      calls += 1
      simulateScript('editor', () => {
        if (calls === 1) throw new Error('materialize boom')
        return { TextEditor: 'text-editor' }
      })
    })
    await expect(loadChunk('editor')).rejects.toThrow('materialize boom')
    // Retry: script re-injected, slot overwritten, materialization succeeds.
    await expect(loadChunk('editor')).resolves.toEqual({ TextEditor: 'text-editor' })
    expect(calls).toBe(2)
    expect(modules.import).toHaveBeenCalled()
  })

  it('fails loudly when no module system is installed (before touching the network)', async () => {
    const loaded: string[] = []
    setChunkScriptLoaderForTests(async (src) => { loaded.push(src) })
    await expect(loadChunk('editor')).rejects.toThrow('client module system unavailable')
    expect(loaded).toEqual([])
  })

  it('resetChunks drops the cache and the externals memo (HMR re-activation)', async () => {
    const modules = installModuleSystem()
    let calls = 0
    setChunkScriptLoaderForTests(async () => {
      calls += 1
      simulateScript('editor', () => ({ TextEditor: 'editor-view' }))
    })
    await loadChunk('editor')
    expect(calls).toBe(1)
    expect(modules.import).toHaveBeenCalledTimes(CHUNK_EXTERNALS.length)
    resetChunks()
    // Cache dropped: the next open re-fetches and re-executes; the externals
    // memo is rebuilt (fresh module-table resolution).
    await loadChunk('editor')
    expect(calls).toBe(2)
    expect(modules.import).toHaveBeenCalledTimes(CHUNK_EXTERNALS.length * 2)
  })

  it('resetChunks is a safe no-op without a module system', () => {
    resetChunks()
    expect(() => resetChunks()).not.toThrow()
  })
})

describe('revalidateChunksOnReactivate (HMR re-activation keeps unchanged chunks)', () => {
  /** Stub the bundle route's HEAD endpoint with per-name ETags (Error = unreachable). */
  function stubBundleHead(etagFor: (name: string) => string | null | Error): void {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input)
      const name = url.endsWith('terminal.js') ? 'terminal' : 'editor'
      const etag = etagFor(name)
      if (etag instanceof Error) throw etag
      return {
        headers: { get: (key: string) => (key.toLowerCase() === 'etag' ? etag : null) },
      } as unknown as Response
    }))
  }

  /** Let the fire-and-forget ETag recorder (recordEtag) settle. */
  const settleEtag = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

  it('keeps the resolved exports of an unchanged chunk — no re-inject / re-execute', async () => {
    installModuleSystem()
    let scriptCalls = 0
    setChunkScriptLoaderForTests(async () => {
      scriptCalls += 1
      simulateScript('editor', () => ({ TextEditor: 'editor-view' }))
    })
    stubBundleHead(() => '"v1"')
    const first = await loadChunk('editor')
    expect(scriptCalls).toBe(1)
    await settleEtag()
    await revalidateChunksOnReactivate()
    const second = await loadChunk('editor')
    expect(second).toBe(first)
    expect(scriptCalls).toBe(1)
  })

  it('drops a chunk whose ETag changed on disk — the next open re-injects and re-executes', async () => {
    installModuleSystem()
    let scriptCalls = 0
    setChunkScriptLoaderForTests(async () => {
      scriptCalls += 1
      simulateScript('editor', () => ({ TextEditor: `editor-view:${scriptCalls}` }))
    })
    let etag = '"v1"'
    stubBundleHead(() => etag)
    const first = await loadChunk('editor')
    await settleEtag()
    etag = '"v2"'
    await revalidateChunksOnReactivate()
    const second = await loadChunk('editor')
    expect(second).not.toBe(first)
    expect(scriptCalls).toBe(2)
  })

  it('fails open when revalidation cannot reach the bundle route', async () => {
    installModuleSystem()
    let scriptCalls = 0
    setChunkScriptLoaderForTests(async () => {
      scriptCalls += 1
      simulateScript('terminal', () => ({ TerminalView: 'tv' }))
    })
    stubBundleHead(() => new Error('HEAD unreachable'))
    await loadChunk('terminal')
    await settleEtag()
    await revalidateChunksOnReactivate()
    await loadChunk('terminal')
    expect(scriptCalls).toBe(2)
  })

  it('loadChunk is a barrier: a pending revalidation never serves stale exports (CR P1)', async () => {
    installModuleSystem()
    let scriptCalls = 0
    setChunkScriptLoaderForTests(async () => {
      scriptCalls += 1
      simulateScript('editor', () => ({ TextEditor: `editor-view:${scriptCalls}` }))
    })
    // First load: etag "v1", recorded after settlement.
    let etag = '"v1"'
    stubBundleHead(() => etag)
    const first = await loadChunk('editor')
    await settleEtag()
    expect(scriptCalls).toBe(1)
    // The chunk changed on disk; the revalidation HEAD is gated (pending).
    etag = '"v2"'
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.stubGlobal('fetch', vi.fn(async () => {
      await gate
      return { headers: { get: () => etag } } as unknown as Response
    }))
    const revalidating = revalidateChunksOnReactivate()
    // A lazy open DURING the pending revalidation must NOT get the old cache.
    let resolved = false
    let pendingLoad: Promise<ChunkExports> | null = null
    pendingLoad = loadChunk('editor').then((exports) => { resolved = true; return exports })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(resolved, 'loadChunk must await the pending revalidation').toBe(false)
    // Release the HEAD; the barrier lifts and the load re-injects fresh exports.
    release?.()
    await revalidating
    const after = await pendingLoad
    expect(after).not.toBe(first)
    expect(scriptCalls).toBe(2)
  })

  it('a HEAD that never answers is bounded by a timeout signal and fails open (barrier cannot wedge loads forever)', async () => {
    installModuleSystem()
    let scriptCalls = 0
    setChunkScriptLoaderForTests(async () => {
      scriptCalls += 1
      simulateScript('editor', () => ({ TextEditor: `editor-view:${scriptCalls}` }))
    })
    // First load settles an ETag under a healthy HEAD route.
    stubBundleHead(() => '"v1"')
    const first = await loadChunk('editor')
    await settleEtag()
    expect(scriptCalls).toBe(1)
    // The revalidation HEAD now hangs. The loader must hand the fetch a
    // timeout signal and, when it fires, fail open (drop + re-fetch) — the
    // barrier must never block lazy loads indefinitely.
    const controller = new AbortController()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    vi.stubGlobal('fetch', vi.fn(async (_input, init?: RequestInit) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')))
      })
    }))
    const revalidating = revalidateChunksOnReactivate()
    let resolved = false
    const pendingLoad = loadChunk('editor').then((exports) => { resolved = true; return exports })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(resolved, 'loadChunk must await the pending revalidation').toBe(false)
    controller.abort() // the timeout fires
    await revalidating
    const after = await pendingLoad
    expect(after).not.toBe(first)
    expect(scriptCalls).toBe(2)
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Number))
    timeoutSpy.mockRestore()
  })

  it('resetChunks clears a pending revalidation barrier (the next load does not wait on the orphaned task)', async () => {
    installModuleSystem()
    let scriptCalls = 0
    setChunkScriptLoaderForTests(async () => {
      scriptCalls += 1
      simulateScript('editor', () => ({ TextEditor: `editor-view:${scriptCalls}` }))
    })
    let etag = '"v1"'
    stubBundleHead(() => etag)
    await loadChunk('editor')
    await settleEtag()
    // Gate the revalidation HEAD so the barrier stays pending.
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.stubGlobal('fetch', vi.fn(async () => {
      await gate
      return { headers: { get: () => etag } } as unknown as Response
    }))
    const revalidating = revalidateChunksOnReactivate()
    // resetChunks mid-revalidation: the barrier guarded only the state being
    // dropped, so the next load must proceed without waiting for the HEAD.
    resetChunks()
    const after = await loadChunk('editor')
    expect(after).toEqual({ TextEditor: 'editor-view:2' })
    expect(scriptCalls).toBe(2)
    // The orphaned task still settles; its identity-guarded finally no-ops.
    // (Its sweep may later drop the freshly loaded entry — chunkEtags was
    // cleared by resetChunks, so the old ETag no longer matches. That is the
    // fail-safe direction: never serve stale, at worst one redundant fetch.)
    release?.()
    await revalidating
  })

  it('clears test-registry fixtures on re-activation (per-test stubs never leak)', async () => {
    let testCalls = 0
    registerChunkForTests('editor', async () => { testCalls += 1; return { TextEditor: 'test-view' } })
    await loadChunk('editor')
    expect(testCalls).toBe(1)
    await revalidateChunksOnReactivate()
    // Test fixture gone: the production path runs and fails fast (no module system).
    await expect(loadChunk('editor')).rejects.toThrow('client module system unavailable')
    expect(testCalls).toBe(1)
  })
})

describe('externals contract', () => {
  it('the loader resolves exactly the platform externals the chunk builds keep external', () => {
    expect(CHUNK_EXTERNALS).toEqual([
      'react',
      'react/jsx-runtime',
      'react-dom',
      'react-dom/client',
      'cordis',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-runtime/client',
    ])
  })
})
