/**
 * Live refresh for the file tree.
 *
 * The tree lists a folder when it is expanded and caches the level, so
 * anything written outside the plugin — a build, a formatter, the model's own
 * `bash` — stayed invisible until the reader refreshed. DSH 0.1.7 gave its own
 * tree per-directory watching; this plugin owns its tree (it took the `files`
 * kind over), so it carries its own.
 *
 * One socket per session, open for as long as the tree is mounted. The client
 * announces the folders it has expanded and the host watches exactly those;
 * every notice names a directory whose listing is stale, and the tree drops
 * that one cached level and re-lists it. Folders the reader collapsed are
 * un-watched, so a long session does not accumulate handles.
 */
import { useEffect, useRef } from 'react'
import { sidebarWebSocketBase } from './desktop-env.ts'

/** One server frame: a stale directory, a watch verdict, or a refusal. */
interface FsWatchFrame {
  dir?: unknown
  ok?: unknown
}

/** What the tree hands the hook. */
export interface DirectoryWatchOptions {
  /** Session whose workspace is being browsed; no socket while undefined. */
  sessionId: string | undefined
  /** The workspace root, always watched (the tree always lists it). */
  root: string | undefined
  /** Expanded directories below the root, in the host's absolute path form. */
  dirs: readonly string[]
  /**
   * A directory whose listing is stale.
   * @param dir - absolute directory path, exactly the form the tree keys levels by.
   */
  onStale: (dir: string) => void
}

/** How long to wait before re-opening a dropped socket; failures back off to the cap. */
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 15_000

/**
 * Keep the file tree's expanded folders watched for the component's lifetime.
 * @param options - session, root, expanded directories, and the staleness callback.
 */
export function useDirectoryWatch(options: DirectoryWatchOptions): void {
  const { sessionId, root, dirs, onStale } = options
  // The expanded set is a fresh array on every render, so neither the socket
  // effect nor the staleness callback may depend on their identity.
  const wantedRef = useRef<string[]>([])
  wantedRef.current = root === undefined ? [...dirs] : [root, ...dirs]
  const staleRef = useRef(onStale)
  staleRef.current = onStale
  /** Set by the socket effect; reconciles the host's watch set with the tree's. */
  const reconcileRef = useRef<() => void>(() => {})
  // One string per expanded-set change: a stable dependency for the effect below.
  const wantedKey = wantedRef.current.join('\u0000')

  useEffect(() => {
    if (sessionId === undefined) return
    let socket: WebSocket | null = null
    let retry: number | undefined
    let closed = false
    let failures = 0
    /** Directories the host confirmed it is watching (its own resolved paths). */
    const watching = new Set<string>()

    const send = (op: 'watch' | 'unwatch', path: string): void => {
      if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op, path }))
    }

    /**
     * Bring the host's watch set in line with the tree's expanded set. The
     * host answers every `watch` with the directory it resolved, so `watching`
     * is the host's own answer rather than a client-side guess.
     */
    const reconcile = (): void => {
      const wanted = new Set(wantedRef.current)
      for (const path of wanted) send('watch', path)
      for (const dir of [...watching]) {
        if (wanted.has(dir)) continue
        send('unwatch', dir)
        watching.delete(dir)
      }
    }
    reconcileRef.current = reconcile

    const connect = (): void => {
      if (closed) return
      const url = new URL('/sidebar/ws/fs-watch', sidebarWebSocketBase())
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.search = new URLSearchParams({ sessionId }).toString()
      socket = new WebSocket(url.toString())
      socket.onopen = () => {
        failures = 0
        watching.clear()
        reconcile()
      }
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return
        let frame: FsWatchFrame
        try {
          frame = JSON.parse(event.data) as FsWatchFrame
        } catch {
          return
        }
        if (frame === null || typeof frame !== 'object' || typeof frame.dir !== 'string') return
        // `ok: true` confirms a watch; `ok: false` refuses one (fenced path,
        // watcher cap, unreadable directory) and must NOT re-list. A frame
        // carrying only `dir` is the stale notice.
        if (frame.ok === true) {
          watching.add(frame.dir)
          return
        }
        if (frame.ok === undefined) staleRef.current(frame.dir)
      }
      socket.onclose = () => {
        if (closed) return
        failures += 1
        retry = window.setTimeout(connect, Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS))
      }
    }
    connect()

    return () => {
      closed = true
      reconcileRef.current = () => {}
      if (retry !== undefined) window.clearTimeout(retry)
      socket?.close()
    }
  }, [sessionId])

  // Reconciling on its own effect keeps an expand/collapse from tearing the
  // socket down and re-opening it.
  useEffect(() => {
    void wantedKey
    reconcileRef.current()
  }, [wantedKey])
}
