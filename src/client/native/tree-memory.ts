/**
 * Durability for the native right Sidebar tabs' EXPLORER MEMORY only.
 *
 * Two things the native surface keeps in memory and loses on every unmount:
 *
 * - the EXPANDED directory set of a tab's file tree, and
 * - the READING POSITION: which row the user was at when the tree last
 *   vanished (closing a preview tab, collapsing the panel, switching a
 *   conversation, reloading the page). Without it the tree comes back at the
 *   workspace root and a deep file means scrolling back down by hand.
 *
 * Both are remembered per session + native content id (a `dsh-resource://…`
 * file address or a page address) under one key (`dsh-sidebar:v1:native-tree`):
 *
 *     { [sessionId]: { [contentId]: { expanded: string[], anchor: string } } }
 *
 * `anchor` is the absolute path of the row the user was on — a PATH rather
 * than a pixel offset, because it survives layout changes and needs no DOM
 * markers, and because it is what the user actually asked to come back to.
 *
 * The tab LAYOUT itself is deliberately untouched: native tabs are owned by
 * DSH, and replaying opens here would move the active tab away from the Files
 * window that owns the tree. Storage is best-effort: malformed blobs read as
 * empty and a full/blocked store never breaks a tab.
 */

/** One blob for every session, keyed by native content id. */
const STORAGE_KEY = 'dsh-sidebar:v1:native-tree'

/** One tab's remembered explorer state. */
interface TreeMemory {
  /** The expanded directory set (absolute paths). */
  expanded?: string[]
  /** The row the user was last at (absolute path), scrolled back into view. */
  anchor?: string
}

/** Shared load so every entry point guards parsing identically. */
function readMemory(): Record<string, unknown> {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/** One tab's stored blob (an older build may hold a bare array here). */
function heldEntry(sessionId: string, contentId: string): TreeMemory {
  const bucket = readMemory()[sessionId]
  if (bucket === null || typeof bucket !== 'object' || Array.isArray(bucket)) return {}
  const value = (bucket as Record<string, unknown>)[contentId]
  // Version skew: v2 of this patch stored the expansion as a bare string[].
  if (Array.isArray(value)) return { expanded: value.filter((path): path is string => typeof path === 'string') }
  if (value === null || typeof value !== 'object') return {}
  const record = value as Record<string, unknown>
  return {
    ...(Array.isArray(record.expanded)
      ? { expanded: record.expanded.filter((path): path is string => typeof path === 'string') }
      : {}),
    ...(typeof record.anchor === 'string' ? { anchor: record.anchor } : {}),
  }
}

/** Merge one patch into a tab's stored blob, pruning empty entries. */
function saveEntry(sessionId: string, contentId: string, patch: TreeMemory): void {
  try {
    if (typeof localStorage === 'undefined') return
    const map = readMemory()
    const bucket = map[sessionId]
    const held = bucket !== null && typeof bucket === 'object' && !Array.isArray(bucket)
      ? bucket as Record<string, unknown>
      : {}
    const merged: TreeMemory = { ...heldEntry(sessionId, contentId), ...patch }
    const next: TreeMemory = {}
    if (merged.expanded !== undefined && merged.expanded.length > 0) next.expanded = merged.expanded
    if (merged.anchor !== undefined && merged.anchor !== '') next.anchor = merged.anchor
    if (next.expanded === undefined && next.anchor === undefined) delete held[contentId]
    else held[contentId] = next
    // Drop sessions that remember nothing, so the blob cannot grow forever.
    if (Object.keys(held).length === 0) delete map[sessionId]
    else map[sessionId] = held
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // Storage full or unavailable: tree memory is best-effort.
  }
}

/** The expanded directory set remembered for one native tab. */
export function recalledExpanded(sessionId: string, contentId: string): string[] {
  return heldEntry(sessionId, contentId).expanded ?? []
}

/** Remember one native tab's expanded directory set. */
export function saveRecalledExpanded(sessionId: string, contentId: string, paths: readonly string[]): void {
  saveEntry(sessionId, contentId, { expanded: [...paths] })
}

/** The row the user was last at in one native tab's tree (absolute path). */
export function recalledAnchor(sessionId: string, contentId: string): string | undefined {
  return heldEntry(sessionId, contentId).anchor
}

/** Remember the row one native tab's tree should come back to. */
export function saveRecalledAnchor(sessionId: string, contentId: string, path: string): void {
  saveEntry(sessionId, contentId, { anchor: path })
}
