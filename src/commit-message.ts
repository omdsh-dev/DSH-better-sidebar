/**
 * Commit-message suggestion: the prompt contract and the model-route
 * vocabulary shared by the `git.suggest-message` host route (src/index.ts)
 * and its tests. Deliberately free of cordis, git and the LLM service, so
 * the wording and the route parse stay unit-testable without a host.
 *
 * The generation itself runs through the harness LLM service (`ctx.llm`) with
 * the route the CONVERSATION runs on by default, or a route the user pinned in
 * the Git card's settings (see {@link parseModelRoute}). The plugin never
 * touches a credential: the harness resolves provider endpoints and keys.
 */

/** Max diff characters fed to the model. A huge change set is truncated (with
 *  an explicit marker) so bulk renames or generated-file diffs cannot flood
 *  the model context. */
export const SUGGEST_DIFF_LIMIT = 12_000

/** The prompt languages the suggestion supports (the panel's own locale). */
export type CommitPromptLanguage = 'zh' | 'en'

/** One assembled suggestion request (system + user halves). */
export interface CommitPrompt {
  system: string
  user: string
}

/** One provider/model route — the pair the LLM service dispatches on. */
export interface CommitModelRoute {
  provider: string
  model: string
}

/** Narrow an untrusted language value to the supported pair. */
export function normalizeLanguage(value: unknown): CommitPromptLanguage {
  return value === 'zh' ? 'zh' : 'en'
}

/** Truncate one diff to {@link SUGGEST_DIFF_LIMIT}, marking the cut. */
export function truncateDiff(diff: string): string {
  if (diff.length <= SUGGEST_DIFF_LIMIT) return diff
  return `${diff.slice(0, SUGGEST_DIFF_LIMIT)}\n...(diff truncated)`
}

/**
 * Parse a pinned route of the form `provider/model`. The FIRST slash splits:
 * a model id may carry its own slashes (e.g. a vendor-prefixed id), the
 * provider never does. Anything malformed (empty half, no slash) yields
 * undefined so the caller falls back to the conversation's own route.
 */
export function parseModelRoute(value: unknown): CommitModelRoute | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1) return undefined
  const provider = trimmed.slice(0, slash).trim()
  const model = trimmed.slice(slash + 1).trim()
  if (provider === '' || model === '') return undefined
  return { provider, model }
}

/** Render one route back into its stored form (the select value). */
export function formatModelRoute(route: CommitModelRoute): string {
  return `${route.provider}/${route.model}`
}

/** Cap of the conversation-derived route list (the adapter catalog is
 *  capped separately, host-side). */
export const MODEL_ROUTE_HISTORY_LIMIT = 20

