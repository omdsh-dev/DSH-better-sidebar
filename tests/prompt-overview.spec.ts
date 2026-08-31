/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SidebarHistoryEntry } from '../src/context-types.ts'
import {
  activePromptIndex,
  collectHistoryPromptEntries,
  collectPromptOverviewEntries,
  normalizePromptPreview,
  promptMarkerWidth,
  reconcilePromptOverviewEntries,
  scrollToPrompt,
  type PromptOverviewEntry,
} from '../src/client/PromptOverview.tsx'

function rect(top: number, height = 20): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    right: 500,
    bottom: top + height,
    width: 500,
    height,
    toJSON: () => ({}),
  }
}

function row(kind: string, key: string, text: string): HTMLElement {
  const element = document.createElement('div')
  element.dataset.chatFlowKind = kind
  element.dataset.chatAnchorKey = key
  element.textContent = text
  return element
}

function history(type: string, seq: number, data: Record<string, unknown>): SidebarHistoryEntry {
  return { event: { type, seq, time: seq, data } }
}

afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})

describe('prompt overview derivation', () => {
  it('pairs each human prompt with the last following assistant excerpt', () => {
    const flow = document.createElement('div')
    const first = row('user', 'user:1', '')
    const firstChrome = document.createElement('div')
    firstChrome.dataset.timeHoverRoot = 'true'
    const firstStack = document.createElement('div')
    firstStack.textContent = '  How do I query\nthis record?  '
    const actions = document.createElement('div')
    actions.textContent = '10:42 Copy Branch'
    firstChrome.append(firstStack, actions)
    first.append(firstChrome)

    const thinking = row('assistant', 'assistant:1', 'First draft')
    const tool = row('tool', 'tool:1', 'internal command output')
    const answer = row('assistant-step', 'assistant:2', 'Use both account and sequence filters.')
    const second = row('steering', 'steering:1', '')
    const secondChrome = document.createElement('div')
    secondChrome.dataset.timeHoverRoot = 'true'
    const secondStack = document.createElement('div')
    secondStack.textContent = 'What about the other service?'
    secondChrome.append(secondStack, document.createElement('div'))
    second.append(secondChrome)
    const secondAnswer = row('assistant', 'assistant:3', 'It validates the app key.')
    flow.append(first, thinking, tool, answer, second, secondAnswer)

    const entries = collectPromptOverviewEntries(flow)
    expect(entries.map(({ key, question, answer: excerpt }) => ({ key, question, excerpt }))).toEqual([
      {
        key: 'user:1',
        question: 'How do I query this record?',
        excerpt: 'Use both account and sequence filters.',
      },
      {
        key: 'steering:1',
        question: 'What about the other service?',
        excerpt: 'It validates the app key.',
      },
    ])
    expect(entries[0]!.row).toBe(first)
  })

  it('derives the complete durable prompt list and ignores injected context', () => {
    const durable = collectHistoryPromptEntries([
      history('user/message', 1, {
        source: { kind: 'system' },
        content: [{ type: 'text', text: 'runtime context' }],
      }),
      history('user/message', 2, {
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'First question' }],
      }),
      history('assistant/message', 3, {
        message: { content: [{ type: 'text', text: 'First answer' }] },
      }),
      history('user/message', 4, {
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Second question' }],
      }),
    ])

    expect(durable.map(({ key, question, answer, row: promptRow }) => ({ key, question, answer, promptRow }))).toEqual([
      { key: 'history:2', question: 'First question', answer: 'First answer', promptRow: null },
      { key: 'history:4', question: 'Second question', answer: '', promptRow: null },
    ])
  })

  it('reads pre-migration steering and assistant message envelopes', () => {
    const durable = collectHistoryPromptEntries([
      history('steering/message', 1, {
        turn: 1,
        message: { content: [{ type: 'input_text', text: 'Legacy follow-up' }] },
      }),
      history('assistant/message', 2, {
        turn: 1,
        step: 2,
        content: [{ type: 'output_text', text: 'Legacy answer' }],
      }),
      history('user/message', 3, {
        source: { kind: 'steering' },
        message: { content: 'Human steering source' },
      }),
    ])

    expect(durable.map(entry => [entry.question, entry.answer])).toEqual([
      ['Legacy follow-up', 'Legacy answer'],
      ['Human steering source', ''],
    ])
  })

  it('reconciles a rendered suffix without losing unloaded history prompts', () => {
    const firstRow = row('user', 'user:1', 'First question')
    const secondRow = row('user', 'user:2', 'Second question')
    const durable: PromptOverviewEntry[] = [
      { key: 'history:1', question: 'First question', answer: 'Old answer', row: null },
      { key: 'history:2', question: 'Second question', answer: 'Second answer', row: null },
    ]
    const merged = reconcilePromptOverviewEntries(durable, [
      { key: 'user:1', question: 'First question', answer: 'Live answer', row: firstRow },
      { key: 'user:2', question: 'Second question', answer: '', row: secondRow },
    ])

    expect(merged.map(entry => [entry.key, entry.answer, entry.row])).toEqual([
      ['history:1', 'Live answer', firstRow],
      ['history:2', 'Second answer', secondRow],
    ])
  })

  it('falls back to suffix order when legacy durable text differs from rendered text', () => {
    const oldRow = row('user', 'user:old', 'Rendered imported prompt')
    const latestRow = row('user', 'user:latest', 'Exact latest prompt')
    const merged = reconcilePromptOverviewEntries([
      { key: 'history:1', question: '', answer: 'Imported answer', row: null },
      { key: 'history:2', question: 'Exact latest prompt', answer: '', row: null },
    ], [
      { key: 'user:old', question: 'Rendered imported prompt', answer: '', row: oldRow },
      { key: 'user:latest', question: 'Exact latest prompt', answer: '', row: latestRow },
    ])

    expect(merged.map(entry => entry.row)).toEqual([oldRow, latestRow])
  })

  it('keeps a newly rendered prompt separate while durable history catches up', () => {
    const oldRow = row('user', 'user:old', 'Repeated prompt')
    const newRow = row('user', 'user:new', 'Repeated prompt')
    const merged = reconcilePromptOverviewEntries([
      { key: 'history:1', question: 'Repeated prompt', answer: 'Old answer', row: null },
    ], [
      { key: 'user:old', question: 'Repeated prompt', answer: '', row: oldRow },
      { key: 'user:new', question: 'Repeated prompt', answer: '', row: newRow },
    ])

    expect(merged.map(entry => [entry.key, entry.row])).toEqual([
      ['history:1', oldRow],
      ['user:new', newRow],
    ])
  })

  it('normalizes whitespace and gives longer prompts longer capped ticks', () => {
    expect(normalizePromptPreview('  one\n\t two  ')).toBe('one two')
    expect(promptMarkerWidth('x')).toBeGreaterThanOrEqual(9)
    expect(promptMarkerWidth('a much longer prompt than the first')).toBeGreaterThan(promptMarkerWidth('x'))
    expect(promptMarkerWidth('x'.repeat(2_000))).toBe(34)
  })
})

