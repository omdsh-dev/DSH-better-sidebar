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
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCluesService,
  type ClueCallOptions,
  type ClueSourceRegistration,
  type CluesService,
} from '../src/clues/service.ts'
import {
  ClueError,
  type ClueDiscussionPage,
  type ClueOperationContext,
  type ClueReadResult,
  type ClueCommentsListParams,
  type Locator,
} from '../src/clues/types.ts'
import {
  MAX_AGENT_READ_PACK_MEMBERS,
  MAX_AGENT_READ_WORKSPACES,
  boundedWorkspaceScopes,
  parseReaderReference,
  readClueReference,
  requestedWorkspaceScope,
  type ClueReaderRegistry,
  type ClueReaderRequest,
} from '../src/clues/tools.ts'
import { serializeClueToken } from '../src/clues/context/tokens.ts'
import { CluesStore } from '../src/clues/store.ts'
import { removeTree } from './temp-tree.ts'

const roots: string[] = []
const NOW = '2026-10-17T00:00:00.000Z'

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-clues-readable-'))
  roots.push(path)
  return path
}

afterEach(() => {
  for (const path of roots.splice(0)) removeTree(path)
})

/** A deterministic service with one configurable test source. */
function makeService(): CluesService {
  let next = 0
  return createCluesService({
    root: tempRoot(),
    now: () => NOW,
    newId: kind => `${kind}-${++next}`,
  })
}

/** One source whose read can be observed or made to fail. */
function source(
  sourceId: string,
  read: (input: { readonly locator: Locator }, context: ClueOperationContext) => Promise<ClueReadResult> = async (input) => ({
    format: 'text/plain',
    data: { text: `live:${String(input.locator.id)}` },
    fetchedAt: NOW,
    text: `live:${String(input.locator.id)}`,
  }),
): ClueSourceRegistration {
  const typeId = `${sourceId}.text`
  return {
    descriptor: {
      sourceId,
      name: sourceId,
      order: 0,
      pluginId: 'test',
      types: [typeId],
      transport: 'http',
      capabilities: { resolve: false, list: false, search: false, read: true, edit: false, portable: false },
    },
    types: [{
      typeId,
      sourceId,
      formats: ['text/plain'],
      capabilities: { read: true, edit: false, concurrency: 'none' },
    }],
    operations: { read: async (input, context) => read(input, context) },
  }
}

/** A two-workspace registry; `list` is the bounded scan source. */
function registry(entries: ReadonlyArray<{ id: string }> = [{ id: 'ws-1' }, { id: 'ws-2' }]): ClueReaderRegistry {
  return {
    get: id => entries.find(entry => entry.id === id),
    list: () => entries,
  }
}

/** A parsed token for a stable id and kind. */
function token(kind: 'clue' | 'pack' | 'snapshot', id: string) {
  return parseReaderReference(serializeClueToken(kind, id))
}

