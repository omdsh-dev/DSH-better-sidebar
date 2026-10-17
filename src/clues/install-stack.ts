/**
 * S9 host assembly: install the COMPLETE clue stack for one plugin mount.
 *
 * S1–S8 each export an independently tested installer; this module is the ONE
 * place that composes them into the running host, so no sub-spec had to edit
 * the plugin entry (`src/index.ts`) while the others were still in flight.
 *
 * Wiring order is fixed by the service construction cycle (EXEC-CONTRACTS §3):
 * 1. build the built-in source registrations FIRST, capturing a LAZY runtime
 *    getter — they are passed into `installClues`, which constructs the clue
 *    service, while the runtime that serves them is built afterwards;
 * 2. `installClues(ctx, { builtinSources })` — durable store, local-file
 *    source, `clues.*` API seam and the `betterSidebarClues` service;
 * 3. `installCluesRuntime(ctx, clues)` — the one shared dependency/connection
 *    runtime plus `clues.dependencies.*` / `clues.connections.*`;
 * 4. register the GitHub/Feishu dependency + connection definitions on it;
 * 5. the read-only agent tools and the first-turn context injection;
 * 6. the share service and its four raw `/sidebar/clues/share/*` routes;
 * 7. one read-only workspace lookup for the client (session → workspace id).
 *
 * Lifecycle: every registration is owned by a `ctx.effect` disposer (the
 * installers register their own; this module registers the rest), so an HMR
 * reload releases the previous mount before the new one starts. Persisted
 * clues, packs, pins, bindings and snapshots are never touched by teardown.
 *
 * Nothing here logs secrets, reads a credential, installs a CLI or authorizes
 * an account: those are explicit S2 operations.
 */
import type { Context, SidebarHttpRequest } from '../context-types.ts'
import type { SidebarPrefs } from '../prefs-shared.ts'
import { ClueError } from './error.ts'
import { installClues } from './index.ts'
import type { CluesService } from './service.ts'
import { installCluesRuntime } from './runtime/index.ts'
import type { ClueRuntime } from './runtime/types.ts'
import { installClueTools } from './tools.ts'
import { installClueInjection } from './context/injection.ts'
import {
  createCluesShareRoutes,
  installCluesShare,
  type CluesShareService,
} from './share/index.ts'
import { createGithubSources, type GithubSourcesInstall } from './sources/github/index.ts'
import { createFeishuSources } from './sources/feishu/index.ts'
import type { FeishuSourcesBundle } from './sources/feishu/types.ts'
import type { ClueApiHandler } from './types.ts'

/**
 * The client-facing workspace lookup (session → host workspace id).
 *
 * Clue APIs address a workspace by its STABLE host id, and the browser's
 * workspace list exposes the id too on DSH 0.2.1; older/trimmed shells expose
 * only path + session membership. This method is the authoritative fallback:
 * the HOST resolves the session's registered workspace through the same
 * `workspaceRegistry.resolveByPath` the S5 injection uses (a registry lookup,
 * not a cwd guess — an unregistered directory answers "no workspace").
 *
 * It is read-only and returns only the id, never a path, so it grants no
 * filesystem capability a caller did not already have.
 */
export const CLUES_WORKSPACE_FOR_SESSION_API = 'clues.workspaceForSession'

/** Result of {@link CLUES_WORKSPACE_FOR_SESSION_API}. */
export interface CluesWorkspaceForSessionResult {
  /** The registered workspace id, or null when the session has none. */
  readonly workspaceId: string | null
}

/** Options of {@link installClueStack}. */
export interface InstallClueStackOptions {
  /**
   * Live Side card preferences. Read at injection time (never captured), so a
   * source switch applies to the next new session without a reload. Omitting
   * it keeps the documented "absent entry = enabled" semantics.
   */
  readonly readPrefs?: () => SidebarPrefs
  /**
   * The plugin's browser-trust fence. Applied to EVERY share route PER
   * REQUEST (never once at mount), exactly like the plugin's other routes.
   */
  readonly fence: (req: SidebarHttpRequest) => boolean
}

/** Everything {@link installClueStack} installed (integration tests inspect it). */
export interface InstalledClueStack {
  readonly clues: CluesService
  readonly runtime: ClueRuntime
  readonly share: CluesShareService
  readonly github: GithubSourcesInstall
  readonly feishu: FeishuSourcesBundle
}

/** The host workspace registry subset the lookup consumes (structural). */
interface WorkspaceRegistryLike {
  resolveByPath(path: string): unknown
}

/** One required, non-empty string field of an API payload. */
function requirePayloadString(payload: unknown, key: string): string {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ClueError('invalid-request', 'the clue workspace request payload must be a JSON object')
  }
  const value = (payload as Record<string, unknown>)[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ClueError('invalid-request', `"${key}" must be a non-empty string`)
  }
  return value
}

