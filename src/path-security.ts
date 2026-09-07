/** Filesystem path guards shared by sidebar APIs that access a session workspace. */
import { randomBytes } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
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

/** A client-visible decision for one explicitly clicked Markdown path. */
export type MarkdownPreviewGrant =
  | { outside: false }
  | { outside: true; grant: string }

/** One server-memory read capability. It is exact-path and session bound. */
interface MarkdownPreviewCapability {
  sessionId: string
  path: string
}

/** Maximum live external-preview capabilities (oldest entries are evicted). */
const MARKDOWN_PREVIEW_GRANT_LIMIT = 128

/** Only Markdown documents get the out-of-workspace preview escape hatch. */
function isMarkdownPath(path: string): boolean {
  const extension = extname(path).toLowerCase()
  return extension === '.md' || extension === '.markdown'
}

/** Resolve one existing path without granting it any workspace authority. */
async function resolveExternalPreviewPath(target: string): Promise<string> {
  const absolute = requireAbsolute(target)
  return resolveRealPath(absolute, 'preview target')
}

/**
 * Host-lifetime, unguessable read capabilities for Markdown documents that
 * the user explicitly clicks in chat. The normal workspace fence remains the
 * default for every route and every write: `issue` only grants one canonical
 * document to one session, and `authorize` re-resolves the path so a replaced
 * symlink cannot reuse an old grant.
 */
export class MarkdownPreviewGrants {
  private readonly grants = new Map<string, MarkdownPreviewCapability>()

  /** Decide whether a clicked document needs a grant, and mint one if so. */
  async issue(sessionId: string, cwd: string, target: string): Promise<MarkdownPreviewGrant> {
    const [workspace, path] = await Promise.all([
      resolveRealPath(cwd, 'workspace'),
      resolveExternalPreviewPath(target),
    ])
    if (isWithin(workspace, path)) return { outside: false }
    if (!isMarkdownPath(path)) {
      throw new SidebarError('bad-request', 'external preview only accepts Markdown files', 400)
    }
    let info
    try {
      info = await stat(path)
    } catch (error) {
      throw new SidebarError('fs-error', `cannot inspect preview target "${path}": ${error instanceof Error ? error.message : String(error)}`, 400)
    }
    if (!info.isFile()) throw new SidebarError('bad-request', 'external Markdown preview target is not a file', 400)

    const grant = randomBytes(24).toString('base64url')
    this.grants.set(grant, { sessionId, path })
    while (this.grants.size > MARKDOWN_PREVIEW_GRANT_LIMIT) {
      const oldest = this.grants.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.grants.delete(oldest)
    }
    return { outside: true, grant }
  }

  /** Validate an exact path/session/token tuple and return its canonical path. */
  async authorize(grant: string, sessionId: string, target: string): Promise<string> {
    const capability = this.grants.get(grant)
    if (capability === undefined || capability.sessionId !== sessionId) {
      throw new SidebarError('forbidden', 'invalid external Markdown preview grant', 403)
    }
    const path = await resolveExternalPreviewPath(target)
    if (path !== capability.path) {
      throw new SidebarError('forbidden', 'external Markdown preview grant does not match this path', 403)
    }
    this.grants.delete(grant)
    this.grants.set(grant, capability)
    return path
  }

  /** Drop all capabilities when the host plugin is disposed. */
  dispose(): void {
    this.grants.clear()
  }
}
