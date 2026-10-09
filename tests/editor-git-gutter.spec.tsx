/**
 * The editor's uncommitted-change gutter (issue #212).
 *
 * Three behaviors are pinned here:
 *  - the LINE MAPPING: a `git diff` patch becomes line number → class, with
 *    additions and rewritten lines on the worktree side, an unpaired deletion
 *    anchored to the line above the gap, and context rows never marked
 *    (a gutter that tints unchanged lines is worse than no gutter at all);
 *  - the DECORATION GATE: the extensions are absent — not merely empty — for
 *    every viewer but `code` and while the ONE setting is switched off,
 *    checked against the real CodeMirror DOM the editor builds;
 *  - the BLAME MEMO: hovering the same line twice asks git once, a fresh
 *    change set drops the file's memo, and so does a change set that vanishes
 *    (commit / discard) — nothing is prefetched, and no hover is ever answered
 *    with a line git blamed before the commit (#212).
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { GitStatusResult } from '../src/client/api.ts'

const { gitStatus, gitDiffHead, gitBlame } = vi.hoisted(() => ({
  gitStatus: vi.fn(),
  gitDiffHead: vi.fn(),
  gitBlame: vi.fn(),
}))

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      gitStatus: (...args: unknown[]) => gitStatus(...args),
      gitDiffHead: (...args: unknown[]) => gitDiffHead(...args),
      gitBlame: (...args: unknown[]) => gitBlame(...args),
    },
  }
})

import { renderRoot, setupReactAct } from './test-utils.ts'
import {
  addedLineKinds,
  applyGitLineKinds,
  forgetBlame,
  GIT_BAR_GUTTER_CLASS,
  GIT_LINE_CLASS,
  gitGutterExtensions,
  gitLineKinds,
  loadBlameLine,
  type GitLineKind,
} from '../src/client/editor-git-gutter.ts'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { attachLocale } from '../src/client/locales.ts'
import { invalidateGitStatus } from '../src/client/ui/git-status.ts'
import { createSidebarStore } from '../src/client/state.ts'
import type { FileViewerProps } from '../src/client/service.ts'

setupReactAct()

/** Minimal structural fake of the DSH LocaleService face the sidebar uses. */
class FakeLocale {
  active: string = 'en'
  getSnapshot(): { active: string } { return { active: this.active } }
  subscribe(_fn: () => void): () => void { return () => {} }
}

beforeEach(() => {
  attachLocale(new FakeLocale())
  gitStatus.mockReset()
  gitDiffHead.mockReset()
  gitBlame.mockReset()
  gitStatus.mockResolvedValue({ isRepo: false, entries: [], repositories: [] })
  gitDiffHead.mockResolvedValue({ diff: '' })
  gitBlame.mockResolvedValue({ lines: [] })
})

afterEach(() => {
  attachLocale(undefined)
  document.body.innerHTML = ''
})

/** One `git diff --no-color -U3` patch over `path`, exactly git's own frame. */
function patch(path: string, hunks: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    hunks,
  ].join('\n') + '\n'
}

/** The mapping as a sorted array, for readable assertions. */
function entries(kinds: Map<number, GitLineKind>): Array<[number, GitLineKind]> {
  return [...kinds.entries()].sort((left, right) => left[0] - right[0])
}

