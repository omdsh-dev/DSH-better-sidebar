/**
 * The `.cluepack` manifest (formatVersion 1): the single metadata document at
 * the archive root.
 *
 * Layout:
 * ```
 * manifest.json                 ← this module
 * content/<clue-key>.json|.bin  ← one optional snapshot per clue record
 * ```
 *
 * Design rules pinned here:
 * - `formatVersion` is an INTEGER and only 1 is understood. A future version
 *   is refused with `unsupported` — the importer never guesses what a newer
 *   field means.
 * - unknown extension keys are IGNORED at every level; the validator copies
 *   only the documented fields, so an untrusted manifest cannot smuggle
 *   arbitrary data into the imported records.
 * - package keys (`source-1`, `clue-1`, …) only name relationships inside one
 *   archive. They are NOT runtime identities; the importer lets S1 mint local
 *   clue/snapshot ids.
 * - a snapshot descriptor is a per-clue optional field, never a top-level
 *   map; one clue carries at most one snapshot per archive.
 * - no credential-shaped field exists: sources carry an attribution
 *   (plugin/source/name/transport) and clues carry a credential-free portable
 *   locator or an explicit not-portable reason.
 */
import { CLUE_ERROR_CATEGORIES, ClueError, type ClueErrorCategory, type CluePortableRef, type JsonValue, type Locator } from '../types.ts'
import type { SourceTransport } from '../types.ts'
import { assertZipEntryName } from './zip.ts'

/** The only manifest format identifier this plugin accepts. */
export const CLUEPACK_FORMAT = 'dsh-cluepack'
/** The manifest format version this plugin writes and understands. */
export const CLUEPACK_FORMAT_VERSION = 1
/** Archive path of the manifest. */
export const CLUEPACK_MANIFEST_PATH = 'manifest.json'
/** Archive path prefix of snapshot payloads. */
export const CLUEPACK_CONTENT_PREFIX = 'content/'
/** File extension the UI offers for clue packs. */
export const CLUEPACK_EXTENSION = '.cluepack'
/** Upper bound of the manifest document itself (defense against a huge JSON entry). */
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024

/** Whether one export carries live references only or fetched content too. */
export type CluepackMode = 'references' | 'snapshot'

/** One source record (attribution only; credentials never travel). */
export interface CluepackSource {
  /** Package-local key (`source-1`), not a runtime id. */
  readonly key: string
  /** Stable source id (`builtin.files`, `third.party:docs`). */
  readonly sourceId: string
  /** Plugin that owns the source, when the exporter knew it. */
  readonly pluginId?: string
  /** Human-readable source name (not localizable across machines). */
  readonly name?: string
  readonly transport?: SourceTransport
  /** Type ids this archive needs from the source. */
  readonly typeIds?: readonly string[]
}

/** One snapshot descriptor attached to a clue record. */
export interface CluepackSnapshot {
  /** Archive-relative path under `content/` (validated, never used as a runtime id). */
  readonly path: string
  /** How the payload is stored: a JSON document or raw original bytes. */
  readonly encoding: 'json' | 'raw'
  /** Media type of the stored payload (e.g. `application/json`). */
  readonly mediaType: string
  /** The source-declared content format (e.g. `text/markdown`). */
  readonly format: string
  /** Byte length of the payload as stored in the archive. */
  readonly bytes: number
  /** Lowercase hex SHA-256 of the payload. */
  readonly sha256: string
  /** When the source content was fetched. */
  readonly fetchedAt: string
  /** Source revision/version when one was reported. */
  readonly sourceVersion?: string
}

/** One clue record. */
export interface CluepackClue {
  readonly key: string
  readonly sourceKey: string
  readonly typeId: string
  readonly title: string
  /** The credential-free reference (or an explicit not-portable reason). */
  readonly portable: CluePortableRef
  readonly snapshot?: CluepackSnapshot
}

/** One pack record: an ordered, de-duplicated set of clue keys (never nested). */
export interface CluepackPack {
  readonly key: string
  readonly name: string
  readonly members: readonly string[]
}

/** One failure/missing record tied to a package object. */
export interface CluepackIssue {
  readonly target: 'clue' | 'pack'
  readonly key: string
  /** Fixed clue category when the failure had one (never a raw transport error). */
  readonly category?: ClueErrorCategory
  /** Stable, user-readable reason. */
  readonly reason: string
}

