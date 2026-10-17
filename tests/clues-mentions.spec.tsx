/**
 * S5 composer `@` sources contract (client half).
 *
 * The harness is a fake clue face (`ctx.betterSidebar.clues`) plus a fake
 * `inputTriggers` service; no React tree is mounted. Pins:
 * - exactly two sources with the frozen codec names, both on `@`;
 * - empty query stays LOCAL (pinned clues / packs) and never calls
 *   `clues.sources()`;
 * - a non-empty query searches only enabled/mention-enabled sources, with
 *   bounded concurrency, cancellation and per-source failure isolation;
 * - every row carries a stable id (existing `clueId` or an explicit `ensure`);
 * - serialize emits only the token (no remote read) and the clipboard is the
 *   same stable reference;
 * - onPick uses only host-supported appearances and the injectable
 *   `openReference` callback, never a fabricated field;
 * - source icons are wrapped (node or size-aware factory, 16px default);
 * - registration/disposal follows the injected Cordis scope.
 */
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import {
  CLUE_CODEC_SOURCE,
  PACK_CODEC_SOURCE,
  type Clue,
  type ClueCandidate,
  type CluePack,
  type ClueSourceDescriptor,
  type ClueSourceDisplayDescriptor,
} from '../src/clues/types.ts'
import {
  createClueInputTriggers,
  installClueInputTriggers,
  type ClueCandidateRequest,
  type ClueInputTriggerSource,
  type ClueMentionsFace,
} from '../src/client/clues/mentions.ts'

const NOW = '2026-10-17T00:00:00.000Z'

/** One source descriptor fixture. */
function sourceDescriptor(sourceId: string, search = true): ClueSourceDescriptor {
  return {
    sourceId,
    name: `Name ${sourceId}`,
    order: 0,
    pluginId: 'test',
    types: [`${sourceId}.text`],
    transport: 'http',
    capabilities: { resolve: false, list: false, search, read: true, edit: false, portable: false },
  }
}