describe('git diff → changed lines', () => {
  it('marks added lines and leaves every context line alone', () => {
    const diff = patch('src/a.ts', [
      '@@ -1,4 +1,6 @@',
      ' const one = 1',
      ' const two = 2',
      '+const three = 3',
      '+const four = 4',
      ' const five = 5',
      ' const six = 6',
    ].join('\n'))
    expect(entries(gitLineKinds(diff))).toEqual([[3, 'add'], [4, 'add']])
  })

  it('marks a rewritten line as modified — once, not as a delete plus an add', () => {
    const diff = patch('src/a.ts', [
      '@@ -1,3 +1,3 @@',
      ' const one = 1',
      '-const two = 2',
      '+const TWO = 2',
      ' const three = 3',
    ].join('\n'))
    // The deleted half of the pair carries no worktree line of its own, so the
    // buffer sees ONE modified row — no stray deletion bar on the line above.
    expect(entries(gitLineKinds(diff))).toEqual([[2, 'mod']])
  })

  it('anchors a pure deletion to the line above the gap', () => {
    const diff = patch('src/a.ts', [
      '@@ -1,6 +1,4 @@',
      ' const one = 1',
      ' const two = 2',
      '-const gone = 3',
      '-const alsoGone = 4',
      ' const five = 5',
      ' const six = 6',
    ].join('\n'))
    expect(entries(gitLineKinds(diff))).toEqual([[2, 'del']])
  })

  it('anchors a deletion at the head of the file to line 1', () => {
    const diff = patch('src/a.ts', [
      '@@ -1,4 +1,2 @@',
      '-const first = 1',
      '-const second = 2',
      ' const third = 3',
      ' const fourth = 4',
    ].join('\n'))
    expect(entries(gitLineKinds(diff))).toEqual([[1, 'del']])
  })

  it('keeps a mixed hunk straight: add, mod and del on their own lines', () => {
    const diff = patch('src/a.ts', [
      '@@ -1,6 +1,7 @@',
      ' const one = 1',
      '+const inserted = 2',
      ' const three = 3',
      '-const four = 4',
      '+const FOUR = 4',
      ' const five = 5',
      '-const six = 6',
      ' const seven = 7',
    ].join('\n'))
    expect(entries(gitLineKinds(diff))).toEqual([
      [2, 'add'],
      [4, 'mod'],
      // The unpaired deletion follows the rewritten line, so it anchors to the
      // line ABOVE the gap in the NEW numbering (5 is `const five = 5`).
      [5, 'del'],
    ])
  })

  it('returns nothing for an empty patch, and nothing for a mode-only change', () => {
    expect(entries(gitLineKinds(''))).toEqual([])
    const modeOnly = [
      'diff --git a/src/a.ts b/src/a.ts',
      'old mode 100644',
      'new mode 100755',
      '',
    ].join('\n')
    expect(entries(gitLineKinds(modeOnly))).toEqual([])
  })

  it('marks every line of an untracked file as added', () => {
    expect(entries(addedLineKinds(3))).toEqual([[1, 'add'], [2, 'add'], [3, 'add']])
    expect(entries(addedLineKinds(0))).toEqual([])
  })
})

describe('the gutter gate (setting off / other viewers)', () => {
  it('installs no extension at all when the feature is off', () => {
    expect(gitGutterExtensions(null)).toEqual([])
    expect(gitGutterExtensions({ scope: { sessionId: 's1', cwd: '/p' }, path: '/p/a.ts' }).length)
      .toBeGreaterThan(0)
  })

  it('every class the gutter hands to CodeMirror names a real stylesheet rule', () => {
    // These class names are strings passed to CodeMirror, so a typo would
    // silently paint nothing (theme.spec only scans the sheets themselves).
    const sheet = readFileSync(resolve(import.meta.dirname, '../src/client/sidebar.module.css'), 'utf8')
    for (const source of [
      'editorGitAdd', 'editorGitMod', 'editorGitDel', 'editorGitBarGutter',
      'editorGitBar', 'editorGitBarSpacer', 'editorGitBarAdd', 'editorGitBarMod', 'editorGitBarDel',
      'editorBlame', 'editorBlameHead', 'editorBlameSummary',
    ]) {
      expect(sheet, source).toContain(`.${source}`)
    }
    for (const cls of Object.values(GIT_LINE_CLASS)) expect(cls).not.toBe('')
  })

  it('applies a change set to an equipped view and is a no-op on a bare one', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const equipped = new EditorView({
      state: EditorState.create({
        doc: 'one\ntwo\nthree\n',
        extensions: gitGutterExtensions({ scope: { sessionId: 's1', cwd: '/p' }, path: '/p/a.ts' }),
      }),
      parent: host,
    })
    const bare = new EditorView({ state: EditorState.create({ doc: 'one\n' }), parent: host })
    try {
      const kinds = gitLineKinds(patch('a.ts', '@@ -1,1 +1,3 @@\n one\n+two\n+three\n'))
      expect(() => { applyGitLineKinds(equipped, kinds) }).not.toThrow()
      // No gutter field in the state: the effect is dropped, not fatal.
      expect(() => { applyGitLineKinds(bare, kinds) }).not.toThrow()
    } finally {
      equipped.destroy()
      bare.destroy()
    }
  })
})

