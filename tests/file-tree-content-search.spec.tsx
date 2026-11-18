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
  fsGrepReplace: vi.fn(async (
    _scope: unknown,
    _query: unknown,
    _replacement: unknown,
    _options: unknown,
    files: readonly { path: string }[],
  ): Promise<GrepReplaceResult> => ({
    files: files.map(file => ({ path: file.path, replaced: file.path === 'src/a.ts' ? 2 : 1 })),
    replaced: files.reduce((total, file) => total + (file.path === 'src/a.ts' ? 2 : 1), 0),
    skipped: [],
  })),
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
    expect(onOpenFileAtLine).toHaveBeenCalledWith('/tmp/src/a.ts', 9, { query: 'target' })
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('sends the option toggles and the include/exclude globs', async () => {
    const onOpenFileAtLine = vi.fn()
    harness = mountPanel({ onOpenFileAtLine })
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

    // The hit carries the SAME switches into the editor: the find panel it
    // seeds must match what the host searched for.
    const hit = [...harness.container.querySelectorAll<HTMLButtonElement>('[data-dsh-grep-line]')][0]!
    await act(async () => { hit.click() })
    expect(onOpenFileAtLine).toHaveBeenCalledWith('/tmp/src/a.ts', 2, {
      query: 'target', caseSensitive: true, wholeWord: true, regex: true,
    })
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

  it('replaces every occurrence of ONE file from the group action (no confirm)', async () => {
    harness = mountPanel()
    await act(async () => {})
    await switchToContent(harness.container)
    await clickTool(harness.container, 'Replace')
    await search(harness.container, 'target', 'content')

    const action = harness.container.querySelector<HTMLButtonElement>(
      '[data-dsh-grep-file="src/a.ts"] button[aria-label="Replace in this file"]',
    )!
    expect(action).not.toBeNull()
    await act(async () => { action.click() })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    // One file, no `line`: the whole file's occurrences.
    expect(fsGrepReplace).toHaveBeenCalledTimes(1)
    const [, , , , files] = fsGrepReplace.mock.calls[0] as unknown as [
      unknown, string, string, unknown, { path: string; mtimeMs: number }[],
    ]
    expect(files).toEqual([{ path: 'src/a.ts', mtimeMs: 111 }])
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('keeps the per-file / per-match actions off until replace mode is open', async () => {
    harness = mountPanel()
    await act(async () => {})
    await search(harness.container, 'target', 'content')
    // With the replace field closed the replacement text is not on screen; an
    // always-visible action could silently delete every match.
    expect(harness.container.querySelector('button[aria-label="Replace in this file"]')).toBeNull()
    expect(harness.container.querySelector('button[aria-label="Replace this match"]')).toBeNull()
  })

  it('replaces exactly one occurrence from a match row action', async () => {
    harness = mountPanel()
    await act(async () => {})
    await switchToContent(harness.container)
    await clickTool(harness.container, 'Replace')
    await search(harness.container, 'target', 'content')

    const row = harness.container.querySelector<HTMLElement>('[data-dsh-grep-line="2"][data-dsh-grep-match="0"]')!
    const action = row.querySelector<HTMLButtonElement>('button[aria-label="Replace this match"]')!
    expect(action).not.toBeNull()
    await act(async () => { action.click() })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    const [, , , , files] = fsGrepReplace.mock.calls[0] as unknown as [
      unknown, string, string, unknown, { path: string; mtimeMs: number; line?: number; matchIndex?: number }[],
    ]
    // The row's line + its ordinal on that line: exactly one span on the host.
    expect(files).toEqual([{ path: 'src/a.ts', mtimeMs: 111, line: 2, matchIndex: 0 }])
  })

  it('renders ONE ROW PER OCCURRENCE and targets the clicked ordinal', async () => {
    // Three matches live on line 4; VS Code renders them as three rows so each
    // can be replaced on its own.
    fsGrep.mockResolvedValueOnce({
      files: [{
        path: 'src/multi.ts',
        mtimeMs: 333,
        matches: [{ line: 4, text: 'target target target', ranges: [
          { start: 0, end: 6 }, { start: 7, end: 13 }, { start: 14, end: 20 },
        ] }],
      }],
      matchesTotal: 3,
      truncated: false,
    })
    harness = mountPanel()
    await act(async () => {})
    await switchToContent(harness.container)
    await clickTool(harness.container, 'Replace')
    await search(harness.container, 'target', 'content')

    const rows = [...harness.container.querySelectorAll<HTMLElement>('[data-dsh-grep-line="4"]')]
    expect(rows.map(row => row.getAttribute('data-dsh-grep-match'))).toEqual(['0', '1', '2'])
    // The file header counts OCCURRENCES, not lines.
    expect(harness.container.querySelector('[data-dsh-grep-file="src/multi.ts"] [class*="grepFileCount"]')?.textContent).toBe('3')

    const action = rows[1]!.querySelector<HTMLButtonElement>('button[aria-label="Replace this match"]')!
    await act(async () => { action.click() })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    const [, , , , files] = fsGrepReplace.mock.calls[0] as unknown as [
      unknown, string, string, unknown, { path: string; mtimeMs: number; line?: number; matchIndex?: number }[],
    ]
    expect(files).toEqual([{ path: 'src/multi.ts', mtimeMs: 333, line: 4, matchIndex: 1 }])
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