/** One clue fixture. */
function clue(id: string, sourceId = 'test.alpha', title = `Title ${id}`, typeId = `${sourceId}.text`): Clue {
  return {
    id,
    sourceId,
    typeId,
    locator: { id },
    title,
    workspaceId: 'ws-1',
    createdAt: NOW,
    updatedAt: NOW,
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
  readonly ensure?: (input: { sourceId: string; typeId: string; title: string }) => Promise<{ id: string; title: string }>
  readonly enabled?: (sourceId: string) => boolean
  readonly mentionEnabled?: (sourceId: string) => boolean
  readonly packsMention?: boolean
}

/** A fake clue extension face with vi.fn() wires. */
function makeFace(options: FaceOptions = {}) {
  const sources = options.sources ?? [sourceDescriptor('test.alpha')]
  const ensureCalls: Array<{ sourceId: string; typeId: string; title: string }> = []
  let ensureSequence = 0
  const api = {
    sources: vi.fn(async () => ({ sources: [...sources], types: [] })),
    search: vi.fn(async (workspaceId: string, input: { sourceId: string; query: string }, signal: AbortSignal) => {
      if (options.search !== undefined) {
        return { items: await options.search(workspaceId, input.sourceId, input.query, signal).then(result => result.items) }
      }
      return { items: [] }
    }),
    ensure: vi.fn(async (_workspaceId: string, input: { sourceId: string; typeId: string; title: string }) => {
      ensureCalls.push(input)
      const ensured = options.ensure === undefined
        ? { id: `ensured-${++ensureSequence}`, title: input.title }
        : await options.ensure(input)
      return { clue: clue(ensured.id, input.sourceId, ensured.title, input.typeId), created: true }
    }),
    pinsList: vi.fn(async () => ({
      pins: (options.pins ?? []).map(pin => ({ workspaceId: 'ws-1', clueId: pin.clueId, createdAt: NOW })),
      revision: 0,
    })),
    clues: vi.fn(async () => ({ clues: [...(options.library ?? [])], revision: 0 })),
    packsList: vi.fn(async () => ({ packs: [...(options.packs ?? [])], revision: 0 })),
    read: vi.fn(async () => {
      throw new Error('serialize must never read content')
    }),
  }
  const face: ClueMentionsFace = {
    api: api as unknown as ClueMentionsFace['api'],
    getSourceDisplays: () => options.displays ?? [],
    isSourceEnabled: options.enabled ?? (() => true),
    isSourceMentionEnabled: options.mentionEnabled ?? (() => true),
    isPacksMentionEnabled: () => options.packsMention ?? true,
  }
  return { face, api, ensureCalls }
}

/** One candidate request. */
function request(query: string, signal: AbortSignal = new AbortController().signal): ClueCandidateRequest {
  return { query, position: 'inline', drilled: false, signal }
}

const SESSION = { sessionId: 'session-1' }

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

describe('createClueInputTriggers: source identity and codecs', () => {
  it('registers exactly the two frozen codec names and serializes tokens only', async () => {
    const { face, api } = makeFace()
    const created = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
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
    const created = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    const controller = new AbortController()
    controller.abort()
    await expect(created.sources[0]!.codec!.serialize('clue-9', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    created.dispose()
  })
})

describe('clues source: empty query', () => {
  it('returns locally pinned clues only, in pin order, without a remote catalogue fetch', async () => {
    const { face, api } = makeFace({
      library: [clue('clue-1', 'test.alpha', 'Alpha'), clue('clue-2', 'test.alpha', 'Beta'), clue('clue-3', 'test.alpha', 'Gamma')],
      pins: [{ clueId: 'clue-2' }, { clueId: 'clue-1' }],
      displays: [{ sourceId: 'test.alpha', name: 'Alpha source' }],
    })
    const created = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    const candidates = await created.sources[0]!.candidates(SESSION, request(''))
    expect(candidates.map(row => row.label)).toEqual(['Beta', 'Alpha'])
    expect(candidates[0]!.description).toBe('Alpha source · test.alpha.text')
    expect(JSON.parse(candidates[0]!.value!)).toEqual({ kind: 'clue', id: 'clue-2', appearance: 'file' })
    expect(api.sources).not.toHaveBeenCalled()
    expect(api.search).not.toHaveBeenCalled()
    created.dispose()
  })

  it('onPick inserts the stable clue token with a host-supported appearance', async () => {
    const { face } = makeFace({
      library: [clue('clue-1', 'builtin.files', 'Notes', 'builtin.files.directory')],
      pins: [{ clueId: 'clue-1' }],
    })
    const created = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    const [candidate] = await created.sources[0]!.candidates(SESSION, request(''))
    const outcome = created.sources[0]!.onPick!({
      candidate: candidate!,
      session: SESSION,
      position: 'inline',
      via: 'menu',
      action: 'pick',
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

  it('stays local when the workspace is not ready and reports resolver failures', async () => {
    const onError = vi.fn()
    const { face, api } = makeFace({ pins: [{ clueId: 'clue-1' }], library: [clue('clue-1')] })
    const notReady = createClueInputTriggers({ face, resolveWorkspaceId: () => undefined })
    expect(await notReady.sources[0]!.candidates(SESSION, request(''))).toEqual([])
    expect(api.pinsList).not.toHaveBeenCalled()
    notReady.dispose()

    const failing = createClueInputTriggers({
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
    const created = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    const candidates = await created.sources[1]!.candidates(SESSION, request(''))
    expect(candidates.map(row => row.label)).toEqual(['Drafts', 'Reading list'])
    expect(candidates[0]!.label).toBe('Drafts')
    expect(api.sources).not.toHaveBeenCalled()
    expect(created.sources[1]!.onPick!({
      candidate: candidates[0]!,
      session: SESSION,
      position: 'inline',
      via: 'menu',
      action: 'pick',
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
    const created = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    expect((await created.sources[1]!.candidates(SESSION, request('read'))).map(row => row.label)).toEqual(['Reading list'])
    created.dispose()

    const off = createClueInputTriggers({
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
    const created = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1', onError })
    const candidates = await created.sources[0]!.candidates(SESSION, request('issue'))
    expect(api.search).toHaveBeenCalledTimes(2)
    expect(api.search.mock.calls.map(call => (call[1] as { sourceId: string }).sourceId).sort())
      .toEqual(['test.broken', 'test.healthy'])
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.label).toBe('test.healthy issue')
    expect(onError).toHaveBeenCalled()
    expect(JSON.stringify(candidates)).not.toContain('source-outage')
    created.dispose()
  })

  it('reuses an existing clueId and ensures only the rows that lack one', async () => {
    const { face, api, ensureCalls } = makeFace({
      sources: [sourceDescriptor('test.alpha')],
      search: async () => ({
        items: [
          { sourceId: 'test.alpha', typeId: 'test.alpha.text', locator: { id: 'a' }, title: 'Known', clueId: 'clue-known' },
          { sourceId: 'test.alpha', typeId: 'test.alpha.text', locator: { id: 'b' }, title: 'Fresh' },
        ],
      }),
    })
    const created = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    const candidates = await created.sources[0]!.candidates(SESSION, request('doc'))
    expect(ensureCalls).toHaveLength(1)
    expect(ensureCalls[0]!.title).toBe('Fresh')
    expect(candidates.map(row => row.name)).toEqual(['clue-known', 'ensured-1'])
    expect(candidates[1]!.label).toBe('Fresh')
    expect(api.read).not.toHaveBeenCalled()
    created.dispose()
  })

  it('drops a row whose ensure fails without failing the other rows', async () => {
    const onError = vi.fn()
    const { face } = makeFace({
      sources: [sourceDescriptor('test.alpha')],
      search: async () => ({
        items: [
          { sourceId: 'test.alpha', typeId: 'test.alpha.text', locator: { id: 'bad' }, title: 'Bad' },
          { sourceId: 'test.alpha', typeId: 'test.alpha.text', locator: { id: 'good' }, title: 'Good' },
        ],
      }),
      ensure: async (input) => {
        if (input.title === 'Bad') throw new Error('ensure failed for SECRET=abc')
        return { id: 'ensured-good', title: input.title }
      },
    })
    const created = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1', onError })
    const candidates = await created.sources[0]!.candidates(SESSION, request('doc'))
    expect(candidates.map(row => row.name)).toEqual(['ensured-good'])
    expect(onError).toHaveBeenCalled()
    expect(JSON.stringify(candidates)).not.toContain('SECRET=abc')
    created.dispose()
  })

  it('caps the merged result at the configured limit', async () => {
    const { face } = makeFace({
      sources: [sourceDescriptor('test.alpha')],
      search: async () => ({
        items: Array.from({ length: 5 }, (_, index) => ({
          sourceId: 'test.alpha',
          typeId: 'test.alpha.text',
          locator: { id: String(index) },
          title: `Row ${index}`,
          clueId: `clue-${index}`,
        })),
      }),
    })
    const created = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1', limit: 2 })
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
    const created = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    const pending = created.sources[0]!.candidates(SESSION, request('doc', controller.signal))
    await Promise.resolve()
    controller.abort()
    await expect(pending).resolves.toEqual([])
    created.dispose()
  })
})

describe('openReference and icons', () => {
  it('routes previews through the injectable callback and leaves the gesture on false', async () => {
    const { face } = makeFace({ packs: [pack('pack-1', 'P')] })
    const openReference = vi.fn(() => true)
    const created = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1', openReference })
    const [candidate] = await created.sources[1]!.candidates(SESSION, request(''))
    expect(created.sources[1]!.openReference!(SESSION, { ref: 'pack-1', appearance: 'folder' })).toBe(true)
    expect(openReference).toHaveBeenCalledWith({ kind: 'pack', id: 'pack-1', sessionId: 'session-1' })
    expect(candidate).toBeDefined()
    created.dispose()

    const none = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    expect(none.sources[1]!.openReference!(SESSION, { ref: 'pack-1' })).toBe(false)
    none.dispose()
  })

  it('wraps a size-aware source icon at the host 16px default', async () => {
    const { face } = makeFace({
      library: [clue('clue-1')],
      pins: [{ clueId: 'clue-1' }],
      displays: [{
        sourceId: 'test.alpha',
        icon: (size: number) => createElement('span', null, `icon:${size}`),
      }],
    })
    const created = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    const [candidate] = await created.sources[0]!.candidates(SESSION, request(''))
    expect(typeof candidate!.icon).toBe('function')
    const html = renderToStaticMarkup(createElement(candidate!.icon as () => ReactNode))
    expect(html).toContain('icon:16')
    created.dispose()
  })
})

describe('installClueInputTriggers', () => {
  it('registers both sources inside the injected inputTriggers scope and releases them', () => {
    const { face } = makeFace()
    let injectCallback: ((injected: unknown) => (() => void) | void) | undefined
    const offInject = vi.fn()
    const ctx = {
      betterSidebar: { clues: face },
      inject: (deps: readonly string[], callback: (injected: unknown) => (() => void) | void) => {
        expect(deps).toEqual(['inputTriggers'])
        injectCallback = callback
        return offInject
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
    expect(offInject).toHaveBeenCalledTimes(1)
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
