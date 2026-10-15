/**
 * Follow the linked git worktree a session is ACTUALLY working in.
 *
 * The explorer is rooted at the session's stored header cwd, which never
 * changes. A session can move into a linked git worktree (`git worktree add`)
 * during its life  including a worktree of a repository that is not the one
 * the header cwd points at  and the sidebar should follow it.
 *
 * The active root is derived from the session's own `tool/call` arguments:
 * absolute paths are collected newest-event-first (structured `cwd` / `workdir`
 * / `path` / ... fields weigh more than free-form mentions, repeated mentions
 * accumulate), each path's git top level is resolved with
 * `git rev-parse --show-toplevel` (falling back to its directory for files),
 * and only top levels whose `--absolute-git-dir` differs from their
 * `--git-common-dir` (i.e. real LINKED worktrees, not the main checkout and
 * not submodules) are adopted. A linked worktree that sits INSIDE the session
 * workspace is adopted only when it belongs to the SAME repository — a
 * `git worktree add .worktrees/x` of the session's own repo is the session
 * moving, while a nested repository's worktree is ordinary content of the
 * workspace: re-rooting the explorer into it hides every sibling directory
 * (#952). Outside the workspace any linked worktree is adopted, which is PR
 * #802's cross-repository case. The highest-scoring adoptable worktree of the
 * newest event that has one wins; when there is no evidence the session cwd is
 * kept (lifted to the repository top level for subdirectory sessions).
 *
 * Resolutions are cached process-wide, so the client's periodic re-ask is
 * cheap after the first scan.
 */
import { stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, sep } from 'node:path'
import type { Context, SidebarSessionEvent } from './context-types.ts'
import { requireAbsolute } from './fs-tree.ts'
import { runGit } from './git.ts'
import { readPersistedSessionOf } from './session-store.ts'

