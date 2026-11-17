/**
 * The files panel's CONTENT search (the VS Code Search view analogue), plus
 * the git ink the result rows share with the tree:
 *
 * - the mode switch replaces the name box with the content box (placeholder +
 *   tool row), and the query runs `fs.grep` with the toggles;
 * - results group by file and each line carries its number and highlighted
 *   ranges; clicking a line opens the file AT that line;
 * - the files-to-include / files-to-exclude fields ride the request as glob
 *   arrays (the host merges the exclude list with the explorer pref);
 * - Replace All confirms once with the counts, then calls `fs.grepReplace`
 *   with the mtimes the rows were rendered from;
 * - a modified file's row name takes the shared git tone and a letter badge,
 *   in BOTH result modes, so results read like the explorer.
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { GitStatusResult, GrepResult, GrepReplaceResult } from '../src/client/api.ts'
import { TreePanel } from '../src/client/TreePanel.tsx'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so the panel's copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const GREP: GrepResult = {
  files: [
    {
      path: 'src/a.ts',
      mtimeMs: 111,
      matches: [
        { line: 2, text: 'const target = 1', ranges: [{ start: 6, end: 12 }] },
        { line: 9, text: 'return target', ranges: [{ start: 7, end: 13 }] },
      ],
    },
    {
      path: 'docs/b.md',
      mtimeMs: 222,
      matches: [{ line: 1, text: 'target doc', ranges: [{ start: 0, end: 6 }] }],
    },
  ],
  matchesTotal: 3,
  truncated: false,
}

const REPLACE: GrepReplaceResult = {
  files: [
    { path: 'src/a.ts', replaced: 2 },
    { path: 'docs/b.md', replaced: 1 },
  ],
  replaced: 3,
  skipped: [],
}

const REPO: GitStatusResult = {
  isRepo: true,
  root: '/tmp',
  entries: [{ path: 'src/a.ts', xy: ' M' }],
}

const { fsTrees, fsSearch, fsGrep, fsGrepReplace, gitStatus } = vi.hoisted(() => ({
  fsTrees: vi.fn(async (_scope: unknown, paths: readonly string[]) => ({
    levels: paths.map(path => ({ path, entries: [], truncated: false })),
  })),
  fsSearch: vi.fn(async () => ({ matches: ['src/a.ts', 'docs/b.md'], dirs: [], truncated: false })),
  fsGrep: vi.fn(async (): Promise<GrepResult> => GREP),
  fsGrepReplace: vi.fn(async (): Promise<GrepReplaceResult> => REPLACE),
  gitStatus: vi.fn(async (): Promise<GitStatusResult> => REPO),
}))

vi.mock('../src/client/api.ts', () => ({
  api: { fsTrees, fsSearch, fsGrep, fsGrepReplace, gitStatus },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

interface Harness {
  container: HTMLDivElement
  unmount: () => void
}

function mountPanel(overrides: Partial<ComponentProps<typeof TreePanel>> = {}): Harness {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(createElement(TreePanel, {
      sessionId: 's1',
      cwd: '/tmp',
      expanded: [],
      revealed: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
      ...overrides,
    }))
  })
  return {
    container,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/** Set a controlled input's value the React way (native setter + input). */
function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function queryInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('input[class*="editorSearchInput"]')!
}

/** Type a query into the search box and let the debounce elapse. */
async function search(container: HTMLElement, query: string, mode: 'name' | 'content'): Promise<void> {
  if (mode === 'content') await switchToContent(container)
  await act(async () => { setInput(queryInput(container), query) })
  await act(async () => { await new Promise<void>(resolve => { window.setTimeout(resolve, mode === 'content' ? 450 : 400) }) })
}

/** Flip the mode segmented control to the content half. */
async function switchToContent(container: HTMLElement): Promise<void> {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button[class*="editorSearchModeButton"]')]
    .find(el => el.getAttribute('aria-label') === 'Search file contents')!
  await act(async () => { button.click() })
}

/** Click one tool-row IconButton by its accessible name. */
async function clickTool(container: HTMLElement, label: string): Promise<void> {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label]')]
    .find(el => el.getAttribute('aria-label') === label)!
  await act(async () => { button.click() })
}

let harness: Harness
afterEach(() => {
  harness.unmount()
  document.body.innerHTML = ''
  fsTrees.mockClear()
  fsSearch.mockClear()
  fsGrep.mockClear()
  fsGrepReplace.mockClear()
  gitStatus.mockClear()
})