describe('parseReaderReference', () => {
  it('accepts exactly one token and trims surrounding whitespace', () => {
    expect(parseReaderReference('  [[dsh-clue:a]]\n')).toMatchObject({ kind: 'clue', id: 'a' })
    expect(parseReaderReference('[[dsh-cluepack:p]]')).toMatchObject({ kind: 'pack', id: 'p' })
    expect(parseReaderReference('[[dsh-clue-snapshot:s]]')).toMatchObject({ kind: 'snapshot', id: 's' })
  })

  it('rejects embedded text, multiple tokens and malformed references', () => {
    for (const reference of [
      'look [[dsh-clue:a]]',
      '[[dsh-clue:a]] trailing',
      '[[dsh-clue:a]] [[dsh-clue:b]]',
      '[[[dsh-clue:a]]]',
      '[[dsh-clue:]]',
      '',
    ]) {
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
    const clues = makeService()
    const value = await readClueReference(
      { workspaceId: 'ws-unknown', token: token('clue', 'clue-1') },
      { clues, registry: registry(), sessionId: 'session-1' },
    )
    expect(value).toMatchObject({
      status: 'error',
      kind: 'clue',
      error: { category: 'invalid-request' },
    })
  })
})

describe('readClueReference — live clue', () => {
  it('reads the current content and forwards caller=agent + the session id', async () => {
    const clues = makeService()
    const seen: Array<{ caller: string; sessionId?: string }> = []
    clues.registerSource(source('test.session', async (_input, context) => {
      seen.push({
        caller: context.caller,
        ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      })
      return { format: 'text/plain', data: {}, text: 'current body', fetchedAt: NOW }
    }))
    const ensured = await clues.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.session',
      typeId: 'test.session.text',
      locator: { id: 'a' },
      title: 'A',
    })
    const value = await readClueReference(
      { workspaceId: 'ws-1', token: token('clue', ensured.clue.id) },
      { clues, registry: registry(), sessionId: 'session-1' },
    )
    expect(value).toMatchObject({
      status: 'ok',
      kind: 'clue',
      id: ensured.clue.id,
      workspaceId: 'ws-1',
      text: 'current body',
      freshness: 'live',
      fetchedAt: NOW,
      snapshotOffset: 0,
      snapshotCount: 0,
    })
    expect(value.snapshots).toBeUndefined()
    expect(seen).toEqual([{ caller: 'agent', sessionId: 'session-1' }])
  })

  it('keeps binary/no-text content as marked assets', async () => {
    const clues = makeService()
    clues.registerSource(source('test.binary', async () => ({
      format: 'application/pdf',
      data: {},
      assets: [{ kind: 'download', path: '/tmp/report.pdf', mime: 'application/pdf', size: 42 }],
      fetchedAt: NOW,
    })))
    const ensured = await clues.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.binary',
      typeId: 'test.binary.text',
      locator: { id: 'pdf' },
      title: 'Binary',
    })
    const value = await readClueReference(
      { workspaceId: 'ws-1', token: token('clue', ensured.clue.id) },
      { clues, registry: registry() },
    )
    expect(value).toMatchObject({ status: 'ok', format: 'application/pdf' })
    expect(value.text).toBeUndefined()
    expect(value.data).toEqual({})
    expect(value.assets).toHaveLength(1)
  })

  it('returns the fixed live error and never falls back to a stored snapshot', async () => {
    const clues = makeService()
    clues.registerSource(source('test.fail', async () => {
      throw new ClueError('auth-required', 'authorization expired')
    }))
    const ensured = await clues.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.fail',
      typeId: 'test.fail.text',
      locator: { id: 'x' },
      title: 'Failing',
    })
    const snapshot = await clues.putSnapshot('ws-1', {
      clueId: ensured.clue.id,
      format: 'text/plain',
      data: { text: 'historical body' },
      text: 'historical body',
      fetchedAt: '2026-01-01T00:00:00.000Z',
      integrity: 'verified',
    })
    const value = await readClueReference(
      { workspaceId: 'ws-1', token: token('clue', ensured.clue.id) },
      { clues, registry: registry(), sessionId: 'session-1' },
    )
    expect(value).toMatchObject({
      status: 'error',
      kind: 'clue',
      sourceId: 'test.fail',
      typeId: 'test.fail.text',
      error: { category: 'auth-required', message: 'authorization expired' },
      snapshotOffset: 0,
      snapshotCount: 1,
    })
    expect(value.snapshots).toEqual([{
      snapshotId: snapshot.snapshotId,
      clueId: ensured.clue.id,
      format: 'text/plain',
      fetchedAt: '2026-01-01T00:00:00.000Z',
      createdAt: NOW,
      integrity: 'verified',
    }])
    expect(value.text).toBeUndefined()
    expect(JSON.stringify(value)).not.toContain('historical body')

    // The metadata lets the caller explicitly choose history; it does not
    // authorize an automatic fallback.
    const historical = await readClueReference(
      { workspaceId: 'ws-1', token: token('snapshot', snapshot.snapshotId) },
      { clues, registry: registry(), sessionId: 'session-1' },
    )
    expect(historical).toMatchObject({
      status: 'ok',
      kind: 'snapshot',
      id: snapshot.snapshotId,
      text: 'historical body',
      integrity: 'verified',
    })
  })

  it('pages snapshot metadata and reports an unavailable index explicitly', async () => {
    const clues = makeService()
    clues.registerSource(source('test.fail', async () => {
      throw new ClueError('auth-required', 'authorization expired')
    }))
    const ensured = await clues.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.fail',
      typeId: 'test.fail.text',
      locator: { id: 'x' },
      title: 'Many snapshots',
    })
    for (let index = 0; index < 21; index += 1) {
      await clues.putSnapshot('ws-1', {
        clueId: ensured.clue.id,
        format: 'text/plain',
        data: { text: `snapshot ${index}` },
        text: `snapshot ${index}`,
        fetchedAt: NOW,
      })
    }
    const first = await readClueReference(
      { workspaceId: 'ws-1', token: token('clue', ensured.clue.id) },
      { clues, registry: registry() },
    )
    expect(first).toMatchObject({
      status: 'error',
      snapshotOffset: 0,
      snapshotCount: 21,
      snapshotsLimited: true,
      snapshotNextOffset: 20,
    })
    expect(first.snapshots).toHaveLength(20)
    expect(JSON.stringify(first)).not.toContain('snapshot 0')

    const second = await readClueReference(
      { workspaceId: 'ws-1', token: token('clue', ensured.clue.id), snapshotOffset: 20 },
      { clues, registry: registry() },
    )
    expect(second).toMatchObject({ status: 'error', snapshotOffset: 20, snapshotCount: 21 })
    expect(second.snapshotsLimited).toBeUndefined()
    expect(second.snapshots).toHaveLength(1)

    const original = clues.listSnapshots
    clues.listSnapshots = async () => {
      throw new ClueError('failed', 'snapshot index offline')
    }
    try {
      const unavailable = await readClueReference(
        { workspaceId: 'ws-1', token: token('clue', ensured.clue.id) },
        { clues, registry: registry() },
      )
      expect(unavailable).toMatchObject({
        status: 'error',
        snapshotOffset: 0,
        snapshotsUnavailable: { category: 'failed', message: 'snapshot index offline' },
      })
      expect(unavailable.snapshotCount).toBeUndefined()
      expect(unavailable.snapshots).toBeUndefined()
    } finally {
      clues.listSnapshots = original
    }
  })

  it('never echoes unknown internal failures', async () => {
    const clues = makeService()
    clues.registerSource(source('test.leak', async () => {
      throw new Error('SECRET=super-secret TOKEN=abc')
    }))
    const ensured = await clues.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.leak',
      typeId: 'test.leak.text',
      locator: { id: 'x' },
      title: 'Leak',
    })
    const value = await readClueReference(
      { workspaceId: 'ws-1', token: token('clue', ensured.clue.id) },
      { clues, registry: registry(), sessionId: 'session-1' },
    )
    expect(value).toMatchObject({ status: 'error', error: { category: 'failed' } })
    expect(JSON.stringify(value)).not.toContain('super-secret')
    expect(JSON.stringify(value)).not.toContain('SECRET=')
    expect(JSON.stringify(value)).not.toContain('TOKEN=')
  })

  it('forwards the source freshness instead of hard-coding live', async () => {
    const clues = makeService()
    clues.registerSource(source('test.snapshot-backed', async () => ({
      format: 'text/plain',
      data: { text: 'restored body' },
      text: 'restored body',
      fetchedAt: NOW,
      freshness: 'snapshot',
    })))
    const ensured = await clues.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.snapshot-backed',
      typeId: 'test.snapshot-backed.text',
      locator: { id: 's' },
      title: 'Restored',
    })
    const value = await readClueReference(
      { workspaceId: 'ws-1', token: token('clue', ensured.clue.id) },
      { clues, registry: registry() },
    )
    expect(value).toMatchObject({ status: 'ok', freshness: 'snapshot' })
  })
})