describe('blame memo (hover only)', () => {
  const scope = { sessionId: 's1', cwd: '/p' }

  it('asks git once per line and never prefetches a neighbour', async () => {
    gitBlame.mockResolvedValue({
      lines: [{ line: 7, hash: 'a'.repeat(40), author: 'Ada', date: '2024-01-01T10:00:00+08:00', summary: 'feat: x' }],
    })
    const first = await loadBlameLine(scope, '/p/a.ts', 7)
    const second = await loadBlameLine(scope, '/p/a.ts', 7)
    expect(gitBlame).toHaveBeenCalledTimes(1)
    expect(gitBlame).toHaveBeenCalledWith(scope, '/p/a.ts', 7, 7)
    expect(second).toBe(first)
    expect(second?.author).toBe('Ada')
    // A different line is a different range — the file is never read ahead.
    await loadBlameLine(scope, '/p/a.ts', 8)
    expect(gitBlame).toHaveBeenCalledTimes(2)
  })

  it('answers null — never throws — when git has no blame for the line', async () => {
    gitBlame.mockRejectedValue(new Error('git exited with 128'))
    await expect(loadBlameLine(scope, '/p/untracked.ts', 1)).resolves.toBeNull()
    gitBlame.mockResolvedValue({ lines: [] })
    await expect(loadBlameLine(scope, '/p/untracked.ts', 2)).resolves.toBeNull()
  })

  it('drops one file\u2019s memo when its change set is recomputed', async () => {
    await loadBlameLine(scope, '/p/a.ts', 1)
    await loadBlameLine(scope, '/p/b.ts', 1)
    forgetBlame('s1', '/p/a.ts')
    await loadBlameLine(scope, '/p/a.ts', 1)
    await loadBlameLine(scope, '/p/b.ts', 1)
    expect(gitBlame.mock.calls.filter(call => call[1] === '/p/a.ts')).toHaveLength(2)
    expect(gitBlame.mock.calls.filter(call => call[1] === '/p/b.ts')).toHaveLength(1)
  })
})

