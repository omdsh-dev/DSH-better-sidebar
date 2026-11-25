/**
 * S5 composer '@' sources contract (client half).
 *
 * A fake clue face (ctx.betterSidebar.clues) plus a fake inputTriggers service;
 * no React tree is mounted. One integration case drives the REAL clue service/
 * store so the production search shape (raw candidates WITHOUT a clueId) is
 * exercised, not assumed. Pins:
 * - exactly two sources with the frozen codec names, both on '@';
 * - empty query stays LOCAL: bounded recent library clues + pins and the local
 *   pack library; no clues.sources();
 * - a non-empty query searches only enabled/mention-enabled sources, with
 *   bounded concurrency, cancellation and per-source failure isolation;
 * - browsing NEVER calls clues.ensure: every hit is offered with its REAL title
 *   (stored hits reuse the stable row); a new hit is persisted only on pick;
 * - every row shows only name === label === title: no description, no UUID
 *   alias and no "include content" duplicate;
 * - a stored pick returns the normal insert outcome; an unstored pick starts
 *   clues.ensure synchronously, answers 'handled', and inserts at the ORIGINAL
 *   pick span; a lost CAS or refused insert asks for '@' again;
 * - historical content-mode refs stay decodable: the frozen codecs serialize
 *   current content at submit time and fail loudly (draft kept);
 * - rows use only host-supported appearances and the injectable openReference
 *   callback; icons are wrapped (node or size-aware factory, 16px default);
 * - registration/disposal follows the injected Cordis scope.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import { CLUE_CODEC_SOURCE, PACK_CODEC_SOURCE, type Clue, type ClueCandidate, type CluePack, type ClueReadResult, type ClueSourceDescriptor, type ClueSourceDisplayDescriptor, type CluesEnsureResult } from '../src/clues/types.ts'
import { createCluesService, type ClueSourceRegistration, type CluesService } from '../src/clues/service.ts'
import type { ClueClientEnsureInput, ClueClientResourceInput, ClueClientSearchInput } from '../src/client/clues/api.ts'
import { createClueInputTriggers, installClueInputTriggers, type ClueCandidateRequest, type ClueInputCandidate, type ClueInputTriggerSource, type ClueMentionsFace, type ClueReferenceSpan } from '../src/client/clues/mentions.ts'
import { removeTree } from './temp-tree.ts'

const NOW = '2026-10-17T00:00:00.000Z'
const roots: string[] = []
const disposers: Array<() => void> = []
const tempRoot = (): string => { const path = mkdtempSync(join(tmpdir(), 'dsh-clues-mentions-')); roots.push(path); return path }

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  for (const path of roots.splice(0)) removeTree(path)
})

function sourceDescriptor(sourceId: string, search = true, read = true): ClueSourceDescriptor {
  return { sourceId, name: 'Name ' + sourceId, order: 0, pluginId: 'test', types: [sourceId + '.text'], transport: 'http', capabilities: { resolve: false, list: false, search, read, edit: false, portable: false } }
}

function clue(id: string, sourceId = 'test.alpha', title = 'Title ' + id, typeId = sourceId + '.text', updatedAt = NOW): Clue {
  return { id, sourceId, typeId, locator: { id }, title, workspaceId: 'ws-1', createdAt: NOW, updatedAt }
}

function pack(id: string, name: string, members: string[] = []): CluePack {
  return { id, name, workspaceId: 'ws-1', members, revision: 1, createdAt: NOW, updatedAt: NOW }
}

interface FaceOptions {
  readonly sources?: readonly ClueSourceDescriptor[]
  readonly displays?: readonly ClueSourceDisplayDescriptor[]
  readonly pins?: readonly { clueId: string }[]
  readonly library?: readonly Clue[]
  readonly packs?: readonly CluePack[]
  readonly search?: (workspaceId: string, sourceId: string, query: string, signal: AbortSignal) => Promise<{ items: ClueCandidate[] }>
  readonly read?: (workspaceId: string, input: { readonly clueId: string; readonly sessionId?: string }, signal: AbortSignal) => Promise<ClueReadResult>
  /** Send-time content must bypass the activation read cache. */
  readonly readFresh?: (workspaceId: string, input: { readonly clueId: string; readonly sessionId?: string }, signal: AbortSignal) => Promise<ClueReadResult>
  readonly ensure?: (workspaceId: string, input: { readonly sourceId: string; readonly typeId: string; readonly locator: unknown; readonly title: string }) => Promise<CluesEnsureResult>
  readonly enabled?: (sourceId: string) => boolean; readonly mentionEnabled?: (sourceId: string) => boolean; readonly packsMention?: boolean
}

