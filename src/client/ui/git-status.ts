/**
 * The plugin's ONE git-status store.
 *
 * Before this module the git status was fetched by the changes tab alone
 * (a 2 s poll inside `changes/GitLens.tsx`) while the file tree had no git
 * data at all — so a VS Code-style "color the changed rows" feature would
 * have added a SECOND poller of the same `git status --porcelain` call. The
 * store keeps one snapshot per `sessionId + cwd + worktree`, one poller per
 * key while at least one VISIBLE consumer is subscribed, and one path index
 * built lazily per snapshot, so the tree (coloring) and the changes page
 * (list) read the same answer.
 *
 * The path index is keyed case-insensitively with '/' separators: git reports
 * repo-root-relative POSIX paths while the tree rows carry host paths (a
 * Windows host mixes separators), and a color lookup must not depend on that
 * difference. The cost is that two paths differing only in case share an
 * entry — invisible in the tree, which lists one of them anyway.
 *
 * Coalescing: a `refresh()` that lands while a fetch is in flight is queued
 * once and re-run when it settles — never dropped (the old `GitLens.refresh`
 * returned early, so a click during the poll silently did nothing).
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { api, type GitStatusResult } from '../api.ts'

/** The semantic class of one changed path (drives the row's ink). */
export type GitTone =
  | 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed' | 'copied' | 'conflict'

/** One path's git state, derived from its two-letter porcelain code. */
export interface GitFileStatus {
  /** Display letter: the index side wins, else the worktree side ('??' → 'U'). */
  letter: string
  tone: GitTone
  /** The index (staged) side carries a change. */
  staged: boolean
  /** The worktree (unstaged) side carries a change. */
  unstaged: boolean
}

/** The porcelain letter → tone rule (both sides share one vocabulary). */
function toneOfLetter(letter: string): GitTone | undefined {
  switch (letter) {
    case 'M': return 'modified'
    case 'T': return 'modified'
    case 'A': return 'added'
    case 'D': return 'deleted'
    case 'R': return 'renamed'
    case 'C': return 'copied'
    case 'U': return 'conflict'
    default: return undefined
  }
}

/**
 * Derive one path's status from its porcelain `XY` code, or `undefined` for a
 * clean (`'  '`) or ignored (`'!!'`) entry. Untracked (`??`) reports 'U' —
 * git's own letter for "not in the index" would be a blank.
 */
export function statusOfXY(xy: string): GitFileStatus | undefined {
  if (xy === '??') return { letter: 'U', tone: 'untracked', staged: false, unstaged: true }
  if (xy.length < 2 || xy === '!!') return undefined
  const x = xy[0]!
  const y = xy[1]!
  if (x === ' ' && y === ' ') return undefined
  const staged = x !== ' ' && x !== '?'
  const unstaged = y !== ' ' && y !== '?'
  // A conflict (any unmerged combination) outranks a plain modification: the
  // user must act on it first, so it owns the row's ink.
  const conflict = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')
  const tone = conflict
    ? 'conflict'
    : toneOfLetter(x !== ' ' && x !== '?' ? x : y) ?? 'modified'
  return {
    letter: x !== ' ' && x !== '?' ? x : y,
    tone,
    staged,
    unstaged,
  }
}

/** The store's normalized path key (case-insensitive, '/' separators). */
function normPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** Join a repo-root-relative git path onto the repo root. */
function joinRoot(root: string, rel: string): string {
  const base = root.replace(/[\\/]+$/, '')
  return `${base}/${rel.replace(/^[\\/]+/, '')}`
}

/**
 * Whether two status snapshots carry the same information. Compared field by
 * field (never by serializing the whole object): the entries are the payload
 * and their order is stable, so a length + pairwise compare is enough.
 */
