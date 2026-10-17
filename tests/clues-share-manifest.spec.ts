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
  MAX_MANIFEST_CLUES,
  MAX_MANIFEST_ISSUES,
  MAX_MANIFEST_PACKS,
  MAX_MANIFEST_SOURCES,
  parseCluepackManifest,
  parseCluepackManifestBytes,
  parseCluepackManifestJson,
  serializeCluepackManifest,
  type CluepackManifest,
} from '../src/clues/share/manifest.ts'
import { ClueError } from '../src/clues/types.ts'

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
        typeIds: ['builtin.files.markdown'],
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

/** Mutable view of a manifest for cases that patch untrusted JSON. */
type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T

/** Deep-clone one manifest as mutable JSON (test-local). */
function clone(): DeepMutable<CluepackManifest> {
  return JSON.parse(JSON.stringify(validManifest())) as DeepMutable<CluepackManifest>
}

/** Patch one field with a deliberately ill-typed value. */
function rawField(value: object): Record<string, unknown> {
  return value as unknown as Record<string, unknown>
}

describe('parseCluepackManifest', () => {
  it('accepts the documented v1 shape and copies only known fields', () => {
    const manifest = validManifest()
    expect(parseCluepackManifest(manifest)).toEqual(manifest)
  })

  it('ignores unknown extension keys at every level', () => {
    const raw = clone()
    rawField(raw).futureFeature = { nested: true }
    rawField(raw.sources[0]!).unknownSourceField = 'x'
    rawField(raw.clues[0]!).unknownClueField = 1
    rawField(raw.clues[0]!.snapshot!).unknownSnapshotField = true
    rawField(raw.packs[0]!).unknownPackField = null
    rawField(raw.issues[0]!).unknownIssueField = 'x'
    const parsed = parseCluepackManifest(raw)
    expect(parsed).toEqual(validManifest())
  })

  it('rejects an unknown formatVersion explicitly instead of guessing', () => {
    const raw = clone()
    rawField(raw).formatVersion = 2
    expect(() => parseCluepackManifest(raw)).toThrowError(/unsupported cluepack format version 2/i)
    try {
      parseCluepackManifest(raw)
    } catch (error) {
      expect(error).toBeInstanceOf(ClueError)
      expect((error as ClueError).category).toBe('unsupported')
    }
    rawField(raw).formatVersion = '1'
    expect(() => parseCluepackManifest(raw)).toThrowError(/formatVersion/i)
  })

  it('rejects a foreign format and an unknown mode', () => {
    const foreign = clone()
    rawField(foreign).format = 'someone-else'
    expect(() => parseCluepackManifest(foreign)).toThrowError(/not a dsh-cluepack manifest/i)
    const badMode = clone()
    rawField(badMode).mode = 'live'
    expect(() => parseCluepackManifest(badMode)).toThrowError(/mode/i)
  })

  it('rejects a malformed exportedAt timestamp', () => {
    const raw = clone()
    raw.exportedAt = 'yesterday'
    expect(() => parseCluepackManifest(raw)).toThrowError(/exportedAt/i)
  })

  it('rejects duplicate keys, dangling references and duplicate pack members', () => {
    const duplicateSource = clone()
    duplicateSource.sources[1] = { ...duplicateSource.sources[0]! }
    expect(() => parseCluepackManifest(duplicateSource)).toThrowError(/duplicate source key/i)

    const duplicateClue = clone()
    duplicateClue.clues[1] = { ...duplicateClue.clues[0]! }
    expect(() => parseCluepackManifest(duplicateClue)).toThrowError(/duplicate clue key/i)

    const duplicatePack = clone()
    duplicatePack.packs.push({ ...duplicatePack.packs[0]! })
    expect(() => parseCluepackManifest(duplicatePack)).toThrowError(/duplicate pack key/i)

    const danglingSource = clone()
    danglingSource.clues[0]!.sourceKey = 'source-missing'
    expect(() => parseCluepackManifest(danglingSource)).toThrowError(/unknown source/i)

    const danglingMember = clone()
    danglingMember.packs[0]!.members.push('clue-missing')
    expect(() => parseCluepackManifest(danglingMember)).toThrowError(/unknown clue/i)

    const duplicateMember = clone()
    duplicateMember.packs[0]!.members.push('clue-1')
    expect(() => parseCluepackManifest(duplicateMember)).toThrowError(/duplicate pack member/i)
  })

  it('validates the optional source typeIds extension', () => {
    const duplicate = clone()
    duplicate.sources[0]!.typeIds = ['builtin.files.markdown', 'builtin.files.markdown']
    expect(() => parseCluepackManifest(duplicate)).toThrowError(/duplicate type id/i)
    const notArray = clone()
    rawField(notArray.sources[0]!).typeIds = 'builtin.files.markdown'
    expect(() => parseCluepackManifest(notArray)).toThrowError(/typeIds/i)
  })

  it('rejects a references-mode manifest that carries snapshots', () => {
    const raw = clone()
    raw.mode = 'references'
    expect(() => parseCluepackManifest(raw)).toThrowError(/references-mode.*snapshots/i)
  })

  it('rejects unsafe or duplicated snapshot paths and invalid digests', () => {
    const cases: Array<(raw: DeepMutable<CluepackManifest>) => void> = [
      raw => { raw.clues[0]!.snapshot!.path = '../content/clue-1.json' },
      raw => { raw.clues[0]!.snapshot!.path = '/content/clue-1.json' },
      raw => { raw.clues[0]!.snapshot!.path = 'manifest.json' },
      raw => { raw.clues[0]!.snapshot!.path = 'content/../manifest.json' },
      raw => { raw.clues[0]!.snapshot!.path = 'content\\clue-1.json' },
      raw => { raw.clues[0]!.snapshot!.sha256 = 'abc' },
      raw => { raw.clues[0]!.snapshot!.sha256 = 'g'.repeat(64) },
      raw => { raw.clues[0]!.snapshot!.bytes = -1 },
      raw => { raw.clues[0]!.snapshot!.bytes = 1.5 },
      raw => { rawField(raw.clues[0]!.snapshot!).encoding = 'base64' },
    ]
    for (const mutate of cases) {
      const raw = clone()
      mutate(raw)
      expect(() => parseCluepackManifest(raw), JSON.stringify(raw.clues[0]!.snapshot)).toThrowError(ClueError)
    }
    const duplicatePath = clone()
    duplicatePath.clues[1]!.snapshot = { ...duplicatePath.clues[0]!.snapshot! }
    expect(() => parseCluepackManifest(duplicatePath)).toThrowError(/duplicate snapshot path/i)
  })

  it('accepts only strict ISO-8601 timestamps, not anything Date.parse tolerates', () => {
    for (const value of [
      '1',
      '2026-02-30T00:00:00.000Z',
      '2026-13-01T00:00:00.000Z',
      '2026-10-17T24:00:00.000Z',
      '2026-10-17T00:60:00.000Z',
      'Fri, 17 Oct 2026 00:00:00 GMT',
      '2026-10-17',
      '2026-10-17T00:00:00+15:00',
    ]) {
      const badExport = clone()
      badExport.exportedAt = value
      expect(() => parseCluepackManifest(badExport), value).toThrowError(/ISO timestamp/i)
      const badFetched = clone()
      badFetched.clues[0]!.snapshot!.fetchedAt = value
      expect(() => parseCluepackManifest(badFetched), value).toThrowError(/ISO timestamp/i)
    }
    const offset = clone()
    offset.exportedAt = '2026-10-17T08:00:00+08:00'
    offset.clues[0]!.snapshot!.fetchedAt = '2026-10-17T00:00:00.123456789Z'
    expect(parseCluepackManifest(offset).exportedAt).toBe('2026-10-17T08:00:00+08:00')
  })

  it('validates extra snapshot assets and rejects duplicate/unsafe paths', () => {
    const valid = clone()
    valid.clues[0]!.snapshot!.assets = [{
      path: 'content/clue-1.asset-1.bin',
      kind: 'download',
      mediaType: 'image/png',
      bytes: 7,
      sha256: 'b'.repeat(64),
    }]
    expect(parseCluepackManifest(valid).clues[0]!.snapshot!.assets).toHaveLength(1)

    const duplicate = clone()
    duplicate.clues[0]!.snapshot!.assets = [
      { ...valid.clues[0]!.snapshot!.assets![0]! },
      { ...valid.clues[0]!.snapshot!.assets![0]! },
    ]
    expect(() => parseCluepackManifest(duplicate)).toThrowError(/duplicate snapshot asset path/i)

    const collidesWithPrimary = clone()
    collidesWithPrimary.clues[0]!.snapshot!.assets = [{
      ...valid.clues[0]!.snapshot!.assets![0]!,
      path: collidesWithPrimary.clues[0]!.snapshot!.path,
    }]
    expect(() => parseCluepackManifest(collidesWithPrimary)).toThrowError(/duplicate snapshot path/i)

    for (const mutate of [
      (asset: Record<string, unknown>) => { asset.path = '../asset.bin' },
      (asset: Record<string, unknown>) => { asset.kind = 'link' },
      (asset: Record<string, unknown>) => { asset.sha256 = 'abc' },
      (asset: Record<string, unknown>) => { asset.bytes = -1 },
    ]) {
      const bad = clone()
      const asset = { ...valid.clues[0]!.snapshot!.assets![0]! } as unknown as Record<string, unknown>
      mutate(asset)
      bad.clues[0]!.snapshot!.assets = [asset as never]
      expect(() => parseCluepackManifest(bad)).toThrowError(ClueError)
    }
  })

  it('validates portable references without inventing a locator', () => {
    const noLocator = clone()
    noLocator.clues[0]!.portable = { portable: true }
    expect(() => parseCluepackManifest(noLocator)).toThrowError(/portable.*locator/i)

    const nonObject = clone()
    rawField(nonObject.clues[0]!.portable).locator = [1, 2]
    expect(() => parseCluepackManifest(nonObject)).toThrowError(/portable.*locator/i)

    const emptyLocator = clone()
    emptyLocator.clues[0]!.portable = { portable: true, locator: {} }
    expect(() => parseCluepackManifest(emptyLocator)).toThrowError(/locator must not be empty/i)

    const nonPortableWithoutReason = clone()
    nonPortableWithoutReason.clues[1]!.portable = { portable: false }
    expect(parseCluepackManifest(nonPortableWithoutReason).clues[1]!.portable.portable).toBe(false)
  })

  it('rejects issues that name unknown objects or categories', () => {
    const dangling = clone()
    dangling.issues[0]!.key = 'clue-missing'
    expect(() => parseCluepackManifest(dangling)).toThrowError(/unknown clue/i)
    const badCategory = clone()
    rawField(badCategory.issues[0]!).category = 'auth-failure'
    expect(() => parseCluepackManifest(badCategory)).toThrowError(/category/i)
    const danglingPack = clone()
    danglingPack.issues[0] = { target: 'pack', key: 'pack-missing', reason: 'x' }
    expect(() => parseCluepackManifest(danglingPack)).toThrowError(/unknown pack/i)
  })

  it('rejects empty titles/type ids and a non-object root', () => {
    const emptyTitle = clone()
    emptyTitle.clues[0]!.title = '   '
    expect(() => parseCluepackManifest(emptyTitle)).toThrowError(/title/i)
    const emptyType = clone()
    emptyType.clues[0]!.typeId = ''
    expect(() => parseCluepackManifest(emptyType)).toThrowError(/typeId/i)
    expect(() => parseCluepackManifest(null)).toThrowError(/JSON object/i)
    expect(() => parseCluepackManifest([])).toThrowError(/JSON object/i)
  })

  it('bounds every manifest array before importing its records', () => {
    const sources = clone()
    sources.sources = Array.from({ length: MAX_MANIFEST_SOURCES + 1 }, (_, index) => ({
      key: `source-${index}`,
      sourceId: `third.party:${index}`,
    }))
    expect(() => parseCluepackManifest(sources)).toThrowError(/sources exceed the limit/i)

    const clues = clone()
    clues.clues = Array.from({ length: MAX_MANIFEST_CLUES + 1 }, (_, index) => ({
      key: `clue-${index}`,
      sourceKey: 'source-1',
      typeId: 'builtin.files.markdown',
      title: `t${index}`,
      portable: { portable: false, reason: 'none' },
    }))
    expect(() => parseCluepackManifest(clues)).toThrowError(/clues exceed the limit/i)

    const packs = clone()
    packs.packs = Array.from({ length: MAX_MANIFEST_PACKS + 1 }, (_, index) => ({
      key: `pack-${index}`,
      name: `p${index}`,
      members: [],
    }))
    expect(() => parseCluepackManifest(packs)).toThrowError(/packs exceed the limit/i)

    const issues = clone()
    issues.issues = Array.from({ length: MAX_MANIFEST_ISSUES + 1 }, () => ({
      target: 'clue' as const,
      key: 'clue-1',
      reason: 'x',
    }))
    expect(() => parseCluepackManifest(issues)).toThrowError(/issues exceed the limit/i)
  })

  it('turns a deeply nested locator into invalid-request instead of RangeError', () => {
    let locator: Record<string, unknown> = { value: 1 }
    for (let depth = 0; depth < 5_000; depth += 1) locator = { nested: locator }
    const raw = clone()
    rawField(raw.clues[0]!.portable).locator = locator
    expect(() => parseCluepackManifest(raw)).toThrowError(/nested too deeply/i)
    try {
      parseCluepackManifest(raw)
    } catch (error) {
      expect(error).toBeInstanceOf(ClueError)
      expect((error as ClueError).category).toBe('invalid-request')
    }

    // The JSON text path must also produce a typed error (never an uncaught
    // RangeError that the route would turn into a 500).
    const deepJson = '{"a":'.repeat(5_000) + '1' + '}'.repeat(5_000)
    const json = `{"formatVersion":1,"format":"${CLUEPACK_FORMAT}","exportedAt":"2026-10-17T00:00:00.000Z","mode":"snapshot","sources":[{"key":"s","sourceId":"builtin.files"}],"clues":[{"key":"c","sourceKey":"s","typeId":"t","title":"x","portable":{"portable":true,"locator":${deepJson}}}],"packs":[],"issues":[]}`
    try {
      parseCluepackManifestJson(json)
      throw new Error('expected the deeply nested locator to be refused')
    } catch (error) {
      expect(error).toBeInstanceOf(ClueError)
      expect((error as ClueError).category).toBe('invalid-request')
    }
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
    const manifest = clone()
    ;(manifest as { formatVersion: number }).formatVersion = CLUEPACK_FORMAT_VERSION + 1
    expect(() => serializeCluepackManifest(manifest)).toThrowError(ClueError)
  })
})
