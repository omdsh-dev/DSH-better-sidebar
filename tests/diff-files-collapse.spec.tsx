// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { DiffFiles } from '../src/client/diff/DiffFiles.tsx'
import { parseUnifiedDiff } from '../src/client/diff/rows.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

const diff = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-old-a',
  '+new-a',
  'diff --git a/tests/b.spec.ts b/tests/b.spec.ts',
  '--- a/tests/b.spec.ts',
  '+++ b/tests/b.spec.ts',
  '@@ -1 +1 @@',
  '-old-b',
  '+new-b',
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1 @@',
  '-old-doc',
  '+new-doc',
].join('\n')

afterEach(() => { document.body.innerHTML = '' })

describe('DiffFiles file folding', () => {
  it('expands source by default while tests and docs stay collapsed', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      act(() => { root.render(createElement(DiffFiles, { diff })) })
      const headers = [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]
      expect(headers).toHaveLength(3)
      expect(headers.map(header => header.getAttribute('aria-expanded'))).toEqual(['true', 'false', 'false'])
      expect(container.textContent).toContain('new-a')
      expect(container.textContent).not.toContain('new-b')
      expect(container.textContent).not.toContain('new-doc')

      act(() => { headers[1]!.click() })
      expect(headers[1]!.getAttribute('aria-expanded')).toBe('true')
      expect(container.textContent).toContain('new-b')

      act(() => { headers[0]!.click() })
      expect(headers[0]!.getAttribute('aria-expanded')).toBe('false')
      expect(container.textContent).not.toContain('new-a')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('caps the default expansion by changed lines, not by file count', () => {
    // Six source files of 600 changed lines each: the first three fill the
    // 2000-line budget, so the other three start folded (their headers still
    // carry the +/− stats and can be opened one by one).
    const parts: string[] = []
    for (let file = 0; file < 6; file += 1) {
      parts.push(
        `diff --git a/src/f${file}.ts b/src/f${file}.ts`,
        `--- a/src/f${file}.ts`,
        `+++ b/src/f${file}.ts`,
        '@@ -1,300 +1,300 @@',
      )
      for (let line = 0; line < 300; line += 1) parts.push(`-old-${file}-${line}`, `+new-${file}-${line}`)
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      act(() => { root.render(createElement(DiffFiles, { diff: parts.join('\n') })) })
      const headers = [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]
      expect(headers).toHaveLength(6)
      expect(headers.map(header => header.getAttribute('aria-expanded')))
        .toEqual(['true', 'true', 'true', 'false', 'false', 'false'])
      // Only the three budgeted files mount their rows (600 each; the pairs
      // render as `mod`, so count every change class and not just `add`).
      expect(container.querySelectorAll('[data-kind="add"], [data-kind="del"], [data-kind="mod"], [data-kind="context"]'))
        .toHaveLength(1800)
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('renders the caller-supplied parse instead of parsing the patch again', () => {
    // The changes pane parses one patch for BOTH its header stats and these
    // rows; a second parse of an ≤8MB patch on the UI thread was the cost.
    const parsed = parseUnifiedDiff(diff)
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      act(() => { root.render(createElement(DiffFiles, { diff: 'not a unified diff', parsed })) })
      const headers = [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]
      expect(headers).toHaveLength(3)
      expect(container.textContent).toContain('new-a')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})
