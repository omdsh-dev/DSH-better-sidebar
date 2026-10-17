/**
 * S1 clue service contract: the host-authoritative registry and domain
 * operations.
 *
 * The cases pin the semantics the rest of the feature line builds on:
 * - registration is explicit (duplicate ids rejected, reserved ids refused),
 *   unload only removes runtime capability and re-registration restores reads
 *   of already-persisted references;
 * - every source operation is dispatched with the caller's abort signal, and
 *   thrown values are normalized to fixed categories WITHOUT echoing the
 *   original message (transport output/tokens must never reach the wire);
 * - stable identity comes from the source-normalized locator: the same
 *   resource re-ensures to the SAME clue id, in this workspace only;
 * - packs are de-duplicated member sets; removing a pin/binding/pack member or
 *   deleting a pack never deletes a clue or its members;
 * - optimistic writes are refused with `conflict` and the old document stays
 *   on disk;
 * - snapshots stay readable from a fresh store/service instance (no source
 *   runtime needed).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCluesService, type CluesService, type ClueSourceRegistration } from '../src/clues/service.ts'
import { CluesStore } from '../src/clues/store.ts'
import {
  ClueError,
  type ClueCandidate,
  type ClueListResult,
} from '../src/clues/types.ts'
import { removeTree } from './temp-tree.ts'

const roots: string[] = []

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-clues-service-'))
  roots.push(path)
  return path
}

afterEach(() => {
  for (const path of roots.splice(0)) removeTree(path)
})

/** Deterministic clock. */
const NOW = '2026-10-17T00:00:00.000Z'

/** A service with deterministic ids on a fresh temp root. */
function makeService(root = tempRoot()): CluesService {
  let next = 0
  return createCluesService({
    root,
    now: () => NOW,
    newId: kind => `${kind}-${++next}`,
  })
}

interface TestSourceOptions {
  sourceId?: string
  typeId?: string
  capabilities?: Partial<ClueSourceRegistration['descriptor']['capabilities']>
  typeCapabilities?: Partial<ClueSourceRegistration['types'][number]['capabilities']>
  operations?: ClueSourceRegistration['operations']
}

/** One minimal source whose locator is `{ id }` and whose key is `id:<id>`. */
function testSource(options: TestSourceOptions = {}): ClueSourceRegistration {
  const sourceId = options.sourceId ?? 'test.source'
  const typeId = options.typeId ?? `${sourceId}.text`
  const capabilities = {
    resolve: true,
    list: true,
    search: true,
    read: true,
    edit: true,
    portable: true,
    ...options.capabilities,
  }
  const defaultOperations: NonNullable<ClueSourceRegistration['operations']> = {
    async resolve(input) {
      const id = input.locator?.id ?? input.text
      if (typeof id !== 'string' || id === '') return undefined
      return {
        sourceId,
        typeId,
        locator: { id },
        title: `title:${id}`,
      }
    },
    async list(input) {
      const cursor = input.cursor === undefined ? 0 : Number(input.cursor)
      const limit = input.limit ?? 2
      const all = ['a', 'b', 'c'].slice(cursor, cursor + limit)
      return {
        items: all.map(id => ({ sourceId, typeId, locator: { id }, title: `title:${id}` })),
        ...(cursor + limit < 3 ? { nextCursor: String(cursor + limit) } : {}),
      }
    },
    async search(input) {
      return {
        items: [{ sourceId, typeId, locator: { id: input.query }, title: `found:${input.query}` }],
        total: 1,
      }
    },
    async read(input) {
      return {
        format: 'text/plain',
        data: { id: String(input.locator.id ?? '') },
        revision: 'r1',
        fetchedAt: NOW,
        text: String(input.locator.id),
      }
    },
    async loadEdit(input) {
      return { format: 'text/plain', data: { text: `edit:${input.locator.id}` }, baseRevision: 'r1' }
    },
    async saveEdit(_input) {
      return { revision: 'r2', savedAt: NOW }
    },
    async portable() {
      return { portable: true, locator: { id: 'portable' } }
    },
    normalizeLocator(locator) {
      const id = typeof locator.id === 'string' ? locator.id.trim() : ''
      return { id }
    },
    locatorKey(locator) {
      return `id:${String(locator.id)}`
    },
  }
  return {
    descriptor: {
      sourceId,
      name: `Test ${sourceId}`,
      order: 10,
      pluginId: 'test-plugin',
      types: [typeId],
      transport: 'mcp',
      capabilities,
    },
    types: [{
      typeId,
      sourceId,
      formats: ['text/plain'],
      capabilities: { read: true, edit: true, ...options.typeCapabilities },
    }],
    operations: options.operations ?? defaultOperations,
  }
}

