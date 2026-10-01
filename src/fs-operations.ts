/**
 * File mutations for the sidebar (the upload route and the tree's renames,
 * deletes and mkdirs).
 *
 * Workspace containment is enforced for reads, writes and uploads. Every path
 * is resolved against the session workspace and checked through symlinks before
 * the operation runs. The workspace root itself is never renamable or removable.
 * Bytes stream from the request body to a uniquely named temp sibling and are
 * renamed into place, so a failed, aborted, or oversized upload never leaves a
 * partial file at the target path.
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
import { access, lstat, mkdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { invalidateDirectoryCache, isWithin, requireAbsolute } from './fs-tree.ts'
import { ensureWorkspacePath, ensureWorkspaceWritePath } from './path-security.ts'
import { resolveSessionPath } from './session-path.ts'
import { SidebarError } from './wire.ts'

/** Inputs of one upload: the session scope plus the request body stream. */
export interface WorkspaceUploadInput {
  /** The session workspace root (the base of session-relative targets). */
  cwd: string
  /** Absolute upload directory chosen by the client. */
  dir: string
  /** Relative path below `dir` (absolute paths, '.', '..' and empty segments refused). */
  relativePath: string
  /** The request body stream (raw bytes). */
  chunks: AsyncIterable<string | Uint8Array>
  /** Byte cap; an oversized upload is refused without touching the target. */
  limit: number
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
  const base = requireAbsolute(dir)
  await ensureWorkspacePath(cwd, base)
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
  /** Absolute path of the row as the tree displays it (may be a symlink). */
  path: string
  /** The new base name (single segment — rename never moves across directories). */
  name: string
}

/**
 * Resolve one existing entry for a link-aware mutation: the lexical row path
 * plus the resolved workspace root (for the "never rename/remove the root"
 * check). No realpath, no containment: the path exists (lstat decides) and the
 * operation addresses it as written.
 */
async function resolveEntry(
  cwd: string,
  target: string,
): Promise<{ absolute: string }> {
  const absolute = requireAbsolute(resolveSessionPath(cwd, target))
  const workspace = requireAbsolute(cwd)
  if (!isWithin(workspace, absolute)) throw new SidebarError('forbidden', `path "${absolute}" is outside workspace`, 403)
  await ensureWorkspacePath(cwd, workspace)
  if (absolute !== workspace) await ensureWorkspacePath(cwd, dirname(absolute))
  return { absolute }
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
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new SidebarError('bad-request', 'name must be a single path segment', 400)
  }
  const { absolute } = await resolveEntry(cwd, path)
  if (absolute === requireAbsolute(cwd)) {
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
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new SidebarError('bad-request', 'name must be a single path segment', 400)
  }
  const { absolute } = await resolveEntry(cwd, path)
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

/** Inputs of one tree-row delete. */
export interface WorkspaceRemoveInput {
  /** The session workspace root (the base of session-relative targets). */
  cwd: string
  /** Absolute path of the row as the tree displays it (may be a symlink). */
  path: string
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
  const { absolute } = await resolveEntry(cwd, path)
  if (absolute === requireAbsolute(cwd)) {
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
