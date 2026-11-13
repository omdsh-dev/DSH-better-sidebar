/**
 * Public option/result shapes of `createFeishuSources` (S4).
 *
 * Node-free so the settings layer may import them type-only.
 */
import type { ClueConnectionDefinition, ClueDependencyDefinition, ClueRuntime } from '../../runtime/types.ts'
import type { ClueSourceRegistration } from '../../service.ts'

/** Options of {@link createFeishuSources}. */
export interface FeishuSourcesOptions {
  /**
   * Lazily resolved S2 runtime. The getter is never called while building the
   * bundle or reading the descriptors — only by an actual CLI operation.
   */
  readonly runtime: () => ClueRuntime
}

/** Everything S9 needs to register the two Feishu sources. */
export interface FeishuSourcesBundle {
  /** The two source registrations (`docs`, then `tasks`). */
  readonly registrations: readonly ClueSourceRegistration[]
  /** The ONE shared lark-cli dependency. */
  readonly dependency: ClueDependencyDefinition
  /** The ONE shared application-config + user-authorization connection. */
  readonly connection: ClueConnectionDefinition
  /** Ids the registrations reference, for settings wiring/assertions. */
  readonly dependencyIds: readonly string[]
  readonly connectionId: string
  readonly typeIds: readonly string[]
}
