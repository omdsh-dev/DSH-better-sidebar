/**
 * The local clue read seam (post-tool revision).
 *
 * The old spec drove two registered model tools. The reader is now called by
 * the fixed loopback HTTP route, so this file pins the BUSINESS contract
 * directly, with the real clue service and a fake workspace registry:
 *
 * - exactly one token per read, parsed by the shared token module;
 * - a clue token is a LIVE read of the source's current content and carries
 *   the caller identity/session; a live failure is a fixed safe category and
 *   NEVER falls back to an old snapshot;
 * - a snapshot token is the only history read; it works from local storage
 *   alone and reports fetchedAt/createdAt/integrity;
 * - a pack token returns CURRENT member metadata in bounded pages, never a
 *   member body;
 * - the requested workspace must be registered; the scan beyond it is bounded;
 * - no raw transport text ever reaches the value.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCluesService, type ClueCallOptions, type ClueSnapshotInput, type ClueSourceRegistration, type CluesService } from '../src/clues/service.ts'
import { ClueError, type ClueCommentsListParams, type ClueDiscussionPage, type ClueOperationContext, type ClueReadResult, type Locator } from '../src/clues/types.ts'
import { MAX_AGENT_READ_PACK_MEMBERS, MAX_AGENT_READ_WORKSPACES, boundedWorkspaceScopes, parseReaderReference, readClueReference, requestedWorkspaceScope, type ClueReaderRegistry } from '../src/clues/tools.ts'
import { serializeClueToken } from '../src/clues/context/tokens.ts'
import { CluesStore } from '../src/clues/store.ts'
import { removeTree } from './temp-tree.ts'

const roots: string[] = []
const NOW = '2026-10-17T00:00:00.000Z'

afterEach(() => {
  for (const path of roots.splice(0)) removeTree(path)
})

function makeService(): CluesService {
  let next = 0
  const root = mkdtempSync(join(tmpdir(), 'dsh-clues-readable-'))
  roots.push(root)
  return createCluesService({ root, now: () => NOW, newId: kind => `${kind}-${++next}` })
}

/** One source whose read can be observed or made to fail. */
function source(
  sourceId: string,
  read: (input: { readonly locator: Locator }, context: ClueOperationContext) => Promise<ClueReadResult> = async input => ({
    format: 'text/plain', data: { text: `live:${String(input.locator.id)}` }, fetchedAt: NOW, text: `live:${String(input.locator.id)}`,
  }),
): ClueSourceRegistration {
  const typeId = `${sourceId}.text`
  return {
    descriptor: { sourceId, name: sourceId, order: 0, pluginId: 'test', types: [typeId], transport: 'http', capabilities: { resolve: false, list: false, search: false, read: true, edit: false, portable: false } },
    types: [{ typeId, sourceId, formats: ['text/plain'], capabilities: { read: true, edit: false, concurrency: 'none' } }],
    operations: { read: async (input, context) => read(input, context) },
  }
}

/** A two-workspace registry; `list` is the bounded scan source. */
function registry(entries: ReadonlyArray<{ id: string }> = [{ id: 'ws-1' }, { id: 'ws-2' }]): ClueReaderRegistry {
  return { get: id => entries.find(entry => entry.id === id), list: () => entries }
}

/** A parsed token for a stable id and kind. */
function token(kind: 'clue' | 'pack' | 'snapshot', id: string) {
  return parseReaderReference(serializeClueToken(kind, id))
}

let clues: CluesService
beforeEach(() => { clues = makeService() })

async function addClue(sourceId: string, locator = 'a', title = 'A', workspaceId = 'ws-1'): Promise<string> {
  const { clue } = await clues.ensure({ workspaceId, sourceId, typeId: `${sourceId}.text`, locator: { id: locator }, title })
  return clue.id
}