describe('readClueReference — explicit snapshot', () => {
  it('reads one local snapshot after its source is gone, with fetch time and integrity', async () => {
    const clues = makeService()
    const unregister = clues.registerSource(source('test.removed'))
    const ensured = await clues.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.removed',
      typeId: 'test.removed.text',
      locator: { id: 's' },
      title: 'Removed source',
    })
    const snapshot = await clues.putSnapshot('ws-1', {
      clueId: ensured.clue.id,
      format: 'text/plain',
      data: { text: 'snapshot body' },
      text: 'snapshot body',
      fetchedAt: '2026-02-02T00:00:00.000Z',
      sourceVersion: 'v7',
      integrity: 'verified',
    })
    unregister()
    const value = await readClueReference(
      { workspaceId: 'ws-1', token: token('snapshot', snapshot.snapshotId) },
      { clues, registry: registry() },
    )
    expect(value).toMatchObject({
      status: 'ok',
      kind: 'snapshot',
      id: snapshot.snapshotId,
      workspaceId: 'ws-1',
      clueId: ensured.clue.id,
      text: 'snapshot body',
      freshness: 'snapshot',
      fetchedAt: '2026-02-02T00:00:00.000Z',
      integrity: 'verified',
      sourceVersion: 'v7',
    })
  })

  it('finds a snapshot in another local workspace and reports not-found cleanly', async () => {
    const clues = makeService()
    clues.registerSource(source('test.alpha'))
    const ensured = await clues.ensure({
      workspaceId: 'ws-2',
      sourceId: 'test.alpha',
      typeId: 'test.alpha.text',
      locator: { id: 's' },
      title: 'Other workspace',
    })
    const snapshot = await clues.putSnapshot('ws-2', {
      clueId: ensured.clue.id,
      format: 'text/plain',
      data: { text: 'local body' },
      text: 'local body',
      fetchedAt: NOW,
    })
    const found = await readClueReference(
      { workspaceId: 'ws-1', token: token('snapshot', snapshot.snapshotId) },
      { clues, registry: registry() },
    )
    expect(found).toMatchObject({
      status: 'ok',
      kind: 'snapshot',
      workspaceId: 'ws-2',
      text: 'local body',
      integrity: 'unknown',
    })

    const missing = await readClueReference(
      { workspaceId: 'ws-1', token: token('snapshot', 'missing') },
      { clues, registry: registry() },
    )
    expect(missing).toMatchObject({ status: 'error', kind: 'snapshot', error: { category: 'not-found' } })
  })
})