function sameStatus(a: GitStatusResult, b: GitStatusResult): boolean {
  if (a === b) return true
  if (a.isRepo !== b.isRepo || a.branch !== b.branch || a.root !== b.root
    || a.truncated !== b.truncated || a.entries.length !== b.entries.length) return false
  if (a.repositories?.length !== b.repositories?.length) return false
  if (a.repositories !== undefined && b.repositories !== undefined
    && a.repositories.some((root, index) => root !== b.repositories![index])) return false
  return a.entries.every((entry, index) => {
    const other = b.entries[index]!
    return entry.path === other.path && entry.xy === other.xy
  })
}

interface Index {
  /** Normalized absolute path → status (files only). */
  files: Map<string, GitFileStatus>
  /** Normalized absolute directories that contain at least one changed file. */
  dirs: Set<string>
}

/** Build the lookup index for one snapshot (once per snapshot, O(rows × depth)). */
function buildIndex(snapshot: GitStatusResult): Index {
  const files = new Map<string, GitFileStatus>()
  const dirs = new Set<string>()
  const root = snapshot.root
  if (!snapshot.isRepo || root === undefined) return { files, dirs }
  for (const entry of snapshot.entries) {
    const status = statusOfXY(entry.xy)
    if (status === undefined) continue
    const absolute = normPath(joinRoot(root, entry.path))
    files.set(absolute, status)
    let at = absolute.lastIndexOf('/')
    while (at > 0) {
      const dir = absolute.slice(0, at)
      if (dirs.has(dir)) break
      dirs.add(dir)
      at = dir.lastIndexOf('/')
    }
  }
  return { files, dirs }
}

interface Slot {
  key: string
  sessionId: string
  cwd: string | undefined
  worktree: string | undefined
  snapshot: GitStatusResult | null
  loading: boolean
  error: boolean
  version: number
  /** Bumped per fetch so a late response from an older fetch is dropped. */
  generation: number
  running: boolean
  pending: boolean
  visible: number
  pollMs: number
  timer: number | undefined
  listeners: Set<() => void>
  index: Index | null
  /** The snapshot the current index was built from (identity compare). */
  indexSource: GitStatusResult | null
}

const slots = new Map<string, Slot>()

function slotOf(sessionId: string, cwd: string | undefined, worktree: string | undefined): Slot {
  const key = `${sessionId}\u0000${cwd ?? ''}\u0000${worktree ?? ''}`
  const existing = slots.get(key)
  if (existing !== undefined) return existing
  const slot: Slot = {
    key, sessionId, cwd, worktree,
    snapshot: null, loading: false, error: false, version: 0, generation: 0,
    running: false, pending: false, visible: 0, pollMs: 2_500, timer: undefined,
    listeners: new Set(),
    index: null, indexSource: null,
  }
  slots.set(key, slot)
  return slot
}

function notify(slot: Slot): void {
  slot.version += 1
  for (const listener of slot.listeners) listener()
}

/** Fetch one snapshot; a concurrent call just marks the slot dirty. */
function fetchSlot(slot: Slot): void {
  if (slot.running) {
    slot.pending = true
    return
  }
  slot.running = true
  const generation = ++slot.generation
  slot.loading = slot.snapshot === null
  notify(slot)
  const scope = { sessionId: slot.sessionId, ...(slot.cwd !== undefined ? { cwd: slot.cwd } : {}) }
  api.gitStatus(scope, slot.worktree)
    .then((snapshot) => {
      if (generation !== slot.generation) return
      // Idle polls return the same answer as a NEW object every 2.5s. Keeping
      // the previous identity when nothing changed is what lets every
      // downstream memo (the changes tree, the file tree's row model, the
      // icon index) hold across ticks — without it the whole list re-rendered
      // and re-resolved icons on every poll.
      if (slot.snapshot !== null && sameStatus(slot.snapshot, snapshot)) {
        slot.error = false
        return
      }
      slot.snapshot = snapshot
      slot.error = false
    })
    .catch(() => {
      if (generation !== slot.generation) return
      slot.error = true
    })
    .finally(() => {
      if (generation !== slot.generation) return
      slot.running = false
      slot.loading = false
      notify(slot)
      if (slot.pending) {
        slot.pending = false
        fetchSlot(slot)
      }
    })
}

