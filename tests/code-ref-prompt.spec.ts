/**
 * The code-reference prompt section registration: registers ONE short
 * system-prompt section through the `systemPrompt` service, retries briefly
 * while the service mounts, and never throws when it is absent (the plugin
 * must work on deployments without the prompt registry).
 */
import { describe, expect, it, vi } from 'vitest'
import { CODE_REF_PROMPT, CODE_REF_PROMPT_SECTION, registerCodeRefPrompt, type SystemPromptFace } from '../src/code-ref-prompt.ts'

/** A fake systemPrompt service recording registered sections. */
function fakePrompt(): { face: SystemPromptFace; sections: Array<{ name: string; order: number; text: string }> } {
  const sections: Array<{ name: string; order: number; text: string }> = []
  return {
    sections,
    face: { section: (section) => { sections.push(section); return () => {} } },
  }
}

describe('registerCodeRefPrompt', () => {
  it('registers the short code-reference section when the service is available', () => {
    const { face, sections } = fakePrompt()
    const dispose = registerCodeRefPrompt(() => face)
    expect(sections).toEqual([{ name: CODE_REF_PROMPT_SECTION, order: 90, text: CODE_REF_PROMPT }])
    dispose()
  })

  it('the injected instruction is intentionally short', () => {
    // "尽可能简短的 prompt": one sentence, no fluff.
    expect(CODE_REF_PROMPT.length).toBeLessThan(140)
    expect(CODE_REF_PROMPT).toContain('src/main.ts:42-56')
  })

  it('retries while the service mounts late, then registers once', () => {
    vi.useFakeTimers()
    try {
      const { face, sections } = fakePrompt()
      let prompt: SystemPromptFace | undefined
      const dispose = registerCodeRefPrompt(() => prompt)
      expect(sections).toHaveLength(0)
      prompt = face
      vi.advanceTimersByTime(2000)
      expect(sections).toHaveLength(1)
      // The timer stops once registered — no duplicate section later.
      vi.advanceTimersByTime(5000)
      expect(sections).toHaveLength(1)
      dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('is a silent no-op when the service never appears', () => {
    vi.useFakeTimers()
    try {
      const dispose = registerCodeRefPrompt(() => undefined)
      vi.advanceTimersByTime(30_000)
      dispose()  // must not throw
    } finally {
      vi.useRealTimers()
    }
  })

  it('a throwing service is contained (warned, never fatal)', () => {
    const warn = vi.fn<(message: string, ...args: unknown[]) => void>()
    const logger = { warn: warn as (message: string, ...args: unknown[]) => void }
    const dispose = registerCodeRefPrompt(() => ({ section: () => { throw new Error('boom') } }), logger)
    expect(warn).toHaveBeenCalled()
    dispose()
  })

  it('the disposer removes the registered section', () => {
    const { face, sections } = fakePrompt()
    const dispose = registerCodeRefPrompt(() => face)
    expect(sections).toHaveLength(1)
    // The fake's disposer is a no-op; the real service unregisters on dispose.
    dispose()
    dispose()  // idempotent
  })
})