/** Drive the business seam against the fixture service and registry. */
function read(
  kind: 'clue' | 'pack' | 'snapshot',
  id: string,
  request: Record<string, unknown> = {},
  options: ClueCallOptions = {},
) {
  return readClueReference(
    { workspaceId: 'ws-1', token: token(kind, id), ...request } as Parameters<typeof readClueReference>[0],
    { clues, registry: registry(), ...options },
  )
}

const putSnapshot = (clueId: string, body: string, extra: Partial<ClueSnapshotInput> = {}) =>
  clues.putSnapshot('ws-1', { clueId, format: 'text/plain', data: { text: body }, text: body, fetchedAt: NOW, ...extra })

describe('parseReaderReference', () => {
  it('accepts exactly one token and trims surrounding whitespace', () => {
    expect(parseReaderReference('  [[dsh-clue:a]]\n')).toMatchObject({ kind: 'clue', id: 'a' })
    expect(parseReaderReference('[[dsh-cluepack:p]]')).toMatchObject({ kind: 'pack', id: 'p' })
    expect(parseReaderReference('[[dsh-clue-snapshot:s]]')).toMatchObject({ kind: 'snapshot', id: 's' })
  })

  it('rejects embedded text, multiple tokens and malformed references', () => {
    for (const reference of ['look [[dsh-clue:a]]', '[[dsh-clue:a]] trailing', '[[dsh-clue:a]] [[dsh-clue:b]]', '[[[dsh-clue:a]]]', '[[dsh-clue:]]', '']) {
      expect(() => parseReaderReference(reference), reference).toThrow(ClueError)
    }
  })
})

describe('workspace scope validation', () => {
  it('requires a registered workspace id', () => {
    expect(requestedWorkspaceScope(registry(), 'ws-1')).toEqual({ id: 'ws-1' })
    expect(requestedWorkspaceScope(registry(), 'ws-unknown')).toBeUndefined()
    expect(requestedWorkspaceScope(undefined, 'ws-1')).toBeUndefined()
  })

  it('bounds the registered-workspace scan', () => {
    const many = Array.from({ length: MAX_AGENT_READ_WORKSPACES + 20 }, (_, index) => ({ id: `ws-${index}` }))
    expect(boundedWorkspaceScopes(registry(many))).toHaveLength(MAX_AGENT_READ_WORKSPACES)
  })

  it('refuses an unregistered workspace without touching the store', async () => {
    const value = await readClueReference(
      { workspaceId: 'ws-unknown', token: token('clue', 'clue-1') },
      { clues, registry: registry(), sessionId: 'session-1' },
    )
    expect(value).toMatchObject({ status: 'error', kind: 'clue', error: { category: 'invalid-request' } })
  })
})

