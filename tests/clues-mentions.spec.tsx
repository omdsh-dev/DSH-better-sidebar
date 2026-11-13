/**
 * S5 composer `@` sources contract (client half).
 *
 * The harness is a fake clue face (`ctx.betterSidebar.clues`) plus a fake
 * `inputTriggers` service; no React tree is mounted. One integration case
 * drives the REAL clue service/store so the production search shape (raw
 * source candidates WITHOUT a clueId) is exercised, not assumed.
 *
 * Pins:
 * - exactly two sources with the frozen codec names, both on `@`;
 * - empty query stays LOCAL: bounded recent library clues + pins (clues
 *   source) and the local pack library (packs source); no `clues.sources()`;
 * - a non-empty query searches only enabled/mention-enabled sources, with
 *   bounded concurrency, cancellation and per-source failure isolation;
 * - browsing NEVER calls `clues.ensure`: every hit is offered with its REAL
 *   title (stored hits reuse the stable row), and a not-yet-stored hit is
 *   persisted only after the user picks it;
 * - every row shows only the real title: `name === label === title`, no
 *   description, no UUID alias and no "include content" duplicate;
 * - a stored pick returns the normal insert outcome (the host applies its own
 *   pick span); a not-yet-stored pick starts `clues.ensure` synchronously,
 *   answers `'handled'`, and inserts at the ORIGINAL pick span through the
 *   injected tail; a lost draftRev CAS or a refused insert asks for `@` again;
 * - historical content-mode refs stay decodable: the frozen codecs still
 *   serialize current content at submit time and fail loudly (draft kept);
 * - candidate rows use only host-supported appearances and the injectable
 *   `openReference` callback, never a fabricated field;
 * - source icons are wrapped (node or size-aware factory, 16px default);
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
import {
  CLUE_CODEC_SOURCE,
  PACK_CODEC_SOURCE,
  type Clue,
  type ClueCandidate,
  type CluePack,
  type ClueReadResult,
  type ClueSourceDescriptor,
  type ClueSourceDisplayDescriptor,
  type CluesEnsureResult,
} from '../src/clues/types.ts'
import {
  createCluesService,
  type ClueSourceRegistration,
  type CluesService,
} from '../src/clues/service.ts'
import type {
  ClueClientEnsureInput,
  ClueClientResourceInput,
  ClueClientSearchInput,
} from '../src/client/clues/api.ts'
import {
  createClueInputTriggers,
  installClueInputTriggers,
  type ClueCandidateRequest,
  type ClueInputCandidate,
  type ClueInputTriggerSource,
  type ClueMentionsFace,
  type ClueReferenceSpan,
} from '../src/client/clues/mentions.ts'
import { removeTree } from './temp-tree.ts'

const NOW = '2026-10-17T00:00:00.000Z'
const roots: string[] = []

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-clues-mentions-'))
  roots.push(path)
  return path
}

afterEach(() => {
  for (const path of roots.splice(0)) removeTree(path)
})

/** One source descriptor fixture. */
function sourceDescriptor(sourceId: string, search = true, read = true): ClueSourceDescriptor {
  return {
    sourceId,
    name: `Name ${sourceId}`,
    order: 0,
    pluginId: 'test',
    types: [`${sourceId}.text`],
    transport: 'http',
    capabilities: { resolve: false, list: false, search, read, edit: false, portable: false },
  }
}

/** One clue fixture. */
function clue(id: string, sourceId = 'test.alpha', title = `Title ${id}`, typeId = `${sourceId}.text`, updatedAt = NOW): Clue {
  return {
    id,
    sourceId,
    typeId,
    locator: { id },
    title,
    workspaceId: 'ws-1',
    createdAt: NOW,
    updatedAt,
  }
}

/** One pack fixture. */
function pack(id: string, name: string, members: string[] = []): CluePack {
  return {
    id,
    name,
    workspaceId: 'ws-1',
    members,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }
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
  readonly enabled?: (sourceId: string) => boolean
  readonly mentionEnabled?: (sourceId: string) => boolean
  readonly packsMention?: boolean
}

