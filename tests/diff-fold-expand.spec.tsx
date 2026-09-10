// @vitest-environment jsdom
/**
 * The git fold expansion path: DiffFiles forwards a resolveFold loader to
 * DiffRows, whose first click on a rows-less git gap fold fetches the hidden
 * rows (loading/failed markers in between) and later clicks toggle; folds
 * that carry rows (the session-op path) expand directly, and gaps without a
 * loader stay inert markers — the pre-fix behavior for op diffs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { DiffFiles } from '../src/client/diff/DiffFiles.tsx'
import { DiffRows } from '../src/client/diff/DiffRows.tsx'
import { buildDiffSegments, diffLines, type DiffFile, type FoldSegment } from '../src/client/diff/rows.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// A git-shaped two-hunk patch: the gap between the hunks (old/new lines
// 2..11) is a fold WITHOUT rows — expandable only through a resolveFold.
const gapDiff = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '@@ -12 +12 @@',
  '-tail',
  '+tail2',
].join('\n')

// The hidden context rows a loader slices out of both sides' contents.
const hiddenRows = Array.from({ length: 10 }, (_, i) => ({
  kind: 'context' as const,
  oldLine: i + 2,
  newLine: i + 2,
  text: `ctx-${String(i + 2)}`,
}))

afterEach(() => { document.body.innerHTML = '' })

describe('DiffFiles on-demand fold expansion', () => {
  it('expands a git gap fold through resolveFold, then collapses back', async () => {
    const resolveFold = vi.fn((_file: DiffFile, _segment: FoldSegment) => Promise.resolve(hiddenRows))
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      act(() => { root.render(createElement(DiffFiles, { diff: gapDiff, resolveFold })) })
      const fold = container.querySelector<HTMLElement>('[data-expandable="true"]')
      expect(fold).not.toBeNull()
      expect(container.textContent).not.toContain('ctx-5')

      await act(async () => { fold!.click() })
      expect(resolveFold).toHaveBeenCalledOnce()
      expect(container.textContent).toContain('ctx-5')
      // The loader received the gap fold itself (line ranges on board).
      const segment = resolveFold.mock.calls[0]![1]
      expect(segment.kind).toBe('fold')
      expect(segment.oldStart).toBe(2)

      // Collapse: the marker is back; the fetch never repeats.
      const expanded = container.querySelector<HTMLElement>('[data-expandable="true"]')
      await act(async () => { expanded!.click() })
      expect(container.textContent).not.toContain('ctx-5')
      expect(resolveFold).toHaveBeenCalledOnce()

      // Re-expanding resolves from the per-fold cache (no second fetch).
      const collapsed = container.querySelector<HTMLElement>('[data-expandable="true"]')
      await act(async () => { collapsed!.click() })
      expect(container.textContent).toContain('ctx-5')
      expect(resolveFold).toHaveBeenCalledOnce()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('degrades to the unavailable marker when the loader rejects', async () => {
    const resolveFold = vi.fn(() => Promise.reject(new Error('boom')))
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      act(() => { root.render(createElement(DiffFiles, { diff: gapDiff, resolveFold })) })
      const fold = container.querySelector<HTMLElement>('[data-expandable="true"]')
      await act(async () => { fold!.click() })
      // The degraded fold promises no interaction.
      expect(container.querySelector('[data-expandable]')).toBeNull()
      expect(container.textContent).not.toContain('ctx-5')
      // jsdom's navigator.language is en-US → the en copy.
      expect(container.textContent).toContain('Context unavailable')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('keeps git gap folds inert without a resolver (session surfaces unchanged)', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      act(() => { root.render(createElement(DiffFiles, { diff: gapDiff })) })
      expect(container.querySelector('[data-expandable]')).toBeNull()
      // The quiet marker still shows the hidden line count.
      expect(container.textContent).toContain('10 lines')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('expands session folds (rows carried) directly, without any loader', async () => {
    // buildDiffSegments output — the session-op path: folds carry their rows,
    // so they toggle on click exactly as before the git expansion existed.
    const rows = diffLines(
      'a\nb\nc\nd\ne\nX\nf\ng\nh\ni\nj\nk\nl\n',
      'a\nb\nc\nd\ne\nY\nf\ng\nh\ni\nj\nk\nl\n',
    )
    const segments = buildDiffSegments(rows)
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      act(() => { root.render(createElement(DiffRows, { segments })) })
      const fold = container.querySelector<HTMLElement>('[data-expandable="true"]')
      expect(fold).not.toBeNull()
      // 'j' is hidden in the tail fold (the marker copy carries no 'j').
      expect(container.textContent).not.toContain('j')
      await act(async () => { fold!.click() })
      expect(container.textContent).toContain('j')
      const expanded = container.querySelector<HTMLElement>('[data-expandable="true"]')
      await act(async () => { expanded!.click() })
      expect(container.textContent).not.toContain('j')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})