function makeFace(options: FaceOptions = {}) {
  const sources = options.sources ?? [sourceDescriptor('test.alpha')]
  const defaultRead = async (input: { readonly clueId: string }): Promise<ClueReadResult> => ({ format: 'text/plain', data: { text: 'body:' + input.clueId }, text: 'body:' + input.clueId, fetchedAt: NOW, freshness: 'live' })
  let ensured = 0
  const api = {
    sources: vi.fn(async () => ({ sources: [...sources], types: [] })),
    search: vi.fn(async (workspaceId: string, input: { sourceId: string; query: string }, signal: AbortSignal) =>
      options.search === undefined ? { items: [] } : { items: await options.search(workspaceId, input.sourceId, input.query, signal).then(result => result.items) }),
    // Browsing must never ensure: the default keeps that a loud contract
    // violation, and the pick tests supply an explicit implementation.
    ensure: vi.fn(async (workspaceId: string, input: { sourceId: string; typeId: string; locator: unknown; title: string }): Promise<CluesEnsureResult> => {
      if (options.ensure !== undefined) return options.ensure(workspaceId, input)
      ensured += 1
      return { clue: { ...clue('ensured-' + ensured, input.sourceId, input.title, input.typeId), locator: input.locator as Clue['locator'] }, created: true }
    }),
    pinsList: vi.fn(async () => ({ pins: (options.pins ?? []).map(pin => ({ workspaceId: 'ws-1', clueId: pin.clueId, createdAt: NOW })), revision: 0 })),
    clues: vi.fn(async () => ({ clues: [...(options.library ?? [])], revision: 0 })),
    packsList: vi.fn(async () => ({ packs: [...(options.packs ?? [])], revision: 0 })),
    read: vi.fn(async (workspaceId: string, input: { readonly clueId: string; readonly sessionId?: string }, signal: AbortSignal) => (
      options.read === undefined ? defaultRead(input) : options.read(workspaceId, input, signal)
    )),
    ...(options.readFresh === undefined ? {} : {
      readFresh: vi.fn(async (workspaceId: string, input: { readonly clueId: string; readonly sessionId?: string }, signal: AbortSignal) => options.readFresh!(workspaceId, input, signal)),
    }),
  }
  const face: ClueMentionsFace = {
    api: api as unknown as ClueMentionsFace['api'],
    getSourceDisplays: () => options.displays ?? [],
    isSourceEnabled: options.enabled ?? (() => true),
    isSourceMentionEnabled: options.mentionEnabled ?? (() => true),
    isPacksMentionEnabled: () => options.packsMention ?? true,
  }
  return { face, api }
}

const createTriggers = (options: Parameters<typeof createClueInputTriggers>[0]) => createClueInputTriggers({ searchDebounceMs: 0, ...options })
const request = (query: string, signal: AbortSignal = new AbortController().signal): ClueCandidateRequest => ({ query, position: 'inline', drilled: false, signal })
const SESSION = { sessionId: 'session-1' }
const valueOf = (candidate: ClueInputCandidate): Record<string, unknown> => JSON.parse(candidate.value!) as Record<string, unknown>
const spanOf = (draftRev = 1, start = 0, end = 0): ClueReferenceSpan => ({ start, end, draftRev })

function pick(source: ClueInputTriggerSource, candidate: ClueInputCandidate, span?: ClueReferenceSpan) {
  return source.onPick!({ candidate, session: SESSION, position: 'inline', via: 'menu', action: 'pick', ...(span === undefined ? {} : { span }) })
}

const HIT: ClueCandidate = { sourceId: 'test.alpha', typeId: 'test.alpha.text', locator: { id: 'b' }, title: 'Fresh B' }
const hitOptions = (extra: FaceOptions = {}): FaceOptions => ({ sources: [sourceDescriptor('test.alpha')], search: async () => ({ items: [HIT] }), ...extra })

function captureSources() {
  const sources = new Map<string, ClueInputTriggerSource>()
  const service = { registerSource(source: ClueInputTriggerSource): () => void { sources.set(source.name, source); return () => { sources.delete(source.name) } } }
  return { sources, service }
}

function realFace(service: CluesService): ClueMentionsFace {
  return {
    api: {
      sources: async () => ({ sources: service.getSources(), types: service.getTypes() }),
      search: (workspaceId: string, input: ClueClientSearchInput, signal: AbortSignal) => service.search({ workspaceId, ...input } as Parameters<CluesService['search']>[0], { signal }),
      clues: (workspaceId: string) => service.listClues(workspaceId),
      ensure: (workspaceId: string, input: ClueClientEnsureInput, signal: AbortSignal) => service.ensure({ workspaceId, ...input }, { signal }),
      pinsList: (workspaceId: string) => service.listPins(workspaceId),
      packsList: (workspaceId: string) => service.listPacks(workspaceId),
      read: (workspaceId: string, input: ClueClientResourceInput, signal: AbortSignal) => service.read({ workspaceId, ...input }, { signal }),
    } as unknown as ClueMentionsFace['api'],
    getSourceDisplays: () => [], isSourceEnabled: () => true, isSourceMentionEnabled: () => true, isPacksMentionEnabled: () => true,
  }
}