describe('prompt overview navigation', () => {
  it('tracks the last prompt above the reading band and pins the bottom to the last', () => {
    const scroller = document.createElement('div')
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 2_000 },
      scrollTop: { configurable: true, writable: true, value: 400 },
    })
    scroller.getBoundingClientRect = () => rect(100, 500)
    const entries = [180, 240, 580].map((top, index) => {
      const prompt = row('user', `user:${index}`, `Question ${index}`)
      prompt.getBoundingClientRect = () => rect(top)
      return { key: `user:${index}`, question: `Question ${index}`, answer: '', row: prompt }
    }) satisfies PromptOverviewEntry[]

    expect(activePromptIndex(entries, scroller)).toBe(1)
    scroller.scrollTop = 1_500
    expect(activePromptIndex(entries, scroller)).toBe(2)
  })

  it('scrolls in native scrollport coordinates and briefly marks the target row', () => {
    vi.useFakeTimers()
    const scroller = document.createElement('div')
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, writable: true, value: 300 })
    scroller.getBoundingClientRect = () => rect(100, 600)
    const scrollTo = vi.fn()
    scroller.scrollTo = scrollTo
    const prompt = row('user', 'user:1', 'Question')
    prompt.getBoundingClientRect = () => rect(460)
    vi.stubGlobal('matchMedia', () => ({ matches: false }))

    scrollToPrompt(prompt, scroller)

    expect(scrollTo).toHaveBeenCalledWith({ top: 636, behavior: 'smooth' })
    expect(prompt.hasAttribute('data-prompt-overview-target')).toBe(true)
    vi.advanceTimersByTime(900)
    expect(prompt.hasAttribute('data-prompt-overview-target')).toBe(false)
    vi.unstubAllGlobals()
  })
})
