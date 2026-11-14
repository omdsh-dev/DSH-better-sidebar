/**
 * S1 clue service contract: the host-authoritative registry and domain
 * operations.
 *
 * Pinned semantics:
 * - registration is explicit (duplicate ids rejected, reserved ids refused);
 *   unload only removes runtime capability and re-registration restores reads
 *   of already-persisted references;
 * - every source operation gets the caller's abort signal, and thrown values
 *   are normalized to fixed categories WITHOUT echoing the original message
 *   (transport output/tokens must never reach the wire);
 * - identity comes from the source-normalized locator: re-ensuring the same
 *   resource returns the SAME clue id, in this workspace only;
 * - packs are de-duplicated member sets; removing a pin/binding/pack member or
 *   deleting a pack never deletes a clue;
 * - optimistic writes are refused with `conflict` and the old row stays on disk;
 * - snapshots stay readable from a fresh store/service instance.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCluesService, type CluesService, type ClueSourceRegistration } from '../src/clues/service.ts'
import { CluesStore, type ClueTransactionResult, type WorkspaceState } from '../src/clues/store.ts'
import {
  ClueError, type ClueCandidate, type ClueListResult, type CluePortableRef, type ClueResourceInfo,
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
  return createCluesService({ root, now: () => NOW, newId: kind => `${kind}-${++next}` })
}
/** Assert a rejected call carries a fixed clue category (and optional message). */
async function fails(run: () => Promise<unknown>, category: ClueError['category'], message?: string): Promise<void> {
  const failure = await run().then(() => undefined, (error: unknown) => error)
  expect(failure).toBeInstanceOf(ClueError)
  expect(failure).toMatchObject({ category, ...(message === undefined ? {} : { message: expect.stringContaining(message) }) })
}
interface TestSourceOptions {
  sourceId?: string
  typeId?: string
  format?: string
  capabilities?: Partial<ClueSourceRegistration['descriptor']['capabilities']>
  typeCapabilities?: Partial<ClueSourceRegistration['types'][number]['capabilities']>
  operations?: ClueSourceRegistration['operations']
}
/** One minimal source whose locator is `{ id }`; identity is the trimmed id. */
function testSource(options: TestSourceOptions = {}): ClueSourceRegistration {
  const sourceId = options.sourceId ?? 'test.source'
  const typeId = options.typeId ?? `${sourceId}.text`
  const format = options.format ?? 'text/plain'
  return {
    descriptor: {
      sourceId, name: `Test ${sourceId}`, order: 10, pluginId: 'test-plugin', types: [typeId], transport: 'mcp',
      capabilities: { resolve: true, list: true, search: true, read: true, edit: true, portable: true, ...options.capabilities },
    },
    types: [{
      typeId, sourceId, formats: [format], capabilities: { read: true, edit: true, concurrency: 'check-before-save', ...options.typeCapabilities },
    }],
    operations: options.operations ?? {
      async read(input) { return { format, data: { id: String(input.locator.id ?? '') }, revision: 'r1', fetchedAt: NOW, text: String(input.locator.id) } },
      async list() { return { items: [{ sourceId, typeId, locator: { id: 'a' }, title: 'a' }] } },
      async loadEdit(input) { return { format, data: { text: `edit:${String(input.locator.id)}` }, baseRevision: 'r1' } },
      async saveEdit() { return { revision: 'r2', savedAt: NOW } },
      async portable() { return { portable: true, locator: { id: 'portable' } } },
      normalizeLocator(locator) { return { id: typeof locator.id === 'string' ? locator.id.trim() : '' } },
    },
  }
}
/** Ensure one clue with the standard source. */
async function ensureClue(service: CluesService, id: string, workspaceId = 'ws-1'): Promise<string> {
  const result = await service.ensure({ workspaceId, sourceId: 'test.source', typeId: 'test.source.text', locator: { id }, title: `title:${id}` })
  return result.clue.id
}
/** A save-metadata source whose save result is the authoritative `info` given. */
function saveMetadataSource(info: ClueResourceInfo | undefined): { registration: ClueSourceRegistration; received(): unknown; saveCalls(): number } {
  let received: unknown
  let saveCalls = 0
  const typeId = 'test.save-meta.text'
  return {
    registration: {
      descriptor: {
        sourceId: 'test.save-meta', name: 'save metadata source', order: 10, pluginId: 'test', types: [typeId], transport: 'mcp',
        capabilities: { resolve: false, list: false, search: false, read: false, edit: true, portable: false },
      },
      types: [{ typeId, sourceId: 'test.save-meta', formats: ['text/plain'], capabilities: { read: false, edit: true, concurrency: 'check-before-save' } }],
      operations: {
        normalizeLocator(locator) { return { id: typeof locator.id === 'string' ? locator.id.trim() : '' } },
        async saveEdit(input) {
          received = input.document
          saveCalls += 1
          return { revision: 'r2', savedAt: NOW, ...(info === undefined ? {} : { info }) }
        },
      },
    },
    received: () => received,
    saveCalls: () => saveCalls,
  }
}
/** A store whose metadata transaction can be made to fail AFTER a source save. */
class FailingMetadataStore extends CluesStore {
  failMetadataWrites = false
  override transact<T>(workspaceId: string, expectedRevision: number | undefined, mutate: (state: WorkspaceState) => T, options?: { readonly writeIf?: (result: T) => boolean }): Promise<ClueTransactionResult<T>> {
    if (this.failMetadataWrites) return Promise.reject(new ClueError('failed', 'metadata write failed'))
    return super.transact(workspaceId, expectedRevision, mutate, options)
  }
}
describe('clue service registration', () => {
  it('publishes isolated metadata copies, including namespaced extensions', async () => {
    const service = makeService()
    const registration = testSource()
    const dispose = service.registerSource(registration)
    expect(service.getSources().map(source => source.sourceId)).toEqual(['test.source'])
    expect(service.getSources()[0]?.types).toEqual(['test.source.text'])
    expect(service.getTypes('test.source').map(type => type.typeId)).toEqual(['test.source.text'])
    // Copies, including the NESTED objects: a shallow spread used to share
    // `capabilities`, so mutating one returned row disabled dispatch.
    const sources = service.getSources() as unknown as Array<{ sourceId: string; types: string[]; capabilities: { read: boolean } }>
    sources[0]!.sourceId = 'mutated'
    sources[0]!.types.push('mutated')
    sources[0]!.capabilities.read = false
    const types = service.getTypes() as unknown as Array<{ formats: string[]; capabilities: { edit: boolean } }>
    types[0]!.formats.push('mutated')
    types[0]!.capabilities.edit = false
    expect(service.getSource('test.source')).toMatchObject({ sourceId: 'test.source', types: ['test.source.text'], capabilities: { read: true } })
    expect(service.getTypes()[0]).toMatchObject({ formats: ['text/plain'], capabilities: { edit: true } })
    // The registry snapshotted the registration itself; the source still dispatches.
    ;(registration.descriptor.capabilities as { read: boolean }).read = false
    ;(registration.types[0]!.capabilities as { edit: boolean }).edit = false
    expect(service.getSource('test.source')?.capabilities.read).toBe(true)
    expect(service.getTypes('test.source')[0]?.capabilities.edit).toBe(true)
    const clueId = await ensureClue(service, 'x')
    await expect(service.read({ workspaceId: 'ws-1', clueId })).resolves.toMatchObject({ text: 'x' })
    // Namespaced extensions travel through the registry and are copied too.
    const ext = testSource({ sourceId: 'test.ext', typeId: 'test.ext.text' })
    service.registerSource({
      ...ext,
      descriptor: { ...ext.descriptor, extensions: { 'my.plugin': { color: 'green' } } },
      types: ext.types.map(type => ({ ...type, extensions: { 'my.plugin': { viewer: 'rich' } } })),
    })
    expect(service.getSource('test.ext')?.extensions).toEqual({ 'my.plugin': { color: 'green' } })
    expect(service.getTypes('test.ext')[0]?.extensions).toEqual({ 'my.plugin': { viewer: 'rich' } })
    const returned = service.getSource('test.ext')?.extensions as { [key: string]: unknown }
    returned['my.plugin'] = { color: 'red' }
    expect(service.getSource('test.ext')?.extensions).toEqual({ 'my.plugin': { color: 'green' } })
    dispose()
  })
  it('rejects duplicate ids and reserves every built-in id for construction', () => {
    const builtin = testSource({ sourceId: 'builtin.files', typeId: 'builtin.files.text' })
    const service = createCluesService({ root: tempRoot(), now: () => NOW, builtinSources: [builtin] })
    expect(service.getSource('builtin.files')?.sourceId).toBe('builtin.files')
    service.registerSource(testSource())
    expect(() => service.registerSource(testSource())).toThrow(/already registered/)
    expect(() => service.registerSource(testSource({ sourceId: 'other.source', typeId: 'test.source.text' }))).toThrow(/already registered/)
    for (const sourceId of ['builtin.packs', 'builtin.files', 'builtin.github.issues', 'builtin.github.pulls', 'builtin.feishu.docs', 'builtin.feishu.tasks']) {
      expect(() => service.registerSource(testSource({ sourceId })), sourceId).toThrow(/reserved/)
    }
  })
  it('unloads only runtime capability: references survive and re-registration restores reads', async () => {
    const service = makeService()
    const dispose = service.registerSource(testSource())
    const clueId = await ensureClue(service, 'a')
    dispose()
    expect(service.getSources()).toHaveLength(0)
    expect((await service.listClues('ws-1')).clues.map(clue => clue.id)).toEqual([clueId])
    await fails(() => service.read({ workspaceId: 'ws-1', clueId }), 'source-missing')
    service.registerSource(testSource())
    expect((await service.read({ workspaceId: 'ws-1', clueId })).text).toBe('a')
  })
  it('imports an unresolved reference, keeps it usable, and remaps it when the source resolves', async () => {
    const service = makeService()
    const input = {
      workspaceId: 'ws-1', sourceId: 'test.source', typeId: 'test.source.text', locator: { id: 'lost' },
      title: 'Lost doc', reason: 'the source plugin is not installed', portable: { portable: true, locator: { id: 'lost' } },
    } as const
    const imported = await service.importUnresolved(input)
    expect(imported.created).toBe(true)
    expect(imported.clue.unresolved).toMatchObject({ reason: 'the source plugin is not installed' })
    const clueId = imported.clue.id
    // Dedupe is by sourceId + locator key: importing twice never mints a second id.
    expect(await service.importUnresolved(input)).toMatchObject({ created: false, clue: { id: clueId } })
    // An unresolved reference is still packable, and its imported snapshot readable.
    expect((await service.createPack({ workspaceId: 'ws-1', name: 'imported', members: [clueId] })).pack.members).toEqual([clueId])
    const meta = await service.putSnapshot('ws-1', { clueId, format: 'text/plain', data: { text: 'cached copy' }, text: 'cached copy' })
    expect((await service.readSnapshot({ workspaceId: 'ws-1', snapshotId: meta.snapshotId })).content.text).toBe('cached copy')
    // Reads/edits/portables never try a source they know is unresolved.
    for (const run of [
      () => service.read({ workspaceId: 'ws-1', clueId }),
      () => service.loadEdit({ workspaceId: 'ws-1', clueId }),
      () => service.saveEdit({ workspaceId: 'ws-1', clueId, document: { format: 'text/plain', data: { text: 'x' }, baseRevision: 'r1' } }),
      () => service.portable({ workspaceId: 'ws-1', clueId }),
    ]) {
      await fails(run, 'source-missing', 'not installed')
    }
    // No source can be consulted before it is registered.
    await fails(() => service.ensure({ workspaceId: 'ws-1', sourceId: 'test.source', typeId: 'test.source.text', locator: { id: 'lost' }, title: 'Lost doc' }), 'source-missing')
    // Once registered, ensure remaps the SAME id and clears the marker.
    service.registerSource(testSource())
    const remapped = await service.ensure({ workspaceId: 'ws-1', sourceId: 'test.source', typeId: 'test.source.text', locator: { id: 'lost' }, title: 'Lost doc' })
    expect(remapped).toMatchObject({ created: false, clue: { id: clueId } })
    expect(remapped.clue.unresolved).toBeUndefined()
    expect((await service.listClues('ws-1')).clues.find(clue => clue.id === clueId)?.unresolved).toBeUndefined()
    expect((await service.read({ workspaceId: 'ws-1', clueId })).text).toBe('lost')
    expect((await service.listPacks('ws-1')).packs[0]?.members).toEqual([clueId])
  })
  it('remaps a portable-only import to one row without duplicating it', async () => {
    const service = makeService()
    const input = {
      workspaceId: 'ws-1', sourceId: 'test.source', typeId: 'test.source.text', locator: {},
      title: 'Portable only', reason: 'source offline', portable: { portable: true, locator: { id: 'only-portable' } },
    } as const
    const first = await service.importUnresolved(input)
    expect(first.created).toBe(true)
    expect(first.clue.locator).toEqual({})
    // Importing the same share again reuses the row, updating its title and
    // keeping the portable address the retry needs.
    expect(await service.importUnresolved({ ...input, title: 'Renamed share' })).toMatchObject({
      created: false,
      clue: { id: first.clue.id, title: 'Renamed share', unresolved: { portable: { portable: true, locator: { id: 'only-portable' } } } },
    })
    expect((await service.listClues('ws-1')).clues).toHaveLength(1)
    // The registered source remaps that same row and clears the marker.
    service.registerSource(testSource())
    const remapped = await service.ensure({ workspaceId: 'ws-1', sourceId: 'test.source', typeId: 'test.source.text', locator: { id: 'only-portable' }, title: 'Portable only' })
    expect(remapped).toMatchObject({ created: false, clue: { id: first.clue.id } })
    expect(remapped.clue.unresolved).toBeUndefined()
    expect((await service.listClues('ws-1')).clues).toHaveLength(1)
    expect((await service.read({ workspaceId: 'ws-1', clueId: first.clue.id })).text).toBe('only-portable')
  })
  it('refuses a malformed portable reference before it can corrupt the library', async () => {
    const service = makeService()
    const base = { workspaceId: 'ws-1', sourceId: 'test.source', typeId: 'test.source.text', locator: { id: 'lost' }, title: 'Lost doc', reason: 'the source plugin is not installed' }
    const malformed: unknown[] = [
      { locator: { id: 'lost' } }, { portable: 'yes', locator: { id: 'lost' } }, { portable: true, locator: null },
      { portable: true, locator: [{ id: 'lost' }] }, { portable: true, reason: 42 }, null,
    ]
    for (const portable of malformed) {
      await fails(() => service.importUnresolved({ ...base, portable: portable as CluePortableRef }), 'invalid-request')
    }
    // Nothing was written: a malformed marker would make the whole library unreadable.
    await expect(service.listClues('ws-1')).resolves.toMatchObject({ clues: [], revision: 0 })
    // The valid shape is copied down to the contract fields only.
    const imported = await service.importUnresolved({ ...base, portable: { portable: true, locator: { id: 'lost' }, extra: 'ignored' } as unknown as CluePortableRef })
    expect(imported.clue.unresolved?.portable).toEqual({ portable: true, locator: { id: 'lost' } })
    expect(await service.listClues('ws-1')).toMatchObject({ clues: [{ id: imported.clue.id }] })
  })
  it('reports unknown sources and unsupported operations with fixed categories', async () => {
    const service = makeService()
    service.registerSource(testSource({ capabilities: { list: false, search: false } }))
    await fails(() => service.list({ workspaceId: 'ws-1', sourceId: 'missing.source' }), 'source-missing')
    await fails(() => service.list({ workspaceId: 'ws-1', sourceId: 'test.source' }), 'unsupported')
    await fails(() => service.search({ workspaceId: 'ws-1', sourceId: 'test.source', query: 'x' }), 'unsupported')
    await fails(() => service.read({ workspaceId: 'ws-1', sourceId: 'test.source', typeId: 'test.source.nope', locator: { id: 'a' } }), 'unsupported')
  })
  it('disposes every registration idempotently and refuses late registration', () => {
    const service = makeService()
    service.registerApi('x.y', () => 1)
    service.dispose()
    service.dispose()
    expect(service.hasApi('x.y')).toBe(false)
    expect(() => service.registerSource(testSource())).toThrow(/disposed/)
    expect(() => service.registerApi('late.method', () => 1)).toThrow(/disposed/)
    expect(service.hasApi('late.method')).toBe(false)
  })
})
describe('clue service dispatch', () => {
  it('resolves, normalizes and de-duplicates candidates, marking persisted ones', async () => {
    const service = makeService()
    const base = testSource()
    service.registerSource({
      ...base,
      operations: {
        ...base.operations,
        resolve: async () => [
          { sourceId: 'test.source', typeId: 'test.source.text', locator: { id: '  a  ' }, title: 'a' },
          { sourceId: 'test.source', typeId: 'test.source.text', locator: { id: 'a' }, title: 'again' },
        ] as ClueCandidate[],
      },
    })
    const candidates = await service.resolve({ workspaceId: 'ws-1', text: 'a' })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ locator: { id: 'a' } })
    expect(candidates[0]?.clueId).toBeUndefined()
    const clueId = await ensureClue(service, 'a')
    expect((await service.resolve({ workspaceId: 'ws-1', text: 'a' }))[0]?.clueId).toBe(clueId)
  })
  it('auto-resolve skips a miss but propagates auth failures; an explicit source reports its own miss', async () => {
    const service = makeService()
    const miss = testSource({ sourceId: 'a.miss', typeId: 'a.miss.text' })
    service.registerSource({
      ...miss,
      operations: { ...miss.operations, resolve: async () => { throw new ClueError('not-found', 'no such local path') } },
    })
    const remote = testSource({ sourceId: 'b.remote', typeId: 'b.remote.text' })
    service.registerSource({
      ...remote,
      operations: {
        ...remote.operations,
        resolve: async input => ({ sourceId: 'b.remote', typeId: 'b.remote.text', locator: { id: String(input.text) }, title: 'remote' }),
      },
    })
    const candidates = await service.resolve({ workspaceId: 'ws-1', text: 'https://example.com/doc' })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ sourceId: 'b.remote', locator: { id: 'https://example.com/doc' } })
    await fails(() => service.resolve({ workspaceId: 'ws-1', sourceId: 'a.miss', text: 'x' }), 'not-found')
    // auth-required on a recognized resource aborts auto resolution.
    const auth = makeService()
    const denied = testSource({ sourceId: 'a.auth', typeId: 'a.auth.text' })
    auth.registerSource({ ...denied, operations: { ...denied.operations, resolve: async () => { throw new ClueError('auth-required', 'sign in to continue') } } })
    auth.registerSource(testSource({ sourceId: 'b.remote', typeId: 'b.remote.text' }))
    await fails(() => auth.resolve({ workspaceId: 'ws-1', text: 'x' }), 'auth-required')
  })
  it('passes cursors through unchanged and never invents a total', async () => {
    const service = makeService()
    const cursors: Array<string | undefined> = []
    const base = testSource()
    service.registerSource({
      ...base,
      operations: {
        ...base.operations,
        list: async input => {
          cursors.push(input.cursor)
          const result: ClueListResult = {
            items: [{ sourceId: 'test.source', typeId: 'test.source.text', locator: { id: 'a' }, title: 'a' }],
            nextCursor: 'opaque/cursor==',
          }
          return result
        },
      },
    })
    const first = await service.list({ workspaceId: 'ws-1', sourceId: 'test.source', cursor: 'pasted/opaque' })
    expect(cursors).toEqual(['pasted/opaque'])
    expect(first.nextCursor).toBe('opaque/cursor==')
    expect('total' in first).toBe(false)
  })
  it('dispatches read/loadEdit/saveEdit/portable through source-owned types and formats', async () => {
    const service = makeService()
    service.registerSource(testSource())
    const clueId = await ensureClue(service, 'a')
    expect(await service.read({ workspaceId: 'ws-1', clueId })).toMatchObject({ format: 'text/plain', text: 'a' })
    expect((await service.loadEdit({ workspaceId: 'ws-1', clueId })).baseRevision).toBe('r1')
    expect((await service.saveEdit({ workspaceId: 'ws-1', clueId, document: { format: 'text/plain', data: { text: 'changed' }, baseRevision: 'r1' } })).revision).toBe('r2')
    expect((await service.portable({ workspaceId: 'ws-1', clueId })).portable).toBe(true)
  })
  it('rejects a non-object edit document at the service boundary', async () => {
    const service = makeService()
    service.registerSource(testSource())
    const clueId = await ensureClue(service, 'a')
    for (const document of [null, [], 'text', 42, undefined]) {
      await fails(() => service.saveEdit({ workspaceId: 'ws-1', clueId, document: document as never }), 'invalid-request')
    }
    // The guard does not poison the normal path.
    expect((await service.saveEdit({ workspaceId: 'ws-1', clueId, document: { format: 'text/plain', data: { text: 'x' }, baseRevision: 'r1' } })).revision).toBe('r2')
  })
  it('passes a source-owned structured format through load/save unmodified', async () => {
    // The core must not depend on Markdown: the exact document a structured
    // source loaded comes back on save without a field rewritten.
    const service = makeService()
    const saved: unknown[] = []
    const format = 'application/vnd.test.structure+json'
    service.registerSource(testSource({
      sourceId: 'test.struct', typeId: 'test.struct.doc', format,
      capabilities: { resolve: false, list: false, search: false, portable: false },
      operations: {
        async read() { return { format, data: { blocks: [{ kind: 'x', text: 'y' }] }, revision: 'r1', fetchedAt: NOW } },
        async loadEdit() { return { format, data: { blocks: [{ kind: 'x', text: 'y' }], unknown: { keep: true } }, baseRevision: 'r1' } },
        async saveEdit(input) { saved.push(input.document); return { revision: 'r2', savedAt: NOW } },
      },
    }))
    const ensured = await service.ensure({ workspaceId: 'ws-1', sourceId: 'test.struct', typeId: 'test.struct.doc', locator: { id: 'doc-1' }, title: 'doc' })
    const edit = await service.loadEdit({ workspaceId: 'ws-1', clueId: ensured.clue.id })
    expect(edit.format).toBe(format)
    expect(edit.data).toEqual({ blocks: [{ kind: 'x', text: 'y' }], unknown: { keep: true } })
    const document = { format, data: { blocks: [{ kind: 'x', text: 'edited' }], unknown: { keep: true } }, baseRevision: edit.baseRevision }
    await service.saveEdit({ workspaceId: 'ws-1', clueId: ensured.clue.id, document })
    expect(saved).toEqual([document])
  })
  it('enforces type and source capabilities before dispatch', async () => {
    const service = makeService()
    let calls = 0
    const base = testSource()
    service.registerSource({
      ...base,
      descriptor: { ...base.descriptor, capabilities: { ...base.descriptor.capabilities, edit: false, portable: false } },
      types: base.types.map(type => ({ ...type, capabilities: { read: false, edit: false, concurrency: 'none' } })),
      operations: {
        ...base.operations,
        read: async () => { calls += 1; return { format: 'text/plain', data: {}, fetchedAt: NOW } },
        loadEdit: async () => { calls += 1; return { format: 'text/plain', data: { text: 'x' }, baseRevision: 'r1' } },
        saveEdit: async () => { calls += 1; return { revision: 'r2', savedAt: NOW } },
        portable: async () => { calls += 1; return { portable: true, locator: { id: 'p' } } },
      },
    })
    const clueId = await ensureClue(service, 'a')
    await fails(() => service.read({ workspaceId: 'ws-1', clueId }), 'unsupported')
    await fails(() => service.loadEdit({ workspaceId: 'ws-1', clueId }), 'unsupported')
    await fails(() => service.saveEdit({ workspaceId: 'ws-1', clueId, document: { format: 'text/plain', data: { text: 'x' }, baseRevision: 'r1' } }), 'unsupported')
    // A declared `portable: false` source keeps the reference unresolved even
    // when an operation implementation is still present.
    expect(await service.portable({ workspaceId: 'ws-1', clueId })).toMatchObject({ portable: false, reason: expect.any(String) })
    expect(calls).toBe(0)
  })
  it('forwards caller, abort signal and payload session id to source operations', async () => {
    const service = makeService()
    const seen: Array<{ caller: string; aborted?: boolean; sessionId?: string }> = []
    const controller = new AbortController()
    const push = (context: { caller: string; signal?: AbortSignal; sessionId?: string }) => seen.push({ caller: context.caller, aborted: context.signal?.aborted, sessionId: context.sessionId })
    const base = testSource()
    service.registerSource({
      ...base,
      operations: {
        ...base.operations,
        read: async (_input, context) => { push(context); return { format: 'text/plain', data: { ok: true }, fetchedAt: NOW } },
        loadEdit: async (_input, context) => { push(context); return { format: 'text/plain', data: { text: 'x' }, baseRevision: 'r1' } },
        saveEdit: async (_input, context) => { push(context); return { revision: 'r2', savedAt: NOW } },
        portable: async (_input, context) => { push(context); return { portable: true, locator: { id: 'p' } } },
      },
    })
    const clueId = await ensureClue(service, 'a')
    const call = { caller: 'agent' as const, signal: controller.signal }
    const params = { workspaceId: 'ws-1', clueId, sessionId: 'session-payload' }
    await service.read(params, call)
    await service.loadEdit(params, call)
    await service.saveEdit({ ...params, document: { format: 'text/plain', data: { text: 'x' }, baseRevision: 'r1' } }, call)
    await service.portable(params, call)
    expect(seen).toEqual(Array.from({ length: 4 }, () => ({ caller: 'agent', aborted: false, sessionId: 'session-payload' })))
  })
  it('reports cancellation for an in-flight abort and for an already-aborted signal', async () => {
    const service = makeService()
    const controller = new AbortController()
    const base = testSource()
    service.registerSource({
      ...base,
      operations: { ...base.operations, read: async () => { controller.abort(); return { format: 'text/plain', data: {}, fetchedAt: NOW } } },
    })
    const clueId = await ensureClue(service, 'a')
    await fails(() => service.read({ workspaceId: 'ws-1', clueId }, { signal: controller.signal }), 'cancelled')
    // An already-aborted signal short-circuits every source operation.
    const aborted = new AbortController(); aborted.abort()
    await fails(() => service.read({ workspaceId: 'ws-1', clueId }, { signal: aborted.signal }), 'cancelled')
    await fails(() => service.list({ workspaceId: 'ws-1', sourceId: 'test.source' }, { signal: aborted.signal }), 'cancelled')
    await fails(() => service.ensure({ workspaceId: 'ws-1', sourceId: 'test.source', typeId: 'test.source.text', locator: { id: 'b' }, title: 'b' }, { signal: aborted.signal }), 'cancelled')
  })
  it('normalizes thrown source failures without leaking the original message', async () => {
    const service = makeService()
    const base = testSource()
    service.registerSource({
      ...base,
      operations: { ...base.operations, read: async () => { throw new Error('Authorization: Bearer super-secret-token; stdout: boom') } },
    })
    const clueId = await ensureClue(service, 'a')
    const failure: unknown = await service.read({ workspaceId: 'ws-1', clueId }).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(ClueError)
    expect(failure).toMatchObject({ category: 'failed' })
    expect((failure as ClueError).message).not.toContain('super-secret')
    expect((failure as ClueError).message).not.toContain('stdout')
    expect((failure as ClueError).message).toContain('test.source')
  })
})

