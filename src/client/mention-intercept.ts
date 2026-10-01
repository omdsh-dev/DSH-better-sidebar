/**
 * Widening of the chat's prose file mentions, and the takeover that sends
 * them to the sidebar editor.
 *
 * `ui-deliverables` publishes the `chatFileMentions` service; `ui-chat` calls
 * `forClosing(owner)` once per closed turn and hands the result to
 * MarkdownText, which turns an inline-code token into a button when — and
 * only when — `resolve(token)` returns a target. Upstream resolves against
 * the turn's PRODUCED paths, so a turn that only read and ran commands offers
 * nothing (see mention-scope.ts for the measurement).
 *
 * This wrapper keeps upstream's answer first and adds two fallbacks, in
 * order of certainty:
 *
 *   1. a path the turn's tool calls named outright (exact, or the basename of
 *      exactly one of them);
 *   2. a filename that exists in a DIRECTORY those calls named — resolved
 *      against a listing fetched in advance, never guessed.
 *
 * Both keep upstream's anti-ambiguity rule: a token matching two candidates
 * stays inert rather than opening the wrong file. Level 2 degrades to level 1
 * when a listing has not arrived, so the worst case is upstream's behaviour
 * plus the paths we know for certain — never a link that 404s.
 *
 * Dependency-free (no React, no fetch): the listing arrives through the
 * injected {@link MentionResolverDeps.listing} lookup, which the client half
 * backs with its own cache.
 */

/** One resolved mention, in the shape MarkdownText renders as a button. */
export interface MentionTarget {
  open(): void
  label: string
  title: string
}

/** The resolver MarkdownText consumes (upstream's shape). */
export interface MentionResolver {
  resolve(value: string): MentionTarget | undefined
}

/** The `chatFileMentions` service face (a plain object, method-assignable). */
export interface ChatFileMentionsService {
  forClosing(owner: unknown): MentionResolver | undefined
}

/** Everything the widened resolver needs, all synchronous. */
export interface MentionResolverDeps {
  /** Paths the turn's tool calls named (mention-scope's accumulated value). */
  paths(owner: unknown): readonly string[]
  /** Entry names of an already-fetched directory listing, or undefined. */
  listing(directory: string): ReadonlySet<string> | undefined
  /** Open the resolved path in the sidebar editor. */
  open(path: string): void
  /** Accessible label for the mention button. */
  label(path: string): string
}

/** Trailing path segment — the part a mention usually names. */
function basename(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? path : path.slice(at + 1)
}

/** Leading path segment — the directory a path lives in ('' when rootless). */
function dirname(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? '' : path.slice(0, at)
}

/** The one element satisfying the predicate, or undefined when 0 or 2+ do. */
function only<T>(items: readonly T[], match: (item: T) => boolean): T | undefined {
  let found: T | undefined
  for (const item of items) {
    if (!match(item)) continue
    if (found !== undefined) return undefined
    found = item
  }
  return found
}

/**
 * The directories a turn's touched paths make searchable: each path's parent,
 * plus every path itself (a `sidebar_open` target or a `bash` workdir is
 * frequently the directory, not a file). Listing a path that turns out to be
 * a file simply yields no entries.
 * @param paths - the turn's touched paths.
 * @returns candidate directories, deduplicated, parents first.
 */
export function candidateDirectories(paths: readonly string[]): readonly string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (value: string): void => {
    if (value === '' || seen.has(value)) return
    seen.add(value)
    out.push(value)
  }
  for (const path of paths) add(dirname(path))
  for (const path of paths) add(path)
  return out
}

/**
 * Resolve one inline-code token against a turn's file scope.
 * @param token - the inline-code text MarkdownText is rendering.
 * @param paths - the turn's touched paths.
 * @param deps - listing lookup and the sinks.
 * @returns the absolute path to open, or undefined to leave the token inert.
 */
export function resolveMentionPath(
  token: string,
  paths: readonly string[],
  deps: Pick<MentionResolverDeps, 'listing'>,
): string | undefined {
  if (token === '') return undefined
  // Level 1a: the token IS one of the touched paths.
  if (paths.includes(token)) return token
  // Level 1b: the token is the basename of exactly one touched path.
  const byName = only(paths, (path) => basename(path) === token)
  if (byName !== undefined) return byName
  // Level 2: the token names a file inside exactly one touched directory
  // whose listing has already arrived. A token that is itself a path
  // fragment ('a/b.ts') is matched against the listing by its basename only
  // when the fragment's own directory part matches the candidate's tail.
  const name = basename(token)
  const directories = candidateDirectories(paths)
  const hit = only(directories, (directory) => {
    const entries = deps.listing(directory)
    if (entries === undefined || !entries.has(name)) return false
    const prefix = dirname(token)
    return prefix === '' || directory.endsWith(prefix)
  })
  if (hit === undefined) return undefined
  const separator = hit.includes('\\') ? '\\' : '/'
  return `${hit.replace(/[\\/]+$/, '')}${separator}${name}`
}

/**
 * Build a resolver over one turn's scope, delegating to upstream's resolver
 * first so a produced file keeps upstream's exact behaviour and labels.
 * @param owner - the turn-tail owner ui-chat passes to `forClosing`.
 * @param upstream - upstream's resolver for this turn, when it offered one.
 * @param deps - scope, listing lookup and sinks.
 * @returns the widened resolver.
 */
export function createMentionResolver(
  owner: unknown,
  upstream: MentionResolver | undefined,
  deps: MentionResolverDeps,
): MentionResolver {
  const paths = deps.paths(owner)
  return {
    resolve(value: string): MentionTarget | undefined {
      const fromUpstream = upstream?.resolve(value)
      if (fromUpstream !== undefined) return fromUpstream
      const path = resolveMentionPath(value, paths, deps)
      if (path === undefined) return undefined
      return {
        open: () => { deps.open(path) },
        label: deps.label(path),
        title: path,
      }
    },
  }
}

/**
 * Wrap the `chatFileMentions` service so every closed turn gets the widened
 * resolver — including the turns upstream declines entirely by returning
 * `undefined`, which is the whole point.
 *
 * Unlike the Remote namespace methods (see openpath-intercept.ts), this
 * service is a plain object literal with a data property, so assignment is
 * the right wrap here.
 * @param service - the `chatFileMentions` service to wrap.
 * @param deps - per-turn scope, listing lookup and sinks.
 * @returns the disposer restoring the original method (HMR-safe).
 */
export function wrapChatFileMentions(
  service: ChatFileMentionsService,
  deps: MentionResolverDeps & { enabled(): boolean },
): () => void {
  const original = service.forClosing
  if (typeof original !== 'function') {
    throw new Error('dsh-better-sidebar: chatFileMentions.forClosing is not a function on this host')
  }
  service.forClosing = function forClosing(this: ChatFileMentionsService, owner: unknown) {
    const upstream = original.call(this, owner) as MentionResolver | undefined
    if (!deps.enabled()) return upstream
    return createMentionResolver(owner, upstream, deps)
  }
  return () => {
    service.forClosing = original
  }
}
