/** Filesystem path guards shared by sidebar APIs that access a session workspace. */
import { realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isWithin, requireAbsolute } from './fs-tree.ts'
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

/** Options for the read-side workspace fence. */
export interface EnsureWorkspacePathOptions {
  /**
   * Whether the caller may resolve an EXISTING path outside the workspace.
   * Only read routes set this from the user's explicit `allowOutsideFiles`
   * pref; write/upload callers never pass it.
   */
  allowOutside?: boolean
}

/**
 * Resolve an existing workspace path through symlinks and enforce containment.
 *
 * @param cwd - Session workspace directory.
 * @param target - Client-supplied absolute path.
 * @param options - {@link EnsureWorkspacePathOptions}.
 * @returns The canonical absolute path used for the filesystem operation.
 */
export async function ensureWorkspacePath(cwd: string, target: string, options: EnsureWorkspacePathOptions = {}): Promise<string> {
  const absolute = requireAbsolute(target)
  const [realCwd, realTarget] = await Promise.all([
    resolveRealPath(cwd, 'workspace'),
    resolveRealPath(absolute, 'target'),
  ])
  // The read-side opt-in still resolves both sides through realpath (symlink
  // targets are never hidden); it only widens the containment decision.
  if (!options.allowOutside) assertWithinWorkspace(realCwd, realTarget)
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
 * @param target - Client-supplied absolute destination path.
 * @returns A canonical path for an existing target or its nearest existing ancestor.
 */
export async function ensureWorkspaceWritePath(cwd: string, target: string): Promise<string> {
  const absolute = requireAbsolute(target)
  const realCwd = await resolveRealPath(cwd, 'workspace')
  let existingPath = absolute
  const missingSegments: string[] = []

  for (;;) {
    try {
      const realTarget = await realpath(existingPath)
      assertWithinWorkspace(realCwd, realTarget)
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
