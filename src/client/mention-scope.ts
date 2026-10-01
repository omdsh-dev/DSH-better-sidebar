/**
 * The turn-local file scope a prose mention may resolve against.
 *
 * DSH's own mention vocabulary (@deepseek-ai/dsh-client-ui-deliverables) only
 * knows a turn's PRODUCED files — the paths `write`/`edit`/`str_replace_editor`
 * mutated. A turn that writes nothing produces nothing, so every filename in
 * its prose stays inert. Measured on a real session (20 tool calls, no
 * mutation): 0 of 7 filenames the assistant named were clickable, including
 * five screenshots the turn had just created through a Bash script.
 *
 * This accumulator widens the scope from "files this turn WROTE" to "paths
 * this turn TOUCHED": every filesystem-looking argument of every tool call.
 * On that same session it captures `read`'s file_path, `read_image`'s
 * file_path, `sidebar_open`'s target (file AND folder) and `bash`'s workdir —
 * 4 of the 7 directly, and the remaining 3 through the DIRECTORY those
 * arguments name, which the resolver lists separately.
 *
 * It follows the same shape as ui-deliverables' `deliverablesDefinition`: a
 * Turn-scoped accumulator registered on `ctx.uiConversation.events`, read back
 * through `owner.turn.data.get(key)`. Kept dependency-free so the extraction
 * rules are unit-testable against raw event payloads.
 */

/** The Turn data key this accumulator publishes under. */
export const MENTION_SCOPE_KEY = 'sidebar-mention-scope'

/** What one closed turn touched, in tool-call order and deduplicated. */
export interface MentionScopeValue {
  /** Every filesystem-looking path named by a tool argument this turn. */
  paths: readonly string[]
}

/**
 * Argument names DSH's shipped tools use for a filesystem path. Deliberately
 * a WHITELIST rather than "any string that looks like a path": a Bash
 * `command` string is full of path-shaped fragments that name nothing, and
 * one wrong entry here turns a mention into a link that 404s.
 */
const PATH_KEYS: readonly string[] = [
  'file_path',
  'filePath',
  'path',
  'target',
  'workdir',
  'cwd',
  'directory',
  'notebook_path',
]

/** True for a value usable as a path (non-empty, single-line, no wildcard). */
function isPathLike(value: unknown): value is string {
  return typeof value === 'string'
    && value !== ''
    && !/[\n\r]/.test(value)
    && !value.includes('*')
}

/**
 * Every path-shaped argument of one tool call.
 *
 * `argsRaw` is the wire form DSH puts on `tool/call` events: a JSON STRING,
 * not an object (mirrors ui-deliverables' `mutationPath`). A malformed or
 * non-object payload yields nothing rather than throwing — one odd tool call
 * must not break the turn's whole mention scope.
 * @param argsRaw - the event's `data.arguments` JSON string.
 * @returns the argument paths, in key order, deduplicated.
 */
export function collectToolPaths(argsRaw: unknown): readonly string[] {
  if (typeof argsRaw !== 'string') return []
  let args: unknown
  try {
    args = JSON.parse(argsRaw)
  } catch {
    return []
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return []
  const record = args as Record<string, unknown>
  const out: string[] = []
  const seen = new Set<string>()
  for (const key of PATH_KEYS) {
    const value = record[key]
    if (!isPathLike(value) || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/** The accumulator's private per-turn state. */
interface MentionScopeState {
  turn: unknown
  paths: readonly string[]
}

/** The subset of the Turn-data definition contract this file needs. */
interface TurnEventMatch {
  event: { type: string; data: Record<string, unknown> }
}

/**
 * Build the Turn-data definition. `onTouched` is called with each newly seen
 * path as the event arrives — the hook the client half uses to warm its
 * directory listings LONG before the turn closes and the prose renders.
 *
 * Warming from here rather than from the resolver is not an optimisation, it
 * is the only workable order: `resolve()` is SYNCHRONOUS (the shared
 * MarkdownText calls `fileMentions?.resolve(token)` inline while rendering an
 * inline-code node), and nothing re-renders a settled turn once its owner
 * memo has resolved. A listing fetched at resolve time would arrive after the
 * only render that would have used it.
 * @param onTouched - notified per newly seen path (fire-and-forget).
 * @returns the definition to hand to `ctx.uiConversation.events.register`.
 */
export function createMentionScopeDefinition(onTouched: (path: string) => void): unknown {
  return {
    kind: MENTION_SCOPE_KEY,
    match: (event: { type: string; data: Record<string, unknown> }) => {
      if (event.type === 'turn/start') return { id: String(event.data['turn']), role: 'start' }
      if (event.type === 'tool/call') return { id: String(event.data['turn']), role: 'update' }
      return null
    },
    start: (_context: unknown, match: TurnEventMatch): MentionScopeState => {
      if (match.event.type !== 'turn/start') throw new Error('mention scope start requires turn/start')
      return { turn: match.event.data['turn'], paths: [] }
    },
    update: (context: { state: MentionScopeState }, match: TurnEventMatch): MentionScopeState => {
      if (match.event.type !== 'tool/call') return context.state
      const found = collectToolPaths(match.event.data['arguments'])
      if (found.length === 0) return context.state
      const paths = [...context.state.paths]
      for (const path of found) {
        if (paths.includes(path)) continue
        paths.push(path)
        onTouched(path)
      }
      return paths.length === context.state.paths.length ? context.state : { ...context.state, paths }
    },
    buildLocationData: (context: { state?: MentionScopeState }, scope: string) =>
      scope !== 'turn' || context.state === undefined
        ? null
        : {
            kind: 'turn',
            turn: context.state.turn,
            key: MENTION_SCOPE_KEY,
            value: { paths: context.state.paths } satisfies MentionScopeValue,
          },
  }
}
