/**
 * Enhanced `chatFileMentions` resolution: makes file paths and `path:line`
 * references in settled chat inline-code spans clickable, routing the click
 * into the sidebar editor at the referenced line.
 *
 * DSH's ui-deliverables provides `chatFileMentions` (a `{ forClosing(owner) }`
 * service whose returned resolver matches only the file paths the closing
 * turn PRODUCED — exact path or unique basename). That resolver is the only
 * seam MarkdownText consults for inline-code mentions, and it is provided by
 * another plugin, so re-providing the name would throw (cordis forbids
 * duplicate service registration). Instead we WRAP the provided service's
 * `forClosing` method — the same "wrap the single funnel" pattern this
 * plugin already uses on `ctx.workspaces.openPath` — and layer our resolver
 * on top:
 *
 * 1. the DSH produced-path resolution first (unchanged behavior);
 * 2. `path:line` / `path:start-end` references (see path-line.ts) whose
 *    path is VERIFIED to exist (verified-paths.ts);
 * 3. bare separator-carrying paths that are VERIFIED to exist.
 *
 * Existence gating: MarkdownText's `resolve()` is synchronous, so only paths
 * the {@link PathVerifier} cache knows to exist become mentions — a
 * non-existent path (an illustrative example in prose, a typo, a deleted
 * file) stays plain code and never renders as a link. Unknown paths are
 * probed in the background; once verified, a later render of the message
 * (any chat re-render) upgrades them to links.
 *
 * The open callback rides the chat file-open funnel (`owner.openFile`) with
 * the line suffix re-appended to the path (`src/foo.ts:42`); the open-path
 * interception (intercept.tsx) splits the suffix back off and opens the
 * sidebar editor with a line jump, so session scoping, the `interceptOpenPath`
 * pref and the editor enable switch all keep their existing meaning.
 *
 * Pure (no React / DOM): the resolver and wrapper are unit-testable.
 */
import { looksLikePath, parsePathLine, linePathWithSuffix, type LineJump } from './path-line.ts'

/** One resolved mention, consumed by MarkdownText's inline-code renderer. */
export interface ChatMention {
  /** Click handler: open the file (in the sidebar, at the line when parsed). */
  open(): void
  /** Accessible label (the button's aria-label). */
  label: string
  /** Hover title (usually the full path). */
  title: string
}

/** The DSH service shape (structural mirror of ui-deliverables' provide). */
export interface ChatFileMentionsService {
  forClosing(owner: unknown): { resolve(value: string): ChatMention | undefined } | undefined
}

/** Per-call decisions the enhanced resolver needs (wired per owner + store). */
export interface ChatMentionDeps {
  /** Whether the feature is on (the side-card toggle, read live). */
  enabled(): boolean
  /**
   * Whether a (possibly relative) path is VERIFIED to exist; unknown paths
   * trigger a background probe (verified-paths.ts). Only verified paths
   * may resolve into mentions — non-existent references stay plain code.
   */
  verified(path: string): boolean
  /** Route one open through the chat file-open funnel (`owner.openFile`). */
  openPath(path: string): void
  /** Localized accessible label for a mention (`{name}` is the display text). */
  label(value: string, line?: LineJump): string
}

/**
 * Layer the path/path:line resolution over the DSH produced-path resolver.
 * The base resolver keeps precedence (a produced path is never shadowed);
 * when the feature is disabled only the base behavior remains.
 */
export function enhanceMentionResolver(
  base: { resolve(value: string): ChatMention | undefined } | undefined,
  deps: ChatMentionDeps,
): { resolve(value: string): ChatMention | undefined } {
  return {
    resolve(value: string): ChatMention | undefined {
      if (!deps.enabled()) return base?.resolve(value)
      const produced = base?.resolve(value)
      if (produced !== undefined) return produced
      const line = parsePathLine(value)
      if (line !== null) {
        // Only references to files that EXIST become links: an illustrative
        // or typo'd path stays plain code (and is probed for later renders).
        if (!deps.verified(line.path)) return undefined
        const title = linePathWithSuffix(line)
        return {
          open: () => deps.openPath(title),
          label: deps.label(value, line),
          title,
        }
      }
      if (looksLikePath(value)) {
        if (!deps.verified(value)) return undefined
        return {
          open: () => deps.openPath(value),
          label: deps.label(value),
          title: value,
        }
      }
      return undefined
    },
  }
}

/**
 * Wrap a provided `chatFileMentions` service so every `forClosing` call
 * resolves through {@link enhanceMentionResolver}. Returns the disposer
 * restoring the original method (HMR-safe; restoring only when OUR wrapper
 * is still installed never clobbers a later wrapper).
 */
export function wrapChatFileMentions(
  service: ChatFileMentionsService,
  depsFor: (owner: unknown) => ChatMentionDeps,
): () => void {
  const original = service.forClosing
  const wrapped: ChatFileMentionsService['forClosing'] = (owner) => {
    const base = original.call(service, owner)
    return enhanceMentionResolver(base ?? undefined, depsFor(owner))
  }
  service.forClosing = wrapped
  return () => {
    if (service.forClosing === wrapped) service.forClosing = original
  }
}