describe('readClueReference — live clue', () => {
  it('reads the current content and forwards caller=agent + the session id', async () => {
    const seen: Array<{ caller: string; sessionId?: string }> = []
    clues.registerSource(source('test.session', async (_input, context) => {
      seen.push({ caller: context.caller, ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }) })
      return { format: 'text/plain', data: {}, text: 'current body', fetchedAt: NOW }
    }))
    const clueId = await addClue('test.session')
    const value = await read('clue', clueId, {}, { sessionId: 'session-1' })
    expect(value).toMatchObject({ status: 'ok', kind: 'clue', id: clueId, workspaceId: 'ws-1', text: 'current body', freshness: 'live', fetchedAt: NOW, snapshotOffset: 0, snapshotCount: 0 })
    expect(value.snapshots).toBeUndefined()
    expect(seen).toEqual([{ caller: 'agent', sessionId: 'session-1' }])
  })

  it('passes assets and source freshness through instead of inventing content', async () => {
    clues.registerSource(source('test.binary', async () => ({
      format: 'application/pdf', data: {}, assets: [{ kind: 'download', path: '/tmp/report.pdf', mime: 'application/pdf', size: 42 }], fetchedAt: NOW,
    })))
    clues.registerSource(source('test.snapshot-backed', async () => ({ format: 'text/plain', data: { text: 'restored body' }, text: 'restored body', fetchedAt: NOW, freshness: 'snapshot' })))
    const binary = await read('clue', await addClue('test.binary', 'pdf', 'Binary'))
    expect(binary).toMatchObject({ status: 'ok', format: 'application/pdf' })
    expect(binary.text).toBeUndefined()
    expect(binary.data).toEqual({})
    expect(binary.assets).toHaveLength(1)
    const restored = await read('clue', await addClue('test.snapshot-backed', 's', 'Restored'))
    expect(restored).toMatchObject({ status: 'ok', freshness: 'snapshot' })
  })

  it('returns the fixed live error and never falls back to a stored snapshot', async () => {
    clues.registerSource(source('test.fail', async () => {
      throw new ClueError('auth-required', 'authorization expired')
    }))
    const clueId = await addClue('test.fail', 'x', 'Failing')
    const snapshot = await putSnapshot(clueId, 'historical body', { fetchedAt: '2026-01-01T00:00:00.000Z', integrity: 'verified' })
    const value = await read('clue', clueId, {}, { sessionId: 'session-1' })
    expect(value).toMatchObject({ status: 'error', kind: 'clue', sourceId: 'test.fail', typeId: 'test.fail.text', error: { category: 'auth-required', message: 'authorization expired' }, snapshotOffset: 0, snapshotCount: 1 })
    expect(value.snapshots).toEqual([{ snapshotId: snapshot.snapshotId, clueId, format: 'text/plain', fetchedAt: '2026-01-01T00:00:00.000Z', createdAt: NOW, integrity: 'verified' }])
    expect(value.text).toBeUndefined()
    expect(JSON.stringify(value)).not.toContain('historical body')

    // Metadata lets the caller choose history explicitly; it does not authorize an automatic fallback.
    const historical = await read('snapshot', snapshot.snapshotId)
    expect(historical).toMatchObject({ status: 'ok', kind: 'snapshot', id: snapshot.snapshotId, text: 'historical body', integrity: 'verified' })
  })

  it('pages snapshot metadata and reports an unavailable index explicitly', async () => {
    clues.registerSource(source('test.fail', async () => {
      throw new ClueError('auth-required', 'authorization expired')
    }))
    const clueId = await addClue('test.fail', 'x', 'Many snapshots')
    for (let index = 0; index < 21; index += 1) await putSnapshot(clueId, `snapshot ${index}`)
    const first = await read('clue', clueId)
    expect(first).toMatchObject({ status: 'error', snapshotOffset: 0, snapshotCount: 21, snapshotsLimited: true, snapshotNextOffset: 20 })
    expect(first.snapshots).toHaveLength(20)
    expect(JSON.stringify(first)).not.toContain('snapshot 0')

    const second = await read('clue', clueId, { snapshotOffset: 20 })
    expect(second).toMatchObject({ status: 'error', snapshotOffset: 20, snapshotCount: 21 })
    expect(second.snapshotsLimited).toBeUndefined()
    expect(second.snapshots).toHaveLength(1)

    clues.listSnapshots = async () => { throw new ClueError('failed', 'snapshot index offline') }
    const unavailable = await read('clue', clueId)
    expect(unavailable).toMatchObject({ status: 'error', snapshotOffset: 0, snapshotsUnavailable: { category: 'failed', message: 'snapshot index offline' } })
    expect(unavailable.snapshotCount).toBeUndefined()
    expect(unavailable.snapshots).toBeUndefined()
  })

  it('never echoes unknown internal failures', async () => {
    clues.registerSource(source('test.leak', async () => {
      throw new Error('SECRET=super-secret TOKEN=abc')
    }))
    const value = await read('clue', await addClue('test.leak', 'x', 'Leak'), {}, { sessionId: 'session-1' })
    expect(value).toMatchObject({ status: 'error', error: { category: 'failed' } })
    for (const secret of ['super-secret', 'SECRET=', 'TOKEN=']) expect(JSON.stringify(value)).not.toContain(secret)
  })
})

