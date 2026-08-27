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

/**
 * Whether a canonical target lies within the workspace or any extra root.
 * Each extra root is resolved via realpath at call time; unresolvable roots
 * are skipped without error.
 * @param realTarget - Canonical target path (already realpath-resolved).
 * @param realCwd - Canonical workspace path.
 * @param extraRoots - Configured extra roots (absolute paths, may be unresolvable).
 * @returns Whether the target is allowed.
 */
async function isAllowedRealTarget(realTarget: string, realCwd: string, extraRoots: string[]): Promise<boolean> {
  if (isWithin(realCwd, realTarget)) return true
  for (const root of extraRoots) {
    try {
      const realRoot = await realpath(root)
      if (isWithin(realRoot, realTarget)) return true
    } catch {
      // Unresolvable extra root (missing or unreadable) is skipped — only
      // when no root contains the target is the request forbidden.
      continue
    }
  }
  return false
}

/**
 * Resolve an existing workspace path through symlinks and enforce containment.
 *
 * @param cwd - Session workspace directory.
 * @param target - Client-supplied absolute path.
 * @param extraRoots - Additional allowed roots (absolute paths, resolved via realpath per call).
 * @returns The canonical absolute path used for the filesystem operation.
 */
export async function ensureWorkspacePath(cwd: string, target: string, extraRoots: string[] = []): Promise<string> {
  const absolute = requireAbsolute(target)
  const [realCwd, realTarget] = await Promise.all([
    resolveRealPath(cwd, 'workspace'),
    resolveRealPath(absolute, 'target'),
  ])
  if (await isAllowedRealTarget(realTarget, realCwd, extraRoots)) return realTarget
  throw new SidebarError('forbidden', `path "${realTarget}" is outside workspace`, 403)
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
 * @param extraRoots - Additional allowed roots (absolute paths, resolved via realpath per call).
 * @returns A canonical path for an existing target or its nearest existing ancestor.
 */
export async function ensureWorkspaceWritePath(cwd: string, target: string, extraRoots: string[] = []): Promise<string> {
  const absolute = requireAbsolute(target)
  const realCwd = await resolveRealPath(cwd, 'workspace')
  // Resolve extra roots once per call; unresolvable roots are skipped.
  const realExtraRoots: string[] = []
  for (const root of extraRoots) {
    try {
      realExtraRoots.push(await realpath(root))
    } catch {
      continue
    }
  }
  const isAllowed = (candidate: string): boolean =>
    isWithin(realCwd, candidate) || realExtraRoots.some(root => isWithin(root, candidate))

  let existingPath = absolute
  const missingSegments: string[] = []

  for (;;) {
    try {
      const realTarget = await realpath(existingPath)
      if (!isAllowed(realTarget)) {
        throw new SidebarError('forbidden', `path "${realTarget}" is outside workspace`, 403)
      }
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