describe('readClueReference — pack', () => {
  it('returns CURRENT member metadata only, never bodies', async () => {
    const clues = makeService()
    const sourceRead = vi.fn(async () => ({
      format: 'text/plain',
      data: { text: 'member body' },
      text: 'member body',
      fetchedAt: NOW,
    }))
    clues.registerSource(source('test.alpha', sourceRead))
    const a = await clues.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.alpha',
      typeId: 'test.alpha.text',
      locator: { id: 'a' },
      title: 'A',
    })
    const b = await clues.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.alpha',
      typeId: 'test.alpha.text',
      locator: { id: 'b' },
      title: 'B',
    })
    const pack = await clues.createPack({ workspaceId: 'ws-1', name: 'P', members: [a.clue.id] })
    const snapshot = await clues.putSnapshot('ws-1', {
      clueId: a.clue.id,
      format: 'text/plain',
      data: { text: 'old body' },
      text: 'old body',
      fetchedAt: NOW,
    })
    const before = await readClueReference(
      { workspaceId: 'ws-1', token: token('pack', pack.pack.id) },
      { clues, registry: registry() },
    )
    expect(before).toMatchObject({
      status: 'ok',
      kind: 'pack',
      id: pack.pack.id,
      name: 'P',
      memberCount: 1,
      snapshotOffset: 0,
    })
    expect(before.members?.map(member => member.clueId)).toEqual([a.clue.id])
    expect(before.members?.[0]).toMatchObject({
      snapshotCount: 1,
      snapshots: [{
        snapshotId: snapshot.snapshotId,
        clueId: a.clue.id,
        format: 'text/plain',
        fetchedAt: NOW,
        createdAt: NOW,
      }],
    })
    expect(JSON.stringify(before)).not.toContain('old body')
    expect(JSON.stringify(before)).not.toContain('member body')
    expect(sourceRead).not.toHaveBeenCalled()

    // A pack is not a frozen body set: a member added later is returned.
    await clues.addPackMember({ workspaceId: 'ws-1', packId: pack.pack.id, clueId: b.clue.id })
    const after = await readClueReference(
      { workspaceId: 'ws-1', token: token('pack', pack.pack.id) },
      { clues, registry: registry() },
    )
    expect(after.memberCount).toBe(2)
    expect(after.members?.map(member => member.clueId)).toEqual([a.clue.id, b.clue.id])
  })

  it('pages each pack member snapshot metadata and points at the next offset', async () => {
    const clues = makeService()
    clues.registerSource(source('test.alpha'))
    const member = await clues.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.alpha',
      typeId: 'test.alpha.text',
      locator: { id: 'a' },
      title: 'A',
    })
    for (let index = 0; index < 21; index += 1) {
      await clues.putSnapshot('ws-1', {
        clueId: member.clue.id,
        format: 'text/plain',
        data: { text: `snapshot ${index}` },
        text: `snapshot ${index}`,
        fetchedAt: NOW,
      })
    }
    const pack = await clues.createPack({ workspaceId: 'ws-1', name: 'P', members: [member.clue.id] })
    const first = await readClueReference(
      { workspaceId: 'ws-1', token: token('pack', pack.pack.id) },
      { clues, registry: registry() },
    )
    const firstMember = first.members?.[0]
    expect(firstMember).toMatchObject({
      snapshotCount: 21,
      snapshotsLimited: true,
      snapshotNextOffset: 20,
    })
    expect(firstMember?.snapshots).toHaveLength(20)

    const second = await readClueReference(
      { workspaceId: 'ws-1', token: token('pack', pack.pack.id), snapshotOffset: 20 },
      { clues, registry: registry() },
    )
    const secondMember = second.members?.[0]
    expect(secondMember).toMatchObject({ snapshotCount: 21 })
    expect(secondMember?.snapshotsLimited).toBeUndefined()
    expect(secondMember?.snapshots).toHaveLength(1)
  })

  it('reports an unavailable pack snapshot index explicitly, never as zero', async () => {
    const clues = makeService()
    clues.registerSource(source('test.alpha'))
    const member = await clues.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.alpha',
      typeId: 'test.alpha.text',
      locator: { id: 'a' },
      title: 'A',
    })
    const pack = await clues.createPack({ workspaceId: 'ws-1', name: 'P', members: [member.clue.id] })
    const original = clues.listSnapshots
    clues.listSnapshots = async () => {
      throw new ClueError('failed', 'snapshot index offline')
    }
    try {
      const value = await readClueReference(
        { workspaceId: 'ws-1', token: token('pack', pack.pack.id) },
        { clues, registry: registry() },
      )
      expect(value).toMatchObject({
        status: 'ok',
        kind: 'pack',
        snapshotOffset: 0,
        snapshotsUnavailable: { category: 'failed', message: 'snapshot index offline' },
      })
      expect(value.snapshotCount).toBeUndefined()
      expect(value.members?.[0]?.snapshotCount).toBeUndefined()
      expect(value.members?.[0]?.snapshots).toBeUndefined()
    } finally {
      clues.listSnapshots = original
    }
  })

  it('pages pack members with a true total and a next offset', async () => {
    const clues = makeService()
    clues.registerSource(source('test.alpha'))
    const memberIds: string[] = []
    for (let index = 0; index < MAX_AGENT_READ_PACK_MEMBERS + 1; index += 1) {
      const ensured = await clues.ensure({
        workspaceId: 'ws-1',
        sourceId: 'test.alpha',
        typeId: 'test.alpha.text',
        locator: { id: `m${index}` },
        title: `Member ${index}`,
      })
      memberIds.push(ensured.clue.id)
    }
    const pack = await clues.createPack({ workspaceId: 'ws-1', name: 'Big', members: memberIds })
    const first = await readClueReference(
      { workspaceId: 'ws-1', token: token('pack', pack.pack.id) },
      { clues, registry: registry() },
    )
    expect(first).toMatchObject({
      status: 'ok',
      memberCount: MAX_AGENT_READ_PACK_MEMBERS + 1,
      limited: true,
      nextOffset: MAX_AGENT_READ_PACK_MEMBERS,
      limit: MAX_AGENT_READ_PACK_MEMBERS,
    })
    expect(first.members).toHaveLength(MAX_AGENT_READ_PACK_MEMBERS)

    const second = await readClueReference(
      { workspaceId: 'ws-1', token: token('pack', pack.pack.id), offset: MAX_AGENT_READ_PACK_MEMBERS },
      { clues, registry: registry() },
    )
    expect(second.memberCount).toBe(MAX_AGENT_READ_PACK_MEMBERS + 1)
    expect(second.members).toHaveLength(1)
    expect(second.limited).toBeUndefined()
  })
})

