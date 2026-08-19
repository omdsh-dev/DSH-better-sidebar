/**
 * Workspace-safe file mutations for the sidebar (the upload route today).
 *
 * Every write is confined to the session workspace: the upload directory is
 * resolved absolute and must sit inside the session cwd, the relative path is
 * sanitized (no '.', '..', empty or absolute segments), and the final target
 * must stay inside both. Bytes stream from the request body to a temp sibling
 * and are renamed into place, so a failed, aborted, or oversized upload never
 * leaves a partial file at the target path.
 */
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SidebarHttpRequest } from './context-types.ts'
import { isWithin, requireAbsolute } from './fs-tree.ts'
import { SidebarError } from './wire.ts'

/** Inputs of one upload: the session scope plus the request body stream. */
export interface WorkspaceUploadInput {
  /** The session workspace root; target and directory must stay inside it. */
  cwd: string
  /** Absolute upload directory chosen by the client (inside `cwd`). */
  dir: string
  /** Sanitized relative path ('.', '..', empty and absolute segments refused). */
  relativePath: string
  /** The request body stream (raw bytes). */
  chunks: AsyncIterable<string | Uint8Array>
  /** Byte cap; an oversized upload is refused without touching the target. */
  limit: number
}

/**
 * Stream `chunks` into `dir/relativePath` atomically: a temp sibling receives
 * the bytes, then is renamed over the target. The parent directory is created
 * on demand (recursive), so folder uploads work before any level exists.
 *
 * @throws SidebarError with a wire code for containment, shape, and size
 * failures; the temp file is always removed on failure.
 */
export async function writeWorkspaceUpload(input: WorkspaceUploadInput): Promise<{ path: string; size: number }> {
  const { cwd, dir, relativePath, chunks, limit } = input
  const base = requireAbsolute(dir)
  if (!isWithin(cwd, base)) {
    throw new SidebarError('forbidden', 'upload directory escapes the session workspace', 403)
  }
  const segments = relativePath.split(/[\\/]+/).filter(Boolean)
  if (segments.length === 0 || segments.some(part => part === '.' || part === '..')) {
    throw new SidebarError('bad-request', 'relativePath must stay below the upload directory', 400)
  }
  const target = join(base, ...segments)
  if (!isWithin(cwd, target) || !isWithin(base, target)) {
    throw new SidebarError('forbidden', 'target escapes the session workspace', 403)
  }
  const tmp = `${target}.dsh-sidebar-upload-tmp-${process.pid}`
  await mkdir(dirname(target), { recursive: true })
  let size = 0
  try {
    const stream = createWriteStream(tmp, { flags: 'wx' })
    try {
      for await (const chunk of chunks) {
        const buffer = Buffer.from(chunk)
        size += buffer.length
        if (size > limit) throw new SidebarError('too-large', `upload exceeds the ${limit} byte limit`, 413)
        if (!stream.write(buffer)) await once(stream, 'drain')
      }
      await new Promise<void>((resolve, reject) => {
        stream.end((error?: Error | null) => (error === undefined || error === null ? resolve() : reject(error)))
      })
    } finally {
      stream.destroy()
    }
    await rename(tmp, target)
    const info = await stat(target)
    return { path: target, size: info.size }
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}