/** The complete v1 manifest. */
export interface CluepackManifest {
  readonly formatVersion: typeof CLUEPACK_FORMAT_VERSION
  readonly format: typeof CLUEPACK_FORMAT
  readonly exportedAt: string
  readonly mode: CluepackMode
  readonly sources: readonly CluepackSource[]
  readonly clues: readonly CluepackClue[]
  readonly packs: readonly CluepackPack[]
  readonly issues: readonly CluepackIssue[]
}

const TRANSPORTS: ReadonlySet<string> = new Set(['files', 'http', 'cli', 'mcp'])
const MODES: ReadonlySet<string> = new Set(['references', 'snapshot'])
const CATEGORIES: ReadonlySet<string> = new Set(CLUE_ERROR_CATEGORIES)
const SHA256 = /^[0-9a-f]{64}$/

/** Whether a value is a plain JSON object (not null / array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Fail one manifest shape with the fixed invalid-request category. */
function invalid(message: string): never {
  throw new ClueError('invalid-request', message)
}

/** One required non-empty string. */
function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') invalid(`${path} must be a non-empty string`)
  return value
}

/** One optional non-empty string (absent stays absent). */
function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  return requireString(value, path)
}

/** One ISO-like timestamp string. */
function requireTimestamp(value: unknown, path: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    invalid(`${path} must be an ISO timestamp`)
  }
  return value
}

/** One non-negative safe integer. */
function requireByteCount(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    invalid(`${path} must be a non-negative integer byte count`)
  }
  return value
}