describe('readClueReference — workspace scan', () => {
  it('locates a clue in another registered workspace even when the requested scope differs', async () => {
    const clues = makeService()
    clues.registerSource(source('test.alpha'))
    const foreign = await clues.ensure({
      workspaceId: 'ws-2',
      sourceId: 'test.alpha',
      typeId: 'test.alpha.text',
      locator: { id: 'foreign' },
      title: 'Foreign',
    })
    const value = await readClueReference(
      { workspaceId: 'ws-1', token: token('clue', foreign.clue.id) },
      { clues, registry: registry() },
    )
    expect(value).toMatchObject({
      status: 'ok',
      kind: 'clue',
      workspaceId: 'ws-2',
      text: 'live:foreign',
    })
  })

  it('returns stable not-found errors for unknown stable ids', async () => {
    const clues = makeService()
    for (const [kind, id] of [
      ['clue', 'missing-clue'],
      ['pack', 'missing-pack'],
      ['snapshot', 'missing-snapshot'],
    ] as const) {
      const value = await readClueReference(
        { workspaceId: 'ws-1', token: token(kind, id) },
        { clues, registry: registry() },
      )
      expect(value).toMatchObject({ status: 'error', kind, error: { category: 'not-found' } })
    }
  })

  it('does not scan past the bound for a stable id outside it', async () => {
    const clues = makeService()
    clues.registerSource(source('test.alpha'))
    const entries = Array.from({ length: MAX_AGENT_READ_WORKSPACES + 1 }, (_, index) => ({ id: `ws-${index}` }))
    const foreign = await clues.ensure({
      workspaceId: entries.at(-1)!.id,
      sourceId: 'test.alpha',
      typeId: 'test.alpha.text',
      locator: { id: 'far' },
      title: 'Far',
    })
    const value = await readClueReference(
      { workspaceId: 'ws-0', token: token('clue', foreign.clue.id) },
      { clues, registry: registry(entries) },
    )
    expect(value).toMatchObject({ status: 'error', kind: 'clue', error: { category: 'not-found' } })
  })
})