function realSearchSource(): ClueSourceRegistration {
  const sourceId = 'test.real'
  const typeId = 'test.real.text'
  return {
    descriptor: { sourceId, name: sourceId, order: 0, pluginId: 'test', types: [typeId], transport: 'http', capabilities: { resolve: false, list: false, search: true, read: true, edit: false, portable: false } },
    types: [{ typeId, sourceId, formats: ['text/plain'], capabilities: { read: true, edit: false, concurrency: 'none' } }],
    operations: {
      search: async () => ({ items: [{ sourceId, typeId, locator: { id: 'a' }, title: 'Known A' }, { sourceId, typeId, locator: { id: 'b' }, title: 'Fresh B' }] }),
      read: async input => ({ format: 'text/plain', data: { text: 'body:' + String(input.locator.id) }, text: 'body:' + String(input.locator.id), fetchedAt: NOW, freshness: 'live' }),
    },
  }
}

const contentRef = (kind: 'clue' | 'pack', id: string, extra: Record<string, unknown> = {}): string => 'dsh-clue-content:v1:' + JSON.stringify({ kind, id, workspaceId: 'ws-1', ...extra })

function mount(options: FaceOptions = {}, extra: Partial<Parameters<typeof createTriggers>[0]> = {}) {
  const { face, api } = makeFace(options)
  const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1', ...extra })
  disposers.push(() => created.dispose())
  return { created, api, face }
}

