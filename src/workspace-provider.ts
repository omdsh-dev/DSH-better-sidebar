import { mkdir, open, opendir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, dirname, join, relative, sep } from 'node:path'
import { compareEntries, requireAbsolute, type SidebarFsListing } from './fs-tree.ts'
import { ensureWorkspacePath, ensureWorkspaceWritePath } from './path-security.ts'
import { resolveSessionPath } from './session-path.ts'
import * as git from './git.ts'
import { SidebarError } from './wire.ts'

/** Version of the public host workspace-provider contract. */
export const BETTER_SIDEBAR_WORKSPACE_VERSION = 1 as const

export interface BetterSidebarWorkspaceScope {
  cwd: string
  fence: boolean
}

export type BetterSidebarTerminalEvent =
  | { type: 'data'; data: string }
  | { type: 'exit'; exitCode: number | null }
  | { type: 'error'; message: string }

export interface BetterSidebarTerminalHandle {
  snapshot(): { text: string; truncated: boolean; exited: boolean; exitCode: number | null; error?: string }
  subscribe(listener: (event: BetterSidebarTerminalEvent) => void): () => void
  write(data: string): Promise<void>
  resize(cols: number, rows: number): Promise<void>
  close(): Promise<void>
}

export interface BetterSidebarTerminalRequest {
  sessionId: string
  tabId: string
  cols: number
  rows: number
  signal: AbortSignal
}

export interface BetterSidebarWorkspaceReadResult {
  content: string
  truncated: boolean
  binary: boolean
  size: number
  head?: string
}

export interface BetterSidebarWorkspaceBytesResult {
  bytes: Uint8Array
  path: string
  size: number
}

export interface BetterSidebarWorkspaceSearchResult {
  matches: string[]
  truncated: boolean
}

/** Existing bounded Git operation vocabulary exposed to workspace providers. */
export type BetterSidebarGitRequest =
  | { operation: 'worktrees'; cwd: string; worktree?: string; repoRoot?: string }
  | { operation: 'status'; cwd: string; worktree?: string; repoRoot?: string }
  | { operation: 'diff'; cwd: string; worktree?: string; path?: string; staged: boolean; repoRoot?: string }
  | { operation: 'stage' | 'unstage'; cwd: string; worktree?: string; path?: string; repoRoot?: string }
  | { operation: 'commit'; cwd: string; worktree?: string; message: string; repoRoot?: string }
  | { operation: 'branch'; cwd: string; worktree?: string; repoRoot?: string }
  | { operation: 'checkout'; cwd: string; worktree?: string; branch: string; repoRoot?: string }
  | { operation: 'log'; cwd: string; worktree?: string; count?: number; skip?: number; repoRoot?: string }
  | { operation: 'commit-diff'; cwd: string; worktree?: string; hash: string; repoRoot?: string }
  | { operation: 'discard'; cwd: string; worktree?: string; path: string; repoRoot?: string }
  | { operation: 'revert' | 'cherry-pick'; cwd: string; worktree?: string; hash: string; repoRoot?: string }
  | { operation: 'show'; cwd: string; worktree?: string; rev: string; path: string; repoRoot?: string }

/** Transport-neutral workspace operations owned by Better Sidebar. */
export interface BetterSidebarWorkspaceProvider {
  /** Stable registration identity. A new registration with the same id replaces the old one. */
  id: string
  /** Higher values claim first. Defaults to zero. */
  priority?: number
  /** Preserve previously claimed workspaces as unavailable after unload; never silently execute locally. */
  retainClaim?: boolean
  /** Synchronous workspace claim; false passes selection to the next provider. */
  claim(scope: { cwd: string }): boolean
  tree(scope: BetterSidebarWorkspaceScope, path: string, limit: number): Promise<SidebarFsListing>
  readText(scope: BetterSidebarWorkspaceScope, path: string, limit: number, headLimit: number): Promise<BetterSidebarWorkspaceReadResult>
  writeText(scope: BetterSidebarWorkspaceScope, path: string, content: string): Promise<void>
  search(scope: BetterSidebarWorkspaceScope, query: string, options: { maxMatches: number; maxVisited: number }): Promise<BetterSidebarWorkspaceSearchResult>
  readBytes(scope: BetterSidebarWorkspaceScope, path: string, limit: number): Promise<BetterSidebarWorkspaceBytesResult>
  /** Execute one existing Git action in the provider's execution world. */
  git: { execute(request: BetterSidebarGitRequest): Promise<unknown> }
  /** Human-owned interactive shell; separate from model-facing terminal tools. */
  terminal?: { label?: string; open(scope: BetterSidebarWorkspaceScope, request: BetterSidebarTerminalRequest): Promise<BetterSidebarTerminalHandle> }
}