/** First non-empty string among the candidates (unknown-shape reads). */
function firstString(...values: readonly unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/**
 * One provider entry of the harness LLM catalog, read tolerantly: the
 * adapter-registration shape is not part of this plugin's contract, so every
 * plausible field is probed and an entry that yields no route is dropped
 * (never guessed) — a wrong route would fail at generation time instead.
 * @param entry - one `listProviders()` element.
 * @returns the provider route and a display label, or undefined.
 */
export function providerEntryOf(entry: unknown): { provider: string; label: string } | undefined {
  if (entry === null || typeof entry !== 'object') return undefined
  const record = entry as Record<string, unknown>
  const provider = firstString(record.provider, record.route, record.id)
  if (provider === '') return undefined
  const label = firstString(record.name, record.displayName, record.label, record.title, provider)
  return { provider, label }
}

/**
 * One model entry of a provider's advertised catalog (same tolerant read as
 * {@link providerEntryOf}).
 * @param entry - one `listModels()` element.
 * @returns the model id and a display name, or undefined.
 */
export function modelEntryOf(entry: unknown): { id: string; name: string } | undefined {
  if (entry === null || typeof entry !== 'object') return undefined
  const record = entry as Record<string, unknown>
  const id = firstString(record.id, record.model, record.name)
  if (id === '') return undefined
  return { id, name: firstString(record.name, record.displayName, record.label, record.title, id) }
}

/**
 * The harness's default model selection (settings namespace
 * `agent-default-model`), read tolerantly: it is the route a NEW conversation
 * would use, so it is available before any message is sent — unlike the
 * conversation-derived history.
 * @param selection - `agentDefaultModel.currentSelection()`.
 * @returns the default route, or undefined when the service or its value is
 * unavailable.
 */
export function defaultRouteOf(selection: unknown): CommitModelRoute | undefined {
  if (selection === null || typeof selection !== 'object') return undefined
  const record = selection as Record<string, unknown>
  const provider = firstString(record.provider)
  const model = firstString(record.model)
  if (provider === '' || model === '') return undefined
  return { provider, model }
}

/**
 * Every provider/model route a session's log has actually USED, newest first
 * and de-duplicated: the newest `request/header` event wins, so the list is
 * the routes this deployment really dispatched on — the fallback a pinned
 * model picker can always offer, even when the harness advertises no catalog.
 * @param events - the session's log events (newest last).
 * @param limit - max routes to return.
 * @returns the distinct routes, newest first.
 */
export function collectModelRoutes(
  events: readonly { type?: unknown; data?: unknown }[],
  limit = MODEL_ROUTE_HISTORY_LIMIT,
): CommitModelRoute[] {
  const routes: CommitModelRoute[] = []
  const seen = new Set<string>()
  for (let index = events.length - 1; index >= 0 && routes.length < limit; index--) {
    const event = events[index]
    if (event === undefined || event.type !== 'request/header') continue
    const config = (event.data as { header?: { config?: unknown } } | undefined)?.header?.config
    if (config === null || typeof config !== 'object') continue
    const provider = (config as { provider?: unknown }).provider
    const model = (config as { model?: unknown }).model
    if (typeof provider !== 'string' || provider === '') continue
    if (typeof model !== 'string' || model === '') continue
    const key = `${provider}/${model}`
    if (seen.has(key)) continue
    seen.add(key)
    routes.push({ provider, model })
  }
  return routes
}

/**
 * The Conventional-Commits prompt for one pending change set. Staged wins
 * upstream (it is exactly what `git commit` records); `files` is the matching
 * path list and `diff` the already-truncated patch text.
 * @param language - the panel locale ('zh' | 'en').
 * @param files - the changed paths the diff covers (repo-root relative).
 * @param diff - the patch text (truncate with {@link truncateDiff} first).
 * @returns the system and user halves, in that language.
 */
export function buildCommitPrompt(
  language: CommitPromptLanguage,
  files: readonly string[],
  diff: string,
): CommitPrompt {
  const fileList = files.join('\n')
  if (language === 'zh') {
    return {
      system: '你是 git 提交信息生成助手。根据给定的文件清单与差异，生成一行 Conventional Commits 风格的中文提交信息'
        + '（类型前缀：feat/fix/refactor/chore/docs/test/perf/style，必要时可附简短正文）。'
        + '只输出提交信息本身，不要解释。',
      user: `改动的文件：\n${fileList}\n\n差异：\n${diff}`,
    }
  }
  return {
    system: 'You are a git commit message assistant. Based on the given file list and diff, write a one-line'
      + ' Conventional Commits style commit message in English (type prefix: feat/fix/refactor/chore/docs/test/perf/style,'
      + ' with a short body when needed). Output only the commit message itself, no explanation.',
    user: `Changed files:\n${fileList}\n\nDiff:\n${diff}`,
  }
}

/** Drop the model's prose scaffolding: fenced blocks, quotes and blank runs.
 *  Models routinely wrap a one-line commit message in a code fence despite
 *  the instruction; the panel inserts the text straight into the commit box,
 *  so anything but the message itself would land in the commit. */
export function cleanSuggestion(text: string): string {
  const withoutFence = text
    .split('\n')
    .filter(line => !line.trimStart().startsWith('```'))
    .join('\n')
  return withoutFence
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trim()
}
