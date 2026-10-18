/**
 * The More Actions menu's Push / Pull affordances (the AI commit-message
 * suggestion is pinned by `git-suggest.spec.tsx`).
 *
 * These pin the WIRING the host routes cannot see — which args each action
 * sends (scope, selected checkout) and that its failure lands on the footer's
 * ONE status line, the same channel commit / stage failures use
 * (`changes-tab.spec.tsx` pins that placement).
 *
 * The copy assertions go through `t()`, so they follow the active locale
 * rather than pinning one language's strings.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { GitLens } from '../src/client/changes/GitLens.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { api, type GitStatusResult, type GitWorktree } from '../src/client/api.ts'
import { t } from '../src/client/locales.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

const MAIN = 'C:/repo/main'

/** Install one inventory whose status carries `entries`. */
function mockGit(entries: Array<{ path: string; xy: string }>): void {
  vi.spyOn(api, 'gitWorktrees').mockResolvedValue([
    { path: MAIN, branch: 'main', current: true, changes: entries.length },
  ] as GitWorktree[])
  vi.spyOn(api, 'gitStatus').mockResolvedValue({ isRepo: true, branch: 'main', entries } as GitStatusResult)
  vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })
  // The lens's history surface is the Graph section (#969): a quiet page.
  vi.spyOn(api, 'gitGraph').mockResolvedValue({
    isRepo: true, root: MAIN, entries: [], branches: [], hasMore: false, snapshot: 'one',
  })
}

function mountGit(root: Root): void {
  act(() => {
    root.render(createElement(GitLens, {
      scope: { sessionId: 'session', cwd: MAIN },
      store: createSidebarStore(),
      onOpenFile: () => {},
      onPreview: () => {},
      selectedRef: null,
      visible: true,
    }))
  })
}

async function flushEffects(): Promise<void> {
  // The refresh chain (inventory → branches/log → state) is several promise
  // hops deep, so a shallow flush asserts on rows still in flight.
  for (let round = 0; round < 5; round += 1) await act(async () => { await Promise.resolve() })
}

function makeRoot(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div')
  document.body.append(container)
  return { container, root: createRoot(container) }
}

/** Push/Pull live in the native, portaled More Actions menu. */
async function selectRemoteAction(container: HTMLElement, label: string): Promise<void> {
  const trigger = container.querySelector<HTMLButtonElement>(`button[aria-label="${t('gitMoreActions')}"]`)
  if (trigger === null) throw new Error('More Actions button not found')
  act(() => { trigger.click() })
  const item = [...document.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')]
    .find(candidate => candidate.textContent === label)
  if (item === undefined) throw new Error(`remote menu action not found: ${label}`)
  expect(container.contains(item)).toBe(false)
  await act(async () => { item.click() })
  await flushEffects()
}

/** One rendered error line of the footer. */
function errorLine(container: HTMLElement, text: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>('[role="alert"]')]
    .find(node => (node.textContent ?? '').includes(text))
}

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('GitLens More Actions menu: remote actions', () => {
  it('pushes and pulls the selected checkout, reporting failures on the same status line', async () => {
    mockGit([{ path: 'src/a.ts', xy: ' M' }])
    const push = vi.spyOn(api, 'gitPush').mockResolvedValue({ ok: true })
    const pull = vi.spyOn(api, 'gitPull').mockRejectedValue(new Error('Not possible to fast-forward'))

    const { container, root } = makeRoot()
    try {
      mountGit(root)
      await flushEffects()

      await selectRemoteAction(container, t('push'))
      expect(push).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session' }), MAIN)

      await selectRemoteAction(container, t('pull'))
      expect(pull).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session' }), MAIN)
      const error = errorLine(container, `${t('pullError')}: Not possible to fast-forward`)
      expect(error).toBeDefined()
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1)
      expect(container.querySelector('[data-git-footer]')!.contains(error!)).toBe(true)

      // A screenful of git stderr keeps its height but must be dismissible
      // instead of squatting in the docked footer.
      const dismiss = error!.querySelector<HTMLButtonElement>(`button[aria-label="${t('dismiss')}"]`)
      expect(dismiss).not.toBeNull()
      act(() => { dismiss!.click() })
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0)
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})
