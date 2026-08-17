/**
 * Verified-path cache for chat path / path:line mentions.
 *
 * MarkdownText's mention `resolve()` is synchronous and runs once per
 * settled render — it cannot await a filesystem check. To honor "only
 * real files become links", this module keeps a client-side cache of
 * paths KNOWN to exist and answers membership synchronously.
 *
 * The cache is seeded by a BOUNDED recursive workspace scan
 * (`fs.index`, host half): whenever a session (workspace) becomes active,
 * the tree is walked once and every indexed path is marked verified.
 * Paths the scan missed (created after the scan, inside a skipped
 * heavyweight directory like node_modules, or beyond the scan bounds)
 * fall back to a rare per-path `fs.read` probe — deduped in flight and
 * negative-cached with a TTL, so a message re-render never re-probes a
 * missing file.
 *
 * Dependency-free (no React / DOM): injectable scope, resolution, index
 * fetch and probe.
 */

/** How long a failed probe stays cached (a missing path is NOT re-probed
 *  within this window on every message re-render). */
const FAILED_TTL_MS = 2 * 60_000

/** Soft cap on verified entries (a big repo can exceed it; oldest evicted). */
const VERIFIED_CAP = 50_000

export interface PathVerifierDeps {
  /** The session scope (undefined → scans/probes are skipped). */
  scope(): { sessionId: string; cwd?: string } | undefined
  /** Resolve a (possibly relative) path to the absolute probe target. */
  resolveAbsolute(path: string): string
  /** Fetch the bounded workspace index (absolute paths). */
  fetchIndex(scope: { sessionId: string; cwd?: string }): Promise<string[]>
  /** Probe existence of one absolute path (fallback for index misses). */
  probe(scope: { sessionId: string; cwd?: string }, absolute: string): Promise<boolean>
}

export interface PathVerifier {
  /** Whether `path` is known to exist; fires a background probe when unknown. */
  check(path: string): boolean
  /** Whether `path` is known to exist (no side effects). */
  has(path: string): boolean
  /** Ensure the current workspace is (being) scanned; seed verified entries. */
  warm(): void
  /** Reset all state (per-activation hygiene). */
  clear(): void
}

/** One verifier instance bound to its deps (one per plugin activation). */
export function createPathVerifier(deps: PathVerifierDeps): PathVerifier {
  const verified = new Set<string>()
  const failed = new Map<string, number>()
  const probing = new Map<string, Promise<void>>()
  /** First-seen order for the bounded cache (oldest evicted first). */
  const order: string[] = []
  /** Workspaces (cwd keys) already scanned / currently scanning. */
  const scanned = new Set<string>()

  const add = (path: string): void => {
    if (verified.has(path)) return
    verified.add(path)
    failed.delete(path)
    order.push(path)
    if (order.length > VERIFIED_CAP) {
      const evicted = order.shift()
      if (evicted !== undefined) verified.delete(evicted)
    }
  }

  /** Kick off the bounded workspace scan for the current cwd (once each). */
  const warm = (): void => {
    const scope = deps.scope()
    if (scope === undefined) return
    const cwd = scope.cwd ?? ''
    if (scanned.has(cwd)) return
    scanned.add(cwd)
    void deps.fetchIndex(scope)
      .then((paths) => { for (const path of paths) add(path) })
      .catch(() => { /* scan failure degrades to per-path probes */ })
  }

  /** Rare fallback probe for one absolute path (index misses / new files). */
  const probe = (absolute: string): void => {
    if (verified.has(absolute) || probing.has(absolute)) return
    const now = Date.now()
    const failedAt = failed.get(absolute)
    if (failedAt !== undefined && now - failedAt < FAILED_TTL_MS) return
    const scope = deps.scope()
    if (scope === undefined) return
    const inflight = deps.probe(scope, absolute)
      .then((exists) => {
        if (exists) add(absolute)
        else failed.set(absolute, Date.now())
      })
      .catch(() => { failed.set(absolute, Date.now()) })
      .finally(() => { probing.delete(absolute) })
    probing.set(absolute, inflight)
  }

  const check = (path: string): boolean => {
    const absolute = deps.resolveAbsolute(path)
    if (verified.has(absolute)) return true
    warm()
    probe(absolute)
    return false
  }

  const has = (path: string): boolean => verified.has(deps.resolveAbsolute(path))

  const clear = (): void => {
    verified.clear()
    failed.clear()
    probing.clear()
    scanned.clear()
    order.length = 0
  }

  return { check, has, warm, clear }
}
