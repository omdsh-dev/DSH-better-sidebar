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
 * Rules enforced here (approved S8 spec §4, amended by the UX pass for
 * device-code auto-check):
 * - a status read happens only because the user opened this page or pressed
 *   re-check; nothing auto-logs-in, auto-configures or requests a business
 *   operation (the "detect" path never runs a dry-run or a login);
 * - the ONE exception is an authorization attempt this page itself started:
 *   while it is authorizing the page re-sends the same explicit device-code
 *   poll at the CLI's suggested cadence (visibility-gated, bounded), because
 *   the human approves in a browser tab and this row is the only place that
 *   can notice. The runtime still schedules nothing; a hidden page and a
 *   terminal answer both stop it;
 * - installing a CLI and authorizing a source connection are separate actions;
 * - failures are retried in place and never discard the surrounding settings;
 * - only S2's sanitized projection fields are rendered: no token, raw stdout,
 *   stderr, environment value or secret file content, even if a DTO smuggles
 *   an extra field in.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { encode as encodeQr } from 'uqr'
import { t, type CopyKey } from '../../locales.ts'
import { clueRuntimeApi, type ClueRuntimeApi } from '../runtime-api.ts'
import { LoadingIndicator } from '../../ui/LoadingIndicator.tsx'
import { ActionButton, Checkbox, Disclosure, FactRow, Notice, TextInput } from '../../ui/index.ts'
import {
  publishClueStatuses,
  publishClueTask,
  subscribeClueRuntime,
} from './runtime-state.ts'
import { subscribeInstallPolling } from './install-polling.ts'
import type {
  ConnectionStatusProjection,
  DependencyInstallActionId,
  DependencyInstallPlan,
  DependencyInstallTask,
  DependencyStatus,
  DependencyState,
} from '../../../clues/runtime/types.ts'
import type { ClueSourceStatusKind } from './status.ts'
import type { CluePermissionPreferences } from './permission-preferences.ts'
import { CLUE_SOURCE_STATUS_COPY } from './copy.ts'
import css from './settings.module.css'

/** UI labels are human permissions; provider ids never appear as checkbox text. */
const PERMISSION_COPY: Readonly<Record<string, CopyKey>> = {
  'docs.read': 'clueAuthPermissionDocsRead',
  'docs.search': 'clueAuthPermissionDocsSearch',
  'docs.edit': 'clueAuthPermissionDocsEdit',
  'wiki.read': 'clueAuthPermissionWikiRead',
  'tasks.read': 'clueAuthPermissionTasksRead',
  'tasks.edit': 'clueAuthPermissionTasksEdit',
  'docs.comments.read': 'clueAuthPermissionDocsCommentsRead',
  'docs.comments.write': 'clueAuthPermissionDocsCommentsWrite',
  'tasks.comments.read': 'clueAuthPermissionTasksCommentsRead',
  'tasks.comments.write': 'clueAuthPermissionTasksCommentsWrite',
  'people.read': 'clueAuthPermissionPeopleRead',
}

/** Props of the configuration page (S6 window content). */
interface SourceConfigPageProps {
  readonly sourceId: string
  readonly sourceName: string
  readonly dependencyIds: readonly string[]
  readonly connectionId?: string
  readonly permissionPreferences?: CluePermissionPreferences
  /**
   * One-shot intent supplied by a USER-CLICKED entry point (the browser's
   * install CTA). After the first completed status read, the page generates
   * the install plan for the first missing/incompatible dependency. The plan
   * is still only a proposal: starting the install keeps its explicit
   * confirmation step. A regular settings open omits this and performs no
   * automatic plan.
   */
  readonly initialAction?: 'install'
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

/**
 * How many times one post-install re-read may be repeated after a fresher
 * observation of the same dependency superseded it. Bounded so two windows
 * observing each other's probes can never livelock this page.
 */
const MAX_RELOAD_ATTEMPTS = 3

/**
 * Device-code auto-check cadence. The CLI's own hint wins inside a sane band
 * (a 0/absent hint must not spin, a 10-minute hint must not look dead); the
 * default is the GitHub device flow's documented 5 s.
 */
const AUTO_POLL_DEFAULT_MS = 5_000
const AUTO_POLL_MIN_MS = 1_000
const AUTO_POLL_MAX_MS = 30_000
/** Consecutive auto-check failures before the page falls back to the button. */
const MAX_AUTO_POLL_FAILURES = 3

/** Resolve the interval for one authorizing attempt's suggested cadence. */
function autoPollInterval(prompt: ConnectionStatusProjection['prompt']): number {
  const suggested = prompt?.pollAfterMs
  if (suggested === undefined || !Number.isFinite(suggested)) return AUTO_POLL_DEFAULT_MS
  return Math.min(AUTO_POLL_MAX_MS, Math.max(AUTO_POLL_MIN_MS, suggested))
}

/** Copy key per install distribution kind. */
const DISTRIBUTION_COPY: Record<DependencyInstallPlan['distribution']['kind'], CopyKey> = {
  archive: 'clueDistributionArchive',
  npm: 'clueDistributionNpm',
  none: 'clueDistributionNone',
}

/** The configuration-state copy shared by the normal and stale rows. */
function configurationCopy(state: ConnectionStatusProjection['configuration']): string {
  switch (state) {
    case 'missing':
      return t('clueStateNotConfigured')
    case 'not-required':
      return '—'
    case 'ready':
      return t('clueStateReady')
    case 'unknown':
      return t('clueStateUnchecked')
  }
}

/** The authorization button copy for each S2 action. */
const CONNECTION_ACTION_COPY = {
  connect: 'clueConnectionAuthorize',
  reconnect: 'clueConnectionReconnect',
  'grant-scope': 'clueConnectionGrantScope',
  configure: 'clueConfigure',
} as const

/**
 * The authorization-state copy. A `Record` over the whole union (not a chain
 * of comparisons ending in a catch-all): adding a state to S2's contract is a
 * compile error here instead of being silently rendered as "not configured".
 */
const CONNECTION_AUTHORIZATION_COPY: Record<ConnectionStatusProjection['authorization'], CopyKey> = {
  ready: 'clueStateReady',
  expired: 'clueStateAuthExpired',
  authorizing: 'clueStateAuthorizing',
  denied: 'clueConnectionDenied',
  'scope-insufficient': 'clueConnectionScope',
  'not-authorized': 'clueStateNotAuthorized',
  unknown: 'clueStateUnchecked',
}

/** One user-readable failure line (sanitized message only). */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether a path is absolute in either host dialect (client is node-free). */
function isAbsoluteHostPath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path)
}

/**
 * A dependency value cell's fallback. "Not installed" is only a claim the DTO
 * actually supports (`state === 'missing'`); before an observation completes,
 * or when a probe failed without a DTO, the honest value is the unchecked
 * placeholder, never a fabricated missing install.
 */
