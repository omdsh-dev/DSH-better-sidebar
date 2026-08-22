/**
 * GitView header pinning (issue #194): the branch select and the inline
 * commit box live in a flex-none header above a dedicated scrolling body —
 * the commit form must stay reachable no matter how long the status/history
 * lists get, and never scroll away with them. The regression guard: the
 * commit input/button sit OUTSIDE the `.gitBody` scroll container while the
 * staged/unstaged/history content lives inside it.
 */
// @vitest-environment jsdom
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { GitView } from '../src/client/GitView.tsx'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// vitest 4.1.11+ follows the OS locale; pin en-US so label assertions are
// deterministic regardless of the developer machine.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

/** The hookable git api surface (the commit mock is asserted in the multi-line case). */
const mocks = vi.hoisted(() => ({
  gitCommit: vi.fn(async () => ({ ok: true as const })),
}))

vi.mock('../src/client/api.ts', () => ({
  api: {
    gitStatus: async () => ({
      isRepo: true,
      branch: 'main',
      entries: [
        { path: 'staged.txt', xy: 'M ' },
        { path: 'unstaged.txt', xy: ' M' },
      ],
    }),
    gitBranch: async () => ({ current: 'main', names: ['main', 'dev'] }),
    gitLog: async () => [{
      hash: 'abc1234',
      hashFull: 'abc1234'.repeat(5),
      subject: 'Initial commit',
      author: 'Tester',
      date: '2026-01-01 10:00:00 +0800',
      refs: 'HEAD -> main',
    }],
    gitCommit: mocks.gitCommit,
  },
}))

interface Harness {
  container: HTMLDivElement
  body: HTMLElement
  unmount: () => void
}

/** Mount the git pane in a repo with one staged, one unstaged file and one log row. */
async function mountGit(): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(createElement(GitView, {
      scope: { sessionId: 's1', cwd: '/tmp' },
      onOpenFile: () => {},
      onOpenDiff: () => {},
    }))
  })
  return {
    container,
    body: container.firstElementChild as HTMLElement,
    unmount: () => { act(() => { root.unmount() }) },
  }
}

/** The scrolling body of the git pane ([class*="gitBody"]). */
function scrollBody(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('[class*="gitBody"]')
  if (el === null) throw new Error('gitBody not found')
  return el
}

/** The element whose text contains `name` (status rows are <button>s, log rows are divs). */
function rowByName(container: HTMLElement, name: string): HTMLElement {
  const el = [...container.querySelectorAll<HTMLElement>('button, [role="button"]')]
    .find(el => el.textContent?.includes(name))
  if (el === undefined) throw new Error(`row not found: ${name}`)
  return el
}

describe('GitView pinned header', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await mountGit()
  })
  afterEach(() => {
    harness.unmount()
    document.body.innerHTML = ''
  })

  it('keeps the commit textarea and button in the header, outside the scrolling body', () => {
    const input = harness.container.querySelector('textarea')
    expect(input).not.toBeNull()
    expect(input?.getAttribute('placeholder')).toContain('Commit message')

    const commitButton = [...harness.container.querySelectorAll('button')]
      .find(button => button.textContent === 'Commit')
    expect(commitButton).not.toBeNull()
    expect(commitButton?.hasAttribute('disabled')).toBe(true) // nothing staged on a fresh panel

    const body = scrollBody(harness.container)
    expect(body.contains(input)).toBe(false)
    expect(commitButton !== undefined && body.contains(commitButton)).toBe(false)
  })

  it('accepts multi-line commit messages and submits them verbatim with Ctrl+Enter', async () => {
    const area = harness.container.querySelector('textarea')
    expect(area).not.toBeNull()
    // A React controlled textarea must be written through the native value
    // setter, then announced with an input event (jsdom has no typing helper).
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    const message = 'feat: subject\n\nbody line one\nbody line two'
    act(() => { setter.call(area, message) })
    act(() => { area!.dispatchEvent(new Event('input', { bubbles: true })) })

    act(() => {
      area!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    })
    await act(async () => {}) // flush the async commit round-trip

    expect(mocks.gitCommit).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1' }),
      message,
    )
  })

  it('renders the branch select with the current branch and the other branches', () => {
    const select = harness.container.querySelector('select')
    expect(select).not.toBeNull()
    expect(select?.value).toBe('main')
    expect([...select?.options ?? []].map(option => option.value)).toEqual(['main', 'dev'])
  })

  it('places the status sections and history inside the scrolling body', () => {
    const body = scrollBody(harness.container)
    expect(body.textContent).toContain('Staged (1)')
    expect(body.textContent).toContain('Unstaged (1)')
    expect(body.textContent).toContain('History')
    expect(body.contains(rowByName(harness.container, 'staged.txt'))).toBe(true)
    expect(body.contains(rowByName(harness.container, 'unstaged.txt'))).toBe(true)
    expect(body.contains(rowByName(harness.container, 'Initial commit'))).toBe(true)
  })
})