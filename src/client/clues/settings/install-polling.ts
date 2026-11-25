/**
 * The ONE install-progress poller per S2 runtime face.
 *
 * AGENTS' steady-state rule: anything "per resource" is a plugin-wide
 * singleton, never one copy per mounted body. Two source configuration
 * windows can share the same CLI dependency (Feishu docs/tasks, GitHub
 * issues/pulls); each window wanting live progress must not add its own 1 Hz
 * `dependenciesStatus` request. This module keeps a single self-scheduling
 * timer per runtime object, ref-counted by the windows that currently show a
 * running task. The first subscriber starts it, the last one stops it.
 *
 * The poller carries observations only: it calls the same typed S2 wrapper
 * (`dependenciesStatus`) every window would have called, publishes changed
 * tasks on the shared runtime bus, and fans the latest task list out to the
 * subscribers. It caches nothing and elects no leader beyond the single timer.
 *
 * Failure policy: three consecutive status failures stop the timer instead of
 * spinning at 1 Hz forever. The failure text reaches every subscriber so its
 * own dependency row can show it; a later explicit Recheck re-discovers the
 * task and a fresh subscription restarts the timer.
 *
 * Steady-state rules (AGENTS §5): at most ONE request in flight (a listener
 * that subscribes while a tick awaits must not schedule a second timer); the
 * published-signature Map is bounded; and the timer is gated by document
 * visibility (hidden = no timer, visible = one immediate catch-up tick).
 */
import type { ClueRuntimeApi } from '../runtime-api.ts'
import type { DependencyInstallTask } from '../../../clues/runtime/types.ts'
import { publishClueTask } from './runtime-state.ts'

/** Install progress cadence (only while at least one task is running). */
const INSTALL_POLL_MS = 1_000

/** Consecutive failed status reads before the shared poller gives up. */
const MAX_POLL_FAILURES = 3

/** Upper bound of remembered task signatures (in-use/running keys are kept). */
const MAX_PUBLISHED_TASKS = 64

/** One tick's observation. */
export interface InstallPollObservation {
  /** Every latest task the runtime reported this tick (may be empty). */
  readonly tasks: readonly DependencyInstallTask[]
  /** Sanitized one-line failure of this tick (no tasks in the same payload). */
  readonly error?: string
  /** The poller stopped after repeated failures; the view drops live progress. */
  readonly gaveUp?: boolean
}

type InstallPollListener = (observation: InstallPollObservation) => void

interface SharedPoller {
  readonly listeners: Set<InstallPollListener>
  /** Tasks already published on the observation bus, by change signature. */
  readonly published: Map<string, string>
  timer: number | undefined
  scheduled: boolean
  /** A status request is awaiting its answer (no second timer may start). */
  inFlight: boolean
  failures: number
  /** The one visibilitychange listener bound while this poller has listeners. */
  visibilityHandler?: () => void
}

const pollers = new WeakMap<ClueRuntimeApi, SharedPoller>()

/** The per-runtime poller (created on first use). */
function pollerOf(runtime: ClueRuntimeApi): SharedPoller {
  const existing = pollers.get(runtime)
  if (existing !== undefined) return existing
  const created: SharedPoller = {
    listeners: new Set(),
    published: new Map(),
    timer: undefined,
    scheduled: false,
    inFlight: false,
    failures: 0,
  }
  pollers.set(runtime, created)
  return created
}

/** Whether the document is currently hidden (SSR/older hosts: not hidden). */
function documentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

/** Keep the signature map bounded without evicting a RUNNING task. */
function trimPublished(poller: SharedPoller, tasks: readonly DependencyInstallTask[]): void {
  if (poller.published.size <= MAX_PUBLISHED_TASKS) return
  const running = new Set(tasks.filter(task => task.state === 'running').map(task => task.taskId))
  for (const taskId of [...poller.published.keys()]) {
    if (poller.published.size <= MAX_PUBLISHED_TASKS) break
    if (!running.has(taskId)) poller.published.delete(taskId)
  }
}

/** One user-readable failure line (sanitized message only). */
function errorTextOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A change signature: only a moved task reaches the observation bus. */
function taskSignature(task: DependencyInstallTask): string {
  return [
    task.taskId,
    task.state,
    task.progress?.stage ?? '',
    task.progress?.fraction ?? '',
    task.error?.message ?? '',
  ].join('|')
}

