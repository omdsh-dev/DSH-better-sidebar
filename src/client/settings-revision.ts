/**
 * Shared settings-document revision tracker.
 *
 * The side card settings route is revision-guarded: every write must carry
 * the latest document revision or the host rejects it as a concurrent edit.
 * The drag-width path writes settings from the sidebar surface (outside the
 * settings section), so this tiny hop keeps the settings section's local
 * revision current after an external write.
 */

let revision: number | undefined
const listeners = new Set<() => void>()
let inFlight: Promise<unknown> = Promise.resolve()

export function getSettingsRevision(): number | undefined {
  return revision
}

export function setSettingsRevision(next: number | undefined): void {
  if (revision === next) return
  revision = next
  for (const listener of [...listeners]) listener()
}

export function subscribeSettingsRevision(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Serialize settings writes across the sidebar surface and the settings
 * section. A failed write must not block later writes.
 */
export function queueSettingsUpdate<T>(update: () => Promise<T>): Promise<T> {
  const run = inFlight.then(update, update)
  inFlight = run.then(() => undefined, () => undefined)
  return run
}