export interface BetterSidebarWorkspaceService {
  readonly version: typeof BETTER_SIDEBAR_WORKSPACE_VERSION
  register(provider: BetterSidebarWorkspaceProvider): () => void
  resolve(scope: { cwd: string }): BetterSidebarWorkspaceProvider
}

/** Priority provider registry with an unconditional built-in local fallback. */
export class BetterSidebarWorkspaceRegistry implements BetterSidebarWorkspaceService {
  readonly version = BETTER_SIDEBAR_WORKSPACE_VERSION
  private providers = new Map<string, BetterSidebarWorkspaceProvider>()
  private readonly retainedClaims = new Set<string>()

  constructor(private readonly local: BetterSidebarWorkspaceProvider) {}

  register(provider: BetterSidebarWorkspaceProvider): () => void {
    if (provider.id.trim() === '') throw new Error('workspace provider id must not be empty')
    this.providers.set(provider.id, provider)
    return () => {
      if (this.providers.get(provider.id) === provider) this.providers.delete(provider.id)
    }
  }

  resolve(scope: { cwd: string }): BetterSidebarWorkspaceProvider {
    const ordered = [...this.providers.values()].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))
    for (const provider of ordered) {
      try {
        if (provider.claim(scope)) {
          if (provider.retainClaim) this.retainedClaims.add(scope.cwd)
          return provider
        }
      } catch (error) {
        if (provider.retainClaim) throw error
        // A broken optional provider must not disable the local workspace.
      }
    }
    if (this.retainedClaims.has(scope.cwd)) throw new SidebarError('pty-error', 'workspace provider is unavailable; reconnect it before using this workspace')
    return this.local
  }
}

const SEARCH_SKIP_DIRS = new Set([
  '.git', 'node_modules', '.pnpm-store', '.yarn', '.turbo', '.turbopack', '.next', '.nuxt',
  '.output', '.cache', '.parcel-cache', 'coverage', 'dist', 'build', 'out', '.umi',
  '.umi-production', '.dumi',
])

/** Built-in local filesystem adapter preserving existing limits and safety semantics. */
export class LocalBetterSidebarWorkspaceProvider implements BetterSidebarWorkspaceProvider {
  readonly id = 'local'
  readonly priority = Number.NEGATIVE_INFINITY
  claim(): boolean { return true }

  async tree(scope: BetterSidebarWorkspaceScope, requested: string, limit: number): Promise<SidebarFsListing> {
    const path = await ensureWorkspacePath(scope.cwd, requested, scope.fence)
    const level = await opendir(path).catch((error: unknown) => {
      throw new SidebarError('fs-error', `cannot list "${requested}": ${messageOf(error)}`, 400)
    })
    const entries: SidebarFsListing['entries'] = []
    let overflow = false
    try {
      for await (const dirent of level) {
        if (entries.length >= limit) { overflow = true; continue }
        const entryPath = join(requested, dirent.name)
        let isDir = dirent.isDirectory()
        let broken = false
        if (dirent.isSymbolicLink()) {
          const info = await stat(join(path, dirent.name)).catch(() => undefined)
          isDir = info?.isDirectory() ?? false
          broken = info === undefined
        }
        entries.push({
          name: dirent.name,
          path: entryPath,
          isDir,
          hidden: dirent.name.startsWith('.'),
          isSymlink: dirent.isSymbolicLink(),
          broken,
        })
      }
    } catch (error) {
      throw new SidebarError('fs-error', `cannot list "${requested}": ${messageOf(error)}`, 400)
    }
    entries.sort(compareEntries)
    return { path: requested, entries, truncated: overflow }
  }

  async readText(scope: BetterSidebarWorkspaceScope, requested: string, limit: number, headLimit: number): Promise<BetterSidebarWorkspaceReadResult> {
    const path = await ensureWorkspacePath(scope.cwd, requested, scope.fence)
    const info = await stat(path).catch((error: unknown) => {
      throw new SidebarError('fs-error', `cannot read "${path}": ${messageOf(error)}`, 400)
    })
    if (info.isDirectory()) throw new SidebarError('fs-error', `"${path}" is a directory`, 400)
    const size = info.size
    const handle = await open(path, 'r').catch((error: unknown) => {
      throw new SidebarError('fs-error', `cannot read "${path}": ${messageOf(error)}`, 400)
    })
    try {
      const buffer = Buffer.alloc(Math.min(size, limit))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const slice = buffer.subarray(0, bytesRead)
      const binary = slice.includes(0)
      return {
        content: binary ? '' : slice.toString('utf8'),
        truncated: size > limit,
        binary,
        size,
        head: binary ? slice.subarray(0, Math.min(slice.length, headLimit)).toString('base64') : undefined,
      }
    } finally {
      await handle.close()
    }
  }