/** Ensure one clue with the standard source. */
async function ensureClue(
  service: CluesService,
  id: string,
  workspaceId = 'ws-1',
  sourceId = 'test.source',
): Promise<string> {
  const typeId = `${sourceId}.text`
  const result = await service.ensure({
    workspaceId,
    sourceId,
    typeId,
    locator: { id },
    title: `title:${id}`,
  })
  return result.clue.id
}

describe('clue service registration', () => {
  it('registers a source + its types and publishes ordered metadata copies', () => {
    const service = makeService()
    const dispose = service.registerSource(testSource())
    expect(service.getSources()).toHaveLength(1)
    expect(service.getSources()[0]?.sourceId).toBe('test.source')
    expect(service.getSources()[0]?.types).toEqual(['test.source.text'])
    expect(service.getTypes('test.source').map(type => type.typeId)).toEqual(['test.source.text'])
    // Copies: mutating the returned array must not mutate the registry.
    const sources = service.getSources() as unknown as { sourceId: string }[]
    sources[0]!.sourceId = 'mutated'
    expect(service.getSource('test.source')?.sourceId).toBe('test.source')
    dispose()
  })

  it('rejects duplicate source ids, duplicate type ids and reserved ids', () => {
    const service = makeService()
    service.registerSource(testSource())
    expect(() => service.registerSource(testSource())).toThrow(/already registered/)
    // A second source cannot claim an id owned by the first.
    const other = testSource({ sourceId: 'other.source', typeId: 'test.source.text' })
    expect(() => service.registerSource(other)).toThrow(/already registered/)
    // The pack library identity is reserved for the core.
    const reserved = testSource({ sourceId: 'builtin.packs', typeId: 'builtin.packs.x' })
    expect(() => service.registerSource(reserved)).toThrow(/reserved/)
  })

  it('reserves every built-in source id and installs built-ins only through construction', () => {
    const builtin = testSource({ sourceId: 'builtin.files', typeId: 'builtin.files.text' })
    const service = createCluesService({
      root: tempRoot(),
      now: () => NOW,
      builtinSources: [builtin],
    })
    expect(service.getSource('builtin.files')?.sourceId).toBe('builtin.files')
    for (const sourceId of [
      'builtin.packs',
      'builtin.files',
      'builtin.github.issues',
      'builtin.github.pulls',
      'builtin.feishu.docs',
      'builtin.feishu.tasks',
    ]) {
      expect(
        () => service.registerSource(testSource({ sourceId })),
        sourceId,
      ).toThrow(/reserved/)
    }
  })

  it('unloads only runtime capability: references survive and re-registration restores reads', async () => {
    const root = tempRoot()
    const service = makeService(root)
    const dispose = service.registerSource(testSource())
    const clueId = await ensureClue(service, 'a')

    dispose()
    expect(service.getSources()).toHaveLength(0)
    // The persisted reference is untouched by an unload.
    expect((await service.listClues('ws-1')).clues.map(clue => clue.id)).toEqual([clueId])
    await expect(service.read({ workspaceId: 'ws-1', clueId })).rejects.toMatchObject({ category: 'source-missing' })

    // Same identity coming back restores resolution of the SAME reference.
    service.registerSource(testSource())
    expect((await service.read({ workspaceId: 'ws-1', clueId })).text).toBe('a')
  })

  it('reports unknown sources and unsupported operations with fixed categories', async () => {
    const service = makeService()
    service.registerSource(testSource({ capabilities: { list: false, search: false } }))
    await expect(service.list({ workspaceId: 'ws-1', sourceId: 'missing.source' }))
      .rejects.toMatchObject({ category: 'source-missing' })
    await expect(service.list({ workspaceId: 'ws-1', sourceId: 'test.source' }))
      .rejects.toMatchObject({ category: 'unsupported' })
    await expect(service.search({ workspaceId: 'ws-1', sourceId: 'test.source', query: 'x' }))
      .rejects.toMatchObject({ category: 'unsupported' })
    await expect(service.read({
      workspaceId: 'ws-1',
      sourceId: 'test.source',
      typeId: 'test.source.nope',
      locator: { id: 'a' },
    })).rejects.toMatchObject({ category: 'unsupported' })
  })

  it('disposes every registration idempotently and refuses late registration', () => {
    const service = makeService()
    service.registerApi('x.y', () => 1)
    service.dispose()
    service.dispose()
    expect(service.hasApi('x.y')).toBe(false)
    expect(() => service.registerSource(testSource())).toThrow(/disposed/)
    // A late API registration must not survive in the cleared service either.
    expect(() => service.registerApi('late.method', () => 1)).toThrow(/disposed/)
    expect(service.hasApi('late.method')).toBe(false)
  })
})

