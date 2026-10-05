/**
 * The root the explorer and the git panel should use for one session.
 *
 * The client session list carries the session HEADER cwd, captured once when
 * the session started. The HOST is the authority on where the session is
 * actually working, because it can follow the agent into a linked git worktree
 *  including one belonging to a different repository. Ask the host, prefer
 * its answer, and re-ask when the window regains focus, when a file refresh is
 * requested, and on a slow timer so a mid-session worktree move is picked up.
 *
 * Shared by both client surfaces: the plugin's own sidebar shell
 * (`Sidebar.tsx`) and the native DSH right-sidebar tab body
 * (`native/tab-adapter.tsx`). They used to disagree  the native body read the
 * frozen list summary directly, so a host-side worktree change never reached
 * the file list drawn in the host's own right Sidebar.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { Context } from '../context-types.ts'
import { api } from './api.ts'

/** How often the host is re-asked while the document is visible. */
const SESSION_ROOT_POLL_MS = 5_000

/**
 * Resolve the live workspace root for one session.
 * @param ctx - client plugin context (owns the session list feed + API).
 * @param sessionId - the session to resolve; `undefined` resolves to `undefined`.
 * @returns the host's active root, falling back to the list summary cwd.
 */
export function useSessionRoot(ctx: Context, sessionId: string | undefined): string | undefined {
  const summaryCwd = useSyncExternalStore(
    useMemo(() => (listener: () => void) => ctx.sessions.list.subscribe(listener), [ctx]),
    () => sessionId === undefined ? undefined : ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd,
  )
  const [fetched, setFetched] = useState<{ sessionId: string; cwd: string } | undefined>(undefined)

  useEffect(() => {
    if (sessionId === undefined) return
    let cancelled = false
    const load = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      api.sessionCwd({ sessionId })
        .then(result => {
          if (cancelled) return
          setFetched(previous => (
            previous !== undefined && previous.sessionId === sessionId && previous.cwd === result.cwd
              ? previous
              : { sessionId, cwd: result.cwd }
          ))
        })
        .catch(() => { /* the explorer/git rows surface their own errors */ })
    }
    load()
    window.addEventListener('focus', load)
    window.addEventListener('dsh-sidebar:refresh-files', load)
    const timer = window.setInterval(load, SESSION_ROOT_POLL_MS)
    return () => {
      cancelled = true
      window.removeEventListener('focus', load)
      window.removeEventListener('dsh-sidebar:refresh-files', load)
      window.clearInterval(timer)
    }
  }, [sessionId])

  return fetched !== undefined && fetched.sessionId === sessionId ? fetched.cwd : summaryCwd
}
