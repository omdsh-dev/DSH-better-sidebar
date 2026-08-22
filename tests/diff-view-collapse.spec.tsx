// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { DiffView } from '../src/client/DiffView.tsx'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

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

describe('DiffView file folding', () => {
  it('expands source by default while tests and docs stay collapsed', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      act(() => { root.render(createElement(DiffView, { diff })) })
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
})