function startTimer(slot: Slot): void {
  if (slot.timer !== undefined) return
  slot.timer = window.setInterval(() => { fetchSlot(slot) }, slot.pollMs)
}

function stopTimer(slot: Slot): void {
  if (slot.timer === undefined) return
  window.clearInterval(slot.timer)
  slot.timer = undefined
}

function retain(slot: Slot): void {
  slot.visible += 1
  if (slot.visible === 1) {
    if (slot.snapshot === null) fetchSlot(slot)
    startTimer(slot)
  }
}

function release(slot: Slot): void {
  slot.visible = Math.max(0, slot.visible - 1)
  if (slot.visible === 0) {
    stopTimer(slot)
    // No consumer left: drop the snapshot so a later mount re-reads the truth
    // instead of coloring rows from a stale answer.
    slot.snapshot = null
    slot.index = null
    slot.indexSource = null
    notify(slot)
  }
}

/** The index for the current snapshot, rebuilt only when the snapshot changed. */
function indexOf(slot: Slot): Index {
  if (slot.index === null || slot.indexSource !== slot.snapshot) {
    slot.index = slot.snapshot === null ? { files: new Map(), dirs: new Set() } : buildIndex(slot.snapshot)
    slot.indexSource = slot.snapshot
  }
  return slot.index
}

/**
 * Force a re-read of one session's git status (after stage/commit/discard,
 * or from a manual refresh). Queues one fetch when another is in flight.
 * Every live key of that session is refreshed, so the tree and the changes
 * page never disagree.
 */
export function invalidateGitStatus(sessionId: string): void {
  for (const slot of slots.values()) {
    if (slot.sessionId === sessionId) fetchSlot(slot)
  }
}

/** The consumer-facing view of one key's status. */
export interface GitStatusView {
  /** The last snapshot, or null before the first answer. */
  snapshot: GitStatusResult | null
  loading: boolean
  error: boolean
  /** Re-read now (queued when a fetch is already in flight). */
  refresh(): void
  /** The status of one absolute path, or undefined when clean/unknown. */
  statusOf(absolutePath: string): GitFileStatus | undefined
  /** Whether `absoluteDir` or anything under it has a change. */
  dirHasChanges(absoluteDir: string): boolean
}

/**
 * Subscribe to the shared git status of one session (optionally of one
 * linked worktree). The poll runs while `visible` is true, at `pollMs`.
 */
export function useGitStatus(
  scope: { sessionId: string; cwd?: string },
  options: { worktree?: string; visible?: boolean; pollMs?: number } = {},
): GitStatusView {
  const { worktree, visible = true, pollMs = 2_500 } = options
  const slot = slotOf(scope.sessionId, scope.cwd, worktree)
  const subscribe = useCallback((listener: () => void) => {
    slot.listeners.add(listener)
    return () => { slot.listeners.delete(listener) }
  }, [slot])
  useSyncExternalStore(subscribe, () => slot.version)

  useEffect(() => {
    slot.pollMs = pollMs
    if (!visible) return undefined
    retain(slot)
    return () => { release(slot) }
  }, [slot, visible, pollMs])

  const refresh = useCallback(() => { fetchSlot(slot) }, [slot])
  const statusOf = useCallback(
    (absolutePath: string) => indexOf(slot).files.get(normPath(absolutePath)),
    [slot],
  )
  const dirHasChanges = useCallback(
    (absoluteDir: string) => indexOf(slot).dirs.has(normPath(absoluteDir)),
    [slot],
  )

  return { snapshot: slot.snapshot, loading: slot.loading, error: slot.error, refresh, statusOf, dirHasChanges }
}
