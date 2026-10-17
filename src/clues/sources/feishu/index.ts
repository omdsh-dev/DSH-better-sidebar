/**
 * `createFeishuSources`: the S9 integration seam for the two built-in Feishu
 * sources.
 *
 * It returns the two S1 source registrations plus the SHARED lark-cli
 * dependency and Feishu authorization connection. The runtime is resolved
 * through a lazy getter: the clue service is constructed with
 * `builtinSources` BEFORE `installCluesRuntime` runs, so capturing a runtime
 * instance here would create a cycle. Building this bundle performs no CLI
 * call and does not even touch the getter.
 *
 * S9 wiring order:
 * 1. `const feishu = createFeishuSources({ runtime: () => runtime! })`
 * 2. `installClues(ctx, { builtinSources: [...feishu.sources] })`
 * 3. `runtime = installCluesRuntime(ctx, clues)`
 * 4. `runtime.dependencies.register(feishu.dependency)`
 * 5. `runtime.connections.register(feishu.connection)`
 */
import type { ClueConnectionDefinition, ClueDependencyDefinition } from '../../runtime/types.ts'
import type { ClueRuntime } from '../../runtime/types.ts'
import type { ClueSourceRegistration } from '../../service.ts'
import { createFeishuDocsSource } from './docs.ts'
import { createFeishuTasksSource } from './tasks.ts'
import { feishuConnectionDefinition, feishuDependencyDefinition } from './definitions.ts'

import type { FeishuSourcesBundle, FeishuSourcesOptions } from './types.ts'

export * from './format.ts'
export {
  createFeishuDocsSource,
} from './docs.ts'
export {
  createFeishuTasksSource,
} from './tasks.ts'
export {
  feishuConnectionDefinition,
  feishuDependencyDefinition,
  larkAuthLoginArgs,
  larkAuthPollArgs,
  larkAuthStatusArgs,
} from './definitions.ts'
export type { FeishuSourcesBundle, FeishuSourcesOptions } from './types.ts'

/**
 * Build the two source registrations and the shared definitions.
 * @param options - lazy runtime accessor.
 */
export function createFeishuSources(options: FeishuSourcesOptions): FeishuSourcesBundle {
  const getRuntime = (): ClueRuntime => options.runtime()
  const sources: readonly ClueSourceRegistration[] = [
    createFeishuDocsSource(getRuntime),
    createFeishuTasksSource(getRuntime),
  ]
  const dependency: ClueDependencyDefinition = feishuDependencyDefinition()
  const connection: ClueConnectionDefinition = feishuConnectionDefinition(getRuntime)
  return { sources, registrations: sources, dependency, connection }
}
