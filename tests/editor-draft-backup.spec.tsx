/**
 * Durable draft backups (src/client/editor-draft-backup.ts).
 *
 * The host-owned ways to lose an editor draft — the native right column's tab
 * strip (its × / context menu / page.close) and the Desktop shell's quit —
 * expose no confirmation hook (the close handler is a cleanup callback whose
 * only veto is a throw, see docs/host-contracts.md). The plugin therefore keeps
 * a throttled localStorage copy and offers it back when the file is reopened.
 *
 * These tests pin the behavior a user gets, not the implementation: the
 * throttle delay, the FIFO budget, the restore prompt driving the REAL
 * TextEditor (CodeMirror) document, and the host close hook flushing what the
 * throttle has not written yet.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { EditorView } from '@codemirror/view'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { SidebarApiError } from '../src/client/api.ts'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import type { FileViewerProps } from '../src/client/service.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createNativeTabRecords } from '../src/client/native/tab-adapter.tsx'
import { registerNativeSurface } from '../src/client/native/index.ts'
import {
  DRAFT_BACKUP_CHARS,
  DRAFT_BACKUP_LIMIT,
  DRAFT_BACKUP_THROTTLE_MS,
  draftBackupBaseMtime,
  flushDraftBackups,
  readDraftBackup,
  registerDraftSource,
  scheduleDraftBackup,
} from '../src/client/editor-draft-backup.ts'

setupReactAct()

const fsWrite = vi.fn()
const fsRead = vi.fn()
vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      fsWrite: (...args: unknown[]) => fsWrite(...args),
      fsRead: (...args: unknown[]) => fsRead(...args),
    },
  }
})

/** Write one draft through the public path (a live source + the throttle). */
function seedDraft(sessionId: string, path: string, text: string): void {
  const release = registerDraftSource(sessionId, path, () => text)
  scheduleDraftBackup(sessionId, path)
  flushDraftBackups()
  release()
}

function viewerProps(overrides: Partial<FileViewerProps> = {}): FileViewerProps {
  return {
    ctx: {} as FileViewerProps['ctx'],
    store: createSidebarStore(),
    scope: { sessionId: 's1', cwd: '/p' },
    path: '/p/a.ts',
    title: 'a.ts',
    viewerId: 'code',
    content: 'const a = 1\n',
    mtimeMs: 123,
    ...overrides,
  }
}

/** The save button of the viewer's own toolbar (no host hoisting here). */
function saveButton(container: HTMLDivElement): HTMLButtonElement {
  const button = container.querySelector('button[aria-label="Save"], button[aria-label="保存"]')
  if (button === null) throw new Error('save button not found')
  return button as HTMLButtonElement
}

function click(element: HTMLElement): void {
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

/** The editor's live CodeMirror view (the real document, draft included). */
function viewOf(container: HTMLElement): EditorView {
  const host = container.querySelector('.cm-editor')
  const view = host === null ? null : EditorView.findFromDOM(host as HTMLElement)
  if (view === null) throw new Error('the mounted editor has no CodeMirror view')
  return view
}

/** Type through CodeMirror's own doc-change path (a keystroke). */
function typeText(container: HTMLElement, text: string): void {
  act(() => { viewOf(container).dispatch({ changes: { from: 0, insert: text } }) })
}

function reloadButton(container: HTMLElement): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button'))
    .find(candidate => candidate.textContent === 'Reload from disk')
  if (button === undefined) throw new Error('the conflict banner has no reload button')
  return button as HTMLButtonElement
}

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

/** A body at revision 1000 that gets an edit, then goes away without a save. */
function leaveDraftAt1000(): void {
  const mounted = renderRoot(createElement(TextEditor, viewerProps({ content: 'base\n', mtimeMs: 1000 })))
  typeText(mounted.container, 'draft ')
  mounted.unmount()
}

