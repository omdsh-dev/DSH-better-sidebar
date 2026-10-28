/**
 * Optional dsh-zen-remote bridge declaration (cooperative protocol v2).
 *
 * When the host ALSO runs dsh-zen-remote >= 2.3.4, this module hands it a
 * "bridge declaration" covering every network surface this plugin serves:
 * in a REMOTE session (a phone/sub-client driving a session that lives on
 * the main server) zen-remote then re-routes these requests to the SERVER's
 * own copy of this plugin, so the file tree, git panels and side chat act on
 * the server's files instead of the phone's. Without dsh-zen-remote the
 * `ctx.inject(['zenRemote'], …)` never fires and this module is inert — no
 * runtime dependency is added to this package.
 *
 * The declaration is DERIVED from the live API dispatch table rather than
 * hand-copied: a new API method appears here automatically with the default
 * shape, and the per-method overrides below only encode what static shape
 * knowledge a remote re-router must have (where the session id sits, which
 * answers mint NEW session ids, which method must never run for a remote
 * session). The authoritative field contract lives in dsh-zen-remote's
 * docs/plugin-bridge.md; the types below are the minimal structural mirror
 * (kept local so this package carries no dependency on zen-remote).
 */

/** Minimal structural mirror of dsh-zen-remote's `ZenRemoteService`. */
interface ZenRemoteBridgeService {
  /** Register this process's bridge declaration; returns the dispose. */
  bridge(declaration: ZenRemoteBridgeDeclaration): () => void
}

/** Minimal structural mirror of dsh-zen-remote's `BridgeDeclaration` (v2). */
interface ZenRemoteBridgeDeclaration {
  plugin: string
  version: string
  routes: ZenRemoteBridgeRoute[]
}

interface ZenRemoteBridgeRoute {
  path: string
  /** `'server'` — every route here is whole-machine data; zen-remote gates
   * the whole declaration behind the server owner's per-plugin consent. */
  scope: 'server'
  /** v1 query-param locating (default parameter name `sessionId`). */
  sessionParam?: string
  /** v2: locate the session id in top-level JSON body fields. */
  locator?: { in: 'json-body'; fields: string[] } | { in: 'path-segment'; index: number }
  prefix?: true
  deny?: true
  /** v2: creation-style answers mint session ids the request never carried;
   * `fields` names where they sit so zen-remote can wrap them virtual. */
  rewriteIds?: true | { fields: string[] }
  methods?: string[]
  upgrade?: true
}

import type { Context } from './context-types.ts'

/** One API method dispatch table entry (same shape index.ts builds). */
type ApiMethod = (payload: unknown, signal?: AbortSignal) => Promise<unknown> | unknown

/**
 * Per-method overrides for the derived declaration. Everything not listed
 * uses the default: session id in the `sessionId` JSON body field, no
 * rewrite. `skip` marks methods that must STAY on each machine's own plugin
 * (per-machine settings/model catalog) — they are deliberately undeclared,
 * which zen-remote reads as "local".
 */
const API_METHOD_OVERRIDES: Record<string, { childId?: true; deny?: true; rewrite?: { fields: string[] }; skip?: true }> = {
  // Side chat threads address the CHILD session: the id rides `childId`.
  'sidechat.prompt': { childId: true },
  'sidechat.cancel': { childId: true },
  'sidechat.dispose': { childId: true },
  'sidechat.info': { childId: true },
  'sidechat.events': { childId: true },
  'sidechat.dequeue': { childId: true },
  'sidechat.model': { childId: true },
  // Starting a thread MINTS a child session: the answer's `value.childId`
  // must come back wrapped virtual or the phone's follow-up calls would
  // target its own machine.
  'sidechat.start': { rewrite: { fields: ['value.childId'] } },
  // `open.external` launches a process on the machine serving the request —
  // exactly what must NOT happen on a remote session's sub-client.
  'open.external': { deny: true },
  // Per-machine surfaces: own settings, own model catalog.
  'settings.get': { skip: true },
  'settings.update': { skip: true },
  'sidechat.models': { skip: true },
}

/** The static routes outside the `/sidebar/api` dispatch table, mirroring
 * the registrations in index.ts: session ids ride the `sessionId` query
 * parameter (the html preview carries it as the first path segment after
 * the prefix). The two WebSockets declare `upgrade` and cross as bytes. */
function staticRoutes(): ZenRemoteBridgeRoute[] {
  return [
    { path: '/sidebar/file', scope: 'server', methods: ['GET'] },
    { path: '/sidebar/archive', scope: 'server', methods: ['GET'] },
    { path: '/sidebar/upload', scope: 'server', methods: ['POST'] },
    { path: '/sidebar/write', scope: 'server', methods: ['POST'] },
    { path: '/sidebar/html', scope: 'server', prefix: true, locator: { in: 'path-segment', index: 0 }, methods: ['GET'] },
    { path: '/sidebar/ws/fs-watch', scope: 'server', upgrade: true },
    { path: '/sidebar/ws/agent-opens', scope: 'server', upgrade: true },
  ]
}

/** Derive the full bridge route list from the live dispatch table. */
export function buildZenRemoteRoutes(api: Record<string, ApiMethod>): ZenRemoteBridgeRoute[] {
  const routes: ZenRemoteBridgeRoute[] = []
  for (const method of Object.keys(api)) {
    const meta = API_METHOD_OVERRIDES[method]
    if (meta?.skip === true) continue
    const route: ZenRemoteBridgeRoute = {
      path: `/sidebar/api/${method}`,
      scope: 'server',
      locator: { in: 'json-body', fields: [meta?.childId === true ? 'childId' : 'sessionId'] },
      methods: ['POST'],
    }
    if (meta?.deny === true) route.deny = true
    if (meta?.rewrite !== undefined) route.rewriteIds = meta.rewrite
    routes.push(route)
  }
  routes.push(...staticRoutes())
  return routes
}

/**
 * Register the declaration when dsh-zen-remote is present. Called from
 * apply() with the freshly built API table; the inject only fires on hosts
 * that provide the `zenRemote` service, and the dispose rides ctx.effect so
 * a row unload withdraws the declaration cleanly.
 */
export function registerZenRemoteBridge(ctx: Pick<Context, 'inject' | 'effect' | 'logger'>, api: Record<string, ApiMethod>, version: string): void {
  ctx.inject(['zenRemote'], (sctx: unknown) => {
    const service = (sctx as { zenRemote?: unknown }).zenRemote as ZenRemoteBridgeService | undefined
    if (service === undefined || typeof service.bridge !== 'function') {
      ctx.logger?.warn?.('dsh-better-sidebar: host provides a zenRemote service without bridge(); skipping the remote-session declaration')
      return
    }
    let dispose: (() => void) | undefined
    try {
      dispose = service.bridge({
        plugin: 'dsh-better-sidebar',
        version,
        routes: buildZenRemoteRoutes(api),
      })
    } catch (error) {
      ctx.logger?.warn?.(`dsh-better-sidebar: zen-remote bridge declaration refused: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    ctx.effect(() => dispose, 'dsh-better-sidebar: zen-remote bridge declaration')
  })
}