describe('TextEditor wiring (code viewer only, one switch)', () => {
  function viewerProps(overrides: Partial<FileViewerProps> = {}): FileViewerProps {
    return {
      ctx: {} as FileViewerProps['ctx'],
      store: createSidebarStore(),
      scope: { sessionId: 's1', cwd: '/p' },
      path: '/p/a.ts',
      title: 'a.ts',
      viewerId: 'code',
      content: 'one\ntwo\nthree\n',
      ...overrides,
    }
  }

  const MODIFIED: GitStatusResult = { isRepo: true, root: '/p', entries: [{ path: 'a.ts', xy: ' M' }] }

  /** The scope the mounted editor subscribes to (and the memo is keyed by). */
  const wiringScope = { sessionId: 's1', cwd: '/p' }
  /** A second file, so this describe block never shares a memo entry with the
   *  hover-only cases above (the memo is a module-level singleton). */
  const COMMITTED = '/p/committed.ts'
  const MODIFIED_COMMITTED: GitStatusResult = {
    isRepo: true, root: '/p', entries: [{ path: 'committed.ts', xy: ' M' }],
  }

  /** Flush the status store's fetch chain: the mocked git answer resolves, the
   *  slot publishes and the subscribed editor re-renders with the new entry. */
  async function flushStatus(): Promise<void> {
    await act(async () => {
      invalidateGitStatus('s1')
      for (let round = 0; round < 5; round += 1) await Promise.resolve()
    })
  }

  it('never prefetches blame for the mounted code view (hover is the only trigger)', async () => {
    gitStatus.mockResolvedValue(MODIFIED_COMMITTED)
    gitDiffHead.mockResolvedValue({ diff: patch('committed.ts', '@@ -1,2 +1,3 @@\n one\n+inserted\n two\n') })
    const mounted = renderRoot(createElement(TextEditor, viewerProps({ path: COMMITTED })))
    try {
      await flushStatus()
      // The gutter really engaged — the change set was read and its bar is in
      // the DOM — so the blame count below is not zero for want of a gutter.
      expect(gitDiffHead).toHaveBeenCalledTimes(1)
      expect(mounted.container.querySelector(`.${GIT_BAR_GUTTER_CLASS}`)).not.toBeNull()
      expect(gitBlame).not.toHaveBeenCalled()
    } finally {
      mounted.unmount()
    }
  })

  it('never answers with the pre-commit blame once the file leaves the change set (#212)', async () => {
    gitStatus.mockResolvedValue(MODIFIED_COMMITTED)
    gitDiffHead.mockResolvedValue({ diff: patch('committed.ts', '@@ -1,2 +1,3 @@\n one\n+inserted\n two\n') })
    // What git blames a modified worktree line BEFORE the commit: the
    // '[Not Committed Yet]' placeholder, no summary, no real hash.
    gitBlame.mockResolvedValueOnce({
      lines: [{ line: 2, hash: '0'.repeat(40), author: 'Not Committed Yet', date: '', summary: '' }],
    })
    const mounted = renderRoot(createElement(TextEditor, viewerProps({ path: COMMITTED })))
    try {
      await flushStatus()
      // The hover the tooltip source performs for line 2.
      const before = await loadBlameLine(wiringScope, COMMITTED, 2)
      expect(before?.author).toBe('Not Committed Yet')
      expect(gitBlame).toHaveBeenCalledTimes(1)

      // The user commits (or discards): the status answer stops listing the
      // file, so the editor's change set for it goes away.
      gitStatus.mockResolvedValue({ isRepo: true, root: '/p', entries: [] })
      gitBlame.mockResolvedValue({
        lines: [{ line: 2, hash: 'a'.repeat(40), author: 'Ada', date: '2026-01-01T10:00:00+08:00', summary: 'feat: committed' }],
      })
      await flushStatus()

      // The same line, hovered again. The memo of a CLEARED change set must
      // not answer with the line git blamed before the commit.
      const after = await loadBlameLine(wiringScope, COMMITTED, 2)
      expect(gitBlame).toHaveBeenCalledTimes(2)
      expect(after?.summary).toBe('feat: committed')
    } finally {
      mounted.unmount()
    }
  })

  it('installs the gutter for the code viewer (default on)', async () => {
    gitStatus.mockResolvedValue(MODIFIED)
    gitDiffHead.mockResolvedValue({ diff: patch('a.ts', '@@ -1,2 +1,3 @@\n one\n+inserted\n two\n') })
    const mounted = renderRoot(createElement(TextEditor, viewerProps()))
    try {
      // The bar is a real CodeMirror gutter: its wrapper element exists as
      // soon as the extension is installed, changed lines or not.
      expect(mounted.container.querySelector(`.${GIT_BAR_GUTTER_CLASS}`)).not.toBeNull()
      expect(mounted.container.querySelector('.cm-gutters')).not.toBeNull()
    } finally {
      mounted.unmount()
    }
  })

  it('produces no decoration at all when the setting is off', async () => {
    const store = createSidebarStore()
    store.setPrefs({ ...store.getPrefs(), editorGitGutter: false })
    gitStatus.mockResolvedValue(MODIFIED)
    gitDiffHead.mockResolvedValue({ diff: patch('a.ts', '@@ -1,2 +1,3 @@\n one\n+inserted\n two\n') })
    // A SECOND editor on the same session keeps the shared status store live
    // (exactly what the file tree does in the merged editor), so the gate
    // under test is this editor's own — not an idle store. The forced refresh
    // is what makes the shared snapshot's arrival deterministic.
    const live = renderRoot(createElement(TextEditor, viewerProps()))
    const off = renderRoot(createElement(TextEditor, viewerProps({ store })))
    try {
      await act(async () => {
        invalidateGitStatus('s1')
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
      // Only the ENABLED editor ever asked for the change set.
      expect(gitDiffHead).toHaveBeenCalledTimes(1)
      expect(off.container.querySelector(`.${GIT_BAR_GUTTER_CLASS}`)).toBeNull()
      // The line-number gutter is still there — only OUR decoration is gone.
      expect(off.container.querySelector('.cm-gutters')).not.toBeNull()
      // The enabled editor on the same session DID get its gutter.
      expect(live.container.querySelector(`.${GIT_BAR_GUTTER_CLASS}`)).not.toBeNull()
    } finally {
      off.unmount()
      live.unmount()
    }
  })

  it('leaves the markdown viewer alone (the feature is code-only)', () => {
    const mounted = renderRoot(createElement(TextEditor, viewerProps({ viewerId: 'markdown' })))
    try {
      expect(mounted.container.querySelector(`.${GIT_BAR_GUTTER_CLASS}`)).toBeNull()
    } finally {
      mounted.unmount()
    }
  })

  it('drops the gutter in place when the setting is switched off mid-session', () => {
    const store = createSidebarStore()
    const mounted = renderRoot(createElement(TextEditor, viewerProps({ store })))
    try {
      expect(mounted.container.querySelector(`.${GIT_BAR_GUTTER_CLASS}`)).not.toBeNull()
      // The pref read is an external store: flipping it re-renders the editor
      // and the compartment swap removes the gutter — no reopen needed.
      act(() => { store.setPrefs({ ...store.getPrefs(), editorGitGutter: false }) })
      expect(mounted.container.querySelector(`.${GIT_BAR_GUTTER_CLASS}`)).toBeNull()
      act(() => { store.setPrefs({ ...store.getPrefs(), editorGitGutter: true }) })
      expect(mounted.container.querySelector(`.${GIT_BAR_GUTTER_CLASS}`)).not.toBeNull()
    } finally {
      mounted.unmount()
    }
  })
})
