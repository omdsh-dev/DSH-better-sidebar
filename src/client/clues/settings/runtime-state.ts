/**
 * Shared S2 runtime observations across every view of the SAME runtime face.
 *
 * The approved S8 spec (§8) requires multiple views to share installation
 * state: a task started from one source's configuration window must show its
 * progress/cancel affordance in another window sharing the dependency, and an
 * authorization result must be visible to both, without a remount. This module
 * is the one in-memory fan-out for those sanitized DTOs. It is NOT a second
 * store or RPC: values still come from `clues.dependencies.*` /
 * `clues.connections.*` through the typed wrapper; a view that already read
 * them publishes the result so another view can ADOPT the fresh observation
 * instead of duplicating that read. This bus carries observations only: it
 * does not cache, deduplicate or elect a leader, and each view still owns its
 * explicit reads (plus its own running-task poller when it shows a task).
 *
 * Each notification carries exactly the values that read/task observed — not
 * an accumulated mirror — so a receiver can tell a FRESH status from an older
 * one (that distinction is what lets a failed status row recover).
 *
 * Scope is the runtime face itself (`clueRuntimeApi` in production, an
 * injected fake in tests): a `WeakMap` keyed by that object means two plugin
 * activations / two test harnesses never see each other's observations, and
 * dropping every view releases the bus with the runtime object. No timers,
 * no probing and no persistence live here.
 */
import type { ClueRuntimeApi } from '../runtime-api.ts'
import type {
  ConnectionStatusProjection,
  DependencyInstallTask,
  DependencyStatus,
} from '../../../clues/runtime/types.ts'

/** What kind of observation changed. */
export type ClueRuntimeObservationKind = 'statuses' | 'tasks'

/** One notification: exactly the values the publishers just observed. */
export interface ClueRuntimeObservation {
  readonly kind: ClueRuntimeObservationKind
  readonly dependencies: readonly DependencyStatus[]
  readonly connections: readonly ConnectionStatusProjection[]
  readonly tasks: readonly DependencyInstallTask[]
}

type Listener = (observation: ClueRuntimeObservation) => void

const buses = new WeakMap<ClueRuntimeApi, Set<Listener>>()

/** The per-runtime listener set (created on first use). */
function busOf(runtime: ClueRuntimeApi): Set<Listener> {
  const existing = buses.get(runtime)
  if (existing !== undefined) return existing
  const created = new Set<Listener>()
  buses.set(runtime, created)
  return created
}

/** Fan one observation out; a throwing subscriber never blocks the others. */
function notify(runtime: ClueRuntimeApi, observation: ClueRuntimeObservation): void {
  for (const listener of [...busOf(runtime)]) {
    try {
      listener(observation)
    } catch {
      // One broken view must not stop the other views from receiving it.
    }
  }
}

/**
 * Publish successfully read dependency/connection statuses.
 * @param runtime - the runtime face the DTOs came from.
 * @param dependencies - sanitized dependency statuses (may be empty).
 * @param connections - sanitized connection projections (may be empty).
 */
export function publishClueStatuses(
  runtime: ClueRuntimeApi,
  dependencies: readonly DependencyStatus[],
  connections: readonly ConnectionStatusProjection[] = [],
): void {
  if (dependencies.length === 0 && connections.length === 0) return
  notify(runtime, {
    kind: 'statuses',
    dependencies: [...dependencies],
    connections: [...connections],
    tasks: [],
  })
}

/**
 * Publish the latest install task of one dependency (start/progress/terminal).
 * @param runtime - the runtime face the task came from.
 * @param task - the sanitized install task.
 */
export function publishClueTask(runtime: ClueRuntimeApi, task: DependencyInstallTask): void {
  notify(runtime, {
    kind: 'tasks',
    dependencies: [],
    connections: [],
    tasks: [task],
  })
}

/**
 * Observe later observations of this runtime face.
 * @param runtime - the runtime face to watch.
 * @param listener - invoked with each fresh status/task observation.
 * @returns the disposer removing exactly this listener.
 */
export function subscribeClueRuntime(runtime: ClueRuntimeApi, listener: Listener): () => void {
  const bus = busOf(runtime)
  bus.add(listener)
  return () => { bus.delete(listener) }
}