describe('clue service dispatch', () => {
  it('resolves and normalizes candidates, de-duplicating the same resource', async () => {
    const service = makeService()
    service.registerSource({
      ...testSource(),
      operations: {
        ...testSource().operations,
        resolve: async () => [
          { sourceId: 'test.source', typeId: 'test.source.text', locator: { id: '  a  ' }, title: 'a' },
          { sourceId: 'test.source', typeId: 'test.source.text', locator: { id: 'a' }, title: 'again' },
        ] as ClueCandidate[],
      },
    })
    const candidates = await service.resolve({ workspaceId: 'ws-1', text: 'a' })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.locator).toEqual({ id: 'a' })
    expect(candidates[0]?.clueId).toBeUndefined()
  })

  it('marks an already-persisted candidate with its stable clueId', async () => {
    const service = makeService()
    service.registerSource(testSource())
    const clueId = await ensureClue(service, 'a')
    const candidates = await service.resolve({ workspaceId: 'ws-1', text: 'a' })
    expect(candidates[0]?.clueId).toBe(clueId)
  })

  it('auto-resolve keeps going past a source that does not own the input', async () => {
    const service = makeService()
    // Same order, so the alphabetical id decides: the first source sees the
    // text and reports "not mine", the second one owns it.
    service.registerSource(testSource({
      sourceId: 'a.miss',
      typeId: 'a.miss.text',
      operations: {
        ...testSource().operations,
        resolve: async () => { throw new ClueError('not-found', 'no such local path') },
      },
    }))
    service.registerSource(testSource({
      sourceId: 'b.remote',
      typeId: 'b.remote.text',
      operations: {
        ...testSource().operations,
        resolve: async input => ({
          sourceId: 'b.remote',
          typeId: 'b.remote.text',
          locator: { id: String(input.text) },
          title: 'remote',
        }),
      },
    }))

    const candidates = await service.resolve({ workspaceId: 'ws-1', text: 'https://example.com/doc' })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      sourceId: 'b.remote',
      locator: { id: 'https://example.com/doc' },
    })

    // An explicit source still reports its own miss instead of silently [].
    await expect(service.resolve({ workspaceId: 'ws-1', sourceId: 'a.miss', text: 'x' }))
      .rejects.toMatchObject({ category: 'not-found' })
  })

  it('auto-resolve propagates authentication and permission failures', async () => {
    const service = makeService()
    service.registerSource(testSource({
      sourceId: 'a.auth',
      typeId: 'a.auth.text',
      operations: {
        ...testSource().operations,
        resolve: async () => { throw new ClueError('auth-required', 'sign in to continue') },
      },
    }))
    service.registerSource(testSource({ sourceId: 'b.remote', typeId: 'b.remote.text' }))
    await expect(service.resolve({ workspaceId: 'ws-1', text: 'x' }))
      .rejects.toMatchObject({ category: 'auth-required' })
  })

  it('passes cursors through unchanged and never invents a total', async () => {
    const service = makeService()
    const cursors: Array<string | undefined> = []
    service.registerSource(testSource({
      operations: {
        ...testSource().operations,
        list: async (input) => {
          cursors.push(input.cursor)
          const result: ClueListResult = {
            items: [{ sourceId: 'test.source', typeId: 'test.source.text', locator: { id: 'a' }, title: 'a' }],
            nextCursor: 'opaque/cursor==',
          }
          return result
        },
      },
    }))
    const first = await service.list({ workspaceId: 'ws-1', sourceId: 'test.source', cursor: 'pasted/opaque' })
    expect(cursors).toEqual(['pasted/opaque'])
    expect(first.nextCursor).toBe('opaque/cursor==')
    expect('total' in first).toBe(false)
  })

  it('dispatches read/loadEdit/saveEdit with the source-owned types and format', async () => {
    const service = makeService()
    service.registerSource(testSource())
    const clueId = await ensureClue(service, 'a')
    const read = await service.read({ workspaceId: 'ws-1', clueId })
    expect(read.format).toBe('text/plain')
    expect(read.text).toBe('a')
    const edit = await service.loadEdit({ workspaceId: 'ws-1', clueId })
    expect(edit.baseRevision).toBe('r1')
    const saved = await service.saveEdit({
      workspaceId: 'ws-1',
      clueId,
      document: { format: 'text/plain', data: { text: 'changed' }, baseRevision: 'r1' },
    })
    expect(saved.revision).toBe('r2')
    expect((await service.portable({ workspaceId: 'ws-1', clueId })).portable).toBe(true)
  })

  it('passes a source-owned structured format through load/save unmodified', async () => {
    // The core must not depend on Markdown: a namespaced structured format is
    // the source's own business, and the exact document it loaded comes back
    // on save without the core rewriting a single field.
    const service = makeService()
    const saved: unknown[] = []
    service.registerSource({
      descriptor: {
        sourceId: 'test.struct',
        name: 'structured',
        order: 1,
        pluginId: 'test',
        types: ['test.struct.doc'],
        transport: 'mcp',
        capabilities: { resolve: false, list: false, search: false, read: true, edit: true, portable: false },
      },
      types: [{
        typeId: 'test.struct.doc',
        sourceId: 'test.struct',
        formats: ['application/vnd.test.structure+json'],
        capabilities: { read: true, edit: true },
      }],
      operations: {
        async read() {
          return {
            format: 'application/vnd.test.structure+json',
            data: { blocks: [{ kind: 'x', text: 'y' }] },
            revision: 'r1',
            fetchedAt: NOW,
          }
        },
        async loadEdit() {
          return {
            format: 'application/vnd.test.structure+json',
            data: { blocks: [{ kind: 'x', text: 'y' }], unknown: { keep: true } },
            baseRevision: 'r1',
          }
        },
        async saveEdit(input) {
          saved.push(input.document)
          return { revision: 'r2', savedAt: NOW }
        },
      },
    })
    const ensured = await service.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.struct',
      typeId: 'test.struct.doc',
      locator: { id: 'doc-1' },
      title: 'doc',
    })
    const edit = await service.loadEdit({ workspaceId: 'ws-1', clueId: ensured.clue.id })
    expect(edit.format).toBe('application/vnd.test.structure+json')
    expect(edit.data).toEqual({ blocks: [{ kind: 'x', text: 'y' }], unknown: { keep: true } })
    const document = {
      format: 'application/vnd.test.structure+json',
      data: { blocks: [{ kind: 'x', text: 'edited' }], unknown: { keep: true } },
      baseRevision: edit.baseRevision,
    }
    await service.saveEdit({ workspaceId: 'ws-1', clueId: ensured.clue.id, document })
    expect(saved).toEqual([document])
  })

  it('reports portable unsupported sources as unresolved instead of throwing', async () => {
    const service = makeService()
    service.registerSource(testSource({
      capabilities: { portable: false },
      operations: {
        ...testSource().operations,
        portable: undefined,
      },
    }))
    const clueId = await ensureClue(service, 'a')
    expect(await service.portable({ workspaceId: 'ws-1', clueId })).toMatchObject({
      portable: false,
      reason: expect.any(String),
    })
  })

  it('enforces the TYPE read/edit capabilities before dispatch', async () => {
    const service = makeService()
    let editCalls = 0
    let readCalls = 0
    const base = testSource()
    service.registerSource({
      ...base,
      types: base.types.map(type => ({ ...type, capabilities: { read: false, edit: false } })),
      operations: {
        ...base.operations,
        read: async () => { readCalls += 1; return { format: 'text/plain', data: {}, fetchedAt: NOW } },
        loadEdit: async () => {
          editCalls += 1
          return { format: 'text/plain', data: { text: 'x' }, baseRevision: 'r1' }
        },
        saveEdit: async () => {
          editCalls += 1
          return { revision: 'r2', savedAt: NOW }
        },
      },
    })
    const clueId = await ensureClue(service, 'a')

    await expect(service.read({ workspaceId: 'ws-1', clueId }))
      .rejects.toMatchObject({ category: 'unsupported' })
    await expect(service.loadEdit({ workspaceId: 'ws-1', clueId }))
      .rejects.toMatchObject({ category: 'unsupported' })
    await expect(service.saveEdit({
      workspaceId: 'ws-1',
      clueId,
      document: { format: 'text/plain', data: { text: 'x' }, baseRevision: 'r1' },
    })).rejects.toMatchObject({ category: 'unsupported' })
    expect(readCalls).toBe(0)
    expect(editCalls).toBe(0)
  })

  it('enforces the source-level edit/portable capabilities before dispatch', async () => {
    const service = makeService()
    let editCalls = 0
    let portableCalls = 0
    const base = testSource()
    service.registerSource({
      ...base,
      descriptor: { ...base.descriptor, capabilities: { ...base.descriptor.capabilities, edit: false, portable: false } },
      operations: {
        ...base.operations,
        loadEdit: async () => {
          editCalls += 1
          return { format: 'text/plain', data: { text: 'x' }, baseRevision: 'r1' }
        },
        portable: async () => {
          portableCalls += 1
          return { portable: true, locator: { id: 'p' } }
        },
      },
    })
    const clueId = await ensureClue(service, 'a')
    await expect(service.loadEdit({ workspaceId: 'ws-1', clueId }))
      .rejects.toMatchObject({ category: 'unsupported' })
    // A declared `portable: false` source keeps the reference unresolved even
    // when an operation implementation is still present.
    expect(await service.portable({ workspaceId: 'ws-1', clueId })).toMatchObject({ portable: false })
    expect(editCalls).toBe(0)
    expect(portableCalls).toBe(0)
  })

  it('forwards the payload session id to loadEdit/saveEdit/portable', async () => {
    const service = makeService()
    const seen: Array<string | undefined> = []
    const base = testSource()
    service.registerSource({
      ...base,
      operations: {
        ...base.operations,
        loadEdit: async (_input, context) => {
          seen.push(context.sessionId)
          return { format: 'text/plain', data: { text: 'x' }, baseRevision: 'r1' }
        },
        saveEdit: async (_input, context) => {
          seen.push(context.sessionId)
          return { revision: 'r2', savedAt: NOW }
        },
        portable: async (_input, context) => {
          seen.push(context.sessionId)
          return { portable: true, locator: { id: 'p' } }
        },
      },
    })
    const clueId = await ensureClue(service, 'a')
    await service.loadEdit({ workspaceId: 'ws-1', clueId, sessionId: 'session-payload' })
    await service.saveEdit({
      workspaceId: 'ws-1',
      clueId,
      sessionId: 'session-payload',
      document: { format: 'text/plain', data: { text: 'x' }, baseRevision: 'r1' },
    })
    await service.portable({ workspaceId: 'ws-1', clueId, sessionId: 'session-payload' })
    expect(seen).toEqual(['session-payload', 'session-payload', 'session-payload'])
  })

  it('reports cancellation when the signal aborts while a source call is in flight', async () => {
    const service = makeService()
    const controller = new AbortController()
    const base = testSource()
    service.registerSource({
      ...base,
      operations: {
        ...base.operations,
        read: async () => {
          controller.abort()
          return { format: 'text/plain', data: {}, fetchedAt: NOW }
        },
      },
    })
    const clueId = await ensureClue(service, 'a')
    await expect(service.read({ workspaceId: 'ws-1', clueId }, { signal: controller.signal }))
      .rejects.toMatchObject({ category: 'cancelled' })
  })

  it('normalizes thrown source failures without leaking the original message', async () => {
    const service = makeService()
    service.registerSource(testSource({
      operations: {
        ...testSource().operations,
        read: async () => {
          throw new Error('Authorization: Bearer super-secret-token; stdout: boom')
        },
      },
    }))
    const clueId = await ensureClue(service, 'a')
    const failure: unknown = await service.read({ workspaceId: 'ws-1', clueId })
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(ClueError)
    const clueFailure = failure as ClueError
    expect(clueFailure.category).toBe('failed')
    expect(clueFailure.message).not.toContain('super-secret')
    expect(clueFailure.message).not.toContain('stdout')
    expect(clueFailure.message).toContain('test.source')
  })

  it('honors an already-aborted signal on every source operation', async () => {
    const service = makeService()
    service.registerSource(testSource())
    const clueId = await ensureClue(service, 'a')
    const controller = new AbortController()
    controller.abort()
    await expect(service.read({ workspaceId: 'ws-1', clueId }, { signal: controller.signal }))
      .rejects.toMatchObject({ category: 'cancelled' })
    await expect(service.list({ workspaceId: 'ws-1', sourceId: 'test.source' }, { signal: controller.signal }))
      .rejects.toMatchObject({ category: 'cancelled' })
    await expect(service.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.source',
      typeId: 'test.source.text',
      locator: { id: 'b' },
      title: 'b',
    }, { signal: controller.signal })).rejects.toMatchObject({ category: 'cancelled' })
  })

  it('forwards the caller identity and abort signal to the source', async () => {
    const service = makeService()
    const seen: Array<{ caller?: string; aborted?: boolean }> = []
    const controller = new AbortController()
    service.registerSource(testSource({
      operations: {
        ...testSource().operations,
        read: async (_input, context) => {
          seen.push({ caller: context.caller, aborted: context.signal?.aborted })
          return { format: 'text/plain', data: { ok: true }, fetchedAt: NOW }
        },
      },
    }))
    const clueId = await ensureClue(service, 'a')
    await service.read({ workspaceId: 'ws-1', clueId }, { caller: 'agent', signal: controller.signal })
    expect(seen).toEqual([{ caller: 'agent', aborted: false }])
  })
})

