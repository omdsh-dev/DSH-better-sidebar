/**
 * FileTree git ink across a CONTAINER workspace (a cwd that holds several
 * independent repositories).
 *
 * The regression this pins: the host used to read only the FIRST discovered
 * repository's status, so with two checkouts under the session root every file
 * in the second one rendered plain. The store now indexes the primary snapshot
 * plus its `others`, so one snapshot colors rows in every repository:
 *
 * - a file changed in repository A takes A's tone/letter,
 * - a file changed in repository B takes B's tone/letter,
 * - a clean file stays plain, and both repository rows are tinted.
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { GitStatusResult } from '../src/client/api.ts'
import { FileTree } from '../src/client/FileTree.tsx'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so the badge tooltip is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const ROWS = {
  a: { name: 'a.ts', path: '/w/repo-a/a.ts', isDir: false },
  clean: { name: 'clean.ts', path: '/w/repo-a/clean.ts', isDir: false },
  b: { name: 'b.ts', path: '/w/repo-b/b.ts', isDir: false },
}

const { gitStatus } = vi.hoisted(() => ({ gitStatus: vi.fn() }))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees: async (_scope: unknown, paths: readonly string[]) => ({
      levels: paths.map((path) => {
        if (path === '/w') {
          return {
            path,
            entries: [
              { name: 'repo-a', path: '/w/repo-a', isDir: true },
              { name: 'repo-b', path: '/w/repo-b', isDir: true },
            ],
            truncated: false,
          }
        }
        if (path === '/w/repo-a') return { path, entries: [ROWS.a, ROWS.clean], truncated: false }
        if (path === '/w/repo-b') return { path, entries: [ROWS.b], truncated: false }
        return { path, entries: [], truncated: false }
      }),
    }),
    gitStatus,
  },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

/** Two independent checkouts under one session cwd, each with a change. */
const CONTAINER: GitStatusResult = {
  isRepo: true,
  root: '/w/repo-a',
  repositories: ['/w/repo-a', '/w/repo-b'],
  entries: [{ path: 'a.ts', xy: ' M' }],
  others: [{ root: '/w/repo-b', entries: [{ path: 'b.ts', xy: '??' }] }],
}

interface Harness {
  container: HTMLDivElement
  unmount: () => void
}

async function mountTree(): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(createElement(FileTree, {
      sessionId: 'multi',
      cwd: '/w',
      expanded: ['/w/repo-a', '/w/repo-b'],
      revealed: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
    }))
    for (let index = 0; index < 4; index += 1) await Promise.resolve()
  })
  return {
    container,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/** One tree row by its displayed name. */
function rowByName(container: HTMLElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row not found: ${name}`)
  return row
}

function nameSpan(row: HTMLElement): HTMLElement {
  return row.querySelector<HTMLElement>('[class*="explorerName"]')!
}

let harness: Harness
afterEach(() => {
  harness.unmount()
  document.body.innerHTML = ''
  gitStatus.mockReset()
})

describe('FileTree git ink in a multi-repository workspace', () => {
  it('tints rows in EVERY checkout, not only the first repository', async () => {
    gitStatus.mockResolvedValue(CONTAINER)
    harness = await mountTree()

    // Repository A (the primary snapshot).
    const a = rowByName(harness.container, 'a.ts')
    expect(nameSpan(a).getAttribute('data-git-tone')).toBe('modified')
    expect(a.querySelector<HTMLElement>('[class*="statusBadge"]')?.textContent).toBe('M')

    // Repository B lives in `others` — this is the row that used to stay plain.
    const b = rowByName(harness.container, 'b.ts')
    expect(nameSpan(b).getAttribute('data-git-tone')).toBe('untracked')
    expect(nameSpan(b).className).toContain('explorerGitName')
    const badge = b.querySelector<HTMLElement>('[class*="statusBadge"]')
    expect(badge?.textContent).toBe('U')
    expect(badge?.getAttribute('title')).toBe('Untracked')

    // A clean file in either repository stays plain.
    const clean = rowByName(harness.container, 'clean.ts')
    expect(nameSpan(clean).getAttribute('data-git-tone')).toBeNull()
    expect(clean.querySelector('[class*="statusBadge"]')).toBeNull()

    // Both repository rows carry a change below them.
    expect(nameSpan(rowByName(harness.container, 'repo-a')).className).toContain('explorerDirChanged')
    expect(nameSpan(rowByName(harness.container, 'repo-b')).className).toContain('explorerDirChanged')
  })

  it('asks for the aggregated container snapshot (no repository selection)', async () => {
    gitStatus.mockResolvedValue(CONTAINER)
    harness = await mountTree()
    expect(gitStatus).toHaveBeenCalled()
    expect(gitStatus.mock.calls[0]![0]).toMatchObject({ sessionId: 'multi', cwd: '/w' })
  })
})