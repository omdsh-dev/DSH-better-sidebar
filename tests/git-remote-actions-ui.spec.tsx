/**
 * The commit bar's Push / Pull affordances (the AI commit-message suggestion
 * that landed in the same upstream PR is pinned by `git-suggest.spec.tsx`,
 * which keeps the implementation merged from `port/pr-642`).
 *
 * These pin the WIRING the host routes cannot see — which args each action
 * sends (scope, selected checkout) and that its failure lands on the bar's ONE
 * status line, the same channel commit / stage failures use
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
  vi.spyOn(api, 'gitLog').mockResolvedValue([])
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
      refreshTick: 0,
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

/** One text button of the commit bar, by its label. */
function textButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find(candidate => candidate.textContent === label)
  if (button === undefined) throw new Error(`no commit-bar button labelled "${label}"`)
  return button
}

/** One rendered error line of the commit bar. */
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

describe('GitLens commit bar: remote actions', () => {
  it('pushes and pulls the selected checkout, reporting failures on the same status line', async () => {
    mockGit([{ path: 'src/a.ts', xy: ' M' }])
    const push = vi.spyOn(api, 'gitPush').mockResolvedValue({ ok: true })
    const pull = vi.spyOn(api, 'gitPull').mockRejectedValue(new Error('Not possible to fast-forward'))

    const { container, root } = makeRoot()
    try {
      mountGit(root)
      await flushEffects()

      await act(async () => { textButton(container, t('push')).click() })
      await flushEffects()
      expect(push).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session' }), MAIN)

      await act(async () => { textButton(container, t('pull')).click() })
      await flushEffects()
      expect(pull).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session' }), MAIN)
      expect(errorLine(container, `${t('pullError')}: Not possible to fast-forward`)).toBeDefined()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})
