/**
 * Workspace-safe file mutations for the sidebar (upload and file deletion).
 *
 * Every write is confined to the real session workspace: the upload
 * directory is resolved absolute and its target is checked through existing
 * filesystem ancestors, the relative path is sanitized (absolute paths, '.',
 * '..' and empty segments are refused), and the final target must stay inside
 * the workspace after symlink resolution. Bytes stream from the request body
 * to a uniquely named temp sibling
 * and are renamed into place, so a failed, aborted, or oversized upload never
 * leaves a partial file at the target path.
 */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { lstat, mkdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { SidebarHttpRequest } from './context-types.ts'
import { isWithin, requireAbsolute } from './fs-tree.ts'
import { ensureWorkspacePath, ensureWorkspaceWritePath } from './path-security.ts'
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

/**
 * Permanently delete one file below the session workspace. Directories are
 * refused: the explorer intentionally has no recursive-delete operation.
 * Symlinks are removed as links rather than following their targets.
 *
 * @param cwd - Session workspace root.
 * @param path - Absolute file path selected in the explorer.
 * @returns The normalized path that was removed.
 * @throws SidebarError when the target escapes the workspace, is a
 * directory, is missing, or cannot be removed.
 */
export async function deleteWorkspaceFile(cwd: string, path: string): Promise<{ path: string }> {
  const root = requireAbsolute(cwd)
  const target = requireAbsolute(path)
  if (target === root || !isWithin(root, target)) {
    throw new SidebarError('forbidden', 'delete target escapes the session workspace', 403)
  }
  let info
  try {
    info = await lstat(target)
  } catch (error) {
    throw new SidebarError(
      'fs-error',
      `cannot delete "${target}": ${error instanceof Error ? error.message : String(error)}`,
      400,
    )
  }
  if (info.isDirectory()) {
    throw new SidebarError('bad-request', 'directory deletion is not supported', 400)
  }
  try {
    await rm(target)
  } catch (error) {
    throw new SidebarError(
      'fs-error',
      `cannot delete "${target}": ${error instanceof Error ? error.message : String(error)}`,
      400,
    )
  }
  return { path: target }
}
