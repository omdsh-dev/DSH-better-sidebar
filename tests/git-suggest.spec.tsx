/**
 * The Git lens' AI commit-message button: it asks the HOST (never a provider
 * directly) for a suggestion and drops the text into the commit box, still
 * editable and regenerable. The empty-changeset case is a dedicated wire code
 * (`git-suggest-empty`) so the panel can say "nothing to summarize" instead
 * of a generic generation failure.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { GitLens } from '../src/client/changes/GitLens.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { api, SidebarApiError, type GitStatusResult } from '../src/client/api.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

const CWD = 'C:/repo/main'

function pendingStatus(): GitStatusResult {
  return { isRepo: true, branch: 'main', entries: [{ path: 'src/app.ts', xy: ' M' }] }
}

async function mount(): Promise<{ container: HTMLElement; unmount: () => void }> {
  vi.spyOn(api, 'gitWorktrees').mockResolvedValue([{ path: CWD, branch: 'main', current: true, changes: 1 }])
  vi.spyOn(api, 'gitStatus').mockResolvedValue(pendingStatus())
  vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })
  vi.spyOn(api, 'gitLog').mockResolvedValue([])

  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(createElement(GitLens, {
      scope: { sessionId: 'session', cwd: CWD },
      store: createSidebarStore(),
      onOpenFile: () => {},
      onPreview: () => {},
      selectedRef: null,
      visible: false,
    }))
  })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return {
    container,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

/** The suggest button (aria-label carries the localized copy; default en). */
function suggestButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="Generate commit message"]')
  if (button === null) throw new Error('the suggest button is missing')
  return button
}

function commitInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input')
  if (input === null) throw new Error('the commit input is missing')
  return input
}

afterEach(() => { vi.restoreAllMocks() })

describe('GitLens commit-message suggestion', () => {
  it('fills the commit box with the host-generated message', async () => {
    const suggest = vi.spyOn(api, 'gitSuggestMessage')
      .mockResolvedValue({ message: 'fix: guard the empty diff', provider: 'deepseek', model: 'deepseek-chat' })
    const { container, unmount } = await mount()
    try {
      await act(async () => { suggestButton(container).click() })
      await act(async () => { await Promise.resolve() })

      expect(suggest).toHaveBeenCalledTimes(1)
      // The panel locale drives the prompt language (this test runs on en).
      expect(suggest.mock.calls[0]?.[1]).toBe('en')
      expect(commitInput(container).value).toBe('fix: guard the empty diff')
    } finally {
      unmount()
    }
  })

  it('says "nothing to summarize" for the dedicated empty-changeset code', async () => {
    vi.spyOn(api, 'gitSuggestMessage').mockRejectedValue(new SidebarApiError('git-suggest-empty', 'no pending changes'))
    const { container, unmount } = await mount()
    try {
      await act(async () => { suggestButton(container).click() })
      await act(async () => { await Promise.resolve() })

      expect(container.textContent).toContain('No pending changes to summarize')
      expect(commitInput(container).value).toBe('')
    } finally {
      unmount()
    }
  })

  it('prefixes any other failure as a generation error', async () => {
    vi.spyOn(api, 'gitSuggestMessage').mockRejectedValue(new SidebarApiError('git-suggest-error', 'llm down'))
    const { container, unmount } = await mount()
    try {
      await act(async () => { suggestButton(container).click() })
      await act(async () => { await Promise.resolve() })

      expect(container.textContent).toContain('Failed to generate commit message')
    } finally {
      unmount()
    }
  })
})