/** A fake clue extension face with vi.fn() wires. */
function makeFace(options: FaceOptions = {}) {
  const sources = options.sources ?? [sourceDescriptor('test.alpha')]
  const defaultRead = async (input: { readonly clueId: string }): Promise<ClueReadResult> => ({
    format: 'text/plain',
    data: { text: `body:${input.clueId}` },
    text: `body:${input.clueId}`,
    fetchedAt: NOW,
    freshness: 'live',
  })
  let ensured = 0
  const api = {
    sources: vi.fn(async () => ({ sources: [...sources], types: [] })),
    search: vi.fn(async (workspaceId: string, input: { sourceId: string; query: string }, signal: AbortSignal) => {
      if (options.search !== undefined) {
        return { items: await options.search(workspaceId, input.sourceId, input.query, signal).then(result => result.items) }
      }
      return { items: [] }
    }),
    // Browsing must never ensure: the default keeps that a loud contract
    // violation, and the pick tests supply an explicit implementation.
    ensure: vi.fn(async (
      workspaceId: string,
      input: { sourceId: string; typeId: string; locator: unknown; title: string },
    ): Promise<CluesEnsureResult> => {
      if (options.ensure !== undefined) return options.ensure(workspaceId, input)
      ensured += 1
      return {
        clue: {
          ...clue(`ensured-${ensured}`, input.sourceId, input.title, input.typeId),
          locator: input.locator as Clue['locator'],
        },
        created: true,
      }
    }),
    pinsList: vi.fn(async () => ({
      pins: (options.pins ?? []).map(pin => ({ workspaceId: 'ws-1', clueId: pin.clueId, createdAt: NOW })),
      revision: 0,
    })),
    clues: vi.fn(async () => ({ clues: [...(options.library ?? [])], revision: 0 })),
    packsList: vi.fn(async () => ({ packs: [...(options.packs ?? [])], revision: 0 })),
    read: vi.fn(async (workspaceId: string, input: { readonly clueId: string; readonly sessionId?: string }, signal: AbortSignal) => (
      options.read === undefined ? defaultRead(input) : options.read(workspaceId, input, signal)
    )),
    ...(options.readFresh === undefined ? {} : {
      readFresh: vi.fn(async (
        workspaceId: string,
        input: { readonly clueId: string; readonly sessionId?: string },
        signal: AbortSignal,
      ) => options.readFresh!(workspaceId, input, signal)),
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

/**
 * Create the two sources with the search debounce disabled unless a test opts
 * in: the contract cases must not spend 300 ms per non-empty query. The
 * debounce timing itself is pinned by the fake-timer cases below.
 */
function createTriggers(options: Parameters<typeof createClueInputTriggers>[0]) {
  return createClueInputTriggers({ searchDebounceMs: 0, ...options })
}

/** One candidate request. */
function request(query: string, signal: AbortSignal = new AbortController().signal): ClueCandidateRequest {
  return { query, position: 'inline', drilled: false, signal }
}

const SESSION = { sessionId: 'session-1' }

/** One parsed candidate value. */
interface CandidateValue {
  readonly kind: 'clue' | 'pack'
  readonly id?: string
  readonly sourceId?: string
  readonly typeId?: string
  readonly locator?: { id: string }
  readonly title?: string
  readonly mode?: 'content'
  readonly appearance?: string
  readonly workspaceId?: string
}

/** Parse one candidate value produced by the module. */
function valueOf(candidate: ClueInputCandidate): CandidateValue {
  return JSON.parse(candidate.value!) as CandidateValue
}

/** One pick-time span fixture. */
function spanOf(draftRev = 1, start = 0, end = 0): ClueReferenceSpan {
  return { start, end, draftRev }
}

/** Register a source list through a fake trigger service. */
function captureSources(): {
  service: { registerSource(source: ClueInputTriggerSource): () => void }
  sources: Map<string, ClueInputTriggerSource>
} {
  const sources = new Map<string, ClueInputTriggerSource>()
  return {
    sources,
    service: {
      registerSource(source: ClueInputTriggerSource): () => void {
        sources.set(source.name, source)
        return () => { sources.delete(source.name) }
      },
    },
  }
}

/** Build the real-service clue face (production search shape, no fakes). */
function realFace(service: CluesService): ClueMentionsFace {
  return {
    api: {
      sources: async () => ({ sources: service.getSources(), types: service.getTypes() }),
      search: (workspaceId: string, input: ClueClientSearchInput, signal: AbortSignal) =>
        service.search({ workspaceId, ...input } as Parameters<CluesService['search']>[0], { signal }),
      clues: (workspaceId: string) => service.listClues(workspaceId),
      ensure: (workspaceId: string, input: ClueClientEnsureInput, signal: AbortSignal) =>
        service.ensure({ workspaceId, ...input }, { signal }),
      pinsList: (workspaceId: string) => service.listPins(workspaceId),
      packsList: (workspaceId: string) => service.listPacks(workspaceId),
      read: (workspaceId: string, input: ClueClientResourceInput, signal: AbortSignal) =>
        service.read({ workspaceId, ...input }, { signal }),
    } as unknown as ClueMentionsFace['api'],
    getSourceDisplays: () => [],
    isSourceEnabled: () => true,
    isSourceMentionEnabled: () => true,
    isPacksMentionEnabled: () => true,
  }
}

/** One real source with search + read; search deliberately returns raw candidates. */
function realSearchSource(): ClueSourceRegistration {
  const sourceId = 'test.real'
  const typeId = 'test.real.text'
  return {
    descriptor: {
      sourceId,
      name: sourceId,
      order: 0,
      pluginId: 'test',
      types: [typeId],
      transport: 'http',
      capabilities: { resolve: false, list: false, search: true, read: true, edit: false, portable: false },
    },
    types: [{
      typeId,
      sourceId,
      formats: ['text/plain'],
      capabilities: { read: true, edit: false, concurrency: 'none' },
    }],
    operations: {
      search: async () => ({
        items: [
          { sourceId, typeId, locator: { id: 'a' }, title: 'Known A' },
          { sourceId, typeId, locator: { id: 'b' }, title: 'Fresh B' },
        ],
      }),
      read: async (input) => ({
        format: 'text/plain',
        data: { text: `body:${String(input.locator.id)}` },
        text: `body:${String(input.locator.id)}`,
        fetchedAt: NOW,
        freshness: 'live',
      }),
    },
  }
}

describe('createClueInputTriggers: source identity and codecs', () => {
  it('registers exactly the two frozen codec names and serializes tokens only', async () => {
    const { face, api } = makeFace()
    const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    expect(created.sources.map(source => source.name)).toEqual([CLUE_CODEC_SOURCE, PACK_CODEC_SOURCE])
    expect(created.sources.every(source => source.trigger === '@')).toBe(true)
    const signal = new AbortController().signal
    await expect(created.sources[0]!.codec!.serialize('clue-9', signal)).resolves.toBe('[[dsh-clue:clue-9]]')
    await expect(created.sources[1]!.codec!.serialize('pack-9', signal)).resolves.toBe('[[dsh-cluepack:pack-9]]')
    expect(created.sources[0]!.codec!.clipboardText('clue-9')).toBe('[[dsh-clue:clue-9]]')
    expect(created.sources[1]!.codec!.clipboardText('pack-9')).toBe('[[dsh-cluepack:pack-9]]')
    // The codec must not consult the wire read method.
    expect(api.read).not.toHaveBeenCalled()
    created.dispose()
  })

  it('blocks serialization for an aborted send attempt', async () => {
    const { face } = makeFace()
    const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    const controller = new AbortController()
    controller.abort()
    await expect(created.sources[0]!.codec!.serialize('clue-9', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    created.dispose()
  })

  it('refuses an id that cannot be represented instead of emitting a bare id', async () => {
    const { face } = makeFace()
    const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    const signal = new AbortController().signal
    await expect(created.sources[0]!.codec!.serialize('bad id', signal)).rejects.toMatchObject({ category: 'invalid-request' })
    await expect(created.sources[1]!.codec!.serialize('bad]]id', signal)).rejects.toMatchObject({ category: 'invalid-request' })
    expect(() => created.sources[0]!.codec!.clipboardText('bad id')).toThrow()
    created.dispose()
  })
})

describe('clues source: empty query', () => {
  it('returns bounded recent clues plus pins, newest first, without a remote catalogue fetch', async () => {
    const { face, api } = makeFace({
      library: [
        clue('clue-1', 'test.alpha', 'Alpha', undefined, '2026-10-15T00:00:00.000Z'),
        clue('clue-2', 'test.alpha', 'Beta', undefined, '2026-10-18T00:00:00.000Z'),
        clue('clue-3', 'test.alpha', 'Gamma', undefined, '2026-10-16T00:00:00.000Z'),
      ],
      pins: [{ clueId: 'clue-3' }],
      displays: [{ sourceId: 'test.alpha', name: 'Alpha source' }],
    })
    const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1', limit: 3 })
    const candidates = await created.sources[0]!.candidates(SESSION, request(''))
    // Pins first (explicit shortcuts), then the recent slice minus the pin.
    expect(candidates.map(row => row.label)).toEqual(['Gamma', 'Beta', 'Alpha'])
    expect(api.sources).not.toHaveBeenCalled()
    expect(api.search).not.toHaveBeenCalled()
    expect(api.ensure).not.toHaveBeenCalled()
    created.dispose()
  })

  it('bounds the merged recent + pin list at the configured limit', async () => {
    const library = Array.from({ length: 6 }, (_, index) =>
      clue(`clue-${index}`, 'test.alpha', `Row ${index}`, undefined, `2026-10-1${index}T00:00:00.000Z`))
    const { face } = makeFace({ library, pins: [{ clueId: 'clue-0' }] })
    const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1', limit: 2 })
    const candidates = await created.sources[0]!.candidates(SESSION, request(''))
    expect(candidates).toHaveLength(2)
    expect(candidates.map(row => row.label)).toEqual(['Row 0', 'Row 5'])
    created.dispose()
  })

  it('onPick returns the stable clue token with a host-supported appearance', async () => {
    const { face } = makeFace({
      library: [clue('clue-1', 'builtin.files', 'Notes', 'builtin.files.directory')],
      pins: [{ clueId: 'clue-1' }],
    })
    const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    const [candidate] = await created.sources[0]!.candidates(SESSION, request(''))
    const outcome = created.sources[0]!.onPick!({
      candidate: candidate!,
      session: SESSION,
      position: 'inline',
      via: 'menu',
      action: 'pick',
      span: spanOf(1, 0, 4),
    })
    expect(outcome).toEqual({
      insert: {
        source: CLUE_CODEC_SOURCE,
        ref: 'clue-1',
        label: 'Notes',
        appearance: 'folder',
        clipboardText: '[[dsh-clue:clue-1]]',
      },
    })
    created.dispose()
  })

  it('shows only real titles: no UUID alias, no description, no duplicate content row', async () => {
    const { face } = makeFace({
      library: [clue('clue-1', 'test.alpha', 'A readable title')],
      pins: [{ clueId: 'clue-1' }],
      packs: [pack('pack-1', 'A readable pack', ['clue-1'])],
    })
    const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    const clues = await created.sources[0]!.candidates(SESSION, request(''))
    expect(clues).toHaveLength(1)
    expect(clues.every(candidate => candidate.name === candidate.label && candidate.description === undefined)).toBe(true)
    expect(clues.map(candidate => candidate.name)).toEqual(['A readable title'])
    expect(valueOf(clues[0]!).mode).toBeUndefined()
    const packs = await created.sources[1]!.candidates(SESSION, request(''))
    expect(packs).toHaveLength(1)
    expect(packs.every(candidate => candidate.name === candidate.label && candidate.description === undefined)).toBe(true)
    created.dispose()
  })

  it('stays local when the workspace is not ready and reports resolver failures', async () => {
    const onError = vi.fn()
    const { face, api } = makeFace({ pins: [{ clueId: 'clue-1' }], library: [clue('clue-1')] })
    const notReady = createTriggers({ face, resolveWorkspaceId: () => undefined })
    expect(await notReady.sources[0]!.candidates(SESSION, request(''))).toEqual([])
    expect(api.pinsList).not.toHaveBeenCalled()
    notReady.dispose()

    const failing = createTriggers({
      face,
      resolveWorkspaceId: () => { throw new Error('workspace service offline') },
      onError,
    })
    expect(await failing.sources[0]!.candidates(SESSION, request(''))).toEqual([])
    expect(onError).toHaveBeenCalled()
    failing.dispose()
  })
})

describe('packs source', () => {
  it('lists local packs on an empty query, newest first, and inserts pack tokens', async () => {
    const first = pack('pack-1', 'Reading list', ['clue-1'])
    const second = { ...pack('pack-2', 'Drafts', ['clue-1', 'clue-2']), updatedAt: '2026-10-18T00:00:00.000Z' }
    const { face, api } = makeFace({ packs: [first, second] })
    const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    const candidates = await created.sources[1]!.candidates(SESSION, request(''))
    expect(candidates.map(row => row.label)).toEqual(['Drafts', 'Reading list'])
    expect(api.sources).not.toHaveBeenCalled()
    expect(created.sources[1]!.onPick!({
      candidate: candidates[0]!,
      session: SESSION,
      position: 'inline',
      via: 'menu',
      action: 'pick',
      span: spanOf(1, 0, 2),
    })).toEqual({
      insert: {
        source: PACK_CODEC_SOURCE,
        ref: 'pack-2',
        label: 'Drafts',
        appearance: 'folder',
        clipboardText: '[[dsh-cluepack:pack-2]]',
      },
    })
    created.dispose()
  })

  it('filters by name on a non-empty query and honours the @ switch', async () => {
    const { face } = makeFace({ packs: [pack('pack-1', 'Reading list'), pack('pack-2', 'Drafts')] })
    const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    expect((await created.sources[1]!.candidates(SESSION, request('read'))).map(row => row.label))
      .toEqual(['Reading list'])
    created.dispose()

    const off = createTriggers({
      face: makeFace({ packsMention: false }).face,
      resolveWorkspaceId: () => 'ws-1',
    })
    expect(await off.sources[1]!.candidates(SESSION, request(''))).toEqual([])
    off.dispose()
  })
})

describe('clues source: non-empty query', () => {
  it('searches only enabled, mention-enabled sources and isolates per-source failures', async () => {
    const onError = vi.fn()
    const broken = sourceDescriptor('test.broken')
    const disabled = sourceDescriptor('test.disabled')
    const hidden = sourceDescriptor('test.hidden')
    const healthy = sourceDescriptor('test.healthy')
    const { face, api } = makeFace({
      sources: [broken, disabled, hidden, healthy],
      library: [{
        ...clue('clue-healthy', 'test.healthy', 'test.healthy issue'),
        locator: { id: 'test.healthy:issue' },
      }],
      enabled: sourceId => sourceId !== 'test.disabled',
      mentionEnabled: sourceId => sourceId !== 'test.hidden',
      search: async (_workspaceId, sourceId, query) => {
        if (sourceId === 'test.broken') throw new Error('SECRET=source-outage')
        return {
          items: [{
            sourceId,
            typeId: `${sourceId}.text`,
            locator: { id: `${sourceId}:${query}` },
            title: `${sourceId} ${query}`,
          }],
        }
      },
    })
    const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1', onError })
    const candidates = await created.sources[0]!.candidates(SESSION, request('issue'))
    expect(api.search).toHaveBeenCalledTimes(2)
    expect(api.search.mock.calls.map(call => (call[1] as { sourceId: string }).sourceId).sort())
      .toEqual(['test.broken', 'test.healthy'])
    expect(candidates.map(row => row.label)).toEqual(['test.healthy issue'])
    expect(api.ensure).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalled()
    expect(JSON.stringify(candidates)).not.toContain('source-outage')
    created.dispose()
  })

  it('offers every hit with its real title and reuses a stored clue without ensuring', async () => {
    const { face, api } = makeFace({
      sources: [sourceDescriptor('test.alpha')],
      library: [{ ...clue('clue-known', 'test.alpha', 'Known'), locator: { id: 'a' } }],
      search: async () => ({
        // Production search does NOT add clueId (the real service is covered below).
        items: [
          { sourceId: 'test.alpha', typeId: 'test.alpha.text', locator: { id: 'a' }, title: 'Search title A' },
          { sourceId: 'test.alpha', typeId: 'test.alpha.text', locator: { id: 'b' }, title: 'Fresh B' },
        ],
      }),
    })
    const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    const candidates = await created.sources[0]!.candidates(SESSION, request('doc'))
    expect(candidates.map(row => row.label)).toEqual(['Known', 'Fresh B'])
    expect(candidates.every(row => row.name === row.label && row.description === undefined)).toBe(true)
    expect(valueOf(candidates[0]!).id).toBe('clue-known')
    expect(valueOf(candidates[1]!).id).toBeUndefined()
    expect(valueOf(candidates[1]!)).toMatchObject({
      kind: 'clue',
      sourceId: 'test.alpha',
      typeId: 'test.alpha.text',
      locator: { id: 'b' },
      title: 'Fresh B',
      workspaceId: 'ws-1',
    })
    expect(api.ensure).not.toHaveBeenCalled()
    expect(api.read).not.toHaveBeenCalled()
    created.dispose()
  })

  it('caps the merged rows at the configured limit', async () => {
    const library = Array.from({ length: 5 }, (_, index) => ({
      ...clue(`clue-${index}`, 'test.alpha', `Row ${index}`),
      locator: { id: String(index) },
    }))
    const { face } = makeFace({
      sources: [sourceDescriptor('test.alpha')],
      library,
      search: async () => ({
        items: Array.from({ length: 5 }, (_, index) => ({
          sourceId: 'test.alpha',
          typeId: 'test.alpha.text',
          locator: { id: String(index) },
          title: `Row ${index}`,
        })),
      }),
    })
    const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1', limit: 2 })
    expect(await created.sources[0]!.candidates(SESSION, request('row'))).toHaveLength(2)
    created.dispose()
  })

  it('cancels in-flight searches and drops their late results', async () => {
    const controller = new AbortController()
    const search = vi.fn(async (_workspaceId: string, _sourceId: string, _query: string, signal: AbortSignal) => {
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
      return { items: [] }
    })
    const { face } = makeFace({ sources: [sourceDescriptor('test.alpha')], search })
    const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    const pending = created.sources[0]!.candidates(SESSION, request('doc', controller.signal))
    await Promise.resolve()
    controller.abort()
    await expect(pending).resolves.toEqual([])
    created.dispose()
  })

  it('hides a stored clue id that cannot be represented as a stable token', async () => {
    const onError = vi.fn()
    const { face } = makeFace({
      library: [clue('bad id')],
      pins: [{ clueId: 'bad id' }],
    })
    const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1', onError })
    expect(await created.sources[0]!.candidates(SESSION, request(''))).toEqual([])
    expect(onError).toHaveBeenCalled()
    created.dispose()
  })
})

describe('non-empty query debounce (search storm control)', () => {
  it('settles only the trailing keystroke: overlapping candidates search once and cancelled calls resolve promptly', async () => {
    vi.useFakeTimers()
    try {
      const { face, api } = makeFace({
        sources: [sourceDescriptor('test.alpha')],
        search: async () => ({ items: [] }),
      })
      const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1', searchDebounceMs: 300 })

      const first = new AbortController()
      const p1 = created.sources[0]!.candidates(SESSION, request('un', first.signal))
      await vi.advanceTimersByTimeAsync(100)
      expect(api.search).not.toHaveBeenCalled()
      first.abort()
      // Cancellation is immediate: the superseded round never waits out the
      // 300 ms window and never searches.
      await expect(p1).resolves.toEqual([])

      const second = new AbortController()
      const p2 = created.sources[0]!.candidates(SESSION, request('uns', second.signal))
      await vi.advanceTimersByTimeAsync(100)
      second.abort()
      await expect(p2).resolves.toEqual([])

      const third = new AbortController()
      const p3 = created.sources[0]!.candidates(SESSION, request('unseen', third.signal))
      await vi.advanceTimersByTimeAsync(299)
      expect(api.search).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await expect(p3).resolves.toEqual([])
      expect(api.search).toHaveBeenCalledTimes(1)
      expect((api.search.mock.calls[0]![1] as { query: string }).query).toBe('unseen')
      created.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a pending debounce when the sources are disposed', async () => {
    vi.useFakeTimers()
    try {
      const { face, api } = makeFace({
        sources: [sourceDescriptor('test.alpha')],
        search: async () => ({ items: [] }),
      })
      const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1', searchDebounceMs: 300 })
      const pending = created.sources[0]!.candidates(SESSION, request('un'))
      created.dispose()
      await expect(pending).resolves.toEqual([])
      expect(api.search).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(300)
      expect(api.search).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('serves an empty query immediately without the debounce window', async () => {
    vi.useFakeTimers()
    try {
      const { face, api } = makeFace({
        library: [clue('clue-1')],
        pins: [{ clueId: 'clue-1' }],
      })
      const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1', searchDebounceMs: 300 })
      const pending = created.sources[0]!.candidates(SESSION, request(''))
      await vi.advanceTimersByTimeAsync(0)
      await expect(pending).resolves.toHaveLength(1)
      expect(api.search).not.toHaveBeenCalled()
      created.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('picking a not-yet-stored search hit', () => {
  it('ensures exactly once on pick, then inserts at the ORIGINAL pick span', async () => {
    const { face, api } = makeFace({
      sources: [sourceDescriptor('test.alpha')],
      search: async () => ({
        items: [{ sourceId: 'test.alpha', typeId: 'test.alpha.text', locator: { id: 'b' }, title: 'Fresh B' }],
      }),
    })
    const insertReference = vi.fn((_reference: unknown, _session: unknown, _span: unknown) => 'inserted' as const)
    const created = createTriggers({
      face,
      resolveWorkspaceId: () => 'ws-1',
      insertReference,
    })
    const [candidate] = await created.sources[0]!.candidates(SESSION, request('doc'))
    expect(api.ensure).not.toHaveBeenCalled()

    const span = spanOf(7, 3, 8)
    const outcome = created.sources[0]!.onPick!({
      candidate: candidate!,
      session: SESSION,
      position: 'inline',
      via: 'menu',
      action: 'pick',
      span,
    })
    // Synchronous answer: the host must not insert anything on its own.
    expect(outcome).toBe('handled')
    await vi.waitFor(() => expect(insertReference).toHaveBeenCalledTimes(1))
    expect(api.ensure).toHaveBeenCalledTimes(1)
    expect(api.ensure.mock.calls[0]![0]).toBe('ws-1')
    expect(api.ensure.mock.calls[0]![1]).toEqual({
      sourceId: 'test.alpha',
      typeId: 'test.alpha.text',
      locator: { id: 'b' },
      title: 'Fresh B',
    })
    expect(insertReference).toHaveBeenCalledWith(
      {
        source: CLUE_CODEC_SOURCE,
        ref: 'ensured-1',
        label: 'Fresh B',
        appearance: 'file',
        clipboardText: '[[dsh-clue:ensured-1]]',
      },
      SESSION,
      span,
    )
    created.dispose()
  })

  it('keeps the draft and asks for @ again when the pick-time span went stale', async () => {
    const onNotice = vi.fn()
    const { face } = makeFace({
      sources: [sourceDescriptor('test.alpha')],
      search: async () => ({
        items: [{ sourceId: 'test.alpha', typeId: 'test.alpha.text', locator: { id: 'b' }, title: 'Fresh B' }],
      }),
    })
    const inserted = vi.fn((_reference: unknown, _session: unknown, _span: unknown) => 'stale' as const)
    const created = createTriggers({
      face,
      resolveWorkspaceId: () => 'ws-1',
      insertReference: inserted,
      onNotice,
    })
    const [candidate] = await created.sources[0]!.candidates(SESSION, request('doc'))
    expect(created.sources[0]!.onPick!({
      candidate: candidate!, session: SESSION, position: 'inline', via: 'menu', action: 'pick', span: spanOf(7),
    })).toBe('handled')
    await vi.waitFor(() => expect(onNotice).toHaveBeenCalledTimes(1))
    expect(onNotice.mock.calls[0]![0]).toContain('Type @ again')
    expect(onNotice.mock.calls[0]![0]).toContain('draft was left unchanged')
    created.dispose()
  })

  it('reports an ensure failure without inserting anything', async () => {
    const onNotice = vi.fn()
    const { face } = makeFace({
      sources: [sourceDescriptor('test.alpha')],
      search: async () => ({
        items: [{ sourceId: 'test.alpha', typeId: 'test.alpha.text', locator: { id: 'b' }, title: 'Fresh B' }],
      }),
      ensure: async () => { throw Object.assign(new Error('offline'), { code: 'unavailable' }) },
    })
    const inserted = vi.fn((_reference: unknown, _session: unknown, _span: unknown) => 'inserted' as const)
    const created = createTriggers({
      face,
      resolveWorkspaceId: () => 'ws-1',
      insertReference: inserted,
      onNotice,
    })
    const [candidate] = await created.sources[0]!.candidates(SESSION, request('doc'))
    created.sources[0]!.onPick!({
      candidate: candidate!, session: SESSION, position: 'inline', via: 'menu', action: 'pick', span: spanOf(7),
    })
    await vi.waitFor(() => expect(onNotice).toHaveBeenCalledTimes(1))
    expect(inserted).not.toHaveBeenCalled()
    expect(onNotice.mock.calls[0]![0]).toContain('draft was left unchanged')
    created.dispose()
  })

  it('never persists a hit when no insert tail is wired', async () => {
    const onNotice = vi.fn()
    const { face, api } = makeFace({
      sources: [sourceDescriptor('test.alpha')],
      search: async () => ({
        items: [{ sourceId: 'test.alpha', typeId: 'test.alpha.text', locator: { id: 'b' }, title: 'Fresh B' }],
      }),
    })
    const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1', onNotice })
    const [candidate] = await created.sources[0]!.candidates(SESSION, request('doc'))
    expect(created.sources[0]!.onPick!({
      candidate: candidate!, session: SESSION, position: 'inline', via: 'menu', action: 'pick', span: spanOf(7),
    })).toBe('handled')
    await Promise.resolve()
    expect(api.ensure).not.toHaveBeenCalled()
    expect(onNotice).toHaveBeenCalledTimes(1)
    created.dispose()
  })

  it('refuses a pick without a span and never ensures', async () => {
    const onNotice = vi.fn()
    const { face, api } = makeFace({
      sources: [sourceDescriptor('test.alpha')],
      search: async () => ({
        items: [{ sourceId: 'test.alpha', typeId: 'test.alpha.text', locator: { id: 'b' }, title: 'Fresh B' }],
      }),
    })
    const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1', onNotice })
    const [candidate] = await created.sources[0]!.candidates(SESSION, request('doc'))
    expect(created.sources[0]!.onPick!({
      candidate: candidate!, session: SESSION, position: 'inline', via: 'menu', action: 'pick',
    })).toBe('handled')
    expect(api.ensure).not.toHaveBeenCalled()
    expect(onNotice).toHaveBeenCalledTimes(1)
    created.dispose()
  })
})

describe('historical content-mode references stay decodable', () => {
  it('preserves comments and explicit incomplete coverage in a historical content send', async () => {
    const { face } = makeFace({ library: [clue('clue-1', 'test.alpha', 'Alpha')], readFresh: async () => ({
      format: 'text/plain', data: 'Current body', text: 'Current body', fetchedAt: NOW,
      discussion: { status: 'ok', coverage: 'document', fetchedAt: NOW, complete: false, nextCursor: 'comments-next',
        items: [{ id: 'comment-one', kind: 'comment', format: 'text/plain', body: 'A material comment' }] },
    }) })
    const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    const ref = `dsh-clue-content:v1:${JSON.stringify({ kind: 'clue', id: 'clue-1', workspaceId: 'ws-1' })}`
    const text = await created.sources[0]!.codec!.serialize(ref, new AbortController().signal)
    expect(text).toContain('Current body')
    expect(text).toContain('A material comment')
    expect(text).toContain('comments-next')
    expect(text).toContain('"complete": false')
    created.dispose()
  })
  it('keeps default serialization offline and reads live content for a stored content ref', async () => {
    const { face, api } = makeFace({ library: [clue('clue-1', 'test.alpha', 'Alpha')] })
    const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    const signal = new AbortController().signal
    const ref = `dsh-clue-content:v1:${JSON.stringify({
      kind: 'clue',
      id: 'clue-1',
      workspaceId: 'ws-1',
      sessionId: 'session-1',
    })}`
    expect(created.sources[0]!.codec!.clipboardText(ref)).toBe('[[dsh-clue:clue-1]]')
    const text = await created.sources[0]!.codec!.serialize(ref, signal)
    expect(text).toContain('[[dsh-clue:clue-1]]')
    expect(text).toContain('source test.alpha')
    expect(text).toContain(NOW)
    expect(text).toContain('freshness: live')
    expect(text).toContain('body:clue-1')
    expect(api.read).toHaveBeenCalledTimes(1)
    // The composer session travels with the content read (S2 §MCP).
    expect(api.read.mock.calls[0]![1]).toEqual({ clueId: 'clue-1', sessionId: 'session-1' })
    created.dispose()
  })

  it('reads a historical clue body through the fresh API, never the cached read', async () => {
    const readFresh = vi.fn(async (): Promise<ClueReadResult> => ({
      format: 'text/plain',
      data: { text: 'fresh body' },
      text: 'fresh body',
      fetchedAt: NOW,
      freshness: 'live',
    }))
    const { face, api } = makeFace({
      library: [clue('clue-1', 'test.alpha', 'Alpha')],
      readFresh,
    })
    const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    const ref = `dsh-clue-content:v1:${JSON.stringify({ kind: 'clue', id: 'clue-1', workspaceId: 'ws-1' })}`
    const text = await created.sources[0]!.codec!.serialize(ref, new AbortController().signal)
    expect(text).toContain('fresh body')
    expect(readFresh).toHaveBeenCalledTimes(1)
    // The stale cached read must not be used for send-time content.
    expect(api.read).not.toHaveBeenCalled()
    created.dispose()
  })

  it('protects the draft on content read failures, limits and partial pages', async () => {
    const auth = makeFace({
      library: [clue('clue-1')],
      read: async () => { throw Object.assign(new Error('authorization expired'), { code: 'auth-required' }) },
    })
    const created = createTriggers({ face: auth.face, resolveWorkspaceId: () => 'ws-1' })
    const authRef = `dsh-clue-content:v1:${JSON.stringify({ kind: 'clue', id: 'clue-1', workspaceId: 'ws-1' })}`
    await expect(created.sources[0]!.codec!.serialize(authRef, new AbortController().signal))
      .rejects.toMatchObject({ category: 'auth-required' })
    created.dispose()

    const long = makeFace({
      library: [clue('clue-1')],
      read: async () => ({
        format: 'text/plain',
        data: { text: 'x'.repeat(50) },
        text: 'x'.repeat(50),
        fetchedAt: NOW,
      }),
    })
    const limited = createTriggers({
      face: long.face,
      resolveWorkspaceId: () => 'ws-1',
      includeContentMaxChars: 20,
    })
    const error = await limited.sources[0]!.codec!.serialize(authRef, new AbortController().signal)
      .then(() => undefined, (reason: unknown) => reason)
    expect(error).toMatchObject({ category: 'invalid-request' })
    expect((error as Error).message).toMatch(/characters, over the 20-character limit/)
    expect((error as Error).message).toContain('draft was kept')
    limited.dispose()

    const paged = makeFace({
      library: [clue('clue-1')],
      read: async () => ({
        format: 'text/plain',
        data: { text: 'x' },
        text: 'x',
        fetchedAt: NOW,
        limited: true,
        nextOffset: 7,
      }),
    })
    const pagedCreated = createTriggers({ face: paged.face, resolveWorkspaceId: () => 'ws-1' })
    await expect(pagedCreated.sources[0]!.codec!.serialize(authRef, new AbortController().signal))
      .rejects.toMatchObject({ category: 'invalid-request' })
    pagedCreated.dispose()
  })

  it('projects every current pack member for a historical pack content ref', async () => {
    const readFresh = vi.fn(async (_workspaceId: string, input: { readonly clueId: string }): Promise<ClueReadResult> => ({
      format: 'text/plain',
      data: { text: `body:${input.clueId}` },
      text: `body:${input.clueId}`,
      fetchedAt: NOW,
      freshness: 'live',
    }))
    const { face, api } = makeFace({
      packs: [pack('pack-1', 'Reading list', ['clue-1', 'clue-2'])],
      library: [clue('clue-1', 'test.alpha', 'A'), clue('clue-2', 'test.alpha', 'B')],
      readFresh,
    })
    const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    const ref = `dsh-clue-content:v1:${JSON.stringify({ kind: 'pack', id: 'pack-1', workspaceId: 'ws-1' })}`
    expect(created.sources[1]!.codec!.clipboardText(ref)).toBe('[[dsh-cluepack:pack-1]]')
    const text = await created.sources[1]!.codec!.serialize(ref, new AbortController().signal)
    expect(text).toContain('[[dsh-cluepack:pack-1]]')
    expect(text).toContain('[[dsh-clue:clue-1]]')
    expect(text).toContain('[[dsh-clue:clue-2]]')
    expect(text).toContain('body:clue-1')
    expect(text).toContain('body:clue-2')
    // Every current member is a send-time read, so the cached body API is
    // never consulted for the pack projection.
    expect(readFresh).toHaveBeenCalledTimes(2)
    expect(api.read).not.toHaveBeenCalled()
    created.dispose()
  })

  it('rejects a cross-kind content ref and a malformed one', async () => {
    const { face } = makeFace()
    const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    const packRef = `dsh-clue-content:v1:${JSON.stringify({ kind: 'pack', id: 'pack-1', workspaceId: 'ws-1' })}`
    await expect(created.sources[0]!.codec!.serialize(packRef, new AbortController().signal))
      .rejects.toMatchObject({ category: 'invalid-request' })
    await expect(created.sources[0]!.codec!.serialize('dsh-clue-content:v1:{', new AbortController().signal))
      .rejects.toMatchObject({ category: 'invalid-request' })
    created.dispose()
  })
})

describe('real clue service integration', () => {
  it('never writes the library while searching, and ensures only on pick', async () => {
    let next = 0
    const service = createCluesService({
      root: tempRoot(),
      now: () => NOW,
      newId: kind => `${kind}-${++next}`,
    })
    service.registerSource(realSearchSource())
    try {
      const existing = await service.ensure({
        workspaceId: 'ws-1',
        sourceId: 'test.real',
        typeId: 'test.real.text',
        locator: { id: 'a' },
        title: 'Known A',
      })
      const rawSearch = await service.search({ workspaceId: 'ws-1', sourceId: 'test.real', query: 'doc' })
      // This is the production shape the fake tests used to hide.
      expect(rawSearch.items.every(item => item.clueId === undefined)).toBe(true)

      const before = await service.listClues('ws-1')
      const insertReference = vi.fn((_reference: unknown, _session: unknown, _span: unknown) => 'inserted' as const)
      const created = createTriggers({
        face: realFace(service),
        resolveWorkspaceId: () => 'ws-1',
        insertReference,
      })
      const first = await created.sources[0]!.candidates(SESSION, request('doc'))
      const afterBrowse = await service.listClues('ws-1')
      // S1 §3: a browse must not ensure a lightweight candidate.
      expect(afterBrowse.revision).toBe(before.revision)
      expect(afterBrowse.clues.map(clue => clue.id)).toEqual([existing.clue.id])
      // Both hits are shown with their real titles; the stored one reuses its stable row.
      expect(first.map(row => row.label)).toEqual(['Known A', 'Fresh B'])
      expect(valueOf(first[0]!).id).toBe(existing.clue.id)
      expect(valueOf(first[1]!).id).toBeUndefined()

      // Picking the unstored hit is the durable use: ensure writes ONE clue,
      // then the insert tail receives that stable id at the original span.
      const span = spanOf(9, 1, 6)
      expect(created.sources[0]!.onPick!({
        candidate: first[1]!, session: SESSION, position: 'inline', via: 'menu', action: 'pick', span,
      })).toBe('handled')
      await vi.waitFor(() => expect(insertReference).toHaveBeenCalledTimes(1))
      const afterPick = await service.listClues('ws-1')
      expect(afterPick.clues).toHaveLength(2)
      const ensured = afterPick.clues.find(clue => clue.title === 'Fresh B')!
      expect(insertReference.mock.calls[0]![0]).toMatchObject({
        ref: ensured.id,
        clipboardText: `[[dsh-clue:${ensured.id}]]`,
        label: 'Fresh B',
      })
      expect(insertReference.mock.calls[0]![1]).toEqual(SESSION)
      expect(insertReference.mock.calls[0]![2]).toEqual(span)

      // A second browse is still read-only.
      const second = await created.sources[0]!.candidates(SESSION, request('doc'))
      expect(second.map(row => row.label)).toEqual(['Known A', 'Fresh B'])
      expect((await service.listClues('ws-1')).revision).toBe(afterPick.revision)
      created.dispose()
    } finally {
      service.dispose()
    }
  })

  it('offers an imported unresolved row as a stable reference without remapping it on browse', async () => {
    let next = 0
    const service = createCluesService({
      root: tempRoot(),
      now: () => NOW,
      newId: kind => `${kind}-${++next}`,
    })
    service.registerSource(realSearchSource())
    try {
      const imported = await service.importUnresolved({
        workspaceId: 'ws-1',
        sourceId: 'test.real',
        typeId: 'test.real.text',
        locator: { id: 'a' },
        title: 'Imported A',
        reason: 'source offline at import time',
      })
      const before = await service.listClues('ws-1')
      expect(before.clues.find(clue => clue.id === imported.clue.id)?.unresolved).toBeDefined()

      const created = createTriggers({ face: realFace(service), resolveWorkspaceId: () => 'ws-1' })
      const rows = await created.sources[0]!.candidates(SESSION, request('doc'))
      // The stable id already exists, so the matching search hit reuses the
      // stored row (and its stored title) instead of minting a second one.
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

describe('openReference and icons', () => {
  it('routes previews through the injectable callback and leaves the gesture on false', async () => {
    const { face } = makeFace({ packs: [pack('pack-1', 'P')] })
    const openReference = vi.fn(() => true)
    const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1', openReference })
    const [candidate] = await created.sources[1]!.candidates(SESSION, request(''))
    expect(created.sources[1]!.openReference!(SESSION, { ref: 'pack-1', appearance: 'folder' })).toBe(true)
    expect(openReference).toHaveBeenCalledWith({ kind: 'pack', id: 'pack-1', sessionId: 'session-1' })
    expect(candidate).toBeDefined()
    created.dispose()

    const none = createTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    expect(none.sources[1]!.openReference!(SESSION, { ref: 'pack-1' })).toBe(false)
    none.dispose()
  })

  it('opens the underlying clue from a historical content-mode ref', async () => {
    const { face } = makeFace({ library: [clue('clue-1')] })
    const openReference = vi.fn(() => true)
    const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1', openReference })
    const ref = `dsh-clue-content:v1:${JSON.stringify({ kind: 'clue', id: 'clue-1', workspaceId: 'ws-1' })}`
    expect(created.sources[0]!.openReference!(SESSION, { ref, appearance: 'file' })).toBe(true)
    expect(openReference).toHaveBeenCalledWith({ kind: 'clue', id: 'clue-1', sessionId: 'session-1' })
    created.dispose()
  })

  it('wraps a size-aware source icon and honours the host-provided size', async () => {
    const { face } = makeFace({
      library: [clue('clue-1')],
      pins: [{ clueId: 'clue-1' }],
      displays: [{
        sourceId: 'test.alpha',
        icon: (size: number) => createElement('span', null, `icon:${size}`),
      }],
    })
    const created = createTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    const [candidate] = await created.sources[0]!.candidates(SESSION, request(''))
    expect(typeof candidate!.icon).toBe('function')
    const Icon = candidate!.icon as (props: { size?: number }) => ReactNode
    // The installed host menu passes size:14; the 16px factory default is only
    // the fallback, never a hard-coded override.
    expect(renderToStaticMarkup(createElement(Icon, { size: 14 }))).toContain('icon:14')
    expect(renderToStaticMarkup(createElement(Icon, {}))).toContain('icon:16')
    created.dispose()
  })
})

describe('installClueInputTriggers', () => {
  it('registers both sources inside the injected inputTriggers scope and disposes the Fiber', () => {
    const { face } = makeFace()
    let injectCallback: ((injected: unknown) => (() => void) | void) | undefined
    const fiberDispose = vi.fn()
    let disposedFiber = false
    const ctx = {
      betterSidebar: { clues: face },
      // Cordis `ctx.inject` returns a Fiber (also PromiseLike), NOT a callable
      // disposer. The fake must have this shape or the disposer bug hides.
      inject: (deps: readonly string[], callback: (injected: unknown) => (() => void) | void) => {
        expect(deps).toEqual(['inputTriggers'])
        injectCallback = callback
        return {
          dispose: () => {
            disposedFiber = true
            fiberDispose()
          },
          // PromiseLike<Fiber> members the real return value also carries.
          then: () => { throw new Error('not awaited in this test') },
        }
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
    expect(disposedFiber).toBe(true)
  })

  it('warns and no-ops when the clue face or the injection seam is absent', () => {
    const warn = vi.fn()
    const noFace = { inject: vi.fn(), logger: { warn } } as unknown as Context
    expect(() => installClueInputTriggers(noFace, { resolveWorkspaceId: () => 'ws-1' })()).not.toThrow()
    expect(warn).toHaveBeenCalled()

    const { face } = makeFace()
    const noInject = { betterSidebar: { clues: face }, logger: { warn } } as unknown as Context
    expect(() => installClueInputTriggers(noInject, { resolveWorkspaceId: () => 'ws-1' })()).not.toThrow()
    expect(warn).toHaveBeenCalled()
  })
})
