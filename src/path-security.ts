/** Filesystem path guards shared by sidebar APIs that access a session workspace. */
import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { isWithin, requireAbsolute } from './fs-tree.ts'
import { resolveSessionPath } from './session-path.ts'
import { SidebarError } from './wire.ts'

/** Resolve a path and convert filesystem resolution failures to an API error. */
async function resolveRealPath(path: string, label: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    throw new SidebarError('fs-error', `cannot resolve ${label} "${path}": ${error instanceof Error ? error.message : String(error)}`, 400)
  }
}

/** Reject a resolved path whose real filesystem target escapes the workspace. */
function assertWithinWorkspace(workspace: string, target: string): void {
  if (!isWithin(workspace, target)) {
    throw new SidebarError('forbidden', `path "${target}" is outside workspace`, 403)
  }
}

/**
 * Resolve a client-supplied route target inside the session namespace: an
 * absolute target passes through (including the outside-workspace spelling,
 * which the fence judges afterwards), while a workspace-relative one joins
 * the session cwd.
 *
 * The media route needs this because a native file address
 * (`dsh-resource://file/session/<sid>/<path>`) spells a file inside the
 * session workspace RELATIVE to that workspace's root, so since the native
 * right-Sidebar migration the image / PDF / download viewers hand the route a
 * workspace-relative path. The JSON APIs have always read their `path` field
 * this way (`fs.read` → `resolveGitPath`), which is why only the media channel
 * broke; joining here also covers a client that has not resolved a cwd yet and
 * third-party viewers built on `ctx.betterSidebar`'s media URL.
 *
 * @param cwd - The session's authoritative working directory.
 * @param target - The client-supplied path (workspace-relative or absolute).
 * @returns An absolute path for `requireAbsolute` / `ensureWorkspacePath`.
 */
export function resolveWorkspaceTarget(cwd: string, target: string): string {
  return isAbsolute(target) ? target : join(cwd, target)
}

/**
 * Resolve an existing workspace path through symlinks and (unless disarmed)
 * enforce containment.
 *
 * @param cwd - Session workspace directory.
 * @param target - Client-supplied absolute path in the session's namespace.
 * @param fence - Whether containment is enforced (the settings-page
 * `workspaceFence` switch). Even when false the paths are still resolved
 * through symlinks so callers always receive the canonical target.
 * @returns The canonical absolute path used for the filesystem operation.
 */
export async function ensureWorkspacePath(cwd: string, target: string, fence = true): Promise<string> {
  const absolute = requireAbsolute(resolveSessionPath(cwd, target))
  const [realCwd, realTarget] = await Promise.all([
    resolveRealPath(cwd, 'workspace'),
    resolveRealPath(absolute, 'target'),
  ])
  if (fence) assertWithinWorkspace(realCwd, realTarget)
  return realTarget
}

/**
 * Validate a write destination, including destinations that do not exist yet.
 * Existing targets are resolved to catch symlinks; missing targets are checked
 * against the nearest existing ancestor before the caller creates or renames.
 * The returned path is rebuilt from that canonical ancestor, so an existing
 * symlink is never left in the path passed to the write operation.
 *
 * @param cwd - Session workspace directory.
 * @param target - Client-supplied absolute destination path in the session's namespace.
 * @param fence - Whether containment is enforced (the settings-page
 * `workspaceFence` switch). Resolution/canonicalization is identical either way.
 * @returns A canonical path for an existing target or its nearest existing ancestor.
 */
export async function ensureWorkspaceWritePath(cwd: string, target: string, fence = true): Promise<string> {
  const absolute = requireAbsolute(resolveSessionPath(cwd, target))
  const realCwd = await resolveRealPath(cwd, 'workspace')
  let existingPath = absolute
  const missingSegments: string[] = []

  for (;;) {
    try {
      const realTarget = await realpath(existingPath)
      if (fence) assertWithinWorkspace(realCwd, realTarget)
      return missingSegments.reduce((path, segment) => join(path, segment), realTarget)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (error instanceof SidebarError) throw error
        throw new SidebarError('fs-error', `cannot resolve target "${existingPath}": ${error instanceof Error ? error.message : String(error)}`, 400)
      }
      const parent = dirname(existingPath)
      if (parent === existingPath) {
        throw new SidebarError('fs-error', `cannot resolve target "${absolute}"`, 400)
      }
      missingSegments.unshift(basename(existingPath))
      existingPath = parent
    }
  }
}
