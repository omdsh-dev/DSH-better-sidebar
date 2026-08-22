/**
 * AI-assisted commit message route ('git.commit-message'): gathers the
 * tracked staged + unstaged diffs, prompts the SESSION's own provider/model
 * through the harness's `ctx.llm` stream, and returns one generated message
 * the client fills into the commit box (never commits on its own).
 *
 * No DSH source is touched: `ctx.llm` is the stock LlmRuntime service and
 * the provider/model come from the session's live agent (the same identity
 * the session itself uses — zero configuration). The prompt builder is a
 * pure function (`buildCommitPrompt`) so the interesting cases are
 * unit-tested without a context.
 */
import { BlockAssembler, createUserMessage, type ContentBlock, type GenerateOptions, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from './context-types.ts'
import { diff } from './git.ts'
import { SidebarError } from './wire.ts'

/** Per-side diff cap fed to the model (bounds the prompt; untracked files never appear). */
export const AI_COMMIT_DIFF_LIMIT = 12 * 1024

/** The stream is cut short if the model takes this long to answer. */
const AI_COMMIT_TIMEOUT_MS = 30_000

/** The one AI commit route of the sidebar API (wire method name). */
export interface AiCommitRoutes {
  'git.commit-message'(payload: unknown): Promise<{ message: string }>
}

/** The minimum llm surface this route needs (structural mirror of the runtime). */
export interface LlmLike {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** The minimum agents-service surface (live-agent lookup for provider/model). */
interface AgentsLike {
  get(id: string): { options?: { provider?: string; model?: string } } | undefined
}

/**
 * Compose the model request for one commit: the fixed system instructions
 * plus ONE user message carrying the staged and unstaged diffs, each
 * section-labeled and capped at {@link AI_COMMIT_DIFF_LIMIT}. Throws a
 * wire `git-error` when there is nothing to commit (both diffs empty).
 */
export function buildCommitPrompt(stagedDiff: string, unstagedDiff: string): { system: string; messages: UserMessage[] } {
  const sections: string[] = []
  if (stagedDiff.trim() !== '') {
    sections.push(`[staged changes]\n${stagedDiff.slice(0, AI_COMMIT_DIFF_LIMIT)}`)
  }
  if (unstagedDiff.trim() !== '') {
    sections.push(`[unstaged changes]\n${unstagedDiff.slice(0, AI_COMMIT_DIFF_LIMIT)}`)
  }
  if (sections.length === 0) {
    throw new SidebarError('git-error', 'no changes to commit')
  }
  return {
    system: [
      'You write git commit messages. Output is the commit message ONLY — no markdown fences, no surrounding quotes, no "Commit:" prefix, no commentary, no extra prose.',
      'Exact layout (follow it every time):',
      '  <conventional type>(<optional scope>): <imperative subject, under 72 chars>',
      '  ',
      '  <concise body: one self-contained line per meaningful change>',
      'Rules:',
      '- The subject is ALWAYS its own single line; it must never run into the body.',
      '- Leave exactly one blank line between the subject and the body.',
      '- Never let two words or two sentences run together without their intended separator; keep every line self-contained.',
      '- When the change is trivial, omit the body and output only the one-line subject.',
      '- Type from: feat, fix, refactor, docs, test, chore, perf, build, ci (choose only when obvious).',
    ].join('\n'),
    messages: [createUserMessage({
      content: [{ type: 'text', text: sections.join('\n\n') }],
      source: { kind: 'user' },
    })],
  }
}

/** Build the AI commit route bound to the plugin context. `resolveCwd` is
 *  the caller's session-cwd resolution (the git.* routes share one). */
export function buildAiCommitApi(
  ctx: Context,
  resolveCwd: (payload: unknown) => { sessionId: string; cwd: string },
): AiCommitRoutes {
  return {
    'git.commit-message': async (payload: unknown) => {
      const { sessionId, cwd } = resolveCwd(payload)
      // Untracked files never appear in `git diff`; the client disables the
      // button when there are no tracked changes, and this is the server guard.
      const [stagedDiff, unstagedDiff] = await Promise.all([
        diff(cwd, undefined, true),
        diff(cwd, undefined, false),
      ])
      const { system, messages } = buildCommitPrompt(stagedDiff, unstagedDiff)

      const llm = ctx.get('llm') as LlmLike | undefined
      if (llm === undefined) {
        throw new SidebarError('method-error', 'the llm service is unavailable')
      }
      // The session's own provider/model: the natural default, zero config.
      const agents = ctx.get('agents') as AgentsLike | undefined
      const options = agents?.get(sessionId)?.options
      const provider = options?.provider
      const model = options?.model
      if (provider === undefined || provider === '' || model === undefined || model === '') {
        throw new SidebarError('method-error', 'no model is configured for this session')
      }

      const assembler = new BlockAssembler()
      try {
        for await (const chunk of llm.stream({
          provider,
          model,
          system,
          messages,
          maxTokens: 320,
          signal: AbortSignal.timeout(AI_COMMIT_TIMEOUT_MS),
        })) {
          assembler.push(chunk)
        }
      } catch (reason) {
        throw new SidebarError('method-error', `commit message generation failed: ${reason instanceof Error ? reason.message : String(reason)}`)
      }
      const message = assembler.blocks()
        .filter((block): block is ContentBlock & { type: 'text'; text: string } => block.type === 'text')
        .map(block => block.text)
        .join('')
        .trim()
      if (message === '') {
        throw new SidebarError('method-error', 'the model returned an empty commit message')
      }
      return { message }
    },
  }
}