/**
 * Install the whole clue feature for one host mount.
 * @param ctx - the host plugin context (profile home, sessions, webServer, tools).
 * @param options - live prefs + the per-request browser-trust fence.
 * @returns the live services (also published on the context by the installers).
 */
export function installClueStack(ctx: Context, options: InstallClueStackOptions): InstalledClueStack {
  // The built-in sources need the runtime, but their registrations are handed
  // to `installClues` BEFORE the runtime exists. The getter closes over this
  // holder, so a source operation only resolves it after step 3 has run; an
  // operation that somehow arrives earlier fails as a typed ClueError rather
  // than dereferencing undefined.
  const holder: { runtime?: ClueRuntime } = {}
  const getRuntime = (): ClueRuntime => {
    const value = holder.runtime
    if (value === undefined) throw new ClueError('failed', 'clue runtime is not ready')
    return value
  }

  const github = createGithubSources({ runtime: getRuntime })
  const feishu = createFeishuSources({ runtime: getRuntime })

  const clues = installClues(ctx, {
    builtinSources: [...github.registrations, ...feishu.registrations],
  })
  const runtime = installCluesRuntime(ctx, clues)
  holder.runtime = runtime

  // One effect owns the four definitions. Cordis disposes effects in reverse
  // registration order; inside this effect the disposers are applied in
  // reverse of their own registration too, so the GitHub login adapter is
  // aborted before the connection definition it serves disappears.
  ctx.effect(() => {
    const disposers: Array<() => void> = []
    try {
      disposers.push(runtime!.dependencies.register(github.dependency))
      disposers.push(runtime!.dependencies.register(feishu.dependency))
      disposers.push(runtime!.connections.register(github.connection))
      disposers.push(runtime!.connections.register(feishu.connection))
      disposers.push(() => { github.dispose() })
    } catch (error) {
      for (const dispose of disposers.splice(0).reverse()) dispose()
      throw error
    }
    return () => {
      for (const dispose of disposers.splice(0).reverse()) dispose()
    }
  }, 'dsh-better-sidebar: clue source definitions')

  // The read-only agent tools. A deployment that trims the tool registry must
  // not lose the whole sidebar: the tab/API remain, and the agent simply has
  // no clue tools (S5's spec makes them additive, never a mount requirement).
  ctx.effect(() => {
    try {
      return installClueTools(ctx, clues)
    } catch (error) {
      ctx.logger?.warn?.('dsh-better-sidebar: clue tools are unavailable')
      ctx.logger?.warn?.(error instanceof Error ? error.message : String(error))
      return () => undefined
    }
  }, 'dsh-better-sidebar: clue tools')

  ctx.effect(
    () => installClueInjection(ctx, clues, options.readPrefs === undefined ? {} : { readPrefs: options.readPrefs }),
    'dsh-better-sidebar: clue context injection',
  )

  const share = installCluesShare(ctx, clues)

  // The raw archive routes. S7 keeps the byte-carrying export and the raw ZIP
  // import here (the JSON API dispatcher stays under its 1 MiB control bound);
  // every route re-runs the fence per request and the handlers themselves only
  // ever call the share service.
  ctx.effect(() => {
    const routes = createCluesShareRoutes(share, options.fence)
    const disposers: Array<() => void> = []
    try {
      for (const route of routes.routes) disposers.push(ctx.webServer.register(route))
    } catch (error) {
      for (const dispose of disposers.splice(0).reverse()) dispose()
      throw error
    }
    return () => {
      for (const dispose of disposers.splice(0).reverse()) dispose()
    }
  }, 'dsh-better-sidebar: clue share routes')

  // The client's authoritative workspace lookup. Registered on the ONE clue
  // API seam, so it rides the existing fenced `/sidebar/api` dispatcher (no
  // second route, no second fence).
  const workspaceForSession: ClueApiHandler = async (payload) => {
    const sessionId = requirePayloadString(payload, 'sessionId')
    const session = ctx.sessions?.get(sessionId)
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') return { workspaceId: null }
    let registry: WorkspaceRegistryLike | undefined
    try {
      const candidate = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
      registry = candidate !== null && typeof candidate === 'object' ? candidate : undefined
    } catch {
      registry = undefined
    }
    if (registry === undefined || typeof registry.resolveByPath !== 'function') {
      return { workspaceId: null }
    }
    try {
      const workspace = await registry.resolveByPath(cwd) as { readonly id?: unknown } | undefined
      const id = workspace?.id
      return { workspaceId: typeof id === 'string' && id !== '' ? id : null }
    } catch {
      // An unregistered/removed directory is "no workspace", never a 500.
      return { workspaceId: null }
    }
  }
  ctx.effect(() => clues.registerApi(CLUES_WORKSPACE_FOR_SESSION_API, workspaceForSession),
    'dsh-better-sidebar: clue workspace lookup')

  return { clues, runtime, share, github, feishu }
}