describe('clues @ menu: codecs, empty query and packs', () => {
  it('registers exactly the two frozen codec names and serializes tokens only', async () => {
    const { created, api } = mount()
    expect(created.sources.map(source => source.name)).toEqual([CLUE_CODEC_SOURCE, PACK_CODEC_SOURCE])
    expect(created.sources.every(source => source.trigger === '@')).toBe(true)
    const signal = new AbortController().signal
    for (const [index, prefix, id] of [[0, '[[dsh-clue:', 'clue-9'], [1, '[[dsh-cluepack:', 'pack-9']] as const) {
      await expect(created.sources[index]!.codec!.serialize(id, signal)).resolves.toBe(prefix + id + ']]')
      expect(created.sources[index]!.codec!.clipboardText(id)).toBe(prefix + id + ']]')
    }
    const controller = new AbortController()
    controller.abort()
    await expect(created.sources[0]!.codec!.serialize('clue-9', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(created.sources[0]!.codec!.serialize('bad id', signal)).rejects.toMatchObject({ category: 'invalid-request' })
    await expect(created.sources[1]!.codec!.serialize('bad]]id', signal)).rejects.toMatchObject({ category: 'invalid-request' })
    expect(() => created.sources[0]!.codec!.clipboardText('bad id')).toThrow()
    expect(api.read).not.toHaveBeenCalled()
  })
  it('returns bounded recent clues plus pins, newest first, without a remote catalogue fetch', async () => {
    const { created, api } = mount({
      library: [clue('clue-1', 'test.alpha', 'Alpha', undefined, '2026-10-15T00:00:00.000Z'), clue('clue-2', 'test.alpha', 'Beta', undefined, '2026-10-18T00:00:00.000Z'), clue('clue-3', 'test.alpha', 'Gamma', undefined, '2026-10-16T00:00:00.000Z')],
      pins: [{ clueId: 'clue-3' }],
    }, { limit: 3 })
    const candidates = await created.sources[0]!.candidates(SESSION, request(''))
    // Pins first (explicit shortcuts), then the recent slice minus the pin.
    expect(candidates.map(row => row.label)).toEqual(['Gamma', 'Beta', 'Alpha'])
    for (const wire of [api.sources, api.search, api.ensure]) expect(wire).not.toHaveBeenCalled()
  })
  it('bounds the merged recent + pin list at the configured limit', async () => {
    const library = Array.from({ length: 6 }, (_, index) => clue('clue-' + index, 'test.alpha', 'Row ' + index, undefined, '2026-10-1' + index + 'T00:00:00.000Z'))
    const { created } = mount({ library, pins: [{ clueId: 'clue-0' }] }, { limit: 2 })
    const candidates = await created.sources[0]!.candidates(SESSION, request(''))
    expect(candidates).toHaveLength(2)
    expect(candidates.map(row => row.label)).toEqual(['Row 0', 'Row 5'])
  })
  it('onPick returns the stable clue token with a host-supported appearance and no fake fields', async () => {
    const { created } = mount({ library: [clue('clue-1', 'builtin.files', 'Notes', 'builtin.files.directory')], pins: [{ clueId: 'clue-1' }] })
    const candidates = await created.sources[0]!.candidates(SESSION, request(''))
    const [candidate] = candidates
    expect(candidates).toHaveLength(1)
    expect(candidate!.name).toBe('Notes')
    expect(candidate!.label).toBe('Notes')
    expect(candidate!.description).toBeUndefined()
    expect(valueOf(candidate!).mode).toBeUndefined()
    expect(pick(created.sources[0]!, candidate!, spanOf(1, 0, 4))).toEqual({ insert: { source: CLUE_CODEC_SOURCE, ref: 'clue-1', label: 'Notes', appearance: 'folder', clipboardText: '[[dsh-clue:clue-1]]' } })
  })
  it('stays local when the workspace is not ready and reports resolver/candidate failures', async () => {
    const onError = vi.fn()
    const { face, api } = makeFace({ pins: [{ clueId: 'bad id' }], library: [clue('bad id')] })
    const notReady = createTriggers({ face, resolveWorkspaceId: () => undefined })
    expect(await notReady.sources[0]!.candidates(SESSION, request(''))).toEqual([])
    expect(api.pinsList).not.toHaveBeenCalled()
    const failing = createTriggers({ face, resolveWorkspaceId: () => { throw new Error('workspace service offline') }, onError })
    expect(await failing.sources[0]!.candidates(SESSION, request(''))).toEqual([])
    const badId = createTriggers({ face, resolveWorkspaceId: () => 'ws-1', onError })
    expect(await badId.sources[0]!.candidates(SESSION, request(''))).toEqual([])
    expect(onError).toHaveBeenCalledTimes(2)
    notReady.dispose(); failing.dispose(); badId.dispose()
  })
  it('lists local packs newest first, inserts pack tokens, filters by name and honours the @ switch', async () => {
    const first = pack('pack-1', 'Reading list', ['clue-1'])
    const second = { ...pack('pack-2', 'Drafts', ['clue-1', 'clue-2']), updatedAt: '2026-10-18T00:00:00.000Z' }
    const { created, api } = mount({ packs: [first, second] })
    const candidates = await created.sources[1]!.candidates(SESSION, request(''))
    expect(candidates.map(row => row.label)).toEqual(['Drafts', 'Reading list'])
    expect(candidates.every(row => row.name === row.label && row.description === undefined)).toBe(true)
    expect(api.sources).not.toHaveBeenCalled()
    expect(pick(created.sources[1]!, candidates[0]!, spanOf(1, 0, 2))).toEqual({ insert: { source: PACK_CODEC_SOURCE, ref: 'pack-2', label: 'Drafts', appearance: 'folder', clipboardText: '[[dsh-cluepack:pack-2]]' } })
    expect((await created.sources[1]!.candidates(SESSION, request('read'))).map(row => row.label)).toEqual(['Reading list'])
    const off = createTriggers({ face: makeFace({ packsMention: false }).face, resolveWorkspaceId: () => 'ws-1' })
    expect(await off.sources[1]!.candidates(SESSION, request(''))).toEqual([]); off.dispose()
  })
})
describe('clues @ menu: non-empty query and picking', () => {
  it('searches only enabled, mention-enabled sources and isolates per-source failures', async () => {
    const onError = vi.fn()
    const { created, api } = mount({
      sources: [sourceDescriptor('test.broken'), sourceDescriptor('test.disabled'), sourceDescriptor('test.hidden'), sourceDescriptor('test.healthy')],
      library: [{ ...clue('clue-healthy', 'test.healthy', 'test.healthy issue'), locator: { id: 'test.healthy:issue' } }],
      enabled: sourceId => sourceId !== 'test.disabled',
      mentionEnabled: sourceId => sourceId !== 'test.hidden',
      search: async (_workspaceId, sourceId, query) => {
        if (sourceId === 'test.broken') throw new Error('SECRET=source-outage')
        return { items: [{ sourceId, typeId: sourceId + '.text', locator: { id: sourceId + ':' + query }, title: sourceId + ' ' + query }] }
      },
    }, { onError })
    const candidates = await created.sources[0]!.candidates(SESSION, request('issue'))
    expect(api.search).toHaveBeenCalledTimes(2)
    expect(api.search.mock.calls.map(call => (call[1] as { sourceId: string }).sourceId).sort()).toEqual(['test.broken', 'test.healthy'])
    expect(candidates.map(row => row.label)).toEqual(['test.healthy issue'])
    expect(onError).toHaveBeenCalled()
    expect(JSON.stringify(candidates)).not.toContain('source-outage')
  })
  it('offers every hit with its real title and reuses a stored clue without ensuring', async () => {
    const { created, api } = mount({
      sources: [sourceDescriptor('test.alpha')],
      library: [{ ...clue('clue-known', 'test.alpha', 'Known'), locator: { id: 'a' } }],
      search: async () => ({ items: [
        { sourceId: 'test.alpha', typeId: 'test.alpha.text', locator: { id: 'a' }, title: 'Search title A' },
        { sourceId: 'test.alpha', typeId: 'test.alpha.text', locator: { id: 'b' }, title: 'Fresh B' },
      ] }),
    })
    const candidates = await created.sources[0]!.candidates(SESSION, request('doc'))
    expect(candidates.map(row => row.label)).toEqual(['Known', 'Fresh B'])
    expect(candidates.every(row => row.name === row.label && row.description === undefined)).toBe(true)
    expect(valueOf(candidates[0]!).id).toBe('clue-known')
    expect(valueOf(candidates[1]!).id).toBeUndefined()
    expect(valueOf(candidates[1]!)).toMatchObject({ kind: 'clue', sourceId: 'test.alpha', typeId: 'test.alpha.text', locator: { id: 'b' }, title: 'Fresh B', workspaceId: 'ws-1' })
    expect(api.ensure).not.toHaveBeenCalled()
    expect(api.read).not.toHaveBeenCalled()
  })
  it('caps the merged rows at the configured limit', async () => {
    const library = Array.from({ length: 5 }, (_, index) => ({ ...clue('clue-' + index, 'test.alpha', 'Row ' + index), locator: { id: String(index) } }))
    const { created } = mount({ sources: [sourceDescriptor('test.alpha')], library, search: async () => ({ items: Array.from({ length: 5 }, (_, index) => ({ sourceId: 'test.alpha', typeId: 'test.alpha.text', locator: { id: String(index) }, title: 'Row ' + index })) }) }, { limit: 2 })
    expect(await created.sources[0]!.candidates(SESSION, request('row'))).toHaveLength(2)
  })
  it('cancels in-flight searches and drops their late results', async () => {
    const controller = new AbortController()
    const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' })
    const search = vi.fn(async (_workspaceId: string, _sourceId: string, _query: string, signal: AbortSignal) => {
      if (signal.aborted) throw abortError()
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(abortError())))
      return { items: [] }
    })
    const { created } = mount({ sources: [sourceDescriptor('test.alpha')], search })
    const pending = created.sources[0]!.candidates(SESSION, request('doc', controller.signal))
    await Promise.resolve()
    controller.abort()
    await expect(pending).resolves.toEqual([])
  })
  it('settles only the trailing keystroke and cancels superseded rounds promptly', async () => {
    vi.useFakeTimers()
    try {
      const { created, api } = mount({ sources: [sourceDescriptor('test.alpha')], search: async () => ({ items: [] }) }, { searchDebounceMs: 300 })
      const round = (query: string) => { const controller = new AbortController(); return { controller, pending: created.sources[0]!.candidates(SESSION, request(query, controller.signal)) } }
      const first = round('un')
      await vi.advanceTimersByTimeAsync(100)
      expect(api.search).not.toHaveBeenCalled()
      first.controller.abort()
      // Cancellation is immediate: the superseded round never waits out the window.
      await expect(first.pending).resolves.toEqual([])
      const second = round('uns')
      await vi.advanceTimersByTimeAsync(100)
      second.controller.abort()
      await expect(second.pending).resolves.toEqual([])
      const third = round('unseen')
      await vi.advanceTimersByTimeAsync(299)
      expect(api.search).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await expect(third.pending).resolves.toEqual([])
      expect(api.search).toHaveBeenCalledTimes(1)
      expect((api.search.mock.calls[0]![1] as { query: string }).query).toBe('unseen')
    } finally {
      vi.useRealTimers()
    }
  })
  it('cancels a pending debounce on dispose and serves an empty query immediately', async () => {
    vi.useFakeTimers()
    try {
      const { created, api } = mount({ sources: [sourceDescriptor('test.alpha')], library: [clue('clue-1')], pins: [{ clueId: 'clue-1' }] }, { searchDebounceMs: 300 })
      const pending = created.sources[0]!.candidates(SESSION, request('un'))
      created.dispose()
      await expect(pending).resolves.toEqual([])
      expect(api.search).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(300)
      expect(api.search).not.toHaveBeenCalled()
      const immediate = createTriggers({ face: makeFace({ library: [clue('clue-1')], pins: [{ clueId: 'clue-1' }] }).face, resolveWorkspaceId: () => 'ws-1', searchDebounceMs: 300 })
      const served = immediate.sources[0]!.candidates(SESSION, request(''))
      await vi.advanceTimersByTimeAsync(0)
      await expect(served).resolves.toHaveLength(1)
      expect(api.search).not.toHaveBeenCalled()
      immediate.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
  it('ensures exactly once on pick, then inserts at the ORIGINAL pick span', async () => {
    const insertReference = vi.fn((_reference: unknown, _session: unknown, _span: unknown) => 'inserted' as const)
    const { created, api } = mount(hitOptions(), { insertReference })
    const [candidate] = await created.sources[0]!.candidates(SESSION, request('doc'))
    expect(api.ensure).not.toHaveBeenCalled()
    const span = spanOf(7, 3, 8)
    // Synchronous answer: the host must not insert anything on its own.
    expect(pick(created.sources[0]!, candidate!, span)).toBe('handled')
    await vi.waitFor(() => expect(insertReference).toHaveBeenCalledTimes(1))
    expect(api.ensure).toHaveBeenCalledTimes(1)
    expect(api.ensure.mock.calls[0]![0]).toBe('ws-1')
    expect(api.ensure.mock.calls[0]![1]).toEqual({ sourceId: 'test.alpha', typeId: 'test.alpha.text', locator: { id: 'b' }, title: 'Fresh B' })
    expect(insertReference).toHaveBeenCalledWith({ source: CLUE_CODEC_SOURCE, ref: 'ensured-1', label: 'Fresh B', appearance: 'file', clipboardText: '[[dsh-clue:ensured-1]]' }, SESSION, span)
  })
  it('keeps the draft and asks for @ again when the pick-time span went stale or ensure fails', async () => {
    const onNotice = vi.fn()
    const inserted = vi.fn((_reference: unknown, _session: unknown, _span: unknown) => 'stale' as const)
    const { created } = mount(hitOptions(), { insertReference: inserted, onNotice })
    const [candidate] = await created.sources[0]!.candidates(SESSION, request('doc'))
    expect(pick(created.sources[0]!, candidate!, spanOf(7))).toBe('handled')
    await vi.waitFor(() => expect(onNotice).toHaveBeenCalledTimes(1))
    expect(onNotice.mock.calls[0]![0]).toContain('Type @ again')
    expect(onNotice.mock.calls[0]![0]).toContain('draft was left unchanged')
    const { created: failed } = mount(hitOptions({ ensure: async () => { throw Object.assign(new Error('offline'), { code: 'unavailable' }) } }), { insertReference: inserted, onNotice })
    const [second] = await failed.sources[0]!.candidates(SESSION, request('doc'))
    pick(failed.sources[0]!, second!, spanOf(7))
    await vi.waitFor(() => expect(onNotice).toHaveBeenCalledTimes(2))
    expect(inserted).toHaveBeenCalledTimes(1)
    expect(onNotice.mock.calls[1]![0]).toContain('draft was left unchanged')
  })
  it('refuses a pick without an insert tail or a span, and never ensures', async () => {
    const onNotice = vi.fn()
    const { created, api } = mount(hitOptions(), { onNotice })
    const [candidate] = await created.sources[0]!.candidates(SESSION, request('doc'))
    expect(pick(created.sources[0]!, candidate!, spanOf(7))).toBe('handled')
    await Promise.resolve()
    expect(api.ensure).not.toHaveBeenCalled()
    expect(onNotice).toHaveBeenCalledTimes(1)
    expect(pick(created.sources[0]!, candidate!)).toBe('handled')
    expect(api.ensure).not.toHaveBeenCalled()
    expect(onNotice).toHaveBeenCalledTimes(2)
  })

  it('preserves comments and explicit incomplete coverage in a historical content send', async () => {
    const { created } = mount({ library: [clue('clue-1', 'test.alpha', 'Alpha')], readFresh: async () => ({
      format: 'text/plain', data: 'Current body', text: 'Current body', fetchedAt: NOW,
      discussion: { status: 'ok', coverage: 'document', fetchedAt: NOW, complete: false, nextCursor: 'comments-next', items: [{ id: 'comment-one', kind: 'comment', format: 'text/plain', body: 'A material comment' }] },
    }) })
    const text = await created.sources[0]!.codec!.serialize(contentRef('clue', 'clue-1'), new AbortController().signal)
    for (const expected of ['Current body', 'A material comment', 'comments-next', '"complete": false']) expect(text).toContain(expected)
  })
  it('reads live content at send time, preferring the fresh API over the cached read', async () => {
    const signal = new AbortController().signal
    const ref = contentRef('clue', 'clue-1', { sessionId: 'session-1' })
    const cached = mount({ library: [clue('clue-1', 'test.alpha', 'Alpha')] })
    expect(cached.created.sources[0]!.codec!.clipboardText(ref)).toBe('[[dsh-clue:clue-1]]')
    const text = await cached.created.sources[0]!.codec!.serialize(ref, signal)
    for (const expected of ['[[dsh-clue:clue-1]]', 'source test.alpha', NOW, 'freshness: live', 'body:clue-1']) expect(text).toContain(expected)
    expect(cached.api.read).toHaveBeenCalledTimes(1)
    // The composer session travels with the content read (S2 §MCP).
    expect(cached.api.read.mock.calls[0]![1]).toEqual({ clueId: 'clue-1', sessionId: 'session-1' })
    const readFresh = vi.fn(async (): Promise<ClueReadResult> => ({ format: 'text/plain', data: { text: 'fresh body' }, text: 'fresh body', fetchedAt: NOW, freshness: 'live' }))
    const fresh = mount({ library: [clue('clue-1')], readFresh })
    expect(await fresh.created.sources[0]!.codec!.serialize(contentRef('clue', 'clue-1'), signal)).toContain('fresh body')
    expect(readFresh).toHaveBeenCalledTimes(1)
    // The stale cached read must not be used for send-time content.
    expect(fresh.api.read).not.toHaveBeenCalled()
  })
  it('protects the draft on content failures, limits, partial pages and invalid refs', async () => {
    const ref = contentRef('clue', 'clue-1')
    const auth = mount({ library: [clue('clue-1')], read: async () => { throw Object.assign(new Error('authorization expired'), { code: 'auth-required' }) } })
    await expect(auth.created.sources[0]!.codec!.serialize(ref, new AbortController().signal)).rejects.toMatchObject({ category: 'auth-required' })
    const long = mount({ library: [clue('clue-1')], read: async () => ({ format: 'text/plain', data: { text: 'x'.repeat(50) }, text: 'x'.repeat(50), fetchedAt: NOW }) }, { includeContentMaxChars: 20 })
    const error = await long.created.sources[0]!.codec!.serialize(ref, new AbortController().signal).then(() => undefined, (reason: unknown) => reason)
    expect(error).toMatchObject({ category: 'invalid-request' })
    expect((error as Error).message).toMatch(/characters, over the 20-character limit/)
    expect((error as Error).message).toContain('draft was kept')
    const paged = mount({ library: [clue('clue-1')], read: async () => ({ format: 'text/plain', data: { text: 'x' }, text: 'x', fetchedAt: NOW, limited: true, nextOffset: 7 }) })
    await expect(paged.created.sources[0]!.codec!.serialize(ref, new AbortController().signal)).rejects.toMatchObject({ category: 'invalid-request' })
    const plain = mount()
    await expect(plain.created.sources[0]!.codec!.serialize(contentRef('pack', 'pack-1'), new AbortController().signal)).rejects.toMatchObject({ category: 'invalid-request' })
    await expect(plain.created.sources[0]!.codec!.serialize('dsh-clue-content:v1:{', new AbortController().signal)).rejects.toMatchObject({ category: 'invalid-request' })
  })
  it('projects every current pack member for a historical pack content ref', async () => {
    const readFresh = vi.fn(async (_workspaceId: string, input: { readonly clueId: string }): Promise<ClueReadResult> => ({ format: 'text/plain', data: { text: 'body:' + input.clueId }, text: 'body:' + input.clueId, fetchedAt: NOW, freshness: 'live' }))
    const { created, api } = mount({ packs: [pack('pack-1', 'Reading list', ['clue-1', 'clue-2'])], library: [clue('clue-1', 'test.alpha', 'A'), clue('clue-2', 'test.alpha', 'B')], readFresh })
    const ref = contentRef('pack', 'pack-1')
    expect(created.sources[1]!.codec!.clipboardText(ref)).toBe('[[dsh-cluepack:pack-1]]')
    const text = await created.sources[1]!.codec!.serialize(ref, new AbortController().signal)
    for (const expected of ['[[dsh-cluepack:pack-1]]', '[[dsh-clue:clue-1]]', '[[dsh-clue:clue-2]]', 'body:clue-1', 'body:clue-2']) expect(text).toContain(expected)
    expect(readFresh).toHaveBeenCalledTimes(2)
    expect(api.read).not.toHaveBeenCalled()
  })
})
describe('real clue service integration', () => {
  it('never writes the library while searching, and ensures only on pick', async () => {
    let next = 0
    const service = createCluesService({ root: tempRoot(), now: () => NOW, newId: kind => kind + '-' + (++next) })
    service.registerSource(realSearchSource())
    try {
      const existing = await service.ensure({ workspaceId: 'ws-1', sourceId: 'test.real', typeId: 'test.real.text', locator: { id: 'a' }, title: 'Known A' })
      const rawSearch = await service.search({ workspaceId: 'ws-1', sourceId: 'test.real', query: 'doc' })
      // This is the production shape the fake tests used to hide.
      expect(rawSearch.items.every(item => item.clueId === undefined)).toBe(true)
      const before = await service.listClues('ws-1')
      const insertReference = vi.fn((_reference: unknown, _session: unknown, _span: unknown) => 'inserted' as const)
      const created = createTriggers({ face: realFace(service), resolveWorkspaceId: () => 'ws-1', insertReference })
      const first = await created.sources[0]!.candidates(SESSION, request('doc'))
      const afterBrowse = await service.listClues('ws-1')
      // S1 §3: a browse must not ensure a lightweight candidate.
      expect(afterBrowse.revision).toBe(before.revision)
      expect(afterBrowse.clues.map(clue => clue.id)).toEqual([existing.clue.id])
      expect(first.map(row => row.label)).toEqual(['Known A', 'Fresh B'])
      expect(valueOf(first[0]!).id).toBe(existing.clue.id)
      expect(valueOf(first[1]!).id).toBeUndefined()
      // Picking the unstored hit writes ONE clue; the insert tail receives it at the original span.
      const span = spanOf(9, 1, 6)
      expect(pick(created.sources[0]!, first[1]!, span)).toBe('handled')
      await vi.waitFor(() => expect(insertReference).toHaveBeenCalledTimes(1))
      const afterPick = await service.listClues('ws-1')
      expect(afterPick.clues).toHaveLength(2)
      const ensured = afterPick.clues.find(clue => clue.title === 'Fresh B')!
      expect(insertReference.mock.calls[0]![0]).toMatchObject({ ref: ensured.id, clipboardText: '[[dsh-clue:' + ensured.id + ']]', label: 'Fresh B' })
      expect(insertReference.mock.calls[0]![1]).toEqual(SESSION)
      expect(insertReference.mock.calls[0]![2]).toEqual(span)
      expect((await created.sources[0]!.candidates(SESSION, request('doc'))).map(row => row.label)).toEqual(['Known A', 'Fresh B'])
      expect((await service.listClues('ws-1')).revision).toBe(afterPick.revision)
      created.dispose()
    } finally {
      service.dispose()
    }
  })
  it('offers an imported unresolved row as a stable reference without remapping it on browse', async () => {
    let next = 0
    const service = createCluesService({ root: tempRoot(), now: () => NOW, newId: kind => kind + '-' + (++next) })
    service.registerSource(realSearchSource())
    try {
      const imported = await service.importUnresolved({ workspaceId: 'ws-1', sourceId: 'test.real', typeId: 'test.real.text', locator: { id: 'a' }, title: 'Imported A', reason: 'source offline at import time' })
      const before = await service.listClues('ws-1')
      expect(before.clues.find(clue => clue.id === imported.clue.id)?.unresolved).toBeDefined()
      const created = createTriggers({ face: realFace(service), resolveWorkspaceId: () => 'ws-1' })
      const rows = await created.sources[0]!.candidates(SESSION, request('doc'))
      // The stable id already exists, so the match reuses the stored row instead of minting one.
      expect(rows.map(row => row.label)).toEqual(['Imported A', 'Fresh B'])
      expect(valueOf(rows[0]!).id).toBe(imported.clue.id)
      expect(valueOf(rows[1]!).id).toBeUndefined()
      const after = await service.listClues('ws-1')
      expect(after.revision).toBe(before.revision)
      expect(after.clues).toHaveLength(1)
      expect(after.clues[0]?.unresolved).toBeDefined()
      created.dispose()
    } finally {
      service.dispose()
    }
  })
})

describe('openReference, icons and installation', () => {
  it('routes previews through the injectable callback, leaves the gesture on false, and wraps a size-aware icon', async () => {
    const { created, face } = mount({ packs: [pack('pack-1', 'P')], library: [clue('clue-1')], displays: [{ sourceId: 'test.alpha', icon: (size: number) => createElement('span', null, 'icon:' + size) }], pins: [{ clueId: 'clue-1' }] })
    const openReference = vi.fn(() => true)
    const withCallback = createTriggers({ face, resolveWorkspaceId: () => 'ws-1', openReference })
    await withCallback.sources[1]!.candidates(SESSION, request(''))
    expect(withCallback.sources[1]!.openReference!(SESSION, { ref: 'pack-1', appearance: 'folder' })).toBe(true)
    expect(openReference).toHaveBeenCalledWith({ kind: 'pack', id: 'pack-1', sessionId: 'session-1' })
    expect(withCallback.sources[0]!.openReference!(SESSION, { ref: contentRef('clue', 'clue-1'), appearance: 'file' })).toBe(true)
    expect(openReference).toHaveBeenCalledWith({ kind: 'clue', id: 'clue-1', sessionId: 'session-1' })
    withCallback.dispose()
    const none = createTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    expect(none.sources[1]!.openReference!(SESSION, { ref: 'pack-1' })).toBe(false)
    none.dispose()
    const [candidate] = await created.sources[0]!.candidates(SESSION, request(''))
    expect(typeof candidate!.icon).toBe('function')
    const Icon = candidate!.icon as (props: { size?: number }) => ReactNode
    // The installed host menu passes size:14; the 16px factory default is only the fallback.
    expect(renderToStaticMarkup(createElement(Icon, { size: 14 }))).toContain('icon:14')
    expect(renderToStaticMarkup(createElement(Icon, {}))).toContain('icon:16')
  })
  it('registers both sources inside the injected inputTriggers scope, disposes the Fiber and warns without a seam', () => {
    const { face } = makeFace()
    let injectCallback: ((injected: unknown) => (() => void) | void) | undefined
    const fiberDispose = vi.fn()
    const ctx = {
      betterSidebar: { clues: face },
      // Cordis ctx.inject returns a Fiber (also PromiseLike), NOT a callable disposer.
      inject: (deps: readonly string[], callback: (injected: unknown) => (() => void) | void) => {
        expect(deps).toEqual(['inputTriggers'])
        injectCallback = callback
        return { dispose: fiberDispose, then: () => { throw new Error('not awaited in this test') } }
      },
      logger: { warn: vi.fn() },
    } as unknown as Context
    const dispose = installClueInputTriggers(ctx, { resolveWorkspaceId: () => 'ws-1' })
    const captured = captureSources()
    const inner = injectCallback!({ inputTriggers: captured.service }) as () => void
    expect([...captured.sources.keys()]).toEqual([CLUE_CODEC_SOURCE, PACK_CODEC_SOURCE])
    inner()
    expect(captured.sources.size).toBe(0)
    dispose()
    dispose()
    expect(fiberDispose).toHaveBeenCalledTimes(1)
    const warn = vi.fn()
    for (const missing of [{ inject: vi.fn(), logger: { warn } }, { betterSidebar: { clues: face }, logger: { warn } }] as unknown as Context[])
      expect(() => installClueInputTriggers(missing, { resolveWorkspaceId: () => 'ws-1' })()).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(2)
  })
})