describe('clue stable identity and library', () => {
  it('re-ensures the same normalized locator to the same id (created:false)', async () => {
    const service = makeService()
    service.registerSource(testSource())
    const first = await service.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.source',
      typeId: 'test.source.text',
      locator: { id: '  a  ' },
      title: 'one',
    })
    expect(first.created).toBe(true)
    const second = await service.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.source',
      typeId: 'test.source.text',
      locator: { id: 'a' },
      title: 'two',
    })
    expect(second.created).toBe(false)
    expect(second.clue.id).toBe(first.clue.id)
    // The original title is not overwritten by a later ensure.
    expect(second.clue.title).toBe('one')
    expect((await service.listClues('ws-1')).clues).toHaveLength(1)
  })

  it('mints exactly one clue for concurrent ensures of the same resource', async () => {
    const service = makeService()
    service.registerSource(testSource())
    const results = await Promise.all(Array.from({ length: 8 }, () => service.ensure({
      workspaceId: 'ws-1',
      sourceId: 'test.source',
      typeId: 'test.source.text',
      locator: { id: 'same' },
      title: 'same',
    })))
    expect(results.filter(result => result.created)).toHaveLength(1)
    expect(new Set(results.map(result => result.clue.id)).size).toBe(1)
    expect((await service.listClues('ws-1')).clues).toHaveLength(1)
  })

  it('keeps workspaces isolated and survives a restart', async () => {
    const root = tempRoot()
    const service = makeService(root)
    service.registerSource(testSource())
    const ws1 = await ensureClue(service, 'a', 'ws-1')
    await ensureClue(service, 'a', 'ws-2')
    expect((await service.listClues('ws-2')).clues.map(clue => clue.id)).not.toContain(ws1)

    const restarted = makeService(root)
    restarted.registerSource(testSource())
    expect((await restarted.listClues('ws-1')).clues[0]?.id).toBe(ws1)
    expect((await restarted.read({ workspaceId: 'ws-1', clueId: ws1 })).text).toBe('a')
  })
})

