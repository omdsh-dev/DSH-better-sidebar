/**
 * Explorer auto-refresh tests: while the explorer is mounted it polls the
 * visible levels and re-renders only when a level's signature changed.
 * Pins (a) the signature function (name/type/hidden) and (b) the end-to-end
 * component behaviour with fake timers: an external edit appears in the DOM
 * without the manual refresh button, and a no-op poll does not rerender.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ExplorerView, levelSignature } from '../src/client/ExplorerView.tsx'
import { api, type FsEntry } from '../src/client/api.ts'

const SCOPE = { sessionId: 's1', cwd: 'C:\\proj' }

const entry = (name: string, isDir = false, hidden = false): FsEntry => ({
  name,
  path: `${SCOPE.cwd}\\${name}`,
  isDir,
  hidden,
})

function mountExplorer() {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(createElement(ExplorerView, {
      sessionId: SCOPE.sessionId,
      cwd: SCOPE.cwd,
      expanded: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
    }))
  })
  /** Flush the async fsTree promise chain so level data lands in the DOM. */
  const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }
  return { container, unmount: () => { act(() => { root.unmount() }); container.remove() }, flush }
}

describe('levelSignature', () => {
  it('distinguishes name, type and hidden state (server order is stable)', () => {
    const a = [entry('a.txt'), entry('src', true), entry('.env', false, true)]
    expect(levelSignature(a)).toBe(levelSignature([...a]))
    const differentName = [entry('b.txt'), entry('src', true), entry('.env', false, true)]
    const differentType = [entry('a.txt', true), entry('src', true), entry('.env', false, true)]
    const differentHidden = [entry('a.txt'), entry('src', true), entry('.env', false, false)]
    expect(levelSignature(a)).not.toBe(levelSignature(differentName))
    expect(levelSignature(a)).not.toBe(levelSignature(differentType))
    expect(levelSignature(a)).not.toBe(levelSignature(differentHidden))
  })
})

describe('ExplorerView auto-refresh', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  it('shows an externally created file after the next poll without a manual refresh', async () => {
    const fsTree = vi.spyOn(api, 'fsTree')
    fsTree.mockResolvedValueOnce({ path: SCOPE.cwd, entries: [entry('a.txt')], truncated: false })
    const { container, unmount, flush } = mountExplorer()
    await flush()
    expect(container.textContent).toContain('a.txt')
    expect(container.textContent).not.toContain('b.txt')

    fsTree.mockResolvedValueOnce({ path: SCOPE.cwd, entries: [entry('a.txt'), entry('b.txt')], truncated: false })
    await act(async () => { vi.advanceTimersByTime(2000) })
    expect(container.textContent).toContain('b.txt')
    unmount()
  })

  it('does not rerender when the polled level is unchanged', async () => {
    const fsTree = vi.spyOn(api, 'fsTree')
    fsTree.mockResolvedValue({ path: SCOPE.cwd, entries: [entry('a.txt')], truncated: false })
    const { container, unmount, flush } = mountExplorer()
    await flush()
    const before = container.textContent
    await act(async () => { vi.advanceTimersByTime(2000) })
    expect(container.textContent).toBe(before)
    unmount()
  })
})
