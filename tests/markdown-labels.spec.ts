/**
 * The chrome-label helper: the props it builds must keep a STABLE `labels`
 * identity across renders whose values did not change. `MarkdownText` is a
 * bare `memo`, so a fresh object per render re-parses the whole document —
 * which the plan page, polling on a timer, paid for on every tick.
 */
import { describe, expect, it } from 'vitest'
import { markdownTextProps } from '../src/client/markdown-labels.tsx'

const zh = { copyLabel: '复制', copiedLabel: '已复制' }

describe('markdownTextProps', () => {
  it('reuses the labels object while the values are unchanged', () => {
    expect(markdownTextProps('a', zh).labels).toBe(markdownTextProps('b', zh).labels)
    // A fresh object with equal values still hits the same entry.
    expect(markdownTextProps('a', { ...zh }).labels).toBe(markdownTextProps('a', zh).labels)
  })

  it('hands out a different object once the values change', () => {
    const en = { copyLabel: 'Copy', copiedLabel: 'Copied' }
    expect(markdownTextProps('a', zh).labels).not.toBe(markdownTextProps('a', en).labels)
  })

  it('threads the values through and keeps the text it was given', () => {
    expect(markdownTextProps('body', zh).text).toBe('body')
    expect(markdownTextProps('body', zh).labels).toMatchObject({
      code: { copyLabel: '复制', copiedLabel: '已复制' },
    })
  })
})