describe('packs, pins and bindings', () => {
  it('de-duplicates pack members and reuses clues across packs', async () => {
    const service = makeService()
    service.registerSource(testSource())
    const a = await ensureClue(service, 'a')
    const b = await ensureClue(service, 'b')
    const created = await service.createPack({ workspaceId: 'ws-1', name: '  My pack  ', members: [a, b, a] })
    expect(created.pack.name).toBe('My pack')
    expect(created.pack.members).toEqual([a, b])
    const added = await service.addPackMember({ workspaceId: 'ws-1', packId: created.pack.id, clueId: a })
    expect(added.pack.members).toEqual([a, b])
    expect(added.pack.revision).toBe(created.pack.revision)

    const second = await service.createPack({ workspaceId: 'ws-1', name: 'Second', members: [a] })
    expect(second.pack.members).toEqual([a])
    // Removing the member from one pack leaves the clue and the other pack.
    const removed = await service.removePackMember({ workspaceId: 'ws-1', packId: created.pack.id, clueId: a })
    expect(removed.pack.members).toEqual([b])
    expect((await service.listClues('ws-1')).clues.map(clue => clue.id).sort()).toEqual([a, b].sort())
    expect((await service.listPacks('ws-1')).packs.find(pack => pack.id === second.pack.id)?.members).toEqual([a])
  })

  it('deletes only the pack: members, other packs and clue records remain', async () => {
    const service = makeService()
    service.registerSource(testSource())
    const a = await ensureClue(service, 'a')
    const pack = await service.createPack({ workspaceId: 'ws-1', name: 'Pack', members: [a] })
    await service.addBinding({ workspaceId: 'ws-1', target: { kind: 'pack', packId: pack.pack.id } })
    const result = await service.deletePack({ workspaceId: 'ws-1', packId: pack.pack.id })
    expect(result.deleted).toBe(true)
    expect(result.packs).toEqual([])
    expect((await service.listBindings('ws-1')).bindings).toEqual([])
    expect((await service.listClues('ws-1')).clues.map(clue => clue.id)).toEqual([a])
    expect((await service.read({ workspaceId: 'ws-1', clueId: a })).text).toBe('a')
  })

  it('pins and bindings never gate reading, and removing them deletes nothing', async () => {
    const service = makeService()
    service.registerSource(testSource())
    const a = await ensureClue(service, 'a')
    const pinned = await service.addPin({ workspaceId: 'ws-1', clueId: a })
    expect(pinned.pins.map(pin => pin.clueId)).toEqual([a])
    await service.addBinding({ workspaceId: 'ws-1', target: { kind: 'clue', clueId: a } })
    const afterRemove = await service.removePin({ workspaceId: 'ws-1', clueId: a })
    expect(afterRemove.pins).toEqual([])
    const bindings = await service.removeBinding({ workspaceId: 'ws-1', target: { kind: 'clue', clueId: a } })
    expect(bindings.bindings).toEqual([])
    expect((await service.read({ workspaceId: 'ws-1', clueId: a })).text).toBe('a')
  })

  it('refuses stale pack revisions with conflict and leaves the old row on disk', async () => {
    const root = tempRoot()
    const service = makeService(root)
    service.registerSource(testSource())
    const pack = await service.createPack({ workspaceId: 'ws-1', name: 'Old' })
    await expect(service.renamePack({
      workspaceId: 'ws-1',
      packId: pack.pack.id,
      name: 'New',
      expectedRevision: pack.pack.revision - 1,
    })).rejects.toMatchObject({ category: 'conflict' })
    const persisted = await new CluesStore({ root }).read('ws-1')
    expect(persisted.packs[0]?.name).toBe('Old')
  })

  it('returns an explicit packRevision: pack CAS and workspace revision are distinct domains', async () => {
    const service = makeService()
    service.registerSource(testSource())
    const a = await ensureClue(service, 'a')
    const b = await ensureClue(service, 'b')
    const created = await service.createPack({ workspaceId: 'ws-1', name: 'Pack', members: [a] })
    // Creation uses the WORKSPACE revision; the returned result still states
    // the new pack's own revision explicitly.
    expect(created.packRevision).toBe(created.pack.revision)
    expect(created.revision).toBeGreaterThanOrEqual(created.packRevision)

    // Feeding the returned packRevision to a pack mutation succeeds…
    const renamed = await service.renamePack({
      workspaceId: 'ws-1',
      packId: created.pack.id,
      name: 'Renamed',
      expectedRevision: created.packRevision,
    })
    expect(renamed.packRevision).toBe(created.packRevision + 1)
    expect(renamed.revision).toBeGreaterThan(created.revision)

    // …while the top-level (workspace) revision is NOT a pack CAS value: a
    // client that fed it back would get a spurious conflict.
    await expect(service.addPackMember({
      workspaceId: 'ws-1',
      packId: created.pack.id,
      clueId: b,
      expectedRevision: renamed.revision,
    })).rejects.toMatchObject({ category: 'conflict' })

    const added = await service.addPackMember({
      workspaceId: 'ws-1',
      packId: created.pack.id,
      clueId: b,
      expectedRevision: renamed.packRevision,
    })
    expect(added.packRevision).toBe(renamed.packRevision + 1)
    const deleted = await service.deletePack({
      workspaceId: 'ws-1',
      packId: created.pack.id,
      expectedRevision: added.packRevision,
    })
    expect(deleted.packRevision).toBe(added.packRevision)
    expect((await service.listPacks('ws-1')).packs).toEqual([])
  })

  it('refuses a stale workspace revision for pin/binding writes and keeps the committed rows', async () => {
    const root = tempRoot()
    const service = makeService(root)
    service.registerSource(testSource())
    const a = await ensureClue(service, 'a')
    await service.addPin({ workspaceId: 'ws-1', clueId: a })
    const state = await new CluesStore({ root }).read('ws-1')
    await expect(service.removePin({ workspaceId: 'ws-1', clueId: a, expectedRevision: 0 }))
      .rejects.toMatchObject({ category: 'conflict' })
    expect((await new CluesStore({ root }).read('ws-1')).pins).toHaveLength(1)
    expect(state.revision).toBeGreaterThan(0)
    await expect(service.addBinding({
      workspaceId: 'ws-1',
      target: { kind: 'clue', clueId: a },
      expectedRevision: 0,
    })).rejects.toMatchObject({ category: 'conflict' })
  })

  it('validates pack names and member existence', async () => {
    const service = makeService()
    service.registerSource(testSource())
    await expect(service.createPack({ workspaceId: 'ws-1', name: '   ' }))
      .rejects.toMatchObject({ category: 'failed' })
    await expect(service.createPack({ workspaceId: 'ws-1', name: 'x', members: ['nope'] }))
      .rejects.toMatchObject({ category: 'not-found' })
    const pack = await service.createPack({ workspaceId: 'ws-1', name: 'x' })
    await expect(service.addPackMember({ workspaceId: 'ws-1', packId: pack.pack.id, clueId: 'nope' }))
      .rejects.toMatchObject({ category: 'not-found' })
    await expect(service.renamePack({ workspaceId: 'ws-1', packId: 'missing', name: 'y' }))
      .rejects.toMatchObject({ category: 'not-found' })
  })
})

