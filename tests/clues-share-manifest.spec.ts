/**
 * S7 manifest contract: the only `.cluepack` metadata format (formatVersion 1).
 *
 * The reader is the untrusted boundary. It must accept the documented shape,
 * ignore unknown JSON extension keys, and refuse anything a share format must
 * not guess at: an unknown `formatVersion`, a foreign `format`, duplicate
 * keys, dangling cross-references, unsafe snapshot paths, non-hex digests and
 * ill-typed fields. Nothing here performs I/O; the importer applies the same
 * result.
 */
import { describe, expect, it } from 'vitest'
import {
  CLUEPACK_FORMAT,
  CLUEPACK_FORMAT_VERSION,
  MAX_MANIFEST_BYTES,
  parseCluepackManifest,
  parseCluepackManifestBytes,
  parseCluepackManifestJson,
  serializeCluepackManifest,
  type CluepackManifest,
} from '../src/clues/share/manifest.ts'
import { ClueError, type JsonValue } from '../src/clues/types.ts'

/** A valid manifest exercising every documented region. */
function validManifest(): CluepackManifest {
  return {
    formatVersion: 1,
    format: CLUEPACK_FORMAT,
    exportedAt: '2026-10-17T00:00:00.000Z',
    mode: 'snapshot',
    sources: [
      {
        key: 'source-1',
        sourceId: 'builtin.files',
        pluginId: 'dsh-better-sidebar',
        name: 'Local files',
        transport: 'files',
      },
      { key: 'source-2', sourceId: 'third.party:docs' },
    ],
    clues: [
      {
        key: 'clue-1',
        sourceKey: 'source-1',
        typeId: 'builtin.files.markdown',
        title: '设计笔记.md',
        portable: {
          portable: true,
          locator: { root: { kind: 'workspace', workspaceId: 'ws-1' }, path: '设计笔记.md', dialect: 'posix' },
        },
        snapshot: {
          path: 'content/clue-1.json',
          encoding: 'json',
          mediaType: 'application/json',
          format: 'text/markdown',
          bytes: 12,
          sha256: 'a'.repeat(64),
          fetchedAt: '2026-10-17T00:00:00.000Z',
          sourceVersion: 'rev-1',
        },
      },
      {
        key: 'clue-2',
        sourceKey: 'source-2',
        typeId: 'third.party:doc',
        title: 'Missing source doc',
        portable: { portable: false, reason: 'the source does not provide portable references' },
      },
    ],
    packs: [
      { key: 'pack-1', name: '发布材料', members: ['clue-1', 'clue-2'] },
    ],
    issues: [
      { target: 'clue', key: 'clue-2', category: 'unsupported', reason: 'content was not fetched' },
    ],
  }
}

