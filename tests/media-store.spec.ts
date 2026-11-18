/**
 * Durable thumbnail store contract: the plugin-owned copy that keeps a
 * session's media browsable after the original attachment object is gone.
 *
 * The invariants that matter, each one a failure mode a real deployment hits:
 *  - the slot is derived from the media IDENTITY through a digest, so an
 *    `attachmentId` (`sha256:<hex>`) and an absolute Windows path land in the
 *    same flat, safe namespace (no `:` / `\` in a file name);
 *  - the FIRST capture wins: a page reload re-renders the same picture, and
 *    churning the file would make every reload a write;
 *  - the payload must be a PNG of bounded size — the bytes come from a browser,
 *    so they are untrusted input, not a trusted pipeline;
 *  - a write is atomic, because a half-written thumbnail would be served as a
 *    broken image forever (the slot never overwrites itself).
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readThumb, statThumb, thumbKeyOf, thumbPathOf, thumbRootOf, THUMB_MAX_BYTES, writeThumb,
} from '../src/media-store.ts'

/** A minimal valid PNG (1×1, transparent). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

let home: string
/** The store root under the temporary home. */
let root: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'sidebar-media-'))
  root = thumbRootOf(home)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('thumbRootOf', () => {
  it('lives under the harness home, in the plugin\'s own namespace', () => {
    expect(root).toContain('better-sidebar')
    expect(root).toContain('media-thumbs')
    expect(root.startsWith(home)).toBe(true)
  })
})

describe('thumbKeyOf / thumbPathOf', () => {
  it('derives a 64-hex slot from any identity, without leaking its shape', () => {
    const key = thumbKeyOf('sha256:ab'.padEnd(71, 'c'))
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    // A Windows path's `:` and `\` must never reach the SLOT's own name (the
    // root may of course carry a drive letter — that is the harness home).
    const fromPath = thumbKeyOf('C:\\Users\\someone\\a.png')
    expect(fromPath).toMatch(/^[0-9a-f]{64}$/)
    const leaf = thumbPathOf(root, 'C:\\Users\\someone\\a.png').slice(root.length)
    expect(leaf).not.toContain(':')
    expect(leaf).toMatch(/^[\\/][0-9a-f]{2}[\\/][0-9a-f]{64}\.png$/)
  })

  it('is a pure function of the identity: the same id always resolves to one slot', () => {
    expect(thumbPathOf(root, 'sha256:aa')).toBe(thumbPathOf(root, 'sha256:aa'))
    expect(thumbPathOf(root, 'sha256:aa')).not.toBe(thumbPathOf(root, 'sha256:ab'))
  })

  it('shards by the first two hex characters, like the host\'s own store', () => {
    const path = thumbPathOf(root, 'sha256:aa')
    expect(path).toContain(thumbKeyOf('sha256:aa').slice(0, 2))
    expect(path.endsWith('.png')).toBe(true)
  })
})

describe('writeThumb / readThumb / statThumb', () => {
  it('stores one PNG and reads it back byte-for-byte', async () => {
    const result = await writeThumb(root, 'sha256:aa', PNG)
    expect(result).toEqual({ bytes: PNG.length, created: true })
    expect(await statThumb(root, 'sha256:aa')).toBe(PNG.length)
    expect(await readThumb(root, 'sha256:aa')).toEqual(PNG)
  })

  it('keeps the FIRST capture when the same identity is uploaded again', async () => {
    await writeThumb(root, 'sha256:aa', PNG)
    // A second render of the same picture: same identity, different bytes.
    const other = Buffer.concat([PNG, Buffer.from([0])])
    const result = await writeThumb(root, 'sha256:aa', other)
    expect(result.created).toBe(false)
    expect(result.bytes).toBe(PNG.length)
    expect(await readThumb(root, 'sha256:aa')).toEqual(PNG)
  })

  it('creates the shard directory on demand', async () => {
    await writeThumb(root, 'a-delivered/path/clip.mp4', PNG)
    // The shard existed only because the write created it.
    const info = await stat(thumbPathOf(root, 'a-delivered/path/clip.mp4'))
    expect(info.isFile()).toBe(true)
  })

  it('answers undefined for an identity with no thumbnail', async () => {
    expect(await statThumb(root, 'sha256:missing')).toBeUndefined()
    expect(await readThumb(root, 'sha256:missing')).toBeUndefined()
  })

  it('refuses a payload that is not a PNG', async () => {
    await expect(writeThumb(root, 'sha256:aa', Buffer.from('not a png'))).rejects.toMatchObject({ code: 'bad-request' })
    await expect(writeThumb(root, 'sha256:aa', Buffer.alloc(0))).rejects.toMatchObject({ code: 'bad-request' })
  })

  it('refuses a payload past the size bound', async () => {
    const oversized = Buffer.concat([PNG, Buffer.alloc(THUMB_MAX_BYTES)])
    await expect(writeThumb(root, 'sha256:aa', oversized)).rejects.toMatchObject({ code: 'too-large' })
  })

  it('leaves no temporary file behind after a successful write', async () => {
    await writeThumb(root, 'sha256:aa', PNG)
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(join(root, thumbKeyOf('sha256:aa').slice(0, 2)))
    // Exactly the slot itself: the `.<pid>.<ts>.tmp` staging name is renamed
    // away, so a crashed write is the only way one survives.
    expect(entries).toEqual([`${thumbKeyOf('sha256:aa')}.png`])
  })

  it('survives the original file disappearing (the whole point)', async () => {
    // Simulate the deployment this store exists for: the media's original is
    // gone, but the thumbnail the plugin captured is still there.
    const original = join(home, 'original.png')
    await writeFile(original, PNG)
    await writeThumb(root, 'sha256:aa', PNG)
    await rm(original)
    expect(await readThumb(root, 'sha256:aa')).toEqual(await readFile(thumbPathOf(root, 'sha256:aa')))
  })
})
