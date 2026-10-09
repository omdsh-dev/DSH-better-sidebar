/**
 * File mutations for the sidebar (the upload route and the tree's renames,
 * deletes and mkdirs).
 *
 * ⚠️ **No workspace containment any more.** The guard was removed at the
 * user's request, so these operations reach whatever the HOST USER can reach.
 * What is still enforced is the SHAPE of a request: the relative upload path
 * is sanitized (absolute paths, '.', '..' and empty segments are refused), a
 * rename/mkdir name must be one path segment, a new FILE's name is additionally
 * checked against the characters and device names Windows cannot store, an
 * existing destination is refused instead of clobbered, and the session
 * workspace root itself is never renamable or removable. Bytes stream from the
 * request body to a uniquely named temp sibling and are renamed into place, so
 * a failed, aborted, or oversized upload never leaves a partial file at the
 * target path.
 *
 * The tree's rename/delete are link-aware: they address the LEXICAL row path
 * (lstat decides), so renaming or deleting a symlink row renames/unlinks the
 * LINK, never its target — matching what the tree row visually names (VS Code
 * semantics). Every mutation invalidates the directory cache of the level(s)
 * it touched.
 */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { access, lstat, mkdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { invalidateDirectoryCache, requireAbsolute } from './fs-tree.ts'
import { ensureWorkspaceWritePath, resolveTarget } from './path-security.ts'
import { SidebarError } from './wire.ts'

/**
 * The name SHAPE every file mutation shares: one path segment, no separators,
 * no `.`/`..`. Shared by rename, mkdir and the new-file rule so the three
 * entries refuse the same inputs with the same sentence.
 */
function assertSingleSegmentName(name: string): void {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new SidebarError('bad-request', 'name must be a single path segment', 400)
  }
}

/** Inputs of one upload: the session scope plus the request body stream. */
export interface WorkspaceUploadInput {
  /** The session workspace root (the base of session-relative targets). */
  cwd: string
  /** Upload directory chosen by the client — absolute, session-relative, or `~`-relative (#713). */
  dir: string
  /** Relative path below `dir` (absolute paths, '.', '..' and empty segments refused). */
  relativePath: string
  /** The request body stream (raw bytes). */
  chunks: AsyncIterable<string | Uint8Array>
  /** Byte cap; an oversized upload is refused without touching the target. */
  limit: number
  /** @deprecated IGNORED — containment was removed. Do not pass it. */
  fence?: boolean
}

/**
 * Stream `chunks` into `dir/relativePath` atomically: a uniquely named temp
 * sibling receives the bytes, then is renamed over the target. The parent
 * directory is created on demand (recursive), so folder uploads work before
 * any level exists. The unique temp name keeps concurrent uploads to the same
 * target independent (each writes and renames its own file; the last rename
 * wins) and never blocks later uploads after a crashed process.
 *
 * @throws SidebarError with a wire code for shape and size failures; the temp
 * file is always removed on failure.
 */
