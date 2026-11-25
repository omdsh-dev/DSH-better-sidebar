/**
 * Community "Featured plugins" integration (the dsh-featured ecosystem).
 *
 * The full `dsh-featured` plugin owns the rich tab. Peer plugins integrate
 * through this module in their host `apply`:
 *
 *  1. Contribute a catalog source to the cross-plugin `featured-plugins`
 *     service. The first activated integrator provides the service; later
 *     ones register into the existing registry and stop there.
 *  2. The provider (owner) additionally serves the aggregate route
 *     `GET /dsh-plugins-plugin/featured`, merging the remote community
 *     catalog (5-minute cache, dual mirrors, newest wins) with every
 *     registered source. A duplicate registration yields silently.
 *
 * Joining does not promise a listing: what shows up in the featured catalog
 * is decided by the skillpie.cn curation flow, so `FEATURED_SOURCE` ships
 * with an empty entry list. The integration contract lives in the
 * dsh-featured repo's AI-INTEGRATION.md.
 *
 * The route is declared `anonymous` and enforces its own same-origin check
 * (browser `Origin` vs `Host`), matching the house rule that every route
 * owns its admission logic. No timers and no module-level state: the remote
 * cache and the registry live inside the caller's fiber, and the installed
 * bundle map is computed per request.
 *
 * @module dsh-better-sidebar/featured-source
 */
import type { Context, SidebarHttpRequest, SidebarHttpResponse, SidebarWebRoute } from './context-types.ts'

/** The exact aggregate route the full plugin and peer inline entries read. */
export const FEATURED_ROUTE = '/dsh-plugins-plugin/featured'

/** Cross-plugin service id; the first activated integrator provides it. */
export const FEATURED_SERVICE = 'featured-plugins'

/** Remote catalog cache lifetime (the curated list moves at most every few minutes). */
const REMOTE_TTL_MS = 5 * 60_000

/** Per-mirror fetch timeout: a dead mirror must not hold the route open. */
const FETCH_TIMEOUT_MS = 8_000

/** Concurrent catalog mirrors. jsdelivr is cached and may lag behind raw. */
const REMOTE_CATALOG_URLS = [
  'https://cdn.jsdelivr.net/gh/skillpie/dsh-plugins@main/dsh-plugins-plugin/plugins.json',
  'https://raw.githubusercontent.com/skillpie/dsh-plugins/main/dsh-plugins-plugin/plugins.json',
] as const

/** Optional text fields a catalog entry may carry. */
const ENTRY_TEXT_KEYS = ['description', 'version', 'icon', 'homepage', 'author', 'category'] as const

/** Rich fields an own entry can inherit from the remote catalog. */
const RICH_KEYS = ['description', 'version', 'icon', 'homepage', 'author', 'category', 'screenshots', 'stars', 'downloads'] as const

/** The remote catalog's own source id (rich-field backfill never rewrites it). */
const REMOTE_SOURCE_ID = 'plugins.json'

/** One catalog entry. `package` and `title` are required; the rest is optional. */
export interface FeaturedEntry {
  package: string
  title: string
  source: string
  description?: string
  version?: string
  icon?: string
  homepage?: string
  author?: string
  category?: string
  screenshots?: string[]
  stars?: number
  downloads?: number
  tags?: string[]
}

/** One registered source: what an integrating plugin contributes. */
export interface FeaturedSource {
  id: string
  title: string
  entries: FeaturedEntry[]
}

/** The cross-plugin registry face: register returns a disposer. */
export interface FeaturedRegistry {
  register(rawSource: FeaturedSource): () => void
  list(): FeaturedSource[]
}

/** The aggregate route payload. */
export interface FeaturedAggregate {
  entries: FeaturedEntry[]
  sources: Array<{ id: string, title: string, count: number }>
  installed: Record<string, string>
  remote: { fetchedAt: string, count: number } | null
}

/** The source this plugin contributes (entries stay empty: curation is community-side). */
export const FEATURED_SOURCE: FeaturedSource = {
  id: 'dsh-better-sidebar',
  title: 'Better Sidebar',
  entries: [],
}

