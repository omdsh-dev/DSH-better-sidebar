/**
 * Workspace-safe file mutations for the sidebar (create, upload and delete).
 *
 * Every mutation is confined to the real session workspace. Create and
 * recursive-delete operations resolve their selected targets so a symlinked
 * parent cannot redirect them outside it. Upload paths are sanitized and
 * checked through existing ancestors before bytes stream to a unique temp
 * sibling, so failed, aborted, or oversized requests leave no partial file.
 */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { lstat, mkdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
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

/** Kind of one empty entry created directly below an explorer directory. */
export type WorkspaceEntryKind = 'file' | 'directory'

/** Inputs for one non-overwriting explorer create operation. */
export interface WorkspaceCreateInput {
  /** Session workspace root. */
  cwd: string
  /** Existing parent directory selected in the explorer. */
  dir: string
  /** One child name; separators and traversal segments are refused. */
  name: string
  /** Empty file or empty directory. */
  kind: WorkspaceEntryKind
}

/**
 * Create one empty file or directory immediately below `dir`. The selected
 * directory must resolve inside the real workspace, so a symlinked parent
 * cannot redirect the mutation outside it. Existing entries are never
 * overwritten.
 *
 * @param input - Workspace scope, selected parent, child name, and kind.
 * @returns The absolute lexical path and created kind.
 * @throws SidebarError for invalid names, containment failures, non-directory
 * parents, existing entries, and filesystem failures.
 */
export async function createWorkspaceEntry(input: WorkspaceCreateInput): Promise<{ path: string; kind: WorkspaceEntryKind }> {
  const root = requireAbsolute(input.cwd)
  const dir = requireAbsolute(input.dir)
  const name = input.name.trim()
  if (name === '' || name === '.' || name === '..' || /[\\/]/.test(name)) {
    throw new SidebarError('bad-request', 'entry name must be one child name', 400)
  }
  if (!isWithin(root, dir)) {
    throw new SidebarError('forbidden', 'create directory escapes the session workspace', 403)
  }
  const target = join(dir, name)
  if (!isWithin(root, target) || !isWithin(dir, target)) {
    throw new SidebarError('forbidden', 'create target escapes the session workspace', 403)
  }
  try {
    const [realRoot, realDir, parentInfo] = await Promise.all([realpath(root), realpath(dir), stat(dir)])
    if (!parentInfo.isDirectory()) {
      throw new SidebarError('bad-request', 'create parent is not a directory', 400)
    }
    if (!isWithin(realRoot, realDir)) {
      throw new SidebarError('forbidden', 'create directory resolves outside the session workspace', 403)
    }
    if (input.kind === 'directory') await mkdir(target)
    else await writeFile(target, '', { encoding: 'utf8', flag: 'wx' })
    return { path: target, kind: input.kind }
  } catch (error) {
    if (error instanceof SidebarError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      throw new SidebarError('fs-error', `"${name}" already exists`, 409)
    }
    throw new SidebarError(
      'fs-error',
      `cannot create "${target}": ${error instanceof Error ? error.message : String(error)}`,
      400,
    )
  }
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
 * Permanently delete one entry below the session workspace. Regular
 * directories are removed recursively; symlinks are removed as links rather
 * than following their targets. Resolving the real target before recursive
 * deletion prevents a symlinked parent from escaping the workspace.
 *
 * @param cwd - Session workspace root.
 * @param path - Absolute entry path selected in the explorer.
 * @returns The normalized path that was removed.
 * @throws SidebarError when the target escapes the workspace, is missing,
 * or cannot be removed.
 */
export async function deleteWorkspaceEntry(cwd: string, path: string): Promise<{ path: string }> {
  const root = requireAbsolute(cwd)
  const target = requireAbsolute(path)
  if (target === root || !isWithin(root, target)) {
    throw new SidebarError('forbidden', 'delete target escapes the session workspace', 403)
  }
  try {
    const [realRoot, info] = await Promise.all([realpath(root), lstat(target)])
    if (!info.isSymbolicLink()) {
      const realTarget = await realpath(target)
      if (!isWithin(realRoot, realTarget)) {
        throw new SidebarError('forbidden', 'delete target resolves outside the session workspace', 403)
      }
    }
    await rm(target, { recursive: info.isDirectory() })
    return { path: target }
  } catch (error) {
    if (error instanceof SidebarError) throw error
    throw new SidebarError(
      'fs-error',
      `cannot delete "${target}": ${error instanceof Error ? error.message : String(error)}`,
      400,
    )
  }
}
