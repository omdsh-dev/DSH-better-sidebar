/**
 * Directory change watching behind the file tree's live refresh.
 *
 * The tree used to go stale the moment anything wrote to disk outside the
 * plugin (a build, a formatter, the model's own `bash`): a folder was listed
 * once, when it was expanded, and never again. DSH 0.1.7 gave its own tree
 * per-directory watching; this plugin owns its tree (it took the `files` kind
 * over), so it needs its own watcher.
 *
 * One connection watches the directories the reader actually has expanded —
 * not the whole workspace — because `fs.watch` is one OS handle per directory
 * and a deep tree would exhaust them. Collapsing a folder or closing the
 * socket releases its handle.
 * @module dsh-better-sidebar/fs-watch
 */
import { watch, type FSWatcher } from 'node:fs'

/** How long a burst of filesystem events is folded into a single push. */
const DEBOUNCE_MS = 150

/**
 * Directory watchers one connection may hold. The cap is a resource guard,
 * not a policy: a reader with more than this many folders expanded simply
 * stops gaining new watchers, and collapsing any folder frees a slot.
 */
const MAX_WATCHES = 64

/** One watched directory reporting that its contents changed. */
export interface DirectoryWatchEvent {
  /** The directory's absolute path, as it was registered. */
  dir: string
}

/** One connection's set of directory watchers. */
export interface DirectoryWatchers {
  /**
   * Start watching one directory.
   * @param dir - absolute directory to watch; already-watched paths are a no-op.
   * @returns true when the directory is now watched (or already was).
   */
  add(dir: string): boolean
  /**
   * Stop watching one directory; idempotent.
   * @param dir - absolute directory that was passed to {@link add}.
   */
  remove(dir: string): void
  /** Stop watching everything. */
  close(): void
}

/**
 * Create the watcher set of one connection.
 *
 * `fs.watch` reports a directory's own entry list changing, which is exactly
 * what re-listing that directory needs — file CONTENTS changing inside an
 * expanded folder is not observable this way and is not what the tree shows.
 * @param push - called once per debounced burst with the changed directory.
 * @param onError - called when a directory cannot be watched or its watcher
 *   fails; the directory is dropped either way, so the caller only reports it.
 * @returns the connection's watcher set.
 */
export function createDirectoryWatchers(
  push: (event: DirectoryWatchEvent) => void,
  onError: (dir: string, error: unknown) => void,
): DirectoryWatchers {
  const watchers = new Map<string, { watcher: FSWatcher; timer: NodeJS.Timeout | undefined }>()

  const drop = (dir: string): void => {
    const entry = watchers.get(dir)
    if (entry === undefined) return
    watchers.delete(dir)
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.watcher.close()
  }

  const notify = (dir: string): void => {
    const entry = watchers.get(dir)
    // A burst is folded into one push: editors emit several events per save,
    // and the tree re-lists the whole directory either way.
    if (entry === undefined || entry.timer !== undefined) return
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      if (watchers.has(dir)) push({ dir })
    }, DEBOUNCE_MS)
    // A pending re-list must never hold the host process open.
    entry.timer.unref()
  }

  return {
    add(dir) {
      if (watchers.has(dir)) return true
      if (watchers.size >= MAX_WATCHES) return false
      let watcher: FSWatcher
      try {
        watcher = watch(dir, { persistent: false })
      } catch (error) {
        onError(dir, error)
        return false
      }
      watcher.on('change', () => { notify(dir) })
      watcher.on('error', (error) => {
        onError(dir, error)
        drop(dir)
      })
      watchers.set(dir, { watcher, timer: undefined })
      return true
    },
    remove: drop,
    close() {
      for (const dir of [...watchers.keys()]) drop(dir)
    },
  }
}