describe('readClueReference — explicit snapshot', () => {
  it('reads one local snapshot after its source is gone, with fetch time and integrity', async () => {
    const unregister = clues.registerSource(source('test.removed'))
    const clueId = await addClue('test.removed', 's', 'Removed source')
    const snapshot = await putSnapshot(clueId, 'snapshot body', {
      fetchedAt: '2026-02-02T00:00:00.000Z', sourceVersion: 'v7', integrity: 'verified',
    })
    unregister()
    const value = await read('snapshot', snapshot.snapshotId)
    expect(value).toMatchObject({ status: 'ok', kind: 'snapshot', id: snapshot.snapshotId, workspaceId: 'ws-1', clueId, text: 'snapshot body', freshness: 'snapshot', fetchedAt: '2026-02-02T00:00:00.000Z', integrity: 'verified', sourceVersion: 'v7' })
  })

  it('finds a snapshot in another local workspace and reports not-found cleanly', async () => {
    clues.registerSource(source('test.alpha'))
    const clueId = await addClue('test.alpha', 's', 'Other workspace', 'ws-2')
    const snapshot = await clues.putSnapshot('ws-2', { clueId, format: 'text/plain', data: { text: 'local body' }, text: 'local body', fetchedAt: NOW })
    const found = await read('snapshot', snapshot.snapshotId)
    expect(found).toMatchObject({ status: 'ok', kind: 'snapshot', workspaceId: 'ws-2', text: 'local body', integrity: 'unknown' })

    const missing = await read('snapshot', 'missing')
    expect(missing).toMatchObject({ status: 'error', kind: 'snapshot', error: { category: 'not-found' } })
  })
})