/** Fan one tick out; a throwing subscriber never blocks the others. */
function notify(poller: SharedPoller, observation: InstallPollObservation): void {
  for (const listener of [...poller.listeners]) {
    try {
      listener(observation)
    } catch {
      // One broken window must not stop the others from updating.
    }
  }
}

/**
 * Schedule the next tick (self-scheduling). `inFlight` is the gate the timer
 * alone cannot provide: `tick` clears `scheduled` before awaiting the status
 * answer, so without it a subscriber arriving mid-request would schedule a
 * second timer and two status requests would race.
 */
function schedule(runtime: ClueRuntimeApi, poller: SharedPoller): void {
  if (poller.listeners.size === 0 || poller.scheduled || poller.inFlight) return
  // Hidden settings windows do not need live progress; becoming visible again
  // schedules one immediate catch-up tick (see onVisibilityChange).
  if (documentHidden()) return
  poller.scheduled = true
  poller.timer = window.setTimeout(() => { void tick(runtime, poller) }, INSTALL_POLL_MS)
}

/** Read every latest install task once and fan the observation out. */
async function tick(runtime: ClueRuntimeApi, poller: SharedPoller): Promise<void> {
  poller.timer = undefined
  poller.scheduled = false
  if (poller.listeners.size === 0) return
  poller.inFlight = true
  try {
    const tasks = await runtime.dependenciesStatus()
    if (poller.listeners.size === 0) return
    poller.failures = 0
    for (const task of tasks) {
      const signature = taskSignature(task)
      if (poller.published.get(task.taskId) === signature) continue
      poller.published.set(task.taskId, signature)
      publishClueTask(runtime, task)
    }
    trimPublished(poller, tasks)
    notify(poller, { tasks })
  } catch (caught) {
    if (poller.listeners.size === 0) return
    poller.failures += 1
    const message = errorTextOf(caught)
    notify(poller, { tasks: [], error: message })
    if (poller.failures >= MAX_POLL_FAILURES) {
      // Keep the listeners (their rows show the failure); stop the timer.
      // Recheck re-adopts the task, which re-subscribes and restarts us.
      poller.failures = 0
      notify(poller, { tasks: [], gaveUp: true })
      return
    }
  } finally {
    poller.inFlight = false
  }
  schedule(runtime, poller)
}

/** Stop the timer without dropping the subscribers. */
function stopTimer(poller: SharedPoller): void {
  if (poller.timer !== undefined) {
    window.clearTimeout(poller.timer)
    poller.timer = undefined
  }
  poller.scheduled = false
}

/** A visible document gets one immediate catch-up tick (no 1 Hz while hidden). */
function onVisibilityChange(runtime: ClueRuntimeApi, poller: SharedPoller): void {
  if (poller.listeners.size === 0) return
  if (documentHidden()) {
    stopTimer(poller)
    return
  }
  // A tick already awaiting its answer will schedule the next one itself.
  if (poller.inFlight) return
  stopTimer(poller)
  poller.failures = 0
  void tick(runtime, poller)
}

/**
 * Observe live install progress for one window/shared runtime.
 *
 * The timer starts with the first subscriber and stops with the last; a
 * subscriber that re-subscribes after the poller stopped (Recheck re-adopted
 * the task) restarts it. Unlike a per-view poller, two subscribers on the
 * same runtime share exactly one `dependenciesStatus` request per tick.
 *
 * @param runtime - the S2 runtime face the observations belong to.
 * @param listener - invoked with every tick's tasks or its sanitized failure.
 * @returns the disposer removing exactly this listener.
 */
export function subscribeInstallPolling(
  runtime: ClueRuntimeApi,
  listener: InstallPollListener,
): () => void {
  const poller = pollerOf(runtime)
  poller.listeners.add(listener)
  if (poller.listeners.size === 1 && typeof document !== 'undefined') {
    const handler = (): void => { onVisibilityChange(runtime, poller) }
    poller.visibilityHandler = handler
    document.addEventListener('visibilitychange', handler)
  }
  if (poller.listeners.size === 1 || (!poller.scheduled && !poller.inFlight)) {
    poller.failures = 0
    schedule(runtime, poller)
  }
  return () => {
    poller.listeners.delete(listener)
    if (poller.listeners.size === 0) {
      stopTimer(poller)
      if (poller.visibilityHandler !== undefined && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', poller.visibilityHandler)
      }
      poller.visibilityHandler = undefined
      poller.published.clear()
    }
  }
}