describe('snapshots', () => {
  it('writes, lists and reads snapshots without any source runtime, surviving a restart', async () => {
    const root = tempRoot()
    const service = makeService(root)
    service.registerSource(testSource())
    const clueId = await ensureClue(service, 'a')
    const meta = await service.putSnapshot('ws-1', {
      clueId,
      format: 'text/plain',
      data: { id: 'a' },
      text: 'snapshot body',
      fetchedAt: NOW,
      integrity: 'verified',
    })
    expect(meta.clueId).toBe(clueId)

    const restarted = makeService(root)
    // No sources registered at all: snapshots are core storage.
    const record = await restarted.readSnapshot({ workspaceId: 'ws-1', snapshotId: meta.snapshotId })
    expect(record.content.text).toBe('snapshot body')
    expect(record.meta.integrity).toBe('verified')
    expect((await restarted.listSnapshots('ws-1')).map(row => row.snapshotId)).toEqual([meta.snapshotId])
  })

  it('refuses a snapshot for a clue that is not in the workspace', async () => {
    const service = makeService()
    service.registerSource(testSource())
    await expect(service.putSnapshot('ws-1', { clueId: 'missing', format: 'text/plain', data: {} }))
      .rejects.toMatchObject({ category: 'not-found' })
  })

  it('appends a second snapshot for the same clue instead of overwriting the first', async () => {
    const service = makeService()
    service.registerSource(testSource())
    const clueId = await ensureClue(service, 'a')
    const first = await service.putSnapshot('ws-1', { clueId, format: 'text/plain', data: { n: 1 } })
    const second = await service.putSnapshot('ws-1', { clueId, format: 'text/plain', data: { n: 2 } })
    expect(second.snapshotId).not.toBe(first.snapshotId)
    expect((await service.readSnapshot({ workspaceId: 'ws-1', snapshotId: first.snapshotId })).content.data)
      .toEqual({ n: 1 })
  })
})

