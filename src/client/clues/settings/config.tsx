/**
 * S8 source configuration page — the body of the S6 window opened from the
 * clue source table (`ctx.betterSidebar.windows` in production; the props here
 * are the window content's own).
 *
 * Sections:
 * - CLI dependency: actual path, parsed version, compatibility contract,
 *   manual path override (absolute path, validated before submission), explicit
 *   re-check, and a one-click install that follows S2's plan → human confirm →
 *   task → progress → cancel pipeline;
 * - shared connection: application configuration / authorization state, the
 *   explicit authorize action, and — while an attempt runs — the prompt (URL,
 *   code, QR payload, expiry), an explicit status check and cancel.
 *
 * Rules enforced here (approved S8 spec §4):
 * - a status read happens only because the user opened this page or pressed
 *   re-check; nothing auto-logs-in, auto-polls authorization or requests a
 *   business operation (the "detect" path never runs a dry-run or a login);
 * - installing a CLI and authorizing a source connection are separate actions;
 * - failures are retried in place and never discard the surrounding settings;
 * - only S2's sanitized projection fields are rendered: no token, raw stdout,
 *   stderr, environment value or secret file content, even if a DTO smuggles
 *   an extra field in.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { t, type CopyKey } from '../../locales.ts'
// The sidebar's ONE polling loop (see use-polling.ts): this page must not own
// a second recurring timer, and the loop is gated by the running-task flag.
import { usePolling } from '../../use-polling.ts'
import { clueRuntimeApi, type ClueRuntimeApi } from '../runtime-api.ts'
import type {
  ConnectionStatusProjection,
  DependencyInstallActionId,
  DependencyInstallPlan,
  DependencyInstallTask,
  DependencyStatus,
  DependencyState,
} from '../../../clues/runtime/types.ts'
import type { ClueSourceStatusKind } from './status.ts'
import css from './settings.module.css'

/** Explicit install progress poll interval (only while a task runs). */
export const INSTALL_POLL_MS = 1_000

/** Props of the configuration page (S6 window content). */
export interface SourceConfigPageProps {
  readonly sourceId: string
  readonly sourceName: string
  readonly dependencyIds: readonly string[]
  readonly connectionId?: string
  /** Test/exotic-host seam; production uses the plugin's one wire wrapper. */
  readonly runtime?: ClueRuntimeApi
}

/** Copy key per install stage. */
const STAGE_COPY: Record<NonNullable<DependencyInstallTask['progress']>['stage'], CopyKey> = {
  queued: 'clueStageQueued',
  downloading: 'clueStageDownloading',
  verifying: 'clueStageVerifying',
  extracting: 'clueStageExtracting',
  installing: 'clueStateInstalling',
  probing: 'clueStageProbing',
  completed: 'tasksStateDone',
}

/** Copy key per ordered install action id. */
const ACTION_COPY: Record<DependencyInstallActionId, CopyKey> = {
  'download-archive': 'clueActionDownloadArchive',
  'verify-sha256': 'clueActionVerifySha256',
  'extract-archive': 'clueActionExtractArchive',
  'install-npm-local': 'clueActionInstallNpmLocal',
  'probe-version': 'clueActionProbeVersion',
  'replace-managed-copy': 'clueActionReplaceManagedCopy',
}

/** Copy key of a dependency state (shared with the source table vocabulary). */
const DEPENDENCY_STATE_COPY: Record<DependencyState, ClueSourceStatusKind> = {
  unknown: 'unchecked',
  missing: 'missing',
  incompatible: 'incompatible',
  installing: 'installing',
  ready: 'ready',
  failed: 'request-failed',
}

/** Copy key of one derived state. */
const STATE_COPY: Record<ClueSourceStatusKind, CopyKey> = {
  unchecked: 'clueStateUnchecked',
  missing: 'clueStateMissing',
  incompatible: 'clueStateIncompatible',
  installing: 'clueStateInstalling',
  'not-configured': 'clueStateNotConfigured',
  authorizing: 'clueStateAuthorizing',
  'auth-expired': 'clueStateAuthExpired',
  'request-failed': 'clueStateRequestFailed',
  ready: 'clueStateReady',
}

/** The authorization button copy for each S2 action. */
const CONNECTION_ACTION_COPY = {
  connect: 'clueConnectionAuthorize',
  reconnect: 'clueConnectionReconnect',
  'grant-scope': 'clueConnectionGrantScope',
  configure: 'clueConfigure',
} as const

