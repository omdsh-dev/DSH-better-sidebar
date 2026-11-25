/** Workspace defaults are observations, never persisted user overrides. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { BUILTIN_SOURCE_IDS, type ClueDefaultScopeResult, type JsonValue } from '../../clues/types.ts'
import { cluesApi } from './api.ts'
import { invalidateClueRequest, peekClueRequest } from './request-cache.ts'
import type { BetterSidebarCluesClientFace } from './registry.ts'

export function isGithubClueSource(sourceId: string | undefined): boolean {
  return sourceId === BUILTIN_SOURCE_IDS.githubIssues || sourceId === BUILTIN_SOURCE_IDS.githubPulls
}

export function useDefaultClueScope(options: {
  face: BetterSidebarCluesClientFace
  workspaceId: string
  sourceId: string | undefined
  explicitScope: JsonValue | undefined
  visible: boolean
}): { scope: JsonValue | undefined; loading: boolean; failed: boolean; reason?: ClueDefaultScopeResult['reason']; refresh(): void } {
  const { face, workspaceId, sourceId, explicitScope, visible } = options
  const [attempt, setAttempt] = useState(0)
  const refresh = useCallback(() => {
    // A range refresh is explicit: drop exactly this observation so the next
    // mount reads the repository again instead of serving the cached answer.
    if (face.api === cluesApi && sourceId !== undefined) {
      invalidateClueRequest('clues.defaultScope', workspaceId, { workspaceId, sourceId })
    }
    setAttempt(value => value + 1)
  }, [face, workspaceId, sourceId])
  /** The request key whose answer is already this hook's settled observation. */
  const settledKey = useRef<string | undefined>(undefined)
  const explicitKey = JSON.stringify(explicitScope)
  const key = `${workspaceId}\u0000${sourceId ?? ''}\u0000${explicitKey ?? ''}\u0000${attempt}`
  const needsRemote = isGithubClueSource(sourceId) && explicitScope === undefined
  // A cached range is the first-paint answer: no loading phase, no probe.
  const cached = needsRemote && face.api === cluesApi && sourceId !== undefined
    ? peekClueRequest<ClueDefaultScopeResult>('clues.defaultScope', workspaceId, { workspaceId, sourceId })
    : undefined
  const [observation, setObservation] = useState<{
    key: string
    loading: boolean
    failed: boolean
    result?: ClueDefaultScopeResult
  }>()
  useEffect(() => {
    if (!visible || sourceId === undefined) return
    if (!needsRemote) {
      setObservation(current => current?.key === key && !current.loading
        ? current
        : { key, loading: false, failed: false })
      return
    }
    // Hiding a keepMounted tab is not a reason to re-probe the same range.
    // With the shared read cache, an invalidated observation re-probes; with
    // an injected face (tests/extensions) the settled answer is authoritative.
    const cacheBacked = face.api === cluesApi
    if (settledKey.current === key && (!cacheBacked || cached !== undefined)) return
    if (cached !== undefined) {
      settledKey.current = key
      setObservation(current => current?.key === key && !current.loading
        ? current
        : { key, loading: false, failed: false, result: cached })
      return
    }
    const controller = new AbortController()
    setObservation({ key, loading: true, failed: false })
    void face.api.defaultScope(workspaceId, { sourceId }, controller.signal).then(result => {
      if (controller.signal.aborted) return
      settledKey.current = key
      setObservation({ key, loading: false, failed: false, result })
    }).catch(() => {
      if (!controller.signal.aborted) setObservation({ key, loading: false, failed: true })
    })
    return () => { controller.abort() }
  }, [face, workspaceId, sourceId, key, visible, needsRemote, cached])

  if (explicitScope !== undefined) return { scope: explicitScope, loading: false, failed: false, refresh }
  if (sourceId === BUILTIN_SOURCE_IDS.feishuDocs) {
    return { scope: { kind: 'drive-root' }, loading: false, failed: false, refresh }
  }
  if (!needsRemote) return { scope: undefined, loading: false, failed: false, refresh }
  const settled = observation?.key === key
    ? observation
    : cached === undefined
      ? undefined
      : { key, loading: false, failed: false, result: cached }
  if (settled === undefined) return { scope: undefined, loading: true, failed: false, refresh }
  return {
    refresh,
    scope: settled.result?.scope,
    loading: settled.loading,
    failed: settled.failed,
    ...(settled.result?.reason === undefined ? {} : { reason: settled.result.reason }),
  }
}
