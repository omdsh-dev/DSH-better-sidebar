import { randomUUID } from 'node:crypto'
import { mkdir, open, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { isWithin, messageOf, requireAbsolute } from './fs-tree.ts'
import { SidebarError } from './wire.ts'

/** A stable-enough optimistic-concurrency token for one path. */
export async function fileVersion(path: string): Promise<string | null> {
  try {
    const info = await stat(path, { bigint: true })
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw new SidebarError('fs-error', `cannot stat "${path}": ${messageOf(error)}`, 400)
  }
}

/** Resolve one destructive/write target and keep it inside the session workspace. */
export function workspacePath(cwd: string, raw: string, allowRoot = false): string {
  const root = requireAbsolute(cwd)
  const target = requireAbsolute(raw)
  if (!isWithin(root, target)) {
    throw new SidebarError('forbidden', `path is outside the session workspace: "${target}"`, 403)
  }
  if (!allowRoot && samePath(root, target)) {
    throw new SidebarError('forbidden', 'the session workspace root cannot be changed or deleted', 403)
  }
  return target
}

/**
 * Reject writes through a directory symlink that escapes the workspace. The
 * nearest existing ancestor is resolved so new nested paths are covered too;
 * the final entry itself is intentionally not resolved (renaming/deleting a
 * symlink removes the link, not its target).
 */
export async function assertWorkspaceParent(cwd: string, target: string): Promise<void> {
  const root = requireAbsolute(cwd)
  const rootReal = await realpath(root).catch((error: unknown) => {
    throw new SidebarError('fs-error', `cannot resolve workspace "${root}": ${messageOf(error)}`, 400)
  })
  let ancestor = dirname(target)
  for (;;) {
    try {
      const ancestorReal = await realpath(ancestor)
      if (!isWithin(rootReal, ancestorReal)) {
        throw new SidebarError('forbidden', `path resolves outside the session workspace: "${target}"`, 403)
      }
      return
    } catch (error) {
      if (error instanceof SidebarError) throw error
      if (errorCode(error) !== 'ENOENT') {
        throw new SidebarError('fs-error', `cannot resolve parent of "${target}": ${messageOf(error)}`, 400)
      }
      const parent = dirname(ancestor)
      if (samePath(parent, ancestor)) {
        throw new SidebarError('forbidden', `cannot resolve a workspace parent for "${target}"`, 403)
      }
      ancestor = parent
    }
  }
}

/** Create one empty file without overwriting an existing entry. */
export async function createWorkspaceFile(cwd: string, raw: string): Promise<{ path: string; version: string }> {
  const path = workspacePath(cwd, raw)
  await assertWorkspaceParent(cwd, path)
  await mkdir(dirname(path), { recursive: true })
  let handle
  try {
    handle = await open(path, 'wx')
  } catch (error) {
    throw fsMutationError('create', path, error)
  }
  await handle.close()
  return { path, version: (await fileVersion(path))! }
}

/** Create one directory without treating an existing directory as success. */
export async function createWorkspaceDirectory(cwd: string, raw: string): Promise<{ path: string }> {
  const path = workspacePath(cwd, raw)
  await assertWorkspaceParent(cwd, path)
  try {
    await mkdir(path)
  } catch (error) {
    throw fsMutationError('create directory', path, error)
  }
  return { path }
}

/** Move/rename one entry inside the workspace without overwriting a target. */
export async function moveWorkspaceEntry(cwd: string, rawFrom: string, rawTo: string): Promise<{ from: string; to: string }> {
  const from = workspacePath(cwd, rawFrom)
  const to = workspacePath(cwd, rawTo)
  if (samePath(from, to)) return { from, to }
  if (isWithin(from, to)) {
    throw new SidebarError('fs-error', 'a directory cannot be moved inside itself', 400)
  }
  await assertWorkspaceParent(cwd, from)
  await assertWorkspaceParent(cwd, to)
  if (await fileVersion(to) !== null) {
    throw new SidebarError('fs-exists', `destination already exists: "${to}"`, 409)
  }
  await mkdir(dirname(to), { recursive: true })
  try {
    await rename(from, to)
  } catch (error) {
    throw fsMutationError('move', from, error)
  }
  return { from, to }
}

/** Permanently remove one file, symlink, or directory tree. */
export async function deleteWorkspaceEntry(cwd: string, raw: string): Promise<{ path: string }> {
  const path = workspacePath(cwd, raw)
  await assertWorkspaceParent(cwd, path)
  try {
    await rm(path, { recursive: true, force: false })
  } catch (error) {
    throw fsMutationError('delete', path, error)
  }
  return { path }
}

/** Atomic UTF-8 save with an optimistic version guard. */
export async function writeWorkspaceText(options: {
  cwd: string
  path: string
  content: string
  expectedVersion?: string | null
  force?: boolean
}): Promise<{ ok: true; version: string }> {
  const path = workspacePath(options.cwd, options.path)
  await assertWorkspaceParent(options.cwd, path)
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.dsh-sidebar-tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(tmp, options.content, { encoding: 'utf8', flag: 'wx' })
    if (options.force !== true && options.expectedVersion !== undefined) {
      const actual = await fileVersion(path)
      if (actual !== options.expectedVersion) {
        throw new SidebarError('fs-conflict', `"${path}" changed on disk after it was opened`, 409)
      }
    }
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    if (error instanceof SidebarError) throw error
    throw fsMutationError('write', path, error)
  }
  return { ok: true, version: (await fileVersion(path))! }
}

/** Reserve an upload target, writing raw chunks with a hard byte limit. */
export async function writeWorkspaceUpload(options: {
  cwd: string
  path: string
  chunks: AsyncIterable<string | Uint8Array>
  limit: number
}): Promise<{ path: string; size: number }> {
  const path = workspacePath(options.cwd, options.path)
  await assertWorkspaceParent(options.cwd, path)
  await mkdir(dirname(path), { recursive: true })
  if (await fileVersion(path) !== null) {
    throw new SidebarError('fs-exists', `destination already exists: "${path}"`, 409)
  }
  const tmp = `${path}.dsh-sidebar-upload-${process.pid}-${randomUUID()}`
  let handle
  let size = 0
  try {
    handle = await open(tmp, 'wx')
    for await (const chunk of options.chunks) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
      size += bytes.length
      if (size > options.limit) {
        throw new SidebarError('bad-request', `upload exceeds the ${options.limit}-byte limit`, 413)
      }
      await handle.write(bytes)
    }
    await handle.close()
    handle = undefined
    if (await fileVersion(path) !== null) {
      throw new SidebarError('fs-exists', `destination already exists: "${path}"`, 409)
    }
    await rename(tmp, path)
  } catch (error) {
    await handle?.close().catch(() => {})
    await rm(tmp, { force: true }).catch(() => {})
    if (error instanceof SidebarError) throw error
    throw fsMutationError('upload', path, error)
  }
  return { path, size }
}

function fsMutationError(action: string, path: string, error: unknown): SidebarError {
  const code = errorCode(error)
  if (code === 'EEXIST' || code === 'ENOTEMPTY') {
    return new SidebarError('fs-exists', `cannot ${action} "${path}": an entry already exists`, 409)
  }
  if (code === 'ENOENT') {
    return new SidebarError('not-found', `cannot ${action} "${path}": the entry does not exist`, 404)
  }
  return new SidebarError('fs-error', `cannot ${action} "${path}": ${messageOf(error)}`, 400)
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)
}
