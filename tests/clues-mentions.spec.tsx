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
 * - empty query stays LOCAL (pinned clues / packs) and never calls
 *   `clues.sources()`;
 * - a non-empty query searches only enabled/mention-enabled sources, with
 *   bounded concurrency, cancellation and per-source failure isolation;
 * - browsing reuses library rows by sourceId + locator and does NOT rewrite
 *   the library for them; only genuinely new rows are ensured;
 * - every row offers an explicit content option; default serialization emits
 *   only the token (no remote read), content mode reads at submit time and
 *   rejects failures/limits so the host restores the draft;
 * - clipboard text is always the stable token, including content mode;
 * - candidate names are display titles (no UUID alias);
 * - onPick uses only host-supported appearances and the injectable
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
  type ClueContentPreview,
  type ClueInputCandidate,
  type ClueInputTriggerSource,
  type ClueMentionsFace,
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
  readonly read?: (workspaceId: string, input: { readonly clueId: string; readonly sessionId?: string }, signal: AbortSignal) => Promise<ClueReadResult>
  readonly enabled?: (sourceId: string) => boolean
  readonly mentionEnabled?: (sourceId: string) => boolean
  readonly packsMention?: boolean
}

/** A fake clue extension face with vi.fn() wires. */
function makeFace(options: FaceOptions = {}) {
  const sources = options.sources ?? [sourceDescriptor('test.alpha')]
  const ensureCalls: Array<{ sourceId: string; typeId: string; title: string }> = []
  let ensureSequence = 0
  const defaultRead = async (input: { readonly clueId: string }): Promise<ClueReadResult> => ({
    format: 'text/plain',
    data: { text: `body:${input.clueId}` },
    text: `body:${input.clueId}`,
    fetchedAt: NOW,
    freshness: 'live',
  })
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
    read: vi.fn(async (workspaceId: string, input: { readonly clueId: string; readonly sessionId?: string }, signal: AbortSignal) => (
      options.read === undefined ? defaultRead(input) : options.read(workspaceId, input, signal)
    )),
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

/** One parsed candidate value. */
interface CandidateValue {
  readonly kind: 'clue' | 'pack'
  readonly id: string
  readonly mode?: 'content'
  readonly appearance?: string
  readonly workspaceId?: string
}

/** Parse one candidate value produced by the module. */
function valueOf(candidate: ClueInputCandidate): CandidateValue {
  return JSON.parse(candidate.value!) as CandidateValue
}

/** Normal (reference-mode) rows only. */
function referenceRows(candidates: readonly ClueInputCandidate[]): ClueInputCandidate[] {
  return candidates.filter(candidate => valueOf(candidate).mode === undefined)
}

/** The content-mode row of one stable id. */
function contentRow(candidates: readonly ClueInputCandidate[], id: string): ClueInputCandidate {
  const found = candidates.find(candidate => {
    const value = valueOf(candidate)
    return value.id === id && value.mode === 'content'
  })
  if (found === undefined) throw new Error(`no content row for "${id}"`)
  return found
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

  it('refuses an id that cannot be represented instead of emitting a bare id', async () => {
    const { face } = makeFace()
    const created = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    const signal = new AbortController().signal
    await expect(created.sources[0]!.codec!.serialize('bad id', signal)).rejects.toMatchObject({ category: 'invalid-request' })
    await expect(created.sources[1]!.codec!.serialize('bad]]id', signal)).rejects.toMatchObject({ category: 'invalid-request' })
    expect(() => created.sources[0]!.codec!.clipboardText('bad id')).toThrow()
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
    expect(referenceRows(candidates).map(row => row.label)).toEqual(['Beta', 'Alpha'])
    expect(referenceRows(candidates)[0]!.description).toBe('Alpha source · test.alpha.text')
    expect(valueOf(referenceRows(candidates)[0]!)).toEqual({ kind: 'clue', id: 'clue-2', appearance: 'file' })
    // Every reference row also offers the explicit content mode.
    expect(contentRow(candidates, 'clue-2').label).toBe('Beta (include content)')
    expect(api.sources).not.toHaveBeenCalled()
    expect(api.search).not.toHaveBeenCalled()
    expect(api.ensure).not.toHaveBeenCalled()
    created.dispose()
  })

  it('onPick inserts the stable clue token with a host-supported appearance', async () => {
    const { face } = makeFace({
      library: [clue('clue-1', 'builtin.files', 'Notes', 'builtin.files.directory')],
      pins: [{ clueId: 'clue-1' }],
    })
    const created = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    const [candidate] = referenceRows(await created.sources[0]!.candidates(SESSION, request('')))
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

  it('uses display titles as candidate names, never the stable UUID', async () => {
    const { face } = makeFace({
      library: [clue('clue-1', 'test.alpha', 'A readable title')],
      pins: [{ clueId: 'clue-1' }],
      packs: [pack('pack-1', 'A readable pack', ['clue-1'])],
    })
    const created = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    const clues = await created.sources[0]!.candidates(SESSION, request(''))
    expect(clues.every(candidate => candidate.name === candidate.label)).toBe(true)
    expect(clues.map(candidate => candidate.name)).not.toContain('clue-1')
    const packs = await created.sources[1]!.candidates(SESSION, request(''))
    expect(packs.every(candidate => candidate.name === candidate.label)).toBe(true)
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
    expect(referenceRows(candidates).map(row => row.label)).toEqual(['Drafts', 'Reading list'])
    expect(referenceRows(candidates)[0]!.label).toBe('Drafts')
    expect(contentRow(candidates, 'pack-2').label).toBe('Drafts (include content)')
    expect(api.sources).not.toHaveBeenCalled()
    expect(created.sources[1]!.onPick!({
      candidate: referenceRows(candidates)[0]!,
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
    expect(referenceRows(await created.sources[1]!.candidates(SESSION, request('read'))).map(row => row.label))
      .toEqual(['Reading list'])
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
    expect(referenceRows(candidates)).toHaveLength(1)
    expect(referenceRows(candidates)[0]!.label).toBe('test.healthy issue')
    expect(contentRow(candidates, valueOf(referenceRows(candidates)[0]!).id)).toBeDefined()
    expect(onError).toHaveBeenCalled()
    expect(JSON.stringify(candidates)).not.toContain('source-outage')
    created.dispose()
  })

  it('reuses a library clue by sourceId + locator and ensures only the new row', async () => {
    const { face, api, ensureCalls } = makeFace({
      sources: [sourceDescriptor('test.alpha')],
      library: [{ ...clue('clue-known', 'test.alpha', 'Known'), locator: { id: 'a' } }],
      search: async () => ({
        // Production search does NOT add clueId (the real service is covered below).
        items: [
          { sourceId: 'test.alpha', typeId: 'test.alpha.text', locator: { id: 'a' }, title: 'Known' },
          { sourceId: 'test.alpha', typeId: 'test.alpha.text', locator: { id: 'b' }, title: 'Fresh' },
        ],
      }),
    })
    const created = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    const candidates = referenceRows(await created.sources[0]!.candidates(SESSION, request('doc')))
    expect(ensureCalls).toHaveLength(1)
    expect(ensureCalls[0]!.title).toBe('Fresh')
    expect(candidates.map(row => valueOf(row).id)).toEqual(['clue-known', 'ensured-1'])
    expect(candidates.map(row => row.label)).toEqual(['Known', 'Fresh'])
    expect(api.read).not.toHaveBeenCalled()
    created.dispose()
  })

  it('drops a row whose ensure fails, keeps the others and asks for a notice', async () => {
    const onError = vi.fn()
    const onNotice = vi.fn()
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
    const created = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1', onError, onNotice })
    const candidates = referenceRows(await created.sources[0]!.candidates(SESSION, request('doc')))
    expect(candidates.map(row => valueOf(row).id)).toEqual(['ensured-good'])
    expect(onError).toHaveBeenCalled()
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('draft was left unchanged'))
    expect(JSON.stringify(candidates)).not.toContain('SECRET=abc')
    created.dispose()
  })

  it('caps the logical rows at the configured limit and adds one content option each', async () => {
    const { face } = makeFace({
      sources: [sourceDescriptor('test.alpha')],
      search: async () => ({
        items: Array.from({ length: 5 }, (_, index) => ({
          sourceId: 'test.alpha',
          typeId: 'test.alpha.text',
          locator: { id: String(index) },
          title: `Row ${index}`,
        })),
      }),
    })
    const created = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1', limit: 2 })
    const candidates = await created.sources[0]!.candidates(SESSION, request('row'))
    expect(referenceRows(candidates)).toHaveLength(2)
    expect(candidates.filter(candidate => valueOf(candidate).mode === 'content')).toHaveLength(2)
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

  it('hides a stored clue id that cannot be represented as a stable token', async () => {
    const onError = vi.fn()
    const { face } = makeFace({
      library: [clue('bad id')],
      pins: [{ clueId: 'bad id' }],
    })
    const created = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1', onError })
    const candidates = await created.sources[0]!.candidates(SESSION, request(''))
    expect(candidates).toEqual([])
    expect(onError).toHaveBeenCalled()
    created.dispose()
  })
})

describe('localized copy', () => {
  it('uses caller-provided copy for labels, descriptions and refusal notices', async () => {
    const onNotice = vi.fn()
    const copy = {
      includeContentSuffix: '（含内容）',
      clueReferenceDescription: (source: string, type: string) => `来源：${source}／${type}`,
      clueContentDescription: (source: string, type: string) => `发送时：${source}／${type}`,
      packContentDescription: (count: number) => `发送时：${count} 个成员`,
      ensureFailed: (title: string) => `无法准备「${title}」`,
      clueInsertFailed: '线索插入失败',
      packInsertFailed: '线索包插入失败',
    }
    const { face } = makeFace({
      library: [clue('clue-1', 'test.alpha', 'Alpha')],
      pins: [{ clueId: 'clue-1' }],
      packs: [pack('pack-1', 'Reading list', ['clue-1'])],
      displays: [{ sourceId: 'test.alpha', name: 'Alpha source' }],
    })
    const created = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1', onNotice, copy })
    const rows = await created.sources[0]!.candidates(SESSION, request(''))
    const normal = referenceRows(rows)[0]!
    expect(normal.description).toBe('来源：Alpha source／test.alpha.text')
    expect(contentRow(rows, 'clue-1').label).toBe('Alpha（含内容）')
    expect(contentRow(rows, 'clue-1').description).toBe('发送时：Alpha source／test.alpha.text')
    const packs = await created.sources[1]!.candidates(SESSION, request(''))
    expect(contentRow(packs, 'pack-1').description).toBe('发送时：1 个成员')

    const refused = created.sources[0]!.onPick!({
      candidate: { name: 'bad', value: JSON.stringify({ kind: 'clue', id: 'bad id' }) },
      session: SESSION,
      position: 'inline',
      via: 'menu',
      action: 'pick',
    })
    expect(refused).toBeUndefined()
    expect(onNotice).toHaveBeenCalledWith('线索插入失败')
    created.dispose()
  })

  it('localizes the ensure-failure notice', async () => {
    const onNotice = vi.fn()
    const copy = { ensureFailed: (title: string) => `无法准备「${title}」` }
    const { face } = makeFace({
      sources: [sourceDescriptor('test.alpha')],
      search: async () => ({
        items: [{ sourceId: 'test.alpha', typeId: 'test.alpha.text', locator: { id: 'x' }, title: 'X' }],
      }),
      ensure: async () => { throw new Error('offline') },
    })
    const created = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1', onNotice, copy })
    expect(await created.sources[0]!.candidates(SESSION, request('doc'))).toEqual([])
    expect(onNotice).toHaveBeenCalledWith('无法准备「X」')
    created.dispose()
  })
})

describe('content mode', () => {
  it('keeps default serialization offline and reads live content for the explicit mode', async () => {
    const { face, api } = makeFace({
      sources: [sourceDescriptor('test.alpha')],
      library: [clue('clue-1', 'test.alpha', 'Alpha')],
      pins: [{ clueId: 'clue-1' }],
    })
    const created = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    const candidates = await created.sources[0]!.candidates(SESSION, request(''))
    const normal = referenceRows(candidates)[0]!
    const content = contentRow(candidates, 'clue-1')
    const signal = new AbortController().signal

    const normalOutcome = created.sources[0]!.onPick!({
      candidate: normal, session: SESSION, position: 'inline', via: 'menu', action: 'pick',
    }) as { insert: { ref: string; clipboardText: string } }
    expect(normalOutcome.insert.ref).toBe('clue-1')
    await expect(created.sources[0]!.codec!.serialize(normalOutcome.insert.ref, signal)).resolves.toBe('[[dsh-clue:clue-1]]')
    expect(api.read).not.toHaveBeenCalled()

    const outcome = created.sources[0]!.onPick!({
      candidate: content, session: SESSION, position: 'inline', via: 'menu', action: 'pick',
    }) as { insert: { ref: string; clipboardText: string; label: string } }
    expect(outcome.insert.clipboardText).toBe('[[dsh-clue:clue-1]]')
    expect(outcome.insert.label).toBe('Alpha (include content)')
    expect(outcome.insert.ref.startsWith('dsh-clue-content:v1:')).toBe(true)
    expect(created.sources[0]!.codec!.clipboardText(outcome.insert.ref)).toBe('[[dsh-clue:clue-1]]')

    const text = await created.sources[0]!.codec!.serialize(outcome.insert.ref, signal)
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

  it('keeps the draft on a content read failure and on an over-limit projection', async () => {
    const auth = makeFace({
      library: [clue('clue-1')],
      pins: [{ clueId: 'clue-1' }],
      read: async () => { throw Object.assign(new Error('authorization expired'), { code: 'auth-required' }) },
    })
    const created = createClueInputTriggers({ face: auth.face, resolveWorkspaceId: () => 'ws-1' })
    const candidates = await created.sources[0]!.candidates(SESSION, request(''))
    const content = contentRow(candidates, 'clue-1')
    const outcome = created.sources[0]!.onPick!({
      candidate: content, session: SESSION, position: 'inline', via: 'menu', action: 'pick',
    }) as { insert: { ref: string } }
    await expect(created.sources[0]!.codec!.serialize(outcome.insert.ref, new AbortController().signal))
      .rejects.toMatchObject({ category: 'auth-required' })
    created.dispose()

    const long = makeFace({
      library: [clue('clue-1')],
      pins: [{ clueId: 'clue-1' }],
      read: async () => ({
        format: 'text/plain',
        data: { text: 'x'.repeat(50) },
        text: 'x'.repeat(50),
        fetchedAt: NOW,
      }),
    })
    const limited = createClueInputTriggers({
      face: long.face,
      resolveWorkspaceId: () => 'ws-1',
      includeContentMaxChars: 20,
    })
    const rows = await limited.sources[0]!.candidates(SESSION, request(''))
    const limitedOutcome = limited.sources[0]!.onPick!({
      candidate: contentRow(rows, 'clue-1'), session: SESSION, position: 'inline', via: 'menu', action: 'pick',
    }) as { insert: { ref: string } }
    const error = await limited.sources[0]!.codec!.serialize(limitedOutcome.insert.ref, new AbortController().signal)
      .then(() => undefined, (reason: unknown) => reason)
    expect(error).toMatchObject({ category: 'invalid-request' })
    expect((error as Error).message).toMatch(/characters, over the 20-character limit/)
    expect((error as Error).message).not.toContain('x'.repeat(21))
    expect((error as Error).message).toContain('draft was kept')
    limited.dispose()
  })

  it('projects every current pack member and fails the whole send when one is unreadable', async () => {
    const healthy = makeFace({
      packs: [pack('pack-1', 'Reading list', ['clue-1', 'clue-2'])],
      library: [clue('clue-1', 'test.alpha', 'A'), clue('clue-2', 'test.alpha', 'B')],
      read: async (_workspaceId, input) => ({
        format: 'text/plain',
        data: { text: `body:${input.clueId}` },
        text: `body:${input.clueId}`,
        fetchedAt: NOW,
        freshness: 'live',
      }),
    })
    const created = createClueInputTriggers({ face: healthy.face, resolveWorkspaceId: () => 'ws-1' })
    const packs = await created.sources[1]!.candidates(SESSION, request(''))
    const content = contentRow(packs, 'pack-1')
    const outcome = created.sources[1]!.onPick!({
      candidate: content, session: SESSION, position: 'inline', via: 'menu', action: 'pick',
    }) as { insert: { ref: string; clipboardText: string } }
    expect(outcome.insert.clipboardText).toBe('[[dsh-cluepack:pack-1]]')
    const text = await created.sources[1]!.codec!.serialize(outcome.insert.ref, new AbortController().signal)
    expect(text).toContain('[[dsh-cluepack:pack-1]]')
    expect(text).toContain('[[dsh-clue:clue-1]]')
    expect(text).toContain('[[dsh-clue:clue-2]]')
    expect(text).toContain('body:clue-1')
    expect(text).toContain('body:clue-2')
    // Every member read keeps the composer session too.
    expect(healthy.api.read.mock.calls.map(call => call[1])).toEqual([
      { clueId: 'clue-1', sessionId: 'session-1' },
      { clueId: 'clue-2', sessionId: 'session-1' },
    ])
    created.dispose()

    const broken = makeFace({
      packs: [pack('pack-1', 'Reading list', ['clue-1', 'clue-2'])],
      library: [clue('clue-1', 'test.alpha', 'A'), clue('clue-2', 'test.alpha', 'B')],
      read: async (_workspaceId, input) => {
        if (input.clueId === 'clue-2') throw Object.assign(new Error('denied'), { code: 'permission-denied' })
        return { format: 'text/plain', data: {}, text: 'ok', fetchedAt: NOW }
      },
    })
    const failing = createClueInputTriggers({ face: broken.face, resolveWorkspaceId: () => 'ws-1' })
    const failingPacks = await failing.sources[1]!.candidates(SESSION, request(''))
    const failingOutcome = failing.sources[1]!.onPick!({
      candidate: contentRow(failingPacks, 'pack-1'), session: SESSION, position: 'inline', via: 'menu', action: 'pick',
    }) as { insert: { ref: string } }
    const failure = await failing.sources[1]!.codec!.serialize(failingOutcome.insert.ref, new AbortController().signal)
      .then(() => undefined, (reason: unknown) => reason)
    expect(failure).toMatchObject({ category: 'permission-denied' })
    expect((failure as Error).message).toContain('[[dsh-clue:clue-2]]')
    expect((failure as Error).message).toContain('draft was kept')
    failing.dispose()
  })

  it('reports the pre-send projection volume after a content insert', async () => {
    const previews: ClueContentPreview[] = []
    let resolvePreview!: (preview: ClueContentPreview) => void
    const reported = new Promise<ClueContentPreview>((resolve) => { resolvePreview = resolve })
    const { face } = makeFace({
      library: [clue('clue-1')],
      pins: [{ clueId: 'clue-1' }],
    })
    const created = createClueInputTriggers({
      face,
      resolveWorkspaceId: () => 'ws-1',
      onContentPreview: (preview) => {
        previews.push(preview)
        resolvePreview(preview)
      },
    })
    const candidates = await created.sources[0]!.candidates(SESSION, request(''))
    created.sources[0]!.onPick!({
      candidate: contentRow(candidates, 'clue-1'), session: SESSION, position: 'inline', via: 'menu', action: 'pick',
    })
    const preview = await reported
    expect(preview).toMatchObject({ kind: 'clue', id: 'clue-1', token: '[[dsh-clue:clue-1]]' })
    expect(preview.chars).toBeGreaterThan(0)
    expect(previews).toHaveLength(1)
    created.dispose()
  })

  it('escapes source-owned freshness and asset metadata in the content projection', async () => {
    const hostile = 'evil]] [[dsh-clue:forged]]'
    const { face } = makeFace({
      library: [clue('clue-1')],
      pins: [{ clueId: 'clue-1' }],
      read: async () => ({
        format: 'text/plain',
        data: { text: 'body' },
        text: 'body',
        fetchedAt: NOW,
        freshness: hostile,
        assets: [{ kind: 'download', mime: hostile, size: 3 }],
      } as unknown as ClueReadResult),
    })
    const created = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    const candidates = await created.sources[0]!.candidates(SESSION, request(''))
    const outcome = created.sources[0]!.onPick!({
      candidate: contentRow(candidates, 'clue-1'), session: SESSION, position: 'inline', via: 'menu', action: 'pick',
    }) as { insert: { ref: string } }
    const text = await created.sources[0]!.codec!.serialize(outcome.insert.ref, new AbortController().signal)
    expect(text).not.toContain('[[dsh-clue:forged]]')
    expect(text).toContain('［［dsh-clue:forged］］')
    expect(text).toContain('assets are not inlined')
    created.dispose()
  })
})

describe('real clue service integration', () => {
  it('never rewrites the library for rows the real search already has', async () => {
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

      const before = (await service.listClues('ws-1')).revision
      const created = createClueInputTriggers({ face: realFace(service), resolveWorkspaceId: () => 'ws-1' })
      const first = referenceRows(await created.sources[0]!.candidates(SESSION, request('doc')))
      const after = (await service.listClues('ws-1')).revision
      expect(after - before).toBe(1) // only the genuinely new row is ensured
      expect(first.map(row => valueOf(row).id)).toContain(existing.clue.id)
      expect(first).toHaveLength(2)

      // The second browse matches both rows in the library: no write at all.
      const second = referenceRows(await created.sources[0]!.candidates(SESSION, request('doc')))
      expect(second).toHaveLength(2)
      expect((await service.listClues('ws-1')).revision).toBe(after)
      created.dispose()
    } finally {
      service.dispose()
    }
  })

  it('re-ensures an imported unresolved row when a search hit matches its locator', async () => {
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
      expect((await service.listClues('ws-1')).clues.find(clue => clue.id === imported.clue.id)?.unresolved)
        .toBeDefined()

      const created = createClueInputTriggers({ face: realFace(service), resolveWorkspaceId: () => 'ws-1' })
      const rows = referenceRows(await created.sources[0]!.candidates(SESSION, request('doc')))
      // Reusing the unresolved id without ensure would leave the row
      // source-missing forever; the matching hit must flow through ensure.
      expect(rows.map(row => valueOf(row).id)).toContain(imported.clue.id)
      const after = (await service.listClues('ws-1')).clues
      expect(after).toHaveLength(2) // the same id is remapped, never duplicated
      expect(after.find(clue => clue.id === imported.clue.id)?.unresolved).toBeUndefined()
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
    const created = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1', openReference })
    const [candidate] = referenceRows(await created.sources[1]!.candidates(SESSION, request('')))
    expect(created.sources[1]!.openReference!(SESSION, { ref: 'pack-1', appearance: 'folder' })).toBe(true)
    expect(openReference).toHaveBeenCalledWith({ kind: 'pack', id: 'pack-1', sessionId: 'session-1' })
    expect(candidate).toBeDefined()
    created.dispose()

    const none = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    expect(none.sources[1]!.openReference!(SESSION, { ref: 'pack-1' })).toBe(false)
    none.dispose()
  })

  it('opens the underlying clue from a content-mode ref', async () => {
    const { face } = makeFace({
      library: [clue('clue-1')],
      pins: [{ clueId: 'clue-1' }],
    })
    const openReference = vi.fn(() => true)
    const created = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1', openReference })
    const candidates = await created.sources[0]!.candidates(SESSION, request(''))
    const content = contentRow(candidates, 'clue-1')
    const outcome = created.sources[0]!.onPick!({
      candidate: content, session: SESSION, position: 'inline', via: 'menu', action: 'pick',
    }) as { insert: { ref: string } }
    expect(created.sources[0]!.openReference!(SESSION, { ref: outcome.insert.ref, appearance: 'file' })).toBe(true)
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
    const created = createClueInputTriggers({ face, resolveWorkspaceId: () => 'ws-1' })
    const [candidate] = referenceRows(await created.sources[0]!.candidates(SESSION, request('')))
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