/** Deep-clone one JSON value (test-local, keeps cases independent). */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe('parseCluepackManifest', () => {
  it('accepts the documented v1 shape and copies only known fields', () => {
    const manifest = validManifest()
    expect(parseCluepackManifest(manifest)).toEqual(manifest)
  })

  it('ignores unknown extension keys at every level', () => {
    const raw = clone(validManifest()) as unknown as Record<string, JsonValue>
    raw.futureFeature = { nested: true }
    ;(raw.sources as JsonValue[])[0]!['unknownSourceField'] = 'x'
    ;(raw.clues as JsonValue[])[0]!['unknownClueField'] = 1
    ;((raw.clues as JsonValue[])[0]!['snapshot'] as JsonValue)['unknownSnapshotField'] = true
    ;(raw.packs as JsonValue[])[0]!['unknownPackField'] = null
    ;(raw.issues as JsonValue[])[0]!['unknownIssueField'] = 'x'
    const parsed = parseCluepackManifest(raw)
    expect(parsed).toEqual(validManifest())
  })

  it('rejects an unknown formatVersion explicitly instead of guessing', () => {
    const raw = clone(validManifest()) as unknown as Record<string, JsonValue>
    raw.formatVersion = 2
    expect(() => parseCluepackManifest(raw)).toThrowError(/unsupported cluepack format version 2/i)
    try {
      parseCluepackManifest(raw)
    } catch (error) {
      expect(error).toBeInstanceOf(ClueError)
      expect((error as ClueError).category).toBe('unsupported')
    }
    raw.formatVersion = '1'
    expect(() => parseCluepackManifest(raw)).toThrowError(/formatVersion/i)
  })

  it('rejects a foreign format and an unknown mode', () => {
    const foreign = clone(validManifest()) as unknown as Record<string, JsonValue>
    foreign.format = 'someone-else'
    expect(() => parseCluepackManifest(foreign)).toThrowError(/not a dsh-cluepack manifest/i)
    const badMode = clone(validManifest()) as unknown as Record<string, JsonValue>
    badMode.mode = 'live'
    expect(() => parseCluepackManifest(badMode)).toThrowError(/mode/i)
  })

  it('rejects a malformed exportedAt timestamp', () => {
    const raw = clone(validManifest()) as unknown as Record<string, JsonValue>
    raw.exportedAt = 'yesterday'
    expect(() => parseCluepackManifest(raw)).toThrowError(/exportedAt/i)
  })

  it('rejects duplicate keys, dangling references and duplicate pack members', () => {
    const duplicateSource = clone(validManifest())
    duplicateSource.sources[1] = { ...duplicateSource.sources[0]! }
    expect(() => parseCluepackManifest(duplicateSource)).toThrowError(/duplicate source key/i)

    const duplicateClue = clone(validManifest())
    duplicateClue.clues[1] = { ...duplicateClue.clues[0]! }
    expect(() => parseCluepackManifest(duplicateClue)).toThrowError(/duplicate clue key/i)

    const duplicatePack = clone(validManifest())
    duplicatePack.packs.push({ ...duplicatePack.packs[0]! })
    expect(() => parseCluepackManifest(duplicatePack)).toThrowError(/duplicate pack key/i)

    const danglingSource = clone(validManifest())
    danglingSource.clues[0]!.sourceKey = 'source-missing'
    expect(() => parseCluepackManifest(danglingSource)).toThrowError(/unknown source/i)

    const danglingMember = clone(validManifest())
    danglingMember.packs[0]!.members.push('clue-missing')
    expect(() => parseCluepackManifest(danglingMember)).toThrowError(/unknown clue/i)

    const duplicateMember = clone(validManifest())
    duplicateMember.packs[0]!.members.push('clue-1')
    expect(() => parseCluepackManifest(duplicateMember)).toThrowError(/duplicate pack member/i)
  })

  it('rejects unsafe or duplicated snapshot paths and invalid digests', () => {
    const cases: Array<(raw: CluepackManifest) => void> = [
      raw => { raw.clues[0]!.snapshot!.path = '../content/clue-1.json' },
      raw => { raw.clues[0]!.snapshot!.path = '/content/clue-1.json' },
      raw => { raw.clues[0]!.snapshot!.path = 'manifest.json' },
      raw => { raw.clues[0]!.snapshot!.path = 'content/../manifest.json' },
      raw => { raw.clues[0]!.snapshot!.path = 'content\\clue-1.json' },
      raw => { raw.clues[0]!.snapshot!.sha256 = 'abc' },
      raw => { raw.clues[0]!.snapshot!.sha256 = 'g'.repeat(64) },
      raw => { raw.clues[0]!.snapshot!.bytes = -1 },
      raw => { raw.clues[0]!.snapshot!.bytes = 1.5 },
      raw => { raw.clues[0]!.snapshot!.encoding = 'base64' },
    ]
    for (const mutate of cases) {
      const raw = clone(validManifest())
      mutate(raw)
      expect(() => parseCluepackManifest(raw), JSON.stringify(raw.clues[0]!.snapshot)).toThrowError(ClueError)
    }
    const duplicatePath = clone(validManifest())
    duplicatePath.clues[1]!.snapshot = { ...duplicatePath.clues[0]!.snapshot! }
    expect(() => parseCluepackManifest(duplicatePath)).toThrowError(/duplicate snapshot path/i)
  })

  it('validates portable references without inventing a locator', () => {
    const noLocator = clone(validManifest())
    noLocator.clues[0]!.portable = { portable: true }
    expect(() => parseCluepackManifest(noLocator)).toThrowError(/portable.*locator/i)

    const nonObject = clone(validManifest()) as unknown as Record<string, JsonValue>
    ;((nonObject.clues as JsonValue[])[0]!['portable'] as JsonValue)['locator'] = [1, 2]
    expect(() => parseCluepackManifest(nonObject)).toThrowError(/portable.*locator/i)

    const nonPortableWithoutReason = clone(validManifest())
    nonPortableWithoutReason.clues[1]!.portable = { portable: false }
    expect(parseCluepackManifest(nonPortableWithoutReason).clues[1]!.portable.portable).toBe(false)
  })

  it('rejects issues that name unknown objects or categories', () => {
    const dangling = clone(validManifest())
    dangling.issues[0]!.key = 'clue-missing'
    expect(() => parseCluepackManifest(dangling)).toThrowError(/unknown clue/i)
    const badCategory = clone(validManifest()) as unknown as Record<string, JsonValue>
    ;(badCategory.issues as JsonValue[])[0]!['category'] = 'auth-failure'
    expect(() => parseCluepackManifest(badCategory)).toThrowError(/category/i)
    const danglingPack = clone(validManifest())
    danglingPack.issues[0] = { target: 'pack', key: 'pack-missing', reason: 'x' }
    expect(() => parseCluepackManifest(danglingPack)).toThrowError(/unknown pack/i)
  })

  it('rejects empty titles/type ids and a non-object root', () => {
    const emptyTitle = clone(validManifest())
    emptyTitle.clues[0]!.title = '   '
    expect(() => parseCluepackManifest(emptyTitle)).toThrowError(/title/i)
    const emptyType = clone(validManifest())
    emptyType.clues[0]!.typeId = ''
    expect(() => parseCluepackManifest(emptyType)).toThrowError(/typeId/i)
    expect(() => parseCluepackManifest(null)).toThrowError(/JSON object/i)
    expect(() => parseCluepackManifest([])).toThrowError(/JSON object/i)
  })

  it('rejects invalid UTF-8 and oversized manifest bytes', () => {
    const bytes = new Uint8Array([0x7b, 0xff, 0x7d])
    expect(() => parseCluepackManifestBytes(bytes)).toThrowError(/UTF-8/i)
    const oversized = new Uint8Array(MAX_MANIFEST_BYTES + 1).fill(0x20)
    expect(() => parseCluepackManifestBytes(oversized)).toThrowError(/too large/i)
  })

  it('parses JSON text and reports malformed JSON as invalid-request', () => {
    expect(parseCluepackManifestJson(JSON.stringify(validManifest()))).toEqual(validManifest())
    expect(() => parseCluepackManifestJson('{')).toThrowError(/not valid JSON/i)
    try {
      parseCluepackManifestJson('{')
    } catch (error) {
      expect((error as ClueError).category).toBe('invalid-request')
    }
  })
})

describe('serializeCluepackManifest', () => {
  it('writes UTF-8 JSON that parses back to the same manifest', () => {
    const manifest = validManifest()
    const bytes = serializeCluepackManifest(manifest)
    expect(Buffer.isBuffer(bytes)).toBe(true)
    expect(parseCluepackManifestBytes(bytes)).toEqual(manifest)
    expect(new TextDecoder().decode(bytes)).toContain('设计笔记.md')
  })

  it('rejects an invalid manifest instead of writing it', () => {
    const manifest = clone(validManifest())
    manifest.formatVersion = CLUEPACK_FORMAT_VERSION + 1 as 1
    expect(() => serializeCluepackManifest(manifest)).toThrowError(ClueError)
  })
})