  async writeText(scope: BetterSidebarWorkspaceScope, requested: string, content: string): Promise<void> {
    const path = await ensureWorkspaceWritePath(scope.cwd, requested, scope.fence)
    const tmp = `${path}.dsh-sidebar-tmp-${process.pid}`
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(tmp, content, 'utf8')
      await rename(tmp, path)
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {})
      throw new SidebarError('fs-error', `cannot write "${path}": ${messageOf(error)}`, 400)
    }
  }

  async search(scope: BetterSidebarWorkspaceScope, query: string, options: { maxMatches: number; maxVisited: number }): Promise<BetterSidebarWorkspaceSearchResult> {
    const needle = query.trim().toLowerCase()
    if (needle === '') return { matches: [], truncated: false }
    const root = await ensureWorkspacePath(scope.cwd, scope.cwd, scope.fence)
    const matches: string[] = []
    let visited = 0
    let truncated = false
    const walk = async (dir: string): Promise<void> => {
      if (truncated) return
      const level = await opendir(dir).catch(() => undefined)
      if (level === undefined) return
      for await (const dirent of level) {
        visited += 1
        if (visited > options.maxVisited) { truncated = true; return }
        if (dirent.isDirectory() && SEARCH_SKIP_DIRS.has(dirent.name.toLowerCase())) continue
        if (dirent.name.toLowerCase().includes(needle)) {
          matches.push(join(relative(root, dir), dirent.name))
          if (matches.length >= options.maxMatches) { truncated = true; return }
        }
        if (dirent.isDirectory() && !dirent.isSymbolicLink()) await walk(join(dir, dirent.name))
        if (truncated) return
      }
    }
    await walk(root)
    return { matches: matches.sort().map(path => path.split(sep).join('/')), truncated }
  }

  async readBytes(scope: BetterSidebarWorkspaceScope, requested: string, limit: number): Promise<BetterSidebarWorkspaceBytesResult> {
    const path = await ensureWorkspacePath(scope.cwd, requested, scope.fence)
    const info = await stat(path).catch((error: unknown) => {
      throw new SidebarError('fs-error', `cannot read "${path}": ${messageOf(error)}`, 400)
    })
    if (!info.isFile() || info.size > limit) throw new SidebarError('fs-error', 'not a file or too large', 400)
    return { bytes: await readFile(path), path, size: info.size }
  }

  readonly git = { execute: (request: BetterSidebarGitRequest): Promise<unknown> => executeLocalGit(request) }
}

async function localGitPath(cwd: string, raw: string, selected?: string): Promise<string> {
  if (isAbsolute(raw)) return requireAbsolute(resolveSessionPath(cwd, raw))
  const sessionPath = requireAbsolute(join(cwd, raw))
  if (await stat(sessionPath).then(() => true).catch(() => false)) return sessionPath
  const root = await git.repoRoot(cwd, selected).catch(() => cwd)
  return requireAbsolute(join(root, raw))
}

async function executeLocalGit(request: BetterSidebarGitRequest): Promise<unknown> {
  const cwd = await git.resolveWorktree(request.cwd, request.worktree)
  const { repoRoot } = request
  switch (request.operation) {
    case 'worktrees': {
      const base = repoRoot !== undefined ? await git.repoRoot(cwd, repoRoot).catch(() => cwd) : cwd
      return git.worktrees(base)
    }
    case 'status': return git.status(cwd, repoRoot)
    case 'diff': return { diff: await git.diff(cwd, request.path === undefined ? undefined : await localGitPath(cwd, request.path, repoRoot), request.staged, repoRoot) }
    case 'stage': await git.stage(cwd, request.path, repoRoot); return { ok: true }
    case 'unstage': await git.unstage(cwd, request.path, repoRoot); return { ok: true }
    case 'commit': await git.commit(cwd, request.message, repoRoot); return { ok: true }
    case 'branch': return git.branches(cwd, repoRoot)
    case 'checkout': await git.checkout(cwd, request.branch, repoRoot); return { ok: true }
    case 'log': return git.log(cwd, request.count, request.skip, repoRoot)
    case 'commit-diff': return { diff: await git.commitDiff(cwd, request.hash, repoRoot) }
    case 'discard': await git.discard(cwd, await localGitPath(cwd, request.path, repoRoot), repoRoot); return { ok: true }
    case 'revert': await git.revert(cwd, request.hash, repoRoot); return { ok: true }
    case 'cherry-pick': await git.cherryPick(cwd, request.hash, repoRoot); return { ok: true }
    case 'show': return { content: await git.show(cwd, request.rev, await localGitPath(cwd, request.path, repoRoot), repoRoot) }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    betterSidebarWorkspace: BetterSidebarWorkspaceService
  }
}
