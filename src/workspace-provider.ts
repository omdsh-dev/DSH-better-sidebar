import { mkdir, open, opendir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { compareEntries, type SidebarFsListing } from './fs-tree.ts'
import { ensureWorkspacePath, ensureWorkspaceWritePath } from './path-security.ts'
import { SidebarError } from './wire.ts'

/** Version of the public host workspace-provider contract. */
export const BETTER_SIDEBAR_WORKSPACE_VERSION = 1 as const

export interface BetterSidebarWorkspaceScope {
  cwd: string
  fence: boolean
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

/** Transport-neutral workspace operations owned by Better Sidebar. */
export interface BetterSidebarWorkspaceProvider {
  /** Stable registration identity. A new registration with the same id replaces the old one. */
  id: string
  /** Higher values claim first. Defaults to zero. */
  priority?: number
  /** Synchronous workspace claim; false passes selection to the next provider. */
  claim(scope: { cwd: string }): boolean
  tree(scope: BetterSidebarWorkspaceScope, path: string, limit: number): Promise<SidebarFsListing>
  readText(scope: BetterSidebarWorkspaceScope, path: string, limit: number, headLimit: number): Promise<BetterSidebarWorkspaceReadResult>
  writeText(scope: BetterSidebarWorkspaceScope, path: string, content: string): Promise<void>
  search(scope: BetterSidebarWorkspaceScope, query: string, options: { maxMatches: number; maxVisited: number }): Promise<BetterSidebarWorkspaceSearchResult>
  readBytes(scope: BetterSidebarWorkspaceScope, path: string, limit: number): Promise<BetterSidebarWorkspaceBytesResult>
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
        if (provider.claim(scope)) return provider
      } catch {
        // A broken optional provider must not disable the local workspace.
      }
    }
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
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    betterSidebarWorkspace: BetterSidebarWorkspaceService
  }
}
