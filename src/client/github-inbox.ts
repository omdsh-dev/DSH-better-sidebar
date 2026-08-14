/**
 * Client half of the built-in GitHub tab: the pure classification / filter
 * functions over the inbox wire shapes, and the GithubInboxStore that owns
 * the polling timer and the badge value. Node-free by contract (the client
 * bundle inlines this module).
 *
 * The store is created once per plugin activation (by the builtins
 * aggregator) and shared by the tab descriptor's badge hook and the inbox
 * view. Polling is lazy: the first badge render (or view mount) arms the
 * timer, so a disabled GitHub tab never polls. The timer tracks the prefs'
 * githubPollSeconds floored by the host's effective poll interval, skips
 * while the document is hidden, and slows to a 5-minute probe while the
 * inbox is unconfigured.
 * @module dsh-better-sidebar/github-inbox
 */

import type { api } from './api.ts'
import type { BetterSidebarService } from './service.ts'
import { allLeaves } from './state.ts'
import type { GithubStateResult, GithubThread } from '../github-shared.ts'
import type { SidebarPrefs } from '../prefs-shared.ts'

/** The five inbox categories the user can filter with checkboxes. */
export type GithubCategory = 'reviewRequested' | 'prActivity' | 'comments' | 'ci' | 'other'

/** The SidebarPrefs field each category's checkbox reads and writes. */
export const GITHUB_CATEGORY_PREF_KEYS: Record<GithubCategory, keyof SidebarPrefs> = {
  reviewRequested: 'githubShowReviewRequested',
  prActivity: 'githubShowPrActivity',
  comments: 'githubShowComments',
  ci: 'githubShowCi',
  other: 'githubShowOther',
}

/**
 * Classify one thread into its display category. GitHub's reason is
 * per-thread and drifts over the thread's life (official behavior: an
 * author thread keeps reporting 'author' even for later comments; an
 * @-mention upgrades it to 'mention'), so the mapping is display-level —
 * it never promises event-level precision.
 * @param thread - the thread's reason and subject type.
 * @returns the category driving the filter checkboxes.
 */
export function categorizeThread(thread: Pick<GithubThread, 'reason' | 'type'>): GithubCategory {
  if (thread.reason === 'review_requested') return 'reviewRequested'
  if (thread.reason === 'ci_activity') return 'ci'
  if (thread.reason === 'author') return thread.type === 'PullRequest' ? 'prActivity' : 'comments'
  if (thread.reason === 'comment' || thread.reason === 'mention' || thread.reason === 'team_mention') return 'comments'
  return 'other'
}

/** The review verdicts the thread title can carry. */
export type GithubVerdict = 'approved' | 'changesRequested'

/**
 * Detect a review verdict from the thread title (GitHub writes 'X approved
 * these changes' / 'X requested changes on this pull request' into it).
 * Display-level only — no extra API call, and no promise of precision.
 * @param title - the subject.title of a PR thread.
 * @returns the verdict tag, or undefined when the title carries none.
 */
export function reviewVerdict(title: string): GithubVerdict | undefined {
  const lower = title.toLowerCase()
  if (lower.includes('approved these changes')) return 'approved'
  if (lower.includes('requested changes') || lower.includes('changes requested')) return 'changesRequested'
  return undefined
}

/**
 * Apply the category filters to a thread list (pure).
 * @param threads - the inbox snapshot's threads.
 * @param prefs - the live side card prefs holding the five checkboxes.
 * @returns only the threads whose category checkbox is on.
 */
export function filterThreads(threads: readonly GithubThread[], prefs: SidebarPrefs): GithubThread[] {
  return threads.filter(thread => prefs[GITHUB_CATEGORY_PREF_KEYS[categorizeThread(thread)]] === true)
}

/** Count the unread threads of a list (pure; the badge uses the FILTERED list). */
export function countUnread(threads: readonly GithubThread[]): number {
  let count = 0
  for (const thread of threads) {
    if (thread.unread) count += 1
  }
  return count
}

/**
 * The PR/issue number of a thread URL ('.../pulls/123' → 123). The inbox
 * subject.url is the REST URL of the subject, which carries the number.
 * @returns the number, or undefined when the URL carries none.
 */
export function threadNumber(url: string): number | undefined {
  const match = /\/(?:pulls?|issues?)\/(\d+)/.exec(url)
  return match === null ? undefined : Number(match[1])
}

/** One repository's threads, grouped for the list. */
export interface GithubThreadGroup {
  repo: string
  threads: GithubThread[]
}

/**
 * Group a thread list by repository. Threads keep their (newest-first)
 * order inside each group; groups are ordered by their newest thread.
 * @param threads - the filtered thread list.
 * @returns the groups in display order.
 */
export function groupThreads(threads: readonly GithubThread[]): GithubThreadGroup[] {
  const byRepo = new Map<string, GithubThread[]>()
  for (const thread of threads) {
    const bucket = byRepo.get(thread.repo)
    if (bucket === undefined) byRepo.set(thread.repo, [thread])
    else bucket.push(thread)
  }
  const groups = [...byRepo.entries()].map(([repo, bucket]) => ({ repo, threads: bucket }))
  groups.sort((a, b) => (b.threads[0]?.updatedAt ?? '').localeCompare(a.threads[0]?.updatedAt ?? ''))
  return groups
}

/** The store's published state (stable object, replaced on changes). */
export interface GithubInboxStoreState {
  /** The last inbox snapshot; null before the first poll settles. */
  snapshot: GithubStateResult | null
  /** The live side card prefs (synced from the sidebar service). */
  prefs: SidebarPrefs
}

