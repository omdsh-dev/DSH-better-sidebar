/**
 * FileTree git ink (VS Code style): the tree reads the plugin's SHARED
 * `useGitStatus` store — a changed file's name takes its tone class and a
 * letter badge whose tooltip is the status word, a directory with a change
 * anywhere below it is tinted without a letter, a clean file stays plain, and
 * a non-repo (or unavailable git) degrades silently to plain rows.
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

const { gitStatus } = vi.hoisted(() => ({ gitStatus: vi.fn() }))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees: async (_scope: unknown, paths: readonly string[]) => ({
      levels: paths.map(path => ({ path, entries: [
        { name: 'sub', path: '/tmp/sub', isDir: true },
        { name: 'a.ts', path: '/tmp/a.ts', isDir: false },
        { name: 'b.ts', path: '/tmp/b.ts', isDir: false },
      ], truncated: false })),
    }),
    gitStatus,
  },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

const REPO: GitStatusResult = {
  isRepo: true,
  root: '/tmp',
  entries: [
    { path: 'a.ts', xy: ' M' },
    // A change strictly BELOW /tmp/sub: the directory is tinted, the file
    // itself is not rendered (its level is collapsed).
    { path: 'sub/inner.ts', xy: '??' },
  ],
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
      sessionId: 'git-spec',
      cwd: '/tmp',
      expanded: [],
      revealed: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
    }))
    // Settle the shared store's fetch (it starts in FileTree's mount effect).
    await Promise.resolve()
    await Promise.resolve()
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

describe('FileTree git ink', () => {
  it('tints a changed file name and badges its porcelain letter', async () => {
    gitStatus.mockResolvedValue(REPO)
    harness = await mountTree()
    const row = rowByName(harness.container, 'a.ts')
    expect(nameSpan(row).getAttribute('data-git-tone')).toBe('modified')
    expect(nameSpan(row).className).toContain('explorerGitName')
    const badge = row.querySelector<HTMLElement>('[class*="statusBadge"]')
    expect(badge?.textContent).toBe('M')
    expect(badge?.getAttribute('data-tone')).toBe('modified')
    expect(badge?.getAttribute('title')).toBe('Modified')
  })

  it('tints a directory that contains a change below it, without a letter', async () => {
    gitStatus.mockResolvedValue(REPO)
    harness = await mountTree()
    const row = rowByName(harness.container, 'sub')
    expect(nameSpan(row).className).toContain('explorerDirChanged')
    expect(row.querySelector('[class*="statusBadge"]')).toBeNull()
  })

  it('leaves a clean file plain', async () => {
    gitStatus.mockResolvedValue(REPO)
    harness = await mountTree()
    const row = rowByName(harness.container, 'b.ts')
    expect(nameSpan(row).getAttribute('data-git-tone')).toBeNull()
    expect(row.querySelector('[class*="statusBadge"]')).toBeNull()
  })

  it('degrades silently outside a repository', async () => {
    gitStatus.mockResolvedValue({ isRepo: false, entries: [] })
    harness = await mountTree()
    const file = rowByName(harness.container, 'a.ts')
    expect(nameSpan(file).getAttribute('data-git-tone')).toBeNull()
    expect(nameSpan(file).className).not.toContain('explorerGitName')
    const dir = rowByName(harness.container, 'sub')
    expect(nameSpan(dir).className).not.toContain('explorerDirChanged')
  })
})
