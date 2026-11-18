/**
 * The durable thumbnail store behind the session media viewer.
 *
 * Why the plugin keeps its OWN copy: DSH's attachment objects live in
 * `<DSH_HOME>/attachments/v1/objects/…` and nothing in the host ever deletes
 * them — but a user cleaning that directory, a rebuilt harness home, or a
 * session carried onto another machine leaves every historical reference
 * dangling, and the conversation's images simply stop loading (the host
 * answers `ATTACHMENT_NOT_FOUND`). A thumbnail stored by this plugin is the
 * one artifact that survives that, because it is small, plugin-owned, and
 * content-addressed by the item's IDENTITY rather than by its bytes: the same
 * `attachmentId` (or delivered file path) always maps to the same slot, so a
 * re-appearance of the media re-uses the thumbnail instead of duplicating it.
 *
 * Layout, under `<DSH_HOME>/better-sidebar/media-thumbs/v1/`:
 *
 *   <2 hex of the identity digest>/<64 hex>.png
 *
 * The leaf is derived from a sha256 of the identity string, never from the
 * identity itself: an `attachmentId` and an absolute path both pass through
 * the same digest, so nothing outside this directory can be addressed and a
 * Windows path's `:` / `\` never reaches the filesystem.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SidebarError } from './wire.ts'

/** Plugin-owned durable directory under the harness home. */
const THUMB_DIR = join('better-sidebar', 'media-thumbs', 'v1')

/** Largest thumbnail the store accepts (a 160px card is a few KiB). */
export const THUMB_MAX_BYTES = 512 * 1024

/** A PNG signature: the only container the client uploads. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * The absolute root of the thumbnail store.
 * @param home - the harness home (`ctx.profileContext.home`).
 * @returns the store root (not guaranteed to exist).
 */
export function thumbRootOf(home: string): string {
  return join(home, THUMB_DIR)
}

/**
 * The 64-hex slot name of one media identity.
 *
 * The identity is hashed rather than used verbatim so that the same primitive
 * serves attachment ids (`sha256:<hex>`) and absolute workspace paths.
 * @param id - the catalogue row's `id`.
 * @returns lowercase hex, 64 characters.
 */
export function thumbKeyOf(id: string): string {
  return createHash('sha256').update(`better-sidebar:media-thumb:v1:${id}`).digest('hex')
}

/**
 * The absolute path of one identity's thumbnail.
 * @param root - the store root.
 * @param id - the catalogue row's `id`.
 * @returns the `.png` path (whether or not it exists).
 */
export function thumbPathOf(root: string, id: string): string {
  const key = thumbKeyOf(id)
  return join(root, key.slice(0, 2), `${key}.png`)
}

/**
 * Whether one identity already has a stored thumbnail, and its byte length.
 * @param root - the store root.
 * @param id - the catalogue row's `id`.
 * @returns the size in bytes, or undefined when no thumbnail exists.
 */
export async function statThumb(root: string, id: string): Promise<number | undefined> {
  try {
    const info = await stat(thumbPathOf(root, id))
    return info.isFile() ? info.size : undefined
  } catch {
    return undefined
  }
}

/**
 * Read one stored thumbnail.
 * @param root - the store root.
 * @param id - the catalogue row's `id`.
 * @returns the PNG bytes, or undefined when absent.
 */
export async function readThumb(root: string, id: string): Promise<Buffer | undefined> {
  try {
    return await readFile(thumbPathOf(root, id))
  } catch {
    return undefined
  }
}

/**
 * Store one thumbnail atomically.
 *
 * An existing file is LEFT ALONE: the slot is content-addressed by identity,
 * and the first capture is the one the viewer already showed — re-generating
 * (a canvas re-decode after a browser refresh) must not churn the file. A
 * caller that genuinely wants a new picture deletes the row first.
 * @param root - the store root.
 * @param id - the catalogue row's `id`.
 * @param bytes - the PNG bytes the client rendered.
 * @returns the stored byte length, and whether this call created the file.
 * @throws {SidebarError} when the payload is not a plausible PNG or is oversized.
 */
export async function writeThumb(
  root: string,
  id: string,
  bytes: Buffer,
): Promise<{ bytes: number; created: boolean }> {
  if (bytes.length === 0) throw new SidebarError('bad-request', 'empty thumbnail payload')
  if (bytes.length > THUMB_MAX_BYTES) {
    throw new SidebarError('too-large', `thumbnail exceeds ${THUMB_MAX_BYTES} bytes`, 413)
  }
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new SidebarError('bad-request', 'thumbnail must be a PNG')
  }
  const target = thumbPathOf(root, id)
  const existing = await statThumb(root, id)
  if (existing !== undefined) return { bytes: existing, created: false }
  await mkdir(join(root, thumbKeyOf(id).slice(0, 2)), { recursive: true })
  // Write beside the target and rename: a half-written thumbnail would be
  // served as a broken image forever (the slot never overwrites itself).
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temp, bytes)
    await rename(temp, target)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
  return { bytes: bytes.length, created: true }
}