// ── UI19 discussion follow-up ──────────────────────────────────────────────

/** The target public comments-reader signature the parent service will wire. */
type CommentsList = (
  params: ClueCommentsListParams,
  options?: ClueCallOptions,
) => Promise<ClueDiscussionPage>

/**
 * Install the parent-owned comments method on a real service instance.
 *
 * The shared `service.ts` in this slot does not expose `commentsList` yet
 * (parent wiring is pending), so the tests exercise the reader against the
 * TARGET public signature without editing the shared file or degrading the
 * call to a body re-read.
 */
function stubCommentsList(clues: CluesService, list: CommentsList): void {
  ;(clues as unknown as { commentsList: CommentsList }).commentsList = list
}

/** One valid discussion page used by the reader projections. */
function discussion(): ClueDiscussionPage {
  return {
    status: 'ok',
    items: [
      {
        id: 'comment-1',
        kind: 'comment',
        format: 'text/markdown',
        body: 'First page',
        author: { id: 'user-1', name: 'Ada' },
        createdAt: NOW,
        replyCount: 2,
        nextRepliesCursor: 'replies-1',
      },
    ],
    fetchedAt: NOW,
    nextCursor: 'page-2',
    total: 3,
    complete: false,
    coverage: 'document',
  }
}

describe('readClueReference — discussion follow-up', () => {
  it('lists a comments page by cursor/parentId without reading the clue body', async () => {
    const clues = makeService()
    let reads = 0
    clues.registerSource(source('test.discussion', async () => {
      reads += 1
      return { format: 'text/plain', data: {}, text: 'live body', fetchedAt: NOW }
    }))
    const ensured = await clues.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.discussion',
      typeId: 'test.discussion.text',
      locator: { id: 'a' },
      title: 'Discussion',
    })
    const calls: Array<{ params: ClueCommentsListParams; options?: ClueCallOptions }> = []
    stubCommentsList(clues, async (params, options) => {
      calls.push({ params, ...(options === undefined ? {} : { options }) })
      return discussion()
    })

    const value = await readClueReference(
      {
        workspaceId: 'ws-1',
        token: token('clue', ensured.clue.id),
        commentsCursor: 'page-2',
        parentId: 'comment-9',
      },
      { clues, registry: registry(), sessionId: 'session-1' },
    )

    expect(value).toMatchObject({
      status: 'ok',
      kind: 'clue',
      id: ensured.clue.id,
      token: serializeClueToken('clue', ensured.clue.id),
      workspaceId: 'ws-1',
      title: 'Discussion',
      sourceId: 'test.discussion',
      typeId: 'test.discussion.text',
      discussion: discussion(),
    })
    // A comments page is not a body read: neither the text nor freshness of
    // the resource may appear, and the source's read operation never runs.
    expect(value.text).toBeUndefined()
    expect(value.freshness).toBeUndefined()
    expect(reads).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params).toMatchObject({
      workspaceId: 'ws-1',
      clueId: ensured.clue.id,
      cursor: 'page-2',
      parentId: 'comment-9',
    })
    expect(calls[0]!.options).toMatchObject({ caller: 'agent', sessionId: 'session-1' })
  })

  it('lists replies by parentId alone and forwards the abort signal', async () => {
    const clues = makeService()
    let reads = 0
    clues.registerSource(source('test.replies', async () => {
      reads += 1
      return { format: 'text/plain', data: {}, text: 'body', fetchedAt: NOW }
    }))
    const ensured = await clues.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.replies',
      typeId: 'test.replies.text',
      locator: { id: 'a' },
      title: 'Replies',
    })
    let seen: { params: ClueCommentsListParams; options?: ClueCallOptions } | undefined
    stubCommentsList(clues, async (params, options) => {
      seen = { params, ...(options === undefined ? {} : { options }) }
      return { ...discussion(), nextCursor: undefined }
    })
    const controller = new AbortController()

    const value = await readClueReference(
      { workspaceId: 'ws-1', token: token('clue', ensured.clue.id), parentId: 'comment-1' },
      { clues, registry: registry(), signal: controller.signal },
    )

    expect(value).toMatchObject({ status: 'ok', discussion: { status: 'ok' } })
    expect(reads).toBe(0)
    expect(seen?.params).toMatchObject({ clueId: ensured.clue.id, parentId: 'comment-1' })
    expect(seen?.params.cursor).toBeUndefined()
    expect(seen?.options?.signal).toBe(controller.signal)
  })

  it('projects the first discussion page carried by a live read', async () => {
    const clues = makeService()
    const page = discussion()
    clues.registerSource(source('test.read-discussion', async () => ({
      format: 'text/plain',
      data: {},
      text: 'live body',
      fetchedAt: NOW,
      discussion: page,
    })))
    const ensured = await clues.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.read-discussion',
      typeId: 'test.read-discussion.text',
      locator: { id: 'a' },
      title: 'Read discussion',
    })

    const value = await readClueReference(
      { workspaceId: 'ws-1', token: token('clue', ensured.clue.id) },
      { clues, registry: registry() },
    )

    expect(value).toMatchObject({ status: 'ok', text: 'live body', discussion: page })
  })

  it('projects a captured snapshot discussion and marks a legacy snapshot not-captured', async () => {
    const root = tempRoot()
    const store = new CluesStore({ root })
    let next = 0
    const clues = createCluesService({ store, now: () => NOW, newId: kind => `${kind}-${++next}` })
    clues.registerSource(source('test.snapshots'))
    const ensured = await clues.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.snapshots',
      typeId: 'test.snapshots.text',
      locator: { id: 'a' },
      title: 'Snapshots',
    })
    const page = discussion()
    // The shared service does not forward `discussion` into its snapshot
    // content yet (parent wiring is pending), so seed the captured page through
    // the store under test. The reader still goes through the real service.
    await store.putSnapshot('ws-1', {
      snapshotId: 'snap-captured',
      workspaceId: 'ws-1',
      clueId: ensured.clue.id,
      format: 'text/markdown',
      fetchedAt: NOW,
      createdAt: NOW,
    }, {
      format: 'text/markdown',
      data: { text: 'captured body' },
      text: 'captured body',
      discussion: page,
    })
    const capturedValue = await readClueReference(
      { workspaceId: 'ws-1', token: token('snapshot', 'snap-captured') },
      { clues, registry: registry() },
    )
    expect(capturedValue).toMatchObject({ status: 'ok', kind: 'snapshot', discussion: page })

    await store.putSnapshot('ws-1', {
      snapshotId: 'snap-legacy',
      workspaceId: 'ws-1',
      clueId: ensured.clue.id,
      format: 'text/plain',
      fetchedAt: NOW,
      createdAt: NOW,
    }, {
      format: 'text/plain',
      data: { text: 'legacy body' },
      text: 'legacy body',
    })
    const legacyValue = await readClueReference(
      { workspaceId: 'ws-1', token: token('snapshot', 'snap-legacy') },
      { clues, registry: registry() },
    )
    expect(legacyValue).toMatchObject({
      status: 'ok',
      kind: 'snapshot',
      discussion: {
        status: 'not-captured',
        items: [],
        fetchedAt: NOW,
        complete: false,
        coverage: 'document',
      },
    })
  })

  it('refuses comments pagination on snapshot and pack tokens', async () => {
    const clues = makeService()
    for (const kind of ['snapshot', 'pack'] as const) {
      const value = await readClueReference(
        { workspaceId: 'ws-1', token: token(kind, 'missing'), commentsCursor: 'page-2' },
        { clues, registry: registry() },
      )
      expect(value, kind).toMatchObject({
        status: 'error',
        kind,
        error: { category: 'invalid-request' },
      })
    }
  })

  it('validates commentsCursor and parentId as non-empty strings', async () => {
    const clues = makeService()
    const cases: Array<{ readonly commentsCursor?: unknown; readonly parentId?: unknown }> = [
      { commentsCursor: '' },
      { commentsCursor: '   ' },
      { commentsCursor: 1 },
      { commentsCursor: null },
      { parentId: '' },
      { parentId: ' \n ' },
      { parentId: 42 },
      { parentId: null },
    ]
    for (const fields of cases) {
      const value = await readClueReference(
        {
          workspaceId: 'ws-1',
          token: token('clue', 'clue-missing'),
          ...fields,
        } as unknown as ClueReaderRequest,
        { clues, registry: registry() },
      )
      expect(value, JSON.stringify(fields)).toMatchObject({
        status: 'error',
        kind: 'clue',
        error: { category: 'invalid-request' },
      })
    }
  })

  it('projects a comments-page failure as a fixed safe error', async () => {
    const clues = makeService()
    clues.registerSource(source('test.comments-fail'))
    const ensured = await clues.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.comments-fail',
      typeId: 'test.comments-fail.text',
      locator: { id: 'a' },
      title: 'Comments fail',
    })
    stubCommentsList(clues, async () => {
      throw new Error('SECRET=super-secret TOKEN=abc')
    })

    const value = await readClueReference(
      { workspaceId: 'ws-1', token: token('clue', ensured.clue.id), commentsCursor: 'page-2' },
      { clues, registry: registry(), sessionId: 'session-1' },
    )

    expect(value).toMatchObject({
      status: 'error',
      kind: 'clue',
      id: ensured.clue.id,
      error: { category: 'failed' },
    })
    expect(JSON.stringify(value)).not.toContain('super-secret')
    expect(JSON.stringify(value)).not.toContain('SECRET=')
    expect(JSON.stringify(value)).not.toContain('TOKEN=')
  })
})