/** How long one computed root is reused before the event log is scanned again. */
const ACTIVE_ROOT_TTL_MS = 3_000
/** Only the newest slice of the event log is considered. */
const ACTIVE_ROOT_MAX_EVENTS = 4_000
/** Upper bound on git probes per scan (cache misses are what cost). */
const ACTIVE_ROOT_MAX_PROBES = 24
/** Explicit override, mainly for tests and manual pinning. */
const ACTIVE_ROOT_OVERRIDE_ENV = 'DSH_SIDEBAR_WORKTREE_ROOT'
/** Keys whose string values describe where a tool actually ran. */
const ACTIVE_ROOT_STRUCTURED_FIELD = /^(cwd|workdir|work_dir|workingdirectory|path|file_path|filepath|target|root)$/i
/** Absolute Windows paths embedded in free-form command text. */
const ACTIVE_ROOT_PATH_PATTERN = /[A-Za-z]:(?:\\|\/)[^\\/\s"'\x60,;|)<>*?]+(?:[\\/][^\\/\s"'\x60,;|)<>*?]+)*/g

/**
 * One computed root per session, reused for {@link ACTIVE_ROOT_TTL_MS}. `base`
 * is the RAW base the caller passed (not the lifted one), because the entry has
 * to be usable BEFORE the git probe below: that probe is a real process spawn
 * (measured ~7 ms), and the repeated asks  every debounced watch frame, every
 * route call, the client's 5 s poll  are exactly what the TTL exists to keep
 * free.
 */
const activeWorktreeRootCache = new Map<string, { root: string; base: string; expires: number }>()
const pathTopCache = new Map<string, string | undefined>()
const gitIdentityCache = new Map<string, GitIdentity | undefined>()

/**
 * Normalized IDENTITY of a path (case- and separator-insensitive), for
 * comparisons and cache keys only: it lowercases, so it must never be handed
 * back to the filesystem. On Linux (case-sensitive) `…/iHpOqm` → `…/ihpoqm`
 * is a different, usually non-existent path, and probing it silently drops
 * the candidate; macOS and Windows mask that because their filesystems fold
 * case. Keep the real path next to its key.
 */
function pathKeyOf(value: string): string {
  return value.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** Whether `target` is `base` itself or lives under it. */
function pathUnderOf(base: string, target: string): boolean {
  const b = pathKeyOf(base)
  const t = pathKeyOf(target)
  return t === b || t.startsWith(`${b}/`)
}

/** `git rev-parse --show-toplevel` of an existing directory, or undefined. */
async function gitTopLevelOf(cwd: string): Promise<string | undefined> {
  if (cwd === '' || !isAbsolute(cwd)) return undefined
  try {
    if (!(await stat(cwd)).isDirectory()) return undefined
    return (await runGit(cwd, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    return undefined
  }
}

/** Collapse duplicated separators without destroying a UNC prefix. */
function normalizeActivePath(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, '')
  if (trimmed.startsWith('\\\\')) return `\\\\${trimmed.slice(2).replace(/[\\/]+/g, '\\')}`
  // Fold to the PLATFORM separator, never unconditionally to a backslash: a
  // POSIX path folded to `\private\var\…` is no longer absolute for
  // `path.isAbsolute`, and `addActivePath` below then drops it  the whole
  // scan silently found nothing on Linux/macOS. On Windows `sep` IS `\`, so
  // the behavior there is unchanged.
  return trimmed.replace(/[\\/]+/g, sep)
}

/** One candidate path mentioned by a tool call, with its accumulated score. */
interface ActivePathEntry {
  /** The real path (original case), the only form safe to probe. */
  path: string
  score: number
}

function addActivePath(map: Map<string, ActivePathEntry>, value: unknown, weight: number): void {
  if (typeof value !== 'string') return
  const normalized = normalizeActivePath(value)
  if (normalized === '' || !isAbsolute(normalized)) return
  const key = pathKeyOf(normalized)
  const entry = map.get(key)
  if (entry === undefined) map.set(key, { path: normalized, score: weight })
  else entry.score += weight
}

/**
 * Collect every absolute path one tool call mentions.
 * @param value - JSON-decoded tool arguments (nested values are walked).
 * @param map - accumulator keyed by normalized path identity.
 * @param structured - whether the current value sits in a cwd/workdir/path field.
 */
function collectActivePaths(value: unknown, map: Map<string, ActivePathEntry>, structured: boolean): void {
  if (typeof value === 'string') {
    if (isAbsolute(value)) {
      addActivePath(map, value, structured ? 8 : 1)
      return
    }
    const head = value.charCodeAt(0)
    if (head === 0x7b || head === 0x5b) {
      try {
        collectActivePaths(JSON.parse(value) as unknown, map, structured)
      } catch {
        // Not JSON: fall through to the embedded-path scan.
      }
    }
    for (const match of value.match(ACTIVE_ROOT_PATH_PATTERN) ?? []) addActivePath(map, match, 1)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectActivePaths(item, map, structured)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const isStructured = ACTIVE_ROOT_STRUCTURED_FIELD.test(key)
      collectActivePaths(item, map, structured || isStructured)
    }
  }
}

/** git top level for one path (its directory when the path names a file). */
async function topOfActivePath(value: string): Promise<string | undefined> {
  const key = pathKeyOf(value)
  if (pathTopCache.has(key)) return pathTopCache.get(key)
  let top = await gitTopLevelOf(value)
  if (top === undefined) top = await gitTopLevelOf(dirname(value))
  const result = top === undefined ? undefined : requireAbsolute(top)
  pathTopCache.set(key, result)
  return result
}

/**
 * The git identity of one checkout, as `git rev-parse` reports it: the
 * checkout's OWN git dir and the COMMON dir every checkout of that repository
 * shares. Two paths belong to the same repository exactly when their common
 * dirs match, which is the only reliable way to tell "the session moved into a
 * worktree of its own repo" from "the workspace contains another repo's
 * worktree" (#952) — a bare repo's checkouts and a container workspace's
 * sub-projects are indistinguishable by path alone.
 *
 * `main checkout: gitDir === commonDir === <repo>/.git`; `linked worktree:
 * gitDir = <repo>/.git/worktrees/<name>, commonDir = <repo>/.git`; `submodule:
 * both are <super>/.git/modules/<name>`.
 */
interface GitIdentity {
  /** The checkout's own git dir (`--absolute-git-dir`). */
  gitDir: string
  /** The repository's shared git dir (`--git-common-dir`). */
  commonDir: string
}

/**
 * `git rev-parse` identity of one directory, cached process-wide (a probe is a
 * spawn). `undefined` for a directory that is not in a repository, or whose
 * answer is unusable — callers treat that as "no identity", never as a match.
 * @param dir - an existing directory (or any path inside one).
 * @returns the identity, or undefined.
 */
async function gitIdentityOf(dir: string): Promise<GitIdentity | undefined> {
  const key = pathKeyOf(dir)
  if (gitIdentityCache.has(key)) return gitIdentityCache.get(key)
  let identity: GitIdentity | undefined
  try {
    const out = (await runGit(dir, ['rev-parse', '--absolute-git-dir', '--git-common-dir'])).trim().split(/\r?\n/)
    const gitDir = out[0]
    const commonRaw = out[1] ?? ''
    if (gitDir !== undefined && gitDir !== '' && commonRaw !== '') {
      // The common dir comes back relative when the checkout is the main one
      // (`.git`); resolve it against the probed directory, not the process cwd.
      identity = {
        gitDir: requireAbsolute(gitDir),
        commonDir: requireAbsolute(isAbsolute(commonRaw) ? commonRaw : join(dir, commonRaw)),
      }
    }
  } catch {
    identity = undefined
  }
  gitIdentityCache.set(key, identity)
  return identity
}

/**
 * Whether a git top level is a LINKED worktree: its git dir lives under the
 * common dir (`<main>/.git/worktrees/<name>`) instead of being it. Submodules
 * report the same dir for both, so they are excluded.
 *
 * The two dirs are compared through {@link gitIdentityOf}, which returns the
 * COMMON dir as well: the same value identifies the repository a checkout
 * belongs to, which is what {@link isAdoptableTop} compares against the
 * session workspace.
 */
async function isLinkedWorktree(top: string): Promise<boolean> {
  const identity = await gitIdentityOf(top)
  return identity !== undefined && pathKeyOf(identity.gitDir) !== pathKeyOf(identity.commonDir)
}

/**
 * Whether a linked worktree is the session MOVING there, rather than ordinary
 * content of the workspace it already roots (#952).
 *
 * Outside the workspace any linked worktree counts — that is exactly PR #802's
 * case (the session's header cwd points at one repository and the agent works
 * in a worktree of another). Inside the workspace the answer depends on the
 * repository: `.worktrees/<branch>` of the session's OWN repo is the session
 * working on a branch, which the explorer should follow; the linked worktrees
 * of a repository NESTED in the workspace (a bare repo's checkouts, a
 * container workspace's sub-projects) are ordinary content, and adopting one
 * re-roots the explorer into that single subdirectory and hides every sibling
 * — the reported 20-of-27-sessions bug.
 *
 * @param top - a candidate's `git rev-parse --show-toplevel`.
 * @param base - the session's effective workspace root.
 * @returns whether the candidate may become the active root.
 */
async function isAdoptableTop(top: string, base: string): Promise<boolean> {
  if (!(await isLinkedWorktree(top))) return false
  // A base of `/` (or of another filesystem root) puts everything "inside";
  // keeping the check would switch the whole feature off, so treat it as no
  // workspace at all.
  if (pathKeyOf(base) === '' || !pathUnderOf(base, top)) return true
  const candidate = await gitIdentityOf(top)
  const workspace = await gitIdentityOf(base)
  return candidate !== undefined && workspace !== undefined
    && pathKeyOf(candidate.commonDir) === pathKeyOf(workspace.commonDir)
}

/** The newest linked worktree the session's tool/call paths resolve to. */
async function activeRootFromEvents(events: readonly SidebarSessionEvent[], base: string): Promise<string | undefined> {
  if (events.length === 0) return undefined
  const baseKey = pathKeyOf(base)
  const start = Math.max(0, events.length - ACTIVE_ROOT_MAX_EVENTS)
  let probes = 0
  for (let index = events.length - 1; index >= start; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'tool/call') continue
    const weights = new Map<string, ActivePathEntry>()
    collectActivePaths(event.data, weights, false)
    if (weights.size === 0) continue
    const ordered = [...weights.values()].sort((left, right) => right.score - left.score)
    const scores = new Map<string, { top: string; score: number }>()
    for (const candidate of ordered) {
      if (probes >= ACTIVE_ROOT_MAX_PROBES) break
      probes += 1
      const top = await topOfActivePath(candidate.path)
      if (top === undefined) continue
      const topKey = pathKeyOf(top)
      if (topKey === baseKey) continue
      if (!(await isAdoptableTop(top, base))) continue
      const entry = scores.get(topKey)
      if (entry === undefined) scores.set(topKey, { top, score: candidate.score })
      else entry.score += candidate.score
    }
    if (scores.size > 0) {
      let best: string | undefined
      let bestScore = -1
      for (const entry of scores.values()) {
        if (entry.score > bestScore) {
          best = entry.top
          bestScore = entry.score
        }
      }
      if (best !== undefined) return best
    }
    if (probes >= ACTIVE_ROOT_MAX_PROBES) return undefined
  }
  return undefined
}

/** The session's live event log, or the persisted one while it is detached. */
async function sessionEventsOf(ctx: Context, sessionId: string): Promise<readonly SidebarSessionEvent[]> {
  const live = ctx.sessions.get(sessionId)
  // Session-store fakes in tests (and some embedders) expose only the header;
  // a missing snapshot must degrade to the persisted log, never throw.
  const events = typeof live?.snapshotEvents === 'function' ? live.snapshotEvents() : undefined
  if (events !== undefined) return events
  const persisted = await readPersistedSessionOf(ctx, sessionId)
  return persisted?.events ?? []
}

/**
 * The directory the sidebar should treat as the session's root.
 * @param ctx - host plugin context.
 * @param sessionId - session whose tool calls are inspected.
 * @param base - the authoritative session cwd (already resolved by the caller).
 * @returns the active linked worktree, the repository top level, or `base`.
 */
export async function activeWorktreeRootOf(ctx: Context, sessionId: string, base: string): Promise<string> {
  if (base === '') return base
  const override = (process.env[ACTIVE_ROOT_OVERRIDE_ENV] ?? '').trim()
  if (override !== '' && isAbsolute(override)) return requireAbsolute(override)
  // The cache is consulted BEFORE the probe: doing it afterwards still pays the
  // spawn on every ask, which is the whole cost the TTL is there to avoid. The
  // comparison is on the raw base, so a session whose caller switched base (the
  // `/sidebar/*` routes pass the client's own) never reuses the other one's root.
  const cached = activeWorktreeRootCache.get(sessionId)
  if (cached !== undefined && cached.expires > Date.now() && cached.base === base) return cached.root
  const top = await gitTopLevelOf(base)
  if (top === undefined) {
    // "Not inside a repository" is an answer too (the base itself), and caching
    // it is what keeps a non-repo session from re-probing on every ask.
    activeWorktreeRootCache.set(sessionId, { root: base, base, expires: Date.now() + ACTIVE_ROOT_TTL_MS })
    return base
  }
  const canonicalTop = requireAbsolute(top)
  const effectiveBase = pathUnderOf(base, canonicalTop) ? base : canonicalTop
  const active = await activeRootFromEvents(await sessionEventsOf(ctx, sessionId), effectiveBase)
  const root = active ?? effectiveBase
  activeWorktreeRootCache.set(sessionId, { root, base, expires: Date.now() + ACTIVE_ROOT_TTL_MS })
  return root
}