/** One user-readable failure line (sanitized message only). */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether a path is absolute in either host dialect (client is node-free). */
export function isAbsoluteHostPath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path)
}

/** Replace one dependency in a list (identity preserved for untouched rows). */
function replaceDependency(list: readonly DependencyStatus[], next: DependencyStatus): DependencyStatus[] {
  const at = list.findIndex(item => item.dependencyId === next.dependencyId)
  if (at < 0) return [...list, next]
  return list.map((item, index) => (index === at ? next : item))
}

/** Replace one connection projection in a list. */
function replaceConnection(
  list: readonly ConnectionStatusProjection[],
  next: ConnectionStatusProjection,
): ConnectionStatusProjection[] {
  const at = list.findIndex(item => item.connectionId === next.connectionId)
  if (at < 0) return [...list, next]
  return list.map((item, index) => (index === at ? next : item))
}

/** A tiny inline action button (native, keyboard focusable). */
function Action(props: {
  label: string
  onClick: () => void
  disabled?: boolean
  primary?: boolean
}) {
  return (
    <button
      type="button"
      className={css.smallButton}
      disabled={props.disabled === true}
      data-primary={props.primary === true ? '' : undefined}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  )
}

/**
 * Render the source configuration page.
 * @param props - source identity/needs plus the injectable runtime wrapper.
 */