/** The raw remote catalog document: an `updated` stamp plus an entry list. */
interface RemoteCatalogDoc {
  updated?: unknown
  entries?: unknown
}

/** Trimmed text of a string; numbers stringify; everything else is empty. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** Normalized screenshot list: strings only, deduplicated, capped at four. */
function screenshotsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const shots: string[] = []
  for (const item of value) {
    const shot = textOf(item)
    if (shot !== '' && !shots.includes(shot)) shots.push(shot)
    if (shots.length === 4) break
  }
  return shots.length > 0 ? shots : undefined
}

/** Normalized tag list: strings only, deduplicated, capped at eight. */
function tagsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tags: string[] = []
  for (const item of value) {
    const tag = textOf(item)
    if (tag !== '' && !tags.includes(tag)) tags.push(tag)
    if (tags.length === 8) break
  }
  return tags.length > 0 ? tags : undefined
}

/** Non-negative finite count (stars / downloads); everything else is dropped. */
function countOf(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return value
}

/** Normalize one raw entry; `null` when a required field is missing. */
function normalizeEntry(raw: unknown, sourceId: string): FeaturedEntry | null {
  if (raw === null || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const pkg = textOf(row.package ?? row.name)
  const title = textOf(row.title)
  if (pkg === '' || title === '') return null
  const entry: FeaturedEntry = { package: pkg, title, source: sourceId }
  for (const key of ENTRY_TEXT_KEYS) {
    const value = textOf(row[key])
    if (value !== '') entry[key] = value
  }
  const screenshots = screenshotsOf(row.screenshots)
  if (screenshots !== undefined) entry.screenshots = screenshots
  const stars = countOf(row.stars)
  if (stars !== undefined) entry.stars = stars
  const downloads = countOf(row.downloads)
  if (downloads !== undefined) entry.downloads = downloads
  const tags = tagsOf(row.tags)
  if (tags !== undefined) entry.tags = tags
  return entry
}

/** Normalize one source; throws when the id (the integrating package name) is missing. */
export function normalizeSource(raw: FeaturedSource): FeaturedSource {
  if (raw === null || typeof raw !== 'object') throw new Error('featured source must be an object')
  const id = textOf(raw.id)
  if (id === '') throw new Error('featured source needs an id (the integrating package name)')
  const title = textOf(raw.title) !== '' ? textOf(raw.title) : id
  const rawEntries = Array.isArray(raw.entries) ? raw.entries : []
  const entries: FeaturedEntry[] = []
  for (const item of rawEntries) {
    const entry = normalizeEntry(item, id)
    if (entry !== null) entries.push(entry)
  }
  return { id, title, entries }
}

/** Freshness score of a catalog doc: updated stamp, then entry count, then version mass. */
function catalogScoreOf(doc: RemoteCatalogDoc): { at: number, count: number, versions: number } {
  const at = Date.parse(textOf(doc.updated))
  const entries = Array.isArray(doc.entries) ? doc.entries : []
  let versions = 0
  for (const item of entries) {
    const row = (item ?? {}) as Record<string, unknown>
    const parts = textOf(row.version ?? '0.0.0').split('.')
    const major = Number.parseInt(parts[0] ?? '', 10) || 0
    const minor = Number.parseInt(parts[1] ?? '', 10) || 0
    const patch = Number.parseInt(parts[2] ?? '', 10) || 0
    versions += major * 1_000_000 + minor * 1_000 + patch
  }
  return { at: Number.isFinite(at) ? at : 0, count: entries.length, versions }
}

/** Whether `a` is strictly newer than `b` under the three-factor ordering. */
function isNewerCatalog(a: { at: number, count: number, versions: number }, b: { at: number, count: number, versions: number }): boolean {
  if (a.at !== b.at) return a.at > b.at
  if (a.count !== b.count) return a.count > b.count
  return a.versions > b.versions
}

/**
 * Fetch one mirror; `null` on any failure (HTTP status, shape, network).
 * A dead mirror must never break the route — the other one answers instead.
 */
async function fetchCatalogAt(url: string): Promise<RemoteCatalogDoc | null> {
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    })
    if (!response.ok) return null
    const doc = await response.json() as RemoteCatalogDoc
    return Array.isArray(doc.entries) ? doc : null
  } catch {
    return null
  }
}

