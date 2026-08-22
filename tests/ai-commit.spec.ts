/**
 * Host route tests for the AI commit-message API ('git.commit-message'):
 * the prompt builder (sections, caps, no-changes guard) and the route
 * (assembled message from a streamed ctx.llm, session-model resolution,
 * and the degradation paths: no model, no llm service, stream failure,
 * empty output). The stream surface is faked structurally — the same
 * pattern tests/sidechat-routes.spec.ts uses for optional services.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { AI_COMMIT_DIFF_LIMIT, buildAiCommitApi, buildCommitPrompt } from '../src/ai-commit.ts'
import { SidebarError } from '../src/wire.ts'
import type { Context } from '../src/context-types.ts'

const STAGED_DIFF = 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n'
const UNSTAGED_DIFF = 'diff --git a/b.ts b/b.ts\n@@ -1 +1 @@\n-x\n+y\n'

/** The git.diff mock (keyed by the staged flag). */
const mocks = vi.hoisted(() => ({
  diff: vi.fn(async (_cwd: string, _path: string | undefined, staged: boolean): Promise<string> => {
    return staged ? '' : ''
  }),
}))

vi.mock('../src/git.ts', () => ({ diff: mocks.diff }))

/** A context serving the optional services the route reads via ctx.get. */
function ctxWith(llm?: unknown, agents?: unknown): Context {
  const table: Record<string, unknown> = {
    ...(llm === undefined ? {} : { llm }),
    ...(agents === undefined ? {} : { agents }),
  }
  return { get: (key: string) => table[key] } as unknown as Context
}

/** A minimal streaming llm that emits one text block for `text`. */
function llmOf(text: string): { stream: () => AsyncGenerator<StreamChunk> } {
  return {
    stream: async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
    },
  }
}

const resolveCwd = (_payload: unknown): { sessionId: string; cwd: string } => ({ sessionId: 's1', cwd: '/tmp' })

/** An agents service whose session 's1' carries the given model options (a
 *  structural mirror of a live Agent: the route reads `agent.options`). */
function agentsOf(options?: { provider?: string; model?: string }): { get: () => unknown } {
  return { get: () => (options === undefined ? undefined : { options }) }
}

describe('buildCommitPrompt', () => {
  /** The text of the single user message block. */
  const promptText = (staged: string, unstaged: string): string => {
    const { system, messages } = buildCommitPrompt(staged, unstaged)
    expect(system).toContain('commit message')
    return messages[0]!.content.map(block => block.type === 'text' ? block.text : '').join('')
  }

  it('labels both sides and orders staged before unstaged', () => {
    const text = promptText(STAGED_DIFF, UNSTAGED_DIFF)
    expect(text.indexOf('[staged changes]')).toBeLessThan(text.indexOf('[unstaged changes]'))
    expect(text).toContain('+new')
    expect(text).toContain('+y')
  })

  it('omits an empty side section', () => {
    const text = promptText('', UNSTAGED_DIFF)
    expect(text).not.toContain('[staged changes]')
    expect(text).toContain('[unstaged changes]')
  })

  it('caps each side at the diff limit', () => {
    const huge = `diff --git a/x b/x\n@@ -1 +1 @@\n-${'a'.repeat(AI_COMMIT_DIFF_LIMIT + 100)}\n`
    const text = promptText(huge, '')
    expect(text.length).toBeLessThanOrEqual(AI_COMMIT_DIFF_LIMIT + '[staged changes]\n'.length)
    expect(text).toContain('[staged changes]')
  })

  it('rejects when there is nothing to commit', () => {
    expect(() => buildCommitPrompt('', '')).toThrow(SidebarError)
  })
})

describe('git.commit-message route', () => {
  beforeEach(() => {
    mocks.diff.mockReset()
    mocks.diff.mockImplementation(async (_cwd, _path, staged) => staged ? STAGED_DIFF : UNSTAGED_DIFF)
  })

  it('assembles the streamed answer and returns it trimmed', async () => {
    const api = buildAiCommitApi(ctxWith(llmOf('  feat(a): new\n'), agentsOf({ provider: 'p1', model: 'm1' })), resolveCwd)
    const { message } = await api['git.commit-message']({})
    expect(message).toBe('feat(a): new')
  })

  it('fails when both diffs are empty (untracked-only counts as no changes)', async () => {
    mocks.diff.mockImplementation(async () => '')
    const api = buildAiCommitApi(ctxWith(llmOf('x'), agentsOf({ provider: 'p1', model: 'm1' })), resolveCwd)
    await expect(api['git.commit-message']({})).rejects.toMatchObject({ code: 'git-error' })
  })

  it('fails when the llm service is unavailable', async () => {
    const api = buildAiCommitApi(ctxWith(undefined, agentsOf({ provider: 'p1', model: 'm1' })), resolveCwd)
    await expect(api['git.commit-message']({})).rejects.toMatchObject({ code: 'method-error' })
  })

  it('fails when the session has no agent or no model', async () => {
    const none = buildAiCommitApi(ctxWith(llmOf('x'), undefined), resolveCwd)
    await expect(none['git.commit-message']({})).rejects.toMatchObject({ code: 'method-error' })
    const bare = buildAiCommitApi(ctxWith(llmOf('x'), agentsOf(undefined)), resolveCwd)
    await expect(bare['git.commit-message']({})).rejects.toMatchObject({ code: 'method-error' })
  })

  it('maps a stream failure to a method error', async () => {
    const failing = {
      stream: async function* () {
        throw new Error('provider down')
        yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk
      },
    }
    const api = buildAiCommitApi(ctxWith(failing, agentsOf({ provider: 'p1', model: 'm1' })), resolveCwd)
    await expect(api['git.commit-message']({})).rejects.toMatchObject({ code: 'method-error' })
  })

  it('rejects an empty model answer', async () => {
    const api = buildAiCommitApi(ctxWith(llmOf('   \n  '), agentsOf({ provider: 'p1', model: 'm1' })), resolveCwd)
    await expect(api['git.commit-message']({})).rejects.toMatchObject({ code: 'method-error' })
  })

  it('verifies the session model is what the llm receives', async () => {
    let received: { provider?: string; model?: string } | undefined
    const recording = {
      stream: async function* (options: { provider: string; model: string }) {
        received = { provider: options.provider, model: options.model }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'ok' }
      },
    }
    const api = buildAiCommitApi(ctxWith(recording, agentsOf({ provider: 'opencode-go', model: 'deepseek-v4-flash' })), resolveCwd)
    await api['git.commit-message']({})
    expect(received).toEqual({ provider: 'opencode-go', model: 'deepseek-v4-flash' })
  })
})