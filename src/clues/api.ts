/**
 * `/sidebar/api/clues.*`: the S1 wire methods over the clue service.
 *
 * One handler per public method; the service stays transport-free. The
 * dispatcher (`src/index.ts`) falls back to {@link CluesService.invokeApi}
 * only for methods the service claims (`hasApi`), so installing this module is
 * the complete wiring step — no route table in the host module needs editing.
 *
 * Payloads are validated HERE (required strings, array/object shapes, integer
 * revisions) so a malformed request fails as a typed `ClueError` before it can
 * reach a source or the store. The caller identity is fixed to `'ui'` — this
 * HTTP face is the interactive surface — and the request's abort signal is
 * forwarded to every operation.
 */
import {
  ClueError,
  type ClueApiHandler,
  type ClueBindingTarget,
  type ClueSaveEditInput,
  type JsonValue,
  type CluesBindingMutationParams,
  type CluesPackCreateParams,
  type CluesPackDeleteParams,
  type CluesPackMemberParams,
  type CluesPackRenameParams,
  type CluesPinMutationParams,
  type CluesReadParams,
  type Locator,
} from './types.ts'
import type { CluesService } from './service.ts'

/** Every API method name this module registers (single source for tests). */
export const CLUES_API_METHODS = [
  'clues.sources',
  'clues.resolve',
  'clues.list',
  'clues.search',
  'clues.read',
  'clues.loadEdit',
  'clues.saveEdit',
  'clues.portable',
  'clues.ensure',
  'clues.clues',
  'clues.pins.list',
  'clues.pins.add',
  'clues.pins.remove',
  'clues.packs.list',
  'clues.packs.create',
  'clues.packs.rename',
  'clues.packs.addMember',
  'clues.packs.removeMember',
  'clues.packs.delete',
  'clues.bindings.list',
  'clues.bindings.add',
  'clues.bindings.remove',
  'clues.snapshots.list',
  'clues.snapshots.read',
] as const

/** One API method name. */
export type CluesApiMethod = (typeof CLUES_API_METHODS)[number]

/** The request payload as the dispatcher's JSON parser produced it. */
type Payload = Record<string, unknown>

/** Whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The payload object or a typed failure. */
function requireRecord(payload: unknown): Payload {
  if (!isRecord(payload)) throw new ClueError('invalid-request', 'the clue request payload must be a JSON object')
  return payload
}

/** One required, non-empty string field. */
function requireString(payload: Payload, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ClueError('invalid-request', `"${key}" must be a non-empty string`)
  }
  return value
}