function missingDependencyValue(current: DependencyStatus | undefined): string {
  if (current === undefined) return t('clueStateUnchecked')
  return current.state === 'missing' ? t('clueDependencyNotInstalled') : '—'
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

/**
 * Merge one status read into the last known list. A failed probe returns no
 * DTO for its dependency; dropping the previous row would lose the last
 * observation (path/version) and make a transient failure look like an empty
 * install. Untouched rows keep their identity; new rows append.
 */
function mergeDependencies(
  current: readonly DependencyStatus[] | null,
  next: readonly DependencyStatus[],
): DependencyStatus[] {
  const base = current ?? []
  const nextById = new Map(next.map(item => [item.dependencyId, item]))
  const merged = base.map(item => nextById.get(item.dependencyId) ?? item)
  const seen = new Set(base.map(item => item.dependencyId))
  for (const item of next) {
    if (!seen.has(item.dependencyId)) merged.push(item)
  }
  return merged
}

/** Compact actions share the host button semantics and theme. */
function Action(props: {
  label: string
  onClick: () => void
  disabled?: boolean
  primary?: boolean
}) {
  return (
    <ActionButton
      variant={props.primary ? 'primary' : 'outline'}
      type="button"
      className={css.smallButton}
      disabled={props.disabled === true}
      onClick={props.onClick}
    >
      {props.label}
    </ActionButton>
  )
}

/**
 * Render the source configuration page.
 * @param props - source identity/needs plus the injectable runtime wrapper.
 */
export function SourceConfigPage(props: SourceConfigPageProps) {
  const { sourceId, sourceName, dependencyIds, connectionId, initialAction } = props
  const runtime = props.runtime ?? clueRuntimeApi
  const ids = useMemo(() => [...dependencyIds], [dependencyIds])

  const [dependencies, setDependencies] = useState<readonly DependencyStatus[] | null>(null)
  const [connections, setConnections] = useState<readonly ConnectionStatusProjection[] | null>(null)
  /** The first status read (the one that can license `initialAction`) settled. */
  const [initialReadDone, setInitialReadDone] = useState(false)
  // Page-level alert: explicit status READ failures only. Action failures are
  // rendered on the row that owns the action (S8 spec §7).
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [failedIds, setFailedIds] = useState<Record<string, true>>({})
  const [plans, setPlans] = useState<Record<string, DependencyInstallPlan>>({})
  const [tasks, setTasks] = useState<Record<string, DependencyInstallTask>>({})
  /** Dependencies being re-probed after a settled install (show unchecked). */
  const [probingIds, setProbingIds] = useState<Record<string, true>>({})
  const [planningId, setPlanningId] = useState<string | null>(null)
  const [pathDrafts, setPathDrafts] = useState<Record<string, string>>({})
  const [pathErrors, setPathErrors] = useState<Record<string, string>>({})
  /** Per-dependency ACTION failures (plan/start/cancel/clear). */
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  /** Per-dependency POLL failures — a separate channel so a recovered poll
   *  clears only its own transient error, never a plan/start/cancel failure. */
  const [pollErrors, setPollErrors] = useState<Record<string, string>>({})
  const [connecting, setConnecting] = useState(false)
  /** Consecutive device-code auto-check failures (0 while the loop is healthy). */
  const [autoPollFailures, setAutoPollFailures] = useState(0)
  const [selectedPermissions, setSelectedPermissions] = useState<readonly string[]>(() =>
    sourceId === 'builtin.feishu.tasks' ? ['tasks.read', 'tasks.comments.read'] : ['docs.read', 'docs.search', 'docs.comments.read'])
  const [permissionPreferencesLoading, setPermissionPreferencesLoading] = useState(
    props.permissionPreferences !== undefined && connectionId !== undefined,
  )
  const [permissionPreferencesError, setPermissionPreferencesError] = useState<string | null>(null)
  const permissionPreferencesRequestRef = useRef<string | null>(null)
  const permissionPreferencesWriteRef = useRef(0)
  /** In-flight start/cancel per dependency (double-click protection + UI gate). */
  const [installBusy, setInstallBusy] = useState<Record<string, 'starting' | 'cancelling'>>({})
  /** A connection action (authorize/check/cancel) failed; shown in its section. */
  const [connectionActionError, setConnectionActionError] = useState<string | null>(null)
  /** The last connection read failed: the row must not claim "not configured". */
  const [connectionReadFailed, setConnectionReadFailed] = useState(false)
  const mounted = useRef(true)
  const tasksRef = useRef(tasks)
  // Overlapping explicit reads (mount + a fast Recheck click) must not let the
  // older answer overwrite the newer one.
  const loadRequestRef = useRef(0)
  // A user action mutates the projection; a read that was in flight (or one
  // that starts while the action is pending) must not apply its older answer
  // afterwards. Bumping on both sides of the action fences both directions.
  const writeEpochRef = useRef(0)
  // Another view of the same runtime published a FRESH observation. A read
  // that started before it is stale for the ids it actually carries: it must
  // not apply its older answer nor publish it back to the other view (the
  // cross-window "old read overwrites new observation" race). Generations are
  // scoped per dependency and per connection — an observation of an UNRELATED
  // dependency (another window, another source) is NOT a fresher answer for
  // anything this page reads and must not cancel its in-flight read.
  const dependencyGenerationsRef = useRef(new Map<string, number>())
  const connectionGenerationRef = useRef(0)
  // The currently in-flight explicit read, aborted when a newer read starts
  // or the window closes (S9 §6: closing a floating window releases requests).
  const loadAbortRef = useRef<AbortController | null>(null)
  // The mount status read. A write clicked while it is still in flight must
  // not cancel it (the read also covers the connection and every sibling
  // dependency); the click waits for it instead.
  const initialStatusReadRef = useRef<Promise<void> | null>(null)
  // Serial post-install re-read queue. Two tasks settling in the SAME tick are
  // two dependencies: each re-read used to fence the page with its own
  // mutation epoch, so the first settled one invalidated the second and that
  // dependency stayed on its pre-install badge/path. Re-reads therefore run
  // one batch at a time, and a batch's mutation fence never overlaps another
  // batch.
  const reloadQueueRef = useRef<string[]>([])
  const reloadQueuedRef = useRef(new Set<string>())
  const reloadRunningRef = useRef(false)
  // One mount-lifetime signal for every other request (plan/start/cancel/
  // path/connect/poll): closing the S6 window aborts all of them, not just the
  // explicit status read.
  const lifecycleAbortRef = useRef<AbortController | null>(null)
  // Synchronous double-click guard; React state alone would let two clicks in
  // one tick past the disabled attribute.
  const installBusyRef = useRef(new Map<string, 'starting' | 'cancelling'>())
  /** The user-clicked install intent was consumed (never replays on re-read). */
  const autoPlanRef = useRef(false)
  useEffect(() => { tasksRef.current = tasks }, [tasks])
  useEffect(() => {
    mounted.current = true
    const lifecycle = new AbortController()
    lifecycleAbortRef.current = lifecycle
    return () => {
      mounted.current = false
      lifecycle.abort()
      loadAbortRef.current?.abort()
    }
  }, [])

  /** Show a sanitized failure on one dependency row (never the page banner). */
  const failRow = useCallback((dependencyId: string, caught: unknown): void => {
    setRowErrors(current => ({ ...current, [dependencyId]: messageOf(caught) }))
  }, [])

  /** Clear one dependency row's action/poll failure. */
  const clearRowError = useCallback((dependencyId: string): void => {
    setRowErrors(current => {
      if (current[dependencyId] === undefined) return current
      const next = { ...current }
      delete next[dependencyId]
      return next
    })
  }, [])

  /** Show a manual-path failure under that dependency's path input. */
  const failPath = (dependencyId: string, message: string): void => {
    setPathErrors(current => ({ ...current, [dependencyId]: message }))
  }

  /** Clear one dependency's manual-path failure. */
  const clearPathError = (dependencyId: string): void => {
    setPathErrors(current => {
      if (current[dependencyId] === undefined) return current
      const next = { ...current }
      delete next[dependencyId]
      return next
    })
  }

  /** Drop one dependency from `failedIds` (a later observation succeeded). */
  const clearFailedDependency = (dependencyId: string): void => {
    setFailedIds(current => {
      if (current[dependencyId] === undefined) return current
      const next = { ...current }
      delete next[dependencyId]
      return next
    })
  }

  /** Clear one dependency's transient POLL failure (never an action error). */
  const clearPollError = useCallback((dependencyId: string): void => {
    setPollErrors(current => {
      if (current[dependencyId] === undefined) return current
      const next = { ...current }
      delete next[dependencyId]
      return next
    })
  }, [])

  /** Current freshness token of one dependency. */
  const dependencyGeneration = useCallback((dependencyId: string): number =>
    dependencyGenerationsRef.current.get(dependencyId) ?? 0, [])

  /** Snapshot the freshness tokens of every dependency this page reads. */
  const snapshotGenerations = useCallback((dependencyIds: readonly string[]): Map<string, number> =>
    new Map(dependencyIds.map(dependencyId => [dependencyId, dependencyGeneration(dependencyId)])), [dependencyGeneration])

  /** Whether no relevant observation arrived since the snapshot. */
  const generationsCurrent = useCallback((snapshot: ReadonlyMap<string, number>): boolean => {
    for (const [dependencyId, generation] of snapshot) {
      if (dependencyGeneration(dependencyId) !== generation) return false
    }
    return true
  }, [dependencyGeneration])

  /**
   * Fence an in-flight read around one user action: the old read loses, and a
   * read that starts while the action is pending loses too (the epoch bumps
   * again in {@link endMutation}).
   */
  const beginMutation = useCallback((): void => {
    writeEpochRef.current += 1
    loadRequestRef.current += 1
    setRefreshing(false)
  }, [])

  /** Close the fence after the action settles (or fails). */
  const endMutation = useCallback((): void => {
    writeEpochRef.current += 1
  }, [])

  /** Explicit status read. `refreshProbes` bypasses S2's probe cache. */
  const loadAll = useCallback(async (refreshProbes: boolean): Promise<void> => {
    const request = loadRequestRef.current + 1
    loadRequestRef.current = request
    const epoch = writeEpochRef.current
    // Freshness is tracked PER TARGET. A fresh observation of one dependency
    // must not discard the connection projection (or a sibling dependency's
    // answer) that the same aggregate read carries: only superseded fields are
    // dropped, everything else still lands.
    const generation = snapshotGenerations(ids)
    const connectionGeneration = connectionGenerationRef.current
    const controller = new AbortController()
    loadAbortRef.current?.abort()
    loadAbortRef.current = controller
    const requestIsCurrent = (): boolean =>
      mounted.current
      && !controller.signal.aborted
      && request === loadRequestRef.current
      && epoch === writeEpochRef.current
    setRefreshing(true)
    setError(null)
    // A fresh explicit read supersedes the previous action failure it retries.
    setConnectionActionError(null)
    const failures: Record<string, string> = {}
    try {
      const nextDependencies = await Promise.all(ids.map(async (dependencyId): Promise<DependencyStatus | undefined> => {
        try {
          const list = await runtime.dependenciesInspect(
            refreshProbes ? { dependencyId, refresh: true } : { dependencyId },
            controller.signal,
          )
          return list.find(item => item.dependencyId === dependencyId) ?? list[0]
        } catch (caught) {
          failures[dependencyId] = messageOf(caught)
          return undefined
        }
      }))
      const succeededDependencies = nextDependencies.filter((item): item is DependencyStatus => item !== undefined)
      let nextConnection: ConnectionStatusProjection | undefined
      let connectionFailed = false
      let connectionError: string | undefined
      if (connectionId !== undefined) {
        try {
          const list = await runtime.connectionsStatus(connectionId, controller.signal, refreshProbes)
          nextConnection = list.find(item => item.connectionId === connectionId) ?? list[0]
        } catch (caught) {
          connectionFailed = true
          connectionError = messageOf(caught)
        }
      }
      if (!requestIsCurrent()) return
      const superseded = new Set(ids.filter(dependencyId =>
        dependencyGeneration(dependencyId) !== (generation.get(dependencyId) ?? 0)))
      const freshDependencies = succeededDependencies.filter(item => !superseded.has(item.dependencyId))
      const connectionSuperseded = connectionGeneration !== connectionGenerationRef.current
      const freshFailures: Record<string, true> = {}
      let dependencyError: string | undefined
      for (const [dependencyId, message] of Object.entries(failures)) {
        if (superseded.has(dependencyId)) continue
        freshFailures[dependencyId] = true
        dependencyError = message
      }
      if (dependencyError !== undefined) setError(dependencyError)
      if (!connectionSuperseded && connectionError !== undefined) setError(connectionError)
      // Merge, not replace: a failed probe has no DTO and must not erase the
      // last observed path/version. The row shows request-failed meanwhile.
      setDependencies(current => mergeDependencies(current, freshDependencies))
      setFailedIds(freshFailures)
      // An explicit read is the retry path for plan/start/poll failures too.
      setRowErrors({})
      setPollErrors({})
      if (!connectionSuperseded) {
        if (!connectionFailed) {
          setConnections(nextConnection === undefined ? [] : [nextConnection])
          setConnectionReadFailed(false)
        } else {
          // Keep the last successful projection; the retryable failure is
          // reported explicitly instead of pretending "not configured".
          setConnectionReadFailed(true)
        }
      }
      publishClueStatuses(
        runtime,
        freshDependencies,
        connectionSuperseded || connectionFailed || nextConnection === undefined ? [] : [nextConnection],
      )
      // The publish above is itself a bus notification (this window's own
      // listener bumps the generation), so the task-adoption step captures a
      // FRESH token afterwards: only an observation arriving while the status
      // call is in flight may invalidate the adoption.
      if (ids.length > 0) {
        const taskRequest = loadRequestRef.current
        const taskEpoch = writeEpochRef.current
        const taskGeneration = snapshotGenerations(ids)
        const taskIsCurrent = (): boolean =>
          mounted.current
          && !controller.signal.aborted
          && taskRequest === loadRequestRef.current
          && taskEpoch === writeEpochRef.current
          && generationsCurrent(taskGeneration)
        try {
          const latest = await runtime.dependenciesStatus(undefined, controller.signal)
          if (!taskIsCurrent()) return
          const running = latest.filter(task => task.state === 'running' && ids.includes(task.dependencyId))
          if (running.length > 0) {
            setTasks(current => {
              const next = { ...current }
              for (const task of running) next[task.dependencyId] = task
              return next
            })
            for (const task of running) publishClueTask(runtime, task)
          }
        } catch (caught) {
          if (taskIsCurrent()) setError(messageOf(caught))
        }
      }
    } finally {
      // Request/mount liveness only: the generation was (correctly) bumped by
      // this read's own publish, so it must not keep the spinner on forever.
      if (mounted.current && request === loadRequestRef.current) setRefreshing(false)
    }
  }, [runtime, ids, connectionId, snapshotGenerations, dependencyGeneration, generationsCurrent])

  useEffect(() => {
    // Track (and clear) the mount status read: a write clicked before it
    // settles waits for it instead of cancelling the only read that carries
    // the connection projection and the sibling dependencies.
    const read = loadAll(false).catch(() => {
      // loadAll already surfaces its per-request failures; this catch only
      // keeps a rejected read from becoming an unhandled rejection.
    })
    initialStatusReadRef.current = read
    void read.then(() => {
      if (initialStatusReadRef.current === read) initialStatusReadRef.current = null
      if (mounted.current) setInitialReadDone(true)
    })
  }, [loadAll])

  /**
   * Re-read a batch of dependencies after settled tasks / manual path writes.
   *
   * One batch = one mutation fence: every dependency a settled tick reports is
   * read before the fence closes. A dependency whose probe is superseded by a
   * fresher observation of THAT dependency is read again (bounded), because
   * the replacing observation may be the other window's pre-install answer;
   * an unrelated dependency's observation never invalidates this batch.
   */
  const reloadBatch = useCallback(async (batch: readonly string[]): Promise<void> => {
    beginMutation()
    const epoch = writeEpochRef.current
    // The pre-install DTO is no longer the answer: hold every batch member
    // unchecked until its probe completes (S2 §6.3: only a passing probe may
    // be ready).
    setProbingIds(current => {
      const next = { ...current }
      for (const dependencyId of batch) next[dependencyId] = true
      return next
    })
    const pending = new Set(batch)
    try {
      for (let attempt = 0; attempt < MAX_RELOAD_ATTEMPTS && pending.size > 0; attempt += 1) {
        if (!mounted.current) return
        const reading = [...pending]
        const generation = snapshotGenerations(reading)
        const results: DependencyStatus[] = []
        for (const dependencyId of reading) {
          try {
            const list = await runtime.dependenciesInspect({ dependencyId, refresh: true }, lifecycleAbortRef.current?.signal)
            if (!mounted.current) return
            const next = list.find(item => item.dependencyId === dependencyId)
            if (next !== undefined) results.push(next)
          } catch (caught) {
            if (!mounted.current) return
            // The refresh failed: keep the last observed path/version, but do
            // not swallow the retryable reason — the row says request-failed
            // and carries the sanitized message until a later read succeeds.
            setFailedIds(current => ({ ...current, [dependencyId]: true }))
            setPollErrors(current => ({ ...current, [dependencyId]: messageOf(caught) }))
          }
        }
        if (!mounted.current) return
        // A user action fenced the page while probing: its own write is the
        // fresher answer for this batch, so the re-read is dropped.
        if (epoch !== writeEpochRef.current) return
        const superseded = new Set(reading.filter(dependencyId =>
          dependencyGeneration(dependencyId) !== (generation.get(dependencyId) ?? 0)))
        const applied = results.filter(item => !superseded.has(item.dependencyId))
        if (applied.length > 0 && mounted.current) {
          setDependencies(current => {
            let next = current ?? []
            for (const item of applied) next = replaceDependency(next, item)
            return next
          })
          setFailedIds(current => {
            let changed = false
            const next = { ...current }
            for (const item of applied) {
              if (next[item.dependencyId] !== undefined) {
                delete next[item.dependencyId]
                changed = true
              }
            }
            return changed ? next : current
          })
          for (const item of applied) clearPollError(item.dependencyId)
          publishClueStatuses(runtime, applied)
        }
        for (const dependencyId of reading) pending.delete(dependencyId)
        // A same-dependency observation replaced this probe's answer. Re-read
        // once more (bounded) so the page settles on a post-install DTO
        // instead of adopting the other window's older badge.
        if (attempt < MAX_RELOAD_ATTEMPTS - 1) {
          for (const dependencyId of superseded) pending.add(dependencyId)
        }
      }
    } finally {
      endMutation()
      if (mounted.current) {
        setProbingIds(current => {
          let changed = false
          const next = { ...current }
          for (const dependencyId of batch) {
            if (next[dependencyId] !== undefined) {
              delete next[dependencyId]
              changed = true
            }
          }
          return changed ? next : current
        })
      }
    }
  }, [runtime, beginMutation, endMutation, clearPollError, snapshotGenerations, dependencyGeneration])

  /**
   * Queue one dependency for a post-install re-read. Requests coalesce while
   * queued; batches run serially so a second settled install in the same tick
   * cannot be invalidated by the first batch's mutation epoch.
   */
  const requestReload = useCallback((dependencyId: string): void => {
    if (!mounted.current) return
    if (!reloadQueuedRef.current.has(dependencyId)) {
      reloadQueuedRef.current.add(dependencyId)
      reloadQueueRef.current.push(dependencyId)
    }
    if (reloadRunningRef.current) return
    reloadRunningRef.current = true
    void (async () => {
      try {
        while (mounted.current && reloadQueueRef.current.length > 0) {
          const batch = reloadQueueRef.current.splice(0)
          for (const id of batch) reloadQueuedRef.current.delete(id)
          try {
            await reloadBatch(batch)
          } catch {
            // One batch failing must not strand the rest of the queue; the
            // batch's own finally has released its fence and probing rows.
          }
        }
      } finally {
        reloadRunningRef.current = false
      }
    })()
  }, [reloadBatch])

  // Every running task is polled (not just one): two shared dependencies may
  // install at once. The loop is gated by `enabled` and teardown clears it —
  // no second recurring timer lives here.
  const runningKey = Object.values(tasks)
    .filter(item => item.state === 'running')
    .map(item => `${item.dependencyId}:${item.taskId}`)
    .sort()
    .join('|')
  // Install progress uses the ONE shared poller for this runtime face (see
  // install-polling.ts): two open configuration windows that show the same
  // dependency share one status request per tick instead of one per window.
  useEffect(() => {
    if (runningKey === '') return
    return subscribeInstallPolling(runtime, observation => {
      if (!mounted.current) return
      if (observation.error !== undefined) {
        // The status route failed. Attribute the transient failure to every
        // progress row this window is showing; the shared poller gives up
        // after three consecutive failures (Recheck re-discovers the task).
        const running = Object.values(tasksRef.current).filter(item => item.state === 'running')
        setPollErrors(current => {
          const next = { ...current }
          for (const task of running) next[task.dependencyId] = observation.error!
          return next
        })
        return
      }
      if (observation.gaveUp === true) {
        // Stop pretending progress is live; the row keeps the failure text.
        setTasks(current => {
          let changed = false
          const next = { ...current }
          for (const [dependencyId, task] of Object.entries(next)) {
            if (task.state !== 'running') continue
            delete next[dependencyId]
            changed = true
          }
          return changed ? next : current
        })
        return
      }
      // A successful tick clears the transient poll failure it covered.
      setPollErrors(current => {
        let changed = false
        const next = { ...current }
        for (const task of Object.values(tasksRef.current)) {
          if (task.state === 'running' && next[task.dependencyId] !== undefined) {
            delete next[task.dependencyId]
            changed = true
          }
        }
        return changed ? next : current
      })
      const latest = new Map(observation.tasks.map(item => [item.taskId, item]))
      for (const local of Object.values(tasksRef.current)) {
        if (local.state !== 'running') continue
        const next = latest.get(local.taskId)
        if (next === undefined) {
          // The runtime no longer reports this task: drop the progress row and
          // re-read the dependency; Recheck can re-adopt a task that returns.
          setTasks(current => {
            if (current[local.dependencyId]?.taskId !== local.taskId) return current
            const copy = { ...current }
            delete copy[local.dependencyId]
            return copy
          })
          requestReload(local.dependencyId)
          continue
        }
        setTasks(current => {
          const existing = current[local.dependencyId]
          if (existing === undefined || existing.taskId !== next.taskId) return current
          if (existing.state === next.state
            && existing.progress === next.progress
            && existing.error === next.error) return current
          return { ...current, [local.dependencyId]: next }
        })
        if (next.state !== 'running') requestReload(local.dependencyId)
      }
    })
  }, [runtime, runningKey, requestReload])

  // Share observations with every other view of the same runtime and follow
  // theirs: the source table refreshes a badge and a second config window gets
  // the live task/prompt without a remount.
  useEffect(() => subscribeClueRuntime(runtime, observation => {
    if (!mounted.current) return
    if (observation.kind === 'statuses') {
      const nextDependencies = observation.dependencies.filter(item => ids.includes(item.dependencyId))
      const nextConnection = connectionId === undefined
        ? undefined
        : observation.connections.find(item => item.connectionId === connectionId)
      // An observation of another source's dependency/connection is NOT a
      // fresher answer for anything this page shows: it must neither overwrite
      // this page nor cancel a read that is still in flight.
      if (nextDependencies.length === 0 && nextConnection === undefined) return
      // A fresh observation supersedes an older read of the SAME ids only.
      for (const item of nextDependencies) {
        dependencyGenerationsRef.current.set(
          item.dependencyId,
          dependencyGeneration(item.dependencyId) + 1,
        )
      }
      if (nextConnection !== undefined) connectionGenerationRef.current += 1
      if (nextDependencies.length > 0) {
        setDependencies(current => mergeDependencies(current, nextDependencies))
        setFailedIds(current => {
          let changed = false
          const next = { ...current }
          for (const item of nextDependencies) {
            if (next[item.dependencyId] !== undefined) {
              delete next[item.dependencyId]
              changed = true
            }
          }
          return changed ? next : current
        })
      }
      if (nextConnection !== undefined) {
        setConnections(current => replaceConnection(current ?? [], nextConnection))
        setConnectionReadFailed(false)
      }
      return
    }
    const relevant = observation.tasks.filter(item => ids.includes(item.dependencyId))
    if (relevant.length === 0) return
    for (const task of relevant) {
      dependencyGenerationsRef.current.set(
        task.dependencyId,
        dependencyGeneration(task.dependencyId) + 1,
      )
    }
    setTasks(current => {
      let changed = false
      const next = { ...current }
      for (const task of relevant) {
        const existing = next[task.dependencyId]
        if (existing?.taskId !== task.taskId || existing.state !== task.state || existing.progress !== task.progress) {
          next[task.dependencyId] = task
          changed = true
        }
      }
      return changed ? next : current
    })
  }), [runtime, ids, connectionId, dependencyGeneration])

  const plan = useCallback(async (dependencyId: string): Promise<void> => {
    setPlanningId(dependencyId)
    clearRowError(dependencyId)
    try {
      const next = await runtime.dependenciesPlan(dependencyId, lifecycleAbortRef.current?.signal)
      if (!mounted.current) return
      setPlans(current => ({ ...current, [dependencyId]: next }))
    } catch (caught) {
      if (mounted.current) failRow(dependencyId, caught)
    } finally {
      if (mounted.current) setPlanningId(null)
    }
  }, [runtime, clearRowError, failRow])

  // One-shot install intent from a USER-CLICKED entry point (the browser's
  // install CTA). It can only PROPOSE a plan for the first missing/incompatible
  // dependency; the confirmation step and the install task pipeline stay
  // untouched. A regular settings open omits `initialAction`, so no automatic
  // plan ever runs there, and the guard consumes the intent exactly once.
  useEffect(() => {
    if (initialAction !== 'install' || !initialReadDone || autoPlanRef.current) return
    autoPlanRef.current = true
    const statuses = dependencies ?? []
    // Dependency id order is the page's declaration order, not the DTO arrival
    // order (a partial merge must not reshuffle which dependency is "first").
    const target = ids
      .map(dependencyId => statuses.find(status => status.dependencyId === dependencyId))
      .find(status => status !== undefined && (status.state === 'missing' || status.state === 'incompatible'))
    if (target === undefined) return
    if (plans[target.dependencyId] !== undefined || planningId === target.dependencyId) return
    if (installBusyRef.current.has(target.dependencyId)) return
    void plan(target.dependencyId)
  }, [initialAction, initialReadDone, dependencies, ids, plans, planningId, plan])

  /** Mark one install action in flight (synchronous ref + rendered state). */
  const setBusy = (dependencyId: string, kind: 'starting' | 'cancelling'): void => {
    installBusyRef.current.set(dependencyId, kind)
    setInstallBusy(current => ({ ...current, [dependencyId]: kind }))
  }

  /** Clear one install action's in-flight state. */
  const clearBusy = (dependencyId: string): void => {
    installBusyRef.current.delete(dependencyId)
    if (!mounted.current) return
    setInstallBusy(current => {
      if (current[dependencyId] === undefined) return current
      const next = { ...current }
      delete next[dependencyId]
      return next
    })
  }

  const startPlan = async (dependencyId: string): Promise<void> => {
    const current = plans[dependencyId]
    // The ref, not the state: two clicks in one React batch both see the
    // pre-render closure, and S2 rejects a duplicate start after the fact.
    if (current === undefined || installBusyRef.current.has(dependencyId)) return
    setBusy(dependencyId, 'starting')
    clearRowError(dependencyId)
    beginMutation()
    try {
      const next = await runtime.dependenciesStart(dependencyId, current.planId, lifecycleAbortRef.current?.signal)
      if (!mounted.current) return
      setTasks(state => ({ ...state, [dependencyId]: next }))
      publishClueTask(runtime, next)
      setPlans(state => {
        const copy = { ...state }
        delete copy[dependencyId]
        return copy
      })
    } catch (caught) {
      if (mounted.current) failRow(dependencyId, caught)
    } finally {
      clearBusy(dependencyId)
      endMutation()
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
    if (installBusyRef.current.has(task.dependencyId)) return
    setBusy(task.dependencyId, 'cancelling')
    clearRowError(task.dependencyId)
    beginMutation()
    let settled = false
    try {
      const next = await runtime.dependenciesCancel(task.dependencyId, task.taskId, lifecycleAbortRef.current?.signal)
      if (!mounted.current) return
      setTasks(current => ({ ...current, [task.dependencyId]: next }))
      publishClueTask(runtime, next)
      if (next.state !== 'running') {
        clearPollError(task.dependencyId)
        settled = true
      }
    } catch (caught) {
      if (mounted.current) failRow(task.dependencyId, caught)
    } finally {
      clearBusy(task.dependencyId)
      endMutation()
    }
    // The re-read runs AFTER this action's own fence closes: it takes its own
    // mutation fence, and the two must not invalidate each other.
    if (settled && mounted.current) requestReload(task.dependencyId)
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
    // The mount read also carries the connection projection and the sibling
    // dependencies: a click that lands before it settles waits for it instead
    // of cancelling it (a fresh write is still fenced against later reads).
    const initialRead = initialStatusReadRef.current
    if (initialRead !== null) await initialRead
    if (!mounted.current) return
    beginMutation()
    try {
      const next = await runtime.dependenciesSetPath(dependencyId, raw, lifecycleAbortRef.current?.signal)
      if (!mounted.current) return
      setDependencies(current => replaceDependency(current ?? [], next))
      publishClueStatuses(runtime, [next])
      // A successful write is a fresh observation: the old probe failure no
      // longer describes this dependency.
      clearFailedDependency(dependencyId)
      clearPollError(dependencyId)
    } catch (caught) {
      if (mounted.current) failPath(dependencyId, messageOf(caught))
    } finally {
      endMutation()
    }
  }

  const clearPath = async (dependencyId: string): Promise<void> => {
    clearPathError(dependencyId)
    const initialRead = initialStatusReadRef.current
    if (initialRead !== null) await initialRead
    if (!mounted.current) return
    beginMutation()
    try {
      const next = await runtime.dependenciesClearPath(dependencyId, lifecycleAbortRef.current?.signal)
      if (!mounted.current) return
      setDependencies(current => replaceDependency(current ?? [], next))
      publishClueStatuses(runtime, [next])
      clearFailedDependency(dependencyId)
      clearPollError(dependencyId)
    } catch (caught) {
      if (mounted.current) failPath(dependencyId, messageOf(caught))
    } finally {
      endMutation()
    }
  }

  const connection = connectionId === undefined
    ? undefined
    : (connections ?? []).find(item => item.connectionId === connectionId)
  const grantedCapabilities = connection?.grantedCapabilities ?? connection?.capabilities ?? []
  const selectableCapabilitiesKey = connection?.selectableCapabilities?.join('\u0000')

  useEffect(() => {
    const preferences = props.permissionPreferences
    if (connectionId === undefined || preferences === undefined
      || selectableCapabilitiesKey === undefined || permissionPreferencesRequestRef.current === connectionId) return
    permissionPreferencesRequestRef.current = connectionId
    const selectable = new Set(selectableCapabilitiesKey.split('\u0000'))
    let current = true
    void preferences.load(connectionId).then((saved) => {
      if (!current || saved === undefined) return
      setSelectedPermissions(saved.filter(capability => selectable.has(capability)))
    }).catch(() => {
      if (current) setPermissionPreferencesError(t('settingsSaveFailed'))
    }).finally(() => {
      if (current) setPermissionPreferencesLoading(false)
    })
    return () => { current = false }
  }, [connectionId, props.permissionPreferences, selectableCapabilitiesKey])

  const changePermission = (capability: string, checked: boolean): void => {
    const next = checked
      ? [...selectedPermissions, capability]
      : selectedPermissions.filter(value => value !== capability)
    setSelectedPermissions(next)
    setPermissionPreferencesError(null)
    if (connectionId === undefined || props.permissionPreferences === undefined) return
    const request = ++permissionPreferencesWriteRef.current
    void props.permissionPreferences.save(connectionId, next).then(() => {
      if (mounted.current && permissionPreferencesWriteRef.current === request) setPermissionPreferencesError(null)
    }).catch(() => {
      if (mounted.current && permissionPreferencesWriteRef.current === request) setPermissionPreferencesError(t('settingsSaveFailed'))
    })
  }

  // S4 §31: render the SAME opaque authorization URL as a QR code (the text
  // payload stays visible too). Encoding is pure; a payload too large or a
  // malformed URI simply falls back to the text row, never a broken SVG.
  const qr = useMemo(() => {
    const uri = connection?.prompt?.qr?.uri
    if (uri === undefined) return undefined
    try {
      return encodeQr(uri, { ecc: 'M', border: 2 })
    } catch {
      return undefined
    }
  }, [connection?.prompt?.qr?.uri])
  const qrPath = useMemo(() => {
    if (qr === undefined) return ''
    const parts: string[] = []
    qr.data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) parts.push(`M${x} ${y}h1v1h-1z`)
      })
    })
    return parts.join('')
  }, [qr])

  const connect = async (): Promise<void> => {
    if (connectionId === undefined) return
    const permissions = connection?.selectableCapabilities === undefined ? undefined
      : selectedPermissions.filter(capability => connection.selectableCapabilities!.includes(capability))
    if (permissions?.length === 0) { setConnectionActionError(t('clueAuthPermissionsEmpty')); return }
    setConnecting(true)
    setConnectionActionError(null)
    // A fresh attempt owns a fresh failure budget.
    setAutoPollFailures(0)
    beginMutation()
    try {
      const next = await runtime.connectionsConnect(connectionId, lifecycleAbortRef.current?.signal, permissions)
      if (!mounted.current) return
      setConnections(current => replaceConnection(current ?? [], next))
      setConnectionReadFailed(false)
      publishClueStatuses(runtime, [], [next])
    } catch (caught) {
      if (mounted.current) setConnectionActionError(messageOf(caught))
    } finally {
      endMutation()
      if (mounted.current) setConnecting(false)
    }
  }

  const pollConnection = useCallback(async (): Promise<void> => {
    if (connectionId === undefined) return
    setConnecting(true)
    setConnectionActionError(null)
    beginMutation()
    try {
      const next = await runtime.connectionsPoll(connectionId, lifecycleAbortRef.current?.signal)
      if (!mounted.current) return
      setConnections(current => replaceConnection(current ?? [], next))
      setConnectionReadFailed(false)
      setAutoPollFailures(0)
      publishClueStatuses(runtime, [], [next])
    } catch (caught) {
      if (mounted.current) {
        setConnectionActionError(messageOf(caught))
        setAutoPollFailures(current => current + 1)
      }
    } finally {
      endMutation()
      if (mounted.current) setConnecting(false)
    }
  }, [beginMutation, connectionId, endMutation, runtime])

  const cancelConnection = async (): Promise<void> => {
    if (connectionId === undefined) return
    setConnecting(true)
    setAutoPollFailures(0)
    setConnectionActionError(null)
    beginMutation()
    try {
      const next = await runtime.connectionsCancel(connectionId, lifecycleAbortRef.current?.signal)
      if (!mounted.current) return
      setConnections(current => replaceConnection(current ?? [], next))
      setConnectionReadFailed(false)
      publishClueStatuses(runtime, [], [next])
    } catch (caught) {
      if (mounted.current) setConnectionActionError(messageOf(caught))
    } finally {
      endMutation()
      if (mounted.current) setConnecting(false)
    }
  }

  // The attempt's suggested cadence, resolved once per projection: a primitive
  // instead of the prompt object keeps the timer from restarting on unrelated
  // re-renders of the same attempt.
  const autoPollDelay = connection?.authorization === 'authorizing'
    ? autoPollInterval(connection.prompt)
    : undefined

  /**
   * Device-code auto-check. The runtime still schedules nothing — this page
   * repeats the SAME explicit poll the button sends, at the CLI's own cadence,
   * only while its own attempt is authorizing. Everything that ends the wait
   * stops the timer: a terminal answer, Cancel, closing the window, a hidden
   * page, or MAX_AUTO_POLL_FAILURES consecutive failures. The manual
   * "I'm done — check status" button stays as the fallback.
   */
  useEffect(() => {
    if (connectionId === undefined || autoPollDelay === undefined || connecting) return
    if (autoPollFailures >= MAX_AUTO_POLL_FAILURES) return
    let timer: number | undefined
    let stopped = false
    const hidden = (): boolean => document.visibilityState === 'hidden'
    const clearTimer = (): void => {
      if (timer === undefined) return
      window.clearTimeout(timer)
      timer = undefined
    }
    const schedule = (): void => {
      if (stopped || hidden() || timer !== undefined) return
      timer = window.setTimeout(() => {
        timer = undefined
        if (stopped || hidden()) return
        void pollConnection()
      }, autoPollDelay)
    }
    // A background page must not spawn CLI polls; becoming visible again
    // re-arms instead of replaying the interval that was missed.
    const onVisibility = (): void => { if (hidden()) clearTimer(); else schedule() }
    schedule()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stopped = true
      clearTimer()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [autoPollDelay, autoPollFailures, connectionId, connecting, pollConnection])

  // Keep install recovery first; a usable CLI yields the first task to account access.
  const dependenciesNeedAttention = ids.some(id => {
    const dependency = dependencies?.find(item => item.dependencyId === id)
    return dependency?.state !== 'ready' || failedIds[id] === true
      || probingIds[id] === true || plans[id] !== undefined || tasks[id]?.state === 'running'
  })
  const dependencySection = ids.length > 0 ? (
    <section key="dependencies" className={css.configSection} aria-label={t('clueDependencyHeading')}>
      <h3 className={css.configHeading}>{t('clueDependencyHeading')}</h3>
      {ids.map(dependencyId => {
        const current = (dependencies ?? []).find(item => item.dependencyId === dependencyId)
        const currentPlan = plans[dependencyId]
        const currentTask = tasks[dependencyId]
        const installable = current?.installable === true
        const busy = installBusy[dependencyId]
        // A live install task is the freshest answer: the dependency DTO
        // read before the install started may still say ready/missing
        // until the post-install probe. Never show the pre-install badge
        // while the task is running (S2 §6.3 / S8 §3).
        const stateKind: ClueSourceStatusKind = currentTask?.state === 'running'
          ? 'installing'
          : probingIds[dependencyId] === true
            ? 'unchecked'
            : failedIds[dependencyId] === true
              ? 'request-failed'
              : current === undefined
                ? 'unchecked'
                : DEPENDENCY_STATE_COPY[current.state]
        return (
          <div key={dependencyId} className={css.dependencyBlock} data-clue-dependency={dependencyId}>
            <div className={css.dependencyHead}>
              <span className={css.dependencyIdentity}>
                <span className={css.dependencyName}>{current?.name ?? dependencyId}</span>
                <span className={css.status} data-kind={stateKind}>
                  {stateKind === 'installing' || probingIds[dependencyId] === true
                    ? <LoadingIndicator inline label={t(CLUE_SOURCE_STATUS_COPY[stateKind])} />
                    : t(CLUE_SOURCE_STATUS_COPY[stateKind])}
                </span>
              </span>
              <div className={css.configActions}>
                <Action
                  label={t('clueDependencyInstall')}
                  primary={stateKind === 'missing' || stateKind === 'incompatible'}
                  // A live task (or an in-flight start/cancel) already owns
                  // this dependency: a second install must not be startable
                  // from a pre-install row while the first one runs.
                  disabled={!installable
                    || currentPlan !== undefined
                    || planningId === dependencyId
                    || currentTask?.state === 'running'
                    || busy !== undefined}
                  onClick={() => { void plan(dependencyId) }}
                />
                <Action
                  label={t('clueDependencyRecheck')}
                  disabled={refreshing}
                  onClick={() => { void loadAll(true) }}
                />
                {currentTask !== undefined && currentTask.state === 'running' && (
                  <Action
                    label={t('clueDependencyInstallCancel')}
                    disabled={busy !== undefined}
                    onClick={() => { void cancelInstall(currentTask) }}
                  />
                )}
              </div>
            </div>
            {current?.error !== undefined && (
              <p className={css.configError} data-clue-dependency-error={dependencyId}>
                {current.error.message}
              </p>
            )}

            {/* Diagnostics are secondary to the state + action above: the
                executable path, parsed version, compatibility contract and
                the manual override live behind one native disclosure. The
                install task/plan pipeline is unaffected by this grouping. */}
            <Disclosure
              className={css.advanced}
              bodyClassName={css.advancedBody}
              data-clue-dependency-details={dependencyId}
              summary={`${t('clueDependencyActualPath')} · ${t('clueDependencyVersion')}`}
              meta={current?.manualPath !== undefined ? t('clueDependencyManualPath') : undefined}
            >
                <FactRow label={t('clueDependencyActualPath')} mono
                  value={current?.executablePath ?? missingDependencyValue(current)} />
                <FactRow label={t('clueDependencyVersion')} mono
                  value={current?.version ?? missingDependencyValue(current)} />
                {current !== undefined && (
                  <FactRow label={t('clueDependencyCompat')} value={t('clueDependencyRequirement', {
                    minimum: current.minimumVersion,
                    recommended: current.recommendedVersion,
                  })} />
                )}
                {current?.manualPath !== undefined && (
                  <FactRow label={t('clueDependencyManualPath')} mono value={current.manualPath}
                    action={<Action label={t('clueDependencyClearPath')} onClick={() => { void clearPath(dependencyId) }} />} />
                )}
                <div className={css.configInputRow}>
                  <TextInput
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
                  <p className={css.configError} role="alert" data-clue-path-error={dependencyId}>
                    {pathErrors[dependencyId]}
                  </p>
                )}
            </Disclosure>
            {rowErrors[dependencyId] !== undefined && (
              <p
                className={css.configError}
                role="alert"
                data-clue-dependency-action-error={dependencyId}
              >
                {rowErrors[dependencyId]}
              </p>
            )}
            {pollErrors[dependencyId] !== undefined && (
              <p
                className={css.configError}
                role="alert"
                data-clue-poll-error={dependencyId}
              >
                {pollErrors[dependencyId]}
              </p>
            )}

            {!installable && current !== undefined && (
              <>
                <p className={css.configHint}>{t('clueDependencyInstallUnavailable')}</p>
                {current.manualInstall !== undefined && (
                  <FactRow label={t('clueDependencyManualInstall')} value={<>
                    {current.manualInstall.instructions}
                    {current.manualInstall.url !== undefined && (
                      <>
                        {' '}
                        <a className={css.authLink} href={current.manualInstall.url} target="_blank" rel="noreferrer">
                          {current.manualInstall.url}
                        </a>
                      </>
                    )}
                  </>} />
                )}
              </>
            )}
            {current?.state === 'installing' && current.installation !== undefined && currentTask === undefined && (
              <FactRow label={t('clueDependencyInstall')} value={current.installation.stage === undefined
                ? t('clueStateInstalling')
                : t(STAGE_COPY[current.installation.stage])} />
            )}

            {currentPlan !== undefined && (
              <div className={css.plan} data-clue-plan={currentPlan.planId}>
                <FactRow value={t('clueDependencyPlanTitle', { name: currentPlan.name, version: currentPlan.version })} />
                <FactRow value={t('clueDependencyPlanTarget', { path: currentPlan.targetDir })} />
                {/* S2 §6.1: confirm the exact asset being installed --
                    platform/arch, distribution source+kind, the PATH copy
                    that will be left untouched, and the plan's expiry. */}
                <FactRow label={t('clueDependencyPlanPlatform')} mono value={`${currentPlan.platform} / ${currentPlan.arch}`} />
                <FactRow label={t('clueDependencyPlanDistribution')}
                  value={`${currentPlan.distribution.source} · ${t(DISTRIBUTION_COPY[currentPlan.distribution.kind])}`} />
                <p className={css.configHint}>
                  {t('clueDependencyPlanExpires', { time: new Date(currentPlan.expiresAt).toLocaleString() })}
                </p>
                {!currentPlan.installable && (
                  <p className={css.configHint}>
                    {t('clueDependencyInstallUnavailable')}
                    {currentPlan.unavailableReason === undefined
                      ? ''
                      : ` — ${currentPlan.unavailableReason}`}
                  </p>
                )}
                {/* The confirm decision stays on the main surface (version,
                    target, distribution, platform, expiry). The ordered
                    steps and the existing PATH copy are reference material,
                    so they fold behind one disclosure. */}
                <Disclosure
                  className={css.planDetails}
                  bodyClassName={css.advancedBody}
                  data-clue-plan-details=""
                  summary={t('taskWindowDetail')}
                >
                  <ul className={css.planActions}>
                    {currentPlan.actionIds.map((action, index) => (
                      <li key={`${action}:${index}`}>
                        {t(ACTION_COPY[action])}
                      </li>
                    ))}
                  </ul>
                  <FactRow label={t('clueDependencyPlanSystemInstall')} value={currentPlan.systemInstall === undefined
                    ? t('clueDependencyPlanSystemInstallNone')
                    : (
                      <>
                        <span className={css.configMono}>{currentPlan.systemInstall.executablePath}</span>
                        {currentPlan.systemInstall.version === undefined
                          ? ''
                          : ` · ${currentPlan.systemInstall.version}`}
                        {' · '}
                        {currentPlan.systemInstall.compatible
                          ? t('clueDependencyPlanSystemInstallCompatible')
                          : t('clueDependencyPlanSystemInstallIncompatible')}
                      </>
                    )} />
                </Disclosure>
                <div className={css.configActions}>
                  <Action
                    label={t('cancel')}
                    disabled={busy !== undefined}
                    onClick={() => { cancelPlan(dependencyId) }}
                  />
                  {currentPlan.installable && (
                    <Action
                      label={t('clueDependencyPlanConfirm')}
                      primary
                      disabled={busy !== undefined}
                      onClick={() => { void startPlan(dependencyId) }}
                    />
                  )}
                </div>
              </div>
            )}

            {currentTask !== undefined && currentTask.state !== 'running' && (
              <FactRow data-clue-task={currentTask.taskId} label={t('clueDependencyInstall')} value={<>
                {currentTask.state === 'succeeded'
                  ? t('tasksStateDone')
                  : currentTask.state === 'cancelled'
                    ? t('clueDependencyInstallCancelled')
                    : t('clueDependencyInstallFailed')}
                {currentTask.error !== undefined && ` — ${currentTask.error.message}`}
              </>} />
            )}

            {currentTask !== undefined && currentTask.state === 'running' && currentTask.progress !== undefined && (
              <div data-clue-progress={currentTask.taskId}>
                <div
                  className={css.progressTrack}
                  role="progressbar"
                  aria-label={t('clueDependencyInstall')}
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
  ) : null

  const connectionSection = connectionId !== undefined ? (
    <section key="connection" className={css.configSection} aria-label={t('clueConnectionHeading')}>
      <h3 className={css.configHeading}>{t('clueConnectionHeading')}</h3>
      {connections === null && !connectionReadFailed ? (
        // The first explicit read is still in flight. "Not configured" is
        // a terminal verdict this page has not earned yet (the table's
        // `checked` rule, applied here too).
        <FactRow label={t('clueConnectionAuthorization')}
          value={<span className={css.status} data-kind="unchecked">{t(CLUE_SOURCE_STATUS_COPY.unchecked)}</span>} />
      ) : connection === undefined ? (
        // A failed read is NOT "this source was never configured": the
        // distinction is the whole point of the status surface.
        <FactRow label={t('clueConnectionAuthorization')} value={
          <span className={css.status} data-kind={connectionReadFailed ? 'request-failed' : 'not-configured'}>
            {t(connectionReadFailed
              ? CLUE_SOURCE_STATUS_COPY['request-failed']
              : CLUE_SOURCE_STATUS_COPY['not-configured'])}
          </span>
        } />
      ) : (
        <>

          {/* A failed re-read marks the row itself, even when a previous
              projection is still on screen: the old "Ready" is not the answer. */}
          <FactRow data-stale={connectionReadFailed ? 'true' : undefined} label={t('clueConnectionAuthorization')}
            value={connectionReadFailed
              ? <span className={css.status} data-kind="request-failed">{t(CLUE_SOURCE_STATUS_COPY['request-failed'])}</span>
              : <span data-authorization={connection.authorization}>{t(CONNECTION_AUTHORIZATION_COPY[connection.authorization])}</span>} />
          {connection.account !== undefined && (
            <FactRow label={t('clueConnectionAccount')} value={connection.account} />
          )}
          {connection.detail !== undefined && <p className={css.configHint}>{connection.detail}</p>}
          {connection.error !== undefined && <p className={css.configError} role="alert">{connection.error.message}</p>}
          {connectionActionError !== null && (
            <p className={css.configError} role="alert" data-clue-connection-action-error="">
              {connectionActionError}
            </p>
          )}

          {connection.selectableCapabilities !== undefined && connection.selectableCapabilities.length > 0 && (
            <Disclosure
              className={css.advanced}
              data-clue-permissions=""
              summary={t('clueAuthPermissions')}
              meta={selectedPermissions.filter(capability => connection.selectableCapabilities!.includes(capability) && PERMISSION_COPY[capability] !== undefined)
                .map(capability => t(PERMISSION_COPY[capability]!)).join(' · ') || t('clueAuthPermissionsEmpty')}
            >
              <fieldset className={css.permissionChoices} disabled={connecting || permissionPreferencesLoading || connection.authorization === 'authorizing'}>
                <legend className={css.srOnly}>{t('clueAuthPermissions')}</legend>
                <p className={css.configHint}>{t('clueAuthPermissionsHint')}</p>
                <div className={css.permissionGrid}>
                  {connection.selectableCapabilities.filter(capability => PERMISSION_COPY[capability] !== undefined).map(capability => (
                    <label className={css.permissionChoice} key={capability}>
                      <Checkbox checked={selectedPermissions.includes(capability)}
                        onChange={event => { changePermission(capability, event.target.checked) }} />
                      <span>{t(PERMISSION_COPY[capability]!)}</span>
                      {grantedCapabilities.includes(capability) && (
                        <span
                          className={css.permissionGranted}
                          data-clue-granted-permissions=""
                          aria-label={t(connection.authorization === 'ready' && connection.capabilities.includes(capability) ? 'clueStateReady' : 'clueStateUnchecked')}
                          title={t(connection.authorization === 'ready' && connection.capabilities.includes(capability) ? 'clueStateReady' : 'clueStateUnchecked')}
                        >
                          {t(connection.authorization === 'ready' && connection.capabilities.includes(capability) ? 'clueStateReady' : 'clueStateUnchecked')}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              </fieldset>
            </Disclosure>
          )}
          {permissionPreferencesError !== null && (
            <p className={css.configError} role="alert" data-clue-permission-preference-error="">
              {permissionPreferencesError}
            </p>
          )}
          {permissionPreferencesLoading && <LoadingIndicator inline label={t('clueAuthPermissions')} />}
          {connecting && <LoadingIndicator inline label={t('clueConnectionAuthorization')} />}
          <div className={css.configActions}>
            {(connection.action !== 'none' || connection.selectableCapabilities !== undefined) && connection.authorization !== 'authorizing' && (
              <Action
                label={t(CONNECTION_ACTION_COPY[connection.action === 'none' ? 'grant-scope' : connection.action])}
                primary={!dependenciesNeedAttention && connection.authorization !== 'ready'}
                disabled={connecting || (connection.selectableCapabilities !== undefined && !selectedPermissions.some(capability => connection.selectableCapabilities!.includes(capability)))}
                onClick={() => { void connect() }}
              />
            )}
            {connection.authorization === 'authorizing' && (
              <>
                <Action label={t('clueConnectionCancel')} disabled={connecting} onClick={() => { void cancelConnection() }} />
                <Action label={t('clueConnectionCheck')} primary disabled={connecting} onClick={() => { void pollConnection() }} />
              </>
            )}
          </div>

          {connection.prompt !== undefined && (
            <div className={css.authPrompt} data-clue-auth-prompt="">
              {connection.prompt.verificationUrl !== undefined && (
                <FactRow label={t('clueConnectionUrl')} value={
                  <a className={css.authLink} href={connection.prompt.verificationUrl} target="_blank" rel="noreferrer">
                    {connection.prompt.verificationUrl}
                  </a>
                } />
              )}
              {connection.prompt.userCode !== undefined && (
                <FactRow label={t('clueConnectionCode')} mono value={connection.prompt.userCode} />
              )}
              {connection.prompt.qr !== undefined && (
                <div className={css.qrBlock} data-clue-qr={connection.prompt.qr.uri}>
                  {qr !== undefined && (
                    <svg
                      className={css.qrImage}
                      viewBox={`0 0 ${qr.size} ${qr.size}`}
                      role="img"
                      aria-label={t('clueConnectionQrAria')}
                      shapeRendering="crispEdges"
                    >
                      <path d={qrPath} fill="currentColor" />
                    </svg>
                  )}
                  <ActionButton
                    size="sm"
                    className={css.smallButton}
                    onClick={() => { void writeClipboard(connection.prompt!.qr!.uri) }}
                  >
                    {t('clueAuthCopyLink')}
                  </ActionButton>
                </div>
              )}
              <p className={css.configHint}>
                {t('clueConnectionExpires', { time: new Date(connection.prompt.expiresAt).toLocaleString() })}
              </p>
              {connection.prompt.instructions !== undefined && (
                <p className={css.configHint}>{connection.prompt.instructions}</p>
              )}
            </div>
          )}
          <Disclosure
            className={css.advanced}
            bodyClassName={css.advancedBody}
            data-clue-connection-details=""
            open={connection.configuration !== 'ready' || connectionReadFailed}
            summary={`${t('clueConnectionConfiguration')} · ${t('windowReadOnly')}`}
          >
            {/* The old projection stays as LAST-KNOWN context, but the row
                itself says the read failed instead of presenting a stale "Ready". */}
            <FactRow data-stale={connectionReadFailed ? 'true' : undefined} label={t('clueConnectionConfiguration')}
              value={connectionReadFailed ? (
                <>
                  <span className={css.status} data-kind="request-failed">
                    {t(CLUE_SOURCE_STATUS_COPY['request-failed'])}
                  </span>
                  {' '}
                  <span className={css.configHint}>
                    {t('clueConnectionLastKnown')} {configurationCopy(connection.configuration)}
                  </span>
                </>
              ) : (
                <span data-configuration={connection.configuration}>{configurationCopy(connection.configuration)}</span>
              )} />
          </Disclosure>
        </>
      )}
      {ids.length === 0 && (
        // Dependency-less sources have no other Recheck entry point; the
        // explicit read must stay available after a failed connection read.
        <div className={css.configActions}>
          <Action
            label={t('clueDependencyRecheck')}
            disabled={refreshing}
            onClick={() => { void loadAll(true) }}
          />
        </div>
      )}
    </section>
  ) : null

  return (
    <section className={css.config} data-clue-config={sourceId} aria-label={sourceName}>
      {refreshing && <LoadingIndicator inline />}
      {error !== null && <Notice kind="error">{error}</Notice>}
      {dependenciesNeedAttention ? [dependencySection, connectionSection] : [connectionSection, dependencySection]}
    </section>
  )
}
