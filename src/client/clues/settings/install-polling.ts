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
 */
import type { ClueRuntimeApi } from '../runtime-api.ts'
import type { DependencyInstallTask } from '../../../clues/runtime/types.ts'
import { publishClueTask } from './runtime-state.ts'

/** Install progress cadence (only while at least one task is running). */
const INSTALL_POLL_MS = 1_000

/** Consecutive failed status reads before the shared poller gives up. */
const MAX_POLL_FAILURES = 3

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
  failures: number
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
    failures: 0,
  }
  pollers.set(runtime, created)
  return created
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

/** Schedule the next tick (self-scheduling: at most one request in flight). */
function schedule(runtime: ClueRuntimeApi, poller: SharedPoller): void {
  if (poller.listeners.size === 0 || poller.scheduled) return
  poller.scheduled = true
  poller.timer = window.setTimeout(() => { void tick(runtime, poller) }, INSTALL_POLL_MS)
}

/** Read every latest install task once and fan the observation out. */
async function tick(runtime: ClueRuntimeApi, poller: SharedPoller): Promise<void> {
  poller.timer = undefined
  poller.scheduled = false
  if (poller.listeners.size === 0) return
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
  }
  schedule(runtime, poller)
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
  if (poller.listeners.size === 1 || !poller.scheduled) {
    poller.failures = 0
    schedule(runtime, poller)
  }
  return () => {
    poller.listeners.delete(listener)
    if (poller.listeners.size === 0) {
      if (poller.timer !== undefined) {
        window.clearTimeout(poller.timer)
        poller.timer = undefined
      }
      poller.scheduled = false
      poller.published.clear()
    }
  }
}
