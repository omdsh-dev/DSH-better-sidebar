import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cachedClueRequest, invalidateClueRequests, peekClueRequest } from '../src/client/clues/request-cache.ts'
import { cluesApi, subscribeClueDataChanges, invalidateClueRead, peekClueRead } from '../src/client/clues/api.ts'
import { call } from '../src/client/api.ts'
vi.mock('../src/client/api.ts', () => ({ call: vi.fn() }))
const wire = vi.mocked(call)
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => { invalidateClueRequests(); wire.mockReset() })
afterEach(() => { invalidateClueRequests(); vi.useRealTimers(); vi.restoreAllMocks() })
const read = <T = string>(workspace: string, load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, key = 'page') =>
  cachedClueRequest<T>('clues.list', workspace, { key }, load, signal)

describe('one bounded clue read cache', () => {
  it('invalidates all body offsets and discussion-control variants for one resource only', async () => {
    const variants = [{ clueId: 'changed', includeDiscussion: false, sessionId: 'one' }, { clueId: 'changed', offset: 100, sessionId: 'two' }]
    for (const input of variants) await cachedClueRequest('clues.read', 'w', { workspaceId: 'w', ...input }, async () => 'old body')
    await cachedClueRequest('clues.read', 'w', { workspaceId: 'w', clueId: 'unrelated' }, async () => 'other body')
    invalidateClueRead('w', { clueId: 'changed' })
    for (const input of variants) expect(peekClueRead('w', input)).toBeUndefined()
    expect(peekClueRead('w', { clueId: 'unrelated' })).toBe('other body')
  })
  it('cancels an abandoned old keyword when a new keyword needs the same source', async () => {
    vi.useFakeTimers()
    const pending = deferred<string>()
    const load = vi.fn((_signal: AbortSignal) => pending.promise)
    const controller = new AbortController()
    const old = cachedClueRequest('clues.search', 'w', { sourceId: 'files', query: 'old' }, load, controller.signal)
    await Promise.resolve()
    const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort(); await rejected
    expect(load.mock.calls[0]![0].aborted).toBe(false)
    expect(await cachedClueRequest('clues.search', 'w', { sourceId: 'files', query: 'new' }, async () => 'new')).toBe('new')
    expect(load.mock.calls[0]![0].aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    pending.resolve('late old result')
  })
  it('preserves the five-second switch-back grace for the same keyword', async () => {
    vi.useFakeTimers()
    const pending = deferred<string>()
    const load = vi.fn((_signal: AbortSignal) => pending.promise)
    const controller = new AbortController()
    const payload = { sourceId: 'files', query: 'same' }
    const first = cachedClueRequest('clues.search', 'w', payload, load, controller.signal)
    await Promise.resolve()
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort(); await rejected
    await vi.advanceTimersByTimeAsync(4900)
    const second = cachedClueRequest('clues.search', 'w', payload, load)
    expect(load).toHaveBeenCalledTimes(1)
    expect(load.mock.calls[0]![0].aborted).toBe(false)
    pending.resolve('same result')
    expect(await second).toBe('same result')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not cancel another view using an old keyword or an abandoned search from another source or workspace', async () => {
    const pending = deferred<string>()
    const load = vi.fn((_signal: AbortSignal) => pending.promise)
    const active = cachedClueRequest('clues.search', 'w', { sourceId: 'files', query: 'old' }, load)
    await Promise.resolve()
    await cachedClueRequest('clues.search', 'w', { sourceId: 'files', query: 'new' }, async () => 'new')
    expect(load.mock.calls[0]![0].aborted).toBe(false)
    const controllers = [new AbortController(), new AbortController()]
    const otherSource = cachedClueRequest('clues.search', 'w', { sourceId: 'docs', query: 'old' }, load, controllers[0]!.signal)
    const otherWorkspace = cachedClueRequest('clues.search', 'elsewhere', { sourceId: 'files', query: 'old' }, load, controllers[1]!.signal)
    await Promise.resolve()
    const rejected = [expect(otherSource).rejects.toMatchObject({ name: 'AbortError' }), expect(otherWorkspace).rejects.toMatchObject({ name: 'AbortError' })]
    for (const controller of controllers) controller.abort()
    await Promise.all(rejected)
    await cachedClueRequest('clues.search', 'w', { sourceId: 'files', query: 'newer' }, async () => 'newer')
    expect(load.mock.calls.every(([signal]) => !signal.aborted)).toBe(true)
    pending.resolve('active result')
    expect(await active).toBe('active result')
  })
  it('serves a successful read until an explicit refresh or invalidation', async () => {
    vi.useFakeTimers()
    const load = vi.fn(async () => 'result')
    expect(await read('w', load)).toBe('result')
    // No read TTL: reader-visible remote staleness is refreshed explicitly or
    // by a mutation, never silently by a clock.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(await read('w', load)).toBe('result')
    expect(load).toHaveBeenCalledTimes(1)
    expect(await cachedClueRequest('clues.list', 'w', { key: 'page' }, load, undefined, { force: true }))
      .toBe('result')
    expect(load).toHaveBeenCalledTimes(2)
    invalidateClueRequests('w')
    await read('w', load)
    expect(load).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('peeks a completed read synchronously without starting a request', async () => {
    const load = vi.fn(async () => ({ items: [1] }))
    expect(peekClueRequest('clues.list', 'w', { key: 'page' })).toBeUndefined()
    expect(load).not.toHaveBeenCalled()
    expect(await read('w', load)).toEqual({ items: [1] })
    expect(peekClueRequest('clues.list', 'w', { key: 'page' })).toEqual({ items: [1] })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('keeps sessionId in every resource key and stays hot within one session', async () => {
    const pending = deferred<string>()
    const request = cachedClueRequest(
      'clues.read', 'w', { clueId: 'c', offset: 1024, sessionId: 's1' }, () => pending.promise,
    )
    await Promise.resolve()
    expect(peekClueRequest('clues.read', 'w', { clueId: 'c', offset: 1024, sessionId: 's2' }))
      .toBeUndefined()
    pending.resolve('body-s1')
    expect(await request).toBe('body-s1')
    // A public source read carries session-specific approval/route context:
    // another session must not reuse it.
    expect(peekClueRequest('clues.read', 'w', { clueId: 'c', offset: 1024, sessionId: 's2' }))
      .toBeUndefined()
    // The same session (even with a different property order) stays hot.
    expect(peekClueRequest('clues.read', 'w', { sessionId: 's1', offset: 1024, clueId: 'c' }))
      .toBe('body-s1')
    const sameSession = vi.fn(async () => 'unused')
    expect(await cachedClueRequest(
      'clues.read', 'w', { sessionId: 's1', offset: 1024, clueId: 'c' }, sameSession,
    )).toBe('body-s1')
    expect(sameSession).not.toHaveBeenCalled()
    // A different session is an independent read, not a cache hit.
    const otherSession = vi.fn(async () => 'body-s2')
    expect(await cachedClueRequest(
      'clues.read', 'w', { clueId: 'c', offset: 1024, sessionId: 's2' }, otherSession,
    )).toBe('body-s2')
    expect(otherSession).toHaveBeenCalledTimes(1)
    expect(peekClueRequest('clues.read', 'w', { clueId: 'c', offset: 1024, sessionId: 's1' }))
      .toBe('body-s1')
    expect(peekClueRequest('clues.read', 'w', { clueId: 'c', sessionId: 's1' })).toBeUndefined()
    expect(peekClueRequest('clues.read', 'other', { clueId: 'c', offset: 1024, sessionId: 's1' }))
      .toBeUndefined()
  })
  it('isolates workspaces, scopes and page inputs', async () => {
    const load = vi.fn(async () => 'result')
    await read('first', load, undefined, 'repo/a:page1')
    await read('second', load, undefined, 'repo/a:page1')
    await read('first', load, undefined, 'repo/b:page1')
    await read('first', load, undefined, 'repo/a:page2')
    expect(load).toHaveBeenCalledTimes(4)
  })
  it('deduplicates pending reads without letting one view cancel the other', async () => {
    const pending = deferred<string>()
    const load = vi.fn((_signal: AbortSignal) => pending.promise)
    const first = new AbortController()
    const second = new AbortController()
    const one = read('w', load, first.signal)
    const two = read('w', load, second.signal)
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)
    const rejected = expect(one).rejects.toMatchObject({ name: 'AbortError' })
    first.abort()
    await rejected
    expect(load.mock.calls[0]![0].aborted).toBe(false)
    pending.resolve('ok')
    expect(await two).toBe('ok')
  })
  it('aborts abandoned work after five seconds and never caches its late answer', async () => {
    vi.useFakeTimers()
    const pending = deferred<string>()
    const load = vi.fn((_signal: AbortSignal) => pending.promise)
    const controller = new AbortController()
    const request = read('w', load, controller.signal)
    await Promise.resolve()
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort(); await rejected
    expect(load.mock.calls[0]![0].aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(5100)
    expect(load.mock.calls[0]![0].aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    pending.resolve('old')
    await Promise.resolve(); await Promise.resolve()
    expect(await read('w', async () => 'fresh')).toBe('fresh')
  })
  it('reuses a pending wire read at 4.9 seconds and clears the abandoned-view timer', async () => {
    vi.useFakeTimers()
    const pending = deferred<string>()
    const load = vi.fn((_signal: AbortSignal) => pending.promise)
    const controller = new AbortController()
    const first = read('w', load, controller.signal)
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort(); await rejected
    await vi.advanceTimersByTimeAsync(4900)
    const second = read('w', load)
    await vi.advanceTimersByTimeAsync(200)
    expect(load).toHaveBeenCalledTimes(1)
    expect(load.mock.calls[0]![0].aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    pending.resolve('shared')
    expect(await second).toBe('shared')
    expect(await read('w', load)).toBe('shared')
  })
  it('starts a new grace window when the last returning consumer also leaves', async () => {
    vi.useFakeTimers()
    const pending = deferred<string>()
    const load = vi.fn((_signal: AbortSignal) => pending.promise)
    for (let index = 0; index < 2; index++) {
      const controller = new AbortController()
      const waiting = read('w', load, controller.signal)
      const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
      controller.abort(); await rejected
      await vi.advanceTimersByTimeAsync(4900)
      expect(load.mock.calls[0]![0].aborted).toBe(false)
    }
    expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(load.mock.calls[0]![0].aborted).toBe(true)
    pending.resolve('late')
  })
  it('keeps a successful answer that settles while no view is watching, without a timer', async () => {
    vi.useFakeTimers()
    const pending = deferred<string>()
    const load = vi.fn(() => pending.promise)
    const controller = new AbortController()
    const request = read('w', load, controller.signal)
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort(); await rejected
    pending.resolve('warm')
    await vi.advanceTimersByTimeAsync(100)
    expect(vi.getTimerCount()).toBe(0)
    expect(await read('w', load)).toBe('warm')
    expect(load).toHaveBeenCalledTimes(1)
  })
  it('clears the grace timer and aborts abandoned work when invalidated', async () => {
    vi.useFakeTimers()
    const load = vi.fn((_signal: AbortSignal) => new Promise<string>(() => {}))
    const controller = new AbortController()
    const request = read('w', load, controller.signal)
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort(); await rejected
    expect(vi.getTimerCount()).toBe(1)
    invalidateClueRequests('w')
    expect(vi.getTimerCount()).toBe(0)
    expect(load.mock.calls[0]![0].aborted).toBe(true)
  })
  it('force replaces the same key while existing callers keep their own result', async () => {
    const old = deferred<string>()
    const first = read('w', () => old.promise)
    const fresh = await cachedClueRequest('clues.list', 'w', { key: 'page' }, async () => 'new', undefined, { force: true })
    expect(fresh).toBe('new')
    old.resolve('old'); expect(await first).toBe('old')
    expect(await read('w', async () => 'wrong')).toBe('new')
  })
  it('coalesces UI refreshes in flight and for one second without weakening forced fresh reads', async () => {
    vi.useFakeTimers()
    const pending = deferred<string>()
    const load = vi.fn(() => pending.promise)
    const options = { force: true, coalesceRefresh: true }
    const first = cachedClueRequest('clues.read', 'w', { clueId: 'c' }, load, undefined, options)
    const second = cachedClueRequest('clues.read', 'w', { clueId: 'c' }, load, undefined, options)
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)
    pending.resolve('refreshed')
    await Promise.all([first, second])
    await vi.advanceTimersByTimeAsync(999)
    expect(await cachedClueRequest('clues.read', 'w', { clueId: 'c' }, load, undefined, options)).toBe('refreshed')
    expect(load).toHaveBeenCalledTimes(1)
    expect(await cachedClueRequest('clues.read', 'w', { clueId: 'c' }, async () => 'send-time', undefined, { force: true })).toBe('send-time')
  })
  it('can invalidate one method without dropping sibling read families', async () => {
    const sources = vi.fn(async () => 'sources')
    const list = vi.fn(async () => 'list')
    await cachedClueRequest('clues.sources', undefined, {}, sources)
    await read('w', list)
    invalidateClueRequests(undefined, 'clues.sources')
    await cachedClueRequest('clues.sources', undefined, {}, sources)
    await read('w', list)
    expect(sources).toHaveBeenCalledTimes(2)
    expect(list).toHaveBeenCalledTimes(1)
  })
  it('never caches failures', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('recovered')
    await expect(read('w', load)).rejects.toThrow('offline')
    expect(await read('w', load)).toBe('recovered')
    expect(load).toHaveBeenCalledTimes(2)
  })
  it('invalidates one workspace without dropping another', async () => {
    const load = vi.fn(async () => 'result')
    await read('one', load); await read('two', load)
    invalidateClueRequests('one')
    await read('one', load); await read('two', load)
    expect(load).toHaveBeenCalledTimes(3)
  })
  it('does not let a pre-mutation response replace a new cache entry', async () => {
    const old = deferred<string>()
    const request = read('w', () => old.promise)
    invalidateClueRequests('w')
    await read('w', async () => 'new')
    old.resolve('old'); expect(await request).toBe('old')
    expect(await read('w', async () => 'unexpected')).toBe('new')
  })
  it('evicts least-recently-used completed entries and keeps pending operations', async () => {
    const pending = deferred<string>()
    const inFlight = read('w', () => pending.promise, undefined, 'active')
    const load = vi.fn(async () => 'done')
    for (let index = 0; index < 130; index++) await read('w', load, undefined, String(index))
    const duplicate = read('w', async () => 'wrong', undefined, 'active')
    pending.resolve('active')
    expect(await inFlight).toBe('active'); expect(await duplicate).toBe('active')
    const before = load.mock.calls.length
    await read('w', load, undefined, '0')
    expect(load).toHaveBeenCalledTimes(before + 1)
  })
  it('bounds retained content bytes and evicts the least-recently-used completed read', async () => {
    const big = (fill: string): string => fill.repeat(6 * 1024 * 1024)
    await cachedClueRequest('clues.read', 'w', { clueId: 'a' }, async () => big('a'))
    await cachedClueRequest('clues.read', 'w', { clueId: 'b' }, async () => big('b'))
    // 12 MiB still fits inside the 16 MiB content budget. Touching both in
    // insertion order keeps `a` the LRU victim of the next overflow.
    expect(peekClueRequest('clues.read', 'w', { clueId: 'a' })).toBeDefined()
    expect(peekClueRequest('clues.read', 'w', { clueId: 'b' })).toBeDefined()
    await cachedClueRequest('clues.read', 'w', { clueId: 'c' }, async () => big('c'))
    // 18 MiB exceeds it: only the newest two survive.
    expect(peekClueRequest('clues.read', 'w', { clueId: 'a' })).toBeUndefined()
    expect(peekClueRequest('clues.read', 'w', { clueId: 'b' })).toBeDefined()
    expect(peekClueRequest('clues.read', 'w', { clueId: 'c' })).toBeDefined()
  })
  it('does not start a request for a view already hidden', async () => {
    const controller = new AbortController(); controller.abort()
    const load = vi.fn(async () => 'unused')
    await expect(read('w', load, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(load).not.toHaveBeenCalled()
  })
})

describe('client wire cache integration', () => {
  it('keeps page reads warm across a pack mutation and refreshes only the pack/binding families', async () => {
    wire.mockResolvedValue({ items: [], packs: [], bindings: [] })
    const list = () => cluesApi.list('w', { sourceId: 'source', limit: 25 })
    const packs = () => cluesApi.packsList('w')
    const bindings = () => cluesApi.bindingsList('w')
    await list(); await packs(); await bindings()
    expect(wire).toHaveBeenCalledTimes(3)
    await cluesApi.packsCreate('w', { name: 'Pack', members: [] })
    await list(); await packs(); await bindings()
    // The create call plus one fresh pack read; the page and binding reads stay
    // cached because creating a pack changes neither.
    expect(wire).toHaveBeenCalledTimes(5)
  })
  it('caches document reads, portable projections and snapshots but keeps editing baselines fresh', async () => {
    wire.mockResolvedValue({})
    await cluesApi.read('w', { clueId: 'clue' }); await cluesApi.read('w', { clueId: 'clue' })
    await cluesApi.portable('w', { clueId: 'clue' }); await cluesApi.portable('w', { clueId: 'clue' })
    await cluesApi.snapshotsRead('w', 'snapshot'); await cluesApi.snapshotsRead('w', 'snapshot')
    await cluesApi.loadEdit('w', { clueId: 'clue' }); await cluesApi.loadEdit('w', { clueId: 'clue' })
    expect(wire).toHaveBeenCalledTimes(5)
  })
  it('also invalidates after a rejected mutation so partial writes cannot leave stale directories', async () => {
    wire.mockResolvedValueOnce({ packs: [] }).mockRejectedValueOnce(new Error('partial')).mockResolvedValueOnce({ packs: [] })
    await cluesApi.packsList('w')
    await expect(cluesApi.packsAddMember('w', { packId: 'p', clueId: 'c' })).rejects.toThrow('partial')
    await cluesApi.packsList('w')
    expect(wire).toHaveBeenCalledTimes(3)
  })
})


describe('precise read-family invalidation after writes', () => {
  /** A wire answer keyed by method so every family can be read independently. */
  function wireByMethod(): void {
    wire.mockImplementation(async (method: string) => ({ method }))
  }

  function callsOf(method: string): number {
    return wire.mock.calls.filter(([called]) => called === method).length
  }

  async function readEveryFamily(): Promise<void> {
    await cluesApi.list('w', { sourceId: 'source', limit: 25 })
    await cluesApi.search('w', { sourceId: 'source', query: 'q' })
    await cluesApi.defaultScope('w', { sourceId: 'source' })
    await cluesApi.clues('w')
    await cluesApi.pinsList('w')
    await cluesApi.packsList('w')
    await cluesApi.bindingsList('w')
    await cluesApi.resolve('w', { text: 'a.md' })
  }

  it('invalidates both cached identities of one resource after ensure + save', async () => {
    const locator = { path: 'a.md' }
    wire.mockImplementation(async (method: string) => {
      if (method === 'clues.ensure') {
        return {
          clue: {
            id: 'c-alias', sourceId: 'source', typeId: 'type', locator, title: 'A note',
            workspaceId: 'w', createdAt: '', updatedAt: '',
          },
          created: true,
        }
      }
      return { method }
    })
    await cluesApi.ensure('w', { sourceId: 'source', typeId: 'type', locator, title: 'A note' })
    await cluesApi.read('w', { clueId: 'c-alias' })
    await cluesApi.read('w', { sourceId: 'source', typeId: 'type', locator })
    expect(callsOf('clues.read')).toBe(2)

    // A save addressed by the persisted clue id refreshes the locator-keyed
    // read of the SAME resource too; the alias came from ensure.
    await cluesApi.saveEdit('w', {
      clueId: 'c-alias',
      document: { format: 'text/markdown', data: { text: 'changed' } },
    })
    await cluesApi.read('w', { clueId: 'c-alias' })
    await cluesApi.read('w', { sourceId: 'source', typeId: 'type', locator })
    expect(callsOf('clues.read')).toBe(4)

    // ...and the reverse: a locator-addressed save refreshes the id read.
    await cluesApi.saveEdit('w', {
      sourceId: 'source',
      typeId: 'type',
      locator,
      document: { format: 'text/markdown', data: { text: 'changed again' } },
    })
    await cluesApi.read('w', { clueId: 'c-alias' })
    await cluesApi.read('w', { sourceId: 'source', typeId: 'type', locator })
    expect(callsOf('clues.read')).toBe(6)
  })

  it('indexes clue ids from the library snapshot without an extra read', async () => {
    const locator = { path: 'lib.md' }
    wire.mockImplementation(async (method: string) => {
      if (method === 'clues.clues') {
        return {
          clues: [{
            id: 'c-lib', sourceId: 'source', typeId: 'type', locator, title: 'From library',
            workspaceId: 'w', createdAt: '', updatedAt: '',
          }],
          revision: 1,
        }
      }
      return { method }
    })
    await cluesApi.clues('w')
    await cluesApi.read('w', { clueId: 'c-lib' })
    await cluesApi.read('w', { sourceId: 'source', typeId: 'type', locator })
    expect(callsOf('clues.read')).toBe(2)
    await cluesApi.saveEdit('w', {
      clueId: 'c-lib',
      document: { format: 'text/markdown', data: { text: 'saved' } },
    })
    await cluesApi.read('w', { clueId: 'c-lib' })
    await cluesApi.read('w', { sourceId: 'source', typeId: 'type', locator })
    expect(callsOf('clues.clues')).toBe(1)
    expect(callsOf('clues.read')).toBe(4)
  })

  it('invalidates every session variant of one resource on save', async () => {
    const locator = { path: 'session.md' }
    wire.mockImplementation(async (method: string) => {
      if (method === 'clues.ensure') {
        return {
          clue: {
            id: 'c-session', sourceId: 'source', typeId: 'type', locator, title: 'Session note',
            workspaceId: 'w', createdAt: '', updatedAt: '',
          },
          created: true,
        }
      }
      return { method }
    })
    await cluesApi.ensure('w', { sourceId: 'source', typeId: 'type', locator, title: 'Session note' })
    await cluesApi.read('w', { clueId: 'c-session', sessionId: 's1' })
    await cluesApi.read('w', { clueId: 'c-session', sessionId: 's2' })
    expect(callsOf('clues.read')).toBe(2)
    // The save is addressed by the locator alias; both session-specific keys
    // must go because the body changed for every session.
    await cluesApi.saveEdit('w', {
      sourceId: 'source',
      typeId: 'type',
      locator,
      document: { format: 'text/markdown', data: { text: 'saved' } },
    })
    await cluesApi.read('w', { clueId: 'c-session', sessionId: 's1' })
    await cluesApi.read('w', { clueId: 'c-session', sessionId: 's2' })
    expect(callsOf('clues.read')).toBe(4)
  })

  it('emits one library event after a successful save, only after cache invalidation', async () => {
    const events: { kind: string; workspaceId?: string }[] = []
    const cachedAtEvent: unknown[] = []
    const unsubscribe = subscribeClueDataChanges((change) => {
      events.push(change)
      cachedAtEvent.push(peekClueRequest('clues.read', 'w', { workspaceId: 'w', clueId: 'c-event' }))
    })
    wireByMethod()
    await cluesApi.read('w', { clueId: 'c-event' })
    await cluesApi.saveEdit('w', {
      clueId: 'c-event',
      document: { format: 'text/markdown', data: { text: 'saved' } },
    })
    expect(events).toEqual([{ kind: 'library', workspaceId: 'w' }])
    // The invalidation happened before the observer ran: a listener that reads
    // immediately cannot observe the saved-over body.
    expect(cachedAtEvent).toEqual([undefined])

    wire.mockRejectedValueOnce(new Error('save failed'))
    await expect(cluesApi.saveEdit('w', {
      clueId: 'c-event',
      document: { format: 'text/markdown', data: { text: 'not saved' } },
    })).rejects.toThrow('save failed')
    expect(events).toHaveLength(1)
    unsubscribe()
  })

  it('emits a library event for a changed ensure but not for an unchanged one', async () => {
    const events: { kind: string; workspaceId?: string }[] = []
    const unsubscribe = subscribeClueDataChanges(change => { events.push(change) })
    const clue = {
      id: 'c-ensure-event', sourceId: 'source', typeId: 'type', locator: { path: 'e.md' },
      title: 'Ensure event', workspaceId: 'w', createdAt: '', updatedAt: '',
    }
    wire.mockImplementation(async (method: string) => {
      if (method === 'clues.ensure') return { clue, created: false, updated: true }
      return { method }
    })
    await cluesApi.ensure('w', { sourceId: 'source', typeId: 'type', locator: clue.locator, title: clue.title })
    expect(events).toEqual([{ kind: 'library', workspaceId: 'w' }])

    wire.mockImplementation(async (method: string) => {
      if (method === 'clues.ensure') return { clue, created: false, updated: false }
      return { method }
    })
    await cluesApi.ensure('w', { sourceId: 'source', typeId: 'type', locator: clue.locator, title: clue.title })
    expect(events).toHaveLength(1)
    unsubscribe()
  })

  it('ensure refreshes the library display only', async () => {
    wire.mockImplementation(async (method: string) =>
      method === 'clues.ensure' ? { clue: { id: 'c-new' }, created: true } : { method })
    await readEveryFamily()
    const before = Object.fromEntries(['clues.list', 'clues.search', 'clues.defaultScope', 'clues.clues', 'clues.pins.list', 'clues.packs.list', 'clues.bindings.list', 'clues.resolve'].map(method => [method, callsOf(method)]))
    await cluesApi.ensure('w', { sourceId: 'source', typeId: 'type', locator: {}, title: 'New clue' })
    await readEveryFamily()
    expect(callsOf('clues.clues')).toBe(before['clues.clues']! + 1)
    for (const method of ['clues.list', 'clues.search', 'clues.defaultScope', 'clues.pins.list', 'clues.packs.list', 'clues.bindings.list', 'clues.resolve']) {
      expect(callsOf(method), method).toBe(before[method])
    }
  })

  it('an unchanged ensure leaves every cached family warm', async () => {
    wire.mockImplementation(async (method: string) =>
      method === 'clues.ensure' ? { clue: { id: 'c-existing' }, created: false } : { method })
    await readEveryFamily()
    const before = Object.fromEntries(['clues.list', 'clues.search', 'clues.defaultScope', 'clues.clues', 'clues.pins.list', 'clues.packs.list', 'clues.bindings.list', 'clues.resolve'].map(method => [method, callsOf(method)]))
    await cluesApi.ensure('w', { sourceId: 'source', typeId: 'type', locator: {}, title: 'Existing clue' })
    await readEveryFamily()
    for (const method of Object.keys(before)) expect(callsOf(method), method).toBe(before[method])
  })

  it('a pin write refreshes pins only', async () => {
    wireByMethod()
    await readEveryFamily()
    const before = Object.fromEntries(['clues.list', 'clues.search', 'clues.clues', 'clues.pins.list', 'clues.packs.list', 'clues.bindings.list'].map(method => [method, callsOf(method)]))
    await cluesApi.pinsAdd('w', { clueId: 'c1' })
    await readEveryFamily()
    expect(callsOf('clues.pins.list')).toBe(before['clues.pins.list']! + 1)
    for (const method of ['clues.list', 'clues.search', 'clues.clues', 'clues.packs.list', 'clues.bindings.list']) {
      expect(callsOf(method), method).toBe(before[method])
    }
  })

  it('pack create/rename/member writes refresh packs only; deleting a pack also drops bindings', async () => {
    wireByMethod()
    await readEveryFamily()
    const before = Object.fromEntries(['clues.list', 'clues.search', 'clues.clues', 'clues.pins.list', 'clues.packs.list', 'clues.bindings.list'].map(method => [method, callsOf(method)]))
    await cluesApi.packsCreate('w', { name: 'Pack', members: [] })
    await cluesApi.packsRename('w', { packId: 'p1', name: 'Renamed' })
    await cluesApi.packsAddMember('w', { packId: 'p1', clueId: 'c1' })
    await cluesApi.packsRemoveMember('w', { packId: 'p1', clueId: 'c1' })
    await readEveryFamily()
    expect(callsOf('clues.packs.list')).toBe(before['clues.packs.list']! + 1)
    expect(callsOf('clues.bindings.list')).toBe(before['clues.bindings.list'])
    for (const method of ['clues.list', 'clues.search', 'clues.clues', 'clues.pins.list']) {
      expect(callsOf(method), method).toBe(before[method])
    }

    await cluesApi.packsDelete('w', { packId: 'p1' })
    await readEveryFamily()
    expect(callsOf('clues.bindings.list')).toBe(before['clues.bindings.list']! + 1)
  })

  it('saving an edit refreshes the saved resource, library and bindings without a pack re-read', async () => {
    wireByMethod()
    const saved = { clueId: 'c1' }
    const other = { clueId: 'c2' }
    await cluesApi.read('w', saved)
    await cluesApi.read('w', other)
    await cluesApi.list('w', { sourceId: 'source', limit: 25 })
    await cluesApi.search('w', { sourceId: 'source', query: 'q' })
    await cluesApi.resolve('w', { text: 'a.md' })
    await cluesApi.portable('w', saved)
    await cluesApi.clues('w')
    await cluesApi.packsList('w')
    await cluesApi.bindingsList('w')
    const before = Object.fromEntries(['clues.read', 'clues.list', 'clues.search', 'clues.resolve', 'clues.portable', 'clues.clues', 'clues.packs.list', 'clues.bindings.list'].map(method => [method, callsOf(method)]))
    await cluesApi.saveEdit('w', {
      ...saved,
      document: { format: 'text/markdown', data: { text: 'changed' } },
    })
    await readEveryFamily()
    // The saved resource's body/portable read plus every content-derived
    // family is refreshed; an unrelated resource read stays warm.
    expect(await cluesApi.read('w', saved)).toEqual({ method: 'clues.read' })
    expect(callsOf('clues.read')).toBe(before['clues.read']! + 1)
    expect(await cluesApi.portable('w', saved)).toEqual({ method: 'clues.portable' })
    expect(callsOf('clues.portable')).toBe(before['clues.portable']! + 1)
    for (const method of ['clues.list', 'clues.search', 'clues.resolve']) {
      expect(callsOf(method), method).toBe(before[method]! + 1)
    }
    // An unrelated resource read is still served from cache: no new wire read.
    expect(await cluesApi.read('w', other)).toEqual({ method: 'clues.read' })
    expect(callsOf('clues.read')).toBe(before['clues.read']! + 1)
    // A save can persist metadata (`persistentInfo`) for an existing clue:
    // the library row and binding revision must be refreshed too.
    expect(callsOf('clues.clues')).toBe(before['clues.clues']! + 1)
    expect(callsOf('clues.bindings.list')).toBe(before['clues.bindings.list']! + 1)
    expect(callsOf('clues.packs.list')).toBe(before['clues.packs.list'])
  })
})
