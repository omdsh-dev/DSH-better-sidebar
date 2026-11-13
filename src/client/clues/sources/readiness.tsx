/** Actionable readiness next to the resources it enables; no background polling. */
import { useEffect, useRef, useState } from 'react'
import type { ClueSourceDescriptor, ClueSourceDisplayDescriptor } from '../../../clues/types.ts'
import type { ConnectionStatusProjection, DependencyStatus } from '../../../clues/runtime/types.ts'
import type { BetterSidebarWindowsClientFace } from '../../windows/types.ts'
import {
  clueRuntimeApi,
  peekClueConnections,
  peekClueDependencies,
  type ClueRuntimeApi,
} from '../runtime-api.ts'
import { deriveClueSourceStatus, type ClueSourceStatus } from '../settings/status.ts'
import { CLUE_SOURCE_STATUS_COPY } from '../settings/copy.ts'
import { subscribeClueRuntime } from '../settings/runtime-state.ts'
import { openClueSourceConfigWindow } from '../windows/source-config.tsx'
import { t } from '../../locales.ts'
import { ActionButton } from '../../ui/index.ts'
import css from '../tab/clues-tab.module.css'

export function SourceReadiness(props: {
  source: ClueSourceDescriptor
  display?: ClueSourceDisplayDescriptor
  windows: BetterSidebarWindowsClientFace
  visible: boolean
  onReady(): void
  runtime?: ClueRuntimeApi
}) {
  const { source, visible } = props
  const runtime = props.runtime ?? clueRuntimeApi
  const dependencyKey = (source.dependencyIds ?? []).join('\u0000')
  const connectionId = source.connectionId
  const hasNeeds = dependencyKey !== '' || connectionId !== undefined
  const [status, setStatus] = useState<ClueSourceStatus>({ kind: 'unchecked' })
  const [attempt, setAttempt] = useState(0)
  const forceCheck = useRef(false)
  const [checking, setChecking] = useState(true)
  const wasBlocked = useRef(false)
  const onReadyRef = useRef(props.onReady)
  onReadyRef.current = props.onReady

  useEffect(() => {
    if (!visible || !hasNeeds) return
    const refresh = forceCheck.current
    forceCheck.current = false
    const controller = new AbortController()
    const ids = dependencyKey === '' ? [] : dependencyKey.split('\u0000')
    const dependencies = new Map<string, DependencyStatus>()
    const connections = new Map<string, ConnectionStatusProjection>()
    // Bus observations are newer than a probe already in flight. Never replace
    // them with the older answer when installing/authorizing in another window.
    const observedDependencies = new Set<string>()
    let observedConnection = false
    let completed = false
    let failed = false
    const runningTasks = new Set<string>()
    const commit = (): void => {
      if (controller.signal.aborted) return
      if (runningTasks.size > 0) { setStatus({ kind: 'installing' }); return }
      const dependencyBlocked = ids.some(id => {
        const state = dependencies.get(id)?.state
        return state === 'missing' || state === 'incompatible' || state === 'installing'
      })
      const covered = ids.every(id => dependencies.has(id))
        && (dependencyBlocked || connectionId === undefined || connections.has(connectionId))
      const next = deriveClueSourceStatus({
        dependencyIds: ids,
        ...(connectionId === undefined ? {} : { connectionId }),
        ...(source.connectionCapability === undefined ? {} : { requiredCapability: source.connectionCapability }),
        dependencies: [...dependencies.values()],
        connections: [...connections.values()],
        checked: completed || covered,
        requestFailed: failed && !covered,
      })
      setStatus(next)
      if (next.kind === 'ready') {
        if (wasBlocked.current) onReadyRef.current()
        wasBlocked.current = false
      } else if (next.kind !== 'unchecked' || completed) wasBlocked.current = true
    }
    setStatus({ kind: 'unchecked' })
    setChecking(true)
    const unsubscribe = subscribeClueRuntime(runtime, observation => {
      let relevant = false
      for (const item of observation.dependencies) {
        if (!ids.includes(item.dependencyId)) continue
        observedDependencies.add(item.dependencyId)
        dependencies.set(item.dependencyId, item)
        relevant = true
      }
      for (const item of observation.connections) {
        if (item.connectionId !== connectionId) continue
        observedConnection = true
        connections.set(item.connectionId, item)
        relevant = true
      }
      let taskSettled = false
      for (const task of observation.tasks) {
        if (!ids.includes(task.dependencyId)) continue
        if (task.state === 'running') {
          runningTasks.add(task.dependencyId)
          wasBlocked.current = true
          relevant = true
        } else if (runningTasks.delete(task.dependencyId)) taskSettled = true
      }
      if (taskSettled) { forceCheck.current = true; setAttempt(value => value + 1); return }
      if (relevant) commit()
    })
    // A completed observation is served synchronously from the activation
    // cache: opening/returning to a surface does not re-probe (and never shows
    // a checking row). Explicit Recheck and any invalidating action still read.
    if (runtime === clueRuntimeApi && !refresh) {
      for (const id of ids) {
        for (const item of peekClueDependencies(id) ?? []) {
          if (item.dependencyId === id) dependencies.set(id, item)
        }
      }
      if (connectionId !== undefined) {
        for (const item of peekClueConnections(connectionId) ?? []) {
          if (item.connectionId === connectionId) connections.set(item.connectionId, item)
        }
      }
      const blocked = ids.some(id => {
        const state = dependencies.get(id)?.state
        return state === 'missing' || state === 'incompatible' || state === 'installing'
      })
      const covered = ids.every(id => dependencies.has(id))
        && (blocked || connectionId === undefined || connections.has(connectionId))
      if (covered) {
        completed = true
        setChecking(false)
        commit()
        return () => { unsubscribe() }
      }
    }
    void Promise.allSettled([
      ...ids.map(id => runtime.dependenciesInspect(refresh ? { dependencyId: id, refresh: true } : { dependencyId: id }, controller.signal).then(items => {
        for (const item of items) {
          if (!observedDependencies.has(item.dependencyId)) dependencies.set(item.dependencyId, item)
        }
      })),
      ...(connectionId === undefined ? [] : [runtime.connectionsStatus(connectionId, controller.signal, refresh).then(items => {
        if (!observedConnection) for (const item of items) connections.set(item.connectionId, item)
      })]),
    ]).then(results => {
      if (controller.signal.aborted) return
      setChecking(false)
      completed = true
      failed = results.some(result => result.status === 'rejected')
      commit()
    })
    return () => { controller.abort(); unsubscribe() }
  }, [runtime, dependencyKey, connectionId, source.connectionCapability, visible, hasNeeds, attempt])

  // A probe in flight is deliberately invisible: inserting a checking row
  // above the search box moves it on every mount and makes the page jump.
  // The actionable row appears only once there is a real next step.
  if (!hasNeeds || status.kind === 'ready') return null
  if (checking && status.kind === 'unchecked') return null
  const missingDependency = status.kind === 'missing' || status.kind === 'incompatible'
  const needsInstall = missingDependency && status.dependency?.installable !== false
  const needsAuthorization = status.kind === 'not-authorized' || status.kind === 'auth-expired'
  return <div className={css.readiness} data-clue-readiness={status.kind} role="status">
    <span className={css.readinessCopy}>
      <strong>{props.display?.name ?? source.name}</strong>
      <span>{missingDependency && status.dependency !== undefined ? `${status.dependency.name} · ` : ''}{t(CLUE_SOURCE_STATUS_COPY[status.kind])}</span>
    </span>
    <ActionButton size="sm"
      onClick={() => {
        openClueSourceConfigWindow({
          windows: props.windows, source, display: props.display, runtime,
          ...(needsInstall ? { initialAction: 'install' as const } : {}),
          onClose: () => { setAttempt(value => value + 1) },
        })
      }}>
      {needsInstall ? t('clueDependencyInstall') : needsAuthorization ? t('clueConnectionAuthorize') : t('clueConfigure')}
    </ActionButton>
    {status.kind === 'request-failed' && <ActionButton variant="ghost" size="sm"
      onClick={() => { forceCheck.current = true; setAttempt(value => value + 1) }}>{t('retry')}</ActionButton>}
  </div>
}