/** The shared store of the GitHub tab (one per plugin activation). */
export interface GithubInboxStore {
  getState(): GithubInboxStoreState
  subscribe(listener: () => void): () => void
  /** Arm the polling timer (idempotent; the badge arms it on first render). */
  ensurePolling(): void
  /** Force a fresh snapshot (the refresh button; bypasses host freshness). */
  refresh(): Promise<void>
  /** Drop one thread locally after a successful markRead / markDone. */
  removeLocal(id: string): void
  /** Drop every thread locally after a successful markAllRead. */
  clearLocal(): void
  /** The badge pill value: filtered unread count, 99+ capped, null = hidden. */
  badgeValue(): string | number | null
  /** Stop the timer and detach the prefs subscription (fiber disposal). */
  dispose(): void
}

/** Poll cadence while the inbox is unconfigured (a slow configuration probe). */
const UNCONFIGURED_RETRY_MS = 5 * 60_000

/**
 * Create the GitHub inbox store. The timer starts on the first
 * ensurePolling (badge render or view mount) and keeps the badge live while
 * the tab is open but inactive — a never-opened tab has no pill to render,
 * so it never polls. Overlapping polls are skipped, hidden documents skip
 * the fetch, and a failed poll keeps the last snapshot.
 * @param apiFace - the typed githubState call (dependency-injected for tests).
 * @param service - the betterSidebar service for the live prefs snapshot.
 * @returns the store bound to one plugin activation.
 */
export function createGithubInboxStore(
  apiFace: Pick<typeof api, 'githubState'>,
  service: Pick<BetterSidebarService, 'getSnapshot' | 'subscribeState' | 'updateTab'>,
): GithubInboxStore {
  let state: GithubInboxStoreState = { snapshot: null, prefs: service.getSnapshot().prefs }
  const listeners = new Set<() => void>()
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null
  // Local mutations (markRead/markDone/markAllRead) bump this counter; a
  // poll that STARTED before a mutation carries the pre-mutation list and
  // its settle is discarded instead of resurrecting removed threads.
  let version = 0

  const emit = (): void => {
    for (const listener of listeners) listener()
  }

  const detachPrefs = service.subscribeState(() => {
    const prefs = service.getSnapshot().prefs
    if (prefs !== state.prefs) {
      state = { ...state, prefs }
      emit()
    }
  })

  const badgeValue = (): string | number | null => {
    const { snapshot, prefs } = state
    if (snapshot === null || !snapshot.configured || snapshot.threads.length === 0) return null
    const count = countUnread(filterThreads(snapshot.threads, prefs))
    if (count === 0) return null
    return count > 99 ? '99+' : count
  }

  // The tab strip renders the badge from the descriptor hook, but the strip
  // itself only re-renders on SIDEBAR state changes — it has no dependency
  // on this store. Bridge: whenever the store changes, bump every open
  // GitHub tab's meta to the fresh badge value, which notifies the sidebar
  // store and re-renders the strip (patchTab always notifies). The value
  // guard skips the bump when the badge did not change, so a poll settle
  // with no unread-count change leaves the strip alone.
  let lastBadge: string | number | null | undefined
  const bumpBadge = (): void => {
    const value = badgeValue()
    if (value === lastBadge) return
    lastBadge = value
    const sidebar = service.getSnapshot().state
    if (sidebar === undefined) return
    for (const leaf of [...allLeaves(sidebar.splits), ...allLeaves(sidebar.bottomSplits)]) {
      for (const tab of leaf.tabs) {
        if (tab.type === 'github') service.updateTab(tab.id, { meta: value })
      }
    }
  }

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  // Every store change re-bumps the open GitHub tabs' badge meta (the
  // updateTab notifies the sidebar store, which re-renders the tab strip).
  subscribe(bumpBadge)

  const nextDelay = (): number => {
    const snapshot = state.snapshot
    if (snapshot === null || !snapshot.configured) return UNCONFIGURED_RETRY_MS
    return Math.max(state.prefs.githubPollSeconds, snapshot.pollIntervalSec) * 1000
  }

  const adopt = (snapshot: GithubStateResult): void => {
    if (!disposed) {
      state = { ...state, snapshot }
      emit()
    }
  }

  const tick = (): void => {
    if (disposed) return
    if (typeof document !== 'undefined' && document.hidden) {
      timer = setTimeout(tick, nextDelay())
      return
    }
    if (inFlight === null) {
      const startedAt = version
      inFlight = apiFace.githubState(false)
        .then(snapshot => {
          if (version === startedAt) adopt(snapshot)
        })
        .catch(() => { /* the host is the sidebar server itself — keep the last snapshot */ })
        .finally(() => { inFlight = null })
    }
    timer = setTimeout(tick, nextDelay())
  }

  return {
    getState: () => state,
    subscribe,
    ensurePolling: () => {
      if (!disposed && timer === null) timer = setTimeout(tick, 0)
    },
    refresh: async () => {
      // The manual refresh respects the overlap guard like the timer does:
      // wait out an in-flight poll, then force past the host freshness
      // window. A mutation during the wait discards this fetch's result
      // (it started before the mutation, so it carries the pre-mutation list).
      if (inFlight !== null) await inFlight
      const startedAt = version
      const snapshot = await apiFace.githubState(true)
      if (version === startedAt) adopt(snapshot)
    },
    removeLocal: (id) => {
      const snapshot = state.snapshot
      if (snapshot === null) return
      version += 1
      state = { ...state, snapshot: { ...snapshot, threads: snapshot.threads.filter(thread => thread.id !== id) } }
      emit()
    },
    clearLocal: () => {
      const snapshot = state.snapshot
      if (snapshot === null) return
      version += 1
      state = { ...state, snapshot: { ...snapshot, threads: [] } }
      emit()
    },
    badgeValue,
    dispose: () => {
      disposed = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      detachPrefs()
      listeners.clear()
    },
  }
}
