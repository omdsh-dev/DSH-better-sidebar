/**
 * The unified changes tab shell: the lens switcher swaps the Git lens for
 * the session lens, a Git-lens file row opens the shared preview pane
 * (loaded through the mocked git API, rendered by the shared DiffFiles
 * stack), and the session ops ride the mocked `changes.ops` poll — the
 * event poll, the op fold and the badge cache all live in the tab.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ChangesTab, opCountOf } from '../src/client/changes/ChangesTab.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { api, type GitStatusResult, type GitWorktree } from '../src/client/api.ts'
import type { Context } from '../src/context-types.ts'
import type { SidebarTab } from '../src/client/state.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

const MAIN = 'C:/repo/main'

/** One synthetic tool/call + tool/result pair (write of one file). */
function writeEvents(seq: number, path: string): Array<{ type: string; seq: number; time: number; data: Record<string, unknown> }> {
  return [
    { type: 'tool/call', seq, time: seq, data: { name: 'write', callId: `w${seq}`, arguments: JSON.stringify({ file_path: path, content: 'body' }) } },
    { type: 'tool/result', seq: seq + 1, time: seq + 1, data: { message: { source: { kind: 'tool', callId: `w${seq}` }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] } } },
  ]
}

function fakeContext(): Context {
  return {
    get: () => undefined,
  } as unknown as Context
}

function mount(root: Root, tab: SidebarTab = { id: 'git', type: 'git', title: 'Changes' }): void {
  act(() => {
    root.render(createElement(ChangesTab, {
      ctx: fakeContext(),
      store: createSidebarStore(),
      scope: { sessionId: 'session', cwd: MAIN },
      tab,
      visible: false,
      onOpenFile: () => {},
      onOpenDiff: () => {},
    }))
  })
}

function mockGit(entries: Array<{ path: string; xy: string }>): void {
  vi.spyOn(api, 'gitWorktrees').mockResolvedValue([
    { path: MAIN, branch: 'main', current: true, changes: entries.length },
  ] as GitWorktree[])
  vi.spyOn(api, 'gitStatus').mockResolvedValue({
    isRepo: true, branch: 'main', entries,
  } as GitStatusResult)
  vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })
  vi.spyOn(api, 'gitLog').mockResolvedValue([])
}

async function flushEffects(): Promise<void> {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('ChangesTab', () => {
  it('renders the git lens by default and previews a file row in the pane', async () => {
    mockGit([{ path: 'src/a.ts', xy: ' M' }])
    vi.spyOn(api, 'gitDiff').mockResolvedValue({
      diff: [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ].join('\n'),
    })

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()

      // Git lens: the file row from the mocked status (badge letter + path).
      const row = [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.textContent?.includes('src/a.ts'))
      expect(row).toBeDefined()

      // Clicking the row previews inline (no diff tab minted): the shared
      // renderer draws the added row.
      await act(async () => { row!.click() })
      await flushEffects()
      expect(container.textContent).toContain('new')

      // The preview survives a lens switch (it is a dock, not lens state).
      const group = container.querySelector('[role="group"]')
      const sessionButton = [...group!.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.getAttribute('aria-pressed') === 'false')
      expect(sessionButton).toBeDefined()
      await act(async () => { sessionButton!.click() })
      expect(container.textContent).toContain('src/a.ts')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('folds the polled session events into session-lens rows and the badge cache', async () => {
    mockGit([])
    const ops = vi.spyOn(api, 'changesOps')
      .mockResolvedValue({ events: [...writeEvents(1, 'src/a.ts'), ...writeEvents(3, 'src/b.ts')], lastSeq: 4 })

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()

      // The tab pulled once on mount and published the op count.
      expect(ops).toHaveBeenCalled()
      expect(opCountOf('session')).toBe(2)

      const group = container.querySelector('[role="group"]')
      const buttons = [...group!.querySelectorAll<HTMLButtonElement>('button')]
      await act(async () => { buttons[1]!.click() })
      // Two files grouped, newest first; the write chip carries its count.
      expect(container.textContent).toContain('src/b.ts')
      expect(container.textContent).toContain('src/a.ts')
      const chips = [...container.querySelectorAll('button[aria-pressed]')]
      expect(chips.some(chip => /写入\s*2|Write\s*2/.test(chip.textContent ?? ''))).toBe(true)
      // The git lens (its branch picker) is unmounted by the switch.
      expect(container.querySelector('select')).toBeNull()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})
