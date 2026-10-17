/**
 * Public entry of the clue surface (package subpath `dsh-better-sidebar/clues`).
 *
 * This module is the HOST half: it may use `node:*` (durable storage), and is
 * what an external source plugin imports to register a source on
 * `ctx.betterSidebarClues`. The browser half of the same feature lives under
 * `src/client/clues/` and imports types only from `./types.ts`.
 *
 * Exports, one level deep:
 * - the vocabulary (`types.ts`): source/type descriptors, candidates, reads,
 *   persisted model, error categories, S1 wire params/results;
 * - the service factory and its registration/operation contracts;
 * - the durable store (workspace state + snapshots);
 * - the built-in `builtin.files` source registration;
 * - `installClues`, the Cordis wiring used by the plugin's own `apply`.
 */
import { join } from 'node:path'
import type { Context } from '../context-types.ts'
import { CluesStore } from './store.ts'
import { createCluesService, type ClueSourceRegistration, type CluesService } from './service.ts'
import { registerCluesApi } from './api.ts'
import { createLocalFileSource } from './local-files.ts'

export * from './types.ts'
export * from './store.ts'
export * from './service.ts'
export * from './local-files.ts'
export * from './api.ts'

/**
 * Directory name of this plugin's user data under the DSH profile home.
 *
 * The host has no versioned "plugin data" location, so the plugin picks its
 * own stable child. It is deliberately a plain path under
 * `profileContext.home` (the profile's home, e.g. `~/.dsh`) rather than the
 * current workspace: clue libraries are machine-local per workspace id and
 * must survive workspace removal/renaming of a directory. S2+ specs reuse this
 * directory; changing it is a data migration, not a preference.
 */
const CLUES_DATA_DIR = 'better-sidebar-data'
const CLUES_DATA_SUBDIR = 'clues'

/**
 * The host workspace-registry surface this install needs, restated
 * structurally: only `get(id)?.path` is used, so a deployment with a
 * different registry shape degrades to "no workspace path" (references still
 * persist; only workspace-file reads then fail with a clear reason).
 */
interface WorkspaceRegistryLike {
  get(id: string): { readonly path?: unknown } | undefined
}

/** Options of {@link installClues} (tests inject temp roots and ids). */
export interface InstallCluesOptions {
  /** Override the durable store root (defaults to profileHome/better-sidebar-data/clues). */
  readonly root?: string
  /**
   * Additional CORE-OWNED built-in sources (GitHub/Feishu, supplied by the
   * plugin's own total assembly). They are installed through the reserved-id
   * construction path the same way as `builtin.files`; external plugins can
   * never register a `builtin.*` id through the public service.
   */
  readonly builtinSources?: readonly ClueSourceRegistration[]
  /** Clock injection (tests). */
  readonly now?: () => string
  /** Stable-id generator injection (tests). */
  readonly newId?: (kind: 'clue' | 'pack' | 'snapshot') => string
}

/**
 * Wire the clue service into one Cordis mount: durable store, built-in local
 * source, the `clues.*` API handlers, and the `betterSidebarClues` service.
 *
 * Lifecycle: the service is provided on the current fiber; one `ctx.effect`
 * disposer releases the API registrations, the source registration, and the
 * service registries (persisted data is never touched — an HMR reload must
 * keep every stable reference).
 *
 * @param ctx - the plugin context (profile home, workspace registry, logger).
 * @param options - test seams.
 * @returns the live service face (also available as `ctx.get('betterSidebarClues')`).
 */
export function installClues(ctx: Context, options: InstallCluesOptions = {}): CluesService {
  const profileHome = ctx.profileContext?.home
  const root = options.root ?? (profileHome === undefined
    ? undefined
    : join(profileHome, CLUES_DATA_DIR, CLUES_DATA_SUBDIR))
  if (root === undefined) {
    ctx.logger?.warn?.('dsh-better-sidebar: no profile home; the clue library stays unavailable')
  }
  const store = new CluesStore({ root })
  // `workspaceRegistry` is resolved lazily on every operation: the registry
  // may appear after this plugin, and a missing one is a degraded read, not a
  // reason to refuse to install (references still persist by workspace id).
  const resolveWorkspacePath = (workspaceId: string): string | undefined => {
    try {
      const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
      const workspace = registry?.get(workspaceId)
      const path = workspace?.path
      return typeof path === 'string' && path !== '' ? path : undefined
    } catch {
      return undefined
    }
  }
  const service = createCluesService({
    store,
    // Built-in identities are supplied through the core-only construction
    // path; the public registerSource refuses every reserved id, so a foreign
    // registrant can never claim `builtin.files` (or any other built-in).
    // Later Specs (S3/S4) pass their registrations here through the total
    // assembly; this keeps the reserved-id rule intact for third parties.
    builtinSources: [createLocalFileSource(), ...(options.builtinSources ?? [])],
    resolveWorkspacePath,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.newId === undefined ? {} : { newId: options.newId }),
  })

  const disposeApi = registerCluesApi(service)
  // Cordis' `provide` publishes the face on the current fiber. Test contexts
  // used by the plugin's own route specs are structural fakes that omit it, so
  // the publish is feature-detected; a real mount always has it.
  const provide = (ctx as { provide?: (name: string, value?: unknown) => unknown }).provide
  if (typeof provide === 'function') provide.call(ctx, 'betterSidebarClues', service)
  ctx.effect(() => () => {
    disposeApi()
    service.dispose()
  }, 'dsh-better-sidebar: clue service')
  return service
}

/**
 * Host-only Cordis service augmentation.
 *
 * `installClues` publishes the face at runtime with `ctx.provide`, but without
 * this declaration a source plugin that imports `Context` from
 * `@deepseek-ai/cordis` (plus this package's `./clues` types) cannot see
 * `ctx.betterSidebarClues` and falls back to an `any`-typed
 * `ctx.get('betterSidebarClues')`. It lives here, not in `context-types.ts`,
 * because only the host half can depend on the node-backed service.
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    betterSidebarClues: CluesService
  }
}
