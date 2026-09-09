/**
 * Pending-writes queue for built-in and external feature settings changed
 * outside the settings popup (for example editor pins and the Tasks active-only
 * switch). Writes are serialized through one promise chain so a quick burst of
 * changes can never read stale preferences and drop an earlier update
 * and drop an earlier toggle; each write pushes the whole open map patch
 * through the revision-free settings route and adopts the returned document.
 *
 * (The settings popup has its own serialized commit — SideCardSection's —
 * so its rows and this helper rarely race; the shared route's last-write-wins
 * semantics cover the uncommon overlap.)
 */
import { api } from './api.ts'
import { parsePrefs, type SidebarPrefs } from './prefs.ts'
import type { SidebarStore } from './state.ts'

let queue: Promise<void> = Promise.resolve()

/** Persist a typed top-level sidebar preference changed outside Settings. */
export function updateSidebarPrefs(
  store: SidebarStore,
  patch: Partial<SidebarPrefs>,
): void {
  queue = queue.then(async () => {
    const view = await api.settingsUpdate(patch)
    store.setPrefs(parsePrefs(view.value))
  }).catch((error: unknown) => {
    console.error('sidebar settings write failed', error)
  })
}

/**
 * Merge one plugin-owned settings blob of one descriptor and persist it.
 * @param store - the sidebar store (its prefs are replaced by the write result).
 * @param descriptorId - the descriptor whose blob is patched ('editor' here).
 * @param updater - pure patch function; receives a shallow copy of the blob.
 */
export function updatePluginSettings(
  store: SidebarStore,
  descriptorId: string,
  updater: (blob: Record<string, unknown>) => Record<string, unknown>,
): void {
  queue = queue.then(async () => {
    const prefs = store.getPrefs()
    const blob = prefs.pluginSettings[descriptorId] ?? {}
    const next = updater({ ...blob })
    const view = await api.settingsUpdate({
      pluginSettings: { ...prefs.pluginSettings, [descriptorId]: next },
    })
    store.setPrefs(parsePrefs(view.value))
  }).catch((error: unknown) => {
    // The pin stays visually unchanged (no optimistic flip) and the menu
    // keeps working — the write failure is logged, not surfaced.
    console.error('plugin settings write failed', error)
  })
}
