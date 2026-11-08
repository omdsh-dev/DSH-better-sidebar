/**
 * The text editor's save-conflict surface: a save whose baseline mtime no
 * longer matches the file on disk is refused by the host (`fs-conflict`) and
 * the editor must (a) keep the draft, (b) explain why, (c) offer the host's
 * reload. Rendered with the REAL CodeMirror viewer (the dirty draft only
 * exists there), against a mocked api module.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { SidebarApiError } from '../src/client/api.ts'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import type { FileViewerProps } from '../src/client/service.ts'

setupReactAct()

const fsWrite = vi.fn()
const fsReadProbe = vi.fn()
vi.mock('../src/client/api.ts', async (importOriginal) => {
  // The real error class: TextEditor narrows the failure with instanceof.
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    ...actual,
    // The real api object with only the two calls the editor owns replaced:
    // the save, and the banner's on-disk probe (a reload whose bytes match the
    // loaded text is resolved in place, see #1059 — a failed probe defers to
    // the host's reload, which is what this spec asserts).
    api: {
      ...actual.api,
      fsWrite: (...args: unknown[]) => fsWrite(...args),
      fsRead: (...args: unknown[]) => fsReadProbe(...args),
    },
  }
})

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
  fsWrite.mockReset()
  fsReadProbe.mockReset()
  // The probe cannot read the file in this spec: the banner must fall back to
  // the host's reload.
  fsReadProbe.mockRejectedValue(new Error('unreadable'))
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('TextEditor save conflict', () => {
  it('sends the loaded mtime as the baseline', async () => {
    fsWrite.mockResolvedValue({ ok: true, mtimeMs: 456 })
    const mounted = renderRoot(createElement(TextEditor, viewerProps()))
    try {
      click(saveButton(mounted.container))
      await act(async () => { await Promise.resolve() })
      expect(fsWrite).toHaveBeenCalledTimes(1)
      // scope, path, content, expectedMtimeMs
      expect(fsWrite.mock.calls[0]![3]).toBe(123)
    } finally {
      mounted.unmount()
    }
  })

  it('keeps the draft and offers a reload when the host refuses with fs-conflict', async () => {
    fsWrite.mockRejectedValue(new SidebarApiError('fs-conflict', 'changed on disk'))
    const onReload = vi.fn()
    const mounted = renderRoot(createElement(TextEditor, viewerProps({ onReload })))
    try {
      click(saveButton(mounted.container))
      await act(async () => { await Promise.resolve() })
      const text = mounted.container.textContent ?? ''
      expect(text).toContain('changed on disk since it was loaded')
      const reload = Array.from(mounted.container.querySelectorAll('button'))
        .find(button => button.textContent === 'Reload from disk')
      expect(reload).toBeDefined()
      click(reload!)
      // The banner probes the disk first; the host's reload is the fallback,
      // one microtask later (a probe that matches the loaded text resolves in
      // place instead — see text-editor-save-baseline / editor-conflict-reload).
      await act(async () => { await Promise.resolve() })
      expect(onReload).toHaveBeenCalledTimes(1)
    } finally {
      mounted.unmount()
    }
  })

  it('does not show the conflict banner for an ordinary save failure', async () => {
    fsWrite.mockRejectedValue(new SidebarApiError('fs-error', 'disk full'))
    const mounted = renderRoot(createElement(TextEditor, viewerProps()))
    try {
      click(saveButton(mounted.container))
      await act(async () => { await Promise.resolve() })
      expect(mounted.container.textContent ?? '').not.toContain('changed on disk')
    } finally {
      mounted.unmount()
    }
  })

  it('adopts the baseline the host reports after a successful save', async () => {
    fsWrite.mockResolvedValue({ ok: true, mtimeMs: 456 })
    const mounted = renderRoot(createElement(TextEditor, viewerProps()))
    try {
      click(saveButton(mounted.container))
      await act(async () => { await Promise.resolve() })
      click(saveButton(mounted.container))
      await act(async () => { await Promise.resolve() })
      expect(fsWrite).toHaveBeenCalledTimes(2)
      expect(fsWrite.mock.calls[0]![3]).toBe(123)
      expect(fsWrite.mock.calls[1]![3]).toBe(456)
    } finally {
      mounted.unmount()
    }
  })
})