describe('readClueReference — pack', () => {
  it('returns CURRENT member metadata only, never bodies', async () => {
    const sourceRead = vi.fn(async () => ({ format: 'text/plain', data: { text: 'member body' }, text: 'member body', fetchedAt: NOW }))
    clues.registerSource(source('test.alpha', sourceRead))
    const a = await addClue('test.alpha', 'a', 'A')
    const b = await addClue('test.alpha', 'b', 'B')
    const pack = await clues.createPack({ workspaceId: 'ws-1', name: 'P', members: [a] })
    const snapshot = await putSnapshot(a, 'old body', {}) // snapshot metadata must be summarised, never inlined
    const before = await read('pack', pack.pack.id)
    expect(before).toMatchObject({ status: 'ok', kind: 'pack', id: pack.pack.id, name: 'P', memberCount: 1, snapshotOffset: 0 })
    expect(before.members?.map(member => member.clueId)).toEqual([a])
    expect(before.members?.[0]).toMatchObject({ snapshotCount: 1, snapshots: [{ snapshotId: snapshot.snapshotId, clueId: a, format: 'text/plain', fetchedAt: NOW, createdAt: NOW }] })
    expect(JSON.stringify(before)).not.toContain('old body')
    expect(JSON.stringify(before)).not.toContain('member body')
    expect(sourceRead).not.toHaveBeenCalled()

    // A pack is not a frozen body set: a member added later is returned.
    await clues.addPackMember({ workspaceId: 'ws-1', packId: pack.pack.id, clueId: b })
    const after = await read('pack', pack.pack.id)
    expect(after.memberCount).toBe(2)
    expect(after.members?.map(member => member.clueId)).toEqual([a, b])
  })

  it('pages each member snapshot metadata and reports an unavailable index, never zero', async () => {
    clues.registerSource(source('test.alpha'))
    const clueId = await addClue('test.alpha')
    for (let index = 0; index < 21; index += 1) await putSnapshot(clueId, `snapshot ${index}`)
    const pack = await clues.createPack({ workspaceId: 'ws-1', name: 'P', members: [clueId] })
    const first = await read('pack', pack.pack.id)
    expect(first.members?.[0]).toMatchObject({ snapshotCount: 21, snapshotsLimited: true, snapshotNextOffset: 20 })
    expect(first.members?.[0]?.snapshots).toHaveLength(20)

    const second = await read('pack', pack.pack.id, { snapshotOffset: 20 })
    expect(second.members?.[0]).toMatchObject({ snapshotCount: 21 })
    expect(second.members?.[0]?.snapshotsLimited).toBeUndefined()
    expect(second.members?.[0]?.snapshots).toHaveLength(1)

    clues.listSnapshots = async () => { throw new ClueError('failed', 'snapshot index offline') }
    const unavailable = await read('pack', pack.pack.id)
    expect(unavailable).toMatchObject({ status: 'ok', kind: 'pack', snapshotOffset: 0, snapshotsUnavailable: { category: 'failed', message: 'snapshot index offline' } })
    expect(unavailable.snapshotCount).toBeUndefined()
    expect(unavailable.members?.[0]?.snapshotCount).toBeUndefined()
    expect(unavailable.members?.[0]?.snapshots).toBeUndefined()
  })

  it('pages pack members with a true total and a next offset', async () => {
    clues.registerSource(source('test.alpha'))
    const memberIds: string[] = []
    for (let index = 0; index < MAX_AGENT_READ_PACK_MEMBERS + 1; index += 1) memberIds.push(await addClue('test.alpha', `m${index}`, `Member ${index}`))
    const pack = await clues.createPack({ workspaceId: 'ws-1', name: 'Big', members: memberIds })
    const first = await read('pack', pack.pack.id)
    expect(first).toMatchObject({ status: 'ok', memberCount: MAX_AGENT_READ_PACK_MEMBERS + 1, limited: true, nextOffset: MAX_AGENT_READ_PACK_MEMBERS, limit: MAX_AGENT_READ_PACK_MEMBERS })
    expect(first.members).toHaveLength(MAX_AGENT_READ_PACK_MEMBERS)

    const second = await read('pack', pack.pack.id, { offset: MAX_AGENT_READ_PACK_MEMBERS })
    expect(second.memberCount).toBe(MAX_AGENT_READ_PACK_MEMBERS + 1)
    expect(second.members).toHaveLength(1)
    expect(second.limited).toBeUndefined()
  })
})

describe('readClueReference — workspace scan', () => {
  it('locates a clue in another registered workspace even when the requested scope differs', async () => {
    clues.registerSource(source('test.alpha'))
    const foreign = await addClue('test.alpha', 'foreign', 'Foreign', 'ws-2')
    expect(await read('clue', foreign)).toMatchObject({ status: 'ok', kind: 'clue', workspaceId: 'ws-2', text: 'live:foreign' })
  })

  it('returns stable not-found errors for unknown stable ids', async () => {
    for (const [kind, id] of [['clue', 'missing-clue'], ['pack', 'missing-pack'], ['snapshot', 'missing-snapshot']] as const) {
      expect(await read(kind, id), kind).toMatchObject({ status: 'error', kind, error: { category: 'not-found' } })
    }
  })

  it('does not scan past the bound for a stable id outside it', async () => {
    clues.registerSource(source('test.alpha'))
    const entries = Array.from({ length: MAX_AGENT_READ_WORKSPACES + 1 }, (_, index) => ({ id: `ws-${index}` }))
    const foreign = await clues.ensure({
      workspaceId: entries.at(-1)!.id, sourceId: 'test.alpha', typeId: 'test.alpha.text', locator: { id: 'far' }, title: 'Far',
    })
    const value = await readClueReference(
      { workspaceId: 'ws-0', token: token('clue', foreign.clue.id) },
      { clues, registry: registry(entries) },
    )
    expect(value).toMatchObject({ status: 'error', kind: 'clue', error: { category: 'not-found' } })
  })
})

