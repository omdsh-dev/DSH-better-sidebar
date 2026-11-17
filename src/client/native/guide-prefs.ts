/**
 * Serialized writes for the start page's own preferences from the guide card's
 * "Reorder" dialog. The settings section has its own revision-guarded queue;
 * this one uses the same revision-free settings route as the editor's
 * plugin-owned settings, and adopts the returned document.
 */
import { api } from '../api.ts'
import { parsePrefs } from '../prefs.ts'
import type { SidebarStore } from '../state.ts'

let queue: Promise<void> = Promise.resolve()

/** Persist one patch of start-page preferences. */
export function writeGuidePrefs(store: SidebarStore, patch: Record<string, unknown>): void {
  queue = queue.then(async () => {
    const view = await api.settingsUpdate(patch)
    store.setPrefs(parsePrefs(view.value))
  }).catch((error: unknown) => {
    console.error('start page settings write failed', error)
  })
}

/** Persist the full explicit order. */
export function saveGuideOrder(store: SidebarStore, order: readonly string[]): void {
  writeGuidePrefs(store, { guideOrder: [...order] })
}

/** Persist one card's start-page visibility. */
export function setGuideEntryHidden(store: SidebarStore, key: string, hidden: boolean): void {
  // The host deep-merges nested plain objects, so deleting the key from the
  // patch cannot express "shown": the stored true would survive the merge.
  // Send the explicit boolean for the touched key instead. Every reader asks
  // `guideHidden[key] === true`, so the stored false already reads as shown.
  writeGuidePrefs(store, { guideHidden: { [key]: hidden } })
}

/** Persist one Better Sidebar type's feature switch (the sidebar-content state). */
export function setGuideEntryEnabled(store: SidebarStore, descriptorId: string, enabled: boolean): void {
  const current = store.getPrefs().tabsEnabled
  writeGuidePrefs(store, { tabsEnabled: { ...current, [descriptorId]: enabled } })
}

/** Persist the maximum row count. */
export function saveGuideRows(store: SidebarStore, rows: number): void {
  writeGuidePrefs(store, { guideRows: rows })
}
