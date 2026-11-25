/**
 * S8 settings navigation (deep links) — node-free, no React dependency.
 *
 * The Side card section is reachable from more than one place: the DSH
 * settings shell's own nav (the existing entry) and the clue Tab's gear (S9),
 * which must land on the Clue sources group and can name one source to
 * configure. Both entry points render the SAME component and share the SAME
 * settings document; this module only carries the in-product navigation
 * intent, never a second store:
 *
 * - `openClueSettings(target)` publishes a one-shot target;
 * - a mounted section subscribes, switches the group and (with a source id)
 *   opens that source's S6 config window;
 * - the target is CONSUMED by the receiving section, so reopening the
 *   settings dialog later does not replay an old deep link.
 *
 * The state is module-level on purpose: the settings surface and the Tab live
 * in the same browser bundle (one client activation), and there is exactly one
 * settings dialog at a time. A throwing subscriber never blocks the rest.
 */

/** The settings groups, in navigation order (approved S8 spec §2). */
export const CLUE_SETTINGS_GROUPS = ['general', 'tabs', 'viewers', 'sources', 'appearance'] as const

/** One settings group id. */
export type ClueSettingsGroup = (typeof CLUE_SETTINGS_GROUPS)[number]

/** A requested landing spot inside the section. */
export interface ClueSettingsTarget {
  readonly group: ClueSettingsGroup
  /** Open this source's configuration window after switching groups. */
  readonly sourceId?: string
}

/** The pending deep link (one value; last request wins). */
let pending: ClueSettingsTarget | undefined

type Listener = (target: ClueSettingsTarget) => void

const listeners = new Set<Listener>()

/**
 * Ask every mounted settings surface to land on `target`.
 * @param target - the group and optional source id to show.
 */
export function openClueSettings(target: ClueSettingsTarget): void {
  pending = target
  for (const listener of [...listeners]) {
    try {
      listener(target)
    } catch {
      // A broken consumer must not stop the other subscribers or the link.
    }
  }
}

/**
 * Observe deep links while a settings section is mounted.
 * @param listener - invoked with each published target.
 * @returns the disposer removing exactly this listener.
 */
export function subscribeClueSettingsTarget(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The pending target without consuming it (render-time peek). */
export function peekClueSettingsTarget(): ClueSettingsTarget | undefined {
  return pending
}

/**
 * Take the pending target (clears it so it is applied exactly once).
 * @returns the target, or undefined when no deep link is pending.
 */
export function consumeClueSettingsTarget(): ClueSettingsTarget | undefined {
  const target = pending
  pending = undefined
  return target
}