/** Same-origin check: browsers always send `Origin`; same-origin fetch matches `Host`. */
function sameOriginOf(req: SidebarHttpRequest): boolean {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/** JSON response with the no-store cache policy every dynamic route here uses. */
function writeJson(res: SidebarHttpResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Installed bundle names to versions, computed per request; `{}` when unavailable. */
async function installedMapOf(ctx: Context): Promise<Record<string, string>> {
  let manager: unknown
  try {
    manager = ctx.get('pluginManager')
  } catch {
    return {}
  }
  const listBundles = (manager as { listBundles?: unknown } | undefined)?.listBundles
  if (typeof listBundles !== 'function') return {}
  try {
    const bundles = await (listBundles as () => Promise<unknown>)()
    if (!Array.isArray(bundles)) return {}
    const installed: Record<string, string> = {}
    for (const bundle of bundles) {
      const row = (bundle ?? {}) as Record<string, unknown>
      if (typeof row.name === 'string' && row.name !== '' && Boolean(row.installed)) {
        installed[row.name] = typeof row.version === 'string' ? row.version : ''
      }
    }
    return installed
  } catch {
    return {}
  }
}

/** Aggregate one remote doc with the registry sources: first-by-package wins, rich fields backfilled. */
function aggregateOf(ctx: Context, registry: FeaturedRegistry, remote: RemoteCatalogDoc | null, remoteAt: number): Promise<FeaturedAggregate> {
  const installed = installedMapOf(ctx)
  const remoteEntries = remote !== null && Array.isArray(remote.entries) ? remote.entries : []
  const remoteIndex = new Map<string, Record<string, unknown>>()
  for (const raw of remoteEntries) {
    const row = (raw ?? {}) as Record<string, unknown>
    const pkg = textOf(row.package ?? row.name)
    if (pkg !== '' && !remoteIndex.has(pkg)) remoteIndex.set(pkg, row)
  }
  const seen = new Set<string>()
  const entries: FeaturedEntry[] = []
  const push = (entry: FeaturedEntry | null): void => {
    if (entry === null || seen.has(entry.package)) return
    seen.add(entry.package)
    const rich = remoteIndex.get(entry.package)
    if (rich !== undefined && entry.source !== REMOTE_SOURCE_ID) {
      const row = entry as unknown as Record<string, unknown>
      for (const key of RICH_KEYS) {
        if (row[key] === undefined && rich[key] !== undefined) row[key] = rich[key]
      }
    }
    entries.push(entry)
  }
  for (const raw of remoteEntries) push(normalizeEntry(raw, REMOTE_SOURCE_ID))
  for (const source of registry.list()) {
    for (const entry of source.entries) push(entry)
  }
  return installed.then((map) => ({
    entries,
    sources: registry.list().map((source) => ({ id: source.id, title: source.title, count: source.entries.length })),
    installed: map,
    remote: remote !== null ? { fetchedAt: new Date(remoteAt).toISOString(), count: entries.length } : null,
  }))
}

/** Build the exact aggregate route (same-origin GET only, failures degrade to `ok:false`). */
function featuredRouteOf(aggregate: () => Promise<FeaturedAggregate>): SidebarWebRoute {
  return {
    auth: 'anonymous',
    kind: 'exact',
    path: FEATURED_ROUTE,
    handler: async (req, res) => {
      try {
        if (!sameOriginOf(req)) {
          writeJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
          return
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          writeJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        writeJson(res, 200, { ok: true, data: await aggregate() })
      } catch (error) {
        writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }
}

/** Human-readable reason of one error (log lines stay one line). */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Integrate into the dsh-featured ecosystem from a host `apply`.
 * @param ctx - the host plugin context.
 * @param source - the catalog source this plugin contributes (entries may be empty).
 */
export function integrateFeaturedPlugins(ctx: Context, source: FeaturedSource): void {
  let registry: FeaturedRegistry | undefined
  let owner = false
  try {
    registry = ctx.get(FEATURED_SERVICE) as FeaturedRegistry | undefined
  } catch {
    registry = undefined
  }
  if (registry === undefined || typeof registry.register !== 'function' || typeof registry.list !== 'function') {
    const sources = new Map<string, FeaturedSource>()
    const created: FeaturedRegistry = {
      register(rawSource: FeaturedSource) {
        const normalized = normalizeSource(rawSource)
        sources.set(normalized.id, normalized)
        return () => {
          if (sources.get(normalized.id) === normalized) sources.delete(normalized.id)
        }
      },
      list() {
        return [...sources.values()]
      },
    }
    try {
      ctx.effect(() => {
        ctx.provide(FEATURED_SERVICE, created)
        return () => {}
      }, 'dsh-better-sidebar: featured plugins registry service')
      owner = true
    } catch (error) {
      // Already provided by a concurrently activating integrator: stay a
      // pure data contributor on the local registry.
      ctx.logger?.warn?.(`dsh-better-sidebar: featured-plugins service stays with another provider: ${reasonOf(error)}`)
    }
    registry = created
  }
  registerSource(ctx, registry, source)
  if (owner) mountOwnerRoute(ctx, registry)
}

/** Contribute one source on a child scope, so plugin disposal unregisters it. */
function registerSource(ctx: Context, registry: FeaturedRegistry, source: FeaturedSource): void {
  try {
    ctx.inject([], (child) => {
      child.effect(() => registry.register(source), `dsh-better-sidebar: featured source ${source.id}`)
    })
  } catch (error) {
    ctx.logger?.warn?.(`dsh-better-sidebar: cannot register the featured source: ${reasonOf(error)}`)
  }
}

/** Owner-only duties: the remote catalog cache and the aggregate route. */
function mountOwnerRoute(ctx: Context, registry: FeaturedRegistry): void {
  let remoteCache: { at: number, doc: RemoteCatalogDoc | null } = { at: 0, doc: null }
  const fetchRemoteCatalog = async (): Promise<RemoteCatalogDoc | null> => {
    const now = Date.now()
    if (remoteCache.doc !== null && now - remoteCache.at < REMOTE_TTL_MS) return remoteCache.doc
    const docs = (await Promise.all(REMOTE_CATALOG_URLS.map((url) => fetchCatalogAt(url)))).filter((doc) => doc !== null)
    if (docs.length === 0) return null
    // Newest wins under the three-factor ordering; ties keep the array order
    // (jsdelivr first) — raw is usually fresher but a tie means equal data.
    const best = docs.reduce((a, b) => (isNewerCatalog(catalogScoreOf(b), catalogScoreOf(a)) ? b : a))
    remoteCache = { at: now, doc: best }
    return best
  }
  const aggregate = async (): Promise<FeaturedAggregate> => {
    const remote = await fetchRemoteCatalog().catch(() => null)
    return aggregateOf(ctx, registry, remote, remoteCache.at)
  }
  try {
    ctx.inject(['webServer'], (child) => {
      child.effect(() => {
        let dispose: (() => void) | undefined
        try {
          dispose = (child as Context).webServer.register(featuredRouteOf(aggregate))
        } catch (error) {
          // The route is already served by another integrator; this side
          // remains a data source.
          ctx.logger?.warn?.(`dsh-better-sidebar: featured route stays with another provider: ${reasonOf(error)}`)
        }
        return () => {
          dispose?.()
        }
      }, 'dsh-better-sidebar: featured plugins route')
    })
  } catch (error) {
    ctx.logger?.warn?.(`dsh-better-sidebar: cannot serve the featured route: ${reasonOf(error)}`)
  }
}