describe('TreePanel content search', () => {
  it('switches modes, groups the result by file and reports the summary', async () => {
    harness = mountPanel()
    await act(async () => {})
    await search(harness.container, 'target', 'content')

    expect(fsGrep).toHaveBeenCalledTimes(1)
    const [scope, query, options] = fsGrep.mock.calls[0] as unknown as [unknown, string, Record<string, unknown>]
    expect(scope).toMatchObject({ sessionId: 's1', cwd: '/tmp' })
    expect(query).toBe('target')
    expect(options).toMatchObject({ caseSensitive: false, wholeWord: false, regex: false })
    expect(options.include).toBeUndefined()
    expect(options.exclude).toBeUndefined()

    const group = harness.container.querySelector<HTMLElement>('[data-dsh-grep-file="src/a.ts"]')!
    expect(group.querySelector('[class*="grepFileName"]')!.textContent).toBe('src/a.ts')
    expect(group.querySelectorAll('[data-dsh-grep-line]')).toHaveLength(2)
    const summary = harness.container.querySelector<HTMLElement>('[data-dsh-grep-summary="true"]')!
    expect(summary.textContent).toBe('2 files · 3 matches')
  })

  it('highlights the reported ranges and opens a line at its file', async () => {
    const onOpenFile = vi.fn()
    const onOpenFileAtLine = vi.fn()
    harness = mountPanel({ onOpenFile, onOpenFileAtLine })
    await act(async () => {})
    await search(harness.container, 'target', 'content')

    const marks = [...harness.container.querySelectorAll<HTMLElement>('[class*="editorSearchMark"]')]
    expect(marks.map(mark => mark.textContent)).toEqual(['target', 'target', 'target'])
    expect(marks[0]!.closest('[data-dsh-grep-line]')?.getAttribute('data-dsh-grep-line')).toBe('2')

    const row = [...harness.container.querySelectorAll<HTMLButtonElement>('[data-dsh-grep-line]')]
      .find(el => el.getAttribute('data-dsh-grep-line') === '9')!
    await act(async () => { row.click() })
    expect(onOpenFileAtLine).toHaveBeenCalledWith('/tmp/src/a.ts', 9)
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('sends the option toggles and the include/exclude globs', async () => {
    harness = mountPanel()
    await act(async () => {})
    await switchToContent(harness.container)
    // Reveal the fields, fill them, then run the search once.
    await clickTool(harness.container, 'Replace')
    await clickTool(harness.container, 'Files to include / exclude')
    const inputs = [...harness.container.querySelectorAll<HTMLInputElement>('input[class*="editorSearchInput"]')]
    const include = inputs.find(el => (el.placeholder).startsWith('Files to include'))!
    const exclude = inputs.find(el => (el.placeholder).startsWith('Files to exclude'))!
    const replacement = inputs.find(el => el.placeholder === 'Replace with…')!
    await act(async () => {
      setInput(include, 'src/**, *.ts')
      setInput(exclude, '**/*.min.js')
      setInput(replacement, 'done')
    })
    const toggles = [...harness.container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')]
    await act(async () => {
      toggles.find(el => el.getAttribute('aria-label') === 'match case')!.click()
      toggles.find(el => el.getAttribute('aria-label') === 'by word')!.click()
      toggles.find(el => el.getAttribute('aria-label') === 'regexp')!.click()
    })
    await search(harness.container, 'target', 'content')

    const [, , options] = fsGrep.mock.calls.at(-1) as unknown as [unknown, string, Record<string, unknown>]
    expect(options).toMatchObject({ caseSensitive: true, wholeWord: true, regex: true })
    expect(options.include).toEqual(['src/**', '*.ts'])
    expect(options.exclude).toEqual(['**/*.min.js'])
  })

  it('confirms Replace All, then sends the rendered files with their mtimes', async () => {
    harness = mountPanel()
    await act(async () => {})
    await switchToContent(harness.container)
    await clickTool(harness.container, 'Replace')
    await search(harness.container, 'target', 'content')

    const replaceButton = harness.container.querySelector<HTMLButtonElement>('[class*="editorSearchReplaceAll"]')!
    await act(async () => { replaceButton.click() })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain('Replace 3 matches in 2 files?')
    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find(el => el.textContent === 'replace all')!
    await act(async () => { confirm.click() })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(fsGrepReplace).toHaveBeenCalledTimes(1)
    const [, query, replacement, options, files] = fsGrepReplace.mock.calls[0] as unknown as [
      unknown, string, string, Record<string, unknown>, { path: string; mtimeMs: number }[],
    ]
    expect(query).toBe('target')
    expect(replacement).toBe('')
    expect(options).toMatchObject({ caseSensitive: false, wholeWord: false, regex: false })
    expect(files).toEqual([{ path: 'src/a.ts', mtimeMs: 111 }, { path: 'docs/b.md', mtimeMs: 222 }])
    expect(harness.container.textContent).toContain('Replaced 3 matches in 2 files')
  })
})

describe('search result git ink', () => {
  it('tints a modified file in a CONTENT result and badges its letter', async () => {
    harness = mountPanel()
    await act(async () => {})
    await search(harness.container, 'target', 'content')
    const changed = harness.container.querySelector<HTMLElement>('[data-dsh-grep-file="src/a.ts"]')!
    expect(changed.querySelector<HTMLElement>('[class*="grepFileName"]')!.getAttribute('data-git-tone')).toBe('modified')
    expect(changed.querySelector<HTMLElement>('[class*="statusBadge"]')?.textContent).toBe('M')
    const clean = harness.container.querySelector<HTMLElement>('[data-dsh-grep-file="docs/b.md"]')!
    expect(clean.querySelector<HTMLElement>('[class*="grepFileName"]')!.getAttribute('data-git-tone')).toBeNull()
    expect(clean.querySelector('[class*="statusBadge"]')).toBeNull()
  })

  it('tints a modified file in a NAME result the same way', async () => {
    harness = mountPanel()
    await act(async () => {})
    await search(harness.container, 'a', 'name')
    const rows = [...harness.container.querySelectorAll<HTMLButtonElement>('[class*="editorSearchResult"]')]
    const changed = rows.find(row => row.textContent?.startsWith('src/a.ts'))!
    expect(changed.querySelector<HTMLElement>('[class*="editorSearchResultLabel"]')!.getAttribute('data-git-tone')).toBe('modified')
    expect(changed.querySelector<HTMLElement>('[class*="statusBadge"]')?.textContent).toBe('M')
    const clean = rows.find(row => row.textContent?.startsWith('docs/b.md'))!
    expect(clean.querySelector('[class*="statusBadge"]')).toBeNull()
  })
})