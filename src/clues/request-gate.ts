/** One bounded request gate per provider connection; no polling or response cache. */
import { ClueError, isClueError } from './error.ts'

interface Queued {
  run(): Promise<unknown>
  resolve(value: unknown): void
  reject(error: unknown): void
  signal?: AbortSignal
  abort?: () => void
}
interface Gate {
  queue: Queued[]
  active: number
  nextStart: number
  cooldown: number
  timer?: ReturnType<typeof setTimeout>
}
export interface ClueRequestGateOptions {
  readonly intervalMs?: number
  readonly concurrency?: number
  readonly maxQueue?: number
  readonly maxConnections?: number
  readonly cooldownMs?: number
}
/** Factory is also the lifecycle/test seam; dispose cancels waiting work. */
export function createClueProviderGate(options: ClueRequestGateOptions = {}) {
  const gates = new Map<string, Gate>()
  const interval = options.intervalMs ?? 500
  const concurrency = options.concurrency ?? 2
  const maxQueue = options.maxQueue ?? 64
  const maxConnections = options.maxConnections ?? 32
  let disposed = false
  function removeAbort(item: Queued): void { if (item.abort !== undefined) item.signal?.removeEventListener('abort', item.abort) }
  function pump(gate: Gate): void {
    if (gate.timer !== undefined) { clearTimeout(gate.timer); gate.timer = undefined }
    if (disposed || gate.queue.length === 0 || gate.active >= concurrency) return
    const wait = Math.max(gate.nextStart, gate.cooldown) - Date.now()
    if (wait > 0) {
      gate.timer = setTimeout(() => { gate.timer = undefined; pump(gate) }, wait)
      return
    }
    const item = gate.queue.shift()!
    removeAbort(item)
    if (item.signal?.aborted) { item.reject(new ClueError('cancelled', 'the queued source request was cancelled')); pump(gate); return }
    gate.active++
    gate.nextStart = Date.now() + interval
    void Promise.resolve().then(item.run).then(item.resolve, error => {
      if (isClueError(error) && error.category === 'rate-limited') {
        const raw = Number(error.meta?.retryAfterMs)
        const cooldown = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 300_000) : (options.cooldownMs ?? 30_000)
        gate.cooldown = Date.now() + cooldown
        // Never replay writes, and never hide a queued request behind a cooldown.
        for (const queued of gate.queue.splice(0)) {
          removeAbort(queued)
          queued.reject(new ClueError('rate-limited', 'the source connection is cooling down', { retryAfterMs: String(cooldown) }))
        }
      }
      item.reject(error)
    }).finally(() => { gate.active--; pump(gate) })
    pump(gate)
  }
  function run<T>(key: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (disposed || signal?.aborted) return Promise.reject(new ClueError('cancelled', 'the source request was cancelled'))
    let gate = gates.get(key)
    if (gate === undefined) {
      if (gates.size >= maxConnections) {
        const unused = [...gates].find(([, entry]) => entry.active === 0 && entry.queue.length === 0 && entry.cooldown <= Date.now() && entry.nextStart <= Date.now())?.[0]
        if (unused === undefined) return Promise.reject(new ClueError('rate-limited', 'too many source connections are active'))
        gates.delete(unused)
      }
      gate = { queue: [], active: 0, nextStart: 0, cooldown: 0 }
      gates.set(key, gate)
    }
    if (gate.cooldown > Date.now()) return Promise.reject(new ClueError('rate-limited', 'the source connection is cooling down', { retryAfterMs: String(gate.cooldown - Date.now()) }))
    if (gate.queue.length >= maxQueue) return Promise.reject(new ClueError('rate-limited', 'the source request queue is full'))
    const current = gate
    return new Promise<T>((resolve, reject) => {
      const item: Queued = { run: operation, resolve: value => resolve(value as T), reject, ...(signal === undefined ? {} : { signal }) }
      item.abort = () => {
        const index = current.queue.indexOf(item)
        if (index < 0) return
        current.queue.splice(index, 1)
        removeAbort(item)
        reject(new ClueError('cancelled', 'the queued source request was cancelled'))
        pump(current)
      }
      signal?.addEventListener('abort', item.abort, { once: true })
      current.queue.push(item)
      pump(current)
    })
  }
  return {
    run,
    dispose(): void {
      disposed = true
      for (const gate of gates.values()) {
        if (gate.timer !== undefined) clearTimeout(gate.timer)
        for (const item of gate.queue.splice(0)) { removeAbort(item); item.reject(new ClueError('cancelled', 'the provider gate was disposed')) }
      }
      gates.clear()
    },
  }
}
let providerGate = createClueProviderGate()
export function runClueProviderRequest<T>(key: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return providerGate.run(key, run, signal)
}
/** Plugin teardown releases queued work and timers; a remount starts clean. */
export function disposeClueProviderRequests(): void {
  providerGate.dispose()
  providerGate = createClueProviderGate()
}
