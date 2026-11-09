/**
 * The one place a {@link SessionScope} object is built for a component tree.
 *
 * A scope is handed to tab bodies, badges, right-actions and the + menu, and
 * those key memos and effects off it. Building `{ sessionId, cwd }` inline on
 * every render made every such dependency look changed whenever the sidebar
 * shell re-rendered, so the same bug kept reappearing one call site at a time
 * (the tab cell's diff preview re-ran its whole-document rewrite and its
 * content tab re-issued a whole-file `fs.read`; a badge or an external
 * plugin's memo would churn the same way).
 *
 * Consumers that hand a scope to a tab body must use this; consumers that only
 * build one to pass INTO an api call (`api.fsRead({ sessionId, cwd }, …)`) do
 * not — the object never outlives the call there.
 */
import { useMemo } from 'react'
import type { SessionScope } from './api.ts'

/**
 * A scope object keyed by CONTENT: the same object is returned across renders
 * until the session or the cwd really changes.
 *
 * @param sessionId - the conversation id, or `undefined` for a shell mounted
 *   with no conversation selected (the scope is then absent).
 * @param cwd - the session's working directory, when known.
 */
export function useSessionScope(sessionId: string, cwd: string | undefined): SessionScope
export function useSessionScope(sessionId: string | undefined, cwd: string | undefined): SessionScope | undefined
export function useSessionScope(sessionId: string | undefined, cwd: string | undefined): SessionScope | undefined {
  return useMemo<SessionScope | undefined>(
    () => (sessionId === undefined ? undefined : { sessionId, cwd }),
    [sessionId, cwd],
  )
}