/** One optional string field (absent or a string; never a number). */
function optionalString(payload: Payload, key: string): string | undefined {
  const value = payload[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new ClueError('invalid-request', `"${key}" must be a string`)
  return value
}

/** One optional non-negative integer field. */
function optionalInteger(payload: Payload, key: string): number | undefined {
  const value = payload[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ClueError('invalid-request', `"${key}" must be a non-negative integer`)
  }
  return value
}

/** One optional JSON object field (a locator / source data). */
function optionalObject(payload: Payload, key: string): Record<string, unknown> | undefined {
  const value = payload[key]
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new ClueError('invalid-request', `"${key}" must be a JSON object`)
  return value
}

/** One optional string-array field. */
function optionalStringArray(payload: Payload, key: string): string[] | undefined {
  const value = payload[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new ClueError('invalid-request', `"${key}" must be an array of strings`)
  }
  return value as string[]
}

/** Validate the read/edit selector half of a payload. */
function readParamsOf(payload: Payload): CluesReadParams {
  const workspaceId = requireString(payload, 'workspaceId')
  const clueId = optionalString(payload, 'clueId')
  const sourceId = optionalString(payload, 'sourceId')
  const typeId = optionalString(payload, 'typeId')
  const locator = optionalObject(payload, 'locator')
  if (clueId === undefined && (sourceId === undefined || typeId === undefined || locator === undefined)) {
    throw new ClueError('invalid-request', 'the request needs a clueId or a sourceId + typeId + locator')
  }
  const offset = optionalInteger(payload, 'offset')
  const sessionId = optionalString(payload, 'sessionId')
  return {
    workspaceId,
    ...(clueId === undefined ? {} : { clueId }),
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(typeId === undefined ? {} : { typeId }),
    ...(locator === undefined ? {} : { locator: locator as Locator }),
    ...(offset === undefined ? {} : { offset }),
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

/** Validate one binding target. */
function bindingTargetOf(payload: Payload): ClueBindingTarget {
  const target = optionalObject(payload, 'target')
  if (target === undefined) throw new ClueError('invalid-request', '"target" must be a clue or a pack binding')
  if (target.kind === 'clue') {
    return { kind: 'clue', clueId: requireString(target, 'clueId') }
  }
  if (target.kind === 'pack') {
    return { kind: 'pack', packId: requireString(target, 'packId') }
  }
  throw new ClueError('invalid-request', 'a binding target must be { kind: "clue" } or { kind: "pack" }')
}

/** Validate one edit document. */
function saveDocumentOf(payload: Payload): ClueSaveEditInput {
  const document = optionalObject(payload, 'document')
  if (document === undefined) throw new ClueError('invalid-request', '"document" must carry the edit format and data')
  if (typeof document.format !== 'string' || document.format.trim() === '') {
    throw new ClueError('invalid-request', '"document.format" must be a non-empty string')
  }
  if (!('data' in document)) throw new ClueError('invalid-request', '"document.data" is required')
  const baseRevision = optionalString(document, 'baseRevision')
  return {
    format: document.format,
    data: document.data as ClueSaveEditInput['data'],
    ...(baseRevision === undefined ? {} : { baseRevision }),
  }
}

/** Build one pin mutation payload. */
function pinParamsOf(payload: Payload): CluesPinMutationParams {
  const expectedRevision = optionalInteger(payload, 'expectedRevision')
  return {
    workspaceId: requireString(payload, 'workspaceId'),
    clueId: requireString(payload, 'clueId'),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  }
}

/** Build one pack member payload. */
function packMemberParamsOf(payload: Payload): CluesPackMemberParams {
  const expectedRevision = optionalInteger(payload, 'expectedRevision')
  return {
    workspaceId: requireString(payload, 'workspaceId'),
    packId: requireString(payload, 'packId'),
    clueId: requireString(payload, 'clueId'),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  }
}

/** Build one binding mutation payload. */
function bindingParamsOf(payload: Payload): CluesBindingMutationParams {
  const expectedRevision = optionalInteger(payload, 'expectedRevision')
  return {
    workspaceId: requireString(payload, 'workspaceId'),
    target: bindingTargetOf(payload),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  }
}

/**
 * All S1 API handlers, keyed by method name. `installClues` registers every
 * entry on the service's API seam; the dispatcher only has to route unknown
 * `/sidebar/api` methods here when `hasApi` says yes.
 * @param service - the host clue service.
 */
export function cluesApiHandlers(service: CluesService): Record<CluesApiMethod, ClueApiHandler> {
  /** The call context every handler shares: interactive UI, forwarded abort. */
  const call = (context: { signal?: AbortSignal; sessionId?: string }) => ({
    caller: 'ui' as const,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
  })

  return {
    'clues.sources': () => ({
      sources: service.getSources(),
      types: service.getTypes(),
    }),

    'clues.resolve': async (payload, context) => {
      const record = requireRecord(payload)
      const workspaceId = requireString(record, 'workspaceId')
      const sourceId = optionalString(record, 'sourceId')
      const typeId = optionalString(record, 'typeId')
      const text = optionalString(record, 'text')
      const locator = optionalObject(record, 'locator')
      // A bare workspaceId used to reach every source and answer an empty
      // candidate list, which reads as "nothing matched" instead of "you did
      // not ask for anything". Resolution needs exactly one selector.
      if (text === undefined && locator === undefined) {
        throw new ClueError('invalid-request', 'the request needs a "text" or a "locator" selector')
      }
      if (text !== undefined && text.trim() === '') {
        throw new ClueError('invalid-request', '"text" must be a non-empty string when provided')
      }
      return {
        candidates: await service.resolve({
          workspaceId,
          ...(sourceId === undefined ? {} : { sourceId }),
          ...(typeId === undefined ? {} : { typeId }),
          ...(text === undefined ? {} : { text }),
          ...(locator === undefined ? {} : { locator: locator as Locator }),
        }, call(context)),
      }
    },

    'clues.list': async (payload, context) => {
      const record = requireRecord(payload)
      const sourceId = requireString(record, 'sourceId')
      const cursor = optionalString(record, 'cursor')
      const limit = optionalInteger(record, 'limit')
      return service.list({
        workspaceId: requireString(record, 'workspaceId'),
        sourceId,
        ...(record.scope === undefined ? {} : { scope: record.scope as JsonValue }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
      }, call(context))
    },

    'clues.search': async (payload, context) => {
      const record = requireRecord(payload)
      const sourceId = requireString(record, 'sourceId')
      const query = requireString(record, 'query')
      const cursor = optionalString(record, 'cursor')
      const limit = optionalInteger(record, 'limit')
      return service.search({
        workspaceId: requireString(record, 'workspaceId'),
        sourceId,
        query,
        ...(record.scope === undefined ? {} : { scope: record.scope as JsonValue }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
      }, call(context))
    },

    'clues.read': async (payload, context) => {
      const record = requireRecord(payload)
      return service.read(readParamsOf(record), call(context))
    },

    'clues.loadEdit': async (payload, context) => {
      const record = requireRecord(payload)
      return service.loadEdit(readParamsOf(record), call(context))
    },

    'clues.saveEdit': async (payload, context) => {
      const record = requireRecord(payload)
      return service.saveEdit({ ...readParamsOf(record), document: saveDocumentOf(record) }, call(context))
    },

    'clues.portable': async (payload, context) => {
      const record = requireRecord(payload)
      return service.portable(readParamsOf(record), call(context))
    },

    'clues.ensure': async (payload, context) => {
      const record = requireRecord(payload)
      const locator = optionalObject(record, 'locator')
      if (locator === undefined) throw new ClueError('invalid-request', '"locator" must be a JSON object')
      return service.ensure({
        workspaceId: requireString(record, 'workspaceId'),
        sourceId: requireString(record, 'sourceId'),
        typeId: requireString(record, 'typeId'),
        locator: locator as Locator,
        title: requireString(record, 'title'),
      }, call(context))
    },

    'clues.clues': async (payload) => {
      return service.listClues(requireString(requireRecord(payload), 'workspaceId'))
    },

    'clues.pins.list': async (payload) => {
      return service.listPins(requireString(requireRecord(payload), 'workspaceId'))
    },

    'clues.pins.add': async (payload, context) => {
      return service.addPin(pinParamsOf(requireRecord(payload)), call(context))
    },

    'clues.pins.remove': async (payload, context) => {
      return service.removePin(pinParamsOf(requireRecord(payload)), call(context))
    },

    'clues.packs.list': async (payload) => {
      return service.listPacks(requireString(requireRecord(payload), 'workspaceId'))
    },

    'clues.packs.create': async (payload, context) => {
      const record = requireRecord(payload)
      const members = optionalStringArray(record, 'members')
      const expectedRevision = optionalInteger(record, 'expectedRevision')
      const params: CluesPackCreateParams = {
        workspaceId: requireString(record, 'workspaceId'),
        name: requireString(record, 'name'),
        ...(members === undefined ? {} : { members }),
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      }
      return service.createPack(params, call(context))
    },

    'clues.packs.rename': async (payload, context) => {
      const record = requireRecord(payload)
      const expectedRevision = optionalInteger(record, 'expectedRevision')
      const params: CluesPackRenameParams = {
        workspaceId: requireString(record, 'workspaceId'),
        packId: requireString(record, 'packId'),
        name: requireString(record, 'name'),
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      }
      return service.renamePack(params, call(context))
    },

    'clues.packs.addMember': async (payload, context) => {
      return service.addPackMember(packMemberParamsOf(requireRecord(payload)), call(context))
    },

    'clues.packs.removeMember': async (payload, context) => {
      return service.removePackMember(packMemberParamsOf(requireRecord(payload)), call(context))
    },

    'clues.packs.delete': async (payload, context) => {
      const record = requireRecord(payload)
      const expectedRevision = optionalInteger(record, 'expectedRevision')
      const params: CluesPackDeleteParams = {
        workspaceId: requireString(record, 'workspaceId'),
        packId: requireString(record, 'packId'),
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      }
      return service.deletePack(params, call(context))
    },

    'clues.bindings.list': async (payload) => {
      return service.listBindings(requireString(requireRecord(payload), 'workspaceId'))
    },

    'clues.bindings.add': async (payload, context) => {
      return service.addBinding(bindingParamsOf(requireRecord(payload)), call(context))
    },

    'clues.bindings.remove': async (payload, context) => {
      return service.removeBinding(bindingParamsOf(requireRecord(payload)), call(context))
    },

    'clues.snapshots.list': async (payload) => {
      return { snapshots: await service.listSnapshots(requireString(requireRecord(payload), 'workspaceId')) }
    },

    'clues.snapshots.read': async (payload) => {
      const record = requireRecord(payload)
      return service.readSnapshot({
        workspaceId: requireString(record, 'workspaceId'),
        snapshotId: requireString(record, 'snapshotId'),
      })
    },
  }
}

/**
 * Register every S1 API handler on the service.
 * @param service - the host clue service.
 * @returns a disposer removing exactly these registrations.
 */
export function registerCluesApi(service: CluesService): () => void {
  const disposers = Object.entries(cluesApiHandlers(service)).map(([name, handler]) =>
    service.registerApi(name, handler))
  return () => {
    for (const dispose of disposers) dispose()
  }
}
