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
import { renderRoot, setupReactAct } from './test-utils.ts'
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
  flushDraftBackups,
  readDraftBackup,
  registerDraftSource,
  scheduleDraftBackup,
} from '../src/client/editor-draft-backup.ts'

setupReactAct()

const fsWrite = vi.fn()
vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    ...actual,
    api: { ...actual.api, fsWrite: (...args: unknown[]) => fsWrite(...args) },
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

beforeEach(() => {
  localStorage.clear()
  fsWrite.mockReset()
  fsWrite.mockResolvedValue({ ok: true, mtimeMs: 456 })
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