beforeEach(() => {
  localStorage.clear()
  fsWrite.mockReset()
  fsWrite.mockResolvedValue({ ok: true, mtimeMs: 456 })
  fsRead.mockReset()
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Every stored key under the module's prefix (the budget assertions). */
function storedKeys(): string[] {
  const keys: string[] = []
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (key !== null && key.startsWith('dsh-better-sidebar:draft:')) keys.push(key)
  }
  return keys
}

describe('editor-draft-backup store', () => {
  it('writes a changed draft only after the throttle, and reads it back', () => {
    vi.useFakeTimers()
    let text = 'first edit'
    const release = registerDraftSource('s1', '/p/a.ts', () => text)
    try {
      scheduleDraftBackup('s1', '/p/a.ts')
      expect(readDraftBackup('s1', '/p/a.ts', 'disk'), 'nothing is written before the throttle').toBeNull()
      text = 'second edit'
      vi.advanceTimersByTime(DRAFT_BACKUP_THROTTLE_MS - 1)
      expect(readDraftBackup('s1', '/p/a.ts', 'disk')).toBeNull()
      vi.advanceTimersByTime(1)
      // The flush reads the LIVE document, so the throttled write carries the
      // latest text, not the text at schedule time.
      expect(readDraftBackup('s1', '/p/a.ts', 'disk')).toBe('second edit')
    } finally {
      release()
    }
  })

  it('keeps at most the configured number of drafts, evicting the oldest first', () => {
    vi.useFakeTimers()
    const total = DRAFT_BACKUP_LIMIT + 1
    for (let index = 0; index < total; index += 1) {
      seedDraft('s' + index, '/p/a.ts', 'draft ' + index)
      vi.advanceTimersByTime(1)
    }
    expect(storedKeys()).toHaveLength(DRAFT_BACKUP_LIMIT)
    expect(readDraftBackup('s0', '/p/a.ts', 'disk'), 'the oldest draft was evicted').toBeNull()
    expect(readDraftBackup('s' + (total - 1), '/p/a.ts', 'disk'), 'the newest draft was kept').toBe('draft ' + (total - 1))
  })

  it('skips a draft larger than the per-entry budget instead of evicting the whole store', () => {
    seedDraft('s1', '/p/big.ts', 'x'.repeat(DRAFT_BACKUP_CHARS + 1))
    expect(readDraftBackup('s1', '/p/big.ts', 'disk')).toBeNull()
    expect(storedKeys()).toHaveLength(0)
  })

  it('drops an entry that is identical to the bytes on disk (the edit was undone)', () => {
    seedDraft('s1', '/p/a.ts', 'same as disk')
    expect(readDraftBackup('s1', '/p/a.ts', 'same as disk')).toBeNull()
    expect(storedKeys()).toHaveLength(0)
  })

  it('stores the base mtime with the draft, and reads a malformed one as absent', () => {
    const release = registerDraftSource('s1', '/p/a.ts', () => 'typed', () => 1000)
    scheduleDraftBackup('s1', '/p/a.ts')
    flushDraftBackups()
    release()
    expect(draftBackupBaseMtime('s1', '/p/a.ts')).toBe(1000)
    localStorage.setItem('dsh-better-sidebar:draft:s1::/p/a.ts', JSON.stringify({ text: 'typed', savedAt: 1, baseMtimeMs: 'x' }))
    expect(draftBackupBaseMtime('s1', '/p/a.ts')).toBeUndefined()
    expect(readDraftBackup('s1', '/p/a.ts', 'disk'), 'the draft itself is still offered').toBe('typed')
  })
})

describe('TextEditor draft restore', () => {
  it('offers a stored draft back and saves it as the document', async () => {
    seedDraft('s1', '/p/a.ts', 'const restored = 2\n')
    const confirmSpy = vi.fn().mockReturnValue(true)
    vi.stubGlobal('confirm', confirmSpy)
    const mounted = renderRoot(createElement(TextEditor, viewerProps()))
    try {
      expect(confirmSpy).toHaveBeenCalledTimes(1)
      click(saveButton(mounted.container))
      await act(async () => { await Promise.resolve() })
      expect(fsWrite).toHaveBeenCalledTimes(1)
      // The restored text, not the disk bytes, is what the editor writes.
      expect(fsWrite.mock.calls[0]![2]).toBe('const restored = 2\n')
      // Saving ends the draft: a later open must not offer it back.
      expect(readDraftBackup('s1', '/p/a.ts', 'const a = 1\n')).toBeNull()
    } finally {
      mounted.unmount()
    }
  })

  it('drops the draft and opens the disk bytes when the restore is declined', async () => {
    seedDraft('s1', '/p/a.ts', 'const restored = 2\n')
    const confirmSpy = vi.fn().mockReturnValue(false)
    vi.stubGlobal('confirm', confirmSpy)
    const mounted = renderRoot(createElement(TextEditor, viewerProps()))
    try {
      expect(confirmSpy).toHaveBeenCalledTimes(1)
      click(saveButton(mounted.container))
      await act(async () => { await Promise.resolve() })
      expect(fsWrite.mock.calls[0]![2]).toBe('const a = 1\n')
      expect(readDraftBackup('s1', '/p/a.ts', 'const a = 1\n')).toBeNull()
    } finally {
      mounted.unmount()
    }
  })

  it('never prompts when the file has no stored draft', () => {
    const confirmSpy = vi.fn().mockReturnValue(true)
    vi.stubGlobal('confirm', confirmSpy)
    const mounted = renderRoot(createElement(TextEditor, viewerProps()))
    try {
      expect(confirmSpy).not.toHaveBeenCalled()
    } finally {
      mounted.unmount()
    }
  })
})

describe('TextEditor draft restore: the mtime the draft was typed against', () => {
  /** The newer revision a reopen loads: another writer moved the file on. */
  const newer = { content: 'rewritten elsewhere\n', mtimeMs: 2000 }
  const refusedByHost = new SidebarApiError('fs-conflict', 'changed on disk')

  beforeEach(() => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true))
  })

  it('saves a restored draft against its own base, not the mtime just loaded', async () => {
    leaveDraftAt1000()
    const mounted = renderRoot(createElement(TextEditor, viewerProps(newer)))
    try {
      click(saveButton(mounted.container))
      await settle()
      expect(fsWrite).toHaveBeenCalledTimes(1)
      expect(fsWrite.mock.calls[0]![2]).toBe('draft base\n')
      expect(fsWrite.mock.calls[0]![3]).toBe(1000)
    } finally {
      mounted.unmount()
    }
  })

  it('takes the conflict path when the host refuses it: the draft stays, and the banner does not resolve in place', async () => {
    // The host's own rule: only the file's current mtime passes.
    fsWrite.mockImplementation((_scope: unknown, _path: unknown, _text: unknown, expected: unknown) => (
      expected === newer.mtimeMs ? Promise.resolve({ ok: true, mtimeMs: 3000 }) : Promise.reject(refusedByHost)
    ))
    // The disk equals what this mount loaded, which is exactly what must not
    // read as "only the mtime moved": the draft was typed on other bytes.
    fsRead.mockResolvedValue({ kind: 'text', content: newer.content, size: newer.content.length, mtimeMs: newer.mtimeMs })
    leaveDraftAt1000()
    const onReload = vi.fn()
    const mounted = renderRoot(createElement(TextEditor, viewerProps({ ...newer, onReload })))
    try {
      click(saveButton(mounted.container))
      await settle()
      expect(mounted.container.textContent ?? '').toContain('changed on disk since it was loaded')
      expect(viewOf(mounted.container).state.doc.toString()).toBe('draft base\n')
      expect(readDraftBackup('s1', '/p/a.ts', newer.content), 'a refused save keeps the backup').toBe('draft base\n')
      click(reloadButton(mounted.container))
      await settle()
      expect(onReload, 'the reload defers to the host and its unsaved-edits guard').toHaveBeenCalledTimes(1)
      click(saveButton(mounted.container))
      await settle()
      expect(fsWrite.mock.calls[1]![3], 'the probe did not move the baseline').toBe(1000)
    } finally {
      mounted.unmount()
    }
  })

  it('keeps the original base across further edits of a restored draft', async () => {
    leaveDraftAt1000()
    const edited = renderRoot(createElement(TextEditor, viewerProps(newer)))
    typeText(edited.container, 'more ')
    edited.unmount()
    const mounted = renderRoot(createElement(TextEditor, viewerProps(newer)))
    try {
      click(saveButton(mounted.container))
      await settle()
      expect(fsWrite.mock.calls[0]![2]).toBe('more draft base\n')
      expect(fsWrite.mock.calls[0]![3]).toBe(1000)
    } finally {
      mounted.unmount()
    }
  })

  it('treats an entry without a base as before: the save carries the mtime just loaded', async () => {
    localStorage.setItem('dsh-better-sidebar:draft:s1::/p/a.ts', JSON.stringify({ text: 'older entry\n', savedAt: 1 }))
    const mounted = renderRoot(createElement(TextEditor, viewerProps(newer)))
    try {
      click(saveButton(mounted.container))
      await settle()
      expect(fsWrite.mock.calls[0]![2]).toBe('older entry\n')
      expect(fsWrite.mock.calls[0]![3]).toBe(newer.mtimeMs)
    } finally {
      mounted.unmount()
    }
  })

  it('leaves a draft whose file did not move on the normal path: a touch still resolves in place (#1059)', async () => {
    leaveDraftAt1000()
    const onReload = vi.fn()
    const mounted = renderRoot(createElement(TextEditor, viewerProps({ content: 'base\n', mtimeMs: 1000, onReload })))
    try {
      fsWrite.mockRejectedValueOnce(refusedByHost)
      click(saveButton(mounted.container))
      await settle()
      expect(fsWrite.mock.calls[0]![3]).toBe(1000)
      fsRead.mockResolvedValue({ kind: 'text', content: 'base\n', size: 5, mtimeMs: 3000 })
      click(reloadButton(mounted.container))
      await settle()
      expect(onReload).not.toHaveBeenCalled()
      expect(mounted.container.textContent ?? '').not.toContain('changed on disk since it was loaded')
      click(saveButton(mounted.container))
      await settle()
      expect(fsWrite.mock.calls[1]![3]).toBe(3000)
    } finally {
      mounted.unmount()
    }
  })
})

