/**
 * Host-side workspace watcher for the sidebar file manager. One watcher per
 * working directory is shared by every subscriber (multiple tabs / sessions
 * pointing at the same cwd). The watcher is started lazily on the first
 * subscriber and stopped when the last one disconnects, so an idle sidebar
 * does not hold file descriptors open.
 *
 * On Windows this deliberately uses Node's recursive `fs.watch` instead of
 * chokidar's per-directory watches. Chokidar opens a watch handle for every
 * nested directory/file, and Windows then refuses to move an ancestor
 * directory while those descendant handles exist. A single recursive handle
 * on the workspace root avoids that entire class of "cannot move folder with
 * obj/bin/generated subfolder" failures without having to enumerate every
 * generated directory name.
 *
 * On other platforms chokidar remains, and the watch is deliberately bounded:
 * recursion is capped at a shallow depth and heavyweight/generated/system
 * directories are ignored. Without this a session whose cwd is a large tree
 * (a user home directory, a monorepo with many nested packages, a cache-heavy
 * project) can make chokidar scan tens of thousands of directories on first
 * subscribe, stalling the whole web server for seconds while the browser is
 * loading. Ignored entries remain visible in the file tree and can still be
 * refreshed manually.
 */
import { watch as chokidarWatch } from 'chokidar'
import { watch as nodeWatch } from 'node:fs'

/** How deep below the watched cwd chokidar recurses on non-Windows (0 = the cwd itself). */
const WATCH_DEPTH = 4

/**
 * Common heavyweight/system/generated directories that do not need live
 * auto-refresh. Matching is path-segment based so `dist`, `build`,
 * `node_modules` etc. are ignored at any depth without matching unrelated
 * names like `distribution` or `building`, and without treating a workspace
 * root that happens to be named `build`/`tmp` as ignored.
 */
const IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', 'out', 'coverage',
  '.cache', '.local', '.config', '.vscode', '.idea', '.vs', '.svn', '.hg',
  'AppData', 'Application Data', 'Local Settings', '.venv', 'venv',
  '__pycache__', 'obj', 'Temp', 'tmp',
])

/** Whether a reported path contains an ignored directory segment. The cwd
 *  root is stripped when supplied, so a workspace root literally named
 *  `build`/`tmp` is still watched. */
export function isIgnoredPath(path: string, cwd?: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const root = cwd?.replace(/\\/g, '/').replace(/\/+$/, '')
  if (root !== undefined) {
    if (normalized === root) return false
    if (normalized.startsWith(`${root}/`)) {
      return normalized.slice(root.length + 1).split('/').some(segment => IGNORED_DIRS.has(segment))
    }
  }
  return normalized.split('/').some(segment => IGNORED_DIRS.has(segment))
}

/** How long to batch a burst of fs events before notifying subscribers. */
const NOTIFY_DEBOUNCE_MS = 50

/** Common surface implemented by both the chokidar and recursive fs.watch adapters. */
interface WorkspaceWatcher {
  onAll(listener: () => void): void
  onError(listener: (error: unknown) => void): void
  close(): Promise<void>
}

function createWorkspaceWatcher(cwd: string): WorkspaceWatcher {
  if (process.platform === 'win32') {
    // One recursive handle on the root. This does not create per-child
    // handles, so moving any subfolder (obj, bin, or anything else) is not
    // blocked by Windows while the workspace is being watched.
    const watcher = nodeWatch(cwd, {
      persistent: true,
      recursive: true,
      encoding: 'utf8',
    })
    return {
      onAll(listener) {
        // `filename` is relative to `cwd`; filter notifications with the same
        // ignored-directory set so generated directories still do not trigger refreshes.
        const notify = (_event: string, filename: string | null): void => {
          if (filename !== null && isIgnoredPath(filename)) return
          listener()
        }
        watcher.on('change', notify)
        watcher.on('rename', notify)
      },
      onError(listener) {
        watcher.on('error', listener)
      },
      close() {
        watcher.close()
        return Promise.resolve()
      },
    }
  }

  const watcher = chokidarWatch(cwd, {
    ignoreInitial: true,
    ignored: (path: string) => isIgnoredPath(path, cwd),
    persistent: true,
    // Bound the recursive scan: a 4-level watch covers normal project
    // nesting without letting chokidar enumerate a huge tree.
    depth: WATCH_DEPTH,
    // A workspace symlink can point at a huge external tree; the file tree
    // still shows symlink entries, but the watcher should not follow them.
    followSymlinks: false,
  })
  return {
    onAll(listener) {
      watcher.on('all', listener)
    },
    onError(listener) {
      watcher.on('error', listener)
    },
    close() {
      return watcher.close()
    },
  }
}

interface WatcherEntry {
  watcher: WorkspaceWatcher
  listeners: Set<() => void>
  timer: ReturnType<typeof setTimeout> | undefined
}

/** Manages shared workspace watchers keyed by absolute working directory. */
export class FsWatcherManager {
  private readonly watchers = new Map<string, WatcherEntry>()

  /**
   * Subscribe to file-tree change notifications for one working directory.
   * @returns a disposer that removes this listener and stops the shared
   * watcher when it was the last one.
   */
  subscribe(cwd: string, listener: () => void): () => void {
    let entry = this.watchers.get(cwd)
    if (entry === undefined) {
      const watcher = createWorkspaceWatcher(cwd)
      const created: WatcherEntry = { watcher, listeners: new Set(), timer: undefined }
      this.watchers.set(cwd, created)
      entry = created
      const notify = (): void => {
        if (created.timer !== undefined) return
        created.timer = setTimeout(() => {
          created.timer = undefined
          for (const listener of created.listeners) listener()
        }, NOTIFY_DEBOUNCE_MS)
      }
      watcher.onAll(notify)
      watcher.onError((error) => {
        console.error('[dsh-better-sidebar] workspace watcher error:', error)
      })
    }
    const current = entry
    current.listeners.add(listener)
    return () => {
      current.listeners.delete(listener)
      if (current.listeners.size > 0) return
      if (current.timer !== undefined) clearTimeout(current.timer)
      current.watcher.close().catch(() => { /* already closed */ })
      this.watchers.delete(cwd)
    }
  }

  /** Stop every watcher (plugin teardown). */
  dispose(): void {
    for (const entry of this.watchers.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      entry.watcher.close().catch(() => { /* already closed */ })
    }
    this.watchers.clear()
  }
}