describe('API method seam', () => {
  it('registers/invokes and rejects duplicate method names; disposer removes exactly one', async () => {
    const service = makeService()
    const dispose = service.registerApi('later.method', payload => ({ payload }))
    expect(service.hasApi('later.method')).toBe(true)
    expect(await service.invokeApi('later.method', { a: 1 })).toEqual({ payload: { a: 1 } })
    expect(() => service.registerApi('later.method', () => 2)).toThrow(/already registered/)
    dispose()
    expect(service.hasApi('later.method')).toBe(false)
    await expect(service.invokeApi('later.method', {})).rejects.toMatchObject({ category: 'not-found' })
  })

  it('refuses an invocation whose signal is already aborted', async () => {
    const service = makeService()
    service.registerApi('later.method', () => 1)
    const controller = new AbortController()
    controller.abort()
    await expect(service.invokeApi('later.method', {}, { caller: 'ui', signal: controller.signal }))
      .rejects.toMatchObject({ category: 'cancelled' })
  })

  it('public identity constants mirror the fixed vocabulary', () => {
    const service = makeService()
    expect(service.codecs).toEqual({ clues: 'better-sidebar:clues', packs: 'better-sidebar:packs' })
    expect(service.builtinSourceIds).toContain('builtin.files')
    expect(service.builtinSourceIds).toContain('builtin.github.issues')
  })
})