export async function writeWorkspaceUpload(input: WorkspaceUploadInput): Promise<{ path: string; size: number }> {
  const { cwd, dir, relativePath, chunks, limit } = input
  // The shared resolution contract: an absolute `dir` normalizes, a
  // session-relative one joins the cwd, `~` expands against the home (#713).
  const base = resolveTarget(cwd, dir)
  if (relativePath === '' || relativePath.startsWith('/') || relativePath.startsWith('\\')) {
    throw new SidebarError('bad-request', 'relativePath must stay below the upload directory', 400)
  }
  const segments = relativePath.split(/[\\/]/)
  if (segments.some(part => part === '' || part === '.' || part === '..')) {
    throw new SidebarError('bad-request', 'relativePath must stay below the upload directory', 400)
  }
  const target = join(base, ...segments)
  const safeTarget = await ensureWorkspaceWritePath(cwd, target)
  const tmp = join(dirname(safeTarget), `.${basename(safeTarget)}.dsh-upload-${randomUUID()}.tmp`)
  await mkdir(dirname(safeTarget), { recursive: true })
  const stream = createWriteStream(tmp, { flags: 'wx' })
  // Resolves once the stream fully closes; created up front so a stream that
  // already closed (successful end, later failure) cannot leave the wait hanging.
  const closed = new Promise<void>((resolve) => { stream.once('close', () => resolve()) })
  let size = 0
  let streamError: unknown
  // A permanent 'error' listener keeps a failing disk from crashing the host:
  // every await below surfaces the failure through the promise chain instead.
  stream.on('error', (error) => { streamError = error })
  try {
    for await (const chunk of chunks) {
      const buffer = Buffer.from(chunk)
      size += buffer.length
      if (size > limit) throw new SidebarError('too-large', `upload exceeds the ${limit} byte limit`, 413)
      if (!stream.write(buffer)) await once(stream, 'drain')
      if (streamError !== undefined) throw streamError
    }
    await new Promise<void>((resolve, reject) => {
      stream.end((error?: Error | null) => (error === undefined || error === null ? resolve() : reject(error)))
    })
    if (streamError !== undefined) throw streamError
    await rename(tmp, safeTarget)
    const info = await stat(safeTarget)
    // The target's level (and, for a new folder, its parent) is now stale.
    invalidateDirectoryCache(dirname(safeTarget))
    return { path: target, size: info.size }
  } catch (error) {
    // Wait for the stream to fully close before unlinking (Windows locks open
    // files), then remove our own uniquely named temp file.
    stream.destroy()
    await closed.catch(() => {})
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/** Inputs of one tree-row rename. */
export interface WorkspaceRenameInput {
  /** The session workspace root (the base of session-relative targets). */
  cwd: string
  /** Row path as the tree displays it (may be a symlink); absolute, session-relative, or `~`-relative. */
  path: string
  /** The new base name (single segment — rename never moves across directories). */
  name: string
  /** @deprecated IGNORED — containment was removed. Do not pass it. */
  fence?: boolean
}

/**
 * Resolve one existing entry for a link-aware mutation through the SHARED
 * resolution contract: session-relative targets join the cwd, `~` targets
 * expand against the home (#713), remote-mirror namespaces project, and
 * everything lands on one absolute, lexically-normalized path (plus the
 * resolved workspace root for the "never rename/remove the root" check).
 * No realpath, no containment: the path exists (lstat decides) and the
 * operation addresses it as written.
 */
function resolveEntry(
  cwd: string,
  target: string,
): { absolute: string; realCwd: string } {
  return { absolute: resolveTarget(cwd, target), realCwd: requireAbsolute(cwd) }
}

/**
 * Compare two spellings the way Windows itself does: the extended-length
 * prefix is not part of the name and case is free. Only reached when the
 * volume cannot answer with an inode (FAT/exFAT, some network shares) — weaker
 * than an identity, but never weaker than the plain string compare it
 * replaced.
 */
function sameSpelling(a: string, b: string): boolean {
  const strip = (value: string): string => value.replace(/^\\\\\?\\/, '')
  const left = strip(a)
  const right = strip(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * Whether `target` IS the workspace root. Comparing the two SPELLINGS is not
 * enough: the resolution above is deliberately lexical (a symlink row must
 * keep addressing the LINK, not its target), and one directory has many
 * spellings — a case variant, a `\\?\` prefix, an 8.3 short name, a mapped
 * drive. Each of them walked straight past this guard and turned "delete this
 * row" into a recursive delete of the whole project. `dev`+`ino` is the
 * identity the filesystem itself uses, and it does not care how the path is
 * spelled — read as `bigint`, because the file id is 64-bit and a JS number
 * rounds it above 2^53, at which point two unrelated entries compare equal and
 * a legitimate delete is refused as "the workspace root".
 *
 * `lstat` (not `stat`) is deliberate, and so is the removal below using the
 * same call: the question is whether THIS ENTRY is the root, so a symlink is
 * its own identity, never its target's. A link pointed at the root therefore
 * stays deletable — only the link goes, no recursion — which is what the
 * string compare did. The spellings above, the actual way a project was lost,
 * are all still refused. A target that cannot be lstat'ed (it may legitimately
 * be gone) falls back to the spelling.
 */
async function isWorkspaceRoot(target: string, root: string): Promise<boolean> {
  try {
    const [entry, base] = await Promise.all([
      lstat(target, { bigint: true }),
      lstat(root, { bigint: true }),
    ])
    // No inode = no identity: fall back to the spelling.
    if (entry.ino === 0n || base.ino === 0n) return sameSpelling(target, root)
    return entry.dev === base.dev && entry.ino === base.ino
  } catch {
    return sameSpelling(target, root)
  }
}

/** Whether a path exists (ENOENT → false; other failures propagate). */
async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Rename one tree row within its directory: `path` → `<parent>/<name>`.
 * The new name must be a single path segment (this is rename, not move);
 * an existing destination is refused (POSIX rename would clobber it
 * silently); the workspace root itself is never renamable; a symlink row
 * renames the link, not its target. A no-op rename (same name) succeeds
 * without touching the filesystem.
 *
 * @throws SidebarError with a wire code for shape, existence and root
 * failures.
 */
export async function renameWorkspaceEntry(input: WorkspaceRenameInput): Promise<{ path: string }> {
  const { cwd, path, name } = input
  assertSingleSegmentName(name)
  const { absolute, realCwd } = resolveEntry(cwd, path)
  if (await isWorkspaceRoot(absolute, realCwd)) {
    throw new SidebarError('fs-error', 'cannot rename the workspace root', 400)
  }
  if (basename(absolute) === name) return { path: absolute }
  const destination = join(dirname(absolute), name)
  const safeDestination = await ensureWorkspaceWritePath(cwd, destination)
  if (await pathExists(safeDestination)) {
    throw new SidebarError('fs-error', `"${name}" already exists`, 409)
  }
  try {
    await rename(absolute, safeDestination)
  } catch (error) {
    throw new SidebarError('fs-error', `cannot rename "${path}" to "${name}": ${error instanceof Error ? error.message : String(error)}`, 400)
  }
  invalidateDirectoryCache(dirname(safeDestination))
  return { path: safeDestination }
}

/** Inputs of one new directory row. */
export interface WorkspaceMkdirInput {
  /** The session workspace root (the base of session-relative targets). */
  cwd: string
  /** Absolute path of the PARENT row as the tree displays it (a directory). */
  path: string
  /** The new directory's base name (single segment — mkdir never nests). */
  name: string
  /** @deprecated IGNORED — containment was removed. Do not pass it. */
  fence?: boolean
}

/**
 * Create one directory inside an existing tree row: `<path>/<name>`.
 * The name must be a single path segment; an existing destination is refused
 * (mkdir would otherwise fail with EEXIST anyway, but the explicit check
 * yields the same "already exists" sentence rename uses); the parent row may
 * be any directory the host user can write.
 *
 * @throws SidebarError with a wire code for shape and existence failures.
 */
export async function mkdirWorkspaceEntry(input: WorkspaceMkdirInput): Promise<{ path: string }> {
  const { cwd, path, name } = input
  assertSingleSegmentName(name)
  const { absolute } = resolveEntry(cwd, path)
  const destination = await ensureWorkspaceWritePath(cwd, join(absolute, name))
  if (await pathExists(destination)) {
    throw new SidebarError('fs-error', `"${name}" already exists`, 409)
  }
  try {
    await mkdir(destination)
  } catch (error) {
    throw new SidebarError('fs-error', `cannot create "${name}": ${error instanceof Error ? error.message : String(error)}`, 400)
  }
  // The PARENT level gained a row; the new directory's own level is empty.
  invalidateDirectoryCache(absolute)
  return { path: destination }
}

/**
 * Characters Windows refuses in a file NAME (control characters — U+0000 to
 * U+001F — are refused beside these, see {@link firstIllegalNameChar}).
 * Checked on every platform: a tree row the plugin happily creates on macOS
 * must not become un-openable (or un-checkout-able) on the Windows host the
 * same workspace is later opened on.
 */
const ILLEGAL_FILE_NAME_CHARS = /[<>:"|?*]/

/**
 * The first character of one file name that Windows cannot store, or undefined
 * when the name is storable there. Iterating the string (not indexing it) keeps
 * astral characters whole, so a valid emoji name is never mistaken for two
 * illegal halves.
 */
function firstIllegalNameChar(name: string): string | undefined {
  for (const char of name) {
    if (ILLEGAL_FILE_NAME_CHARS.test(char) || (char.codePointAt(0) ?? 0) < 0x20) return char
  }
  return undefined
}

/**
 * Windows device names, reserved in EVERY directory with or without an
 * extension (`NUL.txt` and `NUL.tar.gz` both name the device, so the check is
 * on the segment before the FIRST dot).
 */
const RESERVED_FILE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
])

/**
 * The NEW FILE name rule: one path segment ({@link assertSingleSegmentName})
 * plus the two Windows-only refusals — illegal characters and reserved device
 * names. Refusing them HERE, as a shape error, is what lets the inline editor
 * say which rule was broken instead of surfacing a bare `EPERM` from the
 * filesystem on one platform and nothing at all on the others.
 *
 * @throws SidebarError with a wire code of `bad-request` for every refusal.
 */
function assertCreatableFileName(name: string): void {
  assertSingleSegmentName(name)
  const illegal = firstIllegalNameChar(name)
  if (illegal !== undefined) {
    throw new SidebarError('bad-request', `name contains a character that is not allowed in a file name: ${JSON.stringify(illegal)}`, 400)
  }
  if (RESERVED_FILE_NAMES.has(name.split('.')[0]!.toLowerCase())) {
    throw new SidebarError('bad-request', `"${name}" is a reserved device name on Windows`, 400)
  }
}

/** Inputs of one new file row. */
export interface WorkspaceCreateFileInput {
  /** The session workspace root (the base of session-relative targets). */
  cwd: string
  /** Absolute path of the PARENT row as the tree displays it (a directory). */
  path: string
  /** The new file's base name (single segment — creating never nests). */
  name: string
  /** @deprecated IGNORED — containment was removed. Do not pass it. */
  fence?: boolean
}

/**
 * Create one EMPTY file inside an existing tree row: `<path>/<name>`.
 * The name must be one path segment and must survive a Windows host
 * ({@link assertCreatableFileName}); an existing destination — file OR
 * directory — is refused with the same "already exists" sentence rename and
 * mkdir use, and is never truncated (the write itself is `wx`, so a name that
 * appears between the check and the write is refused too, never clobbered);
 * the parent row may be any directory the host user can write (an unwritable
 * one surfaces the filesystem's own refusal text).
 *
 * @throws SidebarError with a wire code for shape, existence and write
 * failures.
 */
export async function createWorkspaceFile(input: WorkspaceCreateFileInput): Promise<{ path: string }> {
  const { cwd, path, name } = input
  assertCreatableFileName(name)
  const { absolute } = await resolveEntry(cwd, path)
  const destination = await ensureWorkspaceWritePath(cwd, join(absolute, name))
  if (await pathExists(destination)) {
    throw new SidebarError('fs-error', `"${name}" already exists`, 409)
  }
  try {
    await writeFile(destination, '', { flag: 'wx', encoding: 'utf8' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new SidebarError('fs-error', `"${name}" already exists`, 409)
    }
    throw new SidebarError('fs-error', `cannot create "${name}": ${error instanceof Error ? error.message : String(error)}`, 400)
  }
  // The PARENT level gained a row; the new file is a leaf.
  invalidateDirectoryCache(absolute)
  return { path: destination }
}

/** Inputs of one tree-row delete. */
export interface WorkspaceRemoveInput {
  /** The session workspace root (the base of session-relative targets). */
  cwd: string
  /** Absolute path of the row as the tree displays it (may be a symlink). */
  path: string
  /** @deprecated IGNORED — containment was removed. Do not pass it. */
  fence?: boolean
}

/**
 * Delete one tree row permanently (there is no trash on the host): files are
 * unlinked, directories removed recursively, a symlink row unlinks the LINK
 * only (lstat decides, so a link to a directory does not recurse into its
 * target). The workspace root itself is never removable.
 *
 * @throws SidebarError with a wire code for existence and root failures.
 */
export async function removeWorkspaceEntry(input: WorkspaceRemoveInput): Promise<{ path: string }> {
  const { cwd, path } = input
  const { absolute, realCwd } = resolveEntry(cwd, path)
  if (await isWorkspaceRoot(absolute, realCwd)) {
    throw new SidebarError('fs-error', 'cannot remove the workspace root', 400)
  }
  try {
    const info = await lstat(absolute)
    if (info.isDirectory()) await rm(absolute, { recursive: true })
    else await unlink(absolute)
  } catch (error) {
    throw new SidebarError('fs-error', `cannot remove "${path}": ${error instanceof Error ? error.message : String(error)}`, 400)
  }
  invalidateDirectoryCache(dirname(absolute))
  return { path: absolute }
}