/** Recursively refuse values JSON cannot represent (functions, BigInt, cycles, NaN). */
function assertJsonValue(value: unknown, path: string, seen = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(`${path} must be a finite JSON number`)
    return
  }
  if (typeof value === 'object') {
    if (seen.has(value)) invalid(`${path} must not contain cycles`)
    seen.add(value)
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, seen))
    } else {
      for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${path}.${key}`, seen)
    }
    seen.delete(value)
    return
  }
  invalid(`${path} must be a JSON value`)
}

/** Validate one portable reference (the only address a clue carries). */
function parsePortable(value: unknown, path: string): CluePortableRef {
  if (!isRecord(value)) invalid(`${path} must be an object`)
  if (typeof value.portable !== 'boolean') invalid(`${path}.portable must be a boolean`)
  const reason = optionalString(value.reason, `${path}.reason`)
  if (value.locator === undefined) {
    if (value.portable) invalid(`${path} needs a locator when portable is true`)
    return { portable: value.portable, ...(reason === undefined ? {} : { reason }) }
  }
  if (!isRecord(value.locator)) invalid(`${path}.locator must be a JSON object`)
  assertJsonValue(value.locator, `${path}.locator`)
  const locator = value.locator as Locator
  return {
    portable: value.portable,
    locator,
    ...(reason === undefined ? {} : { reason }),
  }
}

/** Validate one snapshot descriptor (path safety + integrity fields). */
function parseSnapshot(value: unknown, path: string): CluepackSnapshot {
  if (!isRecord(value)) invalid(`${path} must be an object`)
  const snapshotPath = requireString(value.path, `${path}.path`)
  if (snapshotPath === CLUEPACK_CONTENT_PREFIX || !snapshotPath.startsWith(CLUEPACK_CONTENT_PREFIX)) {
    invalid(`${path}.path must be a file under ${CLUEPACK_CONTENT_PREFIX}`)
  }
  // Reuse the ZIP name policy: no `..`, absolute paths, backslashes, NULs.
  assertZipEntryName(snapshotPath)
  if (value.encoding !== 'json' && value.encoding !== 'raw') {
    invalid(`${path}.encoding must be "json" or "raw"`)
  }
  const mediaType = requireString(value.mediaType, `${path}.mediaType`)
  const format = requireString(value.format, `${path}.format`)
  const bytes = requireByteCount(value.bytes, `${path}.bytes`)
  if (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) {
    invalid(`${path}.sha256 must be 64 lowercase hex characters`)
  }
  const fetchedAt = requireTimestamp(value.fetchedAt, `${path}.fetchedAt`)
  const sourceVersion = optionalString(value.sourceVersion, `${path}.sourceVersion`)
  return {
    path: snapshotPath,
    encoding: value.encoding,
    mediaType,
    format,
    bytes,
    sha256: value.sha256,
    fetchedAt,
    ...(sourceVersion === undefined ? {} : { sourceVersion }),
  }
}

/** Validate one source record. */
function parseSource(value: unknown, path: string): CluepackSource {
  if (!isRecord(value)) invalid(`${path} must be an object`)
  const key = requireString(value.key, `${path}.key`)
  const sourceId = requireString(value.sourceId, `${path}.sourceId`)
  const pluginId = optionalString(value.pluginId, `${path}.pluginId`)
  const name = optionalString(value.name, `${path}.name`)
  if (value.transport !== undefined && !TRANSPORTS.has(value.transport as string)) {
    invalid(`${path}.transport must be one of ${[...TRANSPORTS].join(', ')}`)
  }
  let typeIds: string[] | undefined
  if (value.typeIds !== undefined) {
    if (!Array.isArray(value.typeIds)) invalid(`${path}.typeIds must be an array of strings`)
    const seen = new Set<string>()
    typeIds = value.typeIds.map((typeId, index) => {
      if (typeof typeId !== 'string' || typeId.trim() === '') {
        invalid(`${path}.typeIds[${index}] must be a non-empty string`)
      }
      if (seen.has(typeId)) invalid(`duplicate type id "${typeId}" in ${path}`)
      seen.add(typeId)
      return typeId
    })
  }
  return {
    key,
    sourceId,
    ...(pluginId === undefined ? {} : { pluginId }),
    ...(name === undefined ? {} : { name }),
    ...(value.transport === undefined ? {} : { transport: value.transport as SourceTransport }),
    ...(typeIds === undefined ? {} : { typeIds }),
  }
}

/**
 * Validate one manifest value and return a fresh copy holding only the
 * documented fields.
 * @param value - parsed JSON of `manifest.json` (untrusted).
 */
export function parseCluepackManifest(value: unknown): CluepackManifest {
  if (!isRecord(value)) invalid('the cluepack manifest must be a JSON object')
  if (!Number.isInteger(value.formatVersion)) invalid('manifest formatVersion must be an integer')
  if (value.formatVersion !== CLUEPACK_FORMAT_VERSION) {
    throw new ClueError(
      'unsupported',
      `unsupported cluepack format version ${String(value.formatVersion)} (this plugin understands ${CLUEPACK_FORMAT_VERSION})`,
    )
  }
  if (value.format !== CLUEPACK_FORMAT) {
    invalid(`this file is not a ${CLUEPACK_FORMAT} manifest`)
  }
  const exportedAt = requireTimestamp(value.exportedAt, 'manifest exportedAt')
  if (!MODES.has(value.mode as string)) invalid('manifest mode must be "references" or "snapshot"')
  const mode = value.mode as CluepackMode

  if (!Array.isArray(value.sources)) invalid('manifest sources must be an array')
  const sourceKeys = new Set<string>()
  const sources = value.sources.map((entry, index) => {
    const source = parseSource(entry, `sources[${index}]`)
    if (sourceKeys.has(source.key)) invalid(`duplicate source key "${source.key}"`)
    sourceKeys.add(source.key)
    return source
  })

  if (!Array.isArray(value.clues)) invalid('manifest clues must be an array')
  const clueKeys = new Set<string>()
  const snapshotPaths = new Set<string>()
  const clues = value.clues.map((entry, index) => {
    const path = `clues[${index}]`
    if (!isRecord(entry)) invalid(`${path} must be an object`)
    const key = requireString(entry.key, `${path}.key`)
    if (clueKeys.has(key)) invalid(`duplicate clue key "${key}"`)
    clueKeys.add(key)
    const sourceKey = requireString(entry.sourceKey, `${path}.sourceKey`)
    if (!sourceKeys.has(sourceKey)) invalid(`${path}.sourceKey "${sourceKey}" is an unknown source`)
    const typeId = requireString(entry.typeId, `${path}.typeId`)
    const title = requireString(entry.title, `${path}.title`)
    const portable = parsePortable(entry.portable, `${path}.portable`)
    const snapshot = entry.snapshot === undefined ? undefined : parseSnapshot(entry.snapshot, `${path}.snapshot`)
    if (snapshot !== undefined) {
      if (snapshotPaths.has(snapshot.path)) invalid(`duplicate snapshot path "${snapshot.path}"`)
      snapshotPaths.add(snapshot.path)
    }
    return { key, sourceKey, typeId, title, portable, ...(snapshot === undefined ? {} : { snapshot }) }
  })

  if (!Array.isArray(value.packs)) invalid('manifest packs must be an array')
  const packKeys = new Set<string>()
  const packs = value.packs.map((entry, index) => {
    const path = `packs[${index}]`
    if (!isRecord(entry)) invalid(`${path} must be an object`)
    const key = requireString(entry.key, `${path}.key`)
    if (packKeys.has(key)) invalid(`duplicate pack key "${key}"`)
    packKeys.add(key)
    const name = requireString(entry.name, `${path}.name`)
    if (!Array.isArray(entry.members)) invalid(`${path}.members must be an array`)
    const seen = new Set<string>()
    const members = entry.members.map((member, memberIndex) => {
      if (typeof member !== 'string' || member.trim() === '') {
        invalid(`${path}.members[${memberIndex}] must be a non-empty clue key`)
      }
      if (!clueKeys.has(member)) invalid(`${path}.members[${memberIndex}] "${member}" is an unknown clue`)
      if (seen.has(member)) invalid(`duplicate pack member "${member}" in ${path}`)
      seen.add(member)
      return member
    })
    return { key, name, members }
  })

  if (!Array.isArray(value.issues)) invalid('manifest issues must be an array')
  const issues = value.issues.map((entry, index) => {
    const path = `issues[${index}]`
    if (!isRecord(entry)) invalid(`${path} must be an object`)
    if (entry.target !== 'clue' && entry.target !== 'pack') {
      invalid(`${path}.target must be "clue" or "pack"`)
    }
    const target: 'clue' | 'pack' = entry.target === 'clue' ? 'clue' : 'pack'
    const key = requireString(entry.key, `${path}.key`)
    if (target === 'clue' && !clueKeys.has(key)) invalid(`${path}.key "${key}" is an unknown clue`)
    if (target === 'pack' && !packKeys.has(key)) invalid(`${path}.key "${key}" is an unknown pack`)
    const reason = requireString(entry.reason, `${path}.reason`)
    if (entry.category !== undefined && !CATEGORIES.has(entry.category as string)) {
      invalid(`${path}.category must be a fixed clue error category`)
    }
    return {
      target,
      key,
      reason,
      ...(entry.category === undefined ? {} : { category: entry.category as ClueErrorCategory }),
    }
  })

  return {
    formatVersion: CLUEPACK_FORMAT_VERSION,
    format: CLUEPACK_FORMAT,
    exportedAt,
    mode,
    sources,
    clues,
    packs,
    issues,
  }
}

/**
 * Parse manifest JSON text.
 * @param json - raw UTF-8 text of `manifest.json`.
 */
export function parseCluepackManifestJson(json: string): CluepackManifest {
  let value: unknown
  try {
    value = JSON.parse(json) as unknown
  } catch {
    invalid('the cluepack manifest is not valid JSON')
  }
  return parseCluepackManifest(value)
}

/**
 * Parse raw manifest bytes as UTF-8 JSON (the importer's entry point).
 * @param bytes - raw `manifest.json` entry bytes.
 */
export function parseCluepackManifestBytes(bytes: Uint8Array): CluepackManifest {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    invalid(`the cluepack manifest is too large (${bytes.byteLength} bytes; limit ${MAX_MANIFEST_BYTES})`)
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    invalid('the cluepack manifest is not valid UTF-8')
  }
  return parseCluepackManifestJson(text)
}

/**
 * Serialize one manifest as pretty UTF-8 JSON.
 * The value is validated first, so a malformed in-memory manifest can never
 * become the manifest.json of a finished archive.
 * @param manifest - the manifest the exporter assembled.
 */
export function serializeCluepackManifest(manifest: CluepackManifest): Buffer {
  return Buffer.from(`${JSON.stringify(parseCluepackManifest(manifest), null, 2)}\n`, 'utf8')
}