export function SourceConfigPage(props: SourceConfigPageProps) {
  const { sourceId, sourceName, dependencyIds, connectionId } = props
  const runtime = props.runtime ?? clueRuntimeApi
  const ids = useMemo(() => [...dependencyIds], [dependencyIds])

  const [dependencies, setDependencies] = useState<readonly DependencyStatus[] | null>(null)
  const [connections, setConnections] = useState<readonly ConnectionStatusProjection[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [failedIds, setFailedIds] = useState<Record<string, true>>({})
  const [plans, setPlans] = useState<Record<string, DependencyInstallPlan>>({})
  const [tasks, setTasks] = useState<Record<string, DependencyInstallTask>>({})
  const [planningId, setPlanningId] = useState<string | null>(null)
  const [pathDrafts, setPathDrafts] = useState<Record<string, string>>({})
  const [pathErrors, setPathErrors] = useState<Record<string, string>>({})
  const [connecting, setConnecting] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  /** Explicit status read. `refreshProbes` bypasses S2's probe cache. */
  const loadAll = useCallback(async (refreshProbes: boolean): Promise<void> => {
    setRefreshing(true)
    setError(null)
    const failures: Record<string, true> = {}
    try {
      const nextDependencies = await Promise.all(ids.map(async (dependencyId): Promise<DependencyStatus | undefined> => {
        try {
          const list = await runtime.dependenciesInspect(
            refreshProbes ? { dependencyId, refresh: true } : { dependencyId },
          )
          return list.find(item => item.dependencyId === dependencyId) ?? list[0]
        } catch (caught) {
          failures[dependencyId] = true
          if (mounted.current) setError(messageOf(caught))
          return undefined
        }
      }))
      let nextConnection: ConnectionStatusProjection | undefined
      if (connectionId !== undefined) {
        nextConnection = await runtime.connectionsStatus(connectionId).then(
          list => list.find(item => item.connectionId === connectionId) ?? list[0],
          (caught: unknown) => {
            if (mounted.current) setError(messageOf(caught))
            return undefined
          },
        )
      }
      if (!mounted.current) return
      setDependencies(nextDependencies.filter((item): item is DependencyStatus => item !== undefined))
      setConnections(nextConnection === undefined ? [] : [nextConnection])
      setFailedIds(failures)
    } finally {
      if (mounted.current) setRefreshing(false)
    }
  }, [runtime, ids, connectionId])

  useEffect(() => { void loadAll(false) }, [loadAll])

  /** Re-read one dependency after a settled install/manual path change. */
  const reloadDependency = useCallback(async (dependencyId: string): Promise<void> => {
    try {
      const list = await runtime.dependenciesInspect({ dependencyId })
      const next = list.find(item => item.dependencyId === dependencyId)
      if (next === undefined || !mounted.current) return
      setDependencies(current => replaceDependency(current ?? [], next))
      setFailedIds(current => {
        if (current[dependencyId] === undefined) return current
        const nextFailures = { ...current }
        delete nextFailures[dependencyId]
        return nextFailures
      })
    } catch {
      // The re-probe is a refresh, not a user action: the old row stays.
    }
  }, [runtime])

  // Poll ONLY while a task actually runs, through the shared polling engine:
  // the loop is gated by `enabled`, and teardown (settle, cancel, close,
  // unmount) clears the schedule. No second recurring timer lives here.
  const running = Object.values(tasks).find(item => item.state === 'running')
  const runningDependencyId = running?.dependencyId
  const runningTaskId = running?.taskId
  const pollRunningTask = useCallback(async (signal: AbortSignal): Promise<void> => {
    if (runningDependencyId === undefined || runningTaskId === undefined) return
    try {
      const list = await runtime.dependenciesStatus(runningDependencyId)
      if (signal.aborted) return
      const next = list.find(item => item.taskId === runningTaskId)
      if (next === undefined || !mounted.current) return
      setTasks(current => ({ ...current, [runningDependencyId]: next }))
      if (next.state !== 'running') await reloadDependency(runningDependencyId)
    } catch (caught) {
      if (!signal.aborted) setError(messageOf(caught))
    }
  }, [runtime, runningDependencyId, runningTaskId, reloadDependency])
  usePolling(
    runningDependencyId !== undefined && runningTaskId !== undefined,
    pollRunningTask,
    { intervalMs: INSTALL_POLL_MS, mode: 'self-scheduling' },
  )

  const plan = async (dependencyId: string): Promise<void> => {
    setPlanningId(dependencyId)
    setError(null)
    try {
      const next = await runtime.dependenciesPlan(dependencyId)
      if (!mounted.current) return
      setPlans(current => ({ ...current, [dependencyId]: next }))
    } catch (caught) {
      if (mounted.current) setError(messageOf(caught))
    } finally {
      if (mounted.current) setPlanningId(null)
    }
  }

  const startPlan = async (dependencyId: string): Promise<void> => {
    const current = plans[dependencyId]
    if (current === undefined) return
    try {
      const next = await runtime.dependenciesStart(dependencyId, current.planId)
      if (!mounted.current) return
      setTasks(state => ({ ...state, [dependencyId]: next }))
      setPlans(state => {
        const copy = { ...state }
        delete copy[dependencyId]
        return copy
      })
      setError(null)
    } catch (caught) {
      if (mounted.current) setError(messageOf(caught))
    }
  }

  const cancelPlan = (dependencyId: string): void => {
    setPlans(state => {
      const copy = { ...state }
      delete copy[dependencyId]
      return copy
    })
  }

  const cancelInstall = async (task: DependencyInstallTask): Promise<void> => {
    try {
      const next = await runtime.dependenciesCancel(task.dependencyId, task.taskId)
      if (!mounted.current) return
      setTasks(current => ({ ...current, [task.dependencyId]: next }))
      if (next.state !== 'running') await reloadDependency(task.dependencyId)
    } catch (caught) {
      if (mounted.current) setError(messageOf(caught))
    }
  }

  const applyPath = async (dependencyId: string): Promise<void> => {
    const raw = (pathDrafts[dependencyId] ?? '').trim()
    if (!isAbsoluteHostPath(raw)) {
      setPathErrors(current => ({ ...current, [dependencyId]: t('clueDependencyPathInvalid') }))
      return
    }
    setPathErrors(current => {
      const copy = { ...current }
      delete copy[dependencyId]
      return copy
    })
    try {
      const next = await runtime.dependenciesSetPath(dependencyId, raw)
      if (!mounted.current) return
      setDependencies(current => replaceDependency(current ?? [], next))
      setError(null)
    } catch (caught) {
      if (mounted.current) setError(messageOf(caught))
    }
  }

  const clearPath = async (dependencyId: string): Promise<void> => {
    try {
      const next = await runtime.dependenciesClearPath(dependencyId)
      if (!mounted.current) return
      setDependencies(current => replaceDependency(current ?? [], next))
      setError(null)
    } catch (caught) {
      if (mounted.current) setError(messageOf(caught))
    }
  }

  const connection = connectionId === undefined
    ? undefined
    : (connections ?? []).find(item => item.connectionId === connectionId)

  const connect = async (): Promise<void> => {
    if (connectionId === undefined) return
    setConnecting(true)
    setError(null)
    try {
      const next = await runtime.connectionsConnect(connectionId)
      if (!mounted.current) return
      setConnections(current => replaceConnection(current ?? [], next))
    } catch (caught) {
      if (mounted.current) setError(messageOf(caught))
    } finally {
      if (mounted.current) setConnecting(false)
    }
  }

  const pollConnection = async (): Promise<void> => {
    if (connectionId === undefined) return
    setConnecting(true)
    setError(null)
    try {
      const next = await runtime.connectionsPoll(connectionId)
      if (!mounted.current) return
      setConnections(current => replaceConnection(current ?? [], next))
    } catch (caught) {
      if (mounted.current) setError(messageOf(caught))
    } finally {
      if (mounted.current) setConnecting(false)
    }
  }

  const cancelConnection = async (): Promise<void> => {
    if (connectionId === undefined) return
    setConnecting(true)
    setError(null)
    try {
      const next = await runtime.connectionsCancel(connectionId)
      if (!mounted.current) return
      setConnections(current => replaceConnection(current ?? [], next))
    } catch (caught) {
      if (mounted.current) setError(messageOf(caught))
    } finally {
      if (mounted.current) setConnecting(false)
    }
  }

  return (
    <div className={css.config} data-clue-config={sourceId} aria-label={sourceName}>
      {error !== null && (
        <p className={css.configError} role="alert">{error}</p>
      )}

      {ids.length > 0 && (
        <section className={css.configSection} aria-label={t('clueDependencyHeading')}>
          <h3 className={css.configHeading}>{t('clueDependencyHeading')}</h3>
          {ids.map(dependencyId => {
            const current = (dependencies ?? []).find(item => item.dependencyId === dependencyId)
            const currentPlan = plans[dependencyId]
            const currentTask = tasks[dependencyId]
            const installable = current?.installable === true
            const stateKind: ClueSourceStatusKind = failedIds[dependencyId] === true
              ? 'request-failed'
              : current === undefined
                ? 'unchecked'
                : DEPENDENCY_STATE_COPY[current.state]
            return (
              <div key={dependencyId} className={css.plan} data-clue-dependency={dependencyId}>
                <div className={css.configRow}>
                  <span className={css.configLabel}>{current?.name ?? dependencyId}</span>
                  <span className={css.status} data-kind={stateKind}>{t(STATE_COPY[stateKind])}</span>
                </div>
                <div className={css.configRow}>
                  <span className={css.configLabel}>{t('clueDependencyActualPath')}</span>
                  <span className={`${css.configValue} ${css.configMono}`}>
                    {current?.executablePath ?? t('clueDependencyNotInstalled')}
                  </span>
                </div>
                <div className={css.configRow}>
                  <span className={css.configLabel}>{t('clueDependencyVersion')}</span>
                  <span className={`${css.configValue} ${css.configMono}`}>
                    {current?.version ?? t('clueDependencyNotInstalled')}
                  </span>
                </div>
                {current !== undefined && (
                  <div className={css.configRow}>
                    <span className={css.configLabel}>{t('clueDependencyCompat')}</span>
                    <span className={css.configValue}>
                      {t('clueDependencyRequirement', {
                        minimum: current.minimumVersion,
                        recommended: current.recommendedVersion,
                      })}
                    </span>
                  </div>
                )}
                {current?.manualPath !== undefined && (
                  <div className={css.configRow}>
                    <span className={css.configLabel}>{t('clueDependencyManualPath')}</span>
                    <span className={`${css.configValue} ${css.configMono}`}>{current.manualPath}</span>
                    <Action label={t('clueDependencyClearPath')} onClick={() => { void clearPath(dependencyId) }} />
                  </div>
                )}
                <div className={css.configInputRow}>
                  <input
                    className={css.configInput}
                    type="text"
                    spellCheck={false}
                    aria-label={t('clueDependencyManualPath')}
                    placeholder={t('clueDependencyPathPlaceholder')}
                    value={pathDrafts[dependencyId] ?? ''}
                    onChange={event => {
                      const value = event.currentTarget.value
                      setPathDrafts(currentDrafts => ({ ...currentDrafts, [dependencyId]: value }))
                    }}
                  />
                  <Action label={t('clueDependencyApplyPath')} onClick={() => { void applyPath(dependencyId) }} />
                </div>
                {pathErrors[dependencyId] !== undefined && (
                  <p className={css.configError} role="alert">{pathErrors[dependencyId]}</p>
                )}
                <div className={css.configActions}>
                  <Action
                    label={t('clueDependencyRecheck')}
                    disabled={refreshing}
                    onClick={() => { void loadAll(true) }}
                  />
                  <Action
                    label={t('clueDependencyInstall')}
                    disabled={!installable || currentPlan !== undefined || planningId === dependencyId}
                    onClick={() => { void plan(dependencyId) }}
                  />
                  {currentTask !== undefined && currentTask.state === 'running' && (
                    <Action label={t('clueDependencyInstallCancel')} onClick={() => { void cancelInstall(currentTask) }} />
                  )}
                </div>

                {!installable && current !== undefined && (
                  <>
                    <p className={css.configHint}>{t('clueDependencyInstallUnavailable')}</p>
                    {current.manualInstall !== undefined && (
                      <div className={css.configRow}>
                        <span className={css.configLabel}>{t('clueDependencyManualInstall')}</span>
                        <span className={css.configValue}>
                          {current.manualInstall.instructions}
                          {current.manualInstall.url !== undefined && (
                            <>
                              {' '}
                              <a className={css.authLink} href={current.manualInstall.url} target="_blank" rel="noreferrer">
                                {current.manualInstall.url}
                              </a>
                            </>
                          )}
                        </span>
                      </div>
                    )}
                  </>
                )}
                {current?.state === 'installing' && current.installation !== undefined && currentTask === undefined && (
                  <div className={css.configRow}>
                    <span className={css.configLabel}>{t('clueDependencyInstall')}</span>
                    <span className={css.configValue}>
                      {current.installation.stage === undefined
                        ? t('clueStateInstalling')
                        : t(STAGE_COPY[current.installation.stage])}
                    </span>
                  </div>
                )}

                {currentPlan !== undefined && (
                  <div className={css.plan} data-clue-plan={currentPlan.planId}>
                    <div className={css.configRow}>
                      <span className={css.configValue}>
                        {t('clueDependencyPlanTitle', { name: currentPlan.name, version: currentPlan.version })}
                      </span>
                    </div>
                    <div className={css.configRow}>
                      <span className={css.configValue}>
                        {t('clueDependencyPlanTarget', { path: currentPlan.targetDir })}
                      </span>
                    </div>
                    {!currentPlan.installable && (
                      <p className={css.configHint}>{t('clueDependencyInstallUnavailable')}</p>
                    )}
                    <ul className={css.planActions}>
                      {currentPlan.actionIds.map((action, index) => (
                        <li key={`${action}:${index}`}>
                          {ACTION_COPY[action] === undefined ? currentPlan.actions[index] ?? action : t(ACTION_COPY[action])}
                        </li>
                      ))}
                    </ul>
                    <div className={css.configActions}>
                      {currentPlan.installable && (
                        <Action
                          label={t('clueDependencyPlanConfirm')}
                          primary
                          onClick={() => { void startPlan(dependencyId) }}
                        />
                      )}
                      <Action label={t('cancel')} onClick={() => { cancelPlan(dependencyId) }} />
                    </div>
                  </div>
                )}

                {currentTask !== undefined && currentTask.state !== 'running' && (
                  <div className={css.configRow} data-clue-task={currentTask.taskId}>
                    <span className={css.configLabel}>{t('clueDependencyInstall')}</span>
                    <span className={css.configValue}>
                      {currentTask.state === 'succeeded'
                        ? t('tasksStateDone')
                        : currentTask.state === 'cancelled'
                          ? t('clueDependencyInstallCancelled')
                          : t('clueDependencyInstallFailed')}
                      {currentTask.error !== undefined && ` — ${currentTask.error.message}`}
                    </span>
                  </div>
                )}

                {currentTask !== undefined && currentTask.state === 'running' && currentTask.progress !== undefined && (
                  <div data-clue-progress={currentTask.taskId}>
                    <div
                      className={css.progressTrack}
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={currentTask.progress.fraction === undefined
                        ? undefined
                        : Math.round(currentTask.progress.fraction * 100)}
                    >
                      <div
                        className={css.progressFill}
                        style={{ width: `${Math.round((currentTask.progress.fraction ?? 0) * 100)}%` }}
                      />
                    </div>
                    <p className={css.configHint}>
                      {t(STAGE_COPY[currentTask.progress.stage])}
                      {currentTask.progress.fraction === undefined
                        ? ''
                        : ` · ${Math.round(currentTask.progress.fraction * 100)}%`}
                    </p>
                  </div>
                )}
              </div>
            )
          })}
        </section>
      )}

      {connectionId !== undefined && (
        <section className={css.configSection} aria-label={t('clueConnectionHeading')}>
          <h3 className={css.configHeading}>{t('clueConnectionHeading')}</h3>
          {connection === undefined ? (
            <p className={css.configHint}>{t('clueStateNotConfigured')}</p>
          ) : (
            <>
              <div className={css.configRow}>
                <span className={css.configLabel}>{t('clueConnectionConfiguration')}</span>
                <span className={css.configValue} data-configuration={connection.configuration}>
                  {connection.configuration === 'missing'
                    ? t('clueStateNotConfigured')
                    : connection.configuration === 'not-required'
                      ? '—'
                      : connection.configuration === 'ready'
                        ? t('clueStateReady')
                        : t('clueStateUnchecked')}
                </span>
              </div>
              <div className={css.configRow}>
                <span className={css.configLabel}>{t('clueConnectionAuthorization')}</span>
                <span className={css.configValue} data-authorization={connection.authorization}>
                  {connection.authorization === 'ready'
                    ? t('clueStateReady')
                    : connection.authorization === 'expired'
                      ? t('clueStateAuthExpired')
                      : connection.authorization === 'authorizing'
                        ? t('clueStateAuthorizing')
                        : connection.authorization === 'denied'
                          ? t('clueConnectionDenied')
                          : connection.authorization === 'scope-insufficient'
                            ? t('clueConnectionScope')
                            : connection.authorization === 'unknown'
                              ? t('clueStateUnchecked')
                              : t('clueStateNotConfigured')}
                </span>
              </div>
              {connection.account !== undefined && (
                <div className={css.configRow}>
                  <span className={css.configLabel}>{t('clueConnectionAccount')}</span>
                  <span className={css.configValue}>{connection.account}</span>
                </div>
              )}
              {connection.detail !== undefined && <p className={css.configHint}>{connection.detail}</p>}
              {connection.error !== undefined && <p className={css.configError} role="alert">{connection.error.message}</p>}

              <div className={css.configActions}>
                {connection.action !== 'none' && (
                  <Action
                    label={t(CONNECTION_ACTION_COPY[connection.action])}
                    disabled={connecting}
                    onClick={() => { void connect() }}
                  />
                )}
                {connection.authorization === 'authorizing' && (
                  <>
                    <Action label={t('clueConnectionCheck')} disabled={connecting} onClick={() => { void pollConnection() }} />
                    <Action label={t('clueConnectionCancel')} disabled={connecting} onClick={() => { void cancelConnection() }} />
                  </>
                )}
              </div>

              {connection.prompt !== undefined && (
                <div className={css.authPrompt} data-clue-auth-prompt="">
                  {connection.prompt.verificationUrl !== undefined && (
                    <div className={css.configRow}>
                      <span className={css.configLabel}>{t('clueConnectionUrl')}</span>
                      <span className={css.configValue}>
                        <a
                          className={css.authLink}
                          href={connection.prompt.verificationUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {connection.prompt.verificationUrl}
                        </a>
                      </span>
                    </div>
                  )}
                  {connection.prompt.userCode !== undefined && (
                    <div className={css.configRow}>
                      <span className={css.configLabel}>{t('clueConnectionCode')}</span>
                      <span className={`${css.configValue} ${css.configMono}`}>{connection.prompt.userCode}</span>
                    </div>
                  )}
                  {connection.prompt.qr !== undefined && (
                    <div className={css.configRow}>
                      <span className={css.configLabel}>{t('clueConnectionQrPayload')}</span>
                      <span className={`${css.configValue} ${css.configMono}`}>{connection.prompt.qr.uri}</span>
                    </div>
                  )}
                  <div className={css.configRow}>
                    <span className={css.configLabel}>{t('clueConnectionExpires')}</span>
                    <span className={css.configValue}>{new Date(connection.prompt.expiresAt).toLocaleString()}</span>
                  </div>
                  {connection.prompt.instructions !== undefined && (
                    <p className={css.configHint}>{connection.prompt.instructions}</p>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      )}
    </div>
  )
}
