/**
 * Commit-message suggestion contract: the prompt halves the host sends, the
 * `provider/model` route vocabulary behind the Git card's pinned-model
 * setting, and the cleanup the panel applies before the text lands in the
 * commit box. Pure module (no cordis, no git, no LLM) — every case here is a
 * wire/contract guarantee, not an implementation detail.
 */
import { describe, expect, it } from 'vitest'
import {
  buildCommitPrompt,
  cleanSuggestion,
  collectModelRoutes,
  defaultRouteOf,
  formatModelRoute,
  lowestReasoningEffortOf,
  modelEntryOf,
  normalizeLanguage,
  parseModelRoute,
  providerEntryOf,
  SUGGEST_DIFF_LIMIT,
  truncateDiff,
} from '../src/commit-message.ts'

describe('parseModelRoute', () => {
  it('splits on the FIRST slash (a model id may carry its own)', () => {
    expect(parseModelRoute('deepseek/deepseek-chat')).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(parseModelRoute('openai/vendor/gpt-4o')).toEqual({ provider: 'openai', model: 'vendor/gpt-4o' })
  })

  it('trims surrounding whitespace', () => {
    expect(parseModelRoute('  deepseek / deepseek-chat  ')).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('rejects anything that cannot form a route (the caller falls back)', () => {
    for (const value of [undefined, null, '', '   ', 'deepseek', '/model', 'provider/', 42, {}]) {
      expect(parseModelRoute(value), String(value)).toBeUndefined()
    }
  })
})

describe('formatModelRoute', () => {
  it('round-trips through parseModelRoute', () => {
    const route = { provider: 'deepseek', model: 'deepseek-chat' }
    expect(parseModelRoute(formatModelRoute(route))).toEqual(route)
  })
})

describe('normalizeLanguage', () => {
  it('is zh only on the exact marker, en otherwise', () => {
    expect(normalizeLanguage('zh')).toBe('zh')
    for (const value of ['en', 'ja', undefined, 0, {}]) {
      expect(normalizeLanguage(value), String(value)).toBe('en')
    }
  })
})

describe('truncateDiff', () => {
  it('leaves a short diff untouched and marks a truncated one', () => {
    expect(truncateDiff('abc')).toBe('abc')
    const long = 'x'.repeat(SUGGEST_DIFF_LIMIT + 100)
    const cut = truncateDiff(long)
    // The cut keeps exactly SUGGEST_DIFF_LIMIT characters of the patch and
    // appends the marker — a huge diff can no longer grow without bound.
    expect(cut).toBe(`${'x'.repeat(SUGGEST_DIFF_LIMIT)}\n...(diff truncated)`)
    expect(cut.length).toBeLessThan(long.length)
  })
})

describe('buildCommitPrompt', () => {
  it('carries the file list and the diff in the user half', () => {
    const prompt = buildCommitPrompt('en', ['a.ts', 'b.ts'], '+added')
    expect(prompt.user).toContain('a.ts')
    expect(prompt.user).toContain('b.ts')
    expect(prompt.user).toContain('+added')
    expect(prompt.system).toContain('Conventional Commits')
  })

  it('asks for the message alone (no prose the panel would commit)', () => {
    expect(buildCommitPrompt('en', [], '').system).toContain('Output only the commit message')
    expect(buildCommitPrompt('zh', [], '').system).toContain('只输出提交信息本身')
  })

  it('differs by language', () => {
    expect(buildCommitPrompt('zh', [], '').system).not.toBe(buildCommitPrompt('en', [], '').system)
  })
})

describe('collectModelRoutes', () => {
  /** One `request/header` event as the session log carries it. */
  function header(provider: string, model: string): { type: string; data: unknown } {
    return { type: 'request/header', data: { header: { config: { provider, model } } } }
  }

  it('collects the routes a session actually used, newest first and de-duplicated', () => {
    const events = [
      { type: 'user/message', data: {} },
      header('deepseek', 'deepseek-chat'),
      header('openai', 'gpt-4o'),
      header('deepseek', 'deepseek-chat'),
    ]
    expect(collectModelRoutes(events)).toEqual([
      { provider: 'deepseek', model: 'deepseek-chat' },
      { provider: 'openai', model: 'gpt-4o' },
    ])
  })

  it('honors the cap and ignores headerless / malformed rows', () => {
    const events = [
      header('p1', 'm1'),
      { type: 'request/header', data: {} },
      { type: 'request/header', data: { header: {} } },
      header('p2', 'm2'),
      header('p3', 'm3'),
    ]
    expect(collectModelRoutes(events, 2).map(route => route.model)).toEqual(['m3', 'm2'])
    expect(collectModelRoutes([])).toEqual([])
  })
})

describe('lowestReasoningEffortOf', () => {
  const effort = (id: string): { id: string; name: string } => ({ id, name: id })

  it('picks the cheapest advertised level, whatever the adapter order', () => {
    expect(lowestReasoningEffortOf([effort('high'), effort('off'), effort('max')])).toBe('off')
    expect(lowestReasoningEffortOf([effort('high'), effort('low')])).toBe('low')
    expect(lowestReasoningEffortOf([effort('medium'), effort('minimal')])).toBe('minimal')
  })

  it('never lets an unknown id outrank a known one, and falls back to the first entry', () => {
    expect(lowestReasoningEffortOf([effort('turbo'), effort('high')])).toBe('high')
    expect(lowestReasoningEffortOf([effort('turbo'), effort('brisk')])).toBe('turbo')
  })

  it('reports "no effort" for a model that advertises none', () => {
    for (const value of [undefined, null, [], 'off', [{}], [{ id: '' }]]) {
      expect(lowestReasoningEffortOf(value), JSON.stringify(value)).toBeUndefined()
    }
  })
})

describe('catalog reads (unknown harness shapes)', () => {
  it('reads a provider from any plausible field and never invents one', () => {
    expect(providerEntryOf({ provider: 'deepseek', name: 'DeepSeek' }))
      .toEqual({ provider: 'deepseek', label: 'DeepSeek' })
    // A differently-named registration must not become an empty route.
    expect(providerEntryOf({ id: 'openai' })).toEqual({ provider: 'openai', label: 'openai' })
    for (const value of [undefined, null, '', 42, {}, { name: 'no route' }]) {
      expect(providerEntryOf(value), String(value)).toBeUndefined()
    }
  })

  it('reads a model id/name tolerantly', () => {
    expect(modelEntryOf({ id: 'deepseek-chat' })).toEqual({ id: 'deepseek-chat', name: 'deepseek-chat' })
    expect(modelEntryOf({ model: 'gpt-4o', displayName: 'GPT-4o' })).toEqual({ id: 'gpt-4o', name: 'GPT-4o' })
    // A display-only title is never an id: sending a localized label to a
    // provider would fail at generation time instead of falling back.
    expect(modelEntryOf({ title: 'unnamed' })).toBeUndefined()
    expect(modelEntryOf(null)).toBeUndefined()
  })

  it('reads the harness default selection, or nothing', () => {
    expect(defaultRouteOf({ provider: 'deepseek', model: 'deepseek-chat' }))
      .toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    for (const value of [undefined, null, {}, { provider: 'deepseek' }, { model: 'm' }]) {
      expect(defaultRouteOf(value), String(value)).toBeUndefined()
    }
  })
})

describe('cleanSuggestion', () => {
  it('drops a code fence the model wrapped around the message', () => {
    expect(cleanSuggestion('```\nfeat: add a thing\n```')).toBe('feat: add a thing')
    expect(cleanSuggestion('```text\nfix: broken\n```')).toBe('fix: broken')
  })

  it('keeps a legitimate multi-line message (subject + body)', () => {
    expect(cleanSuggestion('feat: add a thing\n\n- one\n- two')).toBe('feat: add a thing\n\n- one\n- two')
  })

  it('trims blank runs and carriage returns', () => {
    expect(cleanSuggestion('\r\n  chore: tidy   \n\n')).toBe('chore: tidy')
    expect(cleanSuggestion('   ')).toBe('')
  })
})
