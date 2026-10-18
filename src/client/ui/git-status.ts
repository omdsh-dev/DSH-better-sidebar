/**
 * The plugin's ONE git-status store.
 *
 * Before this module the git status was fetched by the changes tab alone
 * (a 2 s poll inside `changes/GitLens.tsx`) while the file tree had no git
 * data at all — so a VS Code-style "color the changed rows" feature would
 * have added a SECOND poller of the same `git status --porcelain` call. The
 * store keeps one snapshot per `sessionId + cwd + repoRoot + worktree`, one poller per
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
 *
 * Cadence: the fetch behind this store is `git status --untracked-files=all`
 * plus two `--numstat` diffs, and on a repository holding a large UNIGNORED
 * tree (a nested `node_modules`, a pnpm store) that is megabytes of output and
 * a fifth of a second of CPU. It therefore runs on a SLOW baseline (30 s) and
 * drops a tier whenever the last round trip came back slow — 2x, then 6x (the
 * user's "60 s / 180 s"), and finally no automatic timer at all — so a
 * pathological repository cannot keep a git process running forever. Every
 * consumer keeps the event-driven refreshes (`refresh()`,
 * `invalidateGitStatus`) at full speed, and any fast answer climbs back to the
 * baseline, so the ladder is self-correcting rather than sticky.
 *
 * Two kinds of consumer exist, and the store separates them: one that WANTS
 * the timer (`poll`, the default — the file tree's ink and the changes page)
 * and one that only wants the answer (`poll: false` — the editor's gutter,
 * which refreshes on mount and after a save). A non-polling consumer can never
 * be the reason a timer runs, and it can never delay one either.
 *
 * Idle polls are silent: a fetch that returns the same status notifies nobody.
 * Bumping the version on every tick re-rendered every consumer — the file
 * tree's rows included — once per cadence for no reason, which is what the
 * snapshot identity check above exists to prevent.
 *
 * Retention: remembering a key is not a lease on memory. The last consumer of
 * a slot going away (unmount, a parked tab, a scope change) DROPS the slot —
 * snapshot, index and listeners and all — so a long session that walks through
 * files, worktrees and cwds cannot grow the map for the page's lifetime. Since
 * v0.25 every visited native tab body stays mounted, so there is no host-side
 * teardown that would have bounded this for us.
 *
 * Dropping is invisible to a consumer that still carries the slot object: its
 * next render re-mints the key (`slotOf`) and `retain` re-registers that same
 * object, so the next retain performs a FRESH fetch rather than serving a
 * stale answer (and never mints a second slot for one key — two slots would
 * mean two pollers). A slot with a fetch in flight is never dropped mid-flight
 * (the answer has to land somewhere); it goes when that fetch settles. As a
 * second bound the registry is capped at {@link SLOT_CAP} keys, because a
 * consumer that mounts while invisible mints a slot it never retains and never
 * releases — eviction only ever takes a slot with no retained consumer and no
 * fetch in flight.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { api, type GitLineCounts, type GitStatusResult, type SessionScope } from '../api.ts'

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
 * Whether two sides carry the same line counts (both absent counts as equal —
 * the entry simply has no reading on that side).
 */
function sameCounts(left: GitLineCounts | undefined, right: GitLineCounts | undefined): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  if ('additions' in left && 'additions' in right) {
    return left.additions === right.additions && left.deletions === right.deletions
  }
  return 'binary' in left && 'binary' in right
}

/**
 * Whether two status snapshots carry the same information. Compared field by
 * field (never by serializing the whole object): the entries are the payload
 * and their order is stable, so a length + pairwise compare is enough.
 *
 * Both sides' counts are compared, each on its own: a numstat-only change — an
 * edit that adds lines without touching either porcelain letter, e.g. more
 * lines appended to an already-modified file — must still publish a NEW
 * snapshot, because keeping the previous identity would freeze the row's
 * numbers at their first reading for as long as the porcelain codes stay put.
 */
