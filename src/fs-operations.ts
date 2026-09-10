/**
 * Workspace-safe file mutations for the sidebar (the upload route today).
 *
 * Every write is confined to the real session workspace: the upload
 * directory is resolved absolute and its target is checked through existing
 * filesystem ancestors, the relative path is sanitized (absolute paths, '.',
 * '..' and empty segments are refused), and the final target must stay inside
 * the workspace after symlink resolution. Bytes stream from the request body
 * to a uniquely named temp sibling
 * and are renamed into place, so a failed, aborted, or oversized upload never
 * leaves a partial file at the target path.
 *
 * The tree's rename/delete (below) are link-aware: existence and containment
 * are verified against the fully resolved target (a symlink pointing outside
 * the workspace is refused while the fence is armed), but the operation
 * itself addresses the lexical row path — renaming or deleting a symlink
 * row renames/unlinks the LINK, never its target, matching what the tree
 * row visually names (VS Code semantics).
 */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { access, lstat, mkdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isWithin, requireAbsolute } from './fs-tree.ts'
import { ensureWorkspacePath, ensureWorkspaceWritePath } from './path-security.ts'
import { resolveSessionPath } from './session-path.ts'
import { SidebarError } from './wire.ts'

/** Inputs of one upload: the session scope plus the request body stream. */
export interface WorkspaceUploadInput {
  /** The session workspace root; target and directory must stay inside it. */
  cwd: string
  /** Absolute upload directory chosen by the client (inside `cwd`). */
  dir: string
  /** Relative path below `dir` (absolute paths, '.', '..' and empty segments refused). */
  relativePath: string
  /** The request body stream (raw bytes). */
  chunks: AsyncIterable<string | Uint8Array>
  /** Byte cap; an oversized upload is refused without touching the target. */
  limit: number
  /** Whether workspace containment is enforced (the `workspaceFence` setting; on by default). */
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
 * @throws SidebarError with a wire code for containment, shape, and size
 * failures; the temp file is always removed on failure.
 */
export async function writeWorkspaceUpload(input: WorkspaceUploadInput): Promise<{ path: string; size: number }> {
  const { cwd, dir, relativePath, chunks, limit, fence = true } = input
  const base = requireAbsolute(dir)
  await ensureWorkspacePath(cwd, base, fence)
  if (relativePath === '' || relativePath.startsWith('/') || relativePath.startsWith('\\')) {
    throw new SidebarError('bad-request', 'relativePath must stay below the upload directory', 400)
  }
  const segments = relativePath.split(/[\\/]/)
  if (segments.some(part => part === '' || part === '.' || part === '..')) {
    throw new SidebarError('bad-request', 'relativePath must stay below the upload directory', 400)
  }
  const target = join(base, ...segments)
  const safeTarget = await ensureWorkspaceWritePath(cwd, target, fence)
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
  /** The session workspace root; the renamed entry must stay inside it. */
  cwd: string
  /** Absolute path of the row as the tree displays it (may be a symlink). */
  path: string
  /** The new base name (single segment — rename never moves across directories). */
  name: string
  /** Whether workspace containment is enforced (the `workspaceFence` setting; on by default). */
  fence?: boolean
}

/** Resolve one existing entry for a link-aware mutation: the lexical row path
 * plus its fully resolved real target (fence-checked). ENOENT becomes an
 * fs-error, mirroring path-security's resolveRealPath semantics. */
async function resolveEntry(
  cwd: string,
  target: string,
  fence: boolean,
): Promise<{ absolute: string; real: string; realCwd: string }> {
  const absolute = requireAbsolute(resolveSessionPath(cwd, target))
  let real: string
  let realCwd: string
  try {
    ;[realCwd, real] = await Promise.all([realpath(cwd), realpath(absolute)])
  } catch (error) {
    throw new SidebarError('fs-error', `cannot resolve "${target}": ${error instanceof Error ? error.message : String(error)}`, 400)
  }
  if (fence && !isWithin(realCwd, real)) {
    throw new SidebarError('forbidden', `path "${target}" is outside workspace`, 403)
  }
  return { absolute, real, realCwd }
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
 * @throws SidebarError with a wire code for shape, containment, existence
 * and root failures.
 */
export async function renameWorkspaceEntry(input: WorkspaceRenameInput): Promise<{ path: string }> {
  const { cwd, path, name, fence = true } = input
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new SidebarError('bad-request', 'name must be a single path segment', 400)
  }
  const { absolute, real, realCwd } = await resolveEntry(cwd, path, fence)
  if (real === realCwd) {
    throw new SidebarError('fs-error', 'cannot rename the workspace root', 400)
  }
  if (basename(absolute) === name) return { path: absolute }
  const destination = join(dirname(absolute), name)
  const safeDestination = await ensureWorkspaceWritePath(cwd, destination, fence)
  if (await pathExists(safeDestination)) {
    throw new SidebarError('fs-error', `"${name}" already exists`, 409)
  }
  try {
    await rename(absolute, safeDestination)
  } catch (error) {
    throw new SidebarError('fs-error', `cannot rename "${path}" to "${name}": ${error instanceof Error ? error.message : String(error)}`, 400)
  }
  return { path: safeDestination }
}

/** Inputs of one tree-row delete. */
export interface WorkspaceRemoveInput {
  /** The session workspace root; the removed entry must stay inside it. */
  cwd: string
  /** Absolute path of the row as the tree displays it (may be a symlink). */
  path: string
  /** Whether workspace containment is enforced (the `workspaceFence` setting; on by default). */
  fence?: boolean
}

/**
 * Delete one tree row permanently (there is no trash on the host): files are
 * unlinked, directories removed recursively, a symlink row unlinks the LINK
 * only (lstat decides, so a link to a directory does not recurse into its
 * target). The workspace root itself is never removable.
 *
 * @throws SidebarError with a wire code for containment, existence and
 * root failures.
 */
export async function removeWorkspaceEntry(input: WorkspaceRemoveInput): Promise<{ path: string }> {
  const { cwd, path, fence = true } = input
  const { absolute, real, realCwd } = await resolveEntry(cwd, path, fence)
  if (real === realCwd) {
    throw new SidebarError('fs-error', 'cannot remove the workspace root', 400)
  }
  try {
    const info = await lstat(absolute)
    if (info.isDirectory()) await rm(absolute, { recursive: true })
    else await unlink(absolute)
  } catch (error) {
    throw new SidebarError('fs-error', `cannot remove "${path}": ${error instanceof Error ? error.message : String(error)}`, 400)
  }
  return { path: absolute }
}