// ── UI19 discussion follow-up ──────────────────────────────────────────────

/** Install the parent-owned comments reader on the fixture service. */
function stubCommentsList(
  list: (params: ClueCommentsListParams, options?: ClueCallOptions) => Promise<ClueDiscussionPage>,
): void {
  ;(clues as unknown as { commentsList: typeof list }).commentsList = list
}

/** One valid discussion page used by the reader projections. */
function discussion(): ClueDiscussionPage {
  return {
    status: 'ok',
    items: [{
      id: 'comment-1', kind: 'comment', format: 'text/markdown', body: 'First page',
      author: { id: 'user-1', name: 'Ada' }, createdAt: NOW, replyCount: 2, nextRepliesCursor: 'replies-1',
    }],
    fetchedAt: NOW, nextCursor: 'page-2', total: 3, complete: false, coverage: 'document',
  }
}

describe('readClueReference — discussion follow-up', () => {
  it('lists a comments page by cursor/parentId without reading the clue body', async () => {
    let reads = 0
    clues.registerSource(source('test.discussion', async () => {
      reads += 1
      return { format: 'text/plain', data: {}, text: 'live body', fetchedAt: NOW }
    }))
    const clueId = await addClue('test.discussion', 'a', 'Discussion')
    const calls: Array<{ params: ClueCommentsListParams; options?: ClueCallOptions }> = []
    stubCommentsList(async (params, options) => {
      calls.push({ params, ...(options === undefined ? {} : { options }) })
      return discussion()
    })

    const value = await read('clue', clueId, { commentsCursor: 'page-2', parentId: 'comment-9' }, { sessionId: 'session-1' })
    expect(value).toMatchObject({ status: 'ok', kind: 'clue', id: clueId, token: serializeClueToken('clue', clueId), workspaceId: 'ws-1', title: 'Discussion', sourceId: 'test.discussion', typeId: 'test.discussion.text', discussion: discussion() })
    // A comments page is not a body read: no text/freshness, and the source's read operation never runs.
    expect(value.text).toBeUndefined()
    expect(value.freshness).toBeUndefined()
    expect(reads).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params).toMatchObject({ workspaceId: 'ws-1', clueId, cursor: 'page-2', parentId: 'comment-9' })
    expect(calls[0]!.options).toMatchObject({ caller: 'agent', sessionId: 'session-1' })
  })

  it('lists replies by parentId alone and forwards the abort signal', async () => {
    let reads = 0
    clues.registerSource(source('test.replies', async () => {
      reads += 1
      return { format: 'text/plain', data: {}, text: 'body', fetchedAt: NOW }
    }))
    const clueId = await addClue('test.replies', 'a', 'Replies')
    let seen: { params: ClueCommentsListParams; options?: ClueCallOptions } | undefined
    stubCommentsList(async (params, options) => {
      seen = { params, ...(options === undefined ? {} : { options }) }
      return { ...discussion(), nextCursor: undefined }
    })
    const controller = new AbortController()
    const value = await read('clue', clueId, { parentId: 'comment-1' }, { signal: controller.signal })
    expect(value).toMatchObject({ status: 'ok', discussion: { status: 'ok' } })
    expect(reads).toBe(0)
    expect(seen?.params).toMatchObject({ clueId, parentId: 'comment-1' })
    expect(seen?.params.cursor).toBeUndefined()
    expect(seen?.options?.signal).toBe(controller.signal)
  })

  it('projects the first discussion page carried by a live read', async () => {
    const page = discussion()
    clues.registerSource(source('test.read-discussion', async () => ({
      format: 'text/plain', data: {}, text: 'live body', fetchedAt: NOW, discussion: page,
    })))
    const value = await read('clue', await addClue('test.read-discussion', 'a', 'Read discussion'))
    expect(value).toMatchObject({ status: 'ok', text: 'live body', discussion: page })
  })

  it('projects a captured snapshot discussion and marks a legacy snapshot not-captured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-clues-readable-'))
    roots.push(root)
    const store = new CluesStore({ root })
    let next = 0
    const seeded = createCluesService({ store, now: () => NOW, newId: kind => `${kind}-${++next}` })
    seeded.registerSource(source('test.snapshots'))
    const { clue } = await seeded.ensure({ workspaceId: 'ws-1', sourceId: 'test.snapshots', typeId: 'test.snapshots.text', locator: { id: 'a' }, title: 'Snapshots' })
    const page = discussion()
    const readSeeded = (snapshotId: string) => readClueReference(
      { workspaceId: 'ws-1', token: token('snapshot', snapshotId) },
      { clues: seeded, registry: registry() },
    )
    // Seed the captured page through the store under test; the reader still goes through the real service.
    await store.putSnapshot('ws-1', {
      snapshotId: 'snap-captured', workspaceId: 'ws-1', clueId: clue.id, format: 'text/markdown', fetchedAt: NOW, createdAt: NOW,
    }, { format: 'text/markdown', data: { text: 'captured body' }, text: 'captured body', discussion: page })
    expect(await readSeeded('snap-captured')).toMatchObject({ status: 'ok', kind: 'snapshot', discussion: page })

    await store.putSnapshot('ws-1', {
      snapshotId: 'snap-legacy', workspaceId: 'ws-1', clueId: clue.id, format: 'text/plain', fetchedAt: NOW, createdAt: NOW,
    }, { format: 'text/plain', data: { text: 'legacy body' }, text: 'legacy body' })
    expect(await readSeeded('snap-legacy')).toMatchObject({
      status: 'ok', kind: 'snapshot',
      discussion: { status: 'not-captured', items: [], fetchedAt: NOW, complete: false, coverage: 'document' },
    })
  })

  it.each([
    ['a comments cursor on a snapshot token', 'snapshot', 'missing', { commentsCursor: 'page-2' }], ['a comments cursor on a pack token', 'pack', 'missing', { commentsCursor: 'page-2' }],
    ['an empty commentsCursor', 'clue', 'clue-missing', { commentsCursor: '' }], ['a blank commentsCursor', 'clue', 'clue-missing', { commentsCursor: '   ' }],
    ['a numeric commentsCursor', 'clue', 'clue-missing', { commentsCursor: 1 }], ['a null commentsCursor', 'clue', 'clue-missing', { commentsCursor: null }],
    ['an empty parentId', 'clue', 'clue-missing', { parentId: '' }], ['a blank parentId', 'clue', 'clue-missing', { parentId: ' \n ' }],
    ['a numeric parentId', 'clue', 'clue-missing', { parentId: 42 }], ['a null parentId', 'clue', 'clue-missing', { parentId: null }],
  ] as Array<[string, 'clue' | 'pack' | 'snapshot', string, Record<string, unknown>]>)('refuses %s as invalid', async (_label, kind, id, fields) => {
    expect(await read(kind, id, fields)).toMatchObject({ status: 'error', kind, error: { category: 'invalid-request' } })
  })

  it('projects a comments-page failure as a fixed safe error', async () => {
    clues.registerSource(source('test.comments-fail'))
    const clueId = await addClue('test.comments-fail', 'a', 'Comments fail')
    stubCommentsList(async () => {
      throw new Error('SECRET=super-secret TOKEN=abc')
    })
    const value = await read('clue', clueId, { commentsCursor: 'page-2' }, { sessionId: 'session-1' })
    expect(value).toMatchObject({ status: 'error', kind: 'clue', id: clueId, error: { category: 'failed' } })
    for (const secret of ['super-secret', 'SECRET=', 'TOKEN=']) expect(JSON.stringify(value)).not.toContain(secret)
  })
})