function sameStatus(a: GitStatusResult, b: GitStatusResult): boolean {
  if (a === b) return true
  if (a.isRepo !== b.isRepo || a.branch !== b.branch || a.root !== b.root
    || a.upstream !== b.upstream || a.ahead !== b.ahead || a.behind !== b.behind
    || a.detached !== b.detached || a.operation !== b.operation
    || a.truncated !== b.truncated || a.entries.length !== b.entries.length) return false
  if (a.repositories?.length !== b.repositories?.length) return false
  if (a.repositories !== undefined && b.repositories !== undefined
    && a.repositories.some((root, index) => root !== b.repositories![index])) return false
  return a.entries.every((entry, index) => {
    const other = b.entries[index]!
    return entry.path === other.path && entry.xy === other.xy
      && sameCounts(entry.staged, other.staged) && sameCounts(entry.unstaged, other.unstaged)
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
  repoRoot: string | undefined
  worktree: string | undefined
  snapshot: GitStatusResult | null
  loading: boolean
  error: boolean
  version: number
  /** Bumped per fetch so a late response from an older fetch is dropped. */
  generation: number
  running: boolean
  pending: boolean
  /** Consumers that want the ANSWER (any `poll` value). */
  visible: number
  /** Consumers that want the automatic TIMER (`poll: true`). */
  pollers: number
  /** The base cadence a polling consumer asked for (30 s by default). */
  pollMs: number
  /** Which slow tier the last round trip landed in (0 = the baseline). */
  tier: number
  timer: number | undefined
  listeners: Set<() => void>
  index: Index | null
  /** The snapshot the current index was built from (identity compare). */
  indexSource: GitStatusResult | null
}

/**
 * The baseline cadence of an automatic poll. Deliberately slow: one fetch is a
 * full `git status --untracked-files=all` (plus two `--numstat` diffs), and the
 * ink it drives is decoration — the file tree's own listing comes from
 * `fs.trees` and never waits for git. Every user-visible git action
 * (stage / commit / discard, a manual refresh, a save in the editor) refreshes
 * through `invalidateGitStatus` / `refresh()` immediately, so the cadence only
 * governs how fast an EXTERNAL change shows up.
 */
const POLL_BASE_MS = 30_000

/** Round trips slower than these drop the slot one tier (measured client-side,
 *  so it covers both git's work and the transport). */
const SLOW_TIERS_MS = [750, 2_000, 5_000]

/** The interval factor of each tier: 30 s, 60 s, 180 s, then no timer at all. */
const TIER_FACTORS: readonly (number | null)[] = [1, 2, 6, null]

const slots = new Map<string, Slot>()

/**
 * The registry's hard ceiling. The primary rule is release-driven (see
 * {@link release}); this cap is the backstop for keys nobody ever released —
 * a consumer that mounts while invisible mints its slot without retaining it,
 * and only the cap bounds that path. Eviction never touches a slot a consumer
 * holds or one with a fetch in flight, so the cap is soft while many slots are
 * genuinely live.
 */
const SLOT_CAP = 256

/** Whether nothing depends on this slot: no consumer holds the answer and no
 *  fetch is in flight. */
function evictable(slot: Slot): boolean {
  return slot.visible === 0 && !slot.running
}

/** Drop one slot from the registry. Identity-checked, so a key that was
 *  re-minted meanwhile keeps its live entry. */
function forget(slot: Slot): void {
  if (slots.get(slot.key) === slot) slots.delete(slot.key)
}

/** Make room for one key about to be minted: evict the oldest slots nobody
 *  holds while the registry is at {@link SLOT_CAP}. Map order is mint order. */
function trimSlots(): void {
  if (slots.size < SLOT_CAP) return
  for (const slot of slots.values()) {
    if (slots.size < SLOT_CAP) break
    if (evictable(slot)) forget(slot)
  }
}

/** The automatic cadence of one slot; `null` = no timer (tier 3). */
function intervalOf(slot: Slot): number | null {
  const factor = TIER_FACTORS[slot.tier] ?? null
  return factor === null ? null : slot.pollMs * factor
}

function slotOf(scope: SessionScope, worktree: string | undefined): Slot {
  const { sessionId, cwd, repoRoot } = scope
  const key = `${sessionId}\u0000${cwd ?? ''}\u0000${repoRoot ?? ''}\u0000${worktree ?? ''}`
  const existing = slots.get(key)
  if (existing !== undefined) return existing
  // Bounded before minting: a key no consumer ever released must not push the
  // registry past the cap (see SLOT_CAP).
  trimSlots()
  const slot: Slot = {
    key, sessionId, cwd, repoRoot, worktree,
    snapshot: null, loading: false, error: false, version: 0, generation: 0,
    running: false, pending: false, visible: 0, pollers: 0,
    pollMs: POLL_BASE_MS, tier: 0, timer: undefined,
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

/**
 * Move the slot to the tier the last round trip belongs in and re-arm the
 * timer when that changed. The tier is a pure function of the most recent
 * measurement, so a repository that recovers climbs straight back to the
 * baseline — no streak counters, no stuck ladder.
 */
function noteFetchDuration(slot: Slot, durationMs: number): void {
  const tier = SLOW_TIERS_MS.filter(threshold => durationMs >= threshold).length
  if (tier === slot.tier) return
  slot.tier = tier
  reschedule(slot)
}

/** Fetch one snapshot; a concurrent call just marks the slot dirty. */
function fetchSlot(slot: Slot): void {
  if (slot.running) {
    slot.pending = true
    return
  }
  slot.running = true
  const generation = ++slot.generation
  const wasLoading = slot.loading
  slot.loading = slot.snapshot === null
  if (slot.loading !== wasLoading) notify(slot)
  // Whether this fetch changed anything a consumer can SEE. An idle poll that
  // returns the same status must stay silent: the version counter is the
  // `useSyncExternalStore` snapshot, so notifying re-renders every consumer —
  // the changes list and every rendered file-tree row with it — once per
  // cadence for nothing. The snapshot identity below is preserved for exactly
  // this reason; the notification has to honour it too.
  let changed = false
  const startedAt = Date.now()
  const scope: SessionScope = { sessionId: slot.sessionId, cwd: slot.cwd, repoRoot: slot.repoRoot }
  api.gitStatus(scope, slot.worktree)
    .then((snapshot) => {
      if (generation !== slot.generation) return
      // Idle polls return the same answer as a NEW object. Keeping the
      // previous identity when nothing changed is what lets every downstream
      // memo (the changes tree, the file tree's row model, the icon index)
      // hold across ticks.
      if (slot.snapshot !== null && sameStatus(slot.snapshot, snapshot)) {
        if (slot.error) { slot.error = false; changed = true }
        return
      }
      slot.snapshot = snapshot
      slot.error = false
      changed = true
    })
    .catch(() => {
      if (generation !== slot.generation) return
      if (!slot.error) { slot.error = true; changed = true }
    })
    .finally(() => {
      if (generation !== slot.generation) return
      slot.running = false
      const stillLoading = slot.loading
      slot.loading = false
      if (changed || stillLoading) notify(slot)
      noteFetchDuration(slot, Date.now() - startedAt)
      if (slot.pending) {
        slot.pending = false
        fetchSlot(slot)
      }
      // The last consumer may have left while this fetch was in flight: the
      // slot is dropped now that nothing is pending on it any more.
      if (evictable(slot)) forget(slot)
    })
}

function startTimer(slot: Slot): void {
  if (slot.timer !== undefined) return
  const interval = intervalOf(slot)
  if (interval === null) return
  slot.timer = window.setInterval(() => { fetchSlot(slot) }, interval)
}

function stopTimer(slot: Slot): void {
  if (slot.timer === undefined) return
  window.clearInterval(slot.timer)
  slot.timer = undefined
}

/**
 * Re-arm the timer after the tier moved. A cadence change means a new handle
 * (the interval is baked into the old one); a slot whose tier 3 stopped the
 * timer stays stopped, and one with no polling consumer is left alone.
 */
function reschedule(slot: Slot): void {
  if (slot.pollers === 0) return
  stopTimer(slot)
  startTimer(slot)
}

function retain(slot: Slot, poll: boolean): void {
  // Re-register a slot the store forgot while nobody held it: the consumer
  // that still carries this object must keep its key (minting a second slot
  // for it would mean a second poller on the same scope).
  if (!slots.has(slot.key)) slots.set(slot.key, slot)
  slot.visible += 1
  if (poll) slot.pollers += 1
  // The answer is fetched for the FIRST consumer whatever kind it is — a
  // non-polling consumer still needs one reading, it just must not own a timer.
  if (slot.visible === 1 && slot.snapshot === null) fetchSlot(slot)
  if (poll && slot.pollers === 1) startTimer(slot)
}

function release(slot: Slot, poll: boolean): void {
  slot.visible = Math.max(0, slot.visible - 1)
  if (poll) {
    slot.pollers = Math.max(0, slot.pollers - 1)
    if (slot.pollers === 0) stopTimer(slot)
  }
  if (slot.visible === 0) {
    stopTimer(slot)
    slot.pollers = 0
    // No consumer left: drop the snapshot so a later mount re-reads the truth
    // instead of coloring rows from a stale answer.
    slot.snapshot = null
    slot.index = null
    slot.indexSource = null
    notify(slot)
    // …and drop the slot itself: nobody holds the answer, so the key must not
    // be remembered for the rest of the page's life. A fetch in flight keeps
    // the slot (its answer has to land somewhere) and the settle path drops it
    // then.
    if (!slot.running) forget(slot)
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
 * Subscribe to the shared git status of one session (optionally of one linked
 * worktree). While `visible` is true the consumer holds the answer; while
 * `poll` is also true it holds the automatic timer (at `pollMs`, escalated by
 * the slow tiers). `poll: false` is for a consumer that wants one reading and
 * event-driven refreshes — the editor's gutter — so it can never keep a git
 * process running in the background.
 */
export function useGitStatus(
  scope: SessionScope,
  options: { worktree?: string; visible?: boolean; pollMs?: number; poll?: boolean } = {},
): GitStatusView {
  const { worktree, visible = true, pollMs = POLL_BASE_MS, poll = true } = options
  const slot = slotOf(scope, worktree)
  const subscribe = useCallback((listener: () => void) => {
    slot.listeners.add(listener)
    return () => { slot.listeners.delete(listener) }
  }, [slot])
  // The third argument (server snapshot) keeps a consumer that is rendered to
  // a string alive — the editor does exactly that in the markdown specs, and
  // the slot's version is 0 on both sides.
  useSyncExternalStore(subscribe, () => slot.version, () => slot.version)

  useEffect(() => {
    // Only a polling consumer states the cadence; a non-polling one must not
    // overwrite the rhythm the timer is actually running at.
    if (poll) slot.pollMs = pollMs
    if (!visible) return undefined
    retain(slot, poll)
    return () => { release(slot, poll) }
  }, [slot, visible, pollMs, poll])

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