describe('native tab close', () => {
  it('flushes a pending draft through the host close hook before the body unmounts', () => {
    vi.useFakeTimers()
    const store = createSidebarStore()
    store.setSession('s1')
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'editor', title: 'Files', component: () => null })
    const records = createNativeTabRecords()
    let closeHandler: (() => void) | undefined
    const tabsRegistry = { register: () => () => {} }
    const closeHost = {
      registerCloseHandler: (_kind: string, handler: () => void) => {
        closeHandler = handler
        return () => { closeHandler = undefined }
      },
    }
    const ctx = {
      inject: (_deps: readonly string[], callback: (injected: { get: (name: string) => unknown }) => (() => void) | void) => {
        const teardown = callback({ get: (name: string) => (name === 'sidebarRight' ? closeHost : tabsRegistry) })
        return { dispose: () => { if (typeof teardown === 'function') teardown() } }
      },
      get: () => tabsRegistry,
      slots: {
        inject: (_key: string, callback: () => () => void) => callback(),
        register: () => () => {},
      },
    }
    const dispose = registerNativeSurface({ ctx: ctx as never, store, service, records })
    const release = registerDraftSource('s1', '/work/a.ts', () => 'typed just now')
    try {
      expect(closeHandler, 'the editor kind registered a close handler').toBeTypeOf('function')
      // The last keystroke is still inside the throttle window.
      scheduleDraftBackup('s1', '/work/a.ts')
      expect(readDraftBackup('s1', '/work/a.ts', 'disk')).toBeNull()
      closeHandler?.()
      expect(readDraftBackup('s1', '/work/a.ts', 'disk')).toBe('typed just now')
    } finally {
      release()
      dispose()
    }
  })
})