describe('clue stable identity and library', () => {
  it('re-ensures the same normalized locator to the same id (created:false)', async () => {
    const service = makeService()
    service.registerSource(testSource())
    const first = await service.ensure({ workspaceId: 'ws-1', sourceId: 'test.source', typeId: 'test.source.text', locator: { id: '  a  ' }, title: 'one' })
    expect(first.created).toBe(true)
    const second = await service.ensure({ workspaceId: 'ws-1', sourceId: 'test.source', typeId: 'test.source.text', locator: { id: 'a' }, title: 'two' })
    // The original title is not overwritten by a later ensure.
    expect(second).toMatchObject({ created: false, clue: { id: first.clue.id, title: 'one' } })
    expect((await service.listClues('ws-1')).clues).toHaveLength(1)
  })
  it('persists a display snapshot supplied by ensure and updates it only when it differs', async () => {
    let clock = 0
    const service = createCluesService({ root: tempRoot(), now: () => `2026-10-17T00:00:0${clock}.000Z`, newId: kind => `${kind}-${++clock}` })
    service.registerSource(testSource())
    const params = {
      workspaceId: 'ws-1', sourceId: 'test.source', typeId: 'test.source.text', locator: { id: 'a' }, title: 'a',
      subtitle: 'Local file', info: { state: 'active' as const, path: 'a.txt', sizeBytes: 12, author: { handle: 'octocat' }, labels: ['bug'] },
    }
    clock = 1
    const first = await service.ensure(params)
    expect(first).toMatchObject({ created: true, clue: { subtitle: 'Local file', info: params.info } })
    expect(first.updated).toBeUndefined()
    const revision = (await service.listClues('ws-1')).revision
    // Identical metadata is NOT a write: revision and `updatedAt` stay untouched.
    clock = 2
    const unchanged = await service.ensure(params)
    expect(unchanged).toMatchObject({ created: false, clue: { updatedAt: first.clue.updatedAt } })
    expect(unchanged.updated).toBeUndefined()
    expect((await service.listClues('ws-1')).revision).toBe(revision)
    // One differing field is enough to commit the new snapshot.
    clock = 3
    const changed = await service.ensure({ ...params, subtitle: 'Markdown file', info: { ...params.info, sizeBytes: 13 } })
    expect(changed).toMatchObject({ created: false, updated: true, clue: { id: first.clue.id, subtitle: 'Markdown file', info: { sizeBytes: 13, labels: ['bug'] } } })
    expect(changed.clue.updatedAt).not.toBe(first.clue.updatedAt)
    expect(await service.listClues('ws-1')).toMatchObject({ clues: [{ id: first.clue.id, subtitle: 'Markdown file', info: { sizeBytes: 13 } }] })
    expect((await service.listClues('ws-1')).revision).toBeGreaterThan(revision)
  })
  it('rejects a malformed display snapshot before writing', async () => {
    const service = makeService()
    service.registerSource(testSource())
    const base = { workspaceId: 'ws-1', sourceId: 'test.source', typeId: 'test.source.text', locator: { id: 'a' }, title: 'a' }
    for (const extra of [{ subtitle: 7 }, { info: { counts: { commits: -1 } } }, { info: { state: 'nope' } }, { info: { author: { url: 'javascript:alert(1)' } } }, { info: 'nope' }]) {
      await fails(() => service.ensure({ ...base, ...extra } as never), 'invalid-request')
    }
    expect(await service.listClues('ws-1')).toEqual({ clues: [], revision: 0 })
  })
  it('validates, deep-copies and sanitizes source filter descriptors', () => {
    const service = makeService()
    const registration = testSource()
    const options = [{ id: 'open', value: 'open' }, { id: 'all', value: 'all' }]
    service.registerSource({ ...registration, descriptor: { ...registration.descriptor, filters: [{ scopeKey: 'state', appliesTo: 'both', defaultOptionId: 'open', options }] } })
    expect(service.getSource('test.source')?.filters).toEqual([{ scopeKey: 'state', appliesTo: 'both', defaultOptionId: 'open', options }])
    // The returned descriptor is a deep copy: mutating the nested option is inert.
    const filters = service.getSource('test.source')?.filters as unknown as Array<{ options: Array<{ id: string; value?: unknown }> }>
    filters[0]!.options[0]!.value = 'tampered'
    expect(service.getSource('test.source')?.filters?.[0]?.options[0]?.value).toBe('open')
    const invalid: Array<ClueSourceRegistration['descriptor']['filters']> = [
      [{ scopeKey: '', options: [{ id: 'x' }] }],
      [{ scopeKey: 'state', options: [] }],
      [{ scopeKey: 'state', options: [{ id: '' }] }],
      [{ scopeKey: 'state', defaultOptionId: 'missing', options: [{ id: 'open' }] }],
      [{ scopeKey: 'state', options: [{ id: 'a' }, { id: 'a' }] }],
      [{ scopeKey: 'state', appliesTo: 'nope' as never, options: [{ id: 'a' }] }],
      [{ scopeKey: 'state', options: [{ id: 'a', value: Number.NaN }] }],
    ]
    for (const [index, badFilters] of invalid.entries()) {
      const bad = testSource({ sourceId: `test.invalid-filter-${index}` })
      expect(() => service.registerSource({ ...bad, descriptor: { ...bad.descriptor, filters: badFilters } }), JSON.stringify(badFilters)).toThrow(/\[clues\]/)
    }
  })
  it('carries source info through list/read/edit and never trusts save input info', async () => {
    const service = makeService()
    const info = { state: 'completed' as const, number: 7, repository: 'acme/docs', labels: ['done'], updatedAt: NOW }
    let receivedDocument: Record<string, unknown> | undefined
    const base = testSource({ sourceId: 'test.meta', typeId: 'test.meta.text' })
    service.registerSource({
      ...base,
      operations: {
        ...base.operations,
        list: async () => ({ items: [{ sourceId: 'test.meta', typeId: 'test.meta.text', locator: { id: 'a' }, title: 'a', info }] }),
        read: async () => ({ format: 'text/plain', data: { text: 'a' }, fetchedAt: NOW, info }),
        loadEdit: async () => ({ format: 'text/plain', data: { text: 'a' }, baseRevision: 'r1', info }),
        saveEdit: async input => {
          receivedDocument = input.document as unknown as Record<string, unknown>
          return { revision: 'r2', savedAt: NOW, info: { ...info, labels: ['authoritative'] } }
        },
      },
    })
    expect((await service.list({ workspaceId: 'ws-1', sourceId: 'test.meta' })).items[0]?.info).toEqual(info)
    const readParams = { workspaceId: 'ws-1', sourceId: 'test.meta', typeId: 'test.meta.text', locator: { id: 'a' } }
    expect((await service.read(readParams)).info).toEqual(info)
    expect((await service.loadEdit(readParams)).info).toEqual(info)
    const saved = await service.saveEdit({
      ...readParams,
      // A client cannot smuggle display metadata into the write result.
      document: { format: 'text/plain', data: { text: 'a' }, ...({ info: { labels: ['forged'] } } as object) } as never,
    })
    expect(saved.info).toEqual({ ...info, labels: ['authoritative'] })
    // The source received ONLY the contract document fields.
    expect(receivedDocument).toEqual({ format: 'text/plain', data: { text: 'a' } })
  })
  it('reconciles authoritative save info onto the stored clue and never creates one from a save', async () => {
    const service = makeService()
    const source = saveMetadataSource({ state: 'completed', updatedAt: '2026-10-18T00:00:00Z', completedAt: '2026-10-18T00:00:00Z' })
    service.registerSource(source.registration)
    const ensured = await service.ensure({
      workspaceId: 'ws-1', sourceId: 'test.save-meta', typeId: 'test.save-meta.text', locator: { id: 'a' }, title: 'doc',
      subtitle: 'Doc', info: { state: 'active', updatedAt: '2026-10-17T00:00:00Z' },
    })
    const before = await service.listClues('ws-1')
    expect(before.clues[0]?.info).toEqual({ state: 'active', updatedAt: '2026-10-17T00:00:00.000Z' })
    const saved = await service.saveEdit({
      workspaceId: 'ws-1', clueId: ensured.clue.id,
      // A forged snapshot must neither reach the source nor the store.
      document: { format: 'text/plain', data: { text: 'edited' }, baseRevision: 'r1', ...({ info: { state: 'draft', labels: ['forged'] } } as object) } as never,
    })
    expect(saved.info).toEqual({ state: 'completed', updatedAt: '2026-10-18T00:00:00.000Z', completedAt: '2026-10-18T00:00:00.000Z' })
    // The source saw only the contract document fields.
    expect(source.received()).toEqual({ format: 'text/plain', data: { text: 'edited' }, baseRevision: 'r1' })
    const after = await service.listClues('ws-1')
    expect(after.clues[0]).toMatchObject({ id: ensured.clue.id, info: saved.info, subtitle: 'Doc' })
    expect(after.revision).toBeGreaterThan(before.revision)
    // A direct-locator save finds the clue through the canonical locator too.
    const direct = await service.saveEdit({
      workspaceId: 'ws-1', sourceId: 'test.save-meta', typeId: 'test.save-meta.text', locator: { id: '  a  ' },
      document: { format: 'text/plain', data: { text: 'edited' }, baseRevision: 'r1' },
    })
    expect(direct.info).toEqual(saved.info)
    expect(await service.listClues('ws-1')).toMatchObject({ clues: [{ id: ensured.clue.id }] })
    // No stored match: the save result returns but no clue is minted.
    expect((await service.saveEdit({
      workspaceId: 'ws-1', sourceId: 'test.save-meta', typeId: 'test.save-meta.text', locator: { id: 'ghost' },
      document: { format: 'text/plain', data: { text: 'edited' }, baseRevision: 'r1' },
    })).info).toEqual(saved.info)
    expect((await service.listClues('ws-1')).clues).toHaveLength(1)
  })
  it('keeps the confirmed source save when the metadata snapshot write fails', async () => {
    const store = new FailingMetadataStore({ root: tempRoot() })
    let next = 0
    const service = createCluesService({ store, now: () => NOW, newId: kind => `${kind}-${++next}` })
    const source = saveMetadataSource({ state: 'completed' })
    service.registerSource(source.registration)
    const ensured = await service.ensure({
      workspaceId: 'ws-1', sourceId: 'test.save-meta', typeId: 'test.save-meta.text', locator: { id: 'a' }, title: 'doc', info: { state: 'active' },
    })
    // The remote save commits; the following local snapshot write fails. That
    // must not turn the confirmed save into a failed/dirty draft.
    store.failMetadataWrites = true
    const saved = await service.saveEdit({
      workspaceId: 'ws-1', clueId: ensured.clue.id, document: { format: 'text/plain', data: { text: 'edited' }, baseRevision: 'r1' },
    })
    expect(saved).toMatchObject({ revision: 'r2', savedAt: NOW, info: { state: 'completed' } })
    expect(source.saveCalls()).toBe(1)
    // Best-effort metadata: the library still has the pre-save snapshot.
    expect(await service.listClues('ws-1')).toMatchObject({ revision: 1, clues: [{ info: { state: 'active' } }] })
  })
  it('does not write or bump the revision when the save info is unchanged or absent', async () => {
    const service = makeService()
    service.registerSource(saveMetadataSource({ state: 'completed' }).registration)
    const first = await service.ensure({
      workspaceId: 'ws-1', sourceId: 'test.save-meta', typeId: 'test.save-meta.text', locator: { id: 'a' }, title: 'doc', info: { state: 'completed' },
    })
    const before = await service.listClues('ws-1')
    expect((await service.saveEdit({
      workspaceId: 'ws-1', clueId: first.clue.id, document: { format: 'text/plain', data: { text: 'edited' }, baseRevision: 'r1' },
    })).info).toEqual({ state: 'completed' })
    expect(await service.listClues('ws-1')).toMatchObject({ revision: before.revision, clues: [{ updatedAt: before.clues[0]?.updatedAt }] })
    // A read-only/docs-style save returns no authoritative info: no write.
    const serviceNoInfo = makeService()
    serviceNoInfo.registerSource(saveMetadataSource(undefined).registration)
    const stored = await serviceNoInfo.ensure({
      workspaceId: 'ws-1', sourceId: 'test.save-meta', typeId: 'test.save-meta.text', locator: { id: 'a' }, title: 'doc', info: { state: 'active' },
    })
    const noInfoBefore = await serviceNoInfo.listClues('ws-1')
    expect((await serviceNoInfo.saveEdit({
      workspaceId: 'ws-1', clueId: stored.clue.id, document: { format: 'text/plain', data: { text: 'edited' }, baseRevision: 'r1' },
    })).info).toBeUndefined()
    expect(await serviceNoInfo.listClues('ws-1')).toMatchObject({ revision: noInfoBefore.revision, clues: [{ info: { state: 'active' } }] })
  })
  it('mints exactly one clue for concurrent ensures of the same resource', async () => {
    const service = makeService()
    service.registerSource(testSource())
    const results = await Promise.all(Array.from({ length: 8 }, () => service.ensure({
      workspaceId: 'ws-1', sourceId: 'test.source', typeId: 'test.source.text', locator: { id: 'same' }, title: 'same',
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
    expect(created.pack).toMatchObject({ name: 'My pack', members: [a, b] })
    const added = await service.addPackMember({ workspaceId: 'ws-1', packId: created.pack.id, clueId: a })
    expect(added.pack.members).toEqual([a, b])
    expect(added.pack.revision).toBe(created.pack.revision)
    // Removing a member from one pack leaves the clue and the other pack.
    const second = await service.createPack({ workspaceId: 'ws-1', name: 'Second', members: [a] })
    expect((await service.removePackMember({ workspaceId: 'ws-1', packId: created.pack.id, clueId: a })).pack.members).toEqual([b])
    expect((await service.listClues('ws-1')).clues.map(clue => clue.id).sort()).toEqual([a, b].sort())
    expect((await service.listPacks('ws-1')).packs.find(pack => pack.id === second.pack.id)?.members).toEqual([a])
  })
  it('removing a pack, pin or binding never deletes the clue itself', async () => {
    const service = makeService()
    service.registerSource(testSource())
    const a = await ensureClue(service, 'a')
    const pack = await service.createPack({ workspaceId: 'ws-1', name: 'Pack', members: [a] })
    await service.addBinding({ workspaceId: 'ws-1', target: { kind: 'pack', packId: pack.pack.id } })
    expect(await service.deletePack({ workspaceId: 'ws-1', packId: pack.pack.id })).toMatchObject({ deleted: true, packs: [] })
    expect((await service.listBindings('ws-1')).bindings).toEqual([])
    expect((await service.listClues('ws-1')).clues.map(clue => clue.id)).toEqual([a])
    expect((await service.read({ workspaceId: 'ws-1', clueId: a })).text).toBe('a')
    expect((await service.addPin({ workspaceId: 'ws-1', clueId: a })).pins.map(pin => pin.clueId)).toEqual([a])
    await service.addBinding({ workspaceId: 'ws-1', target: { kind: 'clue', clueId: a } })
    expect((await service.removePin({ workspaceId: 'ws-1', clueId: a })).pins).toEqual([])
    expect((await service.removeBinding({ workspaceId: 'ws-1', target: { kind: 'clue', clueId: a } })).bindings).toEqual([])
    expect((await service.read({ workspaceId: 'ws-1', clueId: a })).text).toBe('a')
  })
  it('refuses stale pack revisions and separates packRevision from the workspace revision', async () => {
    const root = tempRoot()
    const service = makeService(root)
    service.registerSource(testSource())
    const a = await ensureClue(service, 'a')
    const b = await ensureClue(service, 'b')
    const pack = await service.createPack({ workspaceId: 'ws-1', name: 'Old', members: [a] })
    await fails(() => service.renamePack({ workspaceId: 'ws-1', packId: pack.pack.id, name: 'New', expectedRevision: pack.pack.revision - 1 }), 'conflict')
    // The refused write left the old row on disk.
    expect((await new CluesStore({ root }).read('ws-1')).packs[0]?.name).toBe('Old')
    // Creation returns the pack's own revision explicitly; the workspace
    // revision is NOT a pack CAS value.
    expect(pack.packRevision).toBe(pack.pack.revision)
    expect(pack.revision).toBeGreaterThanOrEqual(pack.packRevision)
    const renamed = await service.renamePack({ workspaceId: 'ws-1', packId: pack.pack.id, name: 'Renamed', expectedRevision: pack.packRevision })
    expect(renamed.packRevision).toBe(pack.packRevision + 1)
    await fails(() => service.addPackMember({ workspaceId: 'ws-1', packId: pack.pack.id, clueId: b, expectedRevision: renamed.revision }), 'conflict')
    const added = await service.addPackMember({ workspaceId: 'ws-1', packId: pack.pack.id, clueId: b, expectedRevision: renamed.packRevision })
    expect(added.packRevision).toBe(renamed.packRevision + 1)
    expect(await service.deletePack({ workspaceId: 'ws-1', packId: pack.pack.id, expectedRevision: added.packRevision })).toMatchObject({ packRevision: added.packRevision })
    expect((await service.listPacks('ws-1')).packs).toEqual([])
  })
  it('refuses a stale workspace revision for pin/binding writes and keeps the committed rows', async () => {
    const root = tempRoot()
    const service = makeService(root)
    service.registerSource(testSource())
    const a = await ensureClue(service, 'a')
    await service.addPin({ workspaceId: 'ws-1', clueId: a })
    await fails(() => service.removePin({ workspaceId: 'ws-1', clueId: a, expectedRevision: 0 }), 'conflict')
    expect((await new CluesStore({ root }).read('ws-1')).pins).toHaveLength(1)
    await fails(() => service.addBinding({ workspaceId: 'ws-1', target: { kind: 'clue', clueId: a }, expectedRevision: 0 }), 'conflict')
  })
  it('validates pack names and member existence', async () => {
    const service = makeService()
    service.registerSource(testSource())
    await fails(() => service.createPack({ workspaceId: 'ws-1', name: '   ' }), 'invalid-request')
    await fails(() => service.createPack({ workspaceId: 'ws-1', name: 'x', members: ['nope'] }), 'not-found')
    const pack = await service.createPack({ workspaceId: 'ws-1', name: 'x' })
    await fails(() => service.addPackMember({ workspaceId: 'ws-1', packId: pack.pack.id, clueId: 'nope' }), 'not-found')
    await fails(() => service.renamePack({ workspaceId: 'ws-1', packId: 'missing', name: 'y' }), 'not-found')
  })
})
describe('snapshots', () => {
  it('writes, lists and reads snapshots without any source runtime, surviving a restart', async () => {
    const root = tempRoot()
    const service = makeService(root)
    service.registerSource(testSource())
    const clueId = await ensureClue(service, 'a')
    const meta = await service.putSnapshot('ws-1', { clueId, format: 'text/plain', data: { id: 'a' }, text: 'snapshot body', fetchedAt: NOW, integrity: 'verified' })
    expect(meta.clueId).toBe(clueId)
    const restarted = makeService(root)
    // No sources registered at all: snapshots are core storage.
    const record = await restarted.readSnapshot({ workspaceId: 'ws-1', snapshotId: meta.snapshotId })
    expect(record.content.text).toBe('snapshot body')
    expect(record.meta.integrity).toBe('verified')
    expect((await restarted.listSnapshots('ws-1')).map(row => row.snapshotId)).toEqual([meta.snapshotId])
  })
  it('appends a second snapshot for the same clue and refuses an unknown one', async () => {
    const service = makeService()
    service.registerSource(testSource())
    await fails(() => service.putSnapshot('ws-1', { clueId: 'missing', format: 'text/plain', data: {} }), 'not-found')
    const clueId = await ensureClue(service, 'a')
    const first = await service.putSnapshot('ws-1', { clueId, format: 'text/plain', data: { n: 1 } })
    const second = await service.putSnapshot('ws-1', { clueId, format: 'text/plain', data: { n: 2 } })
    expect(second.snapshotId).not.toBe(first.snapshotId)
    expect((await service.readSnapshot({ workspaceId: 'ws-1', snapshotId: first.snapshotId })).content.data).toEqual({ n: 1 })
  })
})
describe('API method seam', () => {
  it('registers/invokes methods, rejects duplicates and cancellations, and disposes exactly one', async () => {
    const service = makeService()
    const dispose = service.registerApi('later.method', payload => ({ payload }))
    expect(service.hasApi('later.method')).toBe(true)
    expect(await service.invokeApi('later.method', { a: 1 })).toEqual({ payload: { a: 1 } })
    expect(() => service.registerApi('later.method', () => 2)).toThrow(/already registered/)
    dispose()
    expect(service.hasApi('later.method')).toBe(false)
    await fails(() => service.invokeApi('later.method', {}), 'not-found')
    service.registerApi('other.method', () => 1)
    const controller = new AbortController(); controller.abort()
    await fails(() => service.invokeApi('other.method', {}, { caller: 'ui', signal: controller.signal }), 'cancelled')
  })
  it('public identity constants mirror the fixed vocabulary', () => {
    const service = makeService()
    expect(service.codecs).toEqual({ clues: 'better-sidebar:clues', packs: 'better-sidebar:packs' })
    expect(service.builtinSourceIds).toContain('builtin.files')
    expect(service.builtinSourceIds).toContain('builtin.github.issues')
  })
